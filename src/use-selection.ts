import { useCallback, useEffect, useMemo, useState } from 'react'

import { clearSelection, fileOfSelection, readSelection, selectionRect, type SourceSelection } from '@/lib/selection.ts'

/**
 * What is highlighted in the paper, as an exact place in a file on disk.
 *
 * ## Why this is a hook of its own and not four lines in `app.tsx`
 *
 * It is the module's ONE outward-facing fact about the reader. A paper is a
 * document; the interesting thing a reader does to a document is point at part
 * of it, and nobody but this module can turn "these words on screen" into
 * `chapters/2_bridge.tex` bytes 4120–4380. Everything else here — the pages,
 * the sections, the figures — is this module talking to itself.
 *
 * So the selection is kept in one place with one shape, and a later change that
 * PUBLISHES it is an addition at the bottom of this file rather than a rewrite
 * of the page. That is the whole reason for the file: see the open question.
 *
 * ## The open question, which is deliberately not answered here
 *
 * The user wants a Notes module to be able to attach a note to the passage a
 * reader has highlighted in Paper. The obvious-looking route is the canvas
 * `selection` on `roadmap.context`, and it is wrong: that field carries TRACKER
 * REFS — `gh#105`, `!1801` — and every module that reads it looks the string up
 * in a tracker. A byte range posted into it would be handed to Journeys and to
 * References as though it were an issue, and each would fail to find it,
 * silently, in a way whose cause is three modules away from the symptom.
 *
 * What a passage needs is a shape of its own — epic, file, byte range, the
 * rendered text, and the `exact` flag, because a consumer that ignored `exact`
 * would attach a note to a range this program has already said it widened. That
 * shape has two ends and only one of them exists: the Notes module has not been
 * written, and a protocol extension designed against an imaginary consumer is a
 * protocol extension that gets designed twice.
 *
 * So for this pass the selection is observable inside the module and published
 * nowhere. When Notes exists, the addition is:
 *
 *   - a `passage` extension in `manifest.ts` under `extensions.emits`,
 *   - one `host.emit(...)` where `setPassage` is called below,
 *
 * and nothing else in this file or in `lib/selection.ts` changes. If you are
 * about to widen `selection` instead, read the paragraph above first.
 */

export interface Passage extends SourceSelection {
  /** Which `.tex` file the passage was found in, when it could be told. */
  file: string | null
  /** Viewport coordinates of the end of the selection, for the panel. */
  x: number
  y: number
}

export interface Selected {
  passage: Passage | null
  /** Call after a drag over `root` has finished. */
  read: (root: HTMLElement | null, filesByAnchor: ReadonlyMap<string, string>) => void
  /** Forget it, and drop the browser's highlight with it. */
  dismiss: () => void
  /** Forget it without touching the browser's highlight — a new paper arrived. */
  forget: () => void
}

export function useSelection(): Selected {
  const [passage, setPassage] = useState<Passage | null>(null)

  const read = useCallback((root: HTMLElement | null, filesByAnchor: ReadonlyMap<string, string>) => {
    if (!root) return
    const found = readSelection(root)
    if (!found) {
      setPassage(null)
      return
    }
    const rect = selectionRect()
    if (!rect) return
    /* One place a passage is made, so one place a future `host.emit` goes. */
    setPassage({
      ...found,
      file: fileOfSelection(root, filesByAnchor),
      x: rect.left + rect.width / 2,
      y: rect.bottom,
    })
  }, [])

  const dismiss = useCallback(() => {
    setPassage(null)
    clearSelection()
  }, [])

  const forget = useCallback(() => setPassage(null), [])

  /*
   * A selection the reader cleared elsewhere clears the panel too.
   *
   * Without this, clicking once in the text collapses the browser's highlight
   * and leaves a panel on screen quoting a passage that is no longer selected —
   * a panel making a claim about the document that the document disagrees with.
   */
  useEffect(() => {
    if (!passage) return
    const onChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) setPassage(null)
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [passage])

  return useMemo(() => ({ passage, read, dismiss, forget }), [passage, read, dismiss, forget])
}
