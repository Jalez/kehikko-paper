import { LIMITS, partsOfFile, type EpicPart } from 'kehikot-module-protocol'

import type { Pullable } from '../compile/part.ts'
import { MAIN_FILE, inProject } from './focus.ts'

/**
 * Which chapter is which part's, as the page reasons about it.
 *
 * `chapters.ts` at the root is the record and its publication, on the server.
 * This is what the page needs to offer the choice: which files are chapters,
 * what the parts the host sends already say, and one change to a mapping.
 * Pure: no React, no wire.
 */

/** `part id → file of the paper`: one chapter to a part, and a chapter in at most one part. */
export type Chapters = Record<string, string>

/** As much of a paper as this reads. */
export interface Chaptered extends Pullable {
  epic: string
}

/** The files `main.tex` pulls in itself, in the paper's order: what can be a part's chapter. */
export function chaptersOf(paper: Pullable): string[] {
  const pulls = paper.pulls ?? {}
  return paper.files.filter((file) => pulls[file]?.by === MAIN_FILE)
}

/**
 * What the parts the host sends already say: for each, the first file of the
 * paper it has that no other of its files pulls in, and that no earlier part
 * took.
 *
 * This is what a chapter IS until this module keeps a record of its own — the
 * parts' documents, or from an older host their files, exactly as the page is
 * narrowed by them — and it is what that record starts from the first time a
 * person sets one (`withChapter`), so every part keeps the chapter it had.
 * Which file a part has is asked of the protocol, part by part.
 */
export function chaptersSaid(parts: readonly EpicPart[], paper: Chaptered, projectPath?: string | null): Chapters {
  const out: Chapters = {}
  const taken = new Set<string>()
  const pulls = paper.pulls ?? {}
  for (const part of parts) {
    if (Object.hasOwn(out, part.id)) continue
    const has = paper.files.filter((file) => partsOfFile([part], inProject(paper.epic, file), paper.epic, projectPath).length > 0)
    const chapter = has.find((file) => !has.includes(pulls[file]?.by ?? '') && !taken.has(file))
    if (chapter === undefined) continue
    taken.add(chapter)
    out[part.id] = chapter
  }
  return out
}

/**
 * The mapping with `file` made the chapter of `part` — or of no part, for null.
 *
 * One chapter to a part and a chapter in at most one part, so giving a file to
 * a part that already has a chapter has to do something with that chapter. It
 * is never simply dropped where there is somewhere for it to go:
 *
 * - the file was some other part's chapter: the two SWAP. The chapter that was
 *   in the way goes to the part the file came from, so nobody is left with
 *   less, and pressing the old part again puts both exactly back — the same
 *   entries in the same order, which is the same file on disk.
 * - the file was no part's chapter: there is nowhere to send the other one,
 *   and it is left with no part. `moveOf` is what says so, on the option
 *   before the press and in the page's line after it.
 *
 * Every other part's entry is untouched, and stays where it was in the order.
 */
export function withChapter(chapters: Chapters, part: string | null, file: string): Chapters {
  const from = partOfChapter(chapters, file)
  if (from === part) return { ...chapters }
  const displaced = part !== null && Object.hasOwn(chapters, part) ? chapters[part]! : null
  const out: Chapters = {}
  for (const [id, chapter] of Object.entries(chapters)) {
    if (id === part) out[id] = file
    else if (id !== from) out[id] = chapter
    else if (displaced !== null) out[id] = displaced
  }
  if (part !== null && !Object.hasOwn(out, part)) out[part] = file
  return out
}

/**
 * What giving `file` to `part` does to the chapter that part already has:
 * nothing (`null` — the part has none, or has this file), it goes `to` the
 * part the file came from, or — `to: null` — it is left with no part.
 */
export function moveOf(chapters: Chapters, part: string, file: string): { file: string; to: string | null } | null {
  const has = Object.hasOwn(chapters, part) ? chapters[part]! : null
  if (has === null || has === file) return null
  return { file: has, to: partOfChapter(chapters, file) }
}

/** A file as a person names it in a few words: without its folder. */
export const baseOf = (file: string): string => file.split('/').pop() || file

/**
 * What a press did to a chapter other than the one pressed for, as the one
 * sentence the page says after it — or null when nothing else moved, which
 * needs no words. `heading` names a part by its id.
 */
export function movedWords(file: string, part: string, move: { file: string; to: string | null } | null, heading: (id: string) => string): string | null {
  if (move === null) return null
  const now = `${baseOf(file)} is now the chapter of ${heading(part)}`
  return move.to === null ? `${now}; ${baseOf(move.file)} is the chapter of no part.` : `${now}, and ${baseOf(move.file)} of ${heading(move.to)}.`
}

/** The part a file is the chapter of, or null. */
export function partOfChapter(chapters: Chapters, file: string): string | null {
  return Object.keys(chapters).find((part) => chapters[part] === file) ?? null
}

/**
 * What a part made for a chapter is called: the chapter's first heading, or
 * with none the file's own name without its folder and extension. One line,
 * and no longer than a host takes for a name.
 */
export function nameFor(file: string, sections: readonly { file: string; title: string }[]): string {
  const heading = sections.find((section) => section.file === file)?.title.replace(/\s+/g, ' ').trim()
  const base = (file.split('/').pop() ?? file).replace(/\.tex$/i, '')
  return (heading || base || file).slice(0, LIMITS.TITLE)
}
