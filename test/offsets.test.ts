import { describe, expect, test } from 'bun:test'

import { byteAt, eolOf, indexAt, lineAt, startOfLine, textOfLine, toDisk, toEditor } from '../src/lib/offsets.ts'
import { placeWord, printedWords, tighten, wordAt, type Box, type Run } from '../src/pdf/words.ts'

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

  test('the first rectangle starts at the first word, the last ends at the last word, each with two characters to spare', () => {
    const [a, b] = tighten(rects, runs, 'sentence of this paragraph is here to be selected')
    const per = 400 / runs[0]!.text.length
    expect(a!.x).toBeCloseTo(100 + (runs[0]!.text.indexOf('sentence') - 2) * per, 3)
    expect(a!.x + a!.w).toBeCloseTo(500, 3)
    const per2 = 400 / runs[1]!.text.length
    expect(b!.x).toBe(100)
    expect(b!.x + b!.w).toBeCloseTo(100 + (runs[1]!.text.indexOf('selected') + 'selected'.length + 2) * per2, 3)
  })

  test('an end whose word is not there — hyphenated, or maths — stays where SyncTeX put it', () => {
    const [a, b] = tighten(rects, runs, 'paragraph is here')
    expect(a).toEqual(rects[0]!)
    expect(b!.x + b!.w).toBeLessThan(500)
    expect(tighten(rects, runs, '$x^2$')).toEqual(rects)
    expect(tighten([], runs, 'anything')).toEqual([])
  })

  /* Every rectangle handed back lies inside one that was handed in. By
     containment and not by index, because a rectangle the selection does not
     reach is dropped. */
  const within = (out: readonly Box[], given: readonly Box[]) => {
    for (const box of out) {
      expect(given.some((rect) => box.y === rect.y && box.x >= rect.x - 1e-6 && box.x + box.w <= rect.x + rect.w + 1e-6)).toBe(true)
    }
  }

  test('it never widens', () => {
    for (const source of ['first so', 'highlighted', 'The second sentence', 'nothing matching', 'so', 'first', 'selected, highlighted']) {
      const out = tighten(rects, runs, source)
      expect(out.length).toBeGreaterThan(0)
      within(out, rects)
    }
    /* A margin is kept round a found word, and it stops at SyncTeX's edge. */
    expect(tighten(rects, runs, 'first so')[0]!.x).toBe(100)
    const narrow = [{ x: 100, y: 100, w: 1, h: 10 }]
    within(tighten(narrow, runs, 'first'), narrow)
  })

  /**
   * The report this was fixed for, from the positions a real compile gave.
   *
   * Source line 34 of a 20-page paper, `have nothing to do with the sixth
   * thing; removing one means deleting code that`, set by Tectonic and read
   * back through `syncForward` and pdf.js. It is printed over two lines, so
   * SyncTeX answers with two rectangles — and a selection of three words in
   * the middle of it starts AND ends under the first.
   */
  describe('a selection inside a source line that is printed over two lines', () => {
    const page: Run[] = [
      { x: 85.03938, y: 281.401102, w: 425.1926138880002, h: 10.909088, text: 'editing two files that have nothing to do with the sixth thing; removing one means deleting' },
      { x: 85.03938, y: 294.950302, w: 425.2035229759999, h: 10.909088, text: 'code that four other files reach into. The alternative is that a mode is a program the owner' },
      { x: 85.03938, y: 308.499502, w: 425.1926138880003, h: 10.909088, text: 'runs: a server on loopback that answers a manifest on a well-known path and serves a' },
    ]
    const answer = [
      { page: 1, x: 187.27086353420768, y: 284.6190494143058, w: 322.9653782446684, h: 9.938165229996887 },
      { page: 1, x: 85.03937869707349, y: 298.1682460305106, w: 50.076601781405685, h: 9.938165229996887 },
    ]
    const per = page[0]!.w / page[0]!.text.length
    const edge = (word: string, end = false) => page[0]!.x + (page[0]!.text.indexOf(word) + (end ? word.length : 0)) * per

    test('both ends are found under the first rectangle, and the second is dropped', () => {
      const out = tighten(answer, page, 'removing one means')
      expect(out).toHaveLength(1)
      const [mark] = out
      expect(mark!.page).toBe(1)
      expect(mark!.y).toBe(answer[0]!.y)
      /* It reaches the whole of both words… */
      expect(mark!.x).toBeLessThanOrEqual(edge('removing'))
      expect(mark!.x + mark!.w).toBeGreaterThanOrEqual(edge('means', true))
      /* …with the margin a proportional estimate needs, and no more: not back
         to `thing;`, and not on into `deleting code that f`. */
      expect(mark!.x).toBeGreaterThanOrEqual(edge('thing;', true) - per)
      expect(mark!.x + mark!.w).toBeLessThan(edge('deleting') + 2 * per)
      within(out, answer)
    })

    test('a selection that starts under one rectangle and ends under the next keeps both', () => {
      const out = tighten(answer, page, 'means deleting code')
      expect(out).toHaveLength(2)
      expect(out[0]!.x).toBeGreaterThan(edge('one'))
      expect(out[0]!.x + out[0]!.w).toBeCloseTo(answer[0]!.x + answer[0]!.w, 6)
      expect(out[1]!.x).toBe(answer[1]!.x)
      expect(out[1]!.x + out[1]!.w).toBeLessThanOrEqual(answer[1]!.x + answer[1]!.w)
      within(out, answer)
    })

    test('a selection wholly under the second rectangle drops the first', () => {
      const out = tighten(answer, page, 'code that')
      expect(out).toHaveLength(1)
      expect(out[0]!.y).toBe(answer[1]!.y)
      within(out, answer)
    })

    test('the whole source line is still marked whole', () => {
      const out = tighten(answer, page, 'have nothing to do with the sixth thing; removing one means deleting code that')
      expect(out).toHaveLength(2)
      expect(out[0]!.x).toBeCloseTo(answer[0]!.x, 6)
      expect(out[0]!.x + out[0]!.w).toBeCloseTo(answer[0]!.x + answer[0]!.w, 6)
      expect(out[1]!.x).toBe(answer[1]!.x)
      within(out, answer)
    })

    test('a repeated word costs precision, never coverage; ends that cross change nothing', () => {
      /* `that` is printed once under each rectangle: as the FIRST word the
         earlier is taken, as the LAST word the later. */
      const from = tighten(answer, page, 'that have nothing')
      expect(from).toHaveLength(1)
      expect(from[0]!.x).toBeCloseTo(answer[0]!.x, 6)
      const to = tighten(answer, page, 'deleting code that')
      expect(to).toHaveLength(2)
      /* `code … deleting` is not in that order on the page. */
      expect(tighten(answer, page, 'code and then deleting')).toEqual(answer)
    })
  })
})

/**
 * The same, when the runs were measured in their own font (`xs`).
 *
 * The page is the one this was written against: a thesis set by pdfLaTeX,
 * where SyncTeX's rectangle for a source line starts after that line's first
 * word and runs on over the first word of the next. A passage of three source
 * lines was marked from "their own words" to "taught material."; what was
 * selected was "followed by … exercise grade".
 */
describe('a mark whose ends were measured', () => {
  /* Eight points a character, so an offset is easy to read; nothing here
     depends on the characters being the same width, only on `xs` being used. */
  const run = (x: number, y: number, text: string): Run => ({
    x,
    y,
    w: text.length * 8,
    h: 10,
    text,
    xs: Array.from({ length: text.length + 1 }, (_, i) => i * 8),
  })
  const one = 'in their own words, and received a verdict, followed by a hint, a'
  const two = 'follow-up question or the next item; the score ran out was the'
  const three = 'exercise grade. EduChat keeps what the agent says with the taught'
  const page = [run(70, 100, one), run(70, 112, two), run(70, 124, three)]
  /* Late, as SyncTeX's are: each starts inside its line and the last overruns. */
  const late = [
    { x: 70 + 3 * 8, y: 100, w: (one.length - 3) * 8, h: 10, page: 10 },
    { x: 70 + 5 * 8, y: 112, w: (two.length - 5) * 8, h: 10, page: 10 },
    { x: 70 + 8 * 8, y: 124, w: (three.length - 8) * 8, h: 10, page: 10 },
  ]
  const selected = 'followed by\na hint, a follow-up question or the next item; the score ran\nout was the exercise grade'

  test('runs from its first word to the end of that line, over whole lines, to its last word', () => {
    const [a, b, c] = tighten(late, page, selected)
    expect(a!.x).toBeCloseTo(70 + one.indexOf('followed') * 8 - 1, 3)
    expect(a!.x + a!.w).toBeCloseTo(70 + one.length * 8 + 1, 3)
    /* Wider than SyncTeX's on the left: the line starts at "follow-up", and SyncTeX's rectangle after it. */
    expect(b!.x).toBeCloseTo(70 - 1, 3)
    expect(b!.x + b!.w).toBeCloseTo(70 + two.length * 8 + 1, 3)
    expect(c!.x).toBeCloseTo(70 - 1, 3)
    expect(c!.x + c!.w).toBeCloseTo(70 + (three.indexOf('grade') + 'grade'.length) * 8 + 1, 3)
    expect(c!.page).toBe(10)
  })

  test('one word is marked as that word and nothing either side of it', () => {
    const [only, ...rest] = tighten([late[0]!], page, 'verdict')
    expect(rest).toEqual([])
    expect(only!.x).toBeCloseTo(70 + one.indexOf('verdict') * 8 - 1, 3)
    expect(only!.w).toBeCloseTo('verdict'.length * 8 + 2, 3)
  })

  test('the short words and punctuation at its ends are carried when the page prints what the source says', () => {
    const [only] = tighten([late[0]!], page, 'a verdict, followed by a')
    expect(only!.x).toBeCloseTo(70 + one.indexOf('a verdict') * 8 - 1, 3)
    expect(only!.x + only!.w).toBeCloseTo(70 + (one.indexOf('followed by a') + 'followed by a'.length) * 8 + 1, 3)
    /* A command at an end prints as something else: the end stays on the word. */
    const [cut] = tighten([late[0]!], page, '\\emph{a} verdict')
    expect(cut!.x).toBeCloseTo(70 + one.indexOf('verdict') * 8 - 1, 3)
  })

  test('a word under the point is found by where its characters are', () => {
    const wide: Run = { x: 0, y: 0, w: 100, h: 10, text: 'ab cdef', xs: [0, 5, 10, 60, 70, 80, 90, 100] }
    /* By proportion x = 40 is the third character, the space; measured, the space ends at 60. */
    expect(wordAt([wide], 40, 5)).toBeNull()
    expect(wordAt([wide], 65, 5)).toBe('cdef')
    expect(wordAt([wide], 7, 5)).toBe('ab')
  })

  test('with one end unmeasured the old rule stands: inward only', () => {
    const mixed = [page[0]!, page[1]!, { ...page[2]!, xs: undefined }]
    const out = tighten(late, mixed, selected)
    expect(out[1]!.x).toBe(late[1]!.x)
    for (const [i, rect] of out.entries()) {
      expect(rect.x).toBeGreaterThanOrEqual(late[i]!.x)
      expect(rect.x + rect.w).toBeLessThanOrEqual(late[i]!.x + late[i]!.w + 1e-9)
    }
  })
})
