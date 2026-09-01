import { createContext, useCallback, useContext } from 'react'

import { diffWords } from '../../latex/diff.ts'
import type { Proposal } from '../../latex/propose.ts'
import { Button } from '@/components/ui/button.tsx'
import { ButtonGroup } from '@/components/ui/button-group.tsx'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover.tsx'
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
 *  - **The card points.** `PopoverArrow` is drawn at the anchor, so the control
 *    names its own place on the page. That is a geometric claim, not a
 *    typographic one, and it survives being four pixels tall.
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
 * The control belongs to the block — that is the only level that knows about a
 * suggestion which could not be drawn in the prose at all — but the thing it
 * has to point at is a span several components below it, produced by
 * `segments.tsx` while it walks the runs of one paragraph. Nothing on the way
 * down carries a proposal id, and nothing on the way up carries an element.
 *
 * So the block hands DOWN a place to put one. `Change` calls `put` from a ref
 * callback when it mounts and again with `null` when it goes; the block keeps
 * the map and hands each element to the popover as its anchor. A ref callback
 * fires on mount and unmount and not on every render, and the callback identity
 * is memoised on `(put, id)`, so this settles after one extra render rather
 * than looping.
 *
 * The registry is `null` where nobody is collecting — the reading view with no
 * write path wired, and every test that renders a paragraph on its own.
 */
export interface Anchors {
  put: (id: string, el: HTMLElement | null) => void
}

export const Anchoring = createContext<Anchors | null>(null)

/**
 * The element Floating UI should treat as the edge of the world.
 *
 * The control renders in a portal at the end of `document.body`, which is what
 * frees it from the sheet's transform — and also frees it from the sheet's
 * clipping, which was doing real work. Without a boundary the card would be
 * kept inside the VIEWPORT, and this page is not the viewport: it is a module
 * on somebody else's canvas, routinely 220 pixels wide inside a window that is
 * not. A control shifted to fit the window would sit over the container next to
 * this one.
 *
 * So the scroll column is published here and handed to `collisionBoundary`.
 * Flipping above/below, shifting along the line, and the available width the
 * card bounds itself by are then all measured against the column the reader is
 * actually looking at.
 */
export const Reading = createContext<HTMLElement | null>(null)

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

/**
 * The control that answers one suggestion, pointing at the words it is about.
 *
 * ## What replaced two hand-rolled rules, and why the arithmetic is gone
 *
 * This used to be an absolutely-positioned box against the block row, and it
 * carried two pieces of geometry written by hand. Both are deleted, and the
 * deletion is the point of this component rather than a tidy-up.
 *
 * **It was positioned against the PARAGRAPH, at `bottom: 100%`.** That is what
 * the owner was looking at when they said it "is not positioned correctly": a
 * change to four words in the middle of the third line of a paragraph got a
 * control at the paragraph's top-left corner, which is the right block and the
 * wrong place, and at 220 pixels a paragraph is most of a visible page. Now the
 * anchor is the `<del>`/`<ins>` span itself — see `Anchoring` — so "above the
 * change" means above the change.
 *
 * **It was counter-scaled by hand.** The sheet is drawn at `transform:
 * scale(0.277)` at 220 pixels, so a control inside it drew at a quarter size,
 * and `paginated.tsx` published `--counter-scale` — the reciprocal — for this
 * box to multiply itself back up by, plus `--sheet-room` because a `max-width`
 * against the scaled sheet was four times too big. Both are gone, and there is
 * no reciprocal anywhere in this codebase now.
 *
 * The reason is the portal, and it is worth being precise about why it works
 * rather than treating it as magic. `PopoverContent` renders at the end of
 * `document.body`, outside the transformed subtree, so nothing scales it and it
 * inherits none of the sheet's custom properties. Floating UI positions it from
 * the anchor's `getBoundingClientRect`, which reports the element's rectangle
 * AFTER transforms — where the words really are on the reader's screen and how
 * big they really look. So the scaled side of the boundary is measured and the
 * unscaled side is drawn, and neither has to know about the other.
 *
 * **The manual flip is gone too.** There was a `side` prop — "the first block
 * on a sheet has nothing above it inside the page box, which clips, so its
 * control goes below" — decided from the packing because a measured flip would
 * have needed a layout pass. Floating UI takes that layout pass anyway, so the
 * flip is now `avoidCollisions` against the scroll column, which is both more
 * correct (it flips for the top of the COLUMN, not the top of a sheet) and
 * fewer props.
 *
 * ## What it must not do
 *
 * `modal={false}`, and then four dismissals prevented. This annotates a
 * document somebody is reading: it must not trap focus, must not make the page
 * inert, and must not steal the caret from a reader who has the pen out. It
 * must also not CLOSE — there is no trigger to open it again with, so a stray
 * click on the paper that dismissed the only way to answer a suggestion would
 * lose the suggestion until the paper was re-read. Escape, outside pointers,
 * outside focus and the open/close autofocus are all refused for that reason.
 *
 * That is most of Radix's popover behaviour turned off, and it is fair to ask
 * what is left. What is left is the part that could not be written by hand:
 * portalling, the anchor, collision detection against a scroll container, and
 * `hideWhenDetached`, which is how the card stops being drawn when the words it
 * points at have scrolled out of the column. A card still pointing confidently
 * at a paragraph that is no longer on screen is worse than no card.
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
 * cost of the portal rather than a preference: the card is no longer inside
 * `@container container`, so a `@sm/container:` rule in here would find no
 * container to measure and would never match. Wrapping is measured by the
 * content against the width Floating UI found, which needs no ancestor at all.
 */
export function ProposalControl({
  proposal,
  anchor,
  ordinal,
  total,
  decide,
  busy,
}: {
  proposal: Proposal
  /** The drawn change to point at, or `null` if the prose could not show it. */
  anchor: HTMLElement | null
  /** Which of the paper's waiting changes this is, counting down the paper. */
  ordinal: number
  /** How many are waiting on the whole paper. The chrome row's number. */
  total: number
  decide: (id: string, decision: Decision) => void
  busy: boolean
}) {
  const column = useContext(Reading)
  const counted = `${ordinal} of ${total}`
  return (
    <Popover open modal={false}>
      {/*
        With `virtualRef` given, Radix renders nothing here and measures the
        span instead. Without one — a suggestion the prose could not place
        honestly, which `segments.tsx` skips rather than draw a lie about — this
        div is the anchor, and it covers the block, so the control falls back to
        exactly the behaviour it had before: pinned to the paragraph, still
        answerable.
      */}
      <PopoverAnchor
        virtualRef={anchor ? { current: anchor } : undefined}
        aria-hidden
        className="pointer-events-none absolute inset-0"
      />
      <PopoverContent
        side="top"
        align="start"
        data-proposal={proposal.id}
        /* The column, not the window. See `Reading`. */
        collisionBoundary={column}
        collisionPadding={4}
        /* Stop being drawn when the words are no longer on screen. */
        hideWhenDetached
        /* An annotation, not a dialog. `role="dialog"` would make a screen
           reader announce a modal that is always open, once per suggestion. */
        role="group"
        aria-label={`Suggested change ${counted}: ${proposal.why}`}
        className="proposal-card"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
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
        <PopoverArrow width={10} height={5} />
      </PopoverContent>
    </Popover>
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
