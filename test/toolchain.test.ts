import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'

import { chooseEngine, envFor, findEngines, needsBiber, pathFirst, preferred, runsFor, texLiveDirs, type Engine } from '../compile/engine.ts'
import { biberAbsent, biberMismatch, noBiber, problemsFrom } from '../compile/log.ts'
import {
  BIBER_VERSION,
  BUNDLE_BIBLATEX,
  TECTONIC_VERSION,
  TOOLCHAIN,
  artefactsFor,
  biberFor,
  biblatexIn,
  mayFetch,
  megabytes,
  pieceDir,
  piecePath,
  platformKey,
  safeEntry,
  tarHeader,
  unzipEntry,
  verified,
} from '../compile/toolchain.ts'
import { tarOf, zipOf } from './archives.ts'

/**
 * What this module may download, and which engine a paper gets.
 *
 * The table is the whole of what a press of "Install the compiler" can fetch,
 * so its shape is pinned here: every row a literal https address on one of two
 * hosts, an exact length and a SHA-256 — and nothing that says "latest".
 */

describe('the table', () => {
  const rows = Object.values(TOOLCHAIN).flat()

  test('every row is a pinned version at a literal https address on the project’s own host, with a length and a SHA-256', () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const url = new URL(row.url)
      expect(url.protocol).toBe('https:')
      expect(['github.com', 'downloads.sourceforge.net']).toContain(url.hostname)
      expect(row.url).not.toMatch(/latest|continuous|nightly/i)
      expect(row.url).toContain(row.version)
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(row.bytes).toBeGreaterThan(1_000_000)
      expect(row.unpacked).toBeGreaterThanOrEqual(row.bytes)
      expect(safeEntry(row.entry)).toBe(true)
      expect(row.version).toBe(row.piece === 'tectonic' ? TECTONIC_VERSION : BIBER_VERSION)
    }
    expect(rows.find((row) => row.piece === 'tectonic')!.url).toBe(
      'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-aarch64-apple-darwin.tar.gz',
    )
  })

  test('the biber is the one the bundle’s biblatex goes with', () => {
    expect(biberFor(BUNDLE_BIBLATEX)).toBe(BIBER_VERSION)
  })

  test('both Macs and Linux on x86 get a compiler and a biber; Linux on ARM a compiler; Windows and anything else nothing', () => {
    expect(artefactsFor('darwin', 'arm64').map((row) => row.piece)).toEqual(['tectonic', 'biber'])
    expect(artefactsFor('darwin', 'x64').map((row) => row.piece)).toEqual(['tectonic', 'biber'])
    expect(artefactsFor('linux', 'x64').map((row) => row.piece)).toEqual(['tectonic', 'biber'])
    expect(artefactsFor('linux', 'arm64').map((row) => row.piece)).toEqual(['tectonic'])
    expect(platformKey('win32', 'x64')).toBeNull()
    expect(artefactsFor('freebsd', 'x64')).toEqual([])
    expect(megabytes(artefactsFor('darwin', 'arm64').reduce((sum, row) => sum + row.bytes, 0))).toBe(111)
  })

  test('a piece lives in a folder of its own named for its version', () => {
    const row = artefactsFor('darwin', 'arm64')[1]!
    expect(pieceDir('/t/tools/', row)).toBe('/t/tools/biber-2.17')
    expect(piecePath('/t/tools', row)).toBe('/t/tools/biber-2.17/biber')
  })
})

describe('which address may be asked', () => {
  const tectonic = artefactsFor('darwin', 'arm64')[0]!
  const biber = artefactsFor('darwin', 'arm64')[1]!

  test('the row’s own address, and a redirect only to a host the row names', () => {
    expect(mayFetch(tectonic, tectonic.url)).toBe(true)
    expect(mayFetch(tectonic, 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x')).toBe(true)
    expect(mayFetch(biber, 'https://deac-riga.dl.sourceforge.net/project/biblatex-biber/x.tar.gz?viasf=1')).toBe(true)
  })

  test('not plain http, not another host, and not a host made to look like one', () => {
    expect(mayFetch(tectonic, 'http://release-assets.githubusercontent.com/x')).toBe(false)
    expect(mayFetch(tectonic, 'https://example.com/tectonic.tar.gz')).toBe(false)
    expect(mayFetch(tectonic, 'https://github.com/somebody/else/releases/download/x/tectonic.tar.gz')).toBe(false)
    expect(mayFetch(biber, 'https://dl.sourceforge.net.example.com/x')).toBe(false)
    expect(mayFetch(biber, 'https://example.com/.dl.sourceforge.net/x')).toBe(false)
    expect(mayFetch(biber, 'https://.dl.sourceforge.net/x')).toBe(false)
    expect(mayFetch(biber, 'https://mirror.dl.sourceforge.net@example.com/x')).toBe(false)
    expect(mayFetch(biber, 'https://mirror.dl.sourceforge.net:8443/x')).toBe(false)
    expect(mayFetch(biber, 'file:///etc/passwd')).toBe(false)
    expect(mayFetch(biber, 'not an address')).toBe(false)
  })
})

describe('whether a download is the pinned file', () => {
  const row = { bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }

  test('the length and the SHA-256, both', () => {
    expect(verified(row, 3, row.sha256)).toBe(true)
    expect(verified(row, 3, row.sha256.toUpperCase())).toBe(true)
    expect(verified(row, 4, row.sha256)).toBe(false)
    expect(verified(row, 3, `0${row.sha256.slice(1)}`)).toBe(false)
    /* A row with no checksum is a row nothing matches, not one everything does. */
    expect(verified({ bytes: 3, sha256: '' }, 3, '')).toBe(false)
  })
})

describe('reading an archive', () => {
  test('a name that leaves the folder is not one an honest archive holds', () => {
    for (const name of ['biber', 'bin/biber', 'a..b']) expect(safeEntry(name)).toBe(true)
    for (const name of ['../biber', 'a/../../b', '/usr/bin/biber', 'C:\\biber.exe', 'a\\..\\b', '', 'a\0b']) expect(safeEntry(name)).toBe(false)
  })

  test('a tar header gives the name, size and kind; zeros end the archive; anything else is refused', () => {
    const tar = tarOf([{ name: 'biber', data: Buffer.from('hello') }])
    expect(tarHeader(tar.subarray(0, 512))).toEqual({ name: 'biber', size: 5, type: '0' })
    expect(tarHeader(Buffer.alloc(512))).toBeNull()
    expect(() => tarHeader(Buffer.alloc(512, 7))).toThrow('not a tar archive')
    expect(tarHeader(tarOf([{ name: 'biber', type: '2' }]).subarray(0, 512))!.type).toBe('2')
  })

  test('one file out of a zip, stored or deflated, and no more than it should be', () => {
    const data = Buffer.from('MZ fake exe '.repeat(200))
    for (const deflate of [false, true]) {
      const zip = zipOf([{ name: 'README.txt', data: Buffer.from('hi') }, { name: 'tectonic.exe', data }], deflate ? deflateRawSync : null)
      expect(unzipEntry(zip, 'tectonic.exe', data.length).equals(data)).toBe(true)
      expect(() => unzipEntry(zip, 'tectonic.exe', data.length - 1)).toThrow('larger than it should be')
      expect(() => unzipEntry(zip, 'biber.exe', 1e6)).toThrow('does not hold')
    }
    expect(() => unzipEntry(zipOf([{ name: '../tectonic.exe', data }, { name: 'tectonic.exe', data }], null), 'tectonic.exe', 1e6)).toThrow('no honest archive')
    expect(() => unzipEntry(zipOf([{ name: 'tectonic.exe', data }, { name: 'tectonic.exe', data }], null), 'tectonic.exe', 1e6)).toThrow('twice')
    expect(() => unzipEntry(Buffer.from('not a zip at all, just some text that is long enough'), 'x', 10)).toThrow('not a zip')
  })
})

describe('which biber', () => {
  test('biblatex 3.N goes with biber 2.N, and the bundle’s own file says which N', () => {
    expect(biberFor('3.17')).toBe('2.17')
    expect(biberFor('3.21')).toBe('2.21')
    expect(biberFor('2.9')).toBeNull()
    expect(biberFor('nonsense')).toBeNull()
    expect(biblatexIn('\\def\\abx@date{2022/02/02}\n\\def\\abx@version{3.17}\n')).toBe('3.17')
    expect(biblatexIn('\\def\\abx@version{3.18b}')).toBe('3.18')
    expect(biblatexIn('error: could not reach the bundle')).toBeNull()
  })

  test('biber’s own refusal names all three versions, and the advice is a button where there is one', () => {
    const said = 'Found biblatex control file version 3.8, expected version 3.11. This means that your biber (2.21) and biblatex (3.17) versions are incompatible.'
    expect(biberMismatch(said)).toEqual({ have: '2.21', biblatex: '3.17', need: '2.17' })
    expect(biberMismatch('INFO - This is Biber 2.17')).toBeNull()
    const output = ['error: the external tool exited with an error code; its stdout was:', '', '='.repeat(79), `ERROR - Error: ${said}`, '='.repeat(79)].join('\n')
    const byHand = problemsFrom(output, '', () => null).map((one) => one.message).join(' ')
    expect(byHand).toContain('Install that biber and put it first on the PATH')
    const offered = problemsFrom(output, '', () => null, (text) => (biberMismatch(text) ? 'Paper can download biber 2.17' : null)).map((one) => one.message).join(' ')
    expect(offered).toContain('Paper can download biber 2.17')
    expect(offered).not.toContain('put it first on the PATH')
  })
})

describe('no biber at all', () => {
  test('Tectonic’s "No such file or directory" after it went to run biber is read as what it is', () => {
    /* Tectonic 0.17.0 on a real biblatex thesis, on a PATH with no biber. */
    const output = ['note: Running TeX ...', 'note: Running external tool biber ...', 'note: Writing `/tmp/out/main.log` (65.3 KiB)', 'error: No such file or directory (os error 2)'].join('\n')
    expect(biberAbsent(output)).toBe(true)
    expect(biberAbsent('note: Running TeX ...\nerror: No such file or directory (os error 2)')).toBe(false)
    expect(biberAbsent('note: Running external tool biber ...\nnote: Rerunning TeX because biber was run ...')).toBe(false)
    expect(noBiber('2.17', true)).toContain('Paper can download biber 2.17')
    expect(noBiber('2.17', false)).toContain('Install biber 2.17')
  })
})

describe('which engine, now that one may be fetched', () => {
  const own: Engine = { name: 'tectonic', path: '/opt/homebrew/bin/tectonic' }
  const fetched: Engine = { name: 'tectonic', path: '/t/tools/tectonic-0.17.0/tectonic', managed: true }
  const latexmk: Engine = { name: 'latexmk', path: '/Library/TeX/texbin/latexmk' }
  const pdflatex: Engine = { name: 'pdflatex', path: '/Library/TeX/texbin/pdflatex' }
  const xelatex: Engine = { name: 'xelatex', path: '/Library/TeX/texbin/xelatex' }

  test('the fetched Tectonic is an engine when the person has none of their own, and theirs wins when they do', () => {
    const tools = { tectonic: fetched.path }
    expect(findEngines((path) => path === fetched.path, { PATH: '/a' }, tools)).toEqual([fetched])
    expect(findEngines((path) => path === fetched.path || path === own.path, { PATH: '/a' }, tools)).toEqual([own])
    expect(findEngines(() => false, { PATH: '/a' }, tools)).toEqual([])
    expect(findEngines(() => true, { PATH: '' }, { tectonic: 'relative/tectonic' })[0]).toEqual(own)
  })

  test('TeX Live is looked for where it installs, newest year first, when it is not on PATH', () => {
    const tree: Record<string, string[]> = {
      '/usr/local/texlive': ['2024', '2026', 'texmf-local', '..'],
      '/usr/local/texlive/2026/bin': ['universal-darwin'],
      '/usr/local/texlive/2024/bin': ['x86_64-linux', 'bad name'],
      '/opt/texlive': ['2025basic'],
      '/opt/texlive/2025basic/bin': ['aarch64-linux'],
    }
    const dirs = texLiveDirs((dir) => tree[dir] ?? [])
    expect(dirs).toEqual(['/usr/local/texlive/2026/bin/universal-darwin', '/usr/local/texlive/2024/bin/x86_64-linux', '/opt/texlive/2025basic/bin/aarch64-linux'])
    expect(texLiveDirs(() => [])).toEqual([])
    const found = findEngines((path) => path === `${dirs[0]}/latexmk`, { PATH: '/usr/bin' }, { dirs })
    expect(found).toEqual([{ name: 'latexmk', path: '/usr/local/texlive/2026/bin/universal-darwin/latexmk' }])
  })

  test('whether the bibliography is biber’s', () => {
    expect(needsBiber('\\usepackage[style=apa,backend=biber]{biblatex}')).toBe(true)
    expect(needsBiber('\\usepackage{biblatex}')).toBe(true)
    expect(needsBiber('\\usepackage[backend=bibtex]{biblatex}')).toBe(false)
    expect(needsBiber('% \\usepackage{biblatex}\n\\usepackage{natbib}')).toBe(false)
    expect(needsBiber('\\bibliographystyle{plain}')).toBe(false)
  })

  test('the order: the person’s Tectonic, then TeX Live, then the fetched Tectonic, then the bare engines', () => {
    expect(preferred([pdflatex, latexmk, own]).map((one) => one.path)).toEqual([own.path, latexmk.path, pdflatex.path])
    expect(preferred([pdflatex, latexmk, fetched]).map((one) => one.path)).toEqual([latexmk.path, fetched.path, pdflatex.path])
    expect(preferred([xelatex, fetched])[0]).toEqual(fetched)
  })

  test('a paper that needs biber gets a TeX Live ahead of any Tectonic, since its biber is the matched one', () => {
    expect(preferred([own, latexmk], true)[0]).toEqual(latexmk)
    expect(preferred([fetched, latexmk], true)[0]).toEqual(latexmk)
    expect(chooseEngine([own, latexmk, pdflatex], null, true)).toEqual({ ok: true, engine: latexmk })
    expect(chooseEngine([own, latexmk, pdflatex], null, false)).toEqual({ ok: true, engine: own })
    expect(chooseEngine([own], null, true)).toEqual({ ok: true, engine: own })
  })

  test('a paper that names its engine gets that one whatever the order, and latexmk is told what it always was', () => {
    expect(chooseEngine([own, latexmk, xelatex], { name: 'xelatex' }, true)).toEqual({ ok: true, engine: xelatex })
    expect(chooseEngine([own, latexmk], { name: 'tectonic' }, true)).toEqual({ ok: true, engine: own })
    expect(chooseEngine([fetched, latexmk], { name: 'tectonic' })).toEqual({ ok: true, engine: fetched })
    expect(runsFor(latexmk, 'main.tex', '/o')[0]!.argv).toEqual([
      latexmk.path, '-norc', '-pdf', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', '-outdir=/o', 'main.tex',
    ])
  })

  test('the fetched Tectonic is told exactly what the person’s own is: untrusted, cached first', () => {
    const runs = runsFor(fetched, 'main.tex', '/o')
    expect(runs[0]!.argv).toEqual([fetched.path, '-X', 'compile', '--untrusted', '--synctex', '--keep-logs', '--outdir', '/o', '--only-cached', 'main.tex'])
    expect(runs[1]!.argv).toContain('--untrusted')
  })
})

describe('what is first on an engine’s PATH', () => {
  const tectonic: Engine = { name: 'tectonic', path: '/opt/homebrew/bin/tectonic' }
  const latexmk: Engine = { name: 'latexmk', path: '/usr/local/texlive/2026/bin/universal-darwin/latexmk' }

  test('the fetched biber goes ahead of the machine’s for Tectonic, and only when there is one', () => {
    expect(pathFirst(tectonic, '/t/tools/biber-2.17')).toEqual(['/t/tools/biber-2.17'])
    expect(pathFirst(tectonic, null)).toEqual([])
    expect(envFor({ PATH: '/opt/homebrew/bin:/usr/bin' }, pathFirst(tectonic, '/t/tools/biber-2.17')).PATH).toBe(
      '/t/tools/biber-2.17:/opt/homebrew/bin:/usr/bin:/usr/local/bin:/Library/TeX/texbin',
    )
  })

  test('a TeX Live engine gets its own folder first and never the fetched biber', () => {
    expect(pathFirst(latexmk, '/t/tools/biber-2.17')).toEqual(['/usr/local/texlive/2026/bin/universal-darwin'])
    const env = envFor({ PATH: '/usr/bin' }, pathFirst(latexmk, '/t/tools/biber-2.17'))
    expect(env.PATH!.startsWith('/usr/local/texlive/2026/bin/universal-darwin:/usr/bin')).toBe(true)
    expect(env.PATH).not.toContain('biber-2.17')
  })

  test('nothing relative gets onto it, and a folder is there once', () => {
    expect(envFor({ PATH: '/a' }, ['rel', '/a', '/b'], ['/a']).PATH).toBe('/a:/b:/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:/usr/bin')
    expect(Object.keys(envFor({ PATH: '/a', SECRET: 'x', TECTONIC_CACHE_DIR: '/c' }, ['/b'])).sort()).toEqual(['PATH', 'TECTONIC_CACHE_DIR', 'openin_any', 'openout_any', 'shell_escape'])
  })
})
