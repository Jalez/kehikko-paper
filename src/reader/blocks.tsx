import { useMemo, useState } from 'react'

import type { Block } from '../../latex/parse.ts'
import { anchorId } from './anchor.ts'
import type { PlacedBlock } from '../../store.ts'
import { apiUrl } from '../api.ts'
import { cn } from '@/lib/utils.ts'
import type { Proposal } from '../../latex/propose.ts'
import { Marked, Segments, Typed, type Typing } from './segments.tsx'
import { NO_PROPOSALS, Proposed } from './proposed.tsx'

/**
 * Everything the paper needs in order to be typeable EXCEPT which file it is.
 *
 * The file is supplied by `BlockRow`, because that is the only place that knows
 * it — the same division `Marked` already makes, and for the same reason: a
 * byte range with no file named is a range in whichever of a paper's chapters
 * the reader happened to think of.
 */
export type Pen = Omit<Typing, 'file'>

/**
 * One block, drawn, with the gutter tag that says what it is.
 *
 * ## The gutter
 *
 * `GUTTER` is carried over unchanged from the reader this replaces, glyph for
 * glyph, and it is the most under-rated thing in that file. It labels every
 * block with its KIND — `§` a heading, `¶` a paragraph, `fig`, `tab`, `eq` —
 * which is structural truth about how the LaTeX was parsed rather than
 * decoration. It is the fastest way to see that the thing you are reading as a
 * table was parsed as `unknown`, or that a paragraph you expected is a comment.
 *
 * Revealed on hover, so it never competes with reading, and excluded from text
 * selection, so a drag over the text cannot pick up a stray `¶` and put it in
 * the passage somebody meant to quote.
 *
 * It lives in the sheet's own left margin, which is a fixed fraction of a
 * fixed A4 page rather than whatever the container had left over — so unlike the
 * version this replaces, there is no width at which it is silently not drawn.
 * It is never moved inline: a `¶` in the reading flow is a character in the
 * argument, which is exactly the confusion it exists to prevent.
 */
const GUTTER: Record<Block['kind'], string> = {
  heading: '§',
  paragraph: '¶',
  figure: 'fig',
  table: 'tab',
  equation: 'eq',
  list: 'list',
  verbatim: 'code',
  comment: '%',
  preamble: 'pre',
  include: 'inc',
  structure: 'cmd',
  unknown: 'env',
}

/* Moved to `anchor.ts` so `segments.tsx` can link a cross-reference to its
   block without importing this file, which imports it. Re-exported here so its
   two other importers are untouched. */
export { anchorId } from './anchor.ts'

const HEADING_TAG = ['h2', 'h2', 'h2', 'h3', 'h4', 'h5'] as const
/*
 * In `em`, not `rem`, and that is the fixed page rather than a preference. The
 * sheet sets its own body size (`PAGE.fontSize`) and is then scaled bodily to
 * the container; a heading in `rem` would be sized off the ROOT, so it would keep
 * its pixel size while the page around it shrank and a level-1 heading would
 * end up taller than the sheet in a narrow container.
 */
const HEADING_SIZE = [
  'text-[1.75em] mt-[2em] mb-[0.8em]',
  'text-[1.5em] mt-[2em] mb-[0.8em]',
  'text-[1.25em] mt-[1.8em] mb-[0.6em]',
  'text-[1.1em] mt-[1.5em] mb-[0.5em]',
  'text-[1em] mt-[1.3em] mb-[0.4em]',
  'text-[0.95em] mt-[1.1em] mb-[0.4em]',
]

export interface BlockProps {
  block: PlacedBlock
  /**
   * Which paper this block belongs to.
   *
   * Only the figure case reads it, and it is threaded as a prop rather than
   * read from a context because a block that could be drawn without knowing
   * which document it came from would build an image URL out of a guess. The
   * server checks the pair anyway — see `/api/figure` — so a wrong epic here
   * produces a 404 and the fallback box rather than somebody else's picture.
   */
  epic: string
  /**
   * A byte range of THIS block's file that the canvas is pointing at, or null.
   *
   * Resolved by the caller against the block's file — see the essay on `Marked`
   * — and passed down through a context from here, so that every rendered span
   * inside this block gets it without six call sites having to remember.
   */
  mark?: { id: string; from: number; to: number } | null
  /**
   * The paper is typeable, and this is what a finished edit does.
   *
   * `null` — the default, and what a reader gets until they ask otherwise — is
   * the module exactly as it was: nothing is `contentEditable`, no span carries
   * `data-editable`, and dragging across the prose still makes a passage. That
   * is the property worth keeping cheap. A reader who has not asked to edit
   * cannot edit by accident, and every essay in this repository about this
   * being a reading view stays true for them.
   */
  pen?: Pen | null
  /**
   * Everything suggested about THIS block's file that nobody has answered yet.
   *
   * Narrowed to the block here rather than by the caller, which is the opposite
   * of what happens with `mark` and the difference is worth a line: a mark is
   * one range and the caller can resolve it once, while proposals are a list
   * that every block has to filter for itself anyway. Passing the whole list
   * and narrowing here keeps one filter instead of one per sheet.
   */
  proposals?: readonly Proposal[]
}

/**
 * Whether a suggestion is about this block.
 *
 * Touching is not overlapping, the same rule `here` applies to the mark: a
 * suggestion that ends exactly where this block begins is about the block
 * before it. An INSERTION — `from === to` — has no width to overlap with, so
 * it is admitted by its position, which is the only thing it has.
 *
 * One function and two callers: the block, to draw the change into its prose,
 * and the view, to find the block a control falls back to when the prose
 * could not draw it. Written twice they would eventually disagree about an
 * insertion at a boundary, and a control would point at one paragraph while
 * the change was drawn in the next.
 */
export function covers(block: PlacedBlock, p: Proposal): boolean {
  if (p.file !== block.file) return false
  return p.from === p.to
    ? p.from >= block.srcStart && p.from <= block.srcEnd
    : block.srcStart < p.to && p.from < block.srcEnd
}

export function BlockRow({
  block,
  epic,
  mark = null,
  pen = null,
  proposals = NO_PROPOSALS,
}: BlockProps) {
  /*
   * Narrowed to this block before it is supplied. A block the mark does not
   * touch gets `null`, which is the same value every unmarked block gets, so
   * the context does not change identity for the whole page every time one
   * paragraph is highlighted.
   *
   * Two ways to be touched, and the second is not a widening of the first. A
   * block whose source OVERLAPS the range holds some of the words pointed at. A
   * block that IS the one `pointedAt` resolved to holds the place — which is
   * the only thing left to say when the range names source this module draws
   * none of: a comment run, a `\todo{}` whose words are lifted out, anything in
   * the preamble. That was measured on the thesis and it is not rare:
   * twenty-three of its fifty-eight notes point at exactly that kind of range,
   * and before the id was carried here every one of them turned the page and
   * then drew nothing at all when it arrived.
   *
   * The range itself is unchanged either way. The spans inside a block marked
   * the second way stay unpainted, so the rule in the margin is the whole of
   * what is claimed — "the thing you pointed at is here" — rather than a
   * paragraph washed in colour because something near it was pointed at.
   */
  const overlaps = mark !== null && block.srcStart < mark.to && mark.from < block.srcEnd
  const here = mark && (overlaps || block.id === mark.id) ? mark : null
  /* The file joined on here, once per block, and memoised so that a scroll —
     which re-renders every sheet in order to move a page number — does not hand
     every span in the document a new context value on the way past. */
  const typing = useMemo<Typing | null>(
    () => (pen ? { ...pen, file: block.file } : null),
    [pen, block.file],
  )
  /*
   * The suggestions about this block, narrowed once and memoised.
   *
   * `NO_PROPOSALS` when there are none, rather than a fresh `[]`, so the
   * context value of the 2,437 blocks nothing is suggested about does not
   * change identity every time one of them gains a suggestion.
   */
  const suggested = useMemo<readonly Proposal[]>(() => {
    const mine = proposals.filter((p) => covers(block, p))
    return mine.length ? mine : NO_PROPOSALS
  }, [proposals, block])

  return (
    <div
      className="block-row group relative"
      data-block-id={anchorId(block.file, block.id)}
      data-marked={here ? '1' : undefined}
      data-has-proposals={suggested.length ? String(suggested.length) : undefined}
    >
      <div
        aria-hidden
        className="gutter-tag pointer-events-none absolute top-[0.4em] -left-11 w-9 text-right"
        title={`${block.kind} · bytes ${block.srcStart}–${block.srcEnd}`}
      >
        <span className="gutter-mark">{GUTTER[block.kind]}</span>
      </div>
      {/*
        No control is drawn here. The block used to own one per suggestion,
        and the reason it no longer does is that a control which knows only its
        own block cannot avoid the control of the block next to it — see
        `placeCards` in `proposed.tsx`. `ProposalControls` in the view draws
        all of them, in the column, laid out against each other, and finds the
        span to point at through the anchor store `Change` reports into.
      */}
      <Marked.Provider value={here}>
        <Typed.Provider value={typing}>
          <Proposed.Provider value={suggested}>
            <BlockBody block={block} epic={epic} />
          </Proposed.Provider>
        </Typed.Provider>
      </Marked.Provider>
    </div>
  )
}

function BlockBody({ block, epic }: BlockProps) {
  const id = anchorId(block.file, block.id)

  switch (block.kind) {
    case 'heading': {
      const Tag = HEADING_TAG[Math.min(block.level, HEADING_TAG.length - 1)] ?? 'h3'
      return (
        <Tag id={id} className={cn('prose-reading font-semibold leading-tight', HEADING_SIZE[Math.min(block.level, 5)])}>
          <Segments segments={block.segments} />
        </Tag>
      )
    }

    case 'paragraph':
      return (
        <p id={id} className="prose-reading my-[0.8em]">
          <Segments segments={block.segments} />
        </p>
      )

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag id={id} className={cn('prose-reading my-[0.8em] space-y-1 pl-6', block.ordered ? 'list-decimal' : 'list-disc')}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Segments segments={item} />
            </li>
          ))}
        </Tag>
      )
    }

    case 'equation':
      /*
       * Displayed as its LaTeX rather than typeset, and this is the one place
       * this app knowingly shows markup.
       *
       * The reader this was rebuilt from used KaTeX, and that was right for a
       * thesis full of maths. Not one of the twenty-two `.tex` files in this
       * roadmap contains a single `$` — measured, not assumed — so shipping a
       * typesetting library and its stylesheet would spend the page's whole
       * load budget on a case that does not occur. Showing the source is honest
       * about it: nobody can mistake `\frac{a}{b}` in a monospace box for a
       * rendered fraction, whereas a silently dropped equation would look like
       * a paper with a gap in it. `parse.ts` keeps the raw LaTeX on the block,
       * so the day a paper here has maths in it this is the one branch that
       * grows a call.
       */
      return (
        <div
          id={id}
          className="my-4 overflow-x-auto border-l-2 border-[var(--paper-edge)] py-1 pl-3 font-mono text-[0.88em] whitespace-pre"
        >
          {block.latex}
        </div>
      )

    case 'verbatim':
      /* Its own scroller, never the document's: code does not reflow, and a
         paper with one wide listing must not become a paper you read by
         dragging sideways. `overflow-wrap` is deliberately left alone here —
         breaking a line of code at an arbitrary column changes what it appears
         to say. */
      return (
        <pre
          id={id}
          className="my-4 overflow-x-auto rounded-md border border-[var(--paper-edge)] bg-[var(--code-bg)] p-3 font-mono text-[0.82em] leading-relaxed [overflow-wrap:normal]"
        >
          {block.raw}
        </pre>
      )

    case 'figure':
      return (
        <figure id={id} className="my-6">
          {block.graphics.map((graphic) => (
            <Graphic key={graphic} epic={epic} file={graphic} />
          ))}
          {block.caption.length > 0 && (
            <figcaption className="mt-2 text-[0.85em] leading-snug text-[var(--paper-muted)]">
              <Segments segments={block.caption} />
            </figcaption>
          )}
        </figure>
      )

    case 'table':
      return (
        <figure id={id} className="my-6">
          {block.grid ? (
            <div className="overflow-x-auto rounded-md border border-[var(--paper-edge)]">
              <table className="w-full min-w-full border-collapse text-[0.9em] leading-snug">
                <tbody>
                  {block.grid.rows.map((row, ri) => (
                    <tr key={ri} className={cn(row.ruleAbove && ri > 0 && 'border-t border-[var(--paper-edge)]')}>
                      {row.cells.map((cell, ci) => {
                        const Cell = row.isHeader ? 'th' : 'td'
                        return (
                          <Cell
                            key={ci}
                            colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                            style={{ textAlign: cell.align }}
                            className={cn('px-2.5 py-1.5 align-top', row.isHeader && 'font-semibold')}
                          >
                            <Segments segments={cell.segments} />
                          </Cell>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            /* The parser refused to guess at an irregular body, and this shows
               what it refused to guess at. A confidently wrong table is worse
               than a listing somebody can read for themselves. */
            <pre className="overflow-x-auto rounded-md border border-[var(--paper-edge)] bg-[var(--code-bg)] p-3 font-mono text-[0.8em] [overflow-wrap:normal]">
              {block.raw}
            </pre>
          )}
          {block.caption.length > 0 && (
            <figcaption className="mt-2 text-[0.85em] leading-snug text-[var(--paper-muted)]">
              <Segments segments={block.caption} />
            </figcaption>
          )}
        </figure>
      )

    case 'comment': {
      /*
       * A comment run the author left in the source, which in these papers
       * carries the reasoning behind the section under it.
       *
       * It stays in the flow, set apart by a rule and the muted colour so
       * nobody mistakes it for prose. It used to leave a `%` pin here and send
       * its words to a card in the margin rail; the rail is gone and the words
       * stayed, which is the half of that arrangement worth keeping.
       *
       * `pre-wrap` keeps the author's own line breaks, which is the point of
       * showing a comment at all — and it does NOT break a run with no spaces
       * in it. Every roadmap paper's comments are prose, so that never showed;
       * the thesis opens its files with `% ===============…` banner rules sixty
       * characters wide, and without `anywhere` one of those widens the sheet.
       */
      return (
        <div id={id} className="my-[0.8em]">
          <span className="block border-l-2 border-[var(--paper-edge)] pl-3 text-[0.88em] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-[var(--paper-muted)]">
            {block.text}
          </span>
        </div>
      )
    }

    case 'unknown':
      return (
        <pre
          id={id}
          className="my-4 overflow-x-auto rounded-md border border-[var(--paper-edge)] bg-[var(--code-bg)] p-3 font-mono text-[0.8em] [overflow-wrap:normal]"
        >
          {block.raw}
        </pre>
      )

    default:
      /* `preamble`, `structure` and `include` never reach here: `pages.ts`
         filters them out before a sheet is packed, so that pagination and the
         page agree about what is on it. */
      return null
  }
}


/**
 * The raster image types this page will ASK for.
 *
 * Deliberately the same list as `IMAGE_TYPES` in `store.ts`, and deliberately a
 * second copy of it rather than an import: importing would drag `store.ts` —
 * and with it `node:fs` — into the browser bundle, which is the failure mode
 * this codebase has hit before and which neither `tsc` nor `bun test` can see.
 * The server is the authority; this list only decides whether to render an
 * `<img>` at all, and being wrong about it costs a fallback box rather than a
 * broken picture.
 */
const DRAWABLE = /\.(png|jpe?g|gif|webp)$/i

/**
 * One `\includegraphics` target, as a picture when it can be one.
 *
 * Three states and all three are visible:
 *
 *  - A raster the server will serve: an `<img>`, with the filename underneath
 *    in the same monospace it always had, because a reader comparing the page
 *    to the source still needs to know which file this is.
 *  - A PDF or an SVG: the filename box, unchanged, because the server refuses
 *    those on purpose — see the essay on `IMAGE_TYPES`. The thesis on this
 *    machine has one PDF figure, so this branch is live rather than theoretical.
 *  - A raster that failed to load: the box, via `onError`. A broken-image glyph
 *    with no explanation is the one outcome worth ruling out, because it looks
 *    like the reader's browser is broken rather than like the file is missing.
 */
function Graphic({ epic, file }: { epic: string; file: string }) {
  const [failed, setFailed] = useState(false)
  const box = (
    <div className="rounded-md border border-dashed border-[var(--paper-edge)] px-3 py-4 text-center font-mono text-[0.8em] break-all text-[var(--paper-muted)]">
      figure: {file}
    </div>
  )
  if (failed || !DRAWABLE.test(file)) return box
  return (
    <div className="flex flex-col items-center gap-1">
      <img
        /* Built by `apiUrl` rather than by hand, because a figure is confined
           to its paper's root and there is no root without a project. This URL
           is the one place on the page where forgetting that would not look
           like a missing project: it would look like every image in the paper
           being broken, with the prose around them perfectly correct. */
        src={apiUrl('/api/figure', { epic, file })}
        alt={file}
        loading="lazy"
        onError={() => setFailed(true)}
        /* `max-w-full` and an `auto` height so a 1400px-wide plot in a 220px
           container scales instead of pushing the whole column sideways. Horizontal
           overflow in a reading view is the bug this container is measured for. */
        className="h-auto max-w-full rounded-md border border-[var(--paper-edge)] bg-white"
      />
      <span className="font-mono text-[0.75em] break-all text-[var(--paper-muted)]">{file}</span>
    </div>
  )
}
