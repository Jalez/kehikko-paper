import { LIMITS, type Passage as WirePassage, type Section } from 'kehikot-module-protocol'
import { useEffect, useRef } from 'react'

import type { Paper } from '../store.ts'

/**
 * Where the reader is pointing, said out loud to the canvas.
 *
 * ## The open question in `use-selection.ts`, answered
 *
 * That file ends with a paragraph saying the selection is observable inside
 * this module and published nowhere, because "the Notes module has not been
 * written, and a protocol extension designed against an imaginary consumer is a
 * protocol extension that gets designed twice." It was right to wait, and it
 * was also right about which route not to take: the canvas `selection` carries
 * TRACKER REFS, and a byte range posted into it would be handed to Journeys and
 * to References as though it were an issue.
 *
 * Protocol 0.9 answered it, and answered it better than the extension that file
 * imagined. `context.passage` is a first-class field with three rungs and one
 * method, and the argument for its being CONTEXT rather than a message is the
 * one this app cannot make for itself: a reader highlights a sentence at 10:04
 * and puts a notes container on the canvas at 10:05. An event is gone by then; state
 * is what a module can arrive late to.
 *
 * So the addition this hook makes is the one `use-selection.ts` predicted —
 * nothing in that file or in `lib/selection.ts` changes, and this reads them.
 *
 * ## Three rungs, and this app can honestly stand on all three
 *
 *   1. **No paper on screen** — `null`. Not "the last paper", not a passage
 *      with an empty path: the container is showing a screen that says no epic is
 *      open, and a consumer holding the previous chapter would be showing the
 *      notes on a document the reader closed.
 *   2. **A paper, nothing selected** — the file and the page, with `from`,
 *      `to` null and no quote. This is the rung that makes a notes container useful
 *      when nobody is highlighting anything: it shows the page's notes rather
 *      than nothing, which is the whole ask the field was designed for.
 *   3. **A paper with a highlight** — the byte range and the words.
 *
 * Rung 2 is sent on every page turn, which is what makes it a readout of where
 * the reader IS rather than of what they last did.
 *
 * ## Why the path is joined here
 *
 * Blocks name their file relative to the paper's root — `chapters/2_bridge.tex`
 * — and the protocol wants an absolute path, because that is the only spelling
 * two modules can agree on without sharing a root. `paper.dir` is the root this
 * app was configured with; joining is a string concatenation and is done in one
 * place so that two spellings of one file cannot go out, since every consumer
 * compares this field for EQUALITY.
 */

/**
 * What is selected in the source editor: a file, a byte range, and the words.
 *
 * ## The words are SOURCE now, and that is a change worth a paragraph
 *
 * `text` is the selected `.tex` exactly as it is in the file — markup,
 * line breaks and all. It used to be the rendered prose a reader dragged
 * across, with macros expanded and whitespace collapsed, because that was what
 * was on screen. The protocol's own words for `quoted` are "as the pointing
 * module saw it", and what this module sees now is source.
 *
 * It is also the better quote for every consumer that checks one. Notes
 * verifies an anchor by comparing the quote against the bytes of the file with
 * only whitespace collapsed, so a rendered quote across `\emph{…}` or a
 * citation never matched and the note read as adrift from the day it was
 * written; a source quote matches exactly. Learning and Slides already store
 * source. Nothing about the SHAPE moved: a path, a page, two byte offsets, a
 * string, a section.
 */
export interface Highlighted {
  /** Relative to `paper.dir`. */
  file: string | null
  srcStart: number
  srcEnd: number
  text: string
}

/** Where the caret is: which page of the compiled PDF, which file, under which heading. */
export interface Sheet {
  /**
   * One-based page of the COMPILED PDF that the caret's line came out on, or
   * null when there is no build to say — no engine, or nothing compiled yet.
   *
   * This used to be a page of this module's own estimated pagination, always a
   * number. A real page is the one a person can cite; `null` is in the
   * protocol's shape for exactly "not known", and a consumer that filters by
   * page then shows the whole document's notes rather than the wrong page's.
   */
  page: number | null
  /** Relative to `paper.dir`, or null when no file is open. */
  file: string | null
  /**
   * The heading the top of this sheet is under, with its span in `file`.
   * Optional so a caller that knows no sections need not say so.
   */
  section?: { title: string; from: number; to: number } | null
}

/**
 * How long a selection has to hold still before it is broadcast.
 *
 * ## Not a taste, a measured hazard
 *
 * A passage goes into `kehikot.context`, and a context is posted into EVERY
 * framed module on the canvas. A selection changes on every pointer move during
 * a drag; a reader dragging across a paragraph produces dozens of them in a
 * second, and sent per event that is dozens of broadcasts to every container, each
 * carrying up to two kilobytes of somebody's document.
 *
 * There is a measured history of this exact failure a layer up: the host was
 * found broadcasting seventeen identical contexts during startup because
 * nobody had checked whether anything had changed. Nothing was visibly wrong,
 * which is why it survived being written.
 *
 * A hundred and fifty milliseconds is under the threshold at which a person
 * notices a container react to their selection, and comfortably longer than the gap
 * between two `mouseup`s of one gesture. The dedupe below is the second half:
 * a debounce stops a burst, and only an equality check stops a repeat.
 */
const SETTLE_MS = 150

/** The one place a passage is built, so there is one spelling of every field. */
export function passageFor(
  paper: Paper | null,
  sheet: Sheet,
  highlighted: Highlighted | null,
): WirePassage | null {
  if (!paper) return null

  const file = highlighted?.file ?? sheet.file
  /* No file to name is not a coarser passage, it is no passage. `path` is the
     identity of the document and a consumer compares it for equality; a passage
     with an invented path would be a claim about a file this app cannot say the
     reader is looking at. */
  if (!file) return null

  const path = join(paper.dir, file)
  if (path.length > LIMITS.PATH) return null

  /* Where the reader is, beside what they point at — never instead of it, and
     never a mark: `from`/`to` alone say "this text". A title over the quote
     limit is dropped, not clipped, since a clipped title matches no heading. */
  const at = sheet.section ?? null
  const section: Section | null =
    at && at.title.length >= 1 && at.title.length <= LIMITS.QUOTE ? { title: at.title, from: at.from, to: at.to } : null

  if (!highlighted) return { path, page: sheet.page, from: null, to: null, quoted: '', section }

  /**
   * The quote, or nothing, and never a piece of one.
   *
   * `LIMITS.QUOTE` is refused rather than clipped, and the protocol's own essay
   * says why a clipped quote is worse than no quote at all: the quote exists so
   * that a consumer can tell a good anchor from a rotten one by LOOKING, and
   * half a paragraph compared against a file will never match, so a clipped
   * quote turns every long selection into a permanent false report of drift.
   *
   * Dropping it costs the consumer its ability to verify this one range, which
   * is a loss it can see — an empty quote is visibly "there is nothing to check
   * against" — rather than a wrong answer it cannot.
   */
  const quoted = highlighted.text.length <= LIMITS.QUOTE ? highlighted.text : ''

  return {
    path,
    page: sheet.page,
    from: highlighted.srcStart,
    to: highlighted.srcEnd,
    quoted,
    section,
  }
}

/** `dir` and a relative file, joined without pulling `node:path` into a page. */
export function join(dir: string, file: string): string {
  return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`
}

/**
 * Two passages, compared by value.
 *
 * By field rather than by `JSON.stringify`, because key order out of two
 * different construction sites is not guaranteed to match and a comparison that
 * silently stops matching is a comparison that stops preventing anything.
 */
function same(a: WirePassage | null, b: WirePassage | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.path === b.path && a.page === b.page && a.from === b.from && a.to === b.to && a.quoted === b.quoted
    && sameSection(a.section ?? null, b.section ?? null)
  )
}

function sameSection(a: Section | null, b: Section | null): boolean {
  if (a === null || b === null) return a === b
  return a.title === b.title && a.from === b.from && a.to === b.to
}

/** The section as part of the effect's key, so a change of heading alone re-runs it. */
function sectionKey(section: Section | null | undefined): string {
  return section ? `${section.from}\0${section.to}\0${section.title}` : ''
}

/**
 * Whether a settled passage is this module's to say, or somebody else's coming
 * back at it.
 *
 * ## The loop this exists to make impossible
 *
 * This module now does both halves: it publishes where the reader is pointing,
 * and it REACTS to a passage by scrolling to it. Those two together are a
 * cycle waiting to close. A passage arrives; the container turns to page 14; the
 * page readout changes; `passageFor` builds a rung-2 passage naming page 14
 * with no range; that goes out; the host broadcasts it; the notes container loses
 * the passage it was just narrowed to; and if anything in the chain produced a
 * selection it would go round again. Nothing in it is a bug on its own.
 *
 * The workspace has a measured history of exactly this shape one layer up — the
 * host was found broadcasting seventeen identical contexts in a single startup
 * because nothing checked whether anything had changed. Nothing looked wrong,
 * which is why it survived being written.
 *
 * So there are two independent stops and both are cheap:
 *
 *   - **`quiet`** — this module has adopted a passage somebody else set and the
 *     person at this machine has not touched the paper since. Everything the
 *     container does in that state is a consequence of the passage, so none of it is
 *     news. It is lifted by a gesture: a scroll, a key, a pointer, a selection.
 *     "Publish only on a selection a PERSON made" is what this enforces.
 *   - **`echo`** — never send back the passage that was just received, even
 *     after a gesture has lifted `quiet`. Two modules agreeing is not an event.
 *
 * An echo that was suppressed is recorded as though it had been sent: it IS
 * what the canvas holds, so the next genuine change is compared against that
 * rather than against the last thing this module happened to say out loud. A
 * passage suppressed for `quiet` is not (see `usePublishedPassage`): the canvas
 * holds somebody else's then, and this one was never said to anybody.
 *
 * A pure function, exported, because a loop guard that cannot be tested without
 * two containers and a stopwatch is a loop guard nobody will change with confidence.
 */
export function shouldPublish(
  next: WirePassage | null,
  sent: WirePassage | null,
  seen: boolean,
  echo: WirePassage | null,
  quiet: boolean,
): boolean {
  if (seen && same(sent, next)) return false
  if (quiet) return false
  /* `echo !== null` and not `same(echo, next)` alone: a null echo means nothing
     has been received, and `same(null, null)` is true — so the looser test
     would silently refuse to ever publish "no document is open", which is the
     one state a consumer most needs to be able to move into. */
  if (echo !== null && same(echo, next)) return false
  return true
}

/**
 * Publish it, once it has settled and only when it has changed.
 *
 * The effect runs on every render that changes any input; the timer means only
 * the last one in a burst is sent, and `sent` means an identical passage is not
 * sent at all — including after a burst that started and ended in the same
 * place, which is what a click inside an existing selection looks like.
 */
export function usePublishedPassage(
  point: (passage: WirePassage | null) => void,
  paper: Paper | null,
  sheet: Sheet,
  highlighted: Highlighted | null,
  /** The passage this module last received from the canvas. Never echoed back. */
  echo: WirePassage | null = null,
  /** Whether this container is showing somebody else's passage and nobody has touched it since. */
  quiet = false,
  /**
   * A count of the times a person said where they are by some other means
   * than moving in this page — a part ticked in the host's bar. Each one is a
   * reason to say the passage again though nothing in it moved: the tick may
   * have left this page on the very file somebody else had walked it to, and
   * the canvas is still holding their passage.
   */
  again = 0,
): void {
  const sent = useRef<{ was: WirePassage | null } | null>(null)

  const next = passageFor(paper, sheet, highlighted)
  /* The next passage as a VALUE. The object is rebuilt on every render, so an
     effect depending on it by identity would fire on every render — and the
     first thing it would do is find it equal and do nothing, which works and
     leaves a timer being set and cleared forever behind somebody's reading. */
  const key = next === null ? '' : `${next.path} ${next.page} ${next.from} ${next.to} ${next.quoted} ${sectionKey(next.section)}`

  const latest = useRef(next)
  latest.current = next
  const tell = useRef(point)
  tell.current = point

  /* Read through refs for the same reason `latest` is: a change in either must
     not restart the debounce, because the guards are about whether to SAY the
     settled passage and not about when it settles. */
  const quietly = useRef(quiet)
  quietly.current = quiet
  const echoed = useRef(echo)
  echoed.current = echo

  useEffect(() => {
    const timer = setTimeout(() => {
      const passage = latest.current
      /* Quiet, so not said — and NOT recorded as said. It used to be, and that
         made the quiet outlast itself: the canvas was holding somebody else's
         passage, this one had gone to nobody, and once a person had lifted the
         quiet the first thing worth saying was compared against it and found
         to be no change. */
      if (quietly.current) return
      const say = shouldPublish(passage, sent.current?.was ?? null, sent.current !== null, echoed.current, false)
      /* Recorded whether or not it went out. An echo that was suppressed is
         still what the canvas holds, so the next thing worth saying is the next
         thing that differs from THIS — not from the last thing this module
         happened to have said out loud. */
      sent.current = { was: passage }
      if (say) tell.current(passage)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [key, again])
}
