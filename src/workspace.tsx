import { LIMITS, type Passage as WirePassage } from 'kehikot-module-protocol'
import { useFocus } from 'kehikot-module-protocol/client/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'

import type { PartStatus } from '../compile/build.ts'
import { NOT_CONFINED } from '../compile/confine.ts'
import type { Problem } from '../compile/log.ts'
import { pageOfLine, type PageRect } from '../compile/synctex.ts'
import { plainText } from '../latex/parse.ts'
import type { Proposal } from '../latex/propose.ts'
import type { Paper } from '../store.ts'
import { apiUrl, json, standingIn } from './api.ts'
import { CompilerOffer } from './compiler-offer.tsx'
import type { Editor } from './editor/source-editor.tsx'
import {
  MAIN_FILE,
  coveredBy,
  emptySaid,
  fileAfterTicks,
  fileOnOpening,
  filesShown,
  narrowed,
  pageOfSheet,
  pagesOfSheets,
  pagesShown,
  partOf,
  sheetsOf,
  tabsOf,
  ticksOf,
  type Narrowed,
} from './focus.ts'
import { byteAt, indexAt, lineAt, startOfLine, textOfLine, toDisk } from './lib/offsets.ts'
import { jumpsOf, sectionAt, sectionsOf } from './lib/sections.ts'
import { pdfIsOf } from './pdf/of.ts'
import type { PdfMark, Preview } from './pdf/pdf-view.tsx'
import { placeWord, wholeWords } from './pdf/words.ts'
import { keyOf, received } from './pointed.ts'
import { ProposalsPanel } from './proposals-panel.tsx'
import { autoApproveKey, autoApproveWas, keptPlace, pdfWas, placeWas, rememberAutoApprove, rememberPdf, rememberPlace, rememberSaid, rememberSpot, saidWas, spotWas } from './remembered.ts'
import { useBuild } from './use-build.ts'
import type { usePaper } from './use-paper.ts'
import { join, usePublishedPassage, type Highlighted, type Sheet } from './use-published-passage.ts'
import { useSource, type Landed } from './use-source.ts'
import { useTheme } from './use-theme.ts'

/**
 * A paper being worked on: its source in an editor, its compiled PDF beside it.
 *
 * ## What this screen is
 *
 * The file itself on the left, the thing it compiles to on the right, and four
 * lines between them: a save reaches the disk and the PDF follows; a selection
 * in the source shows where it came out; a press on the PDF goes to the line
 * it came from; an engine's complaint is a line to press. It is the shape
 * Overleaf has and the shape the Slides module beside this one has, and for
 * the same reason — what you edit is the document, and what you look at is
 * the result, and nothing stands in for either.
 *
 * It replaced a reader that parsed the LaTeX itself and drew it as prose. That
 * view could not show a figure it did not understand, a table it had not been
 * taught, or anybody's document class, and editing through it meant mapping a
 * change in rendered words back onto source — exact for plain prose and
 * refused for everything else. The parser is still here and still does what
 * other modules depend on (the section list); it no longer draws the paper.
 *
 * ## Narrow first
 *
 * A container is 220 to 400 pixels wide as often as it is wide. Below 720
 * pixels there is ONE pane and two tabs, and navigation switches tab for you:
 * pressing the PDF lands in the source, "show in PDF" lands in the PDF. From
 * 720 up they sit side by side.
 *
 * ## Narrowed to the picked parts of the epic
 *
 * When a person has picked some of the epic's parts in the host's bar, this
 * screen shows only what those parts own: their files, the sections of those
 * files, and the pages those files printed. `src/focus.ts` has the rule and
 * the arithmetic; four decisions are this screen's.
 *
 * **There is no chapter picker here.** This screen had a dropdown of the
 * paper's files, and under a focus it listed the picked parts' own — so a
 * person ticked a chapter in the host's bar and then chose it again here.
 * That second choice was the complaint: "in the paper you are able to pick to
 * show a specific chapter, but that's not what was promised". The dropdown
 * is gone. What is shown follows the ticks, and `fileAfterTicks` is how:
 * nothing ticked is the whole paper with `main.tex` in the editor; one part
 * ticked opens that part's file; several ticked are tabs, of those files and
 * no others.
 *
 * Every file is still reachable, by the two ways that are about the PAPER
 * and not about a list of its files: a press on the PDF opens the file that
 * printed that spot, at that line; and the section list is grouped by file,
 * with an entry for a file that has no heading (`jumpsOf`). When either has
 * taken the editor away from `main.tex` with nothing ticked, one small press
 * beside the file's name goes back.
 *
 * **The line above the editor names the file an edit is saved to.** With no
 * dropdown showing the open file there has to be something that does, and
 * it has to be unmistakable, because the editor now changes file when a tick
 * changes. "Editing chapters/3_methods.tex" stands directly over the text,
 * with whether it is saved beside it, in both panes' narrow form.
 *
 * **A file with unsaved text in it is never taken away.** Ticking a part
 * while a sentence in `main.tex` has not reached the disk would otherwise
 * swap the editor's file under a person mid-sentence. So that file stays
 * open, stays editable and is saved as it always is; it is the last tab,
 * marked as outside, and no row is spent saying so. It leaves when the person
 * leaves it.
 *
 * **A pointer from elsewhere still arrives.** A note, a question or a slide
 * may point at a passage in a file no picked part owns. It is opened and
 * marked exactly as before, the sentence about it says it is outside the
 * picked parts, and the whole paper is shown at that place for as long as the
 * mark is there — see "Which PDF is on screen", in the body.
 *
 * **The PDF is the picked files compiled on their own**, when the paper pulls
 * them in with `\include` (`compile/part.ts`): a second PDF, with fewer
 * sheets than the paper, its own SyncTeX table and its own record of which
 * text it is of. Three things follow, and each is kept in one place here.
 * Whatever is asked about a place on screen is asked of the PDF on screen
 * (`screen`, `buildId`). Whatever is SAID about a place — to the canvas, in
 * the toolbar, on a sheet — is a page of the paper and never a sheet of the
 * part's PDF (`pageAt`, `partNumbers`). And a save compiles the part alone;
 * the whole paper is compiled when the person leaves the part (`recompile`,
 * and the effects beside it).
 *
 * **There is no "show everything" here, and no line about the pick.** The
 * host's bar says what is picked, and that is where it is lifted. A second switch on this
 * page would be a second place to look for why a paper is short.
 *
 * ## The editor and the preview are passed in
 *
 * CodeMirror does not lay out in a DOM with no layout and pdf.js needs a
 * canvas and a worker, so neither runs under the test DOM. Everything that is
 * this screen's LOGIC — which bytes a selection is, what is said to the
 * canvas, what a foreign anchor does, when a compile is asked for — is
 * exercised with a textarea and a stub in their place. The two real components
 * are checked in a browser.
 */

type Wire = ReturnType<typeof usePaper>

/** Somewhere to take the editor, resolved once that file's text is here. */
interface Going {
  file: string
  /** A byte range of the file on disk… */
  bytes?: { from: number; to: number }
  /** …or a one-based line, optionally narrowed to a word printed there. */
  line?: number
  word?: string | null
  select?: boolean
  focus?: boolean
  /** Mark it as somebody else's anchor rather than moving the selection onto it. */
  foreign?: boolean
  /** A byte to put at the top of the editor, rather than the range in its middle: a place being put back. */
  top?: number | null
  /** How many pixels of the row that byte is on were above the top of the editor. */
  past?: number
}

export function Workspace({
  paper,
  wire,
  editor: EditorPane,
  preview: PreviewPane,
  saveDelay,
  settle = 220,
}: {
  paper: Paper
  wire: Wire
  editor: Editor
  preview: Preview
  /** How long typing has to pause before a save. */
  saveDelay?: number
  /** How long a selection has to hold still before the PDF is asked where it is. */
  settle?: number
}) {
  const theme = useTheme()
  const { build, part, compiling, compile, compilePart, seePart, refresh } = useBuild(paper.epic)
  const { setPaper, setProposals, setSaid } = wire
  /* What "compile" means just now: the whole paper, or — with parts picked
     whose files can be compiled on their own — those files. Decided further
     down, where the pick is known, and reached from here through a ref because
     a save lands in a callback made before any of that. */
  const recompile = useRef<() => void>(() => void compile())

  const onLanded = useCallback(
    (landed: Landed) => {
      if (landed.paper) setPaper(landed.paper)
      if (Array.isArray(landed.proposals)) setProposals(landed.proposals)
      if (landed.said) setSaid(landed.said)
      /* The save reached the disk, so the PDF on screen is now of older text. */
      recompile.current()
    },
    [setPaper, setProposals, setSaid],
  )
  const source = useSource({ paper, disk: wire.disk, onLanded, saveDelay })
  const { file, doc, fresh } = source

  /* ---- The parts the canvas is pointed at ------------------------------- */

  const ticked = useFocus({ parts: wire.parts, epic: paper.epic })
  const parts = ticked.parts
  const pdf = build?.pdf ?? null
  const focus = useMemo(
    () => narrowed(parts, paper, pdf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts, paper.epic, paper.files, pdf?.id],
  )
  const focusRef = useRef(focus)
  focusRef.current = focus
  /* ---- The picked parts compiled on their own ---------------------------- */

  /* Whether the picked files can be compiled alone, and as what (`partOf`):
     `only` is what `\includeonly` is given, or null — nothing picked, a pick
     that owns no file, or files that cannot be (the pane then says which, in
     `plan.cannot`). Held as strings: the paper is re-read after every save,
     and a selection that has not changed must not look as though it had. */
  const plan = partOf(focus, paper)
  const cannot = plan?.cannot ?? null
  const onlyKey = plan?.only ? plan.only.join('\n') : null
  const pickedKey = onlyKey !== null && focus ? focus.files.join('\n') : null
  /* Every file the part's own PDF is of: the picked ones and what they pull in. */
  const coveredKey = pickedKey !== null && focus ? coveredBy(focus.files, paper).join('\n') : ''
  const covered = useMemo(() => (coveredKey ? coveredKey.split('\n') : NO_FILES), [coveredKey])
  /* What the server last said about THIS selection. */
  const heard = part !== null && part.files === pickedKey ? part : null
  const own = heard?.status ?? null
  /* The part's PDF to draw: this selection's own, once there is one. Until
     then the pages its files printed in the whole paper are what is on screen,
     as they always were under a pick — with `\include` those are the same
     sheets, of the last full build — so a tick shows the right chapter at
     once and the part's own PDF takes its place when it is made. Held in a
     ref so that a status re-read that changes nothing is the same object. */
  const drawn = useRef<DrawnPart | null>(null)
  if (pickedKey === null || onlyKey === null || !own?.pdf || !own.key) drawn.current = null
  else if (drawn.current?.pdf.id !== own.pdf.id || drawn.current.kind !== onlyKey || drawn.current.covered !== covered) {
    drawn.current = { kind: onlyKey, key: own.key, pdf: own.pdf, covered }
  }
  const partDrawn = drawn.current

  /* A pick is compiled once it has held still for a moment, the whole paper
     first when it is not of the text on disk (`full`): the pick changing is
     the person leaving the part they were in, and the next part reads every
     other chapter's numbers from the whole paper's last build. What stands
     from before — a reload, a selection come back to — is asked for at once
     and drawn while that is found out. */
  useEffect(() => {
    if (pickedKey === null) return
    const files = pickedKey.split('\n')
    void seePart(files)
    const timer = setTimeout(() => void compilePart(files, { full: true }), PICK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [paper.epic, pickedKey, seePart, compilePart])

  /** Whether a file is outside what is picked. Never, when nothing is. */
  const isOutside = useCallback((name: string) => !ticked.inFocus({ file: name }), [ticked])
  const outsideSaid = focus ? `the picked part${focus.parts.length === 1 ? '' : 's'}` : ''

  /* A paper OPENED goes back to where its reader was — the file, the tab, and
     the caret and scroll in that file — and, with nothing remembered or the
     file no longer in what is shown, starts under a focus on a file that is in
     it. `fileOnOpening` has the rule and `remembered.ts` what is kept. A place
     in the file is put back only while the file is byte for byte the one it
     was a place in.

     Once per paper, which is what the dependency says: after this the open
     file moves only when the ticks do (below). Declared straight after
     `useSource` so that it runs after that hook's own "a new paper starts on
     main.tex" — and with no guard of its own beyond the dependency, so that
     it runs after it EVERY time that one runs. StrictMode, which is how the
     page is mounted, runs both twice; a ref that let this run once left the
     second "starts on main.tex" standing, and a reload with a part ticked
     opened `main.tex`, marked outside. Nothing is REMEMBERED before a file's
     text is on screen (below), so the second run reads what the first did.

     Before the effect that walks to a passage the canvas holds, so that one
     has the last word: what somebody pointed at outranks where this was. */
  useEffect(() => {
    /* Whatever passage was walked to was walked to before this ran, and this
       is about to open a file over it: the walk is owed again. Without it the
       second of StrictMode's two runs left the page off the passage. */
    walkedFor.current = null
    const was = placeWas(standingIn(), paper.epic, wire.kept.current)
    if (was) setTab(was.tab)
    const next = fileOnOpening(focusRef.current, paper.files, was?.file ?? null)
    if (next !== null) source.open(next)
    const spot = was && was.file === (next ?? MAIN_FILE) ? spotWas(standingIn(), paper.epic, was.file) : null
    if (!was || !spot || spot.hash !== paper.hashes[was.file]) return
    putBack.current = { file: was.file, from: spot.from, to: spot.to }
    if (spot.top !== null) scrolled.current = { file: was.file, top: spot.top, past: spot.past }
    setGoing({ file: was.file, bytes: { from: spot.from, to: spot.to }, top: spot.top, past: spot.past, select: true, focus: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.epic])

  /* The editor follows the ticks in the host's bar — see `fileAfterTicks` for
     the rule and for the one case it does not. Once per CHANGE of what is
     ticked: the ref holds what was ticked when this last ran, so a re-render,
     a re-read of the paper or a save never moves the editor, and neither does
     opening a paper (that is the effect above). */
  const ticks = ticksOf(parts)
  /* How far down the PDF was, read while drawing and before anything can have
     been written over it; only under the ticks it was scrolled under, since
     the same number of points down a different set of sheets is another page. */
  const pdfFrom = useMemo(() => {
    const was = pdfWas(standingIn(), paper.epic)
    return was && was.ticks === ticks ? was.top : 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.epic])
  const ticksRef = useRef(ticks)
  ticksRef.current = ticks
  const onPdfScrolled = useCallback(
    (top: number) => {
      /* Not while the whole paper is on screen for a mark outside the picked part: that is a visit, at another length, and not where the reader was. */
      if (!calledNow.current) rememberPdf(standingIn(), paper.epic, { top, ticks: ticksRef.current })
    },
    [paper.epic],
  )
  const followed = useRef<{ epic: string; ticks: string } | null>(null)
  const midEdit = source.state !== 'saved'
  useEffect(() => {
    const was = followed.current
    followed.current = { epic: paper.epic, ticks }
    if (!was || was.epic !== paper.epic || was.ticks === ticks) return
    /* A tick is the person saying where they are, and it is not made in this
       frame: no pointer, wheel or key arrives here to end the quiet a passage
       from somebody else began (see `adopted`), and a collapsed paper can be
       given none at all. So the tick ends it, and the passage is said again
       whether or not the tick moved the editor — it may have been walked to
       this very file by the passage the canvas is still holding. Before the
       return below, for that case and for a file kept open under unsaved text. */
    setAdopted(false)
    sayAgain((n) => n + 1)
    const next = fileAfterTicks(focusRef.current, file, midEdit)
    if (next === null) return
    setOnPassage(false)
    notice(null)
    source.open(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.epic, ticks])

  /* A suggestion is accepted against the file ON DISK. So the editor saves
     first, and the accept then splices into the text the person is looking at. */
  wire.before.current = source.flush

  /* The disk's text replaced the editor's — another editor saved, a suggestion
     was accepted. The PDF follows that too. */
  const taken = source.taken
  useEffect(() => {
    if (taken > 0) recompile.current()
  }, [taken])

  /* On opening: compile when there is an engine and no PDF of THIS text. Once
     per text, so a paper that does not compile is not retried in a loop. */
  const tried = useRef('')
  useEffect(() => {
    /* Not while parts are compiled on their own: their own request compiles
       the whole paper when it has to (above). Lifting the pick comes through
       here, and the paper — stale by then, if anything was typed — is made. */
    if (!build || !build.engine || compiling || pickedKey !== null) return
    const stamp = `${paper.epic}\0${Object.entries(paper.hashes).sort().join('|')}`
    if (tried.current === stamp) return
    const fresh = build.pdf !== null && sameHashes(build.pdf.hashes, paper.hashes)
    tried.current = stamp
    if (!fresh) void compile()
  }, [build, compiling, compile, paper.epic, paper.hashes, pickedKey])

  const [tab, setTab] = useState<'source' | 'pdf'>('source')
  const tabRef = useRef(tab)
  tabRef.current = tab
  const unseen = useRef(false)
  const [selection, setSelection] = useState({ from: 0, to: 0 })
  const [jump, setJump] = useState<{ from: number; to: number; nonce: number; select?: boolean; focus?: boolean; keep?: boolean } | null>(null)
  const [going, setGoing] = useState<Going | null>(null)
  /** The byte at the top of the editor, as the editor last said it, the file it is a byte of, and how far past the top its row is. */
  const scrolled = useRef<{ file: string; top: number; past: number } | null>(null)
  /** The selection that was put back on opening: not the person selecting, so not a reason to turn the PDF to it. */
  const putBack = useRef<{ file: string; from: number; to: number } | null>(null)
  /** Somebody else's anchor, in bytes of a file of this paper. */
  const [theirs, setForeign] = useState<{ file: string; from: number; to: number; quoted: string } | null>(null)
  /**
   * A change this page is drawing attention to: a suggestion that arrived, or
   * text that landed from the disk. In bytes of a file, like `theirs`.
   *
   * It is marked exactly as a passage somebody pointed at is — in the source
   * without touching the selection, on the PDF in the other colour — because
   * it IS that: a place somebody else chose. What the canvas points at
   * outranks it, and going anywhere of one's own accord takes it down.
   *
   * Unlike a passage somebody pointed at, it does not turn the PDF to itself:
   * nobody here asked, and the person may be reading another page. `reveal`
   * is the exception — a change that landed because they pressed Accept.
   */
  const [noted, setNoted] = useState<{ file: string; from: number; to: number; proposal?: string; reveal?: boolean } | null>(null)
  const notedRef = useRef(noted)
  notedRef.current = noted
  const foreign = theirs ?? noted
  const [adopted, setAdopted] = useState(false)
  /** How many times the ticks in the host's bar have changed under this paper: each is a reason to say the passage again. */
  const [again, sayAgain] = useState(0)
  /**
   * Whether what is on screen is still the passage somebody pointed at.
   *
   * Not the same question as `adopted`, which is about SPEAKING and is lifted
   * by any gesture at all, a wheel included. This one is about what the
   * toolbar reads out and whether the sentence about being pointed here is
   * still true, and it ends only when the person goes somewhere else: places
   * the caret, picks a file or a section, presses the PDF.
   *
   * It exists because walking to a foreign passage deliberately leaves the
   * caret alone — the passage is MARKED, the selection stays the person's —
   * so everything derived from the caret went on describing the place the
   * person had been. Paper opened a passage on page 12 and the toolbar said
   * "p. 11/20" and named the file's first section.
   */
  const [onPassage, setOnPassage] = useState(false)
  /**
   * The place a passage from the canvas walked this page to, kept for as long
   * as that is what is on screen (`onPassage`).
   *
   * `theirs` is the same place while the canvas holds their passage, and is
   * the MARK: it goes when the canvas lets go. This outlives it, because the
   * page does not move when the mark comes down. A person who scrolls here
   * after a note was pressed has not gone anywhere else, and what this page
   * then says to the canvas — and what the toolbar reads out — is this place,
   * not wherever the caret was left before the walk.
   */
  const [walked, setWalked] = useState<{ file: string; from: number; to: number } | null>(null)
  /* The sentence this page said about being pointed somewhere, while it is
     the one on screen. Kept so that it can be taken down again without
     taking down whatever else has been said since — a save's answer, a
     commit's — which share the one line. */
  const noticed = useRef<string | null>(null)
  const notice = useCallback(
    (words: string | null) => {
      const was = noticed.current
      noticed.current = words
      if (words !== null) setSaid(words)
      else if (was !== null) setSaid((now) => (now === was ? '' : now))
    },
    [setSaid],
  )
  /** The person went somewhere of their own accord: the passage is no longer what this page is showing. */
  const wandered = useCallback(() => {
    setOnPassage(false)
    setNoted(null)
    notice(null)
  }, [notice])

  useLayoutEffect(() => {
    setSelection({ from: 0, to: 0 })
  }, [file, paper.epic])

  const go = useCallback(
    (target: Going) => {
      source.open(target.file)
      setGoing(target)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source.open],
  )

  /* Resolve a pending `go` once the file it names is the one open and its text
     has arrived: bytes and lines only mean something against that text. */
  useEffect(() => {
    if (!going || going.file !== file || !doc) return
    let from = 0
    let to = 0
    if (going.bytes) {
      from = indexAt(doc.text, going.bytes.from, doc.eol)
      to = indexAt(doc.text, going.bytes.to, doc.eol)
    } else if (going.line) {
      const lines = [going.line - 2, going.line - 1, going.line, going.line + 1, going.line + 2].filter((n) => n >= 1)
      const named = lines.indexOf(going.line)
      const placed = going.word ? placeWord(lines.map((n) => textOfLine(doc.text, n)), named, going.word) : null
      if (placed && going.word) {
        from = startOfLine(doc.text, lines[placed.line]!) + placed.column
        to = from + going.word.length
      } else {
        /* The line, at its first ink: SyncTeX's answer with nothing finer. */
        const start = startOfLine(doc.text, going.line)
        const text = textOfLine(doc.text, going.line)
        from = to = start + (text.length - text.trimStart().length)
      }
    }
    const top = typeof going.top === 'number' ? { top: indexAt(doc.text, going.top, doc.eol), past: going.past ?? 0 } : {}
    setJump((was) => ({ from, to, nonce: (was?.nonce ?? 0) + 1, select: going.select && to > from, focus: going.focus, keep: going.foreign, ...top }))
    if (tabRef.current !== 'source') unseen.current = true
    setGoing(null)
  }, [going, file, doc])

  /* The editor was taken somewhere while the PDF tab was in front of it, and
     an editor with no layout scrolls nowhere. It is owed that scroll when its
     tab is next shown — only the scroll: the selection is already made. */
  useEffect(() => {
    if (tab !== 'source' || !unseen.current) return
    unseen.current = false
    setJump((was) => (was ? { ...was, nonce: was.nonce + 1, keep: true, focus: false } : was))
  }, [tab])

  /* ---- Where the caret is, in the three currencies ---------------------- */

  const sections = useMemo(() => sectionsOf(paper), [paper])
  const text = doc?.text ?? ''
  const eol = doc?.eol ?? '\n'
  const from = Math.min(selection.from, text.length)
  const to = Math.min(selection.to, text.length)
  const fromByte = useMemo(() => byteAt(text, from, eol), [text, from, eol])
  const toByte = useMemo(() => byteAt(text, to, eol), [text, to, eol])
  const fromLine = useMemo(() => lineAt(text, from), [text, from])
  const toLine = useMemo(() => lineAt(text, to > from && text[to - 1] === '\n' ? to - 1 : to), [text, from, to])
  const here = useMemo(() => (doc ? sectionAt(sections, file, fromByte) : null), [doc, sections, file, fromByte])

  const map = build?.pdf?.map ?? null
  /* The page of the PAPER a line is on. Read off the part's own build when
     there is one and the file is in it — it is the newer of the two while
     somebody types in a part — and turned from a sheet of that PDF into a page
     of the paper, which is the only number that leaves this module. */
  const partMap = own?.pdf?.map ?? null
  const pageAt = useCallback(
    (name: string, line: number): number | null => {
      if (!map) return null
      if (partMap && covered.includes(name)) {
        const sheet = pageOfLine(partMap, name, line)
        const known = sheet === null ? null : pageOfSheet(sheet, partMap, map, covered)
        if (known !== null) return known
      }
      return pageOfLine(map, name, line)
    },
    [map, partMap, covered],
  )
  const page = useMemo(() => pageAt(file, fromLine), [pageAt, file, fromLine])

  /* ---- Remembering where this is, for the next time the page loads ------- */

  /* The file and the tab, once that file's text is on screen — not before, or
     the `main.tex` every paper starts on would be written over the place this
     is about to go back to. To this tab's session and, being one short line
     that changes when a person changes file, to the host. */
  const { keep } = wire
  useEffect(() => {
    if (!doc) return
    const place = { file, tab }
    rememberPlace(standingIn(), paper.epic, place)
    const line = keptPlace(standingIn(), paper.epic, place)
    if (line !== null) keep(line)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.epic, file, tab, doc === null, keep])

  /* The selection and the editor's scroll, in bytes of the file as it is on
     disk and with the hash that says which bytes those are. Not while there is
     unsaved text: the offsets would be into text the disk does not hold yet,
     and the save that follows changes the hash and comes through here. */
  const spot = useRef({ file, from: fromByte, to: toByte, text, eol, hash: doc && doc.text === doc.saved ? doc.hash : null })
  spot.current = { file, from: fromByte, to: toByte, text, eol, hash: doc && doc.text === doc.saved ? doc.hash : null }
  const rememberHere = useCallback(() => {
    const now = spot.current
    if (now.hash === null) return
    const at = scrolled.current?.file === now.file ? scrolled.current : null
    rememberSpot(standingIn(), paper.epic, now.file, { from: now.from, to: now.to, top: at?.top ?? null, past: at?.past ?? 0, hash: now.hash })
  }, [paper.epic])
  useEffect(rememberHere, [rememberHere, file, fromByte, toByte, spot.current.hash])
  const onEditorScrolled = useCallback(
    (top: number, past = 0) => {
      const now = spot.current
      scrolled.current = { file: now.file, top: byteAt(now.text, top, now.eol), past }
      rememberHere()
    },
    [rememberHere],
  )

  /* A caret that MOVED is the person going somewhere. Compared with what is
     held, because the editor also reports a selection when the disk's text
     replaces its own, and that is nobody navigating. */
  const held = useRef(selection)
  held.current = selection
  const onSelect = useCallback(
    (next: { from: number; to: number }) => {
      if (held.current.from !== next.from || held.current.to !== next.to) wandered()
      setSelection(next)
    },
    [wandered],
  )

  const selecting = to > from
  /* ---- Which PDF is on screen --------------------------------------------- */

  /* With parts compiled on their own there are two PDFs: the part's, and the
     whole paper's. The part's is the one drawn — except while something is
     marked that it has no page for. A passage a neighbour pointed at in a file
     outside the picked ones, a change that landed in one, and the person's
     own selection or "Show in PDF" in a file kept open outside them: the
     whole paper is then shown, at that place, for as long as that mark is up,
     and the part's PDF comes back when it is taken down. Decided by WHICH FILE
     the mark is in and by nothing that arrives later — not by rectangles, not
     by a build finishing — so it cannot go back and forth by itself. A bare
     caret in a file outside is not a mark anybody asked for and calls nothing.

     The same holds for a pick that cannot be compiled on its own (`cannot`):
     nothing is in a part's PDF then, the pane says why, and a mark still
     brings the whole paper. */
  const [shownOutside, setShownOutside] = useState(false)
  useEffect(() => setShownOutside(false), [file, from, to, ticks])
  const called =
    plan !== null && ((foreign !== null && !covered.includes(foreign.file)) || ((selecting || shownOutside) && !covered.includes(file)))
  const onPart = partDrawn !== null && !called
  /* Everything asked about a place on screen is asked of the PDF on screen. */
  const buildId = onPart ? partDrawn.pdf.id : (build?.pdf?.id ?? null)
  const screen = useRef<DrawnPart | null>(null)
  screen.current = onPart ? partDrawn : null
  const wholeStale = build?.pdf ? !sameHashes(build.pdf.hashes, paper.hashes) : false

  recompile.current = () => {
    if (pickedKey === null) void compile()
    /* The whole paper is on screen for a mark outside the part: it is what has to follow the text. */
    else void compilePart(pickedKey.split('\n'), called ? { full: true } : {})
  }

  /* Where the table said the foreign passage is printed — WHICH passage that
     was asked about, and of WHICH PDF.

     The passage, because one pointed a moment ago must not lend its
     rectangles to the next one: for the tenth of a second before the new
     answer, the new words were looked for beside the old place, and marked
     there when they happened to be found.

     The PDF (`build`), because rectangles are in the sheets of the PDF they
     were asked of. They are drawn on that PDF and no other: when the pane
     turns from the whole paper to a part's own, what was asked of the one is
     not a place in the other, and is not shown for the moment it takes to ask
     again. */
  const [hint, setHint] = useState<Hint>(NO_HINT)
  const foreignKey = foreign ? `${foreign.file}\0${foreign.from}\0${foreign.to}` : ''
  const foreignRects = hint.of === foreignKey && hint.build === buildId ? hint.rects : NO_HINT.rects
  const foreignDoc = foreign ? source.docs.get(foreign.file) : undefined
  const foreignText = foreignDoc?.text

  /* The whole paper was called onto the screen and is of older text than the
     disk's — as it is by design while a part is worked in, and as it is when
     the file the passage is in was changed by somebody else since the last
     full build. It is made current, with nothing pressed, and the mark that
     was waiting for it is put when it lands. Once per time it becomes so: a
     paper that does not compile is not retried in a loop. */
  const wholeBehind =
    called
    && pickedKey !== null
    && (wholeStale || (foreign !== null && build?.pdf != null && foreignDoc !== undefined && build.pdf.hashes[foreign.file] !== foreignDoc.hash))
  useEffect(() => {
    if (wholeBehind && pickedKey !== null) void compilePart(pickedKey.split('\n'), { full: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wholeBehind, pickedKey])

  /* ---- What the toolbar reads out ---------------------------------------- */

  /* The caret's page and section — unless this page is showing a passage it
     was pointed at, and then THAT passage's: see `onPassage`. The page is the
     one its mark is drawn on when SyncTeX has answered, and the one the page
     map gives its first line until then. */
  const showing = onPassage ? (theirs ?? walked ?? noted) : null
  const showingDoc = showing ? source.docs.get(showing.file) : undefined
  const showingText = showingDoc?.text
  /* The page the mark was drawn on, kept for the place after the mark has
     come down: the same page goes on being read out and said. */
  const markedOn = useRef<{ at: string; page: number } | null>(null)
  const showingAt = showing ? `${showing.file}\0${showing.from}` : ''
  if (showing && foreign === showing && foreignRects[0]) {
    /* A rectangle is in the sheets of the PDF it was asked of. On a part's own
       PDF that is not a page of the paper, and it is turned into one here. */
    const drawnOn = foreignRects[0].page
    const paged = !onPart ? drawnOn : map ? pageOfSheet(drawnOn, partDrawn.pdf.map, map, partDrawn.covered) : null
    markedOn.current = paged === null ? null : { at: showingAt, page: paged }
  }
  const marked = markedOn.current?.at === showingAt ? markedOn.current.page : null
  const shown = useMemo(
    () =>
      placeShown(
        { page, section: here?.title ?? null },
        showing && {
          section: sectionAt(sections, showing.file, showing.from)?.title ?? null,
          marked,
          mapped:
            map && showingText !== undefined && showingDoc
              ? pageAt(showing.file, lineAt(showingText, indexAt(showingText, showing.from, showingDoc.eol)))
              : null,
        },
      ),
    [page, here, showing, sections, marked, map, pageAt, showingText, showingDoc],
  )

  /* ---- What this page says to the canvas -------------------------------- */

  /* Where this page is, which is what it says. The caret's place — unless a
     passage from the canvas walked it somewhere and it is still there
     (`walked`): then THAT place, at the precision of a section and with no
     range, which is the very thing the toolbar is reading out. The caret was
     left where it was by the walk, on purpose, and saying its place would be
     saying the page is somewhere it is not showing — and would send a
     neighbour that follows the paper off to it. */
  const at = onPassage && walked && walked.file === file ? walked : null
  const there = useMemo(() => (at ? sectionAt(sections, at.file, at.from) : null), [at, sections])
  const sheet = useMemo<Sheet>(
    () =>
      at
        ? { page: shown.page, file: doc ? file : null, section: there ? { title: there.title, from: there.from, to: there.to } : null }
        : { page, file: doc ? file : null, section: here ? { title: here.title, from: here.from, to: here.to } : null },
    [page, doc, file, here, at, there, shown.page],
  )
  const highlighted = useMemo<Highlighted | null>(
    () => (!at && doc && to > from ? { file, srcStart: fromByte, srcEnd: toByte, text: toDisk(text.slice(from, to), eol) } : null),
    [at, doc, file, from, to, fromByte, toByte, text, eol],
  )

  /* What this page last said, which a reload would otherwise forget while the
     canvas goes on holding it: see `saidWas`. Read once, on mounting. */
  const [saidBefore] = useState(() => saidWas(standingIn(), paper.epic))
  const mine = useRef<string | null>(saidBefore)
  /* The last passage this page said, exactly — section span and all — and kept
     when somebody else's arrives, which `mine` is not. A host holds what each
     module said, and on a kehikko where the neighbour that walked this page is
     absent it hands back this page's own OLDER pointing. That is not somebody
     pointing: see where it is read. */
  const lastSaid = useRef<string | null>(null)
  const { point, pointed } = wire
  const publish = useCallback(
    (passage: WirePassage | null) => {
      mine.current = passage === null ? null : keyOf(passage)
      lastSaid.current = passage === null ? null : exactly(passage)
      rememberSaid(standingIn(), paper.epic, mine.current)
      point(passage)
    },
    [point, paper.epic],
  )
  usePublishedPassage(publish, paper, sheet, highlighted, pointed, adopted, again)

  /* Which FILES are on screen, beside the one place the passage names: the
     whole paper, or the picked parts' files — `filesShown` has the rule. Said
     when the answer changes and never otherwise: the list is held as a string,
     so the paper being re-read after every save, which rebuilds `paper.files`,
     says nothing. Each is a document with no page, range or quote, because a
     file being shown is not a place in it; the place is the passage's. And
     nothing at all once this paper is no longer on screen.

     Once it has held still for a moment, because a tick arrives one render
     ahead of the editor following it: for that render the open file is still
     the old one, which reads as a file kept open outside the new ticks, and
     said at once it would be a second broadcast to every container of a claim
     that was true for a frame. */
  const { show } = wire
  /* Every file a part of the epic owns, ticked or not: what is said first when the paper has more files than fit. */
  const owned = useMemo(() => ticked.parts.flatMap((part) => part.files ?? []), [ticked.parts])
  const shownFiles = filesShown(focus, paper.files, file, LIMITS.SHOWING_DOCUMENTS, owned).join('\n')
  useEffect(() => {
    const timer = setTimeout(() => {
      show(
        (shownFiles ? shownFiles.split('\n') : [])
          .map((one) => ({ path: join(paper.dir, one), page: null, section: null, from: null, to: null, quoted: '' }))
          .filter((one) => one.path.length <= LIMITS.PATH),
      )
    }, SHOWN_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [show, shownFiles, paper.dir])
  useEffect(() => () => show([]), [show])

  /* ---- What the canvas says to this page -------------------------------- */

  const walkedFor = useRef<string | null>(null)
  /* Read through a ref: a change of focus must not re-run the walk below. */
  const outsideRef = useRef(isOutside)
  outsideRef.current = isOutside
  useEffect(() => {
    const heard = received(paper, pointed, mine.current)
    /* This page's own pointing from BEFORE somebody walked it, handed back by a
       host that has nothing newer for this kehikko (the neighbour is not on
       it). Recognised by every field it was said with — a neighbour's section
       passage has no span, a note's has a range — and only without a range.
       It is not walked to: that would take the page back to where it was
       before the walk, mark its own old place as somebody else's and go quiet.
       It is answered instead: where this page is NOW is said, once. */
    const stale = !heard.own && pointed !== null && pointed.from === null && lastSaid.current !== null && exactly(pointed) === lastSaid.current
    const own = heard.own || stale
    const answer: typeof heard.answer = stale && heard.answer.at === 'here' ? { at: 'holding', file: heard.answer.file } : heard.answer
    if (stale) {
      mine.current = keyOf(pointed)
      sayAgain((n) => n + 1)
    }
    if (!own) mine.current = null
    if (answer.at !== 'here' || own) {
      /* Nothing to turn to — or it is this page's own selection coming back,
         which is already on screen as the selection. */
      walkedFor.current = null
      setForeign(null)
      setAdopted(false)
      /* A change being shown is not the canvas's passage, and the paper being
         re-read after it landed is no reason to stop showing it. */
      if (notedRef.current && answer.at !== 'elsewhere') return
      /* Its own passage coming back is this page having SAID the place it is
         showing — after a scroll, a key or a tick ended the quiet — and saying
         where it is does not move it: the mark comes down, the place stays
         (`walked`). Anything else is the canvas having let go or gone
         somewhere this page is not. A person who went somewhere of their own
         accord has already ended it, in `wandered`. */
      if (!own) setOnPassage(false)
      /* And the sentence about the last passage goes with it — the person
         selected something of their own, or the canvas let go — unless there
         is a new one to say. */
      notice(answer.at === 'elsewhere' ? answer.said : null)
      return
    }
    setForeign({ file: answer.file, from: answer.from, to: answer.to, quoted: pointed?.quoted ?? '' })
    /* Walk to it once per passage. The effect re-runs when the paper is
       re-read after a save, and the editor must not be dragged back then. */
    const stamp = `${paper.epic}\0${keyOf(pointed!)}`
    if (walkedFor.current !== stamp) {
      walkedFor.current = stamp
      go({ file: answer.file, bytes: { from: answer.from, to: answer.to }, foreign: true })
      /* Outside the picked parts is not a reason to refuse it — somebody
         pressed a note and means that passage — but it is a thing to say. */
      notice(outsideRef.current(answer.file) ? `${answer.said} ${outsidePassage(focusRef.current)}` : answer.said)
      setWalked({ file: answer.file, from: answer.from, to: answer.to })
      setOnPassage(true)
    }
    /* Everything this page does next is a consequence of that passage and is
       not news: quiet, until a person touches something. See `shouldPublish`. */
    setAdopted(true)
  }, [paper, pointed, go, notice])

  /* A gesture in this frame ends the quiet — and is a reason to SAY where this
     page is, once, when it has settled. It used to only lift the quiet, and a
     wheel or a key that moved no caret then changed nothing there was to say:
     the canvas went on holding the note's passage and this page went on
     drawing its mark, however far the person had scrolled from it. One
     message for the gesture that ends the quiet, not one per scroll: the
     listeners come off with `adopted`, and a gesture that also moves the
     caret restarts the same settle. */
  useEffect(() => {
    if (!adopted) return
    const woke = () => {
      setAdopted(false)
      sayAgain((n) => n + 1)
    }
    const kinds = ['pointerdown', 'wheel', 'keydown'] as const
    for (const kind of kinds) window.addEventListener(kind, woke, { passive: true, capture: true })
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, woke, { capture: true })
    }
  }, [adopted])

  /* `kehikot.goto` carries a ref — text — and no place. It is looked for in
     what the paper SAYS, block by block, and the editor goes to the first
     block that names it. */
  const { goto } = wire
  useEffect(() => {
    goto.current = (message, answer) => {
      if (message.epic && message.epic !== paper.epic) {
        answer(false, `This container is showing the paper for ${paper.epic}, not ${message.epic}.`)
        return
      }
      if (message.step !== undefined && !message.ref) {
        answer(false, 'A paper has sections rather than steps, so there is no step to walk to here.')
        return
      }
      const needle = (message.ref ?? '').trim().toLowerCase()
      if (!needle) {
        answer(false, 'That reference has no text to look for.')
        return
      }
      for (const block of paper.blocks) {
        if (!saysOf(block).toLowerCase().includes(needle)) continue
        go({ file: block.file, bytes: { from: block.srcStart, to: block.srcEnd }, focus: false })
        answer(true)
        setSaid(
          `${message.ref ?? 'That reference'} is named in this paper, in ${block.file}.`
            + (outsideRef.current(block.file) ? ` ${outsidePassage(focusRef.current)}` : ''),
        )
        return
      }
      answer(false, `This paper does not name ${message.ref ?? 'that'}.`)
    }
  }, [paper, goto, go, setSaid])

  /* ---- Source to PDF ---------------------------------------------------- */

  const [ownHeld, setOwnRects] = useState<AskedRects>(NO_RECTS)
  const ownRects = ownHeld.of === buildId ? ownHeld.rects : NO_RECTS.rects
  /* `part` says which PDF the mark to go to is on: the other one is not scrolled. */
  const [reveal, setReveal] = useState<{ nonce: number; part: boolean } | null>(null)
  const turnTo = useCallback(() => setReveal((was) => ({ nonce: (was?.nonce ?? 0) + 1, part: screen.current !== null })), [])
  /* Set by "Show in PDF": reveal even though only a caret is placed. */
  const wanted = useRef(false)
  const [asked, setAsked] = useState(0)

  const ask = useCallback(
    async (name: string, first: number, last: number, nearest = false): Promise<PageRect[]> => {
      const on = screen.current
      const body = await json('/api/sync', { epic: paper.epic, file: name, line: String(first), to: String(last), ...(on ? { part: on.key } : {}) })
      const found = body.found as { rects?: PageRect[]; exact?: boolean } | null | undefined
      /* An inexact answer is SyncTeX's nearest recorded line — a caret on a
         comment or in the preamble has none of its own. Drawing a box round a
         neighbour would be a confident highlight of the wrong thing, so it is
         only shown when a person asked to be taken there anyway. */
      if (!found?.rects || (found.exact === false && !nearest)) return []
      return found.rects
    },
    [paper.epic],
  )

  useEffect(() => {
    if (!buildId || !doc) {
      setOwnRects(NO_RECTS)
      return
    }
    let stopped = false
    const timer = setTimeout(() => {
      void ask(file, fromLine, toLine, wanted.current)
        .then((rects) => {
          if (stopped) return
          setOwnRects({ of: buildId, rects })
          /* A SELECTION is followed; a caret moving is not, or the page would
             slide under every arrow key. Nor is the selection this page put
             back itself: the PDF was put back too, to where IT was. */
          const now = spot.current
          const back = putBack.current
          const restored = back !== null && back.file === now.file && back.from === now.from && back.to === now.to
          if (rects.length && ((selecting && !restored) || wanted.current)) turnTo()
          wanted.current = false
        })
        .catch(() => {})
    }, settle)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [buildId, doc === null, file, fromLine, toLine, selecting, ask, settle, asked, turnTo])

  /* A place somebody else chose — a passage from the canvas, a change that
     landed — is put on the PDF by this PDF's table only once the PDF is OF
     the text it is in (`pdfIsOf`, which says what that takes). Until then the
     page on screen is an older build: the lines are counted in text it was
     not made from, its table answers for other words, and what it named was
     drawn — the wrong printed lines, for a dozen seconds, and then the right
     ones. So the table is not asked. The source's mark does not wait, and
     nothing says the PDF's is waiting.

     A passage from the canvas is still LOOKED FOR meanwhile, by its own words
     and nothing else (`marks`, below): where they are printed once in the PDF
     on screen, that is where they are, whatever the table would have said —
     and where they are not, nothing is drawn until the build that has them.

     Asked of the PDF ON SCREEN, which is one of two. A part's own PDF is of
     the text the part was last compiled from; the whole paper's is of the
     text of its last full build, and while somebody works in a part that is
     older on purpose. A passage outside the part calls the whole paper up
     (`called`): if that file changed since the full build, its table is not
     asked, the full build that `called` starts is waited for, and the mark is
     put by the table when it lands — this effect runs again on the new build
     with nothing pressed. */
  const behind = foreign !== null && !pdfIsOf(onPart ? partDrawn.pdf : build?.pdf, foreign.file, foreignDoc)
  const turns = theirs !== null || noted?.reveal === true
  /* The passage the PDF was last turned to without its table, so that going
     behind again under the same passage — a key typed — does not turn it again. */
  const turnedFor = useRef('')
  useEffect(() => {
    if (!buildId || !foreign || foreignText === undefined || !foreignDoc || behind) {
      setHint(NO_HINT)
      if (behind && buildId && theirs !== null && turnedFor.current !== foreignKey) {
        turnedFor.current = foreignKey
        turnTo()
      }
      if (!foreign) turnedFor.current = ''
      return
    }
    let stopped = false
    const first = lineAt(foreignText, indexAt(foreignText, foreign.from, foreignDoc.eol))
    const last = lineAt(foreignText, Math.max(indexAt(foreignText, foreign.to, foreignDoc.eol) - 1, 0))
    /* The disk first (`fresh`): a byte range somebody else chose is of the
       file as it is NOW, and the poll may not have told this page yet that it
       moved. If it did, the text has just been taken, this effect runs again
       behind, and nothing was asked of a table that is not this text's. */
    void fresh(foreign.file)
      .then((same) => (same && !stopped ? ask(foreign.file, first, Math.max(first, last), true) : null))
      .then((rects) => {
        if (stopped || !rects) return
        setHint({ of: foreignKey, build: buildId, rects })
        if (rects.length && turns) {
          turnedFor.current = foreignKey
          turnTo()
        }
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId, foreign?.file, foreign?.from, foreign?.to, foreignText === undefined, ask, fresh, behind, turns, turnTo])

  const marks = useMemo<PdfMark[]>(() => {
    const out: PdfMark[] = []
    /* The foreign mark first: `reveal` scrolls to the first mark, and what
       somebody pointed at outranks where the caret happens to be. */
    if (foreign && (foreignRects.length || (behind && theirs !== null))) {
      const whole = foreignText !== undefined && foreignDoc
        ? wholeWords(foreignText, indexAt(foreignText, foreign.from, foreignDoc.eol), indexAt(foreignText, foreign.to, foreignDoc.eol))
        : null
      const source = whole && foreignText !== undefined ? { text: foreignText, ...whole } : null
      /* With no rectangles — the PDF is not of this text, so its table was
         not asked — a mark is its words alone: `find.ts` draws them where
         they are printed once, and draws nothing otherwise. Without words to
         look for there is then no mark to make. */
      if (foreignRects.length || source) out.push({ rects: foreignRects, source, foreign: true })
    }
    /* With only a caret, the passage is the line it is on: what that line prints is what is marked. */
    if (ownRects.length) {
      const start = startOfLine(text, fromLine)
      out.push({ rects: ownRects, source: selecting ? { text, from, to } : { text, from: start, to: start + textOfLine(text, fromLine).length } })
    }
    return out
  }, [foreign, foreignRects, foreignText, foreignDoc, behind, theirs, ownRects, selecting, text, from, to, fromLine])

  /* The pages drawn under a focus: the picked parts' own, and — flagged —
     any a mark is on, so that nothing this page points at is ever on a sheet
     that is not there. Null when nothing is picked: every page, as always. */
  const sheets = useMemo(() => {
    /* Called onto the screen for a mark outside the part: the whole paper, whole. */
    if (!focus || focus.pages === null || called) return null
    return pagesShown(focus, marks.flatMap((mark) => mark.rects.map((rect) => rect.page)))
  }, [focus, marks, called])
  /* The same for the part's own PDF, in ITS sheets: the ones its files
     printed — its title page and bibliography are `main.tex`'s, and are left
     out as they are from the whole paper — and what page of the paper each
     sheet is, for everything said about one. */
  const partSheets = useMemo(() => {
    if (!onPart || !focus || partDrawn.pdf.pages === null) return null
    return pagesShown({ ...focus, pages: sheetsOf(partDrawn.covered, partDrawn.pdf.map) }, marks.flatMap((mark) => mark.rects.map((rect) => rect.page)))
  }, [onPart, partDrawn, focus, marks])
  const partNumbers = useMemo(
    () => (partDrawn && partDrawn.pdf.pages !== null && map ? pagesOfSheets(partDrawn.pdf.pages, partDrawn.pdf.map, map, partDrawn.covered) : null),
    [partDrawn, map],
  )

  const showInPdf = () => {
    setTab('pdf')
    if (!build?.pdf) {
      setSaid('There is no compiled PDF yet to show this in.')
      return
    }
    /* In a file the part's own PDF has no page for: the whole paper is called for. */
    if (plan !== null && !covered.includes(file)) setShownOutside(true)
    /* Asked again rather than reusing what is drawn: a caret on a line with
       no record of its own draws nothing until somebody asks for the nearest. */
    wanted.current = true
    setAsked((n) => n + 1)
  }

  /* ---- PDF to source ---------------------------------------------------- */

  const onPoint = useCallback(
    (at: { page: number; x: number; y: number; word: string | null }) => {
      /* `at.page` is a sheet of the PDF that was pressed, and that PDF is the one asked. */
      const on = screen.current
      void json('/api/sync', { epic: paper.epic, page: String(at.page), x: at.x.toFixed(2), y: at.y.toFixed(2), ...(on ? { part: on.key } : {}) })
        .then((body) => {
          const found = body.found as { file?: string; line?: number } | null | undefined
          if (!found?.file || !found.line) {
            setSaid('Nothing in this paper’s own files is recorded at that spot — it was set by the class or a package.')
            return
          }
          wandered()
          /* The tab is left where it is. The press selects the word in the
             source, and that selection is what is marked on the page that was
             pressed: turning to the Source tab here took the person away from
             the very thing they had just marked. A double press is how the
             source is asked for — see `onOpen`. */
          go({ file: found.file, line: found.line, word: at.word, select: true, focus: true })
        })
        .catch(() => {})
    },
    [paper.epic, go, setSaid, wandered],
  )

  /* ---- The engine's complaints ------------------------------------------ */

  /* The run whose words are on screen: the part's own while parts are compiled alone, the whole paper's otherwise. */
  const ran = (pickedKey !== null ? own?.last : null) ?? build?.last ?? null
  const problems = ran?.problems ?? NONE
  const inThisFile = useMemo(
    () =>
      problems
        /* Only a complaint that NAMES this file. One with a line and no file —
           a classic `l.12`, a warning out of the log — is listed with its line
           and not drawn here, since which file's line 12 is exactly what it
           did not say. */
        .filter((one): one is Problem & { line: number } => one.line !== null && one.file === file)
        .map((one) => ({ line: one.line, severity: one.severity, message: one.message })),
    [problems, file],
  )
  const failed = ran ? !ran.ok : false
  const errors = problems.filter((one) => one.severity === 'error')
  const warnings = problems.filter((one) => one.severity === 'warning')
  const [showLog, setShowLog] = useState(false)

  /* Of the PDF on screen. A part's own is of its own files and `main.tex`: another chapter edited since is not in it to be behind. */
  const stale = onPart ? [MAIN_FILE, ...partDrawn.covered].some((one) => partDrawn.pdf.hashes[one] !== paper.hashes[one]) : wholeStale
  const pdfUrl = build?.pdf ? apiUrl('/api/pdf', { epic: paper.epic, build: build.pdf.id }) : null
  const partUrl = partDrawn ? apiUrl('/api/pdf', { epic: paper.epic, part: partDrawn.key, build: partDrawn.pdf.id }) : null
  /* A pick that cannot be compiled on its own draws no page — `cannot` is said instead — until a mark calls the whole paper. */
  const silent = cannot !== null && !called
  /* On opening with a part picked, nothing is drawn until the server has said
     whether that part has a PDF of its own: the whole paper flashing up for a
     moment first is the reload this page is otherwise careful not to show. */
  const drew = useRef(false)
  const awaited = pickedKey !== null && heard === null && partDrawn === null && !drew.current
  const wholeShown = pdfUrl !== null && !onPart && !silent && !awaited
  useEffect(() => {
    if (wholeShown || onPart) drew.current = true
  }, [wholeShown, onPart])
  const partKind = partDrawn?.kind ?? null
  const partFrom = useMemo(
    () => (partKind === null ? 0 : (pdfWas(standingIn(), paper.epic, partKind)?.top ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paper.epic, partKind],
  )
  const onPartScrolled = useCallback(
    (top: number, kind?: string) => {
      if (kind) rememberPdf(standingIn(), paper.epic, { top, ticks: ticksRef.current }, kind)
    },
    [paper.epic],
  )
  const calledNow = useRef(called)
  calledNow.current = called

  /* ---- Suggestions, and the Auto tick ----------------------------------- */

  const { proposals, answerOne, acceptAll, busy } = wire
  const settingKey = autoApproveKey(standingIn(), paper.epic)
  const [auto, setAuto] = useState(false)
  useLayoutEffect(() => setAuto(autoApproveWas(settingKey)), [settingKey])
  const changeAuto = useCallback(
    (on: boolean) => {
      setAuto(on)
      rememberAutoApprove(settingKey, on)
    },
    [settingKey],
  )
  /* Auto accepts what ARRIVES while it is on. What was already waiting when it
     was ticked is left for a person: ticking a box is not reading a diff. */
  const seen = useRef<Set<string>>(new Set())
  const applying = useRef(false)
  const wasAuto = useRef(false)
  useLayoutEffect(() => {
    if (auto && !wasAuto.current) seen.current = new Set(proposals.map((p) => p.id))
    wasAuto.current = auto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto])
  useEffect(() => {
    if (!auto) {
      seen.current = new Set()
      return
    }
    if (applying.current) return
    const fresh = proposals.filter((p) => !seen.current.has(p.id))
    if (!fresh.length) return
    applying.current = true
    void (async () => {
      try {
        for (const one of fresh) {
          seen.current.add(one.id)
          await answerOne(one.id, 'accept')
        }
      } finally {
        applying.current = false
      }
    })()
  }, [auto, proposals, answerOne])

  /**
   * Draw attention to a change: mark it, and take the EDITOR to it unless the person is typing.
   *
   * The tab is never changed. With the PDF in front the change is marked on
   * the page and the Source tab says how many suggestions are waiting; with
   * the source in front the editor is scrolled to it and the selection is left
   * alone. A person in the middle of a sentence is not scrolled away from it:
   * the mark is made, the line at the bottom says so, and the editor stays.
   *
   * The PDF is not scrolled at all, unless `at.reveal` — see `noted`. Pressing
   * a suggestion's file name is how its place on the page is asked for.
   */
  const editorBox = useRef<HTMLDivElement>(null)
  const attend = useCallback(
    (at: { file: string; from: number; to: number; proposal?: string; reveal?: boolean }, words: string) => {
      setNoted(at)
      const typing = editorBox.current !== null && editorBox.current.contains(document.activeElement)
      if (typing) {
        notice(words)
        return
      }
      go({ file: at.file, bytes: { from: at.from, to: at.to }, foreign: true })
      setWalked(null)
      setOnPassage(true)
      notice(outsideRef.current(at.file) ? `${words} ${outsidePassage(focusRef.current)}` : words)
    },
    [go, notice],
  )

  /* A suggestion that ARRIVES is shown. Those already waiting when the paper
     was opened are not: nobody asked to be taken anywhere by opening it. And
     under Auto nothing waits — it is accepted, and what lands is shown. */
  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    /* Until the list has been heard once, what is in it is not an arrival. */
    if (!wire.proposalsHeard) return
    const was = known.current
    known.current = new Set(proposals.map((one) => one.id))
    const waiting = notedRef.current?.proposal
    if (waiting && !known.current.has(waiting)) setNoted((now) => (now?.proposal === waiting ? null : now))
    if (was === null || auto) return
    const fresh = proposals.filter((one) => !was.has(one.id))
    const first = fresh[0]
    if (!first) return
    attend(
      { file: first.file, from: first.from, to: first.to, proposal: first.id },
      `${fresh.length === 1 ? 'A change was suggested' : `${fresh.length} changes were suggested`} in ${first.file}. `
        + 'What it would replace is marked; accept or reject it above the source.',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposals, wire.proposalsHeard])
  /* Another paper: what was waiting in the last one is not news in this one. */
  useLayoutEffect(() => {
    known.current = null
    setNoted(null)
  }, [paper.epic])

  /* Text that landed from the disk — a suggestion accepted, another editor's
     save — is shown too: where it changed, marked, and on the PDF once the
     compile that follows has caught up. */
  const landedChange = source.changed
  /* Set by a press on Accept: what lands next was asked for, and the PDF may turn to it. */
  const accepted = useRef(false)
  useEffect(() => {
    if (!landedChange) return
    const held = source.docs.get(landedChange.file)
    if (!held) return
    const reveal = accepted.current
    accepted.current = false
    attend(
      { file: landedChange.file, from: byteAt(held.text, landedChange.from, held.eol), to: byteAt(held.text, landedChange.to, held.eol), reveal },
      `${landedChange.file} changed on disk. What changed is marked.`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landedChange?.n])

  const showProposal = useCallback(
    (proposal: Proposal) => {
      wandered()
      go({ file: proposal.file, bytes: { from: proposal.from, to: proposal.to }, select: true, focus: true })
      setTab('source')
    },
    [go, wandered],
  )

  /* The files offered: all of them, or under a focus the picked parts' own —
     and the one that is open, whatever it is, because it is open. */
  const listed = useMemo(
    () => (focus ? paper.files.filter((one) => one === file || !isOutside(one)) : paper.files),
    [focus, paper.files, file, isOutside],
  )
  /* The files to switch among: the picked parts' own, and nothing when
     nothing is picked. One file is not a switch. See `tabsOf`. */
  const tabs = useMemo(() => tabsOf(focus, file), [focus, file])
  /* The section list, file by file, limited to what is shown. */
  const jumps = useMemo(() => jumpsOf(listed, sections), [listed, sections])
  /* The way back, drawn only where it is the way back: nothing is picked, and
     a press on the PDF or a section has taken the editor into another file. */
  const awayFromMain = focus === null && file !== MAIN_FILE && paper.files.includes(MAIN_FILE)

  const saved =
    source.state === 'saving' ? 'Saving…' : source.state === 'dirty' ? 'Unsaved' : source.state === 'failed' ? 'Not saved' : 'Saved'
  const engineSays = !build
    ? ''
    : !build.engine
      ? 'No engine'
      : compiling || build.running
        ? 'Compiling…'
        : ran
          ? `${ran.ok ? 'Compiled' : 'Failed'} · ${(ran.ms / 1000).toFixed(1)} s`
          : build.engine

  return (
    <div className="workspace flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b px-1 pb-1 text-[0.72rem]">
        {/* The picked parts' files, as tabs — and only under a focus with more
            than one file to be on. Not a list of the paper's files: what is in
            this row is decided by the ticks in the host's bar, and this only
            moves between them. It scrolls sideways rather than wrapping, so
            seven chapters in a 300-pixel container are one row and not five. */}
        {tabs.length > 1 && (
          <div role="tablist" aria-label="Files of the picked parts" className="flex max-w-full min-w-0 flex-[1_1_100%] gap-1 overflow-x-auto" data-files>
            {tabs.map((one) => (
              <Button
                key={one.file}
                role="tab"
                aria-selected={one.file === file}
                variant={one.file === file ? 'outline' : 'ghost'}
                size="container"
                className={cn('shrink-0 font-mono', one.outside && 'italic')}
                title={one.outside ? `${one.file} — outside ${outsideSaid}, and open` : one.file}
                data-file={one.file}
                onClick={() => {
                  if (one.file === file) return
                  wandered()
                  source.open(one.file)
                }}
              >
                {one.outside ? `${one.label} — outside` : one.label}
              </Button>
            ))}
          </div>
        )}
        {(sections.length > 0 || listed.length > 1) && (
          <select
            className="border-input bg-background w-0 max-w-[12rem] min-w-0 flex-1 basis-[5.5rem] rounded border px-1 py-0.5"
            value=""
            onChange={(event) => {
              const value = event.target.value
              /* "f:<file>" is the top of a file that has no heading to jump to. */
              const top = value.startsWith('f:') ? value.slice(2) : null
              const picked = top === null ? sections[Number(value)] : null
              if (top !== null && listed.includes(top)) {
                wandered()
                go({ file: top, bytes: { from: 0, to: 0 }, focus: true })
                setTab('source')
              } else if (picked) {
                wandered()
                go({ file: picked.file, bytes: { from: picked.at, to: picked.at }, focus: true })
                setTab('source')
              }
            }}
            aria-label="Sections"
          >
            <option value="">{shown.section ?? 'Sections'}</option>
            {jumps.map((group) => (
              <optgroup key={group.file} label={focus && isOutside(group.file) ? `${group.file} — outside the focus` : group.file}>
                {group.sections.length === 0 ? (
                  <option value={`f:${group.file}`}>(no headings) top of the file</option>
                ) : (
                  /* By its place in the WHOLE list, which is what the handler
                     above reads, so leaving some out renumbers nothing. */
                  group.sections.map(({ index, section }) => (
                    <option key={index} value={index}>
                      {`${'  '.repeat(Math.max(0, section.level - 1))}${section.title}`}
                    </option>
                  ))
                )}
              </optgroup>
            ))}
          </select>
        )}
        <span className="flex-1" />
        <span
          className={cn('text-muted-foreground', failed && 'text-(--gone)')}
          data-build={compiling ? 'running' : failed ? 'failed' : ran ? 'ok' : 'idle'}
          /* Said here and not in a row of its own: it is a fact about the run, like the seconds beside it. */
          title={ran?.confined === false ? NOT_CONFINED : undefined}
          data-confined={ran?.confined === undefined ? undefined : String(ran.confined)}
        >
          {engineSays}
          {shown.page !== null && build?.pdf?.pages ? ` · p. ${shown.page}/${build.pdf.pages}` : ''}
        </span>
        {build?.engine && (
          <Button
            variant="outline"
            size="container"
            disabled={compiling}
            /* Asked for by hand: the whole paper, and then the picked part from it. */
            onClick={() => void source.flush().then(() => (pickedKey !== null ? compilePart(pickedKey.split('\n'), { force: true }) : compile()))}
          >
            Compile
          </Button>
        )}
        <Button variant="ghost" size="container" onClick={showInPdf} title="Show the caret’s line in the PDF">
          Show in PDF
        </Button>
        {wire.saving.at === 'ready' && (
          <Button variant="ghost" size="container" disabled={busy} onClick={() => void source.flush().then(() => wire.save())} title="Commit this paper to its repository">
            Commit
          </Button>
        )}
      </header>

      {source.conflict && (
        <div role="alert" className="bg-muted/60 flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1 text-[0.72rem]">
          <span className="min-w-0 flex-1">
            {source.conflict.file} changed on disk while you were editing it. Nothing was written. Which one stays?
          </span>
          <Button variant="outline" size="container" onClick={source.takeTheirs}>
            Take the disk’s
          </Button>
          <Button variant="ghost" size="container" onClick={source.keepMine}>
            Keep mine
          </Button>
        </div>
      )}
      {source.failure && !source.conflict && (
        <p role="alert" className="shrink-0 border-b px-2 py-1 text-[0.72rem] text-(--gone)">
          {source.failure}
        </p>
      )}

      <div role="tablist" className="flex shrink-0 gap-1 border-b px-1 py-1 @min-[720px]:hidden">
        {(['source', 'pdf'] as const).map((one) => (
          <Button key={one} role="tab" aria-selected={tab === one} variant={tab === one ? 'outline' : 'ghost'} size="container" onClick={() => setTab(one)}>
            {one === 'source' ? (tab === 'pdf' && proposals.length ? `Source · ${proposals.length}` : 'Source') : failed ? 'PDF ·!' : 'PDF'}
          </Button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cn('min-h-0 min-w-0 flex-1 flex-col @min-[720px]:flex @min-[720px]:border-r', tab === 'source' ? 'flex' : 'hidden')}>
          {/* Which file this is, directly over its text: what an edit below is
              saved to, and whether it has been. The only place the open file
              is named, now that no dropdown names it — and the editor changes
              file when a tick in the host's bar does, so it has to be here. */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-2 py-0.5 text-[0.72rem] leading-snug" data-editing={file}>
            {awayFromMain && (
              <Button
                variant="outline"
                size="container"
                aria-label={`Back to ${MAIN_FILE}`}
                title={`Back to ${MAIN_FILE}, the file the whole paper starts from`}
                onClick={() => {
                  wandered()
                  source.open(MAIN_FILE)
                }}
              >
                ← {MAIN_FILE}
              </Button>
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="text-muted-foreground">Editing </span>
              <code className="text-foreground font-mono font-medium">{file}</code>
            </span>
            <span className={cn('text-muted-foreground', source.state === 'failed' && 'text-(--gone)')} aria-live="polite" data-save={source.state}>
              {saved}
            </span>
          </div>
          <ProposalsPanel
            proposals={proposals}
            busy={busy}
            auto={auto}
            onAuto={changeAuto}
            onDecide={(id, decision) => {
              if (decision === 'accept') accepted.current = true
              void answerOne(id, decision)
            }}
            onAcceptAll={() => {
              accepted.current = true
              void acceptAll()
            }}
            onShow={showProposal}
          />
          <div ref={editorBox} className="min-h-0 flex-1">
            {doc ? (
              <EditorPane
                key={`${paper.epic}\0${file}`}
                value={doc.text}
                onChange={source.edit}
                onSelect={onSelect}
                onScrolled={onEditorScrolled}
                onSave={() => void source.flush()}
                jump={jump}
                mark={
                  foreign && foreign.file === file
                    ? { from: indexAt(doc.text, foreign.from, doc.eol), to: indexAt(doc.text, foreign.to, doc.eol) }
                    : null
                }
                problems={inThisFile}
                theme={theme}
              />
            ) : (
              <p className="text-muted-foreground p-3 text-xs">Opening {file}…</p>
            )}
          </div>
        </div>

        <div className={cn('min-h-0 min-w-0 flex-1 flex-col @min-[720px]:flex', tab === 'pdf' ? 'flex' : 'hidden')}>
          {(errors.length > 0 || (showLog && ran)) && (
            <section className="problems max-h-[40%] shrink-0 overflow-auto border-b text-[0.72rem]" aria-label="Compile errors">
              {failed && (
                <p className="px-2 pt-1 font-medium text-(--gone)">
                  {ran?.engine} did not produce a PDF{(onPart ? partDrawn.pdf : build?.pdf) ? '. The one below is the last that compiled.' : '.'}
                </p>
              )}
              <ul>
                {[...errors, ...(showLog ? warnings : [])].map((one, i) => (
                  <li key={i} className="border-b px-2 py-1 last:border-b-0">
                    {one.file && one.line !== null ? (
                      <button
                        type="button"
                        className="mr-1.5 font-mono underline underline-offset-2"
                        data-problem={`${one.file}:${one.line}`}
                        onClick={() => {
                          wandered()
                          go({ file: one.file!, line: one.line!, focus: true })
                          setTab('source')
                        }}
                      >
                        {one.file}:{one.line}
                      </button>
                    ) : one.line !== null ? (
                      <span className="text-muted-foreground mr-1.5 font-mono">line {one.line}</span>
                    ) : null}
                    <span className={one.severity === 'error' ? '' : 'text-muted-foreground'}>{one.message}</span>
                  </li>
                ))}
              </ul>
              {showLog && ran?.tail && (
                <pre className="text-muted-foreground border-t px-2 py-1 font-mono text-[0.65rem] whitespace-pre-wrap">{ran.tail}</pre>
              )}
            </section>
          )}
          {build && (
            /* A compiler that has just arrived is found by asking again, and
               the effect above then compiles — asked even when the install
               stopped short, since it may have got as far as the compiler. A
               biber that has just arrived is a reason to compile at once. */
            <CompilerOffer build={build} onInstalled={(what, complete) => void (what === 'compiler' ? refresh() : complete ? compile() : undefined)} />
          )}
          {/* The one thing said about a focus, and only when it has left this pane empty: `emptySaid`. */}
          {wholeShown && sheets && sheets.pages.length === 0 && focus && emptySaid(focus) && (
            <p className="text-muted-foreground shrink-0 px-2 py-2 text-xs leading-relaxed" role="status" data-no-pages>
              {emptySaid(focus)}
            </p>
          )}
          {onPart && partSheets && partSheets.pages.length === 0 && focus && (
            <p className="text-muted-foreground shrink-0 px-2 py-2 text-xs leading-relaxed" role="status" data-no-pages>
              {emptySaid({ ...focus, pages: [] })}
            </p>
          )}
          {/* And the one sentence for a pick that cannot be compiled on its own, where its pages would have been. */}
          {silent && (
            <p className="text-muted-foreground shrink-0 px-2 py-2 text-xs leading-relaxed" role="status" data-no-pages data-cannot>
              {cannot}
            </p>
          )}
          <div className="relative min-h-0 flex-1">
            {/* Two panes, one in front. Each keeps its own document and its own
                place in it, so going from the part's PDF to the whole paper
                and back is neither a load nor a lost scroll; the one behind
                has no layout, draws nothing and is handed no marks. */}
            {partUrl && partDrawn && (
              <div className={cn('h-full', !onPart && 'hidden')} data-pdf="part">
                <PreviewPane
                  url={partUrl}
                  kind={partDrawn.kind}
                  marks={onPart ? marks : NO_MARKS}
                  reveal={reveal?.part ? reveal : null}
                  onPoint={onPoint}
                  onOpen={() => setTab('source')}
                  from={partFrom}
                  onScrolled={onPartScrolled}
                  numbers={partNumbers}
                  total={build?.pdf?.pages ?? null}
                  {...(partSheets ? { pages: partSheets.pages, outside: partSheets.outside, outsideOf: outsideSaid } : {})}
                />
              </div>
            )}
            {pdfUrl ? (
              <div className={cn('h-full', !wholeShown && 'hidden')} data-pdf="whole">
                <PreviewPane
                  url={pdfUrl}
                  marks={wholeShown ? marks : NO_MARKS}
                  reveal={reveal && !reveal.part ? reveal : null}
                  onPoint={onPoint}
                  onOpen={() => setTab('source')}
                  from={pdfFrom}
                  onScrolled={onPdfScrolled}
                  {...(sheets ? { pages: sheets.pages, outside: sheets.outside, outsideOf: outsideSaid } : {})}
                />
              </div>
            ) : (
              build?.engine && (
                <p className="text-muted-foreground p-3 text-xs">
                  {compiling ? `Compiling with ${build.engine}…` : failed ? 'No PDF yet: the first compile failed. The errors are above.' : 'No PDF yet.'}
                </p>
              )
            )}
          </div>
          {ran && (
            <footer className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-2 border-t px-2 py-0.5 text-[0.68rem]">
              {stale && !compiling && <span>The PDF is of an earlier save.</span>}
              <span className="flex-1" />
              <button type="button" className="underline underline-offset-2" onClick={() => setShowLog((on) => !on)}>
                {showLog ? 'Hide the log' : warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'} · log` : 'Log'}
              </button>
            </footer>
          )}
        </div>
      </div>
    </div>
  )
}

const NONE: readonly Problem[] = []
const NO_FILES: string[] = []
const NO_MARKS: readonly PdfMark[] = []

/** What SyncTeX answered, and which build's PDF it answered about. */
interface AskedRects {
  of: string | null
  rects: PageRect[]
}
const NO_RECTS: AskedRects = { of: null, rects: [] }

/** How long a pick has to hold still before its files are compiled on their own: several ticks in a row are one selection. */
const PICK_SETTLE_MS = 250

/** A part's own PDF as it is drawn: which selection (`kind`, what `\includeonly` was given), where it is asked for (`key`), and the files it is of. */
interface DrawnPart {
  kind: string
  key: string
  pdf: NonNullable<PartStatus['pdf']>
  covered: string[]
}

/** How long the list of files on screen has to hold still before it is said. See where it is used. */
const SHOWN_SETTLE_MS = 60

/** One passage with every field it was said with: `keyOf` and the section's span. */
function exactly(passage: WirePassage): string {
  return `${keyOf(passage)}\0${passage.section?.from ?? ''}\0${passage.section?.to ?? ''}`
}

/** Added to what is said about a place this page was sent to, when no picked part owns the file it is in. */
function outsidePassage(focus: Narrowed | null): string {
  return `It is outside the picked part${focus?.parts.length === 1 ? '' : 's'}, and is shown anyway.`
}

/**
 * The page and section the toolbar reads out.
 *
 * `caret` is where the person's caret is. `passage` is the passage this page
 * was pointed at and is still showing, or null when there is none or the
 * person has since gone somewhere else. While there is one it wins outright —
 * its section even when that is "none", since naming the caret's section over
 * somebody else's passage is the wrong answer this exists to stop.
 *
 * Its page is the one its mark is drawn on (`marked`, from SyncTeX), then the
 * one the page map gives its first line (`mapped`) while SyncTeX has not
 * answered, and null — nothing shown — rather than the caret's page when
 * neither is known.
 */
export function placeShown(
  caret: { page: number | null; section: string | null },
  passage: { section: string | null; marked: number | null; mapped: number | null } | null,
): { page: number | null; section: string | null } {
  if (!passage) return caret
  return { page: passage.marked ?? passage.mapped, section: passage.section }
}

/** What the table answered about a pointed passage: which passage (`of`), and which build's PDF the rectangles are sheets of. */
interface Hint {
  of: string
  build: string | null
  rects: PageRect[]
}
/** No rectangles, of no passage. One object, so a mark with none is the same mark again. */
const NO_HINT: Hint = { of: '', build: null, rects: [] }

function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/** What a block says, for `kehikot.goto` to look a reference up in. */
function saysOf(block: Paper['blocks'][number]): string {
  if (block.kind === 'heading' || block.kind === 'paragraph') return plainText(block.segments)
  if (block.kind === 'list') return block.items.map(plainText).join(' ')
  if (block.kind === 'figure' || block.kind === 'table') return plainText(block.caption)
  if (block.kind === 'comment') return block.text
  if (block.kind === 'verbatim' || block.kind === 'unknown') return block.raw
  if (block.kind === 'equation') return block.latex
  return ''
}
