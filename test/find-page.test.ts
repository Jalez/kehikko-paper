import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { FIND_MARK_ATTRIBUTE, findMatches, pageFind } from 'kehikot-module-protocol/client'

import { pdfFind } from '../src/pdf/finding.ts'

/**
 * Find (protocol 2.69.0). The host's find bar is answered by the protocol client's own search of the
 * page, and in the PDF the page's text is pdf.js's text layer: one span per run of text, laid over
 * each sheet. While a search is open every sheet gets its layer (`pdf/finding.ts`), and the source
 * editor is skipped — it has its own ⌘F. This lays out a page the way `pdf-view.tsx` does, with the
 * runs of a real compiled document (`fixtures/highlight/main.pdf`), and searches it.
 */

const DIR = join(import.meta.dir, 'fixtures', 'highlight')
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(DIR, 'main.pdf'))) }).promise
const sheets: string[][] = []
for (let n = 1; n <= doc.numPages; n++) {
  const content = await (await doc.getPage(n)).getTextContent()
  sheets.push((content.items as { str?: string }[]).map((item) => item.str ?? '').filter(Boolean))
}

/* A paper as the page draws it: sheets with their text layers, and the source editor beside them. */
function paper(source: string, laid = true): HTMLElement {
  const root = document.createElement('div')
  const editor = document.createElement('div')
  editor.className = 'source-editor'
  editor.setAttribute('data-kehikot-find-skip', '')
  editor.textContent = source
  root.append(editor)
  sheets.forEach((runs, i) => {
    const sheet = document.createElement('div')
    sheet.className = 'pdf-page'
    sheet.setAttribute('data-page', String(i + 1))
    if (laid) {
      const layer = document.createElement('div')
      layer.className = 'textLayer'
      for (const run of runs) {
        const span = document.createElement('span')
        span.textContent = run
        layer.append(span)
      }
      sheet.append(layer)
    }
    root.append(sheet)
  })
  document.body.append(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
  pdfFind.close()
})

/* A word the document prints more than once, so there is a next and a previous. */
const all = sheets.flat().join('')
/* Every run is a span of its own, side by side with the next: a whole word may begin or end between two (protocol 2.69.1). */
const runBreaks = new Set<number>()
sheets.flat().reduce((at, run) => {
  runBreaks.add(at)
  return at + run.length
}, 0)
const WORD = ['the', 'of', 'and'].find((word) => findMatches(all, word, { wholeWord: true }, runBreaks).length > 2)!
const options = { caseSensitive: false, wholeWord: true }
const marks = (root: Element) => [...root.querySelectorAll(`mark[${FIND_MARK_ATTRIBUTE}]`)]

describe('find in the PDF', () => {
  test('marks and counts every sheet\'s words, and not the source editor\'s', () => {
    const root = paper(`${WORD} ${WORD} ${WORD} in the source`)
    const expected = findMatches(all, WORD, options, runBreaks).length
    const search = pageFind(() => {}, { root, visible: () => true, highlights: false })
    expect(search.run(WORD, options, 'first')).toEqual({ total: expected, current: 1 })
    expect(marks(root)).toHaveLength(expected)
    expect(root.querySelector('.source-editor mark')).toBeNull()
    search.close()
  })

  test('next and previous move through the sheets, and wrap', () => {
    const root = paper('')
    const search = pageFind(() => {}, { root, visible: () => true, highlights: false })
    const { total } = search.run(WORD, options, 'first')
    expect(search.run(WORD, options, 'next')).toEqual({ total, current: 2 })
    expect(search.run(WORD, options, 'prev')).toEqual({ total, current: 1 })
    expect(search.run(WORD, options, 'prev')).toEqual({ total, current: total })
    expect(root.querySelectorAll('[data-current]')).toHaveLength(1)
    search.close()
  })

  test('close clears every mark and leaves the layers as pdf.js laid them', () => {
    const root = paper('')
    const before = root.innerHTML
    const search = pageFind(() => {}, { root, visible: () => true, highlights: false })
    search.run(WORD, options, 'first')
    search.close()
    expect(marks(root)).toHaveLength(0)
    expect(root.innerHTML).toBe(before)
  })
})

describe('the words of every sheet, while a search is open', () => {
  test('the shared adapter waits for the sheets pdf-view draws, then leaves the search to the client', async () => {
    const root = paper('', false)
    let answered: unknown = null
    const asking = pdfFind.onFind(WORD, { ...options, direction: 'first' }).then((said) => (answered = said))
    expect(pdfFind.open()).toBe(true)
    await new Promise((settle) => setTimeout(settle, 80))
    expect(answered).toBeNull()
    for (const sheet of root.querySelectorAll('.pdf-page')) {
      const layer = document.createElement('div')
      layer.className = 'textLayer'
      sheet.append(layer)
    }
    await asking
    expect(answered).toBe('default')
    await pdfFind.onFind(WORD, { ...options, direction: 'close' })
    expect(pdfFind.open()).toBe(false)
  })
})
