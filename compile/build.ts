import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { MAIN, hashesOf, paperRoot, readPaper } from '../store.ts'
import { HOW_TO_INSTALL, chooseEngine, envFor, findEngines, namedEngine, runsFor, wantsNetwork, type Engine, type EngineName } from './engine.ts'
import { problemsFrom, tailOf, type Problem } from './log.ts'
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
 *
 * Two folders because of the rule the page keeps: **a compile that fails must
 * not take the last good PDF off the screen.** The engine never writes into
 * `good/`; a successful run's files are renamed into it, each atomically, and a
 * failed run leaves it exactly as it was.
 *
 * ## One compile at a time per paper, and the latest save wins
 *
 * A person types, pauses, the page saves and asks for a compile; they type
 * again before it finishes. The compile in flight is now of a file that no
 * longer exists, so it is KILLED — by the pid of the child this process itself
 * spawned, never by name — and the newer one starts. Nobody waits for a PDF of
 * text they have already changed, and two engines never write into one `work/`.
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
}

const jobs = new Map<string, Job>()

function jobFor(key: string): Job {
  let job = jobs.get(key)
  if (!job) jobs.set(key, (job = { generation: 0, child: null, tail: Promise.resolve(), running: false, last: null, table: null }))
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

/** The engines on this machine. Looked for on every ask: installing one should not need a restart. */
export function engines(): Engine[] {
  return findEngines(executable, process.env)
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
  const chosen = chooseEngine(found, namedEngine(source))
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
  const chosen = chooseEngine(engines(), namedEngine(source))
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

  let output = ''
  let timedOut = false
  let code: number | null = null
  const runs = runsFor(engine, MAIN, work)
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!
    const left = TIMEOUT_MS - (Date.now() - started)
    if (left <= 0) {
      timedOut = true
      break
    }
    const ran = await spawned(run.argv, root, left, job)
    if (superseded()) return job.last
    output = ran.output
    timedOut = ran.timedOut
    code = ran.code
    if (ran.error) return failed(engine, started, `${engine.name} could not be started: ${ran.error}`)
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

  const resolve = (name: string): string | null => {
    const files = paper?.files ?? [MAIN]
    const plain = (relativeInput(name, root) ?? name).replace(/^\.\//, '')
    return files.find((file) => file === plain || file === `${plain}.tex`) ?? null
  }
  let log = ''
  try {
    log = readFileSync(join(work, 'main.log'), 'latin1').slice(0, 2_000_000)
  } catch {
    /* No log is an ordinary outcome: the engine may not have got that far. */
  }
  const problems = problemsFrom(output, log, resolve)
  if (timedOut) {
    problems.unshift({
      severity: 'error',
      file: null,
      line: null,
      message: `${engine.name} was stopped after ${Math.round(TIMEOUT_MS / 1000)} seconds without finishing.`,
    })
  }

  const made = join(work, PDF)
  const ok = !timedOut && code === 0 && existsSync(made)
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
      const meta: Meta = { id, at: Date.now(), pages, engine: engine.name, hashes, map }
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

  return { ok, at: Date.now(), ms: Date.now() - started, engine: engine.name, timedOut, problems, tail: tailOf(output) }
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
): Promise<{ code: number | null; output: string; timedOut: boolean; error: string | null }> {
  return new Promise((done) => {
    let child: ChildProcess
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env: envFor(process.env), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** The SyncTeX table of the last good build, parsed once per build and kept in memory. */
function tableOf(root: string): { table: SyncTable; meta: Meta } | null {
  const dir = buildDir(root)
  const meta = readMeta(dir)
  if (!meta) return null
  const job = jobFor(root)
  if (job.table?.id !== meta.id) {
    const table = tableFrom(join(dir, 'good', SYNC))
    job.table = table ? { id: meta.id, table } : null
  }
  return job.table ? { table: job.table.table, meta } : null
}

/** The last good PDF's bytes. */
export function readPdf(epic: string, project: string | null): { bytes: Uint8Array; id: string } | null {
  const root = paperRoot(epic, project)
  if (!root) return null
  const dir = buildDir(root)
  const meta = readMeta(dir)
  if (!meta) return null
  try {
    const path = join(dir, 'good', PDF)
    if (statSync(path).size > MAX_PDF_BYTES) return null
    return { bytes: readFileSync(path), id: meta.id }
  } catch {
    return null
  }
}

/** Where lines of a file came out in the last good PDF. Null when there is no build to ask. */
export function syncForward(
  epic: string,
  project: string | null,
  file: string,
  from: number,
  to: number,
): { build: string; rects: PageRect[]; exact: boolean; line: number | null } | null {
  const root = paperRoot(epic, project)
  if (!root) return null
  const held = tableOf(root)
  if (!held) return null
  return { build: held.meta.id, ...forward(held.table, tagsOf(held.table, root, file), from, to) }
}

/** Which file and line a point of the last good PDF came from. */
export function syncReverse(
  epic: string,
  project: string | null,
  page: number,
  x: number,
  y: number,
): { build: string; file: string; line: number } | null {
  const root = paperRoot(epic, project)
  if (!root) return null
  const held = tableOf(root)
  if (!held) return null
  const name = (tag: number) => relativeInput(held.table.inputs.get(tag) ?? '', root)
  const found = reverse(held.table, (tag) => name(tag) !== null, page, x, y)
  if (!found) return null
  const file = name(found.tag)
  return file === null ? null : { build: held.meta.id, file, line: found.line }
}

/** For tests: forget every job. The folders in the temp directory are left; a test makes its own paper and so its own hash. */
export function forgetBuilds(): void {
  for (const job of jobs.values()) stop(job.child)
  jobs.clear()
}

export { HOW_TO_INSTALL }
