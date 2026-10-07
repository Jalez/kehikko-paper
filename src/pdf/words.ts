/**
 * Finer than a line, by reading the PDF's own words.
 *
 * ## What SyncTeX leaves on the table
 *
 * SyncTeX answers in lines — see the essay at the top of `compile/synctex.ts`.
 * A click on the eleventh word of a paragraph gets the source line that word
 * is on, and a selection of three words gets the stretch of the printed line
 * that their whole source line produced. Both are right and both are coarser
 * than what the person did.
 *
 * A PDF carries its text, and pdf.js hands it over as runs with positions. So
 * the last step is done by MATCHING: the word that was clicked is looked for in
 * the source line SyncTeX named, and the first and last words of a selection
 * are looked for in the printed lines SyncTeX named. When a match is found the
 * answer is tightened to it; when it is not — maths, a macro that prints
 * something other than its argument, a word hyphenated across two lines, a
 * ligature the font maps oddly — the SyncTeX answer stands as it was. Nothing
 * here can make an answer worse than the line.
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
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
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
    const at = Math.min(run.text.length - 1, Math.max(0, Math.floor(((x - run.x) / run.w) * run.text.length)))
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
 * The words of a piece of source that will be printed as themselves.
 *
 * Commands, their optional arguments, maths and comments are dropped, because
 * none of them prints as what is typed. What is left is not the rendered text —
 * `\cite{knuth}` prints `[1]` and that is gone entirely — it is only a list of
 * words safe to LOOK FOR.
 */
export function printedWords(source: string): string[] {
  const plain = source
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\(?:cite|ref|label|autoref|eqref|cref|Cref|pageref|input|include|includegraphics|usepackage|bibliography|bibliographystyle|begin|end)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/\\./g, ' ')
  return plain.match(/[\p{L}\p{N}]{3,}/gu) ?? []
}

/**
 * Narrow SyncTeX's rectangles to the words that were selected.
 *
 * Only the two ENDS are moved: the first rectangle's left edge to the first
 * selected word, the last rectangle's right edge to the end of the last one.
 * Rectangles in between are whole printed lines of the selection and are
 * already right. An end whose word is not found in the runs under its
 * rectangle — it was hyphenated, or it is maths, or the selection starts in a
 * command — is left where SyncTeX put it.
 */
export function tighten(rects: readonly Box[], runs: readonly Run[], source: string): Box[] {
  const out = rects.map((rect) => ({ ...rect }))
  const words = printedWords(source)
  if (!out.length || !words.length) return out

  const first = out[0]!
  const start = spanOf(runs, first, words[0]!, 'first')
  if (start) {
    const right = first.x + first.w
    first.x = Math.max(first.x, start.from)
    first.w = Math.max(right - first.x, 2)
  }
  const last = out[out.length - 1]!
  const end = spanOf(runs, last, words[words.length - 1]!, 'last')
  if (end && end.to > last.x) last.w = Math.max(Math.min(last.x + last.w, end.to) - last.x, 2)
  return out
}

/** Where `word` is drawn among the runs under `rect`: its left and right edges, by proportion along its run. */
function spanOf(runs: readonly Run[], rect: Box, word: string, which: 'first' | 'last'): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null
  for (const run of runs) {
    if (run.w <= 0 || !run.text) continue
    const middle = run.y + run.h / 2
    if (middle < rect.y - 1 || middle > rect.y + rect.h + 1) continue
    if (run.x + run.w < rect.x - 1 || run.x > rect.x + rect.w + 1) continue
    for (let at = find(run.text, word, 0); at !== -1; at = find(run.text, word, at + 1)) {
      const per = run.w / run.text.length
      const from = run.x + at * per
      const to = run.x + (at + word.length) * per
      /* Only an occurrence inside what SyncTeX already allowed. The same word
         earlier on the printed line, from a different source line, is not it. */
      if (to < rect.x - per || from > rect.x + rect.w + per) continue
      if (best === null || (which === 'first' ? from < best.from : to > best.to)) best = { from, to }
    }
  }
  return best
}
