import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { confine, isEpic, listPapers, readPaper, readSource } from '../store.ts'

/**
 * The store, which is a reader over somebody else's directory.
 *
 * Two things are worth a test and the rest is the parser's business: that
 * nothing here can be talked into reading a file outside the papers directory,
 * and that the two kinds of emptiness stay apart — "no papers" and "nobody said
 * where to look" are different sentences and the page shows different screens
 * for them.
 */

/*
 * The project, realpath'd, and the papers where a project keeps them by
 * default.
 *
 * `realpathSync` because `store.ts` resolves the project on the way in and
 * every fence measures against the result — on macOS `tmpdir()` is under
 * `/var`, which is a symlink to `/private/var`, and a fixture left unresolved
 * would make every comparison in this file fail for a reason that has nothing
 * to do with what is being tested.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const papers = join(root, '.kehikot', 'paper')
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
  test('no project is not an empty project', () => {
    /* The distinction the host's own holdings code is built around: an app that
       says "no papers" and quietly means "nobody told me where to look" has
       told somebody the opposite of the truth. `test/roots.test.ts` covers the
       three answers this splits into; here it is only that the two ends of it
       do not collapse. */
    expect(listPapers(null)).toEqual([])
    expect(listPapers(root).map((p) => p.epic)).toEqual(['good-epic'])
  })

  test('a project that is not a folder on this machine reads nothing', () => {
    expect(listPapers(join(root, 'nope'))).toEqual([])
  })
})

describe('listing', () => {
  test('only epics that actually have a main.tex are listed', () => {
    const all = listPapers(root)
    expect(all.map((p) => p.epic)).toEqual(['good-epic'])
  })

  test('the title is the paper’s own and is never invented', () => {
    const [first] = listPapers(root)
    expect(first?.title).toBe('A paper with a title')
    expect(first?.files).toBe(2)
  })
})

describe('reading one', () => {
  test('chapters are folded into reading order where the include sat', () => {
    const paper = readPaper('good-epic', root)!
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
    const paper = readPaper('good-epic', root)!
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
    const a = readPaper('good-epic', root)!
    const b = readPaper('good-epic', root)!
    expect(a.blocks.map((x) => `${x.file}:${x.id}`)).toEqual(b.blocks.map((x) => `${x.file}:${x.id}`))
  })

  test('an epic with no paper is null rather than an empty paper', () => {
    expect(readPaper('empty-epic', root)).toBeNull()
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
    expect(readPaper(attempt, root)).toBeNull()
  })

  test('an include that climbs out of the paper’s directory reads nothing', () => {
    /* The shape check cannot help here: `\include{../../secret}` is inside a
       `.tex` file the author wrote, and include targets legitimately contain
       slashes. So the second fence resolves the path and refuses anything that
       did not land under the epic's own directory. */
    mkdirSync(join(papers, 'climber'), { recursive: true })
    writeFileSync(
      join(papers, 'climber', 'main.tex'),
      '\\begin{document}\n\\include{../../../secret}\n\\end{document}',
    )
    const paper = readPaper('climber', root)!
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
    const paper = readPaper('linker', root)!
    expect(JSON.stringify(paper)).not.toContain('this must never be served')
  })

  test('read_source will only open a file the paper itself names', () => {
    /* Checked against the paper's own include list rather than against the
       filesystem, so "what does the paper say" cannot become "what is lying
       around next to it". */
    writeFileSync(join(papers, 'good-epic', 'scratch.tex'), 'notes to self')
    expect(readSource('good-epic', 'main.tex', root)).toContain('\\title{A paper with a title}')
    expect(readSource('good-epic', 'chapters/second.tex', root)).toContain('The second thing')
    expect(readSource('good-epic', 'scratch.tex', root)).toBeNull()
    expect(readSource('good-epic', '../secret.tex', root)).toBeNull()
  })
})

/**
 * The fence itself, asked directly.
 *
 * Every other test in this file goes through a reader, and every one of them
 * passed while `confine` was wrong — because `readFileSync` threw on the way
 * out and the reader returned null for a reason that had nothing to do with
 * the fence. A fence tested only through the thing standing behind it is a
 * fence whose failures are invisible until the thing behind it moves.
 *
 * So `confine` is exported for this, the way `inside` is in the explorer's
 * `tree/confine.ts`, and this block asks it the questions the readers cannot.
 */
describe('the fence, asked directly', () => {
  /*
   * Realpath'd, and the test does not work without it.
   *
   * `tmpdir()` on macOS is under `/var`, which is a symlink to `/private/var`.
   * A root left as the string `mkdtemp` returned makes every prefix comparison
   * in here compare `/var/...` against `/private/var/...` and fail for the
   * wrong reason — the fence would refuse everything and this file would be a
   * row of green ticks proving nothing. `roots()` realpaths its roots before
   * handing them out, so realpathing here is also the honest simulation of how
   * `confine` is actually called.
   */
  const fenced = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-fence-')))
  const inside = join(fenced, 'paper')
  const elsewhere = join(fenced, 'elsewhere')
  mkdirSync(join(inside, 'chapters'), { recursive: true })
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(inside, 'main.tex'), 'the paper')
  writeFileSync(join(elsewhere, 'secret.tex'), 'this must never be served')

  test('a file that is there and is inside is resolved', () => {
    expect(confine(inside, 'main.tex')).toBe(join(inside, 'main.tex'))
  })

  test('a path that climbs out is refused', () => {
    expect(confine(inside, '../elsewhere/secret.tex')).toBeNull()
  })

  test('a symlink pointing out of the tree is refused, though its string looks fine', () => {
    symlinkSync(join(elsewhere, 'secret.tex'), join(inside, 'away.tex'))
    expect(confine(inside, 'away.tex')).toBeNull()
  })

  test('a symlinked DIRECTORY plus a leaf that does not exist is refused', () => {
    /*
     * The hole this test was written to fail against.
     *
     * `confine` used to fall back to a lexical prefix check whenever
     * `realpathSync(target)` threw — and it throws for ENOENT, which is the
     * ordinary case of a leaf that is not there yet. The string it compared
     * was the UNRESOLVED target: `<root>/out/ghost.tex` starts with the root,
     * so the fence said yes and handed back a path that the filesystem would
     * have opened in `elsewhere/`.
     *
     * Nothing was actually served through it, and that is the point rather
     * than the defence: the only reason was that `readFileSync` threw next.
     * A fence that returns a path it should not, and relies on the next line
     * to fail, is one refactor away from being a hole — the day somebody
     * writes `existsSync(path)`, or a `mkdir -p`, or any operation that is
     * happy to CREATE the missing leaf, the escape becomes real. And the
     * comment above `confine` had already promised the parent was realpath'd,
     * so a reader auditing this file would have seen a fence that was correct
     * on paper.
     *
     * Exploitability is low — planting the symlink needs local write, and the
     * loopback threat model already trusts that user. The shape is the
     * problem, and it is exactly the shape explorer's first draft of
     * `tree/confine.ts` had.
     */
    symlinkSync(elsewhere, join(inside, 'out'))
    expect(confine(inside, 'out/ghost.tex')).toBeNull()
  })

  test('a leaf that does not exist inside a real directory is still resolved', () => {
    /* The other half, and the reason this is not "refuse everything that does
       not exist". `readPaper` asks about `chapters/x.tex` before it knows
       whether the author wrote it, and reports "is not on disk here" — which
       it can only do if the fence hands back a path to fail on. */
    expect(confine(inside, 'chapters/nothing-yet.tex')).toBe(join(inside, 'chapters', 'nothing-yet.tex'))
  })

  test('a sibling directory with the root as its prefix is not inside it', () => {
    /* `'/paper-evil'.startsWith('/paper')` is true, and the separator is the
       whole of the answer. The explorer has a test named after this one. */
    mkdirSync(`${inside}-evil`, { recursive: true })
    writeFileSync(join(`${inside}-evil`, 'main.tex'), 'not this one')
    expect(confine(inside, '../paper-evil/main.tex')).toBeNull()
  })
})
