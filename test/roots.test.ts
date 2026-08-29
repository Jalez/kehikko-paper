import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listPapers,
  readFigure,
  readPaper,
  readSource,
  roots,
  thesisRoot,
} from '../store.ts'

/**
 * The second readable root, and the property adding one must not cost.
 *
 * A thesis is not shaped like the papers directory. `main.tex` sits at the top
 * of its own repository, with `chapters/`, `figures/`, a `.cls` and a
 * `references.bib` beside it, and there is no parent directory full of siblings
 * to point `KEHIKKO_PAPERS_DIR` at. So it is a second configured root — see the
 * essay on `thesisRoot` for why the three ways of forcing it into the existing
 * model are each worse than a variable.
 *
 * The whole risk of a second root is that confinement becomes a union rather
 * than a list: one root's realpath compared against another root's target, and
 * `../` climbs out of one and back into the other. Every test in the second
 * half of this file exists to hold that line. `store.test.ts` covers the
 * original single-root fences and is not repeated here.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-roots-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/* A papers directory of the ordinary shape, so the two can be seen side by side. */
const papers = join(root, 'papers')
mkdirSync(join(papers, 'good-epic'), { recursive: true })
writeFileSync(
  join(papers, 'good-epic', 'main.tex'),
  ['\\title{A paper with a title}', '\\begin{document}', '\\section{One}', '\\end{document}'].join('\n'),
)
mkdirSync(join(papers, 'empty-epic'), { recursive: true })
writeFileSync(join(root, 'secret.tex'), 'this must never be served')

/* Eight bytes that are the PNG signature, for a byte-for-byte check. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
writeFileSync(join(root, 'secret.png'), PNG)

/* A thesis: one document, its own root, the shape the real corpus has. */
const thesis = join(root, 'a-thesis')
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
/* And a `references.bib`, which the roadmap's own papers do not have. Nothing
   here reads it — the bibliography is another module's business — and this is
   present so that a paper root carrying one is exercised rather than assumed
   harmless. */
writeFileSync(join(thesis, 'references.bib'), '@article{graesser2004autotutor,\n  year = {2004}\n}\n')

const asThesis = { KEHIKKO_THESIS_DIR: thesis }

describe('a thesis as a second root', () => {
  test('an unset variable is no second root at all', () => {
    expect(thesisRoot({})).toBeNull()
  })

  test('a directory with no main.tex is not a paper root', () => {
    /* The same distinction the papers directory draws: a folder with no
       `main.tex` is a place with no paper, not a paper this app failed to
       render. Said here rather than by a root that 404s later. */
    expect(thesisRoot({ KEHIKKO_THESIS_DIR: join(root, 'nope') })).toBeNull()
    expect(thesisRoot({ KEHIKKO_THESIS_DIR: join(papers, 'empty-epic') })).toBeNull()
  })

  test('the slug defaults to thesis and can be renamed', () => {
    expect(thesisRoot(asThesis)?.epic).toBe('thesis')
    expect(thesisRoot({ ...asThesis, KEHIKKO_THESIS_EPIC: 'educhat' })?.epic).toBe('educhat')
  })

  test('a slug from the environment passes the same shape check as one from a URL', () => {
    /* A variable is set by somebody standing closer, not by somebody more
       trustworthy, and this slug ends up in every URL the page builds. */
    expect(thesisRoot({ ...asThesis, KEHIKKO_THESIS_EPIC: '../..' })).toBeNull()
    expect(thesisRoot({ ...asThesis, KEHIKKO_THESIS_EPIC: 'Not A Slug' })).toBeNull()
  })

  test('it is listed beside the papers directory rather than instead of it', () => {
    const both = listPapers(papers, thesisRoot(asThesis)).map((p) => p.epic)
    expect(both).toContain('good-epic')
    expect(both).toContain('thesis')
  })

  test('it is readable with no papers directory configured at all', () => {
    /* The configuration the thesis is actually used in: one document, no
       roadmap. A null `papersDir()` used to end `readPaper` on its first line. */
    const paper = readPaper('thesis', null, thesisRoot(asThesis))!
    expect(paper.outline.map((h) => h.text)).toEqual(['The only chapter'])
    expect(paper.files).toEqual(['main.tex', 'chapters/one.tex'])
  })

  test('a title broken over lines is one line in the picker', () => {
    /* `\\` is an escape to the brace matcher and a line break to LaTeX, so it
       survived the command stripping and was printed literally in the picker.
       The real thesis has two of them in its `\title{}`. */
    const [brief] = listPapers(null, thesisRoot(asThesis))
    expect(brief?.title).toBe('Chat as an Exercise: Evaluating things in Education')
  })

  test('a slug collision leaves the paper that was already there alone', () => {
    /* A misconfiguration either way. This way the existing paper keeps working
       and the new variable is the one that visibly does nothing, rather than a
       second root silently shadowing a first. */
    const both = roots(papers, { epic: 'good-epic', dir: thesis })
    expect(both.filter((r) => r.epic === 'good-epic')).toHaveLength(1)
    expect(readPaper('good-epic', papers, { epic: 'good-epic', dir: thesis })!.title).toBe(
      'A paper with a title',
    )
  })

  test('a preamble with a class file and a bibliography resource is folded away, not shown', () => {
    const paper = readPaper('thesis', null, thesisRoot(asThesis))!
    const shown = JSON.stringify(paper.blocks.filter((b) => b.kind !== 'preamble'))
    expect(shown).not.toContain('tauthesis')
    expect(shown).not.toContain('graphicspath')
  })

  test('citations reach the page as readable text rather than as an unknown command', () => {
    const paper = readPaper('thesis', null, thesisRoot(asThesis))!
    const text = paper.blocks
      .flatMap((b) => ('segments' in b ? b.segments : []))
      .map((s) => s.text)
      .join('')
    expect(text).toContain('graesser2004autotutor')
    expect(text).toContain('nye2014autotutor')
  })
})

describe('figures, now that there are real ones', () => {
  test('the paper names its own graphics and nothing else', () => {
    const paper = readPaper('thesis', null, thesisRoot(asThesis))!
    expect(paper.figures).toEqual(['figures/plot.png', 'figures/drawing.pdf'])
  })

  test('a raster the paper named comes back with a type out of the table', () => {
    const figure = readFigure('thesis', 'figures/plot.png', null, thesisRoot(asThesis))!
    expect(figure.type).toBe('image/png')
    expect(Buffer.from(figure.bytes).equals(PNG)).toBe(true)
  })

  test('a file on disk the paper never named is not a figure', () => {
    /* The check that keeps this door from being a file server: membership in
       the paper's own list, never a `statSync` on the directory. */
    expect(readFigure('thesis', 'figures/private.png', null, thesisRoot(asThesis))).toBeNull()
  })

  test('PDF is refused even though the paper does name it', () => {
    /* An `<img>` cannot draw it, so serving it would mean an embedded viewer on
       this module's own origin — the same hazard as an SVG, which is refused
       for carrying script, with a larger surface. The reading view keeps the
       filename box for both. */
    expect(readFigure('thesis', 'figures/drawing.pdf', null, thesisRoot(asThesis))).toBeNull()
  })

  test('a graphics path that climbs out of the root is refused', () => {
    const climber = join(root, 'fig-climber')
    mkdirSync(climber, { recursive: true })
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
    const as = thesisRoot({ KEHIKKO_THESIS_DIR: climber })
    const paper = readPaper('thesis', null, as)!
    /* The paper does name it — an author can write anything, and this is a typo
       threat model more than a hostile one — so the membership check passes and
       `confine` is what refuses. */
    expect(paper.figures).toEqual(['../secret.png'])
    expect(readFigure('thesis', '../secret.png', null, as)).toBeNull()
  })

  test('a symlinked figure pointing out of the root is refused', () => {
    const linker = join(root, 'fig-linker')
    mkdirSync(join(linker, 'figures'), { recursive: true })
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
    const as = thesisRoot({ KEHIKKO_THESIS_DIR: linker })
    expect(readPaper('thesis', null, as)!.figures).toEqual(['figures/away.png'])
    expect(readFigure('thesis', 'figures/away.png', null, as)).toBeNull()
  })
})

describe('each root is confined to itself', () => {
  test('a paper under one root cannot be reached through the other', () => {
    expect(readPaper('good-epic', null, thesisRoot(asThesis))).toBeNull()
    expect(readPaper('thesis', papers, null)).toBeNull()
  })

  test('a source file is resolved against its own root and no other', () => {
    expect(readSource('thesis', 'main.tex', papers, thesisRoot(asThesis))).toContain('tauthesis')
    expect(readSource('thesis', '../secret.tex', papers, thesisRoot(asThesis))).toBeNull()
    expect(readSource('good-epic', '../../a-thesis/main.tex', papers, thesisRoot(asThesis))).toBeNull()
  })

  test('an include climbing out of the thesis root reads nothing and says so', () => {
    /* The same fence `store.test.ts` puts on the papers directory, held on the
       new root: a second root that skipped it would be a hole opened by
       configuration rather than by code. */
    const climber = join(root, 'inc-climber')
    mkdirSync(climber, { recursive: true })
    writeFileSync(
      join(climber, 'main.tex'),
      '\\begin{document}\n\\include{../secret}\n\\end{document}',
    )
    const paper = readPaper('thesis', null, thesisRoot({ KEHIKKO_THESIS_DIR: climber }))!
    expect(paper.files).toEqual(['main.tex'])
    const raw = JSON.stringify(paper)
    expect(raw).not.toContain('this must never be served')
    expect(raw).toContain('is not on disk here')
  })

  test('a thesis root that is itself a symlink is followed once and then held to', () => {
    /* Naming a symlink in `KEHIKKO_THESIS_DIR` is a person saying where their
       thesis is, which is fine. What is not fine is skipping the realpath,
       because every later `confine` inside the root compares against it — so
       the root is resolved on the way in and the fences still hold from there. */
    const link = join(root, 'thesis-link')
    symlinkSync(thesis, link)
    const as = thesisRoot({ KEHIKKO_THESIS_DIR: link })
    expect(readPaper('thesis', null, as)!.outline).toHaveLength(1)
    expect(readSource('thesis', '../secret.tex', null, as)).toBeNull()
  })
})
