import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, closeSync, constants, createReadStream, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'

import {
  BIBER_VERSION,
  artefactsFor,
  biberFor,
  biblatexIn,
  mayFetch,
  megabytes,
  pieceDir,
  piecePath,
  safeEntry,
  tarHeader,
  unzipEntry,
  verified,
  type Artefact,
  type PieceId,
} from './toolchain.ts'

/**
 * Fetching the compiler in `toolchain.ts`, and nothing else.
 *
 * This is the half that touches the network and the disk. What may be fetched,
 * from where, and what it must hash to is all in the table; this file only
 * carries it out, and the order it does so in is the safety of it:
 *
 *  1. **Download** to a `.part` file in the tools folder, asking only the
 *     address in the row and following a redirect only to a host the row
 *     names.
 *  2. **Verify** the length and the SHA-256 of what arrived. A file that is not
 *     the pinned one is deleted here; nothing has been unpacked or run.
 *  3. **Extract the one file** the row names, to a name this module chose. No
 *     `tar`, no `unzip`, no shell: the archive is read here, and a path out of
 *     an archive is never a path on disk.
 *  4. **Mark it executable, then rename it into place.** A rename within one
 *     folder is atomic, so the tool is either there whole or not there — which
 *     is the only test `managed()` makes.
 *
 * ## Where the tools are kept, and why that is not where they should be
 *
 * `<tmpdir>/kehikot-paper-tools/`, or wherever `KEHIKOT_PAPER_TOOLS_DIR` says.
 *
 * They are machine-level — one compiler for every project — so they cannot go
 * under a project's `.kehikot/`, and the workspace's storage rule forbids a
 * module building a path under the home directory. What the rule allows a
 * module by name is the temporary directory, so that is what this uses: it is
 * honest (the tools are derived — a press of the button makes them again) and
 * it costs what temp costs, which is that the system may clean them away and
 * the button comes back. The proper home is a machine-level directory the
 * protocol hands a module — see the README — and when there is one, this
 * function is the only line that changes.
 *
 * The folder is made for this user alone (0700) and is only believed when it
 * IS this user's alone: on a machine whose temp directory is shared, a folder
 * of this name made by somebody else is not a folder to run programs out of.
 *
 * ## One at a time, and it can be stopped
 *
 * One install per process. A second press while one is running is that
 * install's status, not a second download. Cancel aborts the request in
 * flight and keeps the `.part` file, so the next press asks the server for the
 * rest of the file rather than the start of it; the checksum is taken over the
 * whole file either way.
 */

type Env = Record<string, string | undefined>

/** Where the managed tools live. See the essay above for why it is temp. */
export function toolsDir(env: Env = process.env): string {
  return env.KEHIKOT_PAPER_TOOLS_DIR || join(tmpdir(), 'kehikot-paper-tools')
}

/** No bytes for this long is a connection that has gone, not a slow one. */
const STALL_MS = 45_000
const MAX_REDIRECTS = 5

export interface PieceStatus {
  id: PieceId
  version: string
  /** Of the download. */
  bytes: number
  /** The host the download is asked of — what a person is told it comes from. */
  host: string
  url: string
  installed: boolean
}

export interface ToolchainStatus {
  /** Whether there is anything to offer on this platform. */
  supported: boolean
  dir: string
  pieces: PieceStatus[]
  running: boolean
  /** The pieces of the install running now, or of the last one. */
  wanted: PieceId[]
  /** Bytes of the pieces in `wanted` that are on disk, and how many there will be. */
  received: number
  total: number
  /** Why the last install stopped short. Null when it did not, or was cancelled. */
  error: string | null
}

export interface InstallerOptions {
  dir: string
  artefacts: readonly Artefact[]
  fetch?: typeof fetch
  /** The biblatex in the bundle a Tectonic uses, or null when it cannot be asked. */
  probe?: (tectonic: string) => Promise<string | null>
}

export interface Installer {
  status(): ToolchainStatus
  /** Start fetching whatever of `pieces` is missing — all of them when none are named. Answers at once. */
  install(pieces?: readonly PieceId[]): ToolchainStatus
  cancel(): ToolchainStatus
  /** Settles when the install running now has ended, however it ended. */
  settled(): Promise<void>
  managed(): Managed
}

export interface Managed {
  /** The managed Tectonic, or null. */
  tectonic: string | null
  /** The folder holding the managed biber and nothing else, for the front of an engine's PATH. Or null. */
  biberDir: string | null
  biber: string | null
}

class Cancelled extends Error {}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Whether a folder is this user's alone: a real directory, owned by whoever is
 * running this, that nobody else may write into. Where the platform has no
 * such notion (`getuid` is absent) the question is not asked.
 */
export function trusted(dir: string): boolean {
  try {
    const stat = lstatSync(dir)
    if (!stat.isDirectory()) return false
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null || (stat.uid === uid && (stat.mode & 0o022) === 0)
  } catch {
    return false
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!trusted(dir)) throw new Error(`The tools folder ${dir} is not this user’s alone, so nothing will be installed into it or run from it.`)
}

export function createInstaller(options: InstallerOptions): Installer {
  const { dir, artefacts } = options
  /* Looked up per request, not once: the runtime's `fetch` is what a test replaces. */
  const fetcher: typeof fetch = ((...args: Parameters<typeof fetch>) => (options.fetch ?? globalThis.fetch)(...args)) as typeof fetch
  const probe = options.probe ?? bundleBiblatex

  let running: Promise<void> | null = null
  let abort: AbortController | null = null
  let wanted: PieceId[] = []
  let received = 0
  let total = 0
  let error: string | null = null

  const installed = (artefact: Artefact) => trusted(dir) && trusted(pieceDir(dir, artefact)) && executable(piecePath(dir, artefact))
  const partial = (artefact: Artefact) => join(dir, `${artefact.piece}-${artefact.version}.${artefact.format}.part`)

  const status = (): ToolchainStatus => ({
    supported: artefacts.length > 0,
    dir,
    pieces: artefacts.map((one) => ({
      id: one.piece,
      version: one.version,
      bytes: one.bytes,
      host: new URL(one.url).hostname,
      url: one.url,
      installed: installed(one),
    })),
    running: running !== null,
    wanted,
    received,
    total,
    error,
  })

  const managed = (): Managed => {
    const path = (piece: PieceId) => {
      const artefact = artefacts.find((one) => one.piece === piece)
      return artefact && installed(artefact) ? piecePath(dir, artefact) : null
    }
    const biber = artefacts.find((one) => one.piece === 'biber')
    const biberPath = path('biber')
    return { tectonic: path('tectonic'), biber: biberPath, biberDir: biber && biberPath ? pieceDir(dir, biber) : null }
  }

  async function one(artefact: Artefact, before: number, signal: AbortSignal): Promise<void> {
    const part = partial(artefact)
    await download(artefact, part, fetcher, signal, (bytes) => {
      received = before + bytes
    })
    const sum = await sha256Of(part)
    if (!verified(artefact, sum.bytes, sum.sha256)) {
      /* Not the pinned file. It goes now — a resumed download must not be
         built on it — and it was never unpacked. */
      rmSync(part, { force: true })
      throw new Error(
        `What ${new URL(artefact.url).hostname} sent for ${artefact.piece} ${artefact.version} is not the file this module pins `
          + `(${sum.bytes} bytes, SHA-256 ${sum.sha256}). It was deleted and nothing was installed.`,
      )
    }
    const scratch = join(dir, `${artefact.piece}-${artefact.version}.${process.pid}.tmp`)
    try {
      await extract(artefact, part, scratch)
      chmodSync(scratch, 0o755)
      const home = pieceDir(dir, artefact)
      mkdirSync(home, { recursive: true, mode: 0o700 })
      if (!trusted(home)) throw new Error(`The folder ${home} is not this user’s alone.`)
      renameSync(scratch, piecePath(dir, artefact))
    } finally {
      rmSync(scratch, { force: true })
    }
    rmSync(part, { force: true })
  }

  async function all(todo: readonly Artefact[], signal: AbortSignal): Promise<void> {
    ensureDir(dir)
    let before = 0
    /* Tectonic first: it is the one that makes a PDF possible at all, and it
       is what says which biber its bundle wants. */
    for (const artefact of [...todo].sort((a, b) => (a.piece === 'tectonic' ? -1 : 0) - (b.piece === 'tectonic' ? -1 : 0))) {
      if (signal.aborted) throw new Cancelled()
      if (artefact.piece === 'biber') {
        /* Ask the Tectonic that was just installed what its bundle carries,
           when there is one to ask. A bundle that has moved on is said, and
           the wrong biber is not fetched. Unanswered — offline, say — is not
           a reason to stop: the row was matched to the bundle when it was
           written, and biber itself refuses a mismatch in a sentence the page
           already reads. */
        const tectonic = managed().tectonic
        const biblatex = tectonic ? await probe(tectonic).catch(() => null) : null
        const needs = biblatex ? biberFor(biblatex) : null
        if (needs && needs !== artefact.version) {
          throw new Error(
            `Tectonic’s bundle now carries biblatex ${biblatex}, which wants biber ${needs}; this version of Paper only knows where `
              + `biber ${artefact.version} is. Tectonic was installed; a paper with a biblatex bibliography needs a newer Paper or a TeX Live.`,
          )
        }
      }
      await one(artefact, before, signal)
      before += artefact.bytes
      received = before
    }
  }

  return {
    status,
    managed,
    settled: () => running ?? Promise.resolve(),
    install(pieces) {
      if (running) return status()
      const todo = artefacts.filter((one) => (pieces?.length ? pieces.includes(one.piece) : true) && !installed(one))
      wanted = todo.map((one) => one.piece)
      total = todo.reduce((sum, one) => sum + one.bytes, 0)
      received = 0
      error = null
      if (!todo.length) return status()
      const controller = new AbortController()
      abort = controller
      running = all(todo, controller.signal)
        .catch((caught: unknown) => {
          error = controller.signal.aborted || caught instanceof Cancelled ? null : (caught as Error).message
        })
        .finally(() => {
          running = null
          abort = null
        })
      return status()
    },
    cancel() {
      abort?.abort()
      return status()
    },
  }
}

/**
 * One artefact, to a `.part` file, picking up where an earlier attempt stopped.
 *
 * `redirect: 'manual'` is the point of the loop: every address is checked
 * against the row before it is asked, the redirect's included, instead of the
 * runtime following wherever it is sent.
 */
export async function download(
  artefact: Artefact,
  part: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<void> {
  let have = 0
  try {
    have = statSync(part).size
  } catch {
    /* Nothing from an earlier attempt. */
  }
  if (have > artefact.bytes) {
    rmSync(part, { force: true })
    have = 0
  }
  progress(have)
  if (have === artefact.bytes) return

  const host = new URL(artefact.url).hostname
  const stall = new AbortController()
  const stop = () => stall.abort()
  signal.addEventListener('abort', stop)
  let timer: ReturnType<typeof setTimeout> | undefined
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(stop, STALL_MS)
  }
  let fd: number | null = null
  try {
    let address = artefact.url
    let response: Response | null = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!mayFetch(artefact, address)) throw new Error(`${host} answered with a redirect to somewhere this module does not download from. Nothing was fetched.`)
      alive()
      const answer = await fetcher(address, {
        redirect: 'manual',
        signal: stall.signal,
        headers: { accept: 'application/octet-stream', ...(have > 0 ? { range: `bytes=${have}-` } : {}) },
      })
      if (answer.status >= 300 && answer.status < 400) {
        const to = answer.headers.get('location')
        if (!to) throw new Error(`${host} answered with a redirect to nowhere.`)
        address = new URL(to, address).toString()
        await answer.body?.cancel().catch(() => undefined)
        continue
      }
      response = answer
      break
    }
    if (!response) throw new Error(`${host} redirected too many times.`)
    if (response.status === 416) {
      /* The server has no bytes past what is here, and what is here is not
         the whole file: the `.part` is of something else. Start again. */
      rmSync(part, { force: true })
      throw new Error(`The download of ${artefact.piece} could not be resumed. Try again and it starts from the beginning.`)
    }
    if (response.status !== 200 && response.status !== 206) throw new Error(`${host} answered ${response.status} for ${artefact.piece} ${artefact.version}.`)
    if (!response.body) throw new Error(`${host} answered with nothing.`)
    /* 206 is "the rest"; 200 is "all of it", whatever was asked. */
    if (response.status === 200) have = 0
    fd = openSync(part, have > 0 ? 'a' : 'w', 0o600)
    const reader = response.body.getReader()
    for (;;) {
      alive()
      const { done, value } = await reader.read()
      if (done) break
      if (have + value.length > artefact.bytes) throw new Error(`${host} sent more than ${artefact.piece} ${artefact.version} is. Nothing was installed.`)
      writeSync(fd, value)
      have += value.length
      progress(have)
    }
    if (have < artefact.bytes) throw new Error(`The download of ${artefact.piece} stopped early (${megabytes(have)} of ${megabytes(artefact.bytes)} MB). Try again and it carries on from there.`)
  } catch (caught) {
    if (signal.aborted) throw new Cancelled()
    if (stall.signal.aborted) throw new Error(`The download of ${artefact.piece} from ${host} stopped arriving. Check the connection and try again; it carries on from where it stopped.`)
    const said = (caught as Error).message ?? ''
    /* What `fetch` throws when there is no route to the host is a sentence
       about sockets. This is the one a person can act on. */
    if (caught instanceof TypeError || /fetch failed|unable to connect|ENOTFOUND|ECONNREFUSED|ECONNRESET|network|getaddrinfo|socket/i.test(said)) {
      throw new Error(`${host} could not be reached, so nothing was downloaded. Check that this machine is online and try again.`)
    }
    throw caught
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    if (fd !== null) closeSync(fd)
  }
}

export function sha256Of(path: string): Promise<{ bytes: number; sha256: string }> {
  return new Promise((done, failed) => {
    const hash = createHash('sha256')
    let bytes = 0
    createReadStream(path)
      .on('data', (chunk) => {
        bytes += chunk.length
        hash.update(chunk)
      })
      .on('error', failed)
      .on('end', () => done({ bytes, sha256: hash.digest('hex') }))
  })
}

/** The one entry an artefact names, out of its (already verified) archive, into `to`. */
export async function extract(artefact: Pick<Artefact, 'format' | 'entry' | 'unpacked'>, archive: string, to: string): Promise<void> {
  if (artefact.format === 'zip') {
    const bytes = unzipEntry(readFileSync(archive), artefact.entry, artefact.unpacked)
    const fd = openSync(to, 'w', 0o600)
    try {
      writeSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
    return
  }
  await untarEntry(archive, artefact.entry, artefact.unpacked, to)
}

/**
 * One regular file out of a `.tar.gz`, streamed.
 *
 * Every header is read and every name checked; only the bytes of the entry
 * wanted are written, and to `to`. A link by that name is refused — a link is
 * a path, and the point is that no path comes out of an archive.
 */
async function untarEntry(archive: string, entry: string, max: number, to: string): Promise<void> {
  let pending: Buffer = Buffer.alloc(0)
  let skip = 0
  let left = 0
  let fd: number | null = null
  let found = false
  let ended = false
  const stream = createReadStream(archive).pipe(createGunzip())
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (ended) continue
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      for (;;) {
        if (left > 0) {
          const take = Math.min(left, pending.length)
          if (!take) break
          writeSync(fd!, pending.subarray(0, take))
          pending = pending.subarray(take)
          left -= take
          if (left === 0) {
            closeSync(fd!)
            fd = null
          }
          continue
        }
        if (skip > 0) {
          const take = Math.min(skip, pending.length)
          if (!take) break
          pending = pending.subarray(take)
          skip -= take
          continue
        }
        if (pending.length < 512) break
        const header = tarHeader(pending.subarray(0, 512))
        pending = pending.subarray(512)
        if (!header) {
          ended = true
          break
        }
        const padded = Math.ceil(header.size / 512) * 512
        /* 'x', 'g' and 'L' carry a name for the entry after them, not a file.
           Their data is passed over; nothing is ever written under a name
           they give. */
        const meta = header.type === 'x' || header.type === 'g' || header.type === 'L' || header.type === 'K'
        if (!meta && !safeEntry(header.name.replace(/^\.\//, '').replace(/\/+$/, '') || '.')) {
          throw new Error(`the archive holds a file named ${JSON.stringify(header.name)}, which no honest archive does`)
        }
        if (!meta && header.name.replace(/^\.\//, '') === entry) {
          if (found) throw new Error(`the archive holds ${entry} twice`)
          if (header.type !== '0') throw new Error(`${entry} in the archive is not a file`)
          if (header.size > max || header.size === 0) throw new Error(`${entry} in the archive is not the size it should be`)
          found = true
          fd = openSync(to, 'w', 0o600)
          left = header.size
          skip = padded - header.size
        } else {
          skip = padded
        }
      }
    }
  } finally {
    if (fd !== null) closeSync(fd)
    stream.destroy()
  }
  if (left > 0) throw new Error('the archive is cut short')
  if (!found) throw new Error(`the archive does not hold ${entry}`)
}

/**
 * The biblatex version in the bundle a Tectonic uses, asked of that Tectonic.
 *
 * `tectonic -X bundle cat biblatex.sty` prints the file. No shell, an argument
 * array, a bare environment, a timeout, and the answer capped: it is a
 * megabyte of TeX and only one line of it is wanted. Null when it cannot be
 * asked — no network on a first run, most likely — which callers treat as "not
 * known", never as "fine".
 */
export function bundleBiblatex(tectonic: string, env: Env = process.env): Promise<string | null> {
  return new Promise((done) => {
    let out = ''
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(value)
    }
    const keep: Record<string, string> = {}
    for (const key of ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'TECTONIC_CACHE_DIR']) if (env[key]) keep[key] = env[key]!
    keep.PATH = '/usr/bin:/bin'
    const child = spawn(tectonic, ['-X', 'bundle', 'cat', 'biblatex.sty'], { cwd: tmpdir(), env: keep, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, 30_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 400_000) out += chunk.toString('latin1')
    })
    child.on('error', () => finish(null))
    child.on('close', () => finish(biblatexIn(out)))
  })
}

/* ---- This process's installer ------------------------------------------- */

let own: { dir: string; installer: Installer } | null = null

/**
 * The installer for this machine. Made on first ask, and again if the tools
 * folder was pointed somewhere else — which is what a test, or a scratch run,
 * does.
 */
export function installer(env: Env = process.env): Installer {
  const dir = toolsDir(env)
  if (!own || own.dir !== dir) own = { dir, installer: createInstaller({ dir, artefacts: artefactsFor(process.platform, process.arch) }) }
  return own.installer
}

/** What `build.ts` asks: the managed tools that are in place right now. */
export function managed(env: Env = process.env): Managed {
  return installer(env).managed()
}

/** Whether this module can fetch a biber of this version for this machine, and has not yet. */
export function canFetchBiber(version: string, env: Env = process.env): boolean {
  if (version !== BIBER_VERSION) return false
  return installer(env)
    .status()
    .pieces.some((one) => one.id === 'biber' && one.version === version && !one.installed)
}
