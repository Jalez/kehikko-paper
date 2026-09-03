import { describe, expect, test } from 'bun:test'

import { parseLatex } from '../latex/parse.ts'
import type { Paper, PlacedBlock } from '../store.ts'
import { changedFiles, compare, diffBlocks, fingerprint, similar } from '../src/reader/changed.ts'

/**
 * The comparison between what the page read and what is on disk, as pure
 * arithmetic.
 *
 * Two things are under test and they are kept apart because they are decided
 * in two places. `changedFiles` is the DETECTION: given the reading's hashes
 * and the disk's, which files moved. It runs on every tick of the standing
 * poll and is the whole of what decides whether the page fetches anything.
 * `compare` and `diffBlocks` are the PICTURE: given both readings, which rows
 * come out, in what order, marked how — and in particular that a chapter
 * rewritten wholesale comes out as many rows and a one-word correction comes
 * out as one reworded paragraph rather than one removed and one added.
 */

/** A paper out of source, with every block placed in one file. */
function paperOf(source: string, file = 'main.tex', epic = 'compared'): Paper {
  const parsed = parseLatex(source, file)
  const blocks: PlacedBlock[] = parsed.blocks.map((b) => ({ ...b, file }))
  return {
    epic,
    dir: '/tmp/papers/compared',
    title: null,
    author: null,
    blocks,
    figures: [],
    outline: [],
    files: [file],
    hashes: { [file]: `hash-of-${source.length}-${source.slice(0, 40)}` },
  }
}

const doc = (...paragraphs: string[]) => ['\\begin{document}', '', ...paragraphs.flatMap((p) => [p, '']), '\\end{document}', ''].join('\n')

const visibleRows = (rows: ReturnType<typeof diffBlocks>) =>
  rows.filter((r) => r.block.kind !== 'structure' && r.block.kind !== 'preamble')

describe('changedFiles: which of the files on screen are not what is on disk', () => {
  test('nothing moved when every hash is the same', () => {
    expect(changedFiles({ 'main.tex': 'a', 'chapters/2.tex': 'b' }, { 'main.tex': 'a', 'chapters/2.tex': 'b' })).toEqual([])
  })

  test('a file whose hash differs is named, and the others are not', () => {
    expect(changedFiles({ 'main.tex': 'a', 'chapters/2.tex': 'b' }, { 'main.tex': 'a', 'chapters/2.tex': 'c' })).toEqual([
      'chapters/2.tex',
    ])
  })

  test('a file the disk no longer has is a change, and so is one the reading never had', () => {
    /* A chapter deleted, or no longer \included, is something the reader is
       looking at that does not exist; a chapter added is something the paper
       has that the reader is not looking at. Both are reported. */
    expect(changedFiles({ 'main.tex': 'a', 'chapters/2.tex': 'b' }, { 'main.tex': 'a' })).toEqual(['chapters/2.tex'])
    expect(changedFiles({ 'main.tex': 'a' }, { 'main.tex': 'a', 'chapters/3.tex': 'c' })).toEqual(['chapters/3.tex'])
  })

  test('no paper on disk at all is every held file changed', () => {
    expect(changedFiles({ 'main.tex': 'a', 'chapters/2.tex': 'b' }, null)).toEqual(['main.tex', 'chapters/2.tex'])
  })

  test('the fingerprint names a state of the disk regardless of key order', () => {
    expect(fingerprint({ b: '2', a: '1' })).toBe(fingerprint({ a: '1', b: '2' }))
    expect(fingerprint({ a: '1' })).not.toBe(fingerprint({ a: '2' }))
    expect(fingerprint(null)).toBe('')
  })
})

describe('diffBlocks: the picture of one file, before and after', () => {
  test('an unchanged file is every block, unchanged, in order', () => {
    const a = paperOf(doc('One.', 'Two.', 'Three.')).blocks
    const b = paperOf(doc('One.', 'Two.', 'Three.')).blocks
    const rows = diffBlocks(a, b)
    expect(rows.every((r) => r.at === 'same')).toBe(true)
    /* The reading's own block objects, so every offset and every anchor on
       the page is still about the reading. */
    expect(rows.map((r) => r.block)).toEqual(a)
  })

  test('a paragraph added in the middle is one new row where it arrives', () => {
    const a = paperOf(doc('One.', 'Three.')).blocks
    const b = paperOf(doc('One.', 'Two arrives here.', 'Three.')).blocks
    const rows = visibleRows(diffBlocks(a, b))
    expect(rows.map((r) => r.at)).toEqual(['same', 'new', 'same'])
    expect(rows[1]!.block.kind).toBe('paragraph')
  })

  test('a paragraph removed from the middle is one gone row where it stood', () => {
    const a = paperOf(doc('One.', 'Two was here.', 'Three.')).blocks
    const b = paperOf(doc('One.', 'Three.')).blocks
    const rows = visibleRows(diffBlocks(a, b))
    expect(rows.map((r) => r.at)).toEqual(['same', 'gone', 'same'])
    /* The reading's block, so it can be drawn from its own segments. */
    expect(rows[1]!.block).toBe(a.find((x) => x.kind === 'paragraph' && x.srcStart > a[0]!.srcStart)!)
  })

  test('a corrected word is one reworded paragraph, not one gone and one new', () => {
    const a = paperOf(doc('The claim has a tpyo in it and runs on for a while, as prose does.', 'Second.')).blocks
    const b = paperOf(doc('The claim has a typo in it and runs on for a while, as prose does.', 'Second.')).blocks
    const rows = visibleRows(diffBlocks(a, b))
    expect(rows.map((r) => r.at)).toEqual(['changed', 'same'])
    const reworded = rows[0]!
    if (reworded.at !== 'changed') throw new Error('not reworded')
    expect(reworded.was).toContain('tpyo')
    expect(reworded.now).toContain('typo')
    /* The reading's block carries the row, because its offsets are the ones
       every pending suggestion was measured against. */
    expect(reworded.block).toBe(a.find((x) => x.kind === 'paragraph')!)
  })

  test('a paragraph replaced by a different argument is gone and new, not reworded', () => {
    const a = paperOf(doc('The market opens at dawn and the traders arrive with carts of fruit.', 'Second.')).blocks
    const b = paperOf(doc('Nothing in this sentence shares a word with what stood before it.', 'Second.')).blocks
    const rows = visibleRows(diffBlocks(a, b))
    expect(rows.map((r) => r.at)).toEqual(['gone', 'new', 'same'])
  })

  test('a chapter rewritten wholesale is many rows, and the kept paragraphs are kept', () => {
    /* Eight paragraphs; the author keeps two, rewords two, drops two and
       writes two new ones. The picture must be readable as that, and not as
       one red block of eight and one green block of eight. */
    const a = paperOf(
      doc(
        'Kept one, exactly as it was, word for word.',
        'Reworded one has a sentence that will change a little at the end.',
        'Dropped one goes away entirely and nothing replaces it.',
        'Kept two, exactly as it was, word for word.',
        'Reworded two is another paragraph whose ending will be touched.',
        'Dropped two also goes away entirely.',
        'A closing paragraph the author keeps.',
        'And a last one the author keeps too.',
      ),
    ).blocks
    const b = paperOf(
      doc(
        'Kept one, exactly as it was, word for word.',
        'Reworded one has a sentence that will change a lot at the end.',
        'Kept two, exactly as it was, word for word.',
        'Brand new paragraph with an argument of its own.',
        'Reworded two is another paragraph whose ending has been touched.',
        'A closing paragraph the author keeps.',
        'Another brand new paragraph, second of two.',
        'And a last one the author keeps too.',
      ),
    ).blocks
    const rows = visibleRows(diffBlocks(a, b))
    expect(rows.map((r) => r.at)).toEqual([
      'same',
      'changed',
      'gone',
      'same',
      'new',
      'changed',
      'gone',
      'same',
      'new',
      'same',
    ])
  })

  test('a heading can be reworded; a list cannot, and is gone and new', () => {
    const a = paperOf(
      ['\\begin{document}', '\\section{The old title of this section}', '', '\\begin{itemize}', '\\item one', '\\item two', '\\end{itemize}', '', '\\end{document}', ''].join('\n'),
    ).blocks
    const b = paperOf(
      ['\\begin{document}', '\\section{The new title of this section}', '', '\\begin{itemize}', '\\item one', '\\item three', '\\end{itemize}', '', '\\end{document}', ''].join('\n'),
    ).blocks
    const rows = visibleRows(diffBlocks(a, b))
    const kinds = rows.map((r) => `${r.block.kind}:${r.at}`)
    expect(kinds).toContain('heading:changed')
    expect(kinds).toContain('list:gone')
    expect(kinds).toContain('list:new')
    expect(kinds).not.toContain('list:changed')
  })
})

describe('compare: the two readings laid over each other', () => {
  test('a file whose hash did not move is not compared, even if its blocks would differ', () => {
    /* The hash is the only witness. A page must not draw a change in a file
       the disk says did not move; that would be this page reporting its own
       parser's mood as the author's edit. */
    const held = paperOf(doc('One.'))
    const now = { ...paperOf(doc('Something else.')), hashes: held.hashes }
    const out = compare(held, now)
    expect(out.files).toEqual([])
    expect(out.changes.size).toBe(0)
    expect(out.blocks).toEqual(held.blocks)
  })

  test('a moved file is named, its rows are marked, and the counts add up', () => {
    const held = paperOf(doc('One.', 'Two was here.', 'Three has a tpyo and a long enough tail to pair.'))
    const now = paperOf(doc('One.', 'Three has a typo and a long enough tail to pair.', 'Four arrives.'))
    const out = compare(held, now)
    expect(out.files).toEqual(['main.tex'])
    expect(out.counts).toEqual({ gone: 1, new: 1, changed: 1 })
    const marks = out.blocks.filter((b) => b.kind === 'paragraph').map((b) => out.changes.get(b)?.at ?? 'same')
    expect(marks).toEqual(['same', 'gone', 'changed', 'new'])
  })

  test('a new block gets an id that cannot collide with the reading', () => {
    const held = paperOf(doc('One.'))
    const now = paperOf(doc('Zero arrives first.', 'One.'))
    const out = compare(held, now)
    const fresh = out.blocks.find((b) => out.changes.get(b)?.at === 'new')!
    expect(fresh.id.endsWith('~new')).toBe(true)
    const ids = out.blocks.map((b) => `${b.file}#${b.id}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a chapter the disk has and the reading has not is placed after the file before it, all new', () => {
    const main = paperOf(doc('Main.'))
    const chapter = paperOf(doc('A whole new chapter.'), 'chapters/2.tex')
    const held = main
    const now: Paper = {
      ...main,
      blocks: [...main.blocks, ...chapter.blocks],
      files: ['main.tex', 'chapters/2.tex'],
      hashes: { ...main.hashes, ...chapter.hashes },
    }
    const out = compare(held, now)
    expect(out.files).toEqual(['chapters/2.tex'])
    const inChapter = out.blocks.filter((b) => b.file === 'chapters/2.tex')
    expect(inChapter.length).toBe(chapter.blocks.length)
    expect(inChapter.every((b) => out.changes.get(b)?.at === 'new')).toBe(true)
    /* After main's blocks, which is where the disk puts it. */
    expect(out.blocks.indexOf(inChapter[0]!)).toBe(main.blocks.length)
  })

  test('a chapter the reading has and the disk has not is all gone, where it was', () => {
    const main = paperOf(doc('Main.'))
    const chapter = paperOf(doc('A chapter that was dropped.'), 'chapters/2.tex')
    const held: Paper = {
      ...main,
      blocks: [...main.blocks, ...chapter.blocks],
      files: ['main.tex', 'chapters/2.tex'],
      hashes: { ...main.hashes, ...chapter.hashes },
    }
    const out = compare(held, main)
    expect(out.files).toEqual(['chapters/2.tex'])
    const inChapter = out.blocks.filter((b) => b.file === 'chapters/2.tex')
    expect(inChapter.length).toBe(chapter.blocks.length)
    expect(inChapter.every((b) => out.changes.get(b)?.at === 'gone')).toBe(true)
  })
})

describe('similar: whether two paragraphs are one paragraph reworded', () => {
  test('the same words are 1, no shared words are 0', () => {
    expect(similar('a b c', 'a b c')).toBe(1)
    expect(similar('a b c', 'x y z')).toBe(0)
    expect(similar('', '')).toBe(1)
    expect(similar('a', '')).toBe(0)
  })

  test('a sentence changed in a paragraph of five still shares most of its words', () => {
    const before =
      'One sentence stands here. Another follows it closely. A third makes the point. A fourth qualifies it. The fifth concludes.'
    const after =
      'One sentence stands here. Another follows it closely. A third makes the point. Something completely different. The fifth concludes.'
    expect(similar(before, after)).toBeGreaterThan(0.7)
  })
})
