import { describe, expect, test } from 'bun:test'
import { render } from '@testing-library/react'

import { bytesOf } from '../latex/edit.ts'
import { parseLatex } from '../latex/parse.ts'
import type { Paper, PlacedBlock } from '../store.ts'
import { PaginatedView } from '../src/reader/paginated.tsx'

/**
 * When another module points at a byte range, the words that come out marked
 * are those bytes and not the run they sit in.
 *
 * ## The complaint this file was written against
 *
 * "The learning module doesn't seem to correctly highlight the passage from
 * the paper where the question is taken from." Measured with the parser over
 * the thesis's thirty-seven questions: the learning module publishes the exact
 * bytes of the quote, and this module painted whole RUNS that overlapped them
 * — a run being all the prose between two pieces of markup — so a sentence in
 * the middle of a plain paragraph came out marked together with up to four
 * hundred characters around it. Twenty-five of thirty-seven were widened by
 * more than forty characters. The pointing was right; the painting was wide.
 *
 * ## What is asserted
 *
 * The concatenated text of every `.passage-mark` on the page is the rendered
 * form of the pointed bytes — the source slice with its hard wraps collapsed —
 * and nothing else. Read off the DOM by class, because that is what a person
 * sees painted, and it is what `dev/measure-marked.mjs` reads in a browser.
 *
 * `data-marked` is deliberately NOT asserted narrower: it says which RUNS the
 * range touched, which is what the block-level margin rule and the probes read,
 * and it stays on the run so a mark that cannot be split (a derived run, a run
 * with a suggestion drawn in it) is still visibly somewhere.
 */

/* Hard-wrapped, for the reason `typing.test.tsx` gives: a paragraph on one
   source line is the one shape in which every run is literal and the
   collapsing of whitespace is never exercised. */
const SOURCE = [
  '\\begin{document}',
  '\\section{A heading long enough to point into}',
  '',
  'The first sentence is not pointed at. The second sentence is the one a',
  'question was written about, and it wraps. The third sentence is not pointed',
  'at either.',
  '',
  'A citation \\autocite{jones} splits this paragraph into runs, and a pointed',
  'range that crosses the citation touches the run before it and the run after.',
  '',
  '\\end{document}',
  '',
].join('\n')

function fixture(): Paper {
  const parsed = parseLatex(SOURCE, 'main.tex')
  const blocks: PlacedBlock[] = parsed.blocks.map((b) => ({ ...b, file: 'main.tex' }))
  return {
    epic: 'marked',
    dir: '/tmp/papers/marked',
    title: 'A paper somebody points into',
    author: null,
    blocks,
    figures: [],
    outline: [],
    files: ['main.tex'],
    hashes: { 'main.tex': 'not-on-disk' },
  }
}

/** The byte range of `needle` in the source, as a pointing module would publish it. */
function bytesOfNeedle(needle: string): { from: number; to: number } {
  const at = SOURCE.indexOf(needle)
  if (at === -1) throw new Error(`fixture does not contain “${needle}”`)
  return { from: bytesOf(SOURCE.slice(0, at)), to: bytesOf(SOURCE.slice(0, at + needle.length)) }
}

function draw(range: { from: number; to: number } | null) {
  const paper = fixture()
  const block = range
    ? paper.blocks.find((b) => b.srcStart < range.to && range.from < b.srcEnd)
    : undefined
  const mark = range && block ? { file: 'main.tex', id: block.id, ...range } : null
  return render(<PaginatedView paper={paper} walk={null} mark={mark} rootRef={{ current: null }} />)
}

const painted = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('.passage-mark'))
    .map((el) => el.textContent ?? '')
    .join('')

const collapsed = (source: string) => source.replace(/\s+/g, ' ')

describe('a pointed range is painted on its own bytes and not on the run around them', () => {
  test('a sentence in the middle of a paragraph is marked alone', () => {
    const needle = 'The second sentence is the one a\nquestion was written about, and it wraps.'
    const { container } = draw(bytesOfNeedle(needle))
    expect(painted(container)).toBe(collapsed(needle))
    /* The run it sits in is still the run the range touched. */
    expect(container.querySelectorAll('[data-src-start][data-marked]').length).toBe(1)
  })

  test('a range crossing a citation paints its share of the run on each side', () => {
    const needle = 'A citation \\autocite{jones} splits this'
    const { container } = draw(bytesOfNeedle(needle))
    /* `\autocite{jones}` renders as its own derived run. The range covers all
       of it, so that run is marked whole — its rendering is not the source and
       there is no offset inside it to cut at — while the literal runs either
       side of it are cut at the range's ends. Three marks, and the words
       outside the range on both sides are not among them. */
    const marks = Array.from(container.querySelectorAll<HTMLElement>('.passage-mark')).map((el) => el.textContent)
    expect(marks.length).toBe(3)
    expect(marks[0]).toBe('A citation ')
    expect(marks[2]).toBe(' splits this')
    expect(container.querySelectorAll('[data-src-start][data-marked]').length).toBe(3)
  })

  test('a range that is exactly a run marks the run itself, as before', () => {
    const needle = 'The first sentence is not pointed at. The second sentence is the one a\n'
      + 'question was written about, and it wraps. The third sentence is not pointed\nat either.'
    const { container } = draw(bytesOfNeedle(needle))
    expect(painted(container)).toBe(collapsed(needle))
    const span = container.querySelector<HTMLElement>('[data-src-start][data-marked]')!
    expect(span.classList.contains('passage-mark')).toBe(true)
  })

  test('part of a heading is marked alone', () => {
    const needle = 'long enough'
    const { container } = draw(bytesOfNeedle(needle))
    expect(painted(container)).toBe('long enough')
  })

  test('nothing pointed at, nothing painted', () => {
    const { container } = draw(null)
    expect(container.querySelectorAll('.passage-mark').length).toBe(0)
    expect(container.querySelectorAll('[data-src-start][data-marked]').length).toBe(0)
  })
})
