import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo } from 'react'

import type { Paper } from '../../store.ts'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { BlockRow, anchorId } from './blocks.tsx'
import { notesOn } from './notes.ts'
import { pageOf, paginate } from './pages.ts'
import { MarginRail } from './rail.tsx'

/**
 * The reading view: one sheet at a time, with a rail beside it.
 *
 * ## One sheet, not a scroll of sheets
 *
 * The reader this was rebuilt from stacked every sheet in one long column and
 * let the reader scroll it. This shows one, because the pane it lives in is
 * three hundred pixels wide and four hundred tall: a column of A4 sheets in
 * that is a column of slivers. Turning a page is also the thing that makes the
 * page NUMBER mean something — "page 7 of 11" beside a scrollbar is a fact
 * nobody can act on, and beside a next button it is a place.
 *
 * ## The page number is state, and it is not derived from anything that moves
 *
 * `page` lives in the app and is passed in, because the one thing this view
 * must never do is move the reader on its own. The pages themselves are a pure
 * function of the block list (`pages.ts`), so a re-render cannot re-break them;
 * the number is only ever changed by a press, a key, a walk, or a different
 * paper arriving. A context about the epic already on screen changes none of
 * those and therefore changes nothing here — which is the same promise the
 * fetch makes one layer up, kept in the one other place it could be broken.
 */

export interface PaginatedProps {
  paper: Paper
  page: number
  onPage: (page: number) => void
  lit: string | null
  onLit: (key: string | null) => void
  sheetRef: React.RefObject<HTMLElement | null>
}

export function PaginatedView({ paper, page, onPage, lit, onLit, sheetRef }: PaginatedProps) {
  const pages = useMemo(() => paginate(paper.blocks), [paper.blocks])
  const count = Math.max(1, pages.length)
  const at = Math.min(Math.max(page, 0), count - 1)
  const blocks = pages[at] ?? []
  const notes = useMemo(() => notesOn(blocks), [blocks])

  const turn = useCallback(
    (delta: number) => {
      const next = Math.min(Math.max(at + delta, 0), count - 1)
      if (next !== at) onPage(next)
    },
    [at, count, onPage],
  )

  /*
   * Arrow keys turn the page, and only when nothing else wants them.
   *
   * A listener on the window rather than on the sheet, because a reader who has
   * just pressed the next button has focus on a button and would otherwise have
   * to click back into the text to keep reading with the keyboard. Skipped
   * whenever the event came out of a field or a control that has its own
   * meaning for an arrow, so this cannot quietly steal a key from something
   * that needed it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault()
        turn(1)
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        turn(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [turn])

  return (
    <div className="flex flex-col gap-3">
      <Sections paper={paper} pages={pages} at={at} onPage={onPage} />

      <div className="flex min-w-0 items-start gap-0">
        <section
          ref={sheetRef as React.RefObject<HTMLElement>}
          /* The horizontal padding is in the `.sheet` component class rather
             than a `px-` utility, because the wide layout widens the left of it
             to make room for the gutter tags — and a utility would win over
             that, being in a later cascade layer, leaving the tags drawn off
             the edge of the page where they are present and invisible. */
          className="sheet relative min-w-0 flex-1 rounded-sm py-6"
          aria-label={`Page ${at + 1} of ${count}`}
        >
          {/* The title and the byline, on the first sheet only, the way a paper
              carries them. The epic slug is always named beside the title, even
              when the paper has one of its own, because the title is the
              paper's claim about itself and the slug is what the host and the
              reader are both actually standing on — a pane showing "Every mode
              is a module" with no way to tell which epic that is answers the
              wrong question. */}
          {at === 0 && (
            <header className="mb-5">
              {/* `h2`, not `h1`, and for the same reason the old reader used
                  one: `h1` on this page is the APP's name, which is drawn only
                  when nothing is framing it. A paper whose title outranked that
                  would give an unframed page two `h1`s, and a framed one an
                  `h1` for a document inside somebody else's pane header. */}
              <h2 className="prose-reading text-[1.45rem] leading-tight font-semibold">{paper.title ?? paper.epic}</h2>
              <p className="mt-1 text-[0.78rem] text-[var(--paper-muted)]">
                {[paper.author, paper.epic, paper.files.length > 1 ? `${paper.files.length} files` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </header>
          )}
          {blocks.map((block) => (
            <BlockRow key={`${block.file}#${block.id}`} block={block} lit={lit} onNote={onLit} />
          ))}
          {!blocks.length && (
            <p className="text-[0.85rem] text-[var(--paper-muted)]">This paper parsed to nothing a reader can see.</p>
          )}
        </section>

        <MarginRail notes={notes} sheetRef={sheetRef} lit={lit} onLit={onLit} />
      </div>

      {/*
        The controls, below the sheet rather than floating over it.
        A 340px-tall pane cannot spare a strip for chrome that overlaps the
        text, and a control a reader has to move the page to see is a control
        they will not find.
      */}
      <nav className="flex flex-wrap items-center gap-2" aria-label="Pages">
        <Button variant="outline" size="pane" onClick={() => turn(-1)} disabled={at === 0} aria-label="Previous page">
          <ChevronLeft className="size-3.5" />
          Prev
        </Button>
        <Badge variant="outline" aria-live="polite">
          {at + 1} / {count}
        </Badge>
        <Button
          variant="outline"
          size="pane"
          onClick={() => turn(1)}
          disabled={at >= count - 1}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="size-3.5" />
        </Button>
        {/* Said plainly rather than implied. These breaks are this program's
            arithmetic over the block list, not the compiler's over the real
            document; float placement and hyphenation move the PDF's. */}
        <span className="ml-auto text-[0.65rem] text-muted-foreground">page breaks are this reader's, not the PDF's</span>
      </nav>
    </div>
  )
}

/**
 * The section list, and what a section link means once there are pages.
 *
 * It is built from the same blocks the sheets are, so an entry and its heading
 * cannot disagree about where they are — the failure a separately-derived table
 * of contents always eventually has. A link turns to the page that heading is
 * on and then scrolls to it, rather than being an `href="#…"` to an anchor that
 * is not in the document while another page is open: a fragment link into a
 * page nobody has turned to is a link that silently does nothing.
 *
 * Closed by default, because a reader who wanted the argument should not have
 * to scroll past a contents page to reach the first sentence of it.
 */
function Sections({
  paper,
  pages,
  at,
  onPage,
}: {
  paper: Paper
  pages: readonly (readonly { file: string; id: string; kind: string }[])[]
  at: number
  onPage: (page: number) => void
}) {
  const headings = paper.blocks.filter((b) => b.kind === 'heading')
  if (paper.outline.length < 2) return null
  return (
    <details className="rounded-md border bg-card px-2 py-1.5">
      <summary className="cursor-pointer text-[0.75rem] text-muted-foreground">{paper.outline.length} sections</summary>
      <ol className="mt-1.5 space-y-0.5">
        {paper.outline.map((entry, i) => {
          const source = headings[i]
          if (!source) return null
          const on = pageOf(pages, source.file, source.id)
          return (
            <li key={`${source.file}#${source.id}`} style={{ paddingLeft: `${Math.max(0, entry.level - 1) * 0.6}rem` }}>
              <button
                type="button"
                className="text-left text-[0.75rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => {
                  if (on >= 0 && on !== at) onPage(on)
                  requestAnimationFrame(() => {
                    document.getElementById(anchorId(source.file, source.id))?.scrollIntoView({ block: 'start' })
                  })
                }}
              >
                {entry.text}
                {on >= 0 && <span className="ml-1.5 font-mono text-[0.6rem] opacity-60">p{on + 1}</span>}
              </button>
            </li>
          )
        })}
      </ol>
    </details>
  )
}
