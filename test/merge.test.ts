import { describe, expect, test } from 'bun:test'

import { mergeThree } from '../latex/merge.ts'

const base = ['one', 'two', 'three', 'four', 'five', ''].join('\n')

describe('two writers, one starting point', () => {
  test('changes to different lines are both kept', () => {
    const merged = mergeThree(base, base.replace('two', 'TWO typed'), base.replace('four', 'FOUR by an agent'))
    expect(merged).toBe(['one', 'TWO typed', 'three', 'FOUR by an agent', 'five', ''].join('\n'))
  })

  test('an insertion above and a change below are both kept, in order', () => {
    const merged = mergeThree(base, `new first line\n${base}`, base.replace('five', 'FIVE'))
    expect(merged).toBe(['new first line', 'one', 'two', 'three', 'four', 'FIVE', ''].join('\n'))
  })

  test('the same line changed by both is a conflict, whatever the words', () => {
    expect(mergeThree(base, base.replace('two', 'mine'), base.replace('two', 'theirs'))).toBeNull()
    expect(mergeThree(base, base.replace('two', 'mine'), base.replace('two', 'tw0'))).toBeNull()
  })

  test('two insertions at one place are a conflict', () => {
    expect(mergeThree(base, base.replace('three\n', 'three\nA\n'), base.replace('three\n', 'three\nB\n'))).toBeNull()
  })

  test('the very same change on both sides is kept once', () => {
    const same = base.replace('two', 'TWO')
    expect(mergeThree(base, same, same)).toBe(same)
    expect(mergeThree(base, same.replace('four', 'FOUR'), same)).toBe(same.replace('four', 'FOUR'))
  })

  test('only one side changed: that side', () => {
    expect(mergeThree(base, base, base.replace('two', 'TWO'))).toBe(base.replace('two', 'TWO'))
    expect(mergeThree(base, base.replace('two', 'TWO'), base)).toBe(base.replace('two', 'TWO'))
  })

  test('a deletion by one and an edit elsewhere by the other are both kept', () => {
    expect(mergeThree(base, base.replace('two\n', ''), base.replace('five', 'FIVE'))).toBe(['one', 'three', 'four', 'FIVE', ''].join('\n'))
  })
})
