import { describe, expect, test } from 'bun:test'
import type { Passage } from 'roadmap-module-protocol'

import type { Paper, PlacedBlock } from '../store.ts'
import { blockFor, fileOf, pointedAt } from '../src/reader/pointed.ts'
import { shouldPublish } from '../src/use-published-passage.ts'

/**
 * The wire, read as well as written — and the guard that stops the two halves
 * from talking to each other forever.
 *
 * ## What this module now does that it did not
 *
 * It published a passage and never consumed one, so the conversation ran one
 * way: the reader highlighted here and a notes container narrowed. The user asked
 * for the other direction in one sentence — "when you click on a note shouldn't
 * it highlight and show what its target from the paper?" — and it is the same
 * field read instead of written.
 *
 * The interesting half is not the reading. It is that a module which both
 * publishes on a change and moves on a message is a cycle with no natural end,
 * and this workspace has a measured instance of that shape one layer up: the
 * host broadcasting seventeen identical contexts in one startup because nothing
 * checked. So the guard is a pure function and it is tested like one.
 */

const DIR = '/Users/x/Projects/roadmap/data/papers/modes-are-modules'

function block(over: Partial<PlacedBlock> = {}): PlacedBlock {
  return {
    kind: 'paragraph',
    id: 'para-1',
    file: 'chapters/bridge.tex',
    srcStart: 100,
    srcEnd: 400,
    segments: [],
    ...over,
  } as PlacedBlock
}

const paper = {
  epic: 'modes-are-modules',
  title: 'Every mode is a module',
  dir: DIR,
  files: ['main.tex', 'chapters/bridge.tex'],
  blocks: [
    block({ id: 'pre-1', kind: 'preamble', file: 'main.tex', srcStart: 0, srcEnd: 90, raw: '' }),
    block({ id: 'head-1', kind: 'heading', file: 'chapters/bridge.tex', srcStart: 0, srcEnd: 40, level: 2, segments: [] }),
    block({ id: 'para-1', file: 'chapters/bridge.tex', srcStart: 100, srcEnd: 400 }),
    block({ id: 'para-2', file: 'chapters/bridge.tex', srcStart: 400, srcEnd: 900 }),
  ],
} as unknown as Paper

const at = (over: Partial<Passage> = {}): Passage => ({
  path: `${DIR}/chapters/bridge.tex`,
  page: 3,
  from: 420,
  to: 460,
  quoted: 'a passage names both ends of a selection or neither',
  ...over,
})

describe('which file of this paper a passage names', () => {
  test('a path under the root, that the paper actually holds', () => {
    expect(fileOf(paper, `${DIR}/chapters/bridge.tex`)).toBe('chapters/bridge.tex')
  })

  test('a path under the root the paper does not hold is not this paper’s', () => {
    /* A prefix test on its own would say yes to any file in the folder,
       including one nobody assembled into this document. */
    expect(fileOf(paper, `${DIR}/chapters/never-included.tex`)).toBeNull()
  })

  test('a path somewhere else entirely', () => {
    expect(fileOf(paper, '/Users/x/thesis/chapters/3_methods.tex')).toBeNull()
  })
})

describe('which block a byte range lands in', () => {
  test('the block whose source it overlaps', () => {
    expect(blockFor(paper, 'chapters/bridge.tex', { from: 420, to: 460 })?.id).toBe('para-2')
  })

  test('overlap and not containment, because a recorded range rarely fits a block', () => {
    /* A note anchored to a comment run, or one whose anchor MOVED, routinely
       starts a byte or two outside the block a reader would name. */
    expect(blockFor(paper, 'chapters/bridge.tex', { from: 380, to: 410 })?.id).toBe('para-1')
  })

  test('no range at all turns to the file’s first drawn block', () => {
    expect(blockFor(paper, 'chapters/bridge.tex', null)?.id).toBe('head-1')
  })

  test('a range past everything drawn lands on the last block rather than nowhere', () => {
    expect(blockFor(paper, 'chapters/bridge.tex', { from: 5000, to: 5100 })?.id).toBe('para-2')
  })

  test('a file whose only block is the preamble has nothing this container draws', () => {
    /* `main.tex` here holds a folded preamble and nothing else. Notes stopped
       lifting that region for the same reason this container never draws it. */
    expect(blockFor(paper, 'main.tex', { from: 0, to: 40 })).toBeNull()
  })
})

describe('what this container does about a passage', () => {
  test('a range in this paper: turn to the block and mark the range', () => {
    const answer = pointedAt(paper, at())
    expect(answer.at).toBe('here')
    if (answer.at !== 'here') return
    expect(answer.id).toBe('para-2')
    expect(answer.mark).toEqual({ file: 'chapters/bridge.tex', from: 420, to: 460 })
    expect(answer.said).toContain('420')
  })

  test('a passage with no range turns to the file and marks nothing', () => {
    /* Rung 2, and also every note whose words this app could not find in the
       file. Marking recorded offsets nobody verified would put a confident
       colour on whatever text has since drifted into them. */
    const answer = pointedAt(paper, at({ from: null, to: null, quoted: '' }))
    expect(answer.at).toBe('here')
    if (answer.at !== 'here') return
    expect(answer.mark).toBeNull()
    expect(answer.said).toContain('nothing is marked')
  })

  test('a document this container does not have open says so, and never silently does nothing', () => {
    /* The real case: a note lives on another epic's chapter and somebody
       presses it. Opening it would answer for a place the canvas is not
       standing — the `roadmap.goto` handler refuses the same thing for the same
       reason — and doing nothing quietly would look, from the container that sent
       it, exactly like it had worked. */
    const answer = pointedAt(paper, at({ path: '/Users/x/thesis/chapters/3_methods.tex' }))
    expect(answer.at).toBe('elsewhere')
    if (answer.at !== 'elsewhere') return
    expect(answer.said).toContain('3_methods.tex')
    expect(answer.said).toContain('Every mode is a module')
  })

  test('no paper on screen is answered rather than ignored', () => {
    const answer = pointedAt(null, at())
    expect(answer.at).toBe('elsewhere')
  })

  test('no passage at all is nowhere, which is the state a mark is taken off in', () => {
    expect(pointedAt(paper, null).at).toBe('nowhere')
  })

  test('the passage’s own page is not what decides where to go', () => {
    /* It is a filter and never an anchor — the protocol says so — and it was
       computed by whichever module was paginating when the note was written.
       The block list is this module's arithmetic over its own sheets. */
    const early = pointedAt(paper, at({ page: 1 }))
    const late = pointedAt(paper, at({ page: 99 }))
    expect(early).toEqual(late)
  })
})

describe('the loop guard', () => {
  const a = at()
  const b = at({ from: 900, to: 950 })

  test('the first passage of a conversation goes out', () => {
    expect(shouldPublish(a, null, false, null, false)).toBe(true)
  })

  test('the same passage twice is not an event', () => {
    expect(shouldPublish(a, a, true, null, false)).toBe(false)
  })

  test('a passage this module just RECEIVED is never sent back', () => {
    /* Two modules agreeing is not news. Without this, adopting a passage and
       then being touched by a reader would send it straight back to the container
       that set it. */
    expect(shouldPublish(a, null, false, a, false)).toBe(false)
  })

  test('nothing is published while the container is showing somebody else’s passage', () => {
    /* The cycle this closes: a passage arrives, the container turns to page 14, the
       readout changes, and rung 2 — the document and the page, with no range —
       is a DIFFERENT passage from the one that arrived. Sent, it would replace
       the range on the canvas with a page, in answer to a move nobody made. */
    expect(shouldPublish(b, a, true, a, true)).toBe(false)
  })

  test('a gesture lifts it, and then a genuinely new passage goes out', () => {
    expect(shouldPublish(b, a, true, a, false)).toBe(true)
  })

  test('null is a passage like any other and can be published once', () => {
    /* "No document is open" is a state a consumer must be able to move into. */
    expect(shouldPublish(null, a, true, null, false)).toBe(true)
    expect(shouldPublish(null, null, true, null, false)).toBe(false)
  })
})
