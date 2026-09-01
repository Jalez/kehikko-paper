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
 * text it was not even asked to touch. The offsets it returns are BYTES,
 * relative to the start of `before`, because that is what the span carries and
 * what the file is measured in.
 *
 * `null` when nothing changed, which is the ordinary answer: a reader who
 * clicks into a span, looks at it and clicks away has made no edit, and a door
 * that wrote a no-op would rewrite the file's mtime, wake every watcher on it,
 * and invalidate every other reader's hash for nothing.
 */
export interface Narrowed {
  /** Byte offset within the span where the replacement begins. */
  at: number
  /** Byte offset within the span where it ends. Equal to `at` for an insertion. */
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

  const at = bytesOf(before.slice(0, prefix))
  const upto = bytesOf(before.slice(0, before.length - suffix))
  return { at, upto, text: after.slice(prefix, after.length - suffix) }
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

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
