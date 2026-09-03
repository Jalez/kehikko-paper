import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { parseLatex } from '../latex/parse.ts'
import type { Proposal } from '../latex/propose.ts'
import type { Paper, PlacedBlock } from '../store.ts'
import { compare } from '../src/reader/changed.ts'
import { PaginatedView } from '../src/reader/paginated.tsx'

/**
 * A paper that moved on disk, drawn over the reading, as far as a document
 * without layout can see it.
 *
 * What this proves is the part that decides whether the reader is misled:
 *
 *  - **Which blocks are marked, and how.** A block that left is inside a
 *    `<del>`, one that arrived inside an `<ins>`, and a reworded paragraph
 *    carries the word-level `<del>`/`<ins>` a suggested change carries — the
 *    same elements, the same data attributes, so "the same language" is a
 *    query and not a claim.
 *  - **That the unchanged prose is intact around them.**
 *  - **That the one control says what it does**, names the files, and reaches
 *    the caller when pressed.
 *  - **That the pen is put away and the suggestions are withheld** while the
 *    comparison is up — and said to be, rather than silently absent.
 *  - **That the reading is not replaced.** The view is handed the reading
 *    and the comparison separately, and the `data-src-*` offsets on the
 *    unchanged spans are the reading's.
 *
 * What only a browser can show — where the red lands on the sheet, whether a
 * scroll position survives detection — is not asserted here.
 */

const BEFORE = [
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim has a tpyo in it and it runs on for long enough that the',
  'author wrapped the line, the way a real paper is written, and ends.',
  '',
  'A paragraph that is about to be deleted by the author, entirely.',
  '',
  'A paragraph that stays exactly as it is, to the letter.',
  '',
  '\\end{document}',
  '',
].join('\n')

const AFTER = [
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim has a typo in it and it runs on for long enough that the',
  'author wrapped the line, the way a real paper is written, and ends.',
  '',
  'A paragraph that stays exactly as it is, to the letter.',
  '',
  'A paragraph the author added at the end, after saving.',
  '',
  '\\end{document}',
  '',
].join('\n')

function paperOf(source: string, hash: string): Paper {
  const parsed = parseLatex(source, 'main.tex')
  const blocks: PlacedBlock[] = parsed.blocks.map((b) => ({ ...b, file: 'main.tex' }))
  return {
    epic: 'compared',
    dir: '/tmp/papers/compared',
    title: 'A paper that moved',
    author: null,
    blocks,
    figures: [],
    outline: [],
    files: ['main.tex'],
    hashes: { 'main.tex': hash },
  }
}

const ref = () => ({ current: null as HTMLElement | null })

afterEach(cleanup)

function draw(options: { moved?: boolean; onCatchUp?: (() => void) | null; proposals?: Proposal[]; pen?: boolean } = {}) {
  const reading = paperOf(BEFORE, 'before')
  const disk = paperOf(AFTER, 'after')
  const comparison = options.moved === false ? null : compare(reading, disk)
  const pressed: number[] = []
  const onCatchUp = options.onCatchUp === null ? undefined : (options.onCatchUp ?? (() => pressed.push(1)))
  const { container } = render(
    <PaginatedView
      paper={reading}
      walk={null}
      mark={null}
      rootRef={ref()}
      pen={options.pen ? { commit: async () => null, say: () => {} } : null}
      onPen={() => {}}
      proposals={options.proposals ?? []}
      answering={{ decide: () => {}, acceptAll: () => {}, busy: false }}
      comparison={comparison}
      onCatchUp={onCatchUp}
    />,
  )
  return { container, reading, disk, pressed }
}

describe('the disk laid over the reading', () => {
  test('what left is struck through, what arrived is underlined, and the rest is prose', () => {
    const { container } = draw()
    const gone = container.querySelectorAll('[data-changed-block="gone"]')
    const fresh = container.querySelectorAll('[data-changed-block="new"]')
    expect(gone).toHaveLength(1)
    expect(fresh).toHaveLength(1)
    expect(gone[0]!.tagName).toBe('DEL')
    expect(fresh[0]!.tagName).toBe('INS')
    expect(gone[0]!.textContent).toContain('about to be deleted')
    expect(fresh[0]!.textContent).toContain('added at the end')
    /* The unchanged paragraph is drawn once, as ordinary prose, unmarked. */
    const stayed = Array.from(container.querySelectorAll('.block-row')).filter((row) =>
      row.textContent?.includes('stays exactly as it is'),
    )
    expect(stayed).toHaveLength(1)
    expect(stayed[0]!.getAttribute('data-changed')).toBeNull()
  })

  test('a reworded paragraph carries the same word-level marks a suggested change does', () => {
    const { container } = draw()
    const row = container.querySelector('.block-row[data-changed="changed"]')!
    expect(row).not.toBeNull()
    const out = Array.from(row.querySelectorAll('del[data-proposed="out"]')).map((el) => el.textContent)
    const inn = Array.from(row.querySelectorAll('ins[data-proposed="in"]')).map((el) => el.textContent)
    expect(out).toEqual(['tpyo'])
    expect(inn).toEqual(['typo'])
    /* And it is drawn inside the paragraph, between the words that did not
       change, not as a block of red and a block of green. */
    expect(row.textContent).toContain('The claim has a tpyotypo in it')
    expect(row.querySelector('[data-changed-block]')).toBeNull()
  })

  test('the order on the page is the order on disk, with what left kept where it stood', () => {
    const { container } = draw()
    const rows = Array.from(container.querySelectorAll('.block-row p, .block-row h2, .block-row h3')).map(
      (el) => `${el.closest('.block-row')!.getAttribute('data-changed') ?? 'same'}:${el.textContent!.slice(0, 20)}`,
    )
    expect(rows).toEqual([
      'same:A claim',
      'changed:The claim has a tpyo',
      'gone:A paragraph that is ',
      'same:A paragraph that sta',
      'new:A paragraph the auth',
    ])
  })

  test('the reading is not replaced: unchanged spans still carry the reading’s offsets', () => {
    const { container, reading } = draw()
    const stayed = reading.blocks.find((b) => b.kind === 'paragraph' && b.segments.some((s) => s.text.includes('stays')))!
    const span = Array.from(container.querySelectorAll('[data-src-start]')).find((el) =>
      el.textContent?.includes('stays exactly'),
    )!
    expect(Number(span.getAttribute('data-src-start'))).toBeGreaterThanOrEqual(stayed.srcStart)
    expect(Number(span.getAttribute('data-src-end'))).toBeLessThanOrEqual(stayed.srcEnd)
  })

  test('the control says what it does, names the file, and reaches the caller', () => {
    const { container, pressed } = draw()
    const button = container.querySelector<HTMLButtonElement>('[data-catch-up]')!
    expect(button).not.toBeNull()
    expect(button.textContent).toBe('Read the new version')
    const holder = button.closest('[data-changed-on-disk]')!
    expect(holder.getAttribute('data-changed-on-disk')).toBe('main.tex')
    expect(holder.getAttribute('title')).toContain('main.tex')
    expect(holder.getAttribute('title')).toContain('read the new version')
    /* The counts, in words beside the colour. */
    expect(holder.textContent).toContain('1 reworded')
    expect(holder.textContent).toContain('1 new')
    expect(holder.textContent).toContain('1 gone')
    fireEvent.click(button)
    expect(pressed).toHaveLength(1)
  })

  test('with no comparison, nothing of this is drawn', () => {
    const { container } = draw({ moved: false })
    expect(container.querySelector('[data-catch-up]')).toBeNull()
    expect(container.querySelector('[data-changed-block]')).toBeNull()
    expect(container.querySelector('[data-proposed]')).toBeNull()
  })

  test('with no caller wired, the comparison is drawn and the control is not', () => {
    const { container } = draw({ onCatchUp: null })
    expect(container.querySelector('[data-changed-block]')).not.toBeNull()
    expect(container.querySelector('[data-catch-up]')).toBeNull()
  })

  test('the pen is put away while the comparison is up, and the tick says why', () => {
    const { container } = draw({ pen: true })
    expect(container.querySelector('[data-editable="1"]')).toBeNull()
    expect(container.querySelector('[contenteditable]')).toBeNull()
    const tick = container.querySelector<HTMLButtonElement>('[data-editing]')!
    expect(tick.disabled).toBe(true)
    expect(tick.closest('span')!.getAttribute('title')).toContain('Read the new version first')
  })

  test('suggested changes are withheld from the prose, counted in the row, and said to be', () => {
    const { reading } = draw({ moved: false })
    const block = reading.blocks.find((b) => b.kind === 'paragraph')!
    const proposal: Proposal = {
      id: 'p1',
      file: 'main.tex',
      from: block.srcStart + 15,
      to: block.srcStart + 19,
      text: 'typo',
      was_text: 'tpyo',
      was: 'before',
      why: 'A misspelling.',
      by: 'an agent',
      at: 1,
    }
    cleanup()
    const { container } = draw({ proposals: [proposal] })
    /* No card, no Accept all, and the only marks in the prose are the
       comparison's own. */
    expect(container.querySelector('[data-proposal]')).toBeNull()
    expect(container.querySelector('[data-accept-all]')).toBeNull()
    expect(container.querySelector('.proposed-change[data-proposed-change]')).not.toBeNull()
    const count = container.querySelector('[data-pending-proposals]')!
    expect(count.getAttribute('data-pending-proposals')).toBe('1')
    expect(count.textContent).toContain('1 suggested')
    expect(count.textContent).toContain('drawn once you read the new version')
    expect(count.querySelector('[data-proposals-withheld]')).not.toBeNull()
  })
})
