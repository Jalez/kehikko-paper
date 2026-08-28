import { describe, expect, test } from 'bun:test'
import { MESSAGE, PROTOCOL } from 'roadmap-module-protocol'

import { HostRefused, connect } from '../wire/host.ts'
import type { MessageSource } from '../wire/mailbox.ts'

/**
 * The wire, tested without a browser — which is why `connect` takes a
 * `MessageSource` rather than reaching for `window`.
 *
 * These are the decisions that are invisible until they go wrong inside a
 * frame: whether a greeting is answered at all, whether a second window can
 * answer our correlation ids, and whether a `goto` is always acknowledged. Each
 * of them looks like silence from outside, and silence is the one symptom that
 * says nothing about its own cause.
 */

/** A window we can watch. `postMessage` is the only thing the wire uses. */
function fakeWindow() {
  const sent: unknown[] = []
  return {
    sent,
    postMessage(message: unknown) {
      sent.push(message)
    },
  }
}

/** A source we can post into, with a backlog like the real mailbox's. */
function fakeSource() {
  const listeners = new Set<(ev: MessageEvent) => void>()
  const backlog: MessageEvent[] = []
  const source: MessageSource = {
    parent: null,
    addEventListener(_type, fn) {
      for (const ev of backlog) fn(ev)
      listeners.add(fn)
    },
    removeEventListener(_type, fn) {
      listeners.delete(fn)
    },
  }
  const deliver = (data: unknown, from: unknown, origin = 'null') => {
    const ev = { data, source: from, origin } as unknown as MessageEvent
    backlog.push(ev)
    for (const fn of [...listeners]) fn(ev)
  }
  return { source, deliver }
}

const hello = (context: Record<string, unknown> = {}) => ({
  type: MESSAGE.HELLO,
  protocol: PROTOCOL,
  session: 'a-session',
  context: { epic: null, project: null, theme: 'light', ...context },
})

const context = (fields: Record<string, unknown>) => ({
  type: MESSAGE.CONTEXT,
  protocol: PROTOCOL,
  epic: null,
  project: null,
  theme: 'light',
  ...fields,
})

describe('being greeted', () => {
  test('answers the greeting with its own id and the protocol it heard', () => {
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    connect('roadmap.paper', {}, source)
    deliver(hello(), host)
    expect(host.sent[0]).toMatchObject({ type: MESSAGE.READY, id: 'roadmap.paper', protocol: PROTOCOL })
  })

  test('the epic comes with the greeting, not a message later', () => {
    /* This is the whole of what this module needs from a host, and it arrives
       on the greeting — so a page that only listened for `roadmap.context`
       would show nothing until the reader happened to switch epics. */
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    let heard: string | null | undefined
    connect('roadmap.paper', { onHello: (c) => (heard = c.epic) }, source)
    deliver(hello({ epic: 'modes-are-modules' }), host)
    expect(heard).toBe('modes-are-modules')
  })

  /**
   * The bug the mailbox exists for, from the other end: a greeting that arrived
   * before anybody subscribed is replayed on subscription. Without this the
   * host sees a module that loaded and never spoke, and the module's own screen
   * says nothing ever greeted it. The host greets on the frame's `load` event,
   * which is strictly before an application is necessarily ready.
   */
  test('a greeting that arrived before we listened is still answered', () => {
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    deliver(hello(), host)
    connect('roadmap.paper', {}, source)
    expect(host.sent).toHaveLength(1)
  })
})

describe('what a context carries', () => {
  test('epic null is delivered as null and not dropped', () => {
    /* An epic that is `null` is an ordinary state with its own screen. A page
       that received `undefined` here would take it for "the host said nothing"
       and keep showing the previous epic's paper. */
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    const seen: (string | null)[] = []
    connect('roadmap.paper', { onContext: (c) => seen.push(c.epic) }, source)
    deliver(hello({ epic: 'a' }), host)
    deliver(context({ epic: null }), host)
    expect(seen).toEqual([null])
  })

  test('the fields protocol 0.6 added survive the rebuild', () => {
    /* A context is flat on the wire and is rebuilt field by field into the
       object the page reads. A field left out does not fail — it quietly
       becomes the page's idea that the host never mentioned it, which is how
       `selection` was lost for a while. */
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    let got: Record<string, unknown> | null = null
    connect('roadmap.paper', { onContext: (c) => (got = c as unknown as Record<string, unknown>) }, source)
    deliver(hello(), host)
    deliver(context({ epic: 'x', theme: 'dark', selection: ['gh#1'], prompt: 'read closely', pinned: true }), host)
    expect(got).toMatchObject({ epic: 'x', theme: 'dark', selection: ['gh#1'], prompt: 'read closely', pinned: true })
  })

  /**
   * The identity is the window handle, not the origin. A second sender
   * answering our correlation ids is a page quietly showing another roadmap's
   * work under this one's name.
   */
  test('a context from a window that never greeted us is ignored', () => {
    const host = fakeWindow()
    const stranger = fakeWindow()
    const { source, deliver } = fakeSource()
    let heard = 0
    connect('roadmap.paper', { onContext: () => (heard += 1) }, source)
    deliver(hello(), host)
    deliver(context({ epic: 'x' }), stranger)
    expect(heard).toBe(0)
    deliver(context({ epic: 'x' }), host)
    expect(heard).toBe(1)
  })

  /**
   * Vite's own hot-reload socket posts at this window too, and this page is
   * served by Vite, so that is not hypothetical.
   */
  test('something that is not a wire message is dropped without a word', () => {
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    connect('roadmap.paper', {}, source)
    deliver({ type: 'vite:beforeUpdate' }, host)
    expect(host.sent).toHaveLength(0)
  })
})

describe('asking a question', () => {
  test('sends the method and settles on the answer that carries its id', async () => {
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    const wire = connect('roadmap.paper', {}, source)
    deliver(hello(), host)

    const asked = wire.request('epics.list')
    const sent = host.sent[1] as { id: string; method: string }
    expect(sent.method).toBe('epics.list')

    deliver({ type: MESSAGE.RESPONSE, id: sent.id, ok: true, data: [{ epic: 'a', title: 'A' }] }, host)
    expect(await asked).toEqual([{ epic: 'a', title: 'A' }])
  })

  test('a refusal rejects with the host’s own reason rather than a bare string', async () => {
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    const wire = connect('roadmap.paper', {}, source)
    deliver(hello(), host)
    const asked = wire.request('epics.list')
    const sent = host.sent[1] as { id: string }
    deliver({ type: MESSAGE.RESPONSE, id: sent.id, ok: false, reason: 'unknown-method', error: 'no such method here' }, host)
    await expect(asked).rejects.toBeInstanceOf(HostRefused)
  })

  /** With nobody greeting us there is nobody to ask, and saying so beats a timeout. */
  test('asking before a greeting is refused immediately', async () => {
    const { source } = fakeSource()
    const wire = connect('roadmap.paper', {}, source)
    await expect(wire.request('epics.list')).rejects.toBeInstanceOf(HostRefused)
  })
})

describe('being walked to a reference', () => {
  /**
   * `roadmap.went` is the only place a host waits on a module. It times out
   * into `found: false`, so a module that never answers cannot hang a reference
   * — but it also cannot say why, and the reader gets a wait instead of a
   * sentence. So the answer is guaranteed here, whatever the listener does.
   */
  test('a walk is answered even when nothing is listening for it', () => {
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    connect('roadmap.paper', {}, source)
    deliver(hello(), host)
    deliver({ type: MESSAGE.GOTO, id: 'g1', ref: 'gh#41' }, host)
    expect(host.sent[1]).toMatchObject({ type: MESSAGE.WENT, id: 'g1', found: false })
  })

  test('a walk is answered even when the listener throws', () => {
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    connect(
      'roadmap.paper',
      {
        onGoto: () => {
          throw new Error('the page fell over')
        },
      },
      source,
    )
    deliver(hello(), host)
    deliver({ type: MESSAGE.GOTO, id: 'g2', ref: 'gh#41' }, host)
    expect(host.sent[1]).toMatchObject({ type: MESSAGE.WENT, id: 'g2', found: false })
  })

  test('a walk is answered once, however many times the listener calls back', () => {
    const host = fakeWindow()
    const { source, deliver } = fakeSource()
    connect(
      'roadmap.paper',
      {
        onGoto: (_goto, answer) => {
          answer(true)
          answer(false, 'changed my mind')
        },
      },
      source,
    )
    deliver(hello(), host)
    deliver({ type: MESSAGE.GOTO, id: 'g3', ref: 'gh#41' }, host)
    expect(host.sent.filter((m) => (m as { type: string }).type === MESSAGE.WENT)).toHaveLength(1)
  })
})
