import type { Block, Segment } from './parse.ts'

/**
 * Cross-references, resolved: `\ref{ch:conclusion}` becomes "6".
 *
 * ## Why this is a layer above the parser and not a branch inside it
 *
 * The parser stops at `§ch:conclusion`, and its own comment says why: a
 * `\ref` is only meaningful once the whole document is known. The label it
 * names usually lives in another file, and the number LaTeX prints for it is
 * positional — how many chapters, and inside them how many figures, came
 * before it in `\include` order. One file's parse cannot know that. This
 * module can, because `store.ts` has already folded every chapter into reading
 * order by the time it calls here, and reading order is the whole answer.
 *
 * ## Recomputed, and deliberately not read out of an `.aux` file
 *
 * LaTeX writes every label's number to `main.aux` on a compile, and reading
 * that back would be less code than this file. It would also be wrong in
 * exactly the two cases this reader exists for: a paper that has never been
 * compiled on this machine, and a paper edited ten seconds ago. The `.aux`
 * describes the PDF that was, not the source that is, and a reader showing
 * "Chapter 5" for a chapter that became the sixth this morning is a reader
 * disagreeing with the file in front of it. So the counters are run here, over
 * the blocks, the way LaTeX runs them — and nothing on disk but the `.tex` is
 * consulted.
 *
 * ## What is counted, and how far this goes
 *
 * Chapters, sections to three levels below them, figures, tables, numbered
 * equations and listings; `\appendix` turning chapters into letters; the
 * starred heading that takes no number; `\frontmatter` and `\backmatter`
 * switching numbering off. Nothing else. `\part` and `\paragraph` carry no
 * number this scheme can print and are skipped rather than guessed at. A
 * `\pageref` is unresolvable without a compiled document and keeps its
 * placeholder, saying why.
 *
 * ## Chapters or no chapters is a fact about the source, not the class
 *
 * A report numbers its sections `3.2` and its figures `3.1`; an article
 * numbers them `2` and `1`, because it has no chapter counter to prefix with.
 * The obvious way to tell the two apart is `\documentclass`, and it is not
 * done that way: the preamble is one opaque block here, a university class
 * file can `\LoadClass{report}` under any name it likes, and what actually
 * decides the numbering in LaTeX is whether the chapter counter is ever
 * stepped. So this asks the same question — does the paper contain a numbered
 * `\chapter` anywhere — and every roadmap paper on this machine, which is an
 * article, numbers plainly, while the thesis, which is a report, prefixes.
 */

export type LabelKind =
  | 'chapter'
  | 'section'
  | 'subsection'
  | 'subsubsection'
  | 'figure'
  | 'table'
  | 'equation'
  | 'listing'

export interface LabelTarget {
  key: string
  /** The printed number: "6", "6.2", "3.1", "A.1". */
  number: string
  kind: LabelKind
  /** Plain text of the heading or caption, for `\nameref` and for the tooltip. */
  title: string
  /** The block that carries the label, so a click can go there. */
  file: string
  id: string
  /**
   * True when a second `\label` with this key was met.
   *
   * LaTeX warns "multiply defined" and prints the LAST definition's number,
   * because the `.aux` is read top to bottom and each `\newlabel` overwrites
   * the one before. This does the same, so the number shown is the number the
   * PDF shows — and the tooltip says the label is defined twice, because that
   * is the fault the author needs to find and the number alone would hide it.
   */
  definedTwice?: boolean
}

export type LabelIndex = Map<string, LabelTarget>

/** How `\autoref` and `\Cref` name each kind of target. */
const KIND_NAMES: Record<LabelKind, string> = {
  chapter: 'Chapter',
  section: 'Section',
  subsection: 'Section',
  subsubsection: 'Section',
  figure: 'Figure',
  table: 'Table',
  equation: 'Equation',
  listing: 'Listing',
}

/** Heading levels as the parser numbers them, to the kinds that take a number. */
const HEADING_KINDS: Record<number, LabelKind> = {
  1: 'chapter',
  2: 'section',
  3: 'subsection',
  4: 'subsubsection',
}

/** The verbatim environments the `listings` package numbers as listings. */
const LISTING_ENVS = new Set(['lstlisting', 'minted'])

/** The top-level counter as a letter once `\appendix` has been seen. */
function topLabel(n: number, appendix: boolean): string {
  return appendix ? String.fromCharCode(64 + n) : String(n)
}

function plain(segments: readonly Segment[] | undefined): string {
  return (segments ?? [])
    .map((s) => s.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Every label in the paper, with the number LaTeX would print for it.
 *
 * `blocks` must be the paper in reading order — `main.tex` with each
 * `\include` replaced by the blocks of the file it names, which is what
 * `readPaper` produces. The counters are positional, so the order is the
 * whole answer; handed the chapters in any other order this returns numbers
 * that are confidently wrong.
 */
export function buildLabelIndex(blocks: readonly (Block & { file: string })[]): LabelIndex {
  const index: LabelIndex = new Map()

  /* See the essay above: whether the top-level counter is a chapter. */
  const hasChapters = blocks.some((b) => b.kind === 'heading' && b.level === 1 && b.numbered)
  /* Index into `heading` of the counter every float is prefixed with. */
  const top = hasChapters ? 0 : 1

  let appendix = false
  /* `\frontmatter` switches heading numbers off; `\mainmatter` switches them
     back on. A paper that uses neither is in the main matter throughout. */
  let mainMatter = true
  const heading = [0, 0, 0, 0] // chapter, section, subsection, subsubsection
  let figure = 0
  let table = 0
  let equation = 0
  let listing = 0

  /*
   * The titles are filled in AFTER the walk, from the segments, and not
   * during it. A caption can itself hold a reference — the thesis's Figure
   * 3.1 says "described in Section~\ref{sec:meth-rag}" — and a title read off
   * the caption mid-walk would carry that reference as its placeholder, so the
   * tooltip on every `\ref{fig:meth-exflow}` would read "Section §sec:meth-rag"
   * inside a feature whose whole point is that it does not. Resolving the
   * title needs the finished index, so the segments are kept until there is
   * one.
   */
  const titles = new Map<string, readonly Segment[]>()
  const record = (key: string | undefined, kind: LabelKind, number: string, title: readonly Segment[], block: Block & { file: string }) => {
    if (!key) return
    const definedTwice = index.has(key)
    index.set(key, { key, number, kind, title: '', file: block.file, id: block.id, ...(definedTwice ? { definedTwice } : {}) })
    titles.set(key, title)
  }

  /** "3.1" inside a chapter; plain "1" in a paper that has no chapters. */
  const withChapter = (n: number): string => (hasChapters ? `${topLabel(heading[0]!, appendix)}.${n}` : String(n))

  for (const block of blocks) {
    switch (block.kind) {
      case 'structure': {
        const command = block.command.replace(/^\\/, '').replace(/[^a-zA-Z].*$/s, '')
        if (command === 'appendix') {
          /* Chapters start again from A, and so does everything numbered
             within them — the appendix's first figure is A.1. In a paper with
             no chapters it is the sections that become letters. */
          appendix = true
          heading.fill(0)
          figure = table = equation = listing = 0
        } else if (command === 'frontmatter' || command === 'backmatter') {
          mainMatter = false
        } else if (command === 'mainmatter') {
          mainMatter = true
        }
        break
      }

      case 'heading': {
        const kind = HEADING_KINDS[block.level]
        if (!kind || !block.numbered || !mainMatter) break
        const depth = block.level - 1
        if (depth < top) break
        heading[depth] = (heading[depth] ?? 0) + 1
        for (let d = depth + 1; d < heading.length; d++) heading[d] = 0
        /* A new chapter starts every float's numbering again — Figure 3.1 is
           the first figure of chapter three, not the third-and-first. */
        if (depth === top && hasChapters) figure = table = equation = listing = 0
        const parts = heading.slice(top, depth + 1)
        const number = [topLabel(parts[0]!, appendix), ...parts.slice(1).map(String)].join('.')
        record(block.label, kind, number, block.segments, block)
        break
      }

      case 'figure':
        figure += 1
        record(block.label, 'figure', withChapter(figure), block.caption, block)
        break

      case 'table':
        table += 1
        record(block.label, 'table', withChapter(table), block.caption, block)
        break

      case 'equation':
        /* `equation*` and `align*` print no number, so they take none — and
           an unlabelled `equation` still steps the counter, which is why this
           counts every unstarred one and not only the ones a `\ref` can reach. */
        if (block.env.endsWith('*')) break
        equation += 1
        record(block.label, 'equation', withChapter(equation), [], block)
        break

      case 'verbatim':
        if (!LISTING_ENVS.has(block.env)) break
        listing += 1
        record(
          block.label,
          'listing',
          withChapter(listing),
          block.title ? [{ text: block.title, srcStart: block.srcStart, srcEnd: block.srcStart, literal: false, styles: [] }] : [],
          block,
        )
        break

      default:
        break
    }
  }

  for (const [key, segments] of titles) {
    const target = index.get(key)
    if (target) target.title = plain(segments.map((segment) => resolveRef(segment, index)))
  }

  return index
}

/**
 * The text a reference should show.
 *
 * A key with no label keeps its `§key` placeholder. Showing a made-up number,
 * or showing nothing, would hide a broken reference the author needs to see —
 * that `\ref` comes out of LaTeX as a bold `??`, and this is where it should be
 * caught first. `\pageref` keeps the placeholder too, for a different reason:
 * a page number is a fact about the compiled document and nothing here can
 * honestly claim one.
 *
 * `\cref` and `\Cref` take several keys and the name is pluralised for them,
 * which is what cleveref prints: "Sections 3.1 and 3.2". Everything else joins
 * with commas, which is what `\ref{a,b}` would print if anybody wrote it.
 */
export function refText(cmd: string | undefined, keys: readonly string[], index: LabelIndex): string {
  const targets = keys.map((key) => ({ key, target: index.get(key) }))
  const numbers = targets.map(({ key, target }) => {
    if (!target) return `§${key}`
    switch (cmd) {
      case 'eqref':
        return `(${target.number})`
      case 'nameref':
        return target.title || `§${key}`
      case 'pageref':
        return `§${key}`
      default:
        return target.number
    }
  })

  if (cmd === 'autoref' || cmd === 'Cref' || cmd === 'cref') {
    const first = targets[0]?.target
    if (!first) return numbers.join(', ')
    const kinds = new Set(targets.map((t) => t.target?.kind))
    const name = kinds.size === 1 ? KIND_NAMES[first.kind] + (targets.length > 1 ? 's' : '') : ''
    const named = name ? `${cmd === 'cref' ? name.toLowerCase() : name} ` : ''
    return named + joinNaturally(numbers)
  }
  return numbers.join(', ')
}

/** "1", "1 and 2", "1, 2 and 3". */
function joinNaturally(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * A title short enough for a tooltip.
 *
 * A heading is a line; a table caption in this thesis is four sentences and
 * three hundred characters, and a tooltip that long is a paragraph over the
 * prose. Cut at a word, with the mark that says so.
 */
const TITLE_CHARS = 120
function shortTitle(title: string): string {
  if (title.length <= TITLE_CHARS) return title
  const cut = title.lastIndexOf(' ', TITLE_CHARS)
  return `${title.slice(0, cut > TITLE_CHARS / 2 ? cut : TITLE_CHARS)}…`
}

/** The tooltip for a reference: what it points at, or what is wrong. */
function refNote(keys: readonly string[], index: LabelIndex): string {
  return keys
    .map((key) => {
      const target = index.get(key)
      if (!target) return `${key} — no such label in the paper`
      const where = `${KIND_NAMES[target.kind]} ${target.number}${target.title ? ` — ${shortTitle(target.title)}` : ''}`
      return target.definedTwice ? `${where} (${key} is defined twice; LaTeX will warn)` : where
    })
    .join('\n')
}

/**
 * Resolve one reference segment. Anything else is returned as it was.
 *
 * Still derived, and the offsets untouched: the rendered characters are this
 * module's and not the author's, whether they read `§ch:conclusion` or `6`, so
 * a selection keeps snapping to the whole segment and an edit keeps refusing
 * it. `target` is the FIRST key's block — a `\cref{a,b}` can only be a link
 * to one place, and the first is the one a reader expects.
 */
export function resolveRef(segment: Segment, index: LabelIndex): Segment {
  if (!segment.styles.includes('ref') || !segment.keys?.length) return segment
  const first = index.get(segment.keys[0]!)
  const unresolved = segment.keys.some((key) => !index.has(key))
  return {
    ...segment,
    text: refText(segment.cmd, segment.keys, index),
    literal: false,
    note: refNote(segment.keys, index),
    ...(unresolved ? { unresolved } : {}),
    ...(first ? { target: { file: first.file, id: first.id } } : {}),
  }
}

/**
 * Apply `fn` to every segment in a block, wherever segments live.
 *
 * Blocks keep their segments in five shapes — a heading's line, a paragraph,
 * a figure's caption, a list's items, a table's caption and its cells — and a
 * pass that rewrote segments would have to visit all five or quietly miss one.
 * That miss would be a caption reading "as in Chapter §ch:methods" under a
 * figure whose paragraph reads "Chapter 3", which is worse than either alone.
 * One walk, used by both resolvers, is how that stops being a thing to
 * remember.
 *
 * The same block comes back when nothing changed, so a paper with no
 * references in a block does not have every one of its blocks copied.
 */
export function mapSegments<B extends Block>(block: B, fn: (segment: Segment) => Segment): B {
  const map = (segments: Segment[]): Segment[] => {
    let changed = false
    const out = segments.map((segment) => {
      const next = fn(segment)
      if (next !== segment) changed = true
      return next
    })
    return changed ? out : segments
  }

  switch (block.kind) {
    case 'heading':
    case 'paragraph': {
      const segments = map(block.segments)
      return segments === block.segments ? block : { ...block, segments }
    }
    case 'figure': {
      const caption = map(block.caption)
      return caption === block.caption ? block : { ...block, caption }
    }
    case 'list': {
      let changed = false
      const items = block.items.map((item) => {
        const next = map(item)
        if (next !== item) changed = true
        return next
      })
      return changed ? { ...block, items } : block
    }
    case 'table': {
      const caption = map(block.caption)
      let cellsChanged = false
      const grid = block.grid
        ? {
            ...block.grid,
            rows: block.grid.rows.map((row) => ({
              ...row,
              cells: row.cells.map((cell) => {
                const segments = map(cell.segments)
                if (segments !== cell.segments) cellsChanged = true
                return segments === cell.segments ? cell : { ...cell, segments }
              }),
            })),
          }
        : block.grid
      if (caption === block.caption && !cellsChanged) return block
      return { ...block, caption, grid }
    }
    default:
      return block
  }
}
