import type { ReactNode } from 'react'

import type { Segment, SegmentStyle } from '../../latex/parse.ts'

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
 *
 * ## A todonote is not drawn here at all any more
 *
 * There have been three arrangements and this is the third. First a pin in the
 * text and the words on a card in a margin rail; then, when the rail went, the
 * words inline in the copy-editor's amber, on the reasoning that a note is the
 * author's own words and belongs where the author put them.
 *
 * That reasoning was sound and has been overtaken rather than refuted: the
 * words now have somewhere to live. Notes ingests every `\todo{}` and every
 * `%` run out of the source, anchored to the byte range it sits at, and shows
 * them beside the paper — which is a better home for them than the middle of a
 * sentence, and the thing the user asked for in as many words: "can they be
 * converted into notes so that they are not mixed in with the actual paper
 * paragraphs?"
 *
 * So this file draws the paper. It is not a claim that the annotations do not
 * matter; it is the opposite claim, that they matter enough to be a first-class
 * thing somewhere rather than a coloured aside here. `latex/parse.ts` still
 * PARSES both, unchanged and deliberately — Notes reads exactly what it parses,
 * and a parser that dropped them would leave that module with nothing to read.
 *
 * `stripPin` stays for the same reason it was written: the parser emits `◆` in
 * front of a todonote's text so that a pin can exist, and any segment that
 * escapes the filter below must not put a lone glyph in a sentence.
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
  /* Unreachable, and kept because the type is a `Record` over every style the
     parser can attach — a missing key would be a compile error, and a key that
     is a lie would be worse than one that is never read. `withoutNotes` removes
     these segments before anything gets here; if one ever arrives it should
     look like the prose around it rather than reintroduce a colour scheme this
     module no longer has an argument for. */
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
 *
 * `todo` is outermost, so a `\todo{a \emph{stressed} word}` is one marked run
 * with emphasis inside it rather than two differently-marked pieces.
 */
const NESTING: SegmentStyle[] = ['todo', 'cite', 'ref', 'math', 'quote', 'bold', 'emph', 'code']

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
/**
 * The author's annotations, taken out of the run before anything reads it.
 *
 * One function, used by both `plain` and `Segments`, so that what is DRAWN and
 * what is SEARCHED cannot disagree. They disagreeing is a real bug rather than
 * an untidiness: `roadmap.goto` answers by looking for a reference in the text
 * and then scrolling to the block that holds it, and a reference found only
 * inside a note nobody draws would turn the page to a paragraph with no visible
 * reference in it. This file's own rule about searching rendered text rather
 * than source is the same rule, one layer down.
 */
export function withoutNotes(segments: readonly Segment[]): readonly Segment[] {
  return segments.filter((segment) => !segment.styles.includes('todo'))
}

export function plain(segments: readonly Segment[]): string {
  return withoutNotes(segments)
    .map((s) => s.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export function Segments({ segments }: { segments: readonly Segment[] }) {
  return <>{coalesce(withoutNotes(segments)).map((s, i) => styled(stripPin(s), String(i)))}</>
}

/**
 * The pin glyph, removed from the text it was put in front of.
 *
 * `latex/parse.ts` renders a todonote as `◆` plus the note's words, and its own
 * comment says it does that so a rail has something to point at. There is no
 * rail and no pin now, so the glyph would be a character in the middle of a
 * sentence with nothing to explain it. The segment keeps its offsets, because
 * they still describe where the note came from and `selection.ts` still has to
 * be able to read them; it is marked non-literal, because after this its
 * rendered characters no longer line up with the source one for one.
 */
function stripPin(segment: Segment): Segment {
  if (!segment.text.startsWith('◆')) return segment
  const text = segment.text.replace(/^◆ ?\s*/, '')
  return { ...segment, text, literal: false }
}
