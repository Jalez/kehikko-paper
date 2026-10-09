import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MESSAGE, PROTOCOL, type EpicPart, type Passage } from 'kehikot-module-protocol'
import { createHash } from 'node:crypto'
import { StrictMode } from 'react'

import { parseLatex } from '../latex/parse.ts'
import { standIn } from '../src/api.ts'
import type { EditorProps } from '../src/editor/source-editor.tsx'
import type { PreviewProps } from '../src/pdf/pdf-view.tsx'
import { usePaper } from '../src/use-paper.ts'
import { Workspace } from '../src/workspace.tsx'

/**
 * The page under a focus, greeted and told over the real wire.
 *
 * `test/focus.test.ts` holds the arithmetic. This holds what the page DOES
 * with it, and it is driven the way a host drives it — a `kehikot.hello` and
 * then `kehikot.context` messages, parsed by the protocol's own client — and
 * not by handing the workspace a list, because the first thing that has to be
 * true is that `context.parts` reaches the page at all: this hook used to
 * read four fields off a context and return early on any context that named
 * the epic already on screen, which is every context a pick produces.
 *
 * The server is a fake `fetch` over a paper of three files, with every
 * request on record, so "a change of focus re-reads nothing" is a count.
 */

const PROJECT = '/tmp/project'
const EPIC = 'a-paper'
const DIR = `${PROJECT}/.kehikot/paper/${EPIC}`
const FILES = ['main.tex', 'chapters/design.tex', 'chapters/method.tex']
const TEXT: Record<string, string> = {
  'main.tex': ['\\documentclass{article}', '\\begin{document}', '\\section{Opening}', 'Said in main.', '\\input{chapters/design}', '\\input{chapters/method}', '\\end{document}', ''].join('\n'),
  'chapters/design.tex': ['\\section{Design}', 'The design is this.', '\\subsection{Seams}', 'A seam.', ''].join('\n'),
  'chapters/method.tex': ['\\section{Method}', 'The method is that.', ''].join('\n'),
}
/* Five pages: main prints 1 and 5, the design 2 and 3, the method 3 and 4. */
const MAP = {
  'main.tex': [{ page: 1, from: 1, to: 4 }, { page: 5, from: 7, to: 7 }],
  'chapters/design.tex': [{ page: 2, from: 1, to: 2 }, { page: 3, from: 3, to: 4 }],
  'chapters/method.tex': [{ page: 3, from: 1, to: 1 }, { page: 4, from: 2, to: 2 }],
}

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
let lastPreview: PreviewProps | null
const fetchWas = globalThis.fetch

const hashes = () => Object.fromEntries(FILES.map((file) => [file, hashOf(disk[file]!)]))
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
})
const buildNow = () => ({
  engine: 'tectonic',
  engines: ['tectonic'],
  how: '',
  running: false,
  last: built ? { ok: true, at: 1, ms: 2100, engine: 'tectonic', timedOut: false, problems: [], tail: '' } : null,
  pdf: built ? { id: built, at: 1, pages: 5, hashes: hashes(), map: MAP } : null,
})

function serve(path: string, query: URLSearchParams, body: Record<string, unknown> | null): [number, unknown] {
  const file = String(query.get('file') ?? body?.file ?? 'main.tex')
  if (path === '/api/paper') return [200, { ok: true, paper: paperNow() }]
  if (path === '/api/source') return [200, { ok: true, source: disk[file], hash: hashOf(disk[file]!) }]
  if (path === '/api/build') return [200, { ok: true, build: buildNow() }]
  if (path === '/api/compile') {
    built = `build-${calls.filter((one) => one.path === '/api/compile').length}`
    return [200, { ok: true, build: buildNow() }]
  }
  if (path === '/api/proposals') return [200, { ok: true, proposals: [], said: '' }]
  if (path === '/api/uncommitted') return [200, { ok: true, standing: { at: 'nogit' }, hashes: hashes() }]
  if (path === '/api/file') {
    disk[file] = String(body?.text)
    return [200, { ok: true, hash: hashOf(disk[file]!), paper: paperNow(), proposals: [], said: '' }]
  }
  if (path === '/api/sync') {
    if (query.has('page')) return [200, { ok: true, found: { build: built, file: 'chapters/method.tex', line: 1 } }]
    const page = (MAP as Record<string, { page: number }[]>)[file]?.[0]?.page ?? 1
    return [200, { ok: true, found: { build: built, exact: true, line: Number(query.get('line')), rects: [{ page, x: 10, y: 20, w: 30, h: 8 }] } }]
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
  lastPreview = props
  return <div data-testid="preview" data-pages={props.pages ? props.pages.join(',') : 'all'} data-outside={(props.outside ?? []).join(',')} />
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
  const source = { postMessage: () => {} }
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
    greet: (parts: EpicPart[] = []) => post({ type: MESSAGE.HELLO, protocol: PROTOCOL, session: 's', context: context(parts), state: null }),
    context: (parts: EpicPart[], passage: Passage | null = null) => post({ type: MESSAGE.CONTEXT, protocol: PROTOCOL, ...context(parts, passage) }),
  }
}

const part = (id: string, heading: string, picked: boolean, files?: string[]): EpicPart => ({ id, heading, refs: [], picked, ...(files ? { files } : {}) })
const PARTS = (...picked: string[]): EpicPart[] => [
  part('the-design', 'The design', picked.includes('the-design'), ['chapters/design.tex']),
  part('the-method', 'The method', picked.includes('the-method'), ['chapters/method.tex']),
  part('the-steps', 'Steps only', picked.includes('the-steps')),
]

/** The file the line over the editor says an edit is saved to. */
const openFile = () => document.querySelector('[data-editing]')?.getAttribute('data-editing')
/** The switch among the picked parts' files; empty when there is none to draw. */
const tabs = () => [...document.querySelectorAll('[data-files] [role="tab"]')].map((one) => one.textContent)
/** The files the section list is grouped by. */
const jumpFiles = () => [...(screen.getByLabelText('Sections') as HTMLSelectElement).querySelectorAll('optgroup')].map((one) => one.label)
const sectionOptions = () => [...(screen.getByLabelText('Sections') as HTMLSelectElement).options].slice(1).map((one) => one.textContent?.trim())
const banner = () => document.querySelector('[data-focus]')
const asked = (path: string) => calls.filter((one) => one.path === path).length
const editorText = () => (screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value

const framed = async (parts: EpicPart[] = []) => {
  built = 'kept'
  const canvas = host()
  render(<Framed />)
  canvas.greet(parts)
  await screen.findByLabelText('LaTeX source')
  await waitFor(() => expect(lastPreview).not.toBeNull())
  return canvas
}

beforeEach(() => {
  disk = { ...TEXT }
  calls = []
  built = null
  lastPreview = null
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:7870')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ method, path: url.pathname, query: url.searchParams, body })
    const [status, answer] = serve(url.pathname, url.searchParams, body)
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = fetchWas
  standIn(null)
})

describe('with nothing picked', () => {
  test('the page is what it was: every file, every section, every page, and no line about a focus', async () => {
    await framed(PARTS())
    /* No chapter picker of this page's own: not a dropdown of files, not a row of them. */
    expect(screen.queryByLabelText('File')).toBeNull()
    expect(tabs()).toEqual([])
    expect(openFile()).toBe('main.tex')
    expect(document.querySelector('[data-editing]')!.textContent).toBe('Editing main.texSaved')
    expect(screen.queryByRole('button', { name: 'Back to main.tex' })).toBeNull()
    /* Every file is one jump away, through the section list. */
    expect(jumpFiles()).toEqual(FILES)
    expect(sectionOptions()).toEqual(['Opening', 'Design', 'Seams', 'Method'])
    expect(banner()).toBeNull()
    expect(document.querySelector('[data-outside-file]')).toBeNull()
    /* The preview is not handed a list of pages at all. */
    expect(lastPreview!.pages).toBeUndefined()
    expect(lastPreview!.outside).toBeUndefined()
  })

  test('and the same for a host that says nothing about parts', async () => {
    await framed([])
    expect(jumpFiles()).toEqual(FILES)
    expect(openFile()).toBe('main.tex')
    expect(banner()).toBeNull()
    expect(lastPreview!.pages).toBeUndefined()
  })
})

describe('a part is picked in the host’s bar', () => {
  test('the context reaches the page, and it narrows without reading the paper or compiling again', async () => {
    const canvas = await framed(PARTS())
    const before = { paper: asked('/api/paper'), compile: asked('/api/compile'), build: asked('/api/build'), source: asked('/api/source') }

    canvas.context(PARTS('the-design'))
    await waitFor(() => expect(banner()).not.toBeNull())
    expect(banner()!.textContent).toBe(
      'Only “The design” is shown: 1 of 3 files, 2 of 5 pages. 2 files and 3 pages are outside it. Parts are picked in the host’s bar.',
    )
    expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('2,3')
    expect(asked('/api/paper')).toBe(before.paper)
    expect(asked('/api/compile')).toBe(before.compile)
    expect(asked('/api/build')).toBe(before.build)
    /* The one thing read is the part's own file, which the editor opened:
       one part ticked IS that part's file, with no second choice to make. */
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
    expect(openFile()).toBe('chapters/design.tex')
    expect(asked('/api/source')).toBe(before.source + 1)
    /* One file is not a switch: no tabs, and no way back to a file outside the tick. */
    expect(tabs()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Back to main.tex' })).toBeNull()
    expect(jumpFiles()).toEqual(['chapters/design.tex'])
    expect(document.querySelector('[data-outside-file]')).toBeNull()

    /* And clearing it puts everything back: the whole paper, and main.tex in the editor. */
    canvas.context(PARTS())
    await waitFor(() => expect(banner()).toBeNull())
    await waitFor(() => expect(openFile()).toBe('main.tex'))
    expect(editorText()).toBe(TEXT['main.tex']!)
    expect(jumpFiles()).toEqual(FILES)
    expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('all')
  })

  test('several ticked are tabs of exactly those files, and a tab is how to move between them', async () => {
    const canvas = await framed(PARTS())
    canvas.context(PARTS('the-design', 'the-method'))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
    expect(tabs()).toEqual(['design.tex', 'method.tex'])
    expect(screen.getByRole('tab', { name: 'design.tex' }).getAttribute('aria-selected')).toBe('true')
    /* main.tex is in no part, so it is not offered. */
    expect(jumpFiles()).toEqual(['chapters/design.tex', 'chapters/method.tex'])

    fireEvent.click(screen.getByRole('tab', { name: 'method.tex' }))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    expect(openFile()).toBe('chapters/method.tex')
    expect(screen.getByRole('tab', { name: 'method.tex' }).getAttribute('aria-selected')).toBe('true')
  })

  test('ticking a second part beside the one being read does not move the reader', async () => {
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    canvas.context(PARTS('the-design', 'the-method'))
    await waitFor(() => expect(tabs()).toEqual(['design.tex', 'method.tex']))
    expect(openFile()).toBe('chapters/method.tex')
    /* Unticking the one being read moves to what is still ticked. */
    canvas.context(PARTS('the-design'))
    await waitFor(() => expect(openFile()).toBe('chapters/design.tex'))
    expect(tabs()).toEqual([])
  })

  test('a context that says the same parts again redraws nothing', async () => {
    const canvas = await framed(PARTS('the-design'))
    /* Let the caret's own mark arrive first: that does redraw, and is not this. */
    await new Promise((done) => setTimeout(done, 40))
    const was = lastPreview!.pages
    canvas.context(PARTS('the-design'))
    await new Promise((done) => setTimeout(done, 20))
    expect(lastPreview!.pages).toBe(was)
  })

  test('the file being edited stays open, keeps what was typed and is saved, though it is outside the focus', async () => {
    const canvas = await framed(PARTS())
    const typed = TEXT['main.tex']!.replace('Said in main.', 'Said in main, and still being typed.')
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: typed } })
    /* Before the save has gone out. */
    canvas.context(PARTS('the-design'))
    await waitFor(() => expect(banner()).not.toBeNull())

    expect(openFile()).toBe('main.tex')
    expect(editorText()).toBe(typed)
    /* It is the tab the person is standing on: last, and marked. */
    expect(tabs()).toEqual(['design.tex', 'main.tex — outside'])
    expect(document.querySelector('[data-editing]')!.textContent).toContain('Editing main.tex')
    const said = document.querySelector('[data-outside-file]')!
    expect(said.textContent).toContain('main.tex is outside the picked part. It stays open, and is saved as usual, until you choose another file.')
    await waitFor(() => expect(disk['main.tex']).toBe(typed))

    /* Its own sections are still offered beside the focus's, while it is open. */
    expect(sectionOptions()).toEqual(['Opening', 'Design', 'Seams'])
    expect(jumpFiles()).toEqual(['main.tex — outside the focus', 'chapters/design.tex'])

    /* One press goes to the part; the file that was outside then leaves. */
    fireEvent.click(screen.getByRole('button', { name: 'Open chapters/design.tex' }))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
    expect(tabs()).toEqual([])
    expect(openFile()).toBe('chapters/design.tex')
    expect(sectionOptions()).toEqual(['Design', 'Seams'])
    expect(document.querySelector('[data-outside-file]')).toBeNull()
  })

  test('and unsaved text is not lost when the ticks change twice under it', async () => {
    const canvas = await framed(PARTS('the-design'))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
    const typed = TEXT['chapters/design.tex']!.replace('The design is this.', 'The design is this, mid-sentence')
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: typed } })
    canvas.context(PARTS('the-method'))
    canvas.context(PARTS())
    await waitFor(() => expect(disk['chapters/design.tex']).toBe(typed))
    /* Still the file the hands are in, with what was typed. */
    expect(openFile()).toBe('chapters/design.tex')
    expect(editorText()).toBe(typed)
  })

  test('a paper OPENED under a focus starts on a file that is in it', async () => {
    await framed(PARTS('the-method'))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    expect(openFile()).toBe('chapters/method.tex')
    expect(tabs()).toEqual([])
    expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('3,4')
  })

  test('and it does as the page is really mounted, in StrictMode, where every effect runs twice', async () => {
    /* `main.tsx` mounts the page in StrictMode and Vite serves it unbuilt, so
       this is the mount a person gets. The second run of "a new paper starts
       on main.tex" used to win, because the choice below it was guarded to
       run once: a reload with a part ticked opened `main.tex`, marked outside. */
    built = 'kept'
    const canvas = host()
    render(
      <StrictMode>
        <Framed />
      </StrictMode>,
    )
    canvas.greet(PARTS('the-method'))
    await waitFor(() => expect(openFile()).toBe('chapters/method.tex'))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    expect(tabs()).toEqual([])
  })

  test('two parts are the union, and the shared sheet is drawn once', async () => {
    await framed(PARTS('the-design', 'the-method'))
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('2,3,4'))
    expect(banner()!.textContent).toContain('Only 2 parts (“The design”, “The method”) are shown: 2 of 3 files, 3 of 5 pages. 1 file and 2 pages are outside them.')
  })
})

describe('what a focus must not do in silence', () => {
  test('picked parts that own no file: nothing of the paper is in them, and the page says so and where to fix it', async () => {
    await framed(PARTS('the-steps'))
    await waitFor(() => expect(banner()).not.toBeNull())
    expect(banner()!.getAttribute('data-focus')).toBe('none')
    expect(banner()!.textContent).toContain('that part owns no files of this paper')
    expect(banner()!.textContent).toContain('Give the part its files in Journeys')
    expect(document.querySelector('[data-no-pages]')!.textContent).toContain('No page of this paper is in the picked part')
    expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('')
    /* The source is not taken away: the file that was open is still there, and said to be outside. */
    expect(openFile()).toBe('main.tex')
    expect(jumpFiles()).toEqual(['main.tex — outside the focus'])
    expect(document.querySelector('[data-outside-file]')!.textContent).toContain('main.tex is outside the picked part')
    expect(editorText()).toBe(TEXT['main.tex']!)
  })

  test('a picked part naming a file the paper does not include is said on screen', async () => {
    await framed([part('the-design', 'The design', true, ['chapters/design.tex', 'chapters/desing.tex'])])
    await waitFor(() => expect(document.querySelector('[data-focus-note]')).not.toBeNull())
    expect(document.querySelector('[data-focus-note]')!.textContent).toContain('“The design” names chapters/desing.tex, which this paper does not include')
  })
})

describe('a pointer from another module, at a passage outside the picked parts', () => {
  test('still arrives: the file is opened and marked, the sentence says it is outside, and its page is drawn and flagged', async () => {
    const canvas = await framed(PARTS('the-design'))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
    const from = Buffer.from(TEXT['chapters/method.tex']!).indexOf('The method')
    const passage: Passage = { path: `${DIR}/chapters/method.tex`, page: 3, from, to: from + 10, quoted: 'The method', section: null }

    canvas.context(PARTS('the-design'), passage)
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-mark')).toBe(`${from}-${from + 10}`))
    expect(screen.getByTestId('said').textContent).toBe(
      'Something pointed at chapters/method.tex, bytes 17–27. It is marked in the source. It is outside the picked part, and is shown anyway.',
    )
    expect(tabs()).toEqual(['design.tex', 'method.tex — outside'])
    expect(openFile()).toBe('chapters/method.tex')
    /* The fake SyncTeX puts a line of the method on page 3, which the design
       shares: nothing to add. A passage on a page of its own is added, flagged. */
    await waitFor(() => expect(lastPreview!.marks.length).toBeGreaterThan(0))
    expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('2,3')

    const main = Buffer.from(TEXT['main.tex']!).indexOf('Said in main.')
    canvas.context(PARTS('the-design'), { path: `${DIR}/main.tex`, page: 1, from: main, to: main + 4, quoted: 'Said', section: null })
    await waitFor(() => expect(editorText()).toBe(TEXT['main.tex']!))
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-pages')).toBe('1,2,3'))
    expect(screen.getByTestId('preview').getAttribute('data-outside')).toBe('1')
  })

  test('with nothing picked the sentence is the one it always was', async () => {
    const canvas = await framed(PARTS())
    const from = Buffer.from(TEXT['chapters/method.tex']!).indexOf('The method')
    canvas.context(PARTS(), { path: `${DIR}/chapters/method.tex`, page: 3, from, to: from + 10, quoted: 'The method', section: null })
    await waitFor(() => expect(screen.getByTestId('said').textContent).toBe('Something pointed at chapters/method.tex, bytes 17–27. It is marked in the source.'))
  })
})

describe('the whole paper, with nothing picked', () => {
  test('a press in the PDF opens the file that printed it, and one small press goes back to main.tex', async () => {
    await framed(PARTS())
    expect(openFile()).toBe('main.tex')
    /* The fake SyncTeX answers the method, line 1. */
    lastPreview!.onPoint({ page: 3, x: 1, y: 1, word: null })
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    /* Which file an edit is now saved to is said over the text. */
    expect(openFile()).toBe('chapters/method.tex')
    expect(document.querySelector('[data-editing]')!.textContent).toBe('← main.texEditing chapters/method.texSaved')
    expect(tabs()).toEqual([])
    expect(document.querySelector('[data-outside-file]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back to main.tex' }))
    await waitFor(() => expect(editorText()).toBe(TEXT['main.tex']!))
    expect(openFile()).toBe('main.tex')
    expect(screen.queryByRole('button', { name: 'Back to main.tex' })).toBeNull()
  })

  test('an edit made after such a press is saved to the file the line names, and to no other', async () => {
    await framed(PARTS())
    lastPreview!.onPoint({ page: 3, x: 1, y: 1, word: null })
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    const typed = TEXT['chapters/method.tex']!.replace('that.', 'that, edited.')
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: typed } })
    await waitFor(() => expect(disk['chapters/method.tex']).toBe(typed))
    expect(disk['main.tex']).toBe(TEXT['main.tex']!)
    expect(document.querySelector('[data-editing]')!.textContent).toContain('Editing chapters/method.tex')
  })

  test('a section of any file is one jump away', async () => {
    await framed(PARTS())
    const list = screen.getByLabelText('Sections') as HTMLSelectElement
    const seams = [...list.options].find((one) => one.textContent?.trim() === 'Seams')!
    fireEvent.change(list, { target: { value: seams.value } })
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
    expect(openFile()).toBe('chapters/design.tex')
  })
})

describe('a press on a sheet two files share', () => {
  test('lands in the file it came from even when that file is outside the focus, which is then said', async () => {
    await framed(PARTS('the-design'))
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/design.tex']!))
    /* Page 3 is the design's and the method's; the fake SyncTeX answers the method. */
    lastPreview!.onPoint({ page: 3, x: 1, y: 1, word: null })
    await waitFor(() => expect(editorText()).toBe(TEXT['chapters/method.tex']!))
    expect(document.querySelector('[data-outside-file]')!.textContent).toContain('chapters/method.tex is outside the picked part')
  })
})
