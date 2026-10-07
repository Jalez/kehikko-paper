import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button.tsx'

import { json } from './api.ts'
import type { StartFrom } from './use-paper.ts'

/**
 * An epic with no paper, and the ways to give it one.
 *
 * Three, and all three are "files put in a folder that was not there": one of
 * the built-in starting points, a copy of a folder the person names — a venue's
 * template they downloaded, last year's paper — or nothing but an empty
 * article. None of them converts anything, and none of them can be aimed at a
 * paper that already exists; see `startPaper` in `store.ts`.
 */
export function Start({
  epic,
  where,
  onStart,
}: {
  epic: string
  where: string
  onStart(epic: string, from?: StartFrom): Promise<string | null>
}) {
  const [templates, setTemplates] = useState<{ id: string; name: string; about: string }[]>([])
  const [folder, setFolder] = useState('')
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stopped = false
    void json('/api/templates')
      .then((body) => {
        if (!stopped && Array.isArray(body.templates)) setTemplates(body.templates as { id: string; name: string; about: string }[])
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [])

  const go = async (from?: StartFrom) => {
    setBusy(true)
    setWhy('')
    const refused = await onStart(epic, from)
    setBusy(false)
    if (refused) setWhy(refused)
  }

  return (
    <div className="mt-2 text-[0.8rem]">
      <p className="text-muted-foreground mb-1">It would go here:</p>
      <p className="text-foreground mb-3 min-w-0 font-mono text-[0.72rem] break-all">{where}</p>

      <h3 className="mb-1 text-[0.8rem] font-medium">Start from a template</h3>
      <ul className="mb-3 grid gap-1.5">
        {templates.map((one) => (
          <li key={one.id}>
            <button
              type="button"
              disabled={busy}
              className="border-input hover:bg-accent w-full rounded border px-2 py-1.5 text-left disabled:opacity-50"
              onClick={() => void go({ template: one.id })}
            >
              <span className="block text-[0.8rem] font-medium">{one.name}</span>
              <span className="text-muted-foreground block text-[0.72rem] leading-snug">{one.about}</span>
            </button>
          </li>
        ))}
      </ul>

      <h3 className="mb-1 text-[0.8rem] font-medium">Or from a folder on this machine</h3>
      <p className="text-muted-foreground mb-1 text-[0.72rem] leading-snug">
        A template you downloaded, or another paper. It is copied; the folder itself is not touched. It needs a main.tex, or exactly one .tex
        with a \documentclass.
      </p>
      <form
        className="mb-3 flex flex-wrap gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (folder.trim()) void go({ folder: folder.trim() })
        }}
      >
        <input
          className="border-input bg-background min-w-0 flex-1 rounded border px-1.5 py-1 font-mono text-[0.72rem]"
          placeholder="/path/to/template"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          aria-label="Template folder"
        />
        <Button type="submit" variant="outline" size="container" className="h-auto" disabled={busy || !folder.trim()}>
          Copy it in
        </Button>
      </form>

      <button type="button" disabled={busy} className="text-muted-foreground text-[0.72rem] underline underline-offset-2" onClick={() => void go()}>
        Or start with an empty article
      </button>

      {why && (
        <p className="mt-2 text-[0.75rem]" role="alert" style={{ color: 'var(--gone)' }}>
          {why}
        </p>
      )}
    </div>
  )
}
