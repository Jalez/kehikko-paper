import type { PlacedBlock } from '../../store.ts'

/**
 * The page, and where the pages break.
 *
 * ## The page is a real A4 sheet, and that is what makes this file honest
 *
 * The reader this replaces packed blocks to whatever height the PANE happened
 * to have, so "a page" meant "as much as fits here at the moment". Two readers
 * with differently sized panes were on different page 7s of the same paper, and
 * one reader who dragged a pane edge was moved between them.
 *
 * A page here is 210×297mm at 96dpi — the box below — and every measurement of
 * type on it is fixed too. The whole sheet is then scaled to the width of the
 * pane by a CSS transform, which changes how big the page LOOKS and nothing
 * about what is on it. So pagination is a property of the DOCUMENT: the same
 * blocks give the same pages in a 220-pixel pane and a 1200-pixel one, in both
 * themes, on every render.
 *
 * That property was already true of the previous version and it was true by
 * ACCIDENT — it held because the weights below were written not to consult the
 * pane, and any future line that measured a rendered width would have quietly
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
   */
  meanCharEm: 0.5,
} as const

/** The type column, in pixels. */
export const COLUMN = PAGE.width - PAGE.marginX * 2

/** Characters of prose that make one line in that column. */
export const CHARS_PER_LINE = Math.floor(COLUMN / (PAGE.fontSize * PAGE.meanCharEm))

/** Lines of type that fit between the head and foot margins. */
export const LINES_PER_PAGE = Math.floor((PAGE.height - PAGE.marginY * 2) / (PAGE.fontSize * PAGE.lineHeight))

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
 * was however tall the pane was, where being wrong about a figure cost nothing
 * because the sheet stretched. On a fixed sheet it costs an overrun.
 */
export function weigh(b: PlacedBlock): number {
  switch (b.kind) {
    case 'heading':
      /* A heading is one or two lines of much larger type plus the air above
         it, and the air is most of the cost. */
      return lines(textOf(b.segments).length) + (b.level <= 1 ? 5 : 3)
    case 'paragraph':
      return lines(textOf(b.segments).length) + 1
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
 */
export function paginate(blocks: readonly PlacedBlock[], budget = LINES_PER_PAGE): PlacedBlock[][] {
  const shown = blocks.filter(visible)
  if (!shown.length) return []

  const pages: PlacedBlock[][] = []
  let page: PlacedBlock[] = []
  let used = 0

  for (const b of shown) {
    const cost = weigh(b)
    if (page.length && used + cost > budget) {
      pages.push(page)
      page = []
      used = 0
    }
    page.push(b)
    used += cost
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
