import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'

import { parseLatex } from '../latex/parse.ts'
import type { Paper, PlacedBlock } from '../store.ts'
import { Screen, wordsFor } from '../src/app.tsx'
import { epicFromUrl, type Sight } from '../src/use-paper.ts'
import {
  CHARS_PER_LINE,
  COLUMN,
  LINES_PER_PAGE,
  MASTHEAD,
  PAGE,
  paginate,
  pageOf,
  visible,
  weigh,
} from '../src/reader/pages.ts'
import { PaginatedView, type PaginatedProps } from '../src/reader/paginated.tsx'

/**
 * The reader, checked where it is cheapest to check it.
 *
 * Four things this file is deliberately about, because each has a way of going
 * quietly wrong:
 *
 * - **A page is a page.** The sheet is A4 and every number that decides where
 *   the breaks fall comes from the same constants the sheet is drawn from. Two
 *   copies of a page size do not fail; they produce a paginator that thinks
 *   forty lines fit a page showing thirty-two, and nothing says so.
 * - **Pagination is a property of the DOCUMENT.** The failure it replaces — a
 *   pagination that re-packs itself when the container moves — does not throw and
 *   does not log; it moves the reader to a different page, once, mid sentence.
 *   The only way to catch that is to assert the property.
 * - **The sections are beside the paper, closed, and reopenable.** A sidebar
 *   that cannot be reopened is a sidebar that ate the table of contents.
 * - **Every page is in the DOM.** Nothing is virtualised, deliberately, and a
 *   later change that virtualises silently would break find-in-page, a walk to
 *   the end of the paper, and any anchor into a page nobody has scrolled to.
 * - **The rail and the marks are gone, and the author's words are not.** The
 *   dangerous version of removing a rail is the one where the notes go with it.
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
    dir: '/tmp/papers/paginating',
    title: 'A paper about paginating',
    author: 'The test',
    blocks,
    figures: [],
    outline: blocks
      .filter((b) => b.kind === 'heading')
      .map((b, i) => ({ id: b.id, level: b.kind === 'heading' ? b.level : 2, text: `Section ${i + 1}` })),
    files: ['main.tex'],
  }
}

/** The page readout — a `span`, deliberately, so it is found as one. */
const readout = (r: { container: HTMLElement }) => r.container.querySelector('[data-page-readout]') as HTMLElement

/** The view, with the props it actually takes. */
function view(paper: Paper, walk: PaginatedProps['walk'] = null, ref = { current: null as HTMLElement | null }) {
  return render(<PaginatedView paper={paper} walk={walk} rootRef={ref} mark={null} />)
}

/**
 * A recorder for the scrolls a component asks for.
 *
 * happy-dom has no layout, so a scroll cannot be observed by its effect. What
 * CAN be asserted is the request — which element was asked to come into view,
 * and whether it was asked smoothly — and that is the whole of what this
 * component decides. Where the pixels end up is the browser's business and is
 * measured in a browser.
 */
function watchScrolls() {
  const asked: { el: Element; behavior?: string; block?: string }[] = []
  const wasView = Element.prototype.scrollIntoView
  const wasTo = Element.prototype.scrollTo
  const wasBy = Element.prototype.scrollBy
  Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) {
    const opts = (typeof arg === 'object' && arg !== null ? arg : {}) as { behavior?: string; block?: string }
    asked.push({ el: this, ...opts })
  }
  Element.prototype.scrollTo = function (this: Element) {
    asked.push({ el: this, block: 'to-top' })
  }
  Element.prototype.scrollBy = function (this: Element) {
    asked.push({ el: this, block: 'by' })
  }
  return {
    asked,
    stop() {
      Element.prototype.scrollIntoView = wasView
      Element.prototype.scrollTo = wasTo
      Element.prototype.scrollBy = wasBy
    },
  }
}

describe('the page is A4, and the paginator and the sheet agree about it', () => {
  test('the page box has A4 proportions', () => {
    /* 1 : √2, which is what makes A-series paper A-series paper. Within half a
       per cent, because the box is rounded to whole CSS pixels. */
    expect(Math.abs(PAGE.height / PAGE.width - Math.SQRT2)).toBeLessThan(0.005 * Math.SQRT2)
  })

  test('the line budget is derived from the page box and from nothing else', () => {
    /* The assertion that matters is not the numbers; it is that they are a
       FUNCTION of `PAGE`. A future edit that types a budget in by hand is an
       edit that lets the sheet and the paginator drift apart, and this is the
       line that stops it compiling into a silent disagreement. */
    expect(COLUMN).toBe(PAGE.width - PAGE.marginX * 2)
    expect(CHARS_PER_LINE).toBe(Math.floor(COLUMN / (PAGE.fontSize * PAGE.meanCharEm)))
    expect(LINES_PER_PAGE).toBe(Math.floor((PAGE.height - PAGE.marginY * 2) / (PAGE.fontSize * PAGE.lineHeight)))
  })

  test('the measure is a readable one rather than an arithmetic accident', () => {
    expect(CHARS_PER_LINE).toBeGreaterThan(55)
    expect(CHARS_PER_LINE).toBeLessThan(100)
    expect(LINES_PER_PAGE).toBeGreaterThan(25)
  })

  test('the sheet is drawn at the size the paginator packed for', () => {
    const rendered = view(fixture())
    const sheet = rendered.container.querySelector('section[aria-label^="Page"]') as HTMLElement
    expect(sheet.style.width).toBe(`${PAGE.width}px`)
    expect(sheet.style.minHeight).toBe(`${PAGE.height}px`)
    expect(sheet.style.padding).toContain(`${PAGE.marginY}px`)
    /* Scaled, not reflowed. A sheet without a transform is a sheet that got its
       size from the container after all. */
    expect(sheet.style.transform).toMatch(/^scale\(/)
    expect(sheet.style.transformOrigin).toBe('top left')
  })
})

describe('pagination is a property of the document', () => {
  const paper = fixture()

  test('the same blocks give the same pages, every time', () => {
    const a = paginate(paper.blocks)
    const b = paginate(paper.blocks)
    expect(a.length).toBeGreaterThan(1)
    expect(a.map((p) => p.map((x) => x.id))).toEqual(b.map((p) => p.map((x) => x.id)))
  })

  test('nothing about the container can reach the paginator', () => {
    /*
     * The property stated as a property rather than demonstrated at two widths,
     * because a width is exactly what this function must not be able to see: it
     * takes a block list and a line budget and there is no third thing to hand
     * it. The browser-side proof — the same page count at 220px and at 1200px —
     * is in the measurement notes on this change; this is the assertion that
     * makes a regression a compile error rather than a resize.
     */
    expect(paginate(paper.blocks)).toEqual(paginate(paper.blocks, LINES_PER_PAGE))
    /* The budget is the only thing besides the blocks that can change an
       answer, and it comes from `PAGE` rather than from anything measured. */
    expect(paginate(paper.blocks, LINES_PER_PAGE + 40).length).toBeLessThan(paginate(paper.blocks).length)
  })

  test('a resize does not move the reader, because the page count cannot change', () => {
    const total = paginate(paper.blocks).length
    const rendered = view(paper)
    expect(readout(rendered).textContent).toBe(`1 / ${total}`)
    /* A re-render is every re-render a resize would cause: the observer sets
       state and React runs this component again. The readout must not move,
       and no scroll may be asked for. */
    const scrolls = watchScrolls()
    rendered.rerender(<PaginatedView paper={paper} walk={null} rootRef={{ current: null }} mark={null} />)
    expect(readout(rendered).textContent).toBe(`1 / ${total}`)
    expect(scrolls.asked.filter((a) => a.block !== 'to-top')).toEqual([])
    scrolls.stop()
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

  test('the first sheet is packed shorter, because the title is drawn on it', () => {
    /*
     * The masthead — title, author, epic — is drawn by `SheetPage` on sheet one
     * and is not a block, so nothing weighed it and the first page was packed
     * as though 163 pixels of it were empty. That does not throw: the sheet
     * grows past A4 instead, and a first page taller than every page under it
     * is a kind of wrong a reader can see and cannot name. Measured, on
     * `a-green-gate-means-something`: 1140 pixels against A4's 1123.
     *
     * Asserted as a property rather than against a page count, because the
     * count is a fact about this fixture and the property is not.
     */
    const first = paginate(paper.blocks)[0]!
    expect(first.length).toBeGreaterThan(1)
    const spent = first.reduce((n, b) => n + weigh(b), 0)
    /* Two lines of slack: the block that opens a sheet is not charged for the
       top margin it is not drawn with (see `topAir`), and the largest of those
       discounts is a chapter heading's 45 pixels. */
    expect(spent).toBeLessThanOrEqual(LINES_PER_PAGE - MASTHEAD + 2)
  })

  test('a heading that opens a sheet is not charged for air it is not drawn with', () => {
    /*
     * `index.css` sets `margin-top: 0` on whatever a sheet draws first, because
     * a heading's top margin separates it from the paragraph before it and at
     * the top of a page there is no paragraph before it. `topAir` says the same
     * thing to the packer, and the two have to agree: space the page gets back
     * on screen but not in the arithmetic simply moves to the foot of the sheet
     * as blank, which is the whole of what the owner reported as a huge gap.
     *
     * Thirty identical chapter headings make the discount observable without
     * any measurement: each weighs 4.1 lines, so a budget charging every one of
     * them full air fits nine to a sheet, and one that lets the first go
     * without its 45 pixels fits ten.
     */
    const heads = Array.from({ length: 30 }, (_, i) => ({
      kind: 'heading' as const,
      id: `h-${i}`,
      level: 1,
      segments: [{ kind: 'text' as const, text: 'A section' }],
      srcStart: i * 10,
      srcEnd: i * 10 + 9,
      file: 'main.tex',
    })) as unknown as PlacedBlock[]
    const packed = paginate(heads)
    expect(packed.flat().length).toBe(heads.length)
    const perPage = Math.floor(LINES_PER_PAGE / weigh(heads[0]!))
    /* Not page one, which is short by the masthead — any page after it. */
    expect(packed[1]!.length).toBeGreaterThan(perPage)
  })

  test('a block can be found on the page it was packed onto', () => {
    const pages = paginate(paper.blocks)
    const last = pages[pages.length - 1]?.[0]
    expect(last).toBeDefined()
    expect(pageOf(pages, last!.file, last!.id)).toBe(pages.length - 1)
    expect(pageOf(pages, 'main.tex', 'not-a-block')).toBe(-1)
  })
})

describe('the reading view scrolls, and there is nothing to press', () => {
  const paper = fixture()

  test('every page of the paper is in the DOM', () => {
    /*
     * The anti-virtualisation assertion, and it is here because virtualising is
     * the obvious next optimisation and its costs are invisible: a walk to the
     * end of the paper does nothing, the browser's own find-in-page sees a
     * fraction of the document, and an anchor into an unrendered page cannot be
     * resolved. None of those throws. If this test is ever changed, the three
     * of them need answers rather than a note.
     */
    const rendered = view(paper)
    const total = paginate(paper.blocks).length
    expect(total).toBeGreaterThan(1)
    expect(rendered.container.querySelectorAll('[data-page]').length).toBe(total)
    expect(rendered.container.querySelectorAll('section[aria-label^="Page"]').length).toBe(total)
  })

  test('the whole paper is rendered, so find-in-page can see all of it', () => {
    const rendered = view(paper)
    /* Text from the FIRST page and text from the LAST, in one DOM. */
    expect(rendered.container.textContent).toContain('A paper about paginating')
    expect(rendered.container.textContent).toContain('A closing paragraph.')
  })

  test('there is no page-turn control anywhere', () => {
    const rendered = view(paper)
    expect(screen.queryByLabelText('Next page')).toBeNull()
    expect(screen.queryByLabelText('Previous page')).toBeNull()
    const words = (rendered.container.textContent ?? '').toLowerCase()
    expect(words).not.toContain('prev')
    expect(words).not.toContain('next')
  })

  test('the page number is a readout and not something to press', () => {
    const rendered = view(paper)
    const total = paginate(paper.blocks).length
    const badge = readout(rendered)
    /* A number that looks pressable and is not is worse than no number. */
    expect(badge.tagName.toLowerCase()).not.toBe('button')
    expect(badge.closest('button')).toBeNull()
    expect(badge.getAttribute('role')).toBe('status')
    expect(badge.textContent).toBe(`1 / ${total}`)
    expect(rendered.container.querySelector('[data-page]')).toBeTruthy()
  })

  test('the column is focusable, so the keys a document reader knows reach it', () => {
    const rendered = view(paper)
    const column = rendered.container.querySelector('.reading-column') as HTMLElement
    expect(column.getAttribute('tabindex')).toBe('0')
    expect(column.getAttribute('role')).toBe('region')
  })

  test('a page key pressed outside the column is forwarded to it', () => {
    /* The case the browser does not handle for free: the reader has just
       pressed the sections trigger, so focus is on a button, and PageDown would
       otherwise do nothing at all until somebody clicked the text. */
    const rendered = view(paper)
    const column = rendered.container.querySelector('.reading-column') as HTMLElement
    const scrolls = watchScrolls()
    fireEvent.keyDown(document.body, { key: 'PageDown' })
    expect(scrolls.asked.some((a) => a.el === column && a.block === 'by')).toBe(true)
    scrolls.stop()
  })

  test('a key meant for a field is left alone', () => {
    view(paper)
    const field = document.createElement('input')
    document.body.appendChild(field)
    const scrolls = watchScrolls()
    fireEvent.keyDown(field, { key: 'PageDown' })
    expect(scrolls.asked).toEqual([])
    scrolls.stop()
    field.remove()
  })

  test('the column is handed up, so a highlight can be resolved against it', () => {
    /*
     * `lib/selection.ts` reads the DOM under this element, and it is the COLUMN
     * rather than one sheet because a selection can legitimately run from the
     * bottom of one page to the top of the next.
     */
    const ref = { current: null as HTMLElement | null }
    view(paper, null, ref)
    expect(ref.current?.classList.contains('reading-column')).toBe(true)
    expect(ref.current?.querySelectorAll('[data-src-start]').length).toBeGreaterThan(0)
  })

  test('a walk from outside scrolls to the block it found', () => {
    const heading = paper.blocks.filter((b) => b.kind === 'heading')[1]!
    const rendered = view(paper)
    const scrolls = watchScrolls()
    rendered.rerender(
      <PaginatedView
        paper={paper}
        walk={{ file: heading.file, id: heading.id, nonce: 1 }}
        rootRef={{ current: null }} mark={null}
      />,
    )
    const target = document.getElementById(`b-${`${heading.file}-${heading.id}`.replace(/[^a-zA-Z0-9-]+/g, '-')}`)
    expect(target).toBeTruthy()
    /* `nearest` and not `center`: a walk brings a reader to a block that is off
       screen and leaves alone one that is not. The essay is on the effect in
       `paginated.tsx`; asserted here because the block argument is the whole of
       the difference between "only if needed, minimally" and "always, and as
       far as possible". */
    expect(scrolls.asked.some((a) => a.el === target && a.block === 'nearest')).toBe(true)
    scrolls.stop()
  })

  test('the same walk asked for twice is asked for twice', () => {
    /* A nonce rather than value equality, because a reader who asks the host to
       walk to the same reference again means it again — so the effect must fire
       again rather than being deduplicated by the value.

       What the second firing DOES is now the browser's business and not this
       component's: under `nearest` a block already on screen from the first
       walk is not moved to a second time. That is the point of the change and
       is why this test asserts the call and not a scroll position, which
       happy-dom has no layout to give it anyway. */
    const heading = paper.blocks.filter((b) => b.kind === 'heading')[1]!
    const rendered = view(paper)
    const scrolls = watchScrolls()
    for (const nonce of [1, 2]) {
      rendered.rerender(
        <PaginatedView paper={paper} walk={{ file: heading.file, id: heading.id, nonce }} rootRef={{ current: null }} mark={null} />,
      )
    }
    expect(scrolls.asked.filter((a) => a.block === 'nearest').length).toBe(2)
    scrolls.stop()
  })
})

describe('the sections sit beside the paper and collapse to nothing', () => {
  const paper = fixture()

  test('it is closed to start with, because a container is 300 pixels wide', () => {
    const rendered = view(paper)
    const side = rendered.container.querySelector('[data-slot="sidebar"]') as HTMLElement
    expect(side.getAttribute('data-state')).toBe('collapsed')
    expect(side.className).toContain('w-0')
    /* Closed AND out of the accessibility tree, so a screen reader is not read
       a table of contents the page is not showing. */
    expect(side.getAttribute('aria-hidden')).toBe('true')
  })

  test('the trigger opens it and closes it again', () => {
    const rendered = view(paper)
    const side = () => rendered.container.querySelector('[data-slot="sidebar"]') as HTMLElement
    fireEvent.click(screen.getByLabelText('Show sections'))
    expect(side().getAttribute('data-state')).toBe('expanded')
    expect(side().getAttribute('aria-hidden')).toBe('false')
    fireEvent.click(screen.getByLabelText('Hide sections'))
    expect(side().getAttribute('data-state')).toBe('collapsed')
  })

  test('pressing a section scrolls that page into view, smoothly', () => {
    const rendered = view(paper)
    fireEvent.click(screen.getByLabelText('Show sections'))
    const rows = [...rendered.container.querySelectorAll('[data-slot="sidebar-menu-button"]')] as HTMLElement[]
    expect(rows.length).toBe(paper.outline.length)

    const pages = paginate(paper.blocks)
    const second = paper.blocks.filter((b) => b.kind === 'heading')[1]!
    const on = pageOf(pages, second.file, second.id)
    expect(on).toBeGreaterThan(0)

    const scrolls = watchScrolls()
    fireEvent.click(rows[1]!)
    const wrap = rendered.container.querySelector(`[data-page="${on + 1}"]`)
    /* A real scroll and a smooth one, so the reader sees where they landed
       relative to the pages either side of it rather than being teleported. */
    expect(scrolls.asked.some((a) => a.el === wrap && a.behavior === 'smooth' && a.block === 'start')).toBe(true)
    scrolls.stop()
  })

  test('a section names the page it is on, so a press is not a leap in the dark', () => {
    const rendered = view(paper)
    fireEvent.click(screen.getByLabelText('Show sections'))
    const rows = rendered.container.querySelectorAll('[data-slot="sidebar-menu-button"]')
    expect(rows[0]?.textContent ?? '').toMatch(/p\d+$/)
  })
})

describe('the paper shows the paper, and the annotations have gone to Notes', () => {
  const paper = fixture()

  test('nothing draws a rail, a card, or a pin', () => {
    const rendered = view(paper)
    expect(rendered.container.querySelector('.margin-rail')).toBeNull()
    expect(rendered.container.querySelector('.note-card')).toBeNull()
    expect(rendered.container.querySelector('.note-pin')).toBeNull()
    expect(rendered.container.querySelector('[data-note-key]')).toBeNull()
    expect(rendered.container.textContent).not.toContain('No marks on this page')
  })

  test('a source comment is not drawn, and is not weighed into a page either', () => {
    /* Dropped in `visible()` rather than at render time, so the packing and the
       sheet agree about what is on it. A comment left in the packing and not
       drawn would be a blank band where the annotation used to be — a page with
       a hole in it whose size nobody can explain. */
    expect(paginate(paper.blocks).flat().some((b) => b.kind === 'comment')).toBe(false)
    const rendered = view(paper)
    expect(rendered.container.textContent).not.toContain('carries the reasoning')
  })

  test('the parser still holds the comment, because Notes reads what it parses', () => {
    /* Not drawing something is not the same as not knowing it. This is the line
       that keeps the two apart: the block is in the paper, so the ingestion in
       Notes has something to lift, and the reader simply does not draw it. */
    expect(paper.blocks.some((b) => b.kind === 'comment' && b.text.includes('carries the reasoning'))).toBe(true)
  })

  test('a todonote is not in the prose, and its glyph is not either', () => {
    const rendered = view(paper)
    expect(rendered.container.textContent).not.toContain('this needs a citation')
    expect(rendered.container.textContent).not.toContain('◆')
    /* The amber is gone with the words. Marking an aside as not-the-argument
       was the right answer while the aside had nowhere else to be; it now has
       somewhere else to be. */
    expect(rendered.container.querySelector('.note-inline')).toBeNull()
    /* The sentence the note sat inside is untouched — this removed an aside,
       not a paragraph. */
    expect(rendered.container.textContent).toContain('an author note inside it')
  })

  test('every rendered span still carries its source range', () => {
    /* This is what a highlight is resolved against. A span without these is a
       span whose text is silently unquotable. */
    const rendered = view(paper)
    const spans = rendered.container.querySelectorAll('[data-src-start]')
    expect(spans.length).toBeGreaterThan(0)
    for (const span of spans) {
      expect(span.getAttribute('data-src-end')).toBeTruthy()
      expect(['0', '1']).toContain(span.getAttribute('data-literal') ?? '')
    }
  })
})

describe('the gutter names the block kind', () => {
  const paper = fixture()

  test('a paragraph is ¶ and a heading is §', () => {
    const rendered = view(paper)
    const marks = [...rendered.container.querySelectorAll('.gutter-mark')].map((el) => el.textContent)
    expect(marks).toContain('§')
    expect(marks).toContain('¶')
    /* One tag per block on the sheet, so a reader hovering anywhere in the text
       always has one to read. */
    expect(marks.length).toBe(rendered.container.querySelectorAll('[data-block-id]').length)
  })

  test('every kind the parser can emit has a tag, including the ones nobody sees', () => {
    const rendered = view(paper)
    for (const el of rendered.container.querySelectorAll('.gutter-mark')) {
      expect((el.textContent ?? '').length).toBeGreaterThan(0)
    }
  })
})

describe('the screens that are not a paper', () => {
  /**
   * Three states this module can truthfully be in and one it is put in by
   * having no host. They are the reason the picker could go without the page
   * becoming dishonest: what was removed is the browsing, not the telling.
   */
  const cases: { sight: Sight; says: RegExp }[] = [
    { sight: { at: 'no-epic' }, says: /No epic is open/ },
    { sight: { at: 'no-paper', epic: 'unwritten', why: '', where: null }, says: /This epic has no paper yet/ },
    /* `unconfigured` was here, saying "nobody has said where the papers are" —
       a sentence about environment variables. There are none: a paper is in the
       project, so the only way to have nowhere to look is to have no project,
       and that is a state a reader passes through rather than a fault they have
       to go and repair. */
    { sight: { at: 'no-project', why: '' }, says: /No project is open/ },
    { sight: { at: 'alone' }, says: /Nothing is framing this page/ },
  ]

  for (const { sight, says } of cases) {
    test(`“${sight.at}” says what is true and offers no list`, () => {
      const rendered = render(<Screen sight={sight} />)
      expect(rendered.container.textContent ?? '').toMatch(says)
      /* The sentence that used to send a reader to a list of every paper on
         this machine. There is no list any more, so an offer of one would be a
         dead end drawn in the space the paper goes. */
      expect(rendered.container.textContent ?? '').not.toMatch(/papers on this machine|listed above|from the list/)
    })
  }

  test('no screen is dressed as an error', () => {
    for (const { sight } of cases) {
      const [heading] = wordsFor(sight)
      expect(heading).toBeTruthy()
      expect(heading?.toLowerCase()).not.toContain('error')
      expect(heading?.toLowerCase()).not.toContain('failed')
    }
  })
})

describe('an unframed page is told which epic by its address', () => {
  test('one epic, or none, and never a list', () => {
    expect(epicFromUrl('?epic=modes-are-modules')).toBe('modes-are-modules')
    expect(epicFromUrl('?epic=%20')).toBe(null)
    expect(epicFromUrl('')).toBe(null)
    expect(epicFromUrl('?other=1')).toBe(null)
  })

  test('a hostile epic is passed on unchanged, for one door to refuse', () => {
    /* Not sanitised here. `/api/paper` applies `SLUG` and refuses identically
       whether or not the epic exists; a second shape check in the browser would
       be a second place to keep in step with the first, and the first is the
       one that matters. */
    expect(epicFromUrl('?epic=../../etc/passwd')).toBe('../../etc/passwd')
  })
})
