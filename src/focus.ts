import { KEHIKOT_DIR, emptySaid, moduleFolder, partsOfFile, pickedDocuments, pickedParts, type Anchor, type EpicPart } from 'kehikot-module-protocol'
import type { Focus } from 'kehikot-module-protocol/client/react'

import { planOf, type Plan, type Pullable } from '../compile/part.ts'
import type { PageSpan } from '../compile/synctex.ts'

/**
 * The paper, narrowed to the parts of the epic a person picked out.
 *
 * ## One rule, and it is not this file's
 *
 * A part belongs to the epic and names no module. What it has is a list of
 * documents, project-relative, which the host unions from what every module
 * published for it (`chapters.ts` is where this module publishes its own). A
 * host older than that sends the paper-relative `files` instead. Either way
 * the question "is this in a picked part" is asked of the protocol and never
 * answered here: every file of the paper says what ties it to a part with
 * `anchorOf`, and `useFocus(context).narrow` decides.
 *
 *  - **Nothing picked is the whole epic.** `narrowed` answers null, and the
 *    page is exactly the page it was before any of this existed.
 *  - **Otherwise only what a picked part has is shown**, and the one file the
 *    person is in (`keep`): the editor is never taken from under them.
 *  - **What is in no part is not shown, and nothing says so.** The host's bar
 *    names what is picked; this page draws no line, label or rule about it.
 *
 * ## `main.tex` is a file like the others
 *
 * It is in a part when a part lists it, and otherwise in none — so the title
 * page, the table of contents and the bibliography it prints are not drawn
 * under a pick. It could have been anchored `{ whole: true }`, "part of every
 * part"; then every pick would open on the title page and a person who picked
 * Methods would be looking at `main.tex` again, which is the complaint a part
 * compiled on its own was built to answer ("the front matter in main.tex's
 * body still has to be left out of the view").
 *
 * ## Which pages
 *
 * A sheet of a PDF is an item too, about every file that printed on it, read
 * off the page map the build keeps (`pageMap` in `compile/synctex.ts`). So a
 * sheet two files share is shown when EITHER is picked: half a page cannot be
 * left out of a PDF. A sheet something is marked on is the one in hand, and is
 * kept. The numbers are the paper's — page 7 is still page 7 with pages 1 to
 * 6 not drawn — because other modules store them.
 *
 * ## What is said, and where
 *
 * One sentence, and only inside a PDF pane the pick has left with no page to
 * draw (`noPage`): the protocol's `No page is in the picked part.`, or this
 * module's own when it can say more — the picked part names a file the paper
 * does not include, or its file cannot be compiled alone (`partOf`).
 *
 * ## A part compiled on its own
 *
 * When the picked files are ones `main.tex` pulls in with `\include`, the
 * PDF in the pane is those chapters compiled alone, with `\includeonly`
 * given from outside the paper (`compile/part.ts`, `partOf` here). That PDF
 * still opens with whatever `main.tex` writes in its own body and ends with
 * its bibliography, and the same narrowing leaves those sheets out.
 *
 * It has FEWER SHEETS than the paper. Sheet 9 of a part's PDF is page 17 of
 * the paper, and other modules store pages of the paper. So a sheet number
 * never leaves this module: what is said to the canvas, read out in the
 * toolbar and written on a sheet is the page of the paper, through
 * `pageOfSheet`, and `sheetOfPage` goes back.
 *
 * ## What this does not touch
 *
 * The MCP door: an agent has no canvas and no focus, so `list_sections`,
 * `read_paper`, `read_source` and `list_papers` answer about the whole paper
 * whatever is picked.
 *
 * Pure, with no React and no DOM in it: `Focus` is the value `useFocus` hands
 * the page, and every function here is given it.
 */

/** `.kehikot/paper`: where a project keeps its papers, one folder to an epic. This module's own folder, spelled by the protocol. */
const PAPERS = `${KEHIKOT_DIR}/${moduleFolder('kehikot.paper')}`

/** A file of an epic's paper as a part lists it: relative to the project. */
export function inProject(epic: string, file: string): string {
  return `${PAPERS}/${epic}/${file}`
}

/** The other way: the paper's own name for a project-relative document, or null for one that is not under this epic's paper. */
export function inPaper(epic: string, document: string): string | null {
  const under = `${PAPERS}/${epic}/`
  return document.startsWith(under) && document.length > under.length ? document.slice(under.length) : null
}

/** As much of a paper as an anchor reads. */
export interface Anchored {
  epic: string
  pulls?: Readonly<Record<string, { by: string }>>
}

/**
 * What ties one file of the paper to a part: THE anchor function of this
 * module, and the only thing it gives the protocol's rule to compare.
 *
 * A file is about itself — its own project-relative name — and about every
 * file that pulls it in, short of `main.tex`: a chapter's table belongs with
 * the chapter, whether or not anything lists the table. `main.tex` pulls in
 * everything and is nobody's parent here, or every file would be in whatever
 * part listed it.
 */
export function anchorOf(paper: Anchored, file: string): Anchor[] {
  const out: Anchor[] = [{ file: inProject(paper.epic, file) }]
  let above = paper.pulls?.[file]?.by
  for (let depth = 0; depth < 16 && above !== undefined && above !== MAIN_FILE; depth += 1) {
    out.push({ file: inProject(paper.epic, above) })
    above = paper.pulls?.[above]?.by
  }
  return out
}

export interface Narrowed {
  /** Whether exactly one part is picked: “the picked part”, or “parts”. */
  one: boolean
  /** The paper's files a picked part has, with what they pull in, in the paper's own order. */
  files: string[]
  /** Those, and the file in hand when it is not one of them. What the page lists. */
  shown: string[]
  /**
   * The pages the picked files printed on, ascending, in the PDF's own
   * numbers. Null when nothing has compiled: there are no pages to speak of.
   */
  pages: number[] | null
  /** Files the picked parts name under this paper's folder that the paper does not include. */
  missing: string[]
  /** The protocol's sentence for a pane the pick left with no page. */
  empty: string
}

/** As much of a paper as narrowing reads. */
export interface NarrowablePaper extends Anchored {
  files: readonly string[]
}

/** As much of a build as narrowing reads: the last PDF's page count and page map. */
export interface NarrowablePdf {
  pages: number | null
  map: Record<string, PageSpan[]>
}

/** Every sheet a page map has anything on, ascending, and the files that printed on each. */
function sheetsIn(map: Record<string, PageSpan[]>): Map<number, string[]> {
  const found = new Map<number, string[]>()
  for (const [file, spans] of Object.entries(map)) {
    for (const span of spans) {
      const files = found.get(span.page)
      if (!files) found.set(span.page, [file])
      else if (!files.includes(file)) files.push(file)
    }
  }
  return new Map([...found].sort((a, b) => a[0] - b[0]))
}

/**
 * The sheets of one PDF that are in the picked parts, and those in hand.
 *
 * `map` is that PDF's own page map — the whole paper's, or a part's own — and
 * the answer is in ITS sheets. A sheet is about every file that printed on it;
 * `marked` are the sheets a mark is drawn on, which are kept: a passage a
 * neighbour pointed at must arrive somewhere. Read over the map and not over
 * the paper's file list, because the engine sees an `\input` in the middle of
 * a paragraph that this module's own walk does not.
 */
export function pagesDrawn(focus: Focus, paper: Anchored, map: Record<string, PageSpan[]>, marked: readonly number[] = []): { pages: number[]; empty: string } {
  const sheets = sheetsIn(map)
  const said = focus.narrow(
    [...new Set([...sheets.keys(), ...marked])].sort((a, b) => a - b),
    (sheet) => (sheets.get(sheet) ?? []).flatMap((file) => anchorOf(paper, file)),
    { noun: 'page', keep: (sheet) => marked.includes(sheet) },
  )
  return { pages: said.shown, empty: said.empty || emptySaid(focus.parts, 'page') }
}

/** The files of this paper that the picked parts name, once each: `documents`, and from a host older than those the paper-relative `files`. */
function named(parts: readonly EpicPart[], epic: string): string[] {
  const out: string[] = []
  const put = (file: string | null) => {
    if (file !== null && !out.includes(file)) out.push(file)
  }
  for (const document of pickedDocuments(parts)) put(inPaper(epic, document))
  for (const part of pickedParts(parts)) for (const file of part.files ?? []) put(file)
  return out
}

/**
 * The paper as a picked focus leaves it — or null when nothing is picked, and
 * the whole paper is in front of the person.
 *
 * `open` is the file in hand: the one the editor is on, with whatever is typed
 * in it. It is kept in `shown` whatever is picked, and is in `files` only
 * when a picked part has it.
 */
export function narrowed(focus: Focus, paper: NarrowablePaper, pdf: NarrowablePdf | null, open: string | null = null): Narrowed | null {
  if (!focus.focused) return null
  const said = focus.narrow(paper.files, (file) => anchorOf(paper, file), { noun: 'page', keep: (file) => file === open })
  const files = said.kept ? said.shown.filter((file) => file !== open) : said.shown
  return {
    one: pickedParts(focus.parts).length === 1,
    files,
    shown: said.shown,
    pages: pdf ? pagesDrawn(focus, paper, pdf.map).pages : null,
    missing: named(focus.parts, paper.epic).filter((file) => !paper.files.includes(file)),
    empty: emptySaid(focus.parts, 'page'),
  }
}

/**
 * The one sentence this page says about a focus, and only where the pick has
 * left NOTHING to draw: in the PDF pane, in place of the pages.
 *
 * The protocol's — `No page is in the picked part.` — except where this
 * module knows why and the protocol cannot: the picked parts name only files
 * `main.tex` does not include. (A file that cannot be compiled on its own has
 * its sentence from `partOf`.)
 */
export function noPage(focus: Narrowed): string {
  if (focus.files.length === 0 && focus.missing.length) {
    return `No page of this paper is in the picked part${focus.one ? '' : 's'}: ${focus.one ? 'it names' : 'they name'} ${focus.missing.join(', ')}, which main.tex does not include.`
  }
  return focus.empty
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
    .map((part) => `${part.id}\u0000${[...(part.documents ?? []), ...(part.files ?? [])].join('\u0000')}`)
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
 * moves. The file stays open and is saved as it always is: it is the file in
 * hand, which the rule keeps, and it leaves when the person leaves it. A tick
 * in another control is not a reason to take a sentence away from the person
 * in the middle of it.
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
 * `main.tex`, which no note, question or checklist cites. The files are this
 * page's to say, since only it knows them:
 *
 *  - **nothing ticked** is the whole paper — every file;
 *  - **parts ticked** is what `narrowed` shows: the files those parts have,
 *    and the file in hand;
 *  - **ticked parts that have no file of the paper** is nothing. The pane says
 *    so, and claiming the file left open beside that sentence would be
 *    claiming the focus shows what it has just said it does not.
 *
 * ## The file the editor is on is said first
 *
 * The rest are in the paper's own order; the open file leads them. A list is
 * read from its head — a neighbour narrowed to this container names its
 * heading after `documents[0]`. The list changes when the open file does and
 * not otherwise: a caret, a scroll or a keystroke says nothing.
 *
 * ## More files than the wire carries
 *
 * `limit` is the protocol's bound on one container's documents. A paper with
 * more files than that says as many as fit: the open file, then the files
 * some part of the epic has (`held`, ticked or not — the ones a note or a
 * question is about), then the rest.
 */
export function filesShown(
  focus: Narrowed | null,
  files: readonly string[],
  open: string,
  limit: number,
  held: readonly string[] = [],
): string[] {
  const shown = focus === null ? [...files] : focus.files.length === 0 ? [] : focus.shown
  /* The open file first, whatever the paper's order: see "The file the editor is on" above. */
  const first = shown.includes(open) ? [open] : []
  const rest = shown.filter((one) => one !== open)
  if (shown.length <= limit) return [...first, ...rest]
  return [...first, ...rest.filter((one) => held.includes(one)), ...rest.filter((one) => !held.includes(one))].slice(0, limit)
}

/** The files of the paper that some part of the epic has, picked or not, in the paper's order. */
export function heldBy(parts: readonly EpicPart[], paper: NarrowablePaper, projectPath?: string | null): string[] {
  return paper.files.filter((file) => partsOfFile(parts, inProject(paper.epic, file), paper.epic, projectPath).length > 0)
}

/** One file in the switch above the editor. */
export interface FileTab {
  file: string
  /** What the tab says: the file's own name, or its whole path where two share a name. */
  label: string
}

/**
 * The files to switch among, above the editor: the picked parts' chapters.
 *
 * None when nothing is picked. The whole paper is in front of the person
 * then, and it is walked by pressing the PDF and by the section list — a row
 * of every file would be the file picker this page stopped having.
 *
 * Under a focus they are the files in it that no other file in it pulls in —
 * a chapter, and not the tables it reads, which the section list reaches —
 * in the paper's order, and the open file when it is not one of them: the tab
 * the person is standing on, which has to be drawn for the others to be tabs
 * at all. Nothing marks it. It is in hand, and that is why it is there.
 *
 * A single file is not a switch, and the page draws no tabs for one.
 */
export function tabsOf(focus: Narrowed | null, open: string, paper: Pullable = { files: [] }): FileTab[] {
  if (focus === null) return []
  const pulls = paper.pulls ?? {}
  const chapters = focus.files.filter((file) => !focus.files.includes(pulls[file]?.by ?? ''))
  const files = chapters.includes(open) ? chapters : [...chapters, open]
  const names = files.map((file) => file.split('/').pop() ?? file)
  return files.map((file, i) => ({
    file,
    label: names.indexOf(names[i]!) === names.lastIndexOf(names[i]!) ? names[i]! : file,
  }))
}

/* ---- A part compiled on its own ------------------------------------------- */

/**
 * How the picked parts' files are compiled on their own — or the sentence the
 * pane shows because they cannot be. Null when nothing is picked, when the
 * picked parts have no file of the paper (`noPage` has those sentences), and
 * for a paper that does not say how its files are pulled in: one read by a
 * server older than this page, which is narrowed by its pages as it always was.
 *
 * `focus.files` is every file the part's own PDF is OF: the picked ones and
 * whatever they pull in — a chapter's tables, a section split into a file of
 * its own. A chapter compiled alone with the sheets its own table printed
 * left out would be a chapter with a hole in it.
 */
export function partOf(focus: Narrowed | null, paper: Pullable): Plan | null {
  if (!focus || paper.pulls === undefined) return null
  return planOf(focus.files, paper, `the picked part${focus.one ? '' : 's'}`)
}

/**
 * The page of the PAPER that a sheet of a part's own PDF is — or null when
 * that sheet is none of `files`' (the title page, the bibliography) or the
 * paper has never been compiled with that file in it.
 *
 * `part` and `whole` are the two builds' page maps. A file starts on some
 * sheet of each, and from there its sheets follow one another in both — which
 * is exact for a file pulled in with `\include`, since it starts a sheet of
 * its own, and for whatever that file pulls in. So the page is the file's
 * first page in the paper plus how far into the file the sheet is. Counted
 * from the first sheet rather than looked up line by line, because the part
 * is the newer of the two while somebody types: the paper's map may not have
 * the line at all yet.
 */
export function pageOfSheet(sheet: number, part: Record<string, PageSpan[]>, whole: Record<string, PageSpan[]>, files: readonly string[]): number | null {
  for (const file of files) {
    const here = part[file]
    const there = whole[file]
    if (!here?.length || !there?.length || !here.some((span) => span.page === sheet)) continue
    return there[0]!.page + (sheet - here[0]!.page)
  }
  return null
}

/** The other way: the sheet of a part's own PDF that a page of the paper is on, or null when the part's PDF has no such sheet. */
export function sheetOfPage(page: number, part: Record<string, PageSpan[]>, whole: Record<string, PageSpan[]>, files: readonly string[]): number | null {
  for (const file of files) {
    const here = part[file]
    const there = whole[file]
    if (!here?.length || !there?.length) continue
    const sheet = here[0]!.page + (page - there[0]!.page)
    if (here.some((span) => span.page === sheet)) return sheet
  }
  return null
}

/** Every sheet of a part's own PDF as the page of the paper it is, sheet 1 first; null for a sheet that is no picked file's. */
export function pagesOfSheets(count: number, part: Record<string, PageSpan[]>, whole: Record<string, PageSpan[]>, files: readonly string[]): (number | null)[] {
  return Array.from({ length: count }, (_, i) => pageOfSheet(i + 1, part, whole, files))
}
