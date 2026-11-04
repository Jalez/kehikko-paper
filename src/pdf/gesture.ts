/**
 * A press on the PDF, told apart from a drag that selects text.
 *
 * Since 2.10.0 the pages carry pdf.js's text layer, so dragging over a page
 * selects its words the way any PDF reader does. A drag still ends in a
 * `click` on the page it ends on (the browser fires one whenever the button
 * goes down and up inside the same element), and that click used to be a
 * press: it asked the source for the one word under the pointer and moved the
 * editor there, on top of the selection the person had just made.
 *
 * The rule, in `isDrag`: a click is a DRAG — not a press — when the pointer
 * travelled more than `SLOP` pixels since the button went down, or when the
 * document holds a selection that is not empty. A plain click collapses any
 * selection on the way down, so a press is never mistaken for a drag; a
 * double press is two presses and a `dblclick`, as before; and a drag over
 * the margin, which selects nothing, is still not a press.
 *
 * A drag that selected words is a PICK (`endsOf`): the selection's first and
 * last line, each as a page and a point on it, which the workspace asks the
 * source about the way it asks about a press — and selects that stretch of
 * the source, which is what is pointed at for the canvas.
 */

/** How far, in CSS pixels, a press may wander and still be a press. */
export const SLOP = 4

export function isDrag(down: { x: number; y: number } | null, up: { x: number; y: number }, selected: boolean): boolean {
  if (selected) return true
  if (!down) return false
  return Math.hypot(up.x - down.x, up.y - down.y) > SLOP
}

/** A rectangle on screen, in CSS pixels: what `getClientRects` hands back. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** A sheet on screen: its PDF page number and where its box is now. */
export interface Sheet {
  page: number
  box: Box
}

/** A point on a page, in PDF points from its top-left, y down. */
export interface PagePoint {
  page: number
  x: number
  y: number
}

/**
 * Where a selection begins and ends, from the rectangles of its lines
 * (`range.getClientRects()`) and the sheets on screen, at `scale` CSS pixels
 * to a point.
 *
 * Its start is just inside the left end of its first rectangle that lies on a
 * sheet, and its end just inside the right end of its last; each the middle
 * of its line. Empty rectangles — the browser hands back zero-width ones at
 * line ends — and rectangles off every sheet are passed over. Null when no
 * rectangle is on a sheet: nothing on a page was selected.
 */
export function endsOf(rects: readonly Box[], sheets: readonly Sheet[], scale: number): { from: PagePoint; to: PagePoint } | null {
  if (!(scale > 0)) return null
  const on: { rect: Box; sheet: Sheet }[] = []
  for (const rect of rects) {
    if (!(rect.right - rect.left > 0.5) || !(rect.bottom - rect.top > 0.5)) continue
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    const sheet = sheets.find(({ box }) => cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom)
    if (sheet) on.push({ rect, sheet })
  }
  const first = on[0]
  const last = on[on.length - 1]
  if (!first || !last) return null
  const inside = Math.min(1, (first.rect.right - first.rect.left) / 2)
  const insideLast = Math.min(1, (last.rect.right - last.rect.left) / 2)
  return {
    from: {
      page: first.sheet.page,
      x: (first.rect.left + inside - first.sheet.box.left) / scale,
      y: ((first.rect.top + first.rect.bottom) / 2 - first.sheet.box.top) / scale,
    },
    to: {
      page: last.sheet.page,
      x: (last.rect.right - insideLast - last.sheet.box.left) / scale,
      y: ((last.rect.top + last.rect.bottom) / 2 - last.sheet.box.top) / scale,
    },
  }
}
