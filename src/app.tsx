import { probeServer } from 'kehikot-module-protocol/client'
import { Cover, coverFor, useServerStanding } from 'kehikot-module-protocol/client/react'
import { useEffect, useState } from 'react'

import { SourceEditor, type Editor } from './editor/source-editor.tsx'
import { PdfView, type Preview } from './pdf/pdf-view.tsx'
import { Start } from './start.tsx'
import { epicFromUrl, usePaper, type Sight, type StartFrom } from './use-paper.ts'
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
 * The states every module has — waiting to be greeted, nothing framing the
 * page, no project, no epic, this app's own server gone, a page older than its
 * server — are the protocol's shared `Cover`. What is this app's own is below
 * it: an epic with no paper yet and the ways to start one, a project the
 * server could not use, and a paper that could not be read.
 *
 * `editor` and `preview` are parameters so that a test can stand a textarea
 * and a stub in for CodeMirror and pdf.js; the page itself passes the real
 * ones. See the note at the top of `workspace.tsx`.
 */

const FRAMED = typeof window !== 'undefined' && window.parent !== window

/** What only this app can add to "nothing is framing this page": the other way in. */
const BY_ADDRESS = 'Or put ?project=/path/to/project&epic=… in the address, and that epic’s paper is opened straight off this machine.'

export function App({
  editor = SourceEditor,
  preview = PdfView,
  saveDelay,
  settle,
}: {
  editor?: Editor
  preview?: Preview
  /** Passed through to the workspace; a test shortens both. */
  saveDelay?: number
  settle?: number
}) {
  const wire = usePaper(FRAMED)
  const { sight, said, resize, where, projectPath, epic, again } = wire

  /**
   * Which shared cover, if any. A page opened by its address stands in for a
   * host itself, until one greets it: it needs nothing of one, so only its own
   * server's standing can cover it.
   *
   * The last line is for the compiler and for one frame at most: the three
   * states `Sight` can start in are the ones the cover has just answered for.
   */
  const server = useServerStanding()
  /* Whether this page was opened on its own with a paper named in its address
     — `?project=…&epic=…`, the first-class way to use this module with no
     host. Read once, as the page mounts, like the address itself is. */
  const [addressed] = useState(() => !FRAMED && typeof window !== 'undefined' && epicFromUrl(window.location.search) !== null)
  const own = addressed && where !== 'hosted'
  const cover =
    coverFor({ where: own ? 'unhosted' : where, projectPath, epic, server }, own ? {} : { epic: true })
    ?? (sight.at === 'listening' || sight.at === 'alone' || sight.at === 'no-epic' ? 'loading' : null)
  const covering = cover && (
    <Cover
      state={cover}
      name="Paper"
      detail={cover === 'unhosted' && !FRAMED ? BY_ADDRESS : null}
      onRetry={() => void probeServer().then((now) => now === 'up' && again())}
    />
  )

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
    <div className="relative flex h-dvh min-h-0 flex-col px-2 pt-2 pb-1">
      {!FRAMED && <h1 className="mb-1 shrink-0 text-base font-semibold tracking-tight">Paper</h1>}
      {sight.at === 'reading' ? (
        <Workspace paper={sight.paper} wire={wire} editor={editor} preview={preview} saveDelay={saveDelay} settle={settle} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">{covering || <Screen sight={sight} onStart={wire.start} />}</div>
      )}
      {/* Over an open paper, never instead of it. The workspace stays mounted
          and laid out underneath — the editor's text, the caret, where the PDF
          was scrolled to — so a server that answers again without the page
          having reloaded finds everything where it was, and what was typed
          and not saved is still in the editor. */}
      {sight.at === 'reading' && covering && <div className="bg-background absolute inset-0 z-50 flex">{covering}</div>}
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
    case 'broke':
      return ['That paper could not be read', sight.why]
    default:
      /* Waiting, nobody framing the page, no epic: the shared cover's, never drawn here. */
      return ['']
  }
}
