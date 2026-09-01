import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'

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
 * happy-dom lays nothing out, and since the control became a popover it lays
 * out even less that matters: Floating UI reads `getBoundingClientRect`, which
 * here is all zeroes, so every rectangle it computes is a rectangle about
 * nothing. Whether the card actually sits above the changed words, whether it
 * flips at the top of the column, whether it hides when they scroll away, and
 * whether the count fits beside the buttons at 220 pixels are all unverifiable
 * here and are stated as unverified in the report and in the README.
 *
 * What it proves is the part that decides whether somebody approves a change
 * they did not read:
 *
 *  - **Which characters are struck through and which are green.** Both are
 *    `<del>` and `<ins>` with `data-proposed`, so "the right words are marked"
 *    is a query rather than a claim.
 *  - **That the words are marked ONCE**, in the prose, and that the card no
 *    longer repeats them.
 *  - **Which element the control was anchored to.** Not where it landed — that
 *    needs layout — but which, and that is the whole of the owner's second
 *    complaint. Radix renders its own anchor element only when it was NOT given
 *    one, so "there is no anchor div in the block" is a positive statement that
 *    the changed span was handed over instead.
 *  - **That a run under a suggestion cannot be typed into.** A
 *    `contenteditable` span containing a `<del>` and an `<ins>` has a
 *    `textContent` holding the old text and the new run together, and a
 *    correction committed out of it would splice both into the file.
 *  - **That a suggestion which cannot be placed honestly is not drawn in the
 *    prose at all**, and is still answerable, because the control falls back to
 *    the block.
 *  - **That the two counts are one list.**
 *  - **That the control is offered only when the page wired one.**
 *
 * ## Everything the control renders is in a PORTAL
 *
 * `render`'s `container` is no longer where the card is: `PopoverContent` puts
 * it at the end of `document.body`, which is the point of it — see
 * `proposed.tsx`. So the queries here are split deliberately. `container` is
 * the paper, `cards()` is the controls, and a query that used to find both by
 * accident now has to say which it meant. `cleanup` after each test matters
 * more than it did for the same reason: an unmounted render used to take its
 * container with it and now would leave a card behind for the next test to
 * count.
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

afterEach(cleanup)

const out = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-proposed="out"]')).map((e) => e.textContent)
const arrived = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-proposed="in"]')).map((e) => e.textContent)

/** Every floating control on screen, wherever the portal put it. */
const cards = () => Array.from(document.body.querySelectorAll<HTMLElement>('[data-proposal]'))
/** What one control says about where in the paper it is: "2 of 3". */
const counts = (c: HTMLElement) => c.querySelector('.proposal-count')!.getAttribute('data-proposal-count')
/** The only one, when a test filed one suggestion. */
const card = () => {
  const all = cards()
  if (all.length !== 1) throw new Error(`expected one control, found ${all.length}`)
  return all[0]!
}

describe('the change is drawn where it happens', () => {
  test('what leaves is struck through and what arrives is green, at the right words', () => {
    const { container } = draw([about('tpyo', 'typo')])
    expect(out(container)).toEqual(['tpyo'])
    expect(arrived(container)).toEqual(['typo'])
  })

  test('once, and not again in the control', () => {
    /*
     * It used to be drawn twice on purpose — the essay for that is in
     * `proposed.tsx`, and it is now the essay for why it is not. The owner:
     * "repeating the words that were changed there is redundant as they are
     * also showed in the text itself." Asserted on the whole DOCUMENT rather
     * than on `container`, because the control is portalled out of it and a
     * query scoped to the paper would pass whatever the card did.
     */
    draw([about('tpyo', 'typo')])
    expect(document.body.querySelectorAll('[data-proposed]')).toHaveLength(2)
    expect(card().querySelector('[data-proposed]')).toBeNull()
    /* And the sentence stays, which is the half of the card the owner kept. */
    expect(card().querySelector('.proposal-why')!.textContent).toContain('spelled wrong')
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
    /*
     * What arrives, and nothing leaving. This assertion used to be the other
     * way round and it was passing on the copy of the diff that lived in the
     * control, which diffed the RAW source — where the author's newline is a
     * character that has to leave, so there was a `<del>` for it. The prose
     * copy diffs the rendered text, where the newline is already the space it
     * draws as, and the change is then what it really is: the word "has",
     * inserted, with nothing removed. Deleting the second copy made the two
     * disagree out loud, which is the argument for having only one.
     */
    expect(arrived(container)).toEqual(['has '])
    expect(out(container)).toEqual([])
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

  test('it is still answerable, and its control falls back to the block', () => {
    const { container } = draw([about('\\autocite{jones}', 'somebody else')])
    expect(cards()).toHaveLength(1)
    /*
     * The fallback IS the assertion. With a change drawn in the prose, the span
     * is handed to Radix as a `virtualRef` and Radix renders no anchor element
     * of its own; with nothing to point at, the anchor is a div covering the
     * block, which is exactly where the control used to live for every
     * suggestion. So an anchor div in the paper means "this one could not be
     * placed", and its absence in the next test means "this one could".
     */
    const anchor = container.querySelector('[data-slot="popover-anchor"]')
    expect(anchor).not.toBeNull()
    expect(anchor!.closest('[data-has-proposals]')).not.toBeNull()
    /* The card no longer repeats the change — see the essay — so what it can
       still say about a suggestion it could not draw is the reason for it. */
    expect(card().querySelector('.proposal-why')!.textContent).toContain('spelled wrong')
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
    draw([about('tpyo', 'typo')])
    const group = card().querySelector('[data-slot="button-group"]')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toContain('spelled wrong')
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Accept',
      'Reject',
    ])
  })

  test('pressing Accept says accept, and pressing Reject says reject', () => {
    const { answered } = draw([about('tpyo', 'typo')])
    const buttons = Array.from(card().querySelectorAll<HTMLButtonElement>('[data-slot="button-group"] button'))
    fireEvent.click(buttons[0]!)
    fireEvent.click(buttons[1]!)
    expect(answered).toEqual([
      { id: 'p-tpyo', decision: 'accept' },
      { id: 'p-tpyo', decision: 'reject' },
    ])
  })

  test('it carries the reason, so the change is not approved on its own say-so', () => {
    draw([about('tpyo', 'typo', 'The author asked for this in review.')])
    expect(card().querySelector('.proposal-why')!.textContent).toBe('The author asked for this in review.')
  })

  test('it is anchored to the changed words, not to the paragraph', () => {
    /*
     * The owner's second complaint — "it should be positioned right above the
     * part where the change took place. right now it is not positioned
     * correctly" — and the closest a document with no layout can get to it.
     *
     * WHERE the card lands needs a browser. WHICH element it was told to
     * measure does not: Radix's anchor renders as a real div only when it was
     * given nothing better, so a block with no anchor div in it is a block
     * whose control was handed the `<del>`/`<ins>` span instead. That span is
     * the change, so this is the whole of the difference between the old
     * behaviour and the new one, minus the arithmetic only a browser can do.
     */
    const { container } = draw([about('tpyo', 'typo')])
    expect(container.querySelector('[data-slot="popover-anchor"]')).toBeNull()
    const change = container.querySelector('[data-proposed-change]')
    expect(change).not.toBeNull()
    expect(change!.textContent).toBe('tpyotypo')
  })

  test('a change spanning two runs is anchored once, where it starts', () => {
    /* Three spans could claim to be one suggestion's place — the words either
       side of the author's hard wrap are two runs — and whichever mounted last
       would win. Only the run the change STARTS in reports itself, so the
       control points at the first character that moves. */
    const { container } = draw([about('that the\nauthor wrapped', 'that the author has wrapped')])
    expect(container.querySelector('[data-slot="popover-anchor"]')).toBeNull()
    expect(cards()).toHaveLength(1)
  })

  test('the flip is Floating UI’s now, and the control is portalled out of the page', () => {
    /*
     * There was a `side` prop here, set from the packing: the first block on a
     * sheet had nothing above it inside the page box, which clips, so its
     * control went below. Both halves of that are gone — the card is no longer
     * inside the page box, so nothing clips it, and `avoidCollisions` flips it
     * against the reading column instead.
     *
     * What is assertable without layout is that the card left the sheet. That
     * is also what killed `--counter-scale`: a box outside the transformed
     * subtree needs no reciprocal, and there is none anywhere in the codebase
     * now.
     */
    const { container } = draw([about('A claim', 'A different claim')])
    expect(container.querySelector('[data-proposal]')).toBeNull()
    expect(cards()).toHaveLength(1)
    expect(card().closest('.sheet')).toBeNull()
    expect(card().getAttribute('data-side')).toBe('top')
  })

  test('with nothing wired to answer it, the change is drawn and no control is', () => {
    /* What any caller of the reading view that has not wired the write path
       gets, which is the same rule the Edit checkbox already follows. */
    const { container } = draw([about('tpyo', 'typo')], { wired: false })
    expect(out(container)).toEqual(['tpyo'])
    expect(cards()).toHaveLength(0)
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
    expect(document.body.querySelectorAll('[data-accept-all]')).toHaveLength(1)
    expect(document.body.querySelector('[data-proposal] [data-accept-all]')).toBeNull()
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-accept-all]')!)
    expect(countAll()).toBe(1)
  })

  test('two suggestions in two paragraphs get one control each', () => {
    draw([
      about('tpyo', 'typo'),
      about('prose after them', 'the prose after them', 'It reads better.'),
    ])
    expect(cards()).toHaveLength(2)
  })
})

describe('x of y, beside the buttons', () => {
  /*
   * The owner asked for "x of y changes" beside the button group "so a reader
   * can see this is the second of four without counting". There was already a
   * count in the chrome row next to `Accept all`, and two counts that could
   * disagree would be worse than one — so they are not two numbers. They are
   * the length and the index of one list, sorted once by `PaginatedView` into
   * the order a reader meets them, and these tests hold that join.
   */
  const three = () => [
    /* Filed in an order that is NOT document order, on purpose: `at` says the
       middle paragraph's suggestion arrived first. If the ordinal came from the
       filing order this fixture would number them 2, 1, 3. */
    { ...about('prose after them', 'the prose after them', 'It reads better.'), at: 1 },
    { ...about('tpyo', 'typo'), at: 2 },
    { ...about('A claim', 'A better claim', 'The section is misnamed.'), at: 3 },
  ]

  test('the count is beside the two buttons, in the same row', () => {
    draw([about('tpyo', 'typo')])
    const row = card().querySelector('.proposal-answer')!
    expect(row.querySelector('[data-slot="button-group"]')).not.toBeNull()
    expect(row.querySelector('.proposal-count')!.textContent).toBe('1 of 1')
  })

  test('it counts down the paper, not up the filing order', () => {
    const { container } = draw(three())
    /* Heading first, then the first paragraph, then the second — which is the
       order these blocks appear in the fixture and not the order `at` gives. */
    const counted = cards().map(counts)
    expect(counted.sort()).toEqual(['1 of 3', '2 of 3', '3 of 3'])
    const byId = new Map(cards().map((c) => [c.getAttribute('data-proposal'), counts(c)]))
    expect(byId.get('p-A claim')).toBe('1 of 3')
    expect(byId.get('p-tpyo')).toBe('2 of 3')
    expect(byId.get('p-prose after them')).toBe('3 of 3')
    /* And nothing about the paper moved to make that true. */
    expect(container.querySelectorAll('[data-has-proposals]')).toHaveLength(3)
  })

  test('the y is the chrome row’s number, because it is the same list', () => {
    const { container } = draw(three())
    const chrome = container.querySelector('[data-pending-proposals]')!
    expect(chrome.getAttribute('data-pending-proposals')).toBe('3')
    expect(chrome.textContent).toContain('3 suggested')
    for (const c of cards()) expect(counts(c)).toEndWith('of 3')
  })

  test('the word “changes” is said where it costs no line', () => {
    /* Not in the visible text: at 220 pixels it is what pushes the count onto a
       line of its own. In the title and in the group's accessible name, which
       is the same move the page readout's caveat made. */
    draw(three())
    const one = cards().find((c) => c.getAttribute('data-proposal') === 'p-tpyo')!
    const count = one.querySelector<HTMLElement>('.proposal-count')!
    expect(count.textContent).toBe('2 of 3')
    expect(count.title).toContain('2nd of 3 suggested changes')
    expect(one.getAttribute('aria-label')).toContain('Suggested change 2 of 3')
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
