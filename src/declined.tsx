import { useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button.tsx'

import { DECLINE_REASON_MAX } from './editor/source-editor.tsx'
import type { Declined } from './use-paper.ts'

/**
 * The suggestions the person declined lately, over the source, so a reason
 * can be given after the decision or changed: the agent that suggested one
 * reads it in `list_proposals` (and is told, where its host can).
 *
 * Everything an agent wrote and everything the person wrote is drawn as text:
 * no markup, no link. A list the server stops sending (an hour after the
 * decision) is simply gone; Hide puts it away for this page.
 */
export function DeclinedList({
  list,
  onReason,
}: {
  list: readonly Declined[]
  /** Save (or clear, with '') the reason on a declined suggestion; true when it was kept. */
  onReason(id: string, reason: string): Promise<boolean>
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
  const short = (words: string) => {
    const one = words.replace(/\s+/g, ' ').trim()
    return one.length > 60 ? `${one.slice(0, 59)}…` : one || '(nothing)'
  }

  return (
    <section aria-label="Declined lately" className="shrink-0 border-b px-2 py-1 text-[0.72rem]" data-declined>
      <ul className="flex flex-col gap-0.5">
        {shown.map((one) => (
          <li key={one.id} className="flex flex-wrap items-baseline gap-x-1.5" data-declined-item={one.id}>
            <span className="text-muted-foreground shrink-0">Declined</span>
            <code className="shrink-0 font-mono">{one.file}</code>
            <span className="text-muted-foreground min-w-0 truncate" title={`${one.old} → ${one.new}`}>
              {short(one.old)} → {short(one.new)}
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
                {one.reason ? (
                  <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]" data-declined-reason>
                    “{one.reason}”
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">no reason given</span>
                )}
                <Button variant="ghost" size="container" onClick={() => edit(one)} data-declined-edit>
                  {one.reason ? 'Edit reason' : 'Add reason'}
                </Button>
                <Button
                  variant="ghost"
                  size="container"
                  aria-label={`Hide: declined change in ${one.file}`}
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
