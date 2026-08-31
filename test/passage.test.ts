import { describe, expect, test } from 'bun:test'
import { LIMITS, passageSchema } from 'roadmap-module-protocol'

import type { Paper } from '../store.ts'
import { passageFor } from '../src/use-published-passage.ts'
import type { Passage as Highlighted } from '../src/use-selection.ts'

/**
 * What this module tells the canvas about where the reader is pointing.
 *
 * The rungs are the protocol's, and the point of testing them here is that this
 * app can honestly stand on all three: it knows when no paper is open, it knows
 * which sheet is in front of somebody, and it can turn a browser highlight into
 * a byte range. A module that could only ever send the third rung would leave a
 * notes container blank whenever nobody happened to be dragging.
 */

const paper = { epic: 'modes-are-modules', dir: '/Users/x/Projects/roadmap/data/papers/modes-are-modules' } as Paper

const highlight = (over: Partial<Highlighted> = {}): Highlighted => ({
  srcStart: 4120,
  srcEnd: 4180,
  rendered: 'a passage names both ends of a selection or neither',
  exact: true,
  file: 'chapters/bridge.tex',
  x: 0,
  y: 0,
  ...over,
})

describe('the three rungs, and no fourth', () => {
  test('no paper on screen is null, and not a passage with an empty path', () => {
    /* "No document is open" is a state a consumer has to be able to move INTO.
       A container that kept sending the last chapter would leave a notes container
       showing the notes on a document the reader closed. */
    expect(passageFor(null, { page: 1, file: 'chapters/bridge.tex' }, null)).toBeNull()
    expect(passageFor(null, { page: 1, file: null }, highlight())).toBeNull()
  })

  test('a paper with nothing selected names the document and the page', () => {
    /* This is the rung that makes a notes container useful when nobody is
       highlighting anything: it shows the page's notes rather than nothing,
       which is the ask the field was designed for. */
    const passage = passageFor(paper, { page: 7, file: 'chapters/bridge.tex' }, null)
    expect(passage).toEqual({
      path: '/Users/x/Projects/roadmap/data/papers/modes-are-modules/chapters/bridge.tex',
      page: 7,
      from: null,
      to: null,
      quoted: '',
    })
  })

  test('a highlight carries the range and the words that were there', () => {
    const passage = passageFor(paper, { page: 7, file: 'chapters/bridge.tex' }, highlight())
    expect(passage?.from).toBe(4120)
    expect(passage?.to).toBe(4180)
    expect(passage?.quoted).toBe('a passage names both ends of a selection or neither')
  })

  test('the page is named on the range rung too, so a filter still works', () => {
    /* `page` is a FILTER and never an anchor, and dropping it once a range
       exists would make a consumer unable to narrow a list to the sheet
       somebody is looking at the moment they highlight anything. */
    expect(passageFor(paper, { page: 7, file: 'chapters/bridge.tex' }, highlight())?.page).toBe(7)
  })
})

describe('the path is one absolute string, spelled one way', () => {
  test('the paper’s root is joined to the block’s relative file', () => {
    /* Blocks name their file relative to the root; the protocol wants absolute,
       because that is the only spelling two modules can agree on without
       sharing one. A consumer handed `chapters/bridge.tex` would have to guess
       which of eleven projects on this machine it is relative to. */
    expect(passageFor(paper, { page: 1, file: 'chapters/bridge.tex' }, null)?.path).toBe(
      '/Users/x/Projects/roadmap/data/papers/modes-are-modules/chapters/bridge.tex',
    )
  })

  test('a root with a trailing slash does not produce a second spelling', () => {
    /* Every consumer compares this field for EQUALITY, so two spellings of one
       file are two documents as far as the canvas is concerned. */
    const trailing = { ...paper, dir: '/Users/x/papers/thesis/' } as Paper
    expect(passageFor(trailing, { page: 1, file: 'main.tex' }, null)?.path).toBe('/Users/x/papers/thesis/main.tex')
  })

  test('the highlight’s own file wins over the sheet’s', () => {
    /* A selection can run from the bottom of one page to the top of the next,
       and `lib/selection.ts` reads the file off the block the range is actually
       inside. The sheet is only the fallback for when nothing is selected. */
    const passage = passageFor(paper, { page: 7, file: 'chapters/wire.tex' }, highlight())
    expect(passage?.path).toContain('chapters/bridge.tex')
  })

  test('no file to name is no passage, rather than an invented path', () => {
    /* A page holding nothing placed cannot be named, and a passage with a made
       up path is a claim about a file this app cannot say anybody is looking
       at. */
    expect(passageFor(paper, { page: 1, file: null }, null)).toBeNull()
  })

  test('a path past the protocol’s bound is refused rather than sent to be dropped', () => {
    const deep = { ...paper, dir: `/${'x'.repeat(LIMITS.PATH)}` } as Paper
    expect(passageFor(deep, { page: 1, file: 'main.tex' }, null)).toBeNull()
  })
})

describe('the quote is whole or it is absent', () => {
  test('a selection longer than the bound sends the range with no quote', () => {
    /* `LIMITS.QUOTE` is refused rather than clipped, and the reason is what the
       quote is FOR: a consumer compares it against the file to tell a good
       anchor from a rotten one. Half a paragraph will never match, so a clipped
       quote turns every long selection into a permanent false report of drift.
       An empty quote is visibly "there is nothing to check against". */
    const passage = passageFor(paper, { page: 2, file: 'main.tex' }, highlight({ rendered: 'x'.repeat(LIMITS.QUOTE + 1) }))
    expect(passage?.from).toBe(4120)
    expect(passage?.quoted).toBe('')
  })

  test('a selection exactly at the bound keeps its quote', () => {
    const passage = passageFor(paper, { page: 2, file: 'main.tex' }, highlight({ rendered: 'x'.repeat(LIMITS.QUOTE) }))
    expect(passage?.quoted).toHaveLength(LIMITS.QUOTE)
  })
})

describe('everything this module can send is something a host will take', () => {
  test('each rung parses against the protocol’s own schema', () => {
    /* Running the package's schema here is a convenience and not the check —
       the host runs its own copy over whatever arrives. It is the cheapest way
       to learn this file is wrong at the moment it is edited, rather than from
       a refusal in somebody else's console. */
    const rungs = [
      passageFor(paper, { page: 1, file: 'main.tex' }, null),
      passageFor(paper, { page: 3, file: 'chapters/bridge.tex' }, highlight()),
      passageFor(paper, { page: 3, file: 'chapters/bridge.tex' }, highlight({ rendered: 'x'.repeat(LIMITS.QUOTE + 1) })),
    ]
    for (const rung of rungs) {
      expect(rung).not.toBeNull()
      expect(() => passageSchema.parse(rung)).not.toThrow()
    }
  })

  test('a half-range can never leave this module', () => {
    /* The schema refuses `from` without `to`, calling it malformed rather than
       coarser. `lib/selection.ts` only ever produces both, and this is the
       assertion that keeps that true if it ever stops. */
    const passage = passageFor(paper, { page: 1, file: 'main.tex' }, highlight())
    expect(passage?.from === null).toBe(passage?.to === null)
  })
})
