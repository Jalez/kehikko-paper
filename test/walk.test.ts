import { describe, expect, test } from 'bun:test'

import type { Proposal } from '../latex/propose.ts'
import { headerOf, type HeaderState } from '../src/header.ts'
import { placement, position, step, stopsOf } from '../src/suggestions.ts'

const one = (id: string, file: string, from: number, extra: Partial<Proposal> = {}): Proposal => ({
  id, file, from, to: from + 1, text: 'x', was_text: 'a', was: 'h', why: 'w', by: 'a', at: from, ...extra,
})

describe('the order suggestions are walked in', () => {
  const listed = ['main.tex', 'chapters/b.tex', 'chapters/a.tex']
  const all = [
    one('a2', 'chapters/a.tex', 5),
    one('m2', 'main.tex', 40),
    one('b1', 'chapters/b.tex', 9),
    one('m1', 'main.tex', 3),
    one('g1', 'chapters/b.tex', 30, { group: 'move' }),
    one('g2', 'chapters/b.tex', 2, { group: 'move' }),
  ]

  test('files as main.tex pulls them in, then position; a group is one stop', () => {
    const stops = stopsOf(all, listed)
    expect(stops.map((s) => s.key)).toEqual(['p:m1', 'p:m2', 'g:move', 'p:b1', 'p:a2'])
    expect(stops[2]!.ids).toEqual(['g2', 'g1'])
    expect(position(stops, 'g:move')).toBe('3 of 5')
  })

  test('it wraps both ways, and starts at the ends from nowhere', () => {
    const stops = stopsOf(all, listed)
    expect(step(stops, 'p:a2', 1)!.key).toBe('p:m1')
    expect(step(stops, 'p:m1', -1)!.key).toBe('p:a2')
    expect(step(stops, null, 1)!.key).toBe('p:m1')
    expect(step(stops, null, -1)!.key).toBe('p:a2')
    expect(step([], null, 1)).toBeNull()
  })

  test('a part pick narrows it: files it does not show are not stops', () => {
    const stops = stopsOf(all, ['chapters/b.tex'])
    expect(stops.map((s) => s.key)).toEqual(['g:move', 'p:b1'])
  })
})

describe('where a suggestion sits in the text on screen', () => {
  const text = 'The claim has a tpyo in it.\nNext line.'
  const p = one('p', 'main.tex', 'The claim has a '.length, {
    to: 'The claim has a tpyo'.length, text: 'typo', was_text: 'tpyo', asked: { find: 'a tpyo in', replace: 'a typo in' },
  })

  test('the quoted passage, with what would stand there', () => {
    expect(placement(p, text, '\n')).toEqual({ from: 'The claim has '.length, to: 'The claim has a tpyo in'.length, replacement: 'a typo in', quoted: true })
  })

  test('typing that moved the words is not drawn in the wrong place', () => {
    expect(placement(p, 'Oops. ' + text, '\n')).toBeNull()
  })
})

describe('the suggestion items in the header', () => {
  const base: HeaderState = {
    tab: 'source', proposals: 0, tabs: [], file: 'main.tex', listed: ['main.tex'], jumps: [], auto: false, log: null,
    chapter: null, eachOffered: false, chaptersBusy: false, engine: undefined, compiling: false, ran: null, pages: null,
    pdf: false, commit: null,
  }
  const items = (suggest: HeaderState['suggest']) =>
    headerOf({ ...base, suggest }).filter((i) => i.id.startsWith('sg-')) as (Record<string, unknown> & { id: string })[]

  test('none pending: all declared, all disabled with the reason', () => {
    const got = items({ stops: 0, position: null, editing: false, busy: false })
    expect(got.map((i) => i.id)).toEqual(['sg-prev', 'sg-next', 'sg-accept', 'sg-reject', 'sg-edit'])
    for (const i of got) expect(String(i.disabled)).toContain('No suggestion')
  })

  test('pending but none chosen: walking is allowed, answering says to choose', () => {
    const got = items({ stops: 3, position: null, editing: false, busy: false })
    expect(got.find((i) => i.id === 'sg-next')!.disabled).toBeNull()
    expect(String(got.find((i) => i.id === 'sg-accept')!.disabled)).toContain('Next suggestion')
    expect(got.find((i) => i.id === 'sg-next')!.label).toBe('Next suggestion · 3 waiting')
    expect(got.some((i) => i.id === 'sg-all')).toBe(true)
  })

  test('chosen: position in the label; only the walk is pinned (Accept and Reject are on the tag); none is for agents', () => {
    const got = items({ stops: 5, position: '2 of 5', editing: false, busy: false })
    expect(got.find((i) => i.id === 'sg-next')!.label).toBe('Next suggestion · 2 of 5')
    expect(got.find((i) => i.id === 'sg-accept')!.disabled).toBeNull()
    expect(got.filter((i) => i.pinned === true).map((i) => i.id)).toEqual(['sg-prev', 'sg-next'])
    expect(got.some((i) => i.agents === true)).toBe(false)
    expect(got.every((i) => i.group === 'Suggestions')).toBe(true)
  })

  test('while editing, Accept says it applies the author’s version', () => {
    const got = items({ stops: 1, position: '1 of 1', editing: true, busy: false })
    expect(got.find((i) => i.id === 'sg-accept')!.label).toBe('Accept my version')
    expect(got.find((i) => i.id === 'sg-edit')!.label).toBe('Stop editing suggestion')
  })
})

import { stopsOf as stopsOfVersions } from '../src/suggestions.ts'

describe('versions of one passage are one stop', () => {
  const one = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, file: 'main.tex', from: 10, to: 14, text: 'x', was_text: 'y', was: 'h', why: '', by: 'an agent', at: 1, ...over }) as never

  test('they share a stop, the one in the file first, the suggestions in the order they came', () => {
    const stops = stopsOfVersions(
      [one('a', { alt: 'alt-a', at: 3 }), one('b', { alt: 'alt-a', kind: 'disk', at: 9 }), one('c', { alt: 'alt-a', at: 2 }), one('d', { from: 90 })],
      ['main.tex'],
    )
    expect(stops.map((s) => s.key)).toEqual(['a:alt-a', 'p:d'])
    expect(stops[0]!.versions).toBe(true)
    expect(stops[0]!.members.map((m) => m.id)).toEqual(['b', 'c', 'a'])
    expect(stops[0]!.lead.id).toBe('b')
    expect(stops[1]!.versions).toBeUndefined()
  })
})
