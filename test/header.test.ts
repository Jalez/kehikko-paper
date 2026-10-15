import { describe, expect, test } from 'bun:test'
import { headerItemsSchema, LIMITS } from 'kehikot-module-protocol'

import { chapterOption, cut, headerOf, placesOf, resultOf, type HeaderState } from '../src/header.ts'
import type { SectionAt } from '../src/lib/sections.ts'

const section = (file: string, title: string, level = 1): SectionAt => ({ file, title, level, at: 0, end: 0, from: 0, to: 0 })
const jumps = (files: Record<string, SectionAt[]>, from = 0) => {
  let index = from
  return Object.entries(files).map(([file, sections]) => ({ file, sections: sections.map((one) => ({ index: index++, section: one })) }))
}

const base: HeaderState = {
  tab: 'source',
  proposals: 0,
  tabs: [],
  file: 'main.tex',
  listed: ['main.tex'],
  jumps: jumps({ 'main.tex': [section('main.tex', 'Intro'), section('main.tex', 'End')] }),
  auto: false,
  log: null,
  chapter: null,
  eachOffered: false,
  chaptersBusy: false,
  engine: 'tectonic',
  compiling: false,
  ran: null,
  pages: null,
  pdf: false,
  commit: null,
}

describe('what the page declares for the header', () => {
  test('every list it can make parses, whatever the paper', () => {
    const many = Array.from({ length: 200 }, (_, i) => section('main.tex', `A heading that goes on for rather longer than a label may, number ${i}`, 1 + (i % 3)))
    const state: HeaderState = {
      ...base,
      tab: 'pdf',
      proposals: 3,
      tabs: [{ file: 'a.tex', label: 'a.tex' }, { file: 'main.tex', label: 'main.tex' }],
      listed: ['main.tex', 'a.tex'],
      jumps: jumps({ 'main.tex': many, 'a.tex': [] }),
      log: { open: true, warnings: 2 },
      chapter: {
        parts: [
          { id: 'x'.repeat(200), heading: '' },
          { id: 'b', heading: 'B'.repeat(90) },
          { id: 'c', heading: 'C'.repeat(90), moves: { file: `chapters/${'f'.repeat(90)}.tex`, to: 'b' } },
          { id: 'd', heading: 'D'.repeat(90), moves: { file: `chapters/${'f'.repeat(90)}.tex`, to: null } },
        ],
        of: 'b',
      },
      eachOffered: true,
      compiling: true,
      ran: { ok: false, ms: 12345, first: 'Undefined control sequence \\foo on a line that is long' },
      pages: 12,
      pdf: true,
      commit: { why: 'x'.repeat(900) },
    }
    expect(headerItemsSchema.safeParse(headerOf(state)).success).toBe(true)
    expect(headerItemsSchema.safeParse(headerOf(base)).success).toBe(true)
    expect(headerItemsSchema.safeParse(headerOf({ ...base, engine: null, jumps: [], listed: [] })).success).toBe(true)
  })

  test('a paper with more headings than a go item holds loses its deepest first', () => {
    const many = Array.from({ length: 100 }, (_, i) => section('main.tex', `S${i}`, i % 2 === 0 ? 1 : 2))
    const places = placesOf(['main.tex'], jumps({ 'main.tex': many }))
    expect(places.length).toBeLessThanOrEqual(LIMITS.HEADER_OPTIONS)
    expect(places.every((one) => !one.label.startsWith(' '))).toBe(true)
    expect(places).toHaveLength(50)
  })

  test('one file is its sections; several are each file and its sections under it', () => {
    expect(placesOf(['main.tex'], base.jumps).map((one) => one.id)).toEqual(['s0', 's1'])
    const two = placesOf(['main.tex', 'a.tex'], jumps({ 'main.tex': [section('main.tex', 'Intro')], 'a.tex': [] }))
    expect(two).toEqual([{ id: 'f0', label: 'main.tex' }, { id: 's0', label: '  Intro' }, { id: 'f1', label: 'a.tex' }])
    expect(placesOf(['a.tex'], jumps({ 'a.tex': [] }))).toEqual([{ id: 'f0', label: 'Top of a.tex' }])
  })

  test('compile says how it is going and what it came to; commit is confirmed and so is not for agents', () => {
    const run = (state: Partial<HeaderState>) =>
      headerOf({ ...base, ...state }).find((one) => one.id === 'compile') as { state: string; result: string | null; disabled: string | null; agents: boolean }
    expect(run({})).toMatchObject({ state: 'idle', result: null, disabled: null, agents: true })
    expect(run({ compiling: true }).state).toBe('busy')
    expect(run({ ran: { ok: true, ms: 2100, first: null }, pages: 3 }).result).toBe('2.1 s · 3 pp.')
    expect(run({ ran: { ok: false, ms: 900, first: 'Undefined control sequence.' } })).toMatchObject({ state: 'failed', result: 'Undefined control sequence.' })
    expect(run({ engine: null }).disabled).toContain('No LaTeX engine')
    expect(headerOf({ ...base, engine: undefined }).some((one) => one.id === 'compile')).toBe(false)
    const commit = headerOf({ ...base, commit: { why: null } }).find((one) => one.id === 'commit') as { confirm: boolean; agents?: boolean }
    expect(commit.confirm).toBe(true)
    expect(commit.agents).toBeUndefined()
    expect(resultOf({ ran: { ok: false, ms: 1, first: 'x'.repeat(80) }, pages: null })!.length).toBe(LIMITS.HEADER_RESULT)
  })

  test('the same state is the same list, so nothing is declared twice', () => {
    const again = { ...base, jumps: jumps({ 'main.tex': [section('main.tex', 'Intro'), section('main.tex', 'End')] }) }
    expect(JSON.stringify(headerOf({ ...base }))).toBe(JSON.stringify(headerOf(again)))
  })

  test('a label is one line, never empty, never longer than it may be', () => {
    expect(cut('  a\n b  ')).toBe('a b')
    expect(cut('')).toBe('—')
    expect(cut('x'.repeat(60)).length).toBe(LIMITS.HEADER_LABEL)
  })
})

describe('a part in “chapter of”', () => {
  const option = (state: HeaderState, id: string) => {
    const item = headerOf(state).find((one) => one.id === 'chapter')
    return item?.kind === 'switch' ? item.options.find((one) => one.id === id)?.label : undefined
  }

  test('is its name — and, when it already has another chapter, what choosing it does to that one, before it is chosen', () => {
    const state: HeaderState = {
      ...base,
      file: 'chapters/3_methods.tex',
      chapter: {
        of: 'methods',
        parts: [
          { id: 'introduction', heading: 'Introduction', moves: { file: 'chapters/1_introduction.tex', to: 'methods' } },
          { id: 'methods', heading: 'Methods', moves: null },
          { id: 'results', heading: 'Results', moves: { file: 'chapters/4_results.tex', to: 'methods' } },
          { id: 'notes', heading: 'Notes' },
        ],
      },
    }
    expect(option(state, 'none')).toBe('no part')
    expect(option(state, 'p0')).toBe('Introduction · swaps with 1_introduction.tex')
    expect(option(state, 'p1')).toBe('Methods')
    expect(option(state, 'p2')).toBe('Results · swaps with 4_results.tex')
    expect(option(state, 'p3')).toBe('Notes')
  })

  test('a file with no part to give back says the other chapter is left with none', () => {
    expect(chapterOption({ id: 'results', heading: 'Results', moves: { file: 'chapters/4_results.tex', to: null } })).toBe('Results · no part for 4_results.tex')
  })

  test('long names: the label still fits, and what is cut is the end of the file’s name', () => {
    expect(chapterOption({ id: 'l', heading: 'Literature Review', moves: { file: 'chapters/2_literature_review.tex', to: 'methods' } })).toBe('Literature Review · swaps with 2_literature_rev…')
    for (const to of ['methods', null]) {
      const label = chapterOption({ id: 'r', heading: 'Results and a good deal more besides, at length', moves: { file: 'chapters/a_file_named_at_some_considerable_length.tex', to } })
      expect(label.length).toBeLessThanOrEqual(LIMITS.HEADER_LABEL)
      /* The part and what happens come first and whole; the file's name is what is cut, from its end. */
      expect(label).toMatch(to === null ? /^Results and a good deal.*… · no part for a_file.*…$/ : /^Results and a good deal.*… · swaps with a_file.*…$/)
    }
  })
})

describe('the review items', () => {
  const full: HeaderState = {
    ...base,
    proposals: 7,
    auto: true,
    jump: false,
    baseline: 'compared with what is staged or committed in git',
    stale: 2,
    deleted: 1,
    recent: {
      count: 3,
      auto: 3,
      last: 'chapters/a-rather-long-chapter-name-indeed.tex',
      options: [{ n: 3, label: 'a-rather-long-chapter-name-indeed.tex · some words → other words that go on' }],
    },
    suggest: { stops: 7, position: '2 of 7', editing: false, busy: false, noMore: true },
  }

  test('every one parses, and the checkboxes are named as the person reads them', () => {
    for (const state of [full, { ...full, auto: false, jump: true, suggest: { ...full.suggest!, noMore: false } }]) {
      const items = headerOf(state)
      expect(headerItemsSchema.safeParse(items).success).toBe(true)
      expect(items.find((one) => one.id === 'auto')!.label).toBe('Auto accept changes')
      expect(items.find((one) => one.id === 'jump')!.label).toStartWith('Jump to next change')
    }
  })

  test('jump is on by default, and says why it is idle under Auto accept', () => {
    const on = headerOf({ ...base, auto: false })
    expect((on.find((one) => one.id === 'jump') as { checked: boolean }).checked).toBe(true)
    const idle = headerOf({ ...base, auto: true })
    expect(idle.find((one) => one.id === 'jump')!.label).toContain('Auto accept is on')
  })

  test('"No more changes" is the result of Next, and nothing else', () => {
    const items = headerOf(full)
    expect((items.find((one) => one.id === 'sg-next') as { result: string | null }).result).toBe('No more changes')
    expect((items.find((one) => one.id === 'sg-prev') as { result?: string | null }).result ?? null).toBeNull()
  })

  test('out of date, deleted, accepted lately and the baseline are items; none is offered when there is none', () => {
    const ids = headerOf(full).map((one) => one.id)
    for (const id of ['sg-stale', 'sg-deleted-accept', 'sg-deleted-restore', 'ac-undo', 'accepted', 'sg-baseline']) expect(ids).toContain(id)
    const none = headerOf(base).map((one) => one.id)
    for (const id of ['sg-stale', 'sg-deleted-accept', 'ac-undo', 'accepted', 'sg-baseline']) expect(none).not.toContain(id)
  })

  test('no review item may be pressed by an agent', () => {
    const items = headerOf(full)
    expect(items.filter((one) => one.agents).map((one) => one.id)).toEqual(['compile'])
  })
})
