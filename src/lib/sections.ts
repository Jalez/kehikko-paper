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

/** One file in the section list: its sections, each with its place in the WHOLE list. */
export interface FileJumps {
  file: string
  sections: { index: number; section: SectionAt }[]
}

/**
 * The section list, file by file: what the jump control offers.
 *
 * ## Every file is in it, including one with no heading
 *
 * This page used to have a second dropdown, of files, and it has gone: which
 * part of a paper is shown is chosen once, in the host's bar, and a file
 * picker here was a second, private way to choose a chapter. What it also
 * did, and nothing else did, was reach a file that has no heading in it — an
 * abstract, a file of tables, the macros the preamble pulls in. A press in
 * the PDF reaches what PRINTED, and a section jump reaches what has a
 * section; a file that is neither would have become unreachable.
 *
 * So the list is grouped by file, in the paper's own order, and a file with
 * no section still has its group, with one entry for the top of it. Nothing
 * a paper is made of is more than one jump away.
 *
 * `files` is the files the page is showing — all of them, or under a focus
 * the picked parts' own and whichever is open — so the list is limited to
 * what is shown, as it was. `index` is a section's place in the list it came
 * from, which is what the control's handler reads, so leaving files out
 * renumbers nothing.
 */
export function jumpsOf(files: readonly string[], sections: readonly SectionAt[]): FileJumps[] {
  return files.map((file) => ({
    file,
    sections: sections.flatMap((section, index) => (section.file === file ? [{ index, section }] : [])),
  }))
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
