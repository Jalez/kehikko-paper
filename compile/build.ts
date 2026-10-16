import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { MAIN, hashesOf, paperRoot, projectOf, readPaper } from '../store.ts'
import {
  HOW_TO_INSTALL,
  chooseEngine,
  envFor,
  findEngines,
  namedEngine,
  needsBiber,
  partRunsFor,
  pathFirst,
  runsFor,
  texLiveDirs,
  wantsNetwork,
  type Engine,
  type EngineName,
  type Run,
} from './engine.ts'
import {
  BWRAP,
  SANDBOX_EXEC,
  TREE_VARS,
  cacheFolders,
  confinedEnv,
  linuxArgv,
  macArgv,
  notFound,
  opened,
  outsideSaid,
  readable,
  texTrees,
  type Places,
} from './confine.ts'
import { canFetchBiber, managed } from './install.ts'
import { biberAbsent, biberAdvice, biberMismatch, biberOffer, noBiber, problemsFrom, tailOf, type BiberMismatch, type Problem } from './log.ts'
import { DRIVER, KEPT_PARTS, driverText, isIntermediate, onlyLine, planOf, toEvict, unresolved, type Plan } from './part.ts'
import { BIBER_VERSION, BUNDLE_BIBLATEX } from './toolchain.ts'
import {
  forward,
  pageMap,
  parseSynctex,
  relativeInput,
  reverse,
  tagsOf,
  type PageRect,
  type PageSpan,
  type SyncTable,
} from './synctex.ts'

/**
 * Compiling a paper, one at a time, and keeping the last PDF that worked.
 *
 * This is the half of the preview that touches the machine: it spawns the
 * engine `engine.ts` chose, with the arguments `engine.ts` wrote, and files
 * what comes out. Everything that can be decided without running anything is
 * in the three pure files beside this one.
 *
 * ## Where the build goes, and why it is not in the project
 *
 * **The operating system's temporary directory**, in a folder named for a hash
 * of the paper's real path: `<tmpdir>/kehikot-paper/<hash>/`.
 *
 * The storage rule in this workspace is that a project's DATA lives under
 * `<project>/.kehikot/<module>/` and nowhere else, and it is worth being exact
 * about why a build is not that:
 *
 *  - **It is derived.** Every byte of it is recomputed from the `.tex` by
 *    pressing nothing. Losing it costs one compile; there is no state in it a
 *    person made.
 *  - **The paper's folder IS `.kehikot/paper/<epic>/`, and that folder may be
 *    committed.** Whether `.kehikot/` is in a project's history is a setting in
 *    the host, and a paper that lives there wants it on. An `.aux`, a `.log`, a
 *    `.synctex.gz` and a PDF beside `main.tex` would be five files in every
 *    `git status`, in every "Save" this module offers, and in every diff — the
 *    litter the user asked not to have. A sibling folder under
 *    `.kehikot/paper/` has the same problem one level up, and would also have
 *    to be told apart from an epic by the code that lists papers.
 *  - **It is per machine.** A SyncTeX file holds absolute paths and a PDF built
 *    by this machine's fonts; neither means anything on another checkout.
 *
 * So: temp, which the host's storage boundary allows by name ("temporary
 * directories are scratch, not storage"). The one cost is that a reboot, or the
 * system's own cleaning of its temp directory, forgets the last good PDF, and
 * the page compiles again on the next open. Tectonic's package cache is its
 * own, under the user's cache directory, and is not this module's to place.
 *
 * ## The folder
 *
 *     <tmpdir>/kehikot-paper/<hash>/work/   the engine's output directory, emptied before every run
 *     <tmpdir>/kehikot-paper/<hash>/good/   main.pdf, main.synctex.gz and meta.json from the last run that produced a PDF
 *     <tmpdir>/kehikot-paper/<hash>/good/aux/     what that run wrote for the NEXT run to read: every `.aux`, the `.bbl`, the `.toc`
 *     <tmpdir>/kehikot-paper/<hash>/parts/<key>/  one picked selection compiled on its own — see "A part on its own", below
 *
 * Two folders because of the rule the page keeps: **a compile that fails must
 * not take the last good PDF off the screen.** The engine never writes into
 * `good/`; a successful run's files are renamed into it, each atomically, and a
 * failed run leaves it exactly as it was.
 *
 * ## What the engine can reach
 *
 * An engine, and every program it starts, reads only the paper (and
 * the project it is in), this build folder and the TeX installation, and
 * writes only here and to `cacheDir()`: `confine.ts` has what and why. Where a
 * machine has nothing to do that with, the engine runs as it did before and
 * the run says `confined: false`, which the page shows on the status line.
 *
 * ## One compile at a time per paper, and the latest save wins
 *
 * A person types, pauses, the page saves and asks for a compile; they type
 * again before it finishes. The compile in flight is now of a file that no
 * longer exists, so it is KILLED — by the pid of the child this process itself
 * spawned, never by name — and the newer one starts. Nobody waits for a PDF of
 * text they have already changed, and two engines never write into one `work/`.
 *
 * ## A part on its own
 *
 * When parts of the epic are picked and their files are `\include`d, the
 * engine is given `\includeonly{…}` ahead of `main.tex` and typesets those
 * chapters alone (`part.ts` has why, and what cannot be). Three things make
 * that work, and all three are folders here and none is the paper's:
 *
 *  - **`good/aux/`** — a full build's intermediates, kept. `\includeonly`
 *    reads the numbers of every chapter it leaves out from that chapter's
 *    `.aux`, so the last full build's have to be where the part's compile can
 *    read them, and `work/` is emptied before every run.
 *  - **`parts/<key>/work/`** — the part's own output directory, seeded from
 *    `good/aux/` and NOT emptied: `latexmk` then knows what changed and runs
 *    the engine once for an edit, where a fresh folder costs three passes.
 *  - **`parts/<key>/good/`** — the last PDF of that selection that compiled,
 *    with its own SyncTeX and its own `meta.json`: which text it is of, which
 *    full build's numbers it read. Kept per selection, the last few used, so
 *    coming back to a part is not a compile.
 *
 * Tectonic reads its inputs from the folder it runs in and nowhere else, so
 * for it there is a fourth: `parts/<key>/tree/`, the paper's folder mirrored
 * with links, with the `.aux` files and the two-line file that says
 * `\includeonly` put into the mirror rather than into the paper.
 *
 * ## When the whole paper is compiled, once parts are picked
 *
 * Not on every save: the picked chapters are, and the rest of the paper is
 * not typeset. The whole paper is compiled when there is no full build to
 * read numbers from; when the page asks for it — the pick changed or was
 * lifted, somebody pressed Compile, a passage outside the part has to be
 * shown; and when the part's own log says a reference or a citation could not
 * be resolved from numbers that are older than the text. One queue for both
 * kinds, so an engine never runs beside another on one paper.
 */

/** How long one run may take before it is killed. A first compile may be downloading a TeX distribution's worth of packages. */
export const TIMEOUT_MS = 180_000

/**
 * How much of an engine's chatter is kept.
 *
 * A paper that loops prints until it is stopped. Past this, output is dropped
 * on the floor — the engine is not killed for being chatty, only for being slow
 * — and the tail that is kept is the part that says why it stopped.
 */
export const MAX_OUTPUT_BYTES = 400_000

/** A PDF this module will serve, and a SyncTeX file it will open. Bounds, not budgets. */
const MAX_PDF_BYTES = 200_000_000
const MAX_SYNCTEX_BYTES = 400_000_000

const PDF = 'main.pdf'
const SYNC = 'main.synctex.gz'
const META = 'meta.json'

/** What the last good build was, kept beside it so a restart of this server does not forget it. */
interface Meta {
  id: string
  at: number
  pages: number | null
  engine: EngineName
  /** The hash of every source file as it was when this PDF was made. */
  hashes: Record<string, string>
  map: Record<string, PageSpan[]>
  /** A hash of the intermediates this build left in `good/aux/`. Absent when it left none. */
  aux?: string
}

/** A part's own last good build: a `Meta`, and what it was made of. */
interface PartMeta extends Meta {
  /** What `\includeonly` was given. */
  only: string[]
  /** The engine, the selection, the text and the full build's numbers, as one hash: the same again is the same PDF. */
  stamp: string
  /** References the part's log could not resolve. */
  unresolved: string[]
}

/** Where one picked selection's own build stands. */
export interface PartStatus {
  /** The selection, as its folder is named. What `/api/pdf` and `/api/sync` are asked with. */
  key: string
  /** What `\includeonly` is given, in the paper's order. Empty when the selection cannot be compiled on its own. */
  only: string[]
  /** Why it cannot, as the one sentence the pane shows. Null when it can. */
  cannot: string | null
  running: boolean
  /** The last run of THIS selection in this process. Null before the first. */
  last: BuildStatus['last']
  /** The last PDF of this selection that compiled. Its pages are sheets of THAT PDF, not pages of the paper. */
  pdf: BuildStatus['pdf']
}

export interface BuildStatus {
  /** The engine that would be, or was, used. Null when none can be. */
  engine: EngineName | null
  /** Every engine found on this machine. */
  engines: EngineName[]
  /** Why there is no engine to use. Empty when there is one. */
  how: string
  running: boolean
  /** The last run, whether or not it produced anything. Null before the first. */
  last: {
    ok: boolean
    at: number
    ms: number
    engine: EngineName
    timedOut: boolean
    problems: Problem[]
    /** The end of what the engine printed. */
    tail: string
    /**
     * Set when the run failed because the biber on this machine is not the one
     * the engine's biblatex wants, or because there is no biber on it at all.
     * `fetchable` is whether this module can download the one that is wanted —
     * the page offers that in place of advice.
     */
    biber?: (BiberMismatch & { fetchable: boolean }) | null
    /**
     * Whether the engine was kept to the paper, the build folder and the TeX
     * installation (`confine.ts`). False when it ran on a machine with
     * nothing to confine it. Absent when no engine ran.
     */
    confined?: boolean
  } | null
  /** The last PDF that compiled. Stays through any number of failures. */
  pdf: {
    id: string
    at: number
    pages: number | null
    hashes: Record<string, string>
    /** Per file of the paper: which pages it reached, and with which lines. */
    map: Record<string, PageSpan[]>
  } | null
}

interface Job {
  generation: number
  child: ChildProcess | null
  tail: Promise<unknown>
  running: boolean
  last: BuildStatus['last']
  table: { id: string; table: SyncTable } | null
  /** Per selection: its last run, and its SyncTeX table once asked for. */
  parts: Map<string, { last: BuildStatus['last']; table: { id: string; table: SyncTable } | null }>
}

const jobs = new Map<string, Job>()

function jobFor(key: string): Job {
  let job = jobs.get(key)
  if (!job) jobs.set(key, (job = { generation: 0, child: null, tail: Promise.resolve(), running: false, last: null, table: null, parts: new Map() }))
  return job
}

/**
 * The build folder for a paper, from its real path.
 *
 * A hash and not the epic's name: two projects both have an epic called
 * `thesis`, and their builds must not be one folder. The root is already
 * realpath'd by `roots()`, so one paper is one hash whichever way it was named.
 */
export function buildDir(root: string): string {
  return join(tmpdir(), 'kehikot-paper', createHash('sha256').update(root).digest('hex').slice(0, 24))
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** TeX Live folders that are not on PATH. Looked for on every ask, like the engines in them. */
function texLive(): string[] {
  return texLiveDirs(names)
}

/** The engines on this machine. Looked for on every ask: installing one should not need a restart. */
export function engines(): Engine[] {
  return findEngines(executable, process.env, { dirs: texLive(), tectonic: managed().tectonic })
}

function readMeta(dir: string): Meta | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'good', META), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const meta = parsed as Meta
    if (typeof meta.id !== 'string' || !existsSync(join(dir, 'good', PDF))) return null
    return meta
  } catch {
    return null
  }
}

/** Where a paper's build stands, without compiling anything. */
export function buildStatus(epic: string, project: string | null): BuildStatus | null {
  const root = paperRoot(epic, project)
  if (!root) return null
  const found = engines()
  let source = ''
  try {
    source = readFileSync(join(root, MAIN), 'utf8')
  } catch {
    /* `paperRoot` said there is a `main.tex`; if it went between the two
       calls the engine choice below is made as though it named none. */
  }
  const chosen = chooseEngine(found, namedEngine(source), needsBiber(source))
  const job = jobs.get(root)
  const meta = readMeta(buildDir(root))
  return {
    engine: chosen.ok ? chosen.engine.name : null,
    engines: found.map((one) => one.name),
    how: chosen.ok ? '' : chosen.why,
    running: job?.running ?? false,
    last: job?.last ?? null,
    pdf: meta ? { id: meta.id, at: meta.at, pages: meta.pages, hashes: meta.hashes, map: meta.map } : null,
  }
}

/**
 * Compile a paper, superseding any compile of it already running.
 *
 * Resolves when the paper has settled: with this run's result, or — if a newer
 * request killed this one — with whatever stands once the newer one is done.
 * It never rejects; an engine that cannot be spawned is a failed run with a
 * sentence in it.
 */
export async function compile(epic: string, project: string | null): Promise<BuildStatus | null> {
  const root = paperRoot(epic, project)
  if (!root) return null
  const job = jobFor(root)
  job.generation += 1
  const mine = job.generation
  stop(job.child)

  const run = job.tail.then(async () => {
    if (mine !== job.generation) return
    job.running = true
    try {
      job.last = await once(epic, project, root, job, () => mine !== job.generation)
    } finally {
      job.running = false
      job.child = null
    }
  })
  job.tail = run.catch(() => undefined)
  await job.tail
  /* Superseded: wait for whoever superseded this, then report what stands. */
  while (mine !== job.generation) {
    const newest = job.generation
    await job.tail
    if (newest === job.generation) break
  }
  return buildStatus(epic, project)
}

async function once(
  epic: string,
  project: string | null,
  root: string,
  job: Job,
  superseded: () => boolean,
): Promise<BuildStatus['last']> {
  const started = Date.now()
  const paper = readPaper(epic, project)
  const hashes = hashesOf(epic, project) ?? {}
  const source = (() => {
    try {
      return readFileSync(join(root, MAIN), 'utf8')
    } catch {
      return ''
    }
  })()
  const chosen = chooseEngine(engines(), namedEngine(source), needsBiber(source))
  if (!chosen.ok) return job.last
  const engine = chosen.engine

  const dir = buildDir(root)
  const work = join(dir, 'work')
  try {
    /* Emptied, so that a PDF left by the run before cannot be mistaken for
       this run's. `dir` is under the temp directory by construction — it is
       built from `tmpdir()` and a hex digest, with nothing of the caller's in
       it — which is what makes a recursive remove here something to write. */
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    mkdirSync(join(dir, 'good'), { recursive: true })
    /* TeX Live's engines write `chapters/wire.aux` under the output directory
       for an `\include{chapters/wire}` and do not make `chapters/` themselves. */
    for (const file of paper?.files ?? []) {
      const sub = dirname(file)
      if (sub !== '.') mkdirSync(join(work, sub), { recursive: true })
    }
  } catch (error) {
    return failed(engine, started, `The build folder ${dir} could not be made: ${(error as Error).message}`)
  }

  const went = await runAll(runsFor(engine, MAIN, work), root, engine, started, job, superseded, { root, project, biber: needsBiber(source) })
  if (went === 'superseded') return job.last
  if ('error' in went) return failed(engine, started, `${engine.name} could not be started: ${went.error}`)
  const { output, timedOut, code, fetching, places, confined } = went

  const resolve = (name: string): string | null => {
    const files = paper?.files ?? [MAIN]
    const plain = (relativeInput(name, root) ?? name).replace(/^\.\//, '')
    return files.find((file) => file === plain || file === `${plain}.tex`) ?? null
  }
  const log = logOf(join(work, 'main.log'))
  /* The one tool failure this module can do something about: biber of the
     wrong release. Where the right one can be fetched, the sentence says so
     and the page puts a button beside it. */
  const absent = engine.name === 'tectonic' && code !== 0 && biberAbsent(output)
  const mismatch: BiberMismatch | null =
    engine.name !== 'tectonic' ? null : absent ? { have: null, biblatex: BUNDLE_BIBLATEX, need: BIBER_VERSION } : biberMismatch(output)
  const fetchable = mismatch ? canFetchBiber(mismatch.need) : false
  const problems = problemsFrom(output, log, resolve, fetchable ? biberOffer : biberAdvice)
  /* Tectonic's own words for a missing biber are the operating system's "No
     such file or directory", about nothing in particular. Said first. */
  if (absent) problems.unshift({ severity: 'error', file: null, line: null, message: noBiber(BIBER_VERSION, fetchable) })
  if (timedOut) {
    problems.unshift({
      severity: 'error',
      file: null,
      line: null,
      message:
        `${engine.name} was stopped after ${Math.round(TIMEOUT_MS / 1000)} seconds without finishing.`
        /* A first compile on a machine downloads the packages the paper uses,
           one at a time, and a long paper's worth can outlast the limit. What
           arrived is in Tectonic's cache, so the next press does not start
           over — and a person told only "stopped" would not know to press. */
        + (fetching ? ' It was fetching the LaTeX packages this paper uses, for the first time on this machine; what it fetched is kept, so compile again and it carries on from there.' : ''),
    })
  }

  const made = join(work, PDF)
  const ok = !timedOut && code === 0 && existsSync(made)
  if (!ok && places) problems.unshift(...outside([output, log, logOf(join(work, 'main.blg'))].join('\n'), root, places))
  if (ok) {
    try {
      const pdf = readFileSync(made)
      const id = createHash('sha256').update(pdf).digest('hex').slice(0, 16)
      let pages: number | null = null
      let map: Record<string, PageSpan[]> = {}
      const sync = join(work, SYNC)
      if (existsSync(sync)) {
        const table = tableFrom(sync)
        if (table) {
          pages = table.pages
          map = pageMap(table, root)
          job.table = { id, table }
        }
        renameSync(sync, join(dir, 'good', SYNC))
      } else {
        rmSync(join(dir, 'good', SYNC), { force: true })
        job.table = null
      }
      renameSync(made, join(dir, 'good', PDF))
      /* After the PDF, which is what this run was for: a build whose
         intermediates could not be kept is still a build, and only the parts
         compiled on their own go without. */
      const aux = keepIntermediates(work, join(dir, 'good'))
      const meta: Meta = { id, at: Date.now(), pages, engine: engine.name, hashes, map, ...(aux ? { aux } : {}) }
      const scratch = join(dir, 'good', `${META}.tmp`)
      writeFileSync(scratch, JSON.stringify(meta))
      renameSync(scratch, join(dir, 'good', META))
    } catch (error) {
      return failed(engine, started, `The PDF was made and could not be kept: ${(error as Error).message}`)
    }
  } else if (!problems.some((one) => one.severity === 'error')) {
    problems.unshift({
      severity: 'error',
      file: null,
      line: null,
      message: `${engine.name} stopped without making a PDF and without naming an error. Its last words are below.`,
    })
  }

  return {
    ok,
    at: Date.now(),
    ms: Date.now() - started,
    engine: engine.name,
    timedOut,
    problems,
    tail: tailOf(output),
    biber: !ok && mismatch ? { ...mismatch, fetchable } : null,
    confined,
  }
}

/**
 * Run an engine's argument lists in order, to the first that settles it.
 *
 * Shared by the whole paper and a part of it: the same timeout, the same
 * cached-only-then-fetching pair for Tectonic, the same child a newer request
 * kills.
 */
async function runAll(
  runs: readonly Run[],
  cwd: string,
  engine: Engine,
  started: number,
  job: Job,
  superseded: () => boolean,
  paper: { root: string; project: string | null; biber: boolean },
): Promise<
  | 'superseded'
  | { error: string }
  | { output: string; timedOut: boolean; code: number | null; fetching: boolean; places: Places | null; confined: boolean }
> {
  let output = ''
  let timedOut = false
  let code: number | null = null
  let fetching = false
  /* Decided once per compile: which biber Tectonic finds, and that a TeX Live
     engine finds its own siblings. See `pathFirst`. */
  const first = pathFirst(engine, managed().biberDir)
  const plain = envFor(process.env, first, texLive())
  /* An engine is kept to the paper, the build folder and the TeX
     installation where the machine can do that; where it cannot, the engine
     runs as it always has and the status says so. See `confine.ts`. */
  const guard = confinement(engine, paper.root, paper.project, cwd, plain, first)
  const confined = guard !== null
  let env = plain
  if (guard) {
    const unpacked = await biberReady(guard.places, plain, TIMEOUT_MS - (Date.now() - started), job, paper.biber)
    if (superseded()) return 'superseded'
    env = confinedEnv(plain, guard.places, unpacked, engine.name)
  }
  let mended = false
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!
    const left = TIMEOUT_MS - (Date.now() - started)
    if (left <= 0) {
      timedOut = true
      break
    }
    fetching = engine.name === 'tectonic' && !run.cachedOnly
    const ran = await spawned(guard ? guard.wrap(run.argv, fetching) : run.argv, cwd, left, job, env)
    if (superseded()) return 'superseded'
    /* A biber that was not unpacked beforehand — the paper did not look like
       one that runs it — or whose unpacked files have since lost one, stops
       with its own words for that. Unpacked, once, and the run made again. */
    const broken = unpackedBroken(ran.output)
    if (guard && !mended && !ran.timedOut && ran.code !== 0 && (broken || notUnpacked(ran.output))) {
      mended = true
      if (broken) forgetUnpacked(guard.places)
      /* `latexmk` remembers that biber failed and would not run it again. */
      const out = run.argv.find((arg) => arg.startsWith('-outdir='))?.slice('-outdir='.length)
      if (out) for (const name of names(out)) if (name.endsWith('.fdb_latexmk')) rmSync(join(out, name), { force: true })
      const unpacked = await biberReady(guard.places, plain, TIMEOUT_MS - (Date.now() - started), job, true)
      if (superseded()) return 'superseded'
      env = confinedEnv(plain, guard.places, unpacked, engine.name)
      i -= 1
      continue
    }
    output = ran.output
    timedOut = ran.timedOut
    code = ran.code
    if (ran.error) return { error: ran.error }
    if (timedOut) break
    /* A cached-only run that failed for want of a file gets its second,
       fetching run; one that failed for any other reason does not, because the
       second would say the same thing thirty seconds later. One that worked
       skips the fetching run entirely. */
    if (run.cachedOnly) {
      if (code === 0) break
      if (!wantsNetwork(output)) break
      continue
    }
    if (code !== 0) break
  }
  return { output, timedOut, code, fetching, places: guard?.places ?? null, confined }
}

/**
 * The folder the engines' own caches are kept in, for every paper.
 *
 * In the temporary directory beside the build folders, and derived like them:
 * the fonts an engine generated, LuaTeX's font cache, and what biber unpacks.
 * A confined engine cannot write to the TeX trees those would otherwise go to.
 */
export function cacheDir(): string {
  return join(tmpdir(), 'kehikot-paper', 'tex-cache')
}

function real(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

const treesFound = new Map<string, string[]>()

/**
 * The folders of the TeX installation an engine belongs to, as real paths.
 *
 * Asked of the `kpsewhich` beside the engine, once per engine and per setting
 * of the person's trees — it is the installation's own answer, whatever its
 * layout. Where there is no `kpsewhich`, the folder the engine is in and the
 * folder it really is in are what there is.
 */
function treesOf(engine: Engine, env: Record<string, string>, home: string | null): string[] {
  const key = [engine.path, env.TEXMFHOME ?? '', env.TEXMFVAR ?? '', env.HOME ?? ''].join('\0')
  const known = treesFound.get(key)
  if (known) return known
  const dir = dirname(engine.path)
  const more = [dir]
  const at = real(engine.path)
  if (at) more.push(dirname(at))
  let said = ''
  let asked = false
  const kpsewhich = join(dir, 'kpsewhich')
  if (engine.name === 'tectonic') {
    /* No trees: what Tectonic reads besides itself is its own settings and the packages it fetched (`tectonicKeeps`). */
    if (home) more.push(join(home, 'Library', 'Application Support', 'Tectonic'), join(home, '.config', 'Tectonic'))
    asked = true
  } else if (executable(kpsewhich)) {
    try {
      const ran = spawnSync(kpsewhich, [`--expand-var=${TREE_VARS}`], { cwd: tmpdir(), env, shell: false, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      if (ran.status === 0 && typeof ran.stdout === 'string') {
        said = ran.stdout.slice(0, 20_000)
        asked = true
      }
    } catch {
      /* Then the two folders above. */
    }
  }
  const found = texTrees('', texTrees(said, more, home).flatMap((tree) => real(tree) ?? []), home)
  /* Kept only when the installation answered: one that did not may yet. */
  if (asked) treesFound.set(key, found)
  return found
}

/** The wrappers that have been seen to work in this process, by what they were given. */
const applied = new Set<string>()

/**
 * How to run this paper's engine confined, or null where this machine cannot.
 *
 * Null is not an error: the engine then runs as it did before there was any
 * of this, and the run's status carries `confined: false`. It is null when the
 * platform has no such tool, when a place cannot be named to it, and when the
 * tool itself will not start here — tried once with a program that does
 * nothing, because a wrapper that fails would otherwise be every compile
 * failing for a reason that is not in the paper.
 */
function confinement(
  engine: Engine,
  root: string,
  project: string | null,
  cwd: string,
  env: Record<string, string>,
  beside: readonly string[],
): { places: Places; wrap: (argv: string[], network: boolean) => string[] } | null {
  const tool = process.platform === 'darwin' ? (executable(SANDBOX_EXEC) ? SANDBOX_EXEC : null) : process.platform === 'linux' ? (BWRAP.find(executable) ?? null) : null
  if (!tool) return null
  try {
    const home = env.HOME ? real(env.HOME) : null
    const paper = real(root)
    const build = real(buildDir(root))
    if (!paper || !build) return null
    const cache = cacheDir()
    mkdirSync(cache, { recursive: true })
    const places: Places = {
      paper,
      project: opened(projectOf(project), paper, home),
      build,
      cache: realpathSync(cache),
      /* `beside`: the folders put first on the engine's `PATH` (`pathFirst`), whose programs it runs by name. */
      tex: texTrees('', [...treesOf(engine, env, home), ...beside.flatMap((dir) => real(dir) ?? [])], home),
      kept: engine.name === 'tectonic' ? tectonicKeeps(env, home) : [],
      home,
    }
    for (const dir of cacheFolders(places)) mkdirSync(dir, { recursive: true })
    const wrap = (argv: string[], network = false): string[] | null =>
      tool === SANDBOX_EXEC ? macArgv(places, argv, network) : linuxArgv(tool, places, argv, cwd, network)
    const probe = wrap(['/usr/bin/true'])
    if (!probe) return null
    const key = JSON.stringify(probe)
    if (!applied.has(key)) {
      const ran = spawnSync(probe[0]!, probe.slice(1), { cwd, env: { PATH: '/usr/bin:/bin' }, shell: false, timeout: 10_000, stdio: 'ignore' })
      if (ran.status !== 0) return null
      applied.add(key)
    }
    return { places, wrap: (argv, network) => wrap(argv, network) ?? argv }
  } catch {
    return null
  }
}

/**
 * Where Tectonic keeps the packages it fetched: read and written by it.
 *
 * Its own choice of place, said the way it says it — `TECTONIC_CACHE_DIR`, or
 * the platform's cache folder. Named even when it is not there yet, since the
 * first run is what makes it.
 */
function tectonicKeeps(env: Record<string, string>, home: string | null): string[] {
  const said = env.TECTONIC_CACHE_DIR
  const at = said ? said : !home ? null : process.platform === 'darwin' ? join(home, 'Library', 'Caches', 'Tectonic') : join(env.XDG_CACHE_HOME || join(home, '.cache'), 'Tectonic')
  if (!at || !isAbsolute(at)) return []
  const whole = real(at)
  if (whole) return [whole]
  const parent = real(dirname(at))
  return parent ? [join(parent, at.slice(dirname(at).length + 1))] : []
}

/**
 * The biber an engine would run, unpacked, where the confined engine finds it.
 *
 * biber is a packed program: it unpacks itself into the temporary folder the
 * first time and runs from there afterwards. On a Mac it is, further, one file
 * for two processors, and starts every time by asking the system's developer
 * tools to take out this machine's half — which a confined program has no
 * business reaching. So it is run once here, by this module and with no paper
 * anywhere near it (`--version`), to unpack into the cache; and the half it
 * took out, which is a whole biber, is linked from a folder of the cache's
 * `bin` that goes first on the confined engine's `PATH`. Twelve seconds, once;
 * and a biber that then starts faster than the one it came from, having
 * nothing to take out.
 *
 * The folder is named for which biber it is of — its path, size and date — so
 * an updated TeX Live gets a fresh one, and Tectonic's biber and TeX Live's
 * each have theirs. Answers that folder, or null: where biber is not such a
 * file (a distribution's own package, any Linux) there is nothing to link and
 * the engine runs the one on its `PATH`.
 *
 * @param unpack whether to unpack one that is not: only for a paper that will run it
 */
async function biberReady(places: Places, env: Record<string, string>, left: number, job: Job, unpack: boolean): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const found = (env.PATH ?? '').split(':').map((dir) => join(dir, 'biber')).find(executable)
    const theirs = found ? real(found) : null
    if (!theirs) return null
    const is = statSync(theirs)
    const dir = join(places.cache, 'bin', createHash('sha256').update(`${theirs}\n${is.size}\n${is.mtimeMs}`).digest('hex').slice(0, 16))
    const link = join(dir, 'biber')
    if (executable(link)) return dir
    if (existsSync(join(dir, NOT_PACKED))) return null
    if (!unpack || left <= 0) return null
    const tmp = join(places.cache, 'tmp')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const ran = await spawned([theirs, '--version'], tmp, left, job, { HOME: env.HOME ?? '', PATH: `${dirname(theirs)}:/usr/bin:/bin`, TMPDIR: tmp })
    if (ran.code !== 0) return null
    const halves = names(tmp)
      .filter((name) => name.startsWith('par-'))
      .flatMap((user) => names(join(tmp, user)).map((cache) => join(tmp, user, cache, 'thin', 'biber')))
      .filter(executable)
      .map((path) => ({ path, at: statSync(path).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    /* The one just taken out is the newest: every start takes it out again. */
    if (halves[0] && Date.now() - halves[0].at < 120_000) {
      symlinkSync(halves[0].path, link)
      return dir
    }
    writeFileSync(join(dir, NOT_PACKED), '')
    return null
  } catch {
    /* Then the engine runs the biber on its `PATH`, and says what it says. */
    return null
  }
}

const NOT_PACKED = 'not-packed'

/** Forget every unpacked biber: what it unpacked is no longer whole, and the next `biberReady` unpacks again. */
function forgetUnpacked(places: Places): void {
  rmSync(join(places.cache, 'bin'), { recursive: true, force: true })
  mkdirSync(join(places.cache, 'bin'), { recursive: true })
  const tmp = join(places.cache, 'tmp')
  for (const name of names(tmp)) if (name.startsWith('par-')) rmSync(join(tmp, name), { recursive: true, force: true })
}

/** Whether biber stopped at taking its own half out of itself, which a confined one cannot: `biberReady`. */
function notUnpacked(output: string): boolean {
  return /extracting \S+ binary with lipo failed|cannot find \/usr\/bin\/lipo/.test(output)
}

/** Whether a tool that unpacks itself stopped because what it unpacked is no longer whole. */
function unpackedBroken(output: string): boolean {
  return /par-[0-9a-f]+\/cache-[0-9a-f]+/.test(output) && /Can't locate \S+ in @INC|Compilation failed in require|BEGIN failed--compilation aborted/.test(output)
}

/** Extensions an engine adds to a name by itself, for telling a file that is not there from one that is out of reach. */
const TRIED = ['', '.tex', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.bib', '.sty', '.cls']

/**
 * What to say about files the engine could not find that ARE there.
 *
 * A confined engine is told "no such file" for a file outside what it may
 * read, and says "not found" — the sentence for a misspelt name. A person who
 * can see the file in their own folder deserves the other sentence.
 */
function outside(output: string, root: string, places: Places): Problem[] {
  const out: Problem[] = []
  for (const name of notFound(output)) {
    const base = isAbsolute(name) ? name : join(root, name)
    for (const ext of TRIED) {
      const at = real(base + ext)
      if (at === null) continue
      if (!readable(at, places)) out.push({ severity: 'error', file: null, line: null, message: outsideSaid(name, places.project !== null) })
      break
    }
  }
  return out
}

function logOf(path: string): string {
  try {
    return readFileSync(path, 'latin1').slice(0, 2_000_000)
  } catch {
    /* No log is an ordinary outcome: the engine may not have got that far. */
    return ''
  }
}

/** Every file under a folder, as paths from it. Bounded: a build folder is small, and one that is not is not walked forever. */
function filesUnder(dir: string, depth = 0, out: string[] = [], from = dir): string[] {
  if (depth > 6 || out.length > 4000) return out
  for (const name of names(dir)) {
    const path = join(dir, name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) filesUnder(path, depth + 1, out, from)
    else if (stat.isFile()) out.push(relative(from, path))
  }
  return out
}

/** The most one kept intermediate may be. An `.aux` is kilobytes; this is a bound against something that is not one. */
const MAX_INTERMEDIATE_BYTES = 20_000_000

/**
 * Keep what a full build wrote for the next run to read, in `good/aux/`.
 *
 * Copied out of `work/`, which the next compile empties, into a folder made
 * beside the old one and swapped for it — a compile of one part may be reading
 * the old one's files until this run is done. Answers a hash of what was kept,
 * which is how a part's build knows the numbers it read are still the ones
 * that stand; null when nothing could be kept.
 */
function keepIntermediates(work: string, good: string): string | null {
  const next = join(good, 'aux.next')
  try {
    rmSync(next, { recursive: true, force: true })
    mkdirSync(next, { recursive: true })
    const hash = createHash('sha256')
    for (const name of filesUnder(work).filter(isIntermediate).sort()) {
      const from = join(work, name)
      if (statSync(from).size > MAX_INTERMEDIATE_BYTES) continue
      const bytes = readFileSync(from)
      mkdirSync(dirname(join(next, name)), { recursive: true })
      writeFileSync(join(next, name), bytes)
      hash.update(name).update('\0').update(bytes).update('\0')
    }
    rmSync(join(good, 'aux'), { recursive: true, force: true })
    renameSync(next, join(good, 'aux'))
    return hash.digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

function failed(engine: Engine, started: number, why: string): BuildStatus['last'] {
  return {
    ok: false,
    at: Date.now(),
    ms: Date.now() - started,
    engine: engine.name,
    timedOut: false,
    problems: [{ severity: 'error', file: null, line: null, message: why }],
    tail: '',
  }
}

/**
 * Stop an engine this process started, and everything it started.
 *
 * By pid, and only ever the pid of a child spawned HERE: never a name and never
 * a pattern, because the person's own editor may be running the same engine on
 * the same paper. The NEGATIVE pid is the whole process group, which is why
 * `spawned` starts each engine as the leader of a group of its own —
 * `latexmk` runs `pdflatex` runs `bibtex`, and killing only the first leaves
 * the other two writing into a build folder the next compile has already
 * emptied.
 */
function stop(child: ChildProcess | null): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* No such group: it finished between the check and the kill, or the
       platform gave it none. The child alone, then. */
    child.kill('SIGKILL')
  }
}

/**
 * Run one argument list to its end, or to the timeout.
 *
 * `detached` makes the engine the leader of its own process group so that
 * `stop` can end all of it; it is still this process's child, still piped, and
 * is not unref'd — the server waits for it like any other.
 *
 * `argv` is the engine's own argument list, or — on a machine that can —
 * that list behind the program that keeps it to the paper,
 * the build folder and the TeX installation (`confinement`). That program
 * replaces itself with the engine or stays its parent in the same group, so
 * the pid here is still the one `stop` ends everything by.
 *
 * `shell: false` is the default and is written anyway, because it is the line
 * a reviewer looks for. `stdin` is closed: an engine that stops to ask a
 * question at a terminal that is not there would otherwise wait for the
 * timeout to answer it.
 */
function spawned(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  job: Job,
  env: Record<string, string>,
): Promise<{ code: number | null; output: string; timedOut: boolean; error: string | null }> {
  return new Promise((done) => {
    let child: ChildProcess
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      done({ code: null, output: '', timedOut: false, error: (error as Error).message })
      return
    }
    job.child = child
    const chunks: Buffer[] = []
    let size = 0
    let timedOut = false
    let settled = false
    const keep = (chunk: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) return
      const piece = chunk.subarray(0, MAX_OUTPUT_BYTES - size)
      size += piece.length
      chunks.push(piece)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => {
      timedOut = true
      stop(child)
    }, timeoutMs)
    const finish = (code: number | null, error: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (job.child === child) job.child = null
      done({ code, output: Buffer.concat(chunks).toString('utf8'), timedOut, error })
    }
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code, null))
  })
}

function tableFrom(path: string): SyncTable | null {
  try {
    const packed = readFileSync(path)
    /* latin1, not utf8: the file is ASCII except for file names, the parser
       reads only digits and punctuation out of the records, and a decode that
       can never throw or re-encode is the cheap one. */
    return parseSynctex(gunzipSync(packed, { maxOutputLength: MAX_SYNCTEX_BYTES }).toString('latin1'))
  } catch {
    return null
  }
}

/** The SyncTeX table of the last good build — of the whole paper, or of one selection's own — parsed once per build and kept in memory. */
function tableOf(root: string, part: string | null = null): { table: SyncTable; meta: Meta } | null {
  const job = jobFor(root)
  if (part !== null) {
    if (!PART_KEY.test(part)) return null
    const pdir = partDir(root, part)
    const meta = readPartMeta(pdir)
    if (!meta) return null
    let held = job.parts.get(part)
    if (!held) job.parts.set(part, (held = { last: null, table: null }))
    if (held.table?.id !== meta.id) {
      const table = tableFrom(join(pdir, 'good', SYNC))
      held.table = table ? { id: meta.id, table: rebased(table, [join(pdir, 'tree')], root) } : null
    }
    return held.table ? { table: held.table.table, meta } : null
  }
  const dir = buildDir(root)
  const meta = readMeta(dir)
  if (!meta) return null
  if (job.table?.id !== meta.id) {
    const table = tableFrom(join(dir, 'good', SYNC))
    job.table = table ? { id: meta.id, table } : null
  }
  return job.table ? { table: job.table.table, meta } : null
}

/** The last good PDF's bytes: the whole paper's, or — `part` — one selection's own. */
export function readPdf(epic: string, project: string | null, part: string | null = null): { bytes: Uint8Array; id: string } | null {
  const root = paperRoot(epic, project)
  if (!root) return null
  if (part !== null && !PART_KEY.test(part)) return null
  const dir = part === null ? buildDir(root) : partDir(root, part)
  const meta = part === null ? readMeta(dir) : readPartMeta(dir)
  if (!meta) return null
  try {
    const path = join(dir, 'good', PDF)
    if (statSync(path).size > MAX_PDF_BYTES) return null
    return { bytes: readFileSync(path), id: meta.id }
  } catch {
    return null
  }
}

/**
 * Where lines of a file came out in the last good PDF. Null when there is no build to ask.
 *
 * `part` asks one selection's own PDF, and the pages in the answer are then
 * sheets of THAT PDF. Every question about a place on screen names the PDF
 * that is on screen: a rectangle from one drawn on the other is a mark in the
 * wrong place.
 */
export function syncForward(
  epic: string,
  project: string | null,
  file: string,
  from: number,
  to: number,
  part: string | null = null,
): { build: string; rects: PageRect[]; exact: boolean; line: number | null } | null {
  const root = paperRoot(epic, project)
  if (!root) return null
  const held = tableOf(root, part)
  if (!held) return null
  return { build: held.meta.id, ...forward(held.table, tagsOf(held.table, root, file), from, to) }
}

/** Which file and line a point of the last good PDF — or of one selection's own — came from. */
export function syncReverse(
  epic: string,
  project: string | null,
  page: number,
  x: number,
  y: number,
  part: string | null = null,
): { build: string; file: string; line: number } | null {
  const root = paperRoot(epic, project)
  if (!root) return null
  const held = tableOf(root, part)
  if (!held) return null
  const name = (tag: number) => relativeInput(held.table.inputs.get(tag) ?? '', root)
  const found = reverse(held.table, (tag) => name(tag) !== null, page, x, y)
  if (!found) return null
  const file = name(found.tag)
  return file === null ? null : { build: held.meta.id, file, line: found.line }
}

/* ---- A part on its own ---------------------------------------------------- */

const PART_KEY = /^[0-9a-f]{16}$/

/** A selection's folder name: a hash of what `\includeonly` is given, so one selection is one folder however its parts were ticked. */
function partKey(only: readonly string[]): string {
  return createHash('sha256').update(only.join('\0')).digest('hex').slice(0, 16)
}

function partDir(root: string, key: string): string {
  return join(buildDir(root), 'parts', key)
}

function readPartMeta(pdir: string): PartMeta | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(pdir, 'good', META), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const meta = parsed as PartMeta
    if (typeof meta.id !== 'string' || typeof meta.stamp !== 'string' || !existsSync(join(pdir, 'good', PDF))) return null
    return meta
  } catch {
    return null
  }
}

/**
 * A table whose files are named from the paper's folder, whichever folder the engine ran in.
 *
 * Tectonic compiles a part in a mirror of the paper's folder (`mirror`), so
 * its table names `…/tree/chapters/a.tex`. Everything that reads a table asks
 * it about the paper's own files; the names are moved back once, here.
 */
function rebased(table: SyncTable, trees: readonly string[], root: string): SyncTable {
  const all = [...trees]
  for (const tree of trees) {
    try {
      all.push(realpathSync(tree))
    } catch {
      /* Not there: a TeX Live build has no mirror. */
    }
  }
  const inputs = new Map<number, string>()
  for (const [tag, name] of table.inputs) {
    const tree = all.find((one) => name.startsWith(`${one}/`))
    inputs.set(tag, tree ? `${root}/${name.slice(tree.length + 1)}` : name)
  }
  return { ...table, inputs }
}

/** How the picked files can be compiled on their own, read off the paper as it is on disk now. */
function planFor(epic: string, project: string | null, files: readonly string[]): { plan: Plan | null; files: string[] } {
  const paper = readPaper(epic, project)
  if (!paper) return { plan: null, files: [] }
  const picked = paper.files.filter((file) => files.includes(file))
  return { plan: planOf(picked, paper), files: paper.files }
}

/** Where one selection's own build stands, without compiling anything. Null when there is no paper, or nothing of it is picked. */
export function partStatus(epic: string, project: string | null, files: readonly string[]): PartStatus | null {
  const root = paperRoot(epic, project)
  if (!root) return null
  const { plan } = planFor(epic, project, files)
  if (!plan) return null
  if (plan.cannot !== undefined) return { key: '', only: [], cannot: plan.cannot, running: false, last: null, pdf: null }
  const key = partKey(plan.only)
  const job = jobs.get(root)
  const meta = readPartMeta(partDir(root, key))
  return {
    key,
    only: plan.only,
    cannot: null,
    running: job?.running ?? false,
    last: job?.parts.get(key)?.last ?? null,
    pdf: meta ? { id: meta.id, at: meta.at, pages: meta.pages, hashes: meta.hashes, map: meta.map } : null,
  }
}

/**
 * Compile the picked files on their own, superseding whatever is compiling.
 *
 * In the same queue as `compile`, so that one paper has one engine running:
 * a newer request of either kind kills the one in flight.
 *
 * `full` asks for the whole paper to be OF THIS TEXT first — it is compiled
 * when it is not, and left alone when it is. `force` compiles both whatever
 * stands: somebody pressed Compile. Without either the whole paper is still
 * compiled when there is no full build whose numbers a part could read, and
 * when the part's log says it could not resolve something from numbers older
 * than the text.
 *
 * Resolves with both statuses, because either may have changed. Never rejects.
 */
export async function compilePart(
  epic: string,
  project: string | null,
  files: readonly string[],
  ask: { full?: boolean; force?: boolean } = {},
): Promise<{ build: BuildStatus; part: PartStatus | null } | null> {
  const root = paperRoot(epic, project)
  if (!root) return null
  const job = jobFor(root)
  job.generation += 1
  const mine = job.generation
  stop(job.child)
  const superseded = () => mine !== job.generation

  const run = job.tail.then(async () => {
    if (superseded()) return
    const { plan } = planFor(epic, project, files)
    if (!plan || plan.cannot !== undefined) return
    job.running = true
    try {
      const dir = buildDir(root)
      const stale = () => {
        const meta = readMeta(dir)
        return !meta || !sameHashes(meta.hashes, hashesOf(epic, project) ?? {})
      }
      const numbered = () => {
        const meta = readMeta(dir)
        return Boolean(meta?.aux) && existsSync(join(dir, 'good', 'aux'))
      }
      const whole = async () => {
        job.last = await once(epic, project, root, job, superseded)
      }
      if (ask.force || !numbered() || (ask.full && stale())) {
        await whole()
        if (superseded()) return
      }
      const key = partKey(plan.only)
      const held = job.parts.get(key) ?? { last: null, table: null }
      job.parts.set(key, held)
      if (!numbered()) {
        /* No full build to read numbers from, and the one just tried failed:
           what it said is what there is to say about this part too. */
        held.last = job.last
        return
      }
      let made = await partOnce(epic, project, root, plan.only, job, superseded, ask.force === true)
      if (made === 'superseded') return
      /* `??` where a number should be, read from numbers older than the text:
         the whole paper is compiled, and the part again from what it left. */
      if (made.unresolved.length && stale()) {
        await whole()
        if (superseded()) return
        if (job.last?.ok) {
          made = await partOnce(epic, project, root, plan.only, job, superseded, false)
          if (made === 'superseded') return
        }
      }
      held.last = made.last
    } finally {
      job.running = false
      job.child = null
    }
  })
  job.tail = run.catch(() => undefined)
  await job.tail
  while (mine !== job.generation) {
    const newest = job.generation
    await job.tail
    if (newest === job.generation) break
  }
  const build = buildStatus(epic, project)
  return build ? { build, part: partStatus(epic, project, files) } : null
}

function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/**
 * The paper's folder, mirrored with links, for an engine that reads nowhere else.
 *
 * Tectonic finds `\input` files — and the `.aux` files `\includeonly` reads —
 * in the folder its main file is in, and has no way to be told another. The
 * paper's folder is not somewhere an `.aux` may be put. So the folder is
 * mirrored: every entry a link to the paper's own, except the folders an
 * intermediate has to sit in, which are real folders of links. The
 * intermediates are copied in beside them, the full build's `main.*` under the
 * name of the two-line file that is compiled here, and that file is written.
 * Made again for every run, since the paper's folder may have gained a file.
 */
function mirror(root: string, tree: string, aux: string, only: readonly string[]): void {
  rmSync(tree, { recursive: true, force: true })
  mkdirSync(tree, { recursive: true })
  const kept = filesUnder(aux)
  const real = new Set<string>()
  for (const name of kept) for (let dir = dirname(name); dir !== '.'; dir = dirname(dir)) real.add(dir)
  const link = (at: string, depth: number): void => {
    for (const name of names(join(root, at))) {
      /* Dot-entries are a repository's and an editor's; no paper names one. */
      if (name.startsWith('.')) continue
      const here = at ? join(at, name) : name
      if (real.has(here) && depth < 6) {
        mkdirSync(join(tree, here), { recursive: true })
        link(here, depth + 1)
      } else symlinkSync(join(root, here), join(tree, here))
    }
  }
  link('', 0)
  for (const name of kept) {
    const to = join(tree, name.startsWith('main.') ? `${DRIVER}${name.slice('main'.length)}` : name)
    mkdirSync(dirname(to), { recursive: true })
    /* A link by that name is the paper's own leftover `.aux`: the build's replaces it here, in the mirror. */
    rmSync(to, { force: true })
    copyFileSync(join(aux, name), to)
  }
  writeFileSync(join(tree, `${DRIVER}.tex`), driverText(only))
}

/**
 * One compile of one selection.
 *
 * Skipped altogether when the last good PDF of this selection was made by
 * this engine from this text and these numbers (`stamp`): coming back to a
 * part is then a read of a folder. `again` compiles regardless.
 */
async function partOnce(
  epic: string,
  project: string | null,
  root: string,
  only: readonly string[],
  job: Job,
  superseded: () => boolean,
  again: boolean,
): Promise<'superseded' | { last: BuildStatus['last']; unresolved: string[] }> {
  const started = Date.now()
  const paper = readPaper(epic, project)
  const hashes = hashesOf(epic, project) ?? {}
  const source = (() => {
    try {
      return readFileSync(join(root, MAIN), 'utf8')
    } catch {
      return ''
    }
  })()
  const chosen = chooseEngine(engines(), namedEngine(source), needsBiber(source))
  const key = partKey(only)
  const was = job.parts.get(key)?.last ?? null
  if (!chosen.ok) return { last: was, unresolved: [] }
  const engine = chosen.engine

  const dir = buildDir(root)
  const whole = readMeta(dir)
  const aux = join(dir, 'good', 'aux')
  const pdir = partDir(root, key)
  const work = join(pdir, 'work')
  const good = join(pdir, 'good')
  const stamp = createHash('sha256')
    .update([engine.name, only.join('\0'), whole?.aux ?? '', JSON.stringify(Object.entries(hashes).sort())].join('\n'))
    .digest('hex')
    .slice(0, 24)

  const before = readPartMeta(pdir)
  if (!again && before?.stamp === stamp) {
    used(pdir)
    return { last: was ?? { ok: true, at: before.at, ms: 0, engine: before.engine, timedOut: false, problems: [], tail: '' }, unresolved: before.unresolved ?? [] }
  }

  const tectonic = engine.name === 'tectonic'
  const tree = join(pdir, 'tree')
  /* A run that was killed — a newer request superseded it — or that failed
     leaves what it was half-way through writing: an `.out` cut off mid-line
     is read by the next run's `hyperref` and stops it with a fatal error, and
     every run after that, since none gets far enough to write it again. So a
     folder such a run used is emptied, and seeded afresh, before the next. */
  const dirty = join(pdir, 'dirty')
  try {
    if (existsSync(dirty)) {
      rmSync(work, { recursive: true, force: true })
      rmSync(dirty, { force: true })
    }
  } catch {
    /* Left as it is: the run says what it says. */
  }
  const soil = () => {
    try {
      mkdirSync(pdir, { recursive: true })
      writeFileSync(dirty, '')
    } catch {
      /* Nothing to mark it with: the next run reads the folder as it is. */
    }
  }
  try {
    mkdirSync(work, { recursive: true })
    mkdirSync(good, { recursive: true })
    for (const file of paper?.files ?? []) {
      const sub = dirname(file)
      if (sub !== '.') mkdirSync(join(work, sub), { recursive: true })
    }
    if (tectonic) mirror(root, tree, aux, only)
    else {
      /* The full build's numbers, laid over what this folder holds — when they
         are newer than the ones laid here last. Not emptied first: what
         `latexmk` remembers about this folder is why an edit is one pass. */
      const seeded = join(work, '.seed')
      let seed = ''
      try {
        seed = readFileSync(seeded, 'utf8')
      } catch {
        /* Never seeded. */
      }
      if (seed !== (whole?.aux ?? '')) {
        for (const name of filesUnder(aux)) {
          mkdirSync(dirname(join(work, name)), { recursive: true })
          copyFileSync(join(aux, name), join(work, name))
        }
        writeFileSync(seeded, whole?.aux ?? '')
      }
    }
  } catch (error) {
    return { last: failed(engine, started, `The build folder ${pdir} could not be made: ${(error as Error).message}`), unresolved: [] }
  }

  const base = tectonic ? DRIVER : 'main'
  const made = join(work, `${base}.pdf`)
  /* A PDF left by the run before must not be mistaken for this run's: an engine that halts leaves it. */
  rmSync(made, { force: true })
  const runs = partRunsFor(engine, tectonic ? `${DRIVER}.tex` : MAIN, work, onlyLine(only))
  const went = await runAll(runs, tectonic ? tree : root, engine, started, job, superseded, { root, project, biber: false })
  if (went === 'superseded') {
    soil()
    return 'superseded'
  }
  if ('error' in went) return { last: failed(engine, started, `${engine.name} could not be started: ${went.error}`), unresolved: [] }
  const { output, timedOut, code, places, confined } = went

  const resolve = (name: string): string | null => {
    const files = paper?.files ?? [MAIN]
    const plain = (relativeInput(name, root) ?? relativeInput(name, tree) ?? name).replace(/^\.\//, '')
    return files.find((file) => file === plain || file === `${plain}.tex`) ?? null
  }
  const log = logOf(join(work, `${base}.log`))
  const problems = problemsFrom(output, log, resolve, biberAdvice)
  if (timedOut) {
    problems.unshift({ severity: 'error', file: null, line: null, message: `${engine.name} was stopped after ${Math.round(TIMEOUT_MS / 1000)} seconds without finishing.` })
  }
  const missing = unresolved(log)

  const ok = !timedOut && code === 0 && existsSync(made)
  if (!ok) soil()
  if (!ok && places) problems.unshift(...outside([output, log, logOf(join(work, 'main.blg'))].join('\n'), root, places))
  if (ok) {
    try {
      const pdf = readFileSync(made)
      const id = createHash('sha256').update(pdf).digest('hex').slice(0, 16)
      let pages: number | null = null
      let map: Record<string, PageSpan[]> = {}
      const sync = join(work, `${base}.synctex.gz`)
      const held = job.parts.get(key) ?? { last: null, table: null }
      job.parts.set(key, held)
      if (existsSync(sync)) {
        const read = tableFrom(sync)
        if (read) {
          const table = rebased(read, [tree], root)
          pages = table.pages
          map = pageMap(table, root)
          held.table = { id, table }
        }
        copyFileSync(sync, join(good, `${SYNC}.tmp`))
        renameSync(join(good, `${SYNC}.tmp`), join(good, SYNC))
      } else {
        rmSync(join(good, SYNC), { force: true })
        held.table = null
      }
      /* Copied, not moved: the engine's own folder keeps its PDF, which is what tells `latexmk` there is nothing to do. */
      writeFileSync(join(good, `${PDF}.tmp`), pdf)
      renameSync(join(good, `${PDF}.tmp`), join(good, PDF))
      const meta: PartMeta = { id, at: Date.now(), pages, engine: engine.name, hashes, map, only: [...only], stamp, unresolved: missing }
      writeFileSync(join(good, `${META}.tmp`), JSON.stringify(meta))
      renameSync(join(good, `${META}.tmp`), join(good, META))
      used(pdir)
      evict(root, key, job)
    } catch (error) {
      return { last: failed(engine, started, `The PDF was made and could not be kept: ${(error as Error).message}`), unresolved: [] }
    }
  } else if (!problems.some((one) => one.severity === 'error')) {
    problems.unshift({
      severity: 'error',
      file: null,
      line: null,
      message: `${engine.name} stopped without making a PDF of the picked part and without naming an error. Its last words are below.`,
    })
  }

  return {
    last: { ok, at: Date.now(), ms: Date.now() - started, engine: engine.name, timedOut, problems, tail: tailOf(output), confined },
    unresolved: ok ? missing : [],
  }
}

/** Say that a selection's build was used just now: what `evict` orders by. */
function used(pdir: string): void {
  try {
    const now = new Date()
    utimesSync(pdir, now, now)
  } catch {
    /* It is then the first to go, and is made again when asked for. */
  }
}

/** Remove the selections not used lately. `pdir` paths are built from the temp directory and hex digests: see `once`. */
function evict(root: string, current: string, job: Job): void {
  const parts = join(buildDir(root), 'parts')
  const kept = names(parts)
    .filter((name) => PART_KEY.test(name))
    .map((key) => {
      try {
        return { key, used: statSync(join(parts, key)).mtimeMs }
      } catch {
        return { key, used: 0 }
      }
    })
  for (const key of toEvict(kept, KEPT_PARTS, current)) {
    rmSync(join(parts, key), { recursive: true, force: true })
    job.parts.delete(key)
  }
}

/** For tests: forget every job. The folders in the temp directory are left; a test makes its own paper and so its own hash. */
export function forgetBuilds(): void {
  for (const job of jobs.values()) stop(job.child)
  jobs.clear()
}

export { HOW_TO_INSTALL }
