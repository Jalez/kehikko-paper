import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

import { locate, read } from '../src/pdf/find.ts'
import { spanOf } from '../src/pdf/printed.ts'
import type { Run } from '../src/pdf/words.ts'

/**
 * The mark on the PDF covers the words it is for.
 *
 * A REAL compiled document (`fixtures/highlight/main.pdf`, built by Tectonic
 * from the two .tex files beside it): a page of its own, and an included
 * chapter that runs over two more. Each test names a passage by its source,
 * finds it with the page's own `locate`, and compares the rectangles with where
 * pdf.js says those very words are printed — by the words themselves, not by
 * any line number.
 *
 * What a rectangle is, in this file, is what the page draws: PDF points from
 * the top-left of a sheet. The page draws it at `rect * scale` inside the
 * sheet, so a correct rectangle is correct at every zoom, which the last test
 * says in the page's own arithmetic.
 */

const DIR = join(import.meta.dir, 'fixtures', 'highlight')
const MAIN = readFileSync(join(DIR, 'main.tex'), 'utf8')
const CHAPTER = readFileSync(join(DIR, 'chapter.tex'), 'utf8')

interface Item { x: number; y: number; w: number; h: number; text: string; page: number }

const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(DIR, 'main.pdf'))) }).promise

const sheets: { height: number; runs: Run[]; items: Item[] }[] = []
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n)
  const height = page.getViewport({ scale: 1 }).height
  const content = await page.getTextContent()
  const items: Item[] = []
  for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
    if (typeof item.str !== 'string' || !item.transform || !item.str.trim()) continue
    const h = item.height || 10
    items.push({ x: item.transform[4]!, y: height - item.transform[5]! - h, w: item.width ?? 0, h, text: item.str, page: n })
  }
  sheets.push({
    height,
    items,
    /* No canvas here to measure letters with: an edge is found by proportion along the run, as `edge` does before measuring. */
    runs: items.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h, text: i.text })),
  })
}
const text = read(sheets.map((one, i) => ({ page: i + 1, runs: one.runs })))

/** Where a passage of a source is printed, by `locate`, with nothing from SyncTeX to lean on. */
function placed(source: string, passage: string) {
  const from = source.indexOf(passage)
  expect(from).toBeGreaterThanOrEqual(0)
  return locate(text, spanOf(source, from, from + passage.length), [])
}

/**
 * The ink of a printed line is from above its tall letters to below its
 * descenders: the baseline less 0.78 of the line's height, down to a little
 * below it. A mark is right when it spans that, on the right sheet.
 */
function coversInk(r: { y: number; h: number }, line: { y: number; h: number }): boolean {
  const base = line.y + line.h
  return r.y <= base - line.h * 0.6 && r.y + r.h >= base + line.h * 0.1 && r.h < line.h * 1.6
}

/** The printed lines a run of words is on, from pdf.js alone: the first and last line the words begin and end in. */
function linesOfWords(words: string): { page: number; y: number; h: number }[] {
  const out: { page: number; y: number; h: number }[] = []
  const first = words.split(/\s+/).slice(0, 3).join(' ')
  const hit = sheets.flatMap((s, i) => s.items.filter((it) => it.text.includes(first)).map((it) => ({ page: i + 1, y: it.y, h: it.h })))
  out.push(...hit)
  return out
}

describe('where a passage is marked is where its words are printed', () => {
  test('a sentence on the first page, over two source lines', () => {
    const passage = 'The opening paragraph carries the sentence the first test looks for, and it\nruns over two source lines before it ends.'
    const found = placed(MAIN, passage)
    expect(found.how).toBe('words')
    const [first, ...rest] = found.rects
    expect(first!.page).toBe(1)
    const line = linesOfWords('The opening paragraph carries')[0]!
    expect(coversInk(first!, line)).toBe(true)
    /* It starts at the margin and runs to the end of what was said. */
    expect(first!.x).toBeLessThan(75)
    expect(rest.length + 1).toBeGreaterThanOrEqual(2)
  })

  test('a sentence in the INCLUDED file, on a later sheet', () => {
    const passage = 'This sentence is in the included file and printed beyond the first page of the paper,\nso a mark for it has to be drawn on a later sheet.'
    const found = placed(CHAPTER, passage)
    expect(found.how).toBe('words')
    const pages = [...new Set(found.rects.map((r) => r.page))]
    expect(pages.every((p) => p >= 1 && p <= doc.numPages)).toBe(true)
    const line = linesOfWords('This sentence is in')[0]!
    expect(found.rects[0]!.page).toBe(line.page)
    expect(coversInk(found.rects[0]!, line)).toBe(true)
  })

  test('a sentence on the LAST page, after a good deal of text', () => {
    const passage = 'The late passage sits on the last page, after a good deal of other text, in the included chapter.'
    const found = placed(CHAPTER, passage)
    expect(found.how).toBe('words')
    expect(found.rects[0]!.page).toBeGreaterThan(1)
    const line = linesOfWords('The late passage sits')[0]!
    expect(found.rects[0]!.page).toBe(line.page)
    expect(coversInk(found.rects[0]!, line)).toBe(true)
    /* And every rectangle lies inside its sheet. */
    for (const r of found.rects) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y + r.h).toBeLessThan(sheets[r.page - 1]!.height)
    }
  })

  test('a mark covers the words and not their neighbours: the box holds the passage and no whole other line', () => {
    const passage = 'The late passage sits on the last page'
    const found = placed(CHAPTER, passage)
    for (const r of found.rects) {
      const under = sheets[r.page - 1]!.items.filter((i) => i.x + i.w > r.x + 1 && i.x < r.x + r.w - 1 && i.y + i.h > r.y + 1 && i.y < r.y + r.h - 1)
      expect(under.map((i) => i.text).join(' ')).toContain('The late passage sits')
      /* One printed line, not the paragraph. */
      expect(new Set(under.map((i) => Math.round(i.y))).size).toBe(1)
    }
  })

  test('at every zoom the page draws rect * scale inside the sheet: the same words are covered', () => {
    const passage = 'The late passage sits on the last page'
    const found = placed(CHAPTER, passage)
    const r = found.rects[0]!
    const line = linesOfWords('The late passage sits')[0]!
    for (const scale of [0.5, 0.75, 1, 1.54, 2, 3]) {
      const drawn = { y: r.y * scale, h: r.h * scale }
      const printed = { y: line.y * scale, h: line.h * scale }
      /* The same relation between the box and the ink at every zoom: a mark that is a different distance off at each has a scale in the wrong place. */
      expect(coversInk(drawn, printed)).toBe(true)
      expect(Math.abs(drawn.y + drawn.h / 2 - (printed.y + printed.h * 0.6))).toBeLessThan(0.15 * printed.h + 0.5)
    }
  })
})
