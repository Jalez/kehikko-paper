import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { Standing } from '../git.ts'
import { parseLatex } from '../latex/parse.ts'
import type { Paper, PlacedBlock } from '../store.ts'
import { PaginatedView } from '../src/reader/paginated.tsx'

/**
 * The Save control: which state it is in, and what it says in each of them.
 *
 * ## What this file can prove
 *
 * happy-dom lays nothing out, so nothing here is a claim about where the button
 * lands, whether the chrome row wraps at 220 pixels, or how a filled button
 * reads beside two ticks. Those are stated in the report as reasoned or as
 * measured in a real browser, and they are not asserted here.
 *
 * What it can prove is the part that decides whether somebody is misled: which
 * of four states the control is drawn in, that it is not drawn at all when
 * there is no repository, that it is pressable in every state it IS drawn in —
 * including the two where pressing changes nothing — and that the count of
 * files waiting is in the LABEL rather than only in the colour.
 */

const SOURCE = [
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim has a tpyo and it runs on for long enough that the author',
  'wrapped the line, the way a real paper is written, and then it ends.',
  '',
  '\\end{document}',
  '',
].join('\n')

function fixture(): Paper {
  const parsed = parseLatex(SOURCE, 'main.tex')
  const blocks: PlacedBlock[] = parsed.blocks.map((b) => ({ ...b, file: 'main.tex' }))
  return {
    epic: 'saving',
    dir: '/tmp/papers/saving',
    title: 'A paper with a history',
    author: null,
    blocks,
    figures: [],
    outline: [],
    files: ['main.tex'],
    hashes: { 'main.tex': 'not-on-disk' },
  }
}

const ref = () => ({ current: null as HTMLElement | null })

afterEach(cleanup)

/* `null` for `onSave`, never `undefined`. A default parameter is applied when
   the argument IS undefined, so `draw(x, undefined)` would quietly wire the
   button it was meant to leave unwired — which is exactly the test that caught
   it, by failing. */
function draw(saving: Standing | null, onSave: (() => void) | null = () => {}) {
  const { container } = render(
    <PaginatedView
      paper={fixture()}
      walk={null}
      mark={null}
      rootRef={ref()}
      onPen={() => {}}
      onAuto={() => {}}
      saving={saving}
      onSave={onSave ?? undefined}
    />,
  )
  return { container, button: container.querySelector<HTMLButtonElement>('[data-save]') }
}

describe('the Save control', () => {
  test('it is not drawn at all when the paper is in no repository', () => {
    /* The state a paper in a plain folder is in, which was the only way to use
       this module until commits existed. A control that is always there and
       never works is worse than no control. */
    expect(draw({ at: 'nogit' }).button).toBeNull()
  })

  test('it is not drawn when the caller offered nowhere to commit', () => {
    /* The same rule `onPen` and `onAuto` already follow: a view rendered
       without the wiring is the reading view unchanged. */
    expect(draw({ at: 'ready', files: ['main.tex'] }, null).button).toBeNull()
  })

  test('with something waiting it says how much, in the label', () => {
    const { button } = draw({ at: 'ready', files: ['main.tex', 'chapters/two.tex'] })
    expect(button).not.toBeNull()
    expect(button!.textContent).toBe('Save 2')
    expect(button!.getAttribute('data-saving')).toBe('ready')
    expect(button!.disabled).toBe(false)
    /* Both files named, so somebody can check what is about to enter their
       history before it does. */
    expect(button!.title).toContain('main.tex')
    expect(button!.title).toContain('chapters/two.tex')
    expect(button!.title).toContain('branch that is checked out')
  })

  test('with nothing waiting it is still pressable, and says why nothing happens', () => {
    /* Deliberately not disabled. A disabled button can only explain itself in a
       `title`, which is a hover, which a touch screen does not have — and
       "nothing has changed" is exactly the thing somebody pressing Save wants
       told. */
    const pressed: number[] = []
    const { button } = draw({ at: 'clean' }, () => pressed.push(1))
    expect(button!.textContent).toBe('Save')
    expect(button!.getAttribute('data-saving')).toBe('clean')
    expect(button!.disabled).toBe(false)
    expect(button!.title).toContain('Nothing has changed')
    fireEvent.click(button!)
    expect(pressed).toHaveLength(1)
  })

  test('when git has refused, the reason is on the control and pressing reaches it', () => {
    const why = 'This repository is not on a branch — HEAD is detached at abc1234. Check out a branch.'
    const pressed: number[] = []
    const { button } = draw({ at: 'refused', why }, () => pressed.push(1))
    expect(button!.getAttribute('data-saving')).toBe('refused')
    expect(button!.title).toBe(why)
    expect(button!.textContent).toBe('Save')
    fireEvent.click(button!)
    expect(pressed).toHaveLength(1)
  })

  test('it sits in the same row as the two ticks', () => {
    /* Where the owner asked for it — "next to those edit/auto checkmarks" —
       and where a reader looking for one of the three will look for the
       others. */
    const { container, button } = draw({ at: 'ready', files: ['main.tex'] })
    const row = button!.closest('div')!
    expect(row.querySelector('[data-editing]')).not.toBeNull()
    expect(row.querySelector('[data-auto-approve]')).not.toBeNull()
    expect(container.querySelectorAll('[data-save]')).toHaveLength(1)
  })
})

describe('all three controls are shadcn, and none of them is a native widget', () => {
  /*
   * The enumeration, written as a test so that a fourth control added to this
   * row has to come here and say what it is. The two ticks used to be
   * `<input type="checkbox">` with `accent-color` set, which draws the
   * operating system's widget with one colour changed — the only things in this
   * row that did not belong to the canvas they sit on.
   */
  test('the ticks are Radix checkboxes and Save is a button', () => {
    const { container } = draw({ at: 'ready', files: ['main.tex'] })
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    for (const which of ['[data-editing]', '[data-auto-approve]']) {
      const tick = container.querySelector(which)!
      expect(tick.tagName).toBe('BUTTON')
      expect(tick.getAttribute('role')).toBe('checkbox')
      expect(tick.getAttribute('data-slot')).toBe('checkbox')
    }
    expect(container.querySelector('[data-save]')!.getAttribute('data-slot')).toBe('button')
  })

  test('each tick has a label that names it', () => {
    const { container } = draw({ at: 'clean' })
    const labels = Array.from(container.querySelectorAll('[data-slot="label"]')).map((one) => one.textContent)
    expect(labels).toEqual(['Edit', 'Auto'])
    /* Pointed at the controls by id, which is what makes the WORD a target for
       the tick rather than decoration beside it. */
    expect(container.querySelector('label[for="paper-edit"]')).not.toBeNull()
    expect(container.querySelector('label[for="paper-auto"]')).not.toBeNull()
    expect(container.querySelector('[data-editing]')!.id).toBe('paper-edit')
    expect(container.querySelector('[data-auto-approve]')!.id).toBe('paper-auto')
  })
})
