/**
 * What an engine may read and write while it compiles a paper.
 *
 * The engines read only the paper, the build folder and the TeX installation.
 * The flags and the environment in `engine.ts` say what an engine is asked to
 * do; this says what the operating system lets it do, for the engine and for
 * every program it starts — `latexmk` runs `pdflatex` runs `biber`,
 * `makeindex`, `kpsewhich` and the font generators, and all of them inherit it.
 *
 * ## What is readable
 *
 *  - **The paper's folder**, and **the project it is in**: a paper draws
 *    figures and tables from elsewhere in its own repository
 *    (`\includegraphics{../../figures/plot.pdf}`), and that is the paper too.
 *    Not the project's `.git` folders or its `.env` files, which no paper is
 *    made of. A "project" that is somebody's whole home folder, or holds it,
 *    is not opened: the paper's own folder is then all there is.
 *  - **The build folder** and this module's own cache for the engines
 *    (`cacheDir` in `build.ts`).
 *  - **The TeX installation**: where the engine really is, and the trees its
 *    own `kpsewhich` names — the distribution's, the machine's local one, and
 *    the person's (`TEXMFHOME`, `TEXMFVAR`, `TEXMFCONFIG`), read-only. For
 *    Tectonic, whose installation is the packages it has fetched: its cache.
 *  - **Fonts** — the system's and the person's — and the font configuration.
 *  - **The system**: its libraries, frameworks and programs.
 *
 * ## What is writable
 *
 * The build folder and four folders of the cache. Nothing else: not the
 * paper, not the person's TeX trees, not the cache's `bin`. What an engine
 * would have kept in those trees — a font it generated, LuaTeX's font cache —
 * goes to the cache instead (`confinedEnv`), which also has the temporary
 * folder, where biber is unpacked. Tectonic writes its own package cache as
 * well, which is where it keeps what it fetched.
 *
 * ## No network
 *
 * A TeX Live installation is on the disk. Nothing a compile needs is elsewhere.
 * Tectonic's one run that is allowed to fetch a package (`runsFor`) is the
 * exception, and the only one.
 *
 * ## Nothing here runs anything
 *
 * Like `engine.ts`: paths in, argument lists out, and `build.ts` does the
 * looking and the spawning. A path never becomes part of the profile's text —
 * on macOS every one is handed over as a `-D NAME=value` argument and the
 * profile names the parameter — so there is no path, whatever characters it
 * holds, that can end a string in the profile and begin a rule.
 */

import type { EngineName } from './engine.ts'

/** macOS's own. Looked for at this path and nowhere else: never a name on `PATH`. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** Where a Linux has `bwrap`. Absolute, for the same reason. */
export const BWRAP: readonly string[] = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']

export interface Places {
  /** The paper's folder. Real path. */
  paper: string
  /** The project the paper is in, when it is opened as well: `opened`. Real path. */
  project: string | null
  /** The paper's build folder. Real path; read and written. */
  build: string
  /** This module's cache for the engines. Real path; read and written. */
  cache: string
  /** The TeX installation's folders: `texTrees`. Real paths; read. */
  tex: readonly string[]
  /** What the engine keeps for itself and writes: Tectonic's package cache. Real paths. Empty for a TeX Live engine. */
  kept: readonly string[]
  /** The person's home folder, for the fonts under it. Null when there is none. */
  home: string | null
}

/**
 * Whether a path can be named to the confinement at all.
 *
 * Absolute, and with no control character in it: a newline in an argument is
 * nothing a profile parameter or a bind mount was written for, and a path
 * this module cannot say exactly is one it does not open.
 */
export function nameable(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return path.startsWith('/') && path.length > 1 && path.length < 4096 && !/[\u0000-\u001f\u007f]/.test(path)
}

const within = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)

/**
 * The project, when the engine may read all of it; null when only the paper.
 *
 * Opened when the paper is inside it and it is a folder of its own — not the
 * root, not a top-level folder, and not the home folder or anything holding it.
 */
export function opened(project: string | null, paper: string, home: string | null): string | null {
  if (project === null || !nameable(project) || !within(paper, project)) return null
  if (project.split('/').filter(Boolean).length < 2) return null
  if (home && within(home, project)) return null
  return project
}

/**
 * The TeX installation's folders, from what its `kpsewhich` said.
 *
 * `said` is `kpsewhich --expand-var` of the tree variables, joined with `|` —
 * one variable may itself be a `:` list. `more` is what was found by looking:
 * the folder the engine really is in. A tree that is the home folder, or holds
 * it, or is the root or a top-level folder, is left out: a `TEXMFHOME` set to
 * `~` would otherwise open everything this file is here to keep closed.
 */
export function texTrees(said: string, more: readonly string[], home: string | null): string[] {
  const out: string[] = []
  for (const raw of [...said.split(/[|:\n]/), ...more]) {
    const tree = raw.trim().replace(/^!!/, '').replace(/\/+$/, '')
    if (!nameable(tree) || tree.split('/').filter(Boolean).length < 2) continue
    if (home && within(home, tree)) continue
    if (!out.includes(tree)) out.push(tree)
  }
  return out
}

/** The variables `kpsewhich` is asked for, as one `--expand-var` argument. */
export const TREE_VARS =
  '$TEXMFROOT|$TEXMFDIST|$TEXMFMAIN|$TEXMFLOCAL|$TEXMFSYSVAR|$TEXMFSYSCONFIG|$TEXMFHOME|$TEXMFVAR|$TEXMFCONFIG'

/**
 * What a confined engine's environment says besides `envFor`.
 *
 * Its temporary folder and the two places an engine keeps what it made for
 * next time are pointed into the cache, since the trees they default to are
 * read-only here: generated fonts (`VARTEXFONTS`, which kpathsea also searches)
 * and LuaTeX's font cache. The temporary folder is the cache's
 * and not the system's shared one, so biber unpacks itself where nothing else
 * has left anything.
 *
 * The written parts of the cache are every paper's, so what one compile leaves
 * there a later one reads. It is still only an engine that reads it, kept to
 * the same places.
 */
export function confinedEnv(env: Record<string, string>, places: Places, first: string | null = null, engine: EngineName = 'latexmk'): Record<string, string> {
  return {
    ...env,
    /* `first`: a folder of the cache's `bin` that holds a link to the biber this engine would run, unpacked (`build.ts`). */
    PATH: [...(first ? [first] : []), ...(env.PATH ?? '').split(':').filter(Boolean)].join(':'),
    TMPDIR: `${places.cache}/tmp`,
    /* Tectonic keeps its packages where `envFor` already let it say, and that is left alone. */
    ...(engine === 'tectonic' ? {} : { VARTEXFONTS: `${places.cache}/fonts`, XDG_CACHE_HOME: `${places.cache}/xdg` }),
    /* LuaTeX writes its font cache itself, and only under `TEXMFVAR` — `openout_any=p` holds it to that — so for it
       that tree IS the cache's folder, and the person's own is not consulted. */
    ...(engine === 'lualatex' ? { TEXMFVAR: `${places.cache}/luatex` } : {}),
  }
}

/** The parts of the cache an engine writes to. The rest of it — `bin` — it only reads. */
const WRITTEN: readonly string[] = ['tmp', 'fonts', 'luatex', 'xdg']

/** Every folder of the cache, for `build.ts` to make before a run. */
export function cacheFolders(places: Places): string[] {
  return [...WRITTEN, 'bin'].map((part) => `${places.cache}/${part}`)
}

/* ---- macOS ---------------------------------------------------------------- */

/** The system's own: libraries, frameworks, programs, fonts, and where TeX installations are put. */
const MAC_SYSTEM: readonly string[] = [
  '/System',
  '/usr/lib',
  '/usr/libexec',
  '/usr/share',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
  '/Library/Fonts',
  '/Library/Perl',
  '/Library/Apple',
  '/Library/TeX',
  '/usr/local/texlive',
  '/opt/texlive',
  '/private/var/db/timezone',
  '/private/var/db/dyld',
  '/private/etc/fonts',
]

/** A package manager's prefix: its programs and libraries, not its `etc` or `var`. */
const MAC_PREFIXES: readonly string[] = ['/opt/homebrew', '/usr/local', '/opt/local']
const PREFIX_PARTS: readonly string[] = ['Cellar', 'opt', 'lib', 'share', 'bin', 'libexec', 'etc/fonts']

const MAC_FILES: readonly string[] = ['/', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/dtracehelper', '/private/etc/localtime']

/** Under the home folder: fonts, and what a font configuration keeps. */
const HOME_PARTS: readonly string[] = ['Library/Fonts', '.fonts', '.fontconfig', '.config/fontconfig', '.cache/fontconfig', '.local/share/fonts']

const quoted = (text: string): string => `"${text.replace(/[\\"]/g, '\\$&')}"`

/**
 * The profile, for this many TeX folders.
 *
 * Its text is this file's own words and nothing else: every path of the
 * caller's is a `(param "…")`. Later rules win, which is the order below —
 * everything that is not a file is left as it is, then no file may be read or
 * written, then the places that may.
 *
 * `file-read-data` and not `file-read*`: a file's name and size stay visible
 * anywhere, as they are to `ls`, because a program finds its own libraries and
 * its working directory by asking; its contents, and a folder's listing, do not.
 */
export function profile(shape: { tex: number; kept: number; project: boolean; home: boolean; network: boolean }): string {
  const { tex, kept, project, home } = shape
  const each = (name: string, count: number): string => Array.from({ length: count }, (_, i) => `(subpath (param "${name}${i}"))`).join(' ')
  const system = [
    ...MAC_SYSTEM.map((dir) => `(subpath ${quoted(dir)})`),
    ...MAC_PREFIXES.flatMap((prefix) => PREFIX_PARTS.map((part) => `(subpath ${quoted(`${prefix}/${part}`)})`)),
    ...MAC_FILES.map((file) => `(literal ${quoted(file)})`),
  ]
  const lines = [
    '(version 1)',
    '(allow default)',
    ...(shape.network ? [] : ['(deny network*)']),
    '(deny file-write*)',
    '(deny file-read-data)',
    `(allow file-read-data ${system.join(' ')})`,
    ...(home ? [`(allow file-read-data ${HOME_PARTS.map((part) => `(subpath (string-append (param "HOME") ${quoted(`/${part}`)}))`).join(' ')})`] : []),
    ...(tex ? [`(allow file-read-data ${each('TEX', tex)})`] : []),
    ...(project
      ? [
          '(allow file-read-data (subpath (param "PROJECT")))',
          '(deny file-read-data (regex (string-append "^" (regex-quote (param "PROJECT")) "/(.*/)?\\\\.(git|env)(/|\\\\.|$)")))',
        ]
      : []),
    '(allow file-read-data (subpath (param "PAPER")) (subpath (param "BUILD")) (subpath (param "CACHE")))',
    `(allow file-write* (subpath (param "BUILD")) ${WRITTEN.map((part) => `(subpath (string-append (param "CACHE") ${quoted(`/${part}`)}))`).join(' ')} (literal "/dev/null"))`,
    ...(kept ? [`(allow file-read-data file-write* ${each('KEPT', kept)})`] : []),
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The argument list that runs `argv` confined, on macOS. Null when a place cannot be named.
 *
 * `network` is for the one run that may fetch: Tectonic's second.
 */
export function macArgv(places: Places, argv: readonly string[], network = false): string[] | null {
  const named: [string, string][] = [
    ['PAPER', places.paper],
    ['BUILD', places.build],
    ['CACHE', places.cache],
    ...(places.project ? ([['PROJECT', places.project]] as [string, string][]) : []),
    ...(places.home ? ([['HOME', places.home]] as [string, string][]) : []),
    ...places.tex.map((tree, i): [string, string] => [`TEX${i}`, tree]),
    ...places.kept.map((dir, i): [string, string] => [`KEPT${i}`, dir]),
  ]
  if (named.some(([, value]) => !nameable(value))) return null
  return [
    SANDBOX_EXEC,
    ...named.flatMap(([name, value]) => ['-D', `${name}=${value}`]),
    '-p',
    profile({ tex: places.tex.length, kept: places.kept.length, project: places.project !== null, home: places.home !== null, network }),
    ...argv,
  ]
}

/* ---- Linux ---------------------------------------------------------------- */

const LINUX_SYSTEM: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt/texlive',
  '/etc/alternatives',
  '/etc/fonts',
  '/etc/texmf',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/localtime',
  '/etc/ssl',
  '/etc/pki',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/var/lib/texmf',
  '/var/lib/tex-common',
  '/var/cache/fontconfig',
]

/**
 * The argument list that runs `argv` confined, on Linux, with `bwrap`.
 *
 * The same places, as bind mounts into an otherwise empty root: read-only
 * for everything but the build folder and the written parts of the cache. `--ro-bind-try` because
 * no one machine has every folder a distribution might use. Arguments, like
 * everything else here; there is no profile text at all. Unlike the macOS
 * profile this leaves the project's `.git` and `.env` readable.
 */
export function linuxArgv(bwrap: string, places: Places, argv: readonly string[], cwd: string, network = false): string[] | null {
  const all = [places.paper, places.build, places.cache, cwd, ...(places.project ? [places.project] : []), ...places.tex, ...places.kept]
  if (!all.every(nameable)) return null
  const ro = (dir: string): string[] => ['--ro-bind-try', dir, dir]
  return [
    bwrap,
    '--die-with-parent',
    ...(network ? [] : ['--unshare-net']),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...LINUX_SYSTEM.flatMap(ro),
    ...places.tex.flatMap(ro),
    ...(places.home && nameable(places.home) ? HOME_PARTS.flatMap((part) => ro(`${places.home}/${part}`)) : []),
    ...ro(places.project ?? places.paper),
    '--bind',
    places.build,
    places.build,
    ...ro(places.cache),
    ...WRITTEN.flatMap((part) => ['--bind', `${places.cache}/${part}`, `${places.cache}/${part}`]),
    ...places.kept.flatMap((dir) => ['--bind', dir, dir]),
    '--chdir',
    cwd,
    '--',
    ...argv,
  ]
}

/* ---- What a person is told ------------------------------------------------ */

/** Said in the status line's tooltip when an engine ran with nothing to confine it. */
export const NOT_CONFINED =
  'Not confined: this machine has nothing to keep the engine to the paper, the build folder and the TeX installation, so it ran as it always has.'

/** How each program says a file was not there for it. The name is the first group. */
const NOT_FOUND: readonly RegExp[] = [
  /File [`']([^'\n]{1,1024})' not found/g,
  /Unable to load picture or PDF file '([^'\n]{1,1024})'/g,
  /cannot find image file ([^\n]{1,1024})/g,
  /Cannot find '([^'\n]{1,1024})'/g,
  /Data file '([^'\n]{1,1024})' cannot be read/g,
  /I couldn't open (?:database|style|auxiliary) file ([^\n]{1,1024})/g,
]

/**
 * The files an engine, or a tool it ran, said it could not find.
 *
 * Every one of them has one sentence for a file that is not there and a file
 * it may not read. `build.ts` looks at each name this returns and says which
 * it was. A log breaks its lines at 79 characters, in the middle of a path as
 * readily as anywhere, so those are joined again first.
 */
export function notFound(output: string): string[] {
  const joined = output.replace(/\r/g, '').replace(/^(.{79})\n/gm, '$1')
  const out: string[] = []
  for (const said of NOT_FOUND) {
    for (const found of joined.matchAll(said)) {
      /* `listings` names the extension it tried in brackets: `notes(.txt)`. */
      const name = found[1]!.trim().replace(/\((\.[A-Za-z0-9]+)\)$/, '$1')
      if (name && !out.includes(name)) out.push(name)
      if (out.length >= 8) return out
    }
  }
  return out
}

/** Whether a real path is somewhere the confined engine can read: the paper, the opened project, the build folder, the cache or a TeX folder. */
export function readable(real: string, places: Places): boolean {
  if ([places.paper, places.build, places.cache, ...places.tex, ...places.kept].some((dir) => within(real, dir))) return true
  if (!places.project || !within(real, places.project)) return false
  return !/\/\.(git|env)(\/|\.|$)/.test(real.slice(places.project.length))
}

/** The sentence for a file that is there and outside what the engine reads. */
export function outsideSaid(name: string, project: boolean): string {
  return (
    `${name} is there, and the engine did not read it: the engines read only ${project ? 'the project the paper is in' : 'the paper’s folder'}, `
    + `the build folder and the TeX installation. Copy it into ${project ? 'the project' : 'the paper’s folder'} to use it.`
  )
}
