import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MESSAGE, PROTOCOL, type EpicPart, type Passage } from 'kehikot-module-protocol'
import { createHash } from 'node:crypto'

import { parseLatex } from '../latex/parse.ts'
import { standIn } from '../src/api.ts'
import { pdfWas } from '../src/remembered.ts'
import type { EditorProps } from '../src/editor/source-editor.tsx'
import type { PreviewProps } from '../src/pdf/pdf-view.tsx'
import { usePaper } from '../src/use-paper.ts'
import { Workspace } from '../src/workspace.tsx'
import { press } from './menu.ts'

/**
 * The page with a picked part compiled on its own.
 *
 * `part.test.ts` has the rule and the arithmetic, `part-build.test.ts` the
 * compiling. This is what the page does with them, greeted and told over the
 * real wire as `focus-page.test.tsx` does it: which PDF is in front, what it
 * is asked, what is compiled when — and that a sheet of the part's own PDF
 * never leaves the page as though it were a page of the paper.
 *
 * The paper: `main.tex` prints pages 1–5 and 12; the design chapter 6–7 and
 * the method chapter 8–9, both pulled in with `\include`; a loose file, pulled
 * in with `\input`, 10–11. The method chapter compiled on its own is a PDF of
 * eight sheets — `main.tex` on 1–5 and 8, the chapter on 6 and 7 — so sheet 6
 * is page 8, and a 6 or a 7 said about the method chapter is a leak.
 */

const PROJECT = '/tmp/project'
const EPIC = 'a-paper'
const DIR = `${PROJECT}/.kehikot/paper/${EPIC}`
const FILES = ['main.tex', 'chapters/design.tex', 'chapters/method.tex', 'chapters/loose.tex']
const TEXT: Record<string, string> = {
  'main.tex': ['\\documentclass{report}', '\\begin{document}', 'Front.', '\\include{chapters/design}', '\\include{chapters/method}', '\\input{chapters/loose}', '\\end{document}', ''].join('\n'),
  'chapters/design.tex': ['\\chapter{Design}', 'The design is this.', ''].join('\n'),
  'chapters/method.tex': ['\\chapter{Method}', 'The method is that.', 'And it goes on.', ''].join('\n'),
  'chapters/loose.tex': ['\\section{Loose}', 'Pulled in with input.', ''].join('\n'),
}
const PULLS = {
  'chapters/design.tex': { by: 'main.tex', with: 'include', as: 'chapters/design' },
  'chapters/method.tex': { by: 'main.tex', with: 'include', as: 'chapters/method' },
  'chapters/loose.tex': { by: 'main.tex', with: 'input', as: 'chapters/loose' },
}
const MAP = {
  'main.tex': [1, 2, 3, 4, 5, 12].map((page) => ({ page, from: 1, to: 7 })),
  'chapters/design.tex': [{ page: 6, from: 1, to: 1 }, { page: 7, from: 2, to: 2 }],
  'chapters/method.tex': [{ page: 8, from: 1, to: 2 }, { page: 9, from: 3, to: 3 }],
  'chapters/loose.tex': [{ page: 10, from: 1, to: 1 }, { page: 11, from: 2, to: 2 }],
}
/** The method chapter's own PDF, in ITS sheets. */
const PART_MAP = {
  'main.tex': [1, 2, 3, 4, 5, 8].map((page) => ({ page, from: 1, to: 7 })),
  'chapters/method.tex': [{ page: 6, from: 1, to: 2 }, { page: 7, from: 3, to: 3 }],
}
const KEY = '0123456789abcdef'

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown> | null
}

let disk: Record<string, string>
let calls: Call[]
let built: string | null
/** The part's own build, once it has been made: its id. */
let partBuilt: string | null
/** The props each pane was last drawn with: '' is the whole paper's, anything else a part's own. */
let panes: Record<string, PreviewProps>
/** While set, a compile of a part does not answer until it resolves. */
let gate: Promise<void> | null
interface Asked {
  type?: string
  method?: string
  params?: { passage?: Passage | null; documents?: Passage[] }
}
let asks: Asked[]
const fetchWas = globalThis.fetch

const hashes = () => Object.fromEntries(FILES.map((file) => [file, hashOf(disk[file]!)]))
/** What the whole paper's PDF was made of: it stays behind while a part is worked in. */
let wholeHashes: Record<string, string>
const paperNow = () => ({
  epic: EPIC,
  dir: DIR,
  title: null,
  author: null,
  blocks: FILES.flatMap((file) => parseLatex(disk[file]!, file).blocks.map((block) => ({ ...block, file }))),
  outline: [],
  files: FILES,
  hashes: hashes(),
  figures: [],
  pulls: PULLS,
  narrowsItself: false,
})
const buildNow = () => ({
  engine: 'latexmk',
  engines: ['latexmk'],
  how: '',
  running: false,
  last: built ? { ok: true, at: 1, ms: 12000, engine: 'latexmk', timedOut: false, problems: [], tail: '' } : null,
  pdf: built ? { id: built, at: 1, pages: 12, hashes: wholeHashes, map: MAP } : null,
})
const partNow = (files: string[]) => {
  if (files.includes('chapters/loose.tex')) return { key: '', only: [], cannot: 'cannot', running: false, last: null, pdf: null }
  if (files.join() !== 'chapters/method.tex') return null
  return {
    key: KEY,
    only: ['chapters/method'],
    cannot: null,
    running: false,
    last: partBuilt ? { ok: true, at: 2, ms: 2500, engine: 'latexmk', timedOut: false, problems: [], tail: '' } : null,
    pdf: partBuilt ? { id: partBuilt, at: 2, pages: 8, hashes: hashes(), map: PART_MAP } : null,
  }
}

function serve(path: string, query: URLSearchParams, body: Record<string, unknown> | null, method: string): [number, unknown] {
  const file = String(query.get('file') ?? body?.file ?? 'main.tex')
  if (path === '/api/paper') return [200, { ok: true, paper: paperNow() }]
  if (path === '/api/source') return [200, { ok: true, source: disk[file], hash: hashOf(disk[file]!) }]
  if (path === '/api/build') return [200, { ok: true, build: buildNow() }]
  if (path === '/api/compile') {
    built = `build-${calls.filter((one) => one.path === '/api/compile').length}`
    wholeHashes = hashes()
    return [200, { ok: true, build: buildNow() }]
  }
  if (path === '/api/part' && method === 'GET') return [200, { ok: true, part: partNow(JSON.parse(query.get('files') ?? '[]') as string[]) }]
  if (path === '/api/part') {
    const files = body?.files as string[]
    if (body?.full === true && JSON.stringify(wholeHashes) !== JSON.stringify(hashes())) {
      built = `build-for-part-${calls.length}`
      wholeHashes = hashes()
    }
    if (files.join() === 'chapters/method.tex') partBuilt = `part-${calls.filter((one) => one.path === '/api/part' && one.method === 'POST').length}`
    return [200, { ok: true, build: buildNow(), part: partNow(files) }]
  }
  if (path === '/api/proposals') return [200, { ok: true, proposals: [], said: '' }]
  if (path === '/api/uncommitted') return [200, { ok: true, standing: { at: 'nogit' }, hashes: hashes() }]
  if (path === '/api/file') {
    disk[file] = String(body?.text)
    return [200, { ok: true, hash: hashOf(disk[file]!), paper: paperNow(), proposals: [], said: '' }]
  }
  if (path === '/api/sync') {
    const of = query.get('part') ? (PART_MAP as Record<string, { page: number }[]>) : (MAP as Record<string, { page: number }[]>)
    if (query.has('page')) return [200, { ok: true, found: { build: built, file: 'chapters/method.tex', line: 2 } }]
    const page = of[file]?.[0]?.page
    const line = Number(query.get('line'))
    if (page === undefined) return [200, { ok: true, found: { build: built, exact: false, line: null, rects: [] } }]
    return [200, { ok: true, found: { build: built, exact: file !== 'main.tex', line, rects: [{ page, x: 10, y: 20, w: 30, h: 8 }] } }]
  }
  return [404, { ok: false, error: `no ${path} in this test` }]
}

function Textarea(props: EditorProps) {
  return (
    <textarea
      aria-label="LaTeX source"
      value={props.value}
      data-mark={props.mark ? `${props.mark.from}-${props.mark.to}` : ''}
      onChange={(event) => props.onChange(event.target.value)}
    />
  )
}

function Stub(props: PreviewProps) {
  panes[props.kind ?? ''] = props
  return <div data-testid={props.kind ? 'part-preview' : 'preview'} data-pages={props.pages ? props.pages.join(',') : 'all'} data-marks={props.marks.length} />
}

/** The page as a host frames it: the wire hook listening, and the workspace once there is a paper. */
function Framed() {
  const wire = usePaper(true)
  if (wire.sight.at !== 'reading') return <p data-testid="sight">{wire.sight.at}</p>
  return (
    <>
      <Workspace paper={wire.sight.paper} wire={wire} editor={Textarea} preview={Stub} saveDelay={15} settle={5} />
      <p data-testid="said">{wire.said}</p>
    </>
  )
}

/** A host, as far as a page can tell: something that greets it and sends contexts. */
function host() {
  const source = { postMessage: (data: Asked) => void asks.push(data) }
  const post = (data: unknown) => {
    const event = new MessageEvent('message', { data, origin: 'http://localhost:7777' })
    Object.defineProperty(event, 'source', { value: source })
    act(() => {
      window.dispatchEvent(event)
    })
  }
  const context = (parts: EpicPart[], passage: Passage | null = null) => ({
    epic: EPIC,
    project: 'project',
    projectPath: PROJECT,
    theme: 'light',
    selection: [],
    parts,
    passage,
  })
  return {
    greet: (parts: EpicPart[] = [], passage: Passage | null = null) =>
      post({ type: MESSAGE.HELLO, protocol: PROTOCOL, session: 's', context: context(parts, passage), state: null }),
    context: (parts: EpicPart[], passage: Passage | null = null) => post({ type: MESSAGE.CONTEXT, protocol: PROTOCOL, ...context(parts, passage) }),
  }
}

const part = (id: string, heading: string, picked: boolean, files?: string[]): EpicPart => ({ id, heading, refs: [], picked, ...(files ? { files } : {}) })
const PARTS = (...picked: string[]): EpicPart[] => [
  part('the-design', 'The design', picked.includes('the-design'), ['chapters/design.tex']),
  part('the-method', 'The method', picked.includes('the-method'), ['chapters/method.tex']),
  part('the-loose', 'Loose ends', picked.includes('the-loose'), ['chapters/loose.tex']),
]

const openFile = () => document.querySelector('[data-editing]')?.getAttribute('data-editing')
const asked = (path: string, method = '') => calls.filter((one) => one.path === path && (!method || one.method === method))
/** Which pane is in front: 'part', 'whole', or null when no page is drawn. */
const inFront = () => [...document.querySelectorAll<HTMLElement>('[data-pdf]')].filter((one) => !one.classList.contains('hidden')).map((one) => one.dataset.pdf).join('+') || null
const said = () => asks.filter((one) => one.method === 'passage.set').map((one) => one.params?.passage ?? null)
const at = (file: string, from: number, to: number): Passage => ({ path: `${DIR}/${file}`, page: null, from, to, quoted: disk[file]!.slice(from, to), section: null })

const framed = async (parts: EpicPart[] = [], passage: Passage | null = null) => {
  built = 'kept'
  const canvas = host()
  render(<Framed />)
  canvas.greet(parts, passage)
  await screen.findByLabelText('LaTeX source')
  return canvas
}

beforeEach(() => {
  disk = { ...TEXT }
  wholeHashes = hashes()
  calls = []
  asks = []
  built = null
  partBuilt = null
  panes = {}
  gate = null
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:7870')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ method, path: url.pathname, query: url.searchParams, body })
    /* A compile takes seconds: a test that has to see the page WHILE one runs holds it here. */
    if (method === 'POST' && url.pathname === '/api/part' && gate) await gate
    const [status, answer] = serve(url.pathname, url.searchParams, body, method)
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = fetchWas
  standIn(null)
  try {
    window.sessionStorage.clear()
  } catch {
    /* No storage in this DOM: nothing was kept. */
  }
})

describe('with nothing picked', () => {
  test('no part is asked about or compiled, and the one pane is the whole paper’s', async () => {
    await framed(PARTS())
    await waitFor(() => expect(inFront()).toBe('whole'))
    await new Promise((done) => setTimeout(done, 320))
    expect(asked('/api/part')).toEqual([])
    expect(panes['']!.pages).toBeUndefined()
    expect(panes['']!.numbers).toBeUndefined()
    expect(Object.keys(panes)).toEqual([''])
  })
})

describe('a part whose file is \\include’d is picked', () => {
  test('its files are compiled on their own, and that PDF takes the pane — its sheets called by the paper’s pages', async () => {
    const canvas = await framed(PARTS())
    await waitFor(() => expect(inFront()).toBe('whole'))
    canvas.context(PARTS('the-method'))
    /* At once: the chapter's pages in the whole paper, as a pick always showed. */
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('8,9'))
    /* Then its own PDF. Asked for once the pick has held still, and for the whole paper to be of this text first. */
    await waitFor(() => expect(inFront()).toBe('part'))
    const posts = asked('/api/part', 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toEqual({ files: ['chapters/method.tex'], full: true })
    expect(asked('/api/compile')).toEqual([])

    const pane = panes['chapters/method']!
    expect(pane.url).toContain(`part=${KEY}`)
    /* In ITS sheets: the two the chapter printed, and not the title pages or the bibliography `main.tex` printed. */
    expect(pane.pages).toEqual([6, 7])
    /* And what each sheet is called: the page of the paper. */
    expect(pane.numbers).toEqual([null, null, null, null, null, 8, 9, null])
    expect(pane.total).toBe(12)
    expect(openFile()).toBe('chapters/method.tex')
    expect(document.querySelector('[data-no-pages]')).toBeNull()
    /* No row about any of it. */
    expect(document.querySelectorAll('[data-focus], .paper-focus, [data-focus-note], [role="alert"]').length).toBe(0)
  })

  test('everything asked about a place is asked of the PDF in front', async () => {
    await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    await waitFor(() => expect(panes['chapters/method']!.marks.length).toBe(1))
    const sync = asked('/api/sync').at(-1)!
    expect(sync.query.get('part')).toBe(KEY)
    expect(sync.query.get('file')).toBe('chapters/method.tex')
    /* The mark is in the part's sheets, where it is drawn… */
    expect(panes['chapters/method']!.marks[0]!.rects[0]!.page).toBe(6)
    /* …and the pane behind is handed none. */
    expect(panes['']!.marks).toEqual([])

    /* A press on the part's PDF names a sheet of the part's PDF, and says so. */
    act(() => panes['chapters/method']!.onPoint({ page: 7, x: 5, y: 5, word: null }))
    await waitFor(() => expect(asked('/api/sync').some((one) => one.query.get('page') === '7' && one.query.get('part') === KEY)).toBe(true))
  })

  test('NO SHEET NUMBER LEAVES: what is said to the canvas, and read out, is the page of the paper', async () => {
    await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    await waitFor(() => expect(said().some((one) => one?.path === `${DIR}/chapters/method.tex`)).toBe(true))
    await waitFor(() => expect(document.querySelector('[data-build]')!.textContent).toContain('p. 8/12'))
    for (const passage of said()) {
      if (passage?.path !== `${DIR}/chapters/method.tex`) continue
      /* The chapter is on sheets 6 and 7 of its own PDF and on pages 8 and 9 of the paper. */
      expect([8, 9]).toContain(passage.page as number)
    }
  })

  test('a save compiles the part — not the whole paper, which waits', async () => {
    await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    const before = asked('/api/part', 'POST').length
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: `${TEXT['chapters/method.tex']}One more line.\n` } })
    await waitFor(() => expect(asked('/api/part', 'POST').length).toBe(before + 1))
    expect(asked('/api/part', 'POST').at(-1)!.body).toEqual({ files: ['chapters/method.tex'] })
    await waitFor(() => expect(panes['chapters/method']!.url).toContain(`build=part-${before + 1}`))
    expect(asked('/api/compile')).toEqual([])
    /* Its own PDF is of the text on disk, and says nothing about being behind — the whole paper's is not on screen to be. */
    expect(document.body.textContent).not.toContain('earlier save')
  })

  test('lifting the pick is leaving the part: the whole paper is then made of the text as it is', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: `${TEXT['chapters/method.tex']}One more line.\n` } })
    await waitFor(() => expect(asked('/api/part', 'POST').length).toBe(2))
    expect(asked('/api/compile')).toEqual([])
    canvas.context(PARTS())
    await waitFor(() => expect(asked('/api/compile')).toHaveLength(1))
    await waitFor(() => expect(inFront()).toBe('whole'))
    expect(panes['']!.pages).toBeUndefined()
  })

  test('pressing Compile asks for both, whatever stands', async () => {
    await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    press('compile')
    await waitFor(() => expect(asked('/api/part', 'POST').at(-1)!.body).toEqual({ files: ['chapters/method.tex'], force: true }))
  })
})

describe('a passage outside the picked files', () => {
  test('brings the whole paper, whole, for as long as its mark is up — and the part’s PDF comes back when it is taken down', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    canvas.context(PARTS('the-method'), at('chapters/design.tex', 16, 35))
    await waitFor(() => expect(inFront()).toBe('whole'))
    await waitFor(() => expect(panes['']!.marks.some((mark) => mark.foreign)).toBe(true))
    /* Every page, not the picked ones with one more: the paper, at that place. */
    expect(panes['']!.pages).toBeUndefined()
    expect(panes['']!.marks.find((mark) => mark.foreign)!.rects[0]!.page).toBe(6)
    /* Asked of the whole paper's table, not the part's. */
    expect(asked('/api/sync').filter((one) => one.query.get('file') === 'chapters/design.tex').every((one) => !one.query.has('part'))).toBe(true)
    expect(panes['chapters/method']!.marks).toEqual([])
    expect(openFile()).toBe('chapters/design.tex')
    await waitFor(() => expect(document.querySelector('[data-build]')!.textContent).toContain('p. 6/12'))

    /* It does not go back and forth by itself. */
    const seen = new Set<string | null>()
    for (let i = 0; i < 12; i += 1) {
      seen.add(inFront())
      await new Promise((done) => setTimeout(done, 20))
    }
    expect([...seen]).toEqual(['whole'])

    /* The neighbour lets go. */
    canvas.context(PARTS('the-method'), null)
    await waitFor(() => expect(inFront()).toBe('part'))
  })

  test('a passage INSIDE them is marked on the part’s own PDF, and read out as the paper’s page', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    canvas.context(PARTS('the-method'), at('chapters/method.tex', 16, 35))
    await waitFor(() => expect(panes['chapters/method']!.marks.some((mark) => mark.foreign)).toBe(true))
    expect(inFront()).toBe('part')
    expect(panes['chapters/method']!.marks.find((mark) => mark.foreign)!.rects[0]!.page).toBe(6)
    await waitFor(() => expect(document.querySelector('[data-build]')!.textContent).toContain('p. 8/12'))
  })

  test('with the whole paper behind the text, calling it onto the screen makes it current', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: `${TEXT['chapters/method.tex']}One more line.\n` } })
    await waitFor(() => expect(asked('/api/part', 'POST').length).toBe(2))
    canvas.context(PARTS('the-method'), at('chapters/design.tex', 16, 35))
    await waitFor(() => expect(asked('/api/part', 'POST').at(-1)!.body).toEqual({ files: ['chapters/method.tex'], full: true }))
    await waitFor(() => expect(panes['']!.url).toContain('build=build-for-part-'))
  })
})

describe('a PDF that is not of the text is never asked where a passage is', () => {
  const held = () => {
    let open = () => {}
    gate = new Promise<void>((done) => {
      open = () => {
        gate = null
        done()
      }
    })
    return () => act(() => open())
  }
  const syncsFor = (file: string) => asked('/api/sync').filter((one) => one.query.get('file') === file)

  test('the whole paper, behind on purpose while a part is worked in: a passage outside is looked for by its words, and marked by the table when the full build lands — nothing pressed', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    /* The design chapter changes on disk — another editor, an agent — while the method chapter is what is compiled. */
    disk['chapters/design.tex'] = ['\\chapter{Design}', 'A line added above.', 'The design is this.', ''].join('\n')
    const before = asked('/api/part', 'POST').length
    const release = held()
    canvas.context(PARTS('the-method'), at('chapters/design.tex', 37, 56))
    await waitFor(() => expect(inFront()).toBe('whole'))
    /* The whole paper is asked to be made of this text… */
    await waitFor(() => expect(asked('/api/part', 'POST').length).toBe(before + 1))
    expect(asked('/api/part', 'POST').at(-1)!.body).toEqual({ files: ['chapters/method.tex'], full: true })
    /* …and until it is, its table is not asked about that file: the mark is the passage's words alone. */
    await waitFor(() => expect(panes['']!.marks.some((mark) => mark.foreign)).toBe(true))
    const alone = panes['']!.marks.find((mark) => mark.foreign)!
    expect(alone.rects).toEqual([])
    expect(alone.source!.text.slice(alone.source!.from, alone.source!.to)).toBe('The design is this.')
    await new Promise((done) => setTimeout(done, 60))
    /* (The caret's own line, where the editor was taken, is asked as it always is; the passage's line is not.) */
    expect(syncsFor('chapters/design.tex').filter((one) => one.query.get('line') === '3')).toEqual([])
    expect(panes['']!.url).toContain('build=kept')

    /* The full build lands. */
    release()
    await waitFor(() => expect(panes['']!.url).toContain('build=build-for-part-'))
    await waitFor(() => expect(panes['']!.marks.find((mark) => mark.foreign)?.rects[0]?.page).toBe(6))
    expect(syncsFor('chapters/design.tex').some((one) => one.query.get('line') === '3')).toBe(true)
    expect(syncsFor('chapters/design.tex').every((one) => !one.query.has('part'))).toBe(true)
    expect(inFront()).toBe('whole')
  })

  test('a file outside the part that has NOT changed since the full build is asked at once: its rows of that table are what they were', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: `${TEXT['chapters/method.tex']}One more line.\n` } })
    await waitFor(() => expect(asked('/api/part', 'POST').length).toBe(2))
    const release = held()
    canvas.context(PARTS('the-method'), at('chapters/design.tex', 16, 35))
    await waitFor(() => expect(panes['']!.marks.find((mark) => mark.foreign)?.rects[0]?.page).toBe(6))
    expect(panes['']!.url).toContain('build=kept')
    release()
  })

  test('the part’s own PDF, behind what was just typed: a passage inside the part is its words alone on THAT PDF until the part’s compile lands', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    await waitFor(() => expect(panes['chapters/method']!.marks.length).toBe(1))
    const release = held()
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: `A line added above.\n${TEXT['chapters/method.tex']}` } })
    await waitFor(() => expect(asked('/api/part', 'POST').length).toBe(2))
    const asksBefore = syncsFor('chapters/method.tex').length
    canvas.context(PARTS('the-method'), at('chapters/method.tex', 37, 56))
    await waitFor(() => expect(panes['chapters/method']!.marks.some((mark) => mark.foreign)).toBe(true))
    const alone = panes['chapters/method']!.marks.find((mark) => mark.foreign)!
    expect(alone.rects).toEqual([])
    expect(alone.source!.text.slice(alone.source!.from, alone.source!.to)).toBe('The method is that.')
    expect(inFront()).toBe('part')
    /* Nothing was asked of the part's table for the passage (its lines are counted in text that PDF was not made from)… */
    await new Promise((done) => setTimeout(done, 60))
    expect(syncsFor('chapters/method.tex').slice(asksBefore).filter((one) => one.query.get('line') === '2' && one.query.get('to') === '2')).toEqual([])
    /* …and nothing of the whole paper's either. */
    expect(syncsFor('chapters/method.tex').slice(asksBefore).every((one) => one.query.get('part') === KEY)).toBe(true)

    release()
    await waitFor(() => expect(panes['chapters/method']!.url).toContain('build=part-2'))
    await waitFor(() => expect(panes['chapters/method']!.marks.find((mark) => mark.foreign)?.rects[0]?.page).toBe(6))
    expect(syncsFor('chapters/method.tex').at(-1)!.query.get('part')).toBe(KEY)
  })
})

describe('a part whose file is pulled in with \\input', () => {
  test('draws no page and says why, in one sentence where the pages would have been — not its neighbours’ pages', async () => {
    const canvas = await framed(PARTS())
    await waitFor(() => expect(inFront()).toBe('whole'))
    canvas.context(PARTS('the-loose'))
    await waitFor(() => expect(inFront()).toBeNull())
    const sentence = document.querySelector('[data-cannot]')!
    expect(sentence.textContent).toBe(
      'No page is shown for the picked part: main.tex pulls chapters/loose.tex in with \\input, and only a file pulled in with \\include can be compiled on its own.',
    )
    expect(sentence.getAttribute('role')).toBe('status')
    expect(document.querySelectorAll('[data-no-pages]').length).toBe(1)
    await waitFor(() => expect(openFile()).toBe('chapters/loose.tex'))
    await new Promise((done) => setTimeout(done, 320))
    /* Nothing was compiled for it. */
    expect(asked('/api/part')).toEqual([])
    /* A save compiles the whole paper, as it always did: that is the PDF a mark would be shown on. */
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: `${TEXT['chapters/loose.tex']}More.\n` } })
    await waitFor(() => expect(asked('/api/compile')).toHaveLength(1))

    /* Lifting the pick puts the paper back. */
    canvas.context(PARTS())
    await waitFor(() => expect(inFront()).toBe('whole'))
    expect(document.querySelector('[data-cannot]')).toBeNull()
  })

  test('a passage pointed at still arrives: the whole paper, at that place, while its mark is up', async () => {
    const canvas = await framed(PARTS('the-loose'))
    await waitFor(() => expect(document.querySelector('[data-cannot]')).not.toBeNull())
    canvas.context(PARTS('the-loose'), at('chapters/loose.tex', 16, 30))
    await waitFor(() => expect(inFront()).toBe('whole'))
    expect(document.querySelector('[data-cannot]')).toBeNull()
    expect(panes['']!.pages).toBeUndefined()
    await waitFor(() => expect(panes['']!.marks.some((mark) => mark.foreign)).toBe(true))
    canvas.context(PARTS('the-loose'), null)
    await waitFor(() => expect(inFront()).toBeNull())
    expect(document.querySelector('[data-cannot]')).not.toBeNull()
  })

  test('a selection that mixes one with an \\include’d file cannot be shown either, and says which file', async () => {
    await framed(PARTS('the-method', 'the-loose'))
    await waitFor(() => expect(document.querySelector('[data-cannot]')?.textContent).toStartWith('No page is shown for the picked parts: main.tex pulls chapters/loose.tex in with \\input'))
    expect(inFront()).toBeNull()
  })
})

describe('coming back', () => {
  test('a reload with a part picked draws its own PDF from before, without the whole paper flashing up first', async () => {
    partBuilt = 'part-kept'
    const seen: (string | null)[] = []
    const watch = new MutationObserver(() => seen.push(inFront()))
    watch.observe(document.body, { subtree: true, childList: true, attributes: true })
    await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    watch.disconnect()
    expect(seen.filter((one) => one === 'whole')).toEqual([])
    expect(panes['chapters/method']!.url).toContain('build=part-')
  })

  test('each PDF keeps its own place: the part’s is remembered under the part, the paper’s under the paper', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    act(() => panes['chapters/method']!.onScrolled?.(432, 'chapters/method'))
    act(() => panes['']!.onScrolled?.(77))
    expect(pdfWas(PROJECT, EPIC, 'chapters/method')?.top).toBe(432)
    expect(pdfWas(PROJECT, EPIC)?.top).toBe(77)
    cleanup()
    await framed(PARTS('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    expect(panes['chapters/method']!.from).toBe(432)
    void canvas
  })
})

describe('the same pick from a host that sends a part’s documents', () => {
  /* A host that keeps the parts unions what the modules publish: each part has
     `documents`, project-relative, and `files` beside them for older modules. */
  const withDocuments = (...picked: string[]): EpicPart[] =>
    PARTS(...picked).map((one) => ({ ...one, documents: (one.files ?? []).map((file) => `.kehikot/paper/${EPIC}/${file}`) }))
  /* And one that sends ONLY documents is narrowed the same: nothing here reads `files` for the rule. */
  const onlyDocuments = (...picked: string[]): EpicPart[] => withDocuments(...picked).map(({ files: _, ...rest }) => rest)

  test.each([
    ['documents and files', withDocuments],
    ['documents alone', onlyDocuments],
  ])('%s: the chapter compiled on its own, its sheets and no others, called by the paper’s pages', async (_, said) => {
    const canvas = await framed(said())
    await waitFor(() => expect(inFront()).toBe('whole'))
    canvas.context(said('the-method'))
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('8,9'))
    await waitFor(() => expect(inFront()).toBe('part'))
    expect(asked('/api/part', 'POST')[0]!.body).toEqual({ files: ['chapters/method.tex'], full: true })
    const pane = panes['chapters/method']!
    expect(pane.pages).toEqual([6, 7])
    expect(pane.numbers).toEqual([null, null, null, null, null, 8, 9, null])
    expect(pane.total).toBe(12)
    expect(openFile()).toBe('chapters/method.tex')
  })

  test('nothing is handed to the pane about what was left out: no rule, no flag, no “outside”', async () => {
    await framed(withDocuments('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    for (const pane of Object.values(panes)) {
      expect('outside' in pane).toBe(false)
      expect('outsideOf' in pane).toBe(false)
    }
    expect(document.body.textContent).not.toMatch(/outside|shown anyway/i)
  })

  test('a passage in a file the part does not have still brings the whole paper, and says nothing about the pick', async () => {
    const canvas = await framed(withDocuments('the-method'))
    await waitFor(() => expect(inFront()).toBe('part'))
    canvas.context(withDocuments('the-method'), at('chapters/design.tex', 16, 26))
    await waitFor(() => expect(inFront()).toBe('whole'))
    expect(panes['']!.pages).toBeUndefined()
    expect(screen.getByTestId('said').textContent).toBe('Something pointed at chapters/design.tex, bytes 16–26. It is marked in the source.')
  })
})
