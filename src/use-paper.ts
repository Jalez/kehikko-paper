import type { Goto } from 'roadmap-module-protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Paper } from '../store.ts'
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
  /** Nothing is framing this page, and no `?epic=` was typed either. */
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
  | { at: 'reading'; paper: Paper }
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
 * Which epic an unframed page was told to read.
 *
 * The one replacement for the picker, and deliberately not a replacement for
 * the picker: it names ONE epic and cannot list any. With a host there this is
 * never consulted — the canvas is the answer and two answers would be one too
 * many. With no host there is otherwise nothing at all to go on, and a page
 * that could only ever say "nothing is framing me" would be untestable from a
 * browser as well as useless at a desk.
 *
 * Not validated here beyond being non-empty: `/api/paper` applies `SLUG` to
 * whatever arrives and refuses identically whether or not the epic exists, so a
 * second shape check in the browser would be a second place to keep in step
 * with the first. A string typed into an address bar is exactly as untrusted as
 * one off the wire and goes through the same door.
 */
export function epicFromUrl(search: string): string | null {
  const asked = new URLSearchParams(search).get('epic')?.trim()
  return asked ? asked : null
}

export function usePaper(framed: boolean) {
  const [sight, setSight] = useState<Sight>(() => (framed ? { at: 'listening' } : { at: 'alone' }))
  /**
   * What this page says out loud, and it is now only ever an answer to a walk.
   *
   * It used to narrate the ordinary case as well — "this is the paper for the
   * epic the canvas is on" — which told a reader what the pane header and the
   * canvas had both already told them, in the space where the paper goes. A
   * `roadmap.goto` is different in kind: the page turned and the reader did not
   * turn it, so something has to say why.
   */
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
   * Called from exactly two places — a context whose epic CHANGED, and the
   * `?epic=` an unframed page was opened with — and never from a context that
   * repeated. There is no third caller now that the picker is gone, which is
   * the point: one place decides which paper is on screen.
   */
  const look = useCallback(async (epic: string) => {
    const mine = (asking.current += 1)
    setSight({ at: 'asking', epic })
    try {
      const body = await json(`/api/paper?epic=${encodeURIComponent(epic)}`)
      if (mine !== asking.current) return
      if (body.ok === true && body.paper) {
        setSight({ at: 'reading', paper: body.paper as Paper })
        /* Nothing is said. The reader asked for a paper and is looking at one;
           a sentence under it repeating that is a sentence in the way. */
        setSaid('')
        return
      }
      if (body.configured === false) {
        setSight({ at: 'unconfigured', why: String(body.error ?? '') })
        return
      }
      setSight({ at: 'no-paper', epic })
      setSaid('')
    } catch (e) {
      if (mine !== asking.current) return
      setSight({ at: 'broke', why: `The paper for ${epic} could not be read: ${(e as Error).message}` })
    }
  }, [])

  /*
   * One question asked of this machine before anything else: has anybody said
   * where the papers are?
   *
   * `/api/papers` also answers with every paper on this machine, and this page
   * deliberately ignores that half of it. The door is not the page's to shrink
   * — the MCP `list_papers` tool is the other caller and an agent asking "what
   * papers are here" is a reasonable question for a program to ask — but a PANE
   * showing a list of papers is what this pass removed, so the list is read and
   * dropped rather than kept in a state nothing draws.
   *
   * Asked unconditionally, framed or not, and not waited for by anything. It
   * matters because `unconfigured` is otherwise invisible until somebody opens
   * an epic: a module pointed at no directory at all would sit there saying "no
   * epic is open", which is true and is not the thing that is wrong.
   */
  useEffect(() => {
    let live = true
    json('/api/papers')
      .then((body) => {
        if (!live) return
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
      .catch(() => {
        /* Swallowed rather than shown. This is a probe for one boolean, and a
           page that replaced a perfectly good paper with "the list of papers
           could not be read" would be reporting the failure of a question
           nobody asked. A paper that cannot be read still says so, in `look`. */
      })
    return () => {
      live = false
    }
  }, [])

  /*
   * With no host, the address bar is the only thing that can say which epic.
   *
   * Run once, on mount, and only when unframed. Framed, this is never consulted
   * at all: the canvas is the answer, and a page that would take an epic from
   * its own URL as well would have two answers to the one question this app
   * cannot afford to be confused about.
   */
  useEffect(() => {
    if (framed) return
    const asked = epicFromUrl(window.location.search)
    if (asked) void look(asked)
  }, [framed, look])

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
        setSaid('')
        return
      }
      void look(context.epic)
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

    host.current = connect(ID, {
      onHello: (context) => held(context, true),
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
    () => ({ sight, said, setSaid, resize, goto }),
    [sight, said, resize],
  )
}
