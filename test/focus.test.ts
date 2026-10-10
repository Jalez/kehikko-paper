import { describe, expect, test } from 'bun:test'
import { anchorInFocus, partsSchema, type EpicPart } from 'kehikot-module-protocol'

import type { PageSpan } from '../compile/synctex.ts'
import { fileAfterTicks, filesShown, gapsBetween, headline, narrowed, notesOf, pagesSaid, pagesShown, tabsOf, ticksOf } from '../src/focus.ts'
import { jumpsOf, type SectionAt } from '../src/lib/sections.ts'

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
    for (const file of paper.files) expect(anchorInFocus(parts(), { file: file }, paper.epic)).toBe(true)
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
    expect(anchorInFocus(parts('the-design'), { file: 'main.tex' }, paper.epic)).toBe(false)
    expect(anchorInFocus(parts('the-design'), { file: 'chapters/design.tex' }, paper.epic)).toBe(true)
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
    expect(anchorInFocus(picked, { file: `/p/.kehikot/paper/${EPIC}/chapters/design.tex` }, paper.epic)).toBe(true)
    expect(anchorInFocus(picked, { file: '/p/.kehikot/paper/another-epic/chapters/design.tex' }, paper.epic)).toBe(false)
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
        + 'files and 12 pages are outside the focus. Give the part its files in Journeys — open the journey’s parts '
        + 'and press “files” on the part to tick them, or “make a part for each chapter file” to have one made for '
        + 'every file main.tex pulls in. Parts are picked in the host’s bar.',
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

describe('the editor follows the ticks', () => {
  const on = (...picked: string[]) => narrowed(parts(...picked), paper, pdf)

  test('nothing ticked rests on main.tex', () => {
    expect(fileAfterTicks(null, 'chapters/design.tex', false)).toBe('main.tex')
    /* Already there: nothing to do. */
    expect(fileAfterTicks(null, 'main.tex', false)).toBeNull()
  })

  test('one part ticked opens that part’s file', () => {
    expect(fileAfterTicks(on('the-design'), 'main.tex', false)).toBe('chapters/design.tex')
    expect(fileAfterTicks(on('the-method'), 'chapters/design.tex', false)).toBe('chapters/method.tex')
  })

  test('several ticked open the first of their files, in the paper’s order', () => {
    expect(fileAfterTicks(on('the-method', 'the-design'), 'main.tex', false)).toBe('chapters/design.tex')
  })

  test('a file that is in the new focus is left open', () => {
    expect(fileAfterTicks(on('the-design', 'the-method'), 'chapters/method.tex', false)).toBeNull()
  })

  test('nothing moves out from under unsaved text, whatever was ticked', () => {
    expect(fileAfterTicks(on('the-design'), 'main.tex', true)).toBeNull()
    expect(fileAfterTicks(null, 'chapters/design.tex', true)).toBeNull()
  })

  test('a focus that owns no file has nowhere to go to', () => {
    expect(fileAfterTicks(on('the-steps'), 'main.tex', false)).toBeNull()
  })

  test('what is followed is the ticks, and not the paper’s own list of files', () => {
    expect(ticksOf(parts())).toBe('')
    expect(ticksOf(parts('the-design'))).not.toBe(ticksOf(parts('the-method')))
    expect(ticksOf(parts('the-design'))).toBe(ticksOf(parts('the-design')))
    /* A part given another file is a different focus; a heading reworded is not. */
    const more = parts('the-design').map((one) => (one.id === 'the-design' ? { ...one, files: [...(one.files ?? []), 'chapters/more.tex'] } : one))
    expect(ticksOf(more)).not.toBe(ticksOf(parts('the-design')))
    const reworded = parts('the-design').map((one) => (one.id === 'the-design' ? { ...one, heading: 'Design, reworded' } : one))
    expect(ticksOf(reworded)).toBe(ticksOf(parts('the-design')))
  })
})

describe('the files to switch among', () => {
  const on = (...picked: string[]) => narrowed(parts(...picked), paper, pdf)

  test('none when nothing is picked: the whole paper is not a row of its files', () => {
    expect(tabsOf(null, 'main.tex')).toEqual([])
    expect(tabsOf(null, 'chapters/design.tex')).toEqual([])
  })

  test('exactly the picked parts’ files, by their own names', () => {
    expect(tabsOf(on('the-design', 'the-method'), 'chapters/design.tex')).toEqual([
      { file: 'chapters/design.tex', label: 'design.tex', outside: false },
      { file: 'chapters/method.tex', label: 'method.tex', outside: false },
    ])
    /* One file: a list of one, which the page draws no tabs for. */
    expect(tabsOf(on('the-design'), 'chapters/design.tex')).toHaveLength(1)
  })

  test('and the open file when it is outside them — last, and marked', () => {
    expect(tabsOf(on('the-design'), 'main.tex')).toEqual([
      { file: 'chapters/design.tex', label: 'design.tex', outside: false },
      { file: 'main.tex', label: 'main.tex', outside: true },
    ])
  })

  test('two files of one name are told apart by their folders', () => {
    const twice = { epic: EPIC, files: ['main.tex', 'a/intro.tex', 'b/intro.tex'] }
    const both: EpicPart[] = [{ id: 'both', heading: 'Both', refs: [], picked: true, files: ['a/intro.tex', 'b/intro.tex'] }]
    expect(tabsOf(narrowed(both, twice, null), 'a/intro.tex').map((one) => one.label)).toEqual(['a/intro.tex', 'b/intro.tex'])
  })
})

describe('the files this page says it is showing', () => {
  const focusOn = (...picked: string[]) => narrowed(parts(...picked), paper, pdf)

  test('nothing ticked is every file of the paper, main.tex first', () => {
    expect(filesShown(null, paper.files, 'main.tex', 16)).toEqual(paper.files)
    /* Whichever file a press on the PDF took the editor into. */
    expect(filesShown(null, paper.files, 'chapters/results.tex', 16)).toEqual(paper.files)
  })

  test('ticked parts are their files, in the paper’s order and once each', () => {
    expect(filesShown(focusOn('the-method'), paper.files, 'chapters/method.tex', 16)).toEqual(['chapters/method.tex'])
    expect(filesShown(focusOn('the-results', 'the-design'), paper.files, 'chapters/results.tex', 16)).toEqual([
      'chapters/design.tex',
      'chapters/results.tex',
    ])
    /* Two parts naming one file say it once, and a file the paper does not include is not said. */
    const twice = [
      part('a', 'A', true, ['chapters/design.tex', 'chapters/not-there.tex']),
      part('b', 'B', true, ['chapters/design.tex']),
    ]
    expect(filesShown(narrowed(twice, paper, pdf), paper.files, 'chapters/design.tex', 16)).toEqual(['chapters/design.tex'])
  })

  test('a file kept open outside the ticked parts is said too, in its place', () => {
    expect(filesShown(focusOn('the-method'), paper.files, 'main.tex', 16)).toEqual(['main.tex', 'chapters/method.tex'])
  })

  test('ticked parts that own no file of the paper show nothing, whatever is left open', () => {
    expect(filesShown(focusOn('the-steps'), paper.files, 'main.tex', 16)).toEqual([])
  })

  test('more files than the wire carries: as many as fit, and the open one among them', () => {
    const many = ['main.tex', ...Array.from({ length: 20 }, (_, i) => `chapters/${i + 1}.tex`)]
    expect(filesShown(null, many, 'main.tex', 16)).toEqual(many.slice(0, 16))
    const far = filesShown(null, many, 'chapters/19.tex', 16)
    expect(far).toHaveLength(16)
    expect(far).toEqual(['chapters/19.tex', ...many.slice(0, 15)])
  })
})

describe('the section list, file by file', () => {
  const at = (file: string, title: string, level = 1): SectionAt => ({ file, title, level, at: 0, end: 0, from: 0, to: 0 })
  const sections = [at('main.tex', 'Abstract'), at('chapters/design.tex', 'Design'), at('chapters/design.tex', 'Seams', 2), at('chapters/method.tex', 'Method')]

  test('groups every file shown, in the paper’s order, each section keeping its place in the whole list', () => {
    expect(jumpsOf(['main.tex', 'chapters/design.tex', 'chapters/method.tex'], sections).map((one) => [one.file, one.sections.map((s) => s.index)])).toEqual([
      ['main.tex', [0]],
      ['chapters/design.tex', [1, 2]],
      ['chapters/method.tex', [3]],
    ])
  })

  test('a file with no heading still has its group, so it is not unreachable', () => {
    const out = jumpsOf(['main.tex', 'annotations.tex', 'chapters/design.tex'], sections)
    expect(out[1]).toEqual({ file: 'annotations.tex', sections: [] })
  })

  test('is limited to the files it is given: under a focus, the picked parts’ own', () => {
    expect(jumpsOf(['chapters/method.tex'], sections)).toEqual([{ file: 'chapters/method.tex', sections: [{ index: 3, section: sections[3]! }] }])
  })
})
