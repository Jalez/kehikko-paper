import type { PlacedBlock } from '../../store.ts'

/**
 * The page, and where the pages break.
 *
 * ## The page is a real A4 sheet, and that is what makes this file honest
 *
 * The reader this replaces packed blocks to whatever height the PANE happened
 * to have, so "a page" meant "as much as fits here at the moment". Two readers
 * with differently sized containers were on different page 7s of the same paper, and
 * one reader who dragged a container edge was moved between them.
 *
 * A page here is 210×297mm at 96dpi — the box below — and every measurement of
 * type on it is fixed too. The whole sheet is then scaled to the width of the
 * container by a CSS transform, which changes how big the page LOOKS and nothing
 * about what is on it. So pagination is a property of the DOCUMENT: the same
 * blocks give the same pages in a 220-pixel container and a 1200-pixel one, in both
 * themes, on every render.
 *
 * That property was already true of the previous version and it was true by
 * ACCIDENT — it held because the weights below were written not to consult the
 * container, and any future line that measured a rendered width would have quietly
 * ended it. Now it holds because the box the type is set in cannot vary. Keep
 * it that way: nothing in this file may read the DOM, and `PAGE` is the only
 * source of the numbers, so the sheet the browser draws and the sheet this
 * function packs cannot disagree about how big a page is.
 *
 * ## The estimate is still an estimate, and still says so
 *
 * These breaks are this program's arithmetic over a block list, not a LaTeX
 * compiler's over the real document: float placement, widow control and
 * hyphenation all move the compiled PDF's boundaries. A fixed page box makes
 * the estimate a better one — the column width and the leading are now the ones
 * the reader is actually looking at — without making it a claim about page 7 of
 * the thesis. The page says so under the controls.
 */

/**
 * The sheet, in CSS pixels, and the type set on it.
 *
 * ONE definition, exported, and read by both this file's arithmetic and the
 * component that draws the sheet. Two copies of a page size is how a reader
 * ends up with a paginator that thinks forty lines fit and a page that shows
 * thirty-two, which looks like a bug in the text rather than in a constant.
 *
 * 794×1123 is A4 at 96dpi (210mm × 297mm), rounded to whole pixels. The margins
 * are a book's rather than a word processor's: generous enough that the measure
 * lands near the sixty-to-ninety characters a line of prose wants.
 */
export const PAGE = {
  width: 794,
  height: 1123,
  /** Left and right margin. */
  marginX: 64,
  /** Head and foot margin. */
  marginY: 72,
  /** The body size everything on the sheet is expressed in ems of. */
  fontSize: 15,
  /** Leading, as a multiple of the body size. */
  lineHeight: 1.6,
  /**
   * Mean advance width of one character of the reading face, in ems.
   *
   * A constant rather than a measurement: it is roughly what a serif at a
   * reading size averages over English prose, counting the spaces. It is a
   * NUMBER here because measuring the real face would mean reading the DOM,
   * which is the thing this file must never do — a paginator that measured
   * would be a paginator that re-packs when a font finishes loading, which is
   * the failure this file exists to end.
   *
   * It was 0.5, which was a guess at a serif rather than a measurement of THIS
   * one, and the guess was 8% too wide. Every paragraph in the thesis and in
   * one roadmap paper was measured as drawn — 74 of them, six lines or longer
   * so the partial last line does not dominate — and the median came out at
   * 96.5 characters to a full line against the 88 this arithmetic assumed.
   * Range 88.7 to 105.3, which is the spread of English prose and not of the
   * face. `dev/measure-pages.mjs` is the probe; the calibration run is in its
   * comment.
   *
   * Being wrong in this direction is not neutral. Charging a paragraph more
   * lines than it draws makes the packer break a page early, and an early break
   * is the whole of what a reader sees as "a huge gap": measured over the
   * thesis's 51 sheets, the mean blank on a page nothing had asked for was 471
   * pixels of a 979-pixel text area — nearly half of every sheet, with the worst
   * at 919. This constant is the largest single part of that, and with it and
   * the air below corrected the same thesis packs onto 45 sheets with a mean of
   * 387. The rest is what greedy packing costs when a paragraph cannot be split
   * across a break, and splitting one would need the run-time measurement this
   * file exists to refuse.
   *
   * It is still deliberately an ESTIMATE and not a promise. The median is the
   * right calibration for a page with several paragraphs on it, where the
   * errors cancel; a single unusually dense paragraph is now charged a line or
   * two short, which `paginate` already survives — a block that runs over gets
   * a sheet taller than A4 rather than being clipped.
   */
  meanCharEm: 0.46,
} as const

/** The type column, in pixels. */
export const COLUMN = PAGE.width - PAGE.marginX * 2

/** Characters of prose that make one line in that column. */
export const CHARS_PER_LINE = Math.floor(COLUMN / (PAGE.fontSize * PAGE.meanCharEm))

/** Lines of type that fit between the head and foot margins. */
export const LINES_PER_PAGE = Math.floor((PAGE.height - PAGE.marginY * 2) / (PAGE.fontSize * PAGE.lineHeight))

/**
 * The title and the byline at the top of sheet one, in lines.
 *
 * `SheetPage` draws a masthead on the first sheet — the paper's title, the
 * author and the epic — and until now it was drawn WITHOUT being weighed. So
 * the first page of every paper was packed as though a hundred and sixty
 * pixels of it were empty, and the only reason that was survivable is that a
 * first page which runs over is allowed to grow rather than clip. It stopped
 * being survivable as soon as the rest of the weights got tighter: the first
 * sheet of `a-green-gate-means-something` came out 1140 pixels tall against
 * A4's 1123, which is a sheet that is visibly not the same size as the ones
 * under it.
 *
 * Seven lines is the masthead measured on the longest title on this machine —
 * the thesis's, which wraps to two lines: 133 pixels of type and a 30-pixel
 * `mb-[2em]`, 163 in all, against a 24-pixel line. A one-line title spends
 * about four, so this over-reserves by three lines on most papers. That is the
 * deliberate direction: a first page an inch short is a page, and a first page
 * that has grown past A4 is a bug somebody can see.
 *
 * A constant rather than a measurement for the reason every number in this file
 * is one — and it cannot be derived from the block list, because the title is
 * `paper.title`, which is not a block.
 */
export const MASTHEAD = 7

const textOf = (segments: { text: string }[]): string => segments.map((s) => s.text).join('')

const lines = (chars: number): number => Math.max(1, Math.ceil(chars / CHARS_PER_LINE))

/**
 * Blocks a reader is meant to see.
 *
 * The four that are dropped are each a decision rather than an omission, and
 * they are dropped HERE rather than at render time so that pagination and the
 * page agree about what is on it — a block that was weighed and then not drawn
 * is a page with a hole in it whose size nobody can explain.
 *
 * - `preamble` is `fontspec`, `geometry` and the paper's own `\newcommand`s. It
 *   is real source and it is not the argument; the two facts a reader wants out
 *   of it, the title and the author, are lifted by `store.ts` and drawn above.
 * - `structure` is `\maketitle`, `\tableofcontents`, `\printbibliography`:
 *   instructions to a compiler about furniture this page builds for itself.
 * - `include` cannot occur, `readPaper` having already replaced each one with
 *   the blocks of the file it named. Dropping rather than throwing means a
 *   single unassembled file still renders.
 * - `comment` — every one of them now, and not only the empty rules. This is a
 *   decision and it changed: a `%` run in these papers is the author reasoning
 *   about the section under it, and it used to be drawn in the flow behind a
 *   rule so nobody mistook it for prose. It is not drawn any more, because
 *   annotation has somewhere to live: Notes ingests every comment run out of
 *   the source, anchored to the bytes it sits at, and shows it beside the paper
 *   instead of inside it. The user's words were "can they be converted into
 *   notes so that they are not mixed in with the actual paper paragraphs?"
 *
 *   Dropping it HERE rather than at render time is what keeps the promise this
 *   list is about — pagination and the page agree on what is on the sheet, and
 *   a block that was weighed and then not drawn is a page with a hole in it. It
 *   also means the page count now matches what a reader sees; leaving comments
 *   in the packing would have left blank bands where the annotations used to
 *   be.
 *
 *   `latex/parse.ts` still parses them, deliberately: Notes reads exactly what
 *   this parser produces, and a parser that dropped them would leave that
 *   module with nothing to read. Not drawing something is not the same as not
 *   knowing it.
 */
export function visible(b: PlacedBlock): boolean {
  if (b.kind === 'preamble' || b.kind === 'structure' || b.kind === 'include') return false
  if (b.kind === 'comment') return false
  return true
}

/**
 * Roughly how many lines of the sheet this block will take.
 *
 * A figure is eight lines per graphic rather than the three it was, and the
 * change is the fixed page rather than a better guess: an image on a 666-pixel
 * column is drawn at whatever width it has up to that, which is a third of the
 * sheet's height for a normal plot. Three lines was calibrated for a page that
 * was however tall the container was, where being wrong about a figure cost nothing
 * because the sheet stretched. On a fixed sheet it costs an overrun.
 *
 * ## The air is measured now, and it used to be doubled
 *
 * The numbers added to `lines()` below are the block's MARGINS expressed in
 * lines, and they were round numbers picked to be safe. Safe in one direction
 * only: the CSS in `blocks.tsx` draws a paragraph with `my-[0.8em]`, which is
 * twelve pixels top and twelve bottom, and two paragraphs in a row COLLAPSE to
 * twelve — half of a twenty-four-pixel line. It was charged a whole one. A
 * level-one heading was charged five lines of air, 120 pixels, against a
 * measured footprint of 99 pixels for the whole heading including its own type.
 *
 * Every one of these is now the drawn value, read off the rendered thesis with
 * `getComputedStyle` and divided by the leading (`dev/measure-pages.mjs`):
 *
 *   level ≤ 1 (22.5px type)  margin 45 + 18, whole block 99px = 4.1 lines
 *   level 2   (18.75px type) margin 34 + 11, whole block 75px = 3.1 lines
 *   level ≥ 3 (16.5px type)  margin 25 +  8, whole block 59px = 2.5 lines
 *   paragraph                12px collapsed                   = 0.5 line
 *
 * They are fractions, and that is not sloppiness: `paginate` sums them against
 * a budget of forty, so half a line is a real quantity and rounding each block
 * up to a whole one is exactly the over-charge being removed. Nothing here
 * measures the DOM at run time — these are constants like every other number in
 * this file, they just happen to be right now.
 */
export function weigh(b: PlacedBlock): number {
  switch (b.kind) {
    case 'heading':
      /* A heading is one or two lines of much larger type plus the air above
         it, and the air is most of the cost. */
      return lines(textOf(b.segments).length) + (b.level <= 1 ? 3.1 : b.level === 2 ? 2.1 : 1.5)
    case 'paragraph':
      return lines(textOf(b.segments).length) + 0.5
    case 'list':
      return b.items.reduce((n, item) => n + lines(textOf(item).length), 0) + 1
    case 'figure':
      return b.graphics.length * 8 + lines(textOf(b.caption).length) + 2
    case 'table':
      return (b.grid ? b.grid.rows.length * 2 : b.raw.split('\n').length) + lines(textOf(b.caption).length) + 2
    case 'verbatim':
      return b.raw.split('\n').length + 2
    case 'equation':
      return b.latex.split('\n').length + 2
    case 'comment':
      return lines(b.text.length) + 1
    default:
      return b.kind === 'unknown' ? b.raw.split('\n').length + 1 : 1
  }
}

/**
 * The air ABOVE a block, which it does not get when it is first on a sheet.
 *
 * `index.css` sets `margin-top: 0` on whatever the sheet draws first, because a
 * heading's top margin separates it from the paragraph before it and there is
 * no paragraph before it at the top of a page. This is the same fact stated to
 * the packer, so that the space the page gets back is space the page is allowed
 * to fill rather than blank that appears at the foot instead.
 *
 * The one rule that keeps this honest: it must be a fact about the BLOCK and
 * its position in the packing, never about anything drawn. It is the measured
 * `margin-top` from `blocks.tsx` divided by the leading, and nothing else.
 *
 * Only headings are worth stating. A paragraph's twelve pixels collapse against
 * its neighbour's anyway, so the half-line it is charged is what it costs
 * whether it is first or not.
 */
function topAir(b: PlacedBlock): number {
  if (b.kind !== 'heading') return 0
  /* 45px, 33.75px and 24.75px against a 24px line. */
  return b.level <= 1 ? 1.9 : b.level === 2 ? 1.4 : 1
}

/**
 * The block list, packed into sheets.
 *
 * A block heavier than a whole sheet gets a sheet of its own and is allowed to
 * run over it, which is the least-bad answer for an oversized table: splitting
 * it would need the measurement this function exists to avoid, and dropping any
 * of it is not an option at all. The sheet is drawn with a MINIMUM height of
 * `PAGE.height` rather than a fixed one for exactly this case — a page that
 * clipped its overflow would lose the author's words silently, which is the one
 * failure this codebase spends the most words refusing.
 *
 * A heading is never the last thing on a sheet. That is the one typographic
 * rule kept here, because a heading stranded at the foot of a page with its
 * section beginning overleaf is the single break that makes a reader think the
 * page they are on is the end of something.
 *
 * Sheet one is `MASTHEAD` lines shorter than the rest, because the title is
 * drawn on it and something has to pay for that.
 */
export function paginate(blocks: readonly PlacedBlock[], budget = LINES_PER_PAGE): PlacedBlock[][] {
  const shown = blocks.filter(visible)
  if (!shown.length) return []

  const pages: PlacedBlock[][] = []
  let page: PlacedBlock[] = []
  let used = 0
  /* Room on the sheet being packed. The masthead is only on the first one. */
  let room = Math.max(1, budget - MASTHEAD)

  for (const b of shown) {
    const cost = weigh(b)
    if (page.length && used + cost > room) {
      pages.push(page)
      page = []
      used = 0
      room = budget
    }
    /* First on the sheet, so its top margin is not drawn — see `topAir`. The
       discount is taken after the break decision and not before it: a block
       that does not fit on this page has to start the next one whether or not
       it would be cheaper there, and asking the cheaper question first is how a
       packer ends up with two answers for one block. */
    const first = page.length === 0
    page.push(b)
    used += first ? cost - topAir(b) : cost
  }
  if (page.length) pages.push(page)

  /* The orphan-heading pass, run after packing rather than during it, so that
     moving a heading forward cannot cascade into a different set of breaks
     further down — pagination has to be one pass over one list or it is not
     the pure function this file promises. */
  for (let i = 0; i < pages.length - 1; i++) {
    const here = pages[i]
    const next = pages[i + 1]
    if (!here || !next || here.length < 2) continue
    const last = here[here.length - 1]
    if (last?.kind !== 'heading') continue
    here.pop()
    next.unshift(last)
  }

  return pages
}

/**
 * Which sheet a given block landed on, or -1.
 *
 * This is how `roadmap.goto` walks to a reference that is not on the page the
 * reader is standing on, and how a press in the sections sidebar turns to a
 * section: the block is found in the block list, this says which sheet holds
 * it, and the reader is turned to that sheet before the anchor is scrolled into
 * view. Without it, a walk could only ever answer for the sheet that happened
 * to be open, which would be a module answering "found" or "not found" about a
 * fraction of the paper it is showing.
 */
export function pageOf(
  pages: readonly (readonly { file: string; id: string }[])[],
  file: string,
  id: string,
): number {
  return pages.findIndex((page) => page.some((b) => b.file === file && b.id === id))
}
