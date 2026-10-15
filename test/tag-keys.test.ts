import { describe, expect, test } from 'bun:test'
import { TagWidget, type InlineSuggestion } from '../src/editor/source-editor.tsx'

const one = (over: Partial<InlineSuggestion> = {}): InlineSuggestion => ({
  id: 'p1', key: 'p1', from: 0, to: 4, replacement: 'x', after: false, current: true, armed: false,
  why: 'Because.', revisions: 0, count: 1, tag: true, editing: false, proposed: 'x', ...over,
})
const draw = (s: InlineSuggestion) => {
  const on = { list: [s], drafts: new Map<string, string>(), toggle() {}, answer() {}, draft() {}, stopEditing() {}, pick() {} }
  return new TagWidget(s, on).toDOM()
}
const caps = (el: HTMLElement) => [...el.querySelectorAll('button[data-sugg-answer]')].map((b) => b.querySelector('kbd')?.textContent ?? null)

describe('keycaps on a suggestion’s tag', () => {
  test('none when not armed: no claim on a key that would not work', () => {
    const tag = draw(one())
    expect(caps(tag)).toEqual([null, null])
    expect(tag.querySelector('[aria-keyshortcuts]')).toBeNull()
    expect(tag.classList.contains('cm-sugg-armed')).toBe(false)
  })
  test('armed: Enter on Accept change, Esc on Cancel change, in titles and aria too', () => {
    const tag = draw(one({ armed: true }))
    expect(caps(tag)).toEqual(['⏎', 'Esc'])
    const [accept, cancel] = [...tag.querySelectorAll('button[data-sugg-answer]')] as HTMLElement[]
    expect(accept!.title).toBe('Accept change — Enter')
    expect(accept!.getAttribute('aria-keyshortcuts')).toBe('Enter')
    expect(cancel!.title).toBe('Cancel change — Escape')
    expect(cancel!.getAttribute('aria-keyshortcuts')).toBe('Escape')
    expect(tag.classList.contains('cm-sugg-armed')).toBe(true)
  })
  test('editing: the modified Enter on Accept change, nothing on Cancel change', () => {
    const [accept, cancel] = caps(draw(one({ armed: true, editing: true })))
    expect(accept).toMatch(/⏎/)
    expect(accept).not.toBe('⏎')
    expect(cancel).toBeNull()
  })
})
