import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

import { standIn } from '../src/api.ts'
import { useChanges } from '../src/use-changes.ts'
import { hiddenBy } from '../src/use-paper.ts'
import { useShown } from '../src/use-shown.ts'

/**
 * 2.8.0: the page asks its server about a paper only while it is shown, in one request, when the
 * server says something moved. 2.9.0: never on a clock — no poll while the stream is down, no
 * once-a-minute ask while it is up; the stream reopening says what moved meanwhile.
 */

/** A stand-in for the browser's EventSource: the test says what the server sends. */
class Stream {
  static made: Stream[] = []
  readonly url: string
  closed = false
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  readonly #on = new Map<string, ((event: MessageEvent) => void)[]>()
  constructor(url: string) {
    this.url = url
    Stream.made.push(this)
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.#on.set(name, [...(this.#on.get(name) ?? []), listener])
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  send(name: string, data: unknown) {
    for (const listener of this.#on.get(name) ?? []) listener(new MessageEvent(name, { data: JSON.stringify(data) }))
  }
}

let asked: URL[] = []
let tag = 't1'
let timeouts: number[] = []
const realFetch = globalThis.fetch
const realTimeout = globalThis.setTimeout

beforeEach(() => {
  asked = []
  tag = 't1'
  timeouts = []
  Stream.made = []
  standIn('/work/project')
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://127.0.0.1:7870')
    asked.push(url)
    const since = url.searchParams.get('since')
    const body = since === tag ? { ok: true, same: true, tag } : { ok: true, proposals: [], standing: { at: 'nogit' }, hashes: {}, tag }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  /* Every wait the hook schedules, read off; none of them is waited for here. */
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    timeouts.push(ms ?? 0)
    return realTimeout(() => {}, 0)
  }) as typeof setTimeout
})
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  globalThis.setTimeout = realTimeout
  ;(globalThis as { EventSource?: unknown }).EventSource = undefined
  ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1024, height: 768 })
  standIn(null)
})

const settle = () => act(async () => void (await new Promise((done) => realTimeout(done, 30))))
const changesAsked = () => asked.filter((url) => url.pathname === '/api/changes')

describe('what the host says hides the page', () => {
  test('its container folded, or the canvas on All epics', () => {
    expect(hiddenBy({ containers: [{ module: 'kehikot.paper', folded: true }] })).toBe(true)
    expect(hiddenBy({ containers: [{ module: 'kehikot.paper', folded: false }, { module: 'kehikot.notes', folded: true }] })).toBe(false)
    expect(hiddenBy({ scope: 'project' })).toBe(true)
    expect(hiddenBy({ scope: 'epic', containers: [] })).toBe(false)
    /* A host that does not say is not folding anything. */
    expect(hiddenBy({})).toBe(false)
  })
})

describe('useShown', () => {
  test('a page drawn at no size is not shown, and is again when it has one', async () => {
    const happy = (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM
    const { result } = renderHook(() => useShown(false))
    expect(result.current).toBe(true)
    await act(async () => {
      happy.setViewport({ width: 0, height: 0 })
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toBe(false)
    await act(async () => {
      happy.setViewport({ width: 800, height: 600 })
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toBe(true)
  })

  test('what the host hides is hidden, whatever the size', () => {
    expect(renderHook(() => useShown(true)).result.current).toBe(false)
  })
})

describe('useChanges', () => {
  test('not shown: nothing is asked and nothing is listened to', async () => {
    ;(globalThis as { EventSource?: unknown }).EventSource = Stream
    renderHook(() => useChanges('a-paper', false, 0, () => {}))
    await settle()
    expect(changesAsked()).toEqual([])
    expect(Stream.made).toEqual([])
  })

  test('shown: one ask and one stream, and nothing scheduled on a clock', async () => {
    ;(globalThis as { EventSource?: unknown }).EventSource = Stream
    const heard: unknown[] = []
    const intervals: unknown[] = []
    const realInterval = globalThis.setInterval
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => (intervals.push(args[1]), realInterval(...args))) as typeof setInterval
    try {
      renderHook(() => useChanges('a-paper', true, 0, (body) => heard.push(body)))
    } finally {
      globalThis.setInterval = realInterval
    }
    /* Counted before anything of the test's own waits. */
    expect(intervals).toEqual([])
    expect(timeouts).toEqual([])
    await settle()
    expect(changesAsked().length).toBe(1)
    expect(heard.length).toBe(1)
    expect(Stream.made.length).toBe(1)
    expect(new URL(Stream.made[0]!.url, 'http://x').searchParams.get('project')).toBe('/work/project')
    await act(async () => Stream.made[0]!.send('ready', { tag: 't1' }))
    await settle()
    /* Ready with the tag already held: nothing more to ask, and nothing waiting to ask later. */
    expect(changesAsked().length).toBe(1)
    expect(timeouts).toEqual([])
  })

  test('an hour of a quiet stream is still one ask', async () => {
    ;(globalThis as { EventSource?: unknown }).EventSource = Stream
    renderHook(() => useChanges('a-paper', true, 0, () => {}))
    await settle()
    await act(async () => Stream.made[0]!.send('ready', { tag: 't1' }))
    await settle()
    /* Every wait anything scheduled, run now, as if an hour went by. */
    expect(timeouts).toEqual([])
    expect(changesAsked().length).toBe(1)
    expect(asked.filter((url) => url.pathname !== '/api/changes')).toEqual([])
  })

  test('changed with a new tag asks once; with the tag held, not at all', async () => {
    ;(globalThis as { EventSource?: unknown }).EventSource = Stream
    const heard: Record<string, unknown>[] = []
    renderHook(() => useChanges('a-paper', true, 0, (body) => heard.push(body)))
    await settle()
    await act(async () => Stream.made[0]!.send('ready', { tag: 't1' }))
    await act(async () => Stream.made[0]!.send('changed', { tag: 't1' }))
    await settle()
    expect(changesAsked().length).toBe(1)
    tag = 't2'
    await act(async () => Stream.made[0]!.send('changed', { tag: 't2' }))
    await settle()
    expect(changesAsked().length).toBe(2)
    expect(changesAsked()[1]!.searchParams.get('since')).toBe('t1')
    expect(heard.at(-1)!.tag).toBe('t2')
  })

  test('hidden again: the stream is closed; shown again: asked once, naming what it holds', async () => {
    ;(globalThis as { EventSource?: unknown }).EventSource = Stream
    const { rerender } = renderHook(({ shown }) => useChanges('a-paper', shown, 0, () => {}), { initialProps: { shown: true } })
    await settle()
    rerender({ shown: false })
    await settle()
    expect(Stream.made[0]!.closed).toBe(true)
    expect(changesAsked().length).toBe(1)
    rerender({ shown: true })
    await settle()
    expect(changesAsked().length).toBe(2)
    expect(changesAsked()[1]!.searchParams.get('since')).toBe('t1')
    expect(Stream.made.length).toBe(2)
  })

  test('a stream that drops does not start a poll: it is reopened, and its ready asks only if the tag moved', async () => {
    ;(globalThis as { EventSource?: unknown }).EventSource = Stream
    renderHook(() => useChanges('a-paper', true, 0, () => {}))
    await settle()
    await act(async () => Stream.made[0]!.send('ready', { tag: 't1' }))
    /* The server went away: the browser gave up on this one. */
    Stream.made[0]!.readyState = 2
    await act(async () => Stream.made[0]!.onerror?.())
    await settle()
    /* One reconnect, waiting a moment; no ask of /api/changes on a clock. */
    expect(timeouts.length).toBe(1)
    expect(changesAsked().length).toBe(1)
    /* What a reopened stream would say, with a change made meanwhile. */
    tag = 't2'
    await act(async () => Stream.made[0]!.send('ready', { tag: 't2' }))
    await settle()
    expect(changesAsked().length).toBe(2)
  })

  test('a tab put behind closes the stream; brought back, it opens again and its ready catches up', async () => {
    ;(globalThis as { EventSource?: unknown }).EventSource = Stream
    let state: DocumentVisibilityState = 'visible'
    const was = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState') ?? Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    try {
      renderHook(() => useChanges('a-paper', true, 0, () => {}))
      await settle()
      state = 'hidden'
      await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
      expect(Stream.made[0]!.closed).toBe(true)
      tag = 't2'
      state = 'visible'
      await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
      expect(Stream.made.length).toBe(2)
      await act(async () => Stream.made[1]!.send('ready', { tag: 't2' }))
      await settle()
      expect(changesAsked().length).toBe(2)
    } finally {
      if (was) Object.defineProperty(document, 'visibilityState', was)
      else delete (document as { visibilityState?: unknown }).visibilityState
    }
  })

  test('a nudge asks at once', async () => {
    const { rerender } = renderHook(({ nudge }) => useChanges('a-paper', true, nudge, () => {}), { initialProps: { nudge: 0 } })
    await settle()
    rerender({ nudge: 1 })
    await settle()
    expect(changesAsked().length).toBe(2)
  })
})
