import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
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
  jump: { from: number; to: number; nonce: number; select?: boolean; focus?: boolean; keep?: boolean } | null
  /** A range somebody ELSE pointed at — a note's anchor, a question's — drawn without touching the selection. */
  mark: { from: number; to: number } | null
  /** One-based lines the engine complained about. */
  problems: readonly { line: number; severity: 'error' | 'warning'; message: string }[]
  theme: 'light' | 'dark'
}

export type Editor = ComponentType<EditorProps>

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

export function SourceEditor({ value, onChange, onSelect, onSave, jump, mark, problems, theme }: EditorProps) {
  const ref = useRef<ReactCodeMirrorRef>(null)
  const select = useRef(onSelect)
  select.current = onSelect
  const save = useRef(onSave)
  save.current = onSave

  const extensions = useMemo<Extension[]>(
    () => [
      StreamLanguage.define(stex),
      /* Wrapped, always. A paragraph of LaTeX is routinely one line a thousand
         characters long, and in a panel 280 pixels wide the alternative is
         reading it through a slot. */
      EditorView.lineWrapping,
      marksField,
      Prec.highest(
        keymap.of([
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
  const jumped = useRef(0)
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
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
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

  return (
    <CodeMirror
      ref={ref}
      className="source-editor h-full min-h-0"
      height="100%"
      value={value}
      theme={theme}
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={(view) => {
        view.dispatch({ effects: setMarks.of({ mark, problems }) })
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
