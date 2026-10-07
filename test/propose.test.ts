import { describe, expect, test } from 'bun:test'

import { diffWords, tokenize } from '../latex/diff.ts'
import { propose, rebase, type Proposal } from '../latex/propose.ts'

/**
 * The arithmetic under a suggested change, with no disk, no door and no page.
 *
 * Everything here decides something that corrupts a thesis quietly when it is
 * wrong: which bytes a suggestion names, where on screen it is drawn, and what
 * happens to the second suggestion when the first is accepted. None of it needs
 * a browser to be asserted, so none of it is left to a browser.
 */

describe('working a suggestion out from the text it quotes', () => {
  const source = 'The claim has a tpyo in it and the tpyo is worth fixing.'

  test('it refuses text that appears more than once, and says how many', () => {
    const said = propose(source, 'tpyo', 'typo')
    expect('why' in said && said.why).toContain('2 times')
  })

  test('a unique quote resolves to a byte range narrowed to what differs', () => {
    const worked = propose('The claim has a tpyo in it.', 'has a tpyo in', 'has a typo in')
    expect(worked).toEqual({ from: 17, to: 19, text: 'yp', was_text: 'py' })
  })

  test('bytes and not UTF-16 units, so an umlaut above the change does not shift it', () => {
    /* The bug this codebase has already lost once, in `inBytes` in the parser.
       `Ä` is two bytes and one unit, so a range measured in units would name a
       place one byte to the left of the word being corrected. */
    const withUmlaut = 'Ääkkösiä ja sitten tpyo tässä.'
    const worked = propose(withUmlaut, 'tpyo', 'typo')
    expect('from' in worked && worked.from).toBe(Buffer.from(withUmlaut, 'utf8').indexOf('tpyo') + 1)
  })

  test('a quote spanning the author’s hard wrap is ordinary', () => {
    const wrapped = 'runs on for long enough that the\nauthor wrapped the line'
    const worked = propose(wrapped, 'that the\nauthor', 'that the author')
    /* The newline is what is replaced, by a space. Whitespace for whitespace,
       which is the one transformation this module makes to a source file
       without being asked — the README calls it out. */
    expect('was_text' in worked && worked.was_text).toBe('\n')
    expect('text' in worked && worked.text).toBe(' ')
  })

  test('nothing to change is refused rather than filed', () => {
    expect('why' in propose(source, 'claim', 'claim')).toBe(true)
  })
})

describe('what an applied edit does to a suggestion measured before it', () => {
  const at = (from: number, to: number): Proposal => ({
    id: 'p',
    file: 'main.tex',
    from,
    to,
    text: 'new',
    was_text: 'old',
    was: 'the-old-hash',
    why: 'because',
    by: 'an agent',
    at: 0,
  })
  /** An edit that removes four bytes and puts thirteen there: nine longer. */
  const applied = { file: 'main.tex', from: 100, to: 104, text: 'typographical' }
  const delta = 9
  const fresh = 'the-new-hash'

  test('a suggestion entirely above it does not move, and IS restamped', () => {
    const moved = rebase(at(10, 20), applied, fresh)
    expect(moved).toMatchObject({ from: 10, to: 20, was: fresh })
  })

  test('the restamp is the whole point: without it the door would answer 409', () => {
    /* Stated as its own test because "the offsets did not change" is the
       obvious half and "the hash did" is the half that makes the second Accept
       work. A rebase that only moved offsets would leave every suggestion above
       an accepted one refused as stale, for a file whose bytes it does not
       share one of. */
    expect(rebase(at(10, 20), applied, fresh)!.was).not.toBe('the-old-hash')
  })

  test('a suggestion entirely below it shifts by the change in length', () => {
    expect(rebase(at(200, 210), applied, fresh)).toMatchObject({ from: 200 + delta, to: 210 + delta, was: fresh })
  })

  test('touching at either end is not overlapping', () => {
    expect(rebase(at(90, 100), applied, fresh)).toMatchObject({ from: 90, to: 100 })
    expect(rebase(at(104, 120), applied, fresh)).toMatchObject({ from: 104 + delta, to: 120 + delta })
  })

  test('a suggestion overlapping it does not survive', () => {
    expect(rebase(at(102, 120), applied, fresh)).toBeNull()
    expect(rebase(at(90, 102), applied, fresh)).toBeNull()
    expect(rebase(at(100, 104), applied, fresh)).toBeNull()
    expect(rebase(at(90, 120), applied, fresh)).toBeNull()
  })

  test('a suggestion about a different file is returned untouched, hash included', () => {
    const other: Proposal = { ...at(200, 210), file: 'chapters/wire.tex' }
    /* Not restamped. The hash of `main.tex` says nothing about `wire.tex`, and
       stamping it on would make a suggestion that IS stale look fresh. */
    expect(rebase(other, applied, fresh)).toEqual(other)
  })

  test('a shrinking edit shifts the other way', () => {
    const shrunk = { file: 'main.tex', from: 100, to: 120, text: 'x' }
    expect(rebase(at(200, 210), shrunk, fresh)).toMatchObject({ from: 181, to: 191 })
  })
})

describe('the picture of the change', () => {
  test('a changed word reads as a changed word, not as changed letters', () => {
    /* The whole argument for tokens over characters. A character-level diff of
       this pair keeps `mark` and reports `et` out, `rm` in — minimal, true, and
       unreadable. */
    expect(diffWords('to the market', 'to the farm')).toEqual([
      { type: 'equal', text: 'to the ' },
      { type: 'removed', text: 'market' },
      { type: 'added', text: 'farm' },
    ])
  })

  test('two changes in one sentence are two changes', () => {
    const ops = diffWords('Little piggy went to the market', 'Little red piggy went to the farm')
    expect(ops.filter((o) => o.type === 'added').map((o) => o.text)).toEqual(['red ', 'farm'])
    expect(ops.filter((o) => o.type === 'removed').map((o) => o.text)).toEqual(['market'])
  })

  test('the whitespace between two words survives, so they do not run together', () => {
    const drawn = diffWords('one two', 'one three')
      .filter((o) => o.type !== 'removed')
      .map((o) => o.text)
      .join('')
    expect(drawn).toBe('one three')
  })

  test('runs of one kind are merged, so a rewritten clause is one red box', () => {
    const ops = diffWords('a b c d', 'a x')
    expect(ops.filter((o) => o.type === 'removed')).toHaveLength(1)
  })

  test('an insertion and a deletion are each one op', () => {
    expect(diffWords('', 'new')).toEqual([{ type: 'added', text: 'new' }])
    expect(diffWords('old', '')).toEqual([{ type: 'removed', text: 'old' }])
  })

  test('punctuation is its own token, so a moved comma is a moved comma', () => {
    expect(tokenize('one, two')).toEqual(['one', ',', ' ', 'two'])
  })
})
