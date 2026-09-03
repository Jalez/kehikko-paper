import type { Goto, Passage } from 'roadmap-module-protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { connect, type Connection } from 'roadmap-module-protocol/client'

import type { Standing } from '../git.ts'
import type { Proposal } from '../latex/propose.ts'
import type { Paper } from '../store.ts'
import { json, post, standIn, standingIn } from './api.ts'

/**
 * What this page can see, and the one place the wire and the papers meet.
 *
 * `reader/` knows about LaTeX and nothing about the wire.
 * `roadmap-module-protocol/client` knows about the wire and nothing about
 * papers. This hook is the only place the two meet, and it is deliberately the
 * only one — two places deciding which paper is on screen would eventually
 * disagree, and "which paper am I looking at" is the one question this app
 * cannot afford to be confused about.
 *
 * ## What used to be underneath this
 *
 * `wire/host.ts` and `wire/mailbox.ts`, at the root of this repository — 435
 * lines, near-identical to the copy every sibling module carried. They are one
 * import now.
 *
 * The context was rebuilt field by field there, and this module's list was the
 * most careful in the family: all nine fields, each with a paragraph arguing
 * that copying a field it does not read costs a line while dropping one costs
 * an afternoon. The argument was right and it is the wrong shape — a list that
 * has to be kept complete is a list that will be incomplete at the next
 * protocol release, and it was in three sibling modules that had written the
 * same paragraph. Nothing starts or stops arriving here today, because the list
 * happened to be current; what changed is that it can no longer fall behind.
 *
 * The `goto` backstop is passed explicitly as 900ms, this module's own number
 * rather than the client's 500 — the option exists so adoption keeps each
 * module's timing rather than unifying it on the way past.
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
  /**
   * An epic is open and its project holds no paper for it.
   *
   * `why` rides along because the sentence is worth nothing without the
   * directory in it. "There is no paper for this epic" used to be a claim about
   * the whole machine; it is now a claim about one project, and naming that
   * project is the difference between a reader shrugging at it and a reader
   * noticing they are standing somewhere they did not mean to be. The server
   * composes it, because the server is the only one that knows whether the
   * project keeps papers at all — see `noPaper` in `doors.ts`.
   */
  | {
      at: 'no-paper'
      epic: string
      why: string
      /**
       * Where the paper would go, as the server names it.
       *
       * Carried on the refusal rather than fetched, so the path on screen and
       * the epic in the sentence cannot be about two different things. `null`
       * when the server did not say — an older build, or a refusal that came
       * from somewhere other than the paper door — and the screen then shows
       * the sentence and no button, which is the honest reading of "I do not
       * know where it goes".
       */
      where: string | null
    }
  /**
   * Nobody has said which project, so there is nowhere to look.
   *
   * This replaced `unconfigured`, which meant "no environment variable is set"
   * — a sentence about the shell that started this process. What it describes
   * is a different kind of thing now: not a misconfiguration somebody has to go
   * and repair, but the ordinary condition of a canvas with no project open,
   * which a reader passes through several times a day.
   */
  | { at: 'no-project'; why: string }
  /** Asking for one. */
  | { at: 'asking'; epic: string }
  /** Showing one. */
  | { at: 'reading'; paper: Paper }
  /** The fetch failed in a way none of the above describes. */
  | { at: 'broke'; why: string }

export type GotoHandler = (goto: Goto, answer: (found: boolean, why?: string) => void) => void

const ID = 'roadmap.paper'

/**
 * How often the page asks what has been suggested about the paper it is showing.
 *
 * Four seconds, and the number is a judgement rather than a measurement. An
 * agent proposing a change is not in a hurry — it has just finished reading a
 * paper — and a person who has one arrive within four seconds of it being made
 * experiences it as immediate. Below about a second this would be a program
 * polling a loopback door faster than anybody can read a sentence; above about
 * ten the feature stops feeling like a conversation.
 */
const PROPOSAL_POLL_MS = 4000

/**
 * `/api/uncommitted`'s answer, checked rather than cast.
 *
 * Everything else this hook reads off the wire is drawn; this one decides
 * whether a control that writes into somebody's git repository appears at all,
 * and whether a sentence about their repository is shown as this app's own. So
 * it is narrowed by hand, and anything unrecognised answers null — which leaves
 * the previous value standing rather than turning an unexpected document into
 * a Save button.
 *
 * The type is `git.ts`'s, imported for the type only. That file imports
 * `node:child_process`, so a VALUE import of it would put a `node:` module in
 * the browser bundle — the failure `store.ts` is imported carefully to avoid,
 * with the same silent shape: a page that loads and then does nothing.
 */
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


/**
 * Which project an unframed page was told to stand in.
 *
 * The companion to `epicFromUrl` and it arrived for the same reason. A paper
 * now lives in a project, so a page with no host has to be told two things
 * rather than one, and the address bar is still the only thing that can say
 * either. `?project=/abs/path&epic=some-slug` is a page opened at a desk; with
 * a host there neither is consulted, because the canvas is the answer and two
 * answers would be one too many.
 *
 * This is the fallback that replaced `KEHIKKO_PAPERS_DIR`, and it is a better
 * one on every axis that mattered: it names the project rather than a directory
 * of papers, it is per-page rather than per-shell, it cannot go missing when
 * somebody restarts the module from a different terminal, and it is the same
 * string in the same request that the framed page and an agent at `/mcp` both
 * send — one path through the server rather than two.
 *
 * Not validated here beyond being non-empty. `projectOf` on the other side
 * demands an absolute path that resolves to a directory and refuses everything
 * else identically; a second opinion in the browser would be a second rule to
 * keep in step with the first.
 */
export function projectFromUrl(search: string): string | null {
  const asked = new URLSearchParams(search).get('project')?.trim()
  return asked ? asked : null
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
   * epic the canvas is on" — which told a reader what the container header and the
   * canvas had both already told them, in the space where the paper goes. A
   * `roadmap.goto` is different in kind: the page turned and the reader did not
   * turn it, so something has to say why.
   */
  const [said, setSaid] = useState('')

  const [saving, setSaving] = useState<Standing>({ at: 'nogit' })
  const [nudge, setNudge] = useState(0)
  /* A stable way for the writers below to say "ask again now". They are
     `useCallback`s with no dependencies and must stay that way — the whole
     module hangs off their identity — so this is a setter and not the ask
     itself. */
  const askAgain = useCallback(() => setNudge((n) => n + 1), [])
  /**
   * Where somebody else is pointing, as the context carries it.
   *
   * ## This module publishes a passage and had never read one
   *
   * `use-published-passage.ts` says where the reader is; nothing here listened
   * for the answer, so the wire ran one way. The user asked for the other —
   * "when you click on a note shouldn't it highlight and show what its target
   * from the paper?" — and the mechanism is the same field read instead of
   * written.
   *
   * Compared before it is written, because it is an OBJECT rebuilt by the host
   * on every context. Without that, a passage that had not changed would be a
   * new identity several times a second, and everything downstream of it —
   * scrolling the reader to a block, marking a range — would fire on each one.
   * The host has a measured history of this exact shape: seventeen identical
   * contexts during one startup because nothing checked.
   */
  const [pointed, setPointed] = useState<Passage | null>(null)

  const host = useRef<Connection | null>(null)
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
   * every time somebody clicked in another container: fifteen hundred words gone, a
   * line saying the question is out, and the text back a moment later having
   * lost the reader's place. The click that caused it would look like a bug in
   * this container.
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
   * Which project the last context put this page in.
   *
   * Three values for the same reason `standingOn` has three, and one extra
   * consequence: this is the field that changes WHICH STORE the page is
   * reading. Every other field in a context changes what is drawn out of one
   * project; a new `projectPath` means a different directory, a different set
   * of papers, and a different answer to every question already asked.
   *
   * So a project that changed forces the epic to be re-read even when the epic
   * did not change. Epic slugs are short, lower-case and hand-picked — `thesis`
   * and `wire` are real ones — and a second project plausibly uses the same
   * word for something else. "You are already showing this" is only true within
   * one project, and believing it across two draws the wrong paper under the
   * right name with nothing on screen saying so.
   */
  const standingInRef = useRef<string | null | undefined>(undefined)

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
    /* Asked before the fetch rather than after the refusal. With no project
       there is nothing to ask, and firing a request that can only ever come
       back 409 puts a red line in the network tab on every load for a state
       that is ordinary — a canvas with no project open. Journeys had exactly
       this, as a 404 on every render for an epic it held no journey for, and
       the noise sent people hunting a broken fetch that did not exist. */
    if (standingIn() === null) {
      setSight({ at: 'no-project', why: '' })
      setSaid('')
      return
    }
    setSight({ at: 'asking', epic })
    try {
      const body = await json('/api/paper', { epic })
      if (mine !== asking.current) return
      if (body.ok === true && body.paper) {
        setSight({ at: 'reading', paper: body.paper as Paper })
        /* Nothing is said. The reader asked for a paper and is looking at one;
           a sentence under it repeating that is a sentence in the way. */
        setSaid('')
        return
      }
      /* `project: null` in a refusal is the server saying it was given no
         project — which can only mean this page's own idea of where it stands
         disagreed with what it sent, so the page's state is what is wrong and
         the paper is not the thing to report on. */
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

  /*
   * The probe that used to run here is gone, and its absence is the change.
   *
   * It asked `/api/papers` on mount, unconditionally, to find out whether
   * anybody had set the environment variables — because `unconfigured` was
   * otherwise invisible until somebody opened an epic, and a module pointed at
   * no directory would sit there saying "no epic is open", which was true and
   * was not the thing that was wrong.
   *
   * There is nothing to probe for any more. Where a paper is is a fact about
   * the open project, so the question "is this app configured" has no answer
   * that is not also the answer to "which project is open" — and that arrives
   * in the context, from the host, without being asked. A probe fired before
   * any context could only ever report on a project this page had not been told
   * about yet.
   *
   * `/api/papers` still exists and is still worth having: `list_papers` on the
   * MCP door is its caller, and an agent asking what papers a project holds is
   * a reasonable question for a program to ask. The page simply is not one of
   * its callers now.
   */

  /*
   * With no host, the address bar is the only thing that can say where we are.
   *
   * Two things rather than one, and `project` is set BEFORE the epic is asked
   * for — `look` reads the standing project to decide whether there is anything
   * to ask at all, so the other order is a page that says "no project" and then
   * quietly does not retry.
   *
   * Run once, on mount, and only when unframed. Framed, neither is consulted:
   * the canvas is the answer, and a page taking a project from its own URL as
   * well would have two answers to the one question this app cannot afford to
   * be confused about — with the URL's answer being the stale one, since it
   * cannot change when the host moves the canvas to another project.
   */
  useEffect(() => {
    if (framed) return
    standIn(projectFromUrl(window.location.search))
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
    const arrived = (
      context: { epic: string | null; projectPath?: string | null; theme?: string; passage?: Passage | null },
      greeting: boolean,
    ) => {
      /* The theme is a fact about the document rather than about any part of
         it, so it goes on the root element. `light` is set explicitly as well
         as `dark`, so a host asking for light on a machine set to dark actually
         gets light — see the media query in `index.css`. */
      const root = document.documentElement
      if (context.theme === 'dark' || context.theme === 'light') {
        root.classList.toggle('dark', context.theme === 'dark')
        root.classList.toggle('light', context.theme === 'light')
      }

      /* Applied on every context including the ones that name no epic, and
         including null — a passage this page holds onto after the canvas has
         stopped pointing is a mark on a page nobody is pointing at. */
      setPointed((was) => (samePassage(was, context.passage ?? null) ? was : (context.passage ?? null)))

      /* A greeting always re-reads, because a greeting means the conversation
         is new: the host greets on every frame LOAD, so one arriving is a page
         that has just come into existence or a frame that reloaded and has
         forgotten everything. In StrictMode this effect is torn down and set up
         again on purpose, and the replayed greeting must not be deduplicated
         against state the teardown has already discarded. */
      if (greeting) {
        standingOn.current = undefined
        standingInRef.current = undefined
      }

      /*
       * The project is applied FIRST, and it invalidates the epic.
       *
       * `standIn` is what every later fetch and every `<img src>` on this page
       * is built from, so it has to be current before anything is asked. And a
       * project that moved makes "you are already showing this epic" false even
       * when the epic did not move, for the reason on `standingInRef`: the same
       * slug in a different project is a different paper.
       *
       * A trimmed empty string is `null` rather than a project. A host that
       * sends `projectPath: ""` is a host saying it has no folder, and treating
       * that as a path would send `project=` on every request for the server to
       * refuse one query at a time.
       */
      const project =
        typeof context.projectPath === 'string' && context.projectPath.trim() ? context.projectPath.trim() : null
      const relocated = standingInRef.current !== project
      standingInRef.current = project
      if (relocated) standIn(project)

      if (!relocated && context.epic === standingOn.current) return
      standingOn.current = context.epic

      if (context.epic === null) {
        /* Both absent is one situation and not two, and the project is the half
           worth saying. "No epic is open" invites somebody to open one; with no
           project there is still nowhere to read when they do, and they would
           have opened an epic to watch the same empty container. */
        setSight(project === null ? { at: 'no-project', why: '' } : { at: 'no-epic' })
        setSaid('')
        return
      }
      void look(context.epic)
    }

    /**
     * The connection is stored BEFORE it is told to listen, and the order is a
     * fixed bug rather than a style.
     *
     * `listen()` subscribes to the mailbox, and the mailbox replays what has
     * already arrived SYNCHRONOUSLY, inside that call. The greeting almost
     * always arrives before React mounts — that is the entire reason the
     * mailbox exists — so `onHello` fires on that line. Anything a handler then
     * tries to send before the assignment goes nowhere, with no error and no
     * timeout: in References this hung a page forever on "Asking about…",
     * because no question was ever sent and so none could time out. Here the
     * symptom would be a container that knows the epic and never asks the host
     * which epics exist.
     *
     * Worse, it works often enough to look fine — when the host happens to
     * greet after this effect returns, the assignment has already happened. A
     * race whose good outcome is the common one is the kind that ships.
     *
     * What stood here was a queue that caught the too-early arrivals and
     * replayed them in order once the assignment was done. `connect` and
     * `listen` are two calls now, so the ordering is three plain lines.
     */
    const live = connect(
      ID,
      {
        /**
         * The greeting, and the second thing it carries.
         *
         * `state` is whatever the host is keeping for this module. The copy of
         * the wire that stood in this repository declared `onHello` with one
         * parameter, so the value was parsed off the greeting and then had
         * nowhere to go. It is named and ignored here rather than absent: this
         * page declares no `state:keep` and holds nothing worth keeping, and
         * the point is that a page which later wants it finds the plumbing
         * instead of rediscovering that the host had been sending it.
         */
        onHello: (context, _kept) => arrived(context, true),
        onContext: (context) => arrived(context, false),
        onGoto: (message, answer) => goto.current(message, answer),
      },
      /* 900ms, this module's own number rather than the client's 500. A walk
         into a paper may have to wait for a paper to load and lay out before it
         can honestly say whether the reference is in it. */
      { gotoBackstop: 900 },
    )
    host.current = live
    live.listen()

    return () => {
      live.stop()
      /* Cleared only if it is still ours: under StrictMode the second mount has
         already assigned its own connection by the time some cleanups run. */
      if (host.current === live) host.current = null
    }
  }, [look])

  /**
   * Start a paper for the epic that has none, and show it.
   *
   * The whole of the interaction is one press: the folder is made with a
   * document in it and the same read that would have run anyway runs again, so
   * what appears is the paper rather than a message about a paper. If the door
   * refuses — something is already there, which is what a second press or a
   * second container would find — the refusal replaces the sentence and the
   * button goes, because the reason it was drawn has stopped being true.
   */
  const start = useCallback(async (epic: string) => {
    if (standingIn() === null) return
    try {
      const body = await post('/api/paper', { epic })
      if (body.ok === true && body.paper) {
        setSight({ at: 'reading', paper: body.paper as Paper })
        setSaid('')
        return
      }
      setSight({ at: 'no-paper', epic, why: String(body.error ?? ''), where: null })
    } catch (e) {
      setSight({ at: 'broke', why: `A paper for ${epic} could not be started: ${(e as Error).message}` })
    }
  }, [])

  /**
   * The paper on screen, where a callback can reach it.
   *
   * Assigned during render rather than in an effect, the way `told.current` is
   * in `paginated.tsx` and for the same reason: `correct` below must not be
   * rebuilt every time the paper object is replaced, because it is handed to
   * every editable span in the document and a new identity would re-bind all of
   * them on every keystroke's worth of state change. A ref is the current value
   * without being a dependency.
   */
  const showing = useRef<Paper | null>(null)
  showing.current = sight.at === 'reading' ? sight.paper : null

  /**
   * Write one correction back into the `.tex` file, and catch the reading up.
   *
   * ## What it adds to what the caller sent
   *
   * The epic, and `was` — the hash of that file as this page last read it,
   * which `readPaper` handed out on the paper itself. That is the whole
   * concurrency story from this side: the page does not decide whether the file
   * has moved and cannot, it says which version its offsets were measured
   * against and the server refuses if that is no longer the file. The essay is
   * on `writeRange`.
   *
   * Taken from the paper on screen rather than passed in by the caller,
   * because the caller is a span in the middle of a paragraph and the one thing
   * it must not be trusted with is which document it is part of.
   *
   * ## Both answers replace the paper, and that is the point
   *
   * A write that landed returns the file re-read, so every offset on screen is
   * about the bytes that are now on disk. A write refused as STALE returns the
   * same thing, because the reason it was refused is that the page's copy was
   * out of date and the fix is the read it was already going to need. Any other
   * refusal leaves the paper alone: the file did not change, so neither should
   * what is drawn.
   *
   * The reader does not move for any of it. `PaginatedView` resets the scroll
   * on the EPIC changing and never on the paper object being replaced — see the
   * note beside that effect, which was written for the re-sent context and
   * holds unchanged here. Nobody is thrown to the top of a thesis for fixing a
   * typo. The one other thing that moves a reader is a walk, and the effect
   * in `app.tsx` that performs one is keyed on the paper too — it stamps each
   * walk with the pointing it was for, so a replaced paper re-marks the
   * passage and does not walk to it again. It used to, and every Accept was a
   * trip back to the last note somebody had clicked.
   *
   * ## It answers with a sentence or with nothing
   *
   * `null` means it landed. A string is what to tell the person, and it is the
   * server's own words rather than this file's: the server is the only one that
   * knows which of a dozen refusals applied, and a page that paraphrased would
   * be a second, worse copy of that list.
   */
  const correct = useCallback(
    async (edit: { file: string; from: number; to: number; text: string }): Promise<string | null> => {
      const paper = showing.current
      if (!paper) return 'There is no paper open to correct.'
      const was = paper.hashes[edit.file]
      /* No hash means this page never opened that file, which makes every
         offset in the request meaningless. Refused here rather than sent with
         an empty `was`, which the server would answer as staleness — a true
         sentence about the wrong problem. */
      if (!was) return `This paper does not name a file called “${edit.file}”.`
      try {
        const body = await post('/api/edit', { epic: paper.epic }, { ...edit, was })
        /* A write moves every pending suggestion's offsets, and the door rebases
           them in the same breath and sends them back — so the page never holds
           a list measured against a file it has stopped believing in. */
        if (Array.isArray(body.proposals)) setProposals(body.proposals as Proposal[])
        if (body.ok === true && body.paper) {
          setSight({ at: 'reading', paper: body.paper as Paper })
          if (body.said) setSaid(String(body.said))
          /* The file just changed, so what Save would do just changed. Asked
             again now rather than waiting up to four seconds for the poll,
             because the reader is looking at the button. */
          askAgain()
          return null
        }
        if (body.paper) setSight({ at: 'reading', paper: body.paper as Paper })
        return String(body.error ?? 'That correction was not written.')
      } catch (e) {
        return `That correction could not be sent: ${(e as Error).message}`
      }
    },
    [askAgain],
  )

  /**
   * What has been suggested about the paper on screen, and nobody has answered.
   *
   * ## Polled, and the reason there is no push
   *
   * An agent proposes over `/mcp`, which is a request to the SERVER. There is no
   * channel from the server to this page: `answer()` returns a status and a
   * document, `vite.config.ts` adapts one request to one response, and adding
   * an event stream would mean this module holding a socket open per reader for
   * the sake of a list that changes a few times an hour. So the page asks.
   *
   * Every four seconds, and only while the document is visible — a container
   * scrolled off a canvas, or a tab in the background, is not a reader waiting
   * for an answer, and a poll that ran there would be this module spending
   * somebody's battery on a paper nobody is looking at. It resumes on
   * `visibilitychange`, immediately rather than after the next interval, so
   * coming back to the tab does not mean waiting.
   *
   * The read is ungated and tiny — an epic, a project, and a list that is
   * almost always empty — which is what makes polling an acceptable answer here
   * rather than a compromise. What it costs when nothing is happening is one
   * request every four seconds returning `{"ok":true,"proposals":[]}`.
   */
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
          /* Dropped if the epic changed while this was in flight. A list of
             suggestions about the previous paper, drawn against this one's byte
             offsets, would put a green and red change in the middle of a
             paragraph it has nothing to do with. */
          if (stopped) return
          if (Array.isArray(body.proposals)) setProposals(body.proposals as Proposal[])
        })
        .catch(() => {
          /* Swallowed, like `point`'s refusal and for the same reason: the
             paper on screen is unaffected, and "the suggestion list could not
             be fetched" is not something the person reading can act on. The
             next tick tries again. */
        })
    }
    ask()
    const every = setInterval(ask, PROPOSAL_POLL_MS)
    const woke = () => ask()
    document.addEventListener('visibilitychange', woke)
    return () => {
      stopped = true
      clearInterval(every)
      document.removeEventListener('visibilitychange', woke)
    }
  }, [epicOnScreen])

  /**
   * Whether the paper has anything waiting to be committed, and whether a
   * commit here would work at all.
   *
   * ## What the Save button is reading
   *
   * This is a fact about somebody's git repository, so it can change without
   * this page doing anything: the author saves a chapter in their real editor,
   * or commits from a terminal, and what Save would do is different. It is
   * therefore polled rather than derived — there is nothing in this page to
   * derive it from — on the same four seconds as the proposal list, in a
   * separate effect so that neither read can break the other, and `nudged`
   * whenever this page has just written something and does not want to wait up
   * to four seconds to say so.
   *
   * `nogit` is the state a paper in a plain folder sits in forever, and it is
   * why this is a four-way answer and not a boolean. See `Standing` in
   * `git.ts`: no repository is not a failure to report, it is a Save button
   * that is not drawn.
   */

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
          /* Checked rather than cast. This is the only value on the page that
             decides whether a control which writes to somebody's git history is
             drawn, and an answer from an older or a different server should
             leave it where it was rather than become a button. */
          const read = asStanding(body.standing)
          if (read) setSaving(read)
        })
        .catch(() => {
          /* Swallowed like the proposal poll's, and for the same reason: the
             paper on screen is unaffected and "I could not ask git what has
             changed" is not something the reader can act on. The next tick
             tries again. What it must NOT do is leave a Save button claiming
             there is something to save when nothing here knows. */
        })
    }
    ask()
    const every = setInterval(ask, PROPOSAL_POLL_MS)
    const woke = () => ask()
    document.addEventListener('visibilitychange', woke)
    return () => {
      stopped = true
      clearInterval(every)
      document.removeEventListener('visibilitychange', woke)
    }
  }, [epicOnScreen, nudge])


  /**
   * Answer one suggestion.
   *
   * The door does the deciding — see the essay on `/api/proposal` — and this is
   * the wiring. What it adds is the ticket, which `post` puts on every write,
   * and that is the whole of why an agent cannot come this way: the ticket is
   * printed into this document and the MCP door has no tool that returns one.
   *
   * `busy` is a ref rather than state read here, because two presses of Accept
   * on the same suggestion inside one round trip would send two writes, and the
   * second would be refused as stale — a confusing sentence about a thing the
   * reader did not do wrong.
   */
  const deciding = useRef(false)
  const [busy, setBusy] = useState(false)

  const answerOne = useCallback(
    async (id: string, decision: 'accept' | 'reject'): Promise<Proposal[] | null> => {
      const paper = showing.current
      if (!paper || deciding.current) return null
      deciding.current = true
      setBusy(true)
      try {
        const body = await post('/api/proposal', { epic: paper.epic }, { id, decision })
        const left = Array.isArray(body.proposals) ? (body.proposals as Proposal[]) : null
        if (left) setProposals(left)
        if (body.paper) setSight({ at: 'reading', paper: body.paper as Paper })
        setSaid(body.ok === true ? String(body.said ?? '') : String(body.error ?? 'That suggestion was not answered.'))
        /*
         * The door's own answer, returned rather than only stored.
         *
         * `acceptAll` needs to know what is still waiting before it sends the
         * next one, and reading that off state would be reading it too early:
         * `setProposals` is a request to re-render, and there is no promise
         * that React has done so by the time this `await` resumes. A loop that
         * trusted the ref would send a suggestion the previous accept had
         * already dropped — which the door answers, correctly, with "there is
         * no suggestion by that name", and the reader gets a confusing sentence
         * about something they did not do. The list from the answer is the only
         * copy that is certainly current.
         */
        return left
      } catch (e) {
        setSaid(`That suggestion could not be answered: ${(e as Error).message}`)
        return null
      } finally {
        deciding.current = false
        setBusy(false)
        /* Accepting commits, so the paper has just gone from having something
           to save to having nothing — or the commit was refused and it still
           does. Either way the button is wrong until this is asked again. */
        askAgain()
      }
    },
    [askAgain],
  )

  /**
   * Accept everything waiting, oldest first.
   *
   * Sequential and not concurrent, and the order is the oldest first rather
   * than any other. Each accept re-reads the paper and rebases what is left, so
   * the second request already describes the file the first one produced —
   * which is the property that makes this safe, and the property that would be
   * destroyed by sending them all at once: two writes racing against the same
   * hash means one of them is refused as stale for no reason but the ordering
   * of two `fetch` calls.
   *
   * Oldest first because that is the order they are drawn in, and a control
   * that applied them in a different order from the one on screen would produce
   * a paper the reader cannot reconcile with what they just read.
   *
   * What is still waiting comes from the door's own answer to the previous
   * accept rather than from state, because `setProposals` is a request to
   * re-render and not a thing that has happened by the time an `await`
   * resumes. A suggestion dropped by an earlier accept — because it covered
   * the same words — must not then be sent: the door would answer "there is no
   * suggestion by that name", correctly, and the reader would be shown a
   * sentence about something they did not do.
   */
  const waiting = useRef<Proposal[]>([])
  waiting.current = proposals

  const acceptAll = useCallback(async (): Promise<void> => {
    /* A snapshot of the ids, taken once, and the SET being answered is the one
       on screen when the button was pressed — otherwise a suggestion filed by
       an agent midway through would be accepted without ever having been shown
       to anybody. */
    const asked = waiting.current.map((p) => p.id)
    let left: Proposal[] = waiting.current
    for (const id of asked) {
      if (!left.some((p) => p.id === id)) continue
      const after = await answerOne(id, 'accept')
      /* A refusal answers `null`, and the honest thing to do with it is stop.
         Whatever refused the first one — the file moved under this page, most
         likely — will refuse the rest, and pressing on would replace the
         sentence saying so with three more copies of it. */
      if (!after) return
      left = after
    }
  }, [answerOne])

  /**
   * Commit what has changed under the paper: what pressing Save does.
   *
   * ## Save does not write the file
   *
   * It cannot, because the file is already written — typing goes to
   * `/api/edit` on blur or Enter and lands in the `.tex` immediately, and that
   * is a property this module depends on rather than an oversight to be tidied
   * behind a button. The essay is on `/api/save` in `doors.ts`. So Save means
   * what it means for a document that is already on disk in a repository:
   * commit what has changed since the last commit.
   *
   * ## It says what happened, always
   *
   * Committed, nothing to commit, or the reason git refused — one sentence,
   * through the same `said` line every other answer here uses. A button that
   * writes into somebody's git history and then looks exactly as it did before
   * is the one shape this feature is not allowed to have.
   */
  const save = useCallback(async (): Promise<void> => {
    const paper = showing.current
    if (!paper || deciding.current) return
    deciding.current = true
    setBusy(true)
    try {
      const body = await post('/api/save', { epic: paper.epic })
      setSaid(String(body.said ?? body.error ?? ''))
    } catch (e) {
      setSaid(`That could not be saved: ${(e as Error).message}`)
    } finally {
      deciding.current = false
      setBusy(false)
      askAgain()
    }
  }, [askAgain])

  /**
   * Say how tall this page would like its frame to be.
   *
   * A request, not an instruction: the host clamps whatever arrives. It is
   * measured off `scrollHeight` by the caller after a paint, because a paper is
   * however long it is and a fixed height would either crop the argument or
   * leave a field of empty container under a short one.
   */
  const resize = useCallback((height: number) => host.current?.resize(height), [])

  /**
   * Say where in the document the reader is pointing.
   *
   * ## Fire and forget, and the swallowed refusal is the design
   *
   * `passage.set` is a request, and every reason it can fail is a reason a
   * reader must not be told about. A host that has not greeted this page yet
   * refuses `silent`; a host that never learned the method refuses
   * `unknown-method`; a host built against protocol 0.8 refuses it forever.
   * None of those is a fault in the paper on screen and none of them is
   * actionable by the person reading it — putting "the host would not take your
   * highlight" under a paragraph would be this container reporting somebody else's
   * missing feature as its own failure, in the space the paper goes.
   *
   * What it must not do is throw. `request` rejects with `HostRefused`, and an
   * unhandled rejection out of a mouse-up handler is a console full of red on a
   * canvas where the notes container simply is not present.
   *
   * The page loses nothing by being refused: the highlight is still on screen,
   * the popover still offers the citation to copy, and this module goes on
   * being a paper. That is the same shape as everything else here — the epic
   * list arriving added a line and its absence removed one.
   */
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
      correct,
      proposals,
      answerOne,
      acceptAll,
      busy,
      saving,
      save,
    }),
    [sight, said, resize, point, pointed, start, correct, proposals, answerOne, acceptAll, busy, saving, save],
  )
}

/**
 * Two passages, compared by value.
 *
 * Field by field rather than by `JSON.stringify`, for the reason the same
 * function in `use-published-passage.ts` gives: key order out of two different
 * construction sites is not guaranteed to match, and a comparison that silently
 * stops matching is one that stops preventing anything.
 */
function samePassage(a: Passage | null, b: Passage | null): boolean {
  if (a === null || b === null) return a === b
  return a.path === b.path && a.page === b.page && a.from === b.from && a.to === b.to && a.quoted === b.quoted
}
