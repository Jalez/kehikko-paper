import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { EditorSelection, Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef, type ComponentType } from 'react'

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
  /** Accept change / Cancel change on a tag: answers THAT suggestion (its group, by stop key), not the current one. */
  onAnswerSuggestion?(key: string, decision: 'accept' | 'reject'): void
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
  /** The nonce of the last jump this editor's file has landed, kept by the page: an editor mounted again does not land it twice. */
  landed?: { current: number }
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
}

type Suggesting = {
  list: readonly InlineSuggestion[]
  drafts: Map<string, string>
  toggle(key: string): void
  answer(key: string, decision: 'accept' | 'reject'): void
  draft(id: string, text: string): void
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
      other.one.current === this.one.current
    )
  }
  toDOM(): HTMLElement {
    const { one, on } = this
    const span = document.createElement('span')
    span.className = `cm-sugg-after${one.current ? ' cm-sugg-current' : ''}`
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
    if (!one.editing) {
      span.textContent = one.replacement
      return span
    }
    const area = document.createElement('textarea')
    area.className = 'cm-sugg-edit'
    area.setAttribute('aria-label', 'Proposed text, editable')
    area.setAttribute('data-sugg-edit', one.id)
    area.value = on.drafts.get(one.id) ?? one.replacement
    area.rows = Math.min(10, Math.max(2, area.value.split('\n').length))
    area.addEventListener('input', () => {
      on.drafts.set(one.id, area.value)
      on.draft(one.id, area.value)
      const mark = area.ownerDocument.querySelector(`[data-sugg-tag="${CSS.escape(one.id)}"] .cm-sugg-adj`)
      if (mark instanceof HTMLElement) mark.hidden = area.value === one.proposed
    })
    span.append(area)
    const grow = () => {
      area.style.height = 'auto'
      area.style.height = `${area.scrollHeight + 2}px`
    }
    area.addEventListener('input', grow)
    /* A text field: Enter is a newline. Cmd/Ctrl+Enter accepts the edited text;
       Escape stops editing and rejects nothing. */
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        on.answer(one.key, 'accept')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        on.stopEditing()
      }
    })
    queueMicrotask(() => {
      if (!area.isConnected) return
      grow()
      area.focus()
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
      a.revisions === b.revisions && a.count === b.count && a.editing === b.editing
    )
  }
  toDOM(): HTMLElement {
    const { one, on } = this
    const tag = document.createElement('span')
    tag.className = `cm-sugg-tag${one.current ? ' cm-sugg-current' : ''}${one.armed ? ' cm-sugg-armed' : ''}`
    tag.setAttribute('data-sugg-tag', one.id)
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'cm-sugg-toggle'
    /* The label says what pressing it will show. */
    toggle.textContent = one.after ? 'Show old' : 'Show new'
    toggle.title = one.after ? 'Show the current text' : 'Show the suggested text in place'
    toggle.setAttribute('aria-pressed', String(one.after))
    toggle.addEventListener('mousedown', (event) => event.preventDefault())
    toggle.addEventListener('click', () => on.toggle(one.key))
    /* The three buttons stay together; only a narrow container lets them wrap. */
    const controls = document.createElement('span')
    controls.className = 'cm-sugg-controls'
    controls.append(toggle)
    tag.append(controls)
    /* Answering THIS suggestion (its group as one): the same function the
       header's Accept and Reject run, so there is one code path. The words
       carry the meaning; the colour only agrees with them. */
    const about = (one.why.trim().split(/\s+/).slice(0, 6).join(' ') || 'suggestion').slice(0, 60)
    const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    const hint = (decision: 'accept' | 'reject') => {
      if (one.editing) {
        if (decision !== 'accept') return null
        return mac ? { label: '\u2318\u23CE', name: 'Cmd+Enter', aria: 'Meta+Enter' } : { label: 'Ctrl+\u23CE', name: 'Ctrl+Enter', aria: 'Control+Enter' }
      }
      if (!one.armed) return null
      return decision === 'accept' ? { label: '\u23CE', name: 'Enter', aria: 'Enter' } : { label: 'Esc', name: 'Escape', aria: 'Escape' }
    }
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
      button.append(glyph, document.createTextNode(word))
      /* The key, only where it would work: armed (Enter / Escape), or editing
         (Cmd/Ctrl+Enter accepts the edit; Escape there is not Cancel change). */
      const cap = hint(decision)
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
      button.addEventListener('click', () => on.answer(one.key, decision))
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
    if (one.count > 1) note('cm-sugg-group', `${one.count} changes`)
    if (one.revisions) note('cm-sugg-revised', one.revisions > 1 ? `revised ${one.revisions}×` : 'revised')
    const drafted = on.drafts.get(one.id)
    note('cm-sugg-adj', 'adjusted', !(one.editing && drafted !== undefined && drafted !== one.proposed))
    if (one.current || one.after) {
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
       one that would is left on its current reading (still marked and tagged). */
    const replaces = one.after && from >= taken && to > from
    if (replaces) {
      ranges.push(Decoration.replace({ widget: new ProposedWidget(one, on) }).range(from, to))
      taken = to
    } else if (to > from) {
      ranges.push(
        Decoration.mark({ class: `cm-sugg${one.current ? ' cm-sugg-current' : ''}`, attributes: { 'data-sugg': one.id } }).range(from, to),
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

export function SourceEditor({ value, onChange, onSelect, onSave, jump, onScrolled, mark, problems, theme, suggestions, drafts, onToggleSuggestion, onAnswerSuggestion, onPickSuggestion, onArmedKey, onDisarm, onStopEditing, embedded, landed }: EditorProps) {
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
  const armedKey = useRef(onArmedKey)
  armedKey.current = onArmedKey
  const disarmed = useRef(onDisarm)
  disarmed.current = onDisarm
  const stopped = useRef(onStopEditing)
  stopped.current = onStopEditing
  const ownDrafts = useRef(new Map<string, string>())

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

  /* Suggestions are decorations over the text, set after `value` for the same
     reason marks are, and mapped through typing by the editor itself — so a
     keystroke redraws nothing here and says nothing to the page. */
  const forDrafts = drafts ?? ownDrafts.current
  /** What the decorations are given: the list, and what a press on them does. */
  const suggesting = (view: EditorView, list: readonly InlineSuggestion[], draftsNow: Map<string, string>): Suggesting => ({
    list,
    drafts: draftsNow,
    toggle: (key) => toggled.current?.(key),
    answer: (key, decision) => answered.current?.(key, decision),
    draft: () => {},
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
