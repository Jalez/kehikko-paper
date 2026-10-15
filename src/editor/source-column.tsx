import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'

import { EMBED_TOP } from './source-editor.tsx'

/**
 * The paper's files, one after another, in one scrolling column.
 *
 * ## One scroll, an editor per file
 *
 * Each file is its own editor (so each saves, holds its unsaved words, keeps
 * its marks and its problems exactly as the single editor did) and this lays
 * them end to end in one scroller, with a thin boundary — the file's name, and
 * the part's heading when a part owns it — between them. Nothing else is
 * drawn: no row, no banner.
 *
 * ## Only the ones near are mounted
 *
 * A 20-file paper does not hold 20 editors. The ones whose region is within
 * three quarters of a screen of the visible part are mounted, plus the one the
 * person is in; the rest are a blank of the height they last had, or of the
 * height their text is estimated to take, so the scroll bar is the paper's.
 * When a region above what is on screen changes height — it was an estimate,
 * and is now measured — the scroll is moved by the difference, so the words
 * being read do not move.
 *
 * An editor that is not laid out (a hidden tab, a test DOM) has no screen to
 * be near: then only the active region is mounted, which is what the page's
 * logic was written and tested against.
 */
export interface ColumnRegion {
  file: string
  /** The text, once it has been read; null until then. */
  text: string | null
  /** The part this file is the chapter of, when it has one. */
  heading: string | null
}

export const LABEL_PX = EMBED_TOP

/** How a stretch of text is estimated to wrap, in rows, at `cols` columns. Remembered per text. */
function rowsOf(text: string, cols: number): number {
  let rows = 0
  let at = 0
  for (;;) {
    const next = text.indexOf('\n', at)
    const length = (next === -1 ? text.length : next) - at
    rows += Math.max(1, Math.ceil(length / cols))
    if (next === -1) return rows
    at = next + 1
  }
}

export function SourceColumn({
  regions,
  active,
  locate,
  render,
  onLabel,
  onLook,
  onCount,
}: {
  regions: readonly ColumnRegion[]
  /** The region the person is in: always mounted. */
  active: string
  /** Bring this region to the top, once per nonce: a file was opened rather than scrolled to. */
  locate: { file: string; nonce: number } | null
  render(file: string): ReactNode
  /** The boundary was pressed. */
  onLabel(file: string): void
  /** Scrolling settled with this region at the top and nothing in the column focused. */
  onLook(file: string): void
  /** How many editors are mounted now: said when it changes. */
  onCount?(mounted: number): void
}) {
  const box = useRef<HTMLDivElement>(null)
  /** What a region measured the last time it was mounted, in pixels, label included. */
  const measured = useRef(new Map<string, number>())
  const [mounted, setMounted] = useState<readonly string[]>([])
  const mountedRef = useRef<readonly string[]>([])
  const metrics = useRef({ width: 0, rowPx: 18.7, charPx: 7.5, ratio: 1 })
  const [, redraw] = useState(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const regionsRef = useRef(regions)
  regionsRef.current = regions
  const looked = useRef(onLook)
  looked.current = onLook
  const counted = useRef(onCount)
  counted.current = onCount

  if (box.current && metrics.current.width === 0) metrics.current.width = box.current.clientWidth
  /** The rows a text is estimated to take at the column's width, before what has been measured is applied. */
  const rawOf = (text: string | null): number => {
    if (text === null) return 3
    const width = metrics.current.width || 480
    return rowsOf(text, Math.max(24, Math.floor((width - 56) / metrics.current.charPx)))
  }
  const heightOf = (region: ColumnRegion): number => {
    const known = measured.current.get(region.file)
    if (known !== undefined) return known
    return Math.round(LABEL_PX + rawOf(region.text) * metrics.current.rowPx * metrics.current.ratio + metrics.current.rowPx)
  }

  /** Which regions should be mounted for what is on screen now. */
  const decide = useCallback((): readonly string[] => {
    const el = box.current
    const list = regionsRef.current
    const keep = new Set<string>([activeRef.current])
    if (el && el.clientHeight > 0) {
      const margin = el.clientHeight * 0.75
      const hold = el.clientHeight * 1.5
      const top = el.scrollTop
      const bottom = top + el.clientHeight
      const was = new Set(mountedRef.current)
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const file = child.dataset.region
        if (!file) continue
        const near = was.has(file) ? hold : margin
        if (child.offsetTop < bottom + near && child.offsetTop + child.offsetHeight > top - near) keep.add(file)
      }
    }
    return list.filter((one) => keep.has(one.file)).map((one) => one.file)
  }, [])

  const settle = useCallback(() => {
    const next = decide()
    const was = mountedRef.current
    if (next.length === was.length && next.every((file, i) => file === was[i])) return
    mountedRef.current = next
    setMounted(next)
    counted.current?.(next.length)
  }, [decide])

  /* The set follows the regions, the active one and what is measured. */
  const key = regions.map((one) => one.file).join('\n')
  /* A text arriving changes what the blanks are sized to, and so what is near. */
  const loadedKey = regions.map((one) => (one.text === null ? '0' : '1')).join('')
  useLayoutEffect(() => {
    const el = box.current
    const kept = anchor.current
    if (el && kept && el.clientHeight > 0) {
      const at = Array.from(el.children).find((child) => (child as HTMLElement).dataset.region === kept.file) as HTMLElement | undefined
      if (at && Math.abs(el.scrollTop - (at.offsetTop + kept.delta)) > 1) el.scrollTop = at.offsetTop + kept.delta
    }
  }, [loadedKey])
  useLayoutEffect(() => {
    if (box.current && metrics.current.width === 0 && box.current.clientWidth > 0) {
      metrics.current.width = box.current.clientWidth
      redraw((n) => n + 1)
    }
    settle()
  }, [settle, key, active, loadedKey])

  /* A file that has gone from the paper has no height to remember. */
  useEffect(() => {
    const names = new Set(regions.map((one) => one.file))
    for (const file of [...measured.current.keys()]) if (!names.has(file)) measured.current.delete(file)
  }, [key])

  /* Scrolling: which regions are near, and — once it stops — which is at the top. */
  const look = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTop = useRef(0)
  /** The region at the top of the column and how far into it: kept still while what is above it changes height. */
  const anchor = useRef<{ file: string; delta: number } | null>(null)
  /** The column is where it was told to be but cannot be yet: the text under that place has not arrived, so the scroller is too short. Not the person. */
  const clamped = (el: HTMLElement): boolean => {
    const kept = anchor.current
    if (!kept) return false
    const at = Array.from(el.children).find((child) => (child as HTMLElement).dataset.region === kept.file) as HTMLElement | undefined
    return at !== undefined && at.offsetTop + kept.delta > el.scrollHeight - el.clientHeight + 1
  }
  useEffect(() => {
    const el = box.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      /* A column that is not shown (the other tab) scrolls to nothing and says nothing. */
      if (el.clientHeight > 0 && !clamped(el)) {
        lastTop.current = el.scrollTop
        let at: HTMLElement | null = null
        for (const child of Array.from(el.children) as HTMLElement[]) if (child.dataset.region && child.offsetTop <= el.scrollTop) at = child
        if (at) anchor.current = { file: at.dataset.region!, delta: el.scrollTop - at.offsetTop }
      }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        settle()
      })
      if (look.current) clearTimeout(look.current)
      look.current = setTimeout(() => {
        look.current = null
        if (el.clientHeight === 0 || clamped(el)) return
        /* A caret in an editor is where the person is, however far they have scrolled. */
        if (el.contains(document.activeElement) && document.activeElement !== el) return
        const line = el.scrollTop + LABEL_PX
        let at: string | null = null
        for (const child of Array.from(el.children) as HTMLElement[]) {
          if (child.dataset.region && child.offsetTop <= line) at = child.dataset.region
        }
        if (at !== null && at !== activeRef.current) looked.current(at)
      }, 160)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
      if (look.current) clearTimeout(look.current)
    }
  }, [settle])

  /* The column's own size: a different width wraps differently, so what was
     measured is not known any more; and a column that was hidden and is shown
     again is put back where it was (an element not displayed loses its scroll). */
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let height = el.clientHeight
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    metrics.current.rowPx = rem * 0.78 * 1.5
    metrics.current.charPx = rem * 0.78 * 0.6
    const watch = new ResizeObserver(() => {
      const now = el.clientHeight
      if (metrics.current.width !== el.clientWidth) {
        metrics.current.width = el.clientWidth
        measured.current.clear()
        redraw((n) => n + 1)
      }
      if (height === 0 && now > 0 && lastTop.current > 0) el.scrollTop = lastTop.current
      height = now
      settle()
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [settle])

  /* What each mounted region measures. A region above the top that changes
     height — an estimate becoming real — moves the scroll by as much. */
  const sizes = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const found = new ResizeObserver((entries) => {
      const el = box.current
      let changed = false
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const file = target.dataset.region
        /* Only an editor's own height is a measurement; a blank is what it was told to be. */
        if (!file || !target.isConnected || !target.hasAttribute('data-mounted')) continue
        const next = Math.round(target.getBoundingClientRect().height)
        if (next === 0) continue
        const was = measured.current.get(file) ?? null
        if (was === next) continue
        /* What a mounted editor really takes, against what the estimate said:
           the others are estimated by the same ratio from then on. */
        const own = regionsRef.current.find((one) => one.file === file)
        if (own && own.text !== null && target.hasAttribute('data-mounted')) {
          const rows = rawOf(own.text) * metrics.current.rowPx
          if (rows > 0) metrics.current.ratio = Math.min(4, Math.max(0.25, (next - LABEL_PX) / rows))
        }
        measured.current.set(file, next)
        changed = true
        const known = regionsRef.current.find((one) => one.file === file)
        const before = was ?? (known ? heightOf(known) : next)
        if (el && target.offsetTop + before <= el.scrollTop + 1 && el.clientHeight > 0) el.scrollTop += next - before
      }
      if (changed) redraw((n) => n + 1)
    })
    sizes.current = found
    for (const child of Array.from(box.current?.children ?? [])) found.observe(child)
    return () => {
      found.disconnect()
      sizes.current = null
    }
  }, [])
  const watched = useCallback((node: HTMLElement | null) => {
    if (node) sizes.current?.observe(node)
  }, [])

  /* An opened file is brought to the top of the column, before it paints; the
     editor's own jump then puts the line where it goes. */
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !locate) return
    const section = Array.from(el.children).find((child) => (child as HTMLElement).dataset.region === locate.file) as HTMLElement | undefined
    if (section) {
      el.scrollTop = section.offsetTop
      anchor.current = { file: locate.file, delta: 0 }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate?.nonce])

  const open = new Set(mounted)
  return (
    <div ref={box} data-source-column className="source-column relative h-full min-h-0 overflow-y-auto overscroll-contain">
      {regions.map((region) => {
        const here = open.has(region.file) || region.file === active
        return (
          <section key={region.file} ref={watched} data-region={region.file} data-mounted={here && region.text !== null ? '' : undefined} className="source-region">
            <button
              type="button"
              className={cn('source-boundary', region.file === active && 'source-boundary-active')}
              style={{ height: LABEL_PX }}
              title={region.heading ? `${region.heading} · ${region.file}` : region.file}
              data-boundary={region.file}
              onClick={() => onLabel(region.file)}
            >
              <span className="min-w-0 truncate font-mono">{region.file}</span>
              {region.heading && <span className="min-w-0 shrink-[3] truncate opacity-70">{region.heading}</span>}
            </button>
            {here && region.text !== null ? (
              render(region.file)
            ) : (
              <div aria-hidden style={{ height: Math.max(0, heightOf(region) - LABEL_PX) }} />
            )}
          </section>
        )
      })}
    </div>
  )
}
