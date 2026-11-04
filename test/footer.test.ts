import { describe, expect, test } from 'bun:test'
import { footerItemsSchema, LIMITS } from 'kehikot-module-protocol'

import { buildOf, footerItems, type FooterState } from '../src/footer.ts'
import { headerOf, type HeaderState } from '../src/header.ts'

const base: FooterState = {
  file: 'main.tex',
  main: null,
  saved: 'clean',
  failure: null,
  engine: 'tectonic',
  compiling: false,
  ran: null,
  warnings: 0,
  pages: null,
  stale: false,
  unconfined: null,
  section: null,
  page: null,
  suggest: { stops: 0, position: null, noMore: false },
  baseline: null,
  readOnly: false,
}

const ids = (state: FooterState) => footerItems(state).map((one) => one.id)
const item = (state: FooterState, id: string) => footerItems(state).find((one) => one.id === id) as Record<string, unknown> | undefined

describe('what the page declares for the footer', () => {
  test('every list it can make parses, however long the words', () => {
    const long = 'x'.repeat(900)
    const states: FooterState[] = [
      base,
      { ...base, engine: undefined },
      { ...base, engine: null },
      { ...base, compiling: true },
      {
        ...base,
        file: `chapters/${long}.tex`,
        main: `${long}.tex`,
        saved: 'failed',
        failure: long,
        ran: { ok: false, ms: 1234, first: long },
        section: long,
        page: 3,
        pages: 12,
        suggest: { stops: 5, position: '2 of 5', noMore: true },
        baseline: long,
        readOnly: true,
        unconfined: long,
      },
      { ...base, ran: { ok: true, ms: 1234, first: null }, pages: 12, warnings: 3, stale: true },
    ]
    for (const state of states) expect(footerItemsSchema.safeParse(footerItems(state)).success).toBe(true)
  })

  test('the open file and whether it is saved, always; going back to main.tex only away from it', () => {
    expect(ids(base)).toEqual(['file', 'saved'])
    expect(item({ ...base, saved: 'dirty' }, 'saved')!.text).toBe('Unsaved')
    expect(item({ ...base, saved: 'saving' }, 'saved')!.text).toBe('Saving…')
    const away = { ...base, file: 'chapters/design.tex', main: 'main.tex' }
    expect(ids(away)).toEqual(['main', 'file', 'saved'])
    expect(item(away, 'main')).toMatchObject({ kind: 'run', label: '← main.tex' })
  })

  test('a save that failed says so, and in words', () => {
    const state = { ...base, saved: 'failed' as const, failure: 'The disk is full.' }
    expect(item(state, 'saved')).toMatchObject({ text: 'Not saved', level: 'critical' })
    expect(item(state, 'failure')).toMatchObject({ text: 'The disk is full.', level: 'critical' })
  })

  test('the build: news while it is, the seconds, pages and warnings once it has compiled', () => {
    expect(buildOf({ ...base, engine: undefined })).toBeNull()
    expect(buildOf(base)).toBeNull()
    expect(buildOf({ ...base, engine: null })).toMatchObject({ text: 'No engine', level: 'warn' })
    expect(buildOf({ ...base, compiling: true })).toMatchObject({ text: 'Compiling…' })
    expect(buildOf({ ...base, ran: { ok: false, ms: 900, first: 'Undefined control sequence' } })).toMatchObject({ text: 'Failed: Undefined control sequence', level: 'critical' })
    expect(buildOf({ ...base, ran: { ok: true, ms: 1234, first: null }, pages: 12 })).toMatchObject({ text: '1.2 s · 12 pp.', level: 'normal' })
    expect(buildOf({ ...base, ran: { ok: true, ms: 1234, first: null }, pages: 12, warnings: 1 })).toMatchObject({ text: '1.2 s · 12 pp. · 1 warning', level: 'warn' })
    expect(buildOf({ ...base, ran: { ok: true, ms: 1234, first: null }, stale: true })).toMatchObject({ text: '1.2 s · earlier save', level: 'warn' })
    const failed = item({ ...base, ran: { ok: false, ms: 1, first: 'y'.repeat(400) } }, 'build')!
    expect((failed.text as string).length).toBe(LIMITS.FOOTER_TEXT)
    expect(failed.align).toBe('end')
  })

  test('the section is the first to go, the page stays', () => {
    const state = { ...base, section: 'Method', page: 3, pages: 12 }
    expect(item(state, 'section')).toMatchObject({ text: 'Method', optional: true })
    expect(item(state, 'page')).toMatchObject({ text: 'p. 3/12' })
    expect(item(state, 'page')!.optional).toBeUndefined()
    /* No page count, no page. */
    expect(item({ ...state, pages: null }, 'page')).toBeUndefined()
  })

  test('the suggestion walked, with Previous and Next beside it; nothing when none is waiting', () => {
    expect(ids(base).some((id) => id.startsWith('sg-'))).toBe(false)
    const waiting = { ...base, suggest: { stops: 3, position: null, noMore: false } }
    expect(ids(waiting)).toEqual(['file', 'saved', 'sg-prev', 'suggestion', 'sg-next'])
    expect(item(waiting, 'suggestion')!.text).toBe('3 suggestions waiting')
    const on = { ...base, suggest: { stops: 3, position: '2 of 3', noMore: true } }
    expect(item(on, 'suggestion')!.text).toBe('Suggestion 2 of 3')
    expect(item(on, 'sg-next')).toMatchObject({ kind: 'run', result: 'No more changes' })
  })

  test('what the changes are compared with is optional, unless it says nothing can be answered', () => {
    expect(item({ ...base, baseline: 'compared with the last commit' }, 'baseline')).toMatchObject({ text: 'Changes compared with the last commit', optional: true })
    expect(item({ ...base, baseline: 'git is in the middle of a merge.', readOnly: true }, 'baseline')).toMatchObject({ level: 'warn', optional: false })
  })
})

describe('the header, beside a footer', () => {
  const header: HeaderState = {
    tab: 'pdf',
    proposals: 2,
    tabs: [],
    file: 'main.tex',
    listed: ['main.tex'],
    jumps: [],
    auto: false,
    log: { open: false, warnings: 2 },
    chapter: null,
    eachOffered: false,
    chaptersBusy: false,
    engine: 'tectonic',
    compiling: false,
    ran: { ok: false, ms: 900, first: 'Oops' },
    pages: 4,
    pdf: true,
    commit: null,
    suggest: { stops: 2, position: '1 of 2', editing: false, busy: false },
    baseline: 'compared with the last commit',
  }
  const find = (state: HeaderState, id: string) => headerOf(state).find((one) => one.id === id) as Record<string, unknown> | undefined

  test('without one, the readouts stay in the header as they were', () => {
    expect(find(header, 'compile')!.result).toBe('Oops')
    expect(find(header, 'sg-prev')).toBeDefined()
    expect(find(header, 'sg-baseline')).toBeDefined()
    expect(find(header, 'log')!.label).toBe('Compile log · 2 warnings')
    expect((find(header, 'pane')!.options as { label: string }[]).map((one) => one.label)).toEqual(['Source · 2 suggested', 'PDF · the last compile failed'])
  })

  test('with one, every readout is the footer’s and not said twice', () => {
    const footed = { ...header, footed: true }
    expect(find(footed, 'compile')!.result).toBeNull()
    expect(find(footed, 'compile')!.state).toBe('failed')
    expect(find(footed, 'sg-prev')).toBeUndefined()
    expect(find(footed, 'sg-next')).toBeUndefined()
    expect(find(footed, 'sg-baseline')).toBeUndefined()
    expect(find(footed, 'sg-accept')).toBeDefined()
    expect(find(footed, 'log')!.label).toBe('Compile log')
    expect((find(footed, 'pane')!.options as { label: string }[]).map((one) => one.label)).toEqual(['Source', 'PDF'])
  })
})
