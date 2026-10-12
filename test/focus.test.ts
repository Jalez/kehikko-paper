import { describe, expect, test } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { anchorInFocus, emptySaid, partsSchema, type EpicPart } from 'kehikot-module-protocol'
import { useFocus } from 'kehikot-module-protocol/client/react'

import type { PageSpan } from '../compile/synctex.ts'
import { anchorOf, fileAfterTicks, filesShown, heldBy, inPaper, inProject, narrowed, noPage, pagesDrawn, tabsOf, ticksOf, type NarrowablePaper, type NarrowablePdf } from '../src/focus.ts'
import { jumpsOf, type SectionAt } from '../src/lib/sections.ts'

/**
 * The paper narrowed to the picked parts of the epic: which files, which
 * pages, and the one sentence the page says about it.
 *
 * The rule itself is the protocol's and is tested there. What is held here is
 * what this module gives it — one anchor function — and what it makes of the
 * answer: that nothing picked changes nothing, that a page two files share is
 * shown when either is picked, that the numbers are the PDF's own, that the
 * file in hand is kept, and that it is the same against a host that sends a
 * part's `documents` and one that still sends only its `files`.
 */

const EPIC = 'a-paper'
const PROJECT = '/tmp/project'
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

/**
 * The two hosts a page meets. `old` is one before a part had documents: it
 * sends the paper-relative `files` and nothing else. `new` unions what the
 * modules publish and sends `documents`, project-relative, and goes on
 * filling `files` beside them.
 */
type Host = 'old' | 'new'
let host: Host = 'new'

const part = (id: string, heading: string, picked: boolean, files?: string[]): EpicPart => ({
  id,
  heading,
  refs: [],
  picked,
  ...(files ? (host === 'old' ? { files } : { files, documents: files.map((file) => inProject(EPIC, file)) }) : {}),
})
const parts = (...picked: string[]): EpicPart[] => [
  part('the-design', 'The design', picked.includes('the-design'), ['chapters/design.tex']),
  part('the-method', 'The method', picked.includes('the-method'), ['chapters/method.tex']),
  part('the-results', 'The results', picked.includes('the-results'), ['chapters/results.tex']),
  part('the-steps', 'Steps only', picked.includes('the-steps')),
]

/** The focus as the page holds it: `useFocus` over what the context said. */
const focusOf = (said: readonly EpicPart[]) => renderHook(() => useFocus({ parts: said, epic: EPIC, projectPath: PROJECT })).result.current
const narrow = (said: readonly EpicPart[], of: NarrowablePaper = paper, built: NarrowablePdf | null = pdf, open: string | null = null) => narrowed(focusOf(said), of, built, open)

describe('what ties a file to a part', () => {
  test('a file is anchored by its own name, from the project', () => {
    expect(inProject(EPIC, 'chapters/design.tex')).toBe('.kehikot/paper/a-paper/chapters/design.tex')
    expect(anchorOf(paper, 'chapters/design.tex')).toEqual([{ file: '.kehikot/paper/a-paper/chapters/design.tex' }])
    /* And back, for a document a part lists; one under another epic's paper, or anywhere else, is not this paper's. */
    expect(inPaper(EPIC, '.kehikot/paper/a-paper/chapters/design.tex')).toBe('chapters/design.tex')
    expect(inPaper(EPIC, '.kehikot/paper/another/chapters/design.tex')).toBeNull()
    expect(inPaper(EPIC, 'src/chapters/design.tex')).toBeNull()
  })

  test('main.tex is a file like the others: its own name, and not “the whole paper”', () => {
    expect(anchorOf(paper, 'main.tex')).toEqual([{ file: '.kehikot/paper/a-paper/main.tex' }])
    /* So it is in a part only when a part lists it. */
    expect(anchorInFocus(parts('the-design'), anchorOf(paper, 'main.tex'), EPIC, PROJECT)).toBe(false)
    const listed = [part('front', 'Front matter', true, ['main.tex'])]
    expect(anchorInFocus(listed, anchorOf(paper, 'main.tex'), EPIC, PROJECT)).toBe(true)
  })

  test('a file a chapter pulls in is about that chapter too, at any depth — and never about main.tex', () => {
    const pulled = {
      epic: EPIC,
      pulls: {
        'chapters/design.tex': { by: 'main.tex' },
        'tables/a.tex': { by: 'chapters/design.tex' },
        'tables/a-rows.tex': { by: 'tables/a.tex' },
      },
    }
    expect(anchorOf(pulled, 'chapters/design.tex')).toEqual([{ file: inProject(EPIC, 'chapters/design.tex') }])
    expect(anchorOf(pulled, 'tables/a-rows.tex')).toEqual([
      { file: inProject(EPIC, 'tables/a-rows.tex') },
      { file: inProject(EPIC, 'tables/a.tex') },
      { file: inProject(EPIC, 'chapters/design.tex') },
    ])
    /* Two files that pull each other in are read to a bound, not forever. */
    const loop = { epic: EPIC, pulls: { 'a.tex': { by: 'b.tex' }, 'b.tex': { by: 'a.tex' } } }
    expect(anchorOf(loop, 'a.tex').length).toBeLessThan(20)
  })

  test('so a chapter’s tables come with it, though the part lists only the chapter', () => {
    const tabled = {
      epic: EPIC,
      files: ['main.tex', 'chapters/design.tex', 'tables/a.tex', 'chapters/method.tex'],
      pulls: { 'chapters/design.tex': { by: 'main.tex' }, 'tables/a.tex': { by: 'chapters/design.tex' }, 'chapters/method.tex': { by: 'main.tex' } },
    }
    expect(narrow(parts('the-design'), tabled)!.files).toEqual(['chapters/design.tex', 'tables/a.tex'])
    expect(narrow(parts('the-method'), tabled)!.files).toEqual(['chapters/method.tex'])
  })
})

for (const generation of ['new', 'old'] as const) {
  describe(`against a host that sends ${generation === 'new' ? 'a part’s documents' : 'only a part’s files'}`, () => {
    /* `host` is read when a part is MADE, so every fixture below is made inside a test. */
    const under = (name: string, body: () => void) =>
      test(name, () => {
        host = generation
        try {
          body()
        } finally {
          host = 'new'
        }
      })

    under('the fixtures are parts a host could send', () => {
      expect(partsSchema.safeParse(parts('the-design')).success).toBe(true)
      expect(parts()[0]!.documents === undefined).toBe(generation === 'old')
    })

    under('nothing picked is the whole paper: no narrowing at all', () => {
      expect(narrow(parts())).toBeNull()
      expect(narrow([])).toBeNull()
    })

    under('one part picked: only its files, and the pages they printed on — the shared sheet included', () => {
      const focus = narrow(parts('the-design'))!
      expect(focus.one).toBe(true)
      expect(focus.files).toEqual(['chapters/design.tex'])
      expect(focus.shown).toEqual(['chapters/design.tex'])
      /* Page 4 holds the end of the design and the start of the method. */
      expect(focus.pages).toEqual([2, 3, 4])
    })

    under('several picked: the union of their files and of their pages, each once', () => {
      const focus = narrow(parts('the-design', 'the-method'))!
      expect(focus.one).toBe(false)
      expect(focus.files).toEqual(['chapters/design.tex', 'chapters/method.tex'])
      expect(focus.pages).toEqual([2, 3, 4, 5])
      const both = [part('a', 'A', true, ['chapters/design.tex']), part('b', 'B', true, ['chapters/design.tex', 'chapters/method.tex'])]
      expect(narrow(both)!.files).toEqual(['chapters/design.tex', 'chapters/method.tex'])
    })

    under('the file in hand is kept: shown, though no picked part has it, and not counted as the pick’s', () => {
      const focus = narrow(parts('the-design'), paper, pdf, 'main.tex')!
      expect(focus.files).toEqual(['chapters/design.tex'])
      expect(focus.shown).toEqual(['main.tex', 'chapters/design.tex'])
      /* Its pages are not the pick’s either. */
      expect(focus.pages).toEqual([2, 3, 4])
      /* A file in hand that the pick has anyway is simply one of its files. */
      const inside = narrow(parts('the-design'), paper, pdf, 'chapters/design.tex')!
      expect(inside.files).toEqual(['chapters/design.tex'])
      expect(inside.shown).toEqual(['chapters/design.tex'])
    })

    under('a part with no chapter: nothing of the paper is in it, and the one sentence is the protocol’s', () => {
      const focus = narrow(parts('the-steps'))!
      expect(focus.files).toEqual([])
      expect(focus.pages).toEqual([])
      expect(noPage(focus)).toBe('No page is in the picked part.')
      expect(noPage(focus)).toBe(emptySaid(parts('the-steps'), 'page'))
      expect(noPage(narrow([part('a', 'A', true, []), part('b', 'B', true, [])])!)).toBe('No page is in the picked parts.')
    })

    under('a picked part naming only a file the paper does not include: the sentence names it', () => {
      const typo = [part('the-design', 'The design', true, ['chapters/design.tex', 'chapters/desing.tex'])]
      const focus = narrow(typo)!
      expect(focus.files).toEqual(['chapters/design.tex'])
      expect(focus.missing).toEqual(['chapters/desing.tex'])
      const only = narrow([part('the-design', 'The design', true, ['chapters/desing.tex'])])!
      expect(only.pages).toEqual([])
      expect(noPage(only)).toBe('No page of this paper is in the picked part: it names chapters/desing.tex, which main.tex does not include.')
      /* A part that is NOT picked and names a missing file is nobody's problem now. */
      expect(narrow([...typo.map((one) => ({ ...one, picked: false })), part('b', 'B', true, ['chapters/method.tex'])])!.missing).toEqual([])
    })

    under('a file in the focus that the build recorded nothing for: its source is shown, and the pane says so only if no page is left', () => {
      const macros = { ...paper, files: [...paper.files, 'chapters/macros.tex'] }
      const focus = narrow([part('the-design', 'The design', true, ['chapters/design.tex', 'chapters/macros.tex'])], macros)!
      expect(focus.files).toEqual(['chapters/design.tex', 'chapters/macros.tex'])
      expect(focus.pages).toEqual([2, 3, 4])
      const alone = narrow([part('m', 'Macros', true, ['chapters/macros.tex'])], macros)!
      expect(alone.pages).toEqual([])
      expect(noPage(alone)).toBe('No page is in the picked part.')
    })

    under('a file the engine opened and this module’s own walk missed still has its pages', () => {
      /* An `\input` in the middle of a paragraph: in the page map, not in `files`. */
      const inline = { pages: 12, map: { ...map, 'chapters/aside.tex': [{ page: 9, from: 1, to: 9 }] } }
      const focus = narrow([part('aside', 'An aside', true, ['chapters/aside.tex'])], paper, inline)!
      expect(focus.pages).toEqual([9])
      expect(focus.missing).toEqual(['chapters/aside.tex'])
    })

    under('the pages the pane draws: the pick’s, and any a mark is on — which is in hand, and kept', () => {
      const focus = focusOf(parts('the-design'))
      expect(pagesDrawn(focus, paper, map).pages).toEqual([2, 3, 4])
      /* A note on page 9, and the person's own selection on page 3. */
      expect(pagesDrawn(focus, paper, map, [9, 3, 9]).pages).toEqual([2, 3, 4, 9])
      /* A sheet nothing of the paper printed on can still carry a mark. */
      expect(pagesDrawn(focus, paper, map, [40]).pages).toEqual([2, 3, 4, 40])
      /* Nothing picked is every sheet the map has. */
      expect(pagesDrawn(focusOf(parts()), paper, map).pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    })

    under('and the sentence for a pane left with none is `narrow`’s own `empty`', () => {
      expect(pagesDrawn(focusOf(parts('the-steps')), paper, map)).toEqual({ pages: [], empty: 'No page is in the picked part.' })
      /* With a page drawn there is nothing to say, and with no map at all it is still the one sentence. */
      expect(pagesDrawn(focusOf(parts('the-steps')), paper, {}).empty).toBe('No page is in the picked part.')
    })

    under('the files some part has, picked or not', () => {
      expect(heldBy(parts(), paper, PROJECT)).toEqual(['chapters/design.tex', 'chapters/method.tex', 'chapters/results.tex'])
    })
  })
}

describe('a part’s own PDF: the sheets its files printed, and not what main.tex writes around them', () => {
  /* The method chapter compiled alone: `main.tex` on sheets 1–5 and 8, the chapter on 6 and 7. */
  const own: Record<string, PageSpan[]> = {
    'main.tex': [1, 2, 3, 4, 5, 8].map((page) => ({ page, from: 1, to: 7 })),
    'chapters/method.tex': [{ page: 6, from: 1, to: 2 }, { page: 7, from: 3, to: 3 }],
  }

  test('the title pages and the bibliography are main.tex’s, which is in no part: they are not drawn', () => {
    expect(pagesDrawn(focusOf(parts('the-method')), paper, own).pages).toEqual([6, 7])
  })

  test('a part that does list main.tex has them', () => {
    const front = [part('front', 'Front matter', true, ['main.tex'])]
    expect(pagesDrawn(focusOf(front), paper, own).pages).toEqual([1, 2, 3, 4, 5, 8])
  })
})

describe('before anything has compiled', () => {
  test('the files are narrowed and no page is claimed', () => {
    const focus = narrow(parts('the-design'), paper, null)!
    expect(focus.files).toEqual(['chapters/design.tex'])
    expect(focus.pages).toBeNull()
  })
})

describe('the editor follows the ticks', () => {
  const on = (...picked: string[]) => narrow(parts(...picked))

  test('nothing ticked rests on main.tex', () => {
    expect(fileAfterTicks(null, 'chapters/design.tex', false)).toBe('main.tex')
    /* Already there: nothing to do. */
    expect(fileAfterTicks(null, 'main.tex', false)).toBeNull()
  })

  test('one part ticked opens that part’s file', () => {
    expect(fileAfterTicks(on('the-design'), 'main.tex', false)).toBe('chapters/design.tex')
    expect(fileAfterTicks(on('the-method'), 'chapters/design.tex', false)).toBe('chapters/method.tex')
  })

  test('and does so although main.tex was the file in hand: being kept is not being in the part', () => {
    expect(fileAfterTicks(narrow(parts('the-design'), paper, pdf, 'main.tex'), 'main.tex', false)).toBe('chapters/design.tex')
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

  test('a focus that has no file has nowhere to go to', () => {
    expect(fileAfterTicks(on('the-steps'), 'main.tex', false)).toBeNull()
  })

  test('what is followed is the ticks, and not the paper’s own list of files', () => {
    expect(ticksOf(parts())).toBe('')
    expect(ticksOf(parts('the-design'))).not.toBe(ticksOf(parts('the-method')))
    expect(ticksOf(parts('the-design'))).toBe(ticksOf(parts('the-design')))
    /* A part given another document is a different focus; a heading reworded is not. */
    const more = parts('the-design').map((one) => (one.id === 'the-design' ? { ...one, documents: [...(one.documents ?? []), inProject(EPIC, 'chapters/more.tex')] } : one))
    expect(ticksOf(more)).not.toBe(ticksOf(parts('the-design')))
    const reworded = parts('the-design').map((one) => (one.id === 'the-design' ? { ...one, heading: 'Design, reworded' } : one))
    expect(ticksOf(reworded)).toBe(ticksOf(parts('the-design')))
  })
})

describe('the files to switch among', () => {
  const on = (...picked: string[]) => narrow(parts(...picked))

  test('none when nothing is picked: the whole paper is not a row of its files', () => {
    expect(tabsOf(null, 'main.tex')).toEqual([])
    expect(tabsOf(null, 'chapters/design.tex')).toEqual([])
  })

  test('exactly the picked parts’ files, by their own names', () => {
    expect(tabsOf(on('the-design', 'the-method'), 'chapters/design.tex')).toEqual([
      { file: 'chapters/design.tex', label: 'design.tex' },
      { file: 'chapters/method.tex', label: 'method.tex' },
    ])
    /* One file: a list of one, which the page draws no tabs for. */
    expect(tabsOf(on('the-design'), 'chapters/design.tex')).toHaveLength(1)
  })

  test('and the open file when it is not one of them — last, and with nothing saying so', () => {
    expect(tabsOf(narrow(parts('the-design'), paper, pdf, 'main.tex'), 'main.tex')).toEqual([
      { file: 'chapters/design.tex', label: 'design.tex' },
      { file: 'main.tex', label: 'main.tex' },
    ])
  })

  test('a chapter is a tab and the tables it pulls in are not — until a person is in one', () => {
    const tabled = {
      epic: EPIC,
      files: ['main.tex', 'chapters/design.tex', 'tables/a.tex', 'chapters/method.tex'],
      pulls: {
        'chapters/design.tex': { by: 'main.tex', with: 'include', as: 'chapters/design' },
        'tables/a.tex': { by: 'chapters/design.tex', with: 'input', as: 'tables/a' },
        'chapters/method.tex': { by: 'main.tex', with: 'include', as: 'chapters/method' },
      },
    }
    const focus = narrow(parts('the-design'), tabled)
    expect(tabsOf(focus, 'chapters/design.tex', tabled).map((one) => one.file)).toEqual(['chapters/design.tex'])
    expect(tabsOf(focus, 'tables/a.tex', tabled).map((one) => one.file)).toEqual(['chapters/design.tex', 'tables/a.tex'])
  })

  test('two files of one name are told apart by their folders', () => {
    const twice = { epic: EPIC, files: ['main.tex', 'a/intro.tex', 'b/intro.tex'] }
    const both: EpicPart[] = [part('both', 'Both', true, ['a/intro.tex', 'b/intro.tex'])]
    expect(tabsOf(narrow(both, twice, null), 'a/intro.tex').map((one) => one.label)).toEqual(['a/intro.tex', 'b/intro.tex'])
  })
})

describe('the files this page says it is showing', () => {
  const focusOn = (open: string, ...picked: string[]) => narrow(parts(...picked), paper, pdf, open)

  test('nothing ticked is every file of the paper, the one the editor is on first', () => {
    expect(filesShown(null, paper.files, 'main.tex', 16)).toEqual(paper.files)
    /* Whichever file a press on the PDF took the editor into leads, and the rest keep the paper's order. */
    const on = filesShown(null, paper.files, 'chapters/results.tex', 16)
    expect(on).toEqual(['chapters/results.tex', ...paper.files.filter((one) => one !== 'chapters/results.tex')])
    expect([...on].sort()).toEqual([...paper.files].sort())
  })

  test('ticked parts are their files, in the paper’s order and once each', () => {
    expect(filesShown(focusOn('chapters/method.tex', 'the-method'), paper.files, 'chapters/method.tex', 16)).toEqual(['chapters/method.tex'])
    expect(filesShown(focusOn('chapters/design.tex', 'the-results', 'the-design'), paper.files, 'chapters/design.tex', 16)).toEqual([
      'chapters/design.tex',
      'chapters/results.tex',
    ])
    /* The open one of the two leads. */
    expect(filesShown(focusOn('chapters/results.tex', 'the-results', 'the-design'), paper.files, 'chapters/results.tex', 16)).toEqual([
      'chapters/results.tex',
      'chapters/design.tex',
    ])
    /* Two parts naming one file say it once, and a file the paper does not include is not said. */
    const twice = [
      part('a', 'A', true, ['chapters/design.tex', 'chapters/not-there.tex']),
      part('b', 'B', true, ['chapters/design.tex']),
    ]
    expect(filesShown(narrow(twice, paper, pdf, 'chapters/design.tex'), paper.files, 'chapters/design.tex', 16)).toEqual(['chapters/design.tex'])
  })

  test('the file in hand is said too, first', () => {
    expect(filesShown(focusOn('main.tex', 'the-method'), paper.files, 'main.tex', 16)).toEqual(['main.tex', 'chapters/method.tex'])
  })

  test('ticked parts that have no file of the paper show nothing, whatever is left open', () => {
    expect(filesShown(focusOn('main.tex', 'the-steps'), paper.files, 'main.tex', 16)).toEqual([])
  })

  test('more files than the wire carries: as many as fit, and the open one among them', () => {
    const many = ['main.tex', ...Array.from({ length: 20 }, (_, i) => `chapters/${i + 1}.tex`)]
    expect(filesShown(null, many, 'main.tex', 16)).toEqual(many.slice(0, 16))
    const far = filesShown(null, many, 'chapters/19.tex', 16)
    expect(far).toHaveLength(16)
    expect(far).toEqual(['chapters/19.tex', ...many.slice(0, 15)])
  })

  test('and of those, the files a part of the epic has are said before the ones none does', () => {
    /* A thesis: main, six chapters with three generated tables listed among them, an appendix, then eight more. */
    const thesis = [
      'main.tex', 'chapters/1.tex', 'chapters/2.tex', 'chapters/3.tex', 'chapters/4.tex', 'generated/a.tex', 'generated/b.tex', 'generated/c.tex',
      'chapters/5.tex', 'chapters/6.tex', 'chapters/appendix.tex', 'generated/d.tex', 'generated/e.tex',
      ...Array.from({ length: 8 }, (_, i) => `chapters/x${i + 1}.tex`),
    ]
    const owned = ['chapters/1.tex', 'chapters/2.tex', 'chapters/3.tex', 'chapters/4.tex', 'chapters/5.tex', 'chapters/6.tex', 'chapters/appendix.tex', 'chapters/x8.tex', 'not/in/the/paper.tex']
    expect(thesis).toHaveLength(21)
    /* In the paper's order alone the twenty-first file is cut, and it is a part's. */
    expect(filesShown(null, thesis, 'main.tex', 16)).not.toContain('chapters/x8.tex')
    const said = filesShown(null, thesis, 'main.tex', 16, owned)
    expect(said).toHaveLength(16)
    /* The open file, then the parts' files in the paper's order… */
    expect(said.slice(0, 9)).toEqual(['main.tex', 'chapters/1.tex', 'chapters/2.tex', 'chapters/3.tex', 'chapters/4.tex', 'chapters/5.tex', 'chapters/6.tex', 'chapters/appendix.tex', 'chapters/x8.tex'])
    /* …and the rest fill the room, in the paper's order. */
    expect(said.slice(9)).toEqual(['generated/a.tex', 'generated/b.tex', 'generated/c.tex', 'generated/d.tex', 'generated/e.tex', 'chapters/x1.tex', 'chapters/x2.tex'])
    /* An open file the cut would drop goes first, and costs the last of the others its place. */
    const far = filesShown(null, thesis, 'chapters/x5.tex', 16, owned)
    expect(far[0]).toBe('chapters/x5.tex')
    expect(far).toHaveLength(16)
    expect(far).toContain('chapters/x8.tex')
    expect(far).toContain('main.tex')
    expect(far).not.toContain('chapters/x2.tex')
    /* A paper that fits is said whole and in its own order, whoever has what. */
    expect(filesShown(null, thesis.slice(0, 16), 'main.tex', 16, owned)).toEqual(thesis.slice(0, 16))
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
