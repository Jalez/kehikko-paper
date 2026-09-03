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
