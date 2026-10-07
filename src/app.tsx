import { useEffect } from 'react'

import { SourceEditor, type Editor } from './editor/source-editor.tsx'
import { PdfView, type Preview } from './pdf/pdf-view.tsx'
import { Start } from './start.tsx'
import { usePaper, type Sight, type StartFrom } from './use-paper.ts'
import { Workspace } from './workspace.tsx'

/**
 * The page: the paper for the epic the canvas is on, as source and as PDF.
 *
 * It shows that one paper and nothing else — no list of the others, no rail —
 * because the container's header already carries this module's name and the
 * canvas already says which epic it is on. Every state that is not "a paper is
 * open" has a screen of its own, and none of them is an error: no host, no
 * project, no epic and no paper yet are all ordinary places to be.
 *
 * `editor` and `preview` are parameters so that a test can stand a textarea
 * and a stub in for CodeMirror and pdf.js; the page itself passes the real
 * ones. See the note at the top of `workspace.tsx`.
 */

const FRAMED = typeof window !== 'undefined' && window.parent !== window

export function App({ editor = SourceEditor, preview = PdfView }: { editor?: Editor; preview?: Preview }) {
  const wire = usePaper(FRAMED)
  const { sight, said, resize } = wire

  /* Tell a host how tall this page is. It is a full-height workspace, so this
     is the frame's own height coming back — and a host that sizes containers
     by content gets a number rather than nothing. */
  useEffect(() => {
    const tell = () => resize(document.documentElement.scrollHeight)
    tell()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(tell)
    ro.observe(document.documentElement)
    return () => ro.disconnect()
  }, [resize, sight])

  return (
    <div className="flex h-dvh min-h-0 flex-col px-2 pt-2 pb-1">
      {!FRAMED && <h1 className="mb-1 shrink-0 text-base font-semibold tracking-tight">Paper</h1>}
      {sight.at === 'reading' ? (
        <Workspace paper={sight.paper} wire={wire} editor={editor} preview={preview} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <Screen sight={sight} onStart={wire.start} />
        </div>
      )}
      {said && (
        <p className="text-muted-foreground mt-1 shrink-0 text-[0.72rem]" aria-live="polite">
          {said}
        </p>
      )}
    </div>
  )
}

/** Every state that is not a paper: a heading, a sentence or two, and — for an epic with no paper — the ways to start one. */
export function Screen({ sight, onStart }: { sight: Sight; onStart?(epic: string, from?: StartFrom): Promise<string | null> }) {
  const [heading, ...lines] = wordsFor(sight)
  const start = sight.at === 'no-paper' && sight.where && onStart ? sight : null
  return (
    <div className="bg-card rounded-md border p-3 text-[0.85rem] leading-relaxed">
      <h2 className="text-card-foreground mb-1 text-[0.95rem] font-semibold">{heading}</h2>
      {lines.filter(Boolean).map((line, i) => (
        <p key={i} className="text-muted-foreground mb-1.5 last:mb-0">
          {line}
        </p>
      ))}
      {start && onStart && <Start epic={start.epic} where={start.where!} onStart={onStart} />}
    </div>
  )
}

export function wordsFor(sight: Sight): string[] {
  switch (sight.at) {
    case 'listening':
      return [
        'Waiting to be greeted',
        'This page is inside a frame, so something is expected to say which epic is open. Nothing has yet.',
      ]
    case 'alone':
      return [
        'Nothing is framing this page',
        'No host is here to say which project is open or which epic. Put ?project=/path/to/project&epic=… in the '
          + 'address and that epic’s paper is opened straight off this machine.',
      ]
    case 'no-epic':
      return [
        'No epic is open',
        'The canvas is not on an epic, so there is no particular paper to show. Open one and its paper appears here.',
      ]
    case 'no-paper':
      return ['This epic has no paper yet', sight.where ? '' : sight.why]
    case 'no-project':
      return [
        'No project is open',
        sight.why
          || 'A paper lives in the project it is about, so there is nowhere to look until one is open. Open a project '
            + 'on the canvas and the paper for whichever epic is open appears here.',
        'This is where a paper is looked for, and it is the only place: '
          + '<project>/.kehikot/paper/<epic>/main.tex. There is no second layout and nothing to configure.',
      ]
    case 'asking':
      return ['Opening…', `Opening the paper for “${sight.epic}”.`]
    default:
      return ['That paper could not be read', sight.at === 'broke' ? sight.why : '']
  }
}
