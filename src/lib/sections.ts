import { plainText, spanOf } from '../../latex/parse.ts'
import type { Paper } from '../../store.ts'

/**
 * The sections of a paper, as places in its files.
 *
 * `latex/parse.ts` already knows every heading and where it is; this only
 * reshapes that for a page that thinks in files and offsets rather than in
 * blocks. The title is `plainText` of the heading — the same string
 * `list_sections` hands an agent and the same one `passage.section.title`
 * carries — because Slides follows a paper by comparing that title for
 * equality, and a second spelling of it here would be a slide that stops
 * following.
 */
export interface SectionAt {
  file: string
  title: string
  level: number
  /** Where the heading command itself starts and ends, in bytes of `file`. */
  at: number
  end: number
  /** The section's span: from its heading to the next heading in that file. */
  from: number
  to: number
}

export function sectionsOf(paper: Paper): SectionAt[] {
  const out: SectionAt[] = []
  for (const block of paper.blocks) {
    if (block.kind !== 'heading') continue
    const { from, to } = spanOf(paper.blocks, block)
    out.push({ file: block.file, title: plainText(block.segments), level: block.level, at: block.srcStart, end: block.srcEnd, from, to })
  }
  return out
}

/** The section a byte of a file is in: the last heading of that file at or before it. */
export function sectionAt(sections: readonly SectionAt[], file: string, byte: number): SectionAt | null {
  let found: SectionAt | null = null
  for (const section of sections) {
    if (section.file !== file || section.at > byte) continue
    if (found === null || section.at >= found.at) found = section
  }
  return found
}
