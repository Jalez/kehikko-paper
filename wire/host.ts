import {
  LIMITS,
  MESSAGE,
  PROTOCOL,
  clampHeight,
  hostMessageSchema,
  looksLikeWireMessage,
  type Goto,
  type ModuleContext,
  type ResponseFailureReason,
} from 'roadmap-module-protocol'

import { mailbox, type MessageSource } from './mailbox.ts'

/**
 * The bridge, and nothing about journeys.
 *
 * One conversation with one window, in the shape the protocol package defines.
 * It knows how to be greeted, how to ask a question and match the answer to it,
 * how to answer a `goto`, and how to say how tall it would like to be. It knows
 * nothing about steps, and the code that knows about steps knows nothing about
 * `postMessage`.
 *
 * Adapted from `kehikko-references/src/wire/host.ts`. The one change is the
 * length of the `goto` backstop, which is explained where it is set.
 *
 * ## Binding to the window, not to the origin
 *
 * This page declares storage, so a host frames it WITH `allow-same-origin` and
 * it keeps a real origin of its own. That is a recent change, and the obvious
 * conclusion to draw from it — that origins are now usable as identity here —
 * is wrong.
 *
 * It used to run opaque, where the argument was easy: an opaque frame has no
 * origin string, every message it sends arrives with an origin of `"null"`, and
 * `"null"` is shared by every sandboxed frame in every tab, so it could never
 * be an identity.
 *
 * Having a real one changes nothing, because an origin says which SERVER a
 * document came from, and any number of documents can come from one server — a
 * second frame of this same app, a tab somebody opened at this address, a page
 * that navigated itself here. None of those is the host and every one of them
 * would pass an origin check. The origin was regained so that this app's own
 * `/api` calls stop being cross-origin (see `manifest.ts`), which is a fact
 * about fetching and says nothing about who is on the other end of the frame.
 *
 * What IS an identity is the window handle. The greeting arrives from exactly
 * one `MessageEvent.source`, and nothing in this page or any other page can
 * forge that handle — so the rule is the one the protocol's own note states:
 * bind to the window that greeted us, and after the greeting ignore anything
 * that did not come from it. Not because a stray message would be dangerous by
 * itself, but because a second sender answering our correlation ids is a page
 * that quietly shows another roadmap's work under this one's name.
 *
 * We reply with `targetOrigin: '*'`, and that is not laziness. There is nothing
 * secret in anything this page sends — the name of an epic somebody is already
 * reading — and a targeted origin here would have to be a guess: the host's
 * origin comes from `ev.origin`, which is `"null"` exactly when the host itself
 * is sandboxed. A guess that fails silently drops every message. Where
 * `ev.origin` is a real origin we use it, because then it is a fact rather than
 * a guess.
 *
 * ## Parse what the host sends, too
 *
 * A framed page receives every message posted at its window: the host's, a dev
 * server's hot-reload socket, an extension's. `looksLikeWireMessage` is the
 * cheap filter and `hostMessageSchema` is the real one. A module that trusted
 * `data.type` alone would be one that Vite's own socket can put into an
 * unexplained state on a Tuesday — and this page is served by Vite, so that
 * socket is not hypothetical.
 */

/**
 * Why a question came back without an answer.
 *
 * The protocol's three, plus one of our own. `silent` is the timeout, and it is
 * a separate word rather than folded into `failed` because the two send a
 * person to different places: `failed` is the host telling us it went wrong,
 * and `silent` is the host not being there — which, from inside a frame, is
 * indistinguishable from a host that is still starting up.
 */
export type Refusal = { reason: ResponseFailureReason | 'silent'; error: string }

export class HostRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.error)
    this.name = 'HostRefused'
  }
}

/**
 * How long to wait for one answer.
 *
 * A number rather than forever, because forever is a page that shows "asking…"
 * until somebody reloads it, which is the exact shape of dishonesty this app is
 * against — a spinner is a claim that an answer is coming. Twelve seconds is
 * long enough for a host reading a file off a cold disk and short enough that
 * nobody sits through it twice.
 */
const ANSWER_WITHIN_MS = 12_000

export interface HostEvents {
  /** The greeting arrived, carrying the context that came with it. */
  onHello?: (context: ModuleContext) => void
  /** The reader switched epics, or this tab was shown again. */
  onContext?: (context: ModuleContext) => void
  /**
   * "Go to this reference." The answer is not optional and not deferrable: the
   * host is waiting on it, and the protocol is explicit that a module which
   * never answers must not be able to hang a reference. So `answer` is handed
   * in rather than returned, and `connect` guarantees it is called — see below.
   */
  onGoto?: (goto: Goto, answer: (found: boolean, why?: string) => void) => void
}

export interface Host {
  /** Ask one question. Rejects with `HostRefused` — never with a bare string. */
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** Say how tall we would like to be. Fire and forget, by design. */
  resize: (height: number) => void
  /** Whether anything has greeted us yet. */
  greeted: () => boolean
  /** Stop listening. Every question still waiting is refused rather than left hanging. */
  stop: () => void
}

/**
 * Start listening, and hand back the four things the page needs.
 *
 * Nothing is sent from here until a greeting arrives, and nothing needs to be:
 * the host greets on every frame load, and a module that announced itself first
 * would be shouting at a window that may not be a host at all.
 *
 * The default source is the `mailbox` rather than `window`, so that a greeting
 * which arrived before this was called is replayed rather than lost. The source
 * stays injectable, because everything this function decides is tested without
 * a browser and that has to keep being true.
 */
export function connect(id: string, events: HostEvents = {}, source: MessageSource = mailbox): Host {
  let host: Window | null = null
  let origin = '*'
  let live = true

  /** Correlation id -> the promise waiting on it. A `Map`, per the protocol's note on lookups. */
  const waiting = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: HostRefused) => void; timer: ReturnType<typeof setTimeout> }
  >()

  let counter = 0
  const nextId = () => `${Date.now().toString(36)}-${(counter += 1).toString(36)}`

  const send = (message: unknown) => {
    if (!host) return
    host.postMessage(message, origin)
  }

  const settle = (correlation: string, outcome: { ok: true; data: unknown } | { ok: false; refusal: Refusal }) => {
    const pending = waiting.get(correlation)
    if (!pending) return
    waiting.delete(correlation)
    clearTimeout(pending.timer)
    if (outcome.ok) pending.resolve(outcome.data)
    else pending.reject(new HostRefused(outcome.refusal))
  }

  const onMessage = (ev: MessageEvent) => {
    if (!live) return
    if (!looksLikeWireMessage(ev.data)) return
    const parsed = hostMessageSchema.safeParse(ev.data)
    if (!parsed.success) return
    const message = parsed.data

    if (message.type === MESSAGE.HELLO) {
      /* Re-greeting is normal rather than an error: the host greets on every
         frame load, and a frame that reloaded itself has forgotten everything.
         So the newest greeting wins, and the window it came from becomes the
         one we answer. */
      host = (ev.source as Window | null) ?? source.parent ?? null
      origin = ev.origin && ev.origin !== 'null' ? ev.origin : '*'
      send({ type: MESSAGE.READY, id, protocol: message.protocol ?? PROTOCOL })
      events.onHello?.(message.context)
      return
    }

    /* Everything after the greeting has to come from the window that gave it.
       See the essay at the top: the origin cannot do this job and this can. */
    if (ev.source !== host) return

    if (message.type === MESSAGE.CONTEXT) {
      /* Rebuilt field by field rather than handed on whole, because a context
         message is flat on the wire — `epic` sits beside `type` — while what
         the page wants is the same `ModuleContext` object the greeting carries.
         The listing has to be complete, and completeness here is not obvious to
         look at: a field left out does not fail, it quietly becomes the page's
         idea that the host said nothing about it. That is exactly what happened
         to `selection`, which arrived on the wire and was dropped one line
         before anybody could act on it. The type says so now; it could not
         before the protocol made the field required. */
      events.onContext?.({
        epic: message.epic,
        project: message.project,
        /* Added by protocol 0.8, and copied for the same reason as the three
           below: this pane does not act on which FOLDER the canvas is standing
           in — that is a later phase across every module — but a field dropped
           here is a field the page believes the host never mentioned, and the
           symptom of that is silence rather than an error. */
        projectPath: message.projectPath,
        theme: message.theme,
        selection: message.selection,
        /* Added by protocol 0.6 and copied here for one reason: this app
           declares `prompt: false` and reads neither field, but copying a field
           it will not read costs a line, while dropping one it later WILL read
           costs an afternoon — the symptom being a page that quietly behaves as
           though the host had never mentioned it. */
        prompt: message.prompt,
        pinned: message.pinned,
        /* Added by protocol 0.7. Same argument as the two above, and the same
           cost asymmetry: this app cannot tell which canvas it is standing on
           and does not currently need to, but a field dropped here is a field
           the page believes the host never mentioned. */
        kehikko: message.kehikko,
      })
      return
    }

    if (message.type === MESSAGE.RESPONSE) {
      if (message.ok) settle(message.id, { ok: true, data: message.data })
      else settle(message.id, { ok: false, refusal: { reason: message.reason, error: message.error } })
      return
    }

    if (message.type === MESSAGE.GOTO) {
      /* Answered exactly once, whatever the listener does — including nothing,
         including throwing. The host is waiting on this and will time out into
         "not found"; a module that leaves it to the timeout has turned a
         hundred milliseconds into a reader watching a pane do nothing. */
      let answered = false
      const answer = (found: boolean, why = '') => {
        if (answered) return
        answered = true
        clearTimeout(backstop)
        send({ type: MESSAGE.WENT, id: message.id, found, why: why.slice(0, LIMITS.REASON) })
      }
      /*
       * The backstop, and why 900ms.
       *
       * The protocol is explicit that a module must answer when it KNOWS, not
       * when it is asked: told to walk to a reference in an epic it does not
       * have loaded, the honest thing is to load the epic, look, and then say.
       * So this cannot fire the moment the listener returns.
       *
       * It also cannot be generous. The host gives a walk 1200ms
       * (`WENT_TIMEOUT_MS` in its `conversation.ts`) and then treats silence as
       * "not found", falling back to an ordinary link — which is the right
       * behaviour and a worse experience than being told so. 900ms leaves this
       * page room for a loopback fetch of its own store, which takes single
       * milliseconds, while still beating the host's clock with a sentence a
       * person can read.
       */
      const backstop = setTimeout(
        () => answer(false, 'This app did not manage to say where that reference is.'),
        900,
      )
      try {
        if (events.onGoto) events.onGoto(message, answer)
        else answer(false, 'This app is not showing anything that can be walked to.')
      } catch {
        answer(false, 'This app failed while looking for that reference.')
      }
      return
    }
  }

  source.addEventListener('message', onMessage)

  return {
    request(method, params = {}) {
      if (!host) {
        return Promise.reject(
          new HostRefused({ reason: 'silent', error: 'Nothing has greeted this page, so there is nobody to ask.' }),
        )
      }
      const correlation = nextId()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(correlation, {
            ok: false,
            refusal: {
              reason: 'silent',
              error: `The host was asked ${method} and had not answered ${Math.round(ANSWER_WITHIN_MS / 1000)} seconds later.`,
            },
          })
        }, ANSWER_WITHIN_MS)
        waiting.set(correlation, { resolve, reject, timer })
        send({ type: MESSAGE.REQUEST, id: correlation, method, params })
      })
    },

    resize(height) {
      /* Clamped on our own side with the host's own arithmetic, so that what we
         ask for is what we will get. The host runs its own copy over the raw
         number regardless — this is prediction, not enforcement. */
      send({ type: MESSAGE.RESIZE, height: clampHeight(height) })
    },

    greeted: () => host !== null,

    stop() {
      live = false
      source.removeEventListener('message', onMessage)
      for (const correlation of [...waiting.keys()]) {
        settle(correlation, { ok: false, refusal: { reason: 'silent', error: 'This page stopped listening.' } })
      }
    },
  }
}
