import { useCallback, useEffect, useRef, useState } from 'react'

import type { ToolchainStatus } from '../compile/install.ts'
import type { PieceId } from '../compile/toolchain.ts'
import { json, post } from './api.ts'

/**
 * The compiler this module can fetch, as the page sees it.
 *
 * The server holds the install — one at a time, per process — so this is only
 * the page's end: what the last answer was, and asking again while a download
 * is running. Nothing here starts a download except `install`, and nothing
 * calls `install` except a press of the button.
 *
 * `onDone` is called once per install this page started, when it ends:
 * `true` when everything it was asked for is in place, `false` when it failed
 * or was cancelled — which may still have put ONE of two pieces in place, and
 * the page should look again at what it has.
 */
export function useToolchain(onDone: (complete: boolean) => void, pollMs = 500) {
  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null)
  /** The request to start or stop could not be made at all. */
  const [unreachable, setUnreachable] = useState<string | null>(null)
  const done = useRef(onDone)
  done.current = onDone
  /** An install this page started and has not yet seen the end of. */
  const mine = useRef(false)

  const take = useCallback((body: Record<string, unknown>) => {
    if (body.ok !== true || !body.toolchain) {
      if (typeof body.error === 'string') setUnreachable(body.error)
      return
    }
    const next = body.toolchain as ToolchainStatus
    setUnreachable(null)
    setToolchain(next)
    if (mine.current && !next.running) {
      mine.current = false
      const all = next.wanted.every((id) => next.pieces.some((one) => one.id === id && one.installed))
      done.current(next.error === null && all && next.wanted.length > 0)
    }
  }, [])

  useEffect(() => {
    let stopped = false
    void json('/api/toolchain')
      .then((body) => {
        if (!stopped) take(body)
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [take])

  const running = toolchain?.running ?? false
  useEffect(() => {
    if (!running) return
    let stopped = false
    const timer = setInterval(() => {
      void json('/api/toolchain')
        .then((body) => {
          if (!stopped) take(body)
        })
        .catch(() => {})
    }, pollMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [running, pollMs, take])

  const install = useCallback(
    async (pieces: readonly PieceId[]) => {
      mine.current = true
      try {
        take(await post('/api/toolchain/install', {}, { pieces }))
      } catch {
        mine.current = false
        setUnreachable('This page could not reach its own server. Reload it and try again.')
      }
    },
    [take],
  )

  const cancel = useCallback(async () => {
    try {
      take(await post('/api/toolchain/cancel'))
    } catch {
      /* The server went away; the next poll says what stands. */
    }
  }, [take])

  return { toolchain, unreachable, install, cancel }
}
