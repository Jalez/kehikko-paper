/**
 * The arithmetic that turns "somebody typed in the reading view" into a byte
 * range and a replacement, and the rules about what may be written.
 *
 * ## Why this is a file of pure functions with no filesystem in it
 *
 * `store.ts` holds the write. This holds every decision the write depends on,
 * because each one is a place where being confidently wrong corrupts somebody's
 * thesis silently — and none of them needs a disk, a browser or a host to be
 * asserted. The client imports this too: the check that refuses a `%` has to
 * say so under the reader's cursor rather than only after a round trip, and two
 * spellings of that rule is how one of them ends up disagreeing with the other.
 * The SERVER's copy is the one that decides; this is the same function, so the
 * page can predict its answer instead of guessing at it.
 *
 * ## The one thing every function here is careful about
 *
 * `Segment.literal` means the rendered text is character-identical to
 * `source[srcStart..srcEnd]`. That is the whole licence for editing in place:
 * on a literal span, an offset inside what you SEE is an offset into the file.
 * Everything below assumes it has been checked and nothing below can check it,
 * which is why `segments.tsx` makes only literal spans editable at all and why
 * `store.ts` refuses a range whose ends are not where it was told they are.
 */

/**
 * How many UTF-8 bytes a string of rendered text is.
 *
 * The fourth copy of this arithmetic in the family — `byteOffsets` in
 * `parse.ts`, `bytesOf` in `src/lib/selection.ts`, and the same three cases in
 * the notes module — and it is written the same way in all of them on purpose,
 * so that nobody has to check whether two programs mean the same thing by "a
 * byte". A surrogate pair is four bytes across two units, counted two per unit,
 * which keeps the running total right without either half claiming the other's.
 */
export function bytesOf(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3
  }
  return bytes
}

/**
 * The characters this door will not write, and why refusing beats escaping.
 *
 * These are LaTeX's ten special characters. Typed into a `.tex` file as
 * themselves they do not mean themselves: `%` comments out the rest of the
 * line, `&` is a column separator, `{` opens a group, `\` starts a command. A
 * reader who types "50% of cases" into a paragraph and gets the rest of that
 * paragraph silently eaten on the next read has been destroyed by this feature
 * rather than helped by it.
 *
 * There are two ways out and only one of them is honest here.
 *
 * **Escape on the way in** — write `\%` for `%` — is what a WYSIWYG editor
 * does, and it is exact in prose: `\%` renders as `%`, always. It is NOT exact
 * anywhere else. Inside `verbatim`, inside a `lstlisting`, inside maths, `\%`
 * is a backslash followed by a per cent sign, or a syntax error. This door
 * replaces a byte range in a file and has no idea which of those it is standing
 * in — the segment knows its styles, not its environment — so an escape rule
 * would be right in the common case and wrong in the cases people put code in.
 * A program that rewrites what somebody typed had better be right every time.
 *
 * **Refuse** is the same answer in every context, it is visible immediately,
 * and the thing it asks for — open the file and write the markup you meant — is
 * the thing this module has always told people to do. So a special character is
 * a sentence, not a silent transformation.
 *
 * The backslash is in the list for the same reason as the rest and for one
 * more: it is how a person would try to type markup into a view that is not
 * showing them markup, and markup typed into rendered prose is the exact case
 * where what appears on screen afterwards will not be what they wrote.
 */
const SPECIAL = new Set(['\\', '{', '}', '$', '&', '#', '^', '_', '~', '%'])

/**
 * As much as one edit may write.
 *
 * A bound and not a budget, for the reason `MAX_TEX_BYTES` gives in `store.ts`:
 * the caller is whatever on this machine found the port. A paste of a whole
 * document into one span is not a correction to a sentence, and a door that
 * would accept it is a door that can be asked to rewrite a chapter through a
 * hole meant for a typo.
 */
export const MAX_EDIT_BYTES = 20_000

/**
 * Why this text may not be written, or `null` when it may.
 *
 * A sentence rather than a code, because it goes on screen under somebody's
 * cursor and in an HTTP refusal, and both readers are the same person.
 */
export function whyNot(text: string): string | null {
  if (bytesOf(text) > MAX_EDIT_BYTES) {
    return `That is more than ${MAX_EDIT_BYTES} bytes to write into one span. Edit the .tex file for a change that size.`
  }
  for (const character of text) {
    if (SPECIAL.has(character)) {
      return `“${character}” is LaTeX markup rather than a letter, so it is not written from here — it would change what the source means rather than what it says. Edit the .tex file to write markup.`
    }
    const code = character.codePointAt(0) ?? 0
    /*
     * Newlines are refused with the control characters and they are the
     * interesting member of the set. A single newline inside a paragraph is
     * harmless LaTeX; a BLANK one ends the paragraph, and a `contenteditable`
     * span is exactly where a stray Enter comes from. Telling the two apart
     * means knowing what is on either side of the insertion, which is knowledge
     * this function does not have and the span above it does not either. One
     * span is one run of prose: Enter commits it, and it never writes a line
     * break.
     */
    if (code < 0x20 || code === 0x7f) {
      return 'A line break or a control character is not written from here. One span is one run of prose; press Enter to commit it.'
    }
  }
  return null
}

/**
 * The smallest edit that turns `before` into `after`.
 *
 * ## Why the whole span is not simply written back
 *
 * It would be correct and it would be needlessly destructive. Every passage and
 * every note anchored below an edit moves by the change in length — see the
 * essay in `store.ts` — but an anchor INSIDE the replaced range is worse off
 * than that: it named bytes that have been rewritten, and there is no honest
 * place to put it. Rewriting a whole paragraph-sized literal span because
 * somebody fixed one letter would put every anchor in that paragraph inside the
 * replaced range for no reason. Narrowing to the differing middle keeps the
 * damage to the characters that actually changed.
 *
 * ## Prefix and suffix, and the surrogate pair that would break both
 *
 * The common prefix and the common suffix are found in UTF-16 units and then
 * backed off so that neither can end BETWEEN the halves of a surrogate pair.
 * Splitting one produces a lone surrogate on each side of the cut, and a lone
 * surrogate encoded to UTF-8 is a replacement character written into somebody's
 * file where an emoji used to be — one of the few ways this door could damage
 * text it was not even asked to touch.
 *
 * ## The offsets are RENDERED units, and they used to be bytes
 *
 * They were bytes into the span's source, which was right while a span was one
 * literal segment: rendered text and source were the same characters, so one
 * addition to `srcStart` finished the job. A span on screen is a MERGED run now
 * — words and the collapsed whitespace between them — and inside such a run
 * there is no constant offset between what is rendered and what is on disk.
 *
 * So this answers in the only units it can honestly measure, UTF-16 units of
 * the rendered text it was given, and `place` maps them onto the file through
 * the pieces the run was built from. Splitting the two apart is what let a
 * paragraph become editable without any of the arithmetic becoming a guess.
 *
 * `null` when nothing changed, which is the ordinary answer: a reader who
 * clicks into a span, looks at it and clicks away has made no edit, and a door
 * that wrote a no-op would rewrite the file's mtime, wake every watcher on it,
 * and invalidate every other reader's hash for nothing.
 */
export interface Narrowed {
  /** Rendered offset within the span where the replacement begins, in UTF-16 units. */
  at: number
  /** Rendered offset where it ends. Equal to `at` for an insertion. */
  upto: number
  /** What goes there. Empty for a deletion. */
  text: string
}

export function narrow(before: string, after: string): Narrowed | null {
  if (before === after) return null

  const limit = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1
  /* Never between the halves of a pair: a high surrogate at the end of the
     agreed prefix is only agreed if its low half is too, and if it is then the
     loop above already took both. Stepping back one unit when the last agreed
     unit is a HIGH surrogate is the whole of the correction. */
  if (prefix > 0 && isHigh(before.charCodeAt(prefix - 1))) prefix -= 1

  let suffix = 0
  const room = Math.min(before.length - prefix, after.length - prefix)
  while (
    suffix < room &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1
  }
  /* The mirror of the correction above: the first unit of the agreed suffix
     must not be a LOW surrogate whose high half is outside it. */
  if (suffix > 0 && isLow(before.charCodeAt(before.length - suffix))) suffix -= 1

  return { at: prefix, upto: before.length - suffix, text: after.slice(prefix, after.length - suffix) }
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/**
 * One of the segments a rendered run was merged from.
 *
 * Structurally a `Segment` from the parser, spelled here as the three fields
 * this file actually reads so that nothing in the write path has to import the
 * parser's types — and so that a test can hand it a piece by hand.
 */
export interface Piece {
  text: string
  srcStart: number
  srcEnd: number
  literal: boolean
  gap?: boolean
}

/** A rendered range placed onto the file, or the sentence saying why it was not. */
export type Placed = { from: number; to: number; text: string } | { why: string }

/**
 * Turn a change in what the reader SEES into a change in the file.
 *
 * ## The flag that was doing two jobs
 *
 * `Segment.literal` means "the rendered characters of this segment are
 * character-identical to its source range". It is a claim about MAPPING, it is
 * what `lib/selection.ts` reads in order never to fabricate an offset, and the
 * essay defending it is right. Editability was hung off the same flag, and that
 * was the mistake: "you may not type here" is a different claim from "an offset
 * inside this does not correspond to an offset in the file".
 *
 * The two come apart exactly in ordinary prose. `coalesce` merges a paragraph's
 * words and the collapsed whitespace between them into one run, because they
 * share their styles and drawing them separately would put three chips of
 * padding through the middle of `gh#111`. One non-contiguous join in that run —
 * every hard wrap is one — turned the whole paragraph non-literal, correctly,
 * and locked it. Measured on the real thesis: 100% of heading characters
 * typeable against 1% of paragraph characters, which the person using it
 * reported as "so I can edit the titles of sections but not the text itself?"
 *
 * They were right, and the run was never unsafe. It is not one-for-one with its
 * source, and it is still completely writable, because every piece in it is
 * either literal or a `gap` — and a gap's rule inverts.
 *
 * ## What this function does about it
 *
 * It walks the pieces, finds the ones the rendered range lands in, and:
 *
 *  - **Inside a literal piece**, converts the rendered offset to a byte offset
 *    exactly, because inside a literal piece those are the same characters.
 *  - **Inside a gap**, snaps OUTWARD to the whole gap and carries the rendered
 *    text it skipped over into the replacement. That is the whole trick and it
 *    is safe for one reason: the gap's rendered text is a single space, the
 *    space is put back verbatim, and what lands in the file therefore renders as
 *    exactly what the reader is looking at. What is lost is the author's hard
 *    wrap at that one point — a newline becomes a space — which is a change to
 *    the source that is not a change to the document, and is named in the
 *    README rather than hidden.
 *  - **Inside anything else**, refuses the whole edit. A citation snapped
 *    outward the way a gap is would be replaced by its own rendering, so
 *    `\autocite{jones}` would become the seven characters `[jones]` — the file
 *    destroyed on somebody's behalf while they corrected a word two inches
 *    away. This is the branch that must never become clever.
 *
 * ## And it refuses a run that is not contiguous in the source
 *
 * Every piece must begin where the last one ended. A run assembled across a
 * hole — two blocks, two paragraphs, anything `coalesce` should never have
 * merged — has no single source range to replace, and writing one would swallow
 * whatever was in the hole. `coalesce` does not build such a run today; this is
 * the check that means it cannot start to without being caught.
 */
export function place(pieces: readonly Piece[], change: Narrowed): Placed {
  if (!pieces.length) return { why: 'There is nothing there to edit.' }

  for (let i = 1; i < pieces.length; i++) {
    if (pieces[i]!.srcStart !== pieces[i - 1]!.srcEnd) {
      return { why: 'That run of text does not come from one unbroken piece of the file, so it is not written from here.' }
    }
  }

  /* Where each piece starts in the RENDERED text of the run, so a rendered
     offset can be found in it. Built once rather than searched twice. */
  const starts: number[] = []
  let rendered = 0
  for (const piece of pieces) {
    starts.push(rendered)
    rendered += piece.text.length
  }
  if (change.at < 0 || change.upto > rendered || change.upto < change.at) {
    return { why: 'That is not a place in this text.' }
  }

  const found = (offset: number, leaning: 'start' | 'end'): number => {
    /* A boundary between two pieces belongs to the piece the edit is growing
       INTO: the start of a range takes the piece beginning there, the end of a
       range takes the piece ending there. Without the distinction an insertion
       exactly between two words would be attributed to the gap on one side and
       widened over it for nothing. */
    for (let i = pieces.length - 1; i >= 0; i--) {
      const from = starts[i]!
      const to = from + pieces[i]!.text.length
      if (leaning === 'start' ? offset >= from && offset < to : offset > from && offset <= to) return i
    }
    return leaning === 'start' ? pieces.length - 1 : 0
  }

  const first = found(change.at, 'start')
  const last = found(change.upto, 'end')

  let from: number
  let before = ''
  const head = pieces[first]!
  if (head.literal) {
    from = head.srcStart + bytesOf(head.text.slice(0, change.at - starts[first]!))
  } else if (head.gap) {
    from = head.srcStart
    /* The part of the gap the reader did not touch, put back as itself. */
    before = head.text.slice(0, change.at - starts[first]!)
  } else {
    return { why: NOT_SOURCE }
  }

  let to: number
  let after = ''
  const tail = pieces[last]!
  if (tail.literal) {
    to = tail.srcStart + bytesOf(tail.text.slice(0, change.upto - starts[last]!))
  } else if (tail.gap) {
    to = tail.srcEnd
    after = tail.text.slice(change.upto - starts[last]!)
  } else {
    return { why: NOT_SOURCE }
  }

  /* Everything the range passes THROUGH has to be writable too, not only the
     two ends. A selection dragged across a citation and retyped would otherwise
     have honest ends and a destroyed middle. */
  for (let i = first + 1; i < last; i++) {
    const piece = pieces[i]!
    if (!piece.literal && !piece.gap) return { why: NOT_SOURCE }
  }

  /*
   * A range that came out backwards is a bug in the walk above, not an edit.
   *
   * It should not be reachable: `narrow` never returns `upto < at`, and an
   * insertion exactly on a piece boundary resolves to two adjacent pieces whose
   * shared edge makes `from` and `to` the same number. But this is the last
   * line before a byte range leaves for a file somebody is writing, and a
   * negative-length splice would duplicate whatever lay between the two — so it
   * refuses rather than trusting the argument that it cannot happen.
   */
  if (to < from) return { why: 'That edit did not resolve to a place in the file, so nothing was written.' }

  return { from, to, text: before + change.text + after }
}

/**
 * What this program says when somebody edits across a rendering.
 *
 * One string, because it is said in three places — the two ends of a range and
 * the middle — and three spellings of one refusal is how a person learns that a
 * program has three different problems with them.
 */
const NOT_SOURCE =
  'That edit crosses something this reader renders rather than shows — a citation, a reference or an escape. '
  + 'Its source cannot be recovered from what is on screen, so it is not written from here. Edit the .tex to change it.'

/**
 * Whether the source about to be replaced is safe to replace.
 *
 * ## The guard that does not depend on the browser being right
 *
 * Everything above decides what to write from the pieces the PAGE holds. The
 * server holds the file, and it can ask a question the page cannot: what is
 * actually in the bytes being overwritten? Every edit this feature legitimately
 * makes replaces either the inside of a literal run — which by construction
 * holds no LaTeX special character, because the parser breaks a literal run at
 * every one of them — or a run of whitespace. So no legitimate edit ever
 * overwrites a `\`, a `{`, a `%` or an `&`.
 *
 * Which makes this a complete, cheap, server-side answer to the worst thing
 * this door could do. A page with a bug, an agent that guessed, a request
 * replayed with the numbers changed: none of them can delete a command, a
 * citation, an escape or a comment, whatever they claim about the range,
 * because the door looks at what is there before it writes.
 *
 * Whitespace is deliberately allowed on this side and refused on the other.
 * `whyNot` will not let a newline be WRITTEN, because a blank line ends a
 * paragraph; a newline being replaced is the ordinary case — it is the hard
 * wrap in the middle of somebody's sentence.
 */
export function sourceRefuses(source: string): string | null {
  for (const character of source) {
    if (SPECIAL.has(character)) {
      return `That range covers “${character}”, which is LaTeX markup rather than text, so it is not overwritten from here.`
    }
  }
  return null
}

/**
 * Whether a byte offset falls on the start of a UTF-8 character.
 *
 * The last fence before the splice. Every offset this module produces is
 * already on a boundary — `parse.ts` derives them from a table of character
 * starts — but the number that arrives at the door came over the wire from a
 * browser, and a range that cuts an `ä` in half writes two half-characters into
 * a file that had none. `0b10xxxxxx` is a continuation byte and nothing may
 * begin there; the end of the buffer is a boundary, because a range may finish
 * at the end of the file.
 */
export function onBoundary(bytes: Uint8Array, at: number): boolean {
  if (at < 0 || at > bytes.length) return false
  if (at === bytes.length) return true
  return (bytes[at]! & 0xc0) !== 0x80
}

/**
 * How many UTF-16 units of `text` the first `bytes` bytes of it are.
 *
 * The inverse of `bytesOf`, and it refuses rather than rounds. A byte count
 * that lands in the middle of a character — the second byte of an `ä`, or
 * between the halves of a surrogate pair — does not name a place in the
 * rendered text, and the only two things to do about it are to guess at the
 * nearest boundary or to say so. It says so: this feeds the code that DRAWS a
 * proposed change, and a drawing that snapped to the nearest character would
 * paint the letter beside the one that is actually changing.
 */
function unitsIn(text: string, bytes: number): number | null {
  if (bytes === 0) return 0
  if (bytes < 0) return null
  let seen = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    seen += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3
    /* A stop after the HIGH half of a pair is two bytes into a four-byte
       character, which is exactly the cut `narrow` backs away from at the other
       end of this journey. */
    if (seen === bytes) return isHigh(code) ? null : i + 1
    if (seen > bytes) return null
  }
  return null
}

/**
 * A byte range of the file, found in the rendered text of one run.
 *
 * ## The inverse of `place`, and it is held to the same rule
 *
 * `place` turns "somebody typed here" into bytes. This turns "somebody proposed
 * a change to these bytes" into a place in what is on screen, so the change can
 * be drawn where it happens rather than described in a panel beside the paper.
 *
 * The honesty rule is identical and is not softened because this only draws.
 * Inside a literal piece the mapping is exact, because those are the same
 * characters. Inside a `gap` it snaps OUTWARD to the whole gap, for the same
 * reason `place` does: the gap's rendered text is one space standing for a
 * whole run of source whitespace, so there is no offset inside it that means
 * anything, and the honest unit is all of it. Anything else refuses.
 *
 * The temptation to soften it is real and worth naming. A proposal overlapping
 * `\autocite{jones}` COULD be drawn — strike the seven characters `[jones]` and
 * put the new text beside them — and it would be a lie, because those are not
 * the bytes being removed. A person approving that would be approving one thing
 * having read another, which is the single failure this whole feature exists to
 * prevent. Two doors upstream `sourceRefuses` already refuses to STORE such a
 * proposal; this is the second fence, and it is here so that the drawing does
 * not depend on the door having been right.
 *
 * The range is clamped to the run, so a proposal spanning three runs asks each
 * of them separately and each answers about its own share.
 */
export function renderedRange(
  pieces: readonly Piece[],
  from: number,
  to: number,
): { at: number; upto: number } | { why: string } {
  if (!pieces.length) return { why: 'There is nothing there to draw.' }
  for (let i = 1; i < pieces.length; i++) {
    if (pieces[i]!.srcStart !== pieces[i - 1]!.srcEnd) {
      return { why: 'That run of text does not come from one unbroken piece of the file.' }
    }
  }

  const starts: number[] = []
  let rendered = 0
  for (const piece of pieces) {
    starts.push(rendered)
    rendered += piece.text.length
  }

  const head = pieces[0]!
  const tail = pieces[pieces.length - 1]!
  const wantFrom = Math.max(from, head.srcStart)
  const wantTo = Math.min(to, tail.srcEnd)
  if (wantTo < wantFrom) return { why: 'That range is not in this run.' }

  /*
   * Which piece a byte offset belongs to, leaning the way `place` leans: the
   * start of a range takes the piece beginning there and the end takes the
   * piece ending there, so a range that stops exactly on a boundary is not
   * widened over the piece on the far side of it for nothing.
   */
  const found = (offset: number, leaning: 'start' | 'end'): number => {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const piece = pieces[i]!
      if (
        leaning === 'start'
          ? offset >= piece.srcStart && offset < piece.srcEnd
          : offset > piece.srcStart && offset <= piece.srcEnd
      ) {
        return i
      }
    }
    return leaning === 'start' ? pieces.length - 1 : 0
  }

  const first = found(wantFrom, 'start')
  const last = found(wantTo, 'end')

  let at: number
  const opening = pieces[first]!
  if (opening.literal) {
    const units = unitsIn(opening.text, wantFrom - opening.srcStart)
    if (units === null) return { why: NOT_A_PLACE }
    at = starts[first]! + units
  } else if (opening.gap) {
    at = starts[first]!
  } else {
    return { why: NOT_SOURCE }
  }

  let upto: number
  const closing = pieces[last]!
  if (closing.literal) {
    const units = unitsIn(closing.text, wantTo - closing.srcStart)
    if (units === null) return { why: NOT_A_PLACE }
    upto = starts[last]! + units
  } else if (closing.gap) {
    upto = starts[last]! + closing.text.length
  } else {
    return { why: NOT_SOURCE }
  }

  /* Everything the range passes THROUGH, exactly as in `place`. A range with
     honest ends and a citation in the middle would be drawn as a change to the
     words either side of a citation that is also being replaced, with nothing
     on screen saying so. */
  for (let i = first + 1; i < last; i++) {
    const piece = pieces[i]!
    if (!piece.literal && !piece.gap) return { why: NOT_SOURCE }
  }

  if (upto < at) return { why: 'That range did not resolve to a place in this run.' }
  return { at, upto }
}

const NOT_A_PLACE =
  'That range begins or ends inside a character rather than between two, so there is no place on screen to draw it.'
