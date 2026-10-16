import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import { rebase, relocate, type Proposal } from './latex/propose.ts'
import { epicsWithState, paperState, readJson, removeState, writeJson } from './machine.ts'
import { join } from 'node:path'

/**
 * The suggestions nobody has answered yet, and the argument for where they
 * live.
 *
 * ## Revised: kept on this machine, and still in memory while running
 *
 * The argument below was written when losing every pending suggestion on a
 * restart looked cheap. It was not — a module that updates itself restarts, and
 * an agent's work vanished under the person reading it — so what is held in
 * memory is also written, atomically, to the machine's module-state folder
 * (`machine.ts`) and read back on the first question about a paper. The reasons
 * it is still not in the project (it would travel in git) stand; the one for
 * memory-only (no durable record of a suggestion measured against a file nobody
 * can identify) is answered by measuring it again against whatever the file is
 * (`remeasure`). What follows is kept for the first two options it weighed.
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
const SEP = '\0'

/**
 * The same map, kept on the machine as well (see `machine.ts`).
 *
 * The argument above was written when a restart wiping every pending
 * suggestion looked like a cheap price. It was not: a module that updates
 * itself restarts, and an agent's work vanished under the person reading it.
 * So what is held is also written, atomically, beside the other state this
 * module keeps for a paper, and read back the first time a paper is asked
 * about. Only the HASH of a revision token is ever written, so an agent keeps
 * its token across a restart and the file proves nothing to a reader of it.
 * What no longer matches the paper is not dropped on the way back: it is
 * measured again like any other and shown as out of date (`remeasure`).
 */
const memory = new Map<string, Proposal[]>()
const memoryOutcomes = new Map<string, Outcome[]>()
const loaded = new Set<string>()
const SEP_RE = /\0/

function fileOf(at: string): string {
  const [project, epic] = at.split(SEP_RE) as [string, string]
  return join(paperState(project, epic), 'suggestions.json')
}

function load(at: string): void {
  if (loaded.has(at)) return
  loaded.add(at)
  const kept = readJson<{ pending?: unknown; outcomes?: unknown }>(fileOf(at))
  if (!kept) return
  if (Array.isArray(kept.pending)) {
    const list = (kept.pending as Proposal[])
      .filter((p) => p && typeof p.id === 'string' && typeof p.file === 'string' && typeof p.text === 'string')
    if (list.length) memory.set(at, list)
  }
  if (Array.isArray(kept.outcomes)) memoryOutcomes.set(at, (kept.outcomes as Outcome[]).slice(-MAX_OUTCOMES))
}

function save(at: string): void {
  const pendingNow = memory.get(at) ?? []
  const outcomesNow = memoryOutcomes.get(at) ?? []
  const path = fileOf(at)
  if (!pendingNow.length && !outcomesNow.length) {
    removeState(path)
    return
  }
  writeJson(path, { version: 1, pending: pendingNow, outcomes: outcomesNow })
}

const pending = {
  get(at: string): Proposal[] | undefined {
    load(at)
    return memory.get(at)
  },
  set(at: string, list: Proposal[]): void {
    load(at)
    memory.set(at, list)
    save(at)
  },
  delete(at: string): void {
    load(at)
    memory.delete(at)
    save(at)
  },
  /** The keys of one project, in memory and on the machine. */
  keysFor(project: string): string[] {
    const found = new Set<string>()
    for (const epic of epicsWithState(project)) found.add(`${project}${SEP}${epic}`)
    for (const at of memory.keys()) if (at.startsWith(`${project}${SEP}`)) found.add(at)
    return [...found]
  },
}

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
  return heldFor(project, epic).map(({ tokenHash: _kept, tokenHashes: _more, ...rest }) => rest)
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
const MAX_OUTCOMES = 40
const outcomes = {
  get(at: string): Outcome[] | undefined {
    load(at)
    return memoryOutcomes.get(at)
  },
  set(at: string, list: Outcome[]): void {
    load(at)
    memoryOutcomes.set(at, list)
    save(at)
  },
}

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
  for (const at of pending.keysFor(project)) {
    const found = (outcomes.get(at) ?? []).find((o) => o.id === id)
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
  if (!token) return false
  const b = Buffer.from(hashToken(token), 'hex')
  return [proposal.tokenHash, ...(proposal.tokenHashes ?? [])].some((one) => {
    if (!one) return false
    const a = Buffer.from(one, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  })
}

/** The suggestion with this id anywhere in one project, with the epic it is on. */
export function findInProject(project: string, id: string): { epic: string; proposal: Proposal } | null {
  for (const at of pending.keysFor(project)) {
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
    ...(proposal.tokenHashes ? { tokenHashes: proposal.tokenHashes } : {}),
    revisedAt: Date.now(),
    revisions: (proposal.revisions ?? 0) + 1,
  }
  const at = key(project, epic)
  pending.set(at, (pending.get(at) ?? []).map((p) => (p.id === id ? kept : p)))
  const { tokenHash: _hidden, tokenHashes: _others, ...shown } = kept
  return { ok: true, proposal: shown }
}

/**
 * The same filer says it again about words it already has a pending suggestion
 * on: that suggestion is revised in place rather than a second one filed. Keeps
 * the id, the place in the order, the group and every token it was handed out
 * under, and adds the new call's; answers the revised suggestion, or null when
 * `id` is not pending.
 */
export function reviseByFiler(
  project: string,
  epic: string,
  id: string,
  fields: Pick<Proposal, 'from' | 'to' | 'text' | 'was_text' | 'was' | 'why' | 'asked'>,
  newTokenHash: string,
): Proposal | null {
  const at = key(project, epic)
  const held = pending.get(at) ?? []
  const current = held.find((p) => p.id === id)
  if (!current) return null
  const { held: _out, ...rest } = current
  const kept: Proposal = {
    ...rest,
    ...fields,
    tokenHashes: [...(current.tokenHashes ?? []), newTokenHash],
    revisedAt: Date.now(),
    revisions: (current.revisions ?? 0) + 1,
  }
  pending.set(at, held.map((p) => (p.id === id ? kept : p)))
  const { tokenHash: _a, tokenHashes: _b, ...shown } = kept
  return shown
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
  const filed: Proposal = { ...proposal, id: randomUUID(), at: Date.now() }
  pending.set(at, [...held, filed])
  return { ok: true, proposal: filed }
}

/** The author wrote (or changed) the reason beside a pending suggestion. */
export function setWhy(project: string, epic: string, id: string, why: string): void {
  const at = key(project, epic)
  const held = pending.get(at)
  if (!held) return
  pending.set(at, held.map((p) => (p.id === id ? { ...p, why } : p)))
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
      /* Its bytes were rewritten, so there is no arithmetic that moves it. It
         is NOT dropped: it keeps the hash it was measured at, which no longer
         matches the file, and the next measurement (`remeasure`) looks for its
         quoted words again — drawing it where they are, holding it back where
         they changed, listing it as out of date where they are gone. */
      lost += 1
      kept.push(proposal)
    }
  }
  if (kept.length) pending.set(at, kept)
  else pending.delete(at)
  return lost
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
  let changed = false
  for (const proposal of held) {
    if (!read.has(proposal.file)) read.set(proposal.file, current(proposal.file))
    const file = read.get(proposal.file) ?? null
    if (file === null) {
      if (proposal.held !== 'gone') {
        changed = true
        lost.push({ file: proposal.file, why: `${proposal.file} is no longer a file this paper can read.` })
        kept.push({ ...proposal, held: 'gone', from: 0, to: 0, was_text: '' })
      } else kept.push(proposal)
      continue
    }
    if (file.hash === proposal.was) {
      kept.push(proposal)
      continue
    }
    const again = relocate(proposal, file.source, file.hash)
    changed = true
    if (again.held && again.held !== proposal.held) {
      lost.push({
        file: proposal.file,
        why:
          again.held === 'changed'
            ? `${proposal.file} changed on disk and part of the text it was about was rewritten.`
            : again.held === 'ambiguous'
              ? `${proposal.file} changed on disk and the text it was about is now in the file more than once.`
              : `${proposal.file} changed on disk and the text it was about is no longer there.`,
      })
    }
    kept.push(again)
  }
  if (changed) pending.set(at, kept)
  return lost
}

/**
 * What the suggestions that did not survive a change on disk are called, in a
 * sentence a person reads — the counterpart of `droppedBecause`, for the
 * change this process did not make.
 */
export function lostBecause(lost: readonly { file: string; why: string }[]): string {
  if (!lost.length) return ''
  if (lost.length === 1) return `One suggestion is out of date: ${lost[0]!.why}`
  const files = [...new Set(lost.map((one) => one.file))].join(', ')
  return `${lost.length} suggestions are out of date, because ${files} changed on disk and the text they were about `
    + 'was rewritten or is gone. They are listed, and can be cancelled.'
}

/**
 * Forget everything, which only a test has any business doing.
 *
 * Exported because the alternative is a test that reaches into the map, and a
 * test that reaches into a module's private state is a test that keeps passing
 * after the state stops being a map.
 */
export function forgetAllProposals(): void {
  for (const at of new Set([...memory.keys(), ...memoryOutcomes.keys(), ...loaded])) removeState(fileOf(at))
  memory.clear()
  memoryOutcomes.clear()
  loaded.clear()
}

/**
 * Forget what this process holds in memory and nothing else: what a restart
 * does. The next question about a paper reads what was kept on the machine.
 */
export function restartProposals(): void {
  memory.clear()
  memoryOutcomes.clear()
  loaded.clear()
}
