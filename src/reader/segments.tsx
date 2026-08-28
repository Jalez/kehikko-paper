import { Fragment, type ReactNode } from 'react'

import type { Segment, SegmentStyle } from '../../latex/parse.ts'
import { cn } from '@/lib/utils.ts'
import { runs, type Note } from './notes.ts'

/**
 * Segments to elements, and the two things every span has to carry.
 *
 * Every rendered span keeps `data-src-start`, `data-src-end` and
 * `data-literal`, which is what makes a highlight in the browser answerable in
 * terms of the `.tex` file it came out of. `lib/selection.ts` reads exactly
 * those three attributes and nothing else; dropping them from a span makes that
 * span's text unquotable, silently, which is why they are on every branch here
 * rather than on the ones that seemed to need them.
 *
 * React's escaping does what `textContent` did in the version this replaces: a
 * `<` in a paragraph about generics and an `&` in a URL are text, not markup,
 * and no string out of a `.tex` file is ever handed to `dangerouslySetInnerHTML`.
 * There is no KaTeX here, so there is no branch that would want to.
 */

/** The inline styles the parser can attach, and the element each becomes. */
const INLINE: Record<SegmentStyle, { tag: 'em' | 'strong' | 'code' | 'span' | 'q'; className?: string }> = {
  emph: { tag: 'em' },
  bold: { tag: 'strong', className: 'font-semibold' },
  code: { tag: 'code', className: 'rounded-[3px] bg-[var(--code-bg)] px-1 py-px font-mono text-[0.88em]' },
  cite: { tag: 'span', className: 'text-[0.92em] text-[var(--pencil)]' },
  ref: { tag: 'span', className: 'text-[0.92em] text-[var(--pencil)]' },
  math: { tag: 'span', className: 'mx-[0.05em] font-mono text-[0.92em] text-[var(--pencil)]' },
  quote: { tag: 'q' },
  /* The `todo` style is handled by the run splitter, not here: a todonote is a
     structure the rail cares about rather than an inline decoration. It is in
     this table so the record is exhaustive and so a segment carrying `todo`
     alongside `emph` still gets its emphasis. */
  todo: { tag: 'span' },
}

/**
 * The order styles nest in when a segment carries several.
 *
 * Fixed here rather than taken from the segment's own array, so the same pair
 * always nests the same way: the parser pushes styles in the order it meets
 * them, which depends on how the author wrote the markup, and two paragraphs
 * that render identically must not produce different trees. `<em>` and `<code>`
 * mean different things to a screen reader, so they are nested elements rather
 * than one element with two classes.
 */
const NESTING: SegmentStyle[] = ['cite', 'ref', 'math', 'quote', 'bold', 'emph', 'code']

/**
 * Adjacent segments that are styled identically, merged into one.
 *
 * The parser splits on the source and is right to: `\texttt{gh\##1}` expanded
 * comes back as three segments — `gh`, `#`, `111` — because the escape in the
 * middle is a derived rendering of two characters and the parts either side are
 * not. Every one of them is `code`, and drawn one element each they become
 * three separate chips with three lots of padding, reading as `gh` `#` `111`
 * rather than as `gh#111`.
 *
 * Merged only where the styles are identical, so nothing that renders
 * differently is collapsed. The merged span spans from the first start to the
 * last end and is marked non-literal, because its rendered characters no longer
 * correspond one-for-one to that whole range — which is precisely the thing
 * `selection.ts` must not be lied to about.
 */
function coalesce(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = []
  for (const segment of segments) {
    const last = out[out.length - 1]
    const same =
      last &&
      last.styles.length === segment.styles.length &&
      last.styles.every((style, i) => segment.styles[i] === style)
    if (same && last) {
      out[out.length - 1] = {
        ...last,
        text: last.text + segment.text,
        srcEnd: segment.srcEnd,
        literal: last.literal && segment.literal && last.srcEnd === segment.srcStart,
      }
      continue
    }
    out.push(segment)
  }
  return out
}

function styled(segment: Segment, key: string): ReactNode {
  let node: ReactNode = segment.text
  for (const style of NESTING) {
    if (!segment.styles.includes(style)) continue
    const spec = INLINE[style]
    const Tag = spec.tag
    node = <Tag className={spec.className}>{node}</Tag>
  }
  return (
    <span
      key={key}
      data-src-start={segment.srcStart}
      data-src-end={segment.srcEnd}
      data-literal={segment.literal ? '1' : '0'}
    >
      {node}
    </span>
  )
}

/** Plain text of a run of segments, for a title attribute, a search or a test. */
export function plain(segments: readonly Segment[]): string {
  return segments
    .map((s) => s.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface SegmentsProps {
  file: string
  blockId: string
  segments: readonly Segment[]
  /** Which note is currently lit, by key, or null. */
  lit: string | null
  onNote: (key: string | null) => void
}

/**
 * One run of segments, with its notes split out.
 *
 * Both presentations of a note are emitted: the pin, which is the anchor and is
 * always there, and the note's text inline behind it, which `index.css` hides
 * the moment the pane is wide enough for a rail. Rendering both and letting a
 * container query choose is what keeps this component from having to know how
 * wide it is — and a component that measured its own width would re-render on
 * every drag of the pane, which is the churn the rest of this reader is built
 * to avoid.
 */
export function Segments({ file, blockId, segments, lit, onNote }: SegmentsProps) {
  return (
    <>
      {runs(file, blockId, coalesce(segments)).map((run, i) => {
        const note: Note | null = run.note
        if (!note) return <Fragment key={i}>{run.segments.map((s, j) => styled(s, `${i}-${j}`))}</Fragment>
        return (
          <Fragment key={i}>
            <button
              type="button"
              data-note-key={note.key}
              data-lit={lit === note.key ? 'true' : undefined}
              className="note-pin"
              title={note.text}
              aria-label={`Note: ${note.text}`}
              onMouseEnter={() => onNote(note.key)}
              onMouseLeave={() => onNote(null)}
              onFocus={() => onNote(note.key)}
              onBlur={() => onNote(null)}
              onClick={() => onNote(lit === note.key ? null : note.key)}
            >
              ◆
            </button>
            <span className={cn('note-inline')}>{run.segments.map((s, j) => styled(stripPin(s), `${i}-${j}`))}</span>
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * The pin, removed from the text that follows it.
 *
 * The parser emits the glyph as a derived segment at the head of the note; the
 * pin above is drawn from that same fact and would otherwise be printed twice.
 * The segment keeps its offsets, because they still describe where the note
 * came from and `selection.ts` still has to be able to read them.
 */
function stripPin(segment: Segment): Segment {
  if (!segment.text.startsWith('◆')) return segment
  const text = segment.text.replace(/^◆ ?\s*/, '')
  return { ...segment, text, literal: false }
}
