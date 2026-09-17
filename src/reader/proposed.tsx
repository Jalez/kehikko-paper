import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { diffWords } from '../../latex/diff.ts'
import type { Proposal } from '../../latex/propose.ts'
import { Button } from '@/components/ui/button.tsx'
import { ButtonGroup } from '@/components/ui/button-group.tsx'
import { cn } from '@/lib/utils.ts'

/**
 * A change somebody has suggested, drawn where it happens and answered there.
 *
 * ## Why a suggestion is drawn in the prose and not in a panel
 *
 * A side panel showing "in chapters/wire.tex, bytes 4120–4137, replace X with
 * Y" is the shape this module has refused everywhere else, and for the same
 * reason: a byte range is not a thing a person can check before approving it.
 * Somebody deciding whether a sentence should change has to read the sentence,
 * in the paragraph it is in, with the argument either side of it. A panel makes
 * them find the place themselves and then trust that the panel was talking
 * about it — which is the whole of what goes wrong when a program asks for
 * approval it has not made checkable.
 *
 * So the change is drawn into the paper: what leaves in red and struck through,
 * what arrives in green, at the exact characters, and the control that answers
 * it points at those characters.
 *
 * ## It used to be drawn TWICE, and now it is drawn once
 *
 * The same red and green used to appear in the floating control as well as in
 * the prose. The argument for it was the width this module is read at: the
 * sheet is A4 scaled to the column, at 220 pixels the scale is 0.277, the body
 * type draws at 4.2 pixels, and the inline diff is real, correctly placed and
 * illegible. A counter-scaled copy in the control was the only readable one.
 *
 * The owner has now read it at that width and disagrees — "repeating the words
 * that were changed there is redundant as they are also showed in the text
 * itself" — and they are right about what changed underneath the argument.
 * That argument assumed the control floated over the whole PARAGRAPH, so the
 * copy in the card was doing two jobs: saying what the change is, and saying
 * WHERE in the paragraph it is. Anchored to the changed span itself, the second
 * job is done by the anchoring, and only the first was ever redundant.
 *
 * What is left for findability at 220 pixels is deliberate and not an
 * assumption:
 *
 *  - **The card points.** An arrow is drawn on the edge of the card facing the
 *    words, at the horizontal centre of the changed span, so the control names
 *    its own place on the page. That is a geometric claim, not a typographic
 *    one, and it survives being four pixels tall.
 *  - **The wash survives the scale even though the glyphs do not.** What is
 *    illegible at 4.2 pixels is the LETTERFORMS. `.proposed-out` and
 *    `.proposed-in` are 20% colour washes behind whole words with a rule
 *    through or under them, and a block of colour a few pixels tall is still a
 *    block of colour. "Which words" is not readable there; "there, and not
 *    somewhere else in this paragraph" is, and that is all the inline copy is
 *    now being asked for.
 *
 * The `why` sentence stays. It is the one thing in the card that is nowhere
 * else on the page, and the owner called the explanation nice.
 */

/**
 * What has been suggested about the block being drawn, and how to answer it.
 *
 * A context for the same reason `Marked` and `Typed` are: a suggestion has to
 * reach every rendered span — a paragraph's, a heading's, a list item's, a
 * caption's — and threading it as a prop means five signatures in `blocks.tsx`
 * with the failure mode of forgetting one being a change that draws in a
 * paragraph and silently does not in a caption.
 *
 * Narrowed to one block before it is supplied, so a block with nothing
 * suggested about it gets the same empty array every other one gets and the
 * context does not change identity for the whole page whenever one paragraph
 * gains a suggestion.
 */
/**
 * One frozen empty array, shared, so an unchanged context is an unchanged VALUE.
 *
 * A `[]` written at each call site would hand every block a fresh identity on
 * every render, which re-renders every span in the document each time the page
 * number moves. This is the same care `BlockRow` already takes with `typing`,
 * and it matters more here: there are 2,437 of these on the real thesis.
 */
export const NO_PROPOSALS: readonly Proposal[] = Object.freeze([])

export const Proposed = createContext<readonly Proposal[]>(NO_PROPOSALS)

/**
 * Where each drawn change actually landed in the DOM, reported upward.
 *
 * The controls belong to the reading view — that is the only level that can
 * see every suggestion on the paper at once, which is what laying them out
 * against each other needs — but the thing each one has to point at is a span
 * many components below it, produced by `segments.tsx` while it walks the runs
 * of one paragraph. Nothing on the way down carries a proposal id, and nothing
 * on the way up carries an element.
 *
 * So the view hands DOWN a place to put one. `Change` calls `put` from a ref
 * callback when it mounts and again with `null` when it goes; the store keeps
 * the map and the controls read it. A ref callback fires on mount and unmount
 * and not on every render, and the callback identity is memoised on
 * `(anchors, id)`, so this settles after one pass rather than looping.
 *
 * ## A store and not React state, and the reason is 2,437 blocks
 *
 * This used to be `useState` on each block, which re-rendered that one block
 * when its span arrived. Lifted to the view, the same `useState` would
 * re-render every sheet on the paper once per suggestion drawn, on mount and
 * again on every re-read — the view is what draws the pages. A store with a
 * subscription re-renders the one component that reads it, which is the
 * controls layer, and nothing else notices a span arriving.
 *
 * The registry is `null` where nobody is collecting — every test that renders
 * a paragraph on its own.
 */
export interface Anchors {
  put: (id: string, el: HTMLElement | null) => void
  get: (id: string) => HTMLElement | null
  /** For `useSyncExternalStore`: tell me when the map changes. */
  subscribe: (listen: () => void) => () => void
  /** A number that moves whenever the map does. The snapshot, and nothing else. */
  version: () => number
}

export function anchorStore(): Anchors {
  const held = new Map<string, HTMLElement>()
  const listeners = new Set<() => void>()
  let version = 0
  return {
    put(id, el) {
      if ((held.get(id) ?? null) === el) return
      if (el) held.set(id, el)
      else held.delete(id)
      version += 1
      for (const listen of listeners) listen()
    },
    get: (id) => held.get(id) ?? null,
    subscribe(listen) {
      listeners.add(listen)
      return () => {
        listeners.delete(listen)
      }
    },
    version: () => version,
  }
}

export const Anchoring = createContext<Anchors | null>(null)

/** What a person can say about a suggestion. */
export type Decision = 'accept' | 'reject'

export interface Answering {
  /** Say yes or no to one. The page sends it; the door decides. */
  decide: (id: string, decision: Decision) => void
  /**
   * Accept everything waiting, oldest first.
   *
   * One at a time and in order, rather than as a batch, and the reason is that
   * a batch would need a second write path with its own hash arithmetic. Each
   * accept re-reads the paper and rebases what is left — see `rebaseAll` — so
   * by the time the second one is sent, its byte offsets and its hash already
   * describe the file the first one produced. What that cannot survive is two
   * suggestions about the same words, and it does not pretend to: the second is
   * dropped and said out loud.
   */
  acceptAll: () => void
  /** Whether an answer is in flight, so a second press cannot be made. */
  busy: boolean
}

/**
 * The change itself, in green and red.
 *
 * Rendered as `<del>` and `<ins>` rather than as coloured `<span>`s, because
 * those two elements MEAN removed and inserted. Colour is a channel some
 * readers do not have, and this module's own rule — stated where `--pencil` and
 * `--mark` are defined — is that every colour on the page is paired with
 * something that is not a colour. Here that pairing comes free: the elements
 * carry the meaning, a screen reader says it, and the strike-through says it
 * again for somebody who cannot tell the two hues apart.
 *
 * `id` is passed only where the change BEGINS. A replacement can span two runs
 * — the words either side of the author's hard wrap are two pieces of one
 * coalesced run, and a citation in the middle of a sentence splits it in three
 * — and each piece renders its own `Change`. They are one suggestion, so they
 * must not fight over one entry in the anchor registry; `segments.tsx` names
 * the first and leaves the rest anonymous. The control then points at the first
 * character that changes, which is where a reader's eye has to go anyway.
 */
export function Change({
  was,
  now,
  id,
  className,
}: {
  was: string
  now: string
  id?: string
  className?: string
}) {
  const anchors = useContext(Anchoring)
  const ops = diffWords(was, now)
  /* Memoised on the two things it closes over, so this is a STABLE ref
     callback: an inline arrow here would be a new function on every render, and
     React calls a changed ref callback with `null` and then with the node
     again — which would re-register on every scroll frame. */
  const keep = useCallback(
    (el: HTMLElement | null) => {
      if (anchors && id) anchors.put(id, el)
    },
    [anchors, id],
  )
  return (
    <span
      ref={anchors && id ? keep : undefined}
      className={cn('proposed-change', className)}
      data-proposed-change=""
    >
      {ops.map((op, i) =>
        op.type === 'equal' ? (
          <span key={i}>{op.text}</span>
        ) : op.type === 'removed' ? (
          <del key={i} className="proposed-out" data-proposed="out">
            {op.text}
          </del>
        ) : (
          <ins key={i} className="proposed-in" data-proposed="in">
            {op.text}
          </ins>
        ),
      )}
    </span>
  )
}

/* ---- Where the cards go ------------------------------------------------- */

/**
 * The cards are laid out IN the document, by the view, and not floated over it.
 *
 * ## What this replaced, and the two things it was doing wrong
 *
 * The control was a Radix popover: portalled to the end of `document.body`,
 * `position: fixed`, positioned by Floating UI from the anchor's rectangle,
 * re-positioned on every scroll event of the column, flipped and shifted
 * against the column as a collision boundary, and hidden when the words left
 * it. That is the right machine for a tooltip, which belongs to the WINDOW,
 * and it was the wrong machine for an annotation, which belongs to the PAGE.
 * The owner's two complaints are both consequences of that one mismatch.
 *
 * **It did not hold still.** A card outside the scroll container has to be
 * moved by script every time the container scrolls, and the script runs on the
 * main thread after the compositor has already drawn the words in their new
 * place — so under a wheel or a trackpad the card is drawn behind the text it
 * points at, and wobbles against it. And because the flip was decided against
 * the column's edge, a card above the words became a card below them the
 * moment the words came within a card's height of the top, which is an
 * 88-pixel jump (measured, 460px wide) in the middle of a scroll. A reader saw
 * both and said the card "doesn't really stay still".
 *
 * **Two cards covered each other.** Floating UI positions one floating element
 * against one anchor and knows nothing about any other, so two changes on
 * consecutive lines got two cards in the same place — 2,730px² of overlap,
 * measured — with the lower one's Accept button under the upper one, which is
 * a suggestion that cannot be answered.
 *
 * ## What a card is now
 *
 * A `position: absolute` div inside the reading column, in the column's own
 * coordinates, placed once per LAYOUT and never per scroll. The column is the
 * scroll container, so the browser moves the card with the words on the
 * compositor thread, in the same frame, with no script involved; there is no
 * lag to have. Its position is decided from the anchor's rectangle relative to
 * the column's content, and that rectangle does not change when the column
 * scrolls, so nothing about the card's placement can depend on where the
 * reader has scrolled to. Hiding when the words leave the column is free too:
 * the card leaves with them, because it is in the same scrolling content.
 *
 * What is kept from the portal is the thing that made it worth having: the
 * card is OUTSIDE the transformed sheet, so it draws at its own size while the
 * anchor is measured through the transform by `getBoundingClientRect`. There is
 * still no reciprocal of the scale anywhere in this codebase.
 *
 * And because the view lays out every card on the paper in one pass, it can
 * lay them out against each other — see `placeCards`.
 *
 * ## What it must not do, which is now nothing
 *
 * The popover had `modal={false}` and four dismissals prevented — Escape,
 * outside pointer, outside focus, both autofocuses — because an annotation on
 * a document somebody is reading must not trap focus, must not make the page
 * inert, and must not close, since there is no trigger to reopen it with. All
 * four were Radix behaviours being switched off. A div has none of them to
 * switch off, which is the shorter way of saying the popover was the wrong
 * primitive.
 *
 * ## Wrong primitive HERE, and not everywhere
 *
 * That verdict is about this control specifically, and the distinction is
 * worth writing down because the popover component was briefly deleted on the
 * strength of it and had to come back.
 *
 * Every argument above rests on two properties a suggestion card has: it is
 * always open, and there is no trigger to reopen it with. Those are what make
 * dismissal something to switch off, what put several cards on the page at
 * once so they can cover each other, and what make a card that lags the words
 * during a scroll something a reader stares at for as long as they scroll.
 *
 * A citation card in `segments.tsx` has neither property. It is opened by
 * pressing the citation it is about, only one is open at a time, and closing
 * it is the point rather than a hazard — so dismissal is behaviour it wants,
 * collision between cards cannot arise, and it is on screen for the seconds
 * somebody spends reading an entry rather than for the length of a scroll.
 * Radix is the right tool for that and the wrong one for this, and the two
 * live side by side on purpose.
 */

/** A rectangle in the column's content coordinates. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Where one card goes, and which way it points. */
export interface Placed {
  left: number
  top: number
  /** Which side of its words the card is on. `top` means above them. */
  side: 'top' | 'bottom'
  /**
   * The arrow's distance from the card's left edge, or `null` for a card that
   * had to be pushed away from its words and would be pointing at the wrong
   * thing.
   */
  arrow: number | null
}

/** Between the words and the card, arrow included, in screen pixels. */
export const CARD_GAP = 6
/** Between one card and the next when they are stacked. */
const CARD_SPACE = 3
/** The arrow keeps this far inside the card's rounded corners. */
const ARROW_INSET = 10

/**
 * Where every card on the paper goes, decided together.
 *
 * ## The three rules, in the order they are applied
 *
 * 1. **Above the words, left-aligned with them, inside the column.** The card's
 *    left edge is the anchor's, clamped so the card does not leave the column
 *    — a 220-pixel column with a 132-pixel minimum card is the case that
 *    clamps. That clamp is the whole of what Floating UI's `shift` was doing.
 * 2. **Below the words when there is nothing above them on the sheet.** `floor`
 *    is the top of the page box the words are on. A card above the first line
 *    of a sheet would be drawn over the gap between pages or over the previous
 *    sheet, and above the first line of the FIRST sheet it would be clipped by
 *    the column's edge with no way to scroll it into view. This is the old
 *    "first block on a sheet goes below" rule, decided from the real rectangle
 *    rather than from the packing, and stable under scroll because both
 *    rectangles are in content coordinates.
 * 3. **Never on top of another card.** Cards are placed in document order, and
 *    a card that would land on one already placed first tries the other side
 *    of its words, and then is pushed down until it lands on nothing. Two
 *    changes on consecutive lines therefore get one card above the first line
 *    and one below the second; three get the third stacked under the second.
 *    A pushed card loses its arrow, because an arrow from a card that is no
 *    longer beside its words would point at whatever happens to be between.
 *
 * Document order, and the earlier card keeps its place, because that is the
 * order the reader meets them in and the order `x of y` counts in. The card a
 * reader has just scrolled to should be where they expect; the one after it
 * is the one that moves.
 *
 * Pure, and exported for that reason: which card yields to which is the kind
 * of rule a test should be able to state without a browser, even though where
 * the rectangles come from needs one.
 */
export interface Placing {
  anchor: Box
  size: { width: number; height: number }
  /** The top of the page box the words are on. A card does not go above it. */
  floor: number
}

export function placeCards(cards: readonly Placing[], room: number): Placed[] {
  const taken: Box[] = []
  const out: Placed[] = []
  const touches = (a: Box, b: Box) =>
    a.left < b.left + b.width + CARD_SPACE &&
    b.left < a.left + a.width + CARD_SPACE &&
    a.top < b.top + b.height + CARD_SPACE &&
    b.top < a.top + a.height + CARD_SPACE
  for (const { anchor, size, floor } of cards) {
    const left = Math.max(0, Math.min(anchor.left, room - size.width))
    const above = anchor.top - CARD_GAP - size.height
    const below = anchor.top + anchor.height + CARD_GAP
    let side: Placed['side'] = above >= floor ? 'top' : 'bottom'
    let box: Box = { left, top: side === 'top' ? above : below, ...size }
    const under = () => taken.filter((t) => touches(t, box))
    if (side === 'top' && under().length) {
      side = 'bottom'
      box = { ...box, top: below }
    }
    let pushed = false
    for (let hit = under(); hit.length; hit = under()) {
      box = { ...box, top: Math.max(...hit.map((t) => t.top + t.height)) + CARD_SPACE }
      pushed = true
    }
    taken.push(box)
    out.push({
      left: box.left,
      top: box.top,
      side,
      arrow: pushed
        ? null
        : Math.max(ARROW_INSET, Math.min(size.width - ARROW_INSET, anchor.left + anchor.width / 2 - left)),
    })
  }
  return out
}

const NOWHERE: ReadonlyMap<string, Placed> = new Map()

/**
 * Every control on the paper, laid out in the column.
 *
 * ## Measured in a layout effect, and what makes it re-measure
 *
 * The cards render first, invisible, so that they have a size to measure; then
 * one pass reads every anchor's rectangle and every card's size, decides the
 * placement, and the state change draws them — synchronously, before paint,
 * which is what a layout effect is for. It runs again when the list changes,
 * when a span arrives or leaves (the store's version), and when the view says
 * the sheets were re-laid-out (`laidOut`, which the view derives from the
 * paper, the scale, the sheet heights and the column width).
 *
 * Two things move the words without telling React, and each has a listener:
 * an image finishing its lazy load pushes every block under it down its sheet
 * — `load` does not bubble, so it is caught in the capture phase on the
 * column — and the web font arriving reflows every line. A card's own size
 * changing is watched too, because the `why` sentence wraps differently at a
 * different width and a card measured before the wrap is a card the wrong
 * height.
 *
 * None of these can loop: a card's position affects neither the anchors nor
 * the card's size, and the placement is a pure function of those two.
 */
/**
 * Which suggestion the reader is nearest, and therefore the only one drawn.
 *
 * The card used to be drawn for every waiting change at once, with
 * `placeCards` keeping them off each other — above the words, below them when
 * there was no room, pushed down and stripped of its arrow when even that
 * collided. That packing was the whole reason the `why` sentence was clamped
 * to two lines: a tall card had neighbours to land on.
 *
 * Only the nearest one is drawn now, so a card has nothing to collide with and
 * can say its whole reason. `placeCards` is still what places it, because rules
 * one and two — inside the column, and below the words when there is nothing
 * above them on the sheet — are about the sheet and not about other cards, and
 * they still apply to a single card.
 *
 * Nearest is measured from the middle of the COLUMN, not of the window: the
 * column is what scrolls, and its middle is where a reader's eye is when they
 * have scrolled a change into view. Falls back to the first change in document
 * order when nothing has been drawn into the prose yet, so there is always a
 * card to answer rather than a blank wait for the first measurement.
 */
export function nearestProposal(
  proposals: readonly Proposal[],
  anchors: Anchors,
  fallback: (proposal: Proposal) => HTMLElement | null,
  column: HTMLElement,
): string | null {
  const col = column.getBoundingClientRect()
  const middle = col.top + col.height / 2
  let best: string | null = null
  let bestGap = Infinity
  for (const p of proposals) {
    const at = anchors.get(p.id) ?? fallback(p)
    if (!at) continue
    const r = at.getBoundingClientRect()
    const gap = Math.abs(r.top + r.height / 2 - middle)
    if (gap < bestGap) {
      bestGap = gap
      best = p.id
    }
  }
  return best ?? proposals[0]?.id ?? null
}

export function ProposalControls({
  proposals,
  anchors,
  fallback,
  column,
  answering,
  laidOut,
}: {
  /** In document order — see `inOrder` in `paginated.tsx`. */
  proposals: readonly Proposal[]
  anchors: Anchors
  /** The block a suggestion is about, for one the prose could not draw. */
  fallback: (proposal: Proposal) => HTMLElement | null
  column: HTMLElement | null
  answering: Answering
  /** Changes identity whenever the sheets have been laid out again. */
  laidOut: unknown
}) {
  const version = useSyncExternalStore(anchors.subscribe, anchors.version, anchors.version)
  const cards = useRef(new Map<string, HTMLElement>())
  const [placed, setPlaced] = useState<ReadonlyMap<string, Placed>>(NOWHERE)
  /* Which single change is drawn. See `nearestProposal`. */
  const [current, setCurrent] = useState<string | null>(null)
  /* What to move to once the change being answered has actually gone. See
     `answer` below. */
  const advancing = useRef<{ answered: string; to: string } | null>(null)

  /**
   * Answer one, and line up the one after it.
   *
   * The reader is left where they were when a change is answered, and the
   * change they answered is the one they were looking at — so what is in front
   * of them afterwards is a paragraph with nothing to do in it, while the next
   * suggestion may be several sheets down. Pressing Accept is the clearest
   * statement a reader can make that they are working through these, so the
   * next one is brought to them rather than waiting to be found.
   *
   * The SUCCESSOR is remembered, not the nearest. After the answered change is
   * written out, the nearest remaining one may well be the one BEHIND the
   * reader, which would walk them backwards through a list they are going
   * forwards through. Wraps to the first still waiting when the last is
   * answered, for the same reason `Next suggestion` wraps.
   */
  const answer = useCallback(
    (id: string, decision: Decision) => {
      const i = proposals.findIndex((p) => p.id === id)
      const to = proposals[i + 1] ?? proposals.find((p) => p.id !== id)
      advancing.current = to ? { answered: id, to: to.id } : null
      answering.decide(id, decision)
    },
    [proposals, answering],
  )

  /* Deliberately waits for the answered change to LEAVE the list rather than
     moving as soon as the button is pressed: the door is what decides, the
     write can fail, and a reader scrolled away from a change that turned out
     not to have been written would be the worst of both. Re-runs as the anchor
     store fills, because after an accept the paper is re-read and the next
     change's span is registered again some frames later. */
  useEffect(() => {
    const plan = advancing.current
    if (!plan) return
    if (proposals.some((p) => p.id === plan.answered)) return
    const next = proposals.find((p) => p.id === plan.to)
    if (!next) {
      advancing.current = null
      return
    }
    const at = anchors.get(next.id) ?? fallback(next)
    if (!at) return
    advancing.current = null
    at.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [proposals, version, anchors, fallback])

  const look = useCallback(() => {
    if (!column) return
    setCurrent(nearestProposal(proposals, anchors, fallback, column))
  }, [column, proposals, anchors, fallback])

  useLayoutEffect(look, [look, version, laidOut])

  /* Scrolling moves the words past the column's middle without telling React,
     so the one measurement that has to follow the scroll is this one. Read in a
     frame rather than in the scroll event: `getBoundingClientRect` on every
     anchor is a forced layout, and a reader flicking down the paper fires
     scroll far faster than they can read. */
  useEffect(() => {
    if (!column) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        look()
      })
    }
    column.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      column.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [column, look])

  const place = useCallback(() => {
    if (!column) return
    const col = column.getBoundingClientRect()
    const content = (r: DOMRect): Box => ({
      left: r.left - col.left + column.scrollLeft,
      top: r.top - col.top + column.scrollTop,
      width: r.width,
      height: r.height,
    })
    const ids: string[] = []
    const input: Placing[] = []
    for (const p of proposals) {
      const card = cards.current.get(p.id)
      const at = anchors.get(p.id) ?? fallback(p)
      if (!card || !at) continue
      /* The page box is a direct child of the column, so its `offsetTop` is
         already in the column's coordinates. */
      const page = at.closest<HTMLElement>('[data-page]')
      ids.push(p.id)
      input.push({
        anchor: content(at.getBoundingClientRect()),
        size: { width: card.offsetWidth, height: card.offsetHeight },
        floor: page?.offsetTop ?? 0,
      })
    }
    const out = placeCards(input, column.clientWidth)
    setPlaced(new Map(ids.map((id, i) => [id, out[i]!])))
  }, [column, proposals, anchors, fallback])

  useLayoutEffect(place, [place, version, laidOut, current])

  useEffect(() => {
    if (!column) return
    column.addEventListener('load', place, true)
    if (typeof document !== 'undefined' && 'fonts' in document) void document.fonts.ready.then(place)
    if (typeof ResizeObserver === 'undefined') {
      return () => column.removeEventListener('load', place, true)
    }
    const ro = new ResizeObserver(place)
    for (const card of cards.current.values()) ro.observe(card)
    return () => {
      ro.disconnect()
      column.removeEventListener('load', place, true)
    }
  }, [column, place, current])

  return (
    <>
      {proposals.map((proposal, i) => proposal.id !== current ? null : (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          ordinal={i + 1}
          total={proposals.length}
          placed={placed.get(proposal.id) ?? null}
          anchored={anchors.get(proposal.id) ? 'words' : 'block'}
          decide={answer}
          busy={answering.busy}
          keep={(el) => {
            if (el) cards.current.set(proposal.id, el)
            else cards.current.delete(proposal.id)
          }}
        />
      ))}
    </>
  )
}

/**
 * The control that answers one suggestion.
 *
 * ## Two counts, and how they relate
 *
 * `x of y` beside the buttons, and `y suggested` in the chrome row, are the
 * same `y` by construction: both read the length of the one list
 * `PaginatedView` puts in document order, and the ordinal is that list's index.
 * They cannot drift because there is nothing for them to drift between.
 *
 * The order is the order a reader MEETS them — file by file down the paper —
 * and not the order `Accept all` writes them in, which is oldest-filed first.
 * Those differ, and the count is the one a reader can check by scrolling.
 * Nothing here claims otherwise: the chrome row shows a total and no ordering,
 * so there is no second numbering on screen to contradict this one.
 *
 * The row wraps rather than answering a container query, and that is a real
 * cost of the card being chrome rather than document: it is inside the reading
 * column and not inside `@container container`, so a `@sm/container:` rule in
 * here would find no container to measure and would never match. Wrapping is
 * measured by the content against the card's own width, which needs no
 * ancestor at all.
 */
function ProposalCard({
  proposal,
  ordinal,
  total,
  placed,
  anchored,
  decide,
  busy,
  keep,
}: {
  proposal: Proposal
  /** Which of the paper's waiting changes this is, counting down the paper. */
  ordinal: number
  /** How many are waiting on the whole paper. The chrome row's number. */
  total: number
  /** Where it goes, or `null` before the first layout pass. Drawn invisible until then. */
  placed: Placed | null
  /** What it points at: the changed words, or the block when the prose could not draw them. */
  anchored: 'words' | 'block'
  decide: (id: string, decision: Decision) => void
  busy: boolean
  keep: (el: HTMLElement | null) => void
}) {
  const counted = `${ordinal} of ${total}`
  return (
    <div
      ref={keep}
      data-proposal={proposal.id}
      data-side={placed?.side ?? 'top'}
      data-anchored={anchored}
      data-placed={placed ? '' : undefined}
      data-arrow={placed && placed.arrow !== null ? '' : undefined}
      /* An annotation, not a dialog. `role="dialog"` would make a screen reader
         announce a modal that is always open, once per suggestion. */
      role="group"
      aria-label={`Suggested change ${counted}: ${proposal.why}`}
      className="proposal-card bg-card text-card-foreground rounded-[var(--radius-sm)] border"
      style={
        placed
          ? ({ left: placed.left, top: placed.top, '--arrow-left': `${placed.arrow ?? 0}px` } as React.CSSProperties)
          : undefined
      }
    >
      <p className="proposal-why">{proposal.why}</p>
      <div className="proposal-answer">
        <ButtonGroup label={`Answer the suggested change: ${proposal.why}`}>
          <Button
            size="container"
            variant="default"
            disabled={busy}
            onClick={() => decide(proposal.id, 'accept')}
            /* The whole rule, where somebody meets the thing it is about, in the
               same spirit as the Edit checkbox's own title. */
            title="Write this change into the .tex file now. The paper is re-read afterwards."
          >
            Accept
          </Button>
          <Button
            size="container"
            variant="outline"
            disabled={busy}
            onClick={() => decide(proposal.id, 'reject')}
            title="Forget this suggestion. Nothing is written and the file is left exactly as it is."
          >
            Reject
          </Button>
        </ButtonGroup>
        {/*
          Beside the buttons, where the owner asked for it, and a `span`
          rather than anything pressable: it says where in the paper this one
          is, and there is nothing here to press. The word "changes" is not
          repeated in the visible text — at 220 pixels it is what would push
          the count onto its own line — and is in the title and the group's
          accessible name instead, which is where "2 of 4" of WHAT gets
          answered without costing a line.
        */}
        <span
          className="proposal-count"
          data-proposal-count={counted}
          title={`The ${ordinal}${ordinalSuffix(ordinal)} of ${total} suggested change${total === 1 ? '' : 's'} waiting on this paper, counting down the paper from the top.`}
        >
          {counted}
        </span>
      </div>
    </div>
  )
}

/** `st`, `nd`, `rd`, `th` — for the sentence in the title, not for the badge. */
function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th'
  if (n % 10 === 1) return 'st'
  if (n % 10 === 2) return 'nd'
  if (n % 10 === 3) return 'rd'
  return 'th'
}
