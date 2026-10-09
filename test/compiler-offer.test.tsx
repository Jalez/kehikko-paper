import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { BuildStatus } from '../compile/build.ts'
import type { ToolchainStatus } from '../compile/install.ts'
import { CompilerOffer } from '../src/compiler-offer.tsx'

/**
 * What the PDF pane says about getting a compiler, in each state, against an
 * installer that is not one.
 *
 * The server here is a fake `fetch` holding a `ToolchainStatus` this file
 * moves along by hand — offered, downloading, failed, done — so every state
 * the page can be in is one line to stage, and every request it makes is on
 * record. The point of the record is the first test: opening the page asks
 * what COULD be fetched and fetches nothing.
 */

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
  ticket: string | null
}

let calls: Call[]
let state: ToolchainStatus
let onInstall: (pieces: string[]) => void
const fetchWas = globalThis.fetch

const PIECES: ToolchainStatus['pieces'] = [
  { id: 'tectonic', version: '0.17.0', bytes: 21_704_674, host: 'github.com', url: 'https://github.com/t.tar.gz', installed: false },
  { id: 'biber', version: '2.17', bytes: 89_382_426, host: 'downloads.sourceforge.net', url: 'https://downloads.sourceforge.net/b.tar.gz', installed: false },
]

const fresh = (more: Partial<ToolchainStatus> = {}): ToolchainStatus => ({
  supported: true,
  dir: '/var/tmp/kehikot-paper-tools',
  pieces: PIECES.map((one) => ({ ...one })),
  running: false,
  wanted: [],
  received: 0,
  total: 0,
  error: null,
  ...more,
})

const noEngine: BuildStatus = { engine: null, engines: [], how: 'No LaTeX engine is installed on this machine. brew install tectonic', running: false, last: null, pdf: null }
const mismatched: BuildStatus = {
  engine: 'tectonic',
  engines: ['tectonic'],
  how: '',
  running: false,
  pdf: null,
  last: { ok: false, at: 1, ms: 900, engine: 'tectonic', timedOut: false, problems: [], tail: '', biber: { have: '2.21', biblatex: '3.17', need: '2.17', fetchable: true } },
}

beforeEach(() => {
  calls = []
  state = fresh()
  onInstall = (pieces) => {
    const wanted = state.pieces.filter((one) => pieces.includes(one.id) && !one.installed)
    state = { ...state, running: true, error: null, wanted: wanted.map((one) => one.id), received: 0, total: wanted.reduce((sum, one) => sum + one.bytes, 0) }
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:7870')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ method, path: url.pathname, body, ticket: new Headers(init?.headers).get('x-module-ticket') })
    if (url.pathname === '/api/toolchain/install') onInstall((body?.pieces as string[]) ?? [])
    if (url.pathname === '/api/toolchain/cancel') state = { ...state, running: false }
    return new Response(JSON.stringify({ ok: true, toolchain: state }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = fetchWas
})

/** Let the page's polling run for a moment, inside React's own bookkeeping. */
const idle = (ms: number) => act(async () => void (await new Promise((done) => setTimeout(done, ms))))
const posts = () => calls.filter((one) => one.method === 'POST')
const offer = () => document.querySelector('[data-compiler-offer]')

describe('no compiler on this machine', () => {
  test('the pane says what a compiler is and what the button would fetch — and opening it fetches nothing', async () => {
    render(<CompilerOffer build={noEngine} onInstalled={() => {}} pollMs={5} />)
    const button = await screen.findByRole('button', { name: 'Install the compiler (about 111 MB)' })
    expect(offer()?.getAttribute('data-compiler-offer')).toBe('offer')
    const said = offer()!.textContent!
    expect(said).toContain('a compiler is the program that turns that text into the PDF')
    expect(said).toContain('Tectonic 0.17.0 (22 MB, from github.com)')
    expect(said).toContain('biber 2.17 (89 MB, from downloads.sourceforge.net)')
    expect(said).toContain('/var/tmp/kehikot-paper-tools')
    expect(said).toContain('nothing is downloaded until the button is pressed')
    expect(said).not.toContain('brew install')
    expect(button).toBeTruthy()
    await idle(30)
    expect(posts()).toEqual([])
    expect(calls.every((one) => one.method === 'GET' && one.path === '/api/toolchain')).toBe(true)
  })

  test('the press starts it, with the page’s ticket; while it runs there is progress and Cancel, and no second button', async () => {
    render(<CompilerOffer build={noEngine} onInstalled={() => {}} pollMs={5} />)
    fireEvent.click(await screen.findByRole('button', { name: /Install the compiler/ }))
    await waitFor(() => expect(offer()?.getAttribute('data-compiler-offer')).toBe('installing'))
    expect(posts()).toHaveLength(1)
    expect(posts()[0]!.path).toBe('/api/toolchain/install')
    expect(posts()[0]!.body!.pieces).toEqual(['tectonic', 'biber'])
    /* In the header every module uses, and not in the body. */
    expect(posts()[0]!.ticket).not.toBeNull()
    expect('ticket' in posts()[0]!.body!).toBe(false)
    expect(screen.queryByRole('button', { name: /Install the compiler/ })).toBeNull()

    state = { ...state, received: 34_000_000 }
    await waitFor(() => expect(offer()!.textContent).toContain('34 of 111 MB'))
    const bar = screen.getByLabelText('Download progress') as HTMLProgressElement
    expect(bar.getAttribute('value')).toBe('34000000')
    expect(bar.getAttribute('max')).toBe('111087100')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(offer()?.getAttribute('data-compiler-offer')).toBe('offer'))
    expect(posts().map((one) => one.path)).toEqual(['/api/toolchain/install', '/api/toolchain/cancel'])
    expect(document.querySelector('[data-install-error]')).toBeNull()
  })

  test('a failure is the reason and Retry, and Retry asks again', async () => {
    render(<CompilerOffer build={noEngine} onInstalled={() => {}} pollMs={5} />)
    fireEvent.click(await screen.findByRole('button', { name: /Install the compiler/ }))
    await waitFor(() => expect(offer()?.getAttribute('data-compiler-offer')).toBe('installing'))
    state = { ...state, running: false, error: 'github.com could not be reached, so nothing was downloaded. Check that this machine is online and try again.' }
    await waitFor(() => expect(offer()?.getAttribute('data-compiler-offer')).toBe('failed'))
    expect(document.querySelector('[data-install-error]')!.textContent).toContain('github.com could not be reached')
    fireEvent.click(screen.getByRole('button', { name: 'Retry: install the compiler (about 111 MB)' }))
    await waitFor(() => expect(offer()?.getAttribute('data-compiler-offer')).toBe('installing'))
    expect(posts().filter((one) => one.path === '/api/toolchain/install')).toHaveLength(2)
  })

  test('the page is told once when an install ends, and whether everything is in place', async () => {
    const told: string[] = []
    render(<CompilerOffer build={noEngine} onInstalled={(what, complete) => told.push(`${what}:${complete}`)} pollMs={5} />)
    fireEvent.click(await screen.findByRole('button', { name: /Install the compiler/ }))
    await waitFor(() => expect(offer()?.getAttribute('data-compiler-offer')).toBe('installing'))
    state = { ...state, running: false, error: 'it broke' }
    await waitFor(() => expect(offer()?.getAttribute('data-compiler-offer')).toBe('failed'))
    expect(told).toEqual(['compiler:false'])

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(offer()?.getAttribute('data-compiler-offer')).toBe('installing'))
    state = { ...state, running: false, received: state.total, pieces: state.pieces.map((one) => ({ ...one, installed: true })) }
    await waitFor(() => expect(told).toEqual(['compiler:false', 'compiler:true']))
    await idle(30)
    expect(told).toEqual(['compiler:false', 'compiler:true'])
  })

  test('only what is missing is offered: with Tectonic already fetched, the button is the biber alone', async () => {
    state = fresh()
    state.pieces[0]!.installed = true
    render(<CompilerOffer build={noEngine} onInstalled={() => {}} pollMs={5} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install the compiler (about 89 MB)' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]!.body!.pieces).toEqual(['biber'])
  })

  test('where there is nothing to fetch for this machine, it says what it always said', async () => {
    state = fresh({ supported: false, pieces: [] })
    render(<CompilerOffer build={noEngine} onInstalled={() => {}} pollMs={5} />)
    await waitFor(() => expect(document.querySelector('[data-no-engine]')).not.toBeNull())
    expect(document.querySelector('[data-no-engine]')!.textContent).toContain('brew install tectonic')
    expect(offer()).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('a paper that names an engine the machine lacks is told that, and offered nothing', async () => {
    const named: BuildStatus = { ...noEngine, engines: ['tectonic'], how: 'main.tex asks for xelatex in its “% !TEX program” line, and xelatex is not installed on this machine (installed: tectonic).' }
    render(<CompilerOffer build={named} onInstalled={() => {}} pollMs={5} />)
    expect(document.querySelector('[data-no-engine]')!.textContent).toContain('asks for xelatex')
    await idle(20)
    expect(offer()).toBeNull()
  })
})

describe('the machine’s biber is the wrong release', () => {
  test('the one piece is offered in place of advice, and a compile follows it', async () => {
    const told: string[] = []
    render(<CompilerOffer build={mismatched} onInstalled={(what, complete) => told.push(`${what}:${complete}`)} pollMs={5} />)
    const button = await screen.findByRole('button', { name: 'Install biber 2.17 (about 89 MB)' })
    expect(offer()!.getAttribute('data-offer-for')).toBe('biber')
    const said = offer()!.textContent!
    expect(said).toContain('Nothing is wrong in the paper')
    expect(said).toContain('biblatex is 3.17, which only works with biber 2.17, and this machine has biber 2.21')
    expect(said).toContain('biber 2.17 (89 MB, from downloads.sourceforge.net)')
    expect(said).not.toContain('Tectonic 0.17.0')
    expect(posts()).toEqual([])

    fireEvent.click(button)
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]!.body!.pieces).toEqual(['biber'])
    state = { ...state, running: false, pieces: state.pieces.map((one) => (one.id === 'biber' ? { ...one, installed: true } : one)) }
    await waitFor(() => expect(told).toEqual(['biber:true']))
    /* Fetched: there is nothing left to offer. */
    await waitFor(() => expect(offer()).toBeNull())
  })

  test('no biber at all is the same offer, said as what it is', async () => {
    const absent: BuildStatus = { ...mismatched, last: { ...mismatched.last!, biber: { have: null, biblatex: '3.17', need: '2.17', fetchable: true } } }
    render(<CompilerOffer build={absent} onInstalled={() => {}} pollMs={5} />)
    await screen.findByRole('button', { name: 'Install biber 2.17 (about 89 MB)' })
    expect(offer()!.textContent).toContain('The bibliography needs biber')
    expect(offer()!.textContent).toContain('this machine has no biber')
  })

  test('a mismatch this module has no biber for is not an offer; nor is a compile that worked', async () => {
    const other: BuildStatus = { ...mismatched, last: { ...mismatched.last!, biber: { have: '2.17', biblatex: '3.20', need: '2.20', fetchable: false } } }
    render(<CompilerOffer build={other} onInstalled={() => {}} pollMs={5} />)
    await idle(20)
    expect(offer()).toBeNull()
    cleanup()
    render(<CompilerOffer build={{ ...mismatched, last: { ...mismatched.last!, ok: true, biber: null } }} onInstalled={() => {}} pollMs={5} />)
    await idle(20)
    expect(offer()).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
