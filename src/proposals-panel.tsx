import { useMemo } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'

import { diffWords } from '../latex/diff.ts'
import type { Proposal } from '../latex/propose.ts'

/**
 * The changes an agent suggested, each as a diff of the `.tex`.
 *
 * ## A diff of the source, because the source is what is on screen
 *
 * A suggestion used to be drawn INTO rendered prose, green and red among the
 * words, which is why it could only ever be about prose. The page shows the
 * file now, so a suggestion is shown as what it is: these characters of this
 * file leave, these arrive, and here is the sentence the agent gave for why.
 * The window drawn is the text the agent QUOTED, not only the characters that
 * differ, so a one-word change is read inside its sentence.
 *
 * ## The only door to the file is a person pressing Accept
 *
 * Nothing in this component writes. Accept and Reject call back to
 * `use-paper.ts`, which posts to a door that demands this page's ticket; the
 * MCP door that filed the suggestion has no tool that reaches that door and
 * no argument that skips it. `Auto` is the person saying yes in advance, here,
 * for this paper, on this machine — remembered in this browser and nowhere an
 * agent can set it.
 */
export function ProposalsPanel({
  proposals,
  busy,
  auto,
  onAuto,
  onDecide,
  onAcceptAll,
  onShow,
}: {
  proposals: readonly Proposal[]
  busy: boolean
  auto: boolean
  onAuto(on: boolean): void
  onDecide(id: string, decision: 'accept' | 'reject'): void
  onAcceptAll(): void
  /** Take the editor to where this one would land. */
  onShow(proposal: Proposal): void
}) {
  if (!proposals.length) return null
  return (
    <section className="proposals shrink-0 border-b" aria-label="Suggested changes">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-[0.72rem]">
        <strong className="font-medium">
          {proposals.length === 1 ? '1 suggested change' : `${proposals.length} suggested changes`}
        </strong>
        <span className="flex-1" />
        <label className="text-muted-foreground flex items-center gap-1" title="Accept suggestions for this paper as they arrive">
          <Checkbox size="container" checked={auto} onCheckedChange={(on) => onAuto(on === true)} />
          Auto
        </label>
        {proposals.length > 1 && (
          <Button variant="outline" size="container" disabled={busy} onClick={onAcceptAll}>
            Accept all
          </Button>
        )}
      </header>
      <ul className="max-h-[38cqh] overflow-auto">
        {proposals.map((proposal) => (
          <One key={proposal.id} proposal={proposal} busy={busy} onDecide={onDecide} onShow={onShow} />
        ))}
      </ul>
    </section>
  )
}

function One({
  proposal,
  busy,
  onDecide,
  onShow,
}: {
  proposal: Proposal
  busy: boolean
  onDecide(id: string, decision: 'accept' | 'reject'): void
  onShow(proposal: Proposal): void
}) {
  const ops = useMemo(
    () => diffWords(proposal.asked?.find ?? proposal.was_text, proposal.asked?.replace ?? proposal.text),
    [proposal],
  )
  return (
    <li className="border-t px-2 py-1.5 text-[0.72rem]" data-proposal={proposal.id}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <button type="button" className="font-mono underline-offset-2 hover:underline" onClick={() => onShow(proposal)} title="Show where in the source">
          {proposal.file}
        </button>
        <span className="text-muted-foreground min-w-0 flex-1">{proposal.why}</span>
      </div>
      <pre className="proposal-diff mb-1.5 rounded border px-1.5 py-1 font-mono text-[0.7rem] leading-snug whitespace-pre-wrap">
        {ops.map((op, i) =>
          op.type === 'equal' ? (
            <span key={i}>{op.text}</span>
          ) : op.type === 'removed' ? (
            <del key={i} className="diff-gone">
              {op.text}
            </del>
          ) : (
            <ins key={i} className="diff-arrived">
              {op.text}
            </ins>
          ),
        )}
      </pre>
      <div className="flex gap-1">
        <Button size="container" disabled={busy} onClick={() => onDecide(proposal.id, 'accept')}>
          Accept
        </Button>
        <Button variant="outline" size="container" disabled={busy} onClick={() => onDecide(proposal.id, 'reject')}>
          Reject
        </Button>
      </div>
    </li>
  )
}
