import { partsSetResult, type EpicPart } from 'kehikot-module-protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Paper } from '../store.ts'
import { json, post } from './api.ts'
import { chaptersOf, chaptersSaid, nameFor, partOfChapter, withChapter, type Chapters } from './chapters.ts'

/**
 * Setting which chapter is which part's, from the page.
 *
 * ## Until a person sets one, nothing of this module's is read
 *
 * `own` is this module's record for the epic (`chapters.ts`, on the server),
 * or null while it keeps none. While it is null the chapters are what the
 * parts the host sends say — and the page is narrowed by exactly those, so a
 * paper whose parts were given their chapters somewhere else keeps them with
 * nobody doing anything. Asking for the record writes nothing.
 *
 * The first time a person SETS a chapter, the whole of what the parts said is
 * sent with the one change, and that becomes the record: adopted once, on a
 * deliberate act, with every part's chapter and not only the one touched.
 *
 * ## Only with a host that keeps the parts
 *
 * A host that unions what modules publish also answers `parts.set`. One that
 * does not would leave a chapter set here unheard by everything else on the
 * canvas, and the control would be a switch wired to nothing. So the host is
 * asked once per paper, with an edit that cannot change anything — "move the
 * part called <an id no part of this epic has>", which a host that keeps the
 * parts answers `no-such-part` — and neither control is drawn unless it does.
 * An older host answers `unknown-method`; one that was not granted the
 * capability declines.
 */
export function useChapters({
  paper,
  parts,
  projectPath,
  hosted,
  request,
  say,
  sections,
}: {
  paper: Paper
  parts: readonly EpicPart[]
  projectPath: string | null
  /** Whether a host has greeted this page. */
  hosted: boolean
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** The page's one line of words, for a refusal. */
  say: (words: string) => void
  sections: readonly { file: string; title: string }[]
}) {
  const epic = paper.epic
  const [own, setOwn] = useState<{ epic: string; chapters: Chapters | null } | null>(null)
  const [edits, setEdits] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stopped = false
    void json('/api/chapters', { epic })
      .then((body) => {
        if (stopped || body.ok !== true) return
        const kept = body.chapters && typeof body.chapters === 'object' ? (body.chapters as Chapters) : null
        setOwn({ epic, chapters: kept })
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [epic])

  const partsRef = useRef(parts)
  partsRef.current = parts
  useEffect(() => {
    if (!hosted) return
    let stopped = false
    void request('parts.set', { epic, move: { id: noSuchPart(partsRef.current), after: null } })
      .then((answer) => {
        const said = partsSetResult.safeParse(answer)
        if (!stopped && said.success && said.data.outcome === 'no-such-part') setEdits(epic)
      })
      .catch(() => {})
    return () => {
      stopped = true
    }
  }, [epic, hosted, request])

  const can = hosted && edits === epic
  const kept = own?.epic === epic ? own.chapters : null
  const chapters = useMemo(() => kept ?? chaptersSaid(parts, paper, projectPath), [kept, parts, paper, projectPath])
  const candidates = useMemo(() => chaptersOf(paper), [paper])
  /* What gets a part of its own: a chapter with a heading in it. A file of macros or of tables that `main.tex` pulls in is no chapter of anything a person would pick. */
  const headed = useMemo(() => candidates.filter((file) => sections.some((section) => section.file === file)), [candidates, sections])

  const keep = useCallback(
    async (next: Chapters): Promise<void> => {
      const body = await post('/api/chapters', { epic }, { chapters: next })
      if (body.ok !== true) {
        say(String(body.error ?? 'The chapters could not be kept.'))
        return
      }
      setOwn({ epic, chapters: (body.chapters as Chapters | undefined) ?? next })
      /* What this module holds for the parts changed: the host reads it again and tells every container. */
      if (body.published === true) void request('content.changed', { epic }).catch(() => {})
    },
    [epic, request, say],
  )

  /** Make `file` the chapter of `part`, or of no part. A person's press. */
  const set = useCallback(
    async (part: string | null, file: string): Promise<void> => {
      if (busy) return
      setBusy(true)
      try {
        await keep(withChapter(chapters, part, file))
      } catch (e) {
        say(`The chapter could not be set: ${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [busy, chapters, keep, say],
  )

  /** Ask the host for a part for each chapter, in the paper's order, and file each chapter under the part it made. A person's press. */
  const each = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const next: Chapters = { ...chapters }
    try {
      for (const file of headed) {
        const said = partsSetResult.safeParse(await request('parts.set', { epic, add: { name: nameFor(file, sections) } }))
        if (said.success && said.data.outcome === 'changed' && said.data.id) next[said.data.id] = file
        else {
          say(said.success && said.data.why ? said.data.why : 'The host did not add a part.')
          break
        }
      }
      if (Object.keys(next).length) await keep(next)
    } catch (e) {
      say(`The parts could not be added: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [busy, chapters, headed, request, epic, sections, keep, say])

  return {
    busy,
    /** The part a file is the chapter of, as far as this page knows. */
    partOf: useCallback((file: string) => partOfChapter(chapters, file), [chapters]),
    /** Whether a file is one a person can make a part's chapter here: `main.tex` pulls it in, the epic has parts, and the host keeps them. */
    settable: useCallback((file: string) => can && parts.length > 0 && candidates.includes(file), [can, parts, candidates]),
    /** Whether "a part for each chapter" is offered: an epic with a paper and no parts, on a host that can add them. */
    offer: can && parts.length === 0 && headed.length > 0,
    set,
    each,
  }
}

/** An id no part of the epic has: what the host is asked about, so that asking changes nothing. The context lists every part. */
export function noSuchPart(parts: readonly EpicPart[]): string {
  let id = 'no-such-part'
  while (parts.some((part) => part.id === id)) id += '-x'
  return id
}
