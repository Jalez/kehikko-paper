/**
 * SyncTeX, read here rather than by a `synctex` binary.
 *
 * ## Why this file exists at all
 *
 * A compiled PDF is a picture of the paper and the `.tex` is the paper. The
 * moment the two sit side by side, somebody clicks a sentence in the picture
 * and expects the cursor to land in the source, and selects a line of source
 * and expects to be shown where it came out. An engine run with SyncTeX on
 * writes the table that answers both: for every box and every piece of glue it
 * shipped, which input file and which LINE of it was being read when that node
 * was made, and where on which page it landed.
 *
 * The usual way to ask that table a question is the `synctex` command, which
 * ships with TeX Live. This machine has Tectonic and no `synctex`, and a module
 * that needed a second install to tell a click from a line would be a module
 * that works on one desk. The format is line-oriented text behind gzip, so it
 * is parsed here. Pure: bytes in, a table out, and two questions asked of it.
 *
 * ## What the table can and cannot say, which is the honest part
 *
 * SyncTeX records BOXES, GLUE, KERNS and MATH switches. It does not record
 * glyphs. So the finest thing it knows about a sentence is where the spaces
 * are — every inter-word glue carries the source line the space was typed on —
 * and everything this file answers is built from that:
 *
 *  - **Line, not column.** A record names a line. There is no column in what
 *    Tectonic or pdfTeX write. Finer than a line is somebody else's job: the
 *    page matches the words against the PDF's own text (see `src/pdf/words.ts`).
 *  - **Inside a paragraph it is good to the space.** A source line's words end
 *    at the glue typed after them, so the extent of one source line on one
 *    printed line is the run between the last glue of the line before it and
 *    its own last glue. Hyphenation does not disturb that: a word broken across
 *    two printed lines has glue only at its ends.
 *  - **Maths is one lump.** Inline maths is bracketed by two `$` records and a
 *    display is a box; nothing inside either is told apart.
 *  - **Floats answer from where they LANDED.** A figure typed on line 40 and
 *    floated to the top of the next page is found on that next page, which is
 *    right, and the click on its caption goes to the caption's line.
 *  - **Anything a macro typeset answers with the line that CALLED it.** A
 *    `\maketitle`, a bibliography printed from a `.bbl`, a table of contents:
 *    the click lands on the command, or in a file this paper does not own, and
 *    `reverse` refuses the second rather than opening a file from the bundle.
 *
 * ## Coordinates
 *
 * Scaled points — 65536 to a TeX point — measured from the TOP-LEFT corner of
 * the page, `y` running down to a BASELINE, with a height above it and a depth
 * below. Everything is handed out in PDF points (72 to the inch), still from
 * the top-left and still running down, because that is the arithmetic a canvas
 * wants: multiply by the scale and draw.
 */

/** A box or a leaf, as the file records it. Positions in PDF points from the top-left. */
export interface SyncNode {
  /** One-based page. */
  page: number
  /** Which `Input:` this was read from. */
  tag: number
  line: number
  x: number
  /** The baseline. */
  y: number
  w: number
  h: number
  d: number
  /** Index of the enclosing HORIZONTAL box in `boxes`, or -1. */
  box: number
}

export interface SyncTable {
  /** Input tag to the name the engine wrote. Empty for files out of the engine's own bundle. */
  inputs: Map<number, string>
  pages: number
  /** Every horizontal box, in file order. */
  boxes: SyncNode[]
  /** Every leaf — glue, kern, math switch, rule, current point, void box — in file order. */
  leaves: SyncNode[]
}

/** TeX scaled points in one PDF point: 65536 × 72.27 / 72. */
const SP_PER_BP = 65781.76

/**
 * How many records one table may hold before the rest is ignored.
 *
 * A bound and not a budget, like every other size in this module: the thesis on
 * this machine is 55 pages and about a hundred and fifty thousand records. It
 * exists so that a build directory holding something that merely looks like a
 * SyncTeX file cannot take the server's memory with it.
 */
const MAX_RECORDS = 4_000_000

/**
 * Parse the text of a `.synctex` file — already gunzipped — into a table.
 *
 * Total: a line this does not recognise is skipped, never thrown on. The format
 * has grown records over the years (`f` forms, columns after the line number)
 * and a reader that died on the first unfamiliar one would turn "a newer
 * engine" into "navigation is broken" with nothing on screen to say why.
 */
export function parseSynctex(text: string): SyncTable {
  const inputs = new Map<number, string>()
  const boxes: SyncNode[] = []
  const leaves: SyncNode[] = []
  let unit = 1
  let magnification = 1000
  let xOffset = 0
  let yOffset = 0
  let page = 0
  let pages = 0
  /* The stack of open boxes. A vertical box is pushed as -1 so that `)` and
     `]` stay balanced without a vertical box ever being a leaf's parent. */
  const open: number[] = []
  let records = 0

  const toBp = (value: number, offset: number) => (unit * value * (magnification / 1000) + offset) / SP_PER_BP

  let at = 0
  while (at < text.length && records < MAX_RECORDS) {
    let end = text.indexOf('\n', at)
    if (end === -1) end = text.length
    const first = text.charCodeAt(at)
    const line = text.slice(at, end)
    at = end + 1

    /* `I` — and the preamble's other capitals, all `Name:value`. */
    if (first === 73 && line.startsWith('Input:')) {
      const colon = line.indexOf(':', 6)
      if (colon !== -1) inputs.set(Number(line.slice(6, colon)), line.slice(colon + 1))
      continue
    }
    if (first === 85 && line.startsWith('Unit:')) {
      unit = Number(line.slice(5)) || 1
      continue
    }
    if (first === 77 && line.startsWith('Magnification:')) {
      magnification = Number(line.slice(14)) || 1000
      continue
    }
    if (first === 88 && line.startsWith('X Offset:')) {
      xOffset = Number(line.slice(9)) || 0
      continue
    }
    if (first === 89 && line.startsWith('Y Offset:')) {
      yOffset = Number(line.slice(9)) || 0
      continue
    }

    /* `{n` opens a page, `}n` closes it. */
    if (first === 123) {
      page = Number(line.slice(1)) || page + 1
      if (page > pages) pages = page
      open.length = 0
      continue
    }
    if (first === 125) {
      page = 0
      continue
    }
    if (page === 0) continue

    /* `)` and `]` close whatever was opened last. */
    if (first === 41 || first === 93) {
      open.pop()
      continue
    }

    /* Everything else worth reading is `<kind>tag,line[,column]:x,y[:W[,H,D]]`. */
    const kind = line[0]
    if (kind === undefined || !'([hvxkg$r'.includes(kind)) continue
    const node = record(line)
    if (!node) continue
    records += 1

    const made: SyncNode = {
      page,
      tag: node.tag,
      line: node.line,
      x: toBp(node.x, xOffset),
      y: toBp(node.y, yOffset),
      w: (unit * node.w) / SP_PER_BP,
      h: (unit * node.h) / SP_PER_BP,
      d: (unit * node.d) / SP_PER_BP,
      box: nearestBox(open),
    }

    if (kind === '(') {
      boxes.push(made)
      open.push(boxes.length - 1)
    } else if (kind === '[') {
      open.push(-1)
    } else {
      leaves.push(made)
    }
  }

  return { inputs, pages, boxes, leaves }
}

/** The innermost open horizontal box, skipping the vertical ones stacked above it. */
function nearestBox(open: readonly number[]): number {
  for (let i = open.length - 1; i >= 0; i -= 1) if (open[i]! >= 0) return open[i]!
  return -1
}

/** One record's numbers, or null when the line is not shaped like one. */
function record(line: string): { tag: number; line: number; x: number; y: number; w: number; h: number; d: number } | null {
  const parts = line.slice(1).split(':')
  const link = parts[0]?.split(',')
  const point = parts[1]?.split(',')
  if (!link || link.length < 2 || !point || point.length < 2) return null
  const size = parts[2]?.split(',') ?? []
  const tag = Number(link[0])
  const at = Number(link[1])
  const x = Number(point[0])
  const y = Number(point[1])
  if (!Number.isFinite(tag) || !Number.isFinite(at) || !Number.isFinite(x) || !Number.isFinite(y)) return null
  return { tag, line: at, x, y, w: Number(size[0]) || 0, h: Number(size[1]) || 0, d: Number(size[2]) || 0 }
}

/**
 * The name a paper's file has in this table, as a path relative to the paper.
 *
 * An engine writes the name it was given, made absolute against the directory
 * it ran in, so the paper's own files come out under `root` and everything out
 * of the engine's bundle comes out with no name at all (Tectonic) or with a
 * path somewhere else on the disk (TeX Live). Both are "not this paper's", and
 * both answer null — which is what stops a click on a page number opening
 * `article.cls`.
 */
export function relativeInput(name: string, root: string): string | null {
  if (!name) return null
  const base = root.endsWith('/') ? root : `${root}/`
  let path = name
  if (path.startsWith(base)) path = path.slice(base.length)
  else if (path.startsWith('/')) return null
  /* `./chapters/a.tex`, and the `chapters/./a.tex` pdfTeX writes for an
     `\input{./a}` inside a chapter. */
  path = path.replace(/^(\.\/)+/, '').replace(/\/\.\//g, '/')
  if (!path || path.startsWith('../') || path.includes('/../')) return null
  return path
}

/** Every tag whose name is this file of the paper. Usually one; an `\input` read twice gets two. */
export function tagsOf(table: SyncTable, root: string, file: string): number[] {
  const out: number[] = []
  for (const [tag, name] of table.inputs) if (relativeInput(name, root) === file) out.push(tag)
  return out
}

/** A rectangle on a page, in PDF points from the top-left corner. */
export interface PageRect {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where lines `from`..`to` of one file came out.
 *
 * One rectangle per PRINTED line that holds any of them, as wide as the part of
 * that printed line those source lines produced — see the essay at the top for
 * why that part is the run between two pieces of glue.
 *
 * When no record names any line in the range — a blank line, a comment, a line
 * holding only `\label{…}` — the nearest line that does is used instead, the
 * one below first, because a caret on the blank line before a paragraph means
 * that paragraph. `exact` is false then, and the caller is expected to say so
 * rather than draw a confident box round the wrong thing.
 */
export function forward(
  table: SyncTable,
  tags: readonly number[],
  from: number,
  to: number,
): { rects: PageRect[]; exact: boolean; line: number | null } {
  const mine = new Set(tags)
  if (!mine.size) return { rects: [], exact: false, line: null }
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)

  let exact = true
  let wanted = (line: number) => line >= lo && line <= hi
  if (!table.leaves.some((leaf) => mine.has(leaf.tag) && wanted(leaf.line))
    && !table.boxes.some((box) => mine.has(box.tag) && wanted(box.line))) {
    const near = nearestLine(table, mine, lo, hi)
    if (near === null) return { rects: [], exact: false, line: null }
    exact = false
    wanted = (line: number) => line === near
  }

  /* Printed line to the leaves on it, kept in file order — which is reading
     order within one box. */
  const byBox = new Map<number, { first: number; last: number }>()
  const loose: SyncNode[] = []
  table.leaves.forEach((leaf, index) => {
    if (!mine.has(leaf.tag) || !wanted(leaf.line)) return
    if (leaf.box === -1) {
      loose.push(leaf)
      return
    }
    const seen = byBox.get(leaf.box)
    if (seen) seen.last = index
    else byBox.set(leaf.box, { first: index, last: index })
  })

  const rects: PageRect[] = []
  for (const [boxIndex, run] of byBox) {
    const box = table.boxes[boxIndex]!
    /* From the leaf BEFORE the run, when it sits in the same box: that is the
       space typed before the first word of these lines. Otherwise these lines
       open the printed line, and the box's own left edge is the start. */
    const before = table.leaves[run.first - 1]
    const start = before && before.box === boxIndex ? before.x + before.w : box.x
    const last = table.leaves[run.last]!
    /* To the box's right edge when nothing but the end of the line follows.
       TeX discards the glue at a line break and a paragraph's last word has
       none after it, so in both cases the run's last recorded leaf sits
       BEFORE its last word, and what follows it in the box is only the
       line's closing skip, out at the right edge. Stopping at the last leaf
       there would cut the final word off every paragraph. On a short last
       line this reaches past the text into white space; the page trims that
       against the PDF's own words where it can. */
    const after = table.leaves[run.last + 1]
    const more = after !== undefined && after.box === boxIndex && after.x < box.x + box.w - 2
    const end = more ? last.x + last.w : box.x + box.w
    const left = Math.max(box.x, Math.min(start, end))
    const right = Math.min(box.x + box.w, Math.max(start, end))
    rects.push({ page: box.page, x: left, y: box.y - box.h, w: Math.max(right - left, 2), h: Math.max(box.h + box.d, 4) })
  }

  /* A box that names the line itself with no leaf of that line in it — a
     heading, a display, a caption's outer box. Only when nothing finer was
     found on that page, or every paragraph would also be wrapped in the
     rectangle of the column it sits in. */
  if (!rects.length) {
    for (const box of table.boxes) {
      if (!mine.has(box.tag) || !wanted(box.line) || box.w <= 0) continue
      rects.push({ page: box.page, x: box.x, y: box.y - box.h, w: box.w, h: Math.max(box.h + box.d, 4) })
    }
  }
  if (!rects.length) {
    for (const leaf of loose) {
      rects.push({ page: leaf.page, x: leaf.x, y: leaf.y - Math.max(leaf.h, 8), w: Math.max(leaf.w, 2), h: Math.max(leaf.h + leaf.d, 10) })
    }
  }

  rects.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
  const line = exact ? lo : firstLine(table, mine, wanted)
  return { rects: merged(rects), exact, line }
}

function firstLine(table: SyncTable, mine: ReadonlySet<number>, wanted: (line: number) => boolean): number | null {
  for (const leaf of table.leaves) if (mine.has(leaf.tag) && wanted(leaf.line)) return leaf.line
  for (const box of table.boxes) if (mine.has(box.tag) && wanted(box.line)) return box.line
  return null
}

/** The recorded line closest to a range that has none, preferring the one below. */
function nearestLine(table: SyncTable, mine: ReadonlySet<number>, lo: number, hi: number): number | null {
  let below: number | null = null
  let above: number | null = null
  const see = (node: SyncNode) => {
    if (!mine.has(node.tag) || node.line <= 0) return
    if (node.line > hi && (below === null || node.line < below)) below = node.line
    if (node.line < lo && (above === null || node.line > above)) above = node.line
  }
  table.leaves.forEach(see)
  table.boxes.forEach(see)
  if (below !== null && above !== null) return below - hi <= (lo - above) * 2 ? below : above
  return below ?? above
}

/** Rectangles on one printed line that touch, as one. Keeps a wrapped selection from drawing as confetti. */
function merged(rects: PageRect[]): PageRect[] {
  const out: PageRect[] = []
  for (const rect of rects) {
    const last = out[out.length - 1]
    if (last && last.page === rect.page && Math.abs(last.y - rect.y) < 1 && rect.x <= last.x + last.w + 1) {
      const right = Math.max(last.x + last.w, rect.x + rect.w)
      last.h = Math.max(last.h, rect.h)
      last.w = right - last.x
      continue
    }
    out.push({ ...rect })
  }
  return out
}

/**
 * Which file and line a point on a page came from.
 *
 * The smallest horizontal box round the point, and inside it the first leaf to
 * the RIGHT of the point: a word is followed by the glue typed after it, so
 * the glue just past a click is the one that knows the clicked word's line.
 * `owned` says which tags are the paper's own files; a box typeset entirely
 * from the engine's bundle is passed over for the next one out, and a point
 * with nothing of the paper's round it answers null.
 */
export function reverse(
  table: SyncTable,
  owned: (tag: number) => boolean,
  page: number,
  x: number,
  y: number,
): { tag: number; line: number } | null {
  /* Candidates: boxes on this page that contain the point, smallest first. A
     point just outside every box — the gap between two lines — is given a
     little slack rather than refused, since a person aims at words. */
  const SLACK = 3
  const around: { index: number; area: number }[] = []
  table.boxes.forEach((box, index) => {
    if (box.page !== page) return
    if (x < box.x - SLACK || x > box.x + box.w + SLACK) return
    if (y < box.y - box.h - SLACK || y > box.y + box.d + SLACK) return
    around.push({ index, area: Math.max(box.w, 1) * Math.max(box.h + box.d, 1) })
  })
  around.sort((a, b) => a.area - b.area)

  for (const { index } of around) {
    let best: SyncNode | null = null
    let last: SyncNode | null = null
    for (const leaf of table.leaves) {
      if (leaf.box !== index || !owned(leaf.tag) || leaf.line <= 0) continue
      last = leaf
      if (leaf.x + leaf.w >= x && (best === null || leaf.x < best.x)) best = leaf
    }
    const found = best ?? last
    if (found) return { tag: found.tag, line: found.line }
    const box = table.boxes[index]!
    if (owned(box.tag) && box.line > 0) return { tag: box.tag, line: box.line }
  }

  /* Nothing round the point. The nearest leaf of the paper's on this page, by
     distance, so a click in a margin beside a paragraph still goes to it. */
  let nearest: SyncNode | null = null
  let distance = Infinity
  for (const leaf of table.leaves) {
    if (leaf.page !== page || !owned(leaf.tag) || leaf.line <= 0) continue
    const away = Math.abs(leaf.y - y) * 3 + Math.abs(leaf.x - x)
    if (away < distance) {
      distance = away
      nearest = leaf
    }
  }
  return nearest && distance < 400 ? { tag: nearest.tag, line: nearest.line } : null
}

/** One file's share of one page: the lines of it that put anything there. */
export interface PageSpan {
  page: number
  from: number
  to: number
}

/**
 * For each of the paper's files, the pages it reached and with which lines.
 *
 * This is the table the NEXT thing will stand on and it is built now so that
 * it does not have to be designed in: a paper divided into parts, each a file
 * pulled into `main.tex`, wants "show me only the pages of these parts", and
 * that is a lookup in this — `chapters/method.tex` is pages 4 to 9. It is also
 * what tells the page which sheet the caret is on without asking per keystroke.
 */
export function pageMap(table: SyncTable, root: string): Record<string, PageSpan[]> {
  const files = new Map<number, string>()
  for (const [tag, name] of table.inputs) {
    const file = relativeInput(name, root)
    if (file !== null) files.set(tag, file)
  }
  const seen = new Map<string, Map<number, PageSpan>>()
  const see = (node: SyncNode) => {
    const file = files.get(node.tag)
    if (file === undefined || node.line <= 0) return
    let pages = seen.get(file)
    if (!pages) seen.set(file, (pages = new Map()))
    const span = pages.get(node.page)
    if (!span) pages.set(node.page, { page: node.page, from: node.line, to: node.line })
    else {
      if (node.line < span.from) span.from = node.line
      if (node.line > span.to) span.to = node.line
    }
  }
  table.leaves.forEach(see)
  table.boxes.forEach(see)

  const out: Record<string, PageSpan[]> = {}
  for (const [file, pages] of seen) out[file] = [...pages.values()].sort((a, b) => a.page - b.page)
  return out
}

/**
 * The page a line of a file is on, from the map alone.
 *
 * The first page whose span holds the line; failing that the last page that
 * starts at or before it, which is where a line between two recorded ones —
 * a comment, a blank — reads as being. Null for a file the build never opened.
 */
export function pageOfLine(map: Record<string, PageSpan[]>, file: string, line: number): number | null {
  const spans = map[file]
  if (!spans?.length) return null
  for (const span of spans) if (line >= span.from && line <= span.to) return span.page
  let best: PageSpan | null = null
  for (const span of spans) if (span.from <= line && (best === null || span.from >= best.from)) best = span
  return (best ?? spans[0]!).page
}
