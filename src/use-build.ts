import { useCallback, useEffect, useRef, useState } from 'react'

import type { BuildStatus } from '../compile/build.ts'
import { json, post } from './api.ts'

/**
 * Where the paper's build stands, and asking for another.
 *
 * The server holds the queue — one compile per paper, a newer request killing
 * an older one — so this is only the page's end of it: what the last answer
 * was, and whether a question is still out. A reply to a request that has
 * since been superseded HERE is dropped, since the newer request's reply is
 * the one that describes the text now on disk.
 */
export function useBuild(epic: string | null) {
  const [build, setBuild] = useState<BuildStatus | null>(null)
  const [compiling, setCompiling] = useState(false)
  const asked = useRef(0)
  const on = useRef(epic)
  on.current = epic

  useEffect(() => {
    setBuild(null)
    setCompiling(false)
    asked.current += 1
    if (epic === null) return
    let stopped = false
    void json('/api/build', { epic })
      .then((body) => {
        if (!stopped && body.ok === true && body.build) setBuild(body.build as BuildStatus)
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [epic])

  /** Ask again where the build stands, without compiling: an engine may have just been installed. */
  const refresh = useCallback(async (): Promise<void> => {
    const epicNow = on.current
    if (epicNow === null) return
    const mine = asked.current
    try {
      const body = await json('/api/build', { epic: epicNow })
      if (mine === asked.current && body.ok === true && body.build) setBuild(body.build as BuildStatus)
    } catch {
      /* The server went away. What is on screen stands. */
    }
  }, [])

  const compile = useCallback(async (): Promise<void> => {
    const epicNow = on.current
    if (epicNow === null) return
    const mine = (asked.current += 1)
    setCompiling(true)
    try {
      const body = await post('/api/compile', { epic: epicNow })
      if (mine !== asked.current) return
      if (body.ok === true && body.build) setBuild(body.build as BuildStatus)
    } catch {
      /* The server went away mid-compile. The next save asks again. */
    } finally {
      if (mine === asked.current) setCompiling(false)
    }
  }, [])

  return { build, compiling, compile, refresh }
}
