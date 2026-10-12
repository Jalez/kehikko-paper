import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { partRunsFor, type Engine } from '../compile/engine.ts'
import { DRIVER, KEPT_PARTS, driverText, isIntermediate, onlyLine, planOf, toEvict, unresolved, type Pulled } from '../compile/part.ts'
import { coveredBy, pageOfSheet, pagesOfSheets, partOf, sheetOfPage, sheetsOf, type Narrowed } from '../src/focus.ts'
import { readPaper } from '../store.ts'

/**
 * A picked part compiled on its own: everything about it that is decided
 * without running anything.
 *
 * Which selections `\includeonly` can show and what is said for the ones it
 * cannot; exactly what each engine is told; which of a build's files are kept
 * for the next; which kept selections go; and the arithmetic between a sheet
 * of a part's own PDF and a page of the paper, which is what keeps a sheet
 * number from ever leaving this module as though it were a page.
 */

const include = (as: string, by = 'main.tex'): Pulled => ({ by, with: 'include', as })
const input = (as: string, by = 'main.tex'): Pulled => ({ by, with: 'input', as })

describe('which picked files can be compiled on their own', () => {
  const thesis = {
    files: ['main.tex', 'notes.tex', 'chapters/intro.tex', 'chapters/methods.tex', 'tables/t1.tex', 'tables/deep.tex', 'chapters/results.tex'],
    pulls: {
      'notes.tex': input('notes'),
      'chapters/intro.tex': include('chapters/intro'),
      'chapters/methods.tex': include('chapters/methods'),
      'tables/t1.tex': input('tables/t1', 'chapters/methods.tex'),
      'tables/deep.tex': input('tables/deep', 'tables/t1.tex'),
      'chapters/results.tex': include('chapters/results'),
    },
  }

  test('nothing picked is nothing to compile', () => {
    expect(planOf([], thesis)).toBeNull()
  })

  test('a file main.tex pulls in with \\include is given to \\includeonly under the name the paper wrote', () => {
    expect(planOf(['chapters/methods.tex'], thesis)).toEqual({ only: ['chapters/methods'], files: ['chapters/methods.tex'] })
  })

  test('several are given in the order they were picked in — the paper’s', () => {
    expect(planOf(['chapters/intro.tex', 'chapters/results.tex'], thesis)).toMatchObject({ only: ['chapters/intro', 'chapters/results'] })
  })

  test('a file a picked chapter pulls in, at any depth, comes with the chapter', () => {
    expect(planOf(['chapters/methods.tex', 'tables/t1.tex', 'tables/deep.tex'], thesis)).toEqual({
      only: ['chapters/methods'],
      files: ['chapters/methods.tex', 'tables/t1.tex', 'tables/deep.tex'],
    })
  })

  test('a file pulled in with \\input cannot be, and the sentence names it, who pulls it in and how', () => {
    expect(planOf(['notes.tex'], thesis)).toEqual({
      cannot: 'No page is shown for the picked part: main.tex pulls notes.tex in with \\input, and only a file pulled in with \\include can be compiled on its own.',
    })
  })

  test('nor a chapter’s own table without the chapter', () => {
    expect(planOf(['tables/t1.tex'], thesis)?.cannot).toContain('chapters/methods.tex pulls tables/t1.tex in with \\input')
  })

  test('one file that cannot be makes the whole selection one that cannot: no part with a hole in it', () => {
    const plan = planOf(['notes.tex', 'chapters/methods.tex'], thesis, 'the picked parts')
    expect(plan?.only).toBeUndefined()
    expect(plan?.cannot).toStartWith('No page is shown for the picked parts: main.tex pulls notes.tex in with \\input')
  })

  test('main.tex itself is the whole paper', () => {
    expect(planOf(['main.tex'], thesis)?.cannot).toContain('main.tex is the file the whole paper is compiled from')
  })

  test('a paper that narrows itself overrules anything given from outside, and is told so', () => {
    expect(planOf(['chapters/methods.tex'], { ...thesis, narrowsItself: true })?.cannot).toContain('\\includeonly of its own')
  })

  test('a name \\includeonly cannot carry — a space, a comma, anything a shell reads — is refused rather than quoted', () => {
    for (const as of ['chapters/my chapter', 'a,b', 'x$(id)', 'a"b', "a'b", 'a`b', 'a\\b', 'a;b', 'a{b}']) {
      const plan = planOf(['c.tex'], { files: ['main.tex', 'c.tex'], pulls: { 'c.tex': include(as) } })
      expect(plan?.cannot).toContain('has a character \\includeonly cannot carry')
    }
    expect(planOf(['c.tex'], { files: ['main.tex', 'c.tex'], pulls: { 'c.tex': include('./chapters/3_methods-v2.tex') } })?.only).toEqual(['./chapters/3_methods-v2.tex'])
  })
})

describe('how a paper’s files are pulled in, read off the paper', () => {
  let root = ''
  let project = ''
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'paper-pulls-')))
    project = join(root, 'project')
    const paper = join(project, '.kehikot', 'paper', 'pulled')
    mkdirSync(join(paper, 'chapters'), { recursive: true })
    mkdirSync(join(paper, 'tables'), { recursive: true })
    writeFileSync(
      join(paper, 'main.tex'),
      [
        '\\documentclass[11pt,a4paper]{report}',
        '% \\begin{document} in a comment is not the document, and \\include{chapters/ghost} in one pulls nothing in',
        '\\input{macros}',
        '\\begin{document}',
        '\\include{chapters/one}',
        '\\input{chapters/two}',
        '\\include{chapters/with space}',
        '\\end{document}',
        '',
      ].join('\n'),
    )
    writeFileSync(join(paper, 'macros.tex'), '\\newcommand{\\work}[1]{#1}\n')
    writeFileSync(join(paper, 'chapters', 'one.tex'), '\\chapter{One}\n\\input{tables/t}\n')
    writeFileSync(join(paper, 'chapters', 'two.tex'), '\\chapter{Two}\n')
    writeFileSync(join(paper, 'chapters', 'with space.tex'), '\\chapter{Three}\n')
    writeFileSync(join(paper, 'tables', 't.tex'), 'A table.\n')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('by which file, with which command, and under the name it was given', () => {
    const paper = readPaper('pulled', project)!
    expect(paper.files).toEqual(['main.tex', 'macros.tex', 'chapters/one.tex', 'tables/t.tex', 'chapters/two.tex', 'chapters/with space.tex'])
    expect(paper.pulls).toEqual({
      'macros.tex': { by: 'main.tex', with: 'input', as: 'macros' },
      'chapters/one.tex': { by: 'main.tex', with: 'include', as: 'chapters/one' },
      'tables/t.tex': { by: 'chapters/one.tex', with: 'input', as: 'tables/t' },
      'chapters/two.tex': { by: 'main.tex', with: 'input', as: 'chapters/two' },
      'chapters/with space.tex': { by: 'main.tex', with: 'include', as: 'chapters/with space' },
    })
    expect(paper.narrowsItself).toBe(false)
    expect(planOf(['chapters/one.tex'], paper)?.only).toEqual(['chapters/one'])
    expect(planOf(['chapters/two.tex'], paper)?.cannot).toContain('with \\input')
    expect(planOf(['chapters/with space.tex'], paper)?.cannot).toContain('cannot carry')
  })
})

describe('what an engine is told, for a part', () => {
  const ahead = onlyLine(['chapters/a', 'chapters/b'])

  test('the line put ahead of the paper', () => {
    expect(ahead).toBe('\\includeonly{chapters/a,chapters/b}')
    expect(driverText(['chapters/a'])).toBe('\\includeonly{chapters/a}\\input{main.tex}\n')
    expect(DRIVER).toBe('kehikot-only')
  })

  test('latexmk: the same switches as the whole paper, the line through -usepretex, and never a bibliography run', () => {
    const engine: Engine = { name: 'latexmk', path: '/Library/TeX/texbin/latexmk' }
    expect(partRunsFor(engine, 'main.tex', '/tmp/out', ahead)).toEqual([
      {
        argv: [
          '/Library/TeX/texbin/latexmk',
          '-norc',
          '-pdf',
          '-bibtex-',
          '-no-shell-escape',
          '-interaction=nonstopmode',
          '-halt-on-error',
          '-file-line-error',
          '-synctex=1',
          '-outdir=/tmp/out',
          '-usepretex=\\includeonly{chapters/a,chapters/b}',
          'main.tex',
        ],
      },
    ])
  })

  test('a bare engine: the line and an \\input in place of the file name, still called main', () => {
    const engine: Engine = { name: 'xelatex', path: '/usr/bin/xelatex' }
    const runs = partRunsFor(engine, 'main.tex', '/tmp/out', ahead)
    expect(runs).toHaveLength(2)
    expect(runs[0]!.argv).toEqual([
      '/usr/bin/xelatex',
      '-no-shell-escape',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-synctex=1',
      '-output-directory=/tmp/out',
      '-jobname=main',
      '\\includeonly{chapters/a,chapters/b}\\input{main.tex}',
    ])
  })

  test('Tectonic: the two-line file, untrusted, keeping its intermediates, cached first', () => {
    const engine: Engine = { name: 'tectonic', path: '/opt/homebrew/bin/tectonic' }
    expect(partRunsFor(engine, 'kehikot-only.tex', '/tmp/out', ahead)).toEqual([
      {
        argv: ['/opt/homebrew/bin/tectonic', '-X', 'compile', '--untrusted', '--synctex', '--keep-logs', '--keep-intermediates', '--outdir', '/tmp/out', '--only-cached', 'kehikot-only.tex'],
        cachedOnly: true,
      },
      { argv: ['/opt/homebrew/bin/tectonic', '-X', 'compile', '--untrusted', '--synctex', '--keep-logs', '--keep-intermediates', '--outdir', '/tmp/out', 'kehikot-only.tex'] },
    ])
  })

  test('no engine is ever given shell escape for a part either', () => {
    for (const name of ['tectonic', 'latexmk', 'pdflatex', 'xelatex', 'lualatex'] as const) {
      for (const run of partRunsFor({ name, path: `/bin/${name}` }, 'main.tex', '/o', ahead)) {
        expect(run.argv.join(' ')).not.toMatch(/(^| )-?-shell-escape|enable-write18/)
      }
    }
  })
})

describe('what a full build leaves for the next compile', () => {
  test('everything but what is written for people and for this module', () => {
    for (const kept of ['main.aux', 'chapters/3_methods.aux', 'main.bbl', 'main.toc', 'main.lof', 'main.out', 'main.bcf', 'main.run.xml', 'main.nav', 'main.gls']) {
      expect(isIntermediate(kept)).toBe(true)
    }
    for (const left of ['main.pdf', 'main.synctex.gz', 'main.synctex', 'main.log', 'main.blg', 'main.fls', 'main.fdb_latexmk', 'chapters/a.log', 'meta.json.tmp']) {
      expect(isIntermediate(left)).toBe(false)
    }
  })
})

describe('which kept selections go', () => {
  test('the last few used stay, oldest go first, and the one just made never goes', () => {
    const kept = [
      { key: 'a', used: 1 },
      { key: 'b', used: 5 },
      { key: 'c', used: 3 },
      { key: 'd', used: 4 },
      { key: 'e', used: 2 },
    ]
    expect(toEvict(kept, 4, 'b')).toEqual(['a'])
    expect(toEvict(kept, 4, 'a')).toEqual(['e'])
    expect(toEvict(kept, 2, 'a')).toEqual(['d', 'c', 'e'])
    expect(toEvict(kept.slice(0, 3), 4, 'a')).toEqual([])
    expect(KEPT_PARTS).toBe(4)
  })
})

describe('what a log says it could not resolve', () => {
  test('references and citations, once each, from LaTeX, natbib and biblatex', () => {
    const log = [
      "LaTeX Warning: Reference `sec:new' on page 3 undefined on input line 12.",
      "LaTeX Warning: Reference `sec:new' on page 4 undefined on input line 40.",
      "LaTeX Warning: Citation `knuth1984' on page 3 undefined on input line 14.",
      "Package natbib Warning: Citation `lamport' on page 2 undefined on input line 9.",
      "LaTeX Warning: Citation 'biber2020' on page 5 undefined on input line 3.",
      'LaTeX Warning: There were undefined references.',
    ].join('\n')
    expect(unresolved(log)).toEqual(['Reference sec:new', 'Citation knuth1984', 'Citation lamport', 'Citation biber2020'])
    expect(unresolved('Output written on main.pdf (3 pages).')).toEqual([])
  })
})

describe('a sheet of a part’s own PDF, and the page of the paper it is', () => {
  /* The paper: 8 sheets of front matter, an introduction on 9–11, methods on
     12–22 with its table file on 15–16, results on 23–30, then the back.
     The part: front matter on 1–8, methods on 9–19, the bibliography on 20. */
  const whole = {
    'main.tex': [{ page: 1, from: 1, to: 60 }, { page: 31, from: 90, to: 92 }],
    'chapters/intro.tex': [9, 10, 11].map((page, i) => ({ page, from: i * 40 + 1, to: i * 40 + 40 })),
    'chapters/methods.tex': [12, 13, 14, 17, 18, 19, 20, 21, 22].map((page, i) => ({ page, from: i * 40 + 1, to: i * 40 + 40 })),
    'tables/t1.tex': [15, 16].map((page, i) => ({ page, from: i * 30 + 1, to: i * 30 + 30 })),
    'chapters/results.tex': [23, 24].map((page, i) => ({ page, from: i * 40 + 1, to: i * 40 + 40 })),
  }
  const part = {
    'main.tex': [{ page: 1, from: 1, to: 60 }, { page: 20, from: 90, to: 92 }],
    'chapters/methods.tex': [9, 10, 11, 14, 15, 16, 17, 18, 19].map((page, i) => ({ page, from: i * 40 + 1, to: i * 40 + 40 })),
    'tables/t1.tex': [12, 13].map((page, i) => ({ page, from: i * 30 + 1, to: i * 30 + 30 })),
  }
  const files = ['chapters/methods.tex', 'tables/t1.tex']

  test('the sheets drawn are the ones the part’s files printed, its own tables included', () => {
    expect(sheetsOf(files, part)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(sheetsOf(['chapters/methods.tex'], part)).toEqual([9, 10, 11, 14, 15, 16, 17, 18, 19])
  })

  test('sheet to page: the file’s first page in the paper, plus how far in the sheet is', () => {
    expect(pageOfSheet(9, part, whole, files)).toBe(12)
    expect(pageOfSheet(12, part, whole, files)).toBe(15)
    expect(pageOfSheet(19, part, whole, files)).toBe(22)
  })

  test('a sheet no picked file printed — the title page, the bibliography — is no page anybody numbers', () => {
    expect(pageOfSheet(1, part, whole, files)).toBeNull()
    expect(pageOfSheet(20, part, whole, files)).toBeNull()
    expect(pageOfSheet(40, part, whole, files)).toBeNull()
  })

  test('page to sheet, and back again for every sheet of the part', () => {
    expect(sheetOfPage(12, part, whole, files)).toBe(9)
    expect(sheetOfPage(22, part, whole, files)).toBe(19)
    for (const sheet of sheetsOf(files, part)) expect(sheetOfPage(pageOfSheet(sheet, part, whole, files)!, part, whole, files)).toBe(sheet)
  })

  test('a page of the paper the part has no sheet for answers null, never a neighbouring sheet', () => {
    expect(sheetOfPage(9, part, whole, files)).toBeNull()
    expect(sheetOfPage(23, part, whole, files)).toBeNull()
    expect(sheetOfPage(1, part, whole, files)).toBeNull()
  })

  test('the part is the newer build while somebody types: a sheet the paper’s map has not got yet still has its page', () => {
    const longer = { ...part, 'chapters/methods.tex': [...part['chapters/methods.tex'], { page: 20, from: 361, to: 400 }] }
    expect(pageOfSheet(20, longer, whole, files)).toBe(23)
  })

  test('a file the whole paper has never been compiled with has no page to say', () => {
    expect(pageOfSheet(9, { 'chapters/new.tex': [{ page: 9, from: 1, to: 9 }] }, whole, ['chapters/new.tex'])).toBeNull()
  })

  test('every sheet at once, for the labels', () => {
    expect(pagesOfSheets(20, part, whole, files)).toEqual([null, null, null, null, null, null, null, null, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, null])
  })
})

describe('the picked parts, as the pane reads them', () => {
  const paper = {
    files: ['main.tex', 'chapters/a.tex', 'tables/t.tex', 'chapters/b.tex'],
    pulls: { 'chapters/a.tex': include('chapters/a'), 'tables/t.tex': input('tables/t', 'chapters/a.tex'), 'chapters/b.tex': input('chapters/b') },
  }
  const focus = (files: string[], parts = ['One']): Narrowed => ({ parts, files, pages: [], missing: [], ownsNone: files.length === 0 })

  test('nothing picked, and a pick that owns no file of the paper, are not this function’s to speak about', () => {
    expect(partOf(null, paper)).toBeNull()
    expect(partOf(focus([]), paper)).toBeNull()
  })

  test('the sentence says “part” or “parts” as the pick does', () => {
    expect(partOf(focus(['chapters/b.tex']), paper)?.cannot).toStartWith('No page is shown for the picked part: ')
    expect(partOf(focus(['chapters/b.tex'], ['One', 'Two']), paper)?.cannot).toStartWith('No page is shown for the picked parts: ')
  })

  test('a paper that does not say how its files are pulled in is narrowed by its pages, as it always was', () => {
    expect(partOf(focus(['chapters/a.tex']), { files: paper.files })).toBeNull()
  })

  test('the files a part’s PDF is of: the picked ones and what they pull in, in the paper’s order', () => {
    expect(coveredBy(['chapters/a.tex'], paper)).toEqual(['chapters/a.tex', 'tables/t.tex'])
    expect(coveredBy(['chapters/b.tex'], paper)).toEqual(['chapters/b.tex'])
    expect(coveredBy([], paper)).toEqual([])
  })
})
