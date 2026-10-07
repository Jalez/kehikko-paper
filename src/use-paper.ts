import type { Goto, Passage } from 'kehikot-module-protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { connect, type Connection } from 'kehikot-module-protocol/client'

import type { Standing } from '../git.ts'
import type { Proposal } from '../latex/propose.ts'
import type { Paper } from '../store.ts'
import { json, post, standIn, standingIn } from './api.ts'

/**
 * Which paper this page is on, and the conversation with whatever framed it.
 *
 * ## What this hook is, after the reader went
 *
 * It used to hold everything: the paper, the in-prose correction, the
 * comparison against a paper that changed on disk. The page is a source editor
 * beside a compiled PDF now, and the text of the files, the saving of them and
 * what to do when one moves on disk are `use-source.ts`'s; the build is
 * `use-build.ts`'s. What is left here is what was always this hook's alone:
 *
 *  - **Which epic, in which project** — from the host's greeting and contexts
 *    when framed, from the page's own address when not.
 *  - **The paper's shape** — its files, their hashes, its sections. Not its
 *    text.
 *  - **The wire** — the passage the canvas holds, the passage this page says,
 *    a `kehikot.goto` arriving.
 *  - **Two polls**, kept as they were: the suggestions waiting on this paper,
 *    and where its repository stands plus what its files hash to NOW. That
 *    second answer is how the page learns a file moved under it.
 *
 * ## Fetching is keyed to the epic CHANGING
 *
 * The host sends a context after every selection change anywhere on the
 * canvas. Re-reading the paper on each would throw away an editor somebody is
 * typing in. So a context that names the epic and project already on screen
 * changes nothing here.
 */

export type Sight =
  /** Framed, and nothing has greeted this page yet. */
  | { at: 'listening' }
  /** Not framed, and the address names no epic. */
  | { at: 'alone' }
  | { at: 'no-epic' }
  /** `where` is the folder a paper would go in, when the server could say. */
  | { at: 'no-paper'; epic: string; why: string; where: string | null }
  | { at: 'no-project'; why: string }
  | { at: 'asking'; epic: string }
  | { at: 'reading'; paper: Paper }
  | { at: 'broke'; why: string }

export type GotoHandler = (goto: Goto, answer: (found: boolean, why?: string) => void) => void

export type StartFrom = { template: string } | { folder: string }

const ID = 'kehikot.paper'

/** How often the two polls ask. Slow enough to be nothing, fast enough that a suggestion appears while its author is still watching. */
const POLL_MS = 4000

function asStanding(value: unknown): Standing | null {
  if (!value || typeof value !== 'object') return null
  const at = (value as { at?: unknown }).at
  if (at === 'clean' || at === 'nogit') return { at }
  if (at === 'ready') {
    const files = (value as { files?: unknown }).files
    return { at, files: Array.isArray(files) ? files.filter((one): one is string => typeof one === 'string') : [] }
  }
  if (at === 'refused') {
    const why = (value as { why?: unknown }).why
    return { at, why: typeof why === 'string' ? why : 'git refused this commit and did not say why.' }
  }
  return null
}

function asHashes(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  for (const [file, hash] of Object.entries(value as Record<string, unknown>)) {
    if (typeof hash === 'string') out[file] = hash
  }
  return out
}

export function projectFromUrl(search: string): string | null {
  const asked = new URLSearchParams(search).get('project')?.trim()
  return asked ? asked : null
}

export function epicFromUrl(search: string): string | null {
  const asked = new URLSearchParams(search).get('epic')?.trim()
  return asked ? asked : null
}

export function usePaper(framed: boolean) {
  const [sight, setSight] = useState<Sight>(() => (framed ? { at: 'listening' } : { at: 'alone' }))
  const [said, setSaid] = useState('')
  const [saving, setSaving] = useState<Standing>({ at: 'nogit' })
  /** What every file of the paper hashes to on disk, as of the last poll. Null before the first. */
  const [disk, setDisk] = useState<Record<string, string> | null>(null)
  const [nudge, setNudge] = useState(0)
  const askAgain = useCallback(() => setNudge((n) => n + 1), [])
  /** The passage the canvas holds — this page's own, echoed, or somebody else's. */
  const [pointed, setPointed] = useState<Passage | null>(null)

  const host = useRef<Connection | null>(null)
  const goto = useRef<GotoHandler>(() => {})
  const standingOn = useRef<string | null | undefined>(undefined)
  const standingInRef = useRef<string | null | undefined>(undefined)
  const asking = useRef(0)

  const look = useCallback(async (epic: string) => {
    const mine = (asking.current += 1)
    if (standingIn() === null) {
      setSight({ at: 'no-project', why: '' })
      setSaid('')
      return
    }
    setSight({ at: 'asking', epic })
    setDisk(null)
    try {
      const body = await json('/api/paper', { epic })
      /* A slower answer about an epic the canvas has since left. */
      if (mine !== asking.current) return
      if (body.ok === true && body.paper) {
        setSight({ at: 'reading', paper: body.paper as Paper })
        setSaid('')
        return
      }
      if (body.project === null) {
        setSight({ at: 'no-project', why: String(body.error ?? '') })
        return
      }
      setSight({
        at: 'no-paper',
        epic,
        why: String(body.error ?? ''),
        where: typeof body.where === 'string' && body.where ? body.where : null,
      })
      setSaid('')
    } catch (e) {
      if (mine !== asking.current) return
      setSight({ at: 'broke', why: `The paper for ${epic} could not be read: ${(e as Error).message}` })
    }
  }, [])

  useEffect(() => {
    if (framed) return
    standIn(projectFromUrl(window.location.search))
    const asked = epicFromUrl(window.location.search)
    if (asked) void look(asked)
  }, [framed, look])

  useEffect(() => {
    const arrived = (
      context: { epic: string | null; projectPath?: string | null; theme?: string; passage?: Passage | null },
      greeting: boolean,
    ) => {
      const root = document.documentElement
      if (context.theme === 'dark' || context.theme === 'light') {
        root.classList.toggle('dark', context.theme === 'dark')
        root.classList.toggle('light', context.theme === 'light')
      }
      setPointed((was) => (samePassage(was, context.passage ?? null) ? was : (context.passage ?? null)))

      /* A greeting is a new conversation: whatever this page believed about
         where the canvas stood belonged to the last one. */
      if (greeting) {
        standingOn.current = undefined
        standingInRef.current = undefined
      }
      const project =
        typeof context.projectPath === 'string' && context.projectPath.trim() ? context.projectPath.trim() : null
      const relocated = standingInRef.current !== project
      standingInRef.current = project
      if (relocated) standIn(project)

      if (!relocated && context.epic === standingOn.current) return
      standingOn.current = context.epic

      if (context.epic === null) {
        setSight(project === null ? { at: 'no-project', why: '' } : { at: 'no-epic' })
        setSaid('')
        return
      }
      void look(context.epic)
    }

    const live = connect(
      ID,
      {
        onHello: (context, _kept) => arrived(context, true),
        onContext: (context) => arrived(context, false),
        onGoto: (message, answer) => goto.current(message, answer),
      },
      { gotoBackstop: 900 },
    )
    host.current = live
    live.listen()
    return () => {
      live.stop()
      if (host.current === live) host.current = null
    }
  }, [look])

  /** Start a paper for an epic that has none: the plain article, a built-in template, or a copy of a folder. Answers why not, or null. */
  const start = useCallback(async (epic: string, from?: StartFrom): Promise<string | null> => {
    if (standingIn() === null) return 'No project is open.'
    try {
      const body = await post('/api/paper', { epic }, from ?? {})
      if (body.ok === true && body.paper) {
        setSight({ at: 'reading', paper: body.paper as Paper })
        setSaid('')
        return null
      }
      return String(body.error ?? 'That paper could not be started.')
    } catch (e) {
      return `A paper for ${epic} could not be started: ${(e as Error).message}`
    }
  }, [])

  const showing = useRef<Paper | null>(null)
  showing.current = sight.at === 'reading' ? sight.paper : null

  /** The paper's shape, re-read by somebody who just changed it: a save, an accepted suggestion. */
  const setPaper = useCallback((paper: Paper) => {
    if (showing.current && showing.current.epic !== paper.epic) return
    setSight({ at: 'reading', paper })
    setDisk(paper.hashes)
  }, [])

  const [proposals, setProposals] = useState<Proposal[]>([])
  const epicOnScreen = sight.at === 'reading' ? sight.paper.epic : null

  useEffect(() => {
    if (epicOnScreen === null) {
      setProposals([])
      return
    }
    let stopped = false
    const ask = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void json('/api/proposals', { epic: epicOnScreen })
        .then((body) => {
          if (stopped) return
          if (Array.isArray(body.proposals)) setProposals(body.proposals as Proposal[])
          if (typeof body.said === 'string' && body.said) setSaid(body.said)
        })
        .catch(() => {
          /* A poll that failed is retried by the next one. Saying so every
             four seconds would be a container that looks broken. */
        })
    }
    ask()
    const every = setInterval(ask, POLL_MS)
    const woke = () => ask()
    document.addEventListener('visibilitychange', woke)
    return () => {
      stopped = true
      clearInterval(every)
      document.removeEventListener('visibilitychange', woke)
    }
  }, [epicOnScreen])

  useEffect(() => {
    if (epicOnScreen === null) {
      setSaving({ at: 'nogit' })
      return
    }
    let stopped = false
    const ask = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void json('/api/uncommitted', { epic: epicOnScreen })
        .then((body) => {
          if (stopped) return
          const read = asStanding(body.standing)
          if (read) setSaving(read)
          const now = asHashes(body.hashes)
          if (now) setDisk((was) => (sameHashes(was, now) ? was : now))
        })
        .catch(() => {})
    }
    ask()
    const every = setInterval(ask, POLL_MS)
    const woke = () => ask()
    document.addEventListener('visibilitychange', woke)
    return () => {
      stopped = true
      clearInterval(every)
      document.removeEventListener('visibilitychange', woke)
    }
  }, [epicOnScreen, nudge])

  /* One decision at a time. Accepting writes a file and commits it; two of
     those racing is two writers on one file and two `git commit`s on one
     index. */
  const deciding = useRef(false)
  const [busy, setBusy] = useState(false)
  /** Run before a suggestion is accepted: the editor saves what it holds, so the file on disk is the one on screen. */
  const before = useRef<() => Promise<boolean>>(async () => true)

  const answerOne = useCallback(
    async (id: string, decision: 'accept' | 'reject'): Promise<Proposal[] | null> => {
      const paper = showing.current
      if (!paper || deciding.current) return null
      deciding.current = true
      setBusy(true)
      try {
        if (decision === 'accept' && !(await before.current())) {
          setSaid('The file has to be saved before a suggestion about it can be accepted, and it could not be.')
          return null
        }
        const body = await post('/api/proposal', { epic: paper.epic }, { id, decision })
        const left = Array.isArray(body.proposals) ? (body.proposals as Proposal[]) : null
        if (left) setProposals(left)
        if (body.paper) setPaper(body.paper as Paper)
        setSaid(body.ok === true ? String(body.said ?? '') : String(body.error ?? 'That suggestion was not answered.'))
        return left
      } catch (e) {
        setSaid(`That suggestion could not be answered: ${(e as Error).message}`)
        return null
      } finally {
        deciding.current = false
        setBusy(false)
        askAgain()
      }
    },
    [askAgain, setPaper],
  )

  const waiting = useRef<Proposal[]>([])
  waiting.current = proposals

  const acceptAll = useCallback(async (): Promise<void> => {
    /* By id, from the list as it stood when the button was pressed: accepting
       one can drop another, and a suggestion that arrives mid-way was not what
       the person said yes to. */
    const asked = waiting.current.map((p) => p.id)
    let left: Proposal[] = waiting.current
    for (const id of asked) {
      if (!left.some((p) => p.id === id)) continue
      const after = await answerOne(id, 'accept')
      if (!after) return
      left = after
    }
  }, [answerOne])

  /** Commit the paper to its own repository. The files are already written; this is the history. */
  const save = useCallback(async (): Promise<void> => {
    const paper = showing.current
    if (!paper || deciding.current) return
    deciding.current = true
    setBusy(true)
    try {
      const body = await post('/api/save', { epic: paper.epic })
      setSaid(String(body.said ?? body.error ?? ''))
    } catch (e) {
      setSaid(`That could not be committed: ${(e as Error).message}`)
    } finally {
      deciding.current = false
      setBusy(false)
      askAgain()
    }
  }, [askAgain])

  const resize = useCallback((height: number) => host.current?.resize(height), [])

  /** Say where the reader is. Refused or unanswered is the same as not said: a host need not grant it. */
  const point = useCallback((passage: Passage | null) => {
    const conversation = host.current
    if (!conversation) return
    void conversation.request('passage.set', { passage }).catch(() => {})
  }, [])

  return useMemo(
    () => ({
      sight,
      said,
      setSaid,
      resize,
      point,
      pointed,
      goto,
      start,
      setPaper,
      setProposals,
      disk,
      proposals,
      answerOne,
      acceptAll,
      before,
      busy,
      saving,
      save,
      askAgain,
    }),
    [sight, said, resize, point, pointed, start, setPaper, disk, proposals, answerOne, acceptAll, busy, saving, save, askAgain],
  )
}

/**
 * Two passages, by value — the section included.
 *
 * It used not to be, and that was a quiet bug: Slides points at a section with
 * no range and no page, so two different sections of one file compared equal
 * and the second never reached this page.
 */
function samePassage(a: Passage | null, b: Passage | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.path === b.path && a.page === b.page && a.from === b.from && a.to === b.to && a.quoted === b.quoted
    && (a.section?.title ?? null) === (b.section?.title ?? null)
    && (a.section?.from ?? null) === (b.section?.from ?? null)
  )
}

function sameHashes(a: Record<string, string> | null, b: Record<string, string>): boolean {
  if (a === null) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}
