import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Passage } from 'kehikot-module-protocol'
import { createHash } from 'node:crypto'
import { useMemo, useState } from 'react'

import { parseLatex } from '../latex/parse.ts'
import { standIn } from '../src/api.ts'
import { App } from '../src/app.tsx'
import type { EditorProps } from '../src/editor/source-editor.tsx'
import type { PreviewProps } from '../src/pdf/pdf-view.tsx'
import { usePaper } from '../src/use-paper.ts'
import { placeShown, Workspace } from '../src/workspace.tsx'

/**
 * The page's logic, with a textarea where CodeMirror goes and a stub where
 * pdf.js goes.
 *
 * Neither real component lays out in this DOM, and neither is what is under
 * test. What is: that the editor is given the file, that typing saves the
 * WHOLE file measured against the hash it was read at, that a save is
 * followed by a compile, that a file which moved on disk is never overwritten
 * without a person choosing, that a suggestion is a diff nobody but a person
 * can accept, and that the source and the PDF are asked about each other in
 * the units the server answers in.
 *
 * The server is a fake `fetch` over a small in-memory paper, so every request
 * the page makes is on record.
 */

const PROJECT = '/tmp/project'
const DIR = `${PROJECT}/.kehikot/paper/a-paper`
const MAIN = ['\\documentclass{article}', '\\begin{document}', '\\section{Intro}', 'A claim with a tpyo in it.', '\\section{End}', 'Fin ä.', '\\end{document}', ''].join('\n')

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown> | null
}

let disk: Record<string, string>
let calls: Call[]
let proposals: Record<string, unknown>[]
let engine: string | null
let built: string | null
let lastPreview: PreviewProps | null
let lastEditor: EditorProps | null
/** Which page the fake SyncTeX says a line came out on. The page MAP says 2 for every line. */
let rectPage: number
/** Whether the fake SyncTeX has a record under a press on the PDF. */
let recorded: boolean
const fetchWas = globalThis.fetch

const paperNow = () => {
  const blocks = parseLatex(disk['main.tex']!, 'main.tex').blocks.map((block) => ({ ...block, file: 'main.tex' }))
  return {
    epic: 'a-paper',
    dir: DIR,
    title: null,
    author: null,
    blocks,
    outline: [],
    files: ['main.tex'],
    hashes: { 'main.tex': hashOf(disk['main.tex']!) },
    figures: [],
  }
}

const buildNow = () => ({
  engine,
  engines: engine ? [engine] : [],
  how: engine ? '' : 'No LaTeX engine is installed on this machine. brew install tectonic',
  running: false,
  last: built ? { ok: true, at: 1, ms: 2100, engine, timedOut: false, problems: [], tail: '' } : null,
  pdf: built ? { id: built, at: 1, pages: 3, hashes: { 'main.tex': hashOf(disk['main.tex']!) }, map: { 'main.tex': [{ page: 2, from: 1, to: 99 }] } } : null,
})

function serve(method: string, path: string, query: URLSearchParams, body: Record<string, unknown> | null): [number, unknown] {
  if (path === '/api/paper') return [200, { ok: true, paper: paperNow() }]
  if (path === '/api/source') return [200, { ok: true, source: disk['main.tex'], hash: hashOf(disk['main.tex']!) }]
  if (path === '/api/build') return [200, { ok: true, build: buildNow() }]
  if (path === '/api/compile') {
    built = `build-${calls.filter((one) => one.path === '/api/compile').length}`
    return [200, { ok: true, build: buildNow() }]
  }
  if (path === '/api/proposals') return [200, { ok: true, proposals, said: '' }]
  if (path === '/api/uncommitted') return [200, { ok: true, standing: { at: 'nogit' }, hashes: { 'main.tex': hashOf(disk['main.tex']!) } }]
  if (path === '/api/templates') return [200, { ok: true, templates: [] }]
  if (path === '/api/file') {
    if (body?.was !== hashOf(disk['main.tex']!)) {
      return [409, { ok: false, stale: true, error: 'main.tex has changed on disk', source: disk['main.tex'], hash: hashOf(disk['main.tex']!) }]
    }
    disk['main.tex'] = String(body.text)
    return [200, { ok: true, hash: hashOf(disk['main.tex']!), paper: paperNow(), proposals, said: '' }]
  }
  if (path === '/api/proposal') {
    proposals = proposals.filter((one) => one.id !== body?.id)
    return [200, { ok: true, proposals, paper: paperNow(), said: body?.decision === 'accept' ? 'Committed.' : '' }]
  }
  if (path === '/api/sync') {
    if (query.has('page')) return [200, { ok: true, found: recorded ? { build: built, file: 'main.tex', line: 6 } : null }]
    return [200, { ok: true, found: { build: built, exact: true, line: Number(query.get('line')), rects: [{ page: rectPage, x: 10, y: 20, w: 30, h: 8 }] } }]
  }
  return [404, { ok: false, error: `no ${method} ${path} in this test` }]
}

/** A textarea, with what the page asked of the editor readable off it. */
function Textarea(props: EditorProps) {
  lastEditor = props
  return (
    <textarea
      aria-label="LaTeX source"
      value={props.value}
      data-jump={props.jump ? `${props.jump.from}-${props.jump.to}` : ''}
      data-mark={props.mark ? `${props.mark.from}-${props.mark.to}` : ''}
      onChange={(event) => props.onChange(event.target.value)}
    />
  )
}

function Stub(props: PreviewProps) {
  lastPreview = props
  return <div data-testid="preview" data-url={props.url ?? ''} data-marks={props.marks.reduce((n, mark) => n + mark.rects.length, 0)} />
}

const posted = (path: string) => calls.filter((one) => one.method === 'POST' && one.path === path)

beforeEach(() => {
  disk = { 'main.tex': MAIN }
  calls = []
  proposals = []
  engine = 'tectonic'
  built = null
  lastPreview = null
  lastEditor = null
  rectPage = 2
  recorded = true
  ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://127.0.0.1:7870/app?project=${encodeURIComponent(PROJECT)}&epic=a-paper`)
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:7870')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ method, path: url.pathname, query: url.searchParams, body })
    const [status, answer] = serve(method, url.pathname, url.searchParams, body)
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = fetchWas
  standIn(null)
})

const open = async () => {
  render(<App editor={Textarea} preview={Stub} saveDelay={15} settle={5} />)
  const editor = (await screen.findByLabelText('LaTeX source')) as HTMLTextAreaElement
  return editor
}

describe('opening a paper', () => {
  test('the editor holds the file itself, and a compile is asked for because there is no PDF of it', async () => {
    const editor = await open()
    expect(editor.value).toBe(MAIN)
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=build-1'))
    expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('/api/pdf')
  })

  test('a PDF of this very text is shown without compiling again', async () => {
    built = 'kept'
    await open()
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))
    await new Promise((done) => setTimeout(done, 40))
    expect(posted('/api/compile')).toHaveLength(0)
  })

  test('no engine: the source is still editable and the page says how to get one', async () => {
    engine = null
    const editor = await open()
    expect(editor.value).toBe(MAIN)
    expect(await screen.findByText(/brew install tectonic/)).toBeDefined()
    expect(posted('/api/compile')).toHaveLength(0)
    fireEvent.change(editor, { target: { value: MAIN.replace('tpyo', 'typo') } })
    await waitFor(() => expect(disk['main.tex']).toContain('typo'))
  })
})

describe('saving', () => {
  test('typing saves the whole file against the hash it was read at, then compiles', async () => {
    const editor = await open()
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    const next = MAIN.replace('tpyo', 'typo')
    fireEvent.change(editor, { target: { value: next } })
    await waitFor(() => expect(posted('/api/file')).toHaveLength(1))
    expect(posted('/api/file')[0]!.body).toMatchObject({ file: 'main.tex', text: next, was: hashOf(MAIN) })
    expect(disk['main.tex']).toBe(next)
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(2))
    await waitFor(() => expect(document.querySelector('[data-save]')?.getAttribute('data-save')).toBe('saved'))

    /* The second save is measured against the hash the FIRST one produced. */
    fireEvent.change(editor, { target: { value: next.replace('Fin', 'The end') } })
    await waitFor(() => expect(posted('/api/file')).toHaveLength(2))
    expect(posted('/api/file')[1]!.body!.was).toBe(hashOf(next))
  })

  test('a file that moved on disk while it was being edited is not overwritten; a person chooses', async () => {
    const editor = await open()
    const theirs = MAIN.replace('A claim', 'A claim, restated by somebody else')
    disk['main.tex'] = theirs
    fireEvent.change(editor, { target: { value: MAIN.replace('tpyo', 'typo') } })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('changed on disk')
    expect(disk['main.tex']).toBe(theirs)

    fireEvent.click(screen.getByRole('button', { name: /Take the disk/ }))
    await waitFor(() => expect((screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value).toBe(theirs))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(disk['main.tex']).toBe(theirs)
  })

  test('“Keep mine” saves what was typed over what is on disk, knowingly', async () => {
    const editor = await open()
    disk['main.tex'] = MAIN.replace('A claim', 'Theirs')
    const mine = MAIN.replace('tpyo', 'typo')
    fireEvent.change(editor, { target: { value: mine } })
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(disk['main.tex']).toBe(mine))
  })

  test('a file changed on disk with nothing typed here is simply taken, and compiled', async () => {
    await open()
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    const theirs = MAIN.replace('A claim', 'Edited elsewhere')
    disk['main.tex'] = theirs
    /* The poll is every four seconds; the visibility event asks at once. */
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect((screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value).toBe(theirs))
    await waitFor(() => expect(posted('/api/compile').length).toBeGreaterThanOrEqual(2))
    expect(posted('/api/file')).toHaveLength(0)
  })
})

describe('between the source and the PDF', () => {
  test('a selection asks where its LINES came out and hands the rectangles, with its words, to the preview', async () => {
    built = 'kept'
    await open()
    await waitFor(() => expect(lastEditor).not.toBeNull())
    const from = MAIN.indexOf('tpyo')
    lastEditor!.onSelect({ from, to: from + 4 })
    await waitFor(() => expect(calls.some((one) => one.path === '/api/sync' && one.query.get('line') === '4')).toBe(true))
    const asked = calls.find((one) => one.path === '/api/sync' && one.query.get('line') === '4')!
    expect(asked.query.get('file')).toBe('main.tex')
    expect(asked.query.get('to')).toBe('4')
    await waitFor(() => expect(lastPreview!.marks).toHaveLength(1))
    expect(lastPreview!.marks[0]).toMatchObject({ source: 'tpyo', rects: [{ page: 2, x: 10, y: 20, w: 30, h: 8 }] })
    expect(lastPreview!.reveal).not.toBeNull()
  })

  test('a press on the PDF asks which line it came from and takes the editor to the word', async () => {
    built = 'kept'
    await open()
    await waitFor(() => expect(lastPreview).not.toBeNull())
    lastPreview!.onPoint({ page: 2, x: 100.5, y: 200.25, word: 'Fin' })
    await waitFor(() => expect(calls.some((one) => one.path === '/api/sync' && one.query.get('page') === '2')).toBe(true))
    const at = MAIN.indexOf('Fin')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-jump')).toBe(`${at}-${at + 3}`))
  })

  test('a press on the PDF leaves the PDF tab in front; a double press turns to the source', async () => {
    built = 'kept'
    await open()
    await waitFor(() => expect(lastPreview).not.toBeNull())
    const tabOf = (name: string) => screen.getByRole('tab', { name }).getAttribute('aria-selected')
    fireEvent.click(screen.getByRole('tab', { name: 'PDF' }))
    lastPreview!.onPoint({ page: 2, x: 100.5, y: 200.25, word: 'Fin' })
    const at = MAIN.indexOf('Fin')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-jump')).toBe(`${at}-${at + 3}`))
    expect(tabOf('PDF')).toBe('true')
    act(() => lastPreview!.onOpen!())
    expect(tabOf('Source')).toBe('true')
  })

  test('a press with no word under it lands on the line', async () => {
    built = 'kept'
    await open()
    await waitFor(() => expect(lastPreview).not.toBeNull())
    lastPreview!.onPoint({ page: 2, x: 1, y: 1, word: null })
    const at = MAIN.indexOf('Fin')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-jump')).toBe(`${at}-${at}`))
  })
})

describe('a suggested change', () => {
  const suggestion = () => {
    const from = Buffer.from(MAIN).indexOf('tpyo')
    return { id: 'p1', file: 'main.tex', from, to: from + 4, text: 'typo', was_text: 'tpyo', was: hashOf(MAIN), why: 'A misspelling.', by: 'an agent', at: 1, asked: { find: 'with a tpyo in', replace: 'with a typo in' } }
  }

  test('is a diff of the source with its reason, and writes nothing by being shown', async () => {
    proposals = [suggestion()]
    await open()
    expect(await screen.findByText('A misspelling.')).toBeDefined()
    const diff = document.querySelector('.proposal-diff')!
    expect(diff.querySelector('del')?.textContent).toBe('tpyo')
    expect(diff.querySelector('ins')?.textContent).toBe('typo')
    expect(diff.textContent).toBe('with a tpyotypo in')
    expect(posted('/api/proposal')).toHaveLength(0)
    expect(posted('/api/file')).toHaveLength(0)
    expect(disk['main.tex']).toBe(MAIN)
  })

  test('Accept and Reject are the person’s, and each is one post naming the decision', async () => {
    proposals = [suggestion(), { ...suggestion(), id: 'p2', why: 'Another.' }]
    await open()
    await screen.findByText('A misspelling.')
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]!)
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: 'p1', decision: 'reject' })
    await waitFor(() => expect(screen.queryByText('A misspelling.')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(2))
    expect(posted('/api/proposal')[1]!.body).toMatchObject({ id: 'p2', decision: 'accept' })
  })

  test('what was typed is saved BEFORE a suggestion is accepted, so the accept lands on the text on screen', async () => {
    proposals = [suggestion()]
    const editor = await open()
    await screen.findByText('A misspelling.')
    fireEvent.change(editor, { target: { value: MAIN.replace('Fin', 'The end') } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    const order = calls.filter((one) => one.method === 'POST' && (one.path === '/api/file' || one.path === '/api/proposal')).map((one) => one.path)
    expect(order).toEqual(['/api/file', '/api/proposal'])
  })
})

/**
 * A change nobody on this page made: where it is, shown without being asked.
 *
 * The polls are woken the way a returning tab wakes them, so a suggestion or a
 * save "arrives" here exactly as it does while somebody watches.
 */
describe('a change that arrives', () => {
  const at = MAIN.indexOf('tpyo')
  const suggestion = () => ({ id: 'p1', file: 'main.tex', from: at, to: at + 4, text: 'typo', was_text: 'tpyo', was: hashOf(MAIN), why: 'A misspelling.', by: 'an agent', at: 1, asked: { find: 'tpyo', replace: 'typo' } })
  const wake = () => act(() => void document.dispatchEvent(new Event('visibilitychange')))
  const source = () => screen.getByLabelText('LaTeX source')

  test('a suggestion already waiting when the paper is opened takes nobody anywhere', async () => {
    proposals = [suggestion()]
    await open()
    await screen.findByText('A misspelling.')
    expect(source().getAttribute('data-mark')).toBe('')
    expect(source().getAttribute('data-jump')).toBe('')
  })

  test('one that arrives is marked and gone to, the tab is left alone, and the Source tab counts it', async () => {
    built = 'kept'
    await open()
    fireEvent.click(screen.getByRole('tab', { name: 'PDF' }))
    proposals = [suggestion()]
    wake()
    await waitFor(() => expect(source().getAttribute('data-mark')).toBe(`${at}-${at + 4}`))
    expect(source().getAttribute('data-jump')).toBe(`${at}-${at + 4}`)
    expect(screen.getByRole('tab', { name: 'PDF' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Source · 1' })).toBeDefined()
    expect(await screen.findByText(/A change was suggested in main\.tex/)).toBeDefined()
    /* On the page too, in the colour of a passage somebody else chose. */
    await waitFor(() => expect(lastPreview!.marks.some((mark) => mark.foreign)).toBe(true))
    /* Rejected: there is nothing left to point at. */
    fireEvent.click(screen.getByRole('tab', { name: 'Source · 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(source().getAttribute('data-mark')).toBe(''))
  })

  test('somebody typing is not scrolled away: the mark is made and the editor stays', async () => {
    const editor = await open()
    editor.focus()
    proposals = [suggestion()]
    wake()
    await waitFor(() => expect(source().getAttribute('data-mark')).toBe(`${at}-${at + 4}`))
    expect(source().getAttribute('data-jump')).toBe('')
  })

  test('text that lands from the disk is marked where it changed', async () => {
    await open()
    disk['main.tex'] = MAIN.replace('tpyo', 'mistake')
    wake()
    await waitFor(() => expect(source().getAttribute('data-mark')).toBe(`${at}-${at + 'mistake'.length}`))
    expect(await screen.findByText(/main\.tex changed on disk/)).toBeDefined()
  })
})

/**
 * A passage somebody else pointed at, and what this page reads out about it.
 *
 * The canvas is a host's to speak for, so the workspace is rendered here with
 * everything `usePaper` gives it and `pointed` supplied by the test: that one
 * field is the whole of what arrives.
 */
describe('a passage another module pointed at', () => {
  let pointAt: (passage: Passage | null) => void = () => {}

  function Framed() {
    const wire = usePaper(false)
    const [pointed, setPointed] = useState<Passage | null>(null)
    pointAt = setPointed
    const all = useMemo(() => ({ ...wire, pointed }), [wire, pointed])
    if (wire.sight.at !== 'reading') return null
    return (
      <>
        <Workspace paper={wire.sight.paper} wire={all} editor={Textarea} preview={Stub} saveDelay={15} settle={5} />
        <p data-testid="said">{wire.said}</p>
      </>
    )
  }

  const fin = Buffer.from(MAIN).indexOf('Fin')
  const there: Passage = { path: `${DIR}/main.tex`, page: 3, from: fin, to: fin + 3, quoted: 'Fin', section: null }
  const toolbar = () => document.querySelector('[data-build]')!.textContent ?? ''
  const section = () => (screen.getByLabelText('Sections') as HTMLSelectElement).options[0]!.textContent
  const said = () => screen.getByTestId('said').textContent

  const pointed = async () => {
    built = 'kept'
    render(<Framed />)
    await screen.findByLabelText('LaTeX source')
    /* The caret is at the top of the file: before any heading, on a line the
       page map puts on page 2. */
    await waitFor(() => expect(toolbar()).toContain('p. 2/3'))
    expect(section()).toBe('Sections')
    /* The passage is under “End”, and SyncTeX draws it on page 3. */
    rectPage = 3
    act(() => pointAt(there))
    const at = MAIN.indexOf('Fin')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-mark')).toBe(`${at}-${at + 3}`))
    await waitFor(() => expect(said()).toContain('Something pointed at main.tex'))
  }

  test('the toolbar reads out the passage’s page and section, not the caret’s old place', async () => {
    await pointed()
    await waitFor(() => expect(toolbar()).toContain('p. 3/3'))
    expect(section()).toBe('End')
    /* The caret itself was left alone: the passage is marked, not selected. */
    expect(lastEditor!.jump?.keep).toBe(true)
  })

  test('picking another section is the person moving on: the toolbar is the caret’s again and the sentence is gone', async () => {
    await pointed()
    fireEvent.change(screen.getByLabelText('Sections'), { target: { value: '0' } })
    await waitFor(() => expect(said()).toBe(''))
    expect(section()).toBe('Sections')
    expect(toolbar()).toContain('p. 2/3')
  })

  test('so is moving the caret, and a selection the editor merely repeats is not', async () => {
    await pointed()
    await waitFor(() => expect(toolbar()).toContain('p. 3/3'))
    act(() => lastEditor!.onSelect({ from: 0, to: 0 }))
    expect(said()).toContain('Something pointed at')
    expect(section()).toBe('End')
    const intro = MAIN.indexOf('A claim')
    act(() => lastEditor!.onSelect({ from: intro, to: intro }))
    await waitFor(() => expect(said()).toBe(''))
    expect(section()).toBe('Intro')
  })

  test('a press on the PDF moves on too', async () => {
    await pointed()
    lastPreview!.onPoint({ page: 2, x: 1, y: 1, word: null })
    await waitFor(() => expect(said()).toBe(''))
  })

  test('the sentence goes when the canvas lets go, and one about a file elsewhere is taken down the same way', async () => {
    await pointed()
    act(() => pointAt({ ...there, path: '/elsewhere/notes.md' }))
    await waitFor(() => expect(said()).toContain('not part of the paper open here'))
    expect(toolbar()).toContain('p. 2/3')
    act(() => pointAt(null))
    await waitFor(() => expect(said()).toBe(''))
  })

  test('what else has been said since is not taken down with it', async () => {
    await pointed()
    /* A press where SyncTeX has no record says so, in the same one line. */
    recorded = false
    lastPreview!.onPoint({ page: 2, x: 1, y: 1, word: null })
    await waitFor(() => expect(said()).toContain('Nothing in this paper’s own files is recorded'))
    fireEvent.change(screen.getByLabelText('Sections'), { target: { value: '0' } })
    await waitFor(() => expect(section()).toBe('Sections'))
    expect(said()).toContain('Nothing in this paper’s own files is recorded')
  })

  test('placeShown: the passage wins outright while it is shown', () => {
    const caret = { page: 11, section: 'Introduction' }
    expect(placeShown(caret, null)).toEqual(caret)
    expect(placeShown(caret, { section: 'Results', marked: 12, mapped: 13 })).toEqual({ page: 12, section: 'Results' })
    expect(placeShown(caret, { section: 'Results', marked: null, mapped: 13 })).toEqual({ page: 13, section: 'Results' })
    /* Not known is not the caret's: nothing is shown rather than the old place. */
    expect(placeShown(caret, { section: null, marked: null, mapped: null })).toEqual({ page: null, section: null })
  })
})
