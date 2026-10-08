import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Proposal } from '../latex/propose.ts'
import type { Paper } from '../store.ts'
import { json, post } from './api.ts'
import { eolOf, toDisk, toEditor, type Eol } from './lib/offsets.ts'

/**
 * The text of the paper's files as the editor holds them, and getting it to
 * disk without losing anybody's work — the person's here, or whoever else is
 * in the file.
 *
 * ## The file is the document; this is a buffer over it
 *
 * Nothing is kept anywhere but the `.tex` on disk. What this hook holds is what
 * an editor always holds — the text as last read, the text as now typed, and
 * the hash of what was read — and its whole job is the moment those disagree
 * with the disk.
 *
 * ## Saving
 *
 * A pause in typing saves (`saveDelay`), and so does ⌘S at once. A save sends
 * the whole file and the hash it was read at; the server writes to a temporary
 * and renames, or refuses because the file is no longer that hash and writes
 * nothing. One save is in flight at a time, and what was typed during it is
 * sent by the next.
 *
 * ## A file that moved on disk
 *
 * Somebody saved from another editor, an agent rewrote a paragraph, a
 * suggestion was accepted, `git checkout` changed branch. This hook learns it
 * two ways — the poll's hashes stop matching, or a save is refused — and does
 * one of two things:
 *
 *  - **Nothing typed here since the last save:** the disk's text is taken, at
 *    once and without asking. There is nothing of the person's to lose, and a
 *    stale editor is the only alternative.
 *  - **Something typed:** nothing is touched. Both versions exist and a person
 *    chooses — `takeTheirs` or `keepMine` — because either silent answer
 *    destroys somebody's sentence.
 */

export interface Doc {
  /** The editor's text: `\n` between lines whatever the file uses. */
  text: string
  /** The same, as of the last read or successful save. */
  saved: string
  /** What the file on disk hashed to then. Every save is measured against it. */
  hash: string
  eol: Eol
}

export interface Conflict {
  file: string
  /** The disk's text, as an editor holds it. */
  theirs: string
  hash: string
  eol: Eol
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'failed'

/** What a successful save or an accepted suggestion hands back, for whoever holds the paper's shape. */
export interface Landed {
  paper?: Paper
  proposals?: Proposal[]
  said?: string
}

const MAIN = 'main.tex'

export function useSource({
  paper,
  disk,
  onLanded,
  saveDelay = 900,
}: {
  paper: Paper | null
  /** What each file hashes to on disk now, from the poll. */
  disk: Record<string, string> | null
  /** A save reached the disk. */
  onLanded(landed: Landed, file: string): void
  saveDelay?: number
}) {
  const epic = paper?.epic ?? null
  const docs = useRef<Map<string, Doc>>(new Map())
  /* The buffers live in a ref — a save in flight must see what was typed
     during it — and this is the tick that redraws when one changes. */
  const [, setTick] = useState(0)
  const redraw = useCallback(() => setTick((n) => n + 1), [])
  const [file, setFile] = useState<string>(MAIN)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [failure, setFailure] = useState('')
  const [saving, setSaving] = useState(false)
  /** Bumped whenever the disk's text replaced the editor's, so the page knows to compile again. */
  const [taken, setTaken] = useState(0)
  /** What the last text taken from the disk changed: a file and a range of its NEW text, in characters. */
  const [changed, setChanged] = useState<Changed | null>(null)

  const epicRef = useRef(epic)
  const landed = useRef(onLanded)
  landed.current = onLanded
  const inflight = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conflictRef = useRef<Conflict | null>(null)
  conflictRef.current = conflict

  /* A different paper is a different set of buffers. Nothing typed for the
     last one is carried over; it was either saved or is the last paper's. */
  if (epicRef.current !== epic) {
    epicRef.current = epic
    docs.current = new Map()
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => {
    setFile(MAIN)
    setConflict(null)
    setFailure('')
  }, [epic])

  /* A file the paper stopped naming — its `\input` was deleted — cannot stay
     open: the write door refuses a file the paper does not name. */
  const files = paper?.files
  useEffect(() => {
    if (files && !files.includes(file)) setFile(MAIN)
  }, [files, file])

  const read = useCallback(
    async (name: string): Promise<{ text: string; hash: string; eol: Eol } | null> => {
      if (epic === null) return null
      const body = await json('/api/source', { epic, file: name })
      if (body.ok !== true || typeof body.source !== 'string' || typeof body.hash !== 'string') return null
      return { text: toEditor(body.source), hash: body.hash, eol: eolOf(body.source) }
    },
    [epic],
  )

  useEffect(() => {
    if (epic === null || docs.current.has(file)) return
    let stopped = false
    void read(file)
      .then((got) => {
        if (stopped || !got || epicRef.current !== epic) return
        docs.current.set(file, { text: got.text, saved: got.text, hash: got.hash, eol: got.eol })
        redraw()
      })
      .catch((e) => setFailure(`${file} could not be read: ${(e as Error).message}`))
    return () => {
      stopped = true
    }
  }, [epic, file, read, redraw])

  const saveNow = useCallback(
    async (name: string): Promise<boolean> => {
      /* Behind whatever is already going out, so two saves of one file cannot
         both be measured against the same hash. */
      while (inflight.current) await inflight.current.catch(() => false)
      const doc = docs.current.get(name)
      const on = epicRef.current
      if (!doc || on === null) return true
      if (doc.text === doc.saved) return true
      if (conflictRef.current?.file === name) return false

      const sending = doc.text
      const run = (async (): Promise<boolean> => {
        setSaving(true)
        try {
          const body = await post('/api/file', { epic: on }, { file: name, text: toDisk(sending, doc.eol), was: doc.hash })
          if (epicRef.current !== on) return false
          if (body.ok === true && typeof body.hash === 'string') {
            doc.hash = body.hash
            doc.saved = sending
            setFailure('')
            landed.current(body as Landed, name)
            return true
          }
          if (body.stale === true && typeof body.source === 'string' && typeof body.hash === 'string') {
            setConflict({ file: name, theirs: toEditor(body.source), hash: body.hash, eol: eolOf(body.source) })
            return false
          }
          setFailure(String(body.error ?? `${name} was not saved.`))
          return false
        } catch (e) {
          setFailure(`${name} could not be saved: ${(e as Error).message}`)
          return false
        } finally {
          setSaving(false)
          redraw()
        }
      })()
      inflight.current = run
      try {
        return await run
      } finally {
        if (inflight.current === run) inflight.current = null
      }
    },
    [redraw],
  )

  const edit = useCallback(
    (text: string) => {
      const doc = docs.current.get(file)
      if (!doc || doc.text === text) return
      doc.text = text
      redraw()
      if (timer.current) clearTimeout(timer.current)
      const name = file
      timer.current = setTimeout(() => {
        timer.current = null
        void saveNow(name).then(() => {
          /* Typed during the save: go again, after the same pause. */
          const now = docs.current.get(name)
          if (now && now.text !== now.saved && !conflictRef.current && timer.current === null) {
            timer.current = setTimeout(() => void saveNow(name), saveDelay)
          }
        })
      }, saveDelay)
    },
    [file, redraw, saveDelay, saveNow],
  )

  /** Save everything typed, now. True when the disk holds what the editor does. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    let all = true
    for (const name of [...docs.current.keys()]) if (!(await saveNow(name))) all = false
    return all
  }, [saveNow])

  /* The disk moved. Compared by FETCHING, not by the poll's hash alone: the
     poll may have been answered before this page's own save landed, and its
     stale hash would otherwise read as somebody else's change. */
  useEffect(() => {
    if (!disk || epic === null) return
    let stopped = false
    for (const [name, doc] of docs.current) {
      const now = disk[name]
      if (!now || now === doc.hash || conflictRef.current?.file === name) continue
      void read(name)
        .then((got) => {
          if (stopped || !got || epicRef.current !== epic || inflight.current) return
          const held = docs.current.get(name)
          if (!held || got.hash === held.hash) return
          if (held.text === held.saved) {
            docs.current.set(name, { text: got.text, saved: got.text, hash: got.hash, eol: got.eol })
            setChanged((was) => changedBy(name, held.text, got.text, was))
            setTaken((n) => n + 1)
            redraw()
            return
          }
          setConflict({ file: name, theirs: got.text, hash: got.hash, eol: got.eol })
        })
        .catch(() => {})
    }
    return () => {
      stopped = true
    }
  }, [disk, epic, read, redraw])

  const takeTheirs = useCallback(() => {
    const at = conflictRef.current
    if (!at) return
    const mine = docs.current.get(at.file)?.text
    docs.current.set(at.file, { text: at.theirs, saved: at.theirs, hash: at.hash, eol: at.eol })
    if (mine !== undefined) setChanged((was) => changedBy(at.file, mine, at.theirs, was))
    setConflict(null)
    setTaken((n) => n + 1)
    redraw()
  }, [redraw])

  const keepMine = useCallback(() => {
    const at = conflictRef.current
    if (!at) return
    const doc = docs.current.get(at.file)
    /* Mine is now measured against THEIR hash: the next save says "I have seen
       what is on disk, and this replaces it", which is what the person chose. */
    if (doc) {
      doc.hash = at.hash
      doc.saved = at.theirs
    }
    conflictRef.current = null
    setConflict(null)
    void saveNow(at.file)
  }, [saveNow])

  const doc = docs.current.get(file) ?? null
  let dirty = false
  for (const one of docs.current.values()) if (one.text !== one.saved) dirty = true
  const state: SaveState = saving ? 'saving' : failure || conflict ? 'failed' : dirty ? 'dirty' : 'saved'

  return useMemo(
    () => ({ file, open: setFile, doc, edit, flush, state, failure, conflict, takeTheirs, keepMine, taken, changed, docs: docs.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file, doc, doc?.text, doc?.hash, edit, flush, state, failure, conflict, takeTheirs, keepMine, taken, changed],
  )
}

/** A stretch of a file's text that the disk replaced. `n` counts them, so the same range twice is still news. */
export interface Changed {
  file: string
  from: number
  to: number
  n: number
}

/**
 * Where two texts differ, as a range of the NEW one.
 *
 * What they share at the front and at the back is set aside and the rest is
 * the change: one edit comes back as itself, several as the stretch from the
 * first to the last. Empty when something was only taken out. That is enough
 * to take a person to it, which is all this is for.
 */
export function changedBy(file: string, old: string, next: string, was: Changed | null): Changed | null {
  if (old === next) return was
  const most = Math.min(old.length, next.length)
  let front = 0
  while (front < most && old.charCodeAt(front) === next.charCodeAt(front)) front += 1
  let back = 0
  while (back < most - front && old.charCodeAt(old.length - 1 - back) === next.charCodeAt(next.length - 1 - back)) back += 1
  return { file, from: front, to: next.length - back, n: (was?.n ?? 0) + 1 }
}
