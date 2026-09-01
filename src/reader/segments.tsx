import { createContext, useContext, type ReactNode } from 'react'

import { narrow, place, renderedRange, whyNot } from '../../latex/edit.ts'
import type { Segment, SegmentStyle } from '../../latex/parse.ts'
import type { Proposal } from '../../latex/propose.ts'
import { Change, Proposed } from './proposed.tsx'
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
 * A drawn span: one or more segments merged, and the pieces it was made of.
 *
 * The pieces are what let the run be written back without `literal` having to
 * lie. See `coalesce`.
 */
export interface Run extends Segment {
  /** The segments this run was merged from, in source order and contiguous. */
  pieces: Segment[]
  /**
   * Whether a person may type into this run.
   *
   * A DIFFERENT claim from `literal`, and separating the two is the whole of
   * this pass — see the essay below.
   */
  typeable: boolean
}

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
 *
 * ## `literal` stays exactly as it was, and `typeable` is the new claim
 *
 * All of the paragraph above is unchanged and still true. What changed is that
 * something else was being read off `literal` that was never in it.
 *
 * Editability was hung on this flag, and in ordinary prose it locked
 * everything. The gaps between words are their own segments — a hard wrap in
 * the source collapsing to one rendered space — and they carry the same styles
 * as the words either side, so a whole paragraph merges into one run and the
 * single non-contiguous join flips it non-literal. A heading is one short
 * segment with no collapsed whitespace in it, so it survived. Measured on the
 * real thesis with `dev/typeable.probe.ts`: headings 100% typeable, paragraphs
 * 1%. The person editing said the only useful thing about it — "so I can edit
 * the titles of sections but not the text itself? Why would I ever want this
 * setup?"
 *
 * One flag was doing two jobs. `literal` is a claim about MAPPING: an offset
 * inside the rendered text is an offset in the file, which is what
 * `lib/selection.ts` needs and must never be told wrongly. "You may type here"
 * is a claim about WRITING BACK: replacing this run's source span reproduces
 * what the person now sees. A paragraph with collapsed whitespace fails the
 * first and passes the second, and there is no contradiction in that.
 *
 * So the merged run keeps `literal` computed exactly as before, and carries
 * `pieces` — the segments it came from — plus `typeable`, which is true when
 * every piece is either literal or a `gap`. `latex/edit.ts`'s `place` walks
 * those pieces to turn what somebody typed into a byte range, exactly inside a
 * literal piece and snapped over a gap. A citation is neither, so a run holding
 * one is not typeable and nothing about it has changed.
 */
export function coalesce(segments: readonly Segment[]): Run[] {
  const out: Run[] = []
  for (const segment of segments) {
    const last = out[out.length - 1]
    const same =
      last &&
      last.styles.length === segment.styles.length &&
      last.styles.every((style, i) => segment.styles[i] === style)
    /*
     * Merging happens for one of two reasons, and only one of them survives an
     * unwritable segment.
     *
     * The VISUAL reason is the original one and it is about styles: a `code`
     * run split in three draws three chips with three lots of padding, so
     * `gh#111` must be one element even though the `#` in the middle is a
     * derived escape. That reason applies whatever the pieces are, so a styled
     * run merges exactly as it always did and comes out untypeable.
     *
     * The EDITING reason applies to unstyled prose, where merging costs nothing
     * visually — adjacent bare `<span>`s draw identically to one — and buys a
     * paragraph-sized editing host instead of one per word. There, a segment
     * that cannot be written BREAKS the run rather than poisoning it.
     *
     * That distinction is worth 33,394 characters on the real thesis. There are
     * exactly 125 unstyled unwritable segments in the whole document — 82 `~`,
     * 17 `\%`, and 26 smart quotes — and under the old rule each one made its
     * entire paragraph untypeable. Breaking instead leaves 125 single-character
     * runs that say what they are, and the prose around them editable. The
     * escapes themselves stay unwritable for the reason they always were:
     * `\%` rendered back as `%` would comment out the rest of the line, and a
     * `~` rendered back as a space is a non-breaking space the author chose.
     *
     * A HOLE in the source breaks an unstyled run for the same reason and is
     * worth another 3,845 characters. `withoutNotes` lifts every `\todo{}` out
     * before this runs, so the segments either side of one no longer meet — and
     * a run assembled across that hole cannot be written, because `place`
     * replaces a single source range and would swallow the note. Poisoning the
     * rest of the paragraph over it was the same mistake one layer along; the
     * paragraph is two typeable runs with the note's place between them.
     */
    const merges =
      same &&
      last &&
      (segment.styles.length > 0 ||
        (last.typeable && writable(segment) && last.srcEnd === segment.srcStart))
    if (merges && last) {
      out[out.length - 1] = {
        ...last,
        text: last.text + segment.text,
        srcEnd: segment.srcEnd,
        literal: last.literal && segment.literal && last.srcEnd === segment.srcStart,
        /* Contiguity is required here too, and for a stronger reason than it is
           required for `literal`: `place` replaces ONE source range, so a run
           assembled across a hole would write over whatever was in the hole. */
        typeable: last.typeable && writable(segment) && last.srcEnd === segment.srcStart,
        pieces: [...last.pieces, segment],
      }
      continue
    }
    out.push({ ...segment, typeable: writable(segment), pieces: [segment] })
  }
  /*
   * A run of nothing but gaps is not offered, and says nothing about itself.
   *
   * It arises between two things that are each their own span — two citations
   * with a space between them — and it is a one-character editing host in the
   * gap between two words. Nobody is trying to correct it, it is too small to
   * put a cursor in, and marking it would draw a "you cannot type here" onto
   * the space between two words. Left untypeable and left silent; `styled` says
   * nothing about a run with no visible content in it.
   */
  return out.map((run) => (run.text.trim() === '' ? { ...run, typeable: false } : run))
}

/**
 * Whether one segment's source can be reproduced from what it renders as.
 *
 * Literal, trivially — the characters are the same characters. A `gap`,
 * because the rule collapsing whitespace to one space inverts: one space
 * written over the whole run renders as one space. Nothing else, and in
 * particular not a derived segment that merely LOOKS like a space, which is
 * what `~` renders as and which is a non-breaking space the author chose. The
 * parser marks the real ones; see the essay on `Segment.gap`.
 */
function writable(segment: Segment): boolean {
  return segment.literal || segment.gap === true
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
 * ## A run whose source can be reproduced from what it shows
 *
 * The rule is not `literal`, and the difference matters enough that `coalesce`
 * carries a whole essay about it. `literal` means the rendered characters ARE
 * the source characters, one for one; it is what `lib/selection.ts` needs, and
 * hanging editing off it locked every paragraph in a hard-wrapped document
 * while leaving its headings editable.
 *
 * What licenses typing is weaker and sufficient: replacing this run's source
 * span reproduces what the person now sees. Ordinary prose qualifies even with
 * its hard wraps collapsed, because the collapsing rule inverts — a run of
 * whitespace draws as one space, and one space written back over the whole run
 * draws as one space. A citation does not qualify: `\autocite{jones}` renders
 * as `[jones]`, seven characters standing in for seventeen, and there is no
 * honest way to say which byte a cursor between the `j` and the `o` is sitting
 * on. Typing there and splicing the result in would produce markup nobody
 * wrote, in a place nobody was looking at.
 *
 * ## So what happens when the cursor reaches one of those
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
 * moments. Only a writable run is `contentEditable`, and a span that is not
 * inside an editing host is a span a browser will not put a caret in — so
 * refusal costs no code and cannot be got round by a keyboard, a drag, or a
 * paste. Pressing one then selects it whole and says why, which is the
 * difference between a refusal and nothing happening.
 *
 * A run holding nothing but whitespace is the exception to the saying-why: it
 * is the gap between two things that are each their own span, nobody is trying
 * to correct it, and a "you cannot type here" drawn onto the space between two
 * words is noise about a thing that was never offered.
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

/**
 * A run with the suggested changes to it drawn in, or `null` for a run nothing
 * is suggested about.
 *
 * ## Held to `place`'s rule, and refusing looks like nothing rather than a lie
 *
 * `renderedRange` is the inverse of `place` and applies the same test: a byte
 * range is drawable inside a literal piece exactly, over a whitespace gap by
 * snapping outward to the whole gap, and nowhere else. A range that reaches
 * anything derived is refused, and this function then draws that run as
 * ordinary prose.
 *
 * That is deliberately a SILENT fallback here, and it is not the whole answer:
 * the control above the block still appears, still carries the change in green
 * and red, and still has to be answered. So a suggestion that cannot be placed
 * in the prose is not lost, it is only not underlined — a reader sees the
 * change and the words it is about, in the right paragraph, in the control.
 * Making the prose lie about which characters are leaving, in order to have
 * drawn something, is the one outcome not on the table.
 *
 * The door refuses most of what would land here before it is ever stored — a
 * proposal must quote prose with no LaTeX special in it — so this is the second
 * fence rather than the first. What still reaches it is the narrow set of
 * things that are markup-free in the source and still derived on screen: a
 * smart quote, an em dash written as three hyphens.
 *
 * ## The added text is drawn once, in the run the change STARTS in
 *
 * A suggestion can span several runs — a paragraph's words and the hard wraps
 * between them are one run, but a citation in the middle of a sentence breaks
 * it into two. Each run strikes through its own share of what is leaving, and
 * only the first one carries what arrives. Putting the replacement in every run
 * it touched would draw it two and three times, which reads as a suggestion to
 * repeat the sentence.
 */
function withProposals(run: Run, proposals: readonly Proposal[]): ReactNode | null {
  if (!proposals.length) return null

  /*
   * The pieces have to still add up to what is on screen.
   *
   * `stripPin` is the one place in this file where text is dropped from a run
   * AFTER `coalesce` recorded the pieces it was built from, so a stripped run's
   * pieces are longer than its text and every offset computed through them
   * lands short by the length of the pin. `place` is protected from that by
   * `stripPin` marking the run untypeable; nothing marks it undrawable, and a
   * suggestion drawn one character to the left is exactly the quiet wrongness
   * this whole feature is supposed to remove. So the invariant is checked here
   * rather than a flag being trusted to have been set.
   */
  let rendered = 0
  for (const piece of run.pieces) rendered += piece.text.length
  if (rendered !== run.text.length) return null

  const here: { at: number; upto: number; proposal: Proposal }[] = []
  for (const proposal of proposals) {
    /* Touching is not overlapping, exactly as `isMarked` has it: a suggestion
       that ends where this run begins is about the run before it. An insertion
       — `from === to` — is the exception, and it belongs to the run it sits
       inside rather than to neither. */
    const insertion = proposal.from === proposal.to
    const touches = insertion
      ? proposal.from >= run.srcStart && proposal.from <= run.srcEnd
      : run.srcStart < proposal.to && proposal.from < run.srcEnd
    if (!touches) continue
    const where = renderedRange(run.pieces, proposal.from, proposal.to)
    if ('why' in where) continue
    here.push({ ...where, proposal })
  }
  if (!here.length) return null

  here.sort((a, b) => a.at - b.at || a.upto - b.upto)

  const out: ReactNode[] = []
  let cursor = 0
  for (const { at, upto, proposal } of here) {
    /*
     * Two suggestions about the same words cannot both be drawn.
     *
     * They can exist — the door files them independently, and only ACCEPTING
     * one drops the other. Drawn on top of each other they would produce a
     * span inside a span with two strike-throughs and two replacements, which
     * says nothing true about either. The second is skipped in the prose; its
     * control is still above the block, so it is still answerable.
     */
    if (at < cursor) continue
    if (at > cursor) out.push(<span key={`t${cursor}`}>{run.text.slice(cursor, at)}</span>)
    const startsHere = proposal.from >= run.srcStart && proposal.from < run.srcEnd
    out.push(
      <Change
        key={proposal.id}
        was={run.text.slice(at, upto)}
        /* Only the run the change starts in carries what arrives. Elsewhere the
           replacement is the empty string, which `diffWords` renders as the
           removal alone — the honest picture of "this part of it leaves". */
        now={startsHere ? proposal.text : ''}
      />,
    )
    cursor = upto
  }
  if (cursor < run.text.length) out.push(<span key={`t${cursor}`}>{run.text.slice(cursor)}</span>)
  return <>{out}</>
}

function styled(
  segment: Run,
  key: string,
  mark: { from: number; to: number } | null,
  typing: Typing | null,
  proposals: readonly Proposal[],
): ReactNode {
  const proposed = withProposals(segment, proposals)
  let node: ReactNode = proposed ?? segment.text
  for (const style of NESTING) {
    if (!segment.styles.includes(style)) continue
    const spec = INLINE[style]
    const Tag = spec.tag
    node = <Tag className={spec.className}>{node}</Tag>
  }
  const marked = isMarked(segment, mark)
  /*
   * `typeable`, and NOT `literal`. The two are different claims and the
   * difference is the whole of `coalesce`'s second essay: a paragraph whose
   * hard wraps have been collapsed is not one-for-one with its source and is
   * still perfectly safe to write back, piece by piece.
   */
  /*
   * And NOT while a suggested change is drawn in it.
   *
   * A `contenteditable` span holding `<del>` and `<ins>` elements is a span
   * whose `textContent` is the old text and the new text run together — so a
   * reader who typed one letter into it would commit a sentence containing
   * both, and `narrow` would faithfully compute the range for it. The run is
   * also, and more simply, not a thing to type into: it is a question waiting
   * for an answer, and the answer is the control above the block.
   */
  const editable = typing !== null && segment.typeable && proposed === null
  /*
   * Whether this run is worth saying anything about when it refuses.
   *
   * A run with no visible content in it is the space between two things, and a
   * "you cannot type here" drawn on the gap between two words is noise about
   * something nobody was trying to edit. It stays untypeable and stays silent.
   */
  const speaks = segment.text.trim() !== ''

  /**
   * A finished edit of this run, narrowed to what changed and placed in the file.
   *
   * Two pure functions with their own tests, because this is the line that
   * decides which bytes of somebody's thesis get replaced. `narrow` says what
   * changed in what the reader SEES; `place` walks the pieces this run was
   * merged from and turns that into a byte range — exactly, inside a literal
   * piece, and snapped over a whitespace gap. It refuses outright rather than
   * guessing when the change reaches anything else.
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
    const where = place(segment.pieces, change)
    if ('why' in where) {
      put()
      typing.say(where.why)
      return
    }
    /* Checked here as well as at the door, so the sentence appears under the
       reader's cursor instead of after a round trip. `whyNot` is the same
       function the server runs — one rule, imported twice, rather than two
       copies that can disagree about whether a per cent sign is markup. It is
       applied to what `place` composed rather than to what `narrow` returned,
       because a snap over a gap adds the space back into the replacement. */
    const refused = whyNot(where.text)
    if (refused) {
      put()
      typing.say(refused)
      return
    }
    void typing.commit({ file: typing.file, from: where.from, to: where.to, text: where.text }).then((why) => {
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
        typing && !editable && speaks
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
      /*
       * Said only about a run with something in it to say it about.
       *
       * This tooltip used to fire across whole paragraphs, because a paragraph
       * with a hard wrap in it was not typeable — and the reader met it as "why
       * is my prose a rendering?" It fires on citations and escapes now, which
       * is what it was written for. The whitespace-only runs it also used to
       * cover are silent, because the gap between two words is not something
       * anybody was trying to edit.
       */
      title={
        typing && !editable && speaks
          ? 'This is a rendering of the source rather than the source, so it cannot be typed into.'
          : undefined
      }
      className={cn(
        marked && 'passage-mark',
        typing !== null && (editable ? 'typeable' : speaks && 'not-typeable'),
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
  const proposals = useContext(Proposed)
  return (
    <>
      {coalesce(withoutNotes(segments)).map((s, i) =>
        styled(stripPin(s), String(i), mark, typing, proposals),
      )}
    </>
  )
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
 *
 * It is marked untypeable for a stronger reason than that. This is the one
 * place where text is dropped from a run AFTER `coalesce` has recorded the
 * pieces it was built from, so the pieces no longer add up to what is on
 * screen and `place` would map every offset in the run short by the length of
 * the pin. Nothing here may be typed into, which was already true — a todonote
 * is filtered out before it reaches this file — and this is the line that keeps
 * it true if one ever escapes the filter.
 */
function stripPin(run: Run): Run {
  if (!run.text.startsWith('◆')) return run
  const text = run.text.replace(/^◆ ?\s*/, '')
  return { ...run, text, literal: false, typeable: false }
}
