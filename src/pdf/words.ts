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
 * are looked for in the printed lines SyncTeX named — all of them, since a
 * source line is often printed over two. When a match is found the
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
  /**
   * Where each character of `text` begins, measured from the run's left edge,
   * and where the last one ends: `text.length + 1` offsets. Present when the
   * caller could measure the run in the font it is printed in; absent, an edge
   * is found by proportion along the run. See `edge`.
   */
  xs?: readonly number[]
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
 * difference is the whole of how good a mark looks: by proportion, on a
 * justified line in a proportional font, "chatbots" was marked from the "n" of
 * the word before it to the "an" of the word after.
 */
function edge(run: Run, index: number): number {
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
 * A stretch of source, carried out to the ends of the words it begins and ends
 * in. A change is often a few letters of a word — `focus` in `focused` — and a
 * page is searched for whole words, so the fragment alone is never found.
 */
export function wholeWords(text: string, from: number, to: number): string {
  const letter = /[\p{L}\p{N}]/u
  while (from > 0 && letter.test(text[from - 1]!)) from -= 1
  while (to < text.length && letter.test(text[to]!)) to += 1
  return text.slice(from, to)
}

/**
 * How much of a margin a tightened end keeps, in characters of its run.
 *
 * A run is a string and a width, so a word's edges are found by PROPORTION
 * along it — see `wordAt`. On a justified line in a proportional font that
 * estimate is off by a character or two: measured on a real page, the start of
 * "removing" was put 9 points — its "re" — to the right of where it is
 * printed, and the mark began at "moving". A mark that reaches two characters
 * into the neighbouring word reads as approximate; one that cuts the first
 * letters off the selected word reads as wrong. So an end is pulled in to two
 * characters SHORT of the estimate, and never past SyncTeX's own edge.
 */
const MARGIN = 2

/**
 * Narrow SyncTeX's rectangles to the words that were selected.
 *
 * SyncTeX answers for whole source LINES: one rectangle per printed line those
 * source lines reached. A selection inside a source line is narrower than
 * that at both ends, and — since one source line is often printed over two —
 * either end may be in ANY of the rectangles, not just the first or the last.
 * Selecting `removing one means` in a source line that printed as
 *
 *     …that [have nothing to do with the sixth thing; removing one means deleting]
 *     [code that] four other files reach into…
 *
 * has both of its ends in the first rectangle. Looking for the last word only
 * under the last rectangle found nothing there and left the mark running to
 * the end of `code that`; that was this function until it was reproduced from
 * those very positions (`test/offsets.test.ts`).
 *
 * So: the first selected word is looked for from the first rectangle on, the
 * last selected word from the last rectangle back. Rectangles before the one
 * the selection starts in and after the one it ends in are DROPPED, the two
 * ends are pulled in, and whatever lies between them is whole printed lines of
 * the selection and already right.
 *
 * What it will not do:
 *
 *  - **Widen.** Every rectangle handed back lies inside one that was handed
 *    in. An end is only ever moved inward, and only as far as `MARGIN` short
 *    of the word.
 *  - **Guess at an end it cannot find.** A word that was hyphenated, is maths,
 *    or is inside a command is not among the runs, and that end stays where
 *    SyncTeX put it.
 *  - **Pick the nearer of two.** When the first word is printed more than once
 *    under the rectangles the EARLIEST is taken, and for the last word the
 *    LATEST, so a repeated word costs precision and never coverage.
 *  - **Believe ends that cross.** A start found after the end means one of the
 *    two matched some other occurrence; the SyncTeX answer is returned whole.
 *
 * Anything else a rectangle carries — its page — comes back with it.
 */
export function tighten<B extends Box>(rects: readonly B[], runs: readonly Run[], source: string): B[] {
  const out = rects.map((rect) => ({ ...rect }))
  const words = printedWords(source)
  if (!out.length || !words.length) return out

  let start: { index: number; span: Span } | null = null
  for (let index = 0; index < out.length && !start; index += 1) {
    const span = spanOf(runs, out[index]!, words[0]!, 'first')
    if (span) start = { index, span }
  }
  let end: { index: number; span: Span } | null = null
  for (let index = out.length - 1; index >= 0 && !end; index -= 1) {
    const span = spanOf(runs, out[index]!, words[words.length - 1]!, 'last')
    if (span) end = { index, span }
  }
  if (start && end && (end.index < start.index || (end.index === start.index && end.span.to <= start.span.from))) return out
  if (start && end && start.span.exact && end.span.exact) return exactly(out, runs, start, end, source, words)

  if (end) {
    const last = out[end.index]!
    const right = Math.min(last.x + last.w, end.span.to + MARGIN * end.span.per)
    if (right > last.x) last.w = Math.min(last.w, Math.max(right - last.x, 2))
  }
  if (start) {
    const first = out[start.index]!
    const right = first.x + first.w
    first.x = Math.max(first.x, Math.min(start.span.from - MARGIN * start.span.per, right - 2))
    first.w = right - first.x
  }
  return out.slice(start?.index ?? 0, (end?.index ?? out.length - 1) + 1)
}

/** A word as drawn: its left and right edges, and the width of one character of the run it is in. */
interface Span {
  from: number
  to: number
  per: number
  /** The run it was found in, and which of its characters it is. */
  run: Run
  at: number
  /** Whether the edges were measured rather than estimated. */
  exact: boolean
}

/** How far outside the ink a measured mark is drawn, in points: enough not to touch the letters. */
const PAD = 1

/**
 * The mark for a selection BOTH of whose ends were found, in runs whose
 * characters were measured.
 *
 * This is the one place a rectangle is made WIDER than SyncTeX's, and the
 * reason it may be: SyncTeX's rectangles are late. A record is filed under the
 * source line a word's trailing space was typed on, so the rectangle for a
 * source line starts after that line's first word and runs on over the first
 * word of the next — measured on a thesis set by pdfLaTeX, a passage of three
 * source lines was marked from the second word of its first line to the first
 * word of the line after its last. Tightening could pull those ends in and
 * could never push them out, so a selection that began on a line's first word
 * began, on the page, at its second.
 *
 * With both ends found and measured there is something better to believe than
 * the rectangles' edges. A contiguous passage of source prints as contiguous
 * text: from its first word to the end of that printed line, every whole line
 * between, and the last line up to its last word. So the first rectangle runs
 * from the first word to the end of its line, the last from the start of its
 * line to the last word, and those between are their whole lines. What a line
 * IS comes from the runs — see `lineOf` — and SyncTeX still decides which
 * printed lines there are.
 *
 * The ends are also carried over the short words and punctuation `printedWords`
 * will not look for — the "a" before "hint", the full stop after "grade" —
 * when the page prints exactly what the source says there.
 */
function exactly<B extends Box>(
  rects: readonly B[],
  runs: readonly Run[],
  start: { index: number; span: Span },
  end: { index: number; span: Span },
  source: string,
  words: readonly string[],
): B[] {
  const before = leading(source, words[0]!)
  const from = start.span.run.text.slice(0, start.span.at).endsWith(before) ? start.span.at - before.length : start.span.at
  const after = trailing(source, words[words.length - 1]!)
  const stop = end.span.at + words[words.length - 1]!.length
  const to = end.span.run.text.slice(stop).startsWith(after) ? stop + after.length : stop
  const left = edge(start.span.run, from) - PAD
  const right = edge(end.span.run, to) + PAD

  const out = rects.slice(start.index, end.index + 1).map((rect) => ({ ...rect }))
  out.forEach((rect, index) => {
    const line = lineOf(runs, rect, index === 0 ? start.span.run : index === out.length - 1 ? end.span.run : null)
    const x = index === 0 ? left : line.left - PAD
    const edgeRight = index === out.length - 1 ? right : line.right + PAD
    rect.x = x
    rect.w = Math.max(edgeRight - x, 2)
  })
  return out
}

/**
 * The printed line a rectangle is on, as far as its text reaches left and right.
 *
 * A line is often several runs — a citation, a word in italics, a font change
 * each start one — so it is gathered: from the run an end was found in, or
 * from the runs under the rectangle, outward to every run on the same baseline
 * that is no more than two line-heights away. The limit is what keeps the
 * other column, a margin note or a page number on the same baseline out of it.
 */
function lineOf(runs: readonly Run[], rect: Box, seed: Run | null): { left: number; right: number } {
  const on = runs.filter((run) => {
    if (run.w <= 0 || !run.text.trim()) return false
    const middle = run.y + run.h / 2
    return middle >= rect.y - 1 && middle <= rect.y + rect.h + 1
  })
  let left = seed ? seed.x : rect.x
  let right = seed ? seed.x + seed.w : rect.x + rect.w
  if (!seed) {
    const under = on.filter((run) => run.x < right && run.x + run.w > left)
    if (!under.length) return { left, right }
    left = Math.min(...under.map((run) => run.x))
    right = Math.max(...under.map((run) => run.x + run.w))
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const run of on) {
      const reach = 2 * Math.max(run.h, rect.h)
      if (run.x < left && run.x + run.w >= left - reach) {
        left = run.x
        grew = true
      }
      if (run.x + run.w > right && run.x <= right + reach) {
        right = run.x + run.w
        grew = true
      }
    }
  }
  return { left, right }
}

/** Source that prints as itself: no command, no maths, no comment, no braces, no tie. */
function plain(text: string): boolean {
  return !/[\\$%{}~`]/.test(text) && !text.includes("''") && !text.includes('--')
}

/** What the source says before the first `word`, as it would be printed, or nothing when that cannot be told. */
function leading(source: string, word: string): string {
  const at = find(source, word, 0)
  if (at <= 0) return ''
  const before = source.slice(0, at)
  return plain(before) ? before.replace(/\s+/g, ' ').replace(/^ /, '') : ''
}

/** What the source says after the last `word`, as it would be printed, or nothing when that cannot be told. */
function trailing(source: string, word: string): string {
  let at = -1
  for (let next = find(source, word, 0); next !== -1; next = find(source, word, next + 1)) at = next
  if (at === -1) return ''
  const after = source.slice(at + word.length)
  return plain(after) ? after.replace(/\s+/g, ' ').replace(/ $/, '') : ''
}

/** Where `word` is drawn among the runs under `rect`, by proportion along its run. */
function spanOf(runs: readonly Run[], rect: Box, word: string, which: 'first' | 'last'): Span | null {
  let best: Span | null = null
  for (const run of runs) {
    if (run.w <= 0 || !run.text) continue
    const middle = run.y + run.h / 2
    if (middle < rect.y - 1 || middle > rect.y + rect.h + 1) continue
    if (run.x + run.w < rect.x - 1 || run.x > rect.x + rect.w + 1) continue
    for (let at = find(run.text, word, 0); at !== -1; at = find(run.text, word, at + 1)) {
      const per = run.w / run.text.length
      const from = edge(run, at)
      const to = edge(run, at + word.length)
      /* Only an occurrence inside what SyncTeX already allowed. The same word
         earlier on the printed line, from a different source line, is not it. */
      if (to < rect.x - per || from > rect.x + rect.w + per) continue
      if (best === null || (which === 'first' ? from < best.from : to > best.to)) best = { from, to, per, run, at, exact: measured(run) }
    }
  }
  return best
}
