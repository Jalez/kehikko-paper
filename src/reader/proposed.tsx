import { createContext } from 'react'

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
 * it floats over the block it belongs to.
 *
 * ## And it is drawn TWICE, which is a decision rather than an oversight
 *
 * The same red and green appear in the floating control as well as in the
 * prose, and the reason is the width this module is actually read at. The sheet
 * is A4 scaled to the column: at 220 pixels the scale is 0.247 and the body
 * type draws at under four pixels. The inline diff is real, correctly placed
 * and completely illegible there. The control is counter-scaled — see
 * `--counter-scale` below — so its copy of the change is drawn at true size
 * whatever the page is doing, and at narrow widths it is the only readable one.
 *
 * At 1100 pixels the two agree and the duplication costs a line. At 220 it is
 * the difference between a feature and a decoration.
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
 */
export function Change({ was, now, className }: { was: string; now: string; className?: string }) {
  const ops = diffWords(was, now)
  return (
    <span className={cn('proposed-change', className)} data-proposed-change="">
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
 * The control that answers one suggestion, floating over the block it is about.
 *
 * ## Where it sits, and the two rules it has to keep
 *
 * **It must not cover the text it is about.** So it is absolutely positioned
 * against the block row, at `bottom: 100%` — entirely above the block, sharing
 * no pixel with it. What it does cover is whatever is above it, which is the
 * previous paragraph, and that is the right thing to hide: a floating control
 * has to hide something, and the only wrong choice is the thing it is asking
 * about.
 *
 * The exception is a block at the top of a sheet, where "above" is outside the
 * page box — and the page box clips, deliberately, for a reason `paginated.tsx`
 * argues about phantom width. There the control goes below instead. Which block
 * is first on its sheet is known by the packing rather than measured, so this
 * is a prop and not a `getBoundingClientRect`: a measured flip would need a
 * layout pass this module does not otherwise take, and would be untestable
 * without a browser.
 *
 * **It must work at 220 pixels.** Two things follow. The group wraps, because
 * `Accept` and `Reject` and a sentence do not fit on one line of a column that
 * narrow. And the whole control is counter-scaled: it lives inside a sheet
 * being drawn at `scale(0.247)`, so without `scale(var(--counter-scale))` — the
 * reciprocal, set on the sheet by `paginated.tsx` — its type would be drawn at
 * under four pixels along with the paper's. Counter-scaled, one CSS pixel here
 * is one real pixel on screen at every width, which is what a control has to be
 * and a document has to not be.
 *
 * `--sheet-room` is the column's width in real pixels, set beside it, so the
 * control can be bounded by the container rather than by the sheet it is drawn
 * on. Those are the same number at scale 1 and very different at 0.247.
 *
 * ## Accept and Reject, and where Accept all is not
 *
 * Two buttons, because there are two answers. `Accept all` is deliberately NOT
 * here and is in the row beside the Edit checkbox instead: a button meaning
 * "and the other four as well" repeated above each of five changes is five
 * controls each claiming to speak for all of them, and pressing the one above
 * the paragraph you were reading would apply four changes you have not scrolled
 * to. It belongs with the count of what is waiting, which is chrome.
 */
export function ProposalControl({
  proposal,
  side,
  decide,
  busy,
}: {
  proposal: Proposal
  side: 'above' | 'below'
  decide: (id: string, decision: Decision) => void
  busy: boolean
}) {
  return (
    <div
      data-proposal={proposal.id}
      data-approval-side={side}
      className={cn(
        'proposal-control absolute left-0 z-20',
        side === 'above' ? 'bottom-full origin-bottom-left' : 'top-full origin-top-left',
      )}
    >
      <div className="proposal-card">
        <p className="proposal-why">{proposal.why}</p>
        <p className="proposal-diff">
          <Change was={proposal.was_text} now={proposal.text} />
        </p>
        <ButtonGroup label={`Answer the suggested change: ${proposal.why}`} className="mt-1">
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
      </div>
    </div>
  )
}
