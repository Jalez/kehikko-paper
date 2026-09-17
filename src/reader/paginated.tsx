import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Paper, PlacedBlock } from '../../store.ts'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Label } from '@/components/ui/label.tsx'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar.tsx'
import type { Proposal } from '../../latex/propose.ts'
import type { Standing } from '../../git.ts'
import { Reading } from './anchor.ts'
import { BlockRow, anchorId, covers, type Pen } from './blocks.tsx'
import { Anchoring, NO_PROPOSALS, ProposalControls, anchorStore, nearestProposal, type Answering } from './proposed.tsx'
import { PAGE, pageOf, paginate } from './pages.ts'

/**
 * The reading view: every page of the paper, at A4, in one scrolling column.
 *
 * ## Scrolling, the way every document reader scrolls
 *
 * There were next and previous buttons here and a page number that was a
 * control. They are gone. A paper is a document, and the interaction a reader
 * already has for a document — in Word, in Preview, in every PDF viewer in a
 * browser — is to scroll, with the boundary between one sheet and the next
 * visible as they pass it. Turning pages by pressing a button was a thing this
 * container asked a reader to learn for no benefit they were getting.
 *
 * So the page number is now a READOUT. It follows the scroll and cannot be
 * pressed, because a number that looks pressable and is not is worse than no
 * number at all.
 *
 * ## A whole page, not as much of one as fits
 *
 * The sheet is drawn at its real size, 794×1123 CSS pixels of A4, and the whole
 * thing is scaled with one `transform: scale` until it fits the column's width.
 * Every proportion inside it is therefore fixed: the measure is always the same
 * number of characters, the margins are always the same fraction of the sheet,
 * and a figure is always the same share of the page. Only the apparent size
 * changes.
 *
 * The cost is real and is not hidden: in a 220-pixel container the scale is about
 * 0.28 and the body type draws at four pixels. That is a thumbnail of a page
 * rather than something to read a sentence off, and it is what "show the whole
 * A4 page" means at that width. The alternative — clamping the scale — would
 * put half the sheet behind the edge of a container and make a reader drag sideways
 * to find it, which `index.css` has an essay about refusing.
 *
 * ## Everything is rendered; nothing is virtualised
 *
 * Every PDF viewer virtualises, and the temptation here was strong: the thesis
 * on this machine is fifteen thousand words and thirty-odd A4 pages, all in the
 * DOM at once. It is not done, and the reason is that virtualisation trades
 * correctness for a cost that was measured and found not to be there.
 *
 * What it would break: `scrollIntoView` on a page that is not rendered does
 * nothing, so a `roadmap.goto` at the end of the paper would silently fail; the
 * browser's own find-in-page cannot see what is not in the DOM, which is how
 * people actually search a document; and a highlight or a note anchored to page
 * 30 could not be resolved. Those are three real losses against a first paint
 * that was measured in the tens of milliseconds on the real thesis. If a corpus
 * ever arrives that makes this slow, virtualise then — and read this paragraph
 * first, because each of those three needs an answer, not a note.
 *
 * ## The scale is measured; nothing that decides the CONTENT is
 *
 * One `ResizeObserver`, on the scroll column, reading its width. The sheets'
 * own heights are measured once per paper — a fixed-width box's height depends
 * on what is in it and not on how big it is drawn — so the scaled boxes can
 * reserve the right room in the layout. Neither can feed back: pagination is a
 * pure function of the block list and of `PAGE` (see `pages.ts`), so which
 * blocks are on which sheet was settled before either measurement ran. A
 * measuring pass that cannot change its own input is a measuring pass that
 * cannot oscillate.
 *
 * That matters more with a scroll than it did with a page turn. Page
 * boundaries that moved when somebody dragged a container edge would move the
 * reader's position under them, for a reason they did not cause and could not
 * point at.
 */

/**
 * Air between one sheet and the next, in the PAGE's own units.
 *
 * It was 14 and it was in SCREEN pixels, which made it the one thing in this
 * view that did not shrink with the container — and therefore the one thing
 * that grew, visually, every time somebody made the container narrower. The
 * wrapper's height is already `sheetHeight * scale`, so the gap's share of a
 * page was measured at:
 *
 *   1100px container  scale 1.000  page 1123px  gap 14px  = 1.25% of a page
 *    460px container  scale 0.549  page  617px  gap 14px  = 2.27%
 *    220px container  scale 0.247  page  278px  gap 14px  = 5.04%
 *
 * Four times the separation at the width where the pages are smallest and most
 * need to read as one document. That is what turned a stack of sheets into a
 * list of cards, and it is what the owner was looking at when they said there
 * was "quite a bit of space between the A4s".
 *
 * So it is a page-relative quantity now, scaled with everything else, and
 * smaller: ten page-pixels is a little under one per cent of A4, which is about
 * what a PDF viewer leaves between two sheets. `MIN_GAP` is a screen-pixel
 * floor, because below about three pixels the shadow under one sheet touches
 * the edge of the next and two pages read as one long one — and "show whole A4
 * pages" is not much use if a reader cannot see where one ends.
 */
const GAP = 10
/** The gap never closes below this many real pixels, however small the scale. */
const MIN_GAP = 3

export interface PaginatedProps {
  paper: Paper
  /**
   * A place to scroll to, from outside — the answer to a `roadmap.goto`.
   *
   * `nonce` rather than value equality, because the same reference asked for
   * twice is two walks and the second one has to move the page as well. It is
   * the only way anything outside this component may move the reader.
   */
  walk: { file: string; id: string; nonce: number } | null
  /**
   * A range of one file to draw as marked, or null.
   *
   * Threaded down as a prop rather than applied to the DOM by an effect, and
   * that is the same argument the rest of this file makes about measuring: a
   * pass that reached into the rendered spans and set a class would have to
   * find them again to take it off, and would fight React for the attribute
   * every time a page re-rendered. Passed down, the mark is part of what a
   * segment IS, and a segment that stops being marked stops being marked.
   *
   * It is per FILE as well as per range, because block offsets are per file: a
   * paper is `main.tex` plus its chapters, and bytes 4120–4380 exist in every
   * one of them.
   */
  mark: { file: string; id: string; from: number; to: number } | null
  /**
   * The element every rendered page lives in, handed up so `lib/selection.ts`
   * can resolve a highlight against it. The view owns the element; the app owns
   * what is done with it. It is the scroll column and not one sheet, because a
   * selection can now legitimately run from the bottom of one page to the top
   * of the next.
   */
  rootRef: React.RefObject<HTMLElement | null>
  /**
   * Which sheet is in front of the reader, reported outward.
   *
   * The page number is this component's, because the scroll is, and it is not
   * moved out — see the note on the readout below, which has survived one
   * attempt to lift it already. It is REPORTED because `passage.page` has to
   * say which sheet somebody is looking at and nothing above here knows.
   *
   * The file is reported with it rather than derived above, and for the reason
   * everything else in this file is measured rather than assumed: which file a
   * sheet started in is a property of the packing, and the packing is here.
   */
  onSheet?: (sheet: { page: number; file: string | null }) => void
  /**
   * What a finished edit does, or `null` for a paper that is only read.
   *
   * Null is the default state and the one this module spent its life in: no
   * span is `contentEditable`, nothing carries `data-editable`, and every
   * gesture over the prose still means what it meant — a drag makes a passage,
   * a press moves nothing. Editing is a mode a reader turns on, and the reason
   * it is a mode rather than always available is one sentence long: a document
   * you can change by leaning on the keyboard is a document you cannot read
   * over somebody's shoulder.
   */
  pen?: Pen | null
  /** Turn typing on or off. Drawn as the one control beside the page readout. */
  onPen?: (on: boolean) => void
  /** Every change suggested about this paper that nobody has answered yet. */
  proposals?: readonly Proposal[]
  /** How to answer one, or `null` for a view that only shows them. */
  answering?: Answering | null
  /**
   * Whether a suggestion applies the moment it arrives, and how to change that.
   *
   * `undefined` for `onAuto` means the control is not drawn at all, which is
   * what a caller that has not wired the write path gets \u2014 the same rule `onPen`
   * already follows. `auto` is the state of the tick and is false by default,
   * because a document that rewrites itself while somebody is reading it is a
   * document nobody can leave open beside their work.
   */
  auto?: boolean
  onAuto?: (on: boolean) => void
  /**
   * What committing this paper would do right now, or `null` for a view that
   * does not offer to.
   *
   * Threaded in rather than asked for here, because it is a fact about a git
   * repository and this component knows about LaTeX and a scroll column. The
   * same rule the rest of this file keeps: `reader/` knows nothing about the
   * wire, and `use-paper.ts` is the one place the two meet.
   */
  saving?: Standing | null
  /** Commit what has changed. `undefined` means the Save control is not drawn. */
  onSave?: () => void
}

const CAVEAT = 'Page breaks are this reader\u2019s, not the PDF\u2019s.'

/**
 * The three rules the chrome row's controls carry, as `title` and nothing else.
 *
 * They are constants and not inline strings for one reason: they moved from the
 * control to the wrapper around it when the ticks became Radix buttons, and a
 * four-line string in the middle of JSX that is now attached to a `<span>` is
 * the kind of thing a later edit quietly attaches to the wrong element. Named,
 * they are read once and referred to.
 *
 * A `title` rather than a line of prose under the row, for the reason the
 * page-break caveat became one: a permanent strip of explanation across a
 * 340px container is height taken from the paper forever.
 */
const EDIT_RULE =
  'Type corrections straight into the prose. Only text that is character-for-character what the .tex file '
  + 'says can be typed into \u2014 a citation or a macro shows as what this reader makes of it, so there is no place '
  + 'in the file for a cursor inside it. Enter commits, Escape puts it back, and LaTeX markup is refused rather '
  + 'than escaped. Typing is written to the file straight away; press Save to commit it.'

const AUTO_RULE =
  'Apply a suggested change as soon as it arrives, instead of showing it for approval. Off by default. With it '
  + 'off, a change is drawn into the prose in green and red where it happens and nothing is written until you '
  + 'press Accept. With it on, the change is written straight away, the paper is re-read, and the change is '
  + 'committed \u2014 the same as if you had pressed Accept yourself.'

export function PaginatedView({
  paper,
  walk,
  mark,
  rootRef,
  onSheet,
  pen = null,
  onPen,
  proposals = NO_PROPOSALS,
  answering = null,
  auto = false,
  onAuto,
  saving = null,
  onSave,
}: PaginatedProps) {
  const pages = useMemo(() => paginate(paper.blocks), [paper.blocks])
  const count = Math.max(1, pages.length)

  /**
   * A number that changes when the paper is REPLACED, used to rebuild the
   * sheets from scratch.
   *
   * ## The bug this exists to prevent, which only a browser can produce
   *
   * A `contenteditable` span is a subtree the browser is allowed to rearrange.
   * Typing into one routinely splits its text node in two; a paste can leave
   * three. React does not see any of that — it remembers the node it created
   * and, when the text changes, writes the new value into that node. If the
   * browser has since split it, the remembered half is updated and the other
   * half is left standing, so a corrected sentence draws with a fragment of the
   * old one still in it. The FILE is right; the page is not, which is the worst
   * combination available here, because the reader has no reason to doubt it.
   *
   * A key that changes discards those elements instead of patching them, and
   * the paper's identity is exactly the right trigger: it is replaced when a
   * write lands, when a stale write is refused, and when a new epic arrives —
   * the three moments the DOM must stop being trusted — and never on a scroll,
   * a resize, or a re-sent context.
   *
   * The reader does not move for it. The scroll lives on the column, which is
   * not keyed and is not rebuilt, and each page's box keeps the height it was
   * measured at because `heights` is state on this component rather than a
   * property of the elements being replaced.
   */
  const revision = useRef(0)
  const wasPaper = useRef<Paper | null>(null)
  if (wasPaper.current !== paper) {
    wasPaper.current = paper
    revision.current += 1
  }

  const column = useRef<HTMLDivElement | null>(null)
  const wraps = useRef<(HTMLDivElement | null)[]>([])
  const sheets = useRef<(HTMLElement | null)[]>([])

  const [room, setRoom] = useState<number>(PAGE.width)
  /** Each sheet's natural height. `PAGE.height` unless a block ran over. */
  const [heights, setHeights] = useState<number[]>([])
  /** Which page the reader is looking at. A readout, never a control. */
  const [at, setAt] = useState(0)

  const scale = room > 0 ? Math.min(1, room / PAGE.width) : 1
  /* In screen pixels, from a page-relative constant — see the essay on `GAP`. */
  const gap = Math.max(MIN_GAP, Math.round(GAP * scale))

  /**
   * Which sheet the reader is on, told to whoever asked.
   *
   * In an effect keyed on the page rather than inside the scroll handler,
   * because `setAt` already refuses to change when the page has not, so this
   * runs once per page TURN rather than once per animation frame. The consumer
   * of this is a broadcast to every container on the canvas — see
   * `use-published-passage.ts` — and a callback fired sixty times a second
   * would put the debounce there in charge of a problem that is cheaper to not
   * create.
   *
   * `onSheet` through a ref so a parent passing an inline arrow does not make
   * this fire on every render of the parent.
   */
  const told = useRef(onSheet)
  told.current = onSheet
  const file = pages[at]?.[0]?.file ?? null
  useEffect(() => {
    told.current?.({ page: at + 1, file })
  }, [at, file])

  /*
   * The column, kept in STATE as well as in the ref, and only for the controls.
   *
   * Everything else here reads the column inside an effect or a handler, where
   * a ref is the right tool and a render is not wanted. The controls are the
   * exception: they measure against the column in their own layout effect, so
   * the element has to be a value that changes when it arrives — a ref is
   * still `null` on the pass that mounts them, and an effect keyed on a ref
   * would never run again. Once, on mount, and never again.
   */
  const [columnEl, setColumnEl] = useState<HTMLDivElement | null>(null)

  /*
   * Where every drawn change landed, and where each control goes.
   *
   * The store is made once per view and handed down as context, so every
   * `Change` in every sheet reports into the same map — see `Anchoring` in
   * `proposed.tsx` for why it is a store and not state. `laidOut` is an
   * identity that changes whenever the sheets have been laid out again: a new
   * paper, a new scale, a sheet that grew, a column that was dragged. The
   * controls re-measure on it and on nothing else React knows about; the two
   * things React does not know about — an image loading, a font arriving — the
   * controls listen for themselves.
   *
   * `fallback` finds the block a suggestion is about when the prose could not
   * draw it, by the same rule the block uses to claim it, so the control lands
   * on the paragraph it would have been drawn in.
   */
  const [anchors] = useState(anchorStore)
  const laidOut = useMemo(() => ({}), [paper, scale, heights, room])
  const fallback = useCallback(
    (p: Proposal): HTMLElement | null => {
      const block = paper.blocks.find((b) => covers(b, p))
      if (!block || !column.current) return null
      return column.current.querySelector<HTMLElement>(`[data-block-id="${anchorId(block.file, block.id)}"]`)
    },
    [paper],
  )

  const hold = useCallback(
    (el: HTMLDivElement | null) => {
      column.current = el
      rootRef.current = el
      setColumnEl(el)
    },
    [rootRef],
  )

  /*
   * The waiting suggestions, in the order a reader MEETS them.
   *
   * Sorted here and once, so that everything downstream counts from the same
   * list: the chrome row's total, and the `x of y` beside each control's
   * buttons, are the length and the index of this array. Two numbers derived
   * from one list cannot disagree, which is the whole reason the sort is here
   * rather than in the control.
   *
   * By the paper's own file order and then by byte offset — `paper.files` is
   * the order the document is assembled in, so this is document order and not
   * alphabetical order, which for `chapters/10-x.tex` before `chapters/2-y.tex`
   * would be neither.
   *
   * It is NOT the order `Accept all` writes in, which is oldest-filed first and
   * belongs to the write path — see `acceptAll` in `use-paper.ts`, which reads
   * its own ref and is untouched by anything here. Nothing on screen prints
   * that order, so there is no second numbering for this one to contradict.
   */
  const inOrder = useMemo<readonly Proposal[]>(() => {
    if (proposals.length < 2) return proposals
    const rank = new Map(paper.files.map((f, i) => [f, i]))
    return [...proposals].sort(
      (a, b) =>
        (rank.get(a.file) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.file) ?? Number.MAX_SAFE_INTEGER) ||
        a.from - b.from ||
        /* A tie-break that is total, so the ordinals do not shuffle between two
           renders of the same list. Two suggestions at the same offset happen:
           the door files them independently and only accepting one drops the
           other. */
        a.at - b.at ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
  }, [proposals, paper.files])

  /* How much width there is. Observed rather than read once, because the container
     is dragged and because a frame's window is not what changes when it is. */
  useLayoutEffect(() => {
    const el = column.current
    if (!el) return
    const read = () => setRoom((was) => (Math.abs(was - el.clientWidth) < 0.5 ? was : el.clientWidth))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /*
   * How tall each sheet actually came out.
   *
   * `PAGE.height` unless a block ran over it — see the note in `paginate`. The
   * transform takes these elements out of the layout's height calculation, so
   * without this every page would be drawn on top of the last.
   *
   * Observed rather than measured once, and the reason is a figure: an `<img>`
   * is `loading="lazy"`, so a sheet with a picture on it is short until the
   * reader scrolls near it and then grows. Measured once, that growth would be
   * clipped by the `overflow: hidden` on the box below — silently, with the
   * bottom of somebody's argument behind an edge. Measured on every change, the
   * box grows with it.
   *
   * It cannot feed back into pagination, which is a pure function of the block
   * list and of `PAGE` (see `pages.ts`): a sheet is 794 pixels wide whatever
   * the container is doing, so nothing measured here can change what is on it.
   */
  useLayoutEffect(() => {
    const read = () => {
      const found = sheets.current.slice(0, count).map((el) => Math.max(PAGE.height, el?.offsetHeight ?? 0))
      setHeights((was) => (was.length === found.length && was.every((h, i) => h === found[i]) ? was : found))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    for (const el of sheets.current.slice(0, count)) if (el) ro.observe(el)
    return () => ro.disconnect()
  }, [paper, count])

  /*
   * The readout follows the scroll.
   *
   * The page a reader is ON is the one occupying the top third of the column —
   * not the one under the exact top edge, because a sheet's last line is still
   * being read while its successor's first line has come into view. Coalesced
   * into a frame, because a scroll fires many times a second and this only ever
   * changes a number.
   */
  useEffect(() => {
    const el = column.current
    if (!el) return
    let queued = 0
    const look = () => {
      queued = 0
      const line = el.scrollTop + el.clientHeight * 0.35
      let now = 0
      for (let i = 0; i < count; i++) {
        const box = wraps.current[i]
        /* A box with no height has not been laid out — the first frame, or a
           document with no layout at all, which is what the tests run in. It
           cannot be the page somebody is looking at, and treating it as one
           would make the readout say the LAST page before anything is on
           screen, because every unlaid-out box shares a top of zero. */
        if (!box || box.offsetHeight <= 0) continue
        if (box.offsetTop > line) break
        now = i
      }
      setAt((was) => (was === now ? was : now))
    }
    const onScroll = () => {
      if (queued) return
      queued = requestAnimationFrame(look)
    }
    look()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (queued) cancelAnimationFrame(queued)
    }
  }, [count, heights, scale])

  /*
   * A different paper starts at the top; the same paper does not move.
   *
   * Keyed on the epic rather than on the object, because a re-sent context can
   * hand back the same paper and a reset keyed on identity would throw a reader
   * on page 20 back to page 1 every time somebody clicked in another container. That
   * is the property the fetch in `use-paper.ts` protects one layer up, kept in
   * the one other place it could be broken — and it matters more now that the
   * scroll IS the navigation.
   */
  const epic = paper.epic
  useLayoutEffect(() => {
    column.current?.scrollTo({ top: 0 })
    setAt(0)
  }, [epic])

  /*
   * A walk from outside: scroll to the block, wherever in the document it is.
   * Nothing is virtualised, so the element is always in the DOM to scroll to —
   * see the note above about what virtualising would cost.
   *
   * ## `nearest`, and it used to be `center`
   *
   * `center` moves the page every single time, including when the block asked
   * for is already in front of the reader, and the movement it makes is the
   * largest one that lands on the target. That is the wrong default for a
   * document: scrolling is the reader's, and a page that shifts under somebody
   * who can already see what they are being shown has taken their place away
   * for nothing they can perceive.
   *
   * `nearest` is the standard expression of "only if it is needed, and then as
   * little as possible": nothing at all when the block is on screen, and
   * otherwise the smallest scroll that brings it to an edge. What is lost is
   * the tidiness of a target that always lands mid-column, which was never
   * worth what it cost — and where the block is genuinely off screen the reader
   * arrives at it against a full column of the pages either side of it, which
   * is the same argument `turnTo` below makes for a real scroll over a jump.
   *
   * It also makes a repeated walk harmless. `walk` is fired on a nonce, so a
   * passage re-sent unchanged is a second walk; under `center` that was a
   * second lurch, and under `nearest` it is nothing, because the block it names
   * has not moved since the first one put it on screen.
   *
   * The reported jump this was found next to was NOT this line — see
   * `reader/pointed.ts` for the echo that was setting the walk in the first
   * place. This is the second half: even a walk somebody really did ask for
   * should not move a reader who can already see where they are going.
   */
  const nonce = walk?.nonce
  useEffect(() => {
    if (!walk) return
    document.getElementById(anchorId(walk.file, walk.id))?.scrollIntoView({ block: 'nearest' })
    /* `walk` is deliberately not a dependency: a walk is an event and the nonce
       is what says a new one happened. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  /**
   * Keys reach the column even when nothing in it has focus.
   *
   * The column is `tabIndex=0`, so a reader who tabs or clicks into it gets
   * PageUp, PageDown, Home, End and the arrows for free from the browser. That
   * leaves the case where the container has focus but the column does not — the
   * reader has just pressed the sections trigger, say — where those keys would
   * do nothing at all until somebody clicked the text. So they are forwarded.
   *
   * Skipped whenever the event came out of a field or a control that has its
   * own meaning for the key, so this cannot quietly steal one from something
   * that needed it, and skipped when the column already has focus, so a key is
   * never acted on twice.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = column.current
      if (!el || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (target === el || el.contains(target)) return
      const step = el.clientHeight * 0.9
      const by: Record<string, () => void> = {
        PageDown: () => el.scrollBy({ top: step }),
        PageUp: () => el.scrollBy({ top: -step }),
        ArrowDown: () => el.scrollBy({ top: 80 }),
        ArrowUp: () => el.scrollBy({ top: -80 }),
        Home: () => el.scrollTo({ top: 0 }),
        End: () => el.scrollTo({ top: el.scrollHeight }),
      }
      const move = by[event.key]
      if (!move) return
      event.preventDefault()
      move()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const turnTo = useCallback((index: number) => {
    /* A real scroll, and smooth, so the reader sees where they landed relative
       to the pages either side of it. A jump to an arbitrary offset in a
       document is the thing that loses somebody their place. */
    wraps.current[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [])

  return (
    <SidebarProvider className="min-h-0 w-full flex-1">
      <Sections paper={paper} pages={pages} at={at} onGo={turnTo} />

      <SidebarInset className="min-h-0 gap-2">
        {/* The sections trigger and the page readout, on one row, because a
            container cannot spare a strip of its own for chrome. */}
        {/* `flex-wrap`, because at 220 pixels with the sections open the column
            beside them is under a hundred wide and a row that would not wrap
            pushes the whole document sideways — measured, at 18px of horizontal
            scroll, which is the one thing this container must never do. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <SidebarTrigger />
          <span className="min-w-0 text-[0.7rem] text-muted-foreground">
            {paper.outline.length} {paper.outline.length === 1 ? 'section' : 'sections'}
          </span>
          {/*
            The one control that turns the paper into something typeable.

            A checkbox and not a button, because it has a state somebody has to
            be able to see rather than an action: "am I editing this document"
            is exactly the question a control that toggled silently would leave
            open. It is drawn only when there is somewhere for an edit to go —
            `onPen` absent means the page did not offer one — so the reading
            view in a test, or in any caller that has not wired the write, is
            the reading view unchanged.

            No icon and no label longer than a word. At 220 pixels this row
            already wraps.

            ## It is shadcn's checkbox now, and the native one was a real gap

            It used to be `<input type="checkbox" class="accent-[var(--mark)]">`,
            which draws the OPERATING SYSTEM's checkbox with one colour changed.
            That made these two ticks the only controls on the page that did not
            belong to the canvas they sit on: the box, the tick inside it, the
            focus ring, the dark-mode treatment and the disabled state were all
            the browser's opinion, and `accent-color` is the entire extent of
            what a stylesheet may say about them. Everything else in this row —
            the sidebar trigger, the badge, Accept all — is shadcn, and the two
            controls that decide whether this page may change somebody's thesis
            were the ones that looked like they came from somewhere else.

            `title` moves to the wrapper with the swap. The control is now a
            Radix button with an indicator inside it, and a `title` on the tick
            alone would say nothing when somebody rests on the WORD beside it,
            which is the larger target and the one people point at.
          */}
          {onPen && (
            <span className="flex min-w-0 shrink-0 items-center gap-1" title={EDIT_RULE}>
              <Checkbox
                id="paper-edit"
                size="container"
                checked={pen !== null}
                onCheckedChange={(next) => onPen(next === true)}
                data-editing={pen !== null ? '1' : '0'}
              />
              <Label htmlFor="paper-edit" className="text-[0.7rem] font-normal text-muted-foreground">
                Edit
              </Label>
            </span>
          )}
          {/*
            Whether a suggested change applies the moment it arrives.

            ## Beside Edit, and independent of it

            It sits next to the Edit tick because they are the two answers to
            "how much may this page change the paper", and a reader looking for
            one will look for the other in the same place. It is NOT gated on
            Edit being on, and that is a decision rather than an oversight: Edit
            is about whether YOU may type, and this is about what happens to
            somebody else's suggestion. An agent can propose at any moment,
            including while the paper is being read and not edited, and a
            standing answer to "apply it straight away?" is a thing a person has
            whether or not they are holding a pen.

            ## Off by default, and it stays off until somebody says otherwise

            The default is the state this module has always been in: nothing is
            written that a person did not press a button for. Ticking it hands
            an agent the ability to change a document while it is being read —
            which is a reasonable thing to want when you are working WITH one,
            and is not a thing to arrive at by accident.

            The enforcement is not here and not on the server. There is no
            server-side auto-approve flag at all, deliberately: what this tick
            does is make the PAGE press Accept, with the ticket, the way a finger
            would. See the essay on `/api/proposal`.

            ## And every one of them is a commit

            Accepting writes a commit to the paper's repository, on whatever
            branch is checked out, and that is as true of a change applied by
            this tick as of one somebody pressed a button for — more worth
            saying, if anything, because nobody was looking when it happened.
            The tick's own sentence says so.
          */}
          {onAuto && (
            <span className="flex min-w-0 shrink-0 items-center gap-1" title={AUTO_RULE}>
              <Checkbox
                id="paper-auto"
                size="container"
                checked={auto}
                onCheckedChange={(next) => onAuto(next === true)}
                data-auto-approve={auto ? '1' : '0'}
              />
              <Label htmlFor="paper-auto" className="text-[0.7rem] font-normal text-muted-foreground">
                Auto
              </Label>
            </span>
          )}
          {/*
            Save: commit what has changed under this paper, on the branch that
            is checked out.

            ## It does not write the file, because the file is already written

            Typing goes into the `.tex` on blur or Enter, through the ticketed
            write path, and it always has. That is not a detail to be tidied
            away behind a button — nothing here is cached, `readPaper` opens the
            file every time, and the author may have the same file open in a
            real editor. Buffering edits in the page until Save would make this
            app hold a second, newer copy of a paper it has spent its life
            refusing to hold. So Save means what it means for a document already
            on disk in a repository: commit it. The essay is on `/api/save`.

            ## Drawn only where there is a history to save to

            `nogit` — a paper in a plain folder, which was the only way to use
            this module until commits existed — draws no button at all. A
            control that is always there and never works is worse than no
            control, and "this is not a repository" is not a failure to report
            once per paper, forever.

            ## And it is enabled in every state it IS drawn in

            Including "nothing has changed" and including "git will not take
            this". A disabled button can only explain itself in a `title`, which
            is a hover, which a touch screen does not have and a reader at 220
            pixels will not go looking for. Pressed, each of those answers in
            one sentence on the line under the paper — which is where every
            other answer in this module appears. Pressing with nothing to commit
            does nothing to the repository and says so; pressing when git has
            refused does nothing to the repository and says why.

            ## The count is in the label, not only in the colour

            `Save 2` when two paths would go in, `Save` when none would. The
            filled variant says the same thing a second way, and this module's
            rule — stated where `--pencil` and `--mark` are defined — is that
            every colour on this page is paired with something that is not a
            colour. At 220 pixels the fill is what a reader sees and the number
            is what they can check.
          */}
          {onSave && saving && saving.at !== 'nogit' && (
            <Button
              type="button"
              variant={saving.at === 'ready' ? 'default' : 'outline'}
              size="container"
              className="shrink-0 text-[0.7rem] font-normal"
              disabled={answering?.busy ?? false}
              data-save=""
              data-saving={saving.at}
              onClick={() => onSave()}
              title={
                saving.at === 'ready'
                  ? `Commit ${saving.files.length === 1 ? 'this change' : `these ${saving.files.length} changes`} to `
                    + `the paper's own repository, on the branch that is checked out: ${saving.files.join(', ')}. `
                    + 'Only the paper’s files go in, whatever else is staged.'
                  : saving.at === 'clean'
                    ? 'Nothing has changed under this paper since the last commit.'
                    : saving.why
              }
            >
              {saving.at === 'ready' ? `Save ${saving.files.length}` : 'Save'}
            </Button>
          )}
          {/*
            What is waiting, and the one control that answers all of it.

            `Accept all` is here rather than in the floating control above each
            change, and the reason is that a button meaning "and the other four
            as well" repeated above each of five changes is five controls each
            claiming to speak for all of them — press the one above the
            paragraph you happen to be reading and four changes you have not
            scrolled to are written. It belongs with the COUNT, which is the
            only place on this page that is about all of them at once.

            It appears at two or more, because at one it is the Accept button
            already floating over the change, in a worse place.
          */}
          {answering && inOrder.length > 0 && (
            <span className="flex min-w-0 shrink-0 items-center gap-1" data-pending-proposals={inOrder.length}>
              <span className="text-[0.7rem] text-[var(--mark)]">
                {inOrder.length} suggested
              </span>
              {/*
                Where the next one is, which is the one thing the count cannot
                say. Only the change the reader is nearest is drawn now, so the
                others are marked in the prose and have no card until they are
                reached — and on a paper of 2,437 blocks the next one may be
                several sheets away. This scrolls it to the middle of the
                column, which is the same middle `nearestProposal` measures
                from, so the change this lands on is the change that then draws
                its card. Wraps at the end rather than going dead, because the
                reader who answers the last one is usually going back for the
                ones they skipped.
              */}
              <Button
                type="button"
                variant="outline"
                size="container"
                className="text-[0.7rem] font-normal text-muted-foreground"
                data-next-proposal=""
                onClick={() => {
                  if (!columnEl) return
                  const here = nearestProposal(inOrder, anchors, fallback, columnEl)
                  const i = inOrder.findIndex((p) => p.id === here)
                  const next = inOrder[(i + 1) % inOrder.length]
                  if (!next) return
                  const at = anchors.get(next.id) ?? fallback(next)
                  at?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                }}
                title={
                  'Scroll the next suggested change into the middle of the column. Only the change nearest the '
                  + 'middle is drawn, so this is what opens the one after this. Wraps round at the last.'
                }
              >
                Next suggestion
              </Button>
              {inOrder.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="container"
                  className="text-[0.7rem] font-normal text-muted-foreground"
                  disabled={answering.busy}
                  data-accept-all=""
                  onClick={() => answering.acceptAll()}
                  title={
                    'Write every waiting change into the paper, oldest first, each one its own commit. Each is '
                    + 'checked against the file as it stands after the one before it, so a suggestion covering '
                    + 'words another has already rewritten is dropped rather than applied blindly.'
                  }
                >
                  Accept all
                </Button>
              )}
            </span>
          )}
          {/* A `span` in a badge and not a button. It says where the reader is;
              there is nothing here to press. */}
          <Badge
            variant="outline"
            className="ml-auto"
            data-page-readout=""
            role="status"
            aria-live="polite"
            aria-label={`Reading page ${at + 1} of ${count}. ${CAVEAT}`}
            /* The caveat, kept and costing nothing.
             *
             * It was a centred `<p>` under the scroll column: a permanent strip
             * across the bottom of the container, outside the scroll, taking height
             * from every page forever. In a 340px container that is a real fraction
             * of the paper, and the user asked for the space.
             *
             * Deleting it was not an option. It is the honest caveat on a
             * number a reader will otherwise trust, and it is still TRUE:
             * `pages.ts` derives its characters-per-line from a mean character
             * width and its lines-per-page from font size times line height,
             * which is estimated arithmetic over a block list. LaTeX
             * hyphenates, justifies, places floats and controls widows using
             * real glyph metrics, so this reader's page 22 is very unlikely to
             * be the PDF's.
             *
             * So it moves to where somebody actually wonders about it — the
             * number itself — as a tooltip and in the accessible name, where it
             * occupies no layout at all. The same move was made elsewhere on
             * this canvas for the same reason: Atlas's "choosing one asks the
             * host to show it" was good prose eating a short container's height, and
             * it became `title`/`aria-label` on the control it was about. */
            title={CAVEAT}
          >
            {at + 1} / {count}
          </Badge>
        </div>

        <Anchoring.Provider value={anchors}>
        {/*
          The column, published so a citation card can bound itself by it
          rather than by the window. The suggestion cards below need no such
          thing any more — they are laid out in this column's coordinates —
          but a citation card still floats, and a card shifted to fit the
          WINDOW would sit over the container next to this one on the canvas.
          See `Reading` in `anchor.ts`.
        */}
        <Reading.Provider value={columnEl}>
        <div
          ref={hold}
          /* Focusable so PageUp, PageDown, Home, End and the arrows reach it
             the way they reach any scrolling document. */
          tabIndex={0}
          role="region"
          aria-label={`${paper.title ?? paper.epic}, ${count} pages`}
          /* `min-h-0` is the one class here that is load-bearing rather than
             cosmetic. This is a child of a flex COLUMN, where `min-height`
             defaults to `auto` — the content's height — so without it the
             column's own height is overridden upward to the height of every
             sheet stacked, the container stops scrolling in one place, and the
             document becomes twenty-three thousand pixels tall. Measured. See
             the essay in `app.tsx`. */
          className="reading-column relative min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto focus-visible:outline-none"
        >
          {pages.map((blocks, i) => (
            <div
              key={`${revision.current}#${i}`}
              ref={(el) => {
                wraps.current[i] = el
              }}
              /* The box the scaled sheet occupies. `overflow: hidden` here is
                 the one place in this codebase where that is not the dishonest
                 fix `index.css` warns about: the unscaled sheet is 794 pixels
                 wide and overflows a narrow column as a LAYOUT box, while after
                 the transform nothing of it is outside this element visually.
                 The clip removes a phantom; without it the container would scroll
                 sideways to reach empty space. */
              className="overflow-hidden"
              style={{
                height: Math.ceil((heights[i] ?? PAGE.height) * scale),
                marginBottom: i === pages.length - 1 ? 0 : gap,
              }}
              data-page={i + 1}
            >
              <SheetPage
                index={i}
                count={count}
                paper={paper}
                blocks={blocks}
                mark={mark}
                pen={pen}
                proposals={inOrder}
                scale={scale}
                room={room}
                keep={(el) => {
                  sheets.current[i] = el
                }}
              />
            </div>
          ))}
          {/*
            The controls, inside the column and after every sheet, so that they
            scroll with the words they point at and paint over the sheets. They
            are absolutely positioned in the column's own coordinates — the
            column is `relative` for exactly this — and laid out once per
            layout rather than once per scroll. See `ProposalControls`.
          */}
          {answering && inOrder.length > 0 && (
            <ProposalControls
              proposals={inOrder}
              anchors={anchors}
              fallback={fallback}
              column={columnEl}
              answering={answering}
              laidOut={laidOut}
            />
          )}
        </div>
        </Reading.Provider>
        </Anchoring.Provider>

      </SidebarInset>
    </SidebarProvider>
  )
}

/**
 * One sheet, at A4, scaled into whatever room there is.
 *
 * `transform-origin: top left` and an explicit left offset rather than
 * `top center`, because the arithmetic then has one unknown: the sheet's
 * visible width is `PAGE.width * scale`, and centring it is one subtraction. A
 * centred origin hides the same sum inside the compositor and leaves the
 * enclosing box's size a guess.
 */
function SheetPage({
  index,
  count,
  paper,
  blocks,
  mark,
  pen,
  proposals,
  scale,
  room,
  keep,
}: {
  index: number
  count: number
  paper: Paper
  blocks: readonly PlacedBlock[]
  mark: { file: string; id: string; from: number; to: number } | null
  pen: Pen | null
  proposals: readonly Proposal[]
  scale: number
  room: number
  keep: (el: HTMLElement | null) => void
}) {
  const left = Math.max(0, (room - PAGE.width * scale) / 2)
  return (
    <section
      ref={keep}
      className="sheet rounded-sm"
      style={{
        width: PAGE.width,
        minHeight: PAGE.height,
        padding: `${PAGE.marginY}px ${PAGE.marginX}px`,
        fontSize: PAGE.fontSize,
        lineHeight: PAGE.lineHeight,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        marginLeft: left,
      }}
      aria-label={`Page ${index + 1} of ${count}`}
      /* Readable from the outside, because "is this page whole and in
         proportion" is worth being able to answer by measuring rather than by
         looking at a screenshot. */
      data-page-scale={scale.toFixed(3)}
    >
      {/* The title and the byline, on the first sheet only, the way a paper
          carries them. The epic slug is named beside the title, even when the
          paper has one of its own, because the title is the paper's claim about
          itself and the slug is what the host and the reader are both actually
          standing on. */}
      {index === 0 && (
        <header className="mb-[2em]">
          {/* `h2`, not `h1`: `h1` on this page is the APP's name, drawn only
              when nothing is framing it. A paper whose title outranked that
              would give an unframed page two `h1`s, and a framed one an `h1`
              for a document inside somebody else's container header. */}
          <h2 className="prose-reading text-[1.9em] leading-tight font-semibold">{paper.title ?? paper.epic}</h2>
          <p className="mt-[0.6em] text-[0.8em] text-[var(--paper-muted)]">
            {[paper.author, paper.epic, paper.files.length > 1 ? `${paper.files.length} files` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </header>
      )}
      {blocks.map((block) => (
        <BlockRow
          key={`${block.file}#${block.id}`}
          block={block}
          epic={paper.epic}
          proposals={proposals}
          /* Only where the block is in the marked file, so the range never
             means something in a chapter it was not measured against. */
          mark={mark && mark.file === block.file ? mark : null}
          pen={pen}
        />
      ))}
      {!blocks.length && (
        <p className="text-[0.85em] text-[var(--paper-muted)]">This paper parsed to nothing a reader can see.</p>
      )}
    </section>
  )
}

/**
 * The sections, in a sidebar beside the paper.
 *
 * It is built from the same blocks the sheets are, so an entry and its heading
 * cannot disagree about where they are — the failure a separately-derived table
 * of contents always eventually has. A press SCROLLS that page into view rather
 * than being an `href="#…"`: a fragment link moves the reader with no sense of
 * how far they went, and in a document that is one continuous column, how far
 * is most of what a reader wants to know.
 *
 * Closed by default (see `SidebarProvider`), and it collapses to nothing rather
 * than to a strip of icons: a section is a sentence and there is no icon for
 * one, so an icon rail would be a column of identical marks.
 */
function Sections({
  paper,
  pages,
  at,
  onGo,
}: {
  paper: Paper
  pages: readonly (readonly { file: string; id: string; kind: string }[])[]
  at: number
  onGo: (index: number) => void
}) {
  const headings = paper.blocks.filter((b) => b.kind === 'heading')
  return (
    <Sidebar>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Sections</SidebarGroupLabel>
          {paper.outline.length === 0 ? (
            <p className="px-2 py-1 text-[0.7rem] text-[var(--sidebar-foreground)]/60">This paper has no headings.</p>
          ) : (
            <SidebarMenu>
              {paper.outline.map((entry, i) => {
                const source = headings[i]
                if (!source) return null
                const on = pageOf(pages, source.file, source.id)
                return (
                  <SidebarMenuItem key={`${source.file}#${source.id}`}>
                    <SidebarMenuButton
                      isActive={on === at}
                      style={{ paddingLeft: `${0.5 + Math.max(0, entry.level - 1) * 0.6}rem` }}
                      onClick={() => {
                        if (on >= 0) onGo(on)
                      }}
                    >
                      <span className="min-w-0 flex-1">{entry.text}</span>
                      {on >= 0 && <span className="mt-px font-mono text-[0.6rem] opacity-60">p{on + 1}</span>}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          )}
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
