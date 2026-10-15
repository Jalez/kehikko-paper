import { createHash } from 'node:crypto'

import { tokenize } from './diff.ts'

/**
 * Where two versions of a file differ, as the places a person reviews.
 *
 * Pure, with no filesystem, so that "what changed", "what an own save does to
 * the baseline" and "what Cancel puts back" are tests and not paragraphs.
 *
 * Offsets are UTF-16 units into the strings given; `review.ts` converts to the
 * bytes the write path names.
 *
 * ## Blocks are lines, hunks are blocks tightened to words
 *
 * A LaTeX paragraph is often one line of a thousand characters, so a line is
 * the right unit to find WHERE two files differ (cheap, and an anchor of equal
 * lines is a strong one) and the wrong unit to SHOW: a block is tightened by
 * the words both sides share at its front and its back, so one changed word in
 * a long line is one changed word on screen.
 */

export interface Block {
  oldFrom: number
  oldTo: number
  newFrom: number
  newTo: number
}

/** Above this many line pairs the table costs more than the nuance is worth: one block, between the shared front and back. */
const MAX_CELLS = 4_000_000

function lines(text: string): { starts: number[]; keys: string[] } {
  const starts: number[] = []
  const keys: string[] = []
  let at = 0
  while (at < text.length) {
    const next = text.indexOf('\n', at)
    const end = next === -1 ? text.length : next + 1
    starts.push(at)
    keys.push(text.slice(at, end))
    at = end
  }
  starts.push(text.length)
  return { starts, keys }
}

/** The line-aligned stretches that differ, in order, as offsets into each text. */
export function diffBlocks(oldText: string, newText: string): Block[] {
  if (oldText === newText) return []
  const a = lines(oldText)
  const b = lines(newText)
  const n = a.keys.length
  const m = b.keys.length
  let front = 0
  while (front < n && front < m && a.keys[front] === b.keys[front]) front++
  let back = 0
  while (back < n - front && back < m - front && a.keys[n - 1 - back] === b.keys[m - 1 - back]) back++
  const an = n - front - back
  const bn = m - front - back
  const out: Block[] = []
  const push = (ai: number, aj: number, bi: number, bj: number) => {
    out.push({ oldFrom: a.starts[ai]!, oldTo: a.starts[aj]!, newFrom: b.starts[bi]!, newTo: b.starts[bj]! })
  }
  if (an === 0 || bn === 0 || an * bn > MAX_CELLS) {
    push(front, front + an, front, front + bn)
    return out
  }
  /* LCS over the lines between the shared front and back. */
  const cols = bn + 1
  const table = new Uint32Array((an + 1) * cols)
  for (let i = an - 1; i >= 0; i--) {
    for (let j = bn - 1; j >= 0; j--) {
      table[i * cols + j] =
        a.keys[front + i] === b.keys[front + j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  let openA = -1
  let openB = -1
  const close = () => {
    if (openA === -1) return
    push(front + openA, front + i, front + openB, front + j)
    openA = -1
    openB = -1
  }
  while (i < an || j < bn) {
    if (i < an && j < bn && a.keys[front + i] === b.keys[front + j]) {
      close()
      i++
      j++
    } else {
      if (openA === -1) {
        openA = i
        openB = j
      }
      if (j >= bn || (i < an && table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!)) i++
      else j++
    }
  }
  close()
  return out
}

export interface Hunk extends Block {
  oldText: string
  newText: string
}

/** A block with the words both sides share at its front and back set aside. */
function tighten(oldText: string, newText: string, block: Block): Hunk {
  const a = oldText.slice(block.oldFrom, block.oldTo)
  const b = newText.slice(block.newFrom, block.newTo)
  const ta = tokenize(a)
  const tb = tokenize(b)
  let front = 0
  while (front < ta.length && front < tb.length && ta[front] === tb[front]) front++
  let back = 0
  while (back < ta.length - front && back < tb.length - front && ta[ta.length - 1 - back] === tb[tb.length - 1 - back]) back++
  const width = (tokens: string[], from: number, to: number) => tokens.slice(from, to).reduce((sum, one) => sum + one.length, 0)
  const lead = width(ta, 0, front)
  const tail = width(ta, ta.length - back, ta.length)
  const oldFrom = block.oldFrom + lead
  const oldTo = block.oldTo - tail
  const newFrom = block.newFrom + width(tb, 0, front)
  const newTo = block.newTo - width(tb, tb.length - back, tb.length)
  return { oldFrom, oldTo, newFrom, newTo, oldText: oldText.slice(oldFrom, oldTo), newText: newText.slice(newFrom, newTo) }
}

/** What differs between a baseline and a text, as hunks a person can read. */
export function hunksOf(baseline: string, text: string): Hunk[] {
  return diffBlocks(baseline, text)
    .map((block) => tighten(baseline, text, block))
    .filter((one) => one.oldText !== one.newText)
}

/** `text` with the given hunks undone: each `new` range back to its `old` text. */
export function revert(text: string, hunks: readonly Hunk[]): string {
  let out = text
  for (const one of [...hunks].sort((x, y) => y.newFrom - x.newFrom)) out = out.slice(0, one.newFrom) + one.oldText + out.slice(one.newTo)
  return out
}

/** `baseline` with the given hunks taken in: each `old` range replaced by its `new` text. */
export function accept(baseline: string, hunks: readonly Hunk[]): string {
  let out = baseline
  for (const one of [...hunks].sort((x, y) => y.oldFrom - x.oldFrom)) out = out.slice(0, one.oldFrom) + one.newText + out.slice(one.oldTo)
  return out
}

/**
 * A hunk's name, the same across re-reads and across the author editing the
 * new text in place: it is made from the BASELINE side only — the file, the
 * words before the place in the baseline, and the words being replaced — and
 * from how many hunks before it share that. Never from the new text and never
 * from a position, so a reason written beside a change survives both.
 */
export function hunkIds(file: string, baseline: string, hunks: readonly Hunk[]): string[] {
  const seen = new Map<string, number>()
  return hunks.map((one) => {
    const before = baseline.slice(Math.max(0, one.oldFrom - 40), one.oldFrom)
    const base = createHash('sha256').update(`${file}\0${before}\0${one.oldText}`).digest('hex').slice(0, 12)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? `d-${base}` : `d-${base}-${n}`
  })
}

/**
 * Which hunks are one change to review: those in the same paragraph (no blank
 * line between them in the new text), and — when `times` says when each was
 * first seen — those that arrived within `window` ms of one another, which is
 * one agent edit and not forty. Answers a group index per hunk, in order.
 */
export function grouping(text: string, hunks: readonly Hunk[], times?: readonly number[], window = 3000): number[] {
  const out: number[] = []
  let group = -1
  for (let i = 0; i < hunks.length; i++) {
    const here = hunks[i]!
    const prev = hunks[i - 1]
    let joined = false
    if (prev) {
      const between = text.slice(prev.newTo, here.newFrom)
      joined = !/\n[ \t]*\n/.test(between)
      if (!joined && times && Math.abs(times[i]! - times[i - 1]!) <= window) joined = true
    }
    if (!joined) group++
    out.push(group)
  }
  return out
}

/**
 * What an own save does to the baseline: the author's edit operations laid
 * over it, and nothing else.
 *
 * `baseline` is what the file is compared with, `disk` is the file as the
 * author's editor last read it, `next` is what the author saved. Foreign
 * changes are the differences between baseline and disk; the author's are the
 * differences between disk and next. An author's block that lies clear of every
 * foreign block is carried into the baseline at the matching place. One that
 * touches a foreign block is NOT: the baseline keeps its text there, so the
 * foreign change stays reviewable (now including what the author typed in it),
 * and the block is reported in `touched` (as a range of `disk`) so the page can
 * mark the change adjusted.
 */
export function ownSave(baseline: string, disk: string, next: string): { baseline: string; touched: { from: number; to: number }[] } {
  if (baseline === disk) return { baseline: next, touched: [] }
  const foreign = diffBlocks(baseline, disk)
  const mine = diffBlocks(disk, next)
  const touched: { from: number; to: number }[] = []
  /* Disk offset -> baseline offset, for a place outside every foreign block. */
  const toBaseline = (at: number): number => {
    let shift = 0
    for (const f of foreign) {
      if (f.newTo <= at) shift += f.oldTo - f.oldFrom - (f.newTo - f.newFrom)
    }
    return at + shift
  }
  const clash = (m: Block, f: Block): boolean => {
    const mZero = m.oldFrom === m.oldTo
    const fZero = f.newFrom === f.newTo
    if (mZero && fZero) return m.oldFrom === f.newFrom
    if (mZero) return f.newFrom < m.oldFrom && m.oldFrom < f.newTo
    if (fZero) return m.oldFrom < f.newFrom && f.newFrom < m.oldTo
    return m.oldFrom < f.newTo && f.newFrom < m.oldTo
  }
  const carried: { from: number; to: number; text: string }[] = []
  for (const m of mine) {
    const hit = foreign.find((f) => clash(m, f))
    if (hit) {
      touched.push({ from: Math.min(m.oldFrom, hit.newFrom), to: Math.max(m.oldTo, hit.newTo) })
      continue
    }
    carried.push({ from: toBaseline(m.oldFrom), to: toBaseline(m.oldTo), text: next.slice(m.newFrom, m.newTo) })
  }
  let out = baseline
  for (const one of carried.sort((x, y) => y.from - x.from)) out = out.slice(0, one.from) + one.text + out.slice(one.to)
  return { baseline: out, touched }
}
