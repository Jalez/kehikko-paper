import type { Block } from '../../latex/parse.ts'
import type { PlacedBlock } from '../../store.ts'
import { cn } from '@/lib/utils.ts'
import { Segments } from './segments.tsx'

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
 * It is not drawn at all below the pane width where a gutter fits — see
 * `index.css`. Moving it inline would put a `¶` in the reading flow, where it
 * is a character in the argument, which is exactly the confusion it exists to
 * prevent.
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
const HEADING_SIZE = [
  'text-[1.5rem] mt-8 mb-4',
  'text-[1.35rem] mt-8 mb-4',
  'text-[1.15rem] mt-7 mb-3',
  'text-[1.05rem] mt-6 mb-2',
  'text-[1rem] mt-5 mb-2',
  'text-[0.95rem] mt-4 mb-2',
]

export interface BlockProps {
  block: PlacedBlock
  lit: string | null
  onNote: (key: string | null) => void
}

export function BlockRow({ block, lit, onNote }: BlockProps) {
  return (
    <div className="block-row group relative" data-block-id={anchorId(block.file, block.id)}>
      <div
        aria-hidden
        className="gutter-tag pointer-events-none absolute top-[0.4em] -left-11 w-9 text-right"
        title={`${block.kind} · bytes ${block.srcStart}–${block.srcEnd}`}
      >
        <span className="gutter-mark">{GUTTER[block.kind]}</span>
      </div>
      <BlockBody block={block} lit={lit} onNote={onNote} />
    </div>
  )
}

function BlockBody({ block, lit, onNote }: BlockProps) {
  const seg = { file: block.file, blockId: block.id, lit, onNote }
  const id = anchorId(block.file, block.id)

  switch (block.kind) {
    case 'heading': {
      const Tag = HEADING_TAG[Math.min(block.level, HEADING_TAG.length - 1)] ?? 'h3'
      return (
        <Tag id={id} className={cn('prose-reading font-semibold leading-tight', HEADING_SIZE[Math.min(block.level, 5)])}>
          <Segments segments={block.segments} {...seg} />
        </Tag>
      )
    }

    case 'paragraph':
      return (
        <p id={id} className="prose-reading my-[0.8em]">
          <Segments segments={block.segments} {...seg} />
        </p>
      )

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag id={id} className={cn('prose-reading my-[0.8em] space-y-1 pl-6', block.ordered ? 'list-decimal' : 'list-disc')}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Segments segments={item} {...seg} />
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
          className="my-4 overflow-x-auto border-l-2 border-[var(--paper-edge)] py-1 pl-3 font-mono text-[0.82rem] whitespace-pre"
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
          className="my-4 overflow-x-auto rounded-md border border-[var(--paper-edge)] bg-[var(--code-bg)] p-3 font-mono text-[0.78rem] leading-relaxed [overflow-wrap:normal]"
        >
          {block.raw}
        </pre>
      )

    case 'figure':
      return (
        <figure id={id} className="my-6">
          {block.graphics.map((graphic) => (
            /*
             * The filename, in a box, rather than an `<img>`.
             *
             * Serving the image would mean a door that reads arbitrary files
             * out of somebody else's tree and answers them with a guessed
             * content type — the exact hazard `store.ts` spends two fences
             * avoiding, reintroduced for a picture. Naming the file says what
             * is there and where to find it, which is what a reader in a 240px
             * pane can act on anyway.
             */
            <div
              key={graphic}
              className="rounded-md border border-dashed border-[var(--paper-edge)] px-3 py-4 text-center font-mono text-[0.75rem] text-[var(--paper-muted)]"
            >
              figure: {graphic}
            </div>
          ))}
          {block.caption.length > 0 && (
            <figcaption className="mt-2 text-[0.8rem] leading-snug text-[var(--paper-muted)]">
              <Segments segments={block.caption} {...seg} />
            </figcaption>
          )}
        </figure>
      )

    case 'table':
      return (
        <figure id={id} className="my-6">
          {block.grid ? (
            <div className="overflow-x-auto rounded-md border border-[var(--paper-edge)]">
              <table className="w-full min-w-full border-collapse text-[0.85rem] leading-snug">
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
                            <Segments segments={cell.segments} {...seg} />
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
            <pre className="overflow-x-auto rounded-md border border-[var(--paper-edge)] bg-[var(--code-bg)] p-3 font-mono text-[0.75rem] [overflow-wrap:normal]">
              {block.raw}
            </pre>
          )}
          {block.caption.length > 0 && (
            <figcaption className="mt-2 text-[0.8rem] leading-snug text-[var(--paper-muted)]">
              <Segments segments={block.caption} {...seg} />
            </figcaption>
          )}
        </figure>
      )

    case 'comment': {
      /*
       * A comment run the author left in the source, which in these papers
       * carries the reasoning behind the section under it.
       *
       * Where there is a rail it goes there, and what stays in the flow is the
       * pin that anchors it. Where there is not, the text stays here, marked as
       * not-the-argument so nobody mistakes one for prose.
       */
      const key = `${block.file}#${block.id}#comment`
      return (
        <div id={id} className="my-3">
          <button
            type="button"
            data-note-key={key}
            data-lit={lit === key ? 'true' : undefined}
            className="note-pin"
            title={block.text}
            aria-label={`Source comment: ${block.text}`}
            onMouseEnter={() => onNote(key)}
            onMouseLeave={() => onNote(null)}
            onFocus={() => onNote(key)}
            onBlur={() => onNote(null)}
            onClick={() => onNote(lit === key ? null : key)}
          >
            %
          </button>
          <span className="note-inline-block ml-1 border-l-2 border-[var(--paper-edge)] pl-3 text-[0.82rem] leading-relaxed whitespace-pre-wrap text-[var(--paper-muted)]">
            {block.text}
          </span>
        </div>
      )
    }

    case 'unknown':
      return (
        <pre
          id={id}
          className="my-4 overflow-x-auto rounded-md border border-[var(--paper-edge)] bg-[var(--code-bg)] p-3 font-mono text-[0.75rem] [overflow-wrap:normal]"
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
