import { PART_ID, moduleFile } from 'kehikot-module-protocol'
import { writeHoldings } from 'kehikot-module-protocol/serve'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

import { ID } from './manifest.ts'
import { PAPERS_AT, confine, isEpic, readPaper, type Paper } from './store.ts'

/**
 * Which chapter of an epic's paper is which part's: this module's own record.
 *
 * ## What is kept, and where
 *
 * A part belongs to the epic and is kept by the host; what a module HAS for a
 * part is the module's. This module has one thing: the chapter. So it keeps
 * `part id → file`, one chapter to a part and a chapter in at most one part,
 * in its own folder beside the papers:
 *
 *     <project>/.kehikot/paper/chapters.json
 *     { "version": 1, "epics": { "thesis": { "methods": "chapters/3_methods.tex" } } }
 *
 * Keyed by the part's id, never its name, and the file is named as the paper
 * names it. That is the whole decision a person made, and nothing derived.
 *
 * ## And what is published from it
 *
 * `parts.json`, in the same folder, is the protocol's: what this module holds
 * for each part in the two words every module shares, documents and
 * references. It is NOT the record. It lists, for a part, the chapter and
 * every file the chapter pulls in — which changes when somebody adds an
 * `\input` to the chapter, and which nobody decided. So it is made again from
 * the record and the paper as it now reads (`holdingsOf`) after every change
 * to either, and a host unions it into the part it sends every module.
 *
 * ## Reading never writes
 *
 * An epic this file says nothing about is an epic whose chapters are still
 * read from what the host says its parts have — as they were before this
 * module kept anything. `readChapters` answers null for it and makes nothing.
 * The record is written once a PERSON sets a chapter, with the whole of what
 * the page was showing at that moment (`setChapters`), so the first write
 * takes over every part's chapter and not only the one that was touched.
 */

export type Chapters = Record<string, string>

const FILE = 'chapters'
const VERSION = 1

/** The record's path, fenced: null when there is no project or the papers folder resolves outside it. */
function recordAt(project: string | null): string | null {
  const file = moduleFile(project, ID, FILE)
  if (project === null || file === null) return null
  return confine(project, relative(project, file))
}

/** The whole document, or null when there is none that can be read as one. */
function whole(path: string): Record<string, unknown> | null {
  try {
    if (!lstatSync(path).isFile()) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * A mapping as it may be kept: every key a part's id, every value a file of
 * this paper, and a file under the first part that names it only. Anything
 * else in what was given is left out, not refused: one entry that is not one
 * costs that entry.
 */
export function chaptersIn(raw: unknown, paper: Pick<Paper, 'files'>): Chapters {
  const out: Chapters = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const taken = new Set<string>()
  for (const [part, file] of Object.entries(raw as Record<string, unknown>)) {
    if (!PART_ID.test(part) || typeof file !== 'string' || !paper.files.includes(file) || taken.has(file)) continue
    taken.add(file)
    out[part] = file
  }
  return out
}

/**
 * What this module's record says for one epic — or null when it says nothing
 * about it, which is "read the chapters off the parts the host sends". Never
 * writes, and never throws: no project, no file, a file that is not JSON and
 * an epic it does not list are all null.
 */
export function readChapters(project: string | null, epic: string): Chapters | null {
  if (!isEpic(epic)) return null
  const path = recordAt(project)
  const kept = path === null ? null : whole(path)
  const epics = kept?.epics
  if (!epics || typeof epics !== 'object' || Array.isArray(epics) || !Object.hasOwn(epics, epic)) return null
  const paper = readPaper(epic, project)
  return paper ? chaptersIn((epics as Record<string, unknown>)[epic], paper) : null
}

/**
 * What is published for an epic: for each part, its chapter and every file
 * that chapter pulls in, at any depth, in the paper's own order and named
 * from the project. No references: a paper holds none for a part.
 */
export function holdingsOf(paper: Pick<Paper, 'epic' | 'files' | 'pulls'>, chapters: Chapters): Record<string, { documents: string[]; refs: string[] }> {
  const under = (file: string, chapter: string): boolean => {
    let at = file
    for (let depth = 0; depth < 16; depth += 1) {
      if (at === chapter) return true
      const above = paper.pulls[at]?.by
      if (above === undefined) return false
      at = above
    }
    return false
  }
  const out: Record<string, { documents: string[]; refs: string[] }> = {}
  for (const [part, chapter] of Object.entries(chapters)) {
    const files = [chapter, ...paper.files.filter((file) => file !== chapter && under(file, chapter))]
    out[part] = { documents: files.map((file) => `${PAPERS_AT}/${paper.epic}/${file}`), refs: [] }
  }
  return out
}

/** Publish what the record says, read against the paper as it is now. Whether `parts.json` was written. */
function publish(project: string, paper: Paper, chapters: Chapters): boolean {
  return writeHoldings(project, ID, paper.epic, holdingsOf(paper, chapters), { published: ['documents'] })?.changed === true
}

export type ChaptersSet = { ok: true; chapters: Chapters; published: boolean } | { ok: false; why: string }

/**
 * Keep an epic's chapters, whole, and publish them.
 *
 * `asked` is the WHOLE mapping for the epic as the page then held it — every
 * part's chapter, the one just set among them — and it replaces what the
 * record said for that epic. Every other epic in the file, and every key this
 * does not know, stays as it was. Written beside the file and renamed, so a
 * reader never finds half a document; whatever has the file's name and cannot
 * be read as one is set aside as `chapters.json.unreadable`, not written over.
 *
 * The record first and the publication second: the record is the truth, and
 * a publication that failed is made again by the next save (`republish`).
 */
export function setChapters(project: string | null, epic: string, asked: unknown): ChaptersSet {
  if (!isEpic(epic)) return { ok: false, why: 'That is not an epic name.' }
  const paper = readPaper(epic, project)
  const path = recordAt(project)
  if (project === null || !paper || path === null) return { ok: false, why: 'There is no paper for that epic in this project.' }
  const chapters = chaptersIn(asked, paper)

  const found = lstatSync(path, { throwIfNoEntry: false })
  let kept = found === undefined ? {} : whole(path)
  if (kept === null) {
    renameSync(path, `${path}.unreadable`)
    kept = {}
  }
  const epics = kept.epics && typeof kept.epics === 'object' && !Array.isArray(kept.epics) ? (kept.epics as Record<string, unknown>) : {}
  const next = `${JSON.stringify({ ...kept, version: typeof kept.version === 'number' ? kept.version : VERSION, epics: { ...epics, [epic]: chapters } }, null, 2)}\n`
  const beside = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    rmSync(beside, { force: true })
    writeFileSync(beside, next, { flag: 'wx' })
    renameSync(beside, path)
  } catch (error) {
    rmSync(beside, { force: true })
    return { ok: false, why: `The chapters could not be kept: ${(error as Error).message}` }
  }

  let published = false
  try {
    published = publish(project, paper, chapters)
  } catch {
    /* Kept, and not said to the canvas yet. The next save says it. */
  }
  return { ok: true, chapters, published }
}

/**
 * Publish again after the paper changed: a chapter that now pulls in another
 * file has another document. Does nothing, and writes nothing, for an epic
 * the record says nothing about. Whether `parts.json` was written.
 */
export function republish(project: string | null, epic: string): boolean {
  const chapters = readChapters(project, epic)
  if (project === null || chapters === null) return false
  const paper = readPaper(epic, project)
  if (!paper) return false
  try {
    return publish(project, paper, chapters)
  } catch {
    return false
  }
}
