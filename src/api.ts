/**
 * This app's own server, and the one thing every call to it has to say.
 *
 * ## Every request names a project, and this file is where that is not forgotten
 *
 * A paper lives in the project it is about, so a request that did not say which
 * project is a request the server cannot answer. The alternative to holding it
 * here is every call site remembering to add it — a rule that holds right up
 * until somebody adds the fifth call site, and the fifth one is an `<img src>`
 * built inside a block renderer three files away from anything that has ever
 * heard of the wire. That image would 404, every figure in the paper would draw
 * as a dashed box saying the file is missing, and the prose around it would be
 * perfectly correct. So the project is kept in one module-level variable and
 * both the fetches and the image URLs are built from it.
 *
 * A module-level variable and not React state, deliberately. `Graphic` needs it
 * while rendering a block and is not going to be given a prop for it through
 * four components that have no other reason to know; a context would be the
 * same value with more ceremony and one more thing to remember to wrap. What
 * makes this safe is that there is exactly one writer — `use-paper.ts`, on a
 * context — and the reads happen while drawing a paper that was itself fetched
 * after that write.
 *
 * `null` is a real state and not an unset one: no project is open. Calls still
 * go out and the server answers honestly that there is nowhere to look, and the
 * page draws that. What is NOT done is guessing, here or on the other side.
 *
 * ## The paths are relative, and that is load-bearing
 *
 * `/api/paper` and never `http://127.0.0.1:7870/api/paper`. The page is served
 * at `/app` by the same process that answers these, so a relative path is a
 * fact about where this document came from; an absolute one would be this
 * file's guess about a port, and a wrong guess is a page that works when
 * developed and not when somebody runs it on another one.
 */

let project: string | null = null

/** What this page believes it is standing in. */
export function standingIn(): string | null {
  return project
}

/**
 * Move this page to a project, or to none.
 *
 * Called from one place, before anything is asked about the new project. The
 * order matters for the same reason it matters in Journeys: a fetch that went
 * out between the switch and this assignment would be asking the OLD project
 * for the new project's epic, and epic slugs are short and hand-picked —
 * `thesis`, `bridge`, `wire` — so a second project plausibly has the same one.
 * The wrong paper would be drawn under the right name, which is the single
 * failure this module cannot afford.
 */
export function standIn(next: string | null): void {
  project = next
}

/** A URL under this app's own `/api`, with the project attached. */
export function apiUrl(path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params)
  /* Appended rather than set unconditionally, so a null project produces a URL
     with no `project` at all rather than one claiming the project is the empty
     string. The server tells those apart only by accident, and a caller that
     leaned on the accident would be relying on `str()` trimming. */
  if (project !== null) query.set('project', project)
  const rendered = query.toString()
  return rendered ? `${path}?${rendered}` : path
}

/** A read that answers with a document, or throws. */
export async function json(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(apiUrl(path, params), { headers: { accept: 'application/json' } })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error('that answer was not a document')
  return body as Record<string, unknown>
}
