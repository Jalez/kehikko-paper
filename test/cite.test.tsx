import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { Segment } from '../latex/parse.ts'
import { coalesce, Segments } from '../src/reader/segments.tsx'

/**
 * A resolved citation and a resolved reference, drawn.
 *
 * Reading "(VanLehn, 2011)" answers what is cited; the card answers whether it
 * is the source the author meant and where to read it, and "Chapter 2" is only
 * worth drawing as a link if pressing it goes somewhere. Driven in a DOM
 * because the question is whether a press does anything at all, which markup
 * alone cannot say.
 */

function cite(text: string, srcStart: number, keys: string[], links = true): Segment {
  return {
    text,
    srcStart,
    srcEnd: srcStart + 20,
    literal: false,
    styles: ['cite'],
    keys,
    cmd: 'autocite',
    note: keys.map((k) => `${k} · entry`).join('\n'),
    sources: keys.map((key, i) => ({
      key,
      label: `Author${i} (200${i})`,
      detail: `Author${i} · 200${i} · A Paper [${key}]`,
      link: links ? `https://doi.org/10.1/${key}` : null,
    })),
  }
}

function ref(text: string, srcStart: number, key: string, target?: { file: string; id: string }): Segment {
  return {
    text,
    srcStart,
    srcEnd: srcStart + 12,
    literal: false,
    styles: ['ref'],
    keys: [key],
    cmd: 'ref',
    note: target ? 'Chapter 2 — Conclusion' : `${key} — no such label in the paper`,
    ...(target ? { target } : { unresolved: true }),
  }
}

function literal(text: string, srcStart: number): Segment {
  return { text, srcStart, srcEnd: srcStart + text.length, literal: true, styles: [] }
}

const draw = (segments: Segment[]) => render(<Segments segments={segments} />)

/* The card is portalled to `document.body`, so it outlives a test's own
   container unless the render is unmounted — and a card left over from the
   test before would be found by the test after. */
afterEach(cleanup)

const card = (_r: { container: HTMLElement }) => document.querySelector('[data-cite-card]')

describe('clicking a citation', () => {
  test('opens a card naming the source, and a second click closes it', () => {
    const r = draw([literal('As shown ', 0), cite('(Author0, 2000)', 9, ['key0'])])
    const opener = r.container.querySelector<HTMLElement>('[role="button"]')!
    expect(opener).not.toBeNull()
    expect(card(r)).toBeNull()
    fireEvent.click(opener)
    expect(card(r)?.textContent).toContain('Author0 (2000)')
    fireEvent.click(opener)
    expect(card(r)).toBeNull()
  })

  test('offers a link for every key in the citation, not only the first', () => {
    const r = draw([cite('(Author0, 2000; Author1, 2001)', 0, ['key0', 'key1'])])
    fireEvent.click(r.container.querySelector<HTMLElement>('[role="button"]')!)
    const links = [...card(r)!.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://doi.org/10.1/key0', 'https://doi.org/10.1/key1'])
    expect(links.every((a) => a.getAttribute('target') === '_blank')).toBe(true)
    expect(links.every((a) => (a.getAttribute('rel') ?? '').includes('noopener'))).toBe(true)
    /* The name of the source is the link itself, so reading it is one click. */
    expect(links[0]?.textContent).toBe('Author0 (2000)')
  })

  test('says so when an entry records nowhere to go', () => {
    const r = draw([cite('(Author0, 2000)', 0, ['key0'], false)])
    fireEvent.click(r.container.querySelector<HTMLElement>('[role="button"]')!)
    expect(card(r)!.querySelectorAll('a')).toHaveLength(0)
    expect(card(r)?.textContent).toContain('No DOI or link')
  })

  test('the span still carries its source range, so the passage stays quotable', () => {
    const r = draw([cite('(Author0, 2000)', 9, ['key0'])])
    const span = r.container.querySelector<HTMLElement>('[data-src-start]')!
    expect(span.dataset.srcStart).toBe('9')
    expect(span.dataset.srcEnd).toBe('29')
    expect(span.dataset.literal).toBe('0')
    expect(span.getAttribute('title')).toContain('key0 · entry')
  })

  test('two citations back to back are two cards, not one run wearing the first', () => {
    /* `coalesce` merges runs with identical styles, and two `\autocite`s with
       nothing between them have identical styles. */
    const runs = coalesce([cite('(A, 2000)', 0, ['a']), cite('(B, 2001)', 20, ['b'])])
    expect(runs).toHaveLength(2)
    expect(runs.map((run) => run.sources?.[0]?.key)).toEqual(['a', 'b'])
  })
})

describe('a cross-reference', () => {
  test('is a link to the block it names', () => {
    const r = draw([literal('See Chapter ', 0), ref('2', 12, 'ch:conclusion', { file: 'chapters/two.tex', id: 'heading-1' })])
    const link = r.container.querySelector<HTMLElement>('[role="link"]')!
    expect(link).not.toBeNull()
    expect(link.textContent).toBe('2')
    /* The same spelling `blocks.tsx` gives the block's own element. */
    expect(link.dataset.refTarget).toBe('b-chapters-two-tex-heading-1')
    expect(r.container.querySelector('[data-src-start="12"]')?.getAttribute('title')).toBe('Chapter 2 — Conclusion')
  })

  test('pressing it scrolls the block into view', () => {
    const target = document.createElement('h2')
    target.id = 'b-chapters-two-tex-heading-1'
    document.body.appendChild(target)
    let scrolled = 0
    target.scrollIntoView = () => {
      scrolled += 1
    }
    try {
      const r = draw([ref('2', 12, 'ch:conclusion', { file: 'chapters/two.tex', id: 'heading-1' })])
      fireEvent.click(r.container.querySelector<HTMLElement>('[role="link"]')!)
      expect(scrolled).toBe(1)
      fireEvent.keyDown(r.container.querySelector<HTMLElement>('[role="link"]')!, { key: 'Enter' })
      expect(scrolled).toBe(2)
    } finally {
      target.remove()
    }
  })

  test('one nothing resolved is marked, keeps its placeholder, and is no link', () => {
    const r = draw([ref('§ch:nowhere', 0, 'ch:nowhere')])
    const span = r.container.querySelector<HTMLElement>('[data-src-start]')!
    expect(span.dataset.unresolved).toBe('1')
    expect(span.textContent).toBe('§ch:nowhere')
    expect(span.getAttribute('title')).toContain('no such label')
    expect(r.container.querySelector('[role="link"]')).toBeNull()
  })
})
