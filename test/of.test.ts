import { describe, expect, test } from 'bun:test'

import { pdfIsOf } from '../src/pdf/of.ts'

/*
 * "Is this PDF of this text" — the one question asked before a mark is put on
 * a PDF for a place in a file. See `src/pdf/of.ts`.
 */

const held = (over: Partial<{ text: string; saved: string; hash: string }> = {}) => ({ text: 'a\nb\n', saved: 'a\nb\n', hash: 'h1', ...over })
const pdf = (hashes: Record<string, string>) => ({ hashes })

describe('a PDF is of a file when what was compiled, what was last read or saved, and what is in the editor are the same text', () => {
  test('all three agree', () => {
    expect(pdfIsOf(pdf({ 'main.tex': 'h1' }), 'main.tex', held())).toBe(true)
  })

  test('(a) built before the file changed on disk: saved, or rewritten by an agent and read again, and not compiled yet', () => {
    expect(pdfIsOf(pdf({ 'main.tex': 'h0' }), 'main.tex', held())).toBe(false)
  })

  test('(b) words typed and not saved: the build and the disk agree with each other and not with the editor', () => {
    expect(pdfIsOf(pdf({ 'main.tex': 'h1' }), 'main.tex', held({ text: 'x\na\nb\n' }))).toBe(false)
  })

  test('(c) a compile running because ANOTHER file changed says nothing about this one', () => {
    expect(pdfIsOf(pdf({ 'main.tex': 'h1', 'chapters/2.tex': 'old' }), 'main.tex', held())).toBe(true)
    expect(pdfIsOf(pdf({ 'main.tex': 'h1', 'chapters/2.tex': 'old' }), 'chapters/2.tex', held({ hash: 'new' }))).toBe(false)
  })

  test('(d) a failed compile leaves the last good PDF, which stays not of the text until one succeeds', () => {
    const lastGood = pdf({ 'main.tex': 'h0' })
    expect(pdfIsOf(lastGood, 'main.tex', held())).toBe(false)
    expect(pdfIsOf(pdf({ 'main.tex': 'h1' }), 'main.tex', held())).toBe(true)
  })

  test('a PDF that was not compiled from the file at all — a part’s own, of other files — is not of it', () => {
    expect(pdfIsOf(pdf({ 'chapters/3.tex': 'h3' }), 'main.tex', held())).toBe(false)
  })

  test('no PDF, or a file not read yet, is no', () => {
    expect(pdfIsOf(null, 'main.tex', held())).toBe(false)
    expect(pdfIsOf(undefined, 'main.tex', held())).toBe(false)
    expect(pdfIsOf(pdf({ 'main.tex': 'h1' }), 'main.tex', undefined)).toBe(false)
  })
})
