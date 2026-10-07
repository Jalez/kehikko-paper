import type { Passage } from 'kehikot-module-protocol'

import { plainText } from '../latex/parse.ts'
import type { Paper, PlacedBlock } from '../store.ts'

/**
 * A passage somebody else on the canvas pointed at, turned into a place in
 * this paper's source.
 *
 * ## What arrives, and from whom
 *
 * Nothing sends this page a list of ranges to draw and nothing sends it a
 * `goto` with a path in it. The one channel is `context.passage`: Notes puts a
 * note's anchor there when a note is pressed, Learning a question's, Slides a
 * citation's or — with no range at all — the section a slide is linked to. All
 * of them name an absolute path, most a byte range, some a section title.
 *
 * So the question this file answers is small and exact: is that path a file of
 * the paper open here, and if so which bytes of it. In the source editor the
 * answer is exact, because the anchor is in bytes of the very file the editor
 * holds — there is no rendering between the two to map through. That is the
 * whole of what "highlights keep working" rests on.
 *
 * ## Four answers
 *
 * `nowhere` — nothing is pointed at. `elsewhere` — something is, and it is not
 * in this paper; said once, in a sentence. `holding` — it names this paper's
 * file and no particular place in it, which is what this page's own page-level
 * passage looks like coming back, and is nothing to act on. `here` — a file
 * and a byte range to open, scroll to and mark.
 *
 * Pure, and tested, because the other half of this — not answering one's own
 * echo — is a loop guard, and a loop guard nobody can test is one nobody dares
 * change.
 */
export type Pointed =
  | { at: 'nowhere' }
  | { at: 'here'; file: string; from: number; to: number; said: string }
  | { at: 'holding'; file: string }
  | { at: 'elsewhere'; said: string }

/**
 * One passage as a comparable string.
 *
 * The page is part of it and the quote is not, which is the key Notes and
 * Learning use to recognise their own press coming back. Using the same one
 * here is what lets this page recognise ITS own.
 */
export function keyOf(passage: Passage): string {
  return `${passage.path}\0${passage.page ?? ''}\0${passage.from ?? ''}\0${passage.to ?? ''}\0${passage.section?.title ?? ''}`
}

export function isEcho(published: string | null, passage: Passage | null): boolean {
  if (!published || !passage) return false
  return published === keyOf(passage)
}

/** The paper's own name for an absolute path, or null when the path is not one of its files. */
export function fileOf(paper: Paper, path: string): string | null {
  const dir = paper.dir.endsWith('/') ? paper.dir : `${paper.dir}/`
  if (!path.startsWith(dir)) return null
  const relative = path.slice(dir.length)
  return paper.files.includes(relative) ? relative : null
}

/**
 * The heading a section names, by its title as `list_sections` spells it.
 *
 * By title first and offset second: the title survives an edit above the
 * heading and the offset does not, and Slides — the module that sends these —
 * links a slide to a section by title for exactly that reason.
 */
export function headingFor(paper: Paper, file: string, section: { title: string; from: number | null }): PlacedBlock | null {
  const named = paper.blocks.filter((b) => b.file === file && b.kind === 'heading' && plainText(b.segments) === section.title)
  return named.find((b) => b.srcStart === section.from) ?? named[0] ?? null
}

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

  if (passage.from !== null && passage.to !== null) {
    return {
      at: 'here',
      file,
      from: passage.from,
      to: passage.to,
      said: `Something pointed at ${file}, bytes ${passage.from}–${passage.to}. It is marked in the source.`,
    }
  }

  const section = passage.section ?? null
  if (!section) return { at: 'holding', file }
  const heading = headingFor(paper, file, section)
  if (!heading) return { at: 'holding', file }
  return {
    at: 'here',
    file: heading.file,
    from: heading.srcStart,
    to: heading.srcEnd,
    said: `Something pointed at the section “${section.title}” of ${file}.`,
  }
}

/**
 * What to do about the passage the canvas holds, given what this page last said.
 *
 * `own` is true when it is this page's own passage coming back. A ranged echo
 * is still answered `here` — the range is real — and the caller draws no mark
 * for it, since its own selection is already on screen. An echo with no range
 * is `holding`: it is the caret's own section, and scrolling to the top of it
 * would move the editor every time somebody moved the caret.
 */
export function received(paper: Paper | null, passage: Passage | null, published: string | null): { own: boolean; answer: Pointed } {
  const own = isEcho(published, passage)
  const answer = pointedAt(paper, passage)
  if (own && answer.at === 'here' && (passage?.from === null || passage?.to === null)) {
    return { own, answer: { at: 'holding', file: answer.file } }
  }
  return { own, answer }
}
