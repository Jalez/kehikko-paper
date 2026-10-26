import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MESSAGE, PROTOCOL, type EpicPart } from 'kehikot-module-protocol'
import { createHash } from 'node:crypto'

import { parseLatex } from '../latex/parse.ts'
import { standIn } from '../src/api.ts'
import { SourceColumn, type ColumnRegion } from '../src/editor/source-column.tsx'
import type { EditorProps } from '../src/editor/source-editor.tsx'
import type { PreviewProps } from '../src/pdf/pdf-view.tsx'
import { usePaper } from '../src/use-paper.ts'
import { Workspace } from '../src/workspace.tsx'
import { options, press } from './menu.ts'

/**
 * The continuous column: every file of the paper, one after another.
 *
 * The real editor does not lay out here, so a textarea stands in for it and
 * the layout is faked on the elements the column reads (`clientHeight`,
 * `offsetTop`, `offsetHeight`). What is under test is which regions there are,
 * in what order, which are mounted, and that each file is saved as itself.
 */

const EPIC = 'a-paper'
const FILES = ['main.tex', 'chapters/design.tex', 'chapters/method.tex']
const TEXT: Record<string, string> = {
  'main.tex': ['\\documentclass{article}', '\\begin{document}', '\\section{Opening}', 'Said in main.', '\\end{document}', ''].join('\n'),
  'chapters/design.tex': ['\\section{Design}', 'The design is this.', ''].join('\n'),
  'chapters/method.tex': ['\\section{Method}', 'The method is that.', ''].join('\n'),
}
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')
let disk: Record<string, string>
let posted: { file: string; text: string }[]
let reads: string[]
const fetchWas = globalThis.fetch
const hashes = () => Object.fromEntries(FILES.map((file) => [file, hashOf(disk[file]!)]))
const paperNow = () => ({
  epic: EPIC,
  dir: `/tmp/p/.kehikot/paper/${EPIC}`,
  title: null,
  author: null,
  blocks: FILES.flatMap((file) => parseLatex(disk[file]!, file).blocks.map((block) => ({ ...block, file }))),
  outline: [],
  files: FILES,
  hashes: hashes(),
  figures: [],
})

function Textarea(props: EditorProps) {
  return <textarea aria-label="LaTeX source" value={props.value} data-jump={props.jump ? `${props.jump.from}` : ''} onChange={(e) => props.onChange(e.target.value)} />
}
function Stub(props: PreviewProps) {
  return <div data-testid="preview" data-url={props.url ?? ''} />
}
function Framed() {
  const wire = usePaper(true)
  if (wire.sight.at !== 'reading') return <p>{wire.sight.at}</p>
  return <Workspace paper={wire.sight.paper} wire={wire} editor={Textarea} preview={Stub} saveDelay={15} settle={5} />
}
const part = (id: string, heading: string, picked: boolean, files: string[]): EpicPart => ({ id, heading, refs: [], picked, files })
const PARTS = (...picked: string[]): EpicPart[] => [
  part('the-design', 'The design', picked.includes('the-design'), ['chapters/design.tex']),
  part('the-method', 'The method', picked.includes('the-method'), ['chapters/method.tex']),
]
function host(parts: EpicPart[]) {
  const source = { postMessage: () => {} }
  const ctx = (p: EpicPart[]) => ({ epic: EPIC, project: 'project', projectPath: '/tmp/p', theme: 'light', selection: [], parts: p, passage: null })
  const post = (data: unknown) => {
    const event = new MessageEvent('message', { data, origin: 'http://localhost:7777' })
    Object.defineProperty(event, 'source', { value: source })
    act(() => {
      window.dispatchEvent(event)
    })
  }
  post({ type: MESSAGE.HELLO, protocol: PROTOCOL, session: 's', context: ctx(parts), state: null })
  return (p: EpicPart[]) => post({ type: MESSAGE.CONTEXT, protocol: PROTOCOL, ...ctx(p) })
}
const regionsShown = () => [...document.querySelectorAll('[data-region]')].map((n) => n.getAttribute('data-region'))
const mountedShown = () => [...document.querySelectorAll('[data-region][data-mounted]')].map((n) => n.getAttribute('data-region'))
const openFile = () => document.querySelector('[data-editing]')?.getAttribute('data-editing')

async function open(parts: EpicPart[] = []) {
  render(<Framed />)
  const context = host(parts)
  await screen.findByLabelText('LaTeX source')
  return context
}

beforeEach(() => {
  disk = { ...TEXT }
  posted = []
  reads = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:7870')
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    const file = String(url.searchParams.get('file') ?? body?.file ?? 'main.tex')
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
    switch (url.pathname) {
      case '/api/paper': return json({ ok: true, paper: paperNow() })
      case '/api/source': reads.push(file); return json({ ok: true, source: disk[file], hash: hashOf(disk[file]!) })
      case '/api/build': return json({ ok: true, build: { engine: null, engines: [], how: '', running: false, last: null, pdf: null } })
      case '/api/proposals': return json({ ok: true, proposals: [], said: '' })
      case '/api/uncommitted': return json({ ok: true, standing: { at: 'nogit' }, hashes: hashes() })
      case '/api/changes': return json({ ok: true, proposals: [], said: '', standing: { at: 'nogit' }, hashes: hashes() })
      case '/api/file':
        posted.push({ file, text: String(body?.text) })
        disk[file] = String(body?.text)
        return json({ ok: true, hash: hashOf(disk[file]!), paper: paperNow(), proposals: [], said: '' })
      default: return new Response(JSON.stringify({ ok: false }), { status: 404 })
    }
  }) as typeof fetch
})
afterEach(() => {
  cleanup()
  globalThis.fetch = fetchWas
  standIn(null)
})

describe('the regions of the column', () => {
  test('with nothing picked, every file is a region, in the paper’s order, and the others are read', async () => {
    await open()
    await waitFor(() => expect(regionsShown()).toEqual(FILES))
    await waitFor(() => expect([...new Set(reads)].sort()).toEqual([...FILES].sort()))
    /* Not laid out: only the file in hand has an editor. */
    expect(mountedShown()).toEqual(['main.tex'])
    expect(document.querySelectorAll('textarea').length).toBe(1)
  })

  test('each boundary names its file, and the part that owns it', async () => {
    await open(PARTS())
    await waitFor(() => expect(regionsShown()).toEqual(FILES))
    const labels = [...document.querySelectorAll('[data-boundary]')].map((n) => n.textContent)
    expect(labels).toEqual(['main.tex', 'chapters/design.tex' + 'The design', 'chapters/method.tex' + 'The method'])
  })

  test('a pick shows only the files the pick has: one is one region, two are two', async () => {
    const context = await open(PARTS())
    await waitFor(() => expect(regionsShown()).toEqual(FILES))
    context(PARTS('the-design'))
    await waitFor(() => expect(openFile()).toBe('chapters/design.tex'))
    expect(regionsShown()).toEqual([])
    context(PARTS('the-design', 'the-method'))
    await waitFor(() => expect(regionsShown()).toEqual(['chapters/design.tex', 'chapters/method.tex']))
  })

  test('a single-file paper is the editor alone: no region, no boundary', async () => {
    FILES.splice(1)
    try {
      await open()
      expect(document.querySelector('[data-boundary]')).toBeNull()
      expect(document.querySelector('[data-region]')).toBeNull()
    } finally {
      FILES.push('chapters/design.tex', 'chapters/method.tex')
    }
  })
})

describe('navigating and saving across regions', () => {
  test('Go to a section in another file moves the editor there, and each file is saved as itself', async () => {
    await open()
    await waitFor(() => expect(regionsShown()).toEqual(FILES))
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: `${TEXT['main.tex']}MAINEDIT\n` } })
    await waitFor(() => expect(posted.map((p) => p.file)).toEqual(['main.tex']))
    const method = options('section').find((o) => o.label.trim() === 'Method')!
    press('section', method.id)
    await waitFor(() => expect(openFile()).toBe('chapters/method.tex'))
    expect(regionsShown()).toEqual(FILES)
    expect((screen.getByLabelText('LaTeX source') as HTMLTextAreaElement).value).toBe(TEXT['chapters/method.tex']!)
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: 'METHODEDIT\n' } })
    await waitFor(() => expect(posted.map((p) => p.file)).toEqual(['main.tex', 'chapters/method.tex']))
    expect(disk['main.tex']).toContain('MAINEDIT')
    expect(disk['chapters/method.tex']).toBe('METHODEDIT\n')
    expect(disk['chapters/design.tex']).toBe(TEXT['chapters/design.tex']!)
  })

  test('words typed in a region that is then unmounted are kept and saved', async () => {
    await open()
    await waitFor(() => expect(regionsShown()).toEqual(FILES))
    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: 'KEPT IN MAIN\n' } })
    const design = options('section').find((o) => o.label.trim() === 'Design')!
    press('section', design.id)
    await waitFor(() => expect(mountedShown()).toEqual(['chapters/design.tex']))
    /* main.tex has no editor now; its words are in the buffer and reach the disk. */
    await waitFor(() => expect(disk['main.tex']).toBe('KEPT IN MAIN\n'))
  })
})

describe('mounting by what is on screen', () => {
  const regions: ColumnRegion[] = FILES.map((file) => ({ file, text: 'x\n'.repeat(10), heading: null }))
  let restore: (() => void)[] = []
  function layout(clientHeight: number) {
    const define = (name: string, get: (this: HTMLElement) => number) => {
      const was = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get })
      restore.push(() => (was ? Object.defineProperty(HTMLElement.prototype, name, was) : delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]))
    }
    define('clientHeight', function () {
      return this.hasAttribute('data-source-column') ? clientHeight : 0
    })
    define('scrollHeight', function () {
      return this.hasAttribute('data-source-column') ? this.children.length * 1000 : 0
    })
    const index = (el: HTMLElement) => [...(el.parentElement?.children ?? [])].indexOf(el)
    define('offsetTop', function () {
      return this.hasAttribute('data-region') ? index(this) * 1000 : 0
    })
    define('offsetHeight', function () {
      return this.hasAttribute('data-region') ? 1000 : 0
    })
  }
  afterEach(() => {
    for (const undo of restore.reverse()) undo()
    restore = []
  })
  const wide = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ file: `f${i}.tex`, text: 'x\n', heading: null }))

  test('not laid out: only the active region has an editor', () => {
    render(<SourceColumn regions={regions} active="chapters/design.tex" locate={null} render={(f) => <i data-ed={f} />} onLabel={() => {}} onLook={() => {}} />)
    expect([...document.querySelectorAll('[data-ed]')].map((n) => n.getAttribute('data-ed'))).toEqual(['chapters/design.tex'])
  })

  test('laid out: the regions near the top are mounted, the far ones are blanks, and scrolling swaps them', async () => {
    layout(1000)
    const many = wide(10)
    let counted = 0
    render(<SourceColumn regions={many} active="f0.tex" locate={null} render={(f) => <i data-ed={f} />} onLabel={() => {}} onLook={() => {}} onCount={(n) => (counted = n)} />)
    const seen = () => [...document.querySelectorAll('[data-ed]')].map((n) => n.getAttribute('data-ed'))
    await waitFor(() => expect(seen()).toEqual(['f0.tex', 'f1.tex']))
    expect(counted).toBe(2)
    const column = document.querySelector('[data-source-column]') as HTMLElement
    column.scrollTop = 6000
    fireEvent.scroll(column)
    await waitFor(() => expect(seen()).toContain('f6.tex'))
    expect(seen()).not.toContain('f1.tex')
    expect(seen().length).toBeLessThan(10)
    /* f0 is the active region and stays. */
    expect(seen()).toContain('f0.tex')
  })

  test('a press on a boundary says which file', () => {
    let said = ''
    render(<SourceColumn regions={regions} active="main.tex" locate={null} render={() => null} onLabel={(f) => (said = f)} onLook={() => {}} />)
    fireEvent.click(document.querySelector('[data-boundary="chapters/method.tex"]')!)
    expect(said).toBe('chapters/method.tex')
  })

  test('scrolling to rest on another file, with nothing focused, says so', async () => {
    layout(1000)
    let looked = ''
    render(<SourceColumn regions={wide(4)} active="f0.tex" locate={null} render={() => null} onLabel={() => {}} onLook={(f) => (looked = f)} />)
    const column = document.querySelector('[data-source-column]') as HTMLElement
    column.scrollTop = 2100
    fireEvent.scroll(column)
    await waitFor(() => expect(looked).toBe('f2.tex'))
  })
})
