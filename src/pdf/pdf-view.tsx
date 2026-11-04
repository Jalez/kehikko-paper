import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'

import type { PageRect } from '../../compile/synctex.ts'
import { locate, read, type Text } from './find.ts'
import { endsOf, isDrag, type Sheet } from './gesture.ts'
import { follow, linksOf, placeOf, type PageLink } from './links.ts'
import { spanOf } from './printed.ts'
import { wordAt, type Run } from './words.ts'

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
 * there to be read: it is where a mark is put (`find.ts`). The cost is the weight —
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
 * ## Only some of the pages, under a focus
 *
 * `pages` is the pages to draw, in the PDF's own numbers; absent or null is
 * all of them, and this component is then exactly what it was. With a list,
 * the others are not drawn, and every sheet carries its REAL number (sheet 7
 * is "p. 7 of 20" with six sheets not drawn above it — other modules store
 * these numbers). Nothing else is said: no rule where sheets were left out,
 * and nothing on a sheet about why it is there.
 *
 * Which pages those are is not decided here. See `src/focus.ts`.
 *
 * ## A PDF that is not the whole paper
 *
 * The picked parts' files may have been compiled on their own, and that PDF
 * has fewer sheets than the paper: its ninth is the paper's seventeenth.
 * `numbers` then says, sheet by sheet, which page of the paper each one is,
 * and what this component SAYS about a sheet — its label — is said in those. Everything it is ASKED and everything it answers
 * about a place (`pages`, a mark's rectangle, a press) stays in the sheets of
 * the PDF it is drawing, since that is the document those places are in.
 *
 * `kind` names which PDF `url` is one of. A new build of the same kind is
 * swapped in under the reader and the scroll does not move; a PDF of another
 * kind is another document, and it opens at `from`.
 *
 * ## Text that can be selected, and links that can be followed
 *
 * Over each canvas lies pdf.js's text layer: the page's words as transparent
 * text, placed where they are printed, so dragging selects them across lines,
 * columns and pages and the selection copies. How a drag is told from a press
 * is `gesture.ts`. A drag that selected words is a pick (`onPick`): its two
 * ends, asked of the source like a press, select that stretch of the source,
 * and that is what the canvas is told is pointed at.
 *
 * Over that lie the page's links (`links.ts`): an address goes to the canvas
 * first (`onAddress`), and to a new tab when nothing there took it; a place in
 * the paper — a `\ref`, a line of the contents — scrolls this pane to it.
 *
 * ## Units
 *
 * Everything crossing this component's boundary is in PDF points from the
 * top-left of a page, y down — the units `compile/synctex.ts` answers in. The
 * scale to CSS pixels is this component's own business.
 */

export interface PdfMark {
  /**
   * Where SyncTeX says the passage's source lines came out. Not where the mark
   * is drawn: it is the hint the passage is looked for beside, and — as whole
   * printed lines — what is drawn when its words are not found. See `find.ts`.
   */
  rects: readonly PageRect[]
  /** The passage: a stretch of a file's text. Null draws the rectangles as they are. */
  source: { text: string; from: number; to: number } | null
  /** A passage somebody else pointed at, rather than this page's own selection. Drawn in the other colour. */
  foreign?: boolean
}

/** A place on a page, in PDF points, and the word printed there if the PDF's text says. */
export interface PdfPoint {
  page: number
  x: number
  y: number
  word: string | null
}

export interface PreviewProps {
  /** Where the PDF's bytes are. Changes when a new build lands. Null when there is none. */
  url: string | null
  marks: readonly PdfMark[]
  /** Scroll the first mark into view — where it is drawn, once it has been looked for — once per new `nonce`. */
  reveal: { nonce: number } | null
  /** A press on a page: which page, where in PDF points, and the word under it if the PDF's text says. */
  onPoint(point: { page: number; x: number; y: number; word: string | null }): void
  /** A double press on a page: the person wants the source it came from in front of them. */
  onOpen?(): void
  /**
   * Words were selected by dragging over them: where the selection begins and ends, each as a press
   * would say it — the first word and the last — and the text selected.
   */
  onPick?(pick: { from: PdfPoint; to: PdfPoint; text: string }): void
  /**
   * A link to an address was pressed. Hand it to the canvas (`address.open`) and say what the host
   * answered, or null when nothing took it; the address is then opened in a new tab. Absent, it always is.
   */
  onAddress?(url: string): Promise<{ outcome: string } | null>
  /** The page most in view changed. One-based. */
  onPage?(page: number): void
  /** How far down to start, in PDF points of what is drawn. Read once, when this is first shown. */
  from?: number
  /** It was scrolled: how far down, in the same points, and in which kind of PDF. Never said by a pane that is not laid out. */
  onScrolled?(top: number, kind?: string): void
  /** Which PDF this is one of: empty for the whole paper, the selection for a part's own. A change of it opens at `from`. */
  kind?: string
  /** Sheet by sheet, the page of the paper each one is; null for a sheet that is not a page anybody numbers. Absent: the sheets are the paper's pages. */
  numbers?: readonly (number | null)[] | null
  /** How many pages the paper has, when `numbers` is given. */
  total?: number | null
  /** The pages to draw, ascending, in the PDF's own numbers. Absent or null draws every page, unlabelled, as always. */
  pages?: readonly number[] | null
}

export type Preview = ComponentType<PreviewProps>

/* Structural, so no pdf.js type is needed before the library is imported. */
interface PdfPage {
  getViewport(options: { scale: number }): { width: number; height: number }
  render(options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel(): void }
  getTextContent(): Promise<{ items: unknown[] }>
  getAnnotations(options?: { intent?: string }): Promise<unknown[]>
  /** Asked for only because it is what makes pdf.js load the page's fonts. */
  getOperatorList(): Promise<unknown>
}
interface PdfDocument {
  numPages: number
  getPage(n: number): Promise<PdfPage>
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: unknown): Promise<number>
}
/** What `getDocument` hands back. The TASK is what is destroyed, and the worker's copy of the file with it. */
interface PdfTask {
  promise: Promise<PdfDocument>
  destroy(): Promise<void>
}

/** pdf.js's text layer, the part of it used here. */
interface TextLayerLike {
  render(): Promise<unknown>
  cancel(): void
}
interface PdfLibrary {
  getDocument(source: { data: Uint8Array }): PdfTask
  TextLayer: new (options: { textContentSource: unknown; container: HTMLElement; viewport: unknown }) => TextLayerLike
}

let library: Promise<PdfLibrary> | null = null

function pdfjs() {
  library ??= (async () => {
    const [lib, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ])
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib as unknown as PdfLibrary
  })()
  return library
}

/**
 * Where each character of a run begins, measured in the font it is printed in.
 *
 * pdf.js says what a run says and how wide it is, and nothing about where its
 * characters are. But it loads every font of a page into the document under
 * the name the run carries, so a canvas can be asked how wide any part of the
 * run is in that very font. Spaces are the one thing not asked: TeX prints
 * none — a space is a gap, stretched to justify the line — and most of its
 * fonts have no glyph for one. So the words are measured and what is left of
 * the run's width is shared equally among its spaces, which is what TeX did.
 *
 * Undefined whenever the answer cannot be trusted: no canvas, the font is not
 * loaded, or the measured words do not fit the run (a font whose glyphs pdf.js
 * had to move elsewhere measures as something else entirely). An edge is then
 * found by proportion along the run (`edge` in `words.ts`).
 */
let ruler: CanvasRenderingContext2D | null | undefined

/**
 * Wait for a page's fonts to be in the document.
 *
 * pdf.js hands a page's fonts to the document a moment AFTER it says the page
 * has been read: the operator list resolves, and the font faces are still
 * loading. A page measured in that moment measures nothing, and its words were
 * then filed unmeasured for as long as the PDF was open — which is how a mark
 * on a page somebody was just TAKEN to, and which had never been drawn, came
 * out a letter or two off at both ends. So the fonts are waited for, briefly, and a
 * font that never arrives (pdf.js draws some as paths, with no face at all) is
 * remembered so that the next page does not wait for it again.
 */
const never = new Set<string>()
async function fontsFor(names: ReadonlySet<string>, ms = 2000): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  const until = Date.now() + ms
  for (;;) {
    const faces = new Map<string, FontFace>()
    for (const face of document.fonts) faces.set(face.family.replace(/^"|"$/g, ''), face)
    const missing = [...names].filter((name) => !never.has(name) && faces.get(name)?.status !== 'loaded')
    if (!missing.length) return
    if (Date.now() >= until) {
      for (const name of missing) never.add(name)
      return
    }
    const pause = new Promise<void>((done) => setTimeout(done, 80))
    await Promise.race([Promise.all(missing.map((name) => faces.get(name)?.loaded.then(() => {}, () => {}) ?? pause)), pause.then(() => new Promise<void>((done) => setTimeout(done, 170)))])
  }
}
function offsetsOf(text: string, width: number, font: string | undefined, size: number): number[] | undefined {
  if (typeof document === 'undefined' || !font || !(size > 0) || !(width > 0)) return undefined
  try {
    let loaded = false
    for (const face of document.fonts) if (face.family.replace(/^"|"$/g, '') === font && face.status === 'loaded') loaded = true
    if (!loaded) return undefined
    if (ruler === undefined) ruler = document.createElement('canvas').getContext('2d')
    if (!ruler) return undefined
    ruler.font = `${size}px "${font}"`
    /* A fixed-pitch font is set a column to a character, however it is
       tracked: by proportion is exact, and sharing the slack among the
       spaces — which is what a justified line wants — is not. */
    if (ruler.measureText('i').width === ruler.measureText('M').width) return undefined
    const parts = text.split(/( +)/)
    let ink = 0
    let spaces = 0
    const widths = parts.map((part) => {
      if (part.startsWith(' ')) {
        spaces += part.length
        return 0
      }
      const w = ruler!.measureText(part).width
      ink += w
      return w
    })
    if (!(ink > 0)) return undefined
    const gap = spaces ? (width - ink) / spaces : 0
    if (spaces ? gap < 0 || gap > size * 3 : Math.abs(width - ink) > Math.max(1, width * 0.06)) return undefined
    const stretch = spaces ? 1 : width / ink
    const xs = [0]
    let at = 0
    parts.forEach((part, index) => {
      if (part.startsWith(' ')) {
        for (let n = 0; n < part.length; n += 1) xs.push((at += gap))
        return
      }
      for (let n = 1; n <= part.length; n += 1) xs.push(at + ruler!.measureText(part.slice(0, n)).width * stretch)
      at += widths[index]! * stretch
    })
    return xs.length === text.length + 1 ? xs : undefined
  } catch {
    return undefined
  }
}

/** A run as pdf.js gave it, with what is needed to measure it later: `offsetsOf`. */
interface Item extends Run {
  font: string | undefined
  size: number
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const GAP = 10
const PAD = 8

export function PdfView({
  url,
  marks,
  reveal,
  onPoint,
  onOpen,
  onPick,
  onAddress,
  onPage,
  from = 0,
  onScrolled,
  pages: asked = null,
  kind = '',
  numbers = null,
  total = null,
}: PreviewProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([])
  const [trouble, setTrouble] = useState('')
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [version, setVersion] = useState(0)
  /** The `url` of the document on screen. */
  const [loaded, setLoaded] = useState<string | null>(null)
  /** The words of each page read so far, and which of those pages have been measured. */
  const runs = useRef<Map<number, Item[]>>(new Map())
  const measured = useRef<Set<number>>(new Set())
  /** Pages laid out to be searched, by which pages: `read` in `find.ts`. */
  const texts = useRef<Map<string, Text>>(new Map())
  /** The document on screen, for an answer that arrives after it was replaced. */
  const shown = useRef<PdfDocument | null>(null)
  const held = useRef<PdfTask | null>(null)
  /** Counts up when pages the marks were waiting for have been read. */
  const [read_, setRead] = useState(0)
  /** The kind of the document on screen, and where one of another kind is to open. */
  const shownKind = useRef(kind)
  const kindNow = useRef(kind)
  kindNow.current = kind
  const fromNow = useRef(from)
  fromNow.current = from
  const moved = useRef(false)

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
        const sized: { w: number; h: number }[] = []
        for (let n = 1; n <= next.numPages; n += 1) {
          const view = (await next.getPage(n)).getViewport({ scale: 1 })
          sized.push({ w: view.width, h: view.height })
        }
        if (stopped) {
          void task.destroy().catch(() => {})
          return
        }
        runs.current = new Map()
        measured.current = new Set()
        texts.current = new Map()
        /* Another document, not a newer build of this one: where the reader
           was in the old one is nowhere in this. It opens where it was left. */
        if (shownKind.current !== kindNow.current) {
          shownKind.current = kindNow.current
          kept.current = fromNow.current
          moved.current = true
        }
        setSizes(sized)
        const old = held.current
        held.current = task
        shown.current = next
        setDoc(next)
        setLoaded(url)
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

  /*
   * A page's words, and — separately, because it is the slow half — where each
   * of their characters is.
   *
   * Reading is one question to pdf.js and is what LOOKING for a passage needs,
   * on every page it might be on. Measuring loads the page's fonts and asks a
   * canvas about every run, and is only needed where a mark is then drawn or a
   * word pressed. Both are kept for as long as the PDF is the one on screen.
   */
  const wordsOf = useCallback(
    async (page: number): Promise<Item[]> => {
      const had = runs.current.get(page)
      if (had) return had
      if (!doc) return []
      const sheet = await doc.getPage(page)
      const height = sheet.getViewport({ scale: 1 }).height
      const content = await sheet.getTextContent()
      const out: Item[] = []
      for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string }[]) {
        if (typeof item.str !== 'string' || !item.transform || !item.str) continue
        const h = item.height || Math.abs(item.transform[3] ?? 0) || 10
        /* pdf.js gives the BASELINE's left end, from the bottom-left. */
        out.push({
          x: item.transform[4] ?? 0,
          y: height - (item.transform[5] ?? 0) - h,
          w: item.width ?? 0,
          h,
          text: item.str,
          font: item.fontName,
          size: Math.hypot(item.transform[0] ?? 0, item.transform[1] ?? 0),
        })
      }
      /* A new build landed while this page was being read: these are the old
         PDF's words, and filing them would have every mark on this page
         looked for among words that are no longer where they say. */
      if (shown.current === doc && !runs.current.has(page)) runs.current.set(page, out)
      return runs.current.get(page) ?? out
    },
    [doc],
  )
  const measure = useCallback(
    async (page: number): Promise<Item[]> => {
      const items = await wordsOf(page)
      if (!doc || measured.current.has(page)) return items
      /* The fonts are loaded by the first thing that DRAWS the page, and the
         words may be asked for before that. Without them nothing is measured. */
      await (await doc.getPage(page)).getOperatorList().catch(() => {})
      await fontsFor(new Set(items.flatMap((item) => (item.font ? [item.font] : [])))).catch(() => {})
      if (shown.current !== doc || measured.current.has(page)) return items
      for (const item of items) {
        const xs = offsetsOf(item.text, item.w, item.font, item.size)
        if (xs) item.xs = xs
      }
      measured.current.add(page)
      return items
    },
    [doc, wordsOf],
  )

  /* Where each mark is drawn: looked for in the PDF's own text, beside where
     SyncTeX said. Worked out here, in the render, from pages already read — so
     that a mark whose passage has not moved is the same rectangles again and
     nothing is redrawn — and a page not read yet is asked for (`owed`) and
     the mark waits for it rather than being drawn somewhere else first. */
  const now = useMemo(() => {
    const byPage = new Map<number, { rect: PageRect; foreign: boolean; coarse: boolean }[]>()
    const owed = { words: new Set<number>(), measured: new Set<number>() }
    const count = sizes.length
    const textOf = (pages: readonly number[]): Text | null => {
      const missing = pages.filter((page) => !runs.current.has(page))
      for (const page of missing) owed.words.add(page)
      if (missing.length) return null
      const key = pages.length === count ? 'all' : pages.join(',')
      let text = texts.current.get(key)
      if (!text) texts.current.set(key, (text = read(pages.map((page) => ({ page, runs: runs.current.get(page)! })))))
      return text
    }
    const place = (mark: PdfMark): { rects: readonly PageRect[]; coarse: boolean } | null => {
      if (!mark.source) return { rects: mark.rects, coarse: false }
      const sought = spanOf(mark.source.text, mark.source.from, mark.source.to)
      const every = Array.from({ length: count }, (_, i) => i + 1)
      /* Beside where SyncTeX said first — its pages and one either side — and
         the whole PDF only when it is not there. */
      const beside = every.filter((page) => mark.rects.some((rect) => Math.abs(rect.page - page) <= 1))
      const near = textOf(beside.length ? beside : every)
      if (!near) return null
      let found = locate(near, sought, mark.rects)
      const prints = sought.core[1] > sought.core[0]
      if (found.how === 'lines' && prints && beside.length && beside.length < count) {
        const whole = textOf(every)
        if (!whole) return null
        const again = locate(whole, sought, mark.rects)
        if (again.how === 'words') found = again
      }
      /* Whole lines are as wide as their runs; only a mark that ends inside a line needs its letters measured. */
      if (found.how === 'lines') return { rects: found.rects, coarse: true }
      const unmeasured = [...new Set(found.rects.map((rect) => rect.page))].filter((page) => !measured.current.has(page))
      for (const page of unmeasured) owed.measured.add(page)
      return unmeasured.length ? null : { rects: found.rects, coarse: false }
    }
    /* Where the first mark is DRAWN, for `reveal` — or undefined while it is
       still being looked for, and where it is drawn is not known. */
    let first: PageRect | null | undefined = null
    if (count) {
      for (const mark of marks) {
        const placed = place(mark)
        if (!placed) {
          if (mark === marks[0]) first = undefined
          continue
        }
        for (const rect of placed.rects) byPage.set(rect.page, [...(byPage.get(rect.page) ?? []), { rect, foreign: mark.foreign === true, coarse: placed.coarse }])
        if (mark === marks[0]) first = placed.rects[0] ?? mark.rects[0] ?? null
      }
    }
    return { drawn: byPage, first, owed }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, version, read_, sizes.length])
  /* Read what the marks are waiting for, then look again. A page that cannot
     be read is filed as saying nothing, so that nothing is left waiting. */
  useEffect(() => {
    const { owed } = now
    if (!doc || (!owed.words.size && !owed.measured.size)) return
    let stopped = false
    const filed = (page: number) => {
      if (shown.current !== doc) return
      if (!runs.current.has(page)) runs.current.set(page, [])
      measured.current.add(page)
    }
    void Promise.all([
      ...[...owed.words].map((page) => wordsOf(page).catch(() => filed(page))),
      ...[...owed.measured].map((page) => measure(page).catch(() => filed(page))),
    ]).then(() => {
      if (!stopped && shown.current === doc) setRead((n) => n + 1)
    })
    return () => {
      stopped = true
    }
  }, [now, doc, wordsOf, measure])
  /* While a new build is being opened the pages on screen are still the old
     one's, and the marks handed in may already be the new one's: what was
     drawn stays as it was until the swap. */
  const settled = useRef(now)
  if (loaded === url) settled.current = now
  const { drawn, first } = settled.current
  /* Under a focus, a sheet a mark is drawn on is drawn too. The caller names
     the pages SyncTeX put the passage on; where its words turned out to be is
     only known here, and now and then that is a page earlier — a passage whose
     first words are the foot of the page before. */
  const pages = useMemo(() => {
    const more = asked === null ? [] : [...drawn.keys()].filter((page) => !asked.includes(page))
    if (asked === null || !more.length) return asked
    return [...asked, ...more].sort((a, b) => a - b)
  }, [asked, drawn])

  /* Once per nonce, and not before there is a scale: a pane that is hidden
     behind the other tab has no width, and a reveal asked for then is owed
     until the pane is shown — or the mark is drawn on a page nobody was
     taken to. */
  const revealed = useRef<number | null>(null)
  useEffect(() => {
    if (!reveal || revealed.current === reveal.nonce) return
    const node = scroller.current
    /* Nor while a new build is being opened: what is drawn is then the last
       build's marks, and the one to go to is not among them yet. */
    if (!first || !node || scale <= 0 || loaded !== url) return
    let top = PAD
    if (pages === null) {
      for (let n = 1; n < first.page; n += 1) top += (sizes[n - 1]?.h ?? 0) * scale + GAP
    } else {
      /* Under a focus the sheets above are not all there, and labels sit
         between the ones that are: where a sheet is has to be MEASURED. A
         sheet that is not drawn is nowhere to scroll to. */
      const sheet = node.querySelector<HTMLElement>(`[data-page="${first.page}"]`)
      if (!sheet) return
      top = sheet.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
    }
    revealed.current = reveal.nonce
    const y = top + first.y * scale
    /* Only when it is not already comfortably in view: a caret moving down a
       paragraph should not drag the page with every line. */
    if (y < node.scrollTop + 24 || y > node.scrollTop + node.clientHeight - 48) {
      node.scrollTo({ top: Math.max(0, y - node.clientHeight / 3), behavior: 'smooth' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce, scale > 0, first === undefined, loaded === url])

  /* A pane behind the other tab has no width, so no scale, so its sheets have
     no height — and a scroller whose content has collapsed is at the top when
     it is shown again. Where it was is kept in PDF points, and put back the
     moment there is a scale to put it back at. */
  const kept = useRef(from)
  const collapsed = useRef(true)
  useLayoutEffect(() => {
    const node = scroller.current
    if (scale <= 0) {
      collapsed.current = true
      return
    }
    if (!collapsed.current) return
    collapsed.current = false
    if (node && kept.current > 0) node.scrollTop = kept.current * scale
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale > 0])

  /* Zoomed, or the pane made wider: the same place stays at the top. Without
     this the scroll stayed where it was in PIXELS, and a mark the page had
     been turned to was two dozen pages away after one press of the zoom. In
     a plain stack the place is a page and a point down it; under a focus,
     where labels sit between the sheets, the point down the whole column. */
  const lastScale = useRef(0)
  useLayoutEffect(() => {
    const was = lastScale.current
    lastScale.current = scale
    const node = scroller.current
    if (!node || was <= 0 || scale <= 0 || was === scale || moved.current) return
    if (pages !== null) {
      node.scrollTop = node.scrollTop * (scale / was)
      return
    }
    let top = PAD
    let next = PAD
    for (let n = 1; n <= sizes.length; n += 1) {
      const old = sizes[n - 1]!.h * was + GAP
      if (node.scrollTop < top + old || n === sizes.length) {
        node.scrollTop = next + Math.max(0, node.scrollTop - top) * (scale / was)
        return
      }
      top += old
      next += sizes[n - 1]!.h * scale + GAP
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale])

  /* A PDF of another kind was swapped in: put it where that one was left. */
  useLayoutEffect(() => {
    if (!moved.current || scale <= 0) return
    moved.current = false
    const node = scroller.current
    if (node) node.scrollTop = kept.current * scale
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, scale > 0])

  const onScroll = useCallback(() => {
    const node = scroller.current
    /* Not between a swap and its scroll being put back: a shorter document
       clamps the scroll, and that is nobody scrolling. */
    if (node && scale > 0 && node.clientHeight > 0 && !moved.current) {
      kept.current = node.scrollTop / scale
      onScrolled?.(kept.current, shownKind.current)
    }
    /* Under a focus the sheets are not a plain stack, and nothing asks. */
    if (!node || !onPage || scale <= 0 || pages !== null) return
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
  }, [onPage, onScrolled, scale, sizes, pages])

  /* Where the button last went down in this pane: what tells a press from a drag (`gesture.ts`). */
  const down = useRef<{ x: number; y: number } | null>(null)
  const selectedHere = useCallback((): Range | null => {
    const node = scroller.current
    const selection = typeof window === 'undefined' ? null : window.getSelection()
    if (!node || !selection || selection.isCollapsed || !selection.rangeCount) return null
    const range = selection.getRangeAt(0)
    return node.contains(range.commonAncestorContainer) ? range : null
  }, [])

  const press = useCallback(
    async (page: number, event: React.MouseEvent<HTMLDivElement>) => {
      if (scale <= 0) return
      if (isDrag(down.current, { x: event.clientX, y: event.clientY }, selectedHere() !== null)) return
      const box = event.currentTarget.getBoundingClientRect()
      const x = (event.clientX - box.left) / scale
      const y = (event.clientY - box.top) / scale
      let word: string | null = null
      try {
        word = wordAt(await measure(page), x, y)
      } catch {
        word = null
      }
      onPoint({ page, x, y, word })
    },
    [onPoint, scale, measure, selectedHere],
  )

  /* A drag ends: the text layers stop stretching to catch it, and words it
     selected are a pick. Listened for on the document, since a drag may end
     anywhere — over the desk, over the zoom control, outside the pane. */
  const pickNow = useRef<(event: MouseEvent) => void>(() => {})
  pickNow.current = (event: MouseEvent) => {
    scroller.current?.classList.remove('pdf-selecting')
    const started = down.current !== null
    if (!started || event.button !== 0) return
    /* The second press of a double press selects the word under it, natively: that is `onOpen`'s, not a pick. */
    if (event.detail === 2) return
    /* After the click this mouseup is followed by, which has then seen the selection and not pressed. */
    setTimeout(() => {
      down.current = null
      const range = selectedHere()
      const node = scroller.current
      if (!range || !node || !onPick || scale <= 0) return
      const text = range.toString().replace(/\s+/g, ' ').trim()
      if (!text) return
      const sheets: Sheet[] = [...node.querySelectorAll<HTMLElement>('[data-page]')].map((sheet) => ({ page: Number(sheet.dataset.page), box: sheet.getBoundingClientRect() }))
      const ends = endsOf([...range.getClientRects()], sheets, scale)
      if (!ends) return
      const wordOf = async (at: { page: number; x: number; y: number }) => {
        try {
          return wordAt(await measure(at.page), at.x, at.y)
        } catch {
          return null
        }
      }
      void Promise.all([wordOf(ends.from), wordOf(ends.to)]).then(([first, last]) => {
        onPick({ from: { ...ends.from, word: first }, to: { ...ends.to, word: last }, text })
      })
    }, 0)
  }
  useEffect(() => {
    const up = (event: MouseEvent) => pickNow.current(event)
    document.addEventListener('mouseup', up)
    return () => document.removeEventListener('mouseup', up)
  }, [])
  const onDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    down.current = { x: event.clientX, y: event.clientY }
    /* Pressed on the words: every text layer stretches under the pointer, so a drag that leaves the
       printed lines — across a gap between columns, past the foot of a page — keeps selecting, as in
       pdf.js's own viewer, instead of jumping to wherever the next text node happens to be. */
    if ((event.target as HTMLElement | null)?.closest?.('.textLayer')) scroller.current?.classList.add('pdf-selecting')
  }, [])

  /* A link to a place in this PDF: its page, and how far down when the destination says. */
  const goToPlace = useCallback(
    async (dest: string | readonly unknown[]) => {
      if (!doc) return
      const place = await placeOf(doc, dest)
      const node = scroller.current
      if (!place || !node || scale <= 0 || shown.current !== doc) return
      const sheet = node.querySelector<HTMLElement>(`[data-page="${place.page}"]`)
      /* Under a focus a sheet that is not drawn is nowhere to scroll to. */
      if (!sheet) return
      const top = sheet.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
      node.scrollTo({ top: Math.max(0, top + (place.y ?? 0) * scale - 8), behavior: 'smooth' })
    },
    [doc, scale],
  )
  const openLink = useCallback(
    (link: PageLink) => {
      if (link.to.kind === 'dest') {
        void goToPlace(link.to.dest)
        return
      }
      void follow(link.to.url, onAddress, (url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      })
    },
    [goToPlace, onAddress],
  )

  /* What a sheet is called: its own number, or — in a PDF that is not the
     whole paper — the page of the paper it is. */
  const paperOf = useCallback((sheet: number): number | null => (numbers ? (numbers[sheet - 1] ?? null) : sheet), [numbers])
  const count = numbers ? total : sizes.length || null

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
      <div ref={scroller} className="pdf-scroller min-h-0 flex-1 overflow-auto" onScroll={onScroll} onMouseDownCapture={onDown} style={{ padding: PAD }}>
        {trouble && <p className="text-muted-foreground p-2 text-xs">{trouble}</p>}
        {/* Under a focus the first thing in the pane is words — a sheet's
            number — and the zoom control sits over that corner. Room for
            it, so neither covers the other. */}
        {doc && pages !== null && <div className="h-6" aria-hidden />}
        {doc
          && scale > 0
          && sizes.map((size, i) => {
            const number = i + 1
            if (pages !== null && !pages.includes(number)) return null
            const sheet = (
              <PageCanvas
                key={i}
                doc={doc}
                version={version}
                number={number}
                width={size.w}
                height={size.h}
                scale={scale}
                root={scroller}
                marks={drawn.get(number) ?? []}
                words={!runs.current.has(number) ? '' : (runs.current.get(number) ?? []).some((run) => run.xs !== undefined) ? 'measured' : 'estimated'}
                onPress={press}
                onOpen={onOpen}
                onLink={openLink}
              />
            )
            if (pages === null) return sheet
            const called = paperOf(number)
            return (
              <div key={i} className="pdf-sheet">
                <p className="pdf-number" style={{ width: size.w * scale }}>
                  {called !== null && (count === null ? `p. ${called}` : `p. ${called} of ${count}`)}
                </p>
                {sheet}
              </div>
            )
          })}
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
  words,
  onPress,
  onOpen,
  onLink,
}: {
  doc: PdfDocument
  version: number
  number: number
  width: number
  height: number
  scale: number
  root: React.RefObject<HTMLDivElement | null>
  marks: { rect: PageRect; foreign: boolean; coarse: boolean }[]
  words: string
  onPress(page: number, event: React.MouseEvent<HTMLDivElement>): void
  onOpen?: () => void
  onLink(link: PageLink): void
}) {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [links, setLinks] = useState<PageLink[]>([])

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
    let layer: TextLayerLike | null = null
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
          /* The words, as text that selects, laid where they are printed — into a
             new layer, swapped in once laid out, like the canvas. */
          const [lib, content] = await Promise.all([pdfjs(), page.getTextContent()])
          const slot = text.current
          if (stopped || !slot) return
          const fresh = document.createElement('div')
          fresh.className = 'textLayer'
          layer = new lib.TextLayer({ textContentSource: content, container: fresh, viewport: page.getViewport({ scale }) })
          await layer.render()
          if (stopped) return
          /* What a drag lands on between the lines: see `onDown`. */
          const end = document.createElement('div')
          end.className = 'endOfContent'
          fresh.append(end)
          slot.replaceChildren(fresh)
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
      layer?.cancel()
    }
  }, [doc, version, number, scale, near])

  /* The page's links, read once per document: they are in points, not pixels. */
  useEffect(() => {
    if (!near) return
    let stopped = false
    void (async () => {
      try {
        const page = await doc.getPage(number)
        const found = linksOf(await page.getAnnotations({ intent: 'display' }), height)
        if (!stopped) setLinks(found)
      } catch {
        if (!stopped) setLinks([])
      }
    })()
    return () => {
      stopped = true
    }
  }, [doc, version, number, height, near])

  return (
    <div
      ref={holder}
      className="pdf-page relative mx-auto bg-white"
      data-page={number}
      data-words={words}
      style={{ width: width * scale, height: height * scale, marginBottom: GAP, ['--total-scale-factor' as string]: scale, ['--scale-round-x' as string]: '1px', ['--scale-round-y' as string]: '1px' }}
      onClick={(event) => onPress(number, event)}
      onDoubleClick={onOpen}
    >
      <canvas ref={canvas} className="block size-full" />
      <div ref={text} className="pdf-text" />
      {marks.map(({ rect, foreign, coarse }, i) => (
        <span
          key={i}
          className={`pdf-mark${foreign ? ' pdf-mark-foreign' : ''}${coarse ? ' pdf-mark-coarse' : ''}`}
          style={{ left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale }}
        />
      ))}
      {links.map((link, i) => (
        <a
          key={`link-${i}`}
          className="pdf-link"
          data-link={link.to.kind}
          /* A real address on a real anchor, so hovering says where it goes. The press is this page's (`onLink`). */
          {...(link.to.kind === 'web' ? { href: link.to.url, target: '_blank', rel: 'noopener noreferrer', title: link.to.url } : { href: '#', 'aria-label': 'Go to this place in the paper' })}
          style={{ left: link.rect.x * scale, top: link.rect.y * scale, width: link.rect.w * scale, height: link.rect.h * scale }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onLink(link)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ))}
    </div>
  )
}
