import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { footerItems, type FooterState } from '../src/footer.ts'
import { headerOf, type HeaderState } from '../src/header.ts'

/**
 * The rows this page declares, for `kehikot-check-rows` (protocol 2.70.0): `kehikot.rows.json` is
 * written from the real `headerOf` and `footerItems`, one state per moment worth checking, by
 * `bun dev/rows.ts`; `test/rows.test.ts` fails when the file is not what they make now.
 */

const section = (file: string, title: string) => ({ file, title, level: 1, at: 0, end: 0, from: 0, to: 0 })

const header: HeaderState = {
  footed: true,
  tab: 'source',
  proposals: 0,
  tabs: [{ file: 'main.tex', label: 'main.tex' }, { file: 'chapters/intro.tex', label: 'intro.tex' }],
  file: 'main.tex',
  listed: ['main.tex', 'chapters/intro.tex'],
  jumps: [{ file: 'main.tex', sections: [{ index: 0, section: section('main.tex', 'Introduction') }, { index: 1, section: section('main.tex', 'Method') }] }],
  auto: false,
  jump: true,
  log: { open: false, warnings: 0 },
  chapter: null,
  eachOffered: false,
  chaptersBusy: false,
  engine: 'tectonic',
  compiling: false,
  ran: { ok: true, ms: 2300, first: null },
  pages: 12,
  pdf: true,
  commit: { why: null },
}

const footer: FooterState = {
  file: 'main.tex',
  main: null,
  saved: 'clean',
  failure: null,
  engine: 'tectonic',
  compiling: false,
  ran: { ok: true, ms: 2300, first: null },
  warnings: 0,
  pages: 12,
  stale: false,
  unconfined: null,
  section: 'Introduction',
  page: 1,
  suggest: { stops: 0, position: null, noMore: false },
  baseline: null,
  readOnly: false,
}

const recent = {
  count: 3,
  auto: 0,
  last: 'main.tex',
  options: [1, 2, 3].map((n) => ({ n, label: `main.tex · old words ${n} → new words ${n}` })),
}

export function rows() {
  return [
    { name: 'a paper, compiled', state: true, header: headerOf(header), footer: footerItems(footer) },
    {
      name: 'suggestions waiting, three accepted',
      state: true,
      header: headerOf({ ...header, tab: 'pdf', proposals: 2, recent, stale: 1, suggest: { stops: 2, position: '1 of 2', editing: false, busy: false }, commit: { why: null, waiting: 2 } }),
      footer: footerItems({ ...footer, suggest: { stops: 2, position: '1 of 2', noMore: false }, accepted: { count: 3, auto: 0 }, outOfDate: 1 }),
    },
    {
      name: 'compiling, in a chapter file',
      state: true,
      header: headerOf({ ...header, file: 'chapters/intro.tex', compiling: true, log: { open: true, warnings: 2 } }),
      footer: footerItems({ ...footer, file: 'chapters/intro.tex', main: 'main.tex', saved: 'dirty', compiling: true, warnings: 2 }),
    },
    {
      name: 'the last compile failed',
      state: true,
      header: headerOf({ ...header, ran: { ok: false, ms: 900, first: 'Undefined control sequence' }, pdf: false, pages: null }),
      footer: footerItems({ ...footer, ran: { ok: false, ms: 900, first: 'Undefined control sequence' }, pages: null, page: null }),
    },
  ]
}

export const ROWS_PATH = join(import.meta.dir, '..', 'kehikot.rows.json')
export const rowsText = () => `${JSON.stringify(rows(), null, 2)}\n`

if (import.meta.main) writeFileSync(ROWS_PATH, rowsText())
