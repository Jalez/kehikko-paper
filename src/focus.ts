import { isFocused, narrowToFocus, pickedFiles, pickedParts, type EpicPart } from 'kehikot-module-protocol'

import type { PageSpan } from '../compile/synctex.ts'

/**
 * The paper, narrowed to the parts of the epic a person picked out.
 *
 * ## What is being narrowed, and by whose rule
 *
 * An epic may be divided into parts, and a person may point the whole canvas
 * at some of them in the host's bar. Since protocol 0.32.0 a part can say
 * which files of the epic's paper are its own — `chapters/design.tex`, named
 * from the paper's folder, which is exactly how this module already names a
 * file in `paper.files`, in its hashes and in the page map. So a paper split
 * the ordinary way, one `.tex` per part pulled into `main.tex` with `\input`,
 * can be shown one part at a time: that part's source, and the pages its
 * files printed.
 *
 * The rule is not this file's. It is the one every module on the canvas
 * follows, and it is asked of the protocol each time rather than restated:
 *
 *  - **Nothing picked is the whole epic.** `narrowed` answers null, and the
 *    page is exactly the page it was before any of this existed.
 *  - **Otherwise only what a picked part owns is shown**: a file is anchored
 *    by its own name, `{ file }`, and `narrowToFocus` decides.
 *  - **What is in no part is OUTSIDE the focus** — `main.tex`, usually, and
 *    everything written directly in it. Nothing is said about it: the host's
 *    bar names what is picked, and the pages left out are marked where they
 *    would have been in the PDF.
 *
 * ## Which pages
 *
 * The union of the pages the picked parts' files reached, read off the page
 * map the build already keeps (`pageMap` in `compile/synctex.ts`, built for
 * this). A page two files share is shown if EITHER of them is picked: half a
 * page cannot be left out of a PDF, and a part that begins halfway down a
 * sheet begins on that sheet. The numbers are the real ones — page 7 is still
 * page 7 with pages 1 to 6 not drawn — because other modules store them: a
 * note on page 7 must still be a note on page 7.
 *
 * The map is read over `pickedFiles`, not over the paper's file list, on
 * purpose. The list comes from this module's own walk of the `\input`s, which
 * does not see one in the middle of a paragraph; the engine does. A file the
 * engine opened and the walk missed has pages, and a part that names it means
 * those pages.
 *
 * ## What is said, and where
 *
 * One sentence, and only inside a PDF pane the pick has left with no page to
 * draw (`emptySaid`): the picked parts own no file (`ownsNone`), they name only
 * files the paper does not include (`missing`), or their files printed
 * nothing. Everywhere else the narrowed paper is the message.
 *
 * ## What this does not touch
 *
 * Compilation: the whole paper is always compiled from `main.tex`, and a part
 * is a way of LOOKING at the result. The passage this page publishes
 * (`passage.set`): unchanged, in every field — though which FILES it says it
 * is showing does follow the ticks (`filesShown`). And the MCP door: an agent has no canvas and no
 * focus, so `list_sections`, `read_paper`, `read_source` and `list_papers`
 * answer about the whole paper whatever is picked.
 *
 * Pure, with no React and no DOM in it, so that every sentence the page says
 * about a focus can be asserted without drawing anything.
 */
export interface Narrowed {
  /** The picked parts' headings, in the epic's order. Never empty. */
  parts: string[]
  /** The paper's files a picked part owns, in the paper's own order. */
  files: string[]
  /**
   * The pages the picked files printed on, ascending, in the PDF's own
   * numbers. Null when nothing has compiled: there are no pages to speak of.
   */
  pages: number[] | null
  /** Picked files that are not files of this paper, each with the parts naming it. */
  missing: { file: string; parts: string[] }[]
  /** The picked parts name no file at all. */
  ownsNone: boolean
}

/** As much of a paper as narrowing reads. */
export interface NarrowablePaper {
  epic: string
  files: readonly string[]
}

/** As much of a build as narrowing reads: the last PDF's page count and page map. */
export interface NarrowablePdf {
  pages: number | null
  map: Record<string, PageSpan[]>
}

/**
 * The paper as a picked focus leaves it — or null when nothing is picked, and
 * the whole paper is in front of the person.
 */
export function narrowed(parts: readonly EpicPart[], paper: NarrowablePaper, pdf: NarrowablePdf | null): Narrowed | null {
  if (!isFocused(parts)) return null
  const picked = pickedParts(parts)
  const owned = pickedFiles(parts)
  const { shown: files } = narrowToFocus(parts, paper.files, (file) => ({ file }), { epic: paper.epic })

  const missing = owned
    .filter((file) => !paper.files.includes(file))
    .map((file) => ({
      file,
      parts: picked.filter((part) => (part.files ?? []).includes(file)).map((part) => part.heading || part.id),
    }))

  let pages: number[] | null = null
  if (pdf) {
    const seen = new Set<number>()
    for (const file of owned) for (const span of pdf.map[file] ?? []) seen.add(span.page)
    pages = [...seen].sort((a, b) => a - b)
  }

  return {
    parts: picked.map((part) => part.heading || part.id),
    files,
    pages,
    missing,
    ownsNone: owned.length === 0,
  }
}

/**
 * The one sentence this page says about a focus, and only where the pick has
 * left NOTHING to draw: in the PDF pane, in place of the pages.
 *
 * There used to be a line above the paper for as long as it was narrowed —
 * which parts, how many files and pages, how many were outside, where parts
 * are picked — and more under it. It is gone: the host's bar already says what
 * is picked, the narrowed pages are the message, and a row of prose above a
 * paper is a row of the paper not shown. An empty pane is the exception,
 * because with no words in it it looks broken; so it says why, in one sentence
 * that takes no room from anything.
 *
 * Null whenever there is a page to draw.
 */
export function emptySaid(focus: Narrowed): string | null {
  if (focus.pages === null || focus.pages.length > 0) return null
  const one = focus.parts.length === 1
  const where = `the picked part${one ? '' : 's'}`
  if (focus.ownsNone) return `No page of this paper is in ${where}: ${one ? 'it owns' : 'they own'} none of its files.`
  if (focus.files.length === 0 && focus.missing.length) {
    const named = focus.missing.map((missing) => missing.file).join(', ')
    return `No page of this paper is in ${where}: ${one ? 'it names' : 'they name'} ${named}, which main.tex does not include.`
  }
  return `No page of this PDF was printed by a file of ${where}.`
}

/**
 * The pages the PDF pane draws under a focus, and which of them are there
 * although no picked part printed on them.
 *
 * `marked` is the pages a mark is drawn on — the person's own selection, or a
 * passage another module pointed at. Those are added, flagged, because a note
 * that points at a passage outside the picked parts must still arrive
 * somewhere: the page it is on is drawn, says it is outside, and goes again
 * when the mark does. Without it "show in PDF" and every pointer from another
 * module would scroll to a sheet that is not there.
 */
export function pagesShown(focus: Narrowed, marked: readonly number[]): { pages: number[]; outside: number[] } {
  const own = new Set(focus.pages ?? [])
  const outside = [...new Set(marked)].filter((page) => !own.has(page)).sort((a, b) => a - b)
  return { pages: [...new Set([...own, ...outside])].sort((a, b) => a - b), outside }
}

/**
 * The runs of pages NOT drawn, between the ones that are — so the pane can
 * say "pp. 1–4 are outside the picked parts" where they would have been,
 * rather than letting page 5 follow nothing.
 *
 * Keyed by the shown page each run comes BEFORE; the run after the last shown
 * page is under `total + 1`. `total` null — the build did not say how many
 * pages there are — leaves the last run unsaid rather than guessed.
 */
export function gapsBetween(pages: readonly number[], total: number | null): Map<number, { from: number; to: number }> {
  const gaps = new Map<number, { from: number; to: number }>()
  let next = 1
  for (const page of pages) {
    if (page > next) gaps.set(page, { from: next, to: page - 1 })
    next = page + 1
  }
  if (total !== null && next <= total) gaps.set(total + 1, { from: next, to: total })
  return gaps
}

/** “p. 3” or “pp. 3–6”. */
export function pagesSaid(run: { from: number; to: number }): string {
  return run.from === run.to ? `p. ${run.from}` : `pp. ${run.from}–${run.to}`
}

/** The file every paper starts from, and the one the editor rests on when nothing is picked. */
export const MAIN_FILE = 'main.tex'

/**
 * What is ticked, as one string: the picked parts and the files they own.
 *
 * It is what the editor FOLLOWS (see `fileAfterTicks`), so it is made of the
 * host's ticks and nothing else. Not of the paper's own file list: a chapter
 * added to `main.tex` while one part is picked must not look like a change
 * of focus and move the editor.
 */
export function ticksOf(parts: readonly EpicPart[]): string {
  return pickedParts(parts)
    .map((part) => `${part.id}\u0000${(part.files ?? []).join('\u0000')}`)
    .join('\n')
}

/**
 * The file the editor goes to when the ticks in the host's bar change — or
 * null, to leave the one that is open.
 *
 * ## The editor follows the ticks
 *
 * It used not to. Picking a part narrowed the file LIST and left the editor
 * where it was, with a line offering the part's first file; the person then
 * chose the chapter a second time, in this page's own dropdown. That is "you
 * are able to pick to show a specific chapter" — a chapter picker of this
 * module's — and it is not what was asked for. What was asked for is that the
 * ticks ARE the choice:
 *
 *  - **nothing ticked** is the whole paper, and the editor rests on
 *    `main.tex`;
 *  - **one part ticked** opens that part's file;
 *  - **several ticked** open the first of their files, and the rest are tabs.
 *
 * A file that is already in the new focus is left open: ticking a second
 * part beside the one being read must not move the reader.
 *
 * ## Except out from under somebody typing
 *
 * `midEdit` is the open file holding text that has not reached the disk —
 * typed and not yet saved, a save in flight, a save that failed. Then nothing
 * moves. The file stays open, is saved as it always is, and the page says it
 * is outside the picked parts and offers the way to them; it leaves when the
 * person leaves it. A tick in another control is not a reason to take a
 * sentence away from the person in the middle of it. (Nothing would be LOST
 * either way — every file's text is kept and saved whichever is on screen —
 * but the person would be looking at a different file than the one their
 * hands are in.)
 *
 * And a focus that owns no file of the paper has nowhere to go to; the open
 * file stays, and the empty PDF pane says why nothing is in the focus.
 */
export function fileAfterTicks(focus: Narrowed | null, open: string, midEdit: boolean): string | null {
  if (midEdit) return null
  if (focus === null) return open === MAIN_FILE ? null : MAIN_FILE
  if (focus.files.length === 0 || focus.files.includes(open)) return null
  return focus.files[0] ?? null
}

/**
 * The file a paper OPENS on — or null, for `main.tex`, where every paper starts.
 *
 * `was` is the file the person was in when this page was last on this paper
 * (`remembered.ts`), and it wins over starting on `main.tex`: a reload is not
 * a reason to lose a chapter. But it is a remembered thing and the ticks are
 * a present one, so it is used only while it is still a file of the paper and
 * still inside what is picked. Otherwise this is what it was before anything
 * was remembered: under a focus that does not own `main.tex`, the first file
 * that is in it.
 */
export function fileOnOpening(focus: Narrowed | null, files: readonly string[], was: string | null): string | null {
  if (was !== null && files.includes(was) && (focus === null || focus.files.length === 0 || focus.files.includes(was))) return was
  const first = focus?.files[0]
  return first && !focus!.files.includes(MAIN_FILE) ? first : null
}

/**
 * The files this page says it is showing (`showing.set`), in the paper's own
 * names and the paper's own order.
 *
 * ## Why the paper says it, when the host already knows the passage
 *
 * `passage.set` names ONE file — the one the caret is in. So with two parts
 * ticked the canvas knew one of their files, and with nothing ticked it knew
 * `main.tex`, which no note, question or checklist cites: a pane beside this
 * one that shows "what the paper is showing" showed the wrong half, or
 * nothing. The files are this page's to say, since only it knows them:
 *
 *  - **nothing ticked** is the whole paper — every file;
 *  - **parts ticked** is the files those parts own that the paper includes,
 *    once each — and the open file when it is kept open outside them (unsaved
 *    text, a passage somebody pointed into), because it is on screen;
 *  - **ticked parts that own no file of the paper** is nothing. The page says
 *    so in its own line, and claiming the file left open under that line
 *    would be claiming the focus shows what it has just said it does not.
 *
 * ## The file the editor is on is said first
 *
 * The rest are in the paper's own order; the open file leads them. A list is
 * read from its head — a neighbour narrowed to this container names its
 * heading after `documents[0]` — and in the paper's order that was `main.tex`
 * whatever chapter the editor was on. It is one rule with the cut below: the
 * open file first, then the others, cut at the cap, so the file a person is
 * looking at is never the one dropped. The list changes when the open file
 * does and not otherwise: a caret, a scroll or a keystroke says nothing.
 *
 * ## More files than the wire carries
 *
 * `limit` is the protocol's bound on one container's documents. A paper with
 * more files than that cannot say all of them, and saying none would put the
 * canvas back to knowing only the caret's file. So it says as many as fit —
 * and WHICH is the question, because whatever is cut is a file whose notes
 * and questions a neighbour then calls "about documents nothing here is
 * showing".
 *
 * The first sixteen in the paper's order was the answer, and it cut by
 * accident: a thesis lists its generated tables between its chapters, so the
 * tables were said and the last chapters were not. `owned` is every file some
 * part of the epic owns, ticked or not — the files the work is organised
 * around, and the ones a note or a question is about. After the open file
 * those are said first, in the paper's order, and the rest fill what room is
 * left. A paper that fits is said whole.
 */
export function filesShown(
  focus: Narrowed | null,
  files: readonly string[],
  open: string,
  limit: number,
  owned: readonly string[] = [],
): string[] {
  const shown =
    focus === null ? [...files] : focus.files.length === 0 ? [] : files.filter((one) => one === open || focus.files.includes(one))
  /* The open file first, whatever the paper's order: see "The file the editor is on" above. */
  const first = shown.includes(open) ? [open] : []
  const rest = shown.filter((one) => one !== open)
  if (shown.length <= limit) return [...first, ...rest]
  return [...first, ...rest.filter((one) => owned.includes(one)), ...rest.filter((one) => !owned.includes(one))].slice(0, limit)
}

/** One file in the switch above the editor. */
export interface FileTab {
  file: string
  /** What the tab says: the file's own name, or its whole path where two share a name. */
  label: string
  /** Open, and outside the picked parts: it is here because it is open. */
  outside: boolean
}

/**
 * The files to switch among, above the editor: the picked parts' own.
 *
 * None when nothing is picked. The whole paper is in front of the person
 * then, and it is walked by pressing the PDF and by the section list — a row
 * of every file would be the file picker this page stopped having.
 *
 * Under a focus they are exactly the files in it, in the paper's order,
 * and — last, and marked — the open file when it is not one of them: a file
 * kept open under somebody typing, or one a note in another module pointed
 * into. That one is not a way to widen the focus; it is the tab the person
 * is standing on, which has to be drawn for the others to be tabs at all.
 *
 * A single file is not a switch, and the page draws no tabs for one.
 */
export function tabsOf(focus: Narrowed | null, open: string): FileTab[] {
  if (focus === null) return []
  const files = focus.files.includes(open) ? focus.files : [...focus.files, open]
  const names = files.map((file) => file.split('/').pop() ?? file)
  return files.map((file, i) => ({
    file,
    label: names.indexOf(names[i]!) === names.lastIndexOf(names[i]!) ? names[i]! : file,
    outside: !focus.files.includes(file),
  }))
}
