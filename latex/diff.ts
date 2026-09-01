/**
 * The change inside a proposed edit, expressed as something a page can draw in
 * green and red.
 *
 * ## Two granularities, for two different jobs, and neither is the other's
 *
 * There are two places a proposal gets narrowed, and it is worth being plain
 * that they are not the same operation done twice.
 *
 * `narrow` in `edit.ts` decides WHICH BYTES ARE REPLACED, and it works at the
 * character level for a reason it argues at length: every note and every
 * passage anchored inside a replaced range has nowhere honest to go, so
 * rewriting a whole sentence because one letter moved puts every anchor in that
 * sentence into the blast radius for nothing. Minimal damage means a minimal
 * range, and a minimal range means characters.
 *
 * This file decides WHAT THE READER SEES, and a character-level diff is the
 * wrong answer to that question. "the market" becoming "the farm" is minimally
 * `mark` kept with `et` removed and `rm` added — technically true, and it draws
 * as `ma` `<del>rk</del>` `<ins>r</ins>` `m`, which nobody can read. The prior
 * art in the thesis workbench worked this out the same way and its conclusion
 * is carried over: tokens, so a changed word reads as a changed word.
 *
 * So the file on disk changes by as little as possible, and the picture of the
 * change is drawn at the size a person reads. There is no contradiction in that
 * and there is no third place either of them is decided.
 *
 * ## The LaTeX-aware tokenizer is deliberately NOT carried over
 *
 * The prior art's `tokenize` kept `\autocite{a,b}` together as one token, and
 * the argument for it was exact: split into a command, a brace and two keys, a
 * diff can cut between them, and half a citation cannot be rendered at all.
 *
 * That argument does not reach this module, because a proposal here can never
 * contain one. `sourceRefuses` in `edit.ts` refuses any range whose EXISTING
 * bytes hold a LaTeX special, and `whyNot` refuses any replacement that holds
 * one — so by the time a proposal is stored, both sides of the diff are prose
 * with no `\`, no `{`, no `$` and no `%` anywhere in them. A branch for a
 * command would be a branch that cannot fire, and dead code that looks like a
 * guarantee is worse than no code: the next person reads it as the reason
 * citations are safe here, when the real reason is two doors away.
 *
 * If that guarantee is ever relaxed, this is the file that has to grow the
 * branch back, and the prior art has it written down.
 */

export type DiffOpType = 'equal' | 'removed' | 'added'

export interface DiffOp {
  type: DiffOpType
  text: string
}

/**
 * Prose, in the units a reader compares it in: words, runs of whitespace, and
 * single characters for everything else.
 *
 * Punctuation is one token each rather than being glued to the word before it,
 * so a comma that moved is a comma that moved rather than a whole word
 * rewritten. Whitespace is its own token so that the join between two words
 * survives the diff intact — a diff that swallowed the space would draw two
 * words run together, which reads as a typo the proposal did not contain.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (/\s/.test(c)) {
      let j = i
      while (j < text.length && /\s/.test(text[j]!)) j++
      out.push(text.slice(i, j))
      i = j
      continue
    }
    /* `\w` and not a Unicode letter class, matching every other piece of
       arithmetic in this family. What it costs is that an accented word splits
       at the accent — `päivä` comes out as three tokens — which makes the diff
       of such a word finer than it needs to be and never makes it wrong. What a
       Unicode class would cost is a second opinion about what a word is, in a
       codebase where `bytesOf` is spelled the same way four times on purpose. */
    if (/\w/.test(c)) {
      let j = i
      while (j < text.length && /\w/.test(text[j]!)) j++
      out.push(text.slice(i, j))
      i = j
      continue
    }
    out.push(c)
    i++
  }
  return out
}

/**
 * Above this many token pairs the table costs more than the nuance is worth.
 *
 * A proposal is bounded at `MAX_EDIT_BYTES` on each side, so the worst case is
 * real but small; this is the floor under it rather than a limit anybody is
 * expected to meet. Past it the answer is still TRUE — the whole of one side
 * removed and the whole of the other added — just less specific, which is the
 * right way for a picture to degrade.
 */
const MAX_CELLS = 400_000

/**
 * The smallest set of token moves that turns `before` into `after`.
 *
 * A longest-common-subsequence walk, which is the textbook answer and the right
 * one at this size. What matters more than the algorithm is `merge` at the end:
 * eleven consecutive removed tokens are ONE thing that was removed, and
 * emitting eleven adjacent `<del>` elements would draw eleven separate red
 * boxes through the middle of one sentence.
 */
export function diffWords(before: string, after: string): DiffOp[] {
  if (before === after) return before ? [{ type: 'equal', text: before }] : []
  if (!before) return [{ type: 'added', text: after }]
  if (!after) return [{ type: 'removed', text: before }]

  const a = tokenize(before)
  const b = tokenize(after)

  if (a.length * b.length > MAX_CELLS) {
    return merge([
      { type: 'removed', text: before },
      { type: 'added', text: after },
    ])
  }

  const cols = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * cols)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + (j + 1)]! + 1
          : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + (j + 1)]!)
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i]! })
      i++
      j++
    } else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + (j + 1)]!) {
      ops.push({ type: 'removed', text: a[i]! })
      i++
    } else {
      ops.push({ type: 'added', text: b[j]! })
      j++
    }
  }
  while (i < a.length) ops.push({ type: 'removed', text: a[i++]! })
  while (j < b.length) ops.push({ type: 'added', text: b[j++]! })

  return merge(ops)
}

/** Runs of the same kind read as one change, not as a list of tokens. */
function merge(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = []
  for (const op of ops) {
    if (!op.text) continue
    const last = out[out.length - 1]
    if (last && last.type === op.type) last.text += op.text
    else out.push({ ...op })
  }
  return out
}
