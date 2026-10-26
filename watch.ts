import { existsSync, readFileSync, statSync, watch as watchFiles, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'

import { admits, resolveDoorProject, type Before } from 'kehikot-module-protocol/serve'

import { changesOf } from './doors.ts'
import { gitDirOf } from './git.ts'
import { onTouched } from './news.ts'
import { vouched } from './stale.ts'
import { isEpic, paperRoot } from './store.ts'

/**
 * `GET /api/watch?project=…&epic=…`: one long-lived answer (server-sent events) that says when
 * anything the page shows about a paper may have moved, so the page asks `/api/changes` then and
 * not every four seconds (2.8.0).
 *
 * ## What is watched
 *
 * - **The paper's folder**, recursively (`fs.watch`; FSEvents on a Mac). An editor saving in place
 *   or by writing a copy and renaming it over the file, an agent writing the `.tex` with a shell, a
 *   `git checkout` or a pull rewriting the files: each is an event in the folder.
 * - **The repository's `HEAD` and `index`**, when the paper is in one: a commit or a `git add`
 *   from a terminal changes what is waiting to be saved without touching the folder.
 * - **This process's own state** (`news.ts`): a suggestion filed through `propose_edit`, revised,
 *   withdrawn or answered, Auto accept, a reason. None of that is in the folder.
 *
 * ## What is said
 *
 * Nothing is sent for an event as such. Events come in bursts (an editor's save is three or four),
 * so they are gathered for `SETTLE_MS`, then the answer `/api/changes` would give is measured once
 * and its tag compared with the last one measured: only a different tag is told, as `event:
 * changed` with the tag. A measurement that itself touches the repository (git refreshing its
 * index) cannot start another: after each one the repository's `HEAD` and `index` are stamped
 * (size, time, content of `HEAD`), and a repository event that finds the same stamp is that
 * measurement's own echo. A `git add` a moment later is a new stamp.
 *
 * One watcher per paper however many pages watch it, closed when the last one goes. A comment line
 * every `BEAT_MS` keeps the connection from looking idle to anything in between.
 *
 * ## What it is not
 *
 * A promise. A network drive may send no events at all, and a watcher can be dropped by the
 * system. The page still asks once a minute while it is shown (`SAFETY_MS` in `use-changes.ts`),
 * and at once after anything it does itself (a save, an accept), so a missed event costs at most a
 * minute, never a lost suggestion.
 */

export const WATCH_PATH = '/api/watch'
/** How long a burst of events is gathered before the answer is measured. */
export const SETTLE_MS = 250
/** How often a comment keeps the stream warm. */
export const BEAT_MS = 25_000

interface Group {
  project: string
  epic: string
  pages: Set<(line: string) => void>
  watchers: FSWatcher[]
  timer: ReturnType<typeof setTimeout> | null
  tag: string | null
  measuring: boolean
  /** The repository's folder, when the paper is in one. */
  git: string | null
  /** `stampOf(git)` after the last measurement. */
  stamped: string | null
  stop: () => void
}

/** What the repository's `HEAD` and `index` are now, as one string; a change to either is a new one. */
function stampOf(git: string): string {
  const one = (name: string) => {
    try {
      const at = statSync(join(git, name))
      return `${at.size}:${at.mtimeMs}`
    } catch {
      return '-'
    }
  }
  let head = ''
  try {
    head = readFileSync(join(git, 'HEAD'), 'utf8')
  } catch {
    head = '-'
  }
  return `${one('index')}|${one('HEAD')}|${head}`
}

const groups = new Map<string, Group>()

/** How many pages watch how many papers, for the tests. */
export function watching(): { papers: number; pages: number } {
  let pages = 0
  for (const group of groups.values()) pages += group.pages.size
  return { papers: groups.size, pages }
}

function measure(group: Group): void {
  group.timer = null
  group.measuring = true
  let tag: string
  try {
    tag = changesOf(group.project, group.epic).tag
  } catch {
    return
  } finally {
    group.measuring = false
    if (group.git) group.stamped = stampOf(group.git)
  }
  if (tag === group.tag) return
  group.tag = tag
  const line = `event: changed\ndata: ${JSON.stringify({ tag })}\n\n`
  for (const send of group.pages) send(line)
}

function soon(group: Group, fromRepository = false): void {
  if (group.measuring) return
  if (fromRepository && group.git && stampOf(group.git) === group.stamped) return
  if (group.timer) return
  group.timer = setTimeout(() => measure(group), SETTLE_MS)
}

function groupFor(project: string, epic: string): Group {
  const key = `${project}\n${epic}`
  const known = groups.get(key)
  if (known) return known
  const group: Group = {
    project,
    epic,
    pages: new Set(),
    watchers: [],
    timer: null,
    tag: null,
    measuring: false,
    git: null,
    stamped: null,
    stop: () => {},
  }
  const dir = paperRoot(epic, project)
  if (dir) {
    try {
      group.watchers.push(watchFiles(dir, { recursive: true }, () => soon(group)))
    } catch {
      /* A folder that cannot be watched is asked about once a minute by the page. */
    }
    const git = gitDirOf(dir)
    if (git && existsSync(git)) {
      group.git = git
      try {
        group.watchers.push(
          watchFiles(git, (_event, name) => {
            const file = name ? basename(String(name)) : ''
            if (file === 'HEAD' || file === 'index') soon(group, true)
          }),
        )
      } catch {
        /* As above. */
      }
    }
  }
  for (const one of group.watchers) one.on('error', () => {})
  const unlisten = onTouched(() => soon(group))
  group.stop = () => {
    unlisten()
    if (group.timer) clearTimeout(group.timer)
    for (const one of group.watchers) {
      try {
        one.close()
      } catch {
        /* Already closed. */
      }
    }
    groups.delete(key)
  }
  /* What the page is about to read is the starting point: a change is a change from it. */
  try {
    group.tag = changesOf(project, epic).tag
  } catch {
    group.tag = null
  }
  if (group.git) group.stamped = stampOf(group.git)
  groups.set(key, group)
  return group
}

const refused = (status: number, error: string) => Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } })

/**
 * The door, for `run({ before })` and `beforeDoors` on Vite: the same function on both. Answers its
 * own page and programs on this machine, as the doors' reads do; the project is put to the host
 * (`resolveDoorProject`, kept for a minute by the protocol) before anything is watched.
 */
export const watchDoor: Before = async (request, { asker, url }) => {
  if (url.pathname !== WATCH_PATH) return undefined
  if (request.method !== 'GET') return refused(405, 'GET only.')
  if (!admits(asker)) return refused(403, 'This stream answers this module’s own page and programs on this machine.')
  const epic = url.searchParams.get('epic') ?? ''
  if (!isEpic(epic)) return refused(400, 'that is not an epic name')
  const named = url.searchParams.get('project')?.trim() ?? ''
  if (!named) return refused(400, 'Name the project: `project` is its absolute folder.')
  const at = await resolveDoorProject(named)
  if (!at.ok) return refused(409, at.why)
  vouched(at.path, at.id, at.movedFrom)

  const group = groupFor(at.path, epic)
  const encoder = new TextEncoder()
  let send: ((line: string) => void) | null = null
  let beat: ReturnType<typeof setInterval> | null = null
  const leave = () => {
    if (beat) clearInterval(beat)
    beat = null
    if (send) group.pages.delete(send)
    send = null
    if (group.pages.size === 0) group.stop()
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (line) => {
        try {
          controller.enqueue(encoder.encode(line))
        } catch {
          leave()
        }
      }
      group.pages.add(send)
      /* How long a browser waits before it opens the stream again, and the tag it starts from. */
      send(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ tag: group.tag, ...(at.movedFrom ? { movedFrom: at.movedFrom, path: at.path } : {}) })}\n\n`)
      beat = setInterval(() => send?.(': still here\n\n'), BEAT_MS)
    },
    cancel() {
      leave()
    },
  })
  request.signal?.addEventListener('abort', leave)
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
