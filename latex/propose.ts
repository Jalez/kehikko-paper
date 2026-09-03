/**
 * A change somebody has SUGGESTED to a paper, which is a different thing from a
 * change that has been made.
 *
 * ## Why a proposal is a type at all, rather than an edit with a flag on it
 *
 * `Edit` in `store.ts` is a thing the door is being asked to do now. A proposal
 * is a thing an agent thinks ought to happen, sitting in front of a person who
 * has not answered yet. The two differ in every property that matters: an edit
 * has no identity, because it is over as soon as it lands, and a proposal must
 * have one, because it is going to be referred to twice — once to draw it and
 * once to answer it. An edit carries no explanation, because the person making
 * it is the person reading it; a proposal carries a sentence, because it is a
 * suggestion from somebody who is not in the room.
 *
 * And, decisively: an edit is applied against the file it was measured on, in
 * the same breath. A proposal SITS, while the file it was measured against may
 * be edited by the author in a real editor, by another container, or by an
 * earlier proposal being accepted. So it carries `was` — the hash the door
 * already demands — and that is what makes it safe to hold one at all.
 *
 * ## Everything here is pure, and that is where the concurrency rules live
 *
 * `rebase` below is the whole of the answer to "what happens to the second
 * proposal when the first is accepted". It is arithmetic over two ranges with
 * no filesystem in it, which is what lets the answer be a test rather than a
 * paragraph.
 */

import { bytesOf, narrow } from './edit.ts'

/**
 * How many proposals one paper may hold at once.
 *
 * A bound and not a budget, for the reason `MAX_EDIT_BYTES` gives: the caller
 * is whatever on this machine found the port. A hundred pending suggestions is
 * not a conversation with a reader, it is a queue — and a queue is the shape
 * this module's own doors argue at length about not growing.
 */
export const MAX_PENDING = 24

/** A change to one file of one paper, suggested and not yet answered. */
export interface Proposal {
  /** This process's name for it. Referred to twice: to draw it, to answer it. */
  id: string
  /** Relative to the paper's root, and a file the paper itself names. */
  file: string
  /** Byte offsets into that file, as it was when this was measured. */
  from: number
  to: number
  /** What goes there. Empty is a deletion, which is an ordinary proposal. */
  text: string
  /** The bytes this would replace, kept so the page can draw what leaves. */
  was_text: string
  /** SHA-256 of the whole file as it was measured — `Paper.hashes[file]`. */
  was: string
  /** One sentence from whoever proposed it, shown beside the change. */
  why: string
  /** Who says so. Free text, bounded, and never trusted for anything. */
  by: string
  /** When it arrived, so the page can order several of them. */
  at: number
  /**
   * What the proposer literally asked for, kept so the proposal can be
   * measured AGAIN.
   *
   * `from`, `to`, `text` and `was_text` are the narrowed answer to "replace
   * this text with that text", and they are the right thing to draw and to
   * write. They are the wrong thing to keep when the file has been rewritten by
   * somebody this process did not see — an author in a real editor, a merge —
   * because there is no arithmetic that moves a byte range across a change
   * whose shape nobody knows. What CAN be done is what was done the first time:
   * find the quoted text in the file as it now is, exactly once, and narrow it
   * again. `refile` does that, and this is the only reason the pair is kept.
   *
   * Optional, because a proposal is a value a test can build by hand and a
   * field every fixture has to invent is a field that will be invented wrongly;
   * a proposal without it cannot be measured again and is dropped instead,
   * which is the answer it would have got before this field existed.
   */
  asked?: { find: string; replace: string }
}

/**
 * The same proposal, measured against a file that changed under it — or
 * `null`, when it no longer describes anything in that file.
 *
 * ## This is the answer to an OUTSIDE change, and `rebase` is not
 *
 * `rebase` shifts a range by the length of an edit this process made itself,
 * which is exact and needs no search. An author saving a chapter from their
 * editor, or a `git merge` landing, is a change with no known shape: the hash
 * on the proposal stops matching the file and nothing here knows what moved.
 * Every pending proposal on that file is then refused by `writeRange`, exactly
 * as it should be, and would sit on the page un-acceptable forever.
 *
 * So it is filed AGAIN, by the same rule the door applied when it was filed
 * the first time: the text the proposer quoted has to appear in the file
 * exactly once, and the differing middle of it is the range. That is not the
 * "re-diff against the new file" guess that `rebase`'s essay refuses — that
 * guess searched for the narrowed text, which is often one word and lands on
 * any of its occurrences. This searches for the whole quoted window and
 * refuses ambiguity, so a proposal that survives is about the one place its
 * window still names. A proposal whose window is gone — because the author
 * rewrote the sentence, or applied the very change themselves — is dropped,
 * and the page says so.
 *
 * Restamped with the file's hash so the door will accept it. That is the
 * right stamp, because these offsets were just measured against that file.
 */
export function refile(proposal: Proposal, source: string, hash: string): Proposal | null {
  if (!proposal.asked) return null
  const again = propose(source, proposal.asked.find, proposal.asked.replace)
  if ('why' in again) return null
  return { ...proposal, from: again.from, to: again.to, text: again.text, was_text: again.was_text, was: hash }
}

/**
 * A proposal worked out from "replace this text with that text".
 *
 * ## Why the door takes text and not byte offsets
 *
 * Every other write in this module names bytes, and that is right for the page:
 * the page holds the parsed paper, every span carries its own offsets, and a
 * number it computed from a structure it was handed is a number it can defend.
 *
 * An agent is in the opposite position. It has read the source as a string and
 * has to count UTF-8 bytes by hand to say where a word is — and a byte count
 * that is four out does not fail, it splices a correction into the middle of
 * the wrong word and passes every check the door makes, because the range is
 * real and holds no markup. Asking for the text instead moves the counting to
 * the side that has the actual bytes, where it cannot be wrong.
 *
 * It also makes the proposal readable. `from: 4120, to: 4137` is not something
 * a person can check before approving it; "replace `teh` with `the`" is.
 *
 * ## Exactly once, and a refusal otherwise
 *
 * A `find` that appears twice is a proposal about one of two places, and there
 * is no way to know which. Guessing at the first is the kind of helpfulness
 * that rewrites the wrong paragraph, so it refuses and says how many it found —
 * which tells the caller exactly what to do, namely include more of the
 * surrounding sentence.
 *
 * ## Narrowed, for the reason every write here is narrowed
 *
 * The stored range is the differing MIDDLE of `find` and `replace`, not all of
 * `find`. Every note and every passage anchored inside a replaced range has
 * nowhere honest to go — see the essay on `narrow` — so a proposal that quotes
 * a whole sentence in order to change one word replaces one word.
 */
export type Proposed = { from: number; to: number; text: string; was_text: string } | { why: string }

export function propose(source: string, find: string, replace: string): Proposed {
  if (!find) return { why: 'A proposal has to say which text it replaces.' }
  if (find === replace) return { why: 'That proposal changes nothing: the text and its replacement are the same.' }

  const first = source.indexOf(find)
  if (first === -1) {
    return { why: 'That text is not in this file. Read the file again — it may have changed since you last did.' }
  }
  let seen = 0
  for (let at = first; at !== -1; at = source.indexOf(find, at + 1)) seen += 1
  if (seen > 1) {
    return {
      why:
        `That text appears ${seen} times in this file, so a proposal naming it does not say which one. `
        + 'Include enough of the surrounding sentence to make it unique.',
    }
  }

  const change = narrow(find, replace)
  /* Unreachable — `find === replace` is refused above and `narrow` answers null
     only for equal strings — and kept because this is the line between a
     proposal and a byte range, and a null dereferenced here would be a crash
     inside a request handler rather than a sentence. */
  if (!change) return { why: 'That proposal changes nothing.' }

  const base = bytesOf(source.slice(0, first))
  return {
    from: base + bytesOf(find.slice(0, change.at)),
    to: base + bytesOf(find.slice(0, change.upto)),
    text: change.text,
    was_text: find.slice(change.at, change.upto),
  }
}

/**
 * What one applied edit does to a proposal that was measured before it.
 *
 * ## The question this answers, and why the obvious answers are wrong
 *
 * Two proposals are pending in one file. The reader accepts the first. Every
 * byte offset after the point it landed has now moved, so the second proposal
 * describes a place that no longer means what it meant — and the door will
 * refuse it, correctly, because its `was` hash no longer matches the file.
 * Correct, and useless: the person is told their second suggestion is stale and
 * has to ask the agent to make it again, for a change two paragraphs away that
 * nothing touched.
 *
 * There were three candidate answers and two of them are guesses.
 *
 *  - **Re-diff against the new file** — find the proposal's old text somewhere
 *    in the rewritten document and move it there. That is a search, it can land
 *    on the wrong occurrence, and it can succeed confidently against a sentence
 *    somebody else wrote in between. A guess.
 *  - **Refuse everything else** — invalidate every other pending proposal the
 *    moment one lands. Honest, and it makes accepting three suggestions a
 *    three-round-trip conversation with an agent that has nothing new to say.
 *  - **Shift by the change in length** — which is not a guess at all. It is the
 *    same arithmetic the file itself underwent, and for a range that does not
 *    OVERLAP the applied one it is exact: bytes before the edit did not move,
 *    bytes after it moved by exactly the difference in length. There is no
 *    third case except overlap, and overlap is refused.
 *
 * So this shifts, and drops what overlaps. A proposal whose range intersects
 * the one that was just applied described bytes that have been rewritten, and
 * there is no honest place to put it — the same conclusion `narrow`'s essay
 * reaches about anchors inside a replaced range, reached again one layer up.
 *
 * ## This is deliberately NOT what happens to notes and passages
 *
 * The README is explicit that an edit moves every anchor below it and that this
 * module does not migrate them. That is still true and this is not a quiet
 * reversal of it. The difference is ownership: a note's anchor is another
 * module's stored data, held somewhere this program cannot see and cannot be
 * sure it is the only writer of, and moving it would be one program editing
 * another's records. A pending proposal is this process's own, held in memory
 * for the length of one conversation, and there is exactly one writer.
 *
 * What is worth noticing is that the arithmetic a Notes module would need is
 * now written down, pure and tested, in a place it could be lifted from.
 *
 * `null` means the proposal did not survive.
 */
export function rebase(
  proposal: Proposal,
  applied: { file: string; from: number; to: number; text: string },
  hash: string,
): Proposal | null {
  /* A different file did not move. Its hash did not change either, so the
     proposal is returned exactly as it was rather than restamped — restamping
     it with the hash of a file it is not about is how a stale proposal starts
     looking fresh. */
  if (proposal.file !== applied.file) return proposal

  const delta = bytesOf(applied.text) - (applied.to - applied.from)

  /* Entirely above the edit: the bytes did not move. Only the hash did, and it
     has to be restamped or the door will refuse a proposal that is perfectly
     valid. `<=` and not `<`: a proposal ending exactly where the edit begins
     shares no byte with it. */
  if (proposal.to <= applied.from) return { ...proposal, was: hash }

  /* Entirely below: everything shifted by the same amount. `>=` for the mirror
     reason — a proposal beginning exactly where the edit ended shares no byte
     with it either, and after the splice it begins where the new text ends. */
  if (proposal.from >= applied.to) {
    return { ...proposal, from: proposal.from + delta, to: proposal.to + delta, was: hash }
  }

  /* What is left overlaps, including the degenerate case of an insertion made
     inside a proposal's range. Those bytes were rewritten. */
  return null
}

/**
 * What a proposal that did not survive is called, in a sentence a person reads.
 *
 * Said out loud rather than removed in silence: a suggestion vanishing off the
 * page while somebody was deciding about it reads as the page having lost it.
 */
export function droppedBecause(count: number): string {
  if (count <= 0) return ''
  return count === 1
    ? 'One other suggestion covered the same words and was dropped, because the text it described has been rewritten.'
    : `${count} other suggestions covered the same words and were dropped, because the text they described has `
      + 'been rewritten.'
}
