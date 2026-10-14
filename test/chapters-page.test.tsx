import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MESSAGE, PROTOCOL, type EpicPart } from 'kehikot-module-protocol'
import { createHash } from 'node:crypto'

import { parseLatex } from '../latex/parse.ts'
import { standIn } from '../src/api.ts'
import type { EditorProps } from '../src/editor/source-editor.tsx'
import { inProject } from '../src/focus.ts'
import type { PreviewProps } from '../src/pdf/pdf-view.tsx'
import { LINGER, forgetHost, noSuchPart } from '../src/use-chapters.ts'
import { usePaper } from '../src/use-paper.ts'
import { Workspace } from '../src/workspace.tsx'
import { has, options, press, row } from './menu.ts'

/**
 * Setting which chapter is a part's, on the page, against the two hosts.
 *
 * `chapters.test.ts` has the record and what is published from it. This is
 * the control: where it is drawn and for which file, that opening and reading
 * write nothing, that the first press sends EVERY part's chapter as the parts
 * said them, that the canvas is then told, and that a host which cannot keep
 * parts is shown neither control.
 */

const PROJECT = '/tmp/project'
const EPIC = 'a-paper'
const FILES = ['main.tex', 'chapters/design.tex', 'tables/t.tex', 'chapters/method.tex', 'chapters/results.tex']
const TEXT: Record<string, string> = {
  'main.tex': ['\\documentclass{report}', '\\begin{document}', 'Front.', '\\include{chapters/design}', '\\include{chapters/method}', '\\include{chapters/results}', '\\end{document}', ''].join('\n'),
  'chapters/design.tex': ['\\chapter{The design}', 'The design is this.', '\\input{tables/t}', ''].join('\n'),
  'tables/t.tex': ['A table.', ''].join('\n'),
  'chapters/method.tex': ['\\chapter{Method}', 'The method is that.', ''].join('\n'),
  'chapters/results.tex': ['No heading here.', ''].join('\n'),
}
const PULLS = {
  'chapters/design.tex': { by: 'main.tex', with: 'include', as: 'chapters/design' },
  'tables/t.tex': { by: 'chapters/design.tex', with: 'input', as: 'tables/t' },
  'chapters/method.tex': { by: 'main.tex', with: 'include', as: 'chapters/method' },
  'chapters/results.tex': { by: 'main.tex', with: 'include', as: 'chapters/results' },
}
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')
const hashes = () => Object.fromEntries(FILES.map((file) => [file, hashOf(TEXT[file]!)]))
const paperNow = () => ({
  epic: EPIC,
  dir: `${PROJECT}/.kehikot/paper/${EPIC}`,
  title: null,
  author: null,
  blocks: FILES.flatMap((file) => parseLatex(TEXT[file]!, file).blocks.map((block) => ({ ...block, file }))),
  outline: [],
  files: FILES,
  hashes: hashes(),
  figures: [],
  pulls: PULLS,
  narrowsItself: false,
})

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
}
interface Asked {
  type?: string
  id?: string
  method?: string
  params?: Record<string, unknown>
}
let calls: Call[]
let asks: Asked[]
/** This module's own record, as its server would hold it: null until something is kept. */
let kept: Record<string, string> | null
/** What the host under test does with `parts.set`: keeps the list (1.2.0), has never heard of it, or declines. */
let hostIs: 'keeps' | 'older' | 'declines'
let listed: { id: string; name: string }[]
const fetchWas = globalThis.fetch

function serve(path: string, query: URLSearchParams, body: Record<string, unknown> | null, method: string): [number, unknown] {
  const file = String(query.get('file') ?? body?.file ?? 'main.tex')
  if (path === '/api/paper') return [200, { ok: true, paper: paperNow() }]
  if (path === '/api/source') return [200, { ok: true, source: TEXT[file], hash: hashOf(TEXT[file]!) }]
  if (path === '/api/build') return [200, { ok: true, build: { engine: null, engines: [], how: '', running: false, last: null, pdf: null } }]
  if (path === '/api/proposals') return [200, { ok: true, proposals: [], said: '' }]
  if (path === '/api/uncommitted') return [200, { ok: true, standing: { at: 'nogit' }, hashes: hashes() }]
  if (path === '/api/part') return [200, { ok: true, part: null }]
  if (path === '/api/chapters' && method === 'GET') return [200, { ok: true, chapters: kept }]
  if (path === '/api/chapters') {
    kept = body?.chapters as Record<string, string>
    return [200, { ok: true, chapters: kept, published: true }]
  }
  return [404, { ok: false, error: `no ${path} in this test` }]
}

function Textarea(props: EditorProps) {
  return <textarea aria-label="LaTeX source" value={props.value} onChange={(event) => props.onChange(event.target.value)} />
}
function Stub(_: PreviewProps) {
  return <div data-testid="preview" />
}
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

/** A host that greets, sends contexts and — when it keeps the parts — answers `parts.set` as the protocol specifies. */
function host() {
  const post = (data: unknown) => {
    const event = new MessageEvent('message', { data, origin: 'http://localhost:7777' })
    Object.defineProperty(event, 'source', { value: source })
    act(() => {
      window.dispatchEvent(event)
    })
  }
  const answerTo = (asked: Asked) => {
    if (asked.type !== MESSAGE.REQUEST || !asked.id) return
    if (asked.method !== 'parts.set') return
    const respond = (data: unknown) => setTimeout(() => post({ type: MESSAGE.RESPONSE, id: asked.id, ok: true, data }), 0)
    if (hostIs === 'older') {
      setTimeout(() => post({ type: MESSAGE.RESPONSE, id: asked.id, ok: false, reason: 'unknown-method', error: 'This host has no parts.set.' }), 0)
      return
    }
    if (hostIs === 'declines') {
      respond({ outcome: 'declined', parts: [], id: null, why: 'This module’s manifest does not ask for parts:set.' })
      return
    }
    const params = asked.params as { add?: { name: string }; move?: { id: string; after: string | null } }
    if (params.move) {
      /* As a host does: a part that is not in the list is `no-such-part`, and one that is would be MOVED. */
      if (listed.some((one) => one.id === params.move!.id)) throw new Error('the probe named a real part')
      respond({ outcome: 'no-such-part', parts: listed, id: null, why: '' })
      return
    }
    if (params.add) {
      const id = params.add.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      listed = [...listed, { id, name: params.add.name }]
      respond({ outcome: 'changed', parts: listed, id, why: '' })
    }
  }
  const source = { postMessage: (data: Asked) => void (asks.push(data), answerTo(data)) }
  const context = (parts: EpicPart[]) => ({ epic: EPIC, project: 'project', projectPath: PROJECT, theme: 'light', selection: [], parts, passage: null })
  return {
    greet: (parts: EpicPart[] = []) => post({ type: MESSAGE.HELLO, protocol: PROTOCOL, session: 's', context: context(parts), state: null }),
    context: (parts: EpicPart[]) => post({ type: MESSAGE.CONTEXT, protocol: PROTOCOL, ...context(parts) }),
  }
}

/** A part as each host sends it: `documents` beside `files` from one that keeps the parts, `files` alone from an older one. */
const part = (id: string, heading: string, picked: boolean, files?: string[]): EpicPart => ({
  id,
  heading,
  refs: [],
  picked,
  ...(files ? (hostIs === 'older' ? { files } : { files, documents: files.map((file) => inProject(EPIC, file)) }) : {}),
})
const PARTS = (...picked: string[]): EpicPart[] => {
  listed = [{ id: 'the-design', name: 'The design' }, { id: 'the-method', name: 'The method' }, { id: 'the-results', name: 'Results' }]
  return [
    part('the-design', 'The design', picked.includes('the-design'), ['chapters/design.tex']),
    part('the-method', 'The method', picked.includes('the-method'), ['chapters/method.tex']),
    part('the-results', 'Results', picked.includes('the-results')),
  ]
}

/** The "chapter of" switch in the View menu, as the part's id it is on ('' for no part) and the words of its options; null when it is not declared. */
const control = () => {
  if (!has('chapter')) return null
  const all = options('chapter')
  const at = all.find((one) => one.on)
  return { value: !at || at.id === 'none' ? '' : listed[Number(at.id.slice(1))]!.id, words: all.map((one) => one.label) }
}
const choose = (id: string) => press('chapter', id === '' ? 'none' : `p${listed.findIndex((one) => one.id === id)}`)
const offer = () => (has('parts-each') ? row('parts-each') : null)
const said = () => screen.getByTestId('said').textContent ?? ''
const openFile = () => document.querySelector('[data-editing]')?.getAttribute('data-editing')
const writes = () => calls.filter((one) => one.method !== 'GET')
const asked = (method: string) => asks.filter((one) => one.method === method)
const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 20)))
const jumpTo = async (file: string) => {
  press('section', file)
  await waitFor(() => expect(openFile()).toBe(file))
}

const framed = async (parts: EpicPart[]) => {
  const canvas = host()
  render(<Framed />)
  canvas.greet(parts)
  await screen.findByLabelText('LaTeX source')
  await settle()
  return canvas
}

beforeEach(() => {
  calls = []
  asks = []
  kept = null
  hostIs = 'keeps'
  forgetHost()
  listed = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:7870')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ method, path: url.pathname, body })
    const [status, answer] = serve(url.pathname, url.searchParams, body, method)
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = fetchWas
  standIn(null)
})

describe('on a host that keeps the parts', () => {
  test('the line that names a chapter says which part it is the chapter of — read off the parts, with nothing written', async () => {
    await framed(PARTS('the-method'))
    await waitFor(() => expect(openFile()).toBe('chapters/method.tex'))
    await waitFor(() => expect(control()).not.toBeNull())
    expect(control()!.value).toBe('the-method')
    /* The design already has a chapter, and the option says what choosing it would do to that one. */
    expect(control()!.words).toEqual(['no part', 'The design · swaps with design.tex', 'The method', 'Results'])
    /* In the line that names the file, and not a row of its own. */
    /* Opening, reading and being narrowed wrote nothing, and told the canvas nothing about content. */
    expect(writes()).toEqual([])
    expect(asked('content.changed')).toEqual([])
    /* The host was asked once whether it keeps parts, with an edit that changes nothing. */
    expect(asked('parts.set').map((one) => one.params)).toEqual([{ epic: EPIC, move: { id: 'no-such-part', after: null } }])
  })

  test('main.tex and a table a chapter pulls in are nobody’s chapter to set', async () => {
    await framed(PARTS())
    expect(openFile()).toBe('main.tex')
    expect(control()).toBeNull()
    await jumpTo('tables/t.tex')
    expect(control()).toBeNull()
    await jumpTo('chapters/results.tex')
    await waitFor(() => expect(control()).not.toBeNull())
    expect(control()!.value).toBe('')
  })

  test('the first press takes over EVERY part’s chapter as the parts said them, with the one change — once — and tells the canvas', async () => {
    await framed(PARTS())
    await jumpTo('chapters/results.tex')
    await waitFor(() => expect(control()).not.toBeNull())
    choose('the-results')
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]).toEqual({
      method: 'POST',
      path: '/api/chapters',
      body: { chapters: { 'the-design': 'chapters/design.tex', 'the-method': 'chapters/method.tex', 'the-results': 'chapters/results.tex' } },
    })
    await waitFor(() => expect(asked('content.changed').map((one) => one.params)).toEqual([{ epic: EPIC }]))
    await waitFor(() => expect(control()!.value).toBe('the-results'))
  })

  test('from then on the record is this module’s: a second change is made to IT, whatever the parts go on saying', async () => {
    kept = { 'the-design': 'chapters/design.tex', 'the-results': 'chapters/results.tex' }
    await framed(PARTS())
    await jumpTo('chapters/method.tex')
    await waitFor(() => expect(control()).not.toBeNull())
    /* The parts still say the method chapter is the method's; this module's record says it is no part's. */
    expect(control()!.value).toBe('')
    choose('the-results')
    await waitFor(() => expect(writes()).toHaveLength(1))
    /* One chapter to a part: the results part gives up the chapter it had. */
    expect(writes()[0]!.body).toEqual({ chapters: { 'the-design': 'chapters/design.tex', 'the-results': 'chapters/method.tex' } })
  })

  test('a chapter given to a part that has one swaps with it: the option says so before, the page says what moved, and pressing back restores it exactly', async () => {
    const every = { 'the-design': 'chapters/design.tex', 'the-method': 'chapters/method.tex', 'the-results': 'chapters/results.tex' }
    listed = [{ id: 'the-design', name: 'The design' }, { id: 'the-method', name: 'The method' }, { id: 'the-results', name: 'Results' }]
    /* Read off the parts, with no record yet: the first press is also the one that adopts. */
    await framed([
      part('the-design', 'The design', false, ['chapters/design.tex', 'tables/t.tex']),
      part('the-method', 'The method', true, ['chapters/method.tex']),
      part('the-results', 'Results', false, ['chapters/results.tex']),
    ])
    await waitFor(() => expect(control()?.value).toBe('the-method'))
    expect(control()!.words).toEqual(['no part', 'The design · swaps with design.tex', 'The method', 'Results · swaps with results.tex'])
    expect(said()).toBe('')

    choose('the-results')
    await waitFor(() => expect(writes()).toHaveLength(1))
    /* Every part still has a chapter: the one that was in the way went to the part this file came from. */
    expect(writes()[0]!.body).toEqual({ chapters: { ...every, 'the-method': 'chapters/results.tex', 'the-results': 'chapters/method.tex' } })
    await waitFor(() => expect(said()).toBe('method.tex is now the chapter of Results, and results.tex of The method.'))
    await waitFor(() => expect(control()!.value).toBe('the-results'))
    expect(control()!.words).toEqual(['no part', 'The design · swaps with design.tex', 'The method · swaps with results.tex', 'Results'])

    choose('the-method')
    await waitFor(() => expect(writes()).toHaveLength(2))
    /* As the parts said it before anything was pressed — the same entries in the same order. */
    expect(JSON.stringify(writes()[1]!.body)).toBe(JSON.stringify({ chapters: every }))
    await waitFor(() => expect(said()).toBe('method.tex is now the chapter of The method, and results.tex of Results.'))
    await waitFor(() => expect(control()!.value).toBe('the-method'))
  })

  test('a file that is no part’s chapter, given to a part that has one: the option says the other is left with no part, and so does the page after', async () => {
    kept = { 'the-design': 'chapters/design.tex', 'the-results': 'chapters/results.tex' }
    await framed(PARTS())
    await jumpTo('chapters/method.tex')
    await waitFor(() => expect(control()).not.toBeNull())
    expect(control()!.value).toBe('')
    expect(control()!.words).toEqual(['no part', 'The design · no part for design.tex', 'The method', 'Results · no part for results.tex'])
    choose('the-results')
    await waitFor(() => expect(said()).toBe('method.tex is now the chapter of Results; results.tex is the chapter of no part.'))
    /* A press that moves no other chapter says nothing, and takes that sentence down. */
    choose('the-method')
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes()[1]!.body).toEqual({ chapters: { 'the-design': 'chapters/design.tex', 'the-method': 'chapters/method.tex' } })
    await waitFor(() => expect(said()).toBe(''))
  })

  test('the sentence stands for a while and then gives its row back', async () => {
    const was = LINGER.ms
    LINGER.ms = 60
    try {
      await framed([part('the-design', 'The design', false, ['chapters/design.tex']), part('the-method', 'The method', true, ['chapters/method.tex'])])
      listed = [{ id: 'the-design', name: 'The design' }, { id: 'the-method', name: 'The method' }]
      await waitFor(() => expect(control()?.value).toBe('the-method'))
      choose('the-design')
      await waitFor(() => expect(said()).toBe('method.tex is now the chapter of The design, and design.tex of The method.'))
      await waitFor(() => expect(said()).toBe(''))
    } finally {
      LINGER.ms = was
    }
  })

  test('“no part” takes the chapter from its part', async () => {
    await framed(PARTS('the-method'))
    await waitFor(() => expect(control()?.value).toBe('the-method'))
    choose('')
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]!.body).toEqual({ chapters: { 'the-design': 'chapters/design.tex' } })
  })

  test('an epic with a paper and no parts: one press asks the host for a part to each chapter, and files each chapter under the part it made', async () => {
    await framed([])
    await waitFor(() => expect(offer()).not.toBeNull())
    expect(offer()!.textContent).toBe('A part for each chapter')
    expect(control()).toBeNull()
    expect(writes()).toEqual([])
    press('parts-each')
    await waitFor(() => expect(writes()).toHaveLength(1))
    /* Named by the chapter's first heading, in the paper's order. The table a chapter reads is no
       chapter, and neither is a file main.tex pulls in that has no heading: nobody picks a part called after a file of macros. */
    expect(asked('parts.set').filter((one) => one.params?.add).map((one) => one.params)).toEqual([
      { epic: EPIC, add: { name: 'The design' } },
      { epic: EPIC, add: { name: 'Method' } },
    ])
    /* Under the ids the HOST made. */
    expect(writes()[0]!.body).toEqual({ chapters: { 'the-design': 'chapters/design.tex', method: 'chapters/method.tex' } })
    await waitFor(() => expect(asked('content.changed')).toHaveLength(1))
  })

  test('and it is not offered once the epic has parts', async () => {
    await framed(PARTS())
    await settle()
    expect(offer()).toBeNull()
  })
})

describe('what the host is asked, to learn whether it keeps the parts', () => {
  test('is about an id no part of the epic has, so that asking can change nothing', () => {
    const called = (id: string): EpicPart => ({ id, heading: id, refs: [], picked: false })
    expect(noSuchPart([])).toBe('no-such-part')
    expect(noSuchPart([called('methods')])).toBe('no-such-part')
    expect(noSuchPart([called('no-such-part'), called('no-such-part-x')])).toBe('no-such-part-x-x')
  })
})

describe('how often the host is asked', () => {
  const probes = () => asked('parts.set').filter((one) => one.params?.move)

  test('once a page load, however many times the page mounts — and React mounts it twice where it is developed', async () => {
    const canvas = host()
    render(
      <StrictMode>
        <Framed />
      </StrictMode>,
    )
    canvas.greet(PARTS('the-method'))
    await screen.findByLabelText('LaTeX source')
    await waitFor(() => expect(control()).not.toBeNull())
    expect(probes()).toHaveLength(1)
    cleanup()
    await framed(PARTS('the-method'))
    await waitFor(() => expect(control()).not.toBeNull())
    expect(probes()).toHaveLength(1)
  })

  test('and not at all on a reload, once this host has said in this tab that it keeps the parts', async () => {
    const referrer = Object.getOwnPropertyDescriptor(document, 'referrer')
    Object.defineProperty(document, 'referrer', { value: 'http://localhost:7777/', configurable: true })
    try {
      await framed(PARTS('the-method'))
      await waitFor(() => expect(control()).not.toBeNull())
      expect(probes()).toHaveLength(1)
      cleanup()
      /* A reload: what the page load held is gone, and what the tab holds is not. */
      forgetHost({ tab: false })
      await framed(PARTS('the-method'))
      await waitFor(() => expect(control()).not.toBeNull())
      expect(probes()).toHaveLength(1)
      /* Another host around the same page is asked for itself. */
      cleanup()
      forgetHost({ tab: false })
      Object.defineProperty(document, 'referrer', { value: 'http://localhost:8888/', configurable: true })
      await framed(PARTS('the-method'))
      await waitFor(() => expect(control()).not.toBeNull())
      expect(probes()).toHaveLength(2)
    } finally {
      if (referrer) Object.defineProperty(document, 'referrer', referrer)
      else delete (document as unknown as { referrer?: string }).referrer
    }
  })

  test('a host that said no is not remembered past the page load', async () => {
    hostIs = 'older'
    await framed(PARTS('the-method'))
    await settle()
    expect(control()).toBeNull()
    expect(probes()).toHaveLength(1)
    cleanup()
    forgetHost({ tab: false })
    hostIs = 'keeps'
    await framed(PARTS('the-method'))
    await waitFor(() => expect(control()).not.toBeNull())
    expect(probes()).toHaveLength(2)
  })
})

describe('on a host that cannot answer parts.set', () => {
  test('an older host: neither control is drawn, with parts or without — and the page is narrowed by the files it sends as it always was', async () => {
    hostIs = 'older'
    const canvas = await framed(PARTS('the-method'))
    await waitFor(() => expect(openFile()).toBe('chapters/method.tex'))
    await settle()
    expect(control()).toBeNull()
    expect(offer()).toBeNull()
    canvas.context([])
    await waitFor(() => expect(openFile()).toBe('main.tex'))
    await settle()
    expect(offer()).toBeNull()
    expect(control()).toBeNull()
    expect(writes()).toEqual([])
    /* Asked once, and never to add anything. */
    expect(asked('parts.set').every((one) => one.params?.add === undefined)).toBe(true)
  })

  test('a host that declines — the capability was not granted — is shown neither', async () => {
    hostIs = 'declines'
    await framed([])
    await settle()
    expect(offer()).toBeNull()
    expect(control()).toBeNull()
  })
})
