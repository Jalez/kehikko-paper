import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils.ts'
import type { Note } from './notes.ts'

/**
 * The margin rail.
 *
 * Each card sits beside the text it marks and, when the pair is active, draws a
 * dashed leader line back to that exact span — the way a proofreader's margin
 * mark connects to the line it corrects. That leader line is the signature of
 * the reader this was rebuilt from, and it is the reason a rail is worth having
 * rather than a list of notes under the paper: a note whose position on the
 * page is arbitrary is a note the reader has to search the page for.
 *
 * ## Placement is two passes, and the second one measures
 *
 * First, where does each anchor sit in the rendered text. Then, after the cards
 * have actually rendered, their REAL heights, stacked so none overlaps. The
 * version this is carried over from originally guessed a fixed height per card
 * and collided the moment one was taller than the guess; measuring is the fix
 * and there is no shortcut to it.
 *
 * This is the only measurement anywhere in the reader, and it is deliberately
 * downstream of everything: pagination is a pure function of the block list
 * (see `pages.ts`), so nothing measured here can feed back into which blocks
 * are on the page. The cards are absolutely positioned, so their placement
 * cannot change the height of the text either. A measuring pass that cannot
 * change its own input is a measuring pass that cannot oscillate.
 *
 * ## It is not rendered at all in a narrow pane
 *
 * `index.css` hides it under a `@container` query, and the notes' text stays in
 * the reading flow there instead. A viewport breakpoint would be the wrong
 * question every time: this module is sized by its pane, and the pane is
 * routinely 300 pixels wide inside a window that is two thousand.
 */

/** Vertical air between two stacked cards. */
const GAP = 10

interface Placed extends Note {
  /** Y of the marked text, in pixels from the top of the sheet. */
  anchorTop: number
}

interface Props {
  notes: readonly Note[]
  /** The element the anchors live in. Cards are measured against its top. */
  sheetRef: React.RefObject<HTMLElement | null>
  lit: string | null
  onLit: (key: string | null) => void
}

export function MarginRail({ notes, sheetRef, lit, onLit }: Props) {
  const cards = useRef(new Map<string, HTMLElement>())
  const [placed, setPlaced] = useState<Placed[]>([])
  const [tops, setTops] = useState<Record<string, number>>({})
  const [reserve, setReserve] = useState(0)

  // Pass 1 — where does each anchor sit in the rendered text?
  useLayoutEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return

    const measure = () => {
      const sheetTop = sheet.getBoundingClientRect().top
      const found: Placed[] = []
      for (const note of notes) {
        const pin = sheet.querySelector<HTMLElement>(`[data-note-key="${cssEscape(note.key)}"]`)
        /* A pin this walk cannot find is skipped rather than placed at zero. In
           the one frame after the reader turns a page, the notes are already
           the new sheet's and the DOM is still the old one; a card stacked at
           the top of the rail for that frame is a visible jump. */
        if (!pin) continue
        found.push({ ...note, anchorTop: pin.getBoundingClientRect().top - sheetTop })
      }
      found.sort((a, b) => a.anchorTop - b.anchorTop)
      setPlaced((was) => (same(was, found) ? was : found))
    }

    measure()
    /* The sheet reflows when the pane is resized, which moves every anchor. A
       `ResizeObserver` on the sheet rather than a window `resize` listener,
       because inside a frame the window is not what changes — the pane is.
       Guarded, because the DOM the tests run in does not implement it and a
       rail that threw would take the whole reader down with it. */
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(sheet)
    return () => ro.disconnect()
  }, [notes, sheetRef])

  // Pass 2 — stack the cards using their real, measured heights.
  const restack = useCallback(() => {
    if (!placed.length) {
      setTops((was) => (Object.keys(was).length ? {} : was))
      setReserve(0)
      return
    }
    const next: Record<string, number> = {}
    let cursor = -Infinity
    let bottom = 0
    for (const note of placed) {
      const height = cards.current.get(note.key)?.offsetHeight ?? 64
      const top = Math.max(note.anchorTop, cursor)
      next[note.key] = top
      cursor = top + height + GAP
      bottom = top + height
    }
    setTops((was) => (sameNumbers(was, next) ? was : next))
    setReserve(bottom + 24)
  }, [placed])

  useLayoutEffect(restack, [restack])

  /* A card's height changes when its text wraps differently, which happens
     whenever the rail itself is resized. Observing each card is what keeps the
     stack settled rather than letting neighbours overlap after a drag. */
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => restack())
    for (const el of cards.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [restack, placed])

  if (!notes.length) {
    return (
      <aside className="margin-rail w-[16rem] shrink-0 pl-6" aria-label="Margin notes">
        <p className="font-mono text-[0.65rem] tracking-wide text-[var(--paper-muted)] uppercase">
          No marks on this page
        </p>
      </aside>
    )
  }

  return (
    <aside className="margin-rail relative w-[16rem] shrink-0 pl-6" aria-label="Margin notes">
      {placed.map((note) => {
        const top = tops[note.key] ?? note.anchorTop
        const isLit = lit === note.key
        const pushed = Math.abs(top - note.anchorTop) > 4
        return (
          <div key={note.key}>
            {/* The leader line, from the sheet's edge across the gutter. */}
            <div
              className="leader-line"
              data-lit={isLit ? 'true' : undefined}
              style={{ top: note.anchorTop + 8, left: 0, width: 18 }}
            />
            {/* The vertical run, drawn only when the card had to be pushed away
                from the line it belongs to — without it a lit pair looks like
                it points at whatever text the card happens to sit beside. */}
            {isLit && pushed && (
              <div
                className="absolute w-px bg-[var(--mark)] opacity-60"
                style={{ top: Math.min(note.anchorTop, top) + 8, height: Math.abs(top - note.anchorTop), left: 18 }}
              />
            )}
            <div
              ref={(el) => {
                if (el) cards.current.set(note.key, el)
                else cards.current.delete(note.key)
              }}
              className={cn('note-card absolute right-0 left-6 rounded-r px-3 py-2 transition-[top] duration-200')}
              data-kind={note.kind}
              data-lit={isLit ? 'true' : undefined}
              style={{ top }}
              onMouseEnter={() => onLit(note.key)}
              onMouseLeave={() => onLit(null)}
            >
              <span
                className={cn(
                  'font-mono text-[0.6rem] tracking-[0.1em] uppercase',
                  note.kind === 'todo' ? 'text-[var(--mark)]' : 'text-[var(--paper-muted)]',
                )}
              >
                {note.kind === 'todo' ? 'todo' : 'source comment'}
              </span>
              <p className="mt-1 text-[0.78rem] leading-snug text-[var(--paper-foreground)]">{note.text}</p>
            </div>
          </div>
        )
      })}
      {/* Reserve the height the absolutely-positioned cards do not contribute,
          so a page with more margin than text still scrolls to the last card. */}
      <div style={{ height: reserve }} />
    </aside>
  )
}

/**
 * A note key, safe inside an attribute selector.
 *
 * The key is `file#block#offset` and a filename legitimately contains `/` and
 * `.`. `CSS.escape` is the right answer and is not defined in every DOM this
 * code is tested in, so the quoting is done by hand when it is missing — an
 * attribute VALUE in quotes needs only its quotes and backslashes escaped.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

function same(a: readonly Placed[], b: readonly Placed[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => x.key === b[i]?.key && Math.abs(x.anchorTop - (b[i]?.anchorTop ?? 0)) < 0.5)
}

function sameNumbers(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => b[k] !== undefined && Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 0.5)
}
