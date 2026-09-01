import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  keepsPapers,
  listPapers,
  projectOf,
  readFigure,
  readPaper,
  readSource,
  roots,
  startPaper,
  whereItWouldGo,
} from '../store.ts'

/**
 * Where a paper is, now that the answer is "in the project".
 *
 * This file used to be about a second root named by `KEHIKKO_THESIS_DIR`, and
 * every test in it was written to hold one line: that adding a second root must
 * not turn confinement into a UNION, where one root's realpath is compared
 * against another root's target and `../` climbs out of one and into the other.
 *
 * There are no environment variables any more, and no pointer file either. A
 * paper lives at `<project>/.kehikot/paper/<epic>/main.tex` and nowhere else —
 * one rule, found with the same `moduleDir` every module in this family uses —
 * and the property being defended is the old one in a different shape: two
 * projects on one disk, each with a paper, and nothing reachable through the
 * wrong one.
 *
 * The fixtures are two projects that differ in what they HOLD rather than in
 * where they hold it, which is the point of the change. One has a paper among
 * other things; the other is a thesis, which used to mean `main.tex` at the top
 * of its own repository and a line in a file saying so. It does not mean that
 * any more: a thesis is a paper like any other, in the folder papers go in.
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
 * A project holding several papers, one per epic. Nothing is configured; the
 * folder is where `moduleDir` says this module's folder is.
 * ------------------------------------------------------------------ */

const roadmap = join(root, 'roadmap')
const papers = join(roadmap, '.kehikot', 'paper')
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
 * A project whose one paper is a thesis: a `main.tex` with a class and a
 * bibliography, `chapters/` and `figures/` beside it. Under the old model this
 * was the shape that needed a pointer file, because the paper sat at the top of
 * its own repository. It sits where every other paper sits now, and the
 * fixtures below are the same files in the folder they belong in.
 * ------------------------------------------------------------------ */

const thesisProject = join(root, 'a-thesis')
const thesis = join(thesisProject, '.kehikot', 'paper', 'thesis')
mkdirSync(join(thesis, 'chapters'), { recursive: true })
mkdirSync(join(thesis, 'figures'), { recursive: true })
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
/* Inside the thesis PROJECT and outside its paper, for the fences to refuse. */
writeFileSync(join(thesisProject, 'in-project-secret.tex'), 'nor this')
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

describe('a paper is found by looking, and there is one place to look', () => {
  test('.kehikot/paper/<epic>/main.tex is found with no configuration at all', () => {
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

describe('the pointer file, which is gone, and what replaced it', () => {
  /*
   * There was a `papers.json` in this folder naming an epic and the directory
   * its paper was in, for projects whose layout did not match a default. Twelve
   * tests here covered its parsing, its fences, and which of the two sources won
   * when they disagreed. All of it is gone.
   *
   * The user's objection was the right one: a file whose job is to record how
   * THIS project differs is config that grows an entry per project, and having
   * two roads to a paper meant reading either one alone never told you which had
   * applied. There is one road now, so there is nothing to reconcile, no
   * precedence rule to get wrong, and no file to parse.
   *
   * What is left here is the property those tests were really defending: a
   * directory becomes a paper by holding a `main.tex`, and by nothing else.
   */
  test('a thesis is a paper like any other, in the folder papers go in', () => {
    expect(roots(thesisProject).map((r) => r.epic)).toEqual(['thesis'])
    expect(readPaper('thesis', thesisProject)!.epic).toBe('thesis')
  })

  test('a title broken over lines is one line when the paper is named', () => {
    /* `\\` in a `\title` is a line break for the typesetter and nothing to a
       picker, which shows one paper per row. */
    expect(listPapers(thesisProject)[0]?.title).toBe('Chat as an Exercise: Evaluating things in Education')
  })

  test('a folder with no main.tex is not a paper, however it is named', () => {
    /* Without this, an empty directory left by a checkout would put a button in
       a picker that could only ever say "nothing here". */
    const bare = join(root, 'empty-paper-folder')
    mkdirSync(join(bare, '.kehikot', 'paper', 'looks-like-one'), { recursive: true })
    expect(roots(bare)).toEqual([])
  })

  test('a folder whose name is not an epic is skipped, though it arrived from a disk', () => {
    /* The name becomes a slug the page and the wire both carry, so a folder this
       app accepted that a host would refuse is a paper nothing can point at.
       `..` is in the list because it is a directory name before it is anything
       else, and this is the check that runs before the path is built. */
    const odd = join(root, 'odd-names')
    for (const name of ['Not An Epic', 'UPPER', 'has spaces', 'ok-epic']) {
      mkdirSync(join(odd, '.kehikot', 'paper', name), { recursive: true })
      writeFileSync(join(odd, '.kehikot', 'paper', name, 'main.tex'), '\\begin{document}\\end{document}')
    }
    expect(roots(odd).map((r) => r.epic)).toEqual(['ok-epic'])
  })

  test('a paper folder that is a symlink out of the project is refused', () => {
    /* The fence that mattered most about the pointer file has not gone away —
       it has moved to the only place a path can now come from. */
    const escaping = join(root, 'escaping')
    mkdirSync(join(escaping, '.kehikot', 'paper'), { recursive: true })
    const away = join(root, 'away-paper')
    mkdirSync(away, { recursive: true })
    writeFileSync(join(away, 'main.tex'), '\\title{Elsewhere}\\begin{document}\\end{document}')
    symlinkSync(away, join(escaping, '.kehikot', 'paper', 'gone'))
    expect(roots(escaping)).toEqual([])
  })
})

describe('figures, in a project whose paper is a thesis', () => {
  test('the paper names its own graphics and nothing else', () => {
    expect(readPaper('thesis', thesisProject)!.figures).toEqual(['figures/plot.png', 'figures/drawing.pdf'])
  })

  test('a raster the paper named comes back with a type out of the table', () => {
    const figure = readFigure('thesis', 'figures/plot.png', thesisProject)!
    expect(figure.type).toBe('image/png')
    expect(Buffer.from(figure.bytes).equals(PNG)).toBe(true)
  })

  test('a file on disk the paper never named is not a figure', () => {
    /* The check that keeps this door from being a file server: membership in
       the paper's own list, never a `statSync` on the directory. */
    expect(readFigure('thesis', 'figures/private.png', thesisProject)).toBeNull()
  })

  test('PDF is refused even though the paper does name it', () => {
    /* An `<img>` cannot draw it, so serving it would mean an embedded viewer on
       this module's own origin — the same hazard as an SVG, which is refused
       for carrying script, with a larger surface. */
    expect(readFigure('thesis', 'figures/drawing.pdf', thesisProject)).toBeNull()
  })

  test('a graphics path that climbs out of the paper root is refused', () => {
    const climber = join(root, 'fig-climber')
    mkdirSync(join(climber, '.kehikot', 'paper', 'one'), { recursive: true })
    writeFileSync(
      join(climber, '.kehikot', 'paper', 'one', 'main.tex'),
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
    const linkerPaper = join(linker, '.kehikot', 'paper', 'one')
    mkdirSync(join(linkerPaper, 'figures'), { recursive: true })
    writeFileSync(
      join(linkerPaper, 'main.tex'),
      [
        '\\begin{document}',
        '\\begin{figure}',
        '\\includegraphics{figures/away.png}',
        '\\end{figure}',
        '\\end{document}',
      ].join('\n'),
    )
    symlinkSync(join(root, 'secret.png'), join(linkerPaper, 'figures', 'away.png'))
    expect(readPaper('one', linker)!.figures).toEqual(['figures/away.png'])
    expect(readFigure('one', 'figures/away.png', linker)).toBeNull()
  })
})

describe('each root is confined to itself, and each project to itself', () => {
  test('a paper in one project cannot be reached through another', () => {
    expect(readPaper('good-epic', thesisProject)).toBeNull()
    expect(readPaper('thesis', roadmap)).toBeNull()
  })

  test('a source file is resolved against its own root and no other', () => {
    expect(readSource('thesis', 'main.tex', thesisProject)).toContain('tauthesis')
    expect(readSource('thesis', '../secret.tex', thesisProject)).toBeNull()
    expect(readSource('good-epic', '../../../../a-thesis/main.tex', roadmap)).toBeNull()
  })

  test('the fence is the paper directory and not the project', () => {
    /* `.kehikot/paper/good-epic/` is the root, not `roadmap/`. Otherwise one
       epic's `\include` could reach into the next epic's paper, or into the
       rest of somebody's repository, and every path would still be "inside the
       project". The climb is longer now and the answer is the same. */
    expect(readSource('good-epic', '../../../in-project-secret.tex', roadmap)).toBeNull()
    expect(readSource('good-epic', '../../../../in-project-secret.tex', roadmap)).toBeNull()
    expect(readPaper('good-epic', roadmap)!.files).toEqual(['main.tex'])
  })

  test('an include climbing out of the root reads nothing and says so', () => {
    const climber = join(root, 'inc-climber')
    mkdirSync(join(climber, '.kehikot', 'paper', 'one'), { recursive: true })
    writeFileSync(
      join(climber, '.kehikot', 'paper', 'one', 'main.tex'),
      '\\begin{document}\n\\include{../secret}\n\\end{document}',
    )
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
    symlinkSync(thesisProject, link)
    expect(projectOf(link)).toBe(thesisProject)
    expect(readPaper('thesis', projectOf(link))!.outline).toHaveLength(1)
    expect(readSource('thesis', '../secret.tex', projectOf(link))).toBeNull()
  })

  test('a project that keeps no papers is a sentence of its own, and .kehikot alone is not it', () => {
    /*
     * Not a fence — `roots` already returns nothing — but the difference between
     * "no paper for this epic" and "this project was never set up for papers at
     * all", which are two different things to do next.
     *
     * The middle case is the bug this test exists for. `keepsPapers` used to ask
     * whether `.kehikot/` existed, and it exists in any project where journeys
     * or references has ever saved anything. The Community portal — which has
     * never held a paper — was therefore told it "keeps papers", so the reader
     * got the terse sentence written for a project that has papers but none for
     * this epic. Two sentences whose whole job is to be different, and the wrong
     * one was chosen by a folder another module made.
     */
    const bare = join(root, 'bare-project')
    mkdirSync(bare, { recursive: true })
    expect(keepsPapers(bare)).toBe(false)

    const others = join(root, 'other-modules-only')
    mkdirSync(join(others, '.kehikot', 'journeys'), { recursive: true })
    expect(keepsPapers(others)).toBe(false)

    expect(keepsPapers(roadmap)).toBe(true)
    expect(keepsPapers(thesisProject)).toBe(true)
  })
})

describe('starting a paper, which is the one thing this module writes', () => {
  test('says where a paper would go, whether or not one is there', () => {
    expect(whereItWouldGo('good-epic', roadmap)).toBe(join(papers, 'good-epic'))
    expect(whereItWouldGo('not-written-yet', roadmap)).toBe(join(papers, 'not-written-yet'))
    /* No project and no epic are both "there is no such place", and inventing a
       plausible-looking path would be worse than saying nothing. */
    expect(whereItWouldGo('good-epic', null)).toBeNull()
    expect(whereItWouldGo('../climb', roadmap)).toBeNull()
  })

  test('makes a folder with a document in it, and the paper reads immediately', () => {
    const fresh = join(root, 'starting-here')
    mkdirSync(fresh, { recursive: true })
    const made = startPaper('a-new-one', fresh)
    expect(made.ok).toBe(true)

    /* The point of writing a real document rather than a template: what appears
       is a paper, not a message about one. */
    const paper = readPaper('a-new-one', fresh)
    expect(paper).not.toBeNull()
    expect(paper!.title).toBe('a-new-one')
    expect(roots(fresh).map((r) => r.epic)).toEqual(['a-new-one'])
    expect(keepsPapers(fresh)).toBe(true)
  })

  /*
   * The failure this forecloses is the only one that matters: a button labelled
   * "start a paper" replacing a paper somebody had already started. There is no
   * flag to force it, so it cannot happen by being called wrongly.
   */
  test('refuses rather than overwriting, and touches nothing when it does', () => {
    const before = readSource('good-epic', 'main.tex', roadmap)
    const again = startPaper('good-epic', roadmap)
    expect(again.ok).toBe(false)
    expect(readSource('good-epic', 'main.tex', roadmap)).toBe(before)
  })

  test('refuses a folder that is there but empty, rather than filling it in', () => {
    /* `empty-epic` is a directory with no `main.tex` — an epic with no paper.
       Writing into it would be this app deciding what somebody's empty folder
       was for. */
    const said = startPaper('empty-epic', roadmap)
    expect(said.ok).toBe(false)
  })

  test('with no project there is nowhere to write, and nothing is invented', () => {
    expect(startPaper('anything', null).ok).toBe(false)
  })
})
