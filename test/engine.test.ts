import { describe, expect, test } from 'bun:test'

import { chooseEngine, envFor, findEngines, namedEngine, runsFor, searchDirs, wantsNetwork, type Engine } from '../compile/engine.ts'
import { problemsFrom, tailOf } from '../compile/log.ts'

/**
 * Which engine, and exactly what it is told.
 *
 * The argument lists are the security-relevant part of the whole preview — a
 * `.tex` file is a program and it is somebody else's — so they are pinned here
 * rather than left to be read off a spawn call.
 */

const at = (name: Engine['name'], dir = '/opt/homebrew/bin'): Engine => ({ name, path: `${dir}/${name}` })

describe('finding an engine', () => {
  test('PATH first, then where Homebrew and MacTeX put theirs, and never a relative entry', () => {
    expect(searchDirs({ PATH: '/a/bin:.:bin::/b/bin' })).toEqual(['/a/bin', '/b/bin', '/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin', '/usr/bin'])
  })

  test('every engine present, in preference order', () => {
    const has = new Set(['/a/pdflatex', '/opt/homebrew/bin/tectonic', '/Library/TeX/texbin/latexmk'])
    expect(findEngines((path) => has.has(path), { PATH: '/a' }).map((one) => one.name)).toEqual(['tectonic', 'latexmk', 'pdflatex'])
    expect(findEngines(() => false, { PATH: '/a' })).toEqual([])
  })

  test('a server started with no PATH at all still finds one in a well-known place', () => {
    expect(findEngines((path) => path === '/opt/homebrew/bin/tectonic', {})).toEqual([at('tectonic')])
  })
})

describe('the paper names its engine', () => {
  test('the magic comment other editors already read', () => {
    expect(namedEngine('% !TEX program = xelatex\n\\documentclass{article}')).toEqual({ name: 'xelatex' })
    expect(namedEngine('%!TEX TS-program = LuaLaTeX\n')).toEqual({ name: 'lualatex' })
    expect(namedEngine('\\documentclass{article}\n')).toBeNull()
  })

  test('only near the top, and an engine it does not know is said rather than guessed at', () => {
    expect(namedEngine(`${'\n'.repeat(30)}% !TEX program = xelatex`)).toBeNull()
    expect(namedEngine('% !TEX program = arara')).toEqual({ unknown: 'arara' })
  })

  test('choosing: the named one if installed, a sentence if not, the first found otherwise', () => {
    const found = [at('tectonic'), at('xelatex', '/Library/TeX/texbin')]
    expect(chooseEngine(found, null)).toEqual({ ok: true, engine: at('tectonic') })
    expect(chooseEngine(found, { name: 'xelatex' })).toEqual({ ok: true, engine: at('xelatex', '/Library/TeX/texbin') })
    const missing = chooseEngine(found, { name: 'lualatex' })
    expect(missing.ok === false && missing.why).toContain('lualatex is not installed')
    expect(chooseEngine(found, { unknown: 'arara' }).ok).toBe(false)
    const none = chooseEngine([], null)
    expect(none.ok === false && none.why).toContain('brew install tectonic')
  })
})

describe('what an engine is told', () => {
  test('tectonic: untrusted, synctex, into the build folder; cached first and fetching second', () => {
    const runs = runsFor(at('tectonic'), 'main.tex', '/tmp/out')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual({
      argv: ['/opt/homebrew/bin/tectonic', '-X', 'compile', '--untrusted', '--synctex', '--keep-logs', '--outdir', '/tmp/out', '--only-cached', 'main.tex'],
      cachedOnly: true,
    })
    expect(runs[1]!.argv).not.toContain('--only-cached')
    expect(runs[1]!.argv).toContain('--untrusted')
  })

  test('no engine is ever given shell escape, and latexmk never reads an rc file', () => {
    for (const name of ['tectonic', 'latexmk', 'pdflatex', 'xelatex', 'lualatex'] as const) {
      for (const run of runsFor(at(name), 'main.tex', '/tmp/out')) {
        const line = run.argv.join(' ')
        expect(line).not.toMatch(/(^| )-?-shell-escape|enable-write18|-Z shell-escape/)
        if (name !== 'tectonic') expect(run.argv).toContain('-no-shell-escape')
        if (name === 'latexmk') expect(run.argv).toContain('-norc')
        expect(run.argv[0]!.startsWith('/')).toBe(true)
        expect(run.argv[run.argv.length - 1]).toBe('main.tex')
      }
    }
  })

  test('TeX Live engines write into the build folder and are asked for file:line errors and synctex', () => {
    const [once, twice] = runsFor(at('pdflatex'), 'main.tex', '/tmp/out')
    expect(once!.argv).toEqual(['/opt/homebrew/bin/pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', '-output-directory=/tmp/out', 'main.tex'])
    expect(twice).toEqual(once!)
    expect(runsFor(at('latexmk'), 'main.tex', '/tmp/out')[0]!.argv).toContain('-outdir=/tmp/out')
  })

  test('the environment is what an engine needs and not what the server happened to hold', () => {
    const env = envFor({ HOME: '/Users/x', PATH: '/a', GITHUB_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret' })
    expect(env.HOME).toBe('/Users/x')
    expect(env.shell_escape).toBe('f')
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'openin_any', 'openout_any', 'shell_escape'])
    expect(JSON.stringify(env)).not.toContain('secret')
  })

  test('a cached-only failure for want of a file is worth a fetching run; any other failure is not', () => {
    expect(wantsNetwork("error: main.tex:3: ! LaTeX Error: File `chessboard.sty' not found.")).toBe(true)
    expect(wantsNetwork('error: main.tex:13: Font TU/lmr/m/sc/10 at 10.0pt not loadable: Metric (TFM) file or installed font not found')).toBe(true)
    expect(wantsNetwork('error: main.tex:21: Undefined control sequence')).toBe(false)
  })
})

describe('what an engine said went wrong', () => {
  const resolve = (name: string) => (['main.tex', 'chapters/wire.tex'].find((file) => file === name || file === `${name}.tex`) ?? null)

  test('what a tool tectonic ran said is read out of the frame around it, with what to do about biber', () => {
    /* Tectonic 0.16.9 on a real biblatex thesis, with a newer biber installed. */
    const output = [
      'note: Running external tool biber ...',
      'error: the external tool exited with an error code; its stdout was:',
      '',
      '===============================================================================',
      'INFO - This is Biber 2.21',
      "INFO - Logfile is 'main.blg'",
      "INFO - Reading 'main.bcf'",
      'ERROR - Error: Found biblatex control file version 3.8, expected version 3.11.',
      'This means that your biber (2.21) and biblatex (3.17) versions are incompatible.',
      'See compat matrix in biblatex or biber PDF documentation.',
      'INFO - ERRORS: 1',
      '===============================================================================',
      'error: its stderr was:',
      '',
      '===============================================================================',
      '===============================================================================',
      'note: Writing `/tmp/out/main.log` (65.3 KiB)',
      'error: the external tool exited with error code 2',
    ].join('\n')
    const problems = problemsFrom(output, '', resolve)
    expect(problems.map((one) => one.message)).toEqual([
      'Found biblatex control file version 3.8, expected version 3.11. This means that your biber (2.21) and biblatex (3.17) versions are incompatible. See compat matrix in biblatex or biber PDF documentation.',
      'Nothing is wrong in the paper. The engine’s biblatex is 3.17 and the biber installed on this machine is 2.21; they have to be of the same release, which for biblatex 3.17 is biber 2.17. Install that biber and put it first on the PATH, or compile with a TeX Live install (latexmk), where the two come matched.',
      'the external tool exited with error code 2',
    ])
    expect(problems.every((one) => one.severity === 'error')).toBe(true)
  })

  test('a tool that failed without saying ERROR is still quoted, and an ordinary error after it is still read', () => {
    const output = [
      'error: the external tool exited with an error code; its stdout was:',
      '===============================================================================',
      'something went wrong in a tool with no levels',
      '===============================================================================',
      'error: its stderr was:',
      '===============================================================================',
      '===============================================================================',
      'error: main.tex:5: Undefined control sequence',
    ].join('\n')
    expect(problemsFrom(output, '', resolve)).toEqual([
      { severity: 'error', file: null, line: null, message: 'something went wrong in a tool with no levels' },
      { severity: 'error', file: 'main.tex', line: 5, message: 'Undefined control sequence' },
    ])
  })

  test('tectonic: file as the paper spelled it, line, message — and not its closing sentence', () => {
    const output = [
      'note: Running TeX ...',
      'warning: main.tex:5: Something mild',
      'error: chapters/wire:12: Undefined control sequence',
      'error: halted on potentially-recoverable error as specified',
    ].join('\n')
    expect(problemsFrom(output, '', resolve)).toEqual([
      { severity: 'error', file: 'chapters/wire.tex', line: 12, message: 'Undefined control sequence' },
      { severity: 'warning', file: 'main.tex', line: 5, message: 'Something mild' },
    ])
  })

  test('-file-line-error from a TeX Live engine', () => {
    expect(problemsFrom('./chapters/wire.tex:7: Missing $ inserted.\n', '', (name) => resolve(name.replace(/^\.\//, '')))).toEqual([
      { severity: 'error', file: 'chapters/wire.tex', line: 7, message: 'Missing $ inserted.' },
    ])
  })

  test('a file that is not the paper’s keeps its message and loses its link', () => {
    expect(problemsFrom('error: article.cls:40: Something inside the class', '', resolve)[0]).toMatchObject({ file: null, line: 40 })
  })

  test('the log: a classic error when stderr named none, and LaTeX’s own warnings', () => {
    const log = [
      '! Undefined control sequence.',
      '<recently read> \\foo',
      'l.14 A \\foo',
      '          here.',
      'LaTeX Warning: Reference `nope\' undefined on input line 4.',
      'Overfull \\hbox (12.0pt too wide) in paragraph at lines 3--5',
      'Package natbib Warning: Citation `x\' on page 1 undefined on input line 9.',
    ].join('\n')
    expect(problemsFrom('', log, resolve)).toEqual([
      { severity: 'error', file: null, line: 14, message: 'Undefined control sequence.' },
      { severity: 'warning', file: null, line: 4, message: "Reference `nope' undefined on input line 4." },
      { severity: 'warning', file: null, line: 9, message: "Citation `x' on page 1 undefined on input line 9." },
    ])
  })

  test('the same complaint twice is one, and a flood is bounded', () => {
    expect(problemsFrom('error: main.tex:1: x\nerror: main.tex:1: x\n', '', resolve)).toHaveLength(1)
    const flood = Array.from({ length: 500 }, (_, i) => `error: main.tex:${i + 1}: x`).join('\n')
    expect(problemsFrom(flood, '', resolve).length).toBeLessThanOrEqual(40)
  })

  test('the tail is the END of what was printed', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const tail = tailOf(long, 200)
    expect(tail.endsWith('line 1999')).toBe(true)
    expect(tail.length).toBeLessThan(260)
    expect(tailOf('short')).toBe('short')
  })
})
