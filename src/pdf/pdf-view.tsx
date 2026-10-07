import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'

import type { PageRect } from '../../compile/synctex.ts'
import { tighten, wordAt, type Run } from './words.ts'

/**
 * The compiled PDF, drawn with pdf.js.
 *
 * ## Why pdf.js and not the browser's own viewer
 *
 * A PDF can be shown with one `<iframe>` and no dependency. That viewer is a
 * sealed box: it cannot be told "draw a rectangle here" and it does not say
 * where a click landed, so neither direction of source-and-PDF navigation is
 * possible through it. It is also not there at all in a sandboxed frame in
 * some browsers, which is exactly where this page lives.
 *
 * pdf.js draws each page onto a canvas this page owns. A click is then a
 * coordinate, a highlight is a positioned box, and the page's own text is
 * available for the word matching in `words.ts`. The cost is the weight —
 * about 450 kB for the library and 1.3 MB for its worker, before compression —
 * so it is loaded only when there is a PDF to show, by a dynamic import, and
 * the editor is usable before it arrives.
 *
 * The LEGACY build, on purpose: the host frames this page in a desktop
 * webview as well as in a browser, and the modern build assumes platform
 * features that one of those gets a release or two late.
 *
 * ## The last good PDF stays
 *
 * A new `url` is loaded BESIDE the document on screen, and replaces it only
 * once it has opened. Each page then draws into an offscreen canvas and swaps,
 * so a recompile repaints pages in place — no blank sheet between two builds,
 * and the scroll position, which belongs to a container that never unmounts,
 * does not move. When there is no new `url` because a compile failed, nothing
 * here changes at all, which is the whole of "the last good PDF stays".
 *
 * ## Units
 *
 * Everything crossing this component's boundary is in PDF points from the
 * top-left of a page, y down — the units `compile/synctex.ts` answers in. The
 * scale to CSS pixels is this component's own business.
 */

export interface PdfMark {
  rects: readonly PageRect[]
  /** The source the rectangles are for, when the ends should be tightened to its words. */
  source: string | null
  /** A passage somebody else pointed at, rather than this page's own selection. Drawn in the other colour. */
  foreign?: boolean
}

export interface PreviewProps {
  /** Where the PDF's bytes are. Changes when a new build lands. Null when there is none. */
  url: string | null
  marks: readonly PdfMark[]
  /** Scroll the first rectangle of the first mark into view, once per new `nonce`. */
  reveal: { nonce: number } | null
  /** A press on a page: which page, where in PDF points, and the word under it if the PDF's text says. */
  onPoint(point: { page: number; x: number; y: number; word: string | null }): void
  /** The page most in view changed. One-based. */
  onPage?(page: number): void
}

export type Preview = ComponentType<PreviewProps>

/* Structural, so no pdf.js type is needed before the library is imported. */
interface PdfPage {
  getViewport(options: { scale: number }): { width: number; height: number }
  render(options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void }
  getTextContent(): Promise<{ items: unknown[] }>
}
interface PdfDocument {
  numPages: number
  getPage(n: number): Promise<PdfPage>
}
/** What `getDocument` hands back. The TASK is what is destroyed, and the worker's copy of the file with it. */
interface PdfTask {
  promise: Promise<PdfDocument>
  destroy(): Promise<void>
}

let library: Promise<{ getDocument(source: { data: Uint8Array }): PdfTask }> | null = null

function pdfjs() {
  library ??= (async () => {
    const [lib, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ])
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib as unknown as { getDocument(source: { data: Uint8Array }): PdfTask }
  })()
  return library
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const GAP = 10
const PAD = 8

export function PdfView({ url, marks, reveal, onPoint, onPage }: PreviewProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([])
  const [trouble, setTrouble] = useState('')
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [version, setVersion] = useState(0)
  const runs = useRef<Map<number, Run[]>>(new Map())
  const held = useRef<PdfTask | null>(null)
  const [, setRunsTick] = useState(0)

  /* Load the new document beside the old one; swap when it has opened. */
  useEffect(() => {
    if (!url) return
    let stopped = false
    void (async () => {
      try {
        const [lib, response] = await Promise.all([pdfjs(), fetch(url)])
        if (!response.ok) throw new Error(`the server answered ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        const task = lib.getDocument({ data })
        const next = await task.promise
        const measured: { w: number; h: number }[] = []
        for (let n = 1; n <= next.numPages; n += 1) {
          const view = (await next.getPage(n)).getViewport({ scale: 1 })
          measured.push({ w: view.width, h: view.height })
        }
        if (stopped) {
          void task.destroy().catch(() => {})
          return
        }
        runs.current = new Map()
        setSizes(measured)
        const old = held.current
        held.current = task
        setDoc(next)
        /* After the swap, and not before: the pages on screen were drawn from
           the old document and are still being looked at. */
        if (old) void old.destroy().catch(() => {})
        setVersion((n) => n + 1)
        setTrouble('')
      } catch (e) {
        if (!stopped) setTrouble(`The PDF could not be shown: ${(e as Error).message}`)
      }
    })()
    return () => {
      stopped = true
    }
  }, [url])

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    const measure = () => setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(node)
    return () => watch.disconnect()
  }, [])

  /* Fit the WIDEST page to the pane, then the person's zoom on top. */
  const widest = sizes.reduce((most, one) => Math.max(most, one.w), 0)
  const scale = widest > 0 && width > 0 ? (Math.max(width - PAD * 2, 60) / widest) * zoom : 0

  const textOf = useCallback(
    async (page: number): Promise<Run[]> => {
      const had = runs.current.get(page)
      if (had) return had
      if (!doc) return []
      const sheet = await doc.getPage(page)
      const height = sheet.getViewport({ scale: 1 }).height
      const content = await sheet.getTextContent()
      const out: Run[] = []
      for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
        if (typeof item.str !== 'string' || !item.transform || !item.str) continue
        const h = item.height || Math.abs(item.transform[3] ?? 0) || 10
        /* pdf.js gives the BASELINE's left end, from the bottom-left. */
        out.push({ x: item.transform[4] ?? 0, y: height - (item.transform[5] ?? 0) - h, w: item.width ?? 0, h, text: item.str })
      }
      runs.current.set(page, out)
      setRunsTick((n) => n + 1)
      return out
    },
    [doc],
  )

  /* The words of every page a mark is on, so its ends can be tightened. */
  useEffect(() => {
    for (const mark of marks) {
      if (!mark.source) continue
      for (const rect of mark.rects) if (!runs.current.has(rect.page)) void textOf(rect.page).catch(() => {})
    }
  }, [marks, textOf])

  const drawn = useMemo(() => {
    const byPage = new Map<number, { rect: PageRect; foreign: boolean }[]>()
    for (const mark of marks) {
      const pages = new Map<number, PageRect[]>()
      for (const rect of mark.rects) pages.set(rect.page, [...(pages.get(rect.page) ?? []), rect])
      const all = [...pages.keys()].sort((a, b) => a - b)
      for (const page of all) {
        let rects = pages.get(page)!
        const text = runs.current.get(page)
        /* Tightened only when the whole mark is on one page: the first word
           and the last are then both looked for among that page's words. */
        if (mark.source && text && all.length === 1) rects = tighten(rects, text, mark.source).map((box, i) => ({ ...rects[i]!, ...box }))
        byPage.set(page, [...(byPage.get(page) ?? []), ...rects.map((rect) => ({ rect, foreign: mark.foreign === true }))])
      }
    }
    return byPage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, version, runs.current.size])

  useEffect(() => {
    if (!reveal) return
    const first = marks[0]?.rects[0]
    const node = scroller.current
    if (!first || !node || scale <= 0) return
    let top = PAD
    for (let n = 1; n < first.page; n += 1) top += (sizes[n - 1]?.h ?? 0) * scale + GAP
    const y = top + first.y * scale
    /* Only when it is not already comfortably in view: a caret moving down a
       paragraph should not drag the page with every line. */
    if (y < node.scrollTop + 24 || y > node.scrollTop + node.clientHeight - 48) {
      node.scrollTo({ top: Math.max(0, y - node.clientHeight / 3), behavior: 'smooth' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce])

  const onScroll = useCallback(() => {
    const node = scroller.current
    if (!node || !onPage || scale <= 0) return
    const middle = node.scrollTop + node.clientHeight / 2
    let top = PAD
    for (let n = 1; n <= sizes.length; n += 1) {
      const height = sizes[n - 1]!.h * scale + GAP
      if (middle < top + height || n === sizes.length) {
        onPage(n)
        return
      }
      top += height
    }
  }, [onPage, scale, sizes])

  const press = useCallback(
    async (page: number, event: React.MouseEvent<HTMLDivElement>) => {
      if (scale <= 0) return
      const box = event.currentTarget.getBoundingClientRect()
      const x = (event.clientX - box.left) / scale
      const y = (event.clientY - box.top) / scale
      let word: string | null = null
      try {
        word = wordAt(await textOf(page), x, y)
      } catch {
        word = null
      }
      onPoint({ page, x, y, word })
    },
    [onPoint, scale, textOf],
  )

  const step = (by: 1 | -1) => {
    const at = ZOOMS.indexOf(zoom)
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (at === -1 ? 2 : at) + by))]
    if (next) setZoom(next)
  }

  return (
    <div className="pdf-pane relative flex h-full min-h-0 flex-col">
      {doc && (
        <div className="pdf-zoom absolute top-1 right-1 z-10 flex items-center gap-0.5 rounded border bg-background/90 p-0.5 text-[0.7rem]">
          <button type="button" className="hover:bg-accent size-5 rounded" onClick={() => step(-1)} aria-label="Zoom out" disabled={zoom <= ZOOMS[0]!}>
            −
          </button>
          <button type="button" className="hover:bg-accent h-5 rounded px-1 tabular-nums" onClick={() => setZoom(1)} title="Fit the width">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" className="hover:bg-accent size-5 rounded" onClick={() => step(1)} aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]!}>
            +
          </button>
        </div>
      )}
      <div ref={scroller} className="pdf-scroller min-h-0 flex-1 overflow-auto" onScroll={onScroll} style={{ padding: PAD }}>
        {trouble && <p className="text-muted-foreground p-2 text-xs">{trouble}</p>}
        {doc
          && scale > 0
          && sizes.map((size, i) => (
            <PageCanvas
              key={i}
              doc={doc}
              version={version}
              number={i + 1}
              width={size.w}
              height={size.h}
              scale={scale}
              root={scroller}
              marks={drawn.get(i + 1) ?? []}
              onPress={press}
            />
          ))}
      </div>
    </div>
  )
}

function PageCanvas({
  doc,
  version,
  number,
  width,
  height,
  scale,
  root,
  marks,
  onPress,
}: {
  doc: PdfDocument
  version: number
  number: number
  width: number
  height: number
  scale: number
  root: React.RefObject<HTMLDivElement | null>
  marks: { rect: PageRect; foreign: boolean }[]
  onPress(page: number, event: React.MouseEvent<HTMLDivElement>): void
}) {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)

  /* Drawn only when near the viewport. A thesis is two hundred pages and a
     canvas each, at a retina scale, is more memory than the tab has. */
  useEffect(() => {
    const node = holder.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const watch = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), {
      root: root.current,
      rootMargin: '600px 0px',
    })
    watch.observe(node)
    return () => watch.disconnect()
  }, [root])

  useEffect(() => {
    if (!near) return
    let stopped = false
    let task: { promise: Promise<void>; cancel(): void } | null = null
    /* A pause before drawing, so dragging a divider does not render the page
       once per pixel of width. */
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const page = await doc.getPage(number)
          if (stopped) return
          const ratio = Math.min(window.devicePixelRatio || 1, 2)
          const viewport = page.getViewport({ scale: scale * ratio }) as { width: number; height: number }
          const off = document.createElement('canvas')
          off.width = Math.max(1, Math.floor(viewport.width))
          off.height = Math.max(1, Math.floor(viewport.height))
          const context = off.getContext('2d')
          if (!context) return
          task = page.render({ canvas: off, canvasContext: context, viewport })
          await task.promise
          const shown = canvas.current
          if (stopped || !shown) return
          shown.width = off.width
          shown.height = off.height
          shown.getContext('2d')?.drawImage(off, 0, 0)
        } catch {
          /* Cancelled by the next draw, or a page the PDF cannot give. The
             sheet stays as it was. */
        }
      })()
    }, 60)
    return () => {
      stopped = true
      clearTimeout(timer)
      task?.cancel()
    }
  }, [doc, version, number, scale, near])

  return (
    <div
      ref={holder}
      className="pdf-page relative mx-auto bg-white"
      data-page={number}
      style={{ width: width * scale, height: height * scale, marginBottom: GAP }}
      onClick={(event) => onPress(number, event)}
    >
      <canvas ref={canvas} className="block size-full" />
      {marks.map(({ rect, foreign }, i) => (
        <span
          key={i}
          className={foreign ? 'pdf-mark pdf-mark-foreign' : 'pdf-mark'}
          style={{ left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale }}
        />
      ))}
    </div>
  )
}
