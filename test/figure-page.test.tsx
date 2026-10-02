import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { PlacedBlock } from '../store.ts'
import { BlockRow } from '../src/reader/blocks.tsx'

/**
 * A figure, as the reading view draws it.
 *
 * The server turns a PDF figure into a PNG, which is worth nothing unless the
 * page asks for it: the page used to decide from the extension alone that a
 * `.pdf` was not drawable and put its filename in a box without asking. These
 * pin the three states the `Graphic` essay promises.
 */

afterEach(cleanup)

/* An origin for the page, as it has in a browser. The default document is
   `about:blank`, against which `/api/figure?…` is not a URL at all, and
   happy-dom answers an `<img>` with no parseable `src` with an immediate
   `error` — which would make every picture in this file look like the
   fallback for a reason that is about the test and not about the page. */
beforeAll(() => {
  ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('http://127.0.0.1:7870/app')
})

function figure(graphics: string[], caption = 'A caption.'): PlacedBlock {
  return {
    kind: 'figure',
    id: 'figure-1',
    srcStart: 0,
    srcEnd: 10,
    graphics,
    caption: [{ text: caption, srcStart: 0, srcEnd: caption.length, literal: true, styles: [] }],
    file: 'chapters/3_methods.tex',
  }
}

describe('a figure', () => {
  test('a PDF is drawn as a picture asked of /api/figure, not as a box', () => {
    const { container } = render(<BlockRow block={figure(['figures/fig_research_process.pdf'])} epic="thesis" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toContain('/api/figure')
    expect(img!.getAttribute('src')).toContain('file=figures%2Ffig_research_process.pdf')
    expect(container.textContent).not.toContain('figure: figures/fig_research_process.pdf')
  })

  test('a PDF the server could not draw falls back to the filename box, never a broken picture', () => {
    const { container } = render(<BlockRow block={figure(['figures/fig_exercise_flow.pdf'])} epic="thesis" />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('figure: figures/fig_exercise_flow.pdf')
  })

  test('an SVG is still the filename box, without asking', () => {
    const { container } = render(<BlockRow block={figure(['figures/drawing.svg'])} epic="thesis" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('figure: figures/drawing.svg')
  })

  test('an inline TikZ figure, with no \\includegraphics, shows its caption alone', () => {
    const { container } = render(<BlockRow block={figure([], 'Participation falls at every step.')} epic="thesis" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('figcaption')?.textContent).toContain('Participation falls at every step.')
  })
})
