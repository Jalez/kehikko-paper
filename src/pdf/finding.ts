import { pdfTextLayerFind } from 'kehikot-module-protocol/client/find'
import { useSyncExternalStore } from 'react'

/**
 * Find in the PDF (protocol 2.69.0, the adapter 2.72.0). The search is the protocol client's own
 * (`pageFind`), reading pdf.js's text layer; `pdf-view.tsx` lays that layer only on the sheets near the
 * view, so while the host's find bar is open the shared adapter has every sheet lay it and waits for
 * them (`pdfTextLayerFind`, over `.pdf-page` and `.textLayer`, the classes `pdf-view.tsx` draws). The
 * source editor keeps its own ⌘F and is skipped (`data-kehikot-find-skip`).
 */
export const pdfFind = pdfTextLayerFind()

/** Whether a search is open, so a sheet lays its text layer whatever its distance from the view. */
export function useFinding(): boolean {
  return useSyncExternalStore(pdfFind.subscribe, pdfFind.open, () => false)
}
