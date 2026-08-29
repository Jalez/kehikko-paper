import type { Goto } from 'roadmap-module-protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Paper, PaperBrief } from '../store.ts'
import { connect, type Host } from '../wire/host.ts'

/**
 * What this page can see, and the one place the wire and the papers meet.
 *
 * `reader/` knows about LaTeX and nothing about the wire. `wire/host.ts` knows
 * about the wire and nothing about papers. This hook is the only place the two
 * meet, and it is deliberately the only one — two places deciding which paper
 * is on screen would eventually disagree, and "which paper am I looking at" is
 * the one question this app cannot afford to be confused about.
 *
 * Every type imported from `../store.ts` comes in with `import type`, and that
 * is not a style preference. `store.ts` imports `node:fs`; a VALUE import of it
 * would put a `node:` module in the browser bundle, and what that looks like
 * from the outside is a page that loads, fires `load`, gets greeted, and never
 * answers — with `tsc` and `bun test` both perfectly happy. Only a browser sees
 * it, and only in the console.
 */

export type Sight =
  /** Framed, and no greeting has arrived yet. Under a second. */
  | { at: 'listening' }
  /** Nothing is framing this page. The picker is the whole navigation. */
  | { at: 'alone' }
  /** A host is there and says no epic is open. */
  | { at: 'no-epic' }
  /** An epic is open and this machine holds no paper for it. */
  | { at: 'no-paper'; epic: string }
  /** Nobody has told this program where the papers are. */
  | { at: 'unconfigured'; why: string }
  /** Asking for one. */
  | { at: 'asking'; epic: string }
  /** Showing one. */
  | { at: 'reading'; paper: Paper; because: 'context' | 'picked' }
  /** The fetch failed in a way none of the above describes. */
  | { at: 'broke'; why: string }

export type GotoHandler = (goto: Goto, answer: (found: boolean, why?: string) => void) => void

const ID = 'roadmap.paper'

/**
 * Fetches are relative, and that is load-bearing.
 *
 * `/api/paper` and not `http://127.0.0.1:7870/api/paper`. The page is served at
 * `/app` by the same process that answers these, so a relative path is a fact
 * about where this document came from; an absolute one would be this file's
 * guess about a port, and a wrong guess is a page that works when developed and
 * not when somebody runs it on another one.
 */
async function json(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error('that answer was not a document')
  return body as Record<string, unknown>
}

/**
 * Read one row of `epics.list` defensively.
 *
 * The protocol is explicit that a response is `unknown`: the host promised
 * nothing about this shape. A row with no usable name is not an epic this page
 * can say anything about and is left out.
 *
 * Two shapes and two spellings are accepted, and neither is indecision. The
 * SHAPE, because the protocol's note on `epics.list` gives a floor for what an
 * answer must contain and never says what wraps it — measured against the host
 * in this workspace it is `{ epics: [...] }`, and a bare array is the other
 * obvious reading. A module that insisted on one would show an empty list
 * against half the hosts that exist while being technically correct, and would
 * do it silently, because `Array.isArray` on the wrong shape is `false` rather
 * than an error. The SPELLING, because the protocol renamed this material from
 * journeys to epics and hosts written against the older spelling answer with
 * `slug`. When no host in the field answers `slug`, that clause goes.
 */
export function briefs(data: unknown): { epic: string; title: string }[] {
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { epics?: unknown }).epics)
      ? (data as { epics: unknown[] }).epics
      : null
  if (!rows) return []
  const out: { epic: string; title: string }[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const named = row as { epic?: unknown; slug?: unknown; title?: unknown }
    const epic = typeof named.epic === 'string' ? named.epic : typeof named.slug === 'string' ? named.slug : ''
    if (!epic) continue
    out.push({ epic, title: typeof named.title === 'string' ? named.title : epic })
  }
  return out
}

export function usePaper(framed: boolean) {
  const [sight, setSight] = useState<Sight>(() => (framed ? { at: 'listening' } : { at: 'alone' }))
  /** Every paper on this machine. Empty until `/api/papers` has answered. */
  const [papers, setPapers] = useState<PaperBrief[]>([])
  /**
   * Every epic the host will name, or null while nobody has answered.
   *
   * Three values and the third is doing the work: a list is what the host said,
   * an empty list is a host saying there are no epics, and `null` is "nobody
   * has been asked, or nobody answered". Only the first two are facts.
   * Collapsing the last into the empty list would have this page state, in
   * writing, that every epic has a paper — on the strength of a question that
   * was never answered.
   */
  const [epics, setEpics] = useState<{ epic: string; title: string }[] | null>(null)
  const [said, setSaid] = useState('')

  const host = useRef<Host | null>(null)
  const goto = useRef<GotoHandler>(() => {})

  /**
   * The epic the last context put this page on.
   *
   * Three values and not two: a slug, `null` for "the host says no epic is
   * open", and `undefined` for "no context has been read yet". Collapsing the
   * last two would make the first context of a conversation that names no epic
   * look like a repeat of a state the page was already in, and the screen that
   * belongs to that state would never be drawn.
   *
   * ## Every fetch on this page is keyed to this CHANGING
   *
   * `roadmap.context` no longer means "the reader moved": it carries the
   * canvas's selection too, so the host sends one after every selection change
   * anywhere on the canvas — several a second while somebody drags. Re-fetching
   * on each would throw the paper away and put the page back into `asking`
   * every time somebody clicked in another pane: fifteen hundred words gone, a
   * line saying the question is out, and the text back a moment later having
   * lost the reader's place. The click that caused it would look like a bug in
   * this pane.
   *
   * So a repeated context about the same epic is a normal event, and the right
   * response is to read the parts that did change — the theme — and leave the
   * reading alone. The cost, stated plainly: this page does not refetch when a
   * host re-sends the same epic to mean "you were hidden and are visible
   * again". That was never a promise the protocol made, and the fix if it is
   * ever wanted is a context field saying so, not a fetch on every tick.
   */
  const standingOn = useRef<string | null | undefined>(undefined)

  /**
   * Which question is the current one.
   *
   * Epics switch faster than a slow disk answers, and without this the answer
   * about the previous epic arrives after the answer about this one and quietly
   * replaces it — a paper of the right length, under the right title, about the
   * wrong argument.
   */
  const asking = useRef(0)

  /**
   * Ask for one epic's paper.
   *
   * Called from exactly two places — a context whose epic CHANGED, and a click
   * on the picker — and never from a context that repeated.
   */
  const look = useCallback(async (epic: string, because: 'context' | 'picked') => {
    const mine = (asking.current += 1)
    setSight({ at: 'asking', epic })
    try {
      const body = await json(`/api/paper?epic=${encodeURIComponent(epic)}`)
      if (mine !== asking.current) return
      if (body.ok === true && body.paper) {
        setSight({ at: 'reading', paper: body.paper as Paper, because })
        setSaid(
          because === 'context'
            ? 'This is the paper for the epic the canvas is on.'
            : 'You chose this paper; the canvas is somewhere else.',
        )
        return
      }
      if (body.configured === false) {
        setSight({ at: 'unconfigured', why: String(body.error ?? '') })
        return
      }
      setSight({ at: 'no-paper', epic })
      setSaid(`Nothing here holds a paper for ${epic}.`)
    } catch (e) {
      if (mine !== asking.current) return
      setSight({ at: 'broke', why: `The paper for ${epic} could not be read: ${(e as Error).message}` })
    }
  }, [])

  /*
   * The paper list is fetched immediately and unconditionally, framed or not.
   *
   * It does not depend on a greeting — it is a fact about this machine — and
   * asking for it first means the picker is populated by the time a context
   * arrives, so a `no-epic` screen can already say how many papers are there
   * instead of promising to find out.
   */
  useEffect(() => {
    let live = true
    json('/api/papers')
      .then((body) => {
        if (!live) return
        setPapers(Array.isArray(body.papers) ? (body.papers as PaperBrief[]) : [])
        if (body.configured !== true) {
          setSight({
            at: 'unconfigured',
            why:
              'This app reads papers out of directories named by environment variables, and none of ' +
              'KEHIKKO_PAPERS_DIR, KEHIKKO_ROADMAP_DIR or KEHIKKO_THESIS_DIR is set for the process ' +
              'serving this page.',
          })
        }
      })
      .catch((e: unknown) => {
        if (!live) return
        setSight({ at: 'broke', why: `The list of papers could not be read: ${(e as Error).message}` })
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    /**
     * A context, from the greeting or from a switch, handled identically.
     *
     * One function for both because they carry the same object and mean the
     * same thing: this is where the reader is standing. Handling them
     * separately is how a page ends up applying the theme on a switch and not
     * on the greeting, which is a bug that only shows on the first paint and
     * therefore in front of somebody.
     */
    const arrived = (context: { epic: string | null; theme?: string }, greeting: boolean) => {
      /* The theme is a fact about the document rather than about any part of
         it, so it goes on the root element. `light` is set explicitly as well
         as `dark`, so a host asking for light on a machine set to dark actually
         gets light — see the media query in `index.css`. */
      const root = document.documentElement
      if (context.theme === 'dark' || context.theme === 'light') {
        root.classList.toggle('dark', context.theme === 'dark')
        root.classList.toggle('light', context.theme === 'light')
      }

      /* A greeting always re-reads, because a greeting means the conversation
         is new: the host greets on every frame LOAD, so one arriving is a page
         that has just come into existence or a frame that reloaded and has
         forgotten everything. In StrictMode this effect is torn down and set up
         again on purpose, and the replayed greeting must not be deduplicated
         against state the teardown has already discarded. */
      if (greeting) standingOn.current = undefined

      if (context.epic === standingOn.current) return
      standingOn.current = context.epic

      if (context.epic === null) {
        setSight({ at: 'no-epic' })
        setSaid('The canvas is not on an epic.')
        return
      }
      void look(context.epic, 'context')
    }

    /**
     * The connection is stored BEFORE anything acts on a greeting, and the
     * order is a fixed bug rather than a style.
     *
     * `connect` subscribes to the mailbox, and the mailbox replays what has
     * already arrived SYNCHRONOUSLY, inside that call. The greeting almost
     * always arrives before React mounts — that is the entire reason the
     * mailbox exists — so `onHello` fires on this line, before `host.current`
     * has been assigned. Anything the handler then tries to send goes nowhere,
     * with no error and no timeout: in References this hung a page forever on
     * "Asking about…", because no question was ever sent and so none could time
     * out. Here the symptom would be a pane that knows the epic and never asks
     * the host which epics exist.
     *
     * Worse, it works often enough to look fine — when the host happens to
     * greet after this effect returns, the assignment has already happened. A
     * race whose good outcome is the common one is the kind that ships.
     *
     * So anything that fires too early is held and delivered the moment the
     * assignment is done, in order.
     */
    type Arrival = [context: { epic: string | null; theme?: string }, greeting: boolean]
    let ready = false
    /* A box rather than a bare `let`, and only because of the compiler: this is
       assigned inside a callback `connect` invokes, which the flow analysis
       cannot see. */
    const early: { arrivals: Arrival[] } = { arrivals: [] }
    const held = (...arrival: Arrival) => {
      if (ready) arrived(...arrival)
      else early.arrivals.push(arrival)
    }

    /**
     * Ask which epics exist, once, on the greeting.
     *
     * On the greeting rather than on every context, because the set of epics is
     * not a fact about where the reader is standing, and re-asking it on each
     * context would be one more request per selection change — the arithmetic
     * that makes re-fetching the paper wrong, applied to a smaller answer.
     *
     * Every failure is the same failure and is swallowed: a host that refuses
     * the capability, a host that never heard of `epics.list`, and a host that
     * does not answer all leave `epics` null, and the picker then says nothing
     * about a gap rather than saying there is none.
     */
    const askForEpics = () => {
      host.current
        ?.request('epics.list')
        .then((data) => setEpics(briefs(data)))
        .catch(() => {
          /* Deliberately silent. This is enrichment, and a line complaining
             about a permission this app was never promised is not something a
             reader of a paper needs. */
        })
    }

    host.current = connect(ID, {
      onHello: (context) => {
        setSaid('A host greeted this page.')
        held(context, true)
        askForEpics()
      },
      onContext: (context) => held(context, false),
      onGoto: (message, answer) => goto.current(message, answer),
    })
    ready = true
    for (const arrival of early.arrivals) arrived(...arrival)
    early.arrivals.length = 0

    return () => {
      host.current?.stop()
      host.current = null
    }
  }, [look])

  /**
   * Say how tall this page would like its frame to be.
   *
   * A request, not an instruction: the host clamps whatever arrives. It is
   * measured off `scrollHeight` by the caller after a paint, because a paper is
   * however long it is and a fixed height would either crop the argument or
   * leave a field of empty pane under a short one.
   */
  const resize = useCallback((height: number) => host.current?.resize(height), [])

  return useMemo(
    () => ({ sight, papers, epics, said, setSaid, look, resize, goto }),
    [sight, papers, epics, said, look, resize],
  )
}
