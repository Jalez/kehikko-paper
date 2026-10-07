import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseLatex } from '../latex/parse.ts'
import { hashesOf, readPaper, startPaper } from '../store.ts'
import { TEMPLATES, templateById, templateList, titleFor } from '../templates.ts'

/**
 * Starting a paper from a template or from somebody's folder, and a paper
 * whose files include files.
 */

let root = ''
let project = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'paper-start-')))
  project = join(root, 'project')
  mkdirSync(project, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const paperDir = (epic: string) => join(project, '.kehikot', 'paper', epic)

describe('the built-in templates', () => {
  test('each has a main.tex with a class and a document, and every file it inputs', () => {
    for (const template of TEMPLATES) {
      const files = template.files('A title')
      const main = files.find((file) => file.path === 'main.tex')
      expect(main, template.id).toBeDefined()
      expect(main!.text).toMatch(/^\\documentclass/)
      expect(main!.text).toContain('\\begin{document}')
      expect(main!.text).toContain('\\end{document}')
      expect(main!.text).toContain('\\title{A title}')
      for (const block of parseLatex(main!.text, 'main.tex').blocks) {
        if (block.kind === 'include') expect(files.map((file) => file.path), template.id).toContain(`${block.target}.tex`)
      }
      for (const named of main!.text.matchAll(/\\bibliography\{([^}]+)\}/g)) {
        expect(files.map((file) => file.path)).toContain(`${named[1]}.bib`)
      }
      for (const file of files) expect(file.path.startsWith('/') || file.path.includes('..')).toBe(false)
    }
  })

  test('the picker gets names and sentences, not file contents', () => {
    expect(templateList().map((one) => one.id)).toEqual(['article', 'parts', 'ieee', 'report'])
    expect(templateById('nope')).toBeNull()
  })

  test('a title cannot close its own group', () => {
    expect(titleFor('modes-are-modules')).toBe('Modes are modules')
    expect(titleFor('a}b\\c%d')).toBe('Abcd')
    expect(titleFor('---')).toBe('Untitled')
  })
})

describe('starting from a template', () => {
  test('the files land in the paper’s folder and read back as a paper with its parts', () => {
    const started = startPaper('my-paper', project, { template: 'parts' })
    expect(started.ok).toBe(true)
    const paper = readPaper('my-paper', project)!
    expect(paper.files).toEqual(['main.tex', 'sections/introduction.tex', 'sections/method.tex', 'sections/results.tex', 'sections/discussion.tex'])
    expect(paper.outline.map((one) => one.text)).toEqual(['Introduction', 'Method', 'Results', 'Discussion'])
    expect(existsSync(join(paperDir('my-paper'), 'references.bib'))).toBe(true)
  })

  test('an unknown template makes nothing — not even the folder', () => {
    expect(startPaper('my-paper', project, { template: 'nope' }).ok).toBe(false)
    expect(existsSync(paperDir('my-paper'))).toBe(false)
  })

  test('it never replaces a paper that is there', () => {
    expect(startPaper('my-paper', project).ok).toBe(true)
    const before = readFileSync(join(paperDir('my-paper'), 'main.tex'), 'utf8')
    expect(startPaper('my-paper', project, { template: 'ieee' }).ok).toBe(false)
    expect(readFileSync(join(paperDir('my-paper'), 'main.tex'), 'utf8')).toBe(before)
  })
})

describe('starting from a folder', () => {
  const template = () => {
    const dir = join(root, 'venue-template')
    mkdirSync(join(dir, 'figures'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'main.tex'), '\\documentclass{venue}\n\\begin{document}\n\\section{One}\n\\end{document}\n')
    writeFileSync(join(dir, 'venue.cls'), '\\LoadClass{article}\n')
    writeFileSync(join(dir, 'figures', 'logo.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(dir, 'main.aux'), 'stale')
    writeFileSync(join(dir, 'main.synctex.gz'), 'stale')
    writeFileSync(join(dir, '.git', 'config'), 'secret')
    writeFileSync(join(root, 'outside.txt'), 'not part of the template')
    symlinkSync(join(root, 'outside.txt'), join(dir, 'link.txt'))
    return dir
  }

  test('the class, the figures and the source are copied; build litter, dot-folders and symlinks are not', () => {
    const dir = template()
    const started = startPaper('my-paper', project, { folder: dir })
    expect(started.ok).toBe(true)
    expect(readdirSync(paperDir('my-paper')).sort()).toEqual(['figures', 'main.tex', 'venue.cls'])
    expect(readFileSync(join(paperDir('my-paper'), 'figures', 'logo.png'))).toEqual(Buffer.from([1, 2, 3]))
    /* The folder pointed at is read and never written. */
    expect(readdirSync(dir).sort()).toEqual(['.git', 'figures', 'link.txt', 'main.aux', 'main.synctex.gz', 'main.tex', 'venue.cls'])
  })

  test('with no main.tex, the ONE .tex that has a \\documentclass becomes it', () => {
    const dir = join(root, 'single')
    mkdirSync(dir)
    writeFileSync(join(dir, 'paper.tex'), '% a comment\n\\documentclass{article}\n\\begin{document}x\\end{document}\n')
    writeFileSync(join(dir, 'macros.tex'), '\\newcommand{\\x}{y}\n')
    expect(startPaper('my-paper', project, { folder: dir }).ok).toBe(true)
    expect(readdirSync(paperDir('my-paper')).sort()).toEqual(['macros.tex', 'main.tex'])
  })

  test('two candidates is a refusal that names them, and nothing is made', () => {
    const dir = join(root, 'two')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.tex'), '\\documentclass{article}\n')
    writeFileSync(join(dir, 'b.tex'), '\\documentclass{article}\n')
    const started = startPaper('my-paper', project, { folder: dir })
    expect(started.ok === false && started.why).toContain('a.tex, b.tex')
    expect(existsSync(paperDir('my-paper'))).toBe(false)
  })

  test('a folder with no paper in it, one that is not there, and a relative path are sentences', () => {
    const empty = join(root, 'empty')
    mkdirSync(empty)
    writeFileSync(join(empty, 'notes.txt'), 'x')
    expect(startPaper('my-paper', project, { folder: empty }).ok).toBe(false)
    expect(startPaper('my-paper', project, { folder: join(root, 'missing') }).ok).toBe(false)
    expect(startPaper('my-paper', project, { folder: 'relative/path' }).ok).toBe(false)
    expect(existsSync(paperDir('my-paper'))).toBe(false)
  })
})

describe('files that include files', () => {
  const write = (epic: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      const at = join(paperDir(epic), path)
      mkdirSync(join(at, '..'), { recursive: true })
      writeFileSync(at, text)
    }
  }

  test('an \\input inside an \\input is part of the paper, in reading order, resolved against the root', () => {
    write('deep', {
      'main.tex': '\\documentclass{article}\\begin{document}\n\\section{Top}\n\\input{chapters/a}\n\\section{End}\n\\end{document}\n',
      'chapters/a.tex': '\\section{A}\n\\input{chapters/tables/t}\nAfter the table.\n',
      'chapters/tables/t.tex': '\\subsection{T}\nIn the table file.\n',
    })
    const paper = readPaper('deep', project)!
    expect(paper.files).toEqual(['main.tex', 'chapters/a.tex', 'chapters/tables/t.tex'])
    expect(paper.outline.map((one) => one.text)).toEqual(['Top', 'A', 'T', 'End'])
    expect(Object.keys(hashesOf('deep', project)!).sort()).toEqual(Object.keys(paper.hashes).sort())
    expect(Object.keys(paper.hashes).sort()).toEqual(['chapters/a.tex', 'chapters/tables/t.tex', 'main.tex'])
  })

  test('a file that includes itself, and two that include each other, are read once', () => {
    write('loop', {
      'main.tex': '\\documentclass{article}\\begin{document}\n\\input{a}\n\\end{document}\n',
      'a.tex': '\\section{A}\n\\input{b}\n\\input{a}\n',
      'b.tex': '\\section{B}\n\\input{a}\n\\input{main}\n',
    })
    const paper = readPaper('loop', project)!
    expect(paper.files).toEqual(['main.tex', 'a.tex', 'b.tex'])
    expect(paper.outline.map((one) => one.text)).toEqual(['A', 'B'])
    expect(Object.keys(hashesOf('loop', project)!).sort()).toEqual(['a.tex', 'b.tex', 'main.tex'])
  })
})
