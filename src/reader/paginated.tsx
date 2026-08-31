import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Paper, PlacedBlock } from '../../store.ts'
import { Badge } from '@/components/ui/badge.tsx'
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
import { BlockRow, anchorId } from './blocks.tsx'
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
  mark: { file: string; from: number; to: number } | null
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
}

const CAVEAT = 'Page breaks are this reader\u2019s, not the PDF\u2019s.'

export function PaginatedView({ paper, walk, mark, rootRef, onSheet }: PaginatedProps) {
  const pages = useMemo(() => paginate(paper.blocks), [paper.blocks])
  const count = Math.max(1, pages.length)

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

  const hold = useCallback(
    (el: HTMLDivElement | null) => {
      column.current = el
      rootRef.current = el
    },
    [rootRef],
  )

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

  /* A walk from outside: scroll to the block, wherever in the document it is.
     Nothing is virtualised, so the element is always in the DOM to scroll to —
     see the note above about what virtualising would cost. */
  const nonce = walk?.nonce
  useEffect(() => {
    if (!walk) return
    document.getElementById(anchorId(walk.file, walk.id))?.scrollIntoView({ block: 'center' })
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
              key={i}
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
                scale={scale}
                room={room}
                keep={(el) => {
                  sheets.current[i] = el
                }}
              />
            </div>
          ))}
        </div>

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
  scale,
  room,
  keep,
}: {
  index: number
  count: number
  paper: Paper
  blocks: readonly PlacedBlock[]
  mark: { file: string; from: number; to: number } | null
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
          /* Only where the block is in the marked file, so the range never
             means something in a chapter it was not measured against. */
          mark={mark && mark.file === block.file ? mark : null}
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
