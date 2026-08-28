import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isEpic, listPapers, papersDir, readPaper, readSource } from '../store.ts'

/**
 * The store, which is a reader over somebody else's directory.
 *
 * Two things are worth a test and the rest is the parser's business: that
 * nothing here can be talked into reading a file outside the papers directory,
 * and that the two kinds of emptiness stay apart — "no papers" and "nobody said
 * where to look" are different sentences and the page shows different screens
 * for them.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-paper-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const papers = join(root, 'papers')
mkdirSync(join(papers, 'good-epic', 'chapters'), { recursive: true })
writeFileSync(
  join(papers, 'good-epic', 'main.tex'),
  [
    '\\documentclass{article}',
    '\\newcommand{\\gh}[1]{\\texttt{gh\\##1}}',
    '\\title{A paper with a title}',
    '\\author{Somebody}',
    '\\begin{document}',
    '\\maketitle',
    '\\section{The first thing}',
    'The work is \\gh{41}.',
    '',
    '\\include{chapters/second}',
    '',
    '\\end{document}',
  ].join('\n'),
)
writeFileSync(
  join(papers, 'good-epic', 'chapters', 'second.tex'),
  ['\\section{The second thing}', 'And here it is \\gh{42} again.'].join('\n'),
)
/* A directory that looks like an epic and holds no paper. */
mkdirSync(join(papers, 'empty-epic'), { recursive: true })
/* Something outside the papers directory, for the confinement tests to fail to
   reach. */
writeFileSync(join(root, 'secret.tex'), 'this must never be served')

describe('where the papers come from', () => {
  test('an unset environment is not an empty directory', () => {
    /* The distinction the host's own holdings code is built around: an app that
       says "no papers" and quietly means "I was not configured" has told
       somebody the opposite of the truth. */
    expect(papersDir({})).toBeNull()
    expect(listPapers(null)).toEqual([])
  })

  test('KEHIKKO_PAPERS_DIR points straight at it', () => {
    expect(papersDir({ KEHIKKO_PAPERS_DIR: papers })).toBe(papers)
  })

  test('KEHIKKO_ROADMAP_DIR is accepted and data/papers appended', () => {
    const roadmap = join(root, 'roadmap')
    mkdirSync(join(roadmap, 'data', 'papers'), { recursive: true })
    expect(papersDir({ KEHIKKO_ROADMAP_DIR: roadmap })).toBe(join(roadmap, 'data', 'papers'))
  })

  test('a directory that is not there is refused rather than reported', () => {
    expect(papersDir({ KEHIKKO_PAPERS_DIR: join(root, 'nope') })).toBeNull()
  })
})

describe('listing', () => {
  test('only epics that actually have a main.tex are listed', () => {
    const all = listPapers(papers)
    expect(all.map((p) => p.epic)).toEqual(['good-epic'])
  })

  test('the title is the paper’s own and is never invented', () => {
    const [first] = listPapers(papers)
    expect(first?.title).toBe('A paper with a title')
    expect(first?.files).toBe(2)
  })
})

describe('reading one', () => {
  test('chapters are folded into reading order where the include sat', () => {
    const paper = readPaper('good-epic', papers)!
    const headings = paper.outline.map((h) => h.text)
    expect(headings).toEqual(['The first thing', 'The second thing'])
    expect(paper.files).toEqual(['main.tex', 'chapters/second.tex'])
  })

  test('the paper’s own macros reach the chapters that use them', () => {
    /*
     * The bug this guards: `\gh` is defined in `main.tex`'s preamble and used
     * in `chapters/*.tex`, which have no preamble at all. A chapter parsed on
     * its own terms finds no definition, falls back to "drop the wrapper, keep
     * the argument", and renders `gh#42` as the bare number `42`.
     */
    const paper = readPaper('good-epic', papers)!
    const text = paper.blocks
      .filter((b) => b.file === 'chapters/second.tex' && b.kind === 'paragraph')
      .flatMap((b) => ('segments' in b ? b.segments : []))
      .map((s) => s.text)
      .join('')
    expect(text).toContain('gh#42')
  })

  test('anchors are stable between two reads of the same paper', () => {
    /* The block counter used to run for the life of the process, so a second
       read renumbered every heading and a link a reader had in front of them
       scrolled nowhere. */
    const a = readPaper('good-epic', papers)!
    const b = readPaper('good-epic', papers)!
    expect(a.blocks.map((x) => `${x.file}:${x.id}`)).toEqual(b.blocks.map((x) => `${x.file}:${x.id}`))
  })

  test('an epic with no paper is null rather than an empty paper', () => {
    expect(readPaper('empty-epic', papers)).toBeNull()
  })
})

describe('the two fences', () => {
  test.each([
    '../secret',
    '..',
    '/etc',
    'Good-Epic',
    'good epic',
    'good/epic',
    '.',
    '',
  ])('%p is not an epic name', (attempt) => {
    expect(isEpic(attempt)).toBe(false)
    expect(readPaper(attempt, papers)).toBeNull()
  })

  test('an include that climbs out of the paper’s directory reads nothing', () => {
    /* The shape check cannot help here: `\include{../../secret}` is inside a
       `.tex` file the author wrote, and include targets legitimately contain
       slashes. So the second fence resolves the path and refuses anything that
       did not land under the epic's own directory. */
    mkdirSync(join(papers, 'climber'), { recursive: true })
    writeFileSync(
      join(papers, 'climber', 'main.tex'),
      '\\begin{document}\n\\include{../../secret}\n\\end{document}',
    )
    const paper = readPaper('climber', papers)!
    expect(paper.files).toEqual(['main.tex'])
    const raw = JSON.stringify(paper)
    expect(raw).not.toContain('this must never be served')
    /* And it says so, rather than showing a paper with a silent hole in it. */
    expect(raw).toContain('is not on disk here')
  })

  test('a symlink out of the tree is refused even though its path looks fine', () => {
    mkdirSync(join(papers, 'linker'), { recursive: true })
    writeFileSync(join(papers, 'linker', 'main.tex'), '\\begin{document}\n\\include{away}\n\\end{document}')
    symlinkSync(join(root, 'secret.tex'), join(papers, 'linker', 'away.tex'))
    const paper = readPaper('linker', papers)!
    expect(JSON.stringify(paper)).not.toContain('this must never be served')
  })

  test('read_source will only open a file the paper itself names', () => {
    /* Checked against the paper's own include list rather than against the
       filesystem, so "what does the paper say" cannot become "what is lying
       around next to it". */
    writeFileSync(join(papers, 'good-epic', 'scratch.tex'), 'notes to self')
    expect(readSource('good-epic', 'main.tex', papers)).toContain('\\title{A paper with a title}')
    expect(readSource('good-epic', 'chapters/second.tex', papers)).toContain('The second thing')
    expect(readSource('good-epic', 'scratch.tex', papers)).toBeNull()
    expect(readSource('good-epic', '../secret.tex', papers)).toBeNull()
  })
})
