import { describe, expect, test } from 'bun:test'
import { fireEvent, render } from '@testing-library/react'

import { parseLatex } from '../latex/parse.ts'
import type { Proposal } from '../latex/propose.ts'
import type { Paper, PlacedBlock } from '../store.ts'
import { PaginatedView } from '../src/reader/paginated.tsx'

/**
 * A suggested change, drawn into the paper, as far as a document without layout
 * can see it.
 *
 * ## What this can prove, and what only a browser can
 *
 * happy-dom lays nothing out. It will not say whether the floating control
 * actually clears the paragraph it is about, what the counter-scale looks like
 * at 220 pixels, or whether a wrapped button group is still readable — those
 * are stated as unverified rather than pretended at, in the report and in the
 * README.
 *
 * What it proves is the part that decides whether somebody approves a change
 * they did not read:
 *
 *  - **Which characters are struck through and which are green.** Both are
 *    `<del>` and `<ins>` with `data-proposed`, so "the right words are marked"
 *    is a query rather than a claim.
 *  - **That a run under a suggestion cannot be typed into.** A
 *    `contenteditable` span containing a `<del>` and an `<ins>` has a
 *    `textContent` holding the old text and the new run together, and a
 *    correction committed out of it would splice both into the file.
 *  - **That a suggestion which cannot be placed honestly is not drawn in the
 *    prose at all**, and is still answerable, because the control is anchored
 *    to the block rather than to the run.
 *  - **That the control is offered only when the page wired one.**
 *
 * ## The fixture is hard-wrapped and has a citation in it
 *
 * For the reason `typing.test.tsx` gives at length, and it is the reason this
 * file exists in the shape it does: a fixture with every paragraph on one line
 * of source is the single document shape in which a paragraph has no collapsed
 * whitespace, so every run comes out `literal` and every mapping question is
 * trivially right. A feature shipped here once against exactly that fixture.
 */

const SOURCE = [
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim has a tpyo in it and it runs on for long enough that the',
  'author wrapped the line, the way a real paper is written, and ends.',
  '',
  'A second paragraph with \\autocite{jones} a citation in the middle of',
  'it, and a 50\\% escape, and prose after them that runs to the end.',
  '',
  '\\end{document}',
  '',
].join('\n')

const bytes = Buffer.from(SOURCE, 'utf8')

function fixture(): Paper {
  const parsed = parseLatex(SOURCE, 'main.tex')
  const blocks: PlacedBlock[] = parsed.blocks.map((b) => ({ ...b, file: 'main.tex' }))
  return {
    epic: 'proposed',
    dir: '/tmp/papers/proposed',
    title: 'A paper somebody has suggested a change to',
    author: null,
    blocks,
    figures: [],
    outline: [],
    files: ['main.tex'],
    hashes: { 'main.tex': 'not-on-disk' },
  }
}

/** A suggestion about a run of the fixture, by the text it is about. */
function about(find: string, replace: string, why = 'Because it is spelled wrong.'): Proposal {
  const from = bytes.indexOf(find)
  if (from < 0) throw new Error(`“${find}” is not in the fixture`)
  return {
    id: `p-${find}`,
    file: 'main.tex',
    from,
    to: from + Buffer.byteLength(find, 'utf8'),
    text: replace,
    was_text: find,
    was: 'not-on-disk',
    why,
    by: 'an agent',
    at: 1,
  }
}

const answering = () => {
  const answered: { id: string; decision: string }[] = []
  let all = 0
  return {
    answered,
    countAll: () => all,
    answering: {
      decide: (id: string, decision: 'accept' | 'reject') => answered.push({ id, decision }),
      acceptAll: () => {
        all += 1
      },
      busy: false,
    },
  }
}

const ref = () => ({ current: null as HTMLElement | null })

function draw(proposals: Proposal[], options: { wired?: boolean; pen?: boolean } = {}) {
  const wiring = answering()
  const rendered = render(
    <PaginatedView
      paper={fixture()}
      walk={null}
      mark={null}
      rootRef={ref()}
      proposals={proposals}
      answering={options.wired === false ? null : wiring.answering}
      onPen={() => {}}
      pen={options.pen ? { commit: async () => null, say: () => {} } : null}
      onAuto={() => {}}
    />,
  )
  return { ...wiring, ...rendered }
}

const out = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-proposed="out"]')).map((e) => e.textContent)
const arrived = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-proposed="in"]')).map((e) => e.textContent)

describe('the change is drawn where it happens', () => {
  test('what leaves is struck through and what arrives is green, at the right words', () => {
    const { container } = draw([about('tpyo', 'typo')])
    /* Twice each: once in the prose where the change happens, and once in the
       floating control — which is deliberate, because at 220 pixels the body
       type draws at under four pixels and the control's copy is the only
       readable one. See the essay in `proposed.tsx`. */
    expect(out(container)).toEqual(['tpyo', 'tpyo'])
    expect(arrived(container)).toEqual(['typo', 'typo'])
  })

  test('the rest of the paragraph is untouched around it', () => {
    const { container } = draw([about('tpyo', 'typo')])
    const paragraph = container.querySelector('[data-has-proposals="1"]')!
    /* The struck text is still in the flow — a diff shows what leaves — so the
       paragraph reads as the old and the new together, in order, exactly where
       the change is. What matters is that nothing ELSE moved. */
    expect(paragraph.textContent).toContain('The claim has a ')
    expect(paragraph.textContent).toContain(' in it and it runs on')
  })

  test('a change spanning the author’s hard wrap is drawn as one change', () => {
    /* The case a one-line-per-paragraph fixture cannot exhibit. The words
       either side of a wrap are one coalesced run whose middle piece is a gap,
       and `renderedRange` snaps over it — so the newline in the file is one
       rendered space here, and the diff has to land on that space rather than
       on the letter beside it. */
    const { container } = draw([about('that the\nauthor wrapped', 'that the author has wrapped')])
    expect(out(container).length).toBeGreaterThan(0)
    expect(container.textContent).toContain('has wrapped')
  })

  test('only the block the change is in is marked as having one', () => {
    const { container } = draw([about('tpyo', 'typo')])
    expect(container.querySelectorAll('[data-has-proposals="1"]')).toHaveLength(1)
  })
})

describe('a change this reader cannot place honestly', () => {
  /*
   * The proposal door refuses most of these before they are stored — a
   * suggestion must quote prose with no LaTeX special in it — so what is
   * constructed here is a proposal that could only arrive from a bug, a
   * replayed request, or a future relaxation of that rule. The property is that
   * the page does not draw a lie about it either way.
   */
  test('it is not drawn in the prose, and the citation is left exactly as it renders', () => {
    const { container } = draw([about('\\autocite{jones}', 'somebody else')])
    /* Nothing marked outside the floating control — which does carry it, and
       is the next test. Scoped that way rather than counting, because the whole
       distinction here is between the PROSE and the control. */
    const inProse = Array.from(container.querySelectorAll('[data-proposed]'))
      .filter((el) => el.closest('[data-proposal]') === null)
      /* Mapped to text before it is asserted on. An array of DOM ELEMENTS
         handed to `toEqual` is a deep comparison over a tree whose nodes point
         back at their parents, and it does not come back. */
      .map((el) => el.textContent)
    expect(inProse).toEqual([])
    /* `[jones]` is what this reader makes of the command, and it stays that.
       Striking those seven characters through would say they are the bytes
       leaving, and they are not. */
    expect(container.textContent).toContain('[jones]')
  })

  test('it is still answerable, because the control is anchored to the block', () => {
    const { container } = draw([about('\\autocite{jones}', 'somebody else')])
    const control = container.querySelector('[data-proposal]')
    expect(control).not.toBeNull()
    /* And the control carries the change, so the reader sees what they are
       being asked about even though the prose could not show it in place. */
    expect(control!.textContent).toContain('somebody else')
  })
})

describe('typing and a pending change do not share a run', () => {
  test('a run under a suggestion is not editable, and its neighbours still are', () => {
    const { container } = draw([about('tpyo', 'typo')], { pen: true })
    const editable = Array.from(container.querySelectorAll<HTMLElement>('[data-editable]'))
    expect(editable.length).toBeGreaterThan(0)
    const under = editable.find((el) => el.querySelector('[data-proposed="out"]'))
    expect(under).toBeDefined()
    /*
     * The failure this prevents: a `contenteditable` span holding a `<del>` and
     * an `<ins>` has a `textContent` of "tpyotypo", and a correction committed
     * out of it would narrow that against the source and splice both words into
     * the file.
     */
    expect(under!.getAttribute('data-editable')).toBe('0')
    expect(under!.getAttribute('contenteditable')).toBeNull()
    /* The second paragraph has no suggestion on it and is unaffected. */
    const elsewhere = editable.filter((el) => (el.textContent ?? '').includes('prose after them'))
    expect(elsewhere.some((el) => el.getAttribute('data-editable') === '1')).toBe(true)
  })
})

describe('the control that answers it', () => {
  test('Accept and Reject are one group, and each says which it is', () => {
    const { container } = draw([about('tpyo', 'typo')])
    const group = container.querySelector('[data-slot="button-group"]')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toContain('spelled wrong')
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Accept',
      'Reject',
    ])
  })

  test('pressing Accept says accept, and pressing Reject says reject', () => {
    const { container, answered } = draw([about('tpyo', 'typo')])
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-slot="button-group"] button'))
    fireEvent.click(buttons[0]!)
    fireEvent.click(buttons[1]!)
    expect(answered).toEqual([
      { id: 'p-tpyo', decision: 'accept' },
      { id: 'p-tpyo', decision: 'reject' },
    ])
  })

  test('it carries the reason, so the change is not approved on its own say-so', () => {
    const { container } = draw([about('tpyo', 'typo', 'The author asked for this in review.')])
    expect(container.querySelector('.proposal-why')!.textContent).toBe('The author asked for this in review.')
  })

  test('the first block on a sheet puts its control below, and the rest above', () => {
    /* Above the first block is outside the page box, which clips — deliberately,
       for the phantom-width reason `paginated.tsx` argues. Known from the
       packing rather than measured, which is why it is assertable here. */
    const first = draw([about('A claim', 'A different claim')])
    expect(first.container.querySelector('[data-proposal]')!.getAttribute('data-approval-side')).toBe('below')
    first.unmount()
    const later = draw([about('tpyo', 'typo')])
    expect(later.container.querySelector('[data-proposal]')!.getAttribute('data-approval-side')).toBe('above')
  })

  test('with nothing wired to answer it, the change is drawn and no control is', () => {
    /* What any caller of the reading view that has not wired the write path
       gets, which is the same rule the Edit checkbox already follows. */
    const { container } = draw([about('tpyo', 'typo')], { wired: false })
    expect(out(container)).toEqual(['tpyo'])
    expect(container.querySelector('[data-proposal]')).toBeNull()
  })
})

describe('what is waiting, and the one control that answers all of it', () => {
  test('the count is drawn, and Accept all is not offered for one', () => {
    const { container } = draw([about('tpyo', 'typo')])
    expect(container.querySelector('[data-pending-proposals]')!.getAttribute('data-pending-proposals')).toBe('1')
    expect(container.querySelector('[data-accept-all]')).toBeNull()
  })

  test('Accept all appears at two, beside the count and not above a paragraph', () => {
    /*
     * Its placement is the assertion. A button meaning "and the other one as
     * well" repeated above each change is two controls each claiming to speak
     * for both, and pressing the one above the paragraph you happen to be
     * reading writes a change you have not scrolled to.
     */
    const { container, countAll } = draw([
      about('tpyo', 'typo'),
      about('prose after them', 'the prose after them', 'It reads better.'),
    ])
    expect(container.querySelectorAll('[data-accept-all]')).toHaveLength(1)
    expect(container.querySelector('[data-proposal] [data-accept-all]')).toBeNull()
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-accept-all]')!)
    expect(countAll()).toBe(1)
  })

  test('two suggestions in two paragraphs get one control each', () => {
    const { container } = draw([
      about('tpyo', 'typo'),
      about('prose after them', 'the prose after them', 'It reads better.'),
    ])
    expect(container.querySelectorAll('[data-proposal]')).toHaveLength(2)
  })
})

describe('the auto-approve tick', () => {
  test('it sits beside Edit, is off, and says what it does', () => {
    const { container } = draw([])
    const box = container.querySelector<HTMLInputElement>('input[data-auto-approve]')!
    expect(box.checked).toBe(false)
    expect(box.getAttribute('data-auto-approve')).toBe('0')
    expect(box.title).toContain('Off by default')
    /* Beside the Edit checkbox, in the same row, which is where a reader
       looking for one will look for the other. */
    const row = box.closest('div')!
    expect(row.querySelector('input[data-editing]')).not.toBeNull()
  })

  test('it is not drawn when the page did not offer one', () => {
    const { container } = render(
      <PaginatedView paper={fixture()} walk={null} mark={null} rootRef={ref()} onPen={() => {}} />,
    )
    expect(container.querySelector('input[data-auto-approve]')).toBeNull()
  })

  test('it is independent of Edit: it is drawn with the pen away', () => {
    /* Edit is about whether YOU may type. This is about what happens to
       somebody else's suggestion, and an agent can propose while a paper is
       being read rather than written. */
    const { container } = draw([], { pen: false })
    expect(container.querySelector<HTMLInputElement>('input[data-editing]')!.checked).toBe(false)
    expect(container.querySelector('input[data-auto-approve]')).not.toBeNull()
  })
})
