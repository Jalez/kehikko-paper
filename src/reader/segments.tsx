import { createContext, useContext, type ReactNode } from 'react'

import { narrow, whyNot } from '../../latex/edit.ts'
import type { Segment, SegmentStyle } from '../../latex/parse.ts'
import { cn } from '@/lib/utils.ts'

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

/**
 * The byte range of this file that something outside the paper is pointing at.
 *
 * ## A context and not a prop, and the reason is the six call sites
 *
 * A mark has to reach every rendered span: a heading's, a paragraph's, a list
 * item's, a caption's, a table cell's. Threading it as a prop means five
 * signatures in `blocks.tsx` and one in every branch of `BlockBody`, and the
 * failure mode of forgetting one is a passage that highlights in a paragraph
 * and silently does not in a caption — the same shape as the missing
 * `data-src-start` this file's own opening essay warns about.
 *
 * So it is supplied once per block, by `BlockRow`, which is also the only place
 * that knows which FILE the block came out of — and a range means nothing
 * without its file, because `main.tex` and every chapter each have a byte 4120.
 * `BlockRow` resolves that and hands down a range or nothing.
 */
export const Marked = createContext<{ from: number; to: number } | null>(null)

/**
 * Typing in the paper, and the one rule that decides what may be typed into.
 *
 * ## Only a literal span, because that is what `literal` MEANS
 *
 * A literal segment's rendered text is character-identical to
 * `source[srcStart..srcEnd]`, so an offset inside what the reader sees is an
 * offset into the file, and a change to the characters on screen is the same
 * change to the characters on disk. That equivalence is the entire licence for
 * editing in place. A derived segment does not have it: `\autocite{jones}`
 * renders as `[jones]`, five characters standing in for seventeen, and there is
 * no honest way to say which byte a cursor between the `j` and the `o` is
 * sitting on. Typing there and splicing the result into the file would produce
 * markup nobody wrote, in a place nobody was looking at.
 *
 * ## So what happens when the cursor reaches a derived span
 *
 * It is refused entry, and this is the decision written down rather than left
 * to be inferred. Three options were on the table:
 *
 *  - **Refuse to enter it** — the caret cannot go there at all.
 *  - **Select it whole** — pressing it highlights the whole span, so the reader
 *    can see the unit they are being refused.
 *  - **Offer its source form** — reveal `\autocite{jones}` and let them edit
 *    that.
 *
 * The first two are both taken, because they are the same answer at two
 * moments. Only literal spans are `contentEditable`, and a span that is not
 * inside an editing host is a span a browser will not put a caret in — so
 * refusal costs no code and cannot be got round by a keyboard, a drag, or a
 * paste. Pressing one then selects it whole and says why, which is the
 * difference between a refusal and nothing happening.
 *
 * The third is refused on purpose. Revealing source inside rendered prose makes
 * the page show two languages at once, and the reader who edits the revealed
 * `\autocite{jones}` is editing markup — which is a raw-source editor, which is
 * the thing this view exists not to be. `read_source` on the MCP door and the
 * file on disk are both still there for that, and the popover on a selection
 * already says so.
 *
 * ## Why a context, and why it carries the file
 *
 * The same reason `Marked` is one: an editable span is reached through five
 * signatures in `blocks.tsx` and the failure mode of forgetting one is a
 * paragraph that can be typed into and a caption that silently cannot. And the
 * file, because a byte range means nothing without one — `main.tex` and every
 * chapter each have a byte 4120, and an edit sent against the wrong one of them
 * would land in a real place in the wrong document.
 */
export interface Typing {
  /** Which file the segments under this context came out of. */
  file: string
  /**
   * A finished edit of one span. Answers `null` when it landed, or the sentence
   * to show when it did not — at which point the span puts back what was there.
   */
  commit: (edit: { file: string; from: number; to: number; text: string }) => Promise<string | null>
  /** Something to tell the reader: a refusal, or why a span cannot be entered. */
  say: (sentence: string) => void
}

export const Typed = createContext<Typing | null>(null)

/** Whether a segment's source overlaps the marked range. Touching is not overlapping. */
function isMarked(segment: Segment, mark: { from: number; to: number } | null): boolean {
  if (!mark) return false
  return segment.srcStart < mark.to && mark.from < segment.srcEnd
}

/**
 * What the browser did to the text, undone, before it is compared to the file.
 *
 * A `contenteditable` region does not hold exactly what somebody typed. A space
 * at the end of a run, or one typed twice, comes back as U+00A0 — a no-break
 * space — because that is how a browser stops collapsing whitespace it has been
 * asked to preserve. Written through to the `.tex` file, that is a character
 * the author never typed, invisible in every editor, and different from the
 * space beside it in ways LaTeX cares about.
 *
 * So it is turned back into a space. That is a transformation of what somebody
 * typed, which this file otherwise refuses to do — see `whyNot`, which refuses
 * rather than escapes — and the difference is that this is not an
 * interpretation of their intent. It is the removal of a character the editing
 * surface inserted on its own behalf. Somebody who genuinely wants a no-break
 * space in their LaTeX writes `~`, which is on the refused list precisely
 * because it is markup.
 */
export function asTyped(text: string): string {
  /* Written as an escape rather than as the character itself, because a
     no-break space in a source file is indistinguishable from a space to
     everybody who reads that line, which is most of why it is worth keeping
     out of somebody's thesis. */
  return text.replace(/\u00a0/g, ' ')
}

function styled(
  segment: Segment,
  key: string,
  mark: { from: number; to: number } | null,
  typing: Typing | null,
): ReactNode {
  let node: ReactNode = segment.text
  for (const style of NESTING) {
    if (!segment.styles.includes(style)) continue
    const spec = INLINE[style]
    const Tag = spec.tag
    node = <Tag className={spec.className}>{node}</Tag>
  }
  const marked = isMarked(segment, mark)
  /* Only a literal span is typeable, and the whole argument is on `Typing`. */
  const editable = typing !== null && segment.literal

  /**
   * A finished edit of this span, narrowed to what actually changed.
   *
   * `narrow` is where the arithmetic is and it is a pure function with its own
   * tests, because this is the line that decides which bytes of somebody's
   * thesis get replaced. What it returns is relative to the span; the span's
   * own `srcStart` puts it in the file.
   *
   * Nothing is sent when nothing changed, which is the ordinary case: a reader
   * who clicks into a sentence, reads it and clicks away has made no edit, and
   * a write that rewrote the same bytes would move the file's mtime and
   * invalidate every other reader's hash for nothing.
   *
   * A refusal puts the original text back into the element. It has to be done
   * by hand rather than left to React: React's last-rendered value for this
   * child is still `segment.text`, so from its point of view nothing changed
   * and there is no re-render that would restore it. A span left holding text
   * that is not in the file is the page telling the reader their correction
   * landed when it did not — which is the failure this whole feature is most
   * able to commit.
   */
  const finish = (element: HTMLElement) => {
    if (!typing) return
    const after = asTyped(element.textContent ?? '')
    const change = narrow(segment.text, after)
    if (!change) {
      /* Not even a restore: the text is already what it was, and writing to the
         DOM here would move the caret of somebody who has not finished. */
      return
    }
    const put = () => {
      element.textContent = segment.text
    }
    /* Checked here as well as at the door, so the sentence appears under the
       reader's cursor instead of after a round trip. `whyNot` is the same
       function the server runs — one rule, imported twice, rather than two
       copies that can disagree about whether a per cent sign is markup. */
    const refused = whyNot(change.text)
    if (refused) {
      put()
      typing.say(refused)
      return
    }
    void typing
      .commit({
        file: typing.file,
        from: segment.srcStart + change.at,
        to: segment.srcStart + change.upto,
        text: change.text,
      })
      .then((why) => {
        if (!why) return
        put()
        typing.say(why)
      })
  }

  return (
    <span
      key={key}
      data-src-start={segment.srcStart}
      data-src-end={segment.srcEnd}
      data-literal={segment.literal ? '1' : '0'}
      /* Readable from the outside, so "did the right words get marked" is a
         thing a probe can answer by measuring rather than by looking at a
         picture of a page. `data-editable` is here for the same reason, and it
         is the one property of this feature a test without a browser can
         actually assert: which spans a reader is allowed to type into. */
      data-marked={marked ? '1' : undefined}
      data-editable={typing === null ? undefined : editable ? '1' : '0'}
      contentEditable={editable ? true : undefined}
      /* React warns about a `contentEditable` element with children, because it
         cannot see what the browser does to them. That is exactly the
         arrangement here and it is deliberate: React never re-renders this
         subtree while it is being typed in — the props do not change — and
         after a commit the paper is re-read and every span is rebuilt from the
         file. */
      suppressContentEditableWarning={editable ? true : undefined}
      spellCheck={editable ? true : undefined}
      onBlur={editable ? (event) => finish(event.currentTarget) : undefined}
      onKeyDown={
        editable
          ? (event) => {
              if (event.key === 'Enter') {
                /* Enter commits rather than breaking the line. A blank line in
                   LaTeX ends a paragraph, and `whyNot` refuses line breaks for
                   that reason — so the key that would produce one is given the
                   meaning somebody actually wants from it here. */
                event.preventDefault()
                event.currentTarget.blur()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.currentTarget.textContent = segment.text
                event.currentTarget.blur()
              }
            }
          : undefined
      }
      onMouseDown={
        typing && !editable
          ? (event) => {
              /*
               * A derived span, pressed while the paper is editable: selected
               * whole, and said out loud.
               *
               * The caret cannot enter it — it is not in an editing host — so
               * without this the press does nothing at all, which reads as the
               * page being broken rather than as a rule. Selecting the span is
               * the honest unit: it is exactly the range a passage touching
               * this span already snaps to, in `lib/selection.ts`.
               */
              event.preventDefault()
              const selection = window.getSelection()
              selection?.removeAllRanges()
              const range = document.createRange()
              range.selectNodeContents(event.currentTarget)
              selection?.addRange(range)
              typing.say(
                'That is not what the source says — it is what this reader makes of it, so there is no place in '
                  + 'the file for a cursor inside it. Edit the .tex to change it.',
              )
            }
          : undefined
      }
      title={
        typing && !editable
          ? 'This is a rendering of the source rather than the source, so it cannot be typed into.'
          : undefined
      }
      className={cn(
        marked && 'passage-mark',
        typing !== null && (editable ? 'typeable' : 'not-typeable'),
      )}
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
  const mark = useContext(Marked)
  const typing = useContext(Typed)
  return <>{coalesce(withoutNotes(segments)).map((s, i) => styled(stripPin(s), String(i), mark, typing))}</>
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
