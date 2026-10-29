import { subscribe } from 'kehikot-module-protocol/client'
import { useEffect, useRef } from 'react'

import { apiUrl, json } from './api.ts'

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
 * - `nudge` asks at once: after something this page did itself.
 *
 * Never on a clock: no poll while the stream is down and no "just in case" ask while it is up. A
 * stream that cannot be held is reopened (with a pause, doubling to 15 s), and its `ready` says
 * what moved meanwhile.
 *
 * Not shown — folded, on another kehikko, scrolled off, a hidden tab: nothing is asked and the
 * stream is closed. Shown again, it asks once and listens again.
 *
 * `heard` is handed every answer that is not `same`.
 */

export function useChanges(
  epic: string | null,
  shown: boolean,
  nudge: number,
  heard: (body: Record<string, unknown>) => void,
): void {
  const tag = useRef<{ epic: string | null; tag: string }>({ epic: null, tag: '' })
  const told = useRef(heard)
  told.current = heard
  const askNow = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (epic === null || !shown) return
    if (tag.current.epic !== epic) tag.current = { epic, tag: '' }
    let stopped = false
    let asking = false
    let again = false

    const ask = () => {
      if (stopped) return
      if (asking) {
        again = true
        return
      }
      asking = true
      void json('/api/changes', { epic, since: tag.current.tag })
        .then((body) => {
          if (stopped) return
          if (typeof body.tag === 'string') tag.current = { epic, tag: body.tag }
          if (body.same !== true && body.ok === true) told.current(body)
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

    askNow.current = ask
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
