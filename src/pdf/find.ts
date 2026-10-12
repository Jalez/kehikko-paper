/**
 * Where a passage of the source is printed, found by READING the PDF.
 *
 * ## The text is the answer; SyncTeX is the hint
 *
 * A PDF carries its text, with positions. A passage of source says, give or
 * take its markup, the same letters in the same order. So the place it was
 * printed is the place those letters are: this file looks for them and draws
 * the mark round the characters it found — across line breaks, across a page
 * break, over the citation in the middle of the sentence — and nothing else
 * decides where a mark goes.
 *
 * SyncTeX (`compile/synctex.ts`) answers in whole source lines and is right
 * about the neighbourhood, so it is kept for the two things the text cannot
 * do. It BREAKS A TIE when the same letters are printed twice: the one beside
 * SyncTeX's rectangles is meant. And it is the FALLBACK when the letters are
 * not found at all — maths, a figure, a macro that prints something else, a
 * PDF older than the text — and then what is drawn is the printed lines
 * SyncTeX named, whole: a mark that says "about here" and does not pretend to
 * know the words. Never a tight mark in a guessed place.
 *
 * ## How the looking is done
 *
 * `read` lays the PDF's text out as one string of letters and digits
 * (`letters` in `printed.ts`), line after line and page after page, each
 * letter remembering the run and the line it is from. `printed.ts` makes the
 * same of the source, with gaps where it prints something that cannot be
 * spelled. Then:
 *
 *  - a stretch of letters has to be there letter for letter — except that at
 *    the END OF A PRINTED LINE it may go on some lines later. That is how a
 *    passage gets over the foot of a page (footnotes, the page number, the
 *    next page's running head), round a float set in the middle of its
 *    paragraph, and down one column past the other;
 *  - after a gap, the next stretch has to begin within the gap's width;
 *  - when the whole of it is not there, the longest beginning and the longest
 *    ending that are (`around`) still pin the passage down between them: one
 *    command printing something unexpected, or a line the person is typing on
 *    that the PDF has not caught up with, costs the mark nothing.
 *
 * Pure. Runs in, rectangles out, in PDF points from the top-left.
 */

import type { PageRect } from '../../compile/synctex.ts'
import { letters, type Pattern, type Sought } from './printed.ts'
import { edge, type Run } from './words.ts'

/** One printed line: its baseline, how far its text reaches, and which letters of `Text.said` are on it. */
export interface Line {
  page: number
  base: number
  h: number
  left: number
  right: number
  from: number
  to: number
}

/** The text of some pages as one string of letters, each knowing where it is printed. */
export interface Text {
  said: string
  /** Per letter: the run it is in, which character of that run it is, and its line. */
  run: Run[]
  at: number[]
  line: number[]
  lines: Line[]
}

/** How far apart two runs on one baseline are before they are two lines: the gutter between columns, or between cells. */
const GUTTER = 2.5

/** Lay pages out as `Text`. Lines top to bottom, and left to right where two share a baseline. */
export function read(pages: readonly { page: number; runs: readonly Run[] }[]): Text {
  const text: Text = { said: '', run: [], at: [], line: [], lines: [] }
  const said: string[] = []
  for (const { page, runs } of [...pages].sort((a, b) => a.page - b.page)) {
    const inked = runs.filter((run) => run.w > 0 && run.text.trim()).sort((a, b) => a.y + a.h - (b.y + b.h) || a.x - b.x)
    let row: Run[] = []
    const flush = () => {
      row.sort((a, b) => a.x - b.x)
      let line: Line | null = null
      for (const run of row) {
        if (!line || run.x - line.right > GUTTER * Math.max(run.h, line.h)) {
          line = { page, base: run.y + run.h, h: run.h, left: run.x, right: run.x + run.w, from: text.run.length, to: text.run.length }
          text.lines.push(line)
        }
        line.right = Math.max(line.right, run.x + run.w)
        line.h = Math.max(line.h, run.h)
        for (let index = 0; index < run.text.length; index += 1) {
          for (const one of letters(run.text[index]!)) {
            said.push(one)
            text.run.push(run)
            text.at.push(index)
            text.line.push(text.lines.length - 1)
          }
        }
        line.to = text.run.length
      }
      row = []
    }
    for (const run of inked) {
      if (row.length && Math.abs(run.y + run.h - (row[0]!.y + row[0]!.h)) > 1) flush()
      row.push(run)
    }
    flush()
  }
  text.said = said.join('')
  return text
}

/** How far on, in letters, a stretch may be picked up again after the end of a line: two pages of prose. */
const ON = 8000
/** How many lines back on its own page a stretch may be picked up again: the rows of a table. */
const BACK = 40
/** A stretch shorter than this is not carried over anything: three words could be picked up anywhere. */
const CARRIED = 16
/** How many letters of a stretch have to be placed before it may be picked up again elsewhere. */
const PLACED = 8
/** How many places are looked at before the rest are left: a passage printed forty times is not one to mark. */
const MOST = 40

/**
 * Follow the pattern from letter `k` at place `pos` for as long as it holds.
 * Fills `where` and answers how many letters of the pattern were placed.
 */
function follow(text: Text, pattern: Pattern, k: number, pos: number, where: number[]): number {
  const { said, line, lines } = text
  const want = pattern.text
  /* The end of the stretch `k` is in: up to the next gap. */
  let stop = k + 1
  while (stop < want.length && pattern.gap[stop] === 0) stop += 1
  const begun = k
  let i = pos
  /* The last start of a line this stretch came through: where it may be picked up again from. */
  let turnK = -1
  let turnI = -1
  for (; k < stop; k += 1) {
    const starts = k > begun && i < said.length && line[i] !== line[i - 1]
    if (said[i] === want[k]) {
      if (starts) {
        turnK = k
        turnI = i
      }
    } else {
      if (starts) {
        turnK = k
        turnI = i
      }
      /* Only from the start of a line, only something long enough to be told
         from chance, and only with enough of it already placed: one letter at
         the end of any line would otherwise be the beginning of everything. */
      if (turnK === -1 || stop - begun < CARRIED || turnK - begun < PLACED) return k
      /* The nearest line that begins with what comes next: later ones as far
         as `ON`, and earlier ones on the same page — a cell of a table that
         wrapped is read after the cells beside it. As much of what comes next
         as the line is long, up to a dozen letters: a cell may be one number. */
      const here = line[turnI]!
      const begins = (at: Line | undefined): boolean => {
        if (!at) return false
        const probe = Math.min(12, stop - turnK, at.to - at.from)
        return probe >= Math.min(2, stop - turnK) && said.startsWith(want.slice(turnK, turnK + probe), at.from)
      }
      let next = -1
      for (let away = 1; next === -1; away += 1) {
        const on = lines[here + away]
        const back = lines[here - away]
        const later = on !== undefined && on.from - turnI <= ON
        const earlier = back !== undefined && away <= BACK && back.page === lines[here]!.page
        if (!later && !earlier) break
        if (later && begins(on)) next = on!.from
        else if (earlier && begins(back)) next = back!.from
      }
      if (next === -1) return k
      k = turnK
      i = turnI = next
    }
    where[k] = i
    i += 1
  }
  if (stop >= want.length) return stop
  /* Over the gap: the next stretch, at the first place within reach from which the rest follows furthest. */
  let best = stop
  let kept: number[] | null = null
  const first = want[stop]!
  const reach = Math.min(said.length - 1, i + pattern.gap[stop]!)
  for (let p = said.indexOf(first, i); p !== -1 && p <= reach; p = said.indexOf(first, p + 1)) {
    const tried = where.slice(0, stop)
    const got = follow(text, pattern, stop, p, tried)
    if (got > best) {
      best = got
      kept = tried
      if (got === want.length) break
    }
  }
  if (kept) for (let n = stop; n < best; n += 1) where[n] = kept[n]!
  return best
}

interface Found {
  /** Where each letter of the pattern is, for the first `n` of them. */
  where: number[]
  n: number
}

/** Every place the pattern can be followed from, with how far each gets. Whole ones only, unless `partly`. */
function places(text: Text, pattern: Pattern, partly: boolean): Found[] {
  const out: Found[] = []
  const want = pattern.text
  if (!want) return out
  let longest = partly ? CARRIED : want.length
  for (let i = text.said.indexOf(want[0]!); i !== -1; i = text.said.indexOf(want[0]!, i + 1)) {
    if (want.length > 1 && pattern.gap[1] === 0 && text.said[i + 1] !== want[1] && text.line[i] === text.line[i + 1]) continue
    const where: number[] = []
    const n = follow(text, pattern, 0, i, where)
    if (n < longest) continue
    if (n > longest) {
      longest = n
      out.length = 0
    }
    out.push({ where, n })
    if (out.length >= MOST) break
  }
  return out
}

/**
 * The same text and pattern read backwards, so that an ENDING is followed with
 * the code that follows a beginning. A text is turned round once and kept: it
 * is asked for on every key of a line being typed that the PDF does not have.
 */
const turned = new WeakMap<Text, Text>()
function backwards(text: Text, pattern: Pattern): { text: Text; pattern: Pattern } {
  let flipped = turned.get(text)
  if (!flipped) {
    const n = text.said.length
    const last = text.lines.length - 1
    flipped = {
      said: [...text.said].reverse().join(''),
      run: [...text.run].reverse(),
      at: [...text.at].reverse(),
      line: [...text.line].reverse().map((l) => last - l),
      lines: [...text.lines].reverse().map((line) => ({ ...line, from: n - line.to, to: n - line.from })),
    }
    turned.set(text, flipped)
  }
  const gap = pattern.gap.map((_, k) => (k === 0 ? 0 : pattern.gap[pattern.gap.length - k]!))
  return { text: flipped, pattern: { text: [...pattern.text].reverse().join(''), gap, src: [...pattern.src].reverse() } }
}

/** A passage as found: the letters of `Text.said` that are it, in order, and whether every one was found. */
interface Place {
  letters: number[]
  whole: boolean
}

/** The slice of a pattern, as a pattern of its own. */
function part(pattern: Pattern, from: number, to: number): Pattern {
  const gap = pattern.gap.slice(from, to)
  if (gap.length) gap[0] = 0
  return { text: pattern.text.slice(from, to), gap, src: pattern.src.slice(from, to) }
}

/** How much of a passage has to be found, of its letters, for a mark between two ends to be believed. */
const ENOUGH = 0.6

/**
 * Between the longest beginning and the longest ending that are there.
 *
 * For each beginning, the nearest ending after it; what the passage's letters
 * are is then read off whichever of the two placed them, and a letter neither
 * placed is somewhere between the two.
 */
function around(text: Text, pattern: Pattern, core: readonly [number, number]): Place[] {
  const total = pattern.text.length
  const heads = places(text, pattern, true)
  if (!heads.length) return []
  const flipped = backwards(text, pattern)
  const size = text.said.length
  /* Back in forward terms: `where[k]` for the last `n` letters of the pattern. */
  const tails = places(flipped.text, flipped.pattern, true).map((tail) => {
    const where: number[] = []
    for (let k = 0; k < tail.n; k += 1) where[total - 1 - k] = size - 1 - tail.where[k]!
    return { where, first: total - tail.n }
  })
  const out: Place[] = []
  for (const head of heads) {
    const ends = head.where[head.n - 1]!
    const reach = ends + 2 * (total - head.n) + 400
    const tail = tails
      .filter((one) => one.where[total - 1]! > ends && one.where[total - 1]! <= reach && one.where[one.first]! >= head.where[0]!)
      .sort((a, b) => a.where[total - 1]! - b.where[total - 1]!)[0]
    if (!tail) continue
    const at = (k: number): number | null => (k < head.n ? head.where[k]! : k >= tail.first ? tail.where[k]! : null)
    const start = at(core[0]) ?? ends + 1
    const end = at(core[1] - 1) ?? tail.where[tail.first]! - 1
    let got = 0
    for (let k = core[0]; k < core[1]; k += 1) if (at(k) !== null) got += 1
    if (end < start || got < ENOUGH * (core[1] - core[0])) continue
    const all: number[] = []
    for (let pos = start; pos <= end; pos += 1) all.push(pos)
    out.push({ letters: all, whole: false })
  }
  return out
}

/** How far from SyncTeX's rectangles a place still counts as beside them, in line heights. SyncTeX is a line late as often as not. */
const BESIDE = 2

function beside(text: Text, place: Place, hint: readonly PageRect[]): boolean {
  const seen = new Set<number>()
  for (const pos of place.letters) seen.add(text.line[pos]!)
  for (const index of seen) {
    const line = text.lines[index]!
    for (const rect of hint) {
      if (rect.page !== line.page) continue
      const slack = BESIDE * Math.max(line.h, rect.h)
      if (line.base >= rect.y - slack && line.base - line.h <= rect.y + rect.h + slack) return true
    }
  }
  return false
}

/** How far outside the ink a mark is drawn, in points: enough not to touch the letters. */
const PAD = 1

/**
 * The rectangles round the letters at `at`: one per printed line.
 *
 * From the first letter found on a line to the last, so that what stands
 * between them and was not spelled — the citation, the maths — is inside the
 * mark. Where the passage runs on from one line straight onto the next, the
 * first is marked to its end and the second from its beginning.
 */
function rectsOf(text: Text, at: readonly number[], punctuated: { before: boolean; after: boolean }): PageRect[] {
  /* Which lines the passage leaves for the very next one, and which it comes onto from the one before. */
  const leaves = new Set<number>()
  const enters = new Set<number>()
  for (let n = 1; n < at.length; n += 1) {
    const from = text.line[at[n - 1]!]!
    const to = text.line[at[n]!]!
    if (to !== from + 1 || text.lines[from]!.page !== text.lines[to]!.page) continue
    leaves.add(from)
    enters.add(to)
  }
  const rows: { line: number; lo: number; hi: number }[] = []
  for (const pos of [...at].sort((a, b) => a - b)) {
    const line = text.line[pos]!
    const last = rows[rows.length - 1]
    if (last && last.line === line) last.hi = pos
    else rows.push({ line, lo: pos, hi: pos })
  }
  const first = text.line[at[0]!]
  const last = text.line[at[at.length - 1]!]
  return rows.map((row) => {
    const line = text.lines[row.line]!
    let left = enters.has(row.line) ? line.left : edgeOf(text, row.lo, false, row.line === first && punctuated.before)
    let right = leaves.has(row.line) ? line.right : edgeOf(text, row.hi, true, row.line === last && punctuated.after)
    if (right < left) [left, right] = [right, left]
    return boxOf(line, left - PAD, right + PAD)
  })
}

/** A line's box between two x's: from above its tallest letters to below its descenders. */
function boxOf(line: Line, left: number, right: number): PageRect {
  return { page: line.page, x: left, y: line.base - line.h * 0.78, w: Math.max(right - left, 2), h: line.h * 1.04 }
}

/** The left or right edge of a letter, carried over the punctuation that touches it when the source had some there. */
function edgeOf(text: Text, pos: number, right: boolean, punctuation: boolean): number {
  const run = text.run[pos]!
  let index = text.at[pos]! + (right ? 1 : 0)
  if (punctuation) {
    const mark = (ch: string | undefined) => ch !== undefined && ch.trim() !== '' && letters(ch) === ''
    if (right) while (mark(run.text[index])) index += 1
    else while (mark(run.text[index - 1])) index -= 1
  }
  return edge(run, index)
}

/**
 * The printed lines SyncTeX's rectangles are on, whole.
 *
 * What is drawn when the words were not found. SyncTeX's own rectangle for a
 * source line starts a word late and ends a word late (see the essay in
 * `compile/synctex.ts`); drawn as it is, it reads as a mark that tried for the
 * words and missed. The whole printed line makes no such claim.
 */
export function linesOf(text: Text, hint: readonly PageRect[]): PageRect[] {
  const out: PageRect[] = []
  const seen = new Set<Line>()
  for (const rect of hint) {
    const under = text.lines.filter((line) => {
      const middle = line.base - line.h * 0.3
      return line.page === rect.page && middle >= rect.y - 1 && middle <= rect.y + rect.h + 1 && line.left < rect.x + rect.w && line.right > rect.x
    })
    /* A rectangle over nothing the PDF says, or far taller than a line — a
       figure, a table, a display — is a box already, and stays one: its
       lines one by one would be a hundred slivers. */
    if (!under.length || rect.h > 3 * Math.max(...under.map((line) => line.h))) {
      out.push({ ...rect })
      continue
    }
    for (const line of under) {
      if (seen.has(line)) continue
      seen.add(line)
      out.push(boxOf(line, line.left - PAD, line.right + PAD))
    }
  }
  return out
}

/** Letters enough that finding them once, anywhere, is finding the passage. */
const SURE = 20

/**
 * Where `sought` is printed in `text`.
 *
 * `how` says what the rectangles are: `words` — the passage itself, found;
 * `lines` — the printed lines SyncTeX named, because it was not found, or was
 * found in more places than SyncTeX could choose between. `tie` is true when
 * SyncTeX was what chose.
 */
export function locate(text: Text, sought: Sought, hint: readonly PageRect[]): { rects: PageRect[]; how: 'words' | 'lines'; whole?: boolean; tie?: boolean } {
  const { pattern, core } = sought
  const coarse = () => ({ rects: linesOf(text, hint), how: 'lines' as const })
  const between = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a - 1) }, (_, n) => a + 1 + n)
  /* Nothing of its own to look for: a comment, a label — or only a citation or maths, which is then what was printed between its neighbours. */
  const bare = core[1] <= core[0]
  if (bare && !sought.gapped.before) return coarse()
  const exact = (pat: Pattern, from: number, to: number): Place[] => {
    /* The same words printed twice — a row of one table and a row of the next —
       can be followed from the first occurrence and picked up again at the
       second: a passage made of two halves that are not one passage. So the
       tightest way of placing it is taken first, and one that only shares an
       end with it is the same passage found the long way round. */
    const spread = (where: readonly number[]) => Math.max(...where) - Math.min(...where)
    const firsts = new Set<number>()
    const lasts = new Set<number>()
    return places(text, pat, false)
      .sort((a, b) => spread(a.where) - spread(b.where))
      .filter(({ where }) => !firsts.has(where[0]!) && !lasts.has(where[where.length - 1]!) && firsts.add(where[0]!) && lasts.add(where[where.length - 1]!))
      .map(({ where }) => {
        /* A passage that opens or closes with a citation: what was printed
           there is between its letters and the neighbouring words', and is it. */
        const before = sought.gapped.before && from > 0 && pat.gap[from]! > 0 ? between(where[from - 1]!, where[from]!) : []
        const after = to > from && sought.gapped.after && to < where.length && pat.gap[to]! > 0 ? between(where[to - 1]!, where[to]!) : []
        return { letters: [...before, ...where.slice(from, to), ...after], whole: true }
      })
      .filter((place) => place.letters.length > 0)
  }
  /* With what stands round it; then alone; then between the ends that are there. */
  let found = exact(pattern, core[0], core[1])
  let sure = pattern.text.length >= SURE
  if (!found.length && !bare && (core[0] > 0 || core[1] < pattern.text.length)) {
    found = exact(part(pattern, core[0], core[1]), 0, core[1] - core[0])
    sure = core[1] - core[0] >= SURE
  }
  if (!found.length && !bare) {
    found = around(text, pattern, core)
    sure = pattern.text.length >= SURE
  }
  if (!found.length) return coarse()
  const near = found.filter((place) => beside(text, place, hint))
  const one = near.length === 1 ? near[0]! : found.length === 1 && sure && !near.length ? found[0]! : null
  if (!one) return coarse()
  return { rects: rectsOf(text, one.letters, sought.punctuated), how: 'words', whole: one.whole, tie: found.length > 1 }
}
