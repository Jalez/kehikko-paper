import { afterAll, describe, expect, test } from 'bun:test'
import { holdingsSpoken, readHoldings } from 'kehikot-module-protocol/serve'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chaptersIn, holdingsOf, readChapters, republish, setChapters } from '../chapters.ts'
import { TICKET, answer } from '../doors.ts'
import { chaptersOf, chaptersSaid, moveOf, movedWords, nameFor, partOfChapter, withChapter } from '../src/chapters.ts'
import { inProject } from '../src/focus.ts'
import { readPaper } from '../store.ts'

/**
 * Which chapter is which part's: this module's record, what it publishes from
 * it, and how the page comes by the mapping before there is a record at all.
 *
 * Held here: reading never writes; the first write takes over EVERY part's
 * chapter as the page then read them, so nothing a part had is lost; what is
 * published is the chapter and the files it pulls in, project-relative, where
 * every module's holdings are read from; and it is made again when the paper
 * changes.
 */

const project = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-chapters-')))
afterAll(() => rmSync(project, { recursive: true, force: true }))

const papers = join(project, '.kehikot', 'paper')
const dir = join(papers, 'thesis')
mkdirSync(join(dir, 'chapters'), { recursive: true })
mkdirSync(join(dir, 'tables'), { recursive: true })
writeFileSync(
  join(dir, 'main.tex'),
  ['\\documentclass{report}', '\\begin{document}', 'Front.', '\\include{chapters/intro}', '\\include{chapters/methods}', '\\include{chapters/results}', '\\end{document}', ''].join('\n'),
)
writeFileSync(join(dir, 'chapters', 'intro.tex'), '\\chapter{Introduction}\nWhy.\n')
writeFileSync(join(dir, 'chapters', 'methods.tex'), '\\chapter{How it was done}\nThus.\n\\input{tables/design}\n')
writeFileSync(join(dir, 'tables', 'design.tex'), 'A table.\n')
writeFileSync(join(dir, 'chapters', 'results.tex'), '\\chapter{Results}\nSo.\n')
/* A second paper in the same project, so "every other epic stays" has something to stay. */
mkdirSync(join(papers, 'other'), { recursive: true })
writeFileSync(join(papers, 'other', 'main.tex'), '\\documentclass{article}\\begin{document}\\input{one}\\end{document}\n')
writeFileSync(join(papers, 'other', 'one.tex'), 'One.\n')

const record = join(papers, 'chapters.json')
const published = join(papers, 'parts.json')
/** Every file under the project's `.kehikot`, with its size and when it was written: what a read must leave exactly as it was. */
const snapshot = () => {
  const out: string[] = []
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      const found = statSync(path)
      if (found.isDirectory()) walk(path)
      else out.push(`${path} ${found.size} ${found.mtimeMs}`)
    }
  }
  walk(join(project, '.kehikot'))
  return out
}
const paper = () => readPaper('thesis', project)!
const part = (id: string, picked = false, files?: string[], documents = true) => ({
  id,
  heading: id,
  refs: [],
  picked,
  ...(files ? { files, ...(documents ? { documents: files.map((file) => inProject('thesis', file)) } : {}) } : {}),
})

describe('what a chapter is, and what the parts the host sends already say', () => {
  test('the files main.tex pulls in itself are the chapters; a table a chapter reads is not one', () => {
    expect(chaptersOf(paper())).toEqual(['chapters/intro.tex', 'chapters/methods.tex', 'chapters/results.tex'])
  })

  test('read off the parts: from documents, and from an older host’s files, the same', () => {
    for (const documents of [true, false]) {
      const parts = [part('introduction', false, ['chapters/intro.tex'], documents), part('methods', true, ['chapters/methods.tex'], documents), part('notes', false, undefined, documents)]
      expect(chaptersSaid(parts, paper(), project)).toEqual({ introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' })
    }
  })

  test('one chapter to a part — the file nothing else of the part pulls in — and a chapter under the first part that has it', () => {
    const parts = [
      part('methods', false, ['tables/design.tex', 'chapters/methods.tex', 'chapters/results.tex']),
      part('again', false, ['chapters/methods.tex']),
      part('elsewhere', false, ['not/in/the/paper.tex']),
    ]
    expect(chaptersSaid(parts, paper(), project)).toEqual({ methods: 'chapters/methods.tex' })
  })

  test('one change to a mapping: a part with no chapter takes the file, “no part” gives it up, and nothing else moves', () => {
    const was = { introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' }
    expect(withChapter(was, 'results', 'chapters/results.tex')).toEqual({ ...was, results: 'chapters/results.tex' })
    expect(withChapter(was, null, 'chapters/methods.tex')).toEqual({ introduction: 'chapters/intro.tex' })
    /* A chapter moved to a part that had none leaves its old part with none: that is what was asked. */
    expect(withChapter(was, 'results', 'chapters/methods.tex')).toEqual({ introduction: 'chapters/intro.tex', results: 'chapters/methods.tex' })
    expect(withChapter(was, 'methods', 'chapters/methods.tex')).toEqual(was)
    expect(was).toEqual({ introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' })
    expect(partOfChapter(was, 'chapters/methods.tex')).toBe('methods')
    expect(partOfChapter(was, 'chapters/results.tex')).toBeNull()
    for (const [part, file] of [['results', 'chapters/results.tex'], ['methods', 'chapters/methods.tex'], ['results', 'chapters/methods.tex']] as const) expect(moveOf(was, part, file)).toBeNull()
  })

  test('a chapter given to a part that has one SWAPS with it — and giving it back restores the mapping exactly', () => {
    const seven = {
      introduction: 'chapters/1_introduction.tex',
      'literature-review': 'chapters/2_literature.tex',
      methods: 'chapters/3_methods.tex',
      results: 'chapters/4_results.tex',
      discussion: 'chapters/5_discussion.tex',
      conclusion: 'chapters/6_conclusion.tex',
      appendices: 'chapters/appendices.tex',
    }
    const as = JSON.stringify(seven)
    expect(moveOf(seven, 'results', 'chapters/3_methods.tex')).toEqual({ file: 'chapters/4_results.tex', to: 'methods' })
    const moved = withChapter(seven, 'results', 'chapters/3_methods.tex')
    expect(moved).toEqual({ ...seven, methods: 'chapters/4_results.tex', results: 'chapters/3_methods.tex' })
    /* Seven parts, seven chapters: nobody was left with none. */
    expect(Object.keys(moved)).toEqual(Object.keys(seven))
    expect(Object.values(moved).sort()).toEqual(Object.values(seven).sort())
    /* Back: the same entries in the same order, so the same file on disk. */
    expect(moveOf(moved, 'methods', 'chapters/3_methods.tex')).toEqual({ file: 'chapters/4_results.tex', to: 'results' })
    expect(JSON.stringify(withChapter(moved, 'methods', 'chapters/3_methods.tex'))).toBe(as)
    expect(JSON.stringify(seven)).toBe(as)
  })

  test('the first press adopts what the parts said: all seven parts keep a chapter through a move and back', () => {
    const names = ['1_introduction', '2_literature', '3_methods', '4_results', '5_discussion', '6_conclusion', 'appendices']
    const ids = ['introduction', 'literature-review', 'methods', 'results', 'discussion', 'conclusion', 'appendices']
    const files = names.map((name) => `chapters/${name}.tex`)
    const seven = {
      epic: 'thesis',
      files: ['main.tex', ...files, 'generated/a.tex', 'generated/b.tex'],
      pulls: {
        ...Object.fromEntries(files.map((file) => [file, { by: 'main.tex', with: 'include', as: file.replace(/\.tex$/, '') }])),
        'generated/a.tex': { by: 'chapters/appendices.tex', with: 'input', as: 'generated/a' },
        'generated/b.tex': { by: 'chapters/appendices.tex', with: 'input', as: 'generated/b' },
      },
    }
    /* As a host sends them: each part with its chapter, and the appendices with what the chapter pulls in. */
    const parts = ids.map((id, i) => part(id, false, i === 6 ? [files[6]!, 'generated/a.tex', 'generated/b.tex'] : [files[i]!]))
    const said = chaptersSaid(parts, seven, project)
    expect(said).toEqual(Object.fromEntries(ids.map((id, i) => [id, files[i]!])))
    /* The first deliberate press: the whole of that, with the one change. */
    const first = withChapter(said, 'results', 'chapters/3_methods.tex')
    expect(Object.keys(first)).toEqual(ids)
    expect(new Set(Object.values(first)).size).toBe(7)
    expect(first.methods).toBe('chapters/4_results.tex')
    expect(JSON.stringify(withChapter(first, 'methods', 'chapters/3_methods.tex'))).toBe(JSON.stringify(said))
  })

  test('a file that is no part’s chapter, given to a part that has one: that one is left with no part, and it is known beforehand', () => {
    const was = { introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' }
    expect(moveOf(was, 'methods', 'chapters/results.tex')).toEqual({ file: 'chapters/methods.tex', to: null })
    expect(withChapter(was, 'methods', 'chapters/results.tex')).toEqual({ introduction: 'chapters/intro.tex', methods: 'chapters/results.tex' })
  })

  test('what the page says after a press that moved another chapter — and nothing after one that did not', () => {
    const heading = (id: string) => ({ methods: 'Methods', results: 'Results' })[id] ?? id
    expect(movedWords('chapters/3_methods.tex', 'results', { file: 'chapters/4_results.tex', to: 'methods' }, heading)).toBe(
      '3_methods.tex is now the chapter of Results, and 4_results.tex of Methods.',
    )
    expect(movedWords('chapters/notes.tex', 'results', { file: 'chapters/4_results.tex', to: null }, heading)).toBe(
      'notes.tex is now the chapter of Results; 4_results.tex is the chapter of no part.',
    )
    expect(movedWords('chapters/3_methods.tex', 'results', null, heading)).toBeNull()
  })

  test('a part made for a chapter is called by the chapter’s first heading, or by its file', () => {
    const sections = [{ file: 'chapters/methods.tex', title: 'How it  was done' }, { file: 'chapters/methods.tex', title: 'Design' }]
    expect(nameFor('chapters/methods.tex', sections)).toBe('How it was done')
    expect(nameFor('chapters/3_methods.tex', [])).toBe('3_methods')
  })
})

describe('reading never writes', () => {
  test('an epic the record says nothing about is null, and nothing is made by asking — through the function or the door', () => {
    const before = snapshot()
    expect(readChapters(project, 'thesis')).toBeNull()
    expect(readChapters(project, 'no-such-epic')).toBeNull()
    expect(readChapters(null, 'thesis')).toBeNull()
    expect(republish(project, 'thesis')).toBe(false)
    const asked = answer('GET', '/api/chapters', new URLSearchParams({ epic: 'thesis', project }), null)
    expect(asked?.body).toEqual({ ok: true, chapters: null })
    expect(snapshot()).toEqual(before)
    expect(existsSync(record)).toBe(false)
    expect(existsSync(published)).toBe(false)
  })

  test('and a save of a file of the paper publishes nothing for an epic with no record', () => {
    const text = readFileSync(join(dir, 'chapters', 'results.tex'), 'utf8')
    const saved = answer('POST', '/api/file', new URLSearchParams({ epic: 'thesis', project }), { file: 'chapters/results.tex', text, was: paper().hashes['chapters/results.tex'] }, TICKET)
    expect((saved?.body as { ok: boolean; published: boolean }).published).toBe(false)
    expect(existsSync(record)).toBe(false)
    expect(existsSync(published)).toBe(false)
  })
})

describe('what may be kept', () => {
  test('a part’s id and a file of this paper, a file once: anything else costs that entry', () => {
    expect(
      chaptersIn({ methods: 'chapters/methods.tex', 'Not An Id': 'chapters/intro.tex', gone: 'chapters/gone.tex', twice: 'chapters/methods.tex', n: 3, up: '../other/one.tex' }, paper()),
    ).toEqual({ methods: 'chapters/methods.tex' })
    expect(chaptersIn(null, paper())).toEqual({})
    expect(chaptersIn(['chapters/methods.tex'], paper())).toEqual({})
  })
})

describe('the first deliberate write', () => {
  test('is ticketed', () => {
    const refused = answer('POST', '/api/chapters', new URLSearchParams({ epic: 'thesis', project }), { chapters: { methods: 'chapters/methods.tex' } })
    expect(refused?.status).toBe(403)
    expect(existsSync(record)).toBe(false)
  })

  test('keeps the whole mapping it is given, and publishes each chapter with the files it pulls in', () => {
    const set = answer('POST', '/api/chapters', new URLSearchParams({ epic: 'thesis', project }), { chapters: { introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' } }, TICKET)
    expect(set?.body).toEqual({ ok: true, chapters: { introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' }, published: true })

    /* The record: part id → file, as the paper names it, and nothing derived. */
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ version: 1, epics: { thesis: { introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' } } })
    expect(readChapters(project, 'thesis')).toEqual({ introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' })

    /* The publication: the protocol's file, read back the way a host reads it. */
    expect(readHoldings(project)).toEqual({
      thesis: {
        introduction: { documents: ['.kehikot/paper/thesis/chapters/intro.tex'], refs: [] },
        methods: { documents: ['.kehikot/paper/thesis/chapters/methods.tex', '.kehikot/paper/thesis/tables/design.tex'], refs: [] },
      },
    })
    expect(holdingsOf(paper(), { methods: 'chapters/methods.tex' })).toEqual({
      methods: { documents: ['.kehikot/paper/thesis/chapters/methods.tex', '.kehikot/paper/thesis/tables/design.tex'], refs: [] },
    })
    /* Nothing of either was written into the paper. */
    expect(readdirSync(dir).sort()).toEqual(['chapters', 'main.tex', 'tables'])
  })

  test('saying the same again writes nothing', () => {
    const before = statSync(published).mtimeMs
    const again = setChapters(project, 'thesis', { introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' })
    expect(again).toEqual({ ok: true, chapters: { introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' }, published: false })
    expect(statSync(published).mtimeMs).toBe(before)
  })

  test('another epic’s chapters are another entry: the first stays, in the record and in what is published', () => {
    expect(setChapters(project, 'other', { only: 'one.tex' })).toEqual({ ok: true, chapters: { only: 'one.tex' }, published: true })
    expect(readChapters(project, 'thesis')).toEqual({ introduction: 'chapters/intro.tex', methods: 'chapters/methods.tex' })
    expect(Object.keys(readHoldings(project)).sort()).toEqual(['other', 'thesis'])
  })

  test('a chapter that now pulls in another file has another document: a save publishes again, and says so', () => {
    writeFileSync(join(dir, 'tables', 'more.tex'), 'More.\n')
    const was = paper().hashes['chapters/intro.tex']
    const saved = answer('POST', '/api/file', new URLSearchParams({ epic: 'thesis', project }), { file: 'chapters/intro.tex', text: '\\chapter{Introduction}\nWhy.\n\\input{tables/more}\n', was }, TICKET)
    expect((saved?.body as { published: boolean }).published).toBe(true)
    expect(readHoldings(project).thesis!.introduction!.documents).toEqual(['.kehikot/paper/thesis/chapters/intro.tex', '.kehikot/paper/thesis/tables/more.tex'])
    /* And a save that changes no chapter's files says nothing. */
    const next = answer('POST', '/api/file', new URLSearchParams({ epic: 'thesis', project }), { file: 'chapters/results.tex', text: '\\chapter{Results}\nSo it is.\n', was: paper().hashes['chapters/results.tex'] }, TICKET)
    expect((next?.body as { published: boolean }).published).toBe(false)
  })

  test('taking a chapter from a part takes it out of what is published; an empty mapping is still a record', () => {
    expect(setChapters(project, 'thesis', { methods: 'chapters/methods.tex' })).toMatchObject({ ok: true, published: true })
    expect(Object.keys(readHoldings(project).thesis!)).toEqual(['methods'])
    expect(setChapters(project, 'thesis', {})).toMatchObject({ ok: true, chapters: {}, published: true })
    expect(readHoldings(project).thesis).toBeUndefined()
    /* `{}` and not null: this module keeps the epic's chapters, and it keeps none. */
    expect(readChapters(project, 'thesis')).toEqual({})
  })

  test('a last chapter set to no part still counts as spoken: documents are published, refs never claimed', () => {
    expect(setChapters(project, 'thesis', { methods: 'chapters/methods.tex' })).toMatchObject({ ok: true })
    expect(holdingsSpoken(project, 'thesis')).toEqual({ documents: true, refs: false })
    expect(setChapters(project, 'thesis', {})).toMatchObject({ ok: true, published: true })
    expect(readHoldings(project).thesis).toBeUndefined()
    expect(holdingsSpoken(project, 'thesis')).toEqual({ documents: true, refs: false })
  })

  test('a record that cannot be read is set aside, never written over or read through', () => {
    writeFileSync(record, 'not json at all')
    expect(readChapters(project, 'thesis')).toBeNull()
    expect(setChapters(project, 'thesis', { results: 'chapters/results.tex' })).toMatchObject({ ok: true })
    expect(readFileSync(`${record}.unreadable`, 'utf8')).toBe('not json at all')
    expect(readChapters(project, 'thesis')).toEqual({ results: 'chapters/results.tex' })
  })

  test('no paper, no project, not an epic: refused in a sentence, and nothing made', () => {
    expect(setChapters(project, 'no-such-epic', {})).toEqual({ ok: false, why: 'There is no paper for that epic in this project.' })
    expect(setChapters(null, 'thesis', {})).toMatchObject({ ok: false })
    expect(setChapters(project, '../thesis', {})).toMatchObject({ ok: false })
  })
})
