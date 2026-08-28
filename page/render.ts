import type { Segment, SegmentStyle } from '../latex/parse.ts'
import type { Paper, PlacedBlock } from '../store.ts'

/**
 * Blocks to DOM, and nothing else.
 *
 * This file knows about LaTeX and knows nothing about the wire; `main.ts` knows
 * about the wire and calls this. The split is the same one every module here
 * keeps, and it earns its keep in the tests: everything below can be checked by
 * handing it a parsed paper, with no host, no fetch and no browser beyond a
 * `document`.
 *
 * ## Built with `createElement`, never with `innerHTML`
 *
 * Every string that reaches this function came out of a `.tex` file on somebody
 * else's disk. A paper is not hostile input in any realistic sense — it is the
 * author's own writing — but "realistic" is doing all the work in that
 * sentence, and the failure mode of getting it wrong is script execution inside
 * a page that a host has just granted a real origin to. `textContent` cannot be
 * talked into running anything, and the cost of using it is that the markup is
 * built rather than written. That is the correct trade every time.
 *
 * It also removes a subtler class of bug that has nothing to do with security:
 * a `<` in a paragraph about generics, or an `&` in a URL, is text here and
 * would be markup in a template string. The papers in this roadmap contain
 * both.
 */

/** The inline styles the parser can attach, and the element each becomes. */
const INLINE: Record<SegmentStyle, { tag: string; className?: string }> = {
  emph: { tag: 'em' },
  bold: { tag: 'strong' },
  code: { tag: 'code' },
  cite: { tag: 'span', className: 'cite' },
  ref: { tag: 'span', className: 'xref' },
  math: { tag: 'span', className: 'math' },
  quote: { tag: 'q' },
  todo: { tag: 'span', className: 'todo' },
}

/**
 * The order styles are nested in when a segment carries several.
 *
 * A segment can be `["emph", "code"]` — `\emph{\texttt{x}}` — and the two have
 * to become nested elements rather than one element with two classes, because
 * `<em>` and `<code>` mean different things to a screen reader and collapsing
 * them would lose one. The order is fixed here rather than taken from the
 * segment's own array so that the same pair always nests the same way: the
 * parser pushes styles in the order it meets them, which depends on how the
 * author wrote the markup, and two paragraphs that render identically must not
 * produce different trees.
 */
const NESTING: SegmentStyle[] = ['todo', 'cite', 'ref', 'math', 'quote', 'bold', 'emph', 'code']

/**
 * Adjacent segments that are styled identically, merged into one.
 *
 * The parser splits on the source and is right to: `\\texttt{gh\\##1}` expanded
 * comes back as three segments — `gh`, `#`, `111` — because the escape in the
 * middle is a derived rendering of two characters and the parts either side are
 * not. Every one of them is `code`, and drawn one element each they become
 * three separate `<code>` chips with three lots of padding and background,
 * reading as `gh` `#` `111` rather than as `gh#111`. The same happens to any
 * prose run containing a `~` or a quote: the segment boundary is a fact about
 * the source and has no business being visible.
 *
 * Merged only where the styles are identical, so nothing that renders
 * differently is collapsed. The offsets go — the merged segment spans from the
 * first start to the last end — which is why this lives here and not in the
 * parser: `render.ts` is drawing, and drawing is the one place a byte range is
 * of no further use. Anything that needs offsets reads the blocks.
 */
function coalesce(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = []
  for (const segment of segments) {
    const last = out[out.length - 1]
    const same =
      last &&
      last.styles.length === segment.styles.length &&
      last.styles.every((style, i) => segment.styles[i] === style)
    if (same && last) {
      out[out.length - 1] = { ...last, text: last.text + segment.text, srcEnd: segment.srcEnd, literal: false }
      continue
    }
    out.push(segment)
  }
  return out
}

/** One run of segments, as inline nodes appended to `into`. */
export function inline(into: Node, segments: readonly Segment[]): void {
  const doc = into.ownerDocument ?? document
  for (const segment of coalesce(segments)) {
    let node: Node = doc.createTextNode(segment.text)
    for (const style of NESTING) {
      if (!segment.styles.includes(style)) continue
      const spec = INLINE[style]
      const wrapper = doc.createElement(spec.tag)
      if (spec.className) wrapper.className = spec.className
      wrapper.appendChild(node)
      node = wrapper
    }
    into.appendChild(node)
  }
}

/** Plain text of a run of segments, for a title attribute or a test. */
export function plain(segments: readonly Segment[]): string {
  return segments
    .map((s) => s.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The anchor for a block, and why it is not just the block's id.
 *
 * The parser numbers blocks from 1 within one FILE, and a paper is assembled
 * from a main file plus its chapters — so `heading-3` exists once per chapter
 * and an anchor built from it would send a reader to whichever one the browser
 * found first, which is the earliest one, which is never the one they clicked.
 * Pairing the file with the id makes it unique across the assembled document,
 * and the sanitising is because a filename contains a `/` and a `.`, neither of
 * which can appear in a fragment that `querySelector` will accept.
 */
export function anchorId(file: string, id: string): string {
  return `b-${`${file}-${id}`.replace(/[^a-zA-Z0-9-]+/g, '-')}`
}

const HEADING_TAG = ['h2', 'h2', 'h2', 'h3', 'h4', 'h5']

/**
 * One block, as an element, or `null` for a block a reader should not see.
 *
 * Four kinds return null and each is a decision rather than an omission:
 *
 * - `preamble` is `fontspec`, `geometry` and the paper's own `\newcommand`
 *   definitions. It is real source and it is not the argument, and the two
 *   facts a reader wants out of it — the title and the author — are lifted by
 *   `store.ts` and drawn above the text.
 * - `structure` is `\maketitle`, `\tableofcontents`, `\printbibliography`:
 *   instructions to a compiler about furniture this page builds for itself.
 *   Rendering the instruction as well as the furniture would show it twice.
 * - `include` cannot occur — `readPaper` has already replaced each one with the
 *   blocks of the file it named — and returning null rather than throwing means
 *   a caller that parses a single file without assembling it still gets a page.
 * - a `comment` whose text is empty, which is what a run of `%` rules used as a
 *   visual separator in the source parses to.
 */
export function block(doc: Document, b: PlacedBlock): HTMLElement | null {
  const id = anchorId(b.file, b.id)

  if (b.kind === 'heading') {
    const el = doc.createElement(HEADING_TAG[Math.min(b.level, HEADING_TAG.length - 1)] ?? 'h3')
    el.id = id
    inline(el, b.segments)
    return el
  }

  if (b.kind === 'paragraph') {
    const el = doc.createElement('p')
    el.id = id
    inline(el, b.segments)
    return el
  }

  if (b.kind === 'list') {
    const el = doc.createElement(b.ordered ? 'ol' : 'ul')
    el.id = id
    for (const item of b.items) {
      const li = doc.createElement('li')
      inline(li, item)
      el.appendChild(li)
    }
    return el
  }

  if (b.kind === 'equation') {
    /*
     * Displayed as its LaTeX rather than typeset, and this is the one place
     * this app knowingly shows markup.
     *
     * The program this was extracted from rendered maths with KaTeX, and that
     * was right for a thesis full of it. Not one of the eleven papers in this
     * roadmap contains a single `$`, an `equation` or an `align` — measured,
     * not assumed — so shipping a 300KB typesetting library and its stylesheet
     * would be spending the page's whole load budget on a case that does not
     * occur. Showing the source is honest about that: nobody can mistake
     * `\\frac{a}{b}` in a monospace box for a rendered fraction, whereas a
     * silently dropped equation would look like a paper with a gap in it.
     *
     * The day a paper here has maths in it, this is the branch that grows a
     * KaTeX call, and `parse.ts` already keeps the raw LaTeX on the block for
     * exactly that.
     */
    const el = doc.createElement('div')
    el.id = id
    el.className = 'display-math'
    el.textContent = b.latex
    return el
  }

  if (b.kind === 'verbatim') {
    const el = doc.createElement('pre')
    el.id = id
    el.textContent = b.raw
    return el
  }

  if (b.kind === 'figure') {
    const el = doc.createElement('figure')
    el.id = id
    for (const graphic of b.graphics) {
      /*
       * The filename, in a box, rather than an `<img>`.
       *
       * The image is a path relative to the paper's directory, and serving it
       * would mean a door that reads arbitrary files out of somebody else's
       * tree and answers them with a guessed content type — the exact shape of
       * hazard `store.ts` spends two fences avoiding, reintroduced for a
       * picture. Naming the file says what is there and where to find it, which
       * is what a reader in a 240px pane can act on anyway.
       */
      const box = doc.createElement('div')
      box.className = 'graphic'
      box.textContent = `figure: ${graphic}`
      el.appendChild(box)
    }
    if (b.caption.length) {
      const caption = doc.createElement('figcaption')
      caption.className = 'caption'
      inline(caption, b.caption)
      el.appendChild(caption)
    }
    return el
  }

  if (b.kind === 'table') {
    const el = doc.createElement('div')
    el.id = id
    if (!b.grid) {
      /* The parser refused to guess at an irregular body, and this shows what
         it refused to guess at. A confidently wrong table is worse than a
         listing somebody can read for themselves. */
      const pre = doc.createElement('pre')
      pre.textContent = b.raw
      el.appendChild(pre)
    } else {
      const wrap = doc.createElement('div')
      wrap.className = 'table-wrap'
      const table = doc.createElement('table')
      for (const row of b.grid.rows) {
        const tr = doc.createElement('tr')
        if (row.ruleAbove) tr.className = 'rule-above'
        for (const cell of row.cells) {
          const td = doc.createElement(row.isHeader ? 'th' : 'td')
          td.style.textAlign = cell.align
          if (cell.colSpan > 1) td.colSpan = cell.colSpan
          inline(td, cell.segments)
          tr.appendChild(td)
        }
        table.appendChild(tr)
      }
      wrap.appendChild(table)
      el.appendChild(wrap)
    }
    if (b.caption.length) {
      const caption = doc.createElement('p')
      caption.className = 'caption'
      inline(caption, b.caption)
      el.appendChild(caption)
    }
    return el
  }

  if (b.kind === 'comment') {
    if (!b.text.trim()) return null
    const el = doc.createElement('div')
    el.id = id
    el.className = 'note'
    el.textContent = b.text
    return el
  }

  if (b.kind === 'unknown') {
    const el = doc.createElement('pre')
    el.id = id
    el.textContent = b.raw
    return el
  }

  return null
}

/**
 * The whole paper: title, byline, section list, then the text.
 *
 * Returns a fragment rather than writing into a container, so the caller
 * decides when the swap happens. That matters more than it sounds: replacing a
 * container's contents piece by piece shows a reader a half-drawn paper, and on
 * a slow machine the half that is drawn first is the previous epic's.
 */
export function paper(doc: Document, p: Paper): DocumentFragment {
  const frag = doc.createDocumentFragment()
  const article = doc.createElement('article')
  article.className = 'paper'

  const title = doc.createElement('h2')
  title.className = 'title'
  title.textContent = p.title ?? p.epic
  article.appendChild(title)

  const byline = doc.createElement('p')
  byline.className = 'byline'
  /* The epic slug is always named, even when the paper has a title, because the
     title is the paper's claim about itself and the slug is the thing the host
     and the reader are both actually standing on. A pane showing "Every mode is
     a module" with no way to tell which epic that is answers the wrong
     question. */
  byline.textContent = [p.author, p.epic, p.files.length > 1 ? `${p.files.length} files` : null]
    .filter(Boolean)
    .join(' · ')
  article.appendChild(byline)

  if (p.outline.length > 1) {
    const toc = doc.createElement('details')
    toc.className = 'toc'
    const summary = doc.createElement('summary')
    summary.textContent = `${p.outline.length} sections`
    toc.appendChild(summary)
    const list = doc.createElement('ol')
    /* The outline is built from the same blocks the text is, so an entry and
       its heading cannot disagree about their id — which is the failure a
       separately-derived table of contents always eventually has. */
    const headings = p.blocks.filter((b) => b.kind === 'heading')
    for (const [index, entry] of p.outline.entries()) {
      const source = headings[index]
      if (!source) continue
      const li = doc.createElement('li')
      li.dataset.level = String(entry.level)
      const link = doc.createElement('a')
      link.href = `#${anchorId(source.file, source.id)}`
      link.textContent = entry.text
      li.appendChild(link)
      list.appendChild(li)
    }
    toc.appendChild(list)
    article.appendChild(toc)
  }

  for (const b of p.blocks) {
    const el = block(doc, b)
    if (el) article.appendChild(el)
  }

  frag.appendChild(article)
  return frag
}
