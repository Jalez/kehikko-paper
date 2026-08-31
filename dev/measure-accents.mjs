/**
 * What an accent escape costs the reader, counted on the owner's own thesis.
 *
 * ## What this establishes
 *
 * `latex/parse.ts` had no rule for accent escapes. `\"a` was read as a command
 * named `"` that nothing recognised, so the unknown-bare-command fallback
 * applied — drop the command, keep what follows — and the reading column showed
 * a bare `a`. `tiivistelm\"a` rendered as `tiivistelma`: not markup on screen,
 * which a reader can at least see is markup, but a Finnish word misspelled in
 * a way that looks like the author's own mistake.
 *
 * Three numbers were wanted before and after the fix, because a change to how a
 * person's thesis is READ should be able to say exactly how much of it moved:
 *
 *  1. **How many rendered blocks change.** Not "does it work on my example" —
 *     the whole served document, block by block, diffed against a snapshot
 *     taken from the running module before the change.
 *  2. **Whether pagination moves.** Sheets are packed from character counts
 *     (`src/reader/pages.ts`, `weigh`), so any change in rendered LENGTH can
 *     push a block onto a different sheet. A fix that silently repaginates
 *     somebody's thesis is a surprise even when the text is more correct.
 *  3. **How many accent escapes there are at all**, read off the .tex sources,
 *     so that a diff of zero can be told apart from a corpus of zero.
 *
 * ## What it measured, on `05_drafts/thesis_latex`, 2026-09-01
 *
 *                                  before          after
 *   accent escapes in source          2               2      (both `\"a`)
 *   blocks served                   185             185
 *   blocks whose text changed         —               2
 *   sheets after pagination          45              45
 *
 * The two blocks are the `\missing{…}` notes in `main.tex` and
 * `chapters/1_introduction.tex`, both of which contain the sentence about the
 * Finnish `\emph{tiivistelm\"a}`; both now read `tiivistelmä`.
 *
 * Pagination did NOT move, and the reason is worth writing down because it is
 * luck rather than design: the broken rendering DROPPED the two-character
 * escape and kept the `a`, so the block was already one character long there,
 * and the fix replaces one character with one character. Had the parser instead
 * been showing the source — `tiivistelm\"a`, thirteen characters — the fix
 * would have shortened two blocks by two characters each and the answer here
 * could have been different. The number is measured rather than reasoned about
 * for exactly that reason.
 *
 * ## Running it
 *
 *   bun dev/measure-accents.mjs [epic] [snapshot]   (module must be on 7870)
 *
 * With no snapshot on disk it writes one and reports only the source counts;
 * run it again after the change and it diffs against what it wrote. The
 * snapshot is the rendered text of every block as the RUNNING module serves it,
 * so the two runs must straddle a module restart to mean anything.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { paginate } from '../src/reader/pages.ts'

const epic = process.argv[2] ?? 'thesis'
const snapshotPath = process.argv[3] ?? '/tmp/paper-accents-snapshot.json'
const project = process.argv[4] ?? '/Users/jaakkorajala/Claude/Projects/CS-DEGREE/05_drafts/thesis_latex'

const url = `http://127.0.0.1:7870/api/paper?project=${encodeURIComponent(project)}&epic=${encodeURIComponent(epic)}`
const res = await fetch(url)
if (!res.ok) {
  console.error(`GET /api/paper -> ${res.status}. Is the module running? ./run.sh`)
  process.exit(1)
}
const body = await res.json()
const blocks = body.paper?.blocks ?? []

/* The rendered text of one block, by the same rule `weigh` uses to charge it
   for sheet space: the segments joined, and nothing else. Blocks with no
   segments contribute their raw text so that a comment or a verbatim run is
   still watched for a change. */
const renderedOf = (b) => {
  if (Array.isArray(b.segments)) return b.segments.map((s) => s.text).join('')
  if (Array.isArray(b.items)) return b.items.map((it) => it.map((s) => s.text).join('')).join(' | ')
  return b.text ?? b.raw ?? b.latex ?? ''
}

/* `file#id`, and not `id` alone. Block ids restart per file — the abstract's
   note in `main.tex` and the introduction's are BOTH `para-3` — so a map keyed
   by id silently merges them and this probe would have reported one changed
   block where there are two. */
const rendered = Object.fromEntries(blocks.map((b) => [`${b.file}#${b.id}`, renderedOf(b)]))
const sheets = paginate(blocks).length

/* Accent escapes in the source, counted by the same two shapes the parser
   recognises: a non-letter accent binds to whatever follows it, a letter-named
   one only to a brace group or to a space and a single letter (`\v` is a caron
   and `\vspace` is not). */
const TIGHT = /\\(["'`^~=.])(\{[^}]*\}|\\[ij]|[a-zA-Z])/g
const NAMED = /\\([uvHrckdb])(\{[^}]*\}|\s+[a-zA-Z](?![a-zA-Z]))/g

const texFiles = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.tex')) texFiles.push(path)
  }
}
walk(project)

let escapes = 0
for (const file of texFiles) {
  const src = readFileSync(file, 'utf8')
  for (const re of [TIGHT, NAMED]) {
    for (const m of src.matchAll(re)) {
      escapes += 1
      console.log(`  ${file.slice(project.length + 1)}  ${JSON.stringify(m[0])}`)
    }
  }
}

console.log(`\n${texFiles.length} .tex files, ${escapes} accent escapes in source`)
console.log(`${blocks.length} blocks served, ${sheets} sheets after pagination`)

if (!existsSync(snapshotPath)) {
  writeFileSync(snapshotPath, JSON.stringify({ sheets, rendered }, null, 2))
  console.log(`\nno snapshot yet — wrote ${snapshotPath}. Restart the module and run again.`)
  process.exit(0)
}

const before = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const ids = new Set([...Object.keys(before.rendered), ...Object.keys(rendered)])
let changed = 0
for (const id of ids) {
  const was = before.rendered[id]
  const now = rendered[id]
  if (was === now) continue
  changed += 1
  console.log(`\n${id}\n  was: ${JSON.stringify((was ?? '').slice(0, 220))}\n  now: ${JSON.stringify((now ?? '').slice(0, 220))}`)
}

console.log(`\n${changed} of ${ids.size} blocks changed`)
console.log(`sheets: ${before.sheets} -> ${sheets}${before.sheets === sheets ? ' (pagination did not move)' : ' (PAGINATION MOVED)'}`)
