import { Check, Copy, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import type { Passage } from '@/use-selection.ts'

/**
 * "Ask about this passage", rebuilt as a READ.
 *
 * ## What it was, and what was actually load-bearing about it
 *
 * In the workbench this came from, highlighting a passage opened a panel that
 * queued work for an agent or filed a margin notice — both writes, both against
 * a SQLite queue this module does not have and is not getting. So the panel as
 * it stood cannot come back.
 *
 * What CAN come back is the half that was doing the interesting work. The
 * panel's real trick was never the textarea; it was that a highlight in the
 * browser could be turned into an exact, citable place in a `.tex` file on
 * disk. That is `lib/selection.ts`, it needs no write path, and it is the one
 * thing a reader of this pane genuinely cannot do for themselves: nobody can
 * look at rendered prose and tell you it is bytes 4120–4380 of
 * `chapters/2_bridge.tex`.
 *
 * So: highlight a passage, and this says what you highlighted and where it
 * lives, with one button that copies the citation to the clipboard. From there
 * a person or an agent has everything needed to open the file and read it —
 * `read_source` on this module's own MCP door takes exactly that file name.
 * Nothing is posted anywhere, and there is nothing here that could be.
 *
 * The `≈` is not decoration either. It is the panel admitting that the
 * selection crossed a macro expansion and was widened outward to a boundary it
 * can justify — see the essay in `lib/selection.ts`. A range that quietly
 * pretended to be exact would be the same lie the parser refuses to tell about
 * an irregular table.
 */

const WIDTH = 320
const MARGIN = 12
const GUESS_HEIGHT = 190

/**
 * Below the selection, then clamped into the viewport.
 *
 * The clamp matters more than it looks: the anchor is in viewport coordinates,
 * so a passage highlighted near the bottom of a short pane would otherwise open
 * a panel below the pane, where nobody can reach it.
 */
function place(x: number, y: number, height: number): { left: number; top: number } {
  const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2)
  const left = Math.min(Math.max(MARGIN, x - width / 2), Math.max(MARGIN, window.innerWidth - width - MARGIN))
  const preferred = y + 10 + height <= window.innerHeight - MARGIN ? y + 10 : y - height - 10
  const top = Math.min(Math.max(MARGIN, preferred), Math.max(MARGIN, window.innerHeight - height - MARGIN))
  return { left, top }
}

export function AskPopover({ passage, epic, onDismiss }: { passage: Passage; epic: string; onDismiss: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(() => place(passage.x, passage.y, GUESS_HEIGHT))
  const [copied, setCopied] = useState(false)

  /* Re-place once the real height is known. The guess is only a first pass, and
     a panel that opened half off the bottom of a 340px pane is a panel nobody
     can dismiss. */
  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? GUESS_HEIGHT
    setPos(place(passage.x, passage.y, height))
  }, [passage.x, passage.y])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) onDismiss()
    }
    window.addEventListener('keydown', onKey)
    /* Deferred, so the `mouseup` that made the selection does not immediately
       close the panel it just opened. */
    const timer = setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
      clearTimeout(timer)
    }
  }, [onDismiss])

  const where = `${epic}${passage.file ? `/${passage.file}` : ''} bytes ${passage.srcStart}–${passage.srcEnd}${
    passage.exact ? '' : ' (approximate)'
  }`
  const citation = `${where}\n\n> ${passage.rendered.replace(/\s+/g, ' ').trim()}`

  const copy = () => {
    void navigator.clipboard
      ?.writeText(citation)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => {
        /* A clipboard a browser refuses is not something a reader of a paper
           needs a red box about; the citation is on screen and selectable. */
      })
  }

  return (
    <div
      ref={box}
      role="dialog"
      aria-label="About the selected passage"
      className="fixed z-50 max-h-[80vh] overflow-y-auto rounded-lg border bg-card p-3 text-card-foreground shadow-xl"
      style={{ left: pos.left, top: pos.top, width: Math.min(WIDTH, window.innerWidth - MARGIN * 2) }}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[0.6rem] tracking-[0.1em] text-muted-foreground uppercase">this passage</span>
        <span className="ml-auto font-mono text-[0.6rem] text-muted-foreground">
          {passage.srcStart}–{passage.srcEnd}
          {!passage.exact && (
            <span
              className="ml-1 text-[var(--mark)]"
              title="The selection crossed a macro expansion, so it was widened outward to a boundary this program can justify."
            >
              ≈
            </span>
          )}
        </span>
      </div>

      <blockquote className="mt-2 border-l-2 pl-2.5 text-[0.78rem] leading-snug italic">
        {passage.rendered.length > 220 ? `${passage.rendered.slice(0, 220)}…` : passage.rendered}
      </blockquote>

      <p className="mt-2 font-mono text-[0.65rem] break-all text-muted-foreground">{where}</p>

      <div className="mt-3 flex items-center gap-2">
        <Button size="pane" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy citation'}
        </Button>
        <Button variant="ghost" size="pane" onClick={onDismiss}>
          <X className="size-3.5" />
          Close
        </Button>
      </div>

      {/* Said once, here, because it is the thing somebody will look for. */}
      <p className="mt-2 text-[0.65rem] leading-snug text-muted-foreground">
        This module only reads. Take the citation to an agent, or open the file — nothing is written from here.
      </p>
    </div>
  )
}
