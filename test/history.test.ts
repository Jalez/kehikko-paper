import { describe, expect, test } from 'bun:test'
import { history, historyField, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'

/**
 * An editor that is unmounted (a region scrolled far away) and mounted again
 * starts from the state it ended in, history included: that is
 * `EditorState.toJSON({ history: historyField })` and `fromJSON`, which is what
 * `SourceEditor`'s `memory` does. The component cannot be laid out here, so
 * what is asserted is the mechanism it is built on, with the same fields.
 */
describe('editor history across unmount and mount', () => {
  const typed = () => {
    let state = EditorState.create({ doc: 'the first words', extensions: [history()] })
    state = state.update({ changes: { from: 15, insert: ' and more' }, userEvent: 'input.type' }).state
    return state
  }

  test('a state round-tripped through JSON can still be undone', () => {
    const saved = typed()
    const again = EditorState.fromJSON(saved.toJSON({ history: historyField }), { extensions: [history()] }, { history: historyField })
    expect(again.doc.toString()).toBe('the first words and more')
    let out = again
    expect(undo({ state: again, dispatch: (tr) => (out = tr.state) })).toBe(true)
    expect(out.doc.toString()).toBe('the first words')
  })

  test('without it a fresh editor has nothing to undo', () => {
    const fresh = EditorState.create({ doc: 'the first words and more', extensions: [history()] })
    expect(undo({ state: fresh, dispatch: () => {} })).toBe(false)
  })
})
