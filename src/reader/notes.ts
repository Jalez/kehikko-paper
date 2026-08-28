import type { Segment } from '../../latex/parse.ts'
import type { PlacedBlock } from '../../store.ts'

/**
 * What goes in the margin, and how it is got out of the reading flow.
 *
 * ## Two kinds, and they are genuinely different things
 *
 * - `todo` is a `todonotes` macro the author wrote — `\todo{this needs a
 *   citation}`. In the compiled PDF it IS a margin note; putting it back in the
 *   margin is restoring the author's own layout rather than inventing one.
 * - `comment` is a run of `%` lines in the source. In the papers here those
 *   carry the reasoning behind the section under them, and a reading view that
 *   dropped them would be hiding the best writing in the file. It is not the
 *   argument, so it does not sit in the argument.
 *
 * ## Why the parser was not changed
 *
 * `latex/parse.ts` renders a todonote as a pin glyph followed by the note's
 * text, both carrying the `todo` style, and its comment on the matter says
 * plainly that it does so BECAUSE there is no rail — a pin pointing at nothing
 * is a silent loss, and silent losses are the failure this codebase spends the
 * most words on. That reasoning is still right for the narrow pane, where there
 * is no room for a rail and the text has nowhere else to go.
 *
 * So the parser keeps its behaviour, its tests keep passing, and the SPLIT
 * happens here, on the client, which is the only place that knows how wide the
 * pane is. The pin stays inline in both layouts and is the anchor; the text
 * either follows it in the flow or appears in a card beside it, and which of
 * those is a `@container` query in `index.css` rather than a branch in this
 * file. Both are rendered; CSS shows exactly one, so nothing is duplicated for
 * a screen reader either — `display: none` takes an element out of the
 * accessibility tree as well as out of the picture.
 */

export interface Note {
  /**
   * Stable across renders: the file, the block, and the note's own byte offset.
   *
   * The offset rather than an ordinal, and that is not a detail. The rail finds
   * a card's anchor in the text by this key, and the inline pin and the card
   * are built by two different walks over the same block — one per list item,
   * say, and one over the items flattened. An ordinal counted during the walk
   * would number the same note differently in the two, and the symptom would be
   * a leader line pointing at the wrong sentence. A byte offset is a fact about
   * the source and is the same number whoever is counting.
   */
  key: string
  kind: 'todo' | 'comment'
  /** What the note says, with the pin glyph taken off the front. */
  text: string
  /** The block this note is anchored in, for the rail's measuring pass. */
  file: string
  blockId: string
}

/** A stretch of one block's segments: either ordinary prose, or one note. */
export interface Run {
  segments: Segment[]
  /** Present when this run is a todonote rather than prose. */
  note: Note | null
}

/** The pin `parse.ts` puts in front of a todonote's text. */
const PIN = '◆'

const isTodo = (segment: Segment): boolean => segment.styles.includes('todo')

/**
 * One block's segments, cut into prose and notes.
 *
 * Maximal consecutive runs, so `\todo{a citation for \emph{this}}` — which the
 * parser splits into three segments because the emphasis inside it is a style
 * change — comes back as ONE note rather than three. A note broken into three
 * cards in the margin would read as three separate remarks, which is a claim
 * about the author's writing that nobody made.
 */
export function runs(file: string, blockId: string, segments: readonly Segment[]): Run[] {
  const out: Run[] = []

  for (const segment of segments) {
    const todo = isTodo(segment)
    const last = out[out.length - 1]

    if (last && (last.note !== null) === todo) {
      last.segments.push(segment)
      if (last.note) last.note.text = noteText(last.segments)
      continue
    }

    if (!todo) {
      out.push({ segments: [segment], note: null })
      continue
    }

    out.push({
      segments: [segment],
      note: {
        key: `${file}#${blockId}#${segment.srcStart}`,
        kind: 'todo',
        text: noteText([segment]),
        file,
        blockId,
      },
    })
  }

  return out
}

/**
 * The note's own words.
 *
 * The pin is stripped, and the non-breaking space the parser puts after it with
 * it, because in a card the glyph would be a decoration repeated on every card
 * rather than the anchor it is inline. Anything left is the author's text,
 * whitespace-collapsed the way a title attribute or a card wants it.
 */
function noteText(segments: readonly Segment[]): string {
  return segments
    .map((s) => s.text)
    .join('')
    .replace(new RegExp(`^\\s*${PIN}\\s*`), '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Every note on one page's worth of blocks, in reading order.
 *
 * Taken per PAGE rather than per paper, because the rail sits beside the sheet
 * that is open and a card for a note four sheets away would be a card pointing
 * at text nobody can see.
 */
export function notesOn(blocks: readonly PlacedBlock[]): Note[] {
  const out: Note[] = []
  for (const b of blocks) {
    if (b.kind === 'comment') {
      if (!b.text.trim()) continue
      out.push({
        key: `${b.file}#${b.id}#comment`,
        kind: 'comment',
        text: b.text.replace(/\s+/g, ' ').trim(),
        file: b.file,
        blockId: b.id,
      })
      continue
    }
    /* Every run of segments the reader will actually see, from every block that
       has any. A todonote inside a table cell is rare and is not a reason for
       one note in the paper to have no card: the rail hides the inline copy of
       every note it draws, so a note this walk missed would be a note that
       vanished. Listing the places exhaustively is what keeps that from being
       possible. */
    const groups: readonly (readonly Segment[])[] =
      b.kind === 'heading' || b.kind === 'paragraph'
        ? [b.segments]
        : b.kind === 'list'
          ? b.items
          : b.kind === 'figure'
            ? [b.caption]
            : b.kind === 'table'
              ? [b.caption, ...(b.grid?.rows.flatMap((row) => row.cells.map((cell) => cell.segments)) ?? [])]
              : []
    /* One group per run of segments the renderer will draw in one element, and
       never the groups concatenated. A note is a MAXIMAL run of `todo`
       segments, so concatenating two cells would let a note ending one cell and
       a note starting the next become a single card — with the second one's pin
       then looking for a key that was never made. */
    for (const group of groups) {
      for (const run of runs(b.file, b.id, group)) {
        if (run.note) out.push(run.note)
      }
    }
  }
  return out
}
