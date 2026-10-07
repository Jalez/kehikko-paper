import { describe, expect, test } from 'bun:test'

import { forward, pageMap, pageOfLine, parseSynctex, relativeInput, reverse, tagsOf } from '../compile/synctex.ts'

/**
 * SyncTeX, read by hand.
 *
 * The fixture is written out rather than captured from an engine so that every
 * number in an assertion can be found in it. Coordinates are in scaled points;
 * 65781.76 of them are one PDF point, so the fixture uses multiples of 6578176
 * (100 points) to keep the arithmetic readable.
 *
 * One page. A paragraph of two printed lines typed on source lines 3 and 4 of
 * `main.tex`, then a line from `chapters/a.tex`, then a box out of the
 * engine's own bundle (an input with no name).
 */
const P = 6578176 // 100pt
const ROOT = '/work/paper'
const SYNC = [
  'SyncTeX Version:1',
  `Input:1:${ROOT}/main.tex`,
  'Input:2:',
  `Input:3:${ROOT}/chapters/a.tex`,
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'X Offset:0',
  'Y Offset:0',
  'Content:',
  '!100',
  '{1',
  `[1,9:${P},${8 * P}:${4 * P},${7 * P},0`,
  /* Printed line one: baseline y=200, x 100..500, height 10pt. Words typed on
     source line 3, then — from x=350 — on source line 4. */
  `(1,4:${P},${2 * P}:${4 * P},${P / 10},0`,
  `g1,3:${1.5 * P},${2 * P}`,
  `g1,3:${2.5 * P},${2 * P}`,
  `g1,3:${3.5 * P},${2 * P}`,
  `g1,4:${4.2 * P},${2 * P}`,
  ')',
  /* Printed line two: baseline y=215, all of source line 4. */
  `(1,4:${P},${2.15 * P}:${4 * P},${P / 10},0`,
  `g1,4:${1.6 * P},${2.15 * P}`,
  `g1,4:${2.4 * P},${2.15 * P}`,
  ')',
  /* A line from the chapter file. */
  `(3,2:${P},${3 * P}:${4 * P},${P / 10},0`,
  `g3,2:${2 * P},${3 * P}`,
  `k3,2:${2.2 * P},${3 * P}:${P / 20}`,
  ')',
  /* A page number, typeset by the class. */
  `(2,880:${3 * P},${7.5 * P}:${P / 5},${P / 10},0`,
  `h2,880:${3 * P},${7.5 * P}:0,0,0`,
  ')',
  ']',
  '}1',
  '!50',
  'Postamble:',
  'Count:14',
].join('\n')

const table = parseSynctex(SYNC)
const owned = (tag: number) => relativeInput(table.inputs.get(tag) ?? '', ROOT) !== null

describe('parsing', () => {
  test('inputs, pages, boxes and leaves', () => {
    expect(table.pages).toBe(1)
    expect([...table.inputs.keys()]).toEqual([1, 2, 3])
    expect(table.boxes).toHaveLength(4)
    expect(table.leaves).toHaveLength(9)
  })

  test('coordinates come out in PDF points from the top-left', () => {
    expect(table.boxes[0]).toMatchObject({ page: 1, tag: 1, line: 4 })
    expect(table.boxes[0]!.x).toBeCloseTo(100, 3)
    expect(table.boxes[0]!.y).toBeCloseTo(200, 3)
    expect(table.boxes[0]!.w).toBeCloseTo(400, 3)
    expect(table.boxes[0]!.h).toBeCloseTo(10, 3)
  })

  test('a leaf knows the horizontal box it is in, and a vertical box is never that', () => {
    expect(table.leaves[0]!.box).toBe(0)
    expect(table.leaves[4]!.box).toBe(1)
  })

  test('garbage and unknown records are skipped rather than thrown on', () => {
    const odd = parseSynctex(['Input:1:/a/main.tex', '{1', 'f1000:1,2', '(1,2:65781,65781:65781,65781,0', 'z1,2:3,4', 'g1,2', ')', '}1'].join('\n'))
    expect(odd.boxes).toHaveLength(1)
    expect(odd.leaves).toHaveLength(0)
    expect(parseSynctex('').pages).toBe(0)
  })
})

describe('which input is which file', () => {
  test('a file under the paper is relative to it; one from the bundle is nobody’s', () => {
    expect(relativeInput(`${ROOT}/chapters/a.tex`, ROOT)).toBe('chapters/a.tex')
    expect(relativeInput(`${ROOT}/./chapters/./a.tex`, ROOT)).toBe('chapters/a.tex')
    expect(relativeInput('', ROOT)).toBeNull()
    expect(relativeInput('/usr/share/texmf/article.cls', ROOT)).toBeNull()
    expect(relativeInput(`${ROOT}-evil/main.tex`, ROOT)).toBeNull()
    expect(relativeInput(`${ROOT}/../other/main.tex`, ROOT)).toBeNull()
  })

  test('tagsOf', () => {
    expect(tagsOf(table, ROOT, 'main.tex')).toEqual([1])
    expect(tagsOf(table, ROOT, 'chapters/a.tex')).toEqual([3])
    expect(tagsOf(table, ROOT, 'nope.tex')).toEqual([])
  })
})

describe('forward: source lines to rectangles', () => {
  test('a source line that is the start of a printed line runs from the box’s edge to its last glue', () => {
    const { rects, exact } = forward(table, [1], 3, 3)
    expect(exact).toBe(true)
    expect(rects).toHaveLength(1)
    expect(rects[0]!.page).toBe(1)
    expect(rects[0]!.x).toBeCloseTo(100, 2)
    expect(rects[0]!.x + rects[0]!.w).toBeCloseTo(350, 2)
    expect(rects[0]!.y).toBeCloseTo(190, 2)
  })

  test('a source line that starts mid printed-line and wraps gives two rectangles, each on its own line', () => {
    const { rects } = forward(table, [1], 4, 4)
    expect(rects).toHaveLength(2)
    /* From the glue that ended line 3's words, to the end of the printed line. */
    expect(rects[0]!.x).toBeCloseTo(350, 2)
    expect(rects[0]!.x + rects[0]!.w).toBeCloseTo(500, 2)
    /* The second printed line, whole: nothing follows it in its box. */
    expect(rects[1]!.x).toBeCloseTo(100, 2)
    expect(rects[1]!.x + rects[1]!.w).toBeCloseTo(500, 2)
    expect(rects[1]!.y).toBeGreaterThan(rects[0]!.y)
  })

  test('a range of lines is the union, merged where the pieces touch on one printed line', () => {
    const { rects } = forward(table, [1], 3, 4)
    expect(rects).toHaveLength(2)
    expect(rects[0]!.x).toBeCloseTo(100, 2)
    expect(rects[0]!.w).toBeCloseTo(400, 2)
  })

  test('a line with no record of its own answers the nearest one, and says it is not exact', () => {
    const found = forward(table, [1], 1, 1)
    expect(found.exact).toBe(false)
    expect(found.line).toBe(3)
    expect(found.rects.length).toBeGreaterThan(0)
  })

  test('another file’s line of the same number is not confused with this one', () => {
    const { rects } = forward(table, [3], 2, 2)
    expect(rects).toHaveLength(1)
    expect(rects[0]!.y).toBeCloseTo(290, 2)
  })

  test('no tags, or a file the build never opened, is nothing', () => {
    expect(forward(table, [], 3, 3).rects).toEqual([])
    expect(forward(table, [99], 3, 3).rects).toEqual([])
  })
})

describe('reverse: a point to a file and line', () => {
  test('the first glue to the right of the click is the clicked word’s line', () => {
    expect(reverse(table, owned, 1, 200, 196)).toEqual({ tag: 1, line: 3 })
    /* Past the last glue of line 3's words: these words were typed on line 4. */
    expect(reverse(table, owned, 1, 380, 196)).toEqual({ tag: 1, line: 4 })
    expect(reverse(table, owned, 1, 480, 196)).toEqual({ tag: 1, line: 4 })
  })

  test('the chapter’s line goes to the chapter', () => {
    expect(reverse(table, owned, 1, 150, 296)).toEqual({ tag: 3, line: 2 })
  })

  test('a box set entirely by the class is passed over, and the nearest of the paper’s own is too far to claim', () => {
    expect(reverse(table, owned, 1, 305, 746)).toBeNull()
  })

  test('a click in the gap just beside a line still finds it', () => {
    expect(reverse(table, owned, 1, 98, 202)).toEqual({ tag: 1, line: 3 })
  })

  test('another page has nothing', () => {
    expect(reverse(table, owned, 2, 200, 196)).toBeNull()
  })
})

describe('the per-file page map', () => {
  const map = pageMap(table, ROOT)

  test('each of the paper’s files, with the lines of it that reached each page — and nothing from the bundle', () => {
    expect(map).toEqual({
      'main.tex': [{ page: 1, from: 3, to: 4 }],
      'chapters/a.tex': [{ page: 1, from: 2, to: 2 }],
    })
  })

  test('pageOfLine', () => {
    expect(pageOfLine(map, 'main.tex', 4)).toBe(1)
    expect(pageOfLine(map, 'main.tex', 1)).toBe(1)
    expect(pageOfLine(map, 'nope.tex', 1)).toBeNull()
    const two = { 'a.tex': [{ page: 1, from: 1, to: 40 }, { page: 2, from: 44, to: 90 }] }
    expect(pageOfLine(two, 'a.tex', 42)).toBe(1)
    expect(pageOfLine(two, 'a.tex', 44)).toBe(2)
    expect(pageOfLine(two, 'a.tex', 500)).toBe(2)
  })
})
