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
export function tighten<B extends Box>(rects: readonly B[], runs: readonly Run[], source: string, part: Part = 'whole'): B[] {
  const out = rects.map((rect) => ({ ...rect }))
  const words = printedWords(source)
  if (!out.length) return out
  if (out.some((rect) => on(runs, rect).some(measured))) return byMeasure(out, runs, source, words, part)
  /* Unmeasured, the old rule: and it only knows a mark that is all on one page. */
  if (!words.length || part !== 'whole') return out

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

/**
 * Which part of a mark the rectangles handed to `tighten` are.
 *
 * A passage that crosses a page break is drawn on two pages or more, and each
 * page's rectangles are tightened against that page's words. `head` is the
 * page it starts on — its first word is there and its last is not, so the last
 * row runs to the end of its line; `tail` is the page it ends on; `body` a page
 * it covers from top to bottom. `whole` is a mark all on one page.
 *
 * Without this a mark that crossed a page was not touched at all, and every
 * row of it began wherever SyncTeX's rectangle did: a few letters in from the
 * margin, a different few on each line.
 */
export type Part = 'whole' | 'head' | 'body' | 'tail'

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

/** How far left of SyncTeX's rectangle its first word is still looked for, in characters: a long word and its space. */
const LATE = 16

/** The runs on a rectangle's baseline that say anything. */
function on(runs: readonly Run[], rect: Box): Run[] {
  return runs.filter((run) => {
    if (run.w <= 0 || !run.text.trim()) return false
    const middle = run.y + run.h / 2
    return middle >= rect.y - 1 && middle <= rect.y + rect.h + 1
  })
}

/** The next word of three letters or more in `text` from `from`, and the last one before `to`. */
function wordAfter(text: string, from: number): string | null {
  return text.slice(from).match(/[\p{L}\p{N}]{3,}/u)?.[0] ?? null
}
function wordBefore(text: string, to: number): string | null {
  const all = text.slice(0, to).match(/[\p{L}\p{N}]{3,}/gu)
  return all ? all[all.length - 1]! : null
}

/** Every place `word` is printed, as a whole word, in the measured runs among `among`. */
function places(among: readonly Run[], word: string): Span[] {
  const out: Span[] = []
  for (const run of among) {
    if (!measured(run)) continue
    for (let at = find(run.text, word, 0); at !== -1; at = find(run.text, word, at + 1)) {
      out.push({ from: edge(run, at), to: edge(run, at + word.length), per: run.w / run.text.length, run, at, exact: true })
    }
  }
  return out
}

/**
 * The mark for a selection on a page whose lines were measured.
 *
 * ## SyncTeX's rectangles are late, and this is where that is undone
 *
 * A record is filed under the source line a word's trailing space was typed
 * on. So the rectangle for a source line starts AFTER that line's first word
 * and runs on over the first word of the next — measured on a thesis set by
 * pdfLaTeX, where a passage of three source lines was marked from the second
 * word of its first line to the first word of the line after its last, and
 * every row after the first began where SyncTeX's rectangle did: a word, or
 * half a hyphenated one, in from the margin.
 *
 * Narrowing alone cannot mend that, because the first word of a selection that
 * begins a source line is not INSIDE the rectangle to be found. So:
 *
 *  - **The first word is looked for to the left of the rectangle as well** — a
 *    long word's width — and, failing that, at the very end of the printed
 *    line above, which is where a source line's first word goes when TeX broke
 *    the line right after it. That line is then marked too.
 *  - **The word that follows decides between two candidates.** The selection's
 *    second word printed right after one of them is the difference between
 *    this "the" and the one a few words earlier; when a command stands
 *    between them and nothing can be told, the old order stands.
 *  - **Every row but the ends is its whole printed line.** A contiguous
 *    passage of source prints as contiguous text: from its first word to the
 *    end of that line, whole lines, and the last line up to its last word.
 *    What a line IS comes from the runs — see `lineOf` — and SyncTeX still
 *    decides which printed lines there are.
 *  - **An end that is not found stays where SyncTeX put it**, as always, and
 *    the other end and the rows between are still made right.
 *
 * The ends are also carried over the short words and punctuation `printedWords`
 * will not look for — the "a" before "hint", the full stop after "grade" —
 * when the page prints exactly what the source says there.
 */
function byMeasure<B extends Box>(out: B[], runs: readonly Run[], source: string, words: readonly string[], part: Part): B[] {
  /* Whether each end is on this page at all, and whether there is a word to look for it by. */
  const headHere = part === 'whole' || part === 'head'
  const tailHere = part === 'whole' || part === 'tail'
  const startsHere = headHere && words.length > 0
  const endsHere = tailHere && words.length > 0
  const first = words[0] ?? ''
  const last = words[words.length - 1] ?? ''
  const second = words.length > 1 ? words[1]! : null
  const penultimate = words.length > 1 ? words[words.length - 2]! : null
  const follows = (span: Span) => second !== null && wordAfter(span.run.text, span.at + first.length) === second
  const precedes = (span: Span) => penultimate !== null && wordBefore(span.run.text, span.at) === penultimate

  /* ---- Where it starts ---- */
  let start: { index: number; span: Span } | null = null
  for (let index = 0; startsHere && index < out.length && !start; index += 1) {
    const rect = out[index]!
    const reach = index === 0 ? LATE : 1
    const near = places(on(runs, rect), first).filter((span) => span.to >= rect.x - reach * span.per && span.from <= rect.x + rect.w + span.per)
    near.sort((a, b) => a.from - b.from)
    const inside = near.filter((span) => span.to >= rect.x - span.per)
    /* Confirmed by the word after it; else the first one inside, as before;
       else the nearest one to the left, which is the late start itself. */
    const span = near.find(follows) ?? inside[0] ?? near[near.length - 1] ?? null
    if (span) start = { index, span }
    else if (index === 0) {
      /* Broken off onto the line above: its last word, and nothing after it. */
      const above = { x: rect.x, y: rect.y - (out[1] ? Math.abs(out[1].y - rect.y) : rect.h * 1.4), w: rect.w, h: rect.h }
      const line = lineOf(runs, above, null)
      const tail = places(on(runs, above), first)
        .filter((one) => one.to <= line.right + 1 && one.from >= line.left - 1 && wordAfter(one.run.text, one.at + first.length) === null)
        .sort((a, b) => b.from - a.from)[0]
      if (tail) {
        out.unshift({ ...rect, x: tail.from, y: tail.run.y, w: tail.run.x + tail.run.w - tail.from, h: tail.run.h })
        start = { index: 0, span: tail }
      }
    }
  }

  /* ---- Where it ends ---- */
  let end: { index: number; span: Span } | null = null
  for (let index = out.length - 1; endsHere && index >= (start?.index ?? 0) && !end; index -= 1) {
    const rect = out[index]!
    const near = places(on(runs, rect), last)
      .filter((span) => span.to >= rect.x - span.per && span.from <= rect.x + rect.w + span.per)
      .filter((span) => !start || index > start.index || span.to > start.span.from)
    near.sort((a, b) => b.to - a.to)
    const span = near.find(precedes) ?? near[0] ?? null
    if (span) end = { index, span }
  }

  const s = start?.index ?? 0
  const e = end?.index ?? out.length - 1
  let left: number | null = null
  if (start) {
    const before = leading(source, first)
    const from = start.span.run.text.slice(0, start.span.at).endsWith(before) ? start.span.at - before.length : start.span.at
    left = edge(start.span.run, from) - PAD
  }
  let right: number | null = null
  if (end) {
    const after = trailing(source, last)
    const stop = end.span.at + last.length
    const to = end.span.run.text.slice(stop).startsWith(after) ? stop + after.length : stop
    right = edge(end.span.run, to) + PAD
  }

  const kept = out.slice(s, e + 1)
  kept.forEach((rect, index) => {
    const isFirst = index === 0
    const isLast = index === kept.length - 1
    const line = lineOf(runs, rect, isFirst && start ? start.span.run : isLast && end ? end.span.run : null)
    const was = rect.x + rect.w
    /* An end that is on another page is no end here: the row is a whole line.
       An end that should be here and was not found stays where SyncTeX put it. */
    const x = isFirst ? (left ?? (headHere ? rect.x : line.left - PAD)) : line.left - PAD
    const to = isLast ? (right ?? (tailHere ? was : line.right + PAD)) : line.right + PAD
    rect.x = x
    rect.w = Math.max(to - x, 2)
  })
  return kept
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
