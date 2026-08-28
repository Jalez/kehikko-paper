import type { PlacedBlock } from '../../store.ts'

/**
 * Where the pages break.
 *
 * ## Derived from the block list, and from nothing else
 *
 * The reader this was rebuilt from paginated by MEASUREMENT: it laid a hidden
 * copy of the chapter out at the sheet's content width, read every block's real
 * height, and packed sheets to a pixel budget. That is more accurate and it is
 * the wrong trade here, for a reason the measured version demonstrates rather
 * than argues. A measured pagination is a function of the rendered layout, and
 * the rendered layout changes for reasons that have nothing to do with the
 * paper: a pane resize, a font that finished loading, a `ResizeObserver` firing
 * during somebody else's drag. Each of those re-packs the sheets, and a reader
 * sitting on page 7 of 11 is silently moved to page 6 — mid-sentence, in a
 * document they were reading, with no event they could point at.
 *
 * So pagination here is a pure function of the block list. The same blocks give
 * the same pages, on every render, in every pane width, in both themes. A page
 * number stays the page the reader chose until they choose another one, and the
 * one thing that may move it is a different paper arriving.
 *
 * What is given up is stated plainly rather than hidden: these breaks are an
 * ESTIMATE and always were. Even the measured version could not agree with the
 * compiled PDF — float placement, widow control and hyphenation all move the
 * real boundaries — so neither version was ever a claim about page 7 of the
 * thesis. Both are a reading rhythm. This one is a stable rhythm, which is the
 * property a reader actually notices.
 *
 * ## The weights
 *
 * One unit is roughly one line of type. The character counts are the measure of
 * a comfortable column rather than of any particular pane, which is the same
 * decision as the paragraph above: a weight that read the pane's width would
 * make pagination depend on the pane again through the back door.
 */

/** Characters of prose that make roughly one line at the reading measure. */
const CHARS_PER_LINE = 78

/** How many lines fit a sheet. A4 at this type size, near enough. */
export const LINES_PER_PAGE = 34

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
 * - a `comment` whose text is empty, which is what a run of `%` rules used as a
 *   visual separator in the source parses to.
 */
export function visible(b: PlacedBlock): boolean {
  if (b.kind === 'preamble' || b.kind === 'structure' || b.kind === 'include') return false
  if (b.kind === 'comment' && !b.text.trim()) return false
  return true
}

/** Roughly how many lines of a sheet this block will take. */
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
      /* A named graphic is a box of fixed height per graphic; the caption
         wraps like prose. */
      return b.graphics.length * 3 + lines(textOf(b.caption).length) + 2
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
 * of it is not an option at all.
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
 * reader is standing on: the block is found in the block list, this says which
 * sheet holds it, and the reader is turned to that sheet before the anchor is
 * scrolled into view. Without it, a walk could only ever answer for the sheet
 * that happened to be open, which would be a module answering "found" or "not
 * found" about a fraction of the paper it is showing.
 */
export function pageOf(
  pages: readonly (readonly { file: string; id: string }[])[],
  file: string,
  id: string,
): number {
  return pages.findIndex((page) => page.some((b) => b.file === file && b.id === id))
}
