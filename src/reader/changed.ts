import type { Paper, PlacedBlock } from '../../store.ts'
import { plain } from './segments.tsx'

/**
 * A paper that changed on disk while the page was showing it, drawn as the
 * difference rather than replaced.
 *
 * ## The page keeps its reading on purpose
 *
 * Nothing on the server is cached: `readPaper` opens the files every time, and
 * a reload shows the sentence the author just wrote. The PAGE, though, holds
 * the paper it read — every offset on screen, every hash it will send with an
 * edit, is about that reading — and it re-reads only when its own write lands
 * or the epic changes. So when the `.tex` moves under it from outside (an
 * editor's autosave, a `git merge`, a checkout) the page goes on showing what
 * it read, indefinitely, with nothing on screen saying so. Every write it then
 * tries is refused as stale, correctly, and the reader is told the file has
 * changed without being shown how.
 *
 * The obvious fix — refetch whenever the hashes differ — was refused by the
 * owner, and for a good reason: a reading that is held still is a reading
 * that can be COMPARED. Somebody watching an agent rewrite a chapter, or
 * pulling a co-author's branch, wants to see what moved, where, against the
 * prose they had in front of them. A page that silently became the new
 * version would have thrown that away in the name of being current.
 *
 * So the page learns that a file moved (`changedFiles`, against the hashes the
 * standing poll now carries), fetches the paper as it now is, and draws the
 * two together (`compare`): what is gone in red and struck through, what is
 * new in green, in the place it happens, with the unchanged prose either side
 * of it intact. The reading it holds is replaced only when the reader presses
 * the one control that says so, in `paginated.tsx`.
 *
 * ## The granularity, and why it is two-level
 *
 * The unit the reader works in is the BLOCK — a paragraph, a heading, a list,
 * a figure — because that is the unit `paginate` lays out and the unit every
 * span's offsets are relative to. So the first comparison is a longest common
 * subsequence over blocks, file by file, with a block identified by its kind
 * and its rendered text. That alone answers "which paragraphs were added,
 * which removed" and it answers a whole-chapter rewrite as many rows rather
 * than one: every paragraph the author kept is a common element, and the
 * rewritten ones fall between them.
 *
 * It answers a one-word correction badly, as a paragraph removed and a
 * near-identical one added, which is true and unreadable. So a second pass
 * pairs a removed paragraph with an added one where the two plainly share
 * most of their words (`similar`), and draws that pair as ONE paragraph with
 * the words that differ marked — through the same `diffWords` a suggested
 * change is drawn with, so a change from outside reads exactly like a change
 * an agent proposed. Sentence-level LCS was considered between the two and
 * not added: `diffWords` is an LCS over tokens and already keeps every
 * unchanged run of words as prose, so a sentence rewritten in the middle of a
 * paragraph comes out as that sentence in red and green and nothing else. A
 * paragraph too long for its table falls back, inside `diffWords`, to whole-
 * paragraph red and green, which is the right way for a picture to degrade.
 *
 * ## Pure, and in the reader
 *
 * Nothing here knows about the wire or the fetch. `use-paper.ts` decides WHEN
 * to ask and holds both readings; `app.tsx` hands them here; the view draws
 * what comes back. That keeps this the thing a test can state without a
 * browser: which rows come out, in which order, marked how.
 */

/**
 * The files the page is showing that are not, on disk, what it read.
 *
 * `held` is `Paper.hashes` off the reading on screen and `now` is the same map
 * as the server hashed it a moment ago. A file in `held` that is missing from
 * `now` has gone from the paper — deleted, or no longer `\include`d — and that
 * is a change to hear about. A file in `now` that `held` never had is a
 * chapter added since the read, and it is reported too, because the paper on
 * screen is missing it. A `now` of `null` is a paper that is not there at all
 * any more, and every held file is then a changed one.
 */
export function changedFiles(held: Record<string, string>, now: Record<string, string> | null): string[] {
  const out: string[] = []
  for (const file of Object.keys(held)) if (now === null || now[file] !== held[file]) out.push(file)
  if (now !== null) for (const file of Object.keys(now)) if (!(file in held)) out.push(file)
  return out
}

/**
 * One string that names a whole hash map, so "have I already fetched the
 * paper for THIS state of the disk" is a comparison and not a search. Sorted,
 * because two answers about the same files in a different order are the same
 * answer.
 */
export function fingerprint(hashes: Record<string, string> | null): string {
  if (hashes === null) return ''
  return Object.keys(hashes)
    .sort()
    .map((file) => `${file}=${hashes[file]}`)
    .join('\n')
}

/** What happened to one block of the reading, as far as the disk is concerned. */
export type BlockChange =
  /** In the reading and not on disk any more. Drawn struck through, in red. */
  | { at: 'gone' }
  /** On disk and not in the reading. Drawn underlined, in green. */
  | { at: 'new' }
  /**
   * The same paragraph, reworded. `was` and `now` are its rendered text
   * before and after, for `diffWords` to draw the difference inside it.
   */
  | { at: 'changed'; was: string; now: string }

export interface Comparison {
  /** Which files differ, in the paper's own order, for the control to name. */
  files: string[]
  /**
   * The blocks to lay out: the reading's, with what is gone left in place and
   * what is new put where it arrives. A block that is unchanged, gone or
   * reworded is the READING's block object, so its offsets are the ones every
   * pending suggestion and every anchor on the page was measured against; a
   * new block is the disk's, with its id suffixed so it cannot collide with a
   * block of the reading in the same file.
   */
  blocks: PlacedBlock[]
  /** What happened to each block in `blocks` that is not simply unchanged. */
  changes: Map<PlacedBlock, BlockChange>
  /** How many rows of each kind, for the sentence beside the control. */
  counts: { gone: number; new: number; changed: number }
}

/**
 * Above this many block pairs the table costs more than the nuance is worth,
 * and the middle of that file is drawn as everything-gone, everything-new.
 * The common prefix and suffix are trimmed first, so this is reached only by
 * a file whose middle was rewritten wholesale — which is exactly the case
 * where that picture is true.
 */
const MAX_CELLS = 250_000

/**
 * How much of their vocabulary two paragraphs must share to be drawn as one
 * reworded paragraph rather than as one removed and one added.
 *
 * A Dice coefficient over word tokens: a paragraph with one sentence of five
 * rewritten shares well over half its words with itself; a paragraph replaced
 * by a different argument shares the articles and little else. The threshold
 * is a judgement, and it is set low rather than high because the cost of a
 * wrong pairing is a paragraph drawn as mostly red and green — which is what
 * two unrelated paragraphs drawn separately would have looked like anyway —
 * while the cost of a missed pairing is a corrected typo drawn as a whole
 * paragraph removed and put back.
 */
const SIMILAR_ENOUGH = 0.35

/**
 * The two readings, laid over each other.
 *
 * File by file, in the reading's own order, with a file the disk has and the
 * reading has not placed after the file that precedes it on disk. A file
 * whose hash did not move contributes its blocks unchanged without being
 * compared at all, which is what keeps this cheap on a fifty-page thesis
 * whose author saved one chapter.
 */
export function compare(held: Paper, now: Paper): Comparison {
  const moved = new Set(changedFiles(held.hashes, now.hashes))
  const order = fileOrder(held.files, now.files)

  const blocks: PlacedBlock[] = []
  const changes = new Map<PlacedBlock, BlockChange>()
  const counts = { gone: 0, new: 0, changed: 0 }

  for (const file of order) {
    const before = held.blocks.filter((b) => b.file === file)
    if (!moved.has(file)) {
      blocks.push(...before)
      continue
    }
    const after = now.blocks.filter((b) => b.file === file)
    for (const row of diffBlocks(before, after)) {
      if (row.at === 'same') {
        blocks.push(row.block)
        continue
      }
      if (row.at === 'gone') {
        blocks.push(row.block)
        changes.set(row.block, { at: 'gone' })
        counts.gone += 1
        continue
      }
      if (row.at === 'new') {
        /* A clone with a suffixed id, so the key the sheet builds from
           `file#id` and the anchor `anchorId` builds from it cannot collide
           with a block of the reading numbered the same way. Nothing links to
           a block that is not yet in the reading, so nothing loses the id. */
        const block = { ...row.block, id: `${row.block.id}~new` } as PlacedBlock
        blocks.push(block)
        changes.set(block, { at: 'new' })
        counts.new += 1
        continue
      }
      blocks.push(row.block)
      changes.set(row.block, { at: 'changed', was: row.was, now: row.now })
      counts.changed += 1
    }
  }

  return { files: order.filter((file) => moved.has(file)), blocks, changes, counts }
}

/**
 * The reading's file order, with the disk's new files slotted in after the
 * file that precedes each of them on disk — or at the front, for a chapter
 * the author put first.
 */
function fileOrder(held: readonly string[], now: readonly string[]): string[] {
  const out = [...held]
  for (let i = 0; i < now.length; i += 1) {
    const file = now[i]!
    if (out.includes(file)) continue
    const previous = i > 0 ? now[i - 1]! : null
    const at = previous === null ? -1 : out.indexOf(previous)
    out.splice(at + 1, 0, file)
  }
  return out
}

type Row =
  | { at: 'same'; block: PlacedBlock }
  | { at: 'gone'; block: PlacedBlock }
  | { at: 'new'; block: PlacedBlock }
  | { at: 'changed'; block: PlacedBlock; was: string; now: string }

/**
 * One file's blocks, before and after, as rows in reading order.
 *
 * Common prefix and suffix first, because almost every real change is in one
 * place and the table should be the size of that place rather than of the
 * chapter. Then an LCS over what is left, and then `pairUp` over each run of
 * removed-and-added rows.
 */
export function diffBlocks(before: readonly PlacedBlock[], after: readonly PlacedBlock[]): Row[] {
  const a = before.map(signature)
  const b = after.map(signature)

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1
  }

  const rows: Row[] = []
  for (let i = 0; i < head; i += 1) rows.push({ at: 'same', block: before[i]! })

  const midA = before.slice(head, before.length - tail)
  const midB = after.slice(head, after.length - tail)
  const keysA = a.slice(head, a.length - tail)
  const keysB = b.slice(head, b.length - tail)

  /* The middle, as a sequence of ops. Past the bound the whole middle is one
     hunk of gone-then-new, which `pairUp` still pairs by similarity, so a
     paragraph that survived a wholesale rewrite is still found. */
  const ops: ('same' | 'gone' | 'new')[] = []
  if (keysA.length * keysB.length > MAX_CELLS) {
    for (let i = 0; i < keysA.length; i += 1) ops.push('gone')
    for (let j = 0; j < keysB.length; j += 1) ops.push('new')
  } else {
    const cols = keysB.length + 1
    const lcs = new Uint32Array((keysA.length + 1) * cols)
    for (let i = keysA.length - 1; i >= 0; i -= 1) {
      for (let j = keysB.length - 1; j >= 0; j -= 1) {
        lcs[i * cols + j] =
          keysA[i] === keysB[j]
            ? lcs[(i + 1) * cols + (j + 1)]! + 1
            : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + (j + 1)]!)
      }
    }
    let i = 0
    let j = 0
    while (i < keysA.length && j < keysB.length) {
      if (keysA[i] === keysB[j]) {
        ops.push('same')
        i += 1
        j += 1
      } else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + (j + 1)]!) {
        ops.push('gone')
        i += 1
      } else {
        ops.push('new')
        j += 1
      }
    }
    while (i < keysA.length) {
      ops.push('gone')
      i += 1
    }
    while (j < keysB.length) {
      ops.push('new')
      j += 1
    }
  }

  /* Walk the ops, gathering each maximal run of non-same rows into a hunk and
     handing the hunk to `pairUp`. */
  let i = 0
  let j = 0
  let gone: PlacedBlock[] = []
  let fresh: PlacedBlock[] = []
  const flush = () => {
    if (gone.length || fresh.length) rows.push(...pairUp(gone, fresh))
    gone = []
    fresh = []
  }
  for (const op of ops) {
    if (op === 'same') {
      flush()
      rows.push({ at: 'same', block: midA[i]! })
      i += 1
      j += 1
    } else if (op === 'gone') {
      gone.push(midA[i]!)
      i += 1
    } else {
      fresh.push(midB[j]!)
      j += 1
    }
  }
  flush()

  for (let k = before.length - tail; k < before.length; k += 1) rows.push({ at: 'same', block: before[k]! })
  return rows
}

/**
 * One hunk — the blocks that left and the blocks that arrived between two
 * unchanged ones — with the reworded paragraphs found and drawn as one.
 *
 * In order, and each removed block takes the FIRST added block after the last
 * pairing that is similar enough; the added blocks skipped on the way are
 * emitted as new before the pair, so the rows stay in the disk's order. A
 * removed block that pairs with nothing is emitted where it stood.
 */
function pairUp(gone: readonly PlacedBlock[], fresh: readonly PlacedBlock[]): Row[] {
  const rows: Row[] = []
  let next = 0
  for (const old of gone) {
    let found = -1
    for (let k = next; k < fresh.length; k += 1) {
      if (rewordable(old, fresh[k]!)) {
        found = k
        break
      }
    }
    if (found === -1) {
      rows.push({ at: 'gone', block: old })
      continue
    }
    for (let k = next; k < found; k += 1) rows.push({ at: 'new', block: fresh[k]! })
    rows.push({ at: 'changed', block: old, was: textOf(old), now: textOf(fresh[found]!) })
    next = found + 1
  }
  for (let k = next; k < fresh.length; k += 1) rows.push({ at: 'new', block: fresh[k]! })
  return rows
}

/**
 * Whether two blocks are one block, reworded.
 *
 * Only a paragraph or a heading — the two kinds drawn as prose the reader can
 * see a word change inside. A list, a caption or a table that changed is
 * drawn as the whole thing gone and the whole thing new, because a diff drawn
 * across list items would put one item's red beside another's green and
 * claim they were the same item.
 */
function rewordable(a: PlacedBlock, b: PlacedBlock): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind !== 'paragraph' && a.kind !== 'heading') return false
  return similar(textOf(a), textOf(b)) >= SIMILAR_ENOUGH
}

/** Dice's coefficient over the words of two texts: 1 for the same words, 0 for none shared. */
export function similar(a: string, b: string): number {
  const wordsA = words(a)
  const wordsB = words(b)
  if (!wordsA.length && !wordsB.length) return 1
  if (!wordsA.length || !wordsB.length) return 0
  const seen = new Map<string, number>()
  for (const w of wordsA) seen.set(w, (seen.get(w) ?? 0) + 1)
  let shared = 0
  for (const w of wordsB) {
    const left = seen.get(w) ?? 0
    if (left > 0) {
      shared += 1
      seen.set(w, left - 1)
    }
  }
  return (2 * shared) / (wordsA.length + wordsB.length)
}

function words(text: string): string[] {
  /* `\w`, as `tokenize` in `latex/diff.ts` has it and for the reason it
     gives: one opinion about what a word is, even at the cost of an accented
     word splitting at the accent. */
  return text.toLowerCase().match(/\w+/g) ?? []
}

/** What identifies a block for the LCS: its kind and the text a reader sees. */
function signature(block: PlacedBlock): string {
  return `${block.kind}\0${textOf(block)}`
}

/**
 * The text of a block as the reader sees it, for comparing and for drawing.
 *
 * Rendered text and not source: `plain` reads the segments after every
 * citation and reference has been resolved, so a `\ref` whose chapter number
 * moved because a chapter was inserted above it is a changed paragraph here,
 * which is what the reader would see change on the page.
 */
export function textOf(block: PlacedBlock): string {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
      return plain(block.segments)
    case 'list':
      return block.items.map(plain).join(' • ')
    case 'figure':
      return `${block.graphics.join(', ')} ${plain(block.caption)}`.trim()
    case 'table':
      return `${block.raw} ${plain(block.caption)}`.trim()
    case 'comment':
      return block.text
    case 'equation':
      return block.latex
    case 'verbatim':
    case 'unknown':
    case 'preamble':
      return block.raw
    case 'include':
      return block.target
    case 'structure':
      return block.command
  }
}
