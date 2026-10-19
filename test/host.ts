import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'

/* Bun's own `Response`: `setup.ts` registers a DOM (and its `Response`) after this file is read, and the server must answer with the one it knows. */
const Reply = Response

/**
 * A stand-in for the Kehikot host's `GET /host/is-project`, so a door can be asked about a folder.
 *
 * Started once by `test/setup.ts`, which points `KEHIKOT_ORIGINS` at it. By default it vouches for
 * every folder that exists (the id is made up from the path), so tests that are about something
 * else do not have to say who the project is. A test about a moved or foreign folder says so:
 *
 * - `host.projects.set(path, id)` the host holds `path` as that project, and only those when
 *   `host.auto` is false;
 * - `host.moved.set(oldPath, { to, id })` a project with `id` used to be at `oldPath`;
 * - `host.up = false` nobody answers (the host is not running).
 */
export const host = {
  auto: true,
  up: true,
  projects: new Map<string, string>(),
  moved: new Map<string, { to: string; id: string }>(),
  asked: [] as string[],
  reset(): void {
    host.auto = true
    host.up = true
    host.projects.clear()
    host.moved.clear()
    host.asked.length = 0
  },
}

/* The DOM's `fetch` (see `setup.ts`) holds a cross-origin read to the same rule a page is held to. */
const json = (body: unknown) => Reply.json(body, { headers: { 'access-control-allow-origin': '*' } })

const idOf = (path: string): string => `p-${createHash('sha1').update(path).digest('hex').slice(0, 16)}`

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/host/is-project' || !host.up) return new Reply('no', { status: host.up ? 404 : 503 })
    const path = url.searchParams.get('path') ?? ''
    host.asked.push(path)
    const moved = host.moved.get(path)
    if (moved) return json({ ok: true, project: false, movedTo: moved.to, id: moved.id })
    const id = host.projects.get(path)
    if (id) return json({ ok: true, project: true, id })
    if (host.auto && isFolder(path)) return json({ ok: true, project: true, id: idOf(path) })
    return json({ ok: true, project: false, why: 'Not a project.' })
  },
})

process.env.KEHIKOT_ORIGINS = `http://127.0.0.1:${server.port}`
delete process.env.KEHIKOT_ORIGIN
