import { describe, expect, test } from 'bun:test'

import { changedBy } from '../src/use-source.ts'

describe('what text taken from the disk changed', () => {
  test('one stretch: that stretch, and no pieces', () => {
    const was = 'Several measures let the reader assess.'
    const now = 'Several careful measures let the reader assess.'
    const changed = changedBy('a.tex', was, now, null)!
    expect(now.slice(changed.from, changed.to)).toBe('careful ')
    expect(changed.parts).toBeUndefined()
  })

  test('two stretches far apart: the first, and each as its own piece — never the text between them', () => {
    const middle = 'Unchanged words. '.repeat(200)
    const was = `% top\nThe first authentic one.\n\n${middle}\nSeveral measures.\n`
    const now = `% top\n% a\nThe very first authentic one.\n\n${middle}\nSeveral careful measures.\n`
    const changed = changedBy('a.tex', was, now, null)!
    const pieces = changed.parts!.map((one) => now.slice(one.from, one.to))
    expect(now.slice(changed.from, changed.to)).toBe(pieces[0]!)
    expect(pieces[0]).toContain('very')
    expect(pieces.at(-1)).toBe('careful ')
    expect(pieces.join('')).not.toContain('Unchanged')
  })
})
