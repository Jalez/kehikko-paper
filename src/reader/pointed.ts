import type { Passage } from 'roadmap-module-protocol'

import type { Paper, PlacedBlock } from '../../store.ts'
import { visible } from './pages.ts'

/**
 * A passage somebody else is pointing at, turned into a place in this paper.
 *
 * ## The other direction, at last
 *
 * `use-published-passage.ts` is this module saying where the reader is
 * pointing. This is the answer arriving: a `context.passage` naming a file and
 * a byte range, from a container that holds a note about it, and the user's question
 * was the whole specification — "when you click on a note shouldn't it
 * highlight and show what its target from the paper?"
 *
 * It is a pure function of the paper and the passage on purpose. Everything
 * that could go wrong here is a decision rather than an effect — which file,
 * which block, whether this paper even holds it — and every one of those is
 * worth being able to assert without a browser, a host or a canvas.
 *
 * ## The three answers, and why "nothing" is not one of them
 *
 * A passage can name a document this container does not have open. That is not an
 * edge case: a note lives on a chapter, the canvas is on another epic, and the
 * note is pressed. The protocol's own note on `path` says consumers compare it
 * for EQUALITY, and this one cannot open what it was not asked to show — the
 * `roadmap.goto` handler in `app.tsx` refuses a walk aimed at another epic for
 * a reason that applies unchanged here: loading it would answer for a place the
 * canvas is not standing, and the host is about to send a context for wherever
 * the reader really is.
 *
 * So the third answer is a SENTENCE. Doing nothing quietly is the failure this
 * codebase spends the most words on, and it is at its worst here, because from
 * the other container the press looked like it worked.
 */
export type Pointed =
  /** Nothing is pointing, or the passage names no range and no page worth moving to. */
  | { at: 'nowhere' }
  /**
   * In this paper, and pointed INTO it: turn to this block and mark the range.
   *
   * The mark carries the resolved block's `id` as well as the range, and the
   * two are not the same claim. The range says which SPANS to paint and is the
   * passage exactly as it arrived — never widened, so a paragraph is not washed
   * in colour because a sentence in it was pointed at. The id says which BLOCK
   * the pointing landed on, which is the only way the margin rule can be drawn
   * on a block that draws none of the source in the range: a comment run, a
   * `\todo{}` whose words this module lifts out, a passage in the preamble.
   * Without it those passages walked the reader somewhere and then showed
   * nothing at all when they arrived — measured on twenty-three of the
   * fifty-eight notes in the thesis, and the whole of the "it does not
   * highlight the exact part" complaint.
   */
  | {
      at: 'here'
      file: string
      id: string
      mark: { file: string; id: string; from: number; to: number }
      said: string
    }
  /**
   * In this paper, and not pointed into it — a document is open and no range
   * was named. Nothing to mark, nowhere to turn, nothing to say. Kept apart
   * from `here` with a null mark because the difference is not cosmetic: this
   * is the arm that must NOT move the page, and a boolean inside a shared arm
   * is a thing a later reader drops.
   */
  | { at: 'holding'; file: string }
  /** Not in this paper, and this is what to say about it. */
  | { at: 'elsewhere'; said: string }

/**
 * One passage, as a string that can be compared.
 *
 * The quote is deliberately not part of it. It is the longest and least stable
 * field: it is truncated on the way out (`LIMITS.QUOTE`) and a host is entitled
 * to re-read it from the file on the way back, so two spellings of one place
 * would stop matching and every guard below it would silently stop guarding.
 * Where a passage IS is its path, its page and its range; the quote is what
 * happened to be written there.
 *
 * The same function, for the same reason, is in `notes/pointed.ts` in the notes
 * module — this is the second module to need it, which is what the protocol's
 * own note on `path` predicts: consumers compare passages for equality, and
 * there is no equality without one spelling.
 */
export function keyOf(passage: Passage): string {
  return `${passage.path} ${passage.page ?? ''} ${passage.from ?? ''} ${passage.to ?? ''}`
}

/**
 * Is this passage the echo of one this module published?
 *
 * ## The bug this exists to name
 *
 * A reader highlights a sentence. `use-published-passage.ts` posts it as
 * `passage.set`; the host puts it in `context.passage`; and a context is
 * broadcast to EVERY framed module, this one included. What arrives back is
 * byte-for-byte a passage naming a range of the document on screen — which is
 * indistinguishable, to `pointedAt` above, from a notes container pointing this
 * reader at a chapter. So the paper walked to it, and `scrollIntoView` centred
 * the paragraph the reader had just dragged their mouse across.
 *
 * Measured, with a probe host in `dev/measure-selection.mjs`: selecting a
 * paragraph near the top of the column moved the scroll 166 pixels under the
 * person selecting it. The owner's words for it were "it jumps to 'center' that
 * section, which feels like bad ux — if user wants to center to the highlighted
 * spot, they will scroll to center it themselves."
 *
 * ## Who asked is not a property of the passage
 *
 * Nothing in a `Passage` says where it came from, and nothing should: it is a
 * statement about a document, not about a module. So the only way to tell an
 * echo from a person is to remember what this module said last, which is the
 * one string `Published` holds.
 *
 * ## Why there is no `since` here, when the notes module needed one
 *
 * `notes/pointed.ts` carries a second key — the passage that was live when the
 * press was made — because without it the hold lasted less than one frame.
 * There, a press changes state immediately and the list re-renders long before
 * the echo of it can arrive, so a comparison against the LIVE passage threw the
 * press away on the very next render while every unit test passed.
 *
 * That cannot happen here, and the difference is structural rather than lucky:
 * the thing being guarded is an effect keyed on the ARRIVING passage. It does
 * not run in the gap between publishing and being answered, because nothing in
 * that gap changes `pointed`. When it does run, `pointed` is either the echo
 * (and matches) or somebody else's (and must not). A `since` here would be a
 * second thing to keep true with no failure behind it.
 *
 * ## And why the record is dropped the moment somebody else points
 *
 * Held forever, this key would suppress a real walk the day another module
 * pointed at exactly the range this reader once highlighted — rare, invisible,
 * and impossible to work out from the outside. Dropped as soon as a passage
 * arrives that is not ours, it can only ever suppress the walk caused by the
 * publication that set it. See the call site in `app.tsx`, which does the
 * dropping, because a ref is state and this file holds none.
 */
export function isEcho(published: string | null, passage: Passage | null): boolean {
  if (!published || !passage) return false
  return published === keyOf(passage)
}

/**
 * Which file of this paper a passage names, or null.
 *
 * The passage carries an absolute path because that is the only spelling two
 * modules can agree on without sharing a root; blocks name their file relative
 * to `paper.dir`. `use-published-passage.ts` joins the two the same way in one
 * place for the same reason, and this is that join read backwards.
 *
 * A prefix test and not a resolve: this function must not touch a filesystem,
 * and a passage whose path merely LOOKS like it is under the root is answered
 * by whether a file of that name is actually in the paper, one line down.
 */
export function fileOf(paper: Paper, path: string): string | null {
  const dir = paper.dir.endsWith('/') ? paper.dir : `${paper.dir}/`
  if (!path.startsWith(dir)) return null
  const relative = path.slice(dir.length)
  return paper.files.includes(relative) ? relative : null
}

/**
 * The block a byte range sits in, or the nearest one this sheet actually draws.
 *
 * Overlap rather than containment, because a passage recorded against a comment
 * run or a whole paragraph routinely begins a byte or two outside the block a
 * reader would call it — and because a note whose anchor MOVED points at where
 * the words are now, which need not line up with a block boundary at all.
 *
 * `visible` is applied first so this can never turn to something the sheet does
 * not draw.
 *
 * ## The fallback was "the last block in the file", and it was measured wrong
 *
 * A third of the passages this module is pointed at name source it does not
 * draw, and that is not an edge case — it is the ordinary case. The notes
 * container lifts a note out of every comment run, `pages.ts` drops every
 * `comment` block, and the two together mean a note about the four lines of
 * reasoning above a section names bytes with no block on them at all. On the
 * thesis this was measured against — `dev/measure-marked.mjs` — nineteen of the
 * twenty-three comment notes and four preamble ones, twenty-three of
 * fifty-eight, missed every block.
 *
 * Every one of them fell through to `here[here.length - 1]`, so pressing a note
 * about the top of a chapter walked the reader to the LAST paragraph of that
 * chapter — pages away, in the right file, with nothing marked when they got
 * there, because the block a mark is drawn on has to overlap the range and that
 * one never does. The essay above this function used to say a preamble passage
 * "lands on the first block of the file", which is what a person would want and
 * was never what the code did.
 *
 * So the fallback is the nearest drawn block instead, and "nearest" leans
 * forward: the first block that starts at or after the range, and only failing
 * that the last one before it. Leaning forward is not a tie-break, it is how
 * these files are written — a comment run and a `\todo{}` sit ABOVE the prose
 * they are about, so the block after them is the thing they are about and the
 * block before them is the previous subject. It also makes the sentence above
 * true again: a preamble passage now lands on the first drawn block, because
 * every block in the file starts after the preamble.
 */
export function blockFor(paper: Paper, file: string, range: { from: number; to: number } | null): PlacedBlock | null {
  const here = paper.blocks.filter((b) => b.file === file && visible(b))
  if (!here.length) return null
  if (!range) return here[0] ?? null
  const hit = here.find((b) => b.srcStart < range.to && range.from < b.srcEnd)
  if (hit) return hit
  /* Blocks arrive in source order, so the first one starting after the range is
     the one just below it. Past the end of everything drawn there is none, and
     the last block is then the nearest true answer rather than a guess: a range
     after every block is after the last of them. */
  return here.find((b) => b.srcStart >= range.to) ?? here[here.length - 1] ?? null
}

/**
 * What this container should do about a passage.
 *
 * `page` on the passage is deliberately NOT used to decide where to go. It is a
 * filter and never an anchor — the protocol says so, and the number was
 * computed by whichever module happened to be paginating when the note was
 * written. The block list is this module's own arithmetic over its own sheets,
 * and it is the only thing here entitled to say which sheet a range is on.
 */
export function pointedAt(paper: Paper | null, passage: Passage | null): Pointed {
  if (!passage) return { at: 'nowhere' }
  if (!paper) {
    return {
      at: 'elsewhere',
      said: 'Something pointed at a passage of a document, and this container is not showing a paper at the moment.',
    }
  }

  const file = fileOf(paper, passage.path)
  if (!file) {
    return {
      at: 'elsewhere',
      said:
        `Something pointed at ${passage.path}, which is not part of the paper open here — this container is showing `
        + `${paper.title ?? paper.epic}. Open the epic that paper belongs to and point again.`,
    }
  }

  const range = passage.from === null || passage.to === null ? null : { from: passage.from, to: passage.to }
  const block = blockFor(paper, file, range)
  if (!block) {
    return {
      at: 'elsewhere',
      said: `Something pointed at ${file}, which is part of this paper and has nothing in it that this container draws.`,
    }
  }

  /*
   * A passage with no range is not a request to go anywhere.
   *
   * Rung two of the field — a document and a page, no `from`/`to` — means "a
   * reader has this open", which is what lets a notes container show the page's
   * notes instead of nothing. It does NOT mean "turn to this", and treating it
   * as though it did produced a jump the reader could feel:
   *
   *   scroll -> the page readout changes -> this app publishes rung two naming
   *   the new page -> the host broadcasts it -> this app turns to it -> the
   *   scroll position moves under the person who was scrolling.
   *
   * `shouldPublish` already refuses to send an echo straight back, so the cycle
   * did not spin forever. It did not have to: one turn per scroll is a jump.
   * The guard was on the wrong half — the fix is not to publish less, it is to
   * stop treating "a document is open" as an instruction.
   *
   * So this is its own answer rather than a `here` with a null mark. Nothing is
   * marked, nothing is turned to, and nothing is said: a container that already has
   * the document open, being told the document is open, has no news for
   * anybody. The sentence that used to be here — "no range was named, so
   * nothing is marked" — was the app narrating its own plumbing at somebody
   * reading a thesis.
   */
  if (!range) return { at: 'holding', file: block.file }

  return {
    at: 'here',
    file: block.file,
    id: block.id,
    mark: { file: block.file, id: block.id, ...range },
    said: `Something pointed at ${file}, bytes ${range.from}–${range.to}. It is marked below.`,
  }
}
