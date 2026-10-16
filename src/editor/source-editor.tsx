import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { historyField } from '@codemirror/commands'
import { EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import CodeMirror, { ExternalChange, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'

/**
 * The `.tex` file, in an editor.
 *
 * ## Why CodeMirror 6, and what was weighed
 *
 * The page needs four things of an editor: LaTeX that reads as LaTeX, a
 * selection it can be told about in character offsets, decorations it can draw
 * for somebody else's anchor and for the line an engine complained about, and
 * to behave in a container 220 pixels wide.
 *
 *  - **A `<textarea>`** costs nothing and gives none of the middle two: no
 *    highlighting, and no way to mark a range that is not the selection.
 *  - **Monaco** is the editor people mean by "like VS Code", and it is two to
 *    four megabytes with its workers, has no LaTeX grammar of its own, and was
 *    built for a window rather than a panel.
 *  - **CodeMirror 6** is around 150 kB gzipped with everything used here, is
 *    made of extensions so nothing unused ships, and is what the Slides module
 *    beside this one already edits its decks in — through the same
 *    `@uiw/react-codemirror` wrapper — so a person moving between the two
 *    panels meets one editor with one set of keys.
 *
 * The LaTeX highlighting is CodeMirror's port of the `stex` mode: a tokenizer,
 * not a parser. It colours commands, braces, maths and comments, and it does
 * not understand the document — which is fine, because understanding the
 * document is the engine's job and its verdict is drawn here as `problems`.
 *
 * ## The narrow prop set is on purpose
 *
 * The page's logic — caret to section, anchor to mark, error to line — is
 * tested with a plain textarea standing in for this component, because
 * CodeMirror does not lay out in a DOM that has no layout. So everything the
 * page needs crosses this boundary as plain numbers: offsets into `value`,
 * never a CodeMirror type.
 */
export interface EditorProps {
  value: string
  onChange(text: string): void
  /** The selection moved, or the text under it changed. Offsets into `value`; `from === to` is a caret. */
  onSelect(selection: { from: number; to: number }): void
  /** ⌘S / Ctrl-S. */
  onSave(): void
  /** Go there, once per new `nonce`: scroll it into view and put the caret (or, with `select`, the selection) on it. */
  /** With `keep`, only scroll there: the caret and selection are the person's and stay where they put them. */
  /** With `top`, that offset is put at the top of the editor instead of the range in its middle: a place being put back. */
  /** And with `past`, the row it is on is put that many pixels above the top, as it was: see `onScrolled`. */
  jump: { from: number; to: number; nonce: number; select?: boolean; focus?: boolean; keep?: boolean; top?: number; past?: number } | null
  /**
   * The editor was scrolled: the offset now at its top, and how many pixels of
   * the row that offset is on are above the top. Never said by an editor that
   * is not laid out.
   *
   * The second number is what makes a place put back the SAME place. An offset
   * names a row, and a scroll rarely stops on a row's edge: put back by the
   * offset alone, the editor came back with that row whole — up to a row's
   * height short of where it had been, every time.
   */
  onScrolled?(top: number, past: number): void
  /** A range somebody ELSE pointed at — a note's anchor, a question's — drawn without touching the selection. */
  mark: { from: number; to: number } | null
  /**
   * Suggestions drawn IN the text, where they sit: the passage marked, and
   * either left as it is (`after: false`) or shown as it would read with the
   * change (`after: true`) — the document itself is never touched. Only
   * content is drawn here: the mark, the toggle between the two readings, the
   * agent's reason and the author's edit field. Answering one is the host's
   * header, not a button in this page.
   */
  suggestions?: readonly InlineSuggestion[]
  /** The author's drafts of suggested text, by suggestion id: read when a field is drawn, written as it is typed. */
  drafts?: Map<string, string>
  /** Switch a suggestion (by stop key) between the current and the proposed reading. */
  onToggleSuggestion?(key: string): void
  /** Accept change / Cancel change on a tag: answers THAT suggestion (its group, by stop key), not the current one. `confirm` is said by the second press that deletes a new file. */
  onAnswerSuggestion?(key: string, decision: 'accept' | 'reject', confirm?: boolean): void
  /** Show the next version of a passage that has several (two filers, or a suggestion and a change in the file). */
  onVersion?(key: string): void
  /** The author wrote (or changed) the reason on a tag: saved beside the change, by its id. */
  onWhy?(id: string, why: string): void
  /** The author pressed on a marked passage: it becomes the one answered. */
  onPickSuggestion?(id: string): void
  /**
   * Enter ('accept') or Escape ('reject') with the editor focused: true when
   * the page took it (an armed suggestion, the caret inside it), so the key is
   * consumed and nothing else handles it; false leaves it to the editor.
   */
  onArmedKey?(decision: 'accept' | 'reject'): boolean
  /** The editor lost focus: the keys above are not the person's to give. */
  onDisarm?(): void
  /** Escape in the author's edit box: stop editing, reject nothing. */
  onStopEditing?(): void
  /** One-based lines the engine complained about. */
  problems: readonly { line: number; severity: 'error' | 'warning'; message: string }[]
  theme: 'light' | 'dark'
  /**
   * One of several editors stacked in the continuous column (`source-column.tsx`):
   * it is as tall as its text and does not scroll itself; the column's scroller
   * does, and `onScrolled` is said while the top of THAT is inside this editor.
   */
  embedded?: boolean
  /**
   * Where the editor's last state is kept for the file, so that undo survives
   * the editor being unmounted (a region scrolled far away) and mounted again.
   * Kept in memory only; the page drops a file's entry when the disk's text
   * replaces the editor's.
   */
  memory?: { state: Map<string, EditorState>; key: string; control?: Map<string, EditorControl> }
  /** The nonce of the last jump this editor's file has landed, kept by the page: an editor mounted again does not land it twice. */
  landed?: { current: number }
}

/**
 * What the page may ask an open editor to do on its own behalf: put text back
 * as one undoable step (Cancel on a change that is already in the file), so
 * that the person's own history holds it and nothing is replaced under them.
 */
export interface EditorControl {
  /** All of these, in one transaction: one step of undo. Offsets into the text as it is now. */
  replace(changes: readonly { from: number; to: number; insert: string }[]): void
}

/** The height, in pixels, of the boundary label that lies over the top of the column: a row put at the top is put under it. */
export const EMBED_TOP = 16

export type Editor = ComponentType<EditorProps>

/** A suggestion as the editor draws it: offsets into `value`, never a CodeMirror type. */
export interface InlineSuggestion {
  id: string
  /** Shared by the members of a group, which are toggled together. */
  key: string
  from: number
  to: number
  /** What would stand where `from..to` is. */
  replacement: string
  after: boolean
  current: boolean
  /** The person pressed on it: Enter accepts, Escape cancels, and the tag says so. */
  armed: boolean
  why: string
  revisions: number
  /** Members of its group (1 = not in one). The tag is drawn on the first only. */
  count: number
  tag: boolean
  editing: boolean
  /** What the agent proposed, to tell an adjusted draft from it. */
  proposed: string
  /**
   * What is being reviewed:
   *  - `staged`: an agent's suggestion; the file does not hold it yet. The
   *    marked passage is what the file holds, `replacement` what would stand there.
   *  - `disk`: a change already in the file. The marked passage is what the file
   *    holds now; `replacement` is what the baseline had there.
   *  - `new`: a whole new file (nothing is marked; the tag stands at the top).
   */
  kind: 'staged' | 'disk' | 'new'
  /** The quoted text changed since it was suggested: Accept is held back; Cancel is not. */
  held?: 'changed' | 'ambiguous'
  /** When a change on disk was found (ms), for the tag. */
  found: number
  /** Versions of one passage: how many, and which this is. Answering the item answers them all; Accept takes the one shown. */
  versions?: number
  version?: number
  /** The author changed the reason or the new text. */
  adjusted: boolean
}

type Suggesting = {
  list: readonly InlineSuggestion[]
  drafts: Map<string, string>
  toggle(key: string): void
  answer(key: string, decision: 'accept' | 'reject', confirm?: boolean): void
  draft(id: string, text: string): void
  why(id: string, text: string): void
  version(key: string): void
  stopEditing(): void
  /** A press on the proposed text shown in place: the caret goes into the passage, and it is armed. */
  pick(id: string, withCaret: boolean): void
}
const setSuggestions = StateEffect.define<Suggesting>()

class ProposedWidget extends WidgetType {
  constructor(
    readonly one: InlineSuggestion,
    readonly on: Suggesting,
  ) {
    super()
  }
  eq(other: ProposedWidget): boolean {
    return (
      other.one.id === this.one.id &&
      other.one.replacement === this.one.replacement &&
      other.one.editing === this.one.editing &&
      other.one.current === this.one.current &&
      other.one.kind === this.one.kind
    )
  }
  toDOM(): HTMLElement {
    const { one, on } = this
    const span = document.createElement('span')
    span.className = `cm-sugg-after${one.current ? ' cm-sugg-current' : ''}${one.kind === 'disk' ? ' cm-sugg-old' : ''}`
    span.setAttribute('data-sugg', one.id)
    span.setAttribute('data-sugg-after', '')
    /* The editor ignores events from a widget (`ignoreEvent`), so its own
       mousedown handler never sees a press here: the widget says it itself. A
       press in the edit box leaves the box its focus. */
    span.addEventListener('mousedown', (event) => {
      const inBox = event.target instanceof Element && event.target.closest('textarea') !== null
      if (!inBox) event.preventDefault()
      on.pick(one.id, !inBox)
    })
    /* What the baseline had (a change already in the file) is only shown. The
       words an agent suggested are a live field: typing in it changes what
       Accept will apply, and Header → Edit just puts the caret in it. */
    if (one.kind !== 'staged' || one.held) {
      span.textContent = one.replacement
      return span
    }
    const area = document.createElement('textarea')
    area.className = 'cm-sugg-edit'
    area.setAttribute('aria-label', 'Proposed text, editable')
    area.setAttribute('data-sugg-edit', one.id)
    area.value = on.drafts.get(one.id) ?? one.replacement
    area.rows = Math.min(10, Math.max(1, area.value.split('\n').length))
    area.addEventListener('input', () => {
      on.drafts.set(one.id, area.value)
      on.draft(one.id, area.value)
      const mark = area.ownerDocument.querySelector(`[data-sugg-tag="${CSS.escape(one.id)}"] .cm-sugg-adj`)
      if (mark instanceof HTMLElement) mark.hidden = area.value === one.proposed && !one.adjusted
    })
    span.append(area)
    const grow = () => {
      area.style.height = 'auto'
      area.style.height = `${area.scrollHeight + 2}px`
    }
    area.addEventListener('input', grow)
    /* A text field: Enter is a newline. Cmd/Ctrl+Enter accepts the edited text;
       Escape leaves the field and rejects nothing. */
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        on.answer(one.key, 'accept')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        on.stopEditing()
        area.blur()
      }
    })
    queueMicrotask(() => {
      if (!area.isConnected) return
      grow()
      if (one.editing) area.focus()
    })
    return span
  }
  ignoreEvent(): boolean {
    return true
  }
}

export class TagWidget extends WidgetType {
  constructor(
    readonly one: InlineSuggestion,
    readonly on: Suggesting,
  ) {
    super()
  }
  eq(other: TagWidget): boolean {
    const a = this.one
    const b = other.one
    return (
      a.id === b.id && a.after === b.after && a.current === b.current && a.armed === b.armed && a.why === b.why &&
      a.revisions === b.revisions && a.count === b.count && a.editing === b.editing && a.held === b.held &&
      a.adjusted === b.adjusted && a.kind === b.kind && a.found === b.found && a.versions === b.versions && a.version === b.version
    )
  }
  /* A tag whose reason changed is patched, not rebuilt: a field the person is
     typing in must not be replaced under their hands by their own save. */
  updateDOM(dom: HTMLElement): boolean {
    const field = dom.querySelector<HTMLInputElement>('input.cm-sugg-why-edit')
    const here = this.one
    if (!field || dom.getAttribute('data-sugg-tag') !== here.id) return false
    if (dom.classList.contains('cm-sugg-armed') !== here.armed || dom.classList.contains('cm-sugg-current') !== here.current) return false
    const anew = dom.getAttribute('data-sugg-state') !== `${here.after}|${here.held ?? ''}|${here.adjusted}|${here.count}|${here.revisions}|${here.kind}|${here.editing}`
    if (anew) return false
    if (document.activeElement !== field && field.value !== here.why) field.value = here.why
    return true
  }
  toDOM(): HTMLElement {
    const { one, on } = this
    const tag = document.createElement('span')
    tag.className = `cm-sugg-tag${one.current ? ' cm-sugg-current' : ''}${one.armed ? ' cm-sugg-armed' : ''}`
    tag.setAttribute('data-sugg-tag', one.id)
    tag.setAttribute('data-sugg-kind', one.kind)
    tag.setAttribute('data-sugg-state', `${one.after}|${one.held ?? ''}|${one.adjusted}|${one.count}|${one.revisions}|${one.kind}|${one.editing}`)
    /* The words on the toggle say what pressing it shows. For a suggestion
       the new reading is the one in place; for a change already in the file
       the new reading is what the file holds, and the old one is the baseline. */
    const showingNew = one.kind === 'disk' ? !one.after : one.after
    const controls = document.createElement('span')
    controls.className = 'cm-sugg-controls'
    if (one.kind !== 'new' && !one.held) {
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'cm-sugg-toggle'
      toggle.textContent = showingNew ? 'Show old' : 'Show new'
      toggle.title = showingNew ? 'Show the text as it was' : 'Show the new text in place'
      toggle.setAttribute('aria-pressed', String(one.after))
      toggle.addEventListener('mousedown', (event) => event.preventDefault())
      toggle.addEventListener('click', () => on.toggle(one.key))
      controls.append(toggle)
    }
    if ((one.versions ?? 0) > 1) {
      const other = document.createElement('button')
      other.type = 'button'
      other.className = 'cm-sugg-toggle cm-sugg-version'
      other.setAttribute('data-sugg-version', '')
      other.textContent = `Other version \u00b7 ${one.version ?? 1} of ${one.versions}`
      other.title = 'Several versions are about these words: Accept takes the one shown and the others go with it; Cancel cancels them all'
      other.addEventListener('mousedown', (event) => event.preventDefault())
      other.addEventListener('click', () => on.version(one.key))
      controls.append(other)
    }
    tag.append(controls)
    /* Answering THIS change (its group as one): the same function the
       header's Accept and Reject run, so there is one code path. The words
       carry the meaning; the colour only agrees with them. */
    const about = (one.why.trim().split(/\s+/).slice(0, 6).join(' ') || 'change').slice(0, 60)
    const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    const hint = (decision: 'accept' | 'reject') => {
      if (one.editing) {
        if (decision !== 'accept') return null
        return mac ? { label: '\u2318\u23CE', name: 'Cmd+Enter', aria: 'Meta+Enter' } : { label: 'Ctrl+\u23CE', name: 'Ctrl+Enter', aria: 'Control+Enter' }
      }
      if (!one.armed) return null
      return decision === 'accept' ? { label: '\u23CE', name: 'Enter', aria: 'Enter' } : { label: 'Esc', name: 'Escape', aria: 'Escape' }
    }
    let deleting = false
    const answer = (decision: 'accept' | 'reject', cls: string, icon: string, word: string) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `cm-sugg-toggle cm-sugg-answer ${cls}`
      button.setAttribute('data-sugg-answer', decision)
      button.setAttribute('aria-label', `${word}: ${about}`)
      const glyph = document.createElement('span')
      glyph.setAttribute('aria-hidden', 'true')
      glyph.className = 'cm-sugg-glyph'
      glyph.textContent = icon
      const label = document.createTextNode(word)
      button.append(glyph, label)
      if (decision === 'accept' && one.held) {
        button.disabled = true
        button.title = 'Held back: the text this was about changed since it was suggested'
      }
      /* The key, only where it would work: armed (Enter / Escape), or editing
         (Cmd/Ctrl+Enter accepts the edit; Escape there is not Cancel change). */
      const cap = button.disabled ? null : hint(decision)
      if (cap) {
        const kbd = document.createElement('kbd')
        kbd.className = 'cm-sugg-key'
        kbd.setAttribute('aria-hidden', 'true')
        kbd.textContent = cap.label
        button.append(kbd)
        button.title = `${word} \u2014 ${cap.name}`
        button.setAttribute('aria-keyshortcuts', cap.aria)
      }
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => {
        /* A new file is deleted by Cancel, and only on a second, explicit press. */
        if (decision === 'reject' && one.kind === 'new') {
          if (!deleting) {
            deleting = true
            label.textContent = 'Delete this file? Press again'
            button.setAttribute('data-sugg-confirm', '')
            return
          }
          on.answer(one.key, decision, true)
          return
        }
        on.answer(one.key, decision)
      })
      controls.append(button)
    }
    answer('accept', 'cm-sugg-accept', '\u2713', 'Accept change')
    answer('reject', 'cm-sugg-cancel', '\u2715', 'Cancel change')
    const note = (cls: string, text: string, hidden = false) => {
      const el = document.createElement('span')
      el.className = `cm-sugg-note ${cls}`
      el.textContent = text
      el.hidden = hidden
      tag.append(el)
    }
    if (one.kind === 'disk') {
      const when = new Date(one.found)
      const time = Number.isNaN(when.getTime()) ? '' : ` \u00b7 ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      note('cm-sugg-disk', `changed on disk${time}`)
    } else if (one.kind === 'new') note('cm-sugg-disk', 'new file')
    if (one.held) {
      note('cm-sugg-held', one.held === 'ambiguous' ? 'the text now appears more than once' : 'the text changed since this was suggested')
    }
    if (one.count > 1) note('cm-sugg-group', `${one.count} changes`)
    if ((one.versions ?? 0) > 1) note('cm-sugg-group', `${one.versions} versions of these words`)
    if (one.revisions) note('cm-sugg-revised', one.revisions > 1 ? `revised ${one.revisions}\u00d7` : 'revised')
    const drafted = on.drafts.get(one.id)
    note('cm-sugg-adj', 'adjusted', !(one.adjusted || (drafted !== undefined && drafted !== one.proposed)))
    /* The reason. Where the person is (the tag that is current, armed, or
       showing the new reading) it is a field they can write in; elsewhere it
       is just the words, so a long paper is not a column of input boxes. */
    if (one.current || one.armed || one.after) {
      const field = document.createElement('input')
      field.type = 'text'
      field.className = 'cm-sugg-why cm-sugg-why-edit'
      field.placeholder = 'Why?'
      field.value = one.why
      field.setAttribute('aria-label', 'Why this change')
      field.setAttribute('data-sugg-why', one.id)
      field.maxLength = 240
      const size = () => {
        field.style.width = `${Math.min(36, Math.max(6, field.value.length + 2))}ch`
      }
      size()
      let timer: ReturnType<typeof setTimeout> | null = null
      field.addEventListener('input', () => {
        size()
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => on.why(one.id, field.value), 500)
      })
      field.addEventListener('blur', () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
          on.why(one.id, field.value)
        }
      })
      field.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault()
          field.blur()
        }
      })
      field.addEventListener('mousedown', (event) => event.stopPropagation())
      tag.append(field)
    } else if (one.why) {
      const why = document.createElement('span')
      why.className = 'cm-sugg-why'
      why.textContent = one.why
      tag.append(why)
    }
    return tag
  }
  ignoreEvent(): boolean {
    return true
  }
}

function buildSuggestions(doc: { length: number }, on: Suggesting): DecorationSet {
  const ranges = []
  let taken = 0
  const sorted = [...on.list].sort((a, b) => a.from - b.from || a.to - b.to)
  for (const one of sorted) {
    const from = Math.max(0, Math.min(one.from, doc.length))
    const to = Math.max(from, Math.min(one.to, doc.length))
    /* A reading in place replaces its words, and replacements cannot overlap:
       one that would is left on its current reading (still marked and tagged).
       A passage with no width (a pure insertion, or a deletion already in the
       file) shows the other reading as text put in at that point. */
    const replaces = one.after && !one.held && from >= taken && to > from
    if (replaces) {
      ranges.push(Decoration.replace({ widget: new ProposedWidget(one, on) }).range(from, to))
      taken = to
    } else if (one.after && !one.held && to === from && one.replacement) {
      ranges.push(Decoration.widget({ widget: new ProposedWidget(one, on), side: 1 }).range(from))
    } else if (to > from) {
      ranges.push(
        Decoration.mark({ class: `cm-sugg${one.kind === 'disk' ? ' cm-sugg-new' : ''}${one.current ? ' cm-sugg-current' : ''}${one.held ? ' cm-sugg-stale' : ''}`, attributes: { 'data-sugg': one.id } }).range(from, to),
      )
    }
    if (one.tag) ranges.push(Decoration.widget({ widget: new TagWidget(one, on), side: 1 }).range(to))
  }
  return Decoration.set(ranges, true)
}

const suggestField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setSuggestions)) return buildSuggestions(transaction.state.doc, effect.value)
    return value.map(transaction.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

type Marks = { mark: EditorProps['mark']; problems: EditorProps['problems'] }

const setMarks = StateEffect.define<Marks>()

const marked = Decoration.mark({ class: 'cm-pointed' })

function build(doc: { length: number; lines: number; line(n: number): { from: number } }, marks: Marks): DecorationSet {
  const ranges = []
  /* Line decorations first, by line, then the mark: a decoration set has to be
     built in document order and a line's start sorts before a range inside it. */
  const lines = new Map<number, { severity: 'error' | 'warning'; message: string }>()
  for (const problem of marks.problems) {
    if (problem.line < 1 || problem.line > doc.lines) continue
    const had = lines.get(problem.line)
    if (!had || (had.severity === 'warning' && problem.severity === 'error')) lines.set(problem.line, problem)
  }
  for (const [line, problem] of lines) {
    ranges.push(
      Decoration.line({ class: problem.severity === 'error' ? 'cm-problem-error' : 'cm-problem-warning', attributes: { title: problem.message } }).range(
        doc.line(line).from,
      ),
    )
  }
  if (marks.mark) {
    const from = Math.max(0, Math.min(marks.mark.from, doc.length))
    const to = Math.max(from, Math.min(marks.mark.to, doc.length))
    if (to > from) ranges.push(marked.range(from, to))
  }
  return Decoration.set(ranges, true)
}

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMarks)) return build(transaction.state.doc, effect.value)
    return value.map(transaction.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * Keep a place put back where it was put until the layout under it has settled.
 *
 * ## Why one scroll is not enough
 *
 * An editor draws the lines near the viewport and ESTIMATES the height of the
 * rest, so where an offset is on the page is only a guess until the lines
 * above it have been drawn and measured. A place put back with one scroll lands
 * where the estimate said, and then the lines come into view, are measured, and
 * everything below them moves — by a few lines, or by thousands of pixels in a
 * long chapter. So after the scroll the place is asked for again each frame:
 * where is that offset NOW, and how far is it from where it was meant to be?
 * — and the difference is scrolled away, until it has stayed under a pixel for
 * a moment. Anything the person does to the scroll (wheel, touch, a key, a
 * press) ends it at once: it is theirs again.
 */
let releaseHold: (() => void) | null = null

function holdPlace(view: EditorView, offset: number, margin: number | 'center', column: boolean, until = 12_000): void {
  /* One place is held at a time: going anywhere else (another jump lands) lets go of this one. */
  releaseHold?.()
  const scroller: HTMLElement = (column ? view.dom.closest<HTMLElement>('[data-source-column]') : null) ?? view.scrollDOM
  /* A jump that scrolls smoothly is let finish its glide before it is held:
     correcting it on every frame of the glide would make it a lurch. */
  const glide = typeof getComputedStyle === 'function' && getComputedStyle(scroller).scrollBehavior === 'smooth' ? 950 : 0
  let stopped = false
  const stop = () => {
    if (releaseHold === stop) releaseHold = null
    stopped = true
    for (const name of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) scroller.removeEventListener(name, stop)
  }
  for (const name of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) scroller.addEventListener(name, stop, { passive: true })
  releaseHold = stop
  const started = performance.now()
  const step = () => {
    if (stopped || !view.dom.isConnected) return stop()
    if (performance.now() - started >= glide) {
      const row = view.coordsAtPos(offset, 1)
      const box = scroller.getBoundingClientRect()
      if (row && box.height > 0) {
        const want = margin === 'center' ? box.height / 2 - (row.bottom - row.top) / 2 : margin
        const delta = row.top - (box.top + want)
        if (Math.abs(delta) > 1) scroller.scrollBy({ top: delta, behavior: 'instant' })
      } else if (!row) {
        /* Not drawn — the layout moved it out of what the editor renders: asked for again. */
        view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: 'center' }) })
      }
    }
    /* Held for as long as the layout may still be moving — a long chapter measures itself as it is looked at — and let go the moment the person does anything. */
    if (performance.now() - started > until) return stop()
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export function SourceEditor({ value, onChange, onSelect, onSave, jump, onScrolled, mark, problems, theme, suggestions, drafts, onToggleSuggestion, onAnswerSuggestion, onWhy, onVersion, onPickSuggestion, onArmedKey, onDisarm, onStopEditing, embedded, landed, memory }: EditorProps) {
  const ref = useRef<ReactCodeMirrorRef>(null)
  const scrolled = useRef(onScrolled)
  scrolled.current = onScrolled
  const select = useRef(onSelect)
  select.current = onSelect
  const save = useRef(onSave)
  save.current = onSave
  const pick = useRef(onPickSuggestion)
  pick.current = onPickSuggestion
  const toggled = useRef(onToggleSuggestion)
  toggled.current = onToggleSuggestion
  const answered = useRef(onAnswerSuggestion)
  answered.current = onAnswerSuggestion
  const whyNow = useRef(onWhy)
  whyNow.current = onWhy
  const versionNow = useRef(onVersion)
  versionNow.current = onVersion
  const armedKey = useRef(onArmedKey)
  armedKey.current = onArmedKey
  const disarmed = useRef(onDisarm)
  disarmed.current = onDisarm
  const stopped = useRef(onStopEditing)
  stopped.current = onStopEditing
  const ownDrafts = useRef(new Map<string, string>())
  const typedAt = useRef(0)
  const remembered = useRef(memory)
  remembered.current = memory
  /* What the editor starts from: the state it had when it was last on screen,
     history included, if the text is still exactly what it ended with. */
  const [restored] = useState(() => {
    const saved = memory?.state.get(memory.key)
    if (!saved || saved.doc.toString() !== value) return undefined
    try {
      return { json: saved.toJSON({ history: historyField }), fields: { history: historyField } }
    } catch {
      return undefined
    }
  })

  const extensions = useMemo<Extension[]>(
    () => [
      StreamLanguage.define(stex),
      /* Wrapped, always. A paragraph of LaTeX is routinely one line a thousand
         characters long, and in a panel 280 pixels wide the alternative is
         reading it through a slot. */
      EditorView.lineWrapping,
      marksField,
      suggestField,
      EditorView.domEventHandlers({
        mousedown(event) {
          const hit = event.target instanceof Element ? event.target.closest('[data-sugg]') : null
          const id = hit?.getAttribute('data-sugg')
          if (id) pick.current?.(id)
          return false
        },
        blur(event, view) {
          /* Focus moving into the edit box (inside the editor) is not leaving it. */
          const to = event.relatedTarget
          if (to instanceof Node && view.dom.contains(to)) return false
          disarmed.current?.()
          return false
        },
      }),
      Prec.highest(
        keymap.of([
          {
            key: 'Enter',
            stopPropagation: true,
            run: () => armedKey.current?.('accept') ?? false,
          },
          {
            key: 'Escape',
            stopPropagation: true,
            run: () => armedKey.current?.('reject') ?? false,
          },
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              save.current()
              return true
            },
          },
        ]),
      ),
      EditorView.updateListener.of((update: ViewUpdate) => {
        const kept = remembered.current
        if (kept && (update.docChanged || update.selectionSet)) kept.state.set(kept.key, update.state)
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(ExternalChange))) typedAt.current = Date.now()
        if (!update.selectionSet && !update.docChanged) return
        const main = update.state.selection.main
        select.current({ from: main.from, to: main.to })
      }),
    ],
    [],
  )

  /* A jump is applied once per nonce, by whichever comes second: the nonce
     changing, or the editor existing. The page opens another file and jumps in
     the same breath, and this component is then MOUNTING when the jump
     arrives — an effect alone would find no view and drop it. */
  const ownJumped = useRef(0)
  const jumped = landed ?? ownJumped
  const going = useRef(jump)
  going.current = jump
  const land = (view: EditorView | undefined) => {
    const to = going.current
    if (!to || !view || jumped.current === to.nonce) return
    jumped.current = to.nonce
    /* Going somewhere lets go of any place being held. */
    releaseHold?.()
    const length = view.state.doc.length
    const from = Math.min(to.from, length)
    const end = Math.min(Math.max(to.to, from), length)
    view.dispatch({
      ...(to.keep ? {} : { selection: to.select ? { anchor: from, head: end } : { anchor: from } }),
      effects:
        to.top === undefined
          ? EditorView.scrollIntoView(from, { y: 'center' })
          : /* The row that STARTS at the offset (`assoc` 1): at a soft wrap the same offset is also the end of
               the row above. A negative margin is that many pixels of the row above the top. */
            EditorView.scrollIntoView(EditorSelection.cursor(Math.min(to.top, length), 1), { y: 'start', yMargin: (embedded ? EMBED_TOP : 0) - Math.max(0, to.past ?? 0) }),
    })
    if (to.focus) view.focus()
    if (to.top !== undefined) holdPlace(view, Math.min(to.top, length), (embedded ? EMBED_TOP : 0) - Math.max(0, to.past ?? 0), embedded === true)
    /* A place gone to — a change, a section, a passage — is held in the middle
       while the column round it is still being measured: in the continuous
       column the regions above are estimates, and one scroll landed a change
       in chapter 3 a chapter further down once they had been measured. */
    else if (embedded) holdPlace(view, from, 'center', true, 3000)
  }
  useEffect(() => {
    land(ref.current?.view)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce])

  /* After `value`: the decorations name offsets into the text now in the
     editor, and a mark set before the new text arrived would be clamped to the
     old one. `problems` is compared by content by the caller's memo. */
  useEffect(() => {
    const view = ref.current?.view
    if (!view) return
    view.dispatch({ effects: setMarks.of({ mark, problems }) })
  }, [mark, problems, value])

  /* The text changed from outside (the disk's version, a merge): put in as the
     SMALLEST change that makes the two equal, so the caret and the scroll stay
     where they are and what the person has typed is not replaced. Done before
     the wrapper's own whole-text replacement would be (a layout effect runs
     first), and not while the person is typing: the wrapper holds those back. */
  useLayoutEffect(() => {
    const view = ref.current?.view
    if (!view) return
    const now = view.state.doc.toString()
    if (now === value || Date.now() - typedAt.current < 500) return
    const room = Math.min(now.length, value.length)
    let a = 0
    while (a < room && now.charCodeAt(a) === value.charCodeAt(a)) a++
    if (a > 0 && now.charCodeAt(a - 1) >= 0xd800 && now.charCodeAt(a - 1) <= 0xdbff) a--
    let b = 0
    while (b < room - a && now.charCodeAt(now.length - 1 - b) === value.charCodeAt(value.length - 1 - b)) b++
    if (b > 0 && now.charCodeAt(now.length - b) >= 0xdc00 && now.charCodeAt(now.length - b) <= 0xdfff) b--
    view.dispatch({
      changes: { from: a, to: now.length - b, insert: value.slice(a, value.length - b) },
      annotations: [ExternalChange.of(true), Transaction.addToHistory.of(false)],
    })
  }, [value])

  /* Where the page can reach this editor to put text back as one undoable step. */
  useEffect(() => {
    const control = memory?.control
    if (!control || !memory) return
    const at = memory.key
    control.set(at, {
      replace(changes) {
        const view = ref.current?.view
        if (!view) return
        view.dispatch({ changes: changes.map((one) => ({ from: one.from, to: one.to, insert: one.insert })) })
      },
    })
    return () => {
      control.delete(at)
    }
  }, [memory?.control, memory?.key])

  /* Suggestions are decorations over the text, set after `value` for the same
     reason marks are, and mapped through typing by the editor itself — so a
     keystroke redraws nothing here and says nothing to the page. */
  const forDrafts = drafts ?? ownDrafts.current
  /** What the decorations are given: the list, and what a press on them does. */
  const suggesting = (view: EditorView, list: readonly InlineSuggestion[], draftsNow: Map<string, string>): Suggesting => ({
    list,
    drafts: draftsNow,
    toggle: (key) => toggled.current?.(key),
    answer: (key, decision, confirm) => answered.current?.(key, decision, confirm),
    draft: () => {},
    why: (id, text) => whyNow.current?.(id, text),
    version: (key) => versionNow.current?.(key),
    stopEditing: () => stopped.current?.(),
    pick: (id, withCaret) => {
      if (withCaret) {
        const at = list.find((one) => one.id === id)
        if (at) view.dispatch({ selection: { anchor: Math.min(at.from, view.state.doc.length) } })
        view.focus()
      }
      pick.current?.(id)
    },
  })
  useEffect(() => {
    const view = ref.current?.view
    if (!view) return
    view.dispatch({ effects: setSuggestions.of(suggesting(view, suggestions ?? [], forDrafts)) })
  }, [suggestions, forDrafts, value])
  /* What the editor is to draw when it comes into being: an editor mounted
     with suggestions already in hand (a region scrolled into view) has no
     change of props to draw them on. */
  const drawn = useRef({ suggestions, forDrafts })
  drawn.current = { suggestions, forDrafts }

  return (
    <CodeMirror
      ref={ref}
      className={embedded ? 'source-editor source-editor-embedded' : 'source-editor h-full min-h-0'}
      {...(embedded ? {} : { height: '100%' })}
      value={value}
      {...(restored ? { initialState: restored } : {})}
      theme={theme}
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={(view) => {
        view.dispatch({
          effects: [
            setMarks.of({ mark, problems }),
            setSuggestions.of(suggesting(view, drawn.current.suggestions ?? [], drawn.current.forDrafts)),
          ],
        })
        /* Where the editor is scrolled to, as the offset at its top-left: a
           place in the text, which means the same at another width. Behind the
           other tab it has no height and is "at the top" — which is not where
           anybody put it, and is not said. */
        const report = () => {
          const box = scroller.getBoundingClientRect()
          if (box.height === 0) return
          if (embedded) {
            /* The column scrolls, not this editor: only the editor the column's
               top is inside says where, as the offset at that top. */
            const own = view.dom.getBoundingClientRect()
            if (own.top > box.top + 1 || own.bottom <= box.top) return
          }
          const lid = embedded ? EMBED_TOP : 0
          const top = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 1, y: box.top + lid + 1 }, false)
          const row = view.coordsAtPos(top, 1)
          scrolled.current?.(top, row ? Math.max(0, Math.round(box.top + lid - row.top)) : 0)
        }
        const scroller: HTMLElement = (embedded ? view.dom.closest<HTMLElement>('[data-source-column]') : null) ?? view.scrollDOM
        scroller.addEventListener('scroll', report, { passive: true })
        land(view)
      }}
      basicSetup={{
        /* Line numbers stay on: an engine's error is a line number, and so is
           everything SyncTeX says. Folding and completion are off — the first
           needs a parser this mode is not, the second would offer words. */
        lineNumbers: true,
        foldGutter: false,
        autocompletion: false,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
      }}
      aria-label="LaTeX source"
    />
  )
}
