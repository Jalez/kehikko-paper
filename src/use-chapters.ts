import { partsSetResult, type EpicPart } from 'kehikot-module-protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Paper } from '../store.ts'
import { json, post } from './api.ts'
import { chaptersOf, chaptersSaid, moveOf, movedWords, nameFor, partOfChapter, withChapter, type Chapters } from './chapters.ts'

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
 * canvas, and the control would be a switch wired to nothing. A host from
 * protocol 1.4.0 says so in its greeting (`answers`), and nothing is asked.
 * An older one is asked, with an edit that cannot change anything — "move the part called <an
 * id no part of this epic has>", which a host that keeps the parts answers
 * `no-such-part` — and neither control is drawn unless it does. An older host
 * answers `unknown-method`; one that was not granted the capability declines.
 *
 * Asked ONCE (`keepsParts`): it is a fact about the host, not about the epic
 * or about this mount of the page, so one page load asks at most once however
 * many times React runs the effect, and a host that said yes is not asked
 * again for as long as the tab lives.
 *
 * ## A press never quietly takes a chapter from another part
 *
 * `withChapter` swaps where it can; where it cannot, the option said so
 * before it was pressed (`header.ts`), and either way the page's line says
 * what else moved (`movedWords`).
 */
export function useChapters({
  paper,
  parts,
  projectPath,
  hosted,
  answers,
  request,
  say,
  sections,
}: {
  paper: Paper
  parts: readonly EpicPart[]
  projectPath: string | null
  /** Whether a host has greeted this page. */
  hosted: boolean
  /** The methods the host said it answers for this module; null from a host that does not say, which is asked once instead. */
  answers: readonly string[] | null
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** The page's one line of words, for a refusal. */
  say: (words: string | ((now: string) => string)) => void
  sections: readonly { file: string; title: string }[]
}) {
  const epic = paper.epic
  const [own, setOwn] = useState<{ epic: string; chapters: Chapters | null } | null>(null)
  const [edits, setEdits] = useState(false)
  const [busy, setBusy] = useState(false)
  /** The sentence last said here about a chapter that moved. */
  const spoke = useRef<string | null>(null)
  const fading = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(fading.current), [])

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
    /* The greeting says (1.4.0): nothing is asked. Only a host that does not say is probed. */
    if (answers) {
      setEdits(answers.includes('parts.set'))
      return
    }
    let stopped = false
    void keepsParts(epic, partsRef.current, request).then((keeps) => {
      if (!stopped) setEdits(keeps)
    })
    return () => {
      stopped = true
    }
  }, [epic, hosted, request, answers])

  const can = hosted && edits
  const kept = own?.epic === epic ? own.chapters : null
  const chapters = useMemo(() => kept ?? chaptersSaid(parts, paper, projectPath), [kept, parts, paper, projectPath])
  const candidates = useMemo(() => chaptersOf(paper), [paper])
  /* What gets a part of its own: a chapter with a heading in it. A file of macros or of tables that `main.tex` pulls in is no chapter of anything a person would pick. */
  const headed = useMemo(() => candidates.filter((file) => sections.some((section) => section.file === file)), [candidates, sections])

  const keep = useCallback(
    async (next: Chapters): Promise<boolean> => {
      const body = await post('/api/chapters', { epic }, { chapters: next })
      if (body.ok !== true) {
        say(String(body.error ?? 'The chapters could not be kept.'))
        return false
      }
      setOwn({ epic, chapters: (body.chapters as Chapters | undefined) ?? next })
      /* What this module holds for the parts changed: the host reads it again and tells every container. */
      if (body.published === true) void request('content.changed', { epic }).catch(() => {})
      return true
    },
    [epic, request, say],
  )

  /** Make `file` the chapter of `part`, or of no part. A person's press. */
  const set = useCallback(
    async (part: string | null, file: string): Promise<void> => {
      if (busy) return
      setBusy(true)
      /* Read before the change: which chapter the part had, and where it is going. */
      const heading = (id: string) => partsRef.current.find((one) => one.id === id)?.heading || id
      const words = part === null ? null : movedWords(file, part, moveOf(chapters, part, file), heading)
      try {
        if (await keep(withChapter(chapters, part, file))) {
          /* Said when another chapter moved, and at no other time. The line it
             is said in is a row of the page, so it is given back: after a
             while, or at once by a later press that moved nothing — and only
             ever this sentence, never something else said since. */
          const was = spoke.current
          const down = (sentence: string) => say((now) => (now === sentence ? '' : now))
          clearTimeout(fading.current)
          spoke.current = words
          if (words !== null) {
            say(words)
            fading.current = setTimeout(() => {
              if (spoke.current === words) spoke.current = null
              down(words)
            }, LINGER.ms)
          } else if (was !== null) down(was)
        }
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
    /** What giving a file to a part would do to the chapter that part has now: see `moveOf`. */
    moveOf: useCallback((part: string, file: string) => moveOf(chapters, part, file), [chapters]),
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

/** How long the sentence about a chapter that moved stands before its row is given back. An object, so a test need not wait it out. */
export const LINGER = { ms: 12_000 }

/** Where the answer is kept for the tab: one key per host, so another host in the same tab is asked for itself. */
const KEPT = 'kehikot.paper.keeps-parts:'

/** The host this page is framed by, as far as a page can name it: the origin of the page around it. `''` when it cannot. */
function hostName(): string {
  try {
    const above = window.location.ancestorOrigins?.[0]
    if (above) return above
    return document.referrer ? new URL(document.referrer).origin : ''
  } catch {
    return ''
  }
}

/** What this page load has learned or is learning: yes for the host, and the question in flight for an epic. */
let keeps = false
const asking = new Map<string, Promise<boolean>>()

/**
 * Whether the host keeps the parts — asked at most once.
 *
 * A yes is the host's, whatever the epic: it is remembered for the page load
 * and, under the host's own name, for the tab (`sessionStorage`), so a reload
 * and a second paper ask nothing. A no is remembered for the page load and for
 * that epic only — a host may decline for one epic and not for another, and
 * one that is granted the capability later should not be held to its first
 * answer by a tab that was open at the time.
 */
export function keepsParts(epic: string, parts: readonly EpicPart[], request: (method: string, params?: Record<string, unknown>) => Promise<unknown>): Promise<boolean> {
  const host = hostName()
  if (!keeps && host) {
    try {
      keeps = window.sessionStorage.getItem(KEPT + host) === '1'
    } catch {
      /* A page that may keep nothing asks once a load, which is all this saves. */
    }
  }
  if (keeps) return Promise.resolve(true)
  const flying = asking.get(epic)
  if (flying) return flying
  const asked = request('parts.set', { epic, move: { id: noSuchPart(parts), after: null } })
    .then((answer) => {
      const said = partsSetResult.safeParse(answer)
      if (!said.success || said.data.outcome !== 'no-such-part') return false
      keeps = true
      if (host) {
        try {
          window.sessionStorage.setItem(KEPT + host, '1')
        } catch {
          /* As above. */
        }
      }
      return true
    })
    .catch(() => false)
  asking.set(epic, asked)
  return asked
}

/**
 * Forget what was learned about the host: a test's, which stands a different
 * host behind the same page. `tab: false` forgets only what a page load holds,
 * which is what a reload does.
 */
export function forgetHost({ tab = true }: { tab?: boolean } = {}): void {
  keeps = false
  asking.clear()
  if (!tab) return
  try {
    for (let i = window.sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = window.sessionStorage.key(i)
      if (key?.startsWith(KEPT)) window.sessionStorage.removeItem(key)
    }
  } catch {
    /* Nothing was kept. */
  }
}
