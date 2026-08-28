/**
 * Map a browser text selection back onto byte offsets in the `.tex` source.
 *
 * Every rendered span carries the source range it came from and whether its
 * rendered text is character-identical to that source:
 *
 *   data-src-start / data-src-end / data-literal
 *
 * For a literal span, an offset inside the rendered text is also an offset into
 * the source, so this can be exact. For a derived span — a macro expansion, a
 * collapsed line break, the pin in front of a todonote — there is no honest
 * character-level correspondence, so the selection snaps outward to the whole
 * span and says so.
 *
 * Snapping outward rather than guessing is deliberate, and it is the whole
 * reason this file is worth carrying over rather than reaching for
 * `window.getSelection().toString()`. A range that is slightly too wide still
 * names the right sentence; a fabricated offset names a place in the file that
 * is not where the reader was looking, and nothing downstream could tell.
 *
 * ## This module writes nothing, and this file is why that is still useful
 *
 * The reader this came from used these offsets to POST an edit. There is no
 * write path here and there is not going to be one — the argument is in
 * `doors.ts`. What a source range is still good for is CITATION: "this passage,
 * `chapters/2_bridge.tex` bytes 4120–4380" is a thing a reader can paste into a
 * conversation with an agent, and it is exact enough for that agent to open the
 * file and find the passage. So the mapping is restored and the button on the
 * end of it copies rather than posts.
 */

export interface SourceSelection {
  srcStart: number
  srcEnd: number
  /** The rendered text the reader actually highlighted. */
  rendered: string
  /** True when both ends landed on literal spans and are character-exact. */
  exact: boolean
}

const SEG = '[data-src-start]'

/** Nearest ancestor (inclusive) that carries source-range data. */
function segmentOf(node: Node | null): HTMLElement | null {
  let el: Node | null = node
  while (el && el.nodeType !== 1) el = el.parentNode
  return (el as HTMLElement | null)?.closest?.(SEG) ?? null
}

const startOf = (el: HTMLElement) => Number(el.dataset.srcStart)
const endOf = (el: HTMLElement) => Number(el.dataset.srcEnd)
const isLiteral = (el: HTMLElement) => el.dataset.literal === '1'

/**
 * Characters of rendered text preceding `offset` within `container`, counted
 * from the start of `seg`.
 *
 * A segment normally holds a single text node, but the style nesting splits it
 * — `\emph{\texttt{x}}` is a span holding an `<em>` holding a `<code>` — so
 * this walks rather than assumes.
 */
function offsetWithinSegment(seg: HTMLElement, container: Node, offset: number): number {
  if (container === seg) {
    let count = 0
    for (let i = 0; i < offset && i < seg.childNodes.length; i++) {
      count += seg.childNodes[i]?.textContent?.length ?? 0
    }
    return count
  }
  const walker = document.createTreeWalker(seg, NodeFilter.SHOW_TEXT)
  let count = 0
  let node = walker.nextNode()
  while (node) {
    if (node === container) return count + offset
    count += node.textContent?.length ?? 0
    node = walker.nextNode()
  }
  return 0
}

/** Resolve the current selection inside `root` to a source range, or null. */
export function readSelection(root: HTMLElement): SourceSelection | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null

  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null

  const rendered = sel.toString()
  if (!rendered.trim()) return null

  const startSeg = segmentOf(range.startContainer)
  const endSeg = segmentOf(range.endContainer)

  /* Every segment the range touches. This is the safety net for a selection
     that begins or ends in the whitespace between two spans, where the
     endpoints resolve to nothing useful on their own. */
  const touched: HTMLElement[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(SEG))) {
    if (range.intersectsNode(el)) touched.push(el)
  }
  if (!touched.length && !startSeg && !endSeg) return null

  let srcStart: number
  let srcEnd: number
  let exact = true

  if (startSeg && range.intersectsNode(startSeg)) {
    if (isLiteral(startSeg)) {
      srcStart = startOf(startSeg) + offsetWithinSegment(startSeg, range.startContainer, range.startOffset)
    } else {
      srcStart = startOf(startSeg)
      exact = false
    }
  } else {
    srcStart = Math.min(...touched.map(startOf))
    exact = false
  }

  if (endSeg && range.intersectsNode(endSeg)) {
    if (isLiteral(endSeg)) {
      srcEnd = startOf(endSeg) + offsetWithinSegment(endSeg, range.endContainer, range.endOffset)
    } else {
      srcEnd = endOf(endSeg)
      exact = false
    }
  } else {
    srcEnd = Math.max(...touched.map(endOf))
    exact = false
  }

  /* A backwards or degenerate result means the endpoint reasoning failed. Fall
     back to the union of everything the range touched rather than returning a
     range that names the wrong text — the failure this file exists to prevent
     is a confidently wrong offset, not a missing one. */
  if (!Number.isFinite(srcStart) || !Number.isFinite(srcEnd) || srcEnd <= srcStart) {
    if (!touched.length) return null
    srcStart = Math.min(...touched.map(startOf))
    srcEnd = Math.max(...touched.map(endOf))
    exact = false
  }

  return { srcStart, srcEnd, rendered, exact }
}

/** Which file the selection landed in, read off the block it is inside. */
export function fileOfSelection(root: HTMLElement, blockFiles: ReadonlyMap<string, string>): string | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  let node: Node | null = sel.getRangeAt(0).commonAncestorContainer
  while (node && node.nodeType !== 1) node = node.parentNode
  const row = (node as HTMLElement | null)?.closest?.('[data-block-id]')
  const anchor = row?.getAttribute('data-block-id')
  return (anchor && blockFiles.get(anchor)) ?? null
}

/** Viewport rectangle of the current selection, for positioning the popover. */
export function selectionRect(): DOMRect | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const rects = sel.getRangeAt(0).getClientRects()
  if (!rects.length) return null
  /* The last line, so the popover opens below the END of the selection rather
     than in the middle of the text it is about. */
  return rects[rects.length - 1] ?? null
}

export function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}
