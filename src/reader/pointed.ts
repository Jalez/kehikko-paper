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
  /** In this paper, and pointed INTO it: turn to this block and mark the range. */
  | { at: 'here'; file: string; id: string; mark: { file: string; from: number; to: number }; said: string }
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
 * The block a byte range starts in, or the file's first drawn block.
 *
 * Overlap rather than containment, because a passage recorded against a comment
 * run or a whole paragraph routinely begins a byte or two outside the block a
 * reader would call it — and because a note whose anchor MOVED points at where
 * the words are now, which need not line up with a block boundary at all.
 *
 * `visible` is applied first so this can never turn to something the sheet does
 * not draw. A passage inside the preamble — which this module folds away, and
 * which Notes has stopped lifting for the same reason — lands on the first
 * block of the file instead of on nothing, which is the honest place to put
 * somebody who asked to be shown a part of the document that is not shown.
 */
export function blockFor(paper: Paper, file: string, range: { from: number; to: number } | null): PlacedBlock | null {
  const here = paper.blocks.filter((b) => b.file === file && visible(b))
  if (!here.length) return null
  if (!range) return here[0] ?? null
  const hit = here.find((b) => b.srcStart < range.to && range.from < b.srcEnd)
  /* Past the end of everything drawn — the last block is the nearest true
     answer, and it is a real one rather than a guess: a range after every
     block is after the last of them. */
  return hit ?? here[here.length - 1] ?? null
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
    mark: { file: block.file, ...range },
    said: `Something pointed at ${file}, bytes ${range.from}–${range.to}. It is marked below.`,
  }
}
