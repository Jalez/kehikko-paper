import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildDir, compile, forgetBuilds, readPdf } from '../compile/build.ts'
import {
  SANDBOX_EXEC,
  cacheFolders,
  confinedEnv,
  linuxArgv,
  macArgv,
  nameable,
  notFound,
  opened,
  outsideSaid,
  profile,
  readable,
  texTrees,
  type Places,
} from '../compile/confine.ts'

/**
 * What an engine is kept to.
 *
 * The first half pins the words: the profile, the argument lists, which
 * folders are opened. The second half runs them, on a machine that can — a
 * program that only reads and writes files, put where an engine would be.
 */

const places = (over: Partial<Places> = {}): Places => ({
  paper: '/p/project/.kehikot/paper/a-paper',
  project: '/p/project',
  build: '/t/kehikot-paper/abc',
  cache: '/t/kehikot-paper/tex-cache',
  tex: ['/usr/local/texlive/2026', '/usr/local/texlive/texmf-local'],
  kept: [],
  home: '/Users/somebody',
  ...over,
})

describe('the profile', () => {
  test('denies every read and write, then opens the named places, and has no network', () => {
    const text = profile({ tex: 2, kept: 0, project: true, home: true, network: false })
    const lines = text.trim().split('\n')
    expect(lines.slice(0, 5)).toEqual(['(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)', '(deny file-read-data)'])
    expect(text).toContain('(subpath (param "PAPER"))')
    expect(text).toContain('(subpath (param "PROJECT"))')
    expect(text).toContain('(subpath (param "TEX0")) (subpath (param "TEX1"))')
    expect(text).not.toContain('TEX2')
    /* Written: the build folder and four folders of the cache, and nothing else. */
    const writes = lines.filter((line) => line.includes('file-write*') && line.startsWith('(allow'))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('(subpath (param "BUILD"))')
    expect(writes[0]).not.toContain('PAPER')
    expect(writes[0]).not.toContain('PROJECT')
    expect(writes[0]).not.toContain('"/bin"')
    expect(writes[0]).toContain('(string-append (param "CACHE") "/tmp")')
  })

  test('the project is opened after it is allowed minus its .git folders and .env files, and the paper after that', () => {
    const lines = profile({ tex: 0, kept: 0, project: true, home: false, network: false }).trim().split('\n')
    const allow = lines.findIndex((line) => line === '(allow file-read-data (subpath (param "PROJECT")))')
    const deny = lines.findIndex((line) => line.startsWith('(deny file-read-data (regex'))
    const paper = lines.findIndex((line) => line.includes('(subpath (param "PAPER"))'))
    expect(allow).toBeGreaterThan(0)
    expect(deny).toBe(allow + 1)
    expect(paper).toBeGreaterThan(deny)
    expect(lines[deny]).toContain('(regex-quote (param "PROJECT"))')
  })

  test('without a project there is no word of one; with something kept it is read and written; the fetching run has the network', () => {
    const bare = profile({ tex: 1, kept: 0, project: false, home: false, network: false })
    expect(bare).not.toContain('PROJECT')
    expect(bare).not.toContain('HOME')
    const tectonic = profile({ tex: 1, kept: 1, project: false, home: true, network: true })
    expect(tectonic).toContain('(allow file-read-data file-write* (subpath (param "KEPT0")))')
    expect(tectonic).not.toContain('(deny network*)')
    expect(tectonic).toContain('(string-append (param "HOME") "/Library/Fonts")')
  })

  test('is made of this module’s words only: a path, whatever is in it, is an argument and never profile text', () => {
    const nasty = '/p/it\'s "a" (project)) (allow file-read* (subpath "/")) ; \\ = $(x) `y`'
    const argv = macArgv(places({ project: nasty, paper: `${nasty}/.kehikot/paper/a-paper`, tex: [`${nasty}/tex`], kept: [`${nasty}/kept`] }), ['/bin/engine', 'main.tex'])!
    expect(argv[0]).toBe(SANDBOX_EXEC)
    const text = argv[argv.indexOf('-p') + 1]!
    expect(text).toBe(profile({ tex: 1, kept: 1, project: true, home: true, network: false }))
    expect(text).not.toContain('it\'s')
    expect(text).not.toContain('(project)')
    expect(text).not.toContain('/p/')
    /* Each path is one whole argument after a `-D`, with nothing done to it. */
    expect(argv).toContain(`PROJECT=${nasty}`)
    expect(argv[argv.indexOf(`PROJECT=${nasty}`) - 1]).toBe('-D')
    expect(argv).toContain(`TEX0=${nasty}/tex`)
    expect(argv).toContain(`KEPT0=${nasty}/kept`)
    expect(argv.slice(-2)).toEqual(['/bin/engine', 'main.tex'])
    /* The same text for every paper of the same shape. */
    expect(macArgv(places(), ['x'])![macArgv(places(), ['x'])!.indexOf('-p') + 1]).toBe(profile({ tex: 2, kept: 0, project: true, home: true, network: false }))
  })

  test('a path that cannot be said exactly is refused, and so is the confinement', () => {
    expect(nameable('/a/b')).toBe(true)
    expect(nameable('/a b/"c"')).toBe(true)
    expect(nameable('a/b')).toBe(false)
    expect(nameable('/')).toBe(false)
    expect(nameable('/a\nb')).toBe(false)
    expect(nameable('/a\u0000b')).toBe(false)
    expect(nameable('/a\tb')).toBe(false)
    expect(macArgv(places({ paper: '/p/project/a\n(allow default)' }), ['x'])).toBeNull()
    expect(macArgv(places({ tex: ['/ok', 'relative'] }), ['x'])).toBeNull()
    expect(linuxArgv('/usr/bin/bwrap', places({ build: '/t/a\nb' }), ['x'], '/p/project')).toBeNull()
  })
})

describe('which folders are opened', () => {
  test('the project, when the paper is in it and it is a folder of its own', () => {
    expect(opened('/p/project', '/p/project/.kehikot/paper/a', '/Users/somebody')).toBe('/p/project')
    expect(opened(null, '/p/project/.kehikot/paper/a', '/Users/somebody')).toBeNull()
    /* Not the paper's: only the paper is opened. */
    expect(opened('/p/other', '/p/project/.kehikot/paper/a', '/Users/somebody')).toBeNull()
    expect(opened('/p/proj', '/p/project/.kehikot/paper/a', null)).toBeNull()
  })

  test('never a home folder, what holds one, or the top of the disk', () => {
    const paper = '/Users/somebody/.kehikot/paper/a'
    expect(opened('/Users/somebody', paper, '/Users/somebody')).toBeNull()
    expect(opened('/Users', paper, '/Users/somebody')).toBeNull()
    expect(opened('/', paper, '/Users/somebody')).toBeNull()
    expect(opened('/Users', '/Users/x/.kehikot/paper/a', null)).toBeNull()
    expect(opened('/Users/somebody/work', '/Users/somebody/work/.kehikot/paper/a', '/Users/somebody')).toBe('/Users/somebody/work')
  })

  test('the TeX installation is what its kpsewhich said, less anything that would open a home folder', () => {
    const said = '/usr/local/texlive/2026|/usr/local/texlive/2026/texmf-dist|!!/usr/local/texlive/texmf-local|/usr/local/texlive/2026/texmf-var:/Users/somebody/Library/texlive/2026/texmf-var|/Users/somebody/Library/texmf\n'
    expect(texTrees(said, ['/Library/TeX/texbin'], '/Users/somebody')).toEqual([
      '/usr/local/texlive/2026',
      '/usr/local/texlive/2026/texmf-dist',
      '/usr/local/texlive/texmf-local',
      '/usr/local/texlive/2026/texmf-var',
      '/Users/somebody/Library/texlive/2026/texmf-var',
      '/Users/somebody/Library/texmf',
      '/Library/TeX/texbin',
    ])
    expect(texTrees('/Users/somebody|/Users|/|/usr|relative|$TEXMFHOME|/a\n/b/c', [], '/Users/somebody')).toEqual(['/b/c'])
    expect(texTrees('', ['/opt/x/bin/'], null)).toEqual(['/opt/x/bin'])
  })

  test('what is readable is what the profile opens: the project less its .git and .env, never beside it', () => {
    const at = places()
    expect(readable('/p/project/figures/plot.pdf', at)).toBe(true)
    expect(readable('/p/project/.kehikot/paper/a-paper/main.tex', at)).toBe(true)
    expect(readable('/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls', at)).toBe(true)
    expect(readable('/p/project/.env', at)).toBe(false)
    expect(readable('/p/project/sub/.env.local', at)).toBe(false)
    expect(readable('/p/project/.git/config', at)).toBe(false)
    expect(readable('/p/project/.github/workflows/ci.yml', at)).toBe(true)
    expect(readable('/p/project/.envrc', at)).toBe(true)
    expect(readable('/p/projectile/notes.txt', at)).toBe(false)
    expect(readable('/Users/somebody/notes.txt', at)).toBe(false)
    expect(readable('/p/project/figures/plot.pdf', places({ project: null }))).toBe(false)
  })
})

describe('the environment of a confined engine', () => {
  const env = { HOME: '/Users/somebody', PATH: '/Library/TeX/texbin:/usr/bin', TMPDIR: '/var/tmp/', TEXMFVAR: '/Users/somebody/var', openout_any: 'p' }

  test('keeps what it was given and points the temporary folder and generated fonts into the cache', () => {
    const out = confinedEnv(env, places(), '/t/kehikot-paper/tex-cache/bin/0123', 'latexmk')
    expect(out.PATH).toBe('/t/kehikot-paper/tex-cache/bin/0123:/Library/TeX/texbin:/usr/bin')
    expect(out.TMPDIR).toBe('/t/kehikot-paper/tex-cache/tmp')
    expect(out.VARTEXFONTS).toBe('/t/kehikot-paper/tex-cache/fonts')
    expect(out.TEXMFVAR).toBe('/Users/somebody/var')
    expect(out.openout_any).toBe('p')
    expect(out.HOME).toBe('/Users/somebody')
  })

  test('LuaTeX’s own tree is the cache’s; Tectonic’s package cache is left where it said', () => {
    expect(confinedEnv(env, places(), null, 'lualatex').TEXMFVAR).toBe('/t/kehikot-paper/tex-cache/luatex')
    const tectonic = confinedEnv({ ...env, XDG_CACHE_HOME: '/x' }, places(), null, 'tectonic')
    expect(tectonic.PATH).toBe(env.PATH)
    expect(tectonic.XDG_CACHE_HOME).toBe('/x')
    expect(tectonic.VARTEXFONTS).toBeUndefined()
    expect(tectonic.TMPDIR).toBe('/t/kehikot-paper/tex-cache/tmp')
  })

  test('every folder it names is one build.ts makes', () => {
    const made = cacheFolders(places())
    for (const key of ['TMPDIR', 'VARTEXFONTS'] as const) expect(made).toContain(confinedEnv(env, places())[key]!)
    expect(made).toContain(confinedEnv(env, places(), null, 'lualatex').TEXMFVAR!)
    expect(made).toContain('/t/kehikot-paper/tex-cache/bin')
  })
})

describe('on Linux', () => {
  test('the same places as bind mounts: read-only but for the build folder and the written parts of the cache', () => {
    const argv = linuxArgv('/usr/bin/bwrap', places({ kept: ['/home/x/.cache/Tectonic'] }), ['/usr/bin/pdflatex', 'main.tex'], '/p/project/.kehikot/paper/a-paper')!
    expect(argv[0]).toBe('/usr/bin/bwrap')
    expect(argv).toContain('--unshare-net')
    expect(argv).toContain('--die-with-parent')
    const pairs = (flag: string) => argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1]!] : []))
    expect(pairs('--bind')).toEqual([
      '/t/kehikot-paper/abc',
      '/t/kehikot-paper/tex-cache/tmp',
      '/t/kehikot-paper/tex-cache/fonts',
      '/t/kehikot-paper/tex-cache/luatex',
      '/t/kehikot-paper/tex-cache/xdg',
      '/home/x/.cache/Tectonic',
    ])
    expect(pairs('--ro-bind-try')).toContain('/p/project')
    expect(pairs('--ro-bind-try')).toContain('/usr/local/texlive/2026')
    expect(pairs('--ro-bind-try')).not.toContain('/Users/somebody')
    expect(pairs('--chdir')).toEqual(['/p/project/.kehikot/paper/a-paper'])
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', '/usr/bin/pdflatex', 'main.tex'])
  })

  test('only the paper when the project is not opened; the network only for the run that fetches', () => {
    const argv = linuxArgv('/usr/bin/bwrap', places({ project: null }), ['x'], '/p/project/.kehikot/paper/a-paper', true)!
    expect(argv).not.toContain('/p/project')
    expect(argv).toContain('/p/project/.kehikot/paper/a-paper')
    expect(argv).not.toContain('--unshare-net')
  })
})

describe('a file that is there and out of reach', () => {
  test('is found in what each program says about a file it could not open', () => {
    expect(notFound("! LaTeX Error: File `/a/b/notes.tex' not found.")).toEqual(['/a/b/notes.tex'])
    expect(notFound("! Package Listings Error: File `../notes(.txt)' not found.")).toEqual(['../notes.txt'])
    expect(notFound("error: main.tex:4: Unable to load picture or PDF file '/a/fig.pdf'")).toEqual(['/a/fig.pdf'])
    expect(notFound('!pdfTeX error: /Library/TeX/texbin/pdflatex: cannot find image file /a/fig.pdf\n ==> Fatal')).toEqual(['/a/fig.pdf'])
    expect(notFound("ERROR - Data file '/a/refs.bib' cannot be read in encoding 'utf8': Couldn't open")).toEqual(['/a/refs.bib'])
    expect(notFound("I couldn't open database file /a/refs.bib\n---line 3")).toEqual(['/a/refs.bib'])
    expect(notFound('nothing of the kind')).toEqual([])
  })

  test('a name the log broke across lines is put back together', () => {
    const line = "./main.tex:5: LaTeX Error: File `/Users/somebody/a/long/way/down/to/the/file/th"
    expect(line).toHaveLength(79)
    expect(notFound(`${line}\nat/is/meant.tex' not found.\n`)).toEqual(['/Users/somebody/a/long/way/down/to/the/file/that/is/meant.tex'])
  })

  test('is said in one sentence that names the file and what to do', () => {
    expect(outsideSaid('/a/fig.pdf', true)).toContain('/a/fig.pdf is there')
    expect(outsideSaid('/a/fig.pdf', true)).toContain('Copy it into the project')
    expect(outsideSaid('/a/fig.pdf', false)).toContain('Copy it into the paper’s folder')
  })
})

/* ---- Run for real ---------------------------------------------------------- */

/** Whether this machine, as this test is being run, can confine anything at all. */
const can = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0

describe.skipIf(!can)('applied, on a Mac', () => {
  let root = ''
  let at: Places
  /* Every character the profile language gives a meaning to, in the project's own name. */
  const NAME = 'pro"ject) (allow file-read* (subpath "/")) \\ ; it\'s = $HOME'

  const run = (argv: string[]) => spawnSync(macArgv(at, argv)![0]!, macArgv(at, argv)!.slice(1), { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'paper-confine-')))
    const project = join(root, NAME)
    const paper = join(project, '.kehikot', 'paper', 'a-paper')
    mkdirSync(paper, { recursive: true })
    mkdirSync(join(project, '.git'))
    mkdirSync(join(project, 'figures'))
    mkdirSync(join(root, 'build'))
    mkdirSync(join(root, 'cache'))
    mkdirSync(join(root, 'elsewhere'))
    at = { paper, project, build: join(root, 'build'), cache: join(root, 'cache'), tex: [], kept: [], home: null }
    for (const dir of cacheFolders(at)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(paper, 'main.tex'), 'IN THE PAPER')
    writeFileSync(join(project, 'figures', 'plot.txt'), 'IN THE PROJECT')
    writeFileSync(join(project, '.env'), 'A SETTING')
    writeFileSync(join(project, '.git', 'config'), 'A REPOSITORY')
    writeFileSync(join(root, 'elsewhere', 'private.txt'), 'NOT THE PAPER')
    symlinkSync(join(root, 'elsewhere', 'private.txt'), join(paper, 'link.txt'))
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('the paper and the project are read', () => {
    expect(run(['/bin/cat', join(at.paper, 'main.tex')]).stdout).toBe('IN THE PAPER')
    expect(run(['/bin/cat', join(at.project!, 'figures', 'plot.txt')]).stdout).toBe('IN THE PROJECT')
  })

  test('a file beside the project is not — by its name, by going up, or through a link in the paper', () => {
    const beside = join(root, 'elsewhere', 'private.txt')
    for (const path of [beside, join(at.paper, '..', '..', '..', '..', 'elsewhere', 'private.txt'), join(at.paper, 'link.txt')]) {
      const ran = run(['/bin/cat', path])
      expect(ran.status).not.toBe(0)
      expect(ran.stdout).toBe('')
    }
  })

  test('the project’s .env and .git are not', () => {
    expect(run(['/bin/cat', join(at.project!, '.env')]).stdout).toBe('')
    expect(run(['/bin/cat', join(at.project!, '.git', 'config')]).stdout).toBe('')
  })

  test('only the build folder and the cache’s written folders are written', () => {
    const touch = (path: string) => run(['/usr/bin/touch', path]).status
    expect(touch(join(at.build, 'made'))).toBe(0)
    expect(touch(join(at.cache, 'tmp', 'made'))).toBe(0)
    expect(touch(join(at.cache, 'bin', 'made'))).not.toBe(0)
    expect(touch(join(at.paper, 'made'))).not.toBe(0)
    expect(touch(join(root, 'elsewhere', 'made'))).not.toBe(0)
    expect(existsSync(join(at.paper, 'made'))).toBe(false)
  })

  test('without the project opened, the paper is all there is', () => {
    const paperOnly = macArgv({ ...at, project: null }, ['/bin/cat', join(at.project!, 'figures', 'plot.txt')])!
    expect(spawnSync(paperOnly[0]!, paperOnly.slice(1), { encoding: 'utf8' }).stdout).toBe('')
  })
})

/**
 * The whole path, with an engine that is a few lines of shell: it puts
 * whatever file `main.tex` names into the "PDF".
 */
describe('a compile', () => {
  let root = ''
  let bin = ''
  let pathWas: string | undefined
  const made: string[] = []

  const FAKE = `#!/bin/sh
while [ $# -gt 1 ]; do
  if [ "$1" = "--outdir" ]; then OUT="$2"; fi
  shift
done
WANTED=$(/usr/bin/head -1 "$1")
/bin/cat "$WANTED" > "$OUT/main.pdf" 2>/dev/null
echo "read: $WANTED" >> "$OUT/main.pdf"
exit 0
`

  const paperIn = (project: string): string => {
    const paper = join(project, '.kehikot', 'paper', 'a-paper')
    mkdirSync(paper, { recursive: true })
    made.push(paper)
    return paper
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'paper-confined-')))
    bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'tectonic'), FAKE)
    chmodSync(join(bin, 'tectonic'), 0o755)
    mkdirSync(join(root, 'elsewhere'))
    writeFileSync(join(root, 'elsewhere', 'private.txt'), 'NOT THE PAPER\n')
    pathWas = process.env.PATH
    process.env.PATH = `${bin}:${pathWas ?? ''}`
  })

  afterAll(() => {
    forgetBuilds()
    process.env.PATH = pathWas
    for (const paper of made) rmSync(buildDir(realpathSync(paper)), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  test.skipIf(!can)('is confined, and a file beside the project does not reach the PDF', async () => {
    const project = join(root, 'project')
    const paper = paperIn(project)
    writeFileSync(join(project, 'shared.txt'), 'IN THE PROJECT\n')

    writeFileSync(join(paper, 'main.tex'), `${join(project, 'shared.txt')}\n`)
    const inside = (await compile('a-paper', project))!
    expect(inside.last).toMatchObject({ ok: true, confined: true })
    expect(Buffer.from(readPdf('a-paper', project)!.bytes).toString()).toContain('IN THE PROJECT')

    writeFileSync(join(paper, 'main.tex'), `${join(root, 'elsewhere', 'private.txt')}\n`)
    const outside = (await compile('a-paper', project))!
    expect(outside.last).toMatchObject({ ok: true, confined: true })
    const pdf = Buffer.from(readPdf('a-paper', project)!.bytes).toString()
    expect(pdf).toContain('read: ')
    expect(pdf).not.toContain('NOT THE PAPER')
  })

  test('where the paper’s folder cannot be named to the confinement, the engine runs as it always has and the run says so', async () => {
    const project = join(root, 'a project\nwith a line break')
    const paper = paperIn(project)
    writeFileSync(join(paper, 'main.tex'), `${join(paper, 'main.tex')}\n`)
    const status = (await compile('a-paper', project))!
    expect(status.last).toMatchObject({ ok: true, confined: false, problems: [] })
    expect(readFileSync(join(buildDir(realpathSync(paper)), 'good', 'main.pdf'), 'utf8')).toContain('read: ')
  })
})
