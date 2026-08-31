import { useState } from 'react'

import type { Block } from '../../latex/parse.ts'
import type { PlacedBlock } from '../../store.ts'
import { cn } from '@/lib/utils.ts'
import { Marked, Segments } from './segments.tsx'

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

/**
 * The anchor for a block, and why it is not just the block's id.
 *
 * The parser numbers blocks from 1 within one FILE, and a paper is assembled
 * from a main file plus its chapters — so `heading-3` exists once per chapter
 * and an anchor built from it would send a reader to whichever one the browser
 * found first, which is the earliest one, which is never the one they clicked.
 * Pairing the file with the id makes it unique across the assembled document,
 * and the sanitising is because a filename contains a `/` and a `.`, neither of
 * which can appear in a fragment `querySelector` will accept.
 */
export function anchorId(file: string, id: string): string {
  return `b-${`${file}-${id}`.replace(/[^a-zA-Z0-9-]+/g, '-')}`
}

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
  mark?: { from: number; to: number } | null
}

export function BlockRow({ block, epic, mark = null }: BlockProps) {
  /* Narrowed to this block before it is supplied. A block the mark does not
     touch gets `null`, which is the same value every unmarked block gets, so
     the context does not change identity for the whole page every time one
     paragraph is highlighted. */
  const here = mark && block.srcStart < mark.to && mark.from < block.srcEnd ? mark : null
  return (
    <div
      className="block-row group relative"
      data-block-id={anchorId(block.file, block.id)}
      data-marked={here ? '1' : undefined}
    >
      <div
        aria-hidden
        className="gutter-tag pointer-events-none absolute top-[0.4em] -left-11 w-9 text-right"
        title={`${block.kind} · bytes ${block.srcStart}–${block.srcEnd}`}
      >
        <span className="gutter-mark">{GUTTER[block.kind]}</span>
      </div>
      <Marked.Provider value={here}>
        <BlockBody block={block} epic={epic} />
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
        src={`/api/figure?epic=${encodeURIComponent(epic)}&file=${encodeURIComponent(file)}`}
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
