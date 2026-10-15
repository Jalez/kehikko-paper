import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import { MAX_PENDING, rebase, refile, type Proposal } from './latex/propose.ts'

/**
 * The suggestions nobody has answered yet, and the argument for where they
 * live.
 *
 * ## In this process's memory, and not on the disk
 *
 * There were three places a pending proposal could live and the choice is not
 * cosmetic, so it is written down here rather than left to be inferred from an
 * import.
 *
 *  - **In the page.** Impossible, and worth saying why rather than dismissing:
 *    an agent proposes over `/mcp`, which is a request to the SERVER. A page
 *    holding the pending list would never learn about a proposal at all unless
 *    the server held it first, so this is not an option, it is a
 *    misunderstanding of which process the proposer talks to.
 *  - **In a file, beside the paper.** `<project>/.kehikot/paper/<epic>/` is
 *    already this module's folder, so a `proposals.json` there is one line of
 *    code. It is refused for two reasons, and the first is decisive: whether
 *    that folder is committed is a per-project setting in the host, so on a
 *    project that commits it, a half-considered suggestion an agent made and
 *    nobody accepted lands in the author's git history as part of the paper.
 *    The second is that `doors.ts` says, in as many words, that the program
 *    this was extracted from had "a SQLite work queue" and that its absence is
 *    the point of the extraction rather than an unfinished part of it. A
 *    `proposals.json` is that queue with a different file extension.
 *  - **In this process, for as long as it runs.** Which is what this is.
 *
 * ## What that costs, stated rather than hidden
 *
 * Restart the server and every pending suggestion is gone. Nothing was written
 * and nothing was destroyed — the paper is exactly as it was, which is the
 * whole promise of a proposal — but an agent's work has to be done again, and
 * there is no record that it existed. That is the same lifetime the write
 * ticket has, for the same reason `TICKET` gives: a thing written down outlives
 * the process that minted it, and a proposal that outlived this one would be a
 * suggestion measured against a version of a file nobody can now identify.
 *
 * It also means two servers on two ports over the same project each hold their
 * own, and neither can see the other's. That is already true of the ticket and
 * it is the honest consequence of not having a shared store: what it CANNOT do
 * is let two of them disagree about the paper, because the paper is on the disk
 * and every apply re-reads it and checks its hash.
 *
 * ## Keyed by project and epic together
 *
 * Never by epic alone. Epic slugs are short and hand-picked — `thesis`,
 * `bridge`, `wire` — so a second project on this machine plausibly has the same
 * one, and a proposal filed under a bare slug would be offered to the wrong
 * paper. This is the same reasoning `api.ts` gives for keeping the project
 * beside every request.
 */
const pending = new Map<string, Proposal[]>()

const SEP = '\0'

function key(project: string, epic: string): string {
  /* A NUL between them, because it cannot occur in either half. A slash or a
     colon can, and a separator that can appear inside a component is a key
     where two different pairs collide. */
  return `${project}${SEP}${epic}`
}

/** Everything pending for one paper, oldest first, so the page draws them in order. */
export function pendingFor(project: string, epic: string): Proposal[] {
  /* The token's hash is stripped HERE, so that nothing which reads the list —
     the page's poll, `list_proposals`, a response body — can carry it. It is
     the one proof a filer has, and it is never shown. */
  return heldFor(project, epic).map(({ tokenHash: _kept, ...rest }) => rest)
}

/** The raw records, token hash included. Server-side checks only; never put the result in a response. */
function heldFor(project: string, epic: string): Proposal[] {
  return [...(pending.get(key(project, epic)) ?? [])].sort((a, b) => a.at - b.at)
}

/** One proposal by id, or null. The id is this process's and means nothing elsewhere. */
export function proposalById(project: string, epic: string, id: string): Proposal | null {
  return pendingFor(project, epic).find((p) => p.id === id) ?? null
}

/** Every pending suggestion that shares a group with `proposal`, itself included; just itself when it has none. */
export function groupOf(project: string, epic: string, proposal: Proposal): Proposal[] {
  if (!proposal.group) return [proposal]
  return pendingFor(project, epic).filter((p) => p.group === proposal.group)
}

/** What happened to a suggestion that is no longer pending. */
export type Settled = 'accepted' | 'rejected' | 'withdrawn' | 'dropped'

export interface Outcome {
  id: string
  file: string
  state: Settled
  at: number
  why: string
  /** What the agent asked for, kept as it was filed. */
  was_text: string
  replace: string
  /** The author changed the text before accepting; `final` is what was written. */
  editedByAuthor?: boolean
  final?: string
  /** How many times the filer revised it before it was answered. */
  revisions?: number
}

/** Recent outcomes per paper, newest last, bounded: the agent's "what became of mine". */
const outcomes = new Map<string, Outcome[]>()
const MAX_OUTCOMES = 40

function note(project: string, epic: string, one: Proposal, state: Settled, extra: Partial<Outcome> = {}): void {
  const at = key(project, epic)
  const list = outcomes.get(at) ?? []
  list.push({
    id: one.id,
    file: one.file,
    state,
    at: Date.now(),
    why: one.why,
    was_text: one.was_text,
    replace: one.asked?.replace ?? one.text,
    ...(one.revisions ? { revisions: one.revisions } : {}),
    ...extra,
  })
  outcomes.set(at, list.slice(-MAX_OUTCOMES))
}

/** Recent outcomes of one paper, newest first. */
export function outcomesFor(project: string, epic: string): Outcome[] {
  return [...(outcomes.get(key(project, epic)) ?? [])].reverse()
}

/** One outcome by id across a whole project (any epic), or null. */
export function outcomeById(project: string, id: string): Outcome | null {
  for (const [at, list] of outcomes) {
    if (!at.startsWith(`${project}${SEP}`)) continue
    const found = list.find((o) => o.id === id)
    if (found) return found
  }
  return null
}

/**
 * Answer a suggestion: forget it as pending and remember what became of it.
 * `final` is what was written, when the author changed the text first.
 */
export function settle(
  project: string,
  epic: string,
  id: string,
  state: Settled,
  extra: Partial<Outcome> = {},
): void {
  const one = heldFor(project, epic).find((p) => p.id === id)
  if (one) note(project, epic, one, state, extra)
  drop(project, epic, id)
}

/** A secret the filer holds, and the hash that is all this process keeps of it. */
export function mintToken(): { token: string; hash: string } {
  const token = randomBytes(18).toString('base64url')
  return { token, hash: hashToken(token) }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function tokenMatches(proposal: Proposal, token: string): boolean {
  if (!proposal.tokenHash || !token) return false
  const a = Buffer.from(proposal.tokenHash, 'hex')
  const b = Buffer.from(hashToken(token), 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The suggestion with this id anywhere in one project, with the epic it is on. */
export function findInProject(project: string, id: string): { epic: string; proposal: Proposal } | null {
  for (const at of pending.keys()) {
    if (!at.startsWith(`${project}${SEP}`)) continue
    const epic = at.slice(project.length + SEP.length)
    const proposal = heldFor(project, epic).find((p) => p.id === id)
    if (proposal) return { epic, proposal }
  }
  return null
}

/**
 * Which pending suggestions on this file the range [from, to) touches, in
 * words an agent can act on. `window` is the span of the file the new
 * suggestion QUOTED, so a pending change that sits inside the quoted sentence
 * is named too even when the two narrowed ranges do not touch.
 */
export function overlaps(
  project: string,
  epic: string,
  probe: { file: string; from: number; to: number; window: { from: number; to: number }; find: string },
  windowOf: (p: Proposal) => { from: number; to: number } | null,
): { id: string; conflict: boolean }[] {
  const found: { id: string; conflict: boolean }[] = []
  for (const p of heldFor(project, epic)) {
    if (p.file !== probe.file) continue
    /* Two ranges intersect when each starts before the other ends; a pair of
       zero-width insertions at the same byte intersect too, since both want
       that one place. Touching ends (a.to === b.from) do not. */
    const touches =
      (p.from < probe.to && probe.from < p.to) || (p.from === p.to && probe.from === probe.to && p.from === probe.from) ||
      (p.from === p.to && p.from > probe.from && p.from < probe.to) ||
      (probe.from === probe.to && probe.from > p.from && probe.from < p.to)
    const quoted = windowOf(p)
    const sharesQuote =
      p.asked?.find === probe.find ||
      (quoted !== null && quoted.from < probe.window.to && probe.window.from < quoted.to)
    if (touches) found.push({ id: p.id, conflict: true })
    else if (sharesQuote) found.push({ id: p.id, conflict: false })
  }
  return found
}

/**
 * Update a pending suggestion its filer holds the token for. `next` is built
 * by the caller (it needs the file) and replaces the record, keeping id, `at`,
 * `group` and the token. Refuses, in words, unless pending and the token fits.
 */
export function reviseOne(
  project: string,
  epic: string,
  id: string,
  token: string,
  next: (current: Proposal) => Proposal | { refuse: string },
): { ok: true; proposal: Proposal } | { ok: false; why: string } {
  const gate = ownership(project, id, token)
  if ('why' in gate) return { ok: false, why: gate.why }
  const { proposal } = gate
  const made = next(proposal)
  if ('refuse' in made) return { ok: false, why: made.refuse }
  const kept: Proposal = {
    ...made,
    id: proposal.id,
    at: proposal.at,
    group: proposal.group,
    tokenHash: proposal.tokenHash,
    revisedAt: Date.now(),
    revisions: (proposal.revisions ?? 0) + 1,
  }
  const at = key(project, epic)
  pending.set(at, (pending.get(at) ?? []).map((p) => (p.id === id ? kept : p)))
  const { tokenHash: _hidden, ...shown } = kept
  return { ok: true, proposal: shown }
}

/**
 * Why a token does not open a suggestion — or the suggestion it does.
 * Pending and token-matching are the only two things that let an agent touch one.
 */
export function ownership(
  project: string,
  id: string,
  token: string,
): { epic: string; proposal: Proposal } | { why: string } {
  const found = findInProject(project, id)
  if (!found) {
    const done = outcomeById(project, id)
    if (done) {
      const how =
        done.state === 'accepted'
          ? 'already accepted by the author'
          : done.state === 'rejected'
            ? 'already rejected by the author'
            : done.state === 'withdrawn'
              ? 'already withdrawn'
              : 'dropped because the text it was about changed'
      return { why: `That suggestion was ${how}, so it can no longer be changed. File a new one if it still matters.` }
    }
    return {
      why:
        'There is no pending suggestion with that id in this project. It may be on another project, or this server '
        + 'restarted and forgot it (list_proposals shows what is pending).',
    }
  }
  if (!tokenMatches(found.proposal, token)) {
    return {
      why:
        'That suggestion is not yours to change: the revision token does not match the one propose_edit returned '
        + 'for it. Only the agent that filed a suggestion can revise or withdraw it, and only while it is pending.',
    }
  }
  return found
}

/**
 * Withdraw a pending suggestion its filer holds the token for. A suggestion in
 * a group is withdrawn WITH the group, because the rest of a move is not a
 * change anybody asked for. Answers every id withdrawn.
 */
export function withdraw(
  project: string,
  id: string,
  token: string,
): { ok: true; ids: string[]; epic: string } | { ok: false; why: string } {
  const gate = ownership(project, id, token)
  if ('why' in gate) return { ok: false, why: gate.why }
  const { epic, proposal } = gate
  const all = groupOf(project, epic, proposal)
  for (const one of all) settle(project, epic, one.id, 'withdrawn')
  return { ok: true, ids: all.map((p) => p.id), epic }
}

/**
 * File a suggestion.
 *
 * The bound is enforced here and refuses rather than evicting. Dropping the
 * oldest to make room would silently discard a suggestion a reader had not
 * answered yet, which is the one thing a queue must not do to somebody who is
 * still deciding; refusing tells the caller the truth, which is that nobody is
 * keeping up with it.
 */
export function keep(
  project: string,
  epic: string,
  proposal: Omit<Proposal, 'id' | 'at'>,
): { ok: true; proposal: Proposal } | { ok: false; why: string } {
  const at = key(project, epic)
  const held = pending.get(at) ?? []
  if (held.length >= MAX_PENDING) {
    return {
      ok: false,
      why:
        `There are already ${held.length} suggestions waiting on this paper, which is as many as it holds. `
        + 'Wait for the reader to answer some of them.',
    }
  }
  const filed: Proposal = { ...proposal, id: randomUUID(), at: Date.now() }
  pending.set(at, [...held, filed])
  return { ok: true, proposal: filed }
}

/** Forget one, whether it was accepted, rejected or refused. */
export function drop(project: string, epic: string, id: string): void {
  const at = key(project, epic)
  const held = pending.get(at)
  if (!held) return
  const left = held.filter((p) => p.id !== id)
  if (left.length) pending.set(at, left)
  else pending.delete(at)
}

/**
 * Move every surviving suggestion onto the file as it now is.
 *
 * Called after ANY successful write to a paper — an accepted proposal, and
 * equally a correction a person typed into the prose. That second case is the
 * one worth being explicit about: a reader fixing a typo two paragraphs above a
 * pending suggestion has moved its bytes just as surely as accepting another
 * suggestion would, and a rebase that only ran on the accept path would leave
 * the pending list quietly wrong exactly when somebody was using the feature
 * this module is named for.
 *
 * Answers how many did not survive, so the page can say so out loud rather than
 * letting a suggestion disappear while somebody was reading it.
 */
export function rebaseAll(
  project: string,
  epic: string,
  applied: { file: string; from: number; to: number; text: string },
  hash: string,
): number {
  const at = key(project, epic)
  const held = pending.get(at)
  if (!held?.length) return 0
  const kept: Proposal[] = []
  let lost = 0
  for (const proposal of held) {
    const moved = rebase(proposal, applied, hash)
    if (moved) kept.push(moved)
    else {
      lost += 1
      note(project, epic, proposal, 'dropped')
    }
  }
  lost += breakGroups(project, epic, held, kept)
  if (kept.length) pending.set(at, kept)
  else pending.delete(at)
  return lost
}

/**
 * A group is all or nothing: when one of its members did not survive, the
 * others do not either, since half a move is a change nobody asked for.
 * Mutates `kept`; answers how many survivors it took out.
 */
function breakGroups(project: string, epic: string, before: readonly Proposal[], kept: Proposal[]): number {
  const had = new Map<string, number>()
  for (const p of before) if (p.group) had.set(p.group, (had.get(p.group) ?? 0) + 1)
  const have = new Map<string, number>()
  for (const p of kept) if (p.group) have.set(p.group, (have.get(p.group) ?? 0) + 1)
  let removed = 0
  for (let i = kept.length - 1; i >= 0; i--) {
    const p = kept[i]!
    if (p.group && (have.get(p.group) ?? 0) < (had.get(p.group) ?? 0)) {
      note(project, epic, p, 'dropped')
      kept.splice(i, 1)
      removed += 1
    }
  }
  return removed
}

/**
 * Measure every pending suggestion against the file as it is on disk NOW, and
 * say which ones no longer describe anything.
 *
 * ## The case `rebaseAll` cannot see
 *
 * `rebaseAll` runs after a write THIS process made, and shifts by arithmetic.
 * A file also changes when this process is not looking — the author saves a
 * chapter from a real editor, a merge lands, a branch is checked out — and
 * then every proposal on that file carries a hash the door will refuse. They
 * would sit in the list, drawn on the page, and each Accept would answer "the
 * file has changed since this page read it", correctly and forever. A
 * suggestion that can never be applied is not a decision anybody can make.
 *
 * ## Run on every READ of the list, so the list is always about the disk
 *
 * Not on a trigger from the page. The page polls the list every four seconds
 * anyway, and the invariant this buys is one sentence long: what
 * `/api/proposals` and `list_proposals` return is measured against the file as
 * it stands when they answer. A page that holds an older reading of the paper
 * knows it does — that is what `Paper.hashes` is for — and draws nothing from
 * the list until it has caught up, rather than the list being held back for
 * it. See `changed` in `use-paper.ts`.
 *
 * `current` is asked for a file's hash and source only when a proposal on
 * that file is stale, so a list whose hashes all match costs no file reads at
 * all; a file it answers `null` about — gone, unreadable, no longer named by
 * the paper — drops every proposal on it.
 *
 * Answers the ones that did not survive, with the file each was about, so the
 * caller can say so in words rather than letting a suggestion vanish from a
 * page while somebody was reading it.
 */
export function remeasure(
  project: string,
  epic: string,
  current: (file: string) => { hash: string; source: string } | null,
): { file: string; why: string }[] {
  const at = key(project, epic)
  const held = pending.get(at)
  if (!held?.length) return []
  const read = new Map<string, { hash: string; source: string } | null>()
  const kept: Proposal[] = []
  const lost: { file: string; why: string }[] = []
  for (const proposal of held) {
    if (!read.has(proposal.file)) read.set(proposal.file, current(proposal.file))
    const file = read.get(proposal.file) ?? null
    if (file === null) {
      lost.push({ file: proposal.file, why: `${proposal.file} is no longer a file this paper can read.` })
      note(project, epic, proposal, 'dropped')
      continue
    }
    if (file.hash === proposal.was) {
      kept.push(proposal)
      continue
    }
    const again = refile(proposal, file.source, file.hash)
    if (again) kept.push(again)
    else {
      note(project, epic, proposal, 'dropped')
      lost.push({
        file: proposal.file,
        why: `${proposal.file} changed on disk and the text it was about is no longer there, exactly once, to find.`,
      })
    }
  }
  const extra = breakGroups(project, epic, held, kept)
  for (let n = 0; n < extra; n++) {
    lost.push({ file: held[0]!.file, why: 'It belonged to a group, and another member of the group was dropped.' })
  }
  if (kept.length) pending.set(at, kept)
  else pending.delete(at)
  return lost
}

/**
 * What the suggestions that did not survive a change on disk are called, in a
 * sentence a person reads — the counterpart of `droppedBecause`, for the
 * change this process did not make.
 */
export function lostBecause(lost: readonly { file: string; why: string }[]): string {
  if (!lost.length) return ''
  if (lost.length === 1) return `One suggestion was dropped: ${lost[0]!.why}`
  const files = [...new Set(lost.map((one) => one.file))].join(', ')
  return `${lost.length} suggestions were dropped, because ${files} changed on disk and the text they were about is `
    + 'no longer there to find.'
}

/**
 * Forget everything, which only a test has any business doing.
 *
 * Exported because the alternative is a test that reaches into the map, and a
 * test that reaches into a module's private state is a test that keeps passing
 * after the state stops being a map.
 */
export function forgetAllProposals(): void {
  pending.clear()
  outcomes.clear()
}
