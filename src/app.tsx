import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Paper } from '../store.ts'
import { AskPopover } from './reader/ask.tsx'
import { anchorId } from './reader/blocks.tsx'
import { paginate, pageOf, visible } from './reader/pages.ts'
import { PaginatedView } from './reader/paginated.tsx'
import { pointedAt } from './reader/pointed.ts'
import { plain } from './reader/segments.tsx'
import { usePaper, type Sight } from './use-paper.ts'
import { usePublishedPassage, type Sheet } from './use-published-passage.ts'
import { useSelection } from './use-selection.ts'

/**
 * The page: one paper, and what is selected in it.
 *
 * ## One paper — the epic's — and no list of the others
 *
 * There used to be a picker here: every paper on this machine, as a row of
 * buttons, with a muted line naming the epics that had none. It is gone, and
 * the reason is what a pane IS. The canvas already says which epic the reader
 * is standing on and the host already writes this module's name in the pane
 * header; a list of eleven other papers inside that pane is an invitation to
 * leave the epic you opened, drawn in the space the paper was supposed to
 * occupy — four hundred pixels of buttons in a pane three hundred wide. Which
 * paper is on screen is a question the canvas answers.
 *
 * What is NOT gone is the honesty. There are still screens for the states this
 * module can truthfully be in — no epic open, an epic with no paper, this
 * machine not configured at all — because those are facts a reader has to be
 * told rather than an affordance for browsing.
 *
 * With nothing framing this page there is no canvas to answer the question, so
 * `?epic=…` in the address answers it instead. That is the same one fact a host
 * supplies, typed by whoever opened the page; it is not a list and cannot
 * become one.
 *
 * ## Identity is printed only when nothing is framing this page
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
const FRAMED = typeof window !== 'undefined' && window.parent !== window

export function App() {
  const { sight, said, setSaid, resize, point, pointed, goto } = usePaper(FRAMED)
  const root = useRef<HTMLElement | null>(null)
  /**
   * A walk asked for from outside, and nothing else.
   *
   * The reader's position is the SCROLL now, and the scroll belongs to the
   * element that has it. Lifting it into this component would be a second place
   * that decides where in the paper somebody is, and it would be the place that
   * loses the argument every time a context arrives. So the only thing that
   * travels down is an event: a `roadmap.goto` that found something, carrying a
   * nonce because the same reference asked for twice is two walks.
   */
  const [walk, setWalk] = useState<{ file: string; id: string; nonce: number } | null>(null)
  const selected = useSelection()
  /**
   * Which sheet is in front of the reader, lifted out of the view.
   *
   * The page number is a readout that follows the scroll and it lives in
   * `PaginatedView`, which owns the scroll. It is reported up rather than moved
   * up: `passage.page` has to say which sheet somebody is looking at, and this
   * is the only thing that knows. Kept as one object so a page turn is one
   * state change rather than two, which matters because every change of it is
   * a candidate broadcast to every pane on the canvas.
   */
  const [sheet, setSheet] = useState<Sheet>({ page: 1, file: null })
  /**
   * The range somebody else is pointing at, drawn in the paper.
   *
   * Separate state from `walk` because they are two different acts on two
   * different clocks: the walk happens once, when the passage arrives, and the
   * mark stays on the page for as long as the canvas is pointing there. Folding
   * them together would either re-scroll the reader every render or drop the
   * highlight the moment they scrolled away from it.
   */
  const [mark, setMark] = useState<{ file: string; from: number; to: number } | null>(null)
  /**
   * Whether what this pane is showing came from somebody else, untouched since.
   *
   * The loop guard, and the reason it is a piece of state rather than a
   * comparison: "did a PERSON do this" is not a property of any passage, it is
   * a property of what has happened since one arrived. See `shouldPublish`.
   */
  const [adopted, setAdopted] = useState(false)

  const paper = sight.at === 'reading' ? sight.paper : null

  /* Where the reader is pointing, told to the canvas. Everything about when and
     whether is in `use-published-passage.ts`; from here it is one line, which
     is what `use-selection.ts` predicted it would be — plus the two arguments
     that stop this module answering itself. */
  usePublishedPassage(point, paper, sheet, selected.passage, pointed, adopted)

  /**
   * A passage arriving from the canvas: turn to it, mark it, say so.
   *
   * ## Everything decided here is decided in `reader/pointed.ts`
   *
   * This effect performs; it does not judge. Which file, which block, whether
   * this paper holds the document at all — all of it is a pure function over
   * the paper and the passage, so the awkward case (a note on a chapter of
   * another epic) can be asserted without a canvas.
   *
   * ## It reuses the walk rather than scrolling for itself
   *
   * `walk` is already the one way anything outside `PaginatedView` may move the
   * reader — it is how `roadmap.goto` lands on a reference and how the sections
   * sidebar turns a page. A second scroller here would be a second answer to
   * "where is the reader", and the two would disagree the first time somebody
   * pressed a section while a passage was arriving.
   *
   * ## And it announces that the pane moved on its own
   *
   * `said` exists for exactly this: "the document moved and the reader did not
   * move it". A passage naming a document this pane does not have open goes
   * through the same line rather than doing nothing quietly — from the pane
   * that sent it, a press that silently did nothing looks like it worked.
   */
  useEffect(() => {
    const answer = pointedAt(paper, pointed)
    if (answer.at === 'nowhere') {
      setMark(null)
      setAdopted(false)
      return
    }
    if (answer.at === 'elsewhere') {
      setMark(null)
      setAdopted(false)
      setSaid(answer.said)
      return
    }
    setMark(answer.mark)
    setWalk({ file: answer.file, id: answer.id, nonce: Date.now() })
    setSaid(answer.said)
    /* Quiet from here until somebody touches the paper. Anything the pane does
       between now and then is a consequence of this passage, and saying it back
       to the canvas is the loop. */
    setAdopted(true)
  }, [paper, pointed, setSaid])

  /**
   * The first thing a person does to the paper takes the pane off mute.
   *
   * Four gestures, and they are the four ways somebody moves or points at a
   * document: the pointer, the wheel, a key, and a finished selection. Any one
   * of them means the next passage this module composes is about where THEY
   * are, which is news and is worth broadcasting.
   *
   * On the window rather than on the reading column, because a reader who
   * presses the sections trigger and then an arrow key has moved the paper
   * without the column ever having been touched. Passive and capturing, so
   * nothing here can interfere with what the gesture was for.
   */
  useEffect(() => {
    if (!adopted) return
    const woke = () => setAdopted(false)
    const kinds = ['pointerdown', 'wheel', 'keydown'] as const
    for (const kind of kinds) window.addEventListener(kind, woke, { passive: true, capture: true })
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, woke, { capture: true })
    }
  }, [adopted])

  /*
   * A different paper drops the selection with it.
   *
   * Keyed on the epic rather than on the object, because `sight` is replaced by
   * every state transition and a reset keyed on identity would fire when the
   * same paper came back. This is the second half of the promise `use-paper.ts`
   * makes about not refetching on a repeated context: a fetch that does not
   * happen cannot move the reader, and neither can a reset that does not fire.
   * Where the reader is in the paper is the scroll column's own business — see
   * the note beside it in `paginated.tsx`.
   */
  const epic = paper?.epic ?? null
  const wasOn = useRef<string | null>(null)
  const forget = selected.forget
  useLayoutEffect(() => {
    if (wasOn.current === epic) return
    wasOn.current = epic
    forget()
  }, [epic, forget])

  /*
   * Re-measure when the pane is resized, and after every paint that could have
   * changed the height.
   *
   * `ResizeObserver` on the document element rather than a window `resize`
   * listener, because inside a frame the window is not what changes — the frame
   * is. The host clamps whatever height arrives.
   */
  useEffect(() => {
    const tell = () => resize(document.documentElement.scrollHeight)
    tell()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(tell)
    ro.observe(document.documentElement)
    return () => ro.disconnect()
  }, [resize, sight])

  /**
   * "Go to this reference", answered by looking.
   *
   * The papers in this roadmap name work inline — `gh#111`, `!1801` — through
   * macros the parser expands, so the reference the host asks about is
   * genuinely in the rendered text and this can answer honestly rather than
   * always saying no. The search is over the rendered text rather than the
   * source, because that is what a reader will be looking at when the page
   * turns: finding a match in markup nobody can see and then landing on a
   * paragraph with no visible reference in it would be worse than not
   * answering.
   *
   * `answer` is called exactly once on every path, including the one where
   * nothing was found and the one where no paper is loaded. `wire/host.ts` has
   * a backstop for a module that forgets; this does not intend to rely on it,
   * and there is a test for the contract.
   */
  useEffect(() => {
    goto.current = (message, answer) => {
      if (!paper) {
        answer(false, 'This pane is not showing a paper at the moment.')
        return
      }
      /* A walk aimed at another epic is refused rather than followed. Loading
         that epic's paper would answer `found` while moving the pane somewhere
         the canvas is not, and the host is about to send a context for wherever
         the reader really ends up — which would then be fetched, twice, one of
         them discarded. Saying no costs a fallback link and keeps one place
         deciding what is on screen. */
      if (message.epic && message.epic !== paper.epic) {
        answer(false, `This pane is showing the paper for ${paper.epic}, not ${message.epic}.`)
        return
      }
      /* A step number is Journeys' vocabulary. A paper has sections and no
         steps, and pretending its Nth heading is the Nth step of the epic would
         be an invented correspondence that happens to look right on short
         papers. */
      if (message.step !== undefined && !message.ref) {
        answer(false, 'A paper has sections rather than steps, so there is no step to walk to here.')
        return
      }
      const needle = (message.ref ?? '').trim().toLowerCase()
      if (!needle) {
        answer(false, 'That reference has no text to look for.')
        return
      }
      const pages = paginate(paper.blocks)
      for (const block of paper.blocks.filter(visible)) {
        const text = textOf(block)
        if (!text.toLowerCase().includes(needle)) continue
        const at = pageOf(pages, block.file, block.id)
        if (at < 0) continue
        /* Nothing is virtualised, so the block is in the DOM wherever it is in
           the paper and the view can simply scroll to it. */
        setWalk({ file: block.file, id: block.id, nonce: Date.now() })
        answer(true)
        /* Said out loud, because this is the one case where the document moved
           and the reader did not move it. */
        setSaid(`${message.ref ?? 'That reference'} is named in this paper, on page ${at + 1}.`)
        return
      }
      answer(false, `This paper does not name ${message.ref ?? 'that'}.`)
    }
  }, [paper, goto, setSaid])

  /** Which file each block came from, for a citation to be able to name one. */
  const filesByAnchor = useMemo(() => {
    const map = new Map<string, string>()
    for (const block of paper?.blocks ?? []) map.set(anchorId(block.file, block.id), block.file)
    return map
  }, [paper])

  /**
   * One scroll, and nothing around the paper with a size of its own.
   *
   * ## What was here, and what it cost
   *
   * `mx-auto max-w-[80rem] … pb-10`, with a reading column of a fixed height
   * inside it. Three things were wrong and they compounded:
   *
   * - **Two scrolls.** The reading column has an explicit height and scrolls
   *   internally. Its parent is a flex COLUMN, where a child's `min-height`
   *   resolves to `auto` — its content — so the column's 672px was overridden
   *   upward to the height of every sheet stacked: measured at 23,383px, inside
   *   a page 23,467px tall. The document scrolled twenty-three thousand pixels
   *   of nothing while the pages scrolled inside it. `min-h-0` is the fix and
   *   it is the whole fix; the flex sizing below is so the column can then FILL
   *   the pane instead of guessing at it with `calc(100dvh - 8rem)`.
   * - **A box drawn around the paper.** `max-w-[80rem] mx-auto` centred the
   *   reader at 1280px, and the sheet inside it is already a fixed A4 page
   *   centred by its own arithmetic in `SheetPage`. Two things centring one
   *   thing is how a container appears inside a container, which is what the
   *   user saw and said so.
   * - **A 40-pixel dead strip** under everything, which is most of what read as
   *   a footer. It grew visually when the sections panel opened, because a
   *   narrower column scales the sheet down and leaves more empty pane around
   *   it — the strip did not widen, the paper shrank.
   *
   * ## `h-dvh`, and the number this module reports
   *
   * `resize()` sends `document.documentElement.scrollHeight`. Before this, that
   * was twenty-three thousand pixels — a module asking its host for a pane
   * taller than the screen, clamped by the host and therefore invisible, which
   * is the only reason it was survivable. There is a measured history here of a
   * pane that DID grow that way, to 2552px, pushing its own resize handle off
   * the canvas where nothing could reach it.
   *
   * With the page exactly the height of the frame it is in, the number reported
   * is the pane's own height and the request is a no-op: the module asks to be
   * the size it already is. That is the honest reading for a document reader —
   * it is however tall the reader made it, and it scrolls.
   */
  return (
    <div className="flex h-dvh min-h-0 flex-col px-3 pt-3 pb-2">
      {!FRAMED && <h1 className="mb-2 shrink-0 text-base font-semibold tracking-tight">Paper</h1>}

      {/* A finished drag over the pages becomes a citable source range. */}
      <div className="flex min-h-0 flex-1 flex-col" onMouseUp={() => selected.read(root.current, filesByAnchor)}>
        {paper ? (
          <PaginatedView paper={paper} walk={walk} mark={mark} rootRef={root} onSheet={setSheet} />
        ) : (
          <Screen sight={sight} />
        )}
      </div>

      {selected.passage && paper && (
        <AskPopover passage={selected.passage} epic={paper.epic} onDismiss={selected.dismiss} />
      )}

      {/*
        Kept for one job: answering a `roadmap.goto` out loud. It is the only
        thing a reader could not otherwise see happening — the page turned and
        they did not turn it. It no longer narrates the ordinary case: a line
        saying "this is the paper for the epic the canvas is on" told a reader
        what the canvas and the pane header had both already told them, in the
        space where the paper goes.
      */}
      {said && (
        <p className="mt-2 shrink-0 text-[0.8rem] text-muted-foreground" aria-live="polite">
          {said}
        </p>
      )}
    </div>
  )
}

function textOf(block: Paper['blocks'][number]): string {
  if (block.kind === 'heading' || block.kind === 'paragraph') return plain(block.segments)
  if (block.kind === 'list') return block.items.map(plain).join(' ')
  if (block.kind === 'figure' || block.kind === 'table') return plain(block.caption)
  if (block.kind === 'comment') return block.text
  if (block.kind === 'verbatim' || block.kind === 'unknown') return block.raw
  if (block.kind === 'equation') return block.latex
  return ''
}

/**
 * Everything this page says when it is not showing a paper.
 *
 * One shape, because the states differ in their words and not in their kind,
 * and a state that looked different would read as a different kind of event.
 * `no-epic` in particular is an ordinary state and must not be dressed as an
 * error: it is what the canvas looks like before anybody has opened anything,
 * and after they close what they had open — a state a reader passes through
 * several times an hour.
 */
export function Screen({ sight }: { sight: Sight }) {
  const [heading, ...lines] = wordsFor(sight)
  return (
    <div className="rounded-md border bg-card p-3 text-[0.85rem] leading-relaxed">
      <h2 className="mb-1 text-[0.95rem] font-semibold text-card-foreground">{heading}</h2>
      {lines.filter(Boolean).map((line, i) => (
        <p key={i} className="mb-1.5 text-muted-foreground last:mb-0">
          {line}
        </p>
      ))}
    </div>
  )
}

export function wordsFor(sight: Sight): string[] {
  switch (sight.at) {
    case 'listening':
      return [
        'Waiting to be greeted',
        'This page is inside a frame, so something is expected to say which epic is open. Nothing has yet.',
      ]
    case 'alone':
      return [
        'Nothing is framing this page',
        'No host is here to say which epic is open. Put ?epic=… in the address and that epic’s paper is read ' +
          'straight off this machine.',
      ]
    case 'no-epic':
      return [
        'No epic is open',
        'The canvas is not on an epic, so there is no particular paper to show. Open one and its paper appears here.',
      ]
    case 'no-paper':
      return [
        'This epic has no paper',
        `Nothing on this machine holds a paper for “${sight.epic}”. That is not a failure to read one — there is no ` +
          'folder for it, or the folder has no main.tex in it.',
      ]
    case 'unconfigured':
      return [
        'Nobody has said where the papers are',
        sight.why,
        'Start it again with KEHIKKO_PAPERS_DIR=…/data/papers ./run.sh and this page fills in. For a ' +
          'single document with its own main.tex — a thesis rather than a roadmap — KEHIKKO_THESIS_DIR=… ' +
          'names it instead, or as well.',
      ]
    case 'asking':
      return ['Reading…', `Opening the paper for “${sight.epic}”.`]
    default:
      return ['That paper could not be read', sight.at === 'broke' ? sight.why : '']
  }
}
