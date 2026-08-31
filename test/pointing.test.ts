import { describe, expect, test } from 'bun:test'
import type { Passage } from 'roadmap-module-protocol'

import type { Paper, PlacedBlock } from '../store.ts'
import { blockFor, fileOf, isEcho, keyOf, pointedAt } from '../src/reader/pointed.ts'
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

  test('a range on source this container draws none of lands on the block BELOW it', () => {
    /*
     * The ordinary case rather than an edge one, and it was answered wrong.
     *
     * Bytes 40–100 of this file are drawn by nothing: a comment run, which
     * `pages.ts` folds away and out of which the notes container lifts a note. The
     * fallback used to be "the last block in the file", so pressing a note
     * about the top of a chapter walked the reader to its final paragraph —
     * nineteen of the twenty-three comment notes in the thesis this was
     * measured on, plus four more in a preamble. A comment run sits ABOVE what
     * it is about, so the block below it is the subject and the block above it
     * is the previous one.
     */
    expect(blockFor(paper, 'chapters/bridge.tex', { from: 45, to: 90 })?.id).toBe('para-1')
  })

  test('a passage in the preamble lands on the file’s first drawn block', () => {
    /* Which is what this function's own essay has always claimed and what it
       did not do: every block in a file starts after that file's preamble, so
       the first one below the range is the first one there is. */
    const withBody = {
      ...paper,
      blocks: [
        ...paper.blocks,
        block({ id: 'head-m', kind: 'heading', file: 'main.tex', srcStart: 200, srcEnd: 240, level: 1, segments: [] }),
      ],
    } as unknown as Paper
    expect(blockFor(withBody, 'main.tex', { from: 0, to: 90 })?.id).toBe('head-m')
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
    expect(answer.mark).toEqual({ file: 'chapters/bridge.tex', id: 'para-2', from: 420, to: 460 })
    expect(answer.said).toContain('420')
  })

  test('the mark names the block as well as the range, and the range is never widened', () => {
    /*
     * The two halves of a mark answer two different questions, and a passage
     * naming source this container draws none of only has an answer to the second.
     *
     * `id` is which block the pointing landed on, so `BlockRow` can draw its
     * rule in the margin — "the thing you pointed at is here" — for a comment
     * run, a lifted `\todo{}`, or a preamble. The range stays exactly as it
     * arrived so that no span inside that block is painted: a paragraph washed
     * in colour because something near it was pointed at would be this module
     * claiming to have found words it did not find.
     */
    const answer = pointedAt(paper, at({ from: 45, to: 90 }))
    expect(answer.at).toBe('here')
    if (answer.at !== 'here') return
    expect(answer.id).toBe('para-1')
    expect(answer.mark).toEqual({ file: 'chapters/bridge.tex', id: 'para-1', from: 45, to: 90 })
  })

  test('a passage with no range marks nothing AND turns nowhere', () => {
    /*
     * This test used to assert the opposite, and the opposite was a bug a
     * reader could feel.
     *
     * Rung 2 of the field — a document and a page, no range — means "somebody
     * has this open". It is what lets a notes container show a page's notes
     * instead of nothing. It does not mean "go here". Treating it as a
     * destination closed a loop through the canvas:
     *
     *   scroll -> the page readout changes -> this app publishes rung 2 naming
     *   the new page -> the host broadcasts it -> this app turns to it -> the
     *   page moves under the person who was scrolling.
     *
     * `shouldPublish` refuses to send an echo straight back, so it never span
     * forever. It did not need to: one turn per scroll is a jump. The guard was
     * on the wrong half.
     *
     * Marking is still refused for the reason it always was — a note whose
     * words this app could not find arrives this way, and colouring its
     * recorded offsets would put confidence on whatever text has drifted into
     * them.
     */
    const answer = pointedAt(paper, at({ from: null, to: null, quoted: '' }))
    expect(answer.at).toBe('holding')
  })

  test('holding says nothing, because there is nothing to say', () => {
    /* A container that already has the document open, being told the document is
       open, has no news. The sentence that used to be here narrated the app's
       own plumbing at somebody reading a thesis. */
    const answer = pointedAt(paper, at({ from: null, to: null, quoted: '' }))
    expect('said' in answer).toBe(false)
    expect('mark' in answer).toBe(false)
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

describe('the echo of this module\u2019s own highlight', () => {
  const mine = at()

  test('a passage this module published is recognised when it comes back', () => {
    /* The reported failure: highlighting a paragraph published it, the host put
       it in the context, and the context arrived back here looking exactly like
       a notes container pointing this reader somewhere. Measured at 166 pixels of
       scroll under the person doing the highlighting — `dev/measure-selection.mjs`. */
    expect(isEcho(keyOf(mine), mine)).toBe(true)
  })

  test('the quote is not compared, because it is the field that changes in transit', () => {
    /* Truncated on the way out and re-readable from the file on the way back. A
       key that included it would stop matching for a reason nobody could see,
       and the guard would silently stop guarding. */
    expect(isEcho(keyOf(mine), at({ quoted: 'the host re-read this from disk' }))).toBe(true)
  })

  test('a different range at the same path is somebody else pointing', () => {
    expect(isEcho(keyOf(mine), at({ from: 900, to: 950 }))).toBe(false)
  })

  test('a different page of the same range is somebody else pointing', () => {
    /* Page is part of the key even though the range identifies the place,
       because `passageFor` sends the page the reader is on and two modules
       disagreeing about which sheet a range is on is a real difference. */
    expect(isEcho(keyOf(mine), at({ page: 9 }))).toBe(false)
  })

  test('nothing published and nothing arriving are both "not an echo"', () => {
    /* All three of these mean the same thing to the caller — walk to it — and
       none is worth a separate answer. */
    expect(isEcho(null, mine)).toBe(false)
    expect(isEcho(keyOf(mine), null)).toBe(false)
    expect(isEcho(null, null)).toBe(false)
  })

  test('a passage with no range still keys, so rung two can be recognised too', () => {
    /* `pointedAt` answers `holding` for these and moves nobody, so nothing
       depends on it today. It keys anyway rather than throwing, because a
       function that is correct only for the arm currently calling it is a trap
       for whoever adds the second caller. */
    const page = at({ from: null, to: null, quoted: '' })
    expect(isEcho(keyOf(page), page)).toBe(true)
    expect(keyOf(page)).not.toBe(keyOf(mine))
  })
})
