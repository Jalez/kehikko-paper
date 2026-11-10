import { LIMITS } from 'kehikot-module-protocol'
import { askHost } from 'kehikot-module-protocol/serve'

import { ID } from './manifest.ts'
import { filerOf, type Outcome } from './proposals.ts'

/**
 * Telling the agent session that filed a suggestion that the person declined
 * it, and why (`messages.notify`, protocol 2.54.0, under `agents:message`).
 *
 * A courtesy, never the record: the decision and its reason are kept with the
 * suggestion's outcome and read by `list_proposals` whatever happens here. A
 * session whose call came without a place token, a host that is older or
 * absent, a refusal — each is silence, and the agent still reads it there.
 */
export type Teller = (project: string, token: string, body: string) => void

const viaHost: Teller = (project, token, body) => {
  void askHost('messages.notify', { token, body, kind: 'note' }, { module: ID, project }).catch(() => {})
}

let teller: Teller = viaHost

/** The tests put a recorder here; `null` puts the host back. */
export function setTeller(next: Teller | null): void {
  teller = next ?? viaHost
}

const quote = (text: string, most: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return JSON.stringify(one.length > most ? `${one.slice(0, most - 1)}…` : one)
}

/** What the filer is told: "Declined: <reason>", and which suggestion. Bounded to a message's length. */
export function declinedNotice(outcome: Outcome, count: number, later: boolean): string {
  const which = count > 1 ? `your ${count} suggestions in group ${quote(outcome.group ?? '', 60)}` : `your suggestion ${outcome.id}`
  const head = outcome.declinedReason
    ? `${later ? 'Declined (reason added)' : 'Declined'}: ${quote(outcome.declinedReason, 1200)}`
    : 'Declined, with no reason given.'
  const body = `${head} The person declined ${which} on ${outcome.file} (${quote(outcome.replace, 160)}). `
    + 'list_proposals keeps the reason; read it before proposing that change again.'
  return body.slice(0, LIMITS.MESSAGE_BODY)
}

/**
 * Tell each filing session once about a decision on these outcomes (one
 * decision: a suggestion, or a group). Sessions are told apart by token.
 */
export function tellDeclined(project: string, changed: readonly Outcome[], later = false): void {
  const byToken = new Map<string, Outcome[]>()
  for (const one of changed) {
    const token = filerOf(one.id)
    if (!token) continue
    byToken.set(token, [...(byToken.get(token) ?? []), one])
  }
  for (const [token, mine] of byToken) teller(project, token, declinedNotice(mine[0]!, mine.length, later))
}
