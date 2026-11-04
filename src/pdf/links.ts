import type { PageRect } from '../../compile/synctex.ts'

/**
 * The links a page of the PDF carries, and where a press on one goes.
 *
 * `hyperref` writes each `\href`, `\url`, `\ref` and table-of-contents line as
 * a Link annotation: a rectangle on the page and either an address (a URI
 * action) or a destination inside the document. pdf.js reads them
 * (`getAnnotations`); this file turns what it read into something this page can
 * draw and press, and nothing else.
 *
 * ## Why not pdf.js's own AnnotationLayer
 *
 * It needs the viewer's link service (another 470 kB module) and, given an
 * address, makes an `<a target="_blank">` of it and lets the browser open it.
 * An address in a paper is untrusted text: it is handed to the canvas, which
 * applies the host's rules (`address.open`), and opened in a new tab only when
 * nothing on the canvas took it — and then only if it is `http:` or `https:`.
 * So the rectangles are drawn here and the press is this page's.
 */

/** Where a link goes: an address on the web, or a place in this PDF. */
export type LinkTarget = { kind: 'web'; url: string } | { kind: 'dest'; dest: string | readonly unknown[] }

export interface PageLink {
  /** In PDF points from the top-left of the page, y down: the units of everything else here. */
  rect: PageRect
  to: LinkTarget
}

/**
 * An address a press may open: `http:` or `https:`, parsed, nothing else.
 * `javascript:`, `file:`, `data:` and the rest are never a link here: such a
 * rectangle is not drawn at all. The canvas holds an address to stricter rules
 * still (`addressRefusal` in the protocol); this is the floor for the new tab.
 */
export function webAddressOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || /[\u0000-\u0020\u007f-\u009f]/.test(value)) return null
  /* As written, not as the parser respelled it: it is the paper's address. */
  return value
}

/** pdf.js's annotation, the fields read here. Everything else it says is ignored. */
interface Annotation {
  subtype?: unknown
  rect?: unknown
  url?: unknown
  unsafeUrl?: unknown
  dest?: unknown
}

/**
 * The page's links, from what `getAnnotations` gave, for a page `height` points tall.
 * A Link with neither a usable address nor a destination is left out: a
 * rectangle that does nothing when pressed is worse than none.
 */
export function linksOf(annotations: readonly unknown[], height: number): PageLink[] {
  const out: PageLink[] = []
  for (const one of annotations as Annotation[]) {
    if (!one || one.subtype !== 'Link' || !Array.isArray(one.rect) || one.rect.length !== 4) continue
    const [x1, y1, x2, y2] = one.rect.map(Number) as [number, number, number, number]
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue
    const rect = { page: 0, x: Math.min(x1, x2), y: height - Math.max(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
    if (!(rect.w > 0) || !(rect.h > 0)) continue
    /* pdf.js fills `url` only for an address it judged absolute and safe; `unsafeUrl` is what the file says. Either is checked here again. */
    const url = webAddressOf(one.url) ?? webAddressOf(one.unsafeUrl)
    if (url) {
      out.push({ rect, to: { kind: 'web', url } })
      continue
    }
    if ((typeof one.dest === 'string' && one.dest) || (Array.isArray(one.dest) && one.dest.length)) {
      out.push({ rect, to: { kind: 'dest', dest: one.dest as string | unknown[] } })
    }
  }
  return out
}

/** Enough of a pdf.js document to resolve a destination. */
export interface Destinations {
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: unknown): Promise<number>
  getPage(n: number): Promise<{ getViewport(options: { scale: number }): { height: number } }>
}

/**
 * Where a destination is: a one-based page and, when the destination says, how
 * far down it in points from the top. Null when the PDF does not know it.
 *
 * An explicit destination is `[page, {name}, ...args]`: the page a reference or
 * a zero-based number, and for `XYZ` the args `left, top, zoom`, for `FitH` and
 * `FitBH` just `top` — `top` from the BOTTOM of the page, as PDF counts.
 */
export async function placeOf(doc: Destinations, dest: string | readonly unknown[]): Promise<{ page: number; y: number | null } | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || !explicit.length) return null
    const [ref, kind] = explicit
    const index = typeof ref === 'number' ? ref : ref && typeof ref === 'object' ? await doc.getPageIndex(ref) : -1
    if (!Number.isInteger(index) || index < 0) return null
    const page = index + 1
    const name = (kind as { name?: unknown } | null)?.name
    const top = name === 'XYZ' ? explicit[3] : name === 'FitH' || name === 'FitBH' ? explicit[2] : null
    if (typeof top !== 'number' || !Number.isFinite(top)) return { page, y: null }
    const height = (await doc.getPage(page)).getViewport({ scale: 1 }).height
    return { page, y: Math.max(0, height - top) }
  } catch {
    return null
  }
}

/** What happened to an address: the canvas took it, or this page opened it in a tab. */
export type Followed = 'canvas' | 'tab' | 'nowhere'

/**
 * Follow an address a person pressed.
 *
 * Handed to the canvas first (`toCanvas`: the host's `address.open`), which
 * opens it in the module there that shows pages, or puts it in front of the
 * person when there is none — both an answer, and nothing more is done. When
 * nothing is framing this page, the host does not answer `address.open`, or it
 * declined, the address is opened in a new tab: never nowhere, and never a
 * scheme other than `http:` and `https:`.
 */
export async function follow(
  url: string,
  toCanvas: ((url: string) => Promise<{ outcome: string } | null>) | undefined,
  openTab: (url: string) => void,
): Promise<Followed> {
  const address = webAddressOf(url)
  if (!address) return 'nowhere'
  if (toCanvas) {
    const answer = await toCanvas(address).catch(() => null)
    if (answer && answer.outcome !== 'declined') return 'canvas'
  }
  openTab(address)
  return 'tab'
}
