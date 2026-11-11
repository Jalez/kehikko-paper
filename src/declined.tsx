import { useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button.tsx'

import { DECLINE_REASON_MAX } from './editor/source-editor.tsx'
import type { Declined } from './use-paper.ts'

/** Who or what ended a suggestion, in words: three different things, never all called "declined" (#72). */
export function endedBy(one: Pick<Declined, 'how'>): string {
  if (one.how === 'superseded') return 'Set aside: it overlapped a change you accepted'
  if (one.how === 'withdrawn') return 'Withdrawn by the agent'
  return 'Declined by you'
}

/**
 * What became of suggestions lately, over the source: declined by the person,
 * set aside because the person accepted a change to the same words, or
 * withdrawn by the agent — each said as what it was (#72). The reason for
 * declining is asked on the suggestion's own tag when Decline is pressed; here
 * it can still be given or changed afterwards, and the agent that suggested it
 * reads it in `list_proposals` (and is told, where its host can).
 *
 * Each says where it was — the file and the section — and what it was, the
 * passage as quoted and as proposed, and Show goes back to the passage.
 *
 * Everything an agent wrote and everything the person wrote is drawn as text:
 * no markup, no link. A list the server stops sending (an hour after the
 * decision) is simply gone; Hide puts it away for this page.
 */
export function DeclinedList({
  list,
  onReason,
  sectionOf,
  onShow,
}: {
  list: readonly Declined[]
  /** Save (or clear, with '') the reason on a declined suggestion; true when it was kept. */
  onReason(id: string, reason: string): Promise<boolean>
  /** The title of the section a place in a file is in, or null. */
  sectionOf?(file: string, from: number): string | null
  /** Go back to the passage it was about. */
  onShow?(file: string, from: number): void
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const shown = list.filter((one) => !hidden.has(one.id))
  if (!shown.length) return null

  const edit = (one: Declined) => {
    setOpen(one.id)
    setText(one.reason)
  }
  const save = async (id: string) => {
    if (saving) return
    setSaving(true)
    try {
      if (await onReason(id, text.trim().slice(0, DECLINE_REASON_MAX))) setOpen(null)
    } finally {
      setSaving(false)
    }
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>, id: string) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void save(id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(null)
    }
  }
  const short = (words: string, room = 160) => {
    const one = words.replace(/\s+/g, ' ').trim()
    return one.length > room ? `${one.slice(0, room - 1)}…` : one || '(nothing)'
  }

  return (
    <section aria-label="Not accepted lately" className="shrink-0 border-b px-2 py-1 text-[0.72rem]" data-declined>
      <ul className="flex flex-col gap-0.5">
        {shown.map((one) => (
          <li key={one.id} className="flex flex-wrap items-baseline gap-x-1.5 py-0.5" data-declined-item={one.id} data-declined-how={one.how ?? 'declined'}>
            <span className="shrink-0 font-medium" data-declined-by>
              {endedBy(one)}
            </span>
            <code className="shrink-0 font-mono">{one.file}</code>
            {typeof one.from === 'number' && sectionOf?.(one.file, one.from) ? (
              <span className="text-muted-foreground shrink-0" data-declined-section>
                § {sectionOf(one.file, one.from)}
              </span>
            ) : null}
            {typeof one.from === 'number' && onShow ? (
              <Button variant="ghost" size="container" onClick={() => onShow(one.file, one.from!)} data-declined-show>
                Show
              </Button>
            ) : null}
            <span className="text-muted-foreground w-full min-w-0 [overflow-wrap:anywhere]" data-declined-change>
              <del className="decoration-muted-foreground/60">{short(one.old)}</del>
              {' → '}
              <span>{short(one.new)}</span>
              {one.count > 1 ? ` · ${one.count} changes` : ''}
            </span>
            {open === one.id ? (
              <span className="flex min-w-[12rem] flex-1 items-baseline gap-1">
                <input
                  type="text"
                  autoFocus
                  className="cm-sugg-decline-why min-w-0 flex-1"
                  placeholder="Why? (optional)"
                  aria-label="Why it was declined (optional)"
                  maxLength={DECLINE_REASON_MAX}
                  value={text}
                  data-declined-why={one.id}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => keys(event, one.id)}
                />
                <Button variant="outline" size="container" disabled={saving} onClick={() => void save(one.id)} data-declined-save>
                  Save
                </Button>
                <Button variant="ghost" size="container" onClick={() => setOpen(null)} data-declined-cancel>
                  Cancel
                </Button>
              </span>
            ) : (
              <>
                {(one.how ?? 'declined') !== 'declined' ? null : one.reason ? (
                  <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]" data-declined-reason>
                    “{one.reason}”
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">no reason given</span>
                )}
                {(one.how ?? 'declined') === 'declined' ? (
                  <Button variant="ghost" size="container" onClick={() => edit(one)} data-declined-edit>
                    {one.reason ? 'Edit reason' : 'Add reason'}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="container"
                  aria-label={`Hide: ${endedBy(one).toLowerCase()}, in ${one.file}`}
                  onClick={() => setHidden((was) => new Set([...was, one.id]))}
                  data-declined-hide
                >
                  Hide
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
