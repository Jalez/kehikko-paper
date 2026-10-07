import { describe, expect, test } from 'bun:test'
import { LIMITS, passageSchema } from 'kehikot-module-protocol'

import type { Paper, PlacedBlock } from '../store.ts'
import { sectionAt, sectionsOf } from '../src/lib/sections.ts'
import { passageFor, shouldPublish } from '../src/use-published-passage.ts'

/**
 * Which heading the reader is under, as `passage.section` says it.
 *
 * The caret is in a file at a byte; the section is the last heading of that
 * file at or before it, with the span that heading owns.
 */

const seg = (text: string) => ({ text, srcStart: 0, srcEnd: 0, literal: true })

function heading(id: string, file: string, srcStart: number, srcEnd: number, text: string): PlacedBlock {
  return { kind: 'heading', id, file, srcStart, srcEnd, level: 1, numbered: true, segments: [seg(text)] } as PlacedBlock
}
function para(id: string, file: string, srcStart: number, srcEnd: number): PlacedBlock {
  return { kind: 'paragraph', id, file, srcStart, srcEnd, segments: [seg('words')] } as PlacedBlock
}

const A = 'chapters/a.tex'
const B = 'chapters/b.tex'
const h1 = heading('h1', A, 0, 20, '  Bridging\n the   gap ')
const p1 = para('p1', A, 20, 200)
const h2 = heading('h2', A, 200, 230, 'Second')
const p2 = para('p2', A, 230, 500)
const p3 = para('p3', A, 500, 800)
const hb = heading('hb', B, 0, 15, 'Other file')
const pb = para('pb', B, 15, 90)

const paper = { blocks: [h1, p1, h2, p2, p3, hb, pb] } as unknown as Paper

describe('sectionsOf and sectionAt', () => {
  const sections = sectionsOf(paper)

  test('a paper with no headings has no sections, and a caret in it is under none', () => {
    const plain = { blocks: [p1, p2] } as unknown as Paper
    expect(sectionsOf(plain)).toEqual([])
    expect(sectionAt(sectionsOf(plain), A, 100)).toBeNull()
  })

  test('the title is spelled as the outline and list_sections spell it', () => {
    expect(sections[0]).toMatchObject({ file: A, title: 'Bridging the gap', at: 0, end: 20, from: 0, to: 200 })
  })

  test('a caret is under the last heading at or before it, in its own file', () => {
    expect(sectionAt(sections, A, 0)?.title).toBe('Bridging the gap')
    expect(sectionAt(sections, A, 199)?.title).toBe('Bridging the gap')
    expect(sectionAt(sections, A, 200)?.title).toBe('Second')
    expect(sectionAt(sections, A, 799)?.title).toBe('Second')
  })

  test('the span runs to the next heading, and the last one to the end of its file', () => {
    expect(sectionAt(sections, A, 10)).toMatchObject({ from: 0, to: 200 })
    expect(sectionAt(sections, A, 600)).toMatchObject({ title: 'Second', from: 200, to: 800 })
  })

  test('a heading in another file is not this file’s section', () => {
    expect(sectionAt(sections, B, 50)?.title).toBe('Other file')
    const noHeadingInB = sectionsOf({ blocks: [h1, p1, pb] } as unknown as Paper)
    expect(sectionAt(noHeadingInB, B, 50)).toBeNull()
  })
})

describe('the section on the published passage', () => {
  const dirPaper = { epic: 'e', dir: '/p/.kehikot/paper/e' } as Paper
  const section = { title: 'Second', from: 200, to: 800 }

  test('rides along with no range, and with a highlight too', () => {
    const plain = passageFor(dirPaper, { page: 2, file: A, section }, null)
    expect(plain).toMatchObject({ from: null, to: null, section })
    expect(() => passageSchema.parse(plain)).not.toThrow()
    const lit = passageFor(dirPaper, { page: 2, file: A, section }, {
      srcStart: 240, srcEnd: 260, text: 'words', file: A,
    })
    expect(lit).toMatchObject({ from: 240, to: 260, section })
    expect(() => passageSchema.parse(lit)).not.toThrow()
  })

  test('no section known is null, and a title over the quote limit is dropped rather than clipped', () => {
    expect(passageFor(dirPaper, { page: 2, file: A }, null)?.section).toBeNull()
    const long = { title: 'x'.repeat(LIMITS.QUOTE + 1), from: 0, to: 10 }
    expect(passageFor(dirPaper, { page: 2, file: A, section: long }, null)?.section).toBeNull()
  })

  test('two passages differing only by section are two passages', () => {
    const one = passageFor(dirPaper, { page: 2, file: A, section }, null)
    const other = passageFor(dirPaper, { page: 2, file: A, section: { ...section, title: 'Third' } }, null)
    const moved = passageFor(dirPaper, { page: 2, file: A, section: { ...section, to: 900 } }, null)
    expect(shouldPublish(other, one, true, null, false)).toBe(true)
    expect(shouldPublish(moved, one, true, null, false)).toBe(true)
    expect(shouldPublish(one, passageFor(dirPaper, { page: 2, file: A, section: { ...section } }, null), true, null, false)).toBe(false)
  })
})
