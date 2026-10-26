import { useEffect, useRef } from 'react'

import { apiUrl, json } from './api.ts'

/** How often the page asks while its server's stream is not open: as before 2.8.0. */
export const POLL_MS = 4000
/** How often it asks while the stream is open: in case the watcher missed something (a network drive). */
export const SAFETY_MS = 60_000

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
 * - While that stream is open, once a minute besides (`SAFETY_MS`), in case a change went unseen.
 * - While it is not open (a server from before 2.8.0, a stream that dropped): every `POLL_MS`, as
 *   the page always did.
 * - `nudge` asks at once: after something this page did itself. So does the page coming back to
 *   the front (`visibilitychange`).
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
    let pushing = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = () => {
      if (timer) clearTimeout(timer)
      if (stopped) return
      timer = setTimeout(() => {
        ask()
        schedule()
      }, pushing ? SAFETY_MS : POLL_MS)
    }

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
          /* A failed ask is asked again by the next one. Saying so every few seconds would be a
             container that looks broken. */
        })
        .finally(() => {
          asking = false
          if (again && !stopped) {
            again = false
            ask()
          }
        })
    }

    let stream: EventSource | null = null
    if (typeof EventSource === 'function') {
      try {
        stream = new EventSource(apiUrl('/api/watch', { epic }))
        const fresh = (event: MessageEvent) => {
          let said: unknown = null
          try {
            said = JSON.parse(String(event.data))
          } catch {
            said = null
          }
          const now = said && typeof said === 'object' ? (said as { tag?: unknown }).tag : null
          if (typeof now === 'string' && now === tag.current.tag) return
          /* The first answer is still on its way: it will say what this one would. */
          if (asking && tag.current.tag === '') return
          ask()
        }
        stream.addEventListener('ready', (event) => {
          pushing = true
          schedule()
          /* Opened again after a drop, or by a server that restarted: whatever moved meanwhile. */
          fresh(event as MessageEvent)
        })
        stream.addEventListener('changed', (event) => fresh(event as MessageEvent))
        stream.onerror = () => {
          if (!pushing) return
          pushing = false
          schedule()
        }
      } catch {
        stream = null
      }
    }

    /* The page coming back to the front asks at once, as it always did. */
    const woke = () => {
      if (document.visibilityState !== 'hidden') ask()
    }
    document.addEventListener('visibilitychange', woke)

    askNow.current = ask
    ask()
    schedule()
    return () => {
      stopped = true
      askNow.current = null
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', woke)
      stream?.close()
    }
  }, [epic, shown])

  useEffect(() => {
    if (nudge > 0) askNow.current?.()
  }, [nudge])
}
