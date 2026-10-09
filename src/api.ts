import { ask, replied } from 'kehikot-module-protocol/client'

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

/** The project as a query value: left out altogether when none is open, never the empty string. */
const inProject = (params: Record<string, string>) => ({ ...params, project })

/**
 * A read that answers with a document, or throws.
 *
 * The protocol's `ask`, so no caller is silent and none shows a raw "Failed to
 * fetch". A refusal — a 404, a 409 carrying the file as it now stands — is
 * still an answer and comes back as the server's own document, `ok: false` and
 * its sentence under `error`. What throws is what is not the server's answer
 * at all: nothing answered, the page is older than its server, or the reply is
 * not a document. Those are also what the cover in `app.tsx` draws.
 */
export async function json(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return replied(await ask<Record<string, unknown>>(path, { query: inProject(params) }))
}

/**
 * A write.
 *
 * The project rides along as it does on every read — a POST that forgot it
 * would ask the server to make a folder in a project nobody named.
 *
 * The ticket is added by `ask` and not at the call sites, for exactly the
 * reason the project is added here: a rule every caller has to remember is a
 * rule the fifth caller will not. It is read out of the document that printed
 * it and rides in the `x-module-ticket` header — never in the query, because
 * the query string is the part of a URL that ends up in a log, a referrer and
 * somebody's shell history. It is not a secret from anything that can already
 * read this page, and it does not travel: it goes back to the origin that
 * issued it and nowhere else. The essay on `TICKET` in `doors.ts` says what it
 * does and does not separate.
 *
 * Starting a paper sends nothing else — what is made there is decided by the
 * epic and the project. A save sends the file, its text and the hash of the
 * file it was measured against; see `use-source.ts`.
 */
export async function post(
  path: string,
  params: Record<string, string> = {},
  sending: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return replied(await ask<Record<string, unknown>>(path, { query: inProject(params), body: sending }))
}
