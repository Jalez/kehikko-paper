import { describe, expect, test } from 'bun:test'
import { partsSchema, type EpicPart } from 'kehikot-module-protocol'

import type { PageSpan } from '../compile/synctex.ts'
import { gapsBetween, headline, inFocus, narrowed, notesOf, pagesSaid, pagesShown, sameParts } from '../src/focus.ts'

/**
 * The paper narrowed to the picked parts of the epic: which files, which
 * pages, and every sentence the page says about it.
 *
 * The rule itself is the protocol's and is tested there. What is held here is
 * what this module makes of it — that nothing picked changes nothing, that a
 * page two files share is shown when either is picked, that the numbers are
 * the PDF's own, and that each way a focus can leave a paper short is turned
 * into words rather than into an empty pane.
 */

const EPIC = 'a-paper'
const paper = { epic: EPIC, files: ['main.tex', 'chapters/design.tex', 'chapters/method.tex', 'chapters/results.tex'] }

/* A twelve-page paper. `main.tex` prints the title page and the conclusion;
   the design ends on the sheet the method begins on. */
const map: Record<string, PageSpan[]> = {
  'main.tex': [
    { page: 1, from: 1, to: 40 },
    { page: 12, from: 60, to: 80 },
  ],
  'chapters/design.tex': [
    { page: 2, from: 1, to: 50 },
    { page: 3, from: 51, to: 90 },
    { page: 4, from: 91, to: 99 },
  ],
  'chapters/method.tex': [
    { page: 4, from: 1, to: 20 },
    { page: 5, from: 21, to: 70 },
  ],
  'chapters/results.tex': [
    { page: 6, from: 1, to: 300 },
    { page: 7, from: 301, to: 400 },
    { page: 8, from: 401, to: 500 },
    { page: 9, from: 501, to: 600 },
    { page: 10, from: 601, to: 700 },
    { page: 11, from: 701, to: 800 },
  ],
}
const pdf = { pages: 12, map }

const part = (id: string, heading: string, picked: boolean, files?: string[]): EpicPart => ({
  id,
  heading,
  refs: [],
  picked,
  ...(files ? { files } : {}),
})
const parts = (...picked: string[]): EpicPart[] => [
  part('the-design', 'The design', picked.includes('the-design'), ['chapters/design.tex']),
  part('the-method', 'The method', picked.includes('the-method'), ['chapters/method.tex']),
  part('the-results', 'The results', picked.includes('the-results'), ['chapters/results.tex']),
  part('the-steps', 'Steps only', picked.includes('the-steps')),
]

describe('nothing picked', () => {
  test('is the whole paper: no narrowing at all, and every file in front of the person', () => {
    expect(narrowed(parts(), paper, pdf)).toBeNull()
    expect(narrowed([], paper, pdf)).toBeNull()
    for (const file of paper.files) expect(inFocus(parts(), paper, file)).toBe(true)
  })

  test('the fixtures are parts a host could send', () => {
    expect(partsSchema.safeParse(parts('the-design')).success).toBe(true)
  })
})

describe('one part picked', () => {
  const focus = narrowed(parts('the-design'), paper, pdf)!

  test('only its files, in the paper’s own order, and the rest counted', () => {
    expect(focus.parts).toEqual(['The design'])
    expect(focus.files).toEqual(['chapters/design.tex'])
    expect(focus.totalFiles).toBe(4)
    expect(focus.outsideFiles).toBe(3)
    /* `main.tex` is in no part, so it is outside every focus. */
    expect(inFocus(parts('the-design'), paper, 'main.tex')).toBe(false)
    expect(inFocus(parts('the-design'), paper, 'chapters/design.tex')).toBe(true)
  })

  test('the pages its file printed on, by their real numbers — the shared sheet included', () => {
    /* Page 4 holds the end of the design and the start of the method. */
    expect(focus.pages).toEqual([2, 3, 4])
    expect(focus.totalPages).toBe(12)
  })

  test('and the line above the paper says which part, how much, how much is outside, and where it is set', () => {
    expect(headline(focus)).toBe(
      'Only “The design” is shown: 1 of 4 files, 3 of 12 pages. 3 files and 9 pages are outside it. '
        + 'Parts are picked in the host’s bar.',
    )
    expect(notesOf(focus)).toEqual([])
  })

  test('a file is compared by the protocol, so an absolute path of THIS paper is in focus and another epic’s is not', () => {
    const picked = parts('the-design')
    expect(inFocus(picked, paper, `/p/.kehikot/paper/${EPIC}/chapters/design.tex`)).toBe(true)
    expect(inFocus(picked, paper, '/p/.kehikot/paper/another-epic/chapters/design.tex')).toBe(false)
  })
})

describe('several parts picked', () => {
  test('the union of their files and of their pages, each page once', () => {
    const focus = narrowed(parts('the-design', 'the-method'), paper, pdf)!
    expect(focus.files).toEqual(['chapters/design.tex', 'chapters/method.tex'])
    expect(focus.pages).toEqual([2, 3, 4, 5])
    expect(headline(focus)).toBe(
      'Only 2 parts (“The design”, “The method”) are shown: 2 of 4 files, 4 of 12 pages. 2 files and 8 pages are '
        + 'outside them. Parts are picked in the host’s bar.',
    )
  })

  test('a file two picked parts both own is one file', () => {
    const both = [part('a', 'A', true, ['chapters/design.tex']), part('b', 'B', true, ['chapters/design.tex', 'chapters/method.tex'])]
    const focus = narrowed(both, paper, pdf)!
    expect(focus.files).toEqual(['chapters/design.tex', 'chapters/method.tex'])
    expect(focus.pages).toEqual([2, 3, 4, 5])
  })

  test('singular where it is one', () => {
    const three = narrowed(parts('the-design', 'the-method', 'the-results'), paper, pdf)!
    expect(headline(three)).toContain('3 of 4 files, 10 of 12 pages. 1 file and 2 pages are outside them.')
  })
})

describe('before anything has compiled', () => {
  test('the files are narrowed and no page is claimed', () => {
    const focus = narrowed(parts('the-design'), paper, null)!
    expect(focus.files).toEqual(['chapters/design.tex'])
    expect(focus.pages).toBeNull()
    expect(focus.unprinted).toEqual([])
    expect(headline(focus)).toBe(
      'Only “The design” is shown: 1 of 4 files. Nothing has compiled, so there are no pages to count. 3 files are '
        + 'outside it. Parts are picked in the host’s bar.',
    )
  })

  test('a build that could not count its pages says how many are shown and not out of how many', () => {
    const focus = narrowed(parts('the-design'), paper, { pages: null, map })!
    expect(headline(focus)).toBe(
      'Only “The design” is shown: 1 of 4 files, 3 pages. 3 files are outside it. Parts are picked in the host’s bar.',
    )
  })
})

describe('the ways a focus could leave the paper short without saying', () => {
  test('a picked part that names a file the paper does not include is said, by part and by name', () => {
    const typo = [part('the-design', 'The design', true, ['chapters/design.tex', 'chapters/desing.tex'])]
    const focus = narrowed(typo, paper, pdf)!
    expect(focus.files).toEqual(['chapters/design.tex'])
    expect(focus.missing).toEqual([{ file: 'chapters/desing.tex', parts: ['The design'] }])
    expect(notesOf(focus)).toEqual([
      '“The design” names chapters/desing.tex, which this paper does not include: nothing in main.tex pulls in a file '
        + 'of that name. Correct the name in Journeys, or \\input the file.',
    ])
    /* A part that is NOT picked and names a missing file is nobody's problem now. */
    expect(narrowed([...typo.map((one) => ({ ...one, picked: false })), part('b', 'B', true, ['chapters/method.tex'])], paper, pdf)!.missing).toEqual([])
  })

  test('a file in the focus that the build recorded nothing for: its source is shown, and it is said to have printed no pages', () => {
    const macros = { ...paper, files: [...paper.files, 'chapters/macros.tex'] }
    const picked = [part('the-design', 'The design', true, ['chapters/design.tex', 'chapters/macros.tex'])]
    const focus = narrowed(picked, macros, pdf)!
    expect(focus.files).toEqual(['chapters/design.tex', 'chapters/macros.tex'])
    expect(focus.unprinted).toEqual(['chapters/macros.tex'])
    expect(focus.pages).toEqual([2, 3, 4])
    expect(notesOf(focus)).toEqual(['chapters/macros.tex is in the focus and printed no pages in this PDF. Its source is shown.'])
  })

  test('picked parts that own no file at all do not blank the paper in silence', () => {
    const focus = narrowed(parts('the-steps'), paper, pdf)!
    expect(focus.ownsNone).toBe(true)
    expect(focus.files).toEqual([])
    expect(focus.pages).toEqual([])
    expect(focus.outsideFiles).toBe(4)
    expect(headline(focus)).toBe(
      'The focus is on “Steps only”, and that part owns no files of this paper, so none of the paper is in it: all 4 '
        + 'files and 12 pages are outside the focus. Give the part its files in Journeys — open the journey’s parts, '
        + 'press “files” on the part, and name each from the paper’s folder, like chapters/design.tex. Parts are picked '
        + 'in the host’s bar.',
    )
  })

  test('a part with files beside one with none is not "owns none"', () => {
    const focus = narrowed(parts('the-steps', 'the-design'), paper, pdf)!
    expect(focus.ownsNone).toBe(false)
    expect(focus.files).toEqual(['chapters/design.tex'])
  })

  test('a file the engine opened and this module’s own walk missed still has its pages', () => {
    /* An `\input` in the middle of a paragraph: in the page map, not in `files`. */
    const inline = { pages: 12, map: { ...map, 'chapters/aside.tex': [{ page: 9, from: 1, to: 9 }] } }
    const focus = narrowed([part('aside', 'An aside', true, ['chapters/aside.tex'])], paper, inline)!
    expect(focus.pages).toEqual([9])
    /* And it is still said that the file list does not hold it. */
    expect(focus.missing).toEqual([{ file: 'chapters/aside.tex', parts: ['An aside'] }])
  })
})

describe('the pages the PDF pane draws', () => {
  const focus = narrowed(parts('the-design'), paper, pdf)!

  test('a page something is marked on is drawn although it is outside, and flagged', () => {
    expect(pagesShown(focus, [])).toEqual({ pages: [2, 3, 4], outside: [] })
    /* A note on page 9, and the person's own selection on page 3. */
    expect(pagesShown(focus, [9, 3, 9])).toEqual({ pages: [2, 3, 4, 9], outside: [9] })
  })

  test('the runs left out are said where they would have been, the last one included', () => {
    const gaps = gapsBetween([2, 3, 4, 9], 12)
    expect([...gaps]).toEqual([
      [2, { from: 1, to: 1 }],
      [9, { from: 5, to: 8 }],
      [13, { from: 10, to: 12 }],
    ])
    expect(pagesSaid({ from: 1, to: 1 })).toBe('p. 1')
    expect(pagesSaid({ from: 5, to: 8 })).toBe('pp. 5–8')
  })

  test('no gap where there is none, and every page is one gap when nothing is drawn', () => {
    expect([...gapsBetween([1, 2, 3], 3)]).toEqual([])
    expect([...gapsBetween([], 20)]).toEqual([[21, { from: 1, to: 20 }]])
    /* A page count the build did not give leaves the tail unsaid, not guessed. */
    expect([...gapsBetween([2], null)]).toEqual([[2, { from: 1, to: 1 }]])
  })
})

describe('whether the parts changed', () => {
  test('is asked by value, so a host repeating itself redraws nothing', () => {
    expect(sameParts(parts('the-design'), parts('the-design'))).toBe(true)
    expect(sameParts(parts('the-design'), parts('the-method'))).toBe(false)
    expect(sameParts(parts(), [])).toBe(false)
    expect(sameParts([], [])).toBe(true)
  })
})
