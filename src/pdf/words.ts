/**
 * The runs of text a PDF page is made of, and the word under a press.
 *
 * ## Which way this file goes
 *
 * From the PDF to the source. SyncTeX answers a press on the page with a
 * source LINE — see the essay at the top of `compile/synctex.ts` — and a PDF
 * carries its text, which pdf.js hands over as runs with positions. So the
 * word that was pressed is read off the page (`wordAt`) and looked for in the
 * line SyncTeX named (`placeWord`), and the caret lands on the word rather
 * than at the start of its line. When the word is not found — maths, a macro
 * that prints something other than its argument — the line stands.
 *
 * The other way, from a passage of source to where it is printed, is
 * `find.ts`: it reads the same runs.
 *
 * Pure. The runs are passed in, in PDF points from the TOP-left, already
 * flipped by the caller, so no pdf.js type reaches this file.
 */

/** One run of text on a page: where it is and what it says. */
export interface Run {
  x: number
  /** Top edge. */
  y: number
  w: number
  h: number
  text: string
  /**
   * Where each character of `text` begins, measured from the run's left edge,
   * and where the last one ends: `text.length + 1` offsets. Present when the
   * caller could measure the run in the font it is printed in — which it may do
   * after the run was first read; absent, an edge is found by proportion along
   * the run. See `edge`.
   */
  xs?: readonly number[]
}

/**
 * The word under a point.
 *
 * A run is a string and a width, not a list of glyph positions, so the
 * character under the point is found by PROPORTION along the run. That is
 * exact in a monospaced font and within a character or two in a proportional
 * one, which is why the answer is widened to the whole word: a word is a
 * target several characters wide.
 */
export function wordAt(runs: readonly Run[], x: number, y: number): string | null {
  for (const run of runs) {
    if (!run.text.trim() || run.w <= 0) continue
    if (x < run.x || x > run.x + run.w || y < run.y - 1 || y > run.y + run.h + 1) continue
    const at = charAt(run, x)
    if (!isWord(run.text[at]!)) return null
    let from = at
    let to = at + 1
    while (from > 0 && isWord(run.text[from - 1]!)) from -= 1
    while (to < run.text.length && isWord(run.text[to]!)) to += 1
    const word = run.text.slice(from, to)
    return word.length >= 2 ? word : null
  }
  return null
}

/** Whether a run carries measured offsets that can be trusted: one per character and one more. */
function measured(run: Run): run is Run & { xs: readonly number[] } {
  return run.xs !== undefined && run.xs.length === run.text.length + 1
}

/**
 * The left edge of character `index` of a run — or, at `text.length`, the
 * right edge of the last one.
 *
 * Measured when the run was (`xs`), and by proportion when it was not. The
 * difference is the whole of how good a mark's ends look: by proportion, on a
 * justified line in a proportional font, "chatbots" was marked from the "n" of
 * the word before it to the "an" of the word after.
 */
export function edge(run: Run, index: number): number {
  if (measured(run)) return run.x + run.xs[index]!
  return run.x + (index / run.text.length) * run.w
}

/** The character of a run under `x`. */
function charAt(run: Run, x: number): number {
  const last = run.text.length - 1
  if (!measured(run)) return Math.min(last, Math.max(0, Math.floor(((x - run.x) / run.w) * run.text.length)))
  let at = 0
  while (at < last && run.xs[at + 1]! <= x - run.x) at += 1
  return at
}

function isWord(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch)
}

/**
 * Where a word printed in the PDF is in the source, near the line SyncTeX named.
 *
 * `lines` are source lines around the named one and `named` is its index among
 * them. The named line is tried first, then its neighbours outward, because
 * SyncTeX's line is the line the word's trailing SPACE was typed on — and for
 * the last word of a source line that space is the line break, which TeX has
 * sometimes already counted as the next line.
 *
 * Refuses a word that occurs twice on the line it is found on: there is no
 * telling which was clicked, and the start of the line is a better answer than
 * a coin toss.
 */
export function placeWord(lines: readonly string[], named: number, word: string): { line: number; column: number } | null {
  const order = [named]
  for (let away = 1; away < lines.length; away += 1) {
    if (named + away < lines.length) order.push(named + away)
    if (named - away >= 0) order.push(named - away)
  }
  for (const index of order) {
    const text = lines[index]
    if (text === undefined) continue
    const first = find(text, word, 0)
    if (first === -1) continue
    if (find(text, word, first + 1) !== -1) return null
    return { line: index, column: first }
  }
  return null
}

/** `word` in `text` as a whole word, from `from`. */
function find(text: string, word: string, from: number): number {
  for (let at = text.indexOf(word, from); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = at === 0 ? '' : text[at - 1]!
    const after = text[at + word.length] ?? ''
    if ((before === '' || !isWord(before)) && (after === '' || !isWord(after))) return at
  }
  return -1
}

/**
 * A stretch of source, carried out to the ends of the words it begins and ends
 * in. A change is often a few letters of a word — `focus` in `focused` — and
 * a mark two letters wide is one nobody sees.
 */
export function wholeWords(text: string, from: number, to: number): { from: number; to: number } {
  const letter = /[\p{L}\p{N}]/u
  while (from > 0 && letter.test(text[from - 1]!)) from -= 1
  while (to < text.length && letter.test(text[to]!)) to += 1
  return { from, to }
}
