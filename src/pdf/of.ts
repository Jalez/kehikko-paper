/**
 * Whether a PDF is OF a file as the person has it.
 *
 * ## The one question
 *
 * A mark is put on a PDF by counting lines in the source and asking that
 * PDF's SyncTeX table where they were printed, then looking for the words
 * there (`find.ts`). Both halves assume the PDF was compiled from the text the
 * lines were counted in. When it was not — lines added above the passage
 * since — the table answers for other words: a passage found by its words is
 * tied or missed by the wrong neighbourhood, and one not found is drawn as
 * the whole printed lines the table named, which are the wrong lines.
 *
 * So before anything is asked of a PDF about a place in a file, this is
 * asked first. It is true only when three things are the same text:
 *
 *   - what the PDF was COMPILED from — `pdf.hashes[file]`, the hash of the
 *     file as the compile read it;
 *   - what the editor last READ OR SAVED — `held.hash`, the hash of the file
 *     on disk then;
 *   - what is in the EDITOR now — `held.text === held.saved` says nothing has
 *     been typed since.
 *
 * Any one of them ahead of the others and the answer is no:
 *
 *   - the file was saved, or rewritten by an agent and read again, and the
 *     compile that follows has not finished — or FAILED, which leaves the
 *     last good PDF on screen for as long as the source does not compile;
 *   - words are typed and not saved yet: the PDF and the disk agree with each
 *     other, and not with the lines in the editor.
 *
 * What it does not cover is the moment between a file changing on disk under
 * the editor and the editor reading it again (`use-source.ts`): for those
 * milliseconds the editor's own text is the old one, the PDF is of it, and
 * the whole page is behind together. The poll's hash is not asked, because it
 * can be OLDER than a save this page just made, and a mark held back until
 * the next poll would be late for no reason.
 *
 * It answers per FILE, and that is the point: a compile running because
 * another chapter changed says nothing about this one, whose lines and whose
 * rows of the table are what they were.
 *
 * ## Any PDF
 *
 * `pdf` is whatever is on screen and carries the hashes it was compiled from:
 * the whole paper's build, or a part compiled on its own with
 * `\includeonly`. A caller with two kinds of PDF passes the one it is
 * drawing; a file that PDF was not compiled from has no hash in it, and the
 * answer is no. Nothing here knows which kind it was given.
 *
 * ## What a caller does with a no
 *
 * It does not ask the table. That is all this decides, and it is not the same
 * as drawing nothing: a passage's WORDS are still what they are, and
 * `find.ts` can be handed them with no rectangles at all. It then draws them
 * where they are printed once in the PDF on screen — the common case, lines
 * added above a sentence that itself did not change — and draws nothing where
 * they are not there or are there twice, which is where the table would have
 * had to be believed. `workspace.tsx` does this for a passage the canvas
 * points at, and holds a change that landed back altogether, as it always
 * did.
 *
 * When it becomes true — the compile lands, the save lands — whatever was
 * held back is asked for by the effect that depends on it, with nobody
 * pressing anything. What is held back is said nowhere: there is no notice.
 */

/** A PDF, as far as "which text is this of" goes: the hash of every source file it was compiled from. */
export interface Compiled {
  hashes: Readonly<Record<string, string>>
}

/** A file as the editor holds it — `Doc` in `use-source.ts`, or anything shaped like it. */
export interface Held {
  text: string
  saved: string
  hash: string
}

export function pdfIsOf(pdf: Compiled | null | undefined, file: string, held: Held | null | undefined): boolean {
  if (!pdf || !held) return false
  return held.text === held.saved && pdf.hashes[file] === held.hash
}
