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

/** The mapping with `file` made the chapter of `part` — or of no part, for null. The file leaves whichever part had it, and the part's old chapter leaves the part. */
export function withChapter(chapters: Chapters, part: string | null, file: string): Chapters {
  const out: Chapters = {}
  for (const [id, chapter] of Object.entries(chapters)) if (chapter !== file && id !== part) out[id] = chapter
  if (part !== null) out[part] = file
  return out
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
