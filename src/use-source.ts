import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Proposal } from '../latex/propose.ts'
import type { Paper } from '../store.ts'
import { held } from 'kehikot-module-protocol/client'

import { hunksOf } from '../latex/hunks.ts'
import { mergeThree } from '../latex/merge.ts'
import { json, post, standingIn } from './api.ts'
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
  /** What this module publishes for the epic's parts changed with this save (`chapters.ts`). */
  published?: boolean
}

const MAIN = 'main.tex'

/**
 * What somebody typed and this page has not yet saved, kept across a reload of
 * the page itself.
 *
 * A save here waits most of a second for the typing to stop, and a save that
 * cannot land — this app's own server is restarting — waits longer. Three
 * things reload the page in that window and none can be caught in time: a page
 * that finds it is older than its server, the person, and Vite's own client,
 * which reloads the moment its dev server answers again. So the words are
 * written as they change, with the protocol's `held`, to this tab's
 * `sessionStorage`; nothing is sent anywhere.
 *
 * Keyed so they cannot land anywhere else: by the open project, and under it
 * by the epic and the file. And kept WITH the hash of the file they were typed
 * over, which is what makes putting them back honest. Back in the editor they
 * are an unsaved edit like any other, measured against that hash: if the file
 * on disk is still the one they were typed over they are saved a moment later,
 * and if somebody has written it since, that is the ordinary conflict — both
 * versions in front of the person, and nothing overwritten on their behalf.
 */
interface Unsaved {
  text: string
  hash: string
}

const unsaved = held<Unsaved>('kehikot.paper.unsaved', (stored) => {
  const one = stored as Partial<Unsaved> | null
  return one && typeof one === 'object' && typeof one.text === 'string' && typeof one.hash === 'string'
    ? { text: one.text, hash: one.hash }
    : null
})

const aimedAt = (epic: string, file: string) => `${epic}\u0000${file}`

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
  const [rev, setTick] = useState(0)
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
  /* One pause per file: typing in two regions of the continuous column must
     not let the second keystroke's timer swallow the first file's save. */
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const loading = useRef<Set<string>>(new Set())
  const saveFn = useRef<(name: string) => Promise<boolean>>(async () => true)
  const editRef = useRef<(text: string, name?: string) => void>(() => {})
  const conflictRef = useRef<Conflict | null>(null)
  conflictRef.current = conflict

  /* A different paper is a different set of buffers. Nothing typed for the
     last one is carried over; it was either saved or is the last paper's. */
  /** Hold a file's unsaved words, or forget them once they are what is saved. */
  const hold = useCallback((name: string) => {
    const on = epicRef.current
    const doc = docs.current.get(name)
    if (on === null || !doc) return
    unsaved.at(standingIn()).keep(aimedAt(on, name), doc.text === doc.saved ? null : { text: doc.text, hash: doc.hash })
  }, [])

  if (epicRef.current !== epic) {
    epicRef.current = epic
    docs.current = new Map()
    for (const one of timers.current.values()) clearTimeout(one)
    timers.current = new Map()
    loading.current = new Set()
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

  /** Read one file into the buffers, unless it is there or on its way. */
  const load = useCallback(
    (name: string) => {
      if (epic === null || docs.current.has(name) || loading.current.has(name)) return
      loading.current.add(name)
      void read(name)
        .then((got) => {
          loading.current.delete(name)
          if (!got || epicRef.current !== epic || docs.current.has(name)) return
          const typed = unsaved.at(standingIn()).read(aimedAt(epic, name))
          if (!typed || typed.text === got.text) {
            docs.current.set(name, { text: got.text, saved: got.text, hash: got.hash, eol: got.eol })
            hold(name)
          } else if (typed.hash === got.hash) {
            /* The file is the one these words were typed over: they are back in
               the editor, unsaved, and saved the way a keystroke would have been. */
            docs.current.set(name, { text: typed.text, saved: got.text, hash: got.hash, eol: got.eol })
            const was = timers.current.get(name)
            if (was) clearTimeout(was)
            timers.current.set(
              name,
              setTimeout(() => {
                timers.current.delete(name)
                void saveFn.current(name)
              }, saveDelay),
            )
          } else {
            /* Somebody has written the file since. Their version is not
               overwritten and these words are not dropped: it is a conflict. */
            docs.current.set(name, { text: typed.text, saved: got.text, hash: typed.hash, eol: got.eol })
            setConflict({ file: name, theirs: got.text, hash: got.hash, eol: got.eol })
          }
          redraw()
        })
        .catch((e) => {
          loading.current.delete(name)
          setFailure(`${name} could not be read: ${(e as Error).message}`)
        })
    },
    [epic, read, redraw, hold, saveDelay],
  )
  useEffect(() => {
    load(file)
  }, [load, file])

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
            /* Saved: nothing is held, unless more was typed while this went out. */
            hold(name)
            setFailure('')
            landed.current(body as Landed, name)
            return true
          }
          if (body.stale === true && typeof body.source === 'string' && typeof body.hash === 'string') {
            const theirs = toEditor(body.source)
            const merged = mergeThree(doc.saved, doc.text, theirs)
            if (merged !== null) {
              /* The disk moved between this editor's read and its save, in other lines than the ones typed: both kept. */
              docs.current.set(name, { text: doc.text, saved: theirs, hash: body.hash, eol: eolOf(body.source) })
              setChanged((was) => changedBy(name, doc.saved, theirs, was))
              setTaken((n) => n + 1)
              if (merged === doc.text) void saveFn.current(name)
              else editRef.current(merged, name)
              return false
            }
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
    [redraw, hold],
  )
  saveFn.current = saveNow

  const edit = useCallback(
    (text: string, name: string = file) => {
      const doc = docs.current.get(name)
      if (!doc || doc.text === text) return
      doc.text = text
      hold(name)
      redraw()
      const was = timers.current.get(name)
      if (was) clearTimeout(was)
      timers.current.set(
        name,
        setTimeout(() => {
          timers.current.delete(name)
          void saveNow(name).then(() => {
            /* Typed during the save: go again, after the same pause. */
            const now = docs.current.get(name)
            if (now && now.text !== now.saved && !conflictRef.current && !timers.current.has(name)) {
              timers.current.set(
                name,
                setTimeout(() => {
                  timers.current.delete(name)
                  void saveNow(name)
                }, saveDelay),
              )
            }
          })
        }, saveDelay),
      )
    },
    [file, redraw, saveDelay, saveNow, hold],
  )

  editRef.current = edit

  /** Save everything typed, now. True when the disk holds what the editor does. */
  const flush = useCallback(async (): Promise<boolean> => {
    for (const one of timers.current.values()) clearTimeout(one)
    timers.current.clear()
    let all = true
    for (const name of [...docs.current.keys()]) if (!(await saveNow(name))) all = false
    return all
  }, [saveNow])

  /* The disk moved. Compared by FETCHING, not by the poll's hash alone: the
     poll may have been answered before this page's own save landed, and its
     stale hash would otherwise read as somebody else's change. */
  /** What a read of one file found, taken: the disk's text if nothing is typed over it, a conflict if something is. */
  const take = useCallback(
    (name: string, got: { text: string; hash: string; eol: Eol }) => {
      const held = docs.current.get(name)
      if (!held || got.hash === held.hash) return
      if (held.text === held.saved) {
        docs.current.set(name, { text: got.text, saved: got.text, hash: got.hash, eol: got.eol })
        setChanged((was) => changedBy(name, held.text, got.text, was))
        setTaken((n) => n + 1)
        redraw()
        return
      }
      /* Both changed it. Where what each changed does not touch, both are kept:
         what was typed stays, what the disk has is added, and the whole is
         saved over the disk's version. Where it does, a person chooses. */
      const merged = mergeThree(held.saved, held.text, got.text)
      if (merged !== null) {
        docs.current.set(name, { text: held.text, saved: got.text, hash: got.hash, eol: got.eol })
        setChanged((was) => changedBy(name, held.saved, got.text, was))
        setTaken((n) => n + 1)
        if (merged === held.text) void saveFn.current(name)
        else editRef.current(merged, name)
        return
      }
      setConflict({ file: name, theirs: got.text, hash: got.hash, eol: got.eol })
    },
    [redraw],
  )
  /* Each read of a file is numbered, and only the last one asked for is
     taken: the poll's read and `fresh`'s can be out at once, and the older
     answer arriving second must not put the older text back. */
  const reads = useRef<Map<string, number>>(new Map())
  const reading = useCallback((name: string) => {
    const mine = (reads.current.get(name) ?? 0) + 1
    reads.current.set(name, mine)
    return () => reads.current.get(name) === mine
  }, [])
  useEffect(() => {
    if (!disk || epic === null) return
    let stopped = false
    for (const [name, doc] of docs.current) {
      const now = disk[name]
      if (!now || now === doc.hash || conflictRef.current?.file === name) continue
      const last = reading(name)
      void read(name)
        .then((got) => {
          if (stopped || !got || !last() || epicRef.current !== epic || inflight.current) return
          take(name, got)
        })
        .catch(() => {})
    }
    return () => {
      stopped = true
    }
  }, [disk, epic, read, reading, take])

  /**
   * Look at one file on disk NOW, and say whether the editor holds it.
   *
   * The poll above finds out that the disk moved within `POLL_MS` of it
   * moving, which is soon enough for a person and not for a pointer: a module
   * that rewrites a file and points at a passage in it does both in the same
   * moment, and its byte range is of the new file. Counted in the old text it
   * is other words — in the source, and on the PDF, which is OF the old text
   * and so looks entirely trustworthy (`pdfIsOf`). So whoever is about to act
   * on a place in a file that somebody else chose asks this first.
   *
   * `true`: the editor's text is what is on disk (or the disk could not be
   * asked, which is no reason to hold anything back). `false`: it was not —
   * and it has been taken exactly as the poll would have taken it, so the
   * page redraws with the new text, or with the conflict if something was
   * typed over the old one.
   */
  const fresh = useCallback(
    async (name: string): Promise<boolean> => {
      if (epic === null || !docs.current.has(name)) return false
      const last = reading(name)
      const got = await read(name).catch(() => null)
      if (!got) return true
      const held = docs.current.get(name)
      if (epicRef.current !== epic || !held) return false
      if (got.hash === held.hash) return true
      /* A save of this page's own is on its way: its landing settles what the file is. */
      if (!last() || inflight.current || conflictRef.current?.file === name) return false
      take(name, got)
      return false
    },
    [epic, read, reading, take],
  )

  const takeTheirs = useCallback(() => {
    const at = conflictRef.current
    if (!at) return
    const mine = docs.current.get(at.file)?.text
    docs.current.set(at.file, { text: at.theirs, saved: at.theirs, hash: at.hash, eol: at.eol })
    if (mine !== undefined) setChanged((was) => changedBy(at.file, mine, at.theirs, was))
    hold(at.file)
    setConflict(null)
    setTaken((n) => n + 1)
    redraw()
  }, [redraw, hold])

  const keepMine = useCallback(() => {
    const at = conflictRef.current
    if (!at) return
    const doc = docs.current.get(at.file)
    /* Mine is now measured against THEIR hash: the next save says "I have seen
       what is on disk, and this replaces it", which is what the person chose. */
    if (doc) {
      doc.hash = at.hash
      doc.saved = at.theirs
      hold(at.file)
    }
    conflictRef.current = null
    setConflict(null)
    void saveNow(at.file)
  }, [saveNow, hold])

  const doc = docs.current.get(file) ?? null
  let dirty = false
  for (const one of docs.current.values()) if (one.text !== one.saved) dirty = true
  const state: SaveState = saving ? 'saving' : failure || conflict ? 'failed' : dirty ? 'dirty' : 'saved'

  return useMemo(
    () => ({ file, open: setFile, doc, edit, flush, fresh, load, rev, state, failure, conflict, takeTheirs, keepMine, taken, changed, docs: docs.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file, doc, doc?.text, doc?.hash, edit, flush, fresh, load, rev, state, failure, conflict, takeTheirs, keepMine, taken, changed],
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
 * Where two texts first differ, as a range of the NEW one.
 *
 * ONE change, the first, and not the stretch from the first to the last: an
 * agent that edited a heading and a sentence three pages below it did not
 * change everything between them, and a mark on the PDF drawn over all of it
 * points at text nobody touched. The first change is where a person is taken;
 * the rest are walked to one at a time. Words, not lines: a changed word in a
 * long line is that word. Empty (`from === to`) when something was only taken
 * out there.
 */
export function changedBy(file: string, old: string, next: string, was: Changed | null): Changed | null {
  if (old === next) return was
  const first = hunksOf(old, next)[0]
  if (!first) return was
  return { file, from: first.newFrom, to: first.newTo, n: (was?.n ?? 0) + 1 }
}
