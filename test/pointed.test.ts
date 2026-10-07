import { describe, expect, test } from 'bun:test'
import type { Passage } from 'kehikot-module-protocol'

import { fileOf, keyOf, pointedAt, received } from '../src/pointed.ts'
import type { Paper, PlacedBlock } from '../store.ts'

/**
 * A passage somebody else pointed at, as a place in this paper's source.
 *
 * The shapes below are the ones the other modules actually send: Notes a
 * note's path, page and range; Learning and Slides a range with no page;
 * Slides a section title with no range at all.
 */

const DIR = '/p/.kehikot/paper/e'
const seg = (text: string) => ({ text, srcStart: 0, srcEnd: 0, literal: true })
const heading = (file: string, srcStart: number, srcEnd: number, text: string) =>
  ({ kind: 'heading', id: `h${srcStart}`, file, srcStart, srcEnd, level: 1, numbered: true, segments: [seg(text)] }) as PlacedBlock

const paper = {
  epic: 'e',
  dir: DIR,
  title: 'A paper',
  files: ['main.tex', 'chapters/a.tex'],
  blocks: [heading('chapters/a.tex', 0, 20, 'Method'), heading('chapters/a.tex', 300, 330, 'Results'), heading('main.tex', 40, 60, 'Results')],
} as unknown as Paper

const passage = (over: Partial<Passage>): Passage => ({ path: `${DIR}/chapters/a.tex`, page: null, from: null, to: null, quoted: '', section: null, ...over })

describe('whose file', () => {
  test('a file of this paper by its relative name; anything else is not', () => {
    expect(fileOf(paper, `${DIR}/chapters/a.tex`)).toBe('chapters/a.tex')
    expect(fileOf(paper, `${DIR}/chapters/unnamed.tex`)).toBeNull()
    expect(fileOf(paper, '/p/.kehikot/paper/e-other/main.tex')).toBeNull()
    expect(fileOf(paper, '/elsewhere/main.tex')).toBeNull()
  })
})

describe('pointedAt', () => {
  test('nothing pointed at is nowhere', () => {
    expect(pointedAt(paper, null)).toEqual({ at: 'nowhere' })
  })

  test('a byte range of one of this paper’s files is that range, exactly', () => {
    expect(pointedAt(paper, passage({ from: 120, to: 180, quoted: 'the words', page: 4 }))).toMatchObject({ at: 'here', file: 'chapters/a.tex', from: 120, to: 180 })
  })

  test('a section with no range is its heading, found by title and told apart by file', () => {
    expect(pointedAt(paper, passage({ section: { title: 'Results', from: null, to: null } }))).toMatchObject({ at: 'here', file: 'chapters/a.tex', from: 300, to: 330 })
    expect(pointedAt(paper, passage({ path: `${DIR}/main.tex`, section: { title: 'Results', from: null, to: null } }))).toMatchObject({ file: 'main.tex', from: 40 })
  })

  test('a file with no range and no section — or a section that is not there — is nothing to walk to', () => {
    expect(pointedAt(paper, passage({}))).toEqual({ at: 'holding', file: 'chapters/a.tex' })
    expect(pointedAt(paper, passage({ section: { title: 'Gone', from: null, to: null } }))).toEqual({ at: 'holding', file: 'chapters/a.tex' })
  })

  test('another document, or no paper on screen, is said and not acted on', () => {
    expect(pointedAt(paper, passage({ path: '/elsewhere/notes.md', from: 1, to: 2 })).at).toBe('elsewhere')
    expect(pointedAt(null, passage({ from: 1, to: 2 })).at).toBe('elsewhere')
  })
})

describe('this page’s own passage coming back', () => {
  test('a ranged echo is recognised as own; the same range from a note with a page is not', () => {
    const mine = passage({ from: 120, to: 180, page: 3 })
    expect(received(paper, mine, keyOf(mine)).own).toBe(true)
    expect(received(paper, passage({ from: 120, to: 180, page: null }), keyOf(mine)).own).toBe(false)
  })

  test('the caret’s own section coming back is held, not scrolled to', () => {
    const mine = passage({ page: 2, section: { title: 'Method', from: 0, to: 300 } })
    expect(received(paper, mine, keyOf(mine))).toEqual({ own: true, answer: { at: 'holding', file: 'chapters/a.tex' } })
    /* The same section from Slides — no page — is somebody else's, and is walked to. */
    expect(received(paper, passage({ section: { title: 'Method', from: null, to: null } }), keyOf(mine)).answer.at).toBe('here')
  })

  test('the key leaves the quote out and keeps the page, as Notes and Learning key theirs', () => {
    expect(keyOf(passage({ from: 1, to: 2, quoted: 'a' }))).toBe(keyOf(passage({ from: 1, to: 2, quoted: 'b' })))
    expect(keyOf(passage({ from: 1, to: 2, page: 1 }))).not.toBe(keyOf(passage({ from: 1, to: 2, page: 2 })))
  })
})
