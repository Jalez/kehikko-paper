import { describe, expect, test } from 'bun:test'
import { headerItemsSchema, LIMITS } from 'kehikot-module-protocol'

import { cut, headerOf, placesOf, resultOf, type HeaderState } from '../src/header.ts'
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
      chapter: { parts: [{ id: 'x'.repeat(200), heading: '' }, { id: 'b', heading: 'B'.repeat(90) }], of: 'b' },
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
