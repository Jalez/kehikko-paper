import { useCallback, useEffect, useRef, useState } from 'react'

import type { BuildStatus, PartStatus } from '../compile/build.ts'
import { json, post } from './api.ts'

/** One selection's own build, and which picked files it is the build of. */
export interface PartHeard {
  /** The picked files it was asked about, joined with newlines: what the page compares its selection with. */
  files: string
  /** Null when the server has no build to speak of for them. */
  status: PartStatus | null
}

/**
 * Where the paper's build stands, and asking for another.
 *
 * The server holds the queue — one compile per paper, a newer request killing
 * an older one — so this is only the page's end of it: what the last answer
 * was, and whether a question is still out. A reply to a request that has
 * since been superseded HERE is dropped, since the newer request's reply is
 * the one that describes the text now on disk.
 *
 * Two kinds of build, one queue. `compile` is the whole paper. `compilePart`
 * is the picked parts' files on their own (`compile/part.ts`), and its answer
 * carries the whole paper's status too, because making a part may have meant
 * compiling the paper first. A newer request of either kind supersedes an
 * older one of either, here as on the server.
 */
export function useBuild(epic: string | null) {
  const [build, setBuild] = useState<BuildStatus | null>(null)
  const [part, setPart] = useState<PartHeard | null>(null)
  const [compiling, setCompiling] = useState(false)
  const asked = useRef(0)
  /* A compile request stays open until its compile ends, and a newer one makes the server drop the older compile: the older request is let go of here at once, or a burst of changes to the files holds every connection the browser allows and nothing else gets through. */
  const open = useRef<AbortController | null>(null)
  const supersede = () => {
    open.current?.abort()
    open.current = new AbortController()
    return open.current.signal
  }
  /** The picked files last asked about, by either door: an answer about any others is about a selection the page has left. */
  const wanted = useRef('')
  const on = useRef(epic)
  on.current = epic

  useEffect(() => {
    setBuild(null)
    setPart(null)
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
      const body = await post('/api/compile', { epic: epicNow }, {}, supersede())
      if (mine !== asked.current) return
      if (body.ok === true && body.build) setBuild(body.build as BuildStatus)
    } catch {
      /* The server went away mid-compile. The next save asks again. */
    } finally {
      if (mine === asked.current) setCompiling(false)
    }
  }, [])

  /**
   * Where the build of these picked files stands, without compiling: the PDF
   * of a selection from before a reload is on screen while the page finds out
   * whether it is still of this text. Always answers — with no status when the
   * server has none — so the page knows it has been heard.
   */
  const seePart = useCallback(async (files: readonly string[]): Promise<void> => {
    const epicNow = on.current
    if (epicNow === null) return
    const key = files.join('\n')
    wanted.current = key
    let status: PartStatus | null = null
    try {
      const body = await json('/api/part', { epic: epicNow, files: JSON.stringify(files) })
      if (body.ok === true && body.part) status = body.part as PartStatus
    } catch {
      /* The server went away. Heard, with nothing. */
    }
    if (wanted.current === key && on.current === epicNow) setPart((was) => (was?.files === key && was.status ? was : { files: key, status }))
  }, [])

  /** Compile these picked files on their own. `full` and `force` are `compilePart`'s, in `compile/build.ts`. */
  const compilePart = useCallback(async (files: readonly string[], ask: { full?: boolean; force?: boolean } = {}): Promise<void> => {
    const epicNow = on.current
    if (epicNow === null) return
    const mine = (asked.current += 1)
    const key = files.join('\n')
    wanted.current = key
    setCompiling(true)
    try {
      const body = await post('/api/part', { epic: epicNow }, { files: [...files], ...ask }, supersede())
      if (mine !== asked.current) return
      if (body.ok === true && body.build) setBuild(body.build as BuildStatus)
      if (body.ok === true) setPart({ files: key, status: (body.part as PartStatus | null | undefined) ?? null })
      else setPart((was) => (was?.files === key ? was : { files: key, status: null }))
    } catch {
      /* The server went away mid-compile. The next save asks again. */
    } finally {
      if (mine === asked.current) setCompiling(false)
    }
  }, [])

  return { build, part, compiling, compile, compilePart, seePart, refresh }
}
