/**
 * Which program turns the paper into a PDF, and exactly what it is told.
 *
 * ## An engine, not Tectonic
 *
 * The preview is the paper compiled the way LaTeX compiles it, so that a
 * figure, a table, a reference and somebody's own document class look the way
 * they will in the thing that gets submitted. That needs a real engine and this
 * module does not ship one: it finds what the machine has — and, when the
 * machine has none, can fetch a small one at a person's say-so (`toolchain.ts`
 * says what, `install.ts` does it). On the machine this was written on that is
 * Tectonic and nothing else — no `latexmk`, no `pdflatex` — and on the next
 * one it will be TeX Live. So everything here is written against "an engine":
 * a name, a path, and an argument list.
 *
 * ## Nothing here runs anything
 *
 * This file decides and `build.ts` spawns. Every function below is pure —
 * the environment and the "does this file exist" question are passed in — so
 * the argument lists, which are the security-relevant part of this whole
 * feature, are pinned by tests rather than by reading a spawn call.
 *
 * ## A `.tex` file is a program, and it is somebody else's
 *
 * TeX is a programming language with file I/O, and with shell escape turned on
 * it has `\write18{rm -rf ~}`. A paper here may have been cloned from a
 * stranger, and "preview" must never be the word for "ran it". So, for every
 * engine:
 *
 *  - **Shell escape is off, explicitly.** Never left to a default, because the
 *    default is a property of somebody's `texmf.cnf`.
 *  - **No shell.** The engine is spawned from an argument ARRAY. There is no
 *    string here that a path with a quote or a `$(…)` in it could break out of.
 *  - **No rc files.** `latexmk` reads a `.latexmkrc` from the directory it runs
 *    in and that file is Perl; `-norc` is the difference between compiling a
 *    paper and executing its folder.
 *  - **Tectonic runs `--untrusted`**, its own switch for all of this. It costs
 *    one thing, stated in the README rather than hidden: an extra search path
 *    is refused in that mode, so a `.sty` in a SUBFOLDER of the paper has to be
 *    named with its folder (`\usepackage{style/shout}`). Files beside
 *    `main.tex` are found as they always are.
 */

export type EngineName = 'tectonic' | 'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex'

/** Every engine this module knows how to run. Which one a paper gets is `preferred`, below. */
export const ENGINES: readonly EngineName[] = ['tectonic', 'latexmk', 'pdflatex', 'xelatex', 'lualatex']

export interface Engine {
  name: EngineName
  /** Absolute. What is spawned. */
  path: string
  /** A Tectonic this module fetched (`install.ts`), as opposed to one the person installed. */
  managed?: true
}

/**
 * Where a GUI-launched process has to look as well as `PATH`.
 *
 * A dev server started from a terminal inherits the shell's `PATH`. The same
 * server started by a desktop app or by launchd gets `/usr/bin:/bin` and would
 * report that no engine is installed on a machine with three. These are where
 * Homebrew and MacTeX put theirs, and where a Linux distribution does.
 */
const WELL_KNOWN = ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin', '/usr/bin']

export function searchDirs(env: Record<string, string | undefined>, more: readonly string[] = []): string[] {
  const out: string[] = []
  for (const dir of [...(env.PATH ?? '').split(':'), ...WELL_KNOWN, ...more]) {
    /* Absolute only. A relative `PATH` entry means "the current directory",
       and the current directory of a compile is the PAPER's folder — which is
       how a file called `tectonic` in a cloned repository would get run. */
    if (dir.startsWith('/') && !out.includes(dir)) out.push(dir)
  }
  return out
}

/**
 * Where a TeX Live keeps its programs when nothing has put them on `PATH`.
 *
 * TeX Live installs to `<root>/<year>/bin/<platform>/` and leaves adding that
 * to `PATH` to the person — which a terminal's profile does and an app started
 * from the Dock never sees. MacTeX also makes `/Library/TeX/texbin`, which is
 * in `WELL_KNOWN`; this is for the installs that did not: `install-tl` on a
 * Mac or on Linux (`/usr/local/texlive`, its default), and the `/opt/texlive`
 * some distributions and containers use. A distribution's own packages put
 * theirs in `/usr/bin`, which is already looked in.
 *
 * Newest year first. `list` is the only I/O — the names in a directory, or
 * none — and it is the caller's.
 */
export const TEXLIVE_ROOTS: readonly string[] = ['/usr/local/texlive', '/opt/texlive']

export function texLiveDirs(list: (dir: string) => readonly string[]): string[] {
  const out: string[] = []
  for (const root of TEXLIVE_ROOTS) {
    const years = list(root)
      .filter((name) => /^\d{4}(basic)?$/.test(name))
      .sort()
      .reverse()
    for (const year of years) {
      for (const platform of [...list(`${root}/${year}/bin`)].sort()) {
        if (/^[A-Za-z0-9_.-]+$/.test(platform) && platform !== '.' && platform !== '..') out.push(`${root}/${year}/bin/${platform}`)
      }
    }
  }
  return out
}

export interface Elsewhere {
  /** TeX Live folders that are not on `PATH`: `texLiveDirs`. Looked in last. */
  dirs?: readonly string[]
  /** The Tectonic this module fetched, when it has. Used only when the person has none of their own. */
  tectonic?: string | null
}

/**
 * Every engine this machine has. `exists` is the only I/O and it is the caller's.
 *
 * In the order of `ENGINES`, which is not the order they are preferred in:
 * `preferred` decides that, because it depends on the paper.
 */
export function findEngines(exists: (path: string) => boolean, env: Record<string, string | undefined>, elsewhere: Elsewhere = {}): Engine[] {
  const dirs = searchDirs(env, elsewhere.dirs ?? [])
  const out: Engine[] = []
  for (const name of ENGINES) {
    let found = false
    for (const dir of dirs) {
      const path = `${dir.replace(/\/+$/, '')}/${name}`
      if (exists(path)) {
        out.push({ name, path })
        found = true
        break
      }
    }
    /* The person's own Tectonic wins over the fetched one: it is the one they
       chose, and its package cache is the one already filled. */
    if (name === 'tectonic' && !found && elsewhere.tectonic && elsewhere.tectonic.startsWith('/') && exists(elsewhere.tectonic)) {
      out.push({ name, path: elsewhere.tectonic, managed: true })
    }
  }
  return out
}

/**
 * Whether the paper's bibliography is made by biber.
 *
 * `biblatex` is, unless it is told `backend=bibtex` — biber is its default.
 * It matters for the choice of engine because biber has to match the
 * `biblatex` it is run for, and only a TeX Live ships the two as a pair.
 * Read from `main.tex`, where a preamble is, with comments set aside.
 */
export function needsBiber(source: string): boolean {
  const code = source.replace(/(^|[^\\])%.*$/gm, '$1')
  const loaded = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{[^}]*\bbiblatex\b[^}]*\}/.exec(code)
  if (!loaded) return false
  return !/backend\s*=\s*bibtex/.test(loaded[1] ?? '')
}

/**
 * The engines found, in the order they are tried when the paper names none.
 *
 *  1. **The person's own Tectonic** — unless the paper needs biber and there is
 *     a `latexmk`, which then goes first: a TeX Live's biber is the one its
 *     biblatex was released with, and a Tectonic's is whichever biber happens
 *     to be on the machine.
 *  2. **`latexmk`**, which is a TeX Live. Found, it is used before anything
 *     this module fetched: a person who installed a distribution meant it.
 *  3. **The Tectonic this module fetched.**
 *  4. **The bare engines**, which run no bibliography tool at all.
 */
export function preferred(found: readonly Engine[], biber = false): Engine[] {
  const rank = (engine: Engine): number => {
    if (engine.name === 'tectonic') return engine.managed ? 3 : biber ? 2 : 1
    if (engine.name === 'latexmk') return biber ? 1 : 2
    return 4 + ENGINES.indexOf(engine.name)
  }
  return [...found].sort((a, b) => rank(a) - rank(b))
}

/**
 * The engine a paper asks for, in the paper.
 *
 * `% !TEX program = xelatex` in the first lines of `main.tex` — the magic
 * comment TeXShop, TeXstudio, VS Code's LaTeX Workshop and Overleaf already
 * read. It is here rather than in a config file because which engine a
 * document needs is a fact about the DOCUMENT (it uses `fontspec`, or it does
 * not), it has to travel with it, and a paper that already says so for another
 * editor should not have to say it twice. `TS-program` is the older spelling.
 *
 * Only the top of the file is read, as every editor that honours this does.
 */
export function namedEngine(source: string): { name: EngineName } | { unknown: string } | null {
  const head = source.split('\n', 20).join('\n')
  const found = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*([A-Za-z0-9_-]+)/im.exec(head)
  if (!found) return null
  const said = found[1]!.toLowerCase()
  return (ENGINES as readonly string[]).includes(said) ? { name: said as EngineName } : { unknown: found[1]! }
}

export type Chosen = { ok: true; engine: Engine } | { ok: false; why: string }

/**
 * What to say about getting an engine, where this module has none to fetch.
 *
 * Where it has — see `toolchain.ts` — the page offers a button instead and
 * this is not what a person reads.
 */
export const HOW_TO_INSTALL =
  'No LaTeX engine is installed on this machine, so there is nothing to compile the paper with. The smallest one is '
  + 'Tectonic — `brew install tectonic` on a Mac, or see tectonic-typesetting.github.io — and it fetches the packages '
  + 'a paper uses the first time it needs them. A full TeX Live or MacTeX (latexmk, pdflatex, xelatex, lualatex) is '
  + 'found as well. The source can be edited and saved without one.'

/** @param biber whether the paper's bibliography is biber's: `needsBiber`. It decides the order only when the paper names no engine. */
export function chooseEngine(found: readonly Engine[], named: ReturnType<typeof namedEngine>, biber = false): Chosen {
  if (named && 'unknown' in named) {
    return {
      ok: false,
      why:
        `main.tex asks for “${named.unknown}” in its “% !TEX program” line, which is not an engine this module knows how `
        + `to run. It knows: ${ENGINES.join(', ')}.`,
    }
  }
  if (named) {
    const engine = found.find((one) => one.name === named.name)
    if (engine) return { ok: true, engine }
    return {
      ok: false,
      why:
        `main.tex asks for ${named.name} in its “% !TEX program” line, and ${named.name} is not installed on this machine`
        + (found.length ? ` (installed: ${found.map((one) => one.name).join(', ')}).` : '.'),
    }
  }
  const first = preferred(found, biber)[0]
  return first ? { ok: true, engine: first } : { ok: false, why: HOW_TO_INSTALL }
}

export interface Run {
  /** `argv[0]` is the engine's absolute path. */
  argv: string[]
  /** A run that failed this way is worth one more try with the next run in the list. See `wantsNetwork`. */
  cachedOnly?: boolean
}

/**
 * The runs that compile `main` (a name relative to the paper's folder, which
 * is the working directory) into `out`.
 *
 * `out` is never the paper's folder — see `build.ts` for where it is and why —
 * so no engine leaves an `.aux`, a `.log` or a PDF beside somebody's source.
 *
 * ## Tectonic is asked twice, on purpose
 *
 * Tectonic keeps its packages in a cache and, left to itself, starts every run
 * by asking the network whether its bundle has moved. Measured here: 2.4
 * seconds with `--only-cached`, thirty with the default on a slow connection —
 * for the same paper and the same bytes out. So the first run is cached-only,
 * and only when THAT fails for want of a file is it run again allowed to fetch.
 *
 * ## The bare engines
 *
 * `pdflatex`, `xelatex` and `lualatex` are run twice, which settles
 * cross-references and a table of contents, and do NOT run BibTeX or biber —
 * a bibliography needs `latexmk` or Tectonic, which drive that themselves. The
 * page says so when it picks one of these. Untested against a real binary on
 * the machine this was written on, which has none of them; the argument lists
 * are what the manuals say and what the tests pin.
 */
export function runsFor(engine: Engine, main: string, out: string): Run[] {
  if (engine.name === 'tectonic') {
    const base = ['-X', 'compile', '--untrusted', '--synctex', '--keep-logs', '--outdir', out]
    return [
      { argv: [engine.path, ...base, '--only-cached', main], cachedOnly: true },
      { argv: [engine.path, ...base, main] },
    ]
  }
  const tex = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1']
  if (engine.name === 'latexmk') {
    return [{ argv: [engine.path, '-norc', '-pdf', ...tex, `-outdir=${out}`, main] }]
  }
  const once: Run = { argv: [engine.path, ...tex, `-output-directory=${out}`, main] }
  return [once, once]
}

/**
 * Whether a cached-only run failed for want of something the network has.
 *
 * A package this machine has never used, or a font: TeX says "not found" or
 * "not loadable" and that is the whole signal, because to TeX a file missing
 * from the cache and a file that does not exist are one event. The cost of the
 * coarseness is one slower retry when a paper really does name a file that
 * exists nowhere, and that retry then fails with the same sentence.
 */
export function wantsNetwork(output: string): boolean {
  return /not found|not loadable|could not be found|failed to (?:open|find)|only cached/i.test(output)
}

/**
 * What goes at the FRONT of an engine's `PATH`, because the engine runs other
 * programs by name and which one it finds is the difference between a
 * bibliography and an error.
 *
 *  - **Tectonic** runs `biber` for a `biblatex` paper, and the biber has to be
 *    the release that matches the biblatex in Tectonic's bundle. When this
 *    module has fetched that one (`install.ts`), its folder — which holds that
 *    one file and nothing else — goes first, ahead of whatever biber the
 *    machine has.
 *  - **Every TeX Live engine** gets its own folder first: `latexmk` runs
 *    `pdflatex`, `biber` and `bibtex` by name, and they must be the ones it
 *    was installed with — the folder may not be on `PATH` at all when the
 *    engine was found by looking where TeX Live installs. The fetched biber is
 *    NOT put ahead of it: a TeX Live's own already matches.
 */
export function pathFirst(engine: Engine, biberDir: string | null): string[] {
  if (engine.name === 'tectonic') return biberDir ? [biberDir] : []
  const at = engine.path.lastIndexOf('/')
  return at > 0 ? [engine.path.slice(0, at)] : []
}

/**
 * The environment an engine is given: what it needs and nothing it does not.
 *
 * `first` is `pathFirst`; `more` is the TeX Live folders `texLiveDirs` found.
 *
 * Not the server's whole environment. A dev server's environment holds
 * whatever the shell that started it held — tokens, among other things — and
 * TeX can read environment variables. `HOME` stays because Tectonic keeps its
 * package cache under it and TeX Live its font cache; the three kpathsea
 * settings say again, for an engine that reads them, what the flags already
 * said.
 */
export function envFor(env: Record<string, string | undefined>, first: readonly string[] = [], more: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CACHE_HOME', 'TECTONIC_CACHE_DIR', 'TEXMFHOME', 'TEXMFVAR', 'SOURCE_DATE_EPOCH']) {
    const value = env[key]
    if (typeof value === 'string' && value) out[key] = value
  }
  const path: string[] = []
  for (const dir of [...first, ...searchDirs(env, more)]) if (dir.startsWith('/') && !path.includes(dir)) path.push(dir)
  out.PATH = path.join(':')
  out.shell_escape = 'f'
  out.openout_any = 'p'
  out.openin_any = 'r'
  return out
}
