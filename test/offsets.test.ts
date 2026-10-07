import { describe, expect, test } from 'bun:test'

import { byteAt, eolOf, indexAt, lineAt, startOfLine, textOfLine, toDisk, toEditor } from '../src/lib/offsets.ts'
import { placeWord, printedWords, tighten, wordAt, type Run } from '../src/pdf/words.ts'

/**
 * Bytes, characters and lines.
 *
 * Every anchor another module holds on a paper is a byte offset into a file.
 * The editor counts UTF-16 units. These are the conversions between them, and
 * the cases are the ones that have gone wrong on this codebase before: an `ä`,
 * an emoji, a file from Windows.
 */
describe('bytes and positions', () => {
  const text = 'Tiivistelmä – ja 😀 loppu'

  test('agrees with the encoder at every position that is a place', () => {
    for (let i = 0; i <= text.length; i += 1) {
      const code = text.charCodeAt(i)
      if (code >= 0xdc00 && code <= 0xdfff) continue
      expect(byteAt(text, i)).toBe(Buffer.byteLength(text.slice(0, i)))
      expect(indexAt(text, byteAt(text, i))).toBe(i)
    }
  })

  test('a position inside a surrogate pair counts as the place before it', () => {
    const at = text.indexOf('😀')
    expect(byteAt(text, at + 1)).toBe(byteAt(text, at))
  })

  test('a byte inside a character answers the start of that character', () => {
    const at = text.indexOf('ä')
    expect(indexAt(text, byteAt(text, at) + 1)).toBe(at)
  })

  test('clamped at both ends', () => {
    expect(byteAt(text, -5)).toBe(0)
    expect(byteAt(text, 9999)).toBe(Buffer.byteLength(text))
    expect(indexAt(text, 9999)).toBe(text.length)
  })
})

describe('line endings', () => {
  const disk = 'one\r\ntwo ä\r\nthree'
  const text = toEditor(disk)

  test('the editor holds \\n, the disk gets back what it had', () => {
    expect(eolOf(disk)).toBe('\r\n')
    expect(eolOf('a\nb')).toBe('\n')
    expect(eolOf('no break')).toBe('\n')
    expect(text).toBe('one\ntwo ä\nthree')
    expect(toDisk(text, '\r\n')).toBe(disk)
    expect(toDisk(text, '\n')).toBe(text)
  })

  test('a byte offset counts the \\r the editor does not hold', () => {
    const at = text.indexOf('three')
    expect(byteAt(text, at, '\r\n')).toBe(Buffer.from(disk).indexOf('three'))
    expect(indexAt(text, Buffer.from(disk).indexOf('three'), '\r\n')).toBe(at)
    expect(indexAt(text, Buffer.from(disk).indexOf('two'), '\r\n')).toBe(text.indexOf('two'))
  })
})

describe('lines', () => {
  const text = 'first\nsecond\n\nfourth'
  test('lineAt, startOfLine, textOfLine', () => {
    expect(lineAt(text, 0)).toBe(1)
    expect(lineAt(text, 5)).toBe(1)
    expect(lineAt(text, 6)).toBe(2)
    expect(lineAt(text, text.length)).toBe(4)
    expect(startOfLine(text, 1)).toBe(0)
    expect(startOfLine(text, 2)).toBe(6)
    expect(startOfLine(text, 4)).toBe(14)
    expect(startOfLine(text, 99)).toBe(14)
    expect(textOfLine(text, 2)).toBe('second')
    expect(textOfLine(text, 3)).toBe('')
    expect(textOfLine(text, 4)).toBe('fourth')
  })
})

/**
 * Finer than a line, by matching words. Each of these can only ever tighten an
 * answer SyncTeX already gave, and says nothing when it cannot be sure.
 */
describe('the word under a click', () => {
  const runs: Run[] = [{ x: 100, y: 50, w: 200, h: 10, text: 'saw both conditions in' }]

  test('found by proportion along the run, widened to the whole word', () => {
    expect(wordAt(runs, 100 + (5 / 22) * 200, 55)).toBe('both')
    expect(wordAt(runs, 100 + (12 / 22) * 200, 55)).toBe('conditions')
  })

  test('a space, a one-letter word, or a point off the run is nothing', () => {
    expect(wordAt(runs, 100 + (3.5 / 22) * 200, 55)).toBeNull()
    expect(wordAt(runs, 50, 55)).toBeNull()
    expect(wordAt(runs, 150, 90)).toBeNull()
    expect(wordAt([{ x: 0, y: 0, w: 10, h: 10, text: 'a' }], 5, 5)).toBeNull()
  })
})

describe('placing that word in the source', () => {
  const lines = ['Each participant saw both', 'conditions in a counterbalanced order.', 'The order was the order.']

  test('on the named line first, then its neighbours', () => {
    expect(placeWord(lines, 0, 'both')).toEqual({ line: 0, column: 21 })
    expect(placeWord(lines, 0, 'conditions')).toEqual({ line: 1, column: 0 })
  })

  test('a whole word only, and a word that appears twice on its line is not guessed at', () => {
    expect(placeWord(['counterbalanced'], 0, 'balanced')).toBeNull()
    expect(placeWord(lines, 2, 'order')).toBeNull()
    expect(placeWord(lines, 0, 'absent')).toBeNull()
  })
})

describe('the words of a piece of source that print as themselves', () => {
  test('commands, citations, maths and comments are dropped', () => {
    expect(printedWords('Literate programming~\\cite{knuth1984} is \\emph{the} idea, $E = mc^2$ % not this\nand more')).toEqual([
      'Literate', 'programming', 'the', 'idea', 'and', 'more',
    ])
    expect(printedWords('\\begin{figure}[t]\\includegraphics[width=3cm]{plot.png}')).toEqual([])
  })
})

describe('tightening SyncTeX’s rectangles to the selected words', () => {
  const runs: Run[] = [
    { x: 100, y: 100, w: 400, h: 10, text: 'first so. The second sentence of this para-' },
    { x: 100, y: 112, w: 400, h: 10, text: 'graph is here to be selected, highlighted' },
  ]
  const rects = [
    { x: 100, y: 100, w: 400, h: 10 },
    { x: 100, y: 112, w: 400, h: 10 },
  ]

  test('the first rectangle starts at the first word, the last ends at the last word', () => {
    const [a, b] = tighten(rects, runs, 'sentence of this paragraph is here to be selected')
    const per = 400 / runs[0]!.text.length
    expect(a!.x).toBeCloseTo(100 + runs[0]!.text.indexOf('sentence') * per, 3)
    expect(a!.x + a!.w).toBeCloseTo(500, 3)
    const per2 = 400 / runs[1]!.text.length
    expect(b!.x).toBe(100)
    expect(b!.x + b!.w).toBeCloseTo(100 + (runs[1]!.text.indexOf('selected') + 'selected'.length) * per2, 3)
  })

  test('an end whose word is not there — hyphenated, or maths — stays where SyncTeX put it', () => {
    const [a, b] = tighten(rects, runs, 'paragraph is here')
    expect(a).toEqual(rects[0]!)
    expect(b!.x + b!.w).toBeLessThan(500)
    expect(tighten(rects, runs, '$x^2$')).toEqual(rects)
    expect(tighten([], runs, 'anything')).toEqual([])
  })

  test('it never widens', () => {
    for (const source of ['first so', 'highlighted', 'The second sentence', 'nothing matching']) {
      tighten(rects, runs, source).forEach((box, i) => {
        expect(box.x).toBeGreaterThanOrEqual(rects[i]!.x)
        expect(box.x + box.w).toBeLessThanOrEqual(rects[i]!.x + rects[i]!.w + 1e-6)
      })
    }
  })
})
