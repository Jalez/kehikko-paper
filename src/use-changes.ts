import { subscribe } from 'kehikot-module-protocol/client'
import { useEffect, useRef } from 'react'

import { apiUrl, json, standingIn } from './api.ts'

/**
 * Keeping up with a paper (2.8.0): what has been suggested, what is waiting to be saved and what
 * each file hashes to on disk — one answer, `/api/changes`, asked only while the page is SHOWN.
 *
 * ## How it is asked
 *
 * - On being shown (and on a new epic): once, naming the tag of what this page holds, so a server
 *   with nothing new answers a few bytes (`same`).
 * - While shown, the server is listened to (`/api/watch`, server-sent events, `watch.ts`): it
 *   watches the paper's folder, its repository and its own state, and says `changed` when the
 *   answer moved. Then it is asked once.
 * - Each time that stream (re)opens — after a drop, a server that restarted, or the tab coming back
 *   to the front — it says `ready` with the tag the server holds, and a tag other than this page's
 *   is asked once. The stream is reopened by `subscribe`, which closes it while the tab is hidden.
 * - `nudge` asks at once, and in full: after something this page did itself.
 *
 * Never on a clock: no poll while the stream is down and no "just in case" ask while it is up. A
 * stream that cannot be held is reopened (with a pause, doubling to 15 s), and its `ready` says
 * what moved meanwhile.
 *
 * A paper this page lets go of (another project or epic is being read, so none is on screen) is held
 * under no tag: coming back asks for it in full, whatever the server says its tag is.
 *
 * ## The tag is of the list the page HOLDS, or of nothing (#70)
 *
 * `same` keeps whatever list the page has, so the tag may only name the answer that list came from.
 * The page also takes a list from other answers — a decision, a save, a setting, a re-read — and each
 * of those is followed by a nudge. A nudge therefore asks in full: an answer that reached the page
 * out of order, or a list the page took from somewhere other than here, would otherwise sit under a
 * tag that says "nothing new" about it until the next change on the server, and suggestions the
 * server holds would be missing from the page with every button saying none is waiting. An answer
 * `heard` does not take (it answers false) leaves no tag behind, for the same reason.
  *
 * Not shown — folded, on another kehikko, scrolled off, a hidden tab: nothing is asked and the
 * stream is closed. Shown again, it asks once and listens again.
 *
 * `heard` is handed every answer that is not `same`; it answers `false` when the page did not take it.
 */

export function useChanges(
  epic: string | null,
  shown: boolean,
  nudge: number,
  heard: (body: Record<string, unknown>) => unknown,
): void {
  /* The tag of what this page holds, for ONE paper: an epic in a project. */
  const tag = useRef<{ epic: string | null; project: string | null; tag: string }>({ epic: null, project: null, tag: '' })
  const told = useRef(heard)
  told.current = heard
  const askNow = useRef<(() => void) | null>(null)

  useEffect(() => {
    /* No paper on screen: the page has let go of the list it held (`use-paper.ts` empties it), so a
       tag kept from before would say "nothing new" about a list that is now empty. Going to another
       project and back, or to another epic and back, passes through here (#56). */
    if (epic === null) tag.current = { epic: null, project: null, tag: '' }
    if (epic === null || !shown) return
    const project = standingIn()
    if (tag.current.epic !== epic || tag.current.project !== project) tag.current = { epic, project, tag: '' }
    let stopped = false
    let asking = false
    let again = false

    let whole = false
    const ask = (full = false) => {
      if (stopped) return
      if (full) whole = true
      if (asking) {
        again = true
        return
      }
      asking = true
      const since = whole ? '' : tag.current.tag
      whole = false
      void json('/api/changes', { epic, since })
        .then((body) => {
          if (stopped) return
          if (body.same === true) {
            if (typeof body.tag === 'string') tag.current = { epic, project, tag: body.tag }
            return
          }
          if (body.ok !== true) return
          const took = told.current(body) !== false
          tag.current = { epic, project, tag: took && typeof body.tag === 'string' ? body.tag : '' }
        })
        .catch(() => {
          /* A failed ask is asked again by the next piece of news, or the stream opening again.
             Saying so would be a container that looks broken. */
        })
        .finally(() => {
          asking = false
          if (again && !stopped) {
            again = false
            ask()
          }
        })
    }

    /* `ready` as the stream (re)opens and `changed` when the answer moved: each carries the tag the
       server measured, and only a tag this page does not hold is asked about. */
    const fresh = (said: unknown) => {
      const now = said && typeof said === 'object' ? (said as { tag?: unknown }).tag : null
      if (typeof now === 'string' && now === tag.current.tag) return
      /* The first answer is still on its way: it will say what this one would. */
      if (asking && tag.current.tag === '') return
      ask()
    }
    const unsubscribe = subscribe<unknown>(apiUrl('/api/watch', { epic }), (said, name) => {
      if (name === 'ready' || name === 'changed') fresh(said)
    }, { events: ['ready', 'changed'], probe: true })

    askNow.current = () => ask(true)
    ask()
    return () => {
      stopped = true
      askNow.current = null
      unsubscribe()
    }
  }, [epic, shown])

  useEffect(() => {
    if (nudge > 0) askNow.current?.()
  }, [nudge])
}
