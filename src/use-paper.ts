import { sameParts, type EpicPart, type Goto, type Passage } from 'kehikot-module-protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useHost } from 'kehikot-module-protocol/client/react'

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
 *
 * ## The parts the canvas is pointed at ride past that, and re-read nothing
 *
 * `context.parts` is every part of the open epic, each saying whether a person
 * picked it and which files of the paper are its own. It is read off EVERY
 * context, before the question of whether the epic moved, because picking a
 * part is exactly a context in which the epic did not move. And it is held as
 * its own piece of state, apart from the paper: a change of focus is a change
 * in what is SHOWN of a paper this page already has, so it redraws the lists
 * and the pages and asks the server nothing — no `/api/paper`, no compile, and
 * the editor is not rebuilt under somebody's hands. `src/focus.ts` has the
 * rule; this only carries the list.
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

/** One empty list, so that "no parts" is the same value every time it is said. */
const NO_PARTS: readonly EpicPart[] = []

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
  /** The open epic's parts, as the host last said them. `[]` from a host that has none to say, and when nothing frames this page. */
  const [parts, setParts] = useState<readonly EpicPart[]>(NO_PARTS)

  const goto = useRef<GotoHandler>(() => {})
  /** What the host kept for this module and handed back on its greeting; after that, what it was last asked to keep. */
  const kept = useRef<string | null>(null)
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

  /**
   * What a greeting and every later context both do, after `useHost` has done
   * what is the same in every module: the theme is already on `<html>`.
   *
   * The parts are held HERE rather than read off the hook; the passage is the
   * hook's, by the rule `useHost` is given below.
   */
  const arrived = (
    context: { epic: string | null; projectPath?: string | null; parts?: readonly EpicPart[] },
    greeting: boolean,
  ) => {
    /* Compared by value: a host composes the list afresh for every context
       it sends, and one that says what the last one said must not redraw a
       PDF. Before the early return below, which is about the EPIC. */
    const said = Array.isArray(context.parts) ? context.parts : NO_PARTS
    setParts((was) => (sameParts(was, said) ? was : said))

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

  /**
   * The host: the protocol's `useHost`, which is the connection, the grace
   * before "nobody is there", the theme on `<html>`, and the reload of a page
   * that finds it is older than its own server. The handlers are read through
   * a ref inside it, so the newest is the one called.
   *
   * `same.passage` is this file's own rule for when the passage the canvas
   * holds is the one it was: a passage whose section ends somewhere else is
   * still the same passage. Typing moves the end of the section the caret is
   * in, this page publishes that, the host says it back — and a passage that
   * changed identity on every keystroke would redraw the marks over a PDF
   * nobody had moved in.
   */
  const host = useHost(
    ID,
    {
      onHello: (context, was) => {
        kept.current = was ?? null
        arrived(context, true)
      },
      onContext: (context) => arrived(context, false),
      onGoto: (message, answer) => goto.current(message, answer),
    },
    { gotoBackstop: 900, same: { passage: samePassage } },
  )
  const { where, resize, request, point, passage: pointed } = host

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
  /** The paper the list of suggestions has been HEARD for: before that an empty list is not "none waiting". */
  const [heardFor, setHeardFor] = useState<string | null>(null)
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
          if (Array.isArray(body.proposals)) {
            setProposals(body.proposals as Proposal[])
            setHeardFor(epicOnScreen)
          }
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

  /** Ask the host to keep a string. Said once per change, and a host that refuses or is not there is not an error: see `remembered.ts`. */
  const keep = useCallback((state: string) => {
    if (kept.current === state) return
    kept.current = state
    void request('state.set', { state }).catch(() => {})
  }, [request])

  /**
   * Say which documents this container is showing (`showing.set`), so that a
   * neighbour can narrow to them. Said once per change — the list is compared
   * as its paths, so a paper re-read after a save says nothing — and fire and
   * forget like `keep`: a host that refuses, never learned the method or is
   * not there is not a fault in this page.
   */
  /* `''` and not null: a container that has said nothing is showing nothing, so saying so is no news. */
  const told = useRef('')
  const show = useCallback((documents: Passage[]) => {
    const key = documents.map((one) => one.path).join('\n')
    if (told.current === key) return
    told.current = key
    void request('showing.set', { refs: [], documents }).catch(() => {})
  }, [request])

  /**
   * Try again, after this app's own server has answered again: a paper that
   * could not be opened is asked for once more, and one that is open has its
   * standing read now rather than at the next poll.
   */
  const again = useCallback(() => {
    const on = standingOn.current ?? (framed ? null : epicFromUrl(window.location.search))
    if (on && showing.current === null) void look(on)
    askAgain()
  }, [framed, look, askAgain])

  return useMemo(
    () => ({
      sight,
      /** Whether anything is framing this page, and what the canvas is on: what the shared cover asks. */
      where,
      projectPath: host.projectPath,
      epic: host.epic,
      said,
      setSaid,
      resize,
      point,
      pointed,
      parts,
      goto,
      kept,
      keep,
      show,
      start,
      setPaper,
      setProposals,
      proposalsHeard: heardFor !== null && heardFor === epicOnScreen,
      disk,
      proposals,
      answerOne,
      acceptAll,
      before,
      busy,
      saving,
      save,
      askAgain,
      again,
    }),
    [sight, where, host.projectPath, host.epic, said, resize, point, pointed, parts, keep, show, start, setPaper, disk, proposals, heardFor, epicOnScreen, answerOne, acceptAll, busy, saving, save, askAgain, again],
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
