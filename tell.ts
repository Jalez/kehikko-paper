import { createHash } from 'node:crypto'

import { LIMITS } from 'kehikot-module-protocol'
import {
  proposalDigester,
  type Proposal as Shared,
  type ProposalDigester,
  type ProposalDigesterOptions,
  type ProposalStatus,
} from 'kehikot-module-protocol/proposals'
import { askHost } from 'kehikot-module-protocol/serve'

import { ID } from './manifest.ts'
import { filerOf, onSettled, pendingFor, type Outcome } from './proposals.ts'

/**
 * Telling the agent session that filed suggestions what the person made of
 * them (`messages.notify`, under `agents:message`): ONCE, when the person has
 * answered every suggestion that session has open on a file and nothing more
 * was decided for 30 s — the protocol's follow-up digest (`proposalDigester`,
 * 2.75.0), not one message per decision. A declined suggestion's reason is in
 * the digest.
 *
 * A courtesy, never the record: the decision and its reason are kept with the
 * suggestion's outcome and read by `list_proposals` whatever happens here. A
 * session whose call came without a place token, a host that is older or
 * absent, a refusal, a restart inside the quiet while — each is silence, and
 * the agent still reads it there.
 */
export type Teller = (project: string, token: string, body: string) => void

const viaHost: Teller = (project, token, body) => {
  void askHost('messages.notify', { token, body, kind: 'report' }, { module: ID, project }).catch(() => {})
}

let teller: Teller = viaHost

/** The tests put a recorder here; `null` puts the host back. */
export function setTeller(next: Teller | null): void {
  teller = next ?? viaHost
}

/*
 * The digester knows a filer by `by.session`. Paper knows a filer by the place
 * token its `propose_edit` call came with (`filerOf`), so the session here is a
 * hash of that token, and the token itself is looked up again only to send. In
 * memory only, like `filerOf`: a token speaks for a running session.
 */
const tokens = new Map<string, string>()
const MAX_TOKENS = 500

function sessionOf(token: string): string {
  const session = createHash('sha256').update(token).digest('hex').slice(0, 32)
  tokens.delete(session)
  tokens.set(session, token)
  while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value!)
  return session
}

/* The digester's "project" is one paper: a project and an epic. */
const placeOf = (project: string, epic: string): string => JSON.stringify([project, epic])
const fromPlace = (place: string): [string, string] => JSON.parse(place) as [string, string]

/** A suggestion as the protocol's proposal model says it: only what the digest reads is meaningful. */
function shared(
  one: { id: string; file: string; why: string; was_text: string; replace: string; at: number },
  status: ProposalStatus,
  token: string,
  extra: Partial<Shared> = {},
): Shared {
  return {
    id: one.id,
    file: one.file,
    scope: 'range',
    find: one.was_text,
    replace: one.replace,
    baseHash: '',
    why: one.why,
    by: { kind: 'agent', name: 'agent', session: sessionOf(token) },
    createdAt: one.at,
    status,
    ...extra,
  }
}

/**
 * The id a suggestion goes by in the digest. A group is answered as ONE
 * decision (`groupOf`), so its members share one id per answer: the digest,
 * which keeps one proposal per id, counts the group once and quotes its reason
 * once, instead of once per member. Per answer, so a group whose members were
 * answered differently still says each answer.
 */
const digestIdOf = (outcome: Outcome, status: ProposalStatus): string => (outcome.group ? `g:${outcome.group}:${status}` : outcome.id)

function sharedOutcome(outcome: Outcome, token: string): Shared {
  if (outcome.state === 'accepted') {
    return shared(outcome, 'accepted', token, { id: digestIdOf(outcome, 'accepted'), acceptedAs: outcome.editedByAuthor ? 'edited' : 'as-proposed' })
  }
  if (outcome.state === 'rejected') {
    return shared(outcome, 'declined', token, { id: digestIdOf(outcome, 'declined'), ...(outcome.declinedReason ? { declinedReason: outcome.declinedReason } : {}) })
  }
  /* Withdrawn by the filer, or dropped with the passage it was about: not the person's answer, so the
     digest leaves it out — but it is no longer open, so a digest waiting on it may go. */
  return shared(outcome, 'withdrawn', token, { id: digestIdOf(outcome, 'withdrawn') })
}

type Timers = Pick<ProposalDigesterOptions, 'setTimer' | 'clearTimer' | 'quietMs'>

/* A waiting digest never keeps the process alive by itself. */
const unrefTimer = (run: () => void, ms: number): unknown => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return timer
}

function makeDigester(timers: Timers = {}): ProposalDigester {
  return proposalDigester({
    setTimer: unrefTimer,
    ...timers,
    open(place, file) {
      const [project, epic] = fromPlace(place)
      const open: Shared[] = []
      for (const one of pendingFor(project, epic)) {
        if (one.file !== file) continue
        const token = filerOf(one.id)
        if (token) open.push(shared({ ...one, replace: one.asked?.replace ?? one.text }, 'pending', token))
      }
      return open
    },
    send({ project: place, by, text }) {
      const token = by.session ? tokens.get(by.session) : undefined
      if (!token) return
      teller(fromPlace(place)[0], token, text.slice(0, LIMITS.MESSAGE_BODY))
    },
  })
}

let digester = makeDigester()

/** The tests put fake timers here; with nothing, the real ones and the protocol's quiet while. */
export function resetDigester(timers?: Timers): void {
  digester.stop()
  digester = makeDigester(timers)
}

/** The module is stopping: what is still waiting is dropped (`list_proposals` keeps it). */
export function stopDigester(): void {
  digester.stop()
}

/** A suggestion was answered, withdrawn or dropped: the digest of its filer hears of it. */
export function digestSettled(project: string, epic: string, outcome: Outcome): void {
  const token = filerOf(outcome.id)
  if (!token) return
  digester.settled(placeOf(project, epic), sharedOutcome(outcome, token))
}

/**
 * A reason written after the decision: the digest says it — the one still
 * waiting, or a short one of its own when that one has gone.
 */
export function digestReasons(project: string, epic: string, changed: readonly Outcome[]): void {
  for (const one of changed) digestSettled(project, epic, one)
}

onSettled(digestSettled)
