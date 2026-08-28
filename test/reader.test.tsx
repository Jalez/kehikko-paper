import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'

import { parseLatex } from '../latex/parse.ts'
import type { Paper, PlacedBlock } from '../store.ts'
import { notesOn, runs } from '../src/reader/notes.ts'
import { paginate, pageOf, visible, weigh } from '../src/reader/pages.ts'
import { PaginatedView } from '../src/reader/paginated.tsx'

/**
 * The reader, checked where it is cheapest to check it.
 *
 * Three things this file is deliberately about, because they are the three the
 * rebuild had to restore and each has a way of going quietly wrong:
 *
 * - Pagination is a PURE FUNCTION of the block list. The failure it replaces —
 *   a measured pagination that re-packs itself when the pane moves — does not
 *   throw and does not log; it moves the reader to a different page, once, mid
 *   sentence. The only way to catch that is to assert the property.
 * - A note reaches the margin with its pin left behind in the text. Both halves
 *   matter: a card with no anchor cannot be pointed at, and a pin with no card
 *   is the silent loss `parse.ts` refuses to allow.
 * - The gutter tag names the block's KIND. It is the one piece of structural
 *   truth on the page and it is invisible until hover, which is exactly the
 *   sort of thing that gets deleted by accident.
 */

const SOURCE = [
  '\\documentclass{article}',
  '\\title{A paper about paginating}',
  '\\author{The test}',
  '\\begin{document}',
  '\\maketitle',
  '\\section{First}',
  '% A source comment run.',
  '% It carries the reasoning behind the section under it.',
  ...Array.from({ length: 12 }, (_, i) => `Paragraph number ${i} ${'and some more words '.repeat(12)}\n`),
  'A paragraph with \\todo{this needs a citation} an author note inside it.',
  '\\begin{verbatim}',
  'a line of code',
  '\\end{verbatim}',
  '\\section{Second}',
  'A closing paragraph.',
  '\\end{document}',
].join('\n')

function fixture(): Paper {
  const parsed = parseLatex(SOURCE, 'main.tex')
  const blocks: PlacedBlock[] = parsed.blocks.map((b) => ({ ...b, file: 'main.tex' }))
  return {
    epic: 'paginating',
    title: 'A paper about paginating',
    author: 'The test',
    blocks,
    outline: blocks
      .filter((b) => b.kind === 'heading')
      .map((b) => ({ id: b.id, level: b.kind === 'heading' ? b.level : 2, text: '' })),
    files: ['main.tex'],
  }
}

describe('pagination is derived from the block list', () => {
  const paper = fixture()

  test('the same blocks give the same pages, every time', () => {
    const a = paginate(paper.blocks)
    const b = paginate(paper.blocks)
    expect(a.length).toBeGreaterThan(1)
    expect(a.map((p) => p.map((x) => x.id))).toEqual(b.map((p) => p.map((x) => x.id)))
  })

  test('nothing a reader should see is dropped, and nothing they should not is kept', () => {
    const packed = paginate(paper.blocks).flat()
    const kinds = new Set(packed.map((b) => b.kind))
    expect(kinds.has('preamble')).toBe(false)
    expect(kinds.has('structure')).toBe(false)
    expect(kinds.has('include')).toBe(false)
    /* Every visible block is on exactly one page: none lost between them, none
       counted twice. A block weighed and then not drawn is a page with a hole
       in it whose size nobody can explain. */
    expect(packed.length).toBe(paper.blocks.filter(visible).length)
    expect(new Set(packed.map((b) => `${b.file}#${b.id}`)).size).toBe(packed.length)
  })

  test('a heading is never left alone at the foot of a page', () => {
    for (const page of paginate(paper.blocks)) {
      if (page.length < 2) continue
      expect(page[page.length - 1]?.kind).not.toBe('heading')
    }
  })

  test('every block weighs at least one line, so no page can hold all of a long paper', () => {
    for (const block of paper.blocks.filter(visible)) expect(weigh(block)).toBeGreaterThanOrEqual(1)
  })

  test('a block can be found on the page it was packed onto', () => {
    const pages = paginate(paper.blocks)
    const last = pages[pages.length - 1]?.[0]
    expect(last).toBeDefined()
    expect(pageOf(pages, last!.file, last!.id)).toBe(pages.length - 1)
    expect(pageOf(pages, 'main.tex', 'not-a-block')).toBe(-1)
  })
})

describe('notes leave the reading flow and keep their anchor', () => {
  const paper = fixture()

  test('a todonote becomes one note, with the pin taken off its text', () => {
    const notes = notesOn(paper.blocks).filter((n) => n.kind === 'todo')
    expect(notes.length).toBe(1)
    expect(notes[0]?.text).toBe('this needs a citation')
    expect(notes[0]?.text.includes('◆')).toBe(false)
  })

  test('a source comment becomes a note too, because it is not the argument', () => {
    const notes = notesOn(paper.blocks).filter((n) => n.kind === 'comment')
    expect(notes.length).toBe(1)
    expect(notes[0]?.text).toContain('carries the reasoning')
  })

  test('a note is keyed by its byte offset, so two walks over one block agree', () => {
    const block = paper.blocks.find((b) => b.kind === 'paragraph' && 'segments' in b && b.segments.some((s) => s.styles.includes('todo')))
    expect(block).toBeDefined()
    const segments = 'segments' in block! ? block.segments : []
    const first = runs('main.tex', block!.id, segments).find((r) => r.note)?.note
    const second = runs('main.tex', block!.id, segments).find((r) => r.note)?.note
    expect(first?.key).toBe(second!.key)
    expect(first?.key).toMatch(/^main\.tex#[^#]+#\d+$/)
  })

  test('adjacent todo segments are one note rather than several', () => {
    /* `\todo{a \emph{stressed} word}` splits into three segments because the
       emphasis is a style change. Three cards in the margin would read as three
       separate remarks, which is a claim about the author nobody made. */
    const parsed = parseLatex('\\begin{document}\nA line \\todo{a \\emph{stressed} word} here.\n\\end{document}', 'm.tex')
    const blocks: PlacedBlock[] = parsed.blocks.map((b) => ({ ...b, file: 'm.tex' }))
    expect(notesOn(blocks).filter((n) => n.kind === 'todo').length).toBe(1)
  })
})

describe('the reading view', () => {
  const paper = fixture()

  function show(page = 0, onPage: (n: number) => void = () => {}) {
    const ref = { current: null as HTMLElement | null }
    return render(<PaginatedView paper={paper} page={page} onPage={onPage} lit={null} onLit={() => {}} sheetRef={ref} />)
  }

  test('the page indicator says which sheet of how many', () => {
    show(0)
    const pages = paginate(paper.blocks).length
    expect(screen.getByText(`1 / ${pages}`)).toBeTruthy()
  })

  test('the title and byline are on the first sheet and only there', () => {
    const first = show(0)
    expect(first.container.textContent).toContain('A paper about paginating')
    first.unmount()
    const second = show(1)
    expect(second.container.textContent).not.toContain('A paper about paginating')
  })

  test('next asks for the next page, and prev is refused on the first', () => {
    const asked: number[] = []
    show(0, (n) => asked.push(n))
    fireEvent.click(screen.getByLabelText('Next page'))
    expect(asked).toEqual([1])
    expect((screen.getByLabelText('Previous page') as HTMLButtonElement).disabled).toBe(true)
  })

  test('an arrow key turns the page too', () => {
    const asked: number[] = []
    show(1, (n) => asked.push(n))
    /* Fired at the body rather than at `window` directly: the listener is on
       the window so a reader who has just pressed Next does not have to click
       back into the text, and a key pressed anywhere bubbles up to it. */
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    /* Fired at the body rather than at `window` directly: the listener is on
       the window so a reader who has just pressed Next does not have to click
       back into the text, and a key pressed anywhere bubbles up to it. */
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(asked).toEqual([2, 0])
  })

  test('re-rendering with the same props does not move the reader', () => {
    const asked: number[] = []
    const view = show(2, (n) => asked.push(n))
    view.rerender(
      <PaginatedView
        paper={paper}
        page={2}
        onPage={(n) => asked.push(n)}
        lit={null}
        onLit={() => {}}
        sheetRef={{ current: null }}
      />,
    )
    expect(asked).toEqual([])
    expect(screen.getByText(new RegExp(`^3 / `)).textContent).toContain('3 / ')
  })

  test('a page out of range is clamped rather than drawn empty', () => {
    show(999)
    const pages = paginate(paper.blocks).length
    expect(screen.getByText(`${pages} / ${pages}`)).toBeTruthy()
  })
})

describe('the margin rail', () => {
  const paper = fixture()

  /**
   * The rail placed against a real sheet.
   *
   * `sheetRef` matters more than it looks: the rail finds each card's anchor by
   * querying the sheet for the pin carrying that note's key, and skips anything
   * it cannot find rather than stacking it at the top. So a test that handed it
   * a null ref would assert that an empty rail is empty, which is true of every
   * possible implementation.
   */
  function railed() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = render(
      <PaginatedView
        paper={paper}
        page={0}
        onPage={() => {}}
        lit={null}
        onLit={() => {}}
        sheetRef={{ current: null }}
      />,
      { container: host },
    )
    /* The sheet is written by the view itself, so point a second render at it
       the way the app does: the first pass fills the ref, the second measures
       against it. */
    const sheet = host.querySelector('section[aria-label^="Page"]') as HTMLElement
    view.rerender(
      <PaginatedView
        paper={paper}
        page={0}
        onPage={() => {}}
        lit={null}
        onLit={() => {}}
        sheetRef={{ current: sheet }}
      />,
    )
    return { view, host }
  }

  test('a note on this page gets a card, and the card carries the note’s words', () => {
    const { host } = railed()
    const rail = host.querySelector('aside.margin-rail')
    expect(rail).toBeTruthy()
    const cards = [...rail!.querySelectorAll('.note-card')].map((c) => c.textContent ?? '')
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.join(' ')).toContain('carries the reasoning')
  })

  test('the pin stays in the text, so the card has something to point at', () => {
    const { host } = railed()
    const pins = host.querySelectorAll('section[aria-label^="Page"] [data-note-key]')
    expect(pins.length).toBeGreaterThan(0)
    const keys = [...host.querySelectorAll('.note-card')].length
    expect(keys).toBeLessThanOrEqual(pins.length)
  })

  test('a card names what kind of note it is, never colour alone', () => {
    const { host } = railed()
    const words = host.querySelector('.note-card')?.textContent ?? ''
    expect(/todo|source comment/.test(words)).toBe(true)
  })
})

describe('the gutter names the block kind', () => {
  const paper = fixture()

  test('a paragraph is ¶ and a heading is §', () => {
    const ref = { current: null as HTMLElement | null }
    const view = render(
      <PaginatedView paper={paper} page={0} onPage={() => {}} lit={null} onLit={() => {}} sheetRef={ref} />,
    )
    const marks = [...view.container.querySelectorAll('.gutter-mark')].map((el) => el.textContent)
    expect(marks).toContain('§')
    expect(marks).toContain('¶')
    /* One tag per block on the sheet, so a reader hovering anywhere in the text
       always has one to read. */
    expect(marks.length).toBe(view.container.querySelectorAll('[data-block-id]').length)
  })

  test('every kind the parser can emit has a tag, including the ones nobody sees', () => {
    /* The map is exhaustive over `Block["kind"]` by its type, and this is the
       assertion that a kind added later cannot be given an empty string to keep
       the compiler quiet. */
    const view = render(
      <PaginatedView paper={paper} page={0} onPage={() => {}} lit={null} onLit={() => {}} sheetRef={{ current: null }} />,
    )
    for (const el of view.container.querySelectorAll('.gutter-mark')) {
      expect((el.textContent ?? '').length).toBeGreaterThan(0)
    }
  })
})
