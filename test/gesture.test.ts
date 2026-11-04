import { describe, expect, test } from 'bun:test'

import { endsOf, isDrag, SLOP } from '../src/pdf/gesture.ts'

describe('a press, told from a drag that selects', () => {
  test('a click where the button went down is a press', () => {
    expect(isDrag({ x: 100, y: 100 }, { x: 100, y: 100 }, false)).toBe(false)
    expect(isDrag({ x: 100, y: 100 }, { x: 100 + SLOP - 1, y: 100 }, false)).toBe(false)
  })

  test('a click after the pointer travelled is a drag, even over the margin where nothing was selected', () => {
    expect(isDrag({ x: 100, y: 100 }, { x: 100 + SLOP + 1, y: 100 }, false)).toBe(true)
    expect(isDrag({ x: 100, y: 100 }, { x: 140, y: 180 }, false)).toBe(true)
  })

  test('a click with words selected is a drag, however short — a triple press selecting a line is not a press either', () => {
    expect(isDrag({ x: 100, y: 100 }, { x: 100, y: 100 }, true)).toBe(true)
    expect(isDrag(null, { x: 0, y: 0 }, true)).toBe(true)
  })

  test('with no record of the button going down, a click with nothing selected is a press', () => {
    expect(isDrag(null, { x: 5, y: 5 }, false)).toBe(false)
  })
})

describe('where a selection begins and ends on the pages', () => {
  /* Two sheets 500 px tall at scale 2, one under the other with a 10 px gap. */
  const sheets = [
    { page: 3, box: { left: 10, top: 0, right: 410, bottom: 500 } },
    { page: 4, box: { left: 10, top: 510, right: 410, bottom: 1010 } },
  ]

  test('one line: from just inside its left end to just inside its right, in points, at the middle of the line', () => {
    const ends = endsOf([{ left: 50, top: 100, right: 250, bottom: 120 }], sheets, 2)!
    expect(ends.from).toEqual({ page: 3, x: (51 - 10) / 2, y: 55 })
    expect(ends.to).toEqual({ page: 3, x: (249 - 10) / 2, y: 55 })
  })

  test('across a page break: the start on the first sheet, the end on the next', () => {
    const ends = endsOf(
      [
        { left: 50, top: 460, right: 400, bottom: 480 },
        { left: 30, top: 540, right: 200, bottom: 560 },
      ],
      sheets,
      2,
    )!
    expect(ends.from.page).toBe(3)
    expect(ends.to).toEqual({ page: 4, x: (199 - 10) / 2, y: (550 - 510) / 2 })
  })

  test('empty rectangles at line ends and rectangles off every sheet are passed over', () => {
    const ends = endsOf(
      [
        { left: 2, top: 100, right: 8, bottom: 120 },
        { left: 60, top: 100, right: 60, bottom: 120 },
        { left: 60, top: 200, right: 160, bottom: 216 },
        { left: 300, top: 300, right: 300, bottom: 300 },
      ],
      sheets,
      2,
    )!
    expect(ends.from).toEqual({ page: 3, x: (61 - 10) / 2, y: 104 })
    expect(ends.to).toEqual({ page: 3, x: (159 - 10) / 2, y: 104 })
  })

  test('nothing on a sheet, or no scale, is no pick', () => {
    expect(endsOf([{ left: 0, top: 600, right: 5, bottom: 505 }], sheets, 2)).toBeNull()
    expect(endsOf([], sheets, 2)).toBeNull()
    expect(endsOf([{ left: 50, top: 100, right: 250, bottom: 120 }], sheets, 0)).toBeNull()
  })
})
