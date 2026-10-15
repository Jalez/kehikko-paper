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
import { options, pane, press, row } from './menu.ts'

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
let jumpOn = true
let autoOn = false
let engine: string | null
let built: string | null
/** What the PDF on screen was built from, when that is not the disk as it is now. */
let builtFrom: string | null
/** Set, a compile does not answer until it resolves: the dozen seconds an engine takes. */
let compiling: Promise<void> | null
/** The next compiles fail: the last good PDF stays, and `last` says the build did not make one. */
let failing: boolean
let failed: boolean
/** What the last run says of itself: kept to the paper's places, not, or — an older server — nothing. */
let confined: boolean | undefined
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
  last: built ? { ok: !failed, at: 1, ms: 2100, engine, timedOut: false, problems: [], tail: '', ...(confined === undefined ? {} : { confined }) } : null,
  pdf: built ? { id: built, at: 1, pages: 3, hashes: { 'main.tex': hashOf(builtFrom ?? disk['main.tex']!) }, map: { 'main.tex': [{ page: 2, from: 1, to: 99 }] } } : null,
})

function serve(method: string, path: string, query: URLSearchParams, body: Record<string, unknown> | null): [number, unknown] {
  if (path === '/api/paper') return [200, { ok: true, paper: paperNow() }]
  if (path === '/api/source') return [200, { ok: true, source: disk['main.tex'], hash: hashOf(disk['main.tex']!) }]
  if (path === '/api/build') return [200, { ok: true, build: buildNow() }]
  if (path === '/api/compile') {
    failed = failing
    if (failing) return [200, { ok: true, build: buildNow() }]
    built = `build-${calls.filter((one) => one.path === '/api/compile').length}`
    builtFrom = disk['main.tex']!
    return [200, { ok: true, build: buildNow() }]
  }
  if (path === '/api/proposals') return [200, { ok: true, proposals, auto: autoOn, jump: jumpOn, accepted: [], baseline: null, untracked: [], said: '' }]
  if (path === '/api/review') {
    if (body?.action === 'jump') jumpOn = body.on === true
    if (body?.action === 'auto') autoOn = body.on === true
    return [200, { ok: true, proposals, auto: autoOn, jump: jumpOn, accepted: [], baseline: null, untracked: [], said: '' }]
  }
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
  jumpOn = true
  autoOn = false
  disk = { 'main.tex': MAIN }
  calls = []
  proposals = []
  engine = 'tectonic'
  built = null
  builtFrom = null
  compiling = null
  failing = false
  failed = false
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
    if (url.pathname === '/api/compile' && compiling) await compiling
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

  test('an engine that ran with nothing to confine it says so on the status line, and in no row of its own', async () => {
    built = 'kept'
    confined = false
    await open()
    await waitFor(() => expect(document.querySelector('[data-build]')?.getAttribute('data-confined')).toBe('false'))
    const status = document.querySelector('[data-build]')!
    expect(status.getAttribute('title')).toContain('Not confined')
    /* What the run came to is the Compile item's: the seconds and the pages. */
    expect(row('compile')!.textContent).toContain('2.1 s · 3 pp.')
    expect(document.body.textContent).not.toContain('Not confined')
  })

  test('an engine that was confined says nothing about it', async () => {
    built = 'kept'
    confined = true
    await open()
    await waitFor(() => expect(document.querySelector('[data-build]')?.getAttribute('data-confined')).toBe('true'))
    expect(document.querySelector('[data-build]')!.getAttribute('title')).toBeNull()
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
    /* The same line, so what each changed touches: not mergeable. */
    const theirs = MAIN.replace('tpyo', 'typo, as somebody else has it')
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

  test('changes to other lines, made in both places, are both kept: nothing typed is lost and nothing on disk is overwritten', async () => {
    const editor = await open()
    const theirs = MAIN.replace('Fin', 'Finis')
    disk['main.tex'] = theirs
    const mine = MAIN.replace('tpyo', 'typo')
    fireEvent.change(editor, { target: { value: mine } })
    const both = theirs.replace('tpyo', 'typo')
    await waitFor(() => expect(disk['main.tex']).toBe(both))
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect((screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value).toBe(both))
  })

  test('“Keep mine” saves what was typed over what is on disk, knowingly', async () => {
    const editor = await open()
    disk['main.tex'] = MAIN.replace('tpyo', 'theirs')
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

describe('what was typed and not saved, across a reload of the page', () => {
  /* A reload is a page that knows nothing: the components are torn down and
     mounted afresh, and what survives is what was written to the tab. */
  const reload = async () => {
    cleanup()
    return open()
  }
  /** This app's own server, stopped: nothing answers. */
  const stopped = () => {
    const answering = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new TypeError('Load failed'))) as unknown as typeof fetch
    return () => {
      globalThis.fetch = answering
    }
  }

  test('the words are back in the same file, and are saved as they would have been', async () => {
    const editor = await open()
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    const restart = stopped()
    const mine = MAIN.replace('tpyo', 'typo, typed while the server was away')
    fireEvent.change(editor, { target: { value: mine } })
    await new Promise((done) => setTimeout(done, 60))
    expect(disk['main.tex']).toBe(MAIN)

    restart()
    const after = await reload()
    expect(after.value).toBe(mine)
    await waitFor(() => expect(disk['main.tex']).toBe(mine))
    /* Measured against the file they were typed over, like any other save. */
    expect(posted('/api/file').at(-1)!.body).toMatchObject({ file: 'main.tex', text: mine, was: hashOf(MAIN) })

    /* And once saved, nothing is held: the next reload is just the file. */
    await waitFor(() => expect(document.querySelector('[data-save]')?.getAttribute('data-save')).toBe('saved'))
    expect((await reload()).value).toBe(mine)
    expect(window.sessionStorage.getItem(`kehikot.paper.unsaved:${PROJECT}`)).toBeNull()
  })

  test('they are never put over a file somebody has written since: it is the ordinary conflict', async () => {
    const editor = await open()
    const restart = stopped()
    const mine = MAIN.replace('tpyo', 'typo')
    fireEvent.change(editor, { target: { value: mine } })
    await new Promise((done) => setTimeout(done, 60))

    const theirs = MAIN.replace('tpyo', 'typo, as somebody else has it')
    disk['main.tex'] = theirs
    restart()
    const after = await reload()
    expect(after.value).toBe(mine)
    expect((await screen.findByRole('alert')).textContent).toContain('changed on disk')
    await new Promise((done) => setTimeout(done, 60))
    expect(disk['main.tex']).toBe(theirs)

    fireEvent.click(screen.getByRole('button', { name: /Take the disk/ }))
    await waitFor(() => expect((screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value).toBe(theirs))
    expect(window.sessionStorage.getItem(`kehikot.paper.unsaved:${PROJECT}`)).toBeNull()
  })

  test('words typed in one project do not appear in a paper of the same name in another', async () => {
    const editor = await open()
    /* Reads answer and no save lands, so the file on disk stays as it was: the
       only way the words could reach the other project is by being held for it. */
    const answering = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/api/file') ? Promise.reject(new TypeError('Load failed')) : answering(input, init)) as typeof fetch
    try {
      fireEvent.change(editor, { target: { value: MAIN.replace('tpyo', 'typo') } })
      await new Promise((done) => setTimeout(done, 60))
      cleanup()
      ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('http://127.0.0.1:7870/app?project=%2Fsomewhere%2Felse&epic=a-paper')
      expect((await open()).value).toBe(MAIN)
      await new Promise((done) => setTimeout(done, 60))
      expect(disk['main.tex']).toBe(MAIN)
      expect(window.sessionStorage.getItem('kehikot.paper.unsaved:/somewhere/else')).toBeNull()
      expect(window.sessionStorage.getItem(`kehikot.paper.unsaved:${PROJECT}`)).toContain('typo')
    } finally {
      globalThis.fetch = answering
    }
  })
})

describe('this app’s own server, stopped', () => {
  test('the cover goes over the paper, never instead of it, and Try again reads again', async () => {
    const editor = await open()
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    const answering = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new TypeError('Load failed'))) as unknown as typeof fetch
    const mine = MAIN.replace('tpyo', 'typo')
    try {
      fireEvent.change(editor, { target: { value: mine } })
      expect(await screen.findByText('Paper’s own server is not answering.')).toBeDefined()
      /* Still mounted, still holding what was typed. */
      expect((screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value).toBe(mine)

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await new Promise((done) => setTimeout(done, 20))
      expect(screen.getByText('Paper’s own server is not answering.')).toBeDefined()
    } finally {
      globalThis.fetch = answering
    }
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByText('Paper’s own server is not answering.')).toBeNull())
    expect((screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value).toBe(mine)
  })
})

describe('between the source and the PDF', () => {
  test('a selection asks where its LINES came out and hands the rectangles, with the passage they are a hint for, to the preview', async () => {
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
    expect(lastPreview!.marks[0]).toMatchObject({ source: { text: MAIN, from, to: from + 4 }, rects: [{ page: 2, x: 10, y: 20, w: 30, h: 8 }] })
    expect(lastPreview!.reveal).not.toBeNull()
  })

  test('with only a caret, the passage is the line it is on', async () => {
    built = 'kept'
    await open()
    await waitFor(() => expect(lastEditor).not.toBeNull())
    const at = MAIN.indexOf('tpyo')
    lastEditor!.onSelect({ from: at, to: at })
    await waitFor(() => expect(lastPreview!.marks).toHaveLength(1))
    const passage = lastPreview!.marks[0]!.source!
    expect(passage.text).toBe(MAIN)
    expect(MAIN.slice(passage.from, passage.to)).toBe(MAIN.split('\n')[3]!)
    expect(MAIN.slice(passage.from, passage.to)).toContain('tpyo')
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
    press('pane', 'pdf')
    lastPreview!.onPoint({ page: 2, x: 100.5, y: 200.25, word: 'Fin' })
    const at = MAIN.indexOf('Fin')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-jump')).toBe(`${at}-${at + 3}`))
    expect(pane()).toBe('pdf')
    act(() => lastPreview!.onOpen!())
    expect(pane()).toBe('source')
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

  const waiting = (n = 1) => waitFor(() => expect(lastEditor!.suggestions?.length).toBe(n))

  test('is drawn in the source where it sits, with its reason, and writes nothing by being shown', async () => {
    proposals = [suggestion()]
    await open()
    await waiting()
    const one = lastEditor!.suggestions![0]!
    /* The passage the agent quoted, and what would stand there: content only. */
    expect(MAIN.slice(one.from, one.to)).toBe('with a tpyo in')
    expect(one.replacement).toBe('with a typo in')
    expect(one.why).toBe('A misspelling.')
    expect(one.after).toBe(false)
    expect(posted('/api/proposal')).toHaveLength(0)
    expect(posted('/api/file')).toHaveLength(0)
    expect(disk['main.tex']).toBe(MAIN)
    /* No Accept or Reject in the page's own view. */
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  test('Accept and Reject are the header’s, act on the one walked to, and each is one post naming the decision', async () => {
    proposals = [suggestion(), { ...suggestion(), id: 'p2', asked: { find: 'with a tpyo in', replace: 'with a typo in!' }, why: 'Another.' }]
    await open()
    await waiting(2)
    expect(row('sg-accept')!.disabled).toBe(true)
    press('sg-next')
    await waitFor(() => expect(row('sg-accept')!.disabled).toBe(false))
    expect(row('sg-next')!.textContent).toContain('1 of 2')
    press('sg-reject')
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: 'p1', decision: 'reject' })
    /* After an answer the view moves to the next one that is left. */
    await waitFor(() => expect(row('sg-accept')!.disabled).toBe(false))
    press('sg-accept')
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(2))
    expect(posted('/api/proposal')[1]!.body).toMatchObject({ id: 'p2', decision: 'accept' })
  })

  test('Edit makes the proposed text the author’s, and Accept sends it', async () => {
    proposals = [suggestion()]
    await open()
    await waiting()
    press('sg-next')
    await waitFor(() => expect(row('sg-edit')!.disabled).toBe(false))
    press('sg-edit')
    await waitFor(() => expect(lastEditor!.suggestions![0]!.editing).toBe(true))
    lastEditor!.drafts!.set('p1', 'with a typing slip in')
    expect(row('sg-accept')!.textContent).toContain('Accept my version')
    press('sg-accept')
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: 'p1', decision: 'accept', replaces: { p1: 'with a typing slip in' } })
  })

  const second = () => {
    const from = Buffer.from(MAIN).indexOf('Fin')
    return { id: 'p2', file: 'main.tex', from, to: from + 3, text: 'End', was_text: 'Fin', was: hashOf(MAIN), why: 'Say it plainly.', by: 'an agent', at: 2, asked: { find: 'Fin', replace: 'End' } }
  }

  test('the tag’s Accept change and Cancel change act on THEIR suggestion, not the current one', async () => {
    proposals = [suggestion(), second()]
    await open()
    await waiting(2)
    /* The caret is in the first; the second's tag is answered. */
    act(() => lastEditor!.onSelect({ from: suggestion().from, to: suggestion().from }))
    await waitFor(() => expect(lastEditor!.suggestions!.find((one) => one.id === 'p1')!.current).toBe(true))
    const other = lastEditor!.suggestions!.find((one) => one.id === 'p2')!
    expect(other.current).toBe(false)
    act(() => lastEditor!.onAnswerSuggestion!(other.key, 'accept'))
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: 'p2', decision: 'accept' })
    act(() => lastEditor!.onAnswerSuggestion!(lastEditor!.suggestions!.find((one) => one.id === 'p1')!.key, 'reject'))
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(2))
    expect(posted('/api/proposal')[1]!.body).toMatchObject({ id: 'p1', decision: 'reject' })
  })

  test('a group’s tag answers the group once, by its first passage', async () => {
    proposals = [{ ...suggestion(), group: 'mv' }, { ...second(), group: 'mv' }] as typeof proposals
    await open()
    await waiting(2)
    const tagged = lastEditor!.suggestions!.filter((one) => one.tag)
    expect(tagged).toHaveLength(1)
    expect(tagged[0]!.count).toBe(2)
    act(() => lastEditor!.onAnswerSuggestion!(tagged[0]!.key, 'accept'))
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: tagged[0]!.id, decision: 'accept' })
  })

  test('while editing, the tag’s Accept change applies the edited text and Cancel change rejects', async () => {
    proposals = [suggestion()]
    await open()
    await waiting()
    press('sg-next')
    await waitFor(() => expect(row('sg-edit')!.disabled).toBe(false))
    press('sg-edit')
    await waitFor(() => expect(lastEditor!.suggestions![0]!.editing).toBe(true))
    lastEditor!.drafts!.set('p1', 'with a typing slip in')
    act(() => lastEditor!.onAnswerSuggestion!(lastEditor!.suggestions![0]!.key, 'accept'))
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: 'p1', decision: 'accept', replaces: { p1: 'with a typing slip in' } })
  })

  test('the keys walk and answer, with the editor focused or not', async () => {
    proposals = [suggestion()]
    const editor = await open()
    await waiting()
    editor.focus()
    fireEvent.keyDown(editor, { code: 'BracketRight', altKey: true })
    await waitFor(() => expect(row('sg-accept')!.disabled).toBe(false))
    fireEvent.keyDown(editor, { code: 'Enter', altKey: true, shiftKey: true })
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: 'p1', decision: 'reject' })
  })

  test('typing sends no header message and changes nothing declared', async () => {
    proposals = [suggestion()]
    const editor = await open()
    await waiting()
    for (const ch of 'abcdefghijklmn') fireEvent.change(editor, { target: { value: (editor as HTMLTextAreaElement).value + ch } })
    expect(posted('/api/proposal')).toHaveLength(0)
    /* Let the save the typing owes land here, not in the next test. */
    await waitFor(() => expect(posted('/api/file').length).toBeGreaterThan(0), { timeout: 4000 })
  })

  test('without one chosen there is nothing to answer, and the reason is given', async () => {
    await open()
    expect(row('sg-accept')!.disabled).toBe(true)
    expect(row('sg-accept')!.getAttribute('title')).toContain('No suggestion')
    expect(row('sg-next')!.disabled).toBe(true)
  })

  test('the toggle switches a passage between the current and the proposed reading, in place', async () => {
    proposals = [suggestion()]
    await open()
    await waiting()
    act(() => lastEditor!.onToggleSuggestion!(lastEditor!.suggestions![0]!.key))
    await waitFor(() => expect(lastEditor!.suggestions![0]!.after).toBe(true))
    expect(lastEditor!.value).toBe(MAIN)
  })

  test('what was typed is saved BEFORE a suggestion is accepted, so the accept lands on the text on screen', async () => {
    proposals = [suggestion()]
    const editor = await open()
    await waiting()
    press('sg-next')
    await waitFor(() => expect(row('sg-accept')!.disabled).toBe(false))
    fireEvent.change(editor, { target: { value: MAIN.replace('Fin', 'The end') } })
    press('sg-accept')
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
    await waitFor(() => expect(lastEditor!.suggestions?.length).toBe(1))
    expect(source().getAttribute('data-mark')).toBe('')
    expect(source().getAttribute('data-jump')).toBe('')
  })

  test('one that arrives is marked and gone to, the tab is left alone, and the Source tab counts it', async () => {
    built = 'kept'
    await open()
    press('pane', 'pdf')
    proposals = [suggestion()]
    wake()
    await waitFor(() => expect(source().getAttribute('data-mark')).toBe(`${at}-${at + 4}`))
    expect(source().getAttribute('data-jump')).toBe(`${at}-${at + 4}`)
    expect(pane()).toBe('pdf')
    expect(options('pane')[0]!.label).toBe('Source · 1 suggested')
    expect(await screen.findByText(/A change was suggested in main\.tex/)).toBeDefined()
    /* On the page too, in the colour of a passage somebody else chose. */
    await waitFor(() => expect(lastPreview!.marks.some((mark) => mark.foreign)).toBe(true))
    /* Rejected: there is nothing left to point at. */
    press('pane', 'source')
    press('sg-next')
    await waitFor(() => expect(row('sg-reject')!.disabled).toBe(false))
    press('sg-reject')
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

  const orange = () => lastPreview!.marks.some((mark) => mark.foreign)
  const shownPdf = () => waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))

  test('text that lands is not marked on a PDF built before it: the mark is drawn when the build that has it is on screen', async () => {
    built = 'kept'
    builtFrom = MAIN
    await open()
    await shownPdf()
    let finish = () => {}
    compiling = new Promise((done) => (finish = done))
    disk['main.tex'] = MAIN.replace('tpyo', 'mistake')
    wake()
    /* In the source at once… */
    await waitFor(() => expect(source().getAttribute('data-mark')).toBe(`${at}-${at + 'mistake'.length}`))
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    await new Promise((done) => setTimeout(done, 40))
    /* …and not on the old build, where those words are not printed. */
    expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept')
    expect(orange()).toBe(false)
    finish()
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=build-1'))
    await waitFor(() => expect(orange()).toBe(true))
  })

  test('a suggestion that arrives is marked on the PDF and does not scroll it; pressing its file name does', async () => {
    built = 'kept'
    await open()
    await shownPdf()
    press('pane', 'pdf')
    /* Choosing the PDF shows the caret's line there, once: that is asked for, and is not the suggestion's doing. */
    await waitFor(() => expect(lastPreview!.reveal?.nonce).toBeDefined())
    const was = lastPreview!.reveal?.nonce
    proposals = [suggestion()]
    wake()
    await waitFor(() => expect(orange()).toBe(true))
    await new Promise((done) => setTimeout(done, 40))
    expect(lastPreview!.reveal?.nonce).toBe(was)
    /* The editor is still taken there: it is behind the PDF, and nobody is typing in it. */
    expect(source().getAttribute('data-jump')).toBe(`${at}-${at + 4}`)
    /* Its file name selects it in the source — the real editor reports that
       selection, as here — and a selection is followed on the PDF. */
    act(() => lastEditor!.onSelect({ from: at, to: at + 4 }))
    await waitFor(() => expect(lastPreview!.reveal?.nonce).not.toBe(was))
  })

  test('a change that lands by itself does not scroll the PDF; one that lands after Accept was pressed does', async () => {
    built = 'kept'
    proposals = [suggestion()]
    await open()
    await shownPdf()
    const was = lastPreview!.reveal?.nonce
    disk['main.tex'] = MAIN.replace('Fin', 'The end')
    wake()
    await waitFor(() => expect(orange()).toBe(true))
    await new Promise((done) => setTimeout(done, 40))
    expect(lastPreview!.reveal?.nonce).toBe(was)

    press('sg-next')
    await waitFor(() => expect(row('sg-accept')!.disabled).toBe(false))
    press('sg-accept')
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    disk['main.tex'] = disk['main.tex']!.replace('tpyo', 'typo')
    wake()
    await waitFor(() => expect(lastPreview!.reveal?.nonce).not.toBe(was))
    expect(orange()).toBe(true)
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
  const section = () => document.querySelector('[data-section-now]')?.textContent ?? 'Sections'
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
    press('section', 's0')
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
    press('section', 's0')
    await waitFor(() => expect(section()).toBe('Sections'))
    expect(said()).toContain('Nothing in this paper’s own files is recorded')
  })

  /** Marked where this PDF's table says, the words looked for beside it. */
  const orange = () => lastPreview!.marks.some((mark) => mark.foreign && mark.rects.length > 0)
  /**
   * Handed to the PDF as its words alone — no rectangle, because the table is
   * not this text's — and which words. `find.ts` draws them where they are
   * printed once and nowhere else (`test/find.test.ts`: "with no rectangles
   * from SyncTeX and nothing found, nothing is drawn").
   */
  const byWords = () => {
    const mark = lastPreview!.marks.find((one) => one.foreign && one.rects.length === 0)
    return mark?.source ? mark.source.text.slice(mark.source.from, mark.source.to) : null
  }
  const askedLine = (line: number) => calls.some((one) => one.path === '/api/sync' && one.query.get('line') === String(line))

  test('on a PDF of this very text it is marked at once, and the PDF turns to it', async () => {
    built = 'kept'
    render(<Framed />)
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))
    const was = lastPreview!.reveal?.nonce
    act(() => pointAt(there))
    await waitFor(() => expect(orange()).toBe(true))
    expect(askedLine(6)).toBe(true)
    expect(posted('/api/compile')).toHaveLength(0)
    expect(lastPreview!.reveal?.nonce).not.toBe(was)
  })

  test('a PDF built before lines were added above it is not asked where it is: it is looked for by its words alone, and by the table when the build that has them is on screen', async () => {
    built = 'kept'
    builtFrom = MAIN
    const moved = MAIN.replace('\\section{End}', 'One.\nTwo.\nThree.\n\\section{End}')
    disk['main.tex'] = moved
    let finish = () => {}
    compiling = new Promise((done) => (finish = done))
    render(<Framed />)
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    rectPage = 3
    const bytes = Buffer.from(moved).indexOf('Fin')
    act(() => pointAt({ ...there, from: bytes, to: bytes + 3 }))
    /* In the source at once… */
    const at = moved.indexOf('Fin')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-mark')).toBe(`${at}-${at + 3}`))
    await new Promise((done) => setTimeout(done, 40))
    /* …and the old build's table is never asked for line 9: it would answer for the line that was ninth then. */
    expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept')
    expect(orange()).toBe(false)
    expect(askedLine(9)).toBe(false)
    expect(byWords()).toBe('Fin')
    /* Until then the toolbar has the page map's page, as before any answer. */
    expect(toolbar()).toContain('p. 2/3')
    finish()
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=build-1'))
    await waitFor(() => expect(orange()).toBe(true))
    expect(askedLine(9)).toBe(true)
    expect(byWords()).toBeNull()
    await waitFor(() => expect(toolbar()).toContain('p. 3/3'))
  })

  test('while lines typed above it are unsaved the table is not asked either: the build and the disk still agree, and the editor does not', async () => {
    built = 'kept'
    render(<Framed />)
    const editor = await screen.findByLabelText('LaTeX source')
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))
    const typed = MAIN.replace('\\section{End}', 'One.\nTwo.\nThree.\n\\section{End}')
    let land = () => {}
    const landing = new Promise<void>((done) => (land = done))
    const answering = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/file')) await landing
      return answering(input, init)
    }) as typeof fetch
    fireEvent.change(editor, { target: { value: typed } })
    await waitFor(() => expect(document.querySelector('[data-save]')?.getAttribute('data-save')).toBe('saving'))
    rectPage = 3
    const bytes = Buffer.from(typed).indexOf('Fin')
    act(() => pointAt({ ...there, from: bytes, to: bytes + 3 }))
    const at = typed.indexOf('Fin')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-mark')).toBe(`${at}-${at + 3}`))
    await new Promise((done) => setTimeout(done, 40))
    /* The save has not landed, so the hash is still the build's: only the text says the table is old. */
    expect(disk['main.tex']).toBe(MAIN)
    expect(orange()).toBe(false)
    expect(askedLine(9)).toBe(false)
    expect(byWords()).toBe('Fin')
    land()
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=build-1'))
    await waitFor(() => expect(orange()).toBe(true))
    expect(askedLine(9)).toBe(true)
  })

  test('the file changed on disk a moment ago and the poll has not said so: the disk is looked at before the PDF is asked, and the old text’s table never is', async () => {
    built = 'kept'
    render(<Framed />)
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))
    /* Somebody rewrites the file and points into it in the same moment. Nothing wakes the poll. */
    const moved = MAIN.replace('\\section{End}', 'One.\nTwo.\nThree.\n\\section{End}')
    let finish = () => {}
    compiling = new Promise((done) => (finish = done))
    disk['main.tex'] = moved
    rectPage = 3
    const bytes = Buffer.from(moved).indexOf('Fin')
    act(() => pointAt({ ...there, from: bytes, to: bytes + 3 }))
    /* The editor takes the disk's text at once, so the source's mark is on the words that were meant… */
    const at = moved.indexOf('Fin')
    await waitFor(() => expect(lastEditor!.value).toBe(moved))
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-mark')).toBe(`${at}-${at + 3}`))
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    await new Promise((done) => setTimeout(done, 40))
    /* …and the PDF, which is of the old text, is asked nothing: those bytes of the old text are its last line. */
    expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept')
    expect(orange()).toBe(false)
    expect(askedLine(7)).toBe(false)
    expect(askedLine(9)).toBe(false)
    expect(byWords()).toBe('Fin')
    finish()
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=build-1'))
    await waitFor(() => expect(orange()).toBe(true))
    expect(askedLine(9)).toBe(true)
  })

  test('when the compile that follows fails the last good PDF’s table is never asked, however long that lasts; a compile that succeeds is', async () => {
    built = 'kept'
    builtFrom = MAIN
    const moved = MAIN.replace('\\section{End}', 'One.\nTwo.\nThree.\n\\section{End}')
    disk['main.tex'] = moved
    failing = true
    render(<Framed />)
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))
    await waitFor(() => expect(posted('/api/compile')).toHaveLength(1))
    await waitFor(() => expect(document.querySelector('[data-build]')?.getAttribute('data-build')).toBe('failed'))
    const bytes = Buffer.from(moved).indexOf('Fin')
    act(() => pointAt({ ...there, from: bytes, to: bytes + 3 }))
    const at = moved.indexOf('Fin')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-mark')).toBe(`${at}-${at + 3}`))
    await new Promise((done) => setTimeout(done, 60))
    /* The PDF on screen is the last one that compiled, and it is not of this text. */
    expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept')
    expect(orange()).toBe(false)
    expect(askedLine(9)).toBe(false)
    expect(byWords()).toBe('Fin')
    /* Nothing is said about the mark that is waiting: the toolbar's "failed" is the only word on it. */
    expect(said()).not.toMatch(/PDF|compile|build/i)
    failing = false
    press('compile')
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=build-2'))
    await waitFor(() => expect(orange()).toBe(true))
    expect(askedLine(9)).toBe(true)
  })

  test('a passage pointed straight after another does not borrow its rectangles while its own are on their way', async () => {
    built = 'kept'
    render(<Framed />)
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))
    act(() => pointAt(there))
    await waitFor(() => expect(orange()).toBe(true))
    let answer = () => {}
    const held = new Promise<void>((done) => (answer = done))
    const answering = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/sync')) await held
      return answering(input, init)
    }) as typeof fetch
    const claim = Buffer.from(MAIN).indexOf('claim')
    act(() => pointAt({ ...there, from: claim, to: claim + 5, quoted: 'claim' }))
    const at = MAIN.indexOf('claim')
    await waitFor(() => expect(screen.getByLabelText('LaTeX source').getAttribute('data-mark')).toBe(`${at}-${at + 5}`))
    await new Promise((done) => setTimeout(done, 40))
    /* "claim" beside where "Fin" is printed would be a mark of one passage in the other's place. */
    expect(lastPreview!.marks.some((mark) => mark.foreign)).toBe(false)
    answer()
    await waitFor(() => expect(orange()).toBe(true))
  })

  test('pointed at while the PDF is behind, the PDF is turned to it once — and a key typed under it afterwards does not turn it again', async () => {
    built = 'kept'
    render(<Framed />)
    const editor = await screen.findByLabelText('LaTeX source')
    await waitFor(() => expect(screen.getByTestId('preview').getAttribute('data-url')).toContain('build=kept'))
    act(() => pointAt(there))
    await waitFor(() => expect(orange()).toBe(true))
    const turned = lastPreview!.reveal?.nonce
    let land = () => {}
    const landing = new Promise<void>((done) => (land = done))
    const answering = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/file')) await landing
      return answering(input, init)
    }) as typeof fetch
    /* The person types after a passage that is already up: its mark goes on standing, by its words, and the PDF stays where they left it. */
    fireEvent.change(editor, { target: { value: MAIN.replace('Fin ä.', 'Fin ä. And more.') } })
    await waitFor(() => expect(byWords()).toBe('Fin'))
    await new Promise((done) => setTimeout(done, 40))
    expect(lastPreview!.reveal?.nonce).toBe(turned)
    land()
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

describe('Enter and Escape on a suggestion the person pressed on', () => {
  const first = () => {
    const from = Buffer.from(MAIN).indexOf('tpyo')
    return { id: 'p1', file: 'main.tex', from, to: from + 4, text: 'typo', was_text: 'tpyo', was: hashOf(MAIN), why: 'A misspelling.', by: 'an agent', at: 1, asked: { find: 'with a tpyo in', replace: 'with a typo in' } }
  }
  const other = () => {
    const from = Buffer.from(MAIN).indexOf('Fin')
    return { id: 'p2', file: 'main.tex', from, to: from + 3, text: 'End', was_text: 'Fin', was: hashOf(MAIN), why: 'Say it plainly.', by: 'an agent', at: 2, asked: { find: 'Fin', replace: 'End' } }
  }
  const waiting = (n: number) => waitFor(() => expect(lastEditor!.suggestions?.length).toBe(n))
  const one = (id: string) => lastEditor!.suggestions!.find((s) => s.id === id)!
  const inside = (id: string) => ({ from: one(id).from + 2, to: one(id).from + 2 })
  const key = (decision: 'accept' | 'reject') => {
    let taken = false
    act(() => {
      taken = lastEditor!.onArmedKey!(decision)
    })
    return taken
  }

  test('not armed on load, on the caret landing in it, on Next, or on typing: the keys are not taken', async () => {
    proposals = [first(), other()]
    await open()
    await waiting(2)
    expect(lastEditor!.suggestions!.every((s) => !s.armed)).toBe(true)
    act(() => lastEditor!.onSelect(inside('p1')))
    await waitFor(() => expect(one('p1').current).toBe(true))
    expect(one('p1').armed).toBe(false)
    expect(key('accept')).toBe(false)
    expect(key('reject')).toBe(false)
    act(() => lastEditor!.onSelect({ from: 0, to: 0 }))
    press('sg-next')
    await waitFor(() => expect(one('p2').current || one('p1').current).toBe(true))
    expect(lastEditor!.suggestions!.every((s) => !s.armed)).toBe(true)
    expect(key('accept')).toBe(false)
    expect(posted('/api/proposal')).toHaveLength(0)
  })

  test('a pointer press arms; Enter accepts it, and the next one is NOT armed', async () => {
    proposals = [first(), other()]
    await open()
    await waiting(2)
    act(() => lastEditor!.onPickSuggestion!('p1'))
    act(() => lastEditor!.onSelect(inside('p1')))
    await waitFor(() => expect(one('p1').armed).toBe(true))
    expect(one('p2').armed).toBe(false)
    expect(key('accept')).toBe(true)
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: 'p1', decision: 'accept' })
    await waitFor(() => expect(lastEditor!.suggestions!.map((s) => s.id)).toEqual(['p2']))
    /* The run the pointer began goes on: the next one is led to and armed, once the editor has the focus. */
    await waitFor(() => expect(one('p2').armed).toBe(true))
  })

  test('Jump to next change: Enter, Esc, Enter walk the whole list in reading order, then say there are no more', async () => {
    const third = () => ({ ...other(), id: 'p3', from: Buffer.from(MAIN).indexOf('claim'), to: Buffer.from(MAIN).indexOf('claim') + 5, was_text: 'claim', text: 'point', asked: { find: 'claim', replace: 'point' }, why: 'Third.' })
    proposals = [first(), other(), third()]
    await open()
    await waiting(3)
    act(() => lastEditor!.onPickSuggestion!('p1'))
    act(() => lastEditor!.onSelect(inside('p1')))
    await waitFor(() => expect(one('p1').armed).toBe(true))
    const decided = () => posted('/api/proposal').map((c) => `${c.body!.id}:${c.body!.decision}`)
    expect(key('accept')).toBe(true)
    await waitFor(() => expect(decided()).toEqual(['p1:accept']))
    /* Reading order: claim is above tpyo in the source, so the next after tpyo is Fin. */
    await waitFor(() => expect(lastEditor!.suggestions!.filter((x) => x.armed).length).toBe(1))
    const next = lastEditor!.suggestions!.find((x) => x.armed)!
    act(() => lastEditor!.onSelect({ from: next.from, to: next.from }))
    expect(key('reject')).toBe(true)
    await waitFor(() => expect(decided()).toHaveLength(2))
    await waitFor(() => expect(lastEditor!.suggestions!.filter((x) => x.armed).length).toBe(1))
    const last = lastEditor!.suggestions!.find((x) => x.armed)!
    act(() => lastEditor!.onSelect({ from: last.from, to: last.from }))
    expect(key('accept')).toBe(true)
    await waitFor(() => expect(decided()).toHaveLength(3))
    await waitFor(() => expect(lastEditor!.suggestions).toHaveLength(0))
    await waitFor(() => expect(row('sg-next')!.textContent).toContain('No more changes'))
    expect(new Set(decided().map((d) => d.split(':')[0])).size).toBe(3)
  })

  test('with Jump to next change off, a decision leaves things where they are: nothing is led to, nothing armed', async () => {
    jumpOn = false
    proposals = [first(), other()]
    await open()
    await waiting(2)
    await waitFor(() => expect(row('jump')!.getAttribute('aria-checked')).toBe('false'))
    act(() => lastEditor!.onPickSuggestion!('p1'))
    act(() => lastEditor!.onSelect(inside('p1')))
    await waitFor(() => expect(one('p1').armed).toBe(true))
    expect(key('accept')).toBe(true)
    await waitFor(() => expect(lastEditor!.suggestions!.map((s) => s.id)).toEqual(['p2']))
    await new Promise((done) => setTimeout(done, 300))
    expect(one('p2').armed).toBe(false)
    expect(one('p2').current).toBe(false)
  })

  test('the checkbox is the person’s: pressing it saves it, and under Auto accept it says why it is idle', async () => {
    proposals = [first()]
    await open()
    await waiting(1)
    press('jump', false)
    await waitFor(() => expect(posted('/api/review')[0]!.body).toMatchObject({ action: 'jump', on: false }))
    press('auto', true)
    await waitFor(() => expect(posted('/api/review').at(-1)!.body).toMatchObject({ action: 'auto', on: true }))
    await waitFor(() => expect(String(row('jump')!.textContent)).toContain('Auto accept is on'))
  })

  test('Escape cancels the armed one and leaves the source untouched', async () => {
    proposals = [first()]
    await open()
    await waiting(1)
    act(() => lastEditor!.onPickSuggestion!('p1'))
    act(() => lastEditor!.onSelect(inside('p1')))
    await waitFor(() => expect(one('p1').armed).toBe(true))
    expect(key('reject')).toBe(true)
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
    expect(posted('/api/proposal')[0]!.body).toMatchObject({ id: 'p1', decision: 'reject' })
    expect(posted('/api/file')).toHaveLength(0)
  })

  test('typing, the caret leaving, and losing focus disarm; moving inside the passage does not', async () => {
    proposals = [first(), other()]
    await open()
    await waiting(2)
    const arm = async () => {
      act(() => lastEditor!.onPickSuggestion!('p1'))
      act(() => lastEditor!.onSelect(inside('p1')))
      await waitFor(() => expect(one('p1').armed).toBe(true))
    }
    await arm()
    act(() => lastEditor!.onSelect({ from: one('p1').from + 3, to: one('p1').from + 3 }))
    expect(one('p1').armed).toBe(true)
    act(() => lastEditor!.onSelect({ from: 0, to: 0 }))
    await waitFor(() => expect(one('p1').armed).toBe(false))
    expect(key('accept')).toBe(false)
    await arm()
    act(() => lastEditor!.onDisarm!())
    await waitFor(() => expect(one('p1').armed).toBe(false))
    await arm()
    act(() => lastEditor!.onChange(MAIN + 'x'))
    await waitFor(() => expect(one('p1').armed).toBe(false))
    expect(key('accept')).toBe(false)
  })

  test('the key is not taken when the caret is elsewhere, even if armed state lingered', async () => {
    proposals = [first()]
    await open()
    await waiting(1)
    act(() => lastEditor!.onPickSuggestion!('p1'))
    expect(key('accept')).toBe(false)
    expect(posted('/api/proposal')).toHaveLength(0)
  })

  test('a group is armed as a whole', async () => {
    proposals = [{ ...first(), group: 'mv' }, { ...other(), group: 'mv' }] as typeof proposals
    await open()
    await waiting(2)
    act(() => lastEditor!.onPickSuggestion!('p2'))
    act(() => lastEditor!.onSelect(inside('p2')))
    await waitFor(() => expect(lastEditor!.suggestions!.every((s) => s.armed)).toBe(true))
    expect(key('accept')).toBe(true)
    await waitFor(() => expect(posted('/api/proposal')).toHaveLength(1))
  })

  test('Escape in the edit box stops editing and rejects nothing', async () => {
    proposals = [first()]
    await open()
    await waiting(1)
    press('sg-next')
    await waitFor(() => expect(row('sg-edit')!.disabled).toBe(false))
    press('sg-edit')
    await waitFor(() => expect(one('p1').editing).toBe(true))
    act(() => lastEditor!.onStopEditing!())
    await waitFor(() => expect(one('p1').editing).toBe(false))
    expect(posted('/api/proposal')).toHaveLength(0)
  })
})
