import { useSyncExternalStore } from 'react'

/**
 * Whether the host's find bar is open on this page (protocol 2.69.0), and the wait for the PDF's
 * words to be laid out on every page before a search reads them.
 *
 * The search itself is the protocol client's own (`pageFind`): it walks the page's visible text,
 * and in the PDF that text is pdf.js's text layer — which `pdf-view.tsx` lays only on the pages
 * near the view, to keep the canvases few. While a search is open every page gets its text layer
 * (the canvas still waits for the view), so the count is the whole paper's and the next match can
 * be on a page nobody has scrolled to. The source editor searches itself (its own ⌘F), so the
 * client's search skips it (`data-kehikot-find-skip`).
 */

let open = false
const hearers = new Set<() => void>()

export function setFinding(next: boolean): void {
  if (next === open) return
  open = next
  for (const heard of [...hearers]) heard()
}

export function finding(): boolean {
  return open
}

/** Whether a search is open, for a component that lays out text for it. */
export function useFinding(): boolean {
  return useSyncExternalStore(
    (heard) => {
      hearers.add(heard)
      return () => void hearers.delete(heard)
    },
    () => open,
    () => false,
  )
}

/** How long a search waits for the pages' words before it reads what is there. */
export const LAID_OUT_WITHIN_MS = 4000

/**
 * Resolves once every page of the PDF on screen has its text layer, or after `within` milliseconds
 * whatever is laid out by then — a search reads what there is rather than wait for ever. At once
 * when no PDF is drawn.
 */
export function textLaidOut(root: ParentNode = document, within = LAID_OUT_WITHIN_MS, every = 50): Promise<void> {
  const done = () => {
    const pages = root.querySelectorAll('.pdf-page')
    if (pages.length === 0) return true
    for (const page of pages) if (!page.querySelector('.textLayer')) return false
    return true
  }
  return new Promise((resolve) => {
    if (done()) return resolve()
    const started = Date.now()
    const look = setInterval(() => {
      if (!done() && Date.now() - started < within) return
      clearInterval(look)
      resolve()
    }, every)
  })
}
