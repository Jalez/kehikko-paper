import { describe, expect, test } from 'bun:test'

import { endOfPick } from '../src/pdf/words.ts'

describe('where a selection on the PDF ends in the source', () => {
  const text = ['\\section{Intro}', 'A claim with a tpyo in it.  ', 'Another line, with a claim.', ''].join('\n')

  test('just after its last word, on the line SyncTeX named', () => {
    expect(text.slice(0, endOfPick(text, { line: 2, word: 'tpyo' }))).toEndWith('A claim with a tpyo')
  })

  test('a word SyncTeX put a line off is found on the line beside it', () => {
    expect(text.slice(0, endOfPick(text, { line: 3, word: 'tpyo' }))).toEndWith('with a tpyo')
  })

  test('a word that is not there or not known: the end of the line’s text, without its trailing spaces', () => {
    const end = text.indexOf('in it.') + 'in it.'.length
    expect(endOfPick(text, { line: 2, word: null })).toBe(end)
    expect(endOfPick(text, { line: 2, word: 'nowhere' })).toBe(end)
  })
})
