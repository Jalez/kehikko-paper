import { describe, expect, test } from 'bun:test'
import { fireEvent, render } from '@testing-library/react'

import { bytesOf } from '../latex/edit.ts'
import { parseLatex } from '../latex/parse.ts'
import type { Paper, PlacedBlock } from '../store.ts'
import { PaginatedView } from '../src/reader/paginated.tsx'

/**
 * Typing in the paper, checked as far as a document without layout can see.
 *
 * ## What this file can prove, and what it cannot
 *
 * happy-dom has no caret and no editing. It will not tell you whether a cursor
 * can be placed in a span, what a browser does to a space at the end of a run,
 * or whether the page redraws without jumping. Those are browser behaviours and
 * they are stated as unverified rather than pretended at.
 *
 * What it can prove is the part that decides whether somebody's file gets
 * damaged, and that part was deliberately made assertable:
 *
 *  - **Which spans are offered at all.** `data-editable` is on every span while
 *    the pen is out, so "only a literal span may be typed into" is a query
 *    rather than a claim. A derived span that ever came back `1` is the whole
 *    failure this feature could have — an offset inside a rendering, spliced
 *    into a file as though it were an offset into the source.
 *  - **Which bytes a finished edit names.** The blur handler is reachable, the
 *    element's text is settable, and the range that comes out is checkable
 *    against the source the fixture was parsed from.
 *  - **That reading is unchanged when nobody asked to edit.** No attribute, no
 *    control, nothing `contenteditable`.
 */

const SOURCE = [
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim has a tpyo and \\autocite{jones} a citation after it.',
  '',
  '\\end{document}',
  '',
].join('\n')

function fixture(): Paper {
  const parsed = parseLatex(SOURCE, 'main.tex')
  const blocks: PlacedBlock[] = parsed.blocks.map((b) => ({ ...b, file: 'main.tex' }))
  return {
    epic: 'typing',
    dir: '/tmp/papers/typing',
    title: 'A paper that can be typed into',
    author: null,
    blocks,
    figures: [],
    outline: [],
    files: ['main.tex'],
    hashes: { 'main.tex': 'not-on-disk' },
  }
}

const ref = () => ({ current: null as HTMLElement | null })

/** A pen that records what it was asked to do rather than doing it. */
function recorder(answer: string | null = null) {
  const commits: { file: string; from: number; to: number; text: string }[] = []
  const said: string[] = []
  return {
    commits,
    said,
    pen: {
      commit: async (edit: { file: string; from: number; to: number; text: string }) => {
        commits.push(edit)
        return answer
      },
      say: (sentence: string) => {
        said.push(sentence)
      },
    },
  }
}

const spans = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-src-start]'))

/** The span holding a given run of rendered text. */
function spanSaying(container: HTMLElement, needle: string): HTMLElement {
  const found = spans(container).find((el) => (el.textContent ?? '').includes(needle))
  if (!found) throw new Error(`no span rendering “${needle}”`)
  return found
}

describe('with no pen, the reading view is exactly what it was', () => {
  test('nothing is editable and nothing says anything about editing', () => {
    const { container } = render(<PaginatedView paper={fixture()} walk={null} mark={null} rootRef={ref()} />)
    expect(spans(container).length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-editable]').length).toBe(0)
    expect(container.querySelectorAll('[contenteditable]').length).toBe(0)
    /* And no control, because the caller offered nowhere for an edit to go. */
    expect(container.querySelector('input[type="checkbox"][data-editing]')).toBeNull()
  })

  test('the control appears only when the page offers somewhere to write', () => {
    const { container } = render(
      <PaginatedView paper={fixture()} walk={null} mark={null} rootRef={ref()} onPen={() => {}} />,
    )
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"][data-editing]')
    expect(box).not.toBeNull()
    expect(box!.checked).toBe(false)
  })
})

describe('with the pen out, only a literal span may be typed into', () => {
  const draw = () => {
    const kept = recorder()
    const rendered = render(
      <PaginatedView paper={fixture()} walk={null} mark={null} rootRef={ref()} pen={kept.pen} onPen={() => {}} />,
    )
    return { ...kept, ...rendered }
  }

  test('every span says whether it is typeable, and it agrees with `literal`', () => {
    /*
     * The invariant, asserted over every span on the page rather than over the
     * one that was interesting. `data-literal` is what the parser said; the
     * whole licence for editing in place is that the two are the same claim, so
     * a span where they disagree is a span whose offsets do not mean what the
     * edit door will assume they mean.
     */
    const { container } = draw()
    const all = spans(container)
    expect(all.length).toBeGreaterThan(2)
    for (const el of all) {
      expect(el.dataset.editable).toBe(el.dataset.literal)
      expect(el.getAttribute('contenteditable')).toBe(el.dataset.literal === '1' ? 'true' : null)
    }
  })

  test('a citation is a derived span and refuses the cursor', () => {
    const { container } = draw()
    /* `\autocite{jones}` renders as `[jones]`: seven characters standing in for
       seventeen, with no honest correspondence between them. */
    const citation = spanSaying(container, '[jones]')
    expect(citation.dataset.literal).toBe('0')
    expect(citation.dataset.editable).toBe('0')
    expect(citation.getAttribute('contenteditable')).toBeNull()
    expect(citation.getAttribute('title')).toContain('cannot be typed into')
  })

  test('pressing one selects it whole and says why', () => {
    const { container, said } = draw()
    fireEvent.mouseDown(spanSaying(container, '[jones]'))
    expect(said.length).toBe(1)
    expect(said[0]).toContain('Edit the .tex')
  })
})

describe('a finished edit names the bytes it actually changed', () => {
  const draw = (answer: string | null = null) => {
    const kept = recorder(answer)
    const rendered = render(
      <PaginatedView paper={fixture()} walk={null} mark={null} rootRef={ref()} pen={kept.pen} onPen={() => {}} />,
    )
    return { ...kept, ...rendered }
  }

  test('one word corrected sends one word, at its own offset in the file', () => {
    const { container, commits } = draw()
    const prose = spanSaying(container, 'tpyo')
    const before = prose.textContent ?? ''
    prose.textContent = before.replace('tpyo', 'typo')
    fireEvent.blur(prose)

    expect(commits.length).toBe(1)
    const sent = commits[0]!
    expect(sent.file).toBe('main.tex')
    expect(sent.text).toBe('yp')
    /* Against the source rather than against the span: the point of the whole
       arrangement is that an offset on screen is an offset in the file. */
    expect(sent.from).toBe(bytesOf(SOURCE.slice(0, SOURCE.indexOf('tpyo') + 1)))
    expect(sent.to).toBe(sent.from + 2)
    /* And what the door would splice is the sentence the reader now sees. */
    const bytes = Buffer.from(SOURCE, 'utf8')
    const after = Buffer.concat([
      bytes.subarray(0, sent.from),
      Buffer.from(sent.text, 'utf8'),
      bytes.subarray(sent.to),
    ]).toString('utf8')
    expect(after).toBe(SOURCE.replace('tpyo', 'typo'))
  })

  test('a span left alone sends nothing', () => {
    const { container, commits, said } = draw()
    const prose = spanSaying(container, 'tpyo')
    fireEvent.blur(prose)
    expect(commits).toEqual([])
    expect(said).toEqual([])
  })

  test('LaTeX markup is refused under the cursor, before any round trip', () => {
    const { container, commits, said } = draw()
    const prose = spanSaying(container, 'tpyo')
    const before = prose.textContent ?? ''
    prose.textContent = before.replace('tpyo', '50%')
    fireEvent.blur(prose)

    expect(commits).toEqual([])
    expect(said.length).toBe(1)
    expect(said[0]).toContain('markup')
    /* And the span is put back, because a span holding text that is not in the
       file is the page telling somebody their correction landed. */
    expect(prose.textContent).toBe(before)
  })

  test('a refusal from the door puts the words back and says so', () => {
    const { container, commits, said } = draw('That file has changed since this page read it.')
    const prose = spanSaying(container, 'tpyo')
    const before = prose.textContent ?? ''
    prose.textContent = before.replace('tpyo', 'typo')
    fireEvent.blur(prose)

    expect(commits.length).toBe(1)
    /* The commit is a promise; the restore happens when it answers. */
    return Promise.resolve().then(() => {
      expect(prose.textContent).toBe(before)
      expect(said[0]).toContain('changed since')
    })
  })

  test('Escape puts the span back without sending anything', () => {
    const { container, commits } = draw()
    const prose = spanSaying(container, 'tpyo')
    const before = prose.textContent ?? ''
    prose.textContent = before.replace('tpyo', 'typo')
    fireEvent.keyDown(prose, { key: 'Escape' })
    expect(prose.textContent).toBe(before)
    fireEvent.blur(prose)
    expect(commits).toEqual([])
  })
})
