import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { gitBlob, gitView, stageFile, stageText, unstageFile, type GitView } from './git.ts'
import { accept as applyHunks, grouping, hunkIds, hunksOf, ownSave, type Hunk } from './latex/hunks.ts'
import { bytesOf } from './latex/edit.ts'
import type { Proposal } from './latex/propose.ts'
import { paperState, readJson, removeState, writeJson } from './machine.ts'
import { MAIN, confine, hashOf, hashesOf, isEpic, paperRoot, writeRange, writeRanges } from './store.ts'

/**
 * What is reviewable in a paper, computed from the state of its files.
 *
 * ## One computation, three inputs
 *
 *  - the BASELINE of a file: its text as the author last saw or accepted it;
 *  - the DISK: what the file holds now, whoever changed it;
 *  - the STAGED suggestions: edits an agent proposed and nobody applied
 *    (`proposals.ts`; they are drawn beside what this computes, with the same
 *    tag).
 *
 * A hunk where the disk differs from the baseline is a reviewable change,
 * whether an agent's file tools made it, another editor, `git checkout` or a
 * formatter: review is triggered by the state of the files, not by a call.
 *
 * ## The baseline, and where it comes from
 *
 * Where the paper is inside a git work tree and `main.tex` is tracked, the
 * baseline of a file is its content in the INDEX, or in HEAD when the index has
 * none. Accepting a change stages it; committing commits what was staged.
 * Everywhere else (no repository, git missing, the paper untracked or its
 * folder ignored) it is a snapshot kept on this machine, never in the project:
 * the first time a file is seen its current text is its baseline, so nothing
 * is ever flagged wholesale, and accepting moves the snapshot forward.
 *
 * ## The author's own typing is not a change to review
 *
 * A save from Paper's editor moves the baseline by the author's edit
 * operations only (`ownSave`). A pending change an agent made in the same file
 * is never carried along: the author's block that touches it leaves the
 * baseline there, so it stays reviewable and is marked adjusted.
 */

/** A file larger than this is not tracked: it is listed as such and never compared. */
export const MAX_TRACKED_BYTES = 4_000_000
/** The most files one paper tracks. */
export const MAX_TRACKED_FILES = 64
const MAX_ACCEPTED = 40
const MAX_REASONS = 400
const MAX_SEEN = 600
const KEEP_TEXT = 4000
const KEEP_REASON_MS = 3 * 24 * 3600 * 1000
const DELETABLE = /\.(tex|bib|sty|cls|bst)$/

export interface Accepted {
  /** A number, newest highest, that a cancel names. */
  n: number
  id: string
  kind: 'disk' | 'staged' | 'new' | 'deleted'
  file: string
  /** The text before and after, bounded. */
  old: string
  new: string
  /** A little of what stood before and after the new text, so it can be found again. */
  before: string
  after: string
  why: string
  at: number
  /** Who accepted it: the author pressing, or Auto accept. */
  by: 'author' | 'auto'
  /** The author changed the text (or wrote the reason) before accepting. */
  adjusted?: boolean
  cancelled?: boolean
  committed?: boolean
  /** The agent that filed it, for a suggestion. */
  filer?: string
}

interface State {
  version: 1
  auto: boolean
  /** Go to the next change after answering one. On unless the person turned it off. */
  jump: boolean
  autoSince: number
  reasons: Record<string, { why: string; at: number }>
  adjusted: Record<string, number>
  seen: Record<string, number>
  accepted: Accepted[]
  next: number
  snap: string[]
}

export interface Ctx {
  project: string
  epic: string
  /** The paper's root directory. */
  dir: string
  files: string[]
  hashes: Record<string, string>
}

export function ctxOf(project: string | null, epic: string): Ctx | null {
  if (!project || !isEpic(epic)) return null
  const dir = paperRoot(epic, project)
  const hashes = hashesOf(epic, project)
  if (!dir || !hashes) return null
  return { project, epic, dir, files: Object.keys(hashes), hashes }
}

export interface Review {
  mode: 'git' | 'snapshot'
  /** In words, what the baseline is: shown beside the count. */
  baseline: string
  /** Set while git is in the middle of a merge, rebase or the like: changes are shown, and answering them is refused. */
  readOnly: string | null
  changes: Proposal[]
  /** Files left out of the comparison, with why. */
  untracked: { file: string; why: string }[]
  auto: boolean
  jump: boolean
  /** The changes accepted lately that can still be cancelled, newest first. */
  accepted: Accepted[]
}

const BASELINE_GIT = 'compared with what is staged or committed in git'
const BASELINE_SNAPSHOT = 'compared with what you last accepted in Paper'

/* ----------------------------------------------------------------- state */

const states = new Map<string, State>()
const keyOf = (project: string, epic: string) => `${project}\0${epic}`
const stateFile = (project: string, epic: string) => join(paperState(project, epic), 'review.json')

function fresh(): State {
  return { version: 1, auto: false, jump: true, autoSince: 0, reasons: {}, adjusted: {}, seen: {}, accepted: [], next: 1, snap: [] }
}

function stateOf(project: string, epic: string): State {
  const at = keyOf(project, epic)
  const had = states.get(at)
  if (had) return had
  const read = readJson<Partial<State>>(stateFile(project, epic))
  const made = fresh()
  if (read && typeof read === 'object') {
    if (typeof read.auto === 'boolean') made.auto = read.auto
    if (typeof read.jump === 'boolean') made.jump = read.jump
    if (typeof read.autoSince === 'number') made.autoSince = read.autoSince
    if (read.reasons && typeof read.reasons === 'object') made.reasons = read.reasons as State['reasons']
    if (read.adjusted && typeof read.adjusted === 'object') made.adjusted = read.adjusted as State['adjusted']
    if (read.seen && typeof read.seen === 'object') made.seen = read.seen as State['seen']
    if (Array.isArray(read.accepted)) made.accepted = read.accepted as Accepted[]
    if (typeof read.next === 'number') made.next = read.next
    if (Array.isArray(read.snap)) made.snap = read.snap.filter((one): one is string => typeof one === 'string')
  }
  states.set(at, made)
  return made
}

function keepState(project: string, epic: string): void {
  const s = stateOf(project, epic)
  const entries = Object.entries(s.reasons)
  if (entries.length > MAX_REASONS) {
    s.reasons = Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_REASONS))
  }
  s.accepted = s.accepted.slice(-MAX_ACCEPTED)
  writeJson(stateFile(project, epic), s)
}

/** The auto-accept setting of a paper: remembered on the machine, per project and epic. */
export function autoOf(project: string, epic: string): boolean {
  return stateOf(project, epic).auto
}

/* -------------------------------------------------------------- snapshot */

const snapshots = new Map<string, Map<string, string>>()
const snapPath = (project: string, epic: string, file: string) =>
  join(paperState(project, epic), 'baseline', `${createHash('sha256').update(file).digest('hex').slice(0, 20)}.json`)

function snapshotOf(project: string, epic: string, file: string): string | null {
  const at = keyOf(project, epic)
  let cache = snapshots.get(at)
  if (!cache) snapshots.set(at, (cache = new Map()))
  const had = cache.get(file)
  if (had !== undefined) return had
  const read = readJson<{ file?: string; text?: string }>(snapPath(project, epic, file))
  if (read && read.file === file && typeof read.text === 'string') {
    cache.set(file, read.text)
    return read.text
  }
  return null
}

function keepSnapshot(project: string, epic: string, file: string, text: string): void {
  const at = keyOf(project, epic)
  let cache = snapshots.get(at)
  if (!cache) snapshots.set(at, (cache = new Map()))
  cache.set(file, text)
  writeJson(snapPath(project, epic, file), { file, text })
  const s = stateOf(project, epic)
  if (!s.snap.includes(file)) s.snap.push(file)
}

/** Drop the snapshots of files the paper no longer names. */
function pruneSnapshots(ctx: Ctx): void {
  const s = stateOf(ctx.project, ctx.epic)
  const names = new Set(ctx.files)
  const gone = s.snap.filter((one) => !names.has(one))
  if (!gone.length) return
  for (const file of gone) {
    removeState(snapPath(ctx.project, ctx.epic, file))
    snapshots.get(keyOf(ctx.project, ctx.epic))?.delete(file)
  }
  s.snap = s.snap.filter((one) => names.has(one))
}

/* --------------------------------------------------------------- compute */

interface Part {
  file: string
  text: string
  hash: string
  /** The baseline in the same line endings as the file. */
  base: string
  crlf: boolean
  mode: string
  hunks: Hunk[]
  ids: string[]
}

interface Computed {
  review: Review
  parts: Map<string, Part>
  view: GitView | null
  state: State
  /** Disk-kind changes by id, with the part and hunk they came from. */
  byId: Map<string, { part: Part; hunk: Hunk }>
  /** Changes whose id this paper had not seen before this computation. */
  fresh: Set<string>
}

function readText(ctx: Ctx, file: string): { text: string; bytes: Buffer; mtime: number } | null {
  const path = confine(ctx.dir, file)
  if (!path) return null
  try {
    const found = statSync(path)
    if (!found.isFile() || found.size > MAX_TRACKED_BYTES) return null
    const bytes = readFileSync(path)
    return { text: bytes.toString('utf8'), bytes, mtime: found.mtimeMs }
  } catch {
    return null
  }
}

/** The baseline of the repository's view for one file, or null when there is none to claim. */
function gitBase(ctx: Ctx, view: GitView, file: string): { text: string; mode: string } | null {
  if (view.unmerged.has(file)) return null
  const entry = view.index.get(file) ?? view.head.get(file)
  if (!entry) return null
  const text = gitBlob(ctx.dir, entry.sha)
  return text === null ? null : { text, mode: entry.mode }
}

/**
 * The repository's view when the paper is tracked in it. A repository whose
 * index and HEAD have nothing of this paper has nothing to compare with, and
 * the snapshot is the honest baseline there.
 */
function trackedView(ctx: Ctx): GitView | null {
  const view = gitView(ctx.dir)
  return view && (view.index.has(MAIN) || view.head.has(MAIN)) ? view : null
}

const diffs = new Map<string, { hash: string; base: string; hunks: Hunk[]; ids: string[] }>()

function compute(ctx: Ctx): Computed {
  const state = stateOf(ctx.project, ctx.epic)
  const view = trackedView(ctx)
  const fresh = new Set<string>()
  const mode: Review['mode'] = view ? 'git' : 'snapshot'
  const readOnly = view?.operation ? `Git is in the middle of ${view.operation} — finish it to review here.` : null
  const parts = new Map<string, Part>()
  const byId = new Map<string, { part: Part; hunk: Hunk }>()
  const changes: Proposal[] = []
  const untracked: Review['untracked'] = []
  const now = Date.now()
  const present = new Set<string>()

  let count = 0
  for (const file of ctx.files) {
    if (++count > MAX_TRACKED_FILES) {
      untracked.push({ file, why: `This paper has more than ${MAX_TRACKED_FILES} files; the rest are not compared.` })
      continue
    }
    const read = readText(ctx, file)
    if (!read) {
      untracked.push({
        file,
        why: `${file} is larger than ${Math.round(MAX_TRACKED_BYTES / 1024)} kB, so changes to it are not tracked for review.`,
      })
      continue
    }
    /* A file with git's conflict markers in it is not a change anybody can
       review: it is a conflict to resolve. It is left out until it is. */
    if (/^<{7} /m.test(read.text) && /^>{7} /m.test(read.text)) {
      untracked.push({ file, why: `${file} has conflict markers in it; resolve the conflict first.` })
      continue
    }
    const hash = hashOf(read.bytes)
    let baseText: string | null = null
    let fileMode = '100644'
    if (view) {
      const base = gitBase(ctx, view, file)
      if (base) {
        baseText = base.text
        fileMode = base.mode
      } else if (view.untracked.has(file)) {
        const id = `n-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`
        if (!(id in state.seen)) fresh.add(id)
        const seenAt = state.seen[id] ?? Math.min(now, read.mtime)
        state.seen[id] = seenAt
        present.add(id)
        changes.push({
          id,
          file,
          from: 0,
          to: 0,
          text: '',
          was_text: '',
          was: hash,
          why: state.reasons[id]?.why ?? '',
          by: 'a new file',
          at: seenAt,
          kind: 'new',
          ...(state.adjusted[id] ? { adjusted: true } : {}),
        })
        continue
      } else continue
    } else {
      baseText = snapshotOf(ctx.project, ctx.epic, file)
      if (baseText === null) {
        keepSnapshot(ctx.project, ctx.epic, file, read.text)
        baseText = read.text
      }
    }
    const crlf = read.text.includes('\r\n') && !baseText.includes('\r')
    const base = crlf ? baseText.replace(/\n/g, '\r\n') : baseText
    /* A poll that finds nothing moved costs a hash, not a diff. */
    const memo = `${keyOf(ctx.project, ctx.epic)}\0${file}`
    let cached = diffs.get(memo)
    if (!cached || cached.hash !== hash || cached.base !== base) {
      const found = hunksOf(base, read.text)
      cached = { hash, base, hunks: found, ids: hunkIds(file, base, found) }
      diffs.set(memo, cached)
      if (diffs.size > 400) diffs.delete(diffs.keys().next().value as string)
    }
    const { hunks, ids } = cached
    const part: Part = { file, text: read.text, hash, base, crlf, mode: fileMode, hunks, ids }
    parts.set(file, part)
    const times = ids.map((id) => {
      const had = state.seen[id]
      return had ?? Math.min(now, read.mtime)
    })
    const groups = grouping(read.text, hunks, times)
    const members = new Map<number, number>()
    const leader = new Map<number, string>()
    groups.forEach((g, i) => {
      members.set(g, (members.get(g) ?? 0) + 1)
      if (!leader.has(g)) leader.set(g, ids[i]!)
    })
    // byte offsets of each hunk in the file as it is
    const bytesAt = (index: number) => bytesOf(read.text.slice(0, index))
    hunks.forEach((hunk, i) => {
      const id = ids[i]!
      present.add(id)
      if (!(id in state.seen)) fresh.add(id)
      state.seen[id] = times[i]!
      byId.set(id, { part, hunk })
      const from = bytesAt(hunk.newFrom)
      const group = (members.get(groups[i]!) ?? 0) > 1 ? `h-${leader.get(groups[i]!)}` : undefined
      changes.push({
        id,
        file,
        from,
        to: from + bytesOf(hunk.newText),
        text: hunk.oldText,
        was_text: hunk.newText,
        was: hash,
        why: state.reasons[id]?.why ?? '',
        by: 'changed on disk',
        at: times[i]!,
        kind: 'disk',
        ...(group ? { group } : {}),
        ...(state.adjusted[id] ? { adjusted: true } : {}),
      })
    })
  }

  if (view) {
    for (const [file] of view.index) {
      if (!DELETABLE.test(file) || ctx.files.includes(file) || view.unmerged.has(file)) continue
      const path = confine(ctx.dir, file)
      if (!path || existsSync(path)) continue
      const id = `x-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`
      if (!(id in state.seen)) fresh.add(id)
      const seenAt = state.seen[id] ?? now
      state.seen[id] = seenAt
      present.add(id)
      changes.push({
        id,
        file,
        from: 0,
        to: 0,
        text: '',
        was_text: '',
        was: '',
        why: state.reasons[id]?.why ?? '',
        by: 'a deleted file',
        at: seenAt,
        kind: 'deleted',
      })
    }
  }

  /* What is remembered about changes that are gone is kept for a while (an
     agent explaining after the author accepted), then forgotten. */
  for (const id of Object.keys(state.seen)) if (!present.has(id)) delete state.seen[id]
  const seenEntries = Object.entries(state.seen)
  if (seenEntries.length > MAX_SEEN) state.seen = Object.fromEntries(seenEntries.sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN))
  for (const [id, one] of Object.entries(state.reasons)) if (!present.has(id) && now - one.at > KEEP_REASON_MS) delete state.reasons[id]
  for (const id of Object.keys(state.adjusted)) if (!present.has(id)) delete state.adjusted[id]
  if (!view) pruneSnapshots(ctx)

  const review: Review = {
    mode,
    baseline: mode === 'git' ? BASELINE_GIT : BASELINE_SNAPSHOT,
    readOnly,
    changes,
    untracked,
    auto: state.auto,
    jump: state.jump,
    accepted: [...state.accepted].filter((one) => !one.cancelled).reverse().slice(0, 20),
  }
  return { review, parts, view, state, byId, fresh }
}

/** The group of a change, itself included. */
function membersOf(changes: readonly Proposal[], one: Proposal): Proposal[] {
  return one.group ? changes.filter((c) => c.group === one.group) : [one]
}

function record(ctx: Ctx, s: State, part: Part | null, change: Proposal, hunk: Hunk | null, by: 'author' | 'auto'): void {
  const text = part?.text ?? ''
  s.accepted.push({
    n: s.next++,
    id: change.id,
    kind: change.kind === 'disk' || change.kind === 'new' || change.kind === 'deleted' ? change.kind : 'disk',
    file: change.file,
    old: (hunk?.oldText ?? '').slice(0, KEEP_TEXT),
    new: (hunk?.newText ?? '').slice(0, KEEP_TEXT),
    before: hunk ? text.slice(Math.max(0, hunk.newFrom - 40), hunk.newFrom) : '',
    after: hunk ? text.slice(hunk.newTo, hunk.newTo + 40) : '',
    why: change.why,
    at: Date.now(),
    by,
    ...(change.adjusted ? { adjusted: true } : {}),
  })
}

/** Write the baseline of one file forward. */
function setBase(ctx: Ctx, c: Computed, part: Part, text: string): boolean {
  const out = part.crlf ? text.replace(/\r\n/g, '\n') : text
  if (c.view) return stageText(ctx.dir, c.view, part.file, out, part.mode)
  keepSnapshot(ctx.project, ctx.epic, part.file, out)
  return true
}

/**
 * Accept these changes (already a whole group): the baseline moves forward
 * over each hunk, in git by staging. Returns how many.
 */
function acceptMembers(ctx: Ctx, c: Computed, members: readonly Proposal[], by: 'author' | 'auto'): { ok: true; count: number } | { ok: false; why: string } {
  const perFile = new Map<string, { part: Part; hunks: Hunk[] }>()
  for (const one of members) {
    if (one.kind === 'new') {
      if (!c.view || !stageFile(ctx.dir, c.view, one.file)) return { ok: false, why: `git would not add ${one.file}.` }
      record(ctx, c.state, null, one, null, by)
      continue
    }
    if (one.kind === 'deleted') {
      if (!c.view || !unstageFile(ctx.dir, c.view, one.file)) return { ok: false, why: `git would not stage the deletion of ${one.file}.` }
      record(ctx, c.state, null, one, null, by)
      continue
    }
    const found = c.byId.get(one.id)
    if (!found) return { ok: false, why: 'That change is no longer there.' }
    const at = perFile.get(one.file) ?? { part: found.part, hunks: [] }
    at.hunks.push(found.hunk)
    perFile.set(one.file, at)
    record(ctx, c.state, found.part, one, found.hunk, by)
  }
  for (const { part, hunks } of perFile.values()) {
    if (!setBase(ctx, c, part, applyHunks(part.base, hunks))) return { ok: false, why: `${part.file} could not be staged.` }
  }
  keepState(ctx.project, ctx.epic)
  return { ok: true, count: members.length }
}

/**
 * Compute what is reviewable now. Under Auto accept, changes first seen after
 * it was turned on are accepted as they are found (the baseline moves; nothing
 * is written to the paper) and listed in `accepted`.
 */
export function reviewOf(ctx: Ctx): Review {
  const c = compute(ctx)
  const s = c.state
  if (s.auto && c.fresh.size && !c.review.readOnly) {
    const incoming = c.review.changes.filter((one) => c.fresh.has(one.id) && one.kind === 'disk')
    /* Only what ARRIVED: a group-mate that was already waiting is left for a person. */
    if (incoming.length) {
      const done = acceptMembers(ctx, c, incoming, 'auto')
      if (done.ok) return compute(ctx).review
    }
  }
  keepState(ctx.project, ctx.epic)
  return c.review
}

/** Whether this paper's baseline is git's (the index, else HEAD) rather than a snapshot kept on the machine. */
export function isGitBacked(ctx: Ctx): boolean {
  return trackedView(ctx) !== null
}

/** Accept one change and its group. The author's act. */
export function acceptChange(ctx: Ctx, id: string): { ok: true; count: number } | { ok: false; why: string } {
  const c = compute(ctx)
  const one = c.review.changes.find((m) => m.id === id)
  if (!one) return { ok: false, why: 'There is no change by that name waiting here.' }
  if (c.review.readOnly) return { ok: false, why: c.review.readOnly }
  return acceptMembers(ctx, c, membersOf(c.review.changes, one), 'author')
}

/**
 * Cancel one change and its group: the baseline text goes back into the file
 * (one atomic write per file). A new file is deleted only when `confirmed`; a
 * deleted file is written back from its baseline.
 */
export function cancelChange(ctx: Ctx, id: string, confirmed = false): { ok: true; count: number } | { ok: false; why: string; needsConfirm?: boolean } {
  const c = compute(ctx)
  const one = c.review.changes.find((m) => m.id === id)
  if (!one) return { ok: false, why: 'There is no change by that name waiting here.' }
  if (c.review.readOnly) return { ok: false, why: c.review.readOnly }
  const members = membersOf(c.review.changes, one)
  if (one.kind === 'new') {
    if (!confirmed) return { ok: false, needsConfirm: true, why: `Cancelling deletes ${one.file} from the paper. Confirm to delete it.` }
    const path = confine(ctx.dir, one.file)
    if (!path) return { ok: false, why: 'That file is not inside this paper.' }
    try {
      unlinkSync(path)
    } catch (error) {
      return { ok: false, why: `${one.file} could not be deleted: ${(error as Error).message}` }
    }
    return { ok: true, count: 1 }
  }
  if (one.kind === 'deleted') {
    if (!c.view) return { ok: false, why: 'There is no baseline to restore it from.' }
    const entry = c.view.index.get(one.file)
    const text = entry ? gitBlob(ctx.dir, entry.sha) : null
    const path = confine(ctx.dir, one.file)
    if (text === null || !path) return { ok: false, why: `${one.file} could not be read from git.` }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const scratch = `${path}.${process.pid}.tmp`
      writeFileSync(scratch, text)
      renameSync(scratch, path)
    } catch (error) {
      return { ok: false, why: `${one.file} could not be restored: ${(error as Error).message}` }
    }
    return { ok: true, count: 1 }
  }
  const byFile = new Map<string, { part: Part; hunks: Hunk[] }>()
  for (const m of members) {
    const found = c.byId.get(m.id)
    if (!found) return { ok: false, why: 'That change is no longer there.' }
    const at = byFile.get(m.file) ?? { part: found.part, hunks: [] }
    at.hunks.push(found.hunk)
    byFile.set(m.file, at)
  }
  for (const { part, hunks } of byFile.values()) {
    const edits = hunks.map((h) => {
      const from = bytesOf(part.text.slice(0, h.newFrom))
      return { from, to: from + bytesOf(h.newText), text: h.oldText }
    })
    const done = writeRanges(ctx.epic, { file: part.file, was: part.hash, edits }, ctx.project)
    if (!done.ok) return { ok: false, why: done.why }
  }
  /* The change is not forgotten as "seen": what vanishes is simply gone. */
  return { ok: true, count: members.length }
}

/** Attach (or replace) the reason of a change the paper is holding on disk. False when there is no such change. */
export function explain(ctx: Ctx, id: string, why: string): boolean {
  const c = compute(ctx)
  if (!c.review.changes.some((m) => m.id === id)) return false
  const s = c.state
  s.reasons[id] = { why, at: Date.now() }
  keepState(ctx.project, ctx.epic)
  return true
}

/** Jump to the next change after a decision: the person's setting, remembered like Auto accept. */
export function jumpOf(project: string, epic: string): boolean {
  return stateOf(project, epic).jump
}

export function setJump(ctx: Ctx, on: boolean): void {
  stateOf(ctx.project, ctx.epic).jump = on
  keepState(ctx.project, ctx.epic)
}

/** Turn Auto accept on or off. What is already waiting when it is turned on is left for a person. */
export function setAuto(ctx: Ctx, on: boolean): void {
  const c = compute(ctx)
  c.state.auto = on
  c.state.autoSince = Date.now()
  keepState(ctx.project, ctx.epic)
}

/**
 * Something wrote `file`: `before` is what it held, `after` what it holds.
 * Moves the baseline by that edit only — see `ownSave` — and, for an accepted
 * suggestion (`staged`), records it.
 */
export function afterWrite(
  ctx: Ctx,
  file: string,
  before: string,
  after: string,
  staged?: readonly { id: string; why: string; filer: string; old: string; new: string; by: 'author' | 'auto'; adjusted?: boolean }[],
): void {
  const s = stateOf(ctx.project, ctx.epic)
  const view = trackedView(ctx)
  /* Mid-merge or mid-rebase Paper stages nothing, whoever wrote. */
  if (view?.operation) {
    for (const one of staged ?? []) void one
    return
  }
  let baseText: string | null
  let mode = '100644'
  if (view) {
    const base = gitBase(ctx, view, file)
    baseText = base ? base.text : null
    if (base) mode = base.mode
  } else {
    baseText = snapshotOf(ctx.project, ctx.epic, file)
    if (baseText === null) baseText = before
  }
  if (baseText !== null) {
    const crlf = before.includes('\r\n') && !baseText.includes('\r')
    const base = crlf ? baseText.replace(/\n/g, '\r\n') : baseText
    const result = ownSave(base, before, after)
    if (result.touched.length) {
      const hunks = hunksOf(base, before)
      const ids = hunkIds(file, base, hunks)
      hunks.forEach((h, i) => {
        if (result.touched.some((t) => t.from <= h.newTo && h.newFrom <= t.to)) s.adjusted[ids[i]!] = Date.now()
      })
    }
    if (result.baseline !== base) {
      const text = crlf ? result.baseline.replace(/\r\n/g, '\n') : result.baseline
      if (view) stageText(ctx.dir, view, file, text, mode)
      else keepSnapshot(ctx.project, ctx.epic, file, text)
    }
  }
  for (const one of staged ?? []) {
    /* Found again by the words around it: where the new text now stands. */
    const at = after.indexOf(one.new)
    s.accepted.push({
      n: s.next++,
      id: one.id,
      kind: 'staged',
      file,
      old: one.old.slice(0, KEEP_TEXT),
      new: one.new.slice(0, KEEP_TEXT),
      before: at === -1 ? '' : after.slice(Math.max(0, at - 40), at),
      after: at === -1 ? '' : after.slice(at + one.new.length, at + one.new.length + 40),
      why: one.why,
      at: Date.now(),
      by: one.by,
      ...(one.adjusted ? { adjusted: true } : {}),
      filer: one.filer,
    })
  }
  keepState(ctx.project, ctx.epic)
}

/** Change a reason: remembered beside the change, keyed by its stable id. */
export function setReason(ctx: Ctx, id: string, why: string): boolean {
  const c = compute(ctx)
  const one = c.review.changes.find((m) => m.id === id)
  if (!one) return false
  if (why) c.state.reasons[id] = { why, at: Date.now() }
  else delete c.state.reasons[id]
  c.state.adjusted[id] = c.state.adjusted[id] ?? Date.now()
  keepState(ctx.project, ctx.epic)
  return true
}

/**
 * Put back what an accepted change replaced, in the file AND the baseline.
 * Found again by the words around it, because the file may have moved on.
 */
export function cancelAccepted(ctx: Ctx, n: number): { ok: true } | { ok: false; why: string } {
  const s = stateOf(ctx.project, ctx.epic)
  const one = s.accepted.find((r) => r.n === n && !r.cancelled)
  if (!one) return { ok: false, why: 'That accepted change is no longer on the list.' }
  if (one.kind === 'new' || one.kind === 'deleted') return { ok: false, why: 'A file accepted as new or deleted is answered in git, not here.' }
  const read = readText(ctx, one.file)
  if (!read) return { ok: false, why: `${one.file} could not be read.` }
  const spot = (text: string): { from: number; to: number } | null => {
    for (const [pre, post] of [[one.before, one.after], [one.before, ''], ['', one.after]] as const) {
      if (!pre && !post && one.kind !== 'disk') continue
      const needle = pre + one.new + post
      if (!needle) continue
      const first = text.indexOf(needle)
      if (first !== -1 && text.indexOf(needle, first + 1) === -1) return { from: first + pre.length, to: first + pre.length + one.new.length }
    }
    if (one.new) {
      const first = text.indexOf(one.new)
      if (first !== -1 && text.indexOf(one.new, first + 1) === -1) return { from: first, to: first + one.new.length }
    }
    return null
  }
  const at = spot(read.text)
  if (!at) return { ok: false, why: `The words around that change have been rewritten since, so it is not put back automatically: ${one.file} no longer has them to find.` }
  const from = bytesOf(read.text.slice(0, at.from))
  const done = writeRange(ctx.epic, { file: one.file, from, to: from + bytesOf(one.new), text: one.old, was: hashOf(read.bytes) }, ctx.project)
  if (!done.ok) return { ok: false, why: done.why }
  /* The baseline had taken the new words in; it gives them back too, so the
     put-back is not a change to review. Where it cannot be found there, the
     difference simply shows as an ordinary change. */
  const view = trackedView(ctx)
  let baseText: string | null = null
  let mode = '100644'
  if (view) {
    const base = gitBase(ctx, view, one.file)
    if (base) {
      baseText = base.text
      mode = base.mode
    }
  } else baseText = snapshotOf(ctx.project, ctx.epic, one.file)
  if (baseText !== null) {
    const crlf = read.text.includes('\r\n') && !baseText.includes('\r')
    const base = crlf ? baseText.replace(/\n/g, '\r\n') : baseText
    const where = spot(base)
    if (where) {
      const next = base.slice(0, where.from) + one.old + base.slice(where.to)
      const out = crlf ? next.replace(/\r\n/g, '\n') : next
      if (view) stageText(ctx.dir, view, one.file, out, mode)
      else keepSnapshot(ctx.project, ctx.epic, one.file, out)
    }
  }
  one.cancelled = true
  keepState(ctx.project, ctx.epic)
  return { ok: true }
}

/** Accepted changes not yet in a commit, oldest first (not those cancelled since). */
export function acceptedSinceCommit(project: string, epic: string): Accepted[] {
  return stateOf(project, epic).accepted.filter((r) => !r.committed && !r.cancelled)
}

/** A commit was made: what was accepted until now is in it. */
export function markCommitted(project: string, epic: string): void {
  const s = stateOf(project, epic)
  for (const one of s.accepted) one.committed = true
  keepState(project, epic)
}

/** Forget what is held in memory: a restart, or a test. What is on the machine stays. */
export function restartReview(): void {
  diffs.clear()
  states.clear()
  snapshots.clear()
}

/** Forget everything of one paper, in memory and on the machine (tests). */
export function forgetReview(project: string, epic: string): void {
  states.delete(keyOf(project, epic))
  snapshots.delete(keyOf(project, epic))
  removeState(paperState(project, epic))
}
