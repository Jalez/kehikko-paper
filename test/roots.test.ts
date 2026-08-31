import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { keepsPapers, listPapers, pointers, projectOf, readFigure, readPaper, readSource, roots } from '../store.ts'

/**
 * Where a paper is, now that the answer is "in the project".
 *
 * This file used to be about a second root named by `KEHIKKO_THESIS_DIR`, and
 * every test in it was written to hold one line: that adding a second root must
 * not turn confinement into a UNION, where one root's realpath is compared
 * against another root's target and `../` climbs out of one and into the other.
 *
 * There are no environment variables any more. A paper lives in the project it
 * is about — `<project>/data/papers/<epic>/` by default, or wherever that
 * project's `.kehikot/paper/papers.json` says — and the property being defended
 * is the same one in a different shape: two projects on one disk, each with a
 * paper, and nothing reachable through the wrong one. The fixtures below are
 * two real project layouts, because the thesis case is what the old model could
 * not hold and a test using only the easy shape would prove nothing about it.
 *
 * Every path is realpath'd on the way in and every expectation compares against
 * a realpath'd fixture: `tmpdir()` on macOS is under `/var`, which is a symlink
 * to `/private/var`, and a test that skipped that would be green for the wrong
 * reason here and red somewhere else.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-roots-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/* Something no project may reach: at the top of the temporary directory, and
   therefore outside both projects below. */
writeFileSync(join(root, 'secret.tex'), 'this must never be served')

/* Eight bytes that are the PNG signature, for a byte-for-byte check. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
writeFileSync(join(root, 'secret.png'), PNG)

/* ------------------------------------------------------------------ *
 * A project of the ordinary shape: papers under `data/papers`, no pointer file
 * at all. This is the roadmap's own layout, and the point of making it the
 * default is that it needs no configuration to keep working.
 * ------------------------------------------------------------------ */

const roadmap = join(root, 'roadmap')
const papers = join(roadmap, 'data', 'papers')
mkdirSync(join(papers, 'good-epic'), { recursive: true })
writeFileSync(
  join(papers, 'good-epic', 'main.tex'),
  ['\\title{A paper with a title}', '\\begin{document}', '\\section{One}', '\\end{document}'].join('\n'),
)
/* A folder with no `main.tex`: an epic with no paper, not a paper that failed. */
mkdirSync(join(papers, 'empty-epic'), { recursive: true })
/* Inside the project and outside every paper root, for the fences to refuse. */
writeFileSync(join(roadmap, 'in-project-secret.tex'), 'nor this')

/* ------------------------------------------------------------------ *
 * A project that IS one paper: `main.tex` at the top of its own repository,
 * with `chapters/` and `figures/` beside it and no `data/papers` anywhere.
 * This is the shape `KEHIKKO_THESIS_DIR` existed for, and it is now one line in
 * a file inside the repository it is about.
 * ------------------------------------------------------------------ */

const thesis = join(root, 'a-thesis')
mkdirSync(join(thesis, 'chapters'), { recursive: true })
mkdirSync(join(thesis, 'figures'), { recursive: true })
mkdirSync(join(thesis, '.kehikot', 'paper'), { recursive: true })
writeFileSync(join(thesis, '.kehikot', 'paper', 'papers.json'), JSON.stringify({ papers: { thesis: '.' } }))
writeFileSync(
  join(thesis, 'main.tex'),
  [
    '\\documentclass{tauthesis}',
    '\\usepackage{graphicx}',
    '\\graphicspath{{figures/}}',
    '\\addbibresource{references.bib}',
    '\\title{Chat as an Exercise:\\\\Evaluating things\\\\in Education}',
    '\\author{Somebody Else}',
    '\\begin{document}',
    '\\include{chapters/one}',
    '\\printbibliography',
    '\\end{document}',
  ].join('\n'),
)
writeFileSync(
  join(thesis, 'chapters', 'one.tex'),
  [
    '\\chapter{The only chapter}',
    'A claim \\autocite{graesser2004autotutor,nye2014autotutor}.',
    '',
    '\\begin{figure}[h]',
    '\\includegraphics[width=0.6\\linewidth]{figures/plot.png}',
    '\\caption{A plot.}',
    '\\label{fig:plot}',
    '\\end{figure}',
    '',
    '\\begin{figure}[h]',
    '\\includegraphics{figures/drawing.pdf}',
    '\\caption{A drawing.}',
    '\\end{figure}',
  ].join('\n'),
)
writeFileSync(join(thesis, 'figures', 'plot.png'), PNG)
writeFileSync(join(thesis, 'figures', 'drawing.pdf'), '%PDF-1.7 not an image this app will serve')
/* A picture sitting in `figures/` that the author never put in the paper. */
writeFileSync(join(thesis, 'figures', 'private.png'), PNG)
/* And a `references.bib`, which the roadmap's own papers do not have. Nothing
   here reads it — a bibliography is another module's business — and it is
   present so that a paper root carrying one is exercised rather than assumed
   harmless. */
writeFileSync(join(thesis, 'references.bib'), '@article{graesser2004autotutor,\n  year = {2004}\n}\n')

describe('which directory is a project at all', () => {
  test('no project is null, and is not a failure', () => {
    expect(projectOf(null)).toBeNull()
    expect(projectOf(undefined)).toBeNull()
    expect(projectOf('')).toBeNull()
    expect(projectOf('   ')).toBeNull()
  })

  test('a relative path is refused rather than resolved against this module', () => {
    /* The failure it prevents: `data/papers` resolved against the paper app's
       own directory, serving this repository under the name of somebody's
       project. */
    expect(projectOf('data/papers')).toBeNull()
    expect(projectOf('../..')).toBeNull()
  })

  test('a path that is not a folder on this machine is null, not a root', () => {
    expect(projectOf(join(root, 'nowhere-at-all'))).toBeNull()
    expect(projectOf(join(root, 'secret.tex'))).toBeNull()
  })

  test('a real project comes back resolved, so every later fence measures one string', () => {
    expect(projectOf(roadmap)).toBe(roadmap)
    expect(projectOf(`${roadmap}/`)).toBe(roadmap)
  })
})

describe('a project of the ordinary shape needs no configuration', () => {
  test('data/papers/<epic>/main.tex is found by looking', () => {
    expect(listPapers(roadmap).map((p) => p.epic)).toEqual(['good-epic'])
    expect(readPaper('good-epic', roadmap)!.title).toBe('A paper with a title')
  })

  test('a folder with no main.tex is an epic with no paper', () => {
    expect(readPaper('empty-epic', roadmap)).toBeNull()
    expect(listPapers(roadmap).map((p) => p.epic)).not.toContain('empty-epic')
  })

  test('no project means no papers, and never every paper on the machine', () => {
    expect(roots(null)).toEqual([])
    expect(listPapers(null)).toEqual([])
    expect(readPaper('good-epic', null)).toBeNull()
    expect(readSource('good-epic', 'main.tex', null)).toBeNull()
    expect(keepsPapers(null)).toBe(false)
  })
})

describe('the pointer file, for a project whose paper is somewhere else', () => {
  test('a project that is itself one paper is read through "."', () => {
    /* The whole reason the file exists. A thesis has no `data/papers` and never
       will: one line says the paper IS the project, and it travels with the
       repository rather than with a shell. */
    expect(pointers(thesis)).toEqual({ thesis: '.' })
    const paper = readPaper('thesis', thesis)!
    expect(paper.outline.map((h) => h.text)).toEqual(['The only chapter'])
    expect(paper.files).toEqual(['main.tex', 'chapters/one.tex'])
  })

  test('a title broken over lines is one line when the paper is named', () => {
    /* `\\` is an escape to the brace matcher and a line break to LaTeX, so it
       survived the command stripping and was printed literally where the paper
       is named. The real thesis has two of them in its `\title{}`. */
    expect(listPapers(thesis)[0]?.title).toBe('Chat as an Exercise: Evaluating things in Education')
  })

  test('a project with no pointer file declares no exceptions, and that is not an error', () => {
    expect(pointers(roadmap)).toEqual({})
    expect(listPapers(roadmap).map((p) => p.epic)).toEqual(['good-epic'])
  })

  test('a malformed file is an empty answer rather than a broken page', () => {
    /*
     * The file is hand-editable by design, so a typo in it must degrade to
     * "this project declares no exceptions" rather than to a container that
     * will not draw. A pointer file that could take the page down would be more
     * dangerous than the variables it replaced.
     */
    const broken = join(root, 'broken-pointers')
    const file = join(broken, '.kehikot', 'paper', 'papers.json')
    mkdirSync(join(broken, '.kehikot', 'paper'), { recursive: true })

    writeFileSync(file, '{ "papers": { "thesis": ')
    expect(pointers(broken)).toEqual({})

    writeFileSync(file, '["not", "an", "object"]')
    expect(pointers(broken)).toEqual({})

    writeFileSync(file, JSON.stringify({ papers: { thesis: 7 } }))
    expect(pointers(broken)).toEqual({})

    writeFileSync(file, JSON.stringify({ elsewhere: { thesis: '.' } }))
    expect(pointers(broken)).toEqual({})
  })

  test('a key that is not an epic name is dropped, though it arrived from a file', () => {
    /* A file is written by somebody standing closer, not by somebody more
       trustworthy, and this key becomes a slug the page and the wire both
       carry. A key this app accepted that a host would refuse is a paper
       nothing can ever point at. */
    const odd = join(root, 'odd-keys')
    mkdirSync(join(odd, '.kehikot', 'paper'), { recursive: true })
    writeFileSync(
      join(odd, '.kehikot', 'paper', 'papers.json'),
      JSON.stringify({ papers: { '../..': '.', 'Not A Slug': '.', ok: '.' } }),
    )
    expect(Object.keys(pointers(odd))).toEqual(['ok'])
  })

  test('a value pointing out of the project is refused by the fence, not by the parser', () => {
    /*
     * `pointers` keeps the string — it is a shape check, not a fence — and
     * `roots` is where it is measured against the project root. The split is
     * deliberate: one place decides which paths are reachable, and it is the
     * place that has already resolved the root it measures against.
     */
    const escaping = join(root, 'escaping')
    mkdirSync(join(escaping, '.kehikot', 'paper'), { recursive: true })
    writeFileSync(
      join(escaping, '.kehikot', 'paper', 'papers.json'),
      JSON.stringify({ papers: { away: '../a-thesis', up: '../..' } }),
    )
    expect(pointers(escaping)).toEqual({ away: '../a-thesis', up: '../..' })
    expect(roots(escaping)).toEqual([])
    expect(readPaper('away', escaping)).toBeNull()
  })

  test('a pointer at a directory with no main.tex is not a root', () => {
    /* The same judgement `data/papers` gets. Without it, `"."` in any project
       would make every project a paper. */
    const empty = join(root, 'pointing-at-nothing')
    mkdirSync(join(empty, '.kehikot', 'paper'), { recursive: true })
    mkdirSync(join(empty, 'somewhere'), { recursive: true })
    writeFileSync(
      join(empty, '.kehikot', 'paper', 'papers.json'),
      JSON.stringify({ papers: { here: '.', there: 'somewhere' } }),
    )
    expect(roots(empty)).toEqual([])
  })

  test('an exception wins over a directory that merely exists', () => {
    /*
     * The opposite of the rule the two environment variables had, deliberately.
     * `data/papers/<epic>/` is found by LOOKING — a directory that happens to
     * be there, possibly left behind by a checkout — and a pointer is a
     * sentence somebody wrote about this project on purpose. When the two
     * disagree, the one with an author behind it wins.
     */
    const both = join(root, 'both-ways')
    mkdirSync(join(both, 'data', 'papers', 'twice'), { recursive: true })
    mkdirSync(join(both, 'elsewhere'), { recursive: true })
    mkdirSync(join(both, '.kehikot', 'paper'), { recursive: true })
    writeFileSync(
      join(both, 'data', 'papers', 'twice', 'main.tex'),
      '\\title{The discovered one}\n\\begin{document}\\end{document}',
    )
    writeFileSync(
      join(both, 'elsewhere', 'main.tex'),
      '\\title{The one somebody wrote down}\n\\begin{document}\\end{document}',
    )
    writeFileSync(join(both, '.kehikot', 'paper', 'papers.json'), JSON.stringify({ papers: { twice: 'elsewhere' } }))
    expect(roots(both).filter((r) => r.epic === 'twice')).toHaveLength(1)
    expect(readPaper('twice', both)!.title).toBe('The one somebody wrote down')
  })
})

describe('figures, in a project shaped like a thesis', () => {
  test('the paper names its own graphics and nothing else', () => {
    expect(readPaper('thesis', thesis)!.figures).toEqual(['figures/plot.png', 'figures/drawing.pdf'])
  })

  test('a raster the paper named comes back with a type out of the table', () => {
    const figure = readFigure('thesis', 'figures/plot.png', thesis)!
    expect(figure.type).toBe('image/png')
    expect(Buffer.from(figure.bytes).equals(PNG)).toBe(true)
  })

  test('a file on disk the paper never named is not a figure', () => {
    /* The check that keeps this door from being a file server: membership in
       the paper's own list, never a `statSync` on the directory. */
    expect(readFigure('thesis', 'figures/private.png', thesis)).toBeNull()
  })

  test('PDF is refused even though the paper does name it', () => {
    /* An `<img>` cannot draw it, so serving it would mean an embedded viewer on
       this module's own origin — the same hazard as an SVG, which is refused
       for carrying script, with a larger surface. */
    expect(readFigure('thesis', 'figures/drawing.pdf', thesis)).toBeNull()
  })

  test('a graphics path that climbs out of the paper root is refused', () => {
    const climber = join(root, 'fig-climber')
    mkdirSync(join(climber, '.kehikot', 'paper'), { recursive: true })
    writeFileSync(join(climber, '.kehikot', 'paper', 'papers.json'), JSON.stringify({ papers: { one: '.' } }))
    writeFileSync(
      join(climber, 'main.tex'),
      [
        '\\begin{document}',
        '\\begin{figure}',
        '\\includegraphics{../secret.png}',
        '\\end{figure}',
        '\\end{document}',
      ].join('\n'),
    )
    /* The paper does name it — an author can write anything, and this is a typo
       threat model more than a hostile one — so the membership check passes and
       `confine` is what refuses. */
    expect(readPaper('one', climber)!.figures).toEqual(['../secret.png'])
    expect(readFigure('one', '../secret.png', climber)).toBeNull()
  })

  test('a symlinked figure pointing out of the root is refused', () => {
    const linker = join(root, 'fig-linker')
    mkdirSync(join(linker, 'figures'), { recursive: true })
    mkdirSync(join(linker, '.kehikot', 'paper'), { recursive: true })
    writeFileSync(join(linker, '.kehikot', 'paper', 'papers.json'), JSON.stringify({ papers: { one: '.' } }))
    writeFileSync(
      join(linker, 'main.tex'),
      [
        '\\begin{document}',
        '\\begin{figure}',
        '\\includegraphics{figures/away.png}',
        '\\end{figure}',
        '\\end{document}',
      ].join('\n'),
    )
    symlinkSync(join(root, 'secret.png'), join(linker, 'figures', 'away.png'))
    expect(readPaper('one', linker)!.figures).toEqual(['figures/away.png'])
    expect(readFigure('one', 'figures/away.png', linker)).toBeNull()
  })
})

describe('each root is confined to itself, and each project to itself', () => {
  test('a paper in one project cannot be reached through another', () => {
    expect(readPaper('good-epic', thesis)).toBeNull()
    expect(readPaper('thesis', roadmap)).toBeNull()
  })

  test('a source file is resolved against its own root and no other', () => {
    expect(readSource('thesis', 'main.tex', thesis)).toContain('tauthesis')
    expect(readSource('thesis', '../secret.tex', thesis)).toBeNull()
    expect(readSource('good-epic', '../../../a-thesis/main.tex', roadmap)).toBeNull()
  })

  test('the fence is the epic directory and not the project, even in the ordinary shape', () => {
    /* `data/papers/good-epic/` is the root, not `roadmap/`. Otherwise one
       epic's `\include` could reach into the next epic's paper, or into the
       rest of somebody's repository, and every path would still be "inside the
       project". */
    expect(readSource('good-epic', '../../../in-project-secret.tex', roadmap)).toBeNull()
    expect(readPaper('good-epic', roadmap)!.files).toEqual(['main.tex'])
  })

  test('an include climbing out of the root reads nothing and says so', () => {
    const climber = join(root, 'inc-climber')
    mkdirSync(join(climber, '.kehikot', 'paper'), { recursive: true })
    writeFileSync(join(climber, '.kehikot', 'paper', 'papers.json'), JSON.stringify({ papers: { one: '.' } }))
    writeFileSync(join(climber, 'main.tex'), '\\begin{document}\n\\include{../secret}\n\\end{document}')
    const paper = readPaper('one', climber)!
    expect(paper.files).toEqual(['main.tex'])
    const raw = JSON.stringify(paper)
    expect(raw).not.toContain('this must never be served')
    /* And it says so, rather than showing a paper with a silent hole in it. */
    expect(raw).toContain('is not on disk here')
  })

  test('a project named through a symlink is followed once and then held to', () => {
    /* Naming a symlink is a host saying where a project is, which is fine. What
       is not fine is skipping the realpath, because every later `confine`
       compares against the root that came out of here. */
    const link = join(root, 'thesis-link')
    symlinkSync(thesis, link)
    expect(projectOf(link)).toBe(thesis)
    expect(readPaper('thesis', projectOf(link))!.outline).toHaveLength(1)
    expect(readSource('thesis', '../secret.tex', projectOf(link))).toBeNull()
  })

  test('a project with neither layout keeps no papers, which is a sentence of its own', () => {
    /* Not a fence — `roots` already returns nothing — but the difference
       between "no paper for this epic" and "this project was never set up for
       papers at all", which are two different things to do next. */
    const bare = join(root, 'bare-project')
    mkdirSync(bare, { recursive: true })
    expect(keepsPapers(bare)).toBe(false)
    expect(keepsPapers(roadmap)).toBe(true)
    expect(keepsPapers(thesis)).toBe(true)
  })
})
