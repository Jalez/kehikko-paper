import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { Paper } from '../store.ts'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { clearSelection, fileOfSelection, readSelection, selectionRect } from '@/lib/selection.ts'
import { cn } from '@/lib/utils.ts'
import { AskPopover, type Passage } from './reader/ask.tsx'
import { anchorId } from './reader/blocks.tsx'
import { paginate, pageOf, visible } from './reader/pages.ts'
import { PaginatedView } from './reader/paginated.tsx'
import { plain } from './reader/segments.tsx'
import { usePaper, type Sight } from './use-paper.ts'

/**
 * The page: the screens, the picker, and the reader.
 *
 * ## Identity is printed only when nothing is framing this page
 *
 * The host draws the module's name in the pane header and hangs the manifest's
 * `summary` off it as a tooltip. A page that also printed "Paper" at the top of
 * itself would be saying the name twice and spending a fixed strip of a
 * 340px-tall pane on the repetition. Unframed there is no pane header and
 * nothing else would ever say what this app is, so it stays.
 *
 * `window.parent !== window` is answerable before first paint, so the heading
 * never appears and then vanishes — which would be worse than either choice,
 * because a reader would learn that things on this page move on their own.
 */
const FRAMED = typeof window !== 'undefined' && window.parent !== window

export function App() {
  const { sight, papers, epics, said, setSaid, look, resize, goto } = usePaper(FRAMED)
  const sheet = useRef<HTMLElement | null>(null)
  const [page, setPage] = useState(0)
  const [lit, setLit] = useState<string | null>(null)
  const [passage, setPassage] = useState<Passage | null>(null)

  const paper = sight.at === 'reading' ? sight.paper : null

  /*
   * The page number is reset when the PAPER changes, and on nothing else.
   *
   * Keyed on the epic rather than on the object, because `sight` is replaced by
   * every state transition and a reset keyed on identity would fire when the
   * same paper came back. This is the second half of the promise `use-paper.ts`
   * makes about not refetching on a repeated context: a fetch that does not
   * happen cannot move the reader, and a page number that does not reset cannot
   * either.
   */
  const epic = paper?.epic ?? null
  const wasOn = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (wasOn.current === epic) return
    wasOn.current = epic
    setPage(0)
    setLit(null)
    setPassage(null)
  }, [epic])

  /*
   * Re-measure when the pane is resized, and after every paint that could have
   * changed the height.
   *
   * `ResizeObserver` on the document element rather than a window `resize`
   * listener, because inside a frame the window is not what changes — the frame
   * is. The host clamps whatever height arrives.
   */
  useEffect(() => {
    const tell = () => resize(document.documentElement.scrollHeight)
    tell()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(tell)
    ro.observe(document.documentElement)
    return () => ro.disconnect()
  }, [resize, sight, page])

  /**
   * "Go to this reference", answered by looking.
   *
   * The papers in this roadmap name work inline — `gh#111`, `!1801` — through
   * macros the parser expands, so the reference the host asks about is
   * genuinely in the rendered text and this can answer honestly rather than
   * always saying no. The search is over the rendered text rather than the
   * source, because that is what a reader will be looking at when the page
   * turns: finding a match in markup nobody can see and then landing on a
   * paragraph with no visible reference in it would be worse than not
   * answering.
   *
   * `answer` is called exactly once on every path, including the one where
   * nothing was found and the one where no paper is loaded. `wire/host.ts` has
   * a backstop for a module that forgets; this does not intend to rely on it,
   * and there is a test for the contract.
   */
  useEffect(() => {
    goto.current = (message, answer) => {
      if (!paper) {
        answer(false, 'This pane is not showing a paper at the moment.')
        return
      }
      /* A walk aimed at another epic is refused rather than followed. Loading
         that epic's paper would answer `found` while moving the pane somewhere
         the canvas is not, and the host is about to send a context for wherever
         the reader really ends up — which would then be fetched, twice, one of
         them discarded. Saying no costs a fallback link and keeps one place
         deciding what is on screen. */
      if (message.epic && message.epic !== paper.epic) {
        answer(false, `This pane is showing the paper for ${paper.epic}, not ${message.epic}.`)
        return
      }
      /* A step number is Journeys' vocabulary. A paper has sections and no
         steps, and pretending its Nth heading is the Nth step of the epic would
         be an invented correspondence that happens to look right on short
         papers. */
      if (message.step !== undefined && !message.ref) {
        answer(false, 'A paper has sections rather than steps, so there is no step to walk to here.')
        return
      }
      const needle = (message.ref ?? '').trim().toLowerCase()
      if (!needle) {
        answer(false, 'That reference has no text to look for.')
        return
      }
      const pages = paginate(paper.blocks)
      for (const block of paper.blocks.filter(visible)) {
        const text = textOf(block)
        if (!text.toLowerCase().includes(needle)) continue
        const at = pageOf(pages, block.file, block.id)
        if (at < 0) continue
        setPage(at)
        /* The turn happens in this tick and the anchor exists in the next, so
           the scroll waits for the paint rather than looking for an element
           React has not written yet. */
        requestAnimationFrame(() => {
          document.getElementById(anchorId(block.file, block.id))?.scrollIntoView({ block: 'center' })
        })
        answer(true)
        setSaid(`${message.ref ?? 'That reference'} is named in this paper, on page ${at + 1}.`)
        return
      }
      answer(false, `This paper does not name ${message.ref ?? 'that'}.`)
    }
  }, [paper, goto, setSaid])

  /** Which file each block came from, for a citation to be able to name one. */
  const filesByAnchor = useMemo(() => {
    const map = new Map<string, string>()
    for (const block of paper?.blocks ?? []) map.set(anchorId(block.file, block.id), block.file)
    return map
  }, [paper])

  /** A finished drag over the sheet becomes a citable source range. */
  const onMouseUp = useCallback(() => {
    const root = sheet.current
    if (!root) return
    const found = readSelection(root as HTMLElement)
    if (!found) {
      setPassage(null)
      return
    }
    const rect = selectionRect()
    if (!rect) return
    setPassage({
      ...found,
      file: fileOfSelection(root as HTMLElement, filesByAnchor),
      x: rect.left + rect.width / 2,
      y: rect.bottom,
    })
  }, [filesByAnchor])

  return (
    <div className="mx-auto max-w-[80rem] px-3 pt-3 pb-10">
      {!FRAMED && (
        <>
          <div className="mb-1 flex flex-wrap items-baseline gap-2">
            <h1 className="text-base font-semibold tracking-tight">Paper</h1>
            <span className="min-w-0 text-sm text-muted-foreground">{whereOf(sight)}</span>
          </div>
          <p className="mb-3 rounded-md border border-l-[3px] border-l-[var(--pencil)] p-2 text-[0.8rem] leading-snug text-muted-foreground">
            <b className="text-foreground">The papers are somebody else&rsquo;s files.</b> This app reads a directory of
            LaTeX — one folder per epic — and renders the prose rather than the markup. It holds no copy and keeps no
            cache, so a paper edited in an editor is a paper this page shows on the next read. It writes nothing,
            anywhere, ever. Which epic is open is the host&rsquo;s to say; with no host, the list below is every paper on
            this machine.
          </p>
        </>
      )}
      {FRAMED && whereOf(sight) && (
        <p className="mb-1 truncate text-xs text-muted-foreground">{whereOf(sight)}</p>
      )}

      <Picker
        papers={papers}
        epics={epics}
        open={epic ?? (sight.at === 'asking' ? sight.epic : null)}
        onPick={look}
        framed={FRAMED}
      />

      <div onMouseUp={onMouseUp}>
        {paper ? (
          <PaginatedView paper={paper} page={page} onPage={setPage} lit={lit} onLit={setLit} sheetRef={sheet} />
        ) : (
          <Screen sight={sight} papers={papers.length} />
        )}
      </div>

      {passage && paper && <AskPopover passage={passage} epic={paper.epic} onDismiss={() => { setPassage(null); clearSelection() }} />}

      <p className="mt-4 text-[0.8rem] text-muted-foreground" aria-live="polite">
        {said}
      </p>
    </div>
  )
}

function textOf(block: Paper['blocks'][number]): string {
  if (block.kind === 'heading' || block.kind === 'paragraph') return plain(block.segments)
  if (block.kind === 'list') return block.items.map(plain).join(' ')
  if (block.kind === 'figure' || block.kind === 'table') return plain(block.caption)
  if (block.kind === 'comment') return block.text
  if (block.kind === 'verbatim' || block.kind === 'unknown') return block.raw
  if (block.kind === 'equation') return block.latex
  return ''
}

function whereOf(sight: Sight): string {
  if (sight.at === 'reading') return sight.paper.epic
  if (sight.at === 'asking' || sight.at === 'no-paper') return sight.epic
  return ''
}

/**
 * The picker, and the muted line under it that is the only thing this module
 * asks a host for.
 */
function Picker({
  papers,
  epics,
  open,
  onPick,
  framed,
}: {
  papers: { epic: string; title: string | null }[]
  epics: { epic: string; title: string }[] | null
  open: string | null
  onPick: (epic: string, because: 'picked') => void
  framed: boolean
}) {
  if (!papers.length) return null
  const have = new Set(papers.map((p) => p.epic))
  const missing = epics?.filter((e) => !have.has(e.epic)) ?? []
  const list = (
    <div className="flex flex-wrap items-center gap-1.5">
      {papers.map((brief) => (
        <Button
          key={brief.epic}
          size="pane"
          variant={brief.epic === open ? 'default' : 'outline'}
          /*
           * The one place a shadcn button is overridden, and the reason is this
           * module's own rule rather than taste: NOTHING IS TRUNCATED. A paper
           * titles itself "One thing the app can do, one place it is recorded",
           * and `whitespace-nowrap` — right for a badge, right for Next and
           * Prev — turns that into a 300-pixel button in a 220-pixel pane, so
           * the whole document scrolls sideways to reach a control. Wrapping
           * the label is the honest fix; clipping it would leave a reader
           * choosing between two papers whose names both read "One thing the".
           */
          className="h-auto max-w-full py-1 text-left leading-snug whitespace-normal [overflow-wrap:anywhere]"
          aria-pressed={brief.epic === open}
          /* The slug on the tooltip, because the label is the paper's own title
             and two papers may reasonably title themselves similarly. Nothing
             here is truncated, so the tooltip is not standing in for text that
             was cut off. */
          title={brief.epic}
          onClick={() => onPick(brief.epic, 'picked')}
        >
          {brief.title ?? brief.epic}
        </Button>
      ))}
      {/*
        The gap: epics a host knows about that have no paper here.
        Drawn last, muted, and as a sentence rather than as buttons, because
        there is nothing to press — an epic with no paper has nothing for this
        app to show, and a button that could only ever say so would be a way to
        be disappointed. `epics === null` draws nothing at all: that is the
        state where the question was never answered, and a page printing "every
        epic has a paper" on the strength of an unanswered question would be
        making the claim this whole codebase is against.
      */}
      {missing.length > 0 && (
        <Badge variant="outline" title={missing.map((e) => e.title).join('\n')}>
          no paper yet: {missing.map((e) => e.epic).join(', ')}
        </Badge>
      )}
    </div>
  )

  /*
   * Framed, the picker is folded away; alone, it is open.
   *
   * The same argument as the heading above it, and it matters more here.
   * Eleven papers with titles the length these have is four hundred pixels of
   * buttons, and in a 280px pane that is the entire pane — a reader is handed a
   * list of things to read instead of the thing the canvas already says they
   * are reading. With a host there, which paper is on screen is the HOST's
   * answer and this list is an escape hatch. With no host it is the whole
   * navigation, and folding it would hide the only way to get anywhere.
   */
  if (!framed) return <div className="mb-3">{list}</div>
  return (
    <details className="mb-3 rounded-md border bg-card px-2 py-1.5">
      <summary className="cursor-pointer text-[0.75rem] text-muted-foreground">
        {papers.length} papers on this machine
      </summary>
      <div className="mt-1.5">{list}</div>
    </details>
  )
}

/**
 * Everything this page says when it is not showing a paper.
 *
 * One shape, because the states differ in their words and not in their kind,
 * and a state that looked different would read as a different kind of event.
 * `no-epic` in particular is an ordinary state and must not be dressed as an
 * error: it is what the canvas looks like before anybody has opened anything,
 * and after they close what they had open — a state a reader passes through
 * several times an hour.
 */
function Screen({ sight, papers }: { sight: Sight; papers: number }) {
  const [heading, ...lines] = wordsFor(sight, papers)
  return (
    <div className={cn('rounded-md border bg-card p-3 text-[0.85rem] leading-relaxed')}>
      <h2 className="mb-1 text-[0.95rem] font-semibold text-card-foreground">{heading}</h2>
      {lines.filter(Boolean).map((line, i) => (
        <p key={i} className="mb-1.5 text-muted-foreground last:mb-0">
          {line}
        </p>
      ))}
    </div>
  )
}

function wordsFor(sight: Sight, papers: number): string[] {
  switch (sight.at) {
    case 'listening':
      return [
        'Waiting to be greeted',
        'This page is inside a frame, so something is expected to say which epic is open. Nothing has yet.',
      ]
    case 'alone':
      return [
        'Nothing is framing this page',
        'No host is here to say which epic is open, so nothing is chosen for you. Pick a paper above and it will be ' +
          'read straight off this machine.',
      ]
    case 'no-epic':
      return [
        'No epic is open',
        'The canvas is not on an epic, so there is no particular paper to show. Open one and its paper appears here.',
        papers
          ? `Or read any of the ${papers} papers on this machine from the list above.`
          : 'This machine holds no papers to offer in the meantime.',
      ]
    case 'no-paper':
      return [
        'This epic has no paper',
        `Nothing on this machine holds a paper for “${sight.epic}”. That is not a failure to read one — there is no ` +
          'folder for it, or the folder has no main.tex in it.',
        papers ? `${papers} other epics do have one; they are listed above.` : '',
      ]
    case 'unconfigured':
      return [
        'Nobody has said where the papers are',
        sight.why,
        'Start it again with KEHIKKO_PAPERS_DIR=…/data/papers ./run.sh and this page fills in. For a ' +
          'single document with its own main.tex — a thesis rather than a roadmap — KEHIKKO_THESIS_DIR=… ' +
          'names it instead, or as well.',
      ]
    case 'asking':
      return ['Reading…', `Opening the paper for “${sight.epic}”.`]
    default:
      return ['That paper could not be read', sight.at === 'broke' ? sight.why : '']
  }
}
