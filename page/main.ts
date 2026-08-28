import type { Goto } from 'roadmap-module-protocol'

import type { Paper, PaperBrief } from '../store.ts'
import { connect, type Host } from '../wire/host.ts'
import { anchorId, paper as renderPaper, plain } from './render.ts'

/**
 * The page: what it fetches, when, and what it says when it cannot.
 *
 * `render.ts` knows about LaTeX and nothing about the wire. `wire/host.ts`
 * knows about the wire and nothing about papers. This file is the only place
 * the two meet, and it is deliberately the only one — two places deciding which
 * paper is on screen would eventually disagree, and "which paper am I looking
 * at" is the one question this app cannot afford to be confused about.
 */

const ID = 'roadmap.paper'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const where = el<HTMLElement>('where')
const picker = el<HTMLElement>('picker')
const stage = el<HTMLElement>('paper')
const said = el<HTMLElement>('said')

/**
 * Identity is printed only when nothing is framing this page.
 *
 * The host draws the module's name in the pane header and hangs the manifest's
 * `summary` off it as a tooltip. A page that also printed "Paper" at the top of
 * itself would be saying the name twice and spending a fixed strip of a
 * 340px-tall pane on the repetition. Unframed there is no pane header and
 * nothing else would ever say what this app is, so it stays.
 *
 * `window.parent !== window` is answerable before first paint, so the heading
 * never appears and then vanishes — which would be worse than either choice,
 * because a reader would learn that things on this page move on their own.
 */
const framed = window.parent !== window
if (framed) {
  el<HTMLElement>('who')?.remove()
  el<HTMLElement>('sight')?.remove()
}

/* ------------------------------------------------------------------ *
 * What this page can currently see
 * ------------------------------------------------------------------ */

type Sight =
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
  | { at: 'reading'; paper: Paper }
  /** The fetch failed in a way none of the above describes. */
  | { at: 'broke'; why: string }

let sight: Sight = framed ? { at: 'listening' } : { at: 'alone' }

/**
 * The epic the last context put this page on.
 *
 * Three values and not two: a slug, `null` for "the host says no epic is open",
 * and `undefined` for "no context has been read yet". Collapsing the last two
 * would make the first context of a conversation that names no epic look like a
 * repeat of a state the page was already in, and the screen that belongs to
 * that state would never be drawn.
 *
 * ## Every fetch on this page is keyed to this CHANGING
 *
 * The reason is a bug References, Journeys and Checklist have each hit, and it
 * is worth restating in full because the correct-looking code is the broken
 * one. `roadmap.context` used to mean "the reader moved". It does not any more:
 * it carries the canvas's selection too, so the host sends one after every
 * selection change anywhere on the canvas — including changes this pane had
 * nothing to do with, several a second while somebody drags.
 *
 * Re-fetching on each of those would throw the paper away and put the page back
 * into `asking` every time somebody clicked something in another pane. Fifteen
 * hundred words would vanish, a line would say the question was out, and the
 * text would come back a moment later having lost the reader's scroll position
 * — mid-sentence, in a document they were reading. The click that caused it
 * would look like a bug in this pane.
 *
 * So a repeated context about the same epic is a normal event, and the correct
 * response to it is to read the parts that did change — the theme — and leave
 * the reading alone. The cost, stated plainly: this page no longer refetches
 * when a host re-sends the same epic to mean "you were hidden and are visible
 * again". That was never a promise the protocol made, and the fix if it is ever
 * wanted is a context field saying so, not a fetch on every tick.
 */
let standingOn: string | null | undefined = undefined

/**
 * Which question is the current one.
 *
 * Epics switch faster than a slow disk answers, and without this the answer
 * about the previous epic arrives after the answer about this one and quietly
 * replaces it — a paper of the right length, under the right title, about the
 * wrong argument. Every answer checks it is still the one being waited for
 * before it is allowed to become the page.
 */
let asking = 0

/** Every paper on this machine. Empty until `/api/papers` has answered. */
let papers: PaperBrief[] = []

/**
 * Every epic the host will name, or null while nobody has answered.
 *
 * Three values again and the third is doing the work: a list is what the host
 * said, an empty list is a host that says there are no epics, and `null` is
 * "nobody has been asked, or nobody answered". Only the first two are facts.
 * Collapsing the last into the empty list would have this page state, in
 * writing, that every epic has a paper — on the strength of a question that was
 * never answered.
 */
let epics: { epic: string; title: string }[] | null = null

/**
 * Read one row of `epics.list` defensively.
 *
 * The protocol is explicit that a response is `unknown`: the host promised
 * nothing about this shape. A row with no usable name is not an epic this page
 * can say anything about and is left out.
 *
 * Two shapes and two spellings are accepted, and neither is indecision.
 *
 * The SHAPE, because the protocol's own note on `epics.list` gives a floor for
 * what an answer must contain and never says what wraps it. Measured against
 * the host in this workspace, the answer is `{ epics: [...] }`; a bare array is
 * the other obvious reading and costs one line to accept. A module that guessed
 * one of the two would show an empty list against half the hosts that exist
 * while being, technically, correct — and it would do so silently, because
 * `Array.isArray` on the wrong shape is `false` rather than an error. That
 * silence is the reason both are read here rather than one being insisted on.
 *
 * The SPELLING, because the protocol renamed this material from journeys to
 * epics; hosts written against the older spelling answer with rows carrying
 * `slug`, and the host measured here still does. The field is a name for the
 * same string. When no host answers `slug` any more, that clause goes.
 */
function briefs(data: unknown): { epic: string; title: string }[] {
  const rows =
    Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as { epics?: unknown }).epics)
        ? ((data as { epics: unknown[] }).epics)
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
let host: Host | null = null

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

function state(heading: string, ...paragraphs: (string | Node)[]): HTMLElement {
  const box = document.createElement('div')
  box.className = 'state'
  const h = document.createElement('h2')
  h.textContent = heading
  box.appendChild(h)
  for (const para of paragraphs) {
    const p = document.createElement('p')
    if (typeof para === 'string') p.textContent = para
    else p.appendChild(para)
    box.appendChild(p)
  }
  return box
}

/** A sentence with one `code` span in it, built rather than written as HTML. */
function withCode(before: string, code: string, after: string): Node {
  const frag = document.createDocumentFragment()
  frag.appendChild(document.createTextNode(before))
  const c = document.createElement('code')
  c.textContent = code
  frag.appendChild(c)
  frag.appendChild(document.createTextNode(after))
  return frag
}

function drawPicker(): void {
  picker.replaceChildren()
  if (!papers.length) return
  const open = sight.at === 'reading' ? sight.paper.epic : sight.at === 'asking' ? sight.epic : null
  for (const brief of papers) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = brief.title ?? brief.epic
    /* The slug on the tooltip, because the label is the paper's own title and
       two papers may reasonably title themselves similarly. Nothing here is
       truncated, so the tooltip is the only thing the title attribute is doing
       — it is not standing in for text that was cut off. */
    button.title = brief.epic
    button.setAttribute('aria-pressed', String(brief.epic === open))
    button.addEventListener('click', () => {
      void look(brief.epic, 'picked')
    })
    picker.appendChild(button)
  }

  /*
   * The gap: epics a host knows about that have no paper here.
   *
   * This is the only thing this module asks a host for and the only thing it
   * could not work out alone — a directory of papers cannot say which epics
   * exist. It is drawn last, muted, and as a sentence rather than as buttons,
   * because there is nothing to press: an epic with no paper has nothing for
   * this app to show, and a button that could only ever say so would be a way
   * to be disappointed.
   *
   * `epics === null` draws nothing at all. That is the state where the question
   * was never answered, and a page that printed "every epic has a paper" on the
   * strength of an unanswered question would be making the claim this whole
   * codebase is against.
   */
  if (epics === null) return
  const have = new Set(papers.map((p) => p.epic))
  const missing = epics.filter((e) => !have.has(e.epic))
  if (!missing.length) return
  const note = document.createElement('span')
  note.className = 'gap'
  note.textContent = `no paper yet: ${missing.map((e) => e.epic).join(', ')}`
  note.title = missing.map((e) => e.title).join('\n')
  picker.appendChild(note)
}

function draw(): void {
  where.textContent =
    sight.at === 'reading'
      ? sight.paper.epic
      : sight.at === 'asking'
        ? sight.epic
        : sight.at === 'no-paper'
          ? sight.epic
          : ''

  if (sight.at === 'reading') {
    stage.replaceChildren(renderPaper(document, sight.paper))
  } else if (sight.at === 'listening') {
    stage.replaceChildren(
      state(
        'Waiting to be greeted',
        'This page is inside a frame, so something is expected to say which epic is open. Nothing has yet.',
      ),
    )
  } else if (sight.at === 'alone') {
    stage.replaceChildren(
      state(
        'Nothing is framing this page',
        'No host is here to say which epic is open, so nothing is chosen for you. Pick a paper above and it ' +
          'will be read straight off this machine.',
      ),
    )
  } else if (sight.at === 'no-epic') {
    /*
     * `epic: null` is an ordinary state and gets an ordinary screen.
     *
     * It is not an error and must not be dressed as one. It is what the canvas
     * looks like before anybody has opened anything, and after they close what
     * they had open — a state a reader passes through several times an hour. So
     * the words say what is true and what to do, the picker stays where it was,
     * and nothing about the page suggests something has gone wrong.
     */
    stage.replaceChildren(
      state(
        'No epic is open',
        'The canvas is not on an epic, so there is no particular paper to show. Open one and its paper appears ' +
          'here.',
        papers.length
          ? `Or read any of the ${papers.length} papers on this machine from the list above.`
          : 'This machine holds no papers to offer in the meantime.',
      ),
    )
  } else if (sight.at === 'no-paper') {
    stage.replaceChildren(
      state(
        'This epic has no paper',
        `Nothing on this machine holds a paper for “${sight.epic}”. That is not a failure to read one — there ` +
          'is no folder for it, or the folder has no main.tex in it.',
        papers.length ? `${papers.length} other epics do have one; they are listed above.` : '',
      ),
    )
  } else if (sight.at === 'unconfigured') {
    stage.replaceChildren(
      state(
        'Nobody has said where the papers are',
        sight.why,
        withCode('Start it again with ', 'KEHIKKO_PAPERS_DIR=…/data/papers ./run.sh', ' and this page fills in.'),
      ),
    )
  } else if (sight.at === 'asking') {
    stage.replaceChildren(state('Reading…', `Opening the paper for “${sight.epic}”.`))
  } else {
    stage.replaceChildren(state('That paper could not be read', sight.why))
  }

  drawPicker()
  fit()
}

/**
 * Say how tall this page would like its frame to be.
 *
 * Measured off `scrollHeight` after the swap, because a paper is however long
 * it is and a fixed height would either crop the argument or leave a field of
 * empty pane under a short one. The host clamps whatever arrives; this is a
 * request and reads like one.
 */
function fit(): void {
  host?.resize(document.documentElement.scrollHeight)
}

function say(words: string): void {
  said.textContent = words
}

/* ------------------------------------------------------------------ *
 * Asking this app's own store
 * ------------------------------------------------------------------ */

/**
 * Fetches are relative, and that is load-bearing.
 *
 * `/api/paper` and not `http://127.0.0.1:7870/api/paper`. The page is served at
 * `/app` by the same process that answers these, so a relative path is a fact
 * about where this document came from; an absolute one would be this file's
 * guess about a port, and a wrong guess would be a page that works when
 * developed and not when somebody runs it on a different port.
 */
async function json(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error('that answer was not a document')
  return body as Record<string, unknown>
}

async function loadPapers(): Promise<void> {
  try {
    const body = await json('/api/papers')
    const configured = body.configured === true
    papers = Array.isArray(body.papers) ? (body.papers as PaperBrief[]) : []
    if (!configured) {
      sight = {
        at: 'unconfigured',
        why:
          'This app reads papers out of a directory named by an environment variable, and neither ' +
          'KEHIKKO_PAPERS_DIR nor KEHIKKO_ROADMAP_DIR is set for the process serving this page.',
      }
    }
    draw()
  } catch (e) {
    sight = { at: 'broke', why: `The list of papers could not be read: ${(e as Error).message}` }
    draw()
  }
}

/**
 * Ask for one epic's paper.
 *
 * Called from exactly two places — a context whose epic CHANGED, and a click on
 * the picker — and never from a context that repeated. See `standingOn`.
 */
async function look(epic: string, because: 'context' | 'picked'): Promise<void> {
  const mine = (asking += 1)
  sight = { at: 'asking', epic }
  draw()
  try {
    const body = await json(`/api/paper?epic=${encodeURIComponent(epic)}`)
    if (mine !== asking) return
    if (body.ok === true && body.paper) {
      sight = { at: 'reading', paper: body.paper as Paper }
      say(
        because === 'context'
          ? 'This is the paper for the epic the canvas is on.'
          : 'You chose this paper; the canvas is somewhere else.',
      )
      draw()
      /*
       * Back to the top, and only here.
       *
       * A new paper starts at its first sentence — anything else drops a reader
       * into the middle of an argument they have not begun. But this runs on a
       * fetch, and a fetch only happens when the epic actually changed or
       * somebody pressed a button, so a context arriving about the epic already
       * on screen leaves the scroll exactly where the reader put it. Resetting
       * on every context is the same bug as refetching on every context,
       * wearing the more innocent face of the two.
       */
      window.scrollTo(0, 0)
      return
    }
    if (body.configured === false) {
      sight = { at: 'unconfigured', why: String(body.error ?? '') }
    } else {
      sight = { at: 'no-paper', epic }
      say(`Nothing here holds a paper for ${epic}.`)
    }
    draw()
  } catch (e) {
    if (mine !== asking) return
    sight = { at: 'broke', why: `The paper for ${epic} could not be read: ${(e as Error).message}` }
    draw()
  }
}

/* ------------------------------------------------------------------ *
 * The bridge
 * ------------------------------------------------------------------ */

function theme(value: string | undefined): void {
  if (value === 'dark' || value === 'light') document.documentElement.dataset.theme = value
}

/**
 * A context, from the greeting or from a switch, handled identically.
 *
 * One function for both because they carry the same object and mean the same
 * thing: this is where the reader is standing. Handling them separately is how
 * a page ends up applying the theme on a switch and not on the greeting, which
 * is a bug that only shows up on the first paint and therefore in front of
 * somebody.
 */
function onContext(context: { epic: string | null; theme?: string }): void {
  theme(context.theme)

  if (context.epic === standingOn) {
    /* The repeat. Everything that could have changed here has been read above;
       the paper is left exactly as it is. */
    fit()
    return
  }
  standingOn = context.epic

  if (context.epic === null) {
    sight = { at: 'no-epic' }
    say('The canvas is not on an epic.')
    draw()
    return
  }
  void look(context.epic, 'context')
}

/**
 * "Go to this reference", answered by looking.
 *
 * The papers in this roadmap name work inline — `gh#111`, `!1801` — through
 * macros the parser expands, so the reference the host is asking about is
 * genuinely in the rendered text and this can answer honestly rather than
 * always saying no. The search is over the rendered text rather than the
 * source, because that is what a reader will be looking at when the page
 * scrolls: finding a match in markup nobody can see and then scrolling to a
 * paragraph with no visible reference in it would be worse than not answering.
 *
 * `answer` is called exactly once on every path, including the one where
 * nothing was found and the one where the paper is not loaded. The protocol is
 * explicit that a module which never answers must not be able to hang a
 * reference, and `wire/host.ts` has a 900ms backstop for a module that forgets
 * — this does not intend to rely on it.
 */
function onGoto(goto: Goto, answer: (found: boolean, why?: string) => void): void {
  if (sight.at !== 'reading') {
    answer(false, 'This pane is not showing a paper at the moment.')
    return
  }
  /* A walk aimed at another epic is refused rather than followed. Loading that
     epic's paper would answer `found` while moving the pane somewhere the
     canvas is not, and the host is about to send a context for wherever the
     reader really ends up — which would then be fetched, twice, one of them
     discarded. Saying no here costs a fallback link and keeps one place
     deciding what is on screen. */
  if (goto.epic && goto.epic !== sight.paper.epic) {
    answer(false, `This pane is showing the paper for ${sight.paper.epic}, not ${goto.epic}.`)
    return
  }
  /* A step number is Journeys' vocabulary. A paper has sections and no steps,
     and pretending its Nth heading is the Nth step of the epic would be an
     invented correspondence that happens to look right on short papers. */
  if (goto.step !== undefined && !goto.ref) {
    answer(false, 'A paper has sections rather than steps, so there is no step to walk to here.')
    return
  }
  const needle = (goto.ref ?? '').trim().toLowerCase()
  if (!needle) {
    answer(false, 'That reference has no text to look for.')
    return
  }
  for (const b of sight.paper.blocks) {
    const text = 'segments' in b ? plain(b.segments) : ''
    if (!text.toLowerCase().includes(needle)) continue
    const target = document.getElementById(anchorId(b.file, b.id))
    if (!target) continue
    target.scrollIntoView({ block: 'center' })
    answer(true)
    say(`${goto.ref ?? 'That reference'} is named in this paper; it is above.`)
    return
  }
  answer(false, `This paper does not name ${goto.ref ?? 'that'}.`)
}

/*
 * The connection is stored BEFORE the listener is installed, and that ordering
 * is a fixed bug rather than a style.
 *
 * The mailbox replays its backlog SYNCHRONOUSLY when a subscriber arrives, so a
 * greeting that landed before this line runs is delivered inside `connect()`,
 * before `connect()` has returned and therefore before its return value could
 * be assigned. Written the obvious way — `host = connect(...)` — the handler
 * that fires during that replay sees `host` still null, and everything it tries
 * to send goes nowhere with no error anywhere.
 *
 * In References this hung the page forever on "Asking about…": no question was
 * ever sent, so no timeout could ever fire, so the page had no way to find out
 * it was stuck. Here the symptom would be a pane that knows the epic and never
 * asks for its paper.
 *
 * So `host` is a `let` assigned from a variable the handlers close over, and
 * the assignment happens first. `connect` is called with the handlers already
 * able to see it.
 */
/**
 * Ask which epics exist, once, when somebody greets us.
 *
 * On the greeting rather than on every context, because the set of epics is not
 * a fact about where the reader is standing and re-asking it on each context
 * would be one more request per selection change — the same arithmetic that
 * makes re-fetching the paper wrong, applied to a smaller answer.
 *
 * Every failure is the same failure and is swallowed: a host that refuses the
 * capability, a host that has never heard of `epics.list`, and a host that
 * simply does not answer all leave `epics` null, and the picker then says
 * nothing about a gap rather than saying there is none.
 */
function askForEpics(): void {
  host
    ?.request('epics.list')
    .then((data) => {
      epics = briefs(data)
      drawPicker()
    })
    .catch(() => {
      /* Deliberately silent. This is enrichment; a refusal here is not
         something a reader of a paper needs to be told about, and a line
         saying so would be this page complaining about a permission it was
         never promised. */
    })
}

host = connect(ID, {
  onHello: (context) => {
    say('A host greeted this page.')
    onContext(context)
    askForEpics()
  },
  onContext,
  onGoto,
})

/*
 * The paper list is fetched immediately and unconditionally, framed or not.
 *
 * It does not depend on a greeting — it is a fact about this machine — and
 * asking for it first means the picker is populated by the time a context
 * arrives, so a `no-epic` screen can already say how many papers are available
 * instead of promising to find out.
 */
void loadPapers()

/*
 * Re-measure when the pane is resized.
 *
 * A container query changes the layout at 400px and the height changes with it;
 * a host that was told a height for the wide layout and then narrowed the pane
 * would crop the last paragraph. `ResizeObserver` on the document element
 * rather than a window `resize` listener, because inside a frame the window is
 * not what changes — the frame is.
 */
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => fit()).observe(document.documentElement)
}

draw()
