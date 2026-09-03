/**
 * Every `\ref` and `\cite` in a real paper, before and after resolution, and
 * checked against the compiled PDF where there is one.
 *
 *   bun dev/resolve.probe.ts <project> <epic> [pdftotext-dump.txt]
 *
 * Read-only: it opens the paper the way `/api/paper` does and prints what the
 * parser emitted for each marker beside what `readPaper` rewrote it to. Given a
 * `pdftotext -layout` dump of the compiled thesis it also says, for each
 * resolved form, whether that exact string occurs in the PDF — which is the
 * only truth there is about what a `\ref` prints. A form the PDF does not
 * contain is not necessarily wrong (the PDF may be stale, or the string may
 * wrap across a line), but every one of them is worth a look.
 *
 * The run that checked this branch, on the owner's thesis against
 * `main.pdf`:
 *
 *   refs: 85 (0 unresolved), 85 found verbatim in the PDF
 *   cites: 66 (0 unresolved), 66 found verbatim in the PDF
 *
 * The 66th was the run's one finding: `{Quiroga P{\'e}rez}, Jos{\'e}` read as
 * a corporate author until `bracedWhole` in `latex/bib.ts` learned the
 * difference between a name that starts and ends with a brace and a name that
 * IS one brace group.
 */
import { existsSync, readFileSync } from 'node:fs'

import { parseLatex, type Segment } from '../latex/parse.ts'
import { readPaper } from '../store.ts'

const [project, epic, dump] = process.argv.slice(2)
if (!project || !epic) {
  console.error('usage: bun dev/resolve.probe.ts <project> <epic> [pdftotext-dump.txt]')
  process.exit(2)
}

const paper = readPaper(epic, project)
if (!paper) {
  console.error(`no paper "${epic}" in ${project}`)
  process.exit(1)
}

const pdf = dump && existsSync(dump) ? readFileSync(dump, 'utf8').replace(/\s+/g, ' ') : null

/* The parser's own rendering, for the "before" column: the same file parsed
   again on its own, which is exactly what the page used to be handed. */
const before = new Map<string, Segment[]>()
for (const file of paper.files) {
  const path = `${paper.dir}/${file}`
  const parsed = parseLatex(readFileSync(path, 'utf8'), file)
  before.set(
    file,
    parsed.blocks.flatMap((b) => ('segments' in b ? b.segments : 'caption' in b ? b.caption : 'items' in b ? b.items.flat() : [])),
  )
}

const counts = { refs: 0, refsUnresolved: 0, cites: 0, citesUnresolved: 0, refsInPdf: 0, citesInPdf: 0 }
const seen = new Set<string>()

for (const block of paper.blocks) {
  const runs = 'segments' in block ? [block.segments] : 'caption' in block ? [block.caption] : 'items' in block ? block.items : []
  for (const run of runs) {
    for (const segment of run) {
      if (!segment.keys?.length) continue
      const isRef = segment.styles.includes('ref')
      const was = before.get(block.file)?.find((s) => s.srcStart === segment.srcStart && s.keys)?.text ?? '?'
      const inPdf = pdf ? pdf.includes(segment.text) : null
      if (isRef) {
        counts.refs += 1
        if (segment.unresolved) counts.refsUnresolved += 1
        if (inPdf) counts.refsInPdf += 1
      } else {
        counts.cites += 1
        if (segment.unresolved) counts.citesUnresolved += 1
        if (inPdf) counts.citesInPdf += 1
      }
      const line = `${isRef ? 'ref ' : 'cite'}  ${block.file}:${segment.srcStart}  ${was}  →  ${segment.text}`
      const mark = segment.unresolved ? '  UNRESOLVED' : inPdf === false ? '  not in PDF' : ''
      /* Each distinct rendering once, so the list is readable. */
      const key = `${was}→${segment.text}`
      if (!seen.has(key)) {
        seen.add(key)
        console.log(line + mark + (segment.note ? `\n        ${segment.note.split('\n').join('\n        ')}` : ''))
      }
    }
  }
}

console.log('')
console.log(`refs: ${counts.refs} (${counts.refsUnresolved} unresolved)${pdf ? `, ${counts.refsInPdf} found verbatim in the PDF` : ''}`)
console.log(`cites: ${counts.cites} (${counts.citesUnresolved} unresolved)${pdf ? `, ${counts.citesInPdf} found verbatim in the PDF` : ''}`)
