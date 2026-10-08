import type { EpicPart, Passage as WirePassage } from 'kehikot-module-protocol'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'

import type { Problem } from '../compile/log.ts'
import { pageOfLine, type PageRect } from '../compile/synctex.ts'
import { plainText } from '../latex/parse.ts'
import type { Proposal } from '../latex/propose.ts'
import type { Paper } from '../store.ts'
import { apiUrl, json, standingIn } from './api.ts'
import type { Editor } from './editor/source-editor.tsx'
import { headline, inFocus, narrowed, notesOf, pagesShown, type Narrowed } from './focus.ts'
import { byteAt, indexAt, lineAt, startOfLine, textOfLine, toDisk } from './lib/offsets.ts'
import { sectionAt, sectionsOf } from './lib/sections.ts'
import type { PdfMark, Preview } from './pdf/pdf-view.tsx'
import { placeWord } from './pdf/words.ts'
import { keyOf, received } from './pointed.ts'
import { ProposalsPanel } from './proposals-panel.tsx'
import { autoApproveKey, autoApproveWas, rememberAutoApprove } from './remembered.ts'
import { useBuild } from './use-build.ts'
import type { usePaper } from './use-paper.ts'
import { usePublishedPassage, type Highlighted, type Sheet } from './use-published-passage.ts'
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
 * screen shows only what those parts own: their files in the file list, the
 * sections of those files, and the pages those files printed. `src/focus.ts`
 * has the rule and the arithmetic; three decisions are this screen's.
 *
 * **The file somebody has open is never taken away.** Picking a part while
 * `main.tex` is open — and `main.tex` is in no part, as a rule — would
 * otherwise swap the editor's file under a person who may be mid-sentence,
 * with a save pending. So the open file stays open, stays editable and is
 * saved as it always is; it is listed, marked as outside the focus, and a
 * line above the editor says so and offers the first file that IS in the
 * focus. It leaves the list when the person leaves it. The one time this
 * screen chooses a file for a focus is when a paper is OPENED under one:
 * nothing is being edited yet, and starting on a file that is outside what
 * was asked for would be the wrong first sight.
 *
 * **A pointer from elsewhere still arrives.** A note, a question or a slide
 * may point at a passage in a file no picked part owns. It is opened and
 * marked exactly as before, the sentence about it says it is outside the
 * picked parts, and the page it printed on is drawn, labelled as outside, for
 * as long as the mark is there. The same goes for a press on a shared sheet
 * that lands in a file outside the focus.
 *
 * **There is no "show everything" here.** The line above the paper says where
 * the focus is set, and that is where it is lifted. A second switch on this
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
  const { build, compiling, compile } = useBuild(paper.epic)
  const { setPaper, setProposals, setSaid } = wire

  const onLanded = useCallback(
    (landed: Landed) => {
      if (landed.paper) setPaper(landed.paper)
      if (Array.isArray(landed.proposals)) setProposals(landed.proposals)
      if (landed.said) setSaid(landed.said)
      /* The save reached the disk, so the PDF on screen is now of older text. */
      void compile()
    },
    [compile, setPaper, setProposals, setSaid],
  )
  const source = useSource({ paper, disk: wire.disk, onLanded, saveDelay })
  const { file, doc } = source

  /* ---- The parts the canvas is pointed at ------------------------------- */

  const parts = wire.parts ?? NO_PARTS
  const pdf = build?.pdf ?? null
  const focus = useMemo(
    () => narrowed(parts, paper, pdf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts, paper.epic, paper.files, pdf?.id],
  )
  const focusRef = useRef(focus)
  focusRef.current = focus
  /** Whether a file is outside what is picked. Never, when nothing is. */
  const isOutside = useCallback((name: string) => !inFocus(parts, paper, name), [parts, paper])
  const outsideSaid = focus ? `the picked part${focus.parts.length === 1 ? '' : 's'}` : ''

  /* A paper OPENED under a focus starts on a file that is in it. Once per
     paper, and only then: after this the open file is the person's, and a
     change of focus never moves it. Declared straight after `useSource` so
     that it runs after that hook's own "a new paper starts on main.tex". */
  const startedFor = useRef<string | null>(null)
  useEffect(() => {
    if (startedFor.current === paper.epic) return
    startedFor.current = paper.epic
    const first = focusRef.current?.files[0]
    if (first && !focusRef.current!.files.includes('main.tex')) source.open(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.epic])

  /* A suggestion is accepted against the file ON DISK. So the editor saves
     first, and the accept then splices into the text the person is looking at. */
  wire.before.current = source.flush

  /* The disk's text replaced the editor's — another editor saved, a suggestion
     was accepted. The PDF follows that too. */
  const taken = source.taken
  useEffect(() => {
    if (taken > 0) void compile()
  }, [taken, compile])

  /* On opening: compile when there is an engine and no PDF of THIS text. Once
     per text, so a paper that does not compile is not retried in a loop. */
  const tried = useRef('')
  useEffect(() => {
    if (!build || !build.engine || compiling) return
    const stamp = `${paper.epic}\0${Object.entries(paper.hashes).sort().join('|')}`
    if (tried.current === stamp) return
    const fresh = build.pdf !== null && sameHashes(build.pdf.hashes, paper.hashes)
    tried.current = stamp
    if (!fresh) void compile()
  }, [build, compiling, compile, paper.epic, paper.hashes])

  const [tab, setTab] = useState<'source' | 'pdf'>('source')
  const tabRef = useRef(tab)
  tabRef.current = tab
  const unseen = useRef(false)
  const [selection, setSelection] = useState({ from: 0, to: 0 })
  const [jump, setJump] = useState<{ from: number; to: number; nonce: number; select?: boolean; focus?: boolean; keep?: boolean } | null>(null)
  const [going, setGoing] = useState<Going | null>(null)
  /** Somebody else's anchor, in bytes of a file of this paper. */
  const [foreign, setForeign] = useState<{ file: string; from: number; to: number; quoted: string } | null>(null)
  const [adopted, setAdopted] = useState(false)
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
    setJump((was) => ({ from, to, nonce: (was?.nonce ?? 0) + 1, select: going.select && to > from, focus: going.focus, keep: going.foreign }))
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
  const page = useMemo(() => (map ? pageOfLine(map, file, fromLine) : null), [map, file, fromLine])

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

  /* ---- What this page says to the canvas -------------------------------- */

  const sheet = useMemo<Sheet>(
    () => ({ page, file: doc ? file : null, section: here ? { title: here.title, from: here.from, to: here.to } : null }),
    [page, doc, file, here],
  )
  const highlighted = useMemo<Highlighted | null>(
    () => (doc && to > from ? { file, srcStart: fromByte, srcEnd: toByte, text: toDisk(text.slice(from, to), eol) } : null),
    [doc, file, from, to, fromByte, toByte, text, eol],
  )

  const mine = useRef<string | null>(null)
  const { point, pointed } = wire
  const publish = useCallback(
    (passage: WirePassage | null) => {
      mine.current = passage === null ? null : keyOf(passage)
      point(passage)
    },
    [point],
  )
  usePublishedPassage(publish, paper, sheet, highlighted, pointed, adopted)

  /* ---- What the canvas says to this page -------------------------------- */

  const walkedFor = useRef<string | null>(null)
  /* Read through a ref: a change of focus must not re-run the walk below. */
  const outsideRef = useRef(isOutside)
  outsideRef.current = isOutside
  useEffect(() => {
    const { own, answer } = received(paper, pointed, mine.current)
    if (!own) mine.current = null
    if (answer.at !== 'here' || own) {
      /* Nothing to turn to — or it is this page's own selection coming back,
         which is already on screen as the selection. */
      walkedFor.current = null
      setForeign(null)
      setAdopted(false)
      setOnPassage(false)
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
      setOnPassage(true)
    }
    /* Everything this page does next is a consequence of that passage and is
       not news: quiet, until a person touches something. See `shouldPublish`. */
    setAdopted(true)
  }, [paper, pointed, go, notice])

  useEffect(() => {
    if (!adopted) return
    const woke = () => setAdopted(false)
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

  const buildId = build?.pdf?.id ?? null
  const [ownRects, setOwnRects] = useState<PageRect[]>([])
  const [foreignRects, setForeignRects] = useState<PageRect[]>([])
  const [reveal, setReveal] = useState<{ nonce: number } | null>(null)
  /* Set by "Show in PDF": reveal even though only a caret is placed. */
  const wanted = useRef(false)
  const [asked, setAsked] = useState(0)
  const selecting = to > from

  const ask = useCallback(
    async (name: string, first: number, last: number, nearest = false): Promise<PageRect[]> => {
      const body = await json('/api/sync', { epic: paper.epic, file: name, line: String(first), to: String(last) })
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
      setOwnRects([])
      return
    }
    let stopped = false
    const timer = setTimeout(() => {
      void ask(file, fromLine, toLine, wanted.current)
        .then((rects) => {
          if (stopped) return
          setOwnRects(rects)
          /* A SELECTION is followed; a caret moving is not, or the page would
             slide under every arrow key. */
          if (rects.length && (selecting || wanted.current)) setReveal((was) => ({ nonce: (was?.nonce ?? 0) + 1 }))
          wanted.current = false
        })
        .catch(() => {})
    }, settle)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [buildId, doc === null, file, fromLine, toLine, selecting, ask, settle, asked])

  const foreignDoc = foreign ? source.docs.get(foreign.file) : undefined
  const foreignText = foreignDoc?.text
  useEffect(() => {
    if (!buildId || !foreign || foreignText === undefined || !foreignDoc) {
      setForeignRects([])
      return
    }
    let stopped = false
    const first = lineAt(foreignText, indexAt(foreignText, foreign.from, foreignDoc.eol))
    const last = lineAt(foreignText, Math.max(indexAt(foreignText, foreign.to, foreignDoc.eol) - 1, 0))
    void ask(foreign.file, first, Math.max(first, last), true)
      .then((rects) => {
        if (stopped) return
        setForeignRects(rects)
        if (rects.length) setReveal((was) => ({ nonce: (was?.nonce ?? 0) + 1 }))
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId, foreign?.file, foreign?.from, foreign?.to, foreignText === undefined, ask])

  /* ---- What the toolbar reads out ---------------------------------------- */

  /* The caret's page and section — unless this page is showing a passage it
     was pointed at, and then THAT passage's: see `onPassage`. The page is the
     one its mark is drawn on when SyncTeX has answered, and the one the page
     map gives its first line until then. */
  const showing = onPassage ? foreign : null
  const shown = useMemo(
    () =>
      placeShown(
        { page, section: here?.title ?? null },
        showing && {
          section: sectionAt(sections, showing.file, showing.from)?.title ?? null,
          marked: foreignRects[0]?.page ?? null,
          mapped:
            map && foreignText !== undefined && foreignDoc
              ? pageOfLine(map, showing.file, lineAt(foreignText, indexAt(foreignText, showing.from, foreignDoc.eol)))
              : null,
        },
      ),
    [page, here, showing, sections, foreignRects, map, foreignText, foreignDoc],
  )

  const marks = useMemo<PdfMark[]>(() => {
    const out: PdfMark[] = []
    /* The foreign mark first: `reveal` scrolls to the first mark, and what
       somebody pointed at outranks where the caret happens to be. */
    if (foreign && foreignRects.length) {
      const whole = foreignText !== undefined && foreignDoc
        ? foreignText.slice(indexAt(foreignText, foreign.from, foreignDoc.eol), indexAt(foreignText, foreign.to, foreignDoc.eol))
        : null
      out.push({ rects: foreignRects, source: whole, foreign: true })
    }
    /* With only a caret, the line's own text is what the rectangles are for,
       and tightening to it trims a paragraph's last line back to its words. */
    if (ownRects.length) out.push({ rects: ownRects, source: selecting ? text.slice(from, to) : textOfLine(text, fromLine) })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foreign, foreignRects, ownRects, selecting, selecting ? text.slice(from, to) : textOfLine(text, fromLine)])

  /* The pages drawn under a focus: the picked parts' own, and — flagged —
     any a mark is on, so that nothing this page points at is ever on a sheet
     that is not there. Null when nothing is picked: every page, as always. */
  const sheets = useMemo(() => {
    if (!focus || focus.pages === null) return null
    return pagesShown(focus, marks.flatMap((mark) => mark.rects.map((rect) => rect.page)))
  }, [focus, marks])

  const showInPdf = () => {
    setTab('pdf')
    if (!buildId) {
      setSaid('There is no compiled PDF yet to show this in.')
      return
    }
    /* Asked again rather than reusing what is drawn: a caret on a line with
       no record of its own draws nothing until somebody asks for the nearest. */
    wanted.current = true
    setAsked((n) => n + 1)
  }

  /* ---- PDF to source ---------------------------------------------------- */

  const onPoint = useCallback(
    (at: { page: number; x: number; y: number; word: string | null }) => {
      void json('/api/sync', { epic: paper.epic, page: String(at.page), x: at.x.toFixed(2), y: at.y.toFixed(2) })
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

  const problems = build?.last?.problems ?? NONE
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
  const failed = build?.last ? !build.last.ok : false
  const errors = problems.filter((one) => one.severity === 'error')
  const warnings = problems.filter((one) => one.severity === 'warning')
  const [showLog, setShowLog] = useState(false)

  const stale = build?.pdf ? !sameHashes(build.pdf.hashes, paper.hashes) : false
  const pdfUrl = build?.pdf ? apiUrl('/api/pdf', { epic: paper.epic, build: build.pdf.id }) : null

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
  const openOutside = focus !== null && isOutside(file)
  const firstInFocus = focus?.files[0] ?? null

  const saved =
    source.state === 'saving' ? 'Saving…' : source.state === 'dirty' ? 'Unsaved' : source.state === 'failed' ? 'Not saved' : 'Saved'
  const engineSays = !build
    ? ''
    : !build.engine
      ? 'No engine'
      : compiling || build.running
        ? 'Compiling…'
        : build.last
          ? `${build.last.ok ? 'Compiled' : 'Failed'} · ${(build.last.ms / 1000).toFixed(1)} s`
          : build.engine

  return (
    <div className="workspace flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b px-1 pb-1 text-[0.72rem]">
        {paper.files.length > 1 && (
          <select
            className="border-input bg-background w-0 max-w-[12rem] min-w-0 flex-1 basis-[5.5rem] rounded border px-1 py-0.5 font-mono"
            value={file}
            onChange={(event) => {
              wandered()
              source.open(event.target.value)
            }}
            aria-label="File"
          >
            {listed.map((one) => (
              <option key={one} value={one}>
                {focus && isOutside(one) ? `${one} — outside the focus` : one}
              </option>
            ))}
          </select>
        )}
        {sections.length > 0 && (
          <select
            className="border-input bg-background w-0 max-w-[12rem] min-w-0 flex-1 basis-[5.5rem] rounded border px-1 py-0.5"
            value=""
            onChange={(event) => {
              const picked = sections[Number(event.target.value)]
              if (picked) {
                wandered()
                go({ file: picked.file, bytes: { from: picked.at, to: picked.at }, focus: true })
                setTab('source')
              }
            }}
            aria-label="Sections"
          >
            <option value="">{shown.section ?? 'Sections'}</option>
            {sections.map((one, i) =>
              /* By its place in the WHOLE list, which is what the handler
                 above reads, so leaving some out renumbers nothing. */
              listed.includes(one.file) ? (
                <option key={i} value={i}>
                  {`${'  '.repeat(Math.max(0, one.level - 1))}${one.title}`}
                </option>
              ) : null,
            )}
          </select>
        )}
        <span className={cn('text-muted-foreground', source.state === 'failed' && 'text-(--gone)')} aria-live="polite" data-save={source.state}>
          {saved}
        </span>
        <span className="flex-1" />
        <span className={cn('text-muted-foreground', failed && 'text-(--gone)')} data-build={compiling ? 'running' : failed ? 'failed' : build?.last ? 'ok' : 'idle'}>
          {engineSays}
          {shown.page !== null && build?.pdf?.pages ? ` · p. ${shown.page}/${build.pdf.pages}` : ''}
        </span>
        {build?.engine && (
          <Button variant="outline" size="container" disabled={compiling} onClick={() => void source.flush().then(() => compile())}>
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

      {focus && (
        <div role="status" className="paper-focus shrink-0 border-b px-2 py-1 text-[0.72rem] leading-snug" data-focus={focus.ownsNone ? 'none' : 'some'}>
          <p>{headline(focus)}</p>
          {notesOf(focus).map((note, i) => (
            <p key={i} className="mt-0.5" data-focus-note>
              {note}
            </p>
          ))}
        </div>
      )}

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
            {one === 'source' ? 'Source' : failed ? 'PDF ·!' : 'PDF'}
          </Button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cn('min-h-0 min-w-0 flex-1 flex-col @min-[720px]:flex @min-[720px]:border-r', tab === 'source' ? 'flex' : 'hidden')}>
          <ProposalsPanel
            proposals={proposals}
            busy={busy}
            auto={auto}
            onAuto={changeAuto}
            onDecide={(id, decision) => void answerOne(id, decision)}
            onAcceptAll={() => void acceptAll()}
            onShow={showProposal}
          />
          {openOutside && (
            <div role="status" className="bg-muted/60 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1 text-[0.72rem] leading-snug" data-outside-file={file}>
              <span className="min-w-0 flex-[1_1_11rem]">
                {file} is outside {outsideSaid}. It stays open, and is saved as usual, until you choose another file.
              </span>
              {firstInFocus && (
                <Button
                  variant="outline"
                  size="container"
                  onClick={() => {
                    wandered()
                    source.open(firstInFocus)
                  }}
                >
                  Open {firstInFocus}
                </Button>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {doc ? (
              <EditorPane
                key={`${paper.epic}\0${file}`}
                value={doc.text}
                onChange={source.edit}
                onSelect={onSelect}
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
          {(errors.length > 0 || (showLog && build?.last)) && (
            <section className="problems max-h-[40%] shrink-0 overflow-auto border-b text-[0.72rem]" aria-label="Compile errors">
              {failed && (
                <p className="px-2 pt-1 font-medium text-(--gone)">
                  {build?.last?.engine} did not produce a PDF{build?.pdf ? '. The one below is the last that compiled.' : '.'}
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
              {showLog && build?.last?.tail && (
                <pre className="text-muted-foreground border-t px-2 py-1 font-mono text-[0.65rem] whitespace-pre-wrap">{build.last.tail}</pre>
              )}
            </section>
          )}
          {build && !build.engine && (
            <div className="shrink-0 border-b px-2 py-2 text-[0.75rem] leading-relaxed" role="status" data-no-engine>
              <p className="mb-1 font-medium">The paper cannot be compiled here</p>
              <p className="text-muted-foreground">{build.how}</p>
            </div>
          )}
          {pdfUrl && sheets && sheets.pages.length === 0 && (
            <p className="text-muted-foreground shrink-0 border-b px-2 py-2 text-xs leading-relaxed" role="status" data-no-pages>
              {focus?.ownsNone
                ? `No page of this paper is in ${outsideSaid}, because ${focus.parts.length === 1 ? 'it owns' : 'they own'} no files of it. The line above says how to give ${focus.parts.length === 1 ? 'it' : 'them'} some.`
                : `No page of this PDF was printed by a file of ${outsideSaid}.`}
            </p>
          )}
          <div className="relative min-h-0 flex-1">
            {pdfUrl ? (
              <PreviewPane
                url={pdfUrl}
                marks={marks}
                reveal={reveal}
                onPoint={onPoint}
                onOpen={() => setTab('source')}
                {...(sheets ? { pages: sheets.pages, outside: sheets.outside, outsideOf: outsideSaid } : {})}
              />
            ) : (
              build?.engine && (
                <p className="text-muted-foreground p-3 text-xs">
                  {compiling ? `Compiling with ${build.engine}…` : failed ? 'No PDF yet: the first compile failed. The errors are above.' : 'No PDF yet.'}
                </p>
              )
            )}
          </div>
          {build?.last && (
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
const NO_PARTS: readonly EpicPart[] = []

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
