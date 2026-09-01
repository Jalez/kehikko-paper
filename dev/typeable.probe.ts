/*
 * How much of a real paper can actually be typed into.
 *
 *     bun run dev/typeable.probe.ts /absolute/path/to/project <epic>
 *
 * ## Why this exists, and why it is not a test
 *
 * "How much of this paper can I edit" turned out to be the question that
 * mattered, and nothing could answer it. Editing was shipped against a fixture
 * whose paragraphs were single lines of source, which is the one shape where
 * the bug below does not occur; every test passed, and the real thesis was a
 * document whose only editable text was its headings.
 *
 * It is a probe rather than a test because the answer is a property of somebody
 * else's document, not of this code. A test would have to carry a corpus and
 * would then be asserting the corpus. Point this at a real paper and it says
 * what a person will actually be able to do with it.
 *
 * ## The two numbers, and why the second is the real one
 *
 * The parser's segments are one thing; the screen draws `coalesce`d RUNS, which
 * merge adjacent segments that share their styles. The gaps between words are
 * their own segments — a hard wrap in the source collapsing to one rendered
 * space — and they carry the same styles as the words either side, so an entire
 * paragraph merges into one run.
 *
 * Editing was offered on a run only when it was `literal`, and one collapsed
 * gap anywhere in a paragraph made it not:
 *
 *     before the fix, on the thesis:  heading 100% typeable, paragraph 1%
 *
 * which is what the person using it reported as "so I can edit the titles of
 * sections but not the text itself?". The parser-level number was 96%, and it
 * was measuring something nobody could touch.
 *
 * So this reports BOTH, and splits the second by block kind, because the gap
 * between the two is where the bug lived and one overall percentage hid it.
 * Anything much below "all ordinary prose" in the `paragraph` row means the
 * editing surface is not doing its job, whatever the first number says.
 *
 * It imports the reader's own `coalesce` rather than re-implementing it. An
 * earlier draft kept a copy, and a probe with its own copy of the rule is a
 * probe that can agree with a rule the program no longer follows — which is the
 * exact failure it was written to catch.
 */
import type { Segment } from '../latex/parse.ts'
import { coalesce, withoutNotes } from '../src/reader/segments.tsx'
import { readPaper } from '../store.ts'

const [project, epic] = process.argv.slice(2)
if (!project || !epic) {
  console.error('bun run dev/typeable.probe.ts /absolute/path/to/project <epic>')
  process.exit(2)
}

const paper = readPaper(epic, project)
if (!paper) {
  console.error(`no paper for "${epic}" in ${project}`)
  process.exit(1)
}

/** Every run of segments a block draws, whatever field holds them. */
function runsOf(block: Record<string, unknown>): Segment[][] {
  const out: Segment[][] = []
  if (Array.isArray(block.segments)) out.push(block.segments as Segment[])
  if (Array.isArray(block.caption)) out.push(block.caption as Segment[])
  if (Array.isArray(block.items)) for (const item of block.items as Segment[][]) out.push(item)
  return out.filter((run) => run.length > 0)
}

const byKind = new Map<string, { typeable: number; locked: number }>()
let rawLiteral = 0
let rawTotal = 0
/** What is still locked, and what kind of thing it is. */
const locked = new Map<string, number>()

for (const raw of (paper as unknown as { blocks?: Record<string, unknown>[] }).blocks ?? []) {
  const kind = String(raw.kind)
  for (const raws of runsOf(raw)) {
    /* The same filter the reader applies before it draws anything. A `\todo{}`
       is lifted out into the notes module and never reaches the page, so
       counting it here would report a locked seven thousand characters that
       nobody can see, let alone try to type into. */
    const segments = withoutNotes(raws)
    for (const seg of segments) {
      rawTotal += seg.text.length
      if (seg.literal) rawLiteral += seg.text.length
    }
    const tally = byKind.get(kind) ?? { typeable: 0, locked: 0 }
    for (const run of coalesce(segments)) {
      if (run.typeable) {
        tally.typeable += run.text.length
        continue
      }
      tally.locked += run.text.length
      const why = run.text.trim() === '' ? 'whitespace between spans' : run.styles.join(',') || 'no styles'
      locked.set(why, (locked.get(why) ?? 0) + run.text.length)
    }
    byKind.set(kind, tally)
  }
}

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100))

console.log(`before coalescing: ${pct(rawLiteral, rawTotal)}% of characters are literal`)
console.log('\nafter coalescing — what the screen actually offers:\n')
let allTypeable = 0
let allLocked = 0
for (const [kind, tally] of [...byKind].sort()) {
  const total = tally.typeable + tally.locked
  allTypeable += tally.typeable
  allLocked += tally.locked
  console.log(
    `  ${kind.padEnd(12)} ${String(pct(tally.typeable, total)).padStart(3)}% typeable` +
      `   (${tally.typeable} of ${total} characters)`,
  )
}
const overall = allTypeable + allLocked
console.log(
  `\n  ${'everything'.padEnd(12)} ${String(pct(allTypeable, overall)).padStart(3)}% typeable` +
    `   (${allTypeable} of ${overall} characters)`,
)

/*
 * What is left locked, by what it is.
 *
 * The point of the split is that the remainder should be the things the rule
 * was written for — a citation, a reference, an escape, a `~` — and never
 * prose. A `no styles` row with real words in it is a run this program is
 * refusing for a reason nobody has articulated, and it is where to look next.
 */
if (locked.size) {
  console.log('\nwhat is still not typeable, and why:\n')
  for (const [why, chars] of [...locked].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${why.padEnd(28)} ${String(chars).padStart(6)} characters`)
  }
}
