import { createContext } from 'react'

/**
 * The anchor for a block, and why it is not just the block's id.
 *
 * The parser numbers blocks from 1 within one FILE, and a paper is assembled
 * from a main file plus its chapters — so `heading-3` exists once per chapter
 * and an anchor built from it would send a reader to whichever one the browser
 * found first, which is the earliest one, which is never the one they clicked.
 * Pairing the file with the id makes it unique across the assembled document,
 * and the sanitising is because a filename contains a `/` and a `.`, neither of
 * which can appear in a fragment `querySelector` will accept.
 *
 * In a file of its own rather than in `blocks.tsx`, where it was written,
 * because a resolved cross-reference in `segments.tsx` is a link to a block and
 * needs the same spelling — and `blocks.tsx` imports `segments.tsx`, so the
 * import the other way would be a cycle. `blocks.tsx` re-exports it, so the
 * page and the paginator that always imported it from there still do.
 */
export function anchorId(file: string, id: string): string {
  return `b-${`${file}-${id}`.replace(/[^a-zA-Z0-9-]+/g, '-')}`
}

/**
 * The element a floating card should treat as the edge of the world.
 *
 * A card rendered in a portal is free of the sheet's `transform`, which is what
 * lets it draw at real size over a page scaled to 0.25 — and it is also free of
 * the sheet's clipping, which was doing real work. With no boundary given,
 * Floating UI keeps a card inside the VIEWPORT, and this page is not the
 * viewport: it is a module on somebody else's canvas, routinely 220 pixels wide
 * inside a window that is not. A card shifted to fit the window would sit over
 * the container next to this one.
 *
 * So the scroll column is published here and handed to `collisionBoundary`.
 * Flipping above and below, shifting along the line, and the width a card
 * bounds itself by are then all measured against the column the reader is
 * actually looking at.
 *
 * ## Why it lives in this file
 *
 * It was written in `proposed.tsx`, for the suggestion card. That card no
 * longer floats — it is laid out in the column's own coordinates, against the
 * other cards, and it needed no boundary once it stopped being positioned
 * against the window. So the context was deleted along with it, and the same
 * day a citation card in `segments.tsx` needed exactly this and nothing else.
 *
 * Here for the same reason `anchorId` is: `blocks.tsx` imports `segments.tsx`,
 * so a context defined in either of those and read by the other would be a
 * cycle, and `paginated.tsx` — which owns the column and provides it — is
 * further up still.
 */
export const Reading = createContext<HTMLElement | null>(null)
