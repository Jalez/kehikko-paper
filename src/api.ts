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

/**
 * This process's write ticket, read out of the document that printed it.
 *
 * ## Read once, and an empty string when there is none
 *
 * `page/document.ts` puts it in a `<script type="application/json">` ahead of
 * the module script, so it is there before anything here can ask. It is read
 * lazily and kept: the document does not change under us, and re-reading would
 * be a `getElementById` on every correction somebody types.
 *
 * An empty string when the tag is missing rather than a throw, deliberately.
 * The two ways to get there are a test that rendered the components without the
 * shell and a page served by something that is not this server. Neither should
 * stop the READS — the whole app apart from the write is unaffected — and the
 * write is refused by the server with a sentence saying to reload, which is the
 * right instruction in both cases and better than an exception thrown out of a
 * blur handler.
 *
 * It is not a secret from anything that can already read this page, and it does
 * not travel: it goes back to the origin that issued it and nowhere else. The
 * essay on `TICKET` in `doors.ts` says what it does and does not separate.
 */
const TICKET_ID = 'roadmap-paper-ticket'
let ticket: string | null = null

export function writeTicket(): string {
  if (ticket !== null) return ticket
  const tag = typeof document === 'undefined' ? null : document.getElementById(TICKET_ID)
  try {
    const parsed: unknown = JSON.parse(tag?.textContent ?? '""')
    ticket = typeof parsed === 'string' ? parsed : ''
  } catch {
    ticket = ''
  }
  return ticket
}

/**
 * A write.
 *
 * Same URL builder as `json`, so the project rides along as it does on every
 * read — a POST that forgot it would ask the server to make a folder in a
 * project nobody named.
 *
 * The ticket is added HERE and not at the call sites, for exactly the reason
 * the project is: a rule every caller has to remember is a rule the fifth
 * caller will not. It rides in the body rather than in the query, because the
 * query string is the part of a URL that ends up in a log, a referrer and
 * somebody's shell history.
 *
 * Starting a paper sends nothing else — what is made there is decided by the
 * epic and the project. An edit sends the file, the range, the text and the
 * hash of the file it was measured against; see `use-paper.ts`.
 */
export async function post(
  path: string,
  params: Record<string, string> = {},
  sending: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(apiUrl(path, params), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ ...sending, ticket: writeTicket() }),
  })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error('that answer was not a document')
  return body as Record<string, unknown>
}
