import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MESSAGE, PROTOCOL, type EpicPart, type Passage } from 'kehikot-module-protocol'
import { createHash } from 'node:crypto'
import { StrictMode } from 'react'

import { parseLatex } from '../latex/parse.ts'
import { standIn } from '../src/api.ts'
import type { EditorProps } from '../src/editor/source-editor.tsx'
import { fileOnOpening, narrowed } from '../src/focus.ts'
import type { PreviewProps } from '../src/pdf/pdf-view.tsx'
import { keptPlace, placeWas, rememberPlace } from '../src/remembered.ts'
import type { Paper } from '../store.ts'
import { usePaper } from '../src/use-paper.ts'
import { Workspace } from '../src/workspace.tsx'

/**
 * A page that is loaded again comes back to where its reader was.
 *
 * "Loaded again" here is the page unmounted and mounted and greeted afresh,
 * with the tab's session storage — and what the host was asked to keep — left
 * as the last page left them. That is everything a reload, a frame mounted
 * again or a module restarted has in common. The host is the one
 * `test/focus-page.test.tsx` has, with one thing added: it keeps what the page
 * asks it to keep, as a host does, so the next greeting can hand it back.
 *
 * What the real editor and the real PDF pane do with the offsets they are
 * handed is checked in a browser; here it is that they ARE handed them.
 */

const PROJECT = '/tmp/project'
const FILES = ['main.tex', 'chapters/design.tex', 'chapters/method.tex']
const TEXT: Record<string, string> = {
  'main.tex': ['\\documentclass{article}', '\\begin{document}', '\\section{Opening}', 'Said in main.', '\\input{chapters/design}', '\\input{chapters/method}', '\\end{document}', ''].join('\n'),
  'chapters/design.tex': ['\\section{Design}', 'The design is this.', '\\subsection{Seams}', 'A seam.', ''].join('\n'),
  'chapters/method.tex': ['\\section{Method}', 'The method is that.', ''].join('\n'),
}
const MAP = {
  'main.tex': [{ page: 1, from: 1, to: 4 }, { page: 5, from: 7, to: 7 }],
  'chapters/design.tex': [{ page: 2, from: 1, to: 2 }, { page: 3, from: 3, to: 4 }],
  'chapters/method.tex': [{ page: 3, from: 1, to: 1 }, { page: 4, from: 2, to: 2 }],
}

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

let disk: Record<string, string>
let files: string[]
let lastEditor: EditorProps | null
let lastPreview: PreviewProps | null
/** What the host holds for this module: the last string a page asked it to keep. */
let kept: string | null
let keeps: number
const fetchWas = globalThis.fetch

const hashes = () => Object.fromEntries(files.map((file) => [file, hashOf(disk[file]!)]))
const paperNow = (epic: string) => ({
  epic,
  dir: `${PROJECT}/.kehikot/paper/${epic}`,
  title: null,
  author: null,
  blocks: files.flatMap((file) => parseLatex(disk[file]!, file).blocks.map((block) => ({ ...block, file }))),
  outline: [],
  files,
  hashes: hashes(),
  figures: [],
})
const buildNow = () => ({
  engine: 'tectonic',
  engines: ['tectonic'],
  how: '',
  running: false,
  last: { ok: true, at: 1, ms: 2100, engine: 'tectonic', timedOut: false, problems: [], tail: '' },
  pdf: { id: 'kept', at: 1, pages: 5, hashes: hashes(), map: MAP },
})

function serve(path: string, query: URLSearchParams): [number, unknown] {
  const file = String(query.get('file') ?? 'main.tex')
  if (path === '/api/paper') return [200, { ok: true, paper: paperNow(String(query.get('epic'))) }]
  if (path === '/api/source') return [200, { ok: true, source: disk[file], hash: hashOf(disk[file]!) }]
  if (path === '/api/build' || path === '/api/compile') return [200, { ok: true, build: buildNow() }]
  if (path === '/api/proposals') return [200, { ok: true, proposals: [], said: '' }]
  if (path === '/api/uncommitted') return [200, { ok: true, standing: { at: 'nogit' }, hashes: hashes() }]
  if (path === '/api/sync') return [200, { ok: true, found: { build: 'kept', exact: true, line: Number(query.get('line')), rects: [{ page: 2, x: 10, y: 20, w: 30, h: 8 }] } }]
  return [404, { ok: false, error: `no ${path} in this test` }]
}

function Textarea(props: EditorProps) {
  lastEditor = props
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
  lastPreview = props
  return <div data-testid="preview" />
}

function Framed() {
  const wire = usePaper(true)
  if (wire.sight.at !== 'reading') return <p data-testid="sight">{wire.sight.at}</p>
  return <Workspace paper={wire.sight.paper} wire={wire} editor={Textarea} preview={Stub} saveDelay={15} settle={5} />
}

const part = (id: string, picked: boolean, owned: string[]): EpicPart => ({ id, heading: id, refs: [], picked, files: owned })
const PARTS = (...picked: string[]): EpicPart[] => [
  part('the-design', picked.includes('the-design'), ['chapters/design.tex']),
  part('the-method', picked.includes('the-method'), ['chapters/method.tex']),
]

const openFile = () => document.querySelector('[data-editing]')?.getAttribute('data-editing')
const tabInFront = () => [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((one) => one.textContent).join()
const editorText = () => (screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value

/**
 * Load the page and greet it, as a host that kept what the last page asked.
 * `strict` is how `main.tsx` really mounts it: every effect twice.
 */
async function load({ epic = 'a-paper', parts = [] as EpicPart[], passage = null as Passage | null, strict = false } = {}) {
  lastEditor = null
  lastPreview = null
  const source = {
    postMessage: (data: { type?: string; method?: string; params?: { state?: string } }) => {
      if (data?.type !== MESSAGE.REQUEST || data.method !== 'state.set') return
      kept = data.params?.state ?? null
      keeps += 1
    },
  }
  render(strict ? <StrictMode><Framed /></StrictMode> : <Framed />)
  const event = new MessageEvent('message', {
    data: {
      type: MESSAGE.HELLO,
      protocol: PROTOCOL,
      session: 's',
      context: { epic, project: 'project', projectPath: PROJECT, theme: 'light', selection: [], parts, passage },
      state: kept,
    },
    origin: 'http://localhost:7777',
  })
  Object.defineProperty(event, 'source', { value: source })
  act(() => {
    window.dispatchEvent(event)
  })
  await screen.findByLabelText('LaTeX source')
  await waitFor(() => expect(lastPreview).not.toBeNull())
}

/** Go into the design chapter, select "design" in it, scroll both panes, and put the PDF in front. */
async function wander() {
  fireEvent.change(screen.getByLabelText('Sections'), { target: { value: '1' } })
  await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
  const at = TEXT['chapters/design.tex']!.indexOf('design is')
  act(() => lastEditor!.onSelect({ from: at, to: at + 6 }))
  act(() => lastEditor!.onScrolled!(TEXT['chapters/design.tex']!.indexOf('The design')))
  act(() => lastPreview!.onScrolled!(1234.5))
  fireEvent.click(screen.getByRole('tab', { name: 'PDF' }))
  await waitFor(() => expect(JSON.parse(kept ?? '{}')).toEqual({ project: PROJECT, epic: 'a-paper', file: 'chapters/design.tex', tab: 'pdf' }))
  return at
}

beforeEach(() => {
  disk = { ...TEXT }
  files = [...FILES]
  kept = null
  keeps = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://127.0.0.1:7870')
    const [status, answer] = serve(url.pathname, url.searchParams)
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = fetchWas
  standIn(null)
})

describe('a page that is loaded again', () => {
  test('comes back to the file, the tab, the selection and both scroll positions', async () => {
    await load()
    expect(openFile()).toBe('main.tex')
    expect(lastPreview!.from).toBe(0)
    const at = await wander()

    cleanup()
    await load({ strict: true })
    await waitFor(() => expect(openFile()).toBe('chapters/design.tex'))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
    expect(tabInFront()).toBe('PDF')
    /* The selection is put back as a selection, the line that was at the top
       of the editor goes back to the top, and the caret is not taken from
       wherever the person's hands now are. */
    await waitFor(() => expect(lastEditor!.jump).toMatchObject({ from: at, to: at + 6, select: true, focus: false, top: TEXT['chapters/design.tex']!.indexOf('The design') }))
    expect(lastPreview!.from).toBe(1234.5)
    /* And the PDF is not then turned to that selection: it was put back to
       where IT was, and nobody has selected anything since. */
    await new Promise((done) => setTimeout(done, 40))
    expect(lastPreview!.reveal).toBeNull()
  })

  test('with only what the host kept — another window, the app started again — comes back to the file and the tab', async () => {
    await load()
    await wander()
    const asked = keeps

    cleanup()
    window.sessionStorage.clear()
    await load()
    await waitFor(() => expect(openFile()).toBe('chapters/design.tex'))
    expect(tabInFront()).toBe('PDF')
    /* The caret and the scroll were never sent to the host, so there is none to put back… */
    expect(lastEditor!.jump).toBeNull()
    expect(lastPreview!.from).toBe(0)
    /* …and the host is not told again what it has just said. */
    await new Promise((done) => setTimeout(done, 20))
    expect(keeps).toBe(asked)
  })

  test('a file that changed on disk meanwhile is opened, and the place in it is not guessed at', async () => {
    await load()
    await wander()
    cleanup()
    disk['chapters/design.tex'] = `% a line that was not there\n${TEXT['chapters/design.tex']!}`
    await load()
    await waitFor(() => expect(editorText()).toBe(disk['chapters/design.tex']!))
    await new Promise((done) => setTimeout(done, 20))
    expect(lastEditor!.jump).toBeNull()
  })

  test('a remembered file the paper no longer names falls back to main.tex', async () => {
    await load()
    await wander()
    cleanup()
    files = ['main.tex', 'chapters/method.tex']
    await load({ strict: true })
    await waitFor(() => expect(editorText()).toBe(TEXT['main.tex']!))
    expect(openFile()).toBe('main.tex')
    expect(lastEditor!.jump).toBeNull()
  })

  test('a remembered file outside the parts now picked gives way to them, and one inside them does not', async () => {
    await load()
    await wander()
    cleanup()
    await load({ parts: PARTS('the-method'), strict: true })
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    expect(openFile()).toBe('chapters/method.tex')
    expect(document.querySelector('[data-outside-file]')).toBeNull()
    /* The PDF was scrolled with nothing picked: those points are down other sheets. */
    expect(lastPreview!.from).toBe(0)

    /* Now the method is the remembered file, and it is the SECOND of the picked parts' files. */
    cleanup()
    await load({ parts: PARTS('the-design', 'the-method'), strict: true })
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    expect(openFile()).toBe('chapters/method.tex')
  })

  test('another epic does not inherit it, and coming back to the first still finds it', async () => {
    await load()
    await wander()
    cleanup()
    await load({ epic: 'another-paper', strict: true })
    await waitFor(() => expect(editorText()).toBe(TEXT['main.tex']!))
    expect(openFile()).toBe('main.tex')
    expect(tabInFront()).toBe('Source')
    expect(lastEditor!.jump).toBeNull()
    expect(lastPreview!.from).toBe(0)
    /* The host's one line is now about the other paper; this tab still knows the first. */
    await waitFor(() => expect(JSON.parse(kept ?? '{}').epic).toBe('another-paper'))

    cleanup()
    await load()
    await waitFor(() => expect(openFile()).toBe('chapters/design.tex'))
  })

  for (const strict of [false, true]) {
    test(`a passage the canvas holds outranks it${strict ? ', mounted as the page really is' : ''}`, async () => {
      await load()
      await wander()
      cleanup()
      const from = Buffer.from(TEXT['chapters/method.tex']!).indexOf('The method')
      const passage: Passage = { path: `${PROJECT}/.kehikot/paper/a-paper/chapters/method.tex`, page: 3, from, to: from + 10, quoted: 'The method', section: null }
      await load({ passage, strict })
      await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
      expect(openFile()).toBe('chapters/method.tex')
      await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-mark')).toBe(`${from}-${from + 10}`))
      /* Taken to the passage, which is marked and not selected. */
      expect(lastEditor!.jump).toMatchObject({ from, to: from + 10, keep: true })
      expect(lastEditor!.jump!.top).toBeUndefined()
    })
  }
})

describe('the rule, and what is read first', () => {
  const paper = { epic: 'a-paper', files: FILES } as unknown as Paper
  const focus = narrowed(PARTS('the-method'), paper, null)

  test('the remembered file opens when it is still in the paper and in what is picked', () => {
    expect(fileOnOpening(null, FILES, 'chapters/design.tex')).toBe('chapters/design.tex')
    expect(fileOnOpening(focus, FILES, 'chapters/method.tex')).toBe('chapters/method.tex')
  })

  test('and otherwise the paper opens as it did: main.tex, or the first file of the picked parts', () => {
    expect(fileOnOpening(null, FILES, null)).toBeNull()
    expect(fileOnOpening(null, FILES, 'chapters/gone.tex')).toBeNull()
    expect(fileOnOpening(focus, FILES, null)).toBe('chapters/method.tex')
    expect(fileOnOpening(focus, FILES, 'chapters/design.tex')).toBe('chapters/method.tex')
    expect(fileOnOpening(focus, FILES, 'main.tex')).toBe('chapters/method.tex')
  })

  test('this tab’s own record is read before the host’s, and the host’s only for the paper it names', () => {
    const line = keptPlace(PROJECT, 'a-paper', { file: 'chapters/design.tex', tab: 'pdf' })
    expect(placeWas(PROJECT, 'a-paper', line)).toEqual({ file: 'chapters/design.tex', tab: 'pdf' })
    expect(placeWas(PROJECT, 'another-paper', line)).toBeNull()
    expect(placeWas('/tmp/elsewhere', 'a-paper', line)).toBeNull()
    expect(placeWas(PROJECT, 'a-paper', 'not what this page wrote')).toBeNull()
    rememberPlace(PROJECT, 'a-paper', { file: 'chapters/method.tex', tab: 'source' })
    expect(placeWas(PROJECT, 'a-paper', line)).toEqual({ file: 'chapters/method.tex', tab: 'source' })
    /* No project, no record: nothing is filed under a slug alone. */
    expect(keptPlace(null, 'a-paper', { file: 'main.tex', tab: 'source' })).toBeNull()
  })
})
