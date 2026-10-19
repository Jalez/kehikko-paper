import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildDir, buildStatus, compile, compilePart, forgetBuilds, partStatus, readPdf, syncForward } from '../compile/build.ts'
import { KEPT_PARTS } from '../compile/part.ts'
import { TICKET, answerAt as answer, laterAt as later } from '../doors.ts'

/**
 * A picked part compiled on its own, run for real against engines that are not.
 *
 * `part.test.ts` pins what is decided. This is what is DONE: that a full
 * build's `.aux` files are kept, that a part's compile can read them, that the
 * part's PDF is kept per selection and not made twice, that the whole paper is
 * compiled exactly when it has to be — and, first of all, that none of it
 * writes anything into the paper's folder.
 *
 * Two fakes, a few lines of shell each, put first on PATH. `tectonic` writes
 * its main file back out as the "PDF", followed by the `.aux` files it could
 * read from the folder it ran in; `latexmk` does the same from its output
 * directory. Both leave an `.aux` for `main` and for each chapter, as a real
 * engine does for an `\include`.
 */

const TECTONIC = `#!/bin/sh
ALL="$*"
while [ $# -gt 1 ]; do
  if [ "$1" = "--outdir" ]; then OUT="$2"; fi
  shift
done
MAIN="$1"
BASE="\${MAIN%.tex}"
echo "$ALL" >> "$OUT/args"
/bin/pwd > "$OUT/cwd"
if /usr/bin/grep -q BROKEN main.tex chapters/*.tex; then
  echo "error: chapters/a.tex:2: Undefined control sequence" >&2
  exit 1
fi
{ /bin/cat "$MAIN"; for f in *.aux chapters/*.aux; do [ -f "$f" ] && echo "read $f: $(/bin/cat "$f")"; done; /usr/bin/grep -h "" chapters/*.tex; } > "$OUT/$BASE.pdf"
/bin/mkdir -p "$OUT/chapters"
echo "aux of $BASE" > "$OUT/$BASE.aux"
for c in a b d; do echo "aux of $c, from $(/bin/cat chapters/$c.tex | /usr/bin/head -1)" > "$OUT/chapters/$c.aux"; done
echo "a log" > "$OUT/$BASE.log"
exit 0
`

const LATEXMK = `#!/bin/sh
ALL="$*"
for arg in "$@"; do
  case "$arg" in -outdir=*) OUT="\${arg#-outdir=}";; esac
  MAIN="$arg"
done
echo "$ALL" >> "$OUT/args"
/bin/pwd > "$OUT/cwd"
{ echo "latexmk $ALL"; for f in "$OUT"/*.aux "$OUT"/chapters/*.aux; do [ -f "$f" ] && echo "read \${f#$OUT/}: $(/bin/cat "$f")"; done; /usr/bin/grep -h "" chapters/*.tex; } > "$OUT/main.pdf"
/bin/mkdir -p "$OUT/chapters"
echo "aux of main" > "$OUT/main.aux"
for c in a b d; do echo "aux of $c, from $(/bin/cat chapters/$c.tex | /usr/bin/head -1)" > "$OUT/chapters/$c.aux"; done
exit 0
`

let root = ''
let project = ''
let bin = ''
let pathWas: string | undefined

const MAIN = ['\\documentclass{report}', '\\begin{document}', 'Front matter.', '\\include{chapters/a}', '\\include{chapters/b}', '\\input{chapters/c}', '\\include{chapters/d}', '\\end{document}', ''].join('\n')

function paperAt(epic: string, main = MAIN): string {
  const paper = join(project, '.kehikot', 'paper', epic)
  rmSync(paper, { recursive: true, force: true })
  mkdirSync(join(paper, 'chapters'), { recursive: true })
  mkdirSync(join(paper, 'figures'), { recursive: true })
  writeFileSync(join(paper, 'main.tex'), main)
  for (const one of ['a', 'b', 'c', 'd']) writeFileSync(join(paper, 'chapters', `${one}.tex`), `chapter ${one}\n`)
  writeFileSync(join(paper, 'figures', 'f.png'), 'not a picture')
  writeFileSync(join(paper, '.hidden'), 'an editor’s own')
  rmSync(buildDir(paper), { recursive: true, force: true })
  return paper
}

/** Every entry under a folder: its path, what kind of thing it is, and — for a file — what is in it. */
function snapshot(dir: string, at = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(dir, at)).sort()) {
    const here = at ? `${at}/${name}` : name
    const stat = lstatSync(join(dir, here))
    if (stat.isDirectory()) out.push(`${here}/`, ...snapshot(dir, here))
    else if (stat.isSymbolicLink()) out.push(`${here} -> ${readlinkSync(join(dir, here))}`)
    else out.push(`${here} ${createHash('sha256').update(readFileSync(join(dir, here))).digest('hex')} ${stat.mtimeMs}`)
  }
  return out
}

const text = (pdf: { bytes: Uint8Array } | null) => (pdf ? Buffer.from(pdf.bytes).toString() : '')
const runsIn = (dir: string) => (existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8').trim().split('\n').length : 0)

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'paper-part-')))
  project = join(root, 'project')
  bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'tectonic'), TECTONIC)
  writeFileSync(join(bin, 'latexmk'), LATEXMK)
  chmodSync(join(bin, 'tectonic'), 0o755)
  chmodSync(join(bin, 'latexmk'), 0o755)
  pathWas = process.env.PATH
  process.env.PATH = `${bin}:${pathWas ?? ''}`
})

afterAll(() => {
  forgetBuilds()
  process.env.PATH = pathWas
  for (const epic of ['a-thesis', 'tex-live', 'fresh', 'many']) rmSync(buildDir(join(project, '.kehikot', 'paper', epic)), { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('a full build', () => {
  test('keeps what it wrote for the next compile — in its own folder, with a hash of it', async () => {
    const paper = paperAt('a-thesis')
    await compile('a-thesis', project)
    const aux = join(buildDir(paper), 'good', 'aux')
    expect(readFileSync(join(aux, 'main.aux'), 'utf8')).toBe('aux of main\n')
    expect(readFileSync(join(aux, 'chapters', 'a.aux'), 'utf8')).toBe('aux of a, from chapter a\n')
    /* Not the PDF, not the log, not the fake's own notes of how it was run… */
    expect(readdirSync(aux).sort()).toEqual(['args', 'chapters', 'cwd', 'main.aux'])
    const meta = JSON.parse(readFileSync(join(buildDir(paper), 'good', 'meta.json'), 'utf8')) as { aux?: string }
    expect(meta.aux).toMatch(/^[0-9a-f]{16}$/)
    /* …and the same text again leaves the same hash, which is what lets a part's PDF be kept across full builds. */
    await compile('a-thesis', project)
    expect((JSON.parse(readFileSync(join(buildDir(paper), 'good', 'meta.json'), 'utf8')) as { aux?: string }).aux).toBe(meta.aux)
  })
})

describe('a part compiled on its own, by an engine that reads only its own folder', () => {
  let paper = ''
  beforeEach(async () => {
    paper = paperAt('a-thesis')
    await compile('a-thesis', project)
  })

  test('NOTHING is written in the paper’s folder: not a file, not a link, not a changed byte or date', async () => {
    const before = snapshot(paper)
    const made = (await compilePart('a-thesis', project, ['chapters/a.tex']))!
    expect(made.part?.last?.ok).toBe(true)
    await compilePart('a-thesis', project, ['chapters/a.tex', 'chapters/b.tex'])
    await compilePart('a-thesis', project, ['chapters/a.tex'], { force: true })
    expect(snapshot(paper)).toEqual(before)
    /* And nothing in the project beside the paper's folder either. */
    expect(readdirSync(join(project, '.kehikot'))).toEqual(['paper'])
  })

  test('it is the paper with \\includeonly ahead of it, compiled where the last full build’s .aux files can be read', async () => {
    const made = (await compilePart('a-thesis', project, ['chapters/a.tex']))!
    const part = made.part!
    expect(part).toMatchObject({ only: ['chapters/a'], cannot: null, running: false })
    expect(part.key).toMatch(/^[0-9a-f]{16}$/)
    const pdf = text(readPdf('a-thesis', project, part.key))
    expect(pdf).toStartWith('\\includeonly{chapters/a}\\input{main.tex}\n')
    /* The full build's own `.aux`, under the name of the file compiled here, and each chapter's beside its chapter. */
    expect(pdf).toContain('read kehikot-only.aux: aux of main')
    expect(pdf).toContain('read chapters/b.aux: aux of b, from chapter b')
    /* The whole paper's PDF is still the whole paper's. */
    expect(text(readPdf('a-thesis', project))).toStartWith('\\documentclass{report}')
    expect(part.pdf?.id).not.toBe(made.build.pdf?.id)

    const pdir = join(buildDir(paper), 'parts', part.key)
    const tree = join(pdir, 'tree')
    expect(realpathSync(readFileSync(join(pdir, 'work', 'cwd'), 'utf8').trim())).toBe(realpathSync(tree))
    /* The mirror: links to the paper's own files, real folders where an `.aux` sits, and no dot-entry. */
    expect(readlinkSync(join(tree, 'main.tex'))).toBe(join(paper, 'main.tex'))
    expect(readlinkSync(join(tree, 'figures'))).toBe(join(paper, 'figures'))
    expect(readlinkSync(join(tree, 'chapters', 'a.tex'))).toBe(join(paper, 'chapters', 'a.tex'))
    expect(lstatSync(join(tree, 'chapters')).isDirectory()).toBe(true)
    expect(lstatSync(join(tree, 'chapters', 'a.aux')).isFile()).toBe(true)
    expect(existsSync(join(tree, '.hidden'))).toBe(false)
    const run = readFileSync(join(pdir, 'work', 'args'), 'utf8').trim().split('\n')
    expect(run).toHaveLength(1)
    expect(run[0]).toContain('--untrusted')
    expect(run[0]).toContain('--keep-intermediates')
    expect(run[0]).toEndWith('kehikot-only.tex')
  })

  test('the PDF records which text it is of, for whoever asks whether a mark can be trusted on it', async () => {
    const part = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    expect(Object.keys(part.pdf!.hashes).sort()).toEqual(['chapters/a.tex', 'chapters/b.tex', 'chapters/c.tex', 'chapters/d.tex', 'main.tex'])
    expect(part.pdf!.hashes['chapters/a.tex']).toBe(createHash('sha256').update('chapter a\n').digest('hex'))
  })

  test('coming back to a selection is not a compile; an edit is', async () => {
    const first = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    const work = join(buildDir(paper), 'parts', first.key, 'work')
    expect(runsIn(work)).toBe(1)
    await compilePart('a-thesis', project, ['chapters/b.tex'])
    const again = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    expect(runsIn(work)).toBe(1)
    expect(again.pdf!.id).toBe(first.pdf!.id)
    expect(partStatus('a-thesis', project, ['chapters/a.tex'])!.pdf!.id).toBe(first.pdf!.id)

    writeFileSync(join(paper, 'chapters', 'a.tex'), 'chapter a, rewritten\n')
    const edited = (await compilePart('a-thesis', project, ['chapters/a.tex']))!
    expect(runsIn(work)).toBe(2)
    expect(edited.part!.pdf!.id).not.toBe(first.pdf!.id)
    expect(text(readPdf('a-thesis', project, first.key))).toContain('chapter a, rewritten')
    /* The whole paper was NOT compiled for it: its PDF is still of the text before. */
    expect(runsIn(join(buildDir(paper), 'work'))).toBe(1)
    expect(text(readPdf('a-thesis', project))).not.toContain('rewritten')
    expect(edited.build.pdf!.hashes['chapters/a.tex']).not.toBe(edited.part!.pdf!.hashes['chapters/a.tex'])
  })

  test('a folder a failed run used is emptied before the next: nothing it half-wrote is read again', async () => {
    writeFileSync(join(paper, 'chapters', 'a.tex'), 'BROKEN\n')
    const bad = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    expect(bad.last?.ok).toBe(false)
    const work = join(buildDir(paper), 'parts', bad.key, 'work')
    /* What a run killed mid-write leaves: an outline cut off mid-line, which stops every run after it. */
    writeFileSync(join(work, 'main.out'), '\\BOOKMARK [1][-]{section.1}{cut off')
    writeFileSync(join(paper, 'chapters', 'a.tex'), 'chapter a\n')
    const fixed = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    expect(fixed.last?.ok).toBe(true)
    expect(existsSync(join(work, 'main.out'))).toBe(false)
    /* Seeded afresh from the full build. */
    expect(text(readPdf('a-thesis', project, fixed.key))).toContain('read chapters/b.aux: aux of b, from chapter b')
  })

  test('the whole paper is compiled first when asked to be of this text — and only when it is not', async () => {
    const whole = join(buildDir(paper), 'work')
    await compilePart('a-thesis', project, ['chapters/a.tex'], { full: true })
    expect(runsIn(whole)).toBe(1)
    writeFileSync(join(paper, 'chapters', 'a.tex'), 'chapter a, longer\n')
    const made = (await compilePart('a-thesis', project, ['chapters/b.tex'], { full: true }))!
    /* `work/` is emptied before every run, so one line is one new run. */
    expect(text(readPdf('a-thesis', project))).toContain('chapter a, longer')
    expect(made.build.pdf!.hashes['chapters/a.tex']).toBe(createHash('sha256').update('chapter a, longer\n').digest('hex'))
    /* And the part read the numbers that build left: chapter a's new `.aux`. */
    expect(text(readPdf('a-thesis', project, made.part!.key))).toContain('read chapters/a.aux: aux of a, from chapter a, longer')
  })

  test('pressing Compile makes both, whatever stands', async () => {
    const part = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    const work = join(buildDir(paper), 'parts', part.key, 'work')
    const whole = (await compile('a-thesis', project))!.pdf!.at
    await new Promise((done) => setTimeout(done, 5))
    const forced = (await compilePart('a-thesis', project, ['chapters/a.tex'], { force: true }))!
    expect(runsIn(work)).toBe(2)
    expect(forced.build.pdf!.at).toBeGreaterThan(whole)
  })

  test('a file pulled in with \\input is not compiled at all: the sentence, and no engine', async () => {
    const made = (await compilePart('a-thesis', project, ['chapters/c.tex']))!
    expect(made.part).toEqual({
      key: '',
      only: [],
      cannot: 'No page is shown for the picked part: main.tex pulls chapters/c.tex in with \\input, and only a file pulled in with \\include can be compiled on its own.',
      running: false,
      last: null,
      pdf: null,
    })
    expect(existsSync(join(buildDir(paper), 'parts'))).toBe(false)
    expect(runsIn(join(buildDir(paper), 'work'))).toBe(1)
  })

  test('files that are not the paper’s are nobody’s part', async () => {
    expect((await compilePart('a-thesis', project, ['../../etc/passwd', 'chapters/nope.tex']))!.part).toBeNull()
    expect(partStatus('a-thesis', project, [])).toBeNull()
    expect(await compilePart('no-such-paper', project, ['chapters/a.tex'])).toBeNull()
  })

  test('a part that does not compile says where, and the last good PDF of it stays', async () => {
    const good = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    writeFileSync(join(paper, 'chapters', 'a.tex'), 'BROKEN \\nope\n')
    const bad = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    expect(bad.last?.ok).toBe(false)
    expect(bad.last?.problems[0]).toMatchObject({ severity: 'error', file: 'chapters/a.tex', line: 2 })
    expect(bad.pdf!.id).toBe(good.pdf!.id)
    expect(text(readPdf('a-thesis', project, good.key))).toContain('chapter a')
  })

  test('a selection is asked for by its key, and a key that is not one opens nothing', async () => {
    const part = (await compilePart('a-thesis', project, ['chapters/a.tex']))!.part!
    expect(readPdf('a-thesis', project, '../../good')).toBeNull()
    expect(readPdf('a-thesis', project, '0123456789abcdef')).toBeNull()
    expect(syncForward('a-thesis', project, 'chapters/a.tex', 1, 1, 'not-a-key')).toBeNull()
    /* The fake writes no SyncTeX: nothing to navigate by, and that is an answer. */
    expect(syncForward('a-thesis', project, 'chapters/a.tex', 1, 1, part.key)).toBeNull()
  })
})

describe('with no full build to read numbers from', () => {
  test('the whole paper is compiled first, unasked, and the part from what it left', async () => {
    const paper = paperAt('fresh')
    expect(buildStatus('fresh', project)!.pdf).toBeNull()
    const made = (await compilePart('fresh', project, ['chapters/b.tex']))!
    expect(made.build.pdf).not.toBeNull()
    expect(runsIn(join(buildDir(paper), 'work'))).toBe(1)
    expect(text(readPdf('fresh', project, made.part!.key))).toContain('read chapters/a.aux: aux of a')
  })
})

describe('the last few selections are kept', () => {
  test('and the ones before them are removed', async () => {
    const paper = paperAt('many')
    await compile('many', project)
    const picks = [['a'], ['b'], ['d'], ['a', 'b'], ['a', 'd'], ['b', 'd']].map((one) => one.map((name) => `chapters/${name}.tex`))
    const keys: string[] = []
    for (const pick of picks) {
      keys.push((await compilePart('many', project, pick))!.part!.key)
      await new Promise((done) => setTimeout(done, 15))
    }
    expect(new Set(keys).size).toBe(picks.length)
    expect(readdirSync(join(buildDir(paper), 'parts')).sort()).toEqual(keys.slice(-KEPT_PARTS).sort())
    /* One that went is simply made again. */
    expect((await compilePart('many', project, picks[0]!))!.part!.pdf).not.toBeNull()
  }, 20000)
})

describe('by a TeX Live, which reads its output folder', () => {
  test('the line goes ahead of the paper on latexmk’s own, the paper’s folder is where it runs, and the .aux files are laid in the part’s folder', async () => {
    const paper = paperAt('tex-live', `% !TEX program = latexmk\n${MAIN}`)
    const before = snapshot(paper)
    await compile('tex-live', project)
    const part = (await compilePart('tex-live', project, ['chapters/a.tex', 'chapters/d.tex']))!.part!
    expect(part.last?.ok).toBe(true)
    const work = join(buildDir(paper), 'parts', part.key, 'work')
    expect(realpathSync(readFileSync(join(work, 'cwd'), 'utf8').trim())).toBe(paper)
    const run = readFileSync(join(work, 'args'), 'utf8').trim()
    expect(run).toContain('-norc')
    expect(run).toContain('-bibtex-')
    expect(run).toContain('-usepretex=\\includeonly{chapters/a,chapters/d}')
    expect(run).toContain(`-outdir=${work}`)
    expect(run).toEndWith('main.tex')
    const pdf = text(readPdf('tex-live', project, part.key))
    expect(pdf).toContain('read main.aux: aux of main')
    expect(pdf).toContain('read chapters/b.aux: aux of b, from chapter b')
    /* No mirror for an engine that does not need one. */
    expect(existsSync(join(buildDir(paper), 'parts', part.key, 'tree'))).toBe(false)
    expect(snapshot(paper)).toEqual(before)
  })
})

describe('the doors in front of it', () => {
  const query = (more: Record<string, string> = {}) => new URLSearchParams({ epic: 'a-thesis', project, ...more })

  test('compiling a part needs the ticket; with it the answer is both builds', async () => {
    paperAt('a-thesis')
    expect((await later('POST', '/api/part', query(), { files: ['chapters/a.tex'] }))?.status).toBe(403)
    const reply = await later('POST', '/api/part', query(), { files: ['chapters/a.tex'], full: true }, TICKET)
    expect(reply?.status).toBe(200)
    const body = reply?.body as { build: { pdf: { id: string } }; part: { key: string; only: string[]; pdf: { id: string } } }
    expect(body.part.only).toEqual(['chapters/a'])
    expect(body.build.pdf.id).toMatch(/^[0-9a-f]{16}$/)

    /* Where it stands is a read. */
    const status = answer('GET', '/api/part', query({ files: JSON.stringify(['chapters/a.tex']) }), null)
    expect((status?.body as { part: { key: string } }).part.key).toBe(body.part.key)
    expect((answer('GET', '/api/part', query({ files: JSON.stringify(['chapters/c.tex']) }), null)?.body as { part: { cannot: string } }).part.cannot).toContain('\\input')
    expect((answer('GET', '/api/part', query(), null)?.body as { part: unknown }).part).toBeNull()
    expect(answer('GET', '/api/part', query({ files: 'not json' }), null)?.status).toBe(400)

    /* The part's PDF and the paper's are two addresses. */
    const part = answer('GET', '/api/pdf', query({ part: body.part.key }), null)
    expect(part?.raw?.type).toBe('application/pdf')
    expect(Buffer.from(part!.raw!.bytes as Uint8Array).toString()).toStartWith('\\includeonly{chapters/a}')
    expect(Buffer.from(answer('GET', '/api/pdf', query(), null)!.raw!.bytes as Uint8Array).toString()).toStartWith('\\documentclass')
    expect(answer('GET', '/api/pdf', query({ part: 'nope' }), null)?.status).toBe(404)
    expect(answer('GET', '/api/sync', query({ part: body.part.key, file: 'chapters/a.tex', line: '1' }), null)?.status).toBe(200)
  })
})
