import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { bytesOf, narrow, onBoundary, place, sourceRefuses, whyNot, type Piece } from '../latex/edit.ts'
import { readPaper, writeRange } from '../store.ts'

/**
 * The write door, tested where it can be: the arithmetic and the refusals.
 *
 * ## What these tests can and cannot see
 *
 * They cannot see a browser. Nothing here proves that a caret lands where a
 * reader expects, that a `contenteditable` span reports the text somebody
 * typed, or that the paper redraws in place afterwards. Those are DOM
 * behaviours and this repository's suite renders components into happy-dom,
 * which does not implement editing at all.
 *
 * What they can see is every decision that could corrupt a file, and that is
 * deliberately where all of those decisions were put. `narrow` says which bytes
 * change. `whyNot` says what may be written. `onBoundary` says whether an
 * offset is a place. `writeRange` says whether the file is still the file. Each
 * of them is reachable without a page, and each of them is the one that has to
 * be right — a browser bug shows a reader the wrong cursor, and a bug in any of
 * these silently rewrites somebody's thesis.
 */

/**
 * A literal piece, as the parser produces one for a run of ordinary words.
 *
 * The helpers exist so that a test reads as the shape it is about — a run of
 * pieces — rather than as five object literals with the offsets counted by hand.
 */
function word(text: string, srcStart: number): Piece {
  return { text, srcStart, srcEnd: srcStart + bytesOf(text), literal: true }
}

/** A whitespace run in the source, rendered as one space. */
function gap(source: string, srcStart: number): Piece {
  return { text: ' ', srcStart, srcEnd: srcStart + bytesOf(source), literal: false, gap: true }
}

/** Anything else derived — a citation, an escape, a `~`. */
function rendered(text: string, srcStart: number, source: string): Piece {
  return { text, srcStart, srcEnd: srcStart + bytesOf(source), literal: false }
}

/** What `place` decided, applied to a source string, so it can be checked. */
function apply(source: string, at: { from: number; to: number; text: string }): string {
  const bytes = Buffer.from(source, 'utf8')
  return Buffer.concat([bytes.subarray(0, at.from), Buffer.from(at.text, 'utf8'), bytes.subarray(at.to)]).toString(
    'utf8',
  )
}

/** `place`'s answer when it agreed, for a test that has already asserted it did. */
const landed = (found: ReturnType<typeof place>) => found as { from: number; to: number; text: string }

describe('narrow: the smallest edit that turns one string into another', () => {
  test('nothing changed is not an edit', () => {
    expect(narrow('the same words', 'the same words')).toBeNull()
  })

  test('one letter replaced names one letter, in rendered units', () => {
    /* The property the whole function exists for: a typo fixed in the middle of
       a paragraph-sized run must not rewrite the paragraph. Everything else in
       that run keeps its bytes, and so does every note anchored inside it.

       The offsets are RENDERED units now and not bytes. `place` is what turns
       them into a place in a file, because inside a merged run there is no
       constant offset between what is drawn and what is on disk. */
    expect(narrow('a paragraph with a tpyo in it', 'a paragraph with a typo in it')).toEqual({
      at: 20,
      upto: 22,
      text: 'yp',
    })
  })

  test('an insertion is a zero-width range, and a deletion writes nothing', () => {
    expect(narrow('two words', 'two more words')).toEqual({ at: 4, upto: 4, text: 'more ' })
    expect(narrow('two more words', 'two words')).toEqual({ at: 4, upto: 9, text: '' })
  })

  test('a change at the very start and at the very end', () => {
    expect(narrow('abc', 'Xabc')).toEqual({ at: 0, upto: 0, text: 'X' })
    expect(narrow('abc', 'abcX')).toEqual({ at: 3, upto: 3, text: 'X' })
    expect(narrow('abc', '')).toEqual({ at: 0, upto: 3, text: '' })
  })

  test('a surrogate pair is never cut in half', () => {
    /*
     * `👍` is two UTF-16 units. A prefix stopping between them would name half
     * a character, and the lone surrogates either side of the cut encode to
     * replacement characters — damage to text the edit was not even about.
     * Asserted in rendered units here and again in bytes through `place` below,
     * because both are places it could go wrong.
     */
    const found = narrow('a 👍 b', 'a 👍 c')!
    expect(found.text).toBe('c')
    expect('a 👍 b'.slice(found.at, found.upto)).toBe('b')

    const swap = narrow('x 👍 y', 'x 🙂 y')!
    expect('x 👍 y'.slice(swap.at, swap.upto)).toBe('👍')
    expect(swap.text).toBe('🙂')
  })
})

describe('place: a change in what is SEEN, turned into a place in the file', () => {
  test('inside one literal piece it is exact', () => {
    const source = 'the tpyo here'
    const found = place([word(source, 0)], narrow(source, 'the typo here')!)
    /* `the t` is common to both, so the write is the two letters that swapped
       and not the word — which is the whole point of narrowing. */
    expect(found).toEqual({ from: 5, to: 7, text: 'yp' })
    expect(source.slice(5, 7)).toBe('py')
    expect(apply(source, landed(found))).toBe('the typo here')
  })

  test('bytes, not characters, when a multi-byte character sits above the edit', () => {
    /*
     * The bug this is written against is the one `inBytes` in the parser was
     * written against, one layer up. An em dash is one UTF-16 unit and three
     * bytes, so an edit after one is three bytes along and not one. Counted in
     * characters this would land two bytes early — inside the dash — and write
     * two halves of a character into the file.
     */
    const source = 'one — two'
    const found = landed(place([word(source, 0)], narrow(source, 'one — three')!))
    expect(found.from).toBe(bytesOf('one — t'))
    expect(found.from).toBe(9)
    expect(apply(source, found)).toBe('one — three')
  })

  test('a surrogate pair keeps both ends on UTF-8 boundaries', () => {
    const source = 'x 👍 y'
    const found = landed(place([word(source, 0)], narrow(source, 'x 🙂 y')!))
    const bytes = Buffer.from(source, 'utf8')
    expect(onBoundary(bytes, found.from)).toBe(true)
    expect(onBoundary(bytes, found.to)).toBe(true)
    expect(apply(source, found)).toBe('x 🙂 y')
  })

  test('the splice of what it returns is always what was typed', () => {
    /* The invariant the whole file rests on, checked over a spread of shapes
       rather than argued for once. If this ever fails, the reader typed one
       thing and the file got another. */
    const cases: [string, string][] = [
      ['hello world', 'hello brave world'],
      ['hello world', 'hell world'],
      ['Tiivistelmä ja päätelmä', 'Tiivistelmä ja johtopäätelmä'],
      ['aaa', 'aa'],
      ['aaa', 'aaaa'],
      ['the — dash', 'the – dash'],
    ]
    for (const [before, after] of cases) {
      const change = narrow(before, after)
      expect(change).not.toBeNull()
      const found = place([word(before, 0)], change!)
      expect(found).not.toHaveProperty('why')
      expect(apply(before, landed(found))).toBe(after)
    }
  })
})

describe('place: writing through the gaps between words', () => {
  /*
   * The case the second pass was entirely about. A hard-wrapped paragraph draws
   * as one run — words merged with the collapsed whitespace between them — and
   * the source under it is `first\nsecond`, the newline rendering as one space.
   * Before this, one such gap made the whole paragraph untypeable: measured at
   * 1% of paragraph characters on the real thesis against 100% of headings,
   * which the person using it reported as "so I can edit the titles of sections
   * but not the text itself?".
   */
  const SOURCE = 'first\nsecond   third'
  /* `first` `\n` `second` `   ` `third`, as `normalizeWhitespace` splits it. */
  const pieces = [word('first', 0), gap('\n', 5), word('second', 6), gap('   ', 12), word('third', 15)]
  const shown = 'first second third'

  test('the pieces really do render as what the reader sees', () => {
    /* The fixture checking itself. Every assertion below is worthless if these
       offsets do not describe the string they claim to. */
    expect(pieces.map((p) => p.text).join('')).toBe(shown)
    expect(SOURCE.slice(5, 6)).toBe('\n')
    expect(SOURCE.slice(12, 15)).toBe('   ')
  })

  test('a word in the middle is corrected without touching the gaps', () => {
    const found = landed(place(pieces, narrow(shown, 'first secnod third')!))
    expect(apply(SOURCE, found)).toBe('first\nsecnod   third')
  })

  test('a word typed between two words lands beside the wrap, not on it', () => {
    /*
     * The gesture that was silently impossible: put the caret between two words
     * and type. It works now, and it turns out to cost even less than the
     * design allowed for — the insertion point sits at the START of the next
     * literal piece, so nothing snaps and the author's hard wrap survives
     * untouched. The rendered result is what the reader typed either way; this
     * asserts the cheaper of the two outcomes actually happens, because a test
     * expecting the expensive one would let a regression to it pass.
     */
    const found = landed(place(pieces, narrow(shown, 'first very second third')!))
    expect(apply(SOURCE, found)).toBe('first\nvery second   third')
    expect(found.from).toBe(found.to)
  })

  test('an edit spanning several words keeps the whitespace it did not touch', () => {
    /* `second` becomes `one two`. `narrow` has already excluded the gaps either
       side of it, so the newline before and the three spaces after are not in
       the range at all. The smallest possible write, which is what keeps an
       anchor two paragraphs down where it was. */
    const found = landed(place(pieces, narrow(shown, 'first one two third')!))
    expect(apply(SOURCE, found)).toBe('first\none two   third')
    expect(SOURCE.slice(found.from, found.to)).toBe('second')
  })

  test('deleting the space between two words welds them, and nothing else moves', () => {
    const found = landed(place(pieces, narrow(shown, 'firstsecond third')!))
    expect(apply(SOURCE, found)).toBe('firstsecond   third')
  })

  test('every offset it produces lands on a UTF-8 boundary', () => {
    /* Over an accented paragraph, because that is where bytes and characters
       come apart, and where a gap's snap could put an offset in the wrong
       place without any single-byte test noticing. */
    const src = 'Tiivistelmä\nja päätelmä'
    const accented = [word('Tiivistelmä', 0), gap('\n', 13), word('ja päätelmä', 14)]
    const drawn = accented.map((p) => p.text).join('')
    expect(drawn).toBe('Tiivistelmä ja päätelmä')
    const bytes = Buffer.from(src, 'utf8')
    for (const after of ['Tiivistelmä ja johtopäätelmä', 'Yhteenveto ja päätelmä', 'Tiivistelmä  ja päätelmä']) {
      const found = landed(place(accented, narrow(drawn, after)!))
      expect(onBoundary(bytes, found.from)).toBe(true)
      expect(onBoundary(bytes, found.to)).toBe(true)
    }
  })
})

describe('place: what it refuses', () => {
  /* `before \autocite{jones} after`. In the real page a citation carries the
     `cite` style and so never merges into a prose run at all; handed one
     anyway, because a run that DID contain one must refuse rather than write. */
  const pieces = [
    word('before', 0),
    gap(' ', 6),
    rendered('[jones]', 7, '\\autocite{jones}'),
    gap(' ', 23),
    word('after', 24),
  ]
  const shown = 'before [jones] after'

  test('an edit that starts inside a rendering', () => {
    const found = place(pieces, narrow(shown, 'before [jomes] after')!)
    expect(found).toHaveProperty('why')
    expect((found as { why: string }).why).toContain('citation')
  })

  test('an edit that merely passes THROUGH one', () => {
    /*
     * The dangerous one, and the reason the middle of the range is checked as
     * well as its two ends. A selection dragged across a citation and retyped
     * would otherwise have honest ends and a destroyed middle: `\autocite{…}`
     * replaced by the seven characters `[jones]`, silently, while somebody was
     * correcting the words either side of it.
     */
    expect(place(pieces, narrow(shown, 'beforX [jones] Xfter')!)).toHaveProperty('why')
  })

  test('a run assembled across a hole in the source', () => {
    /* Two pieces that do not meet. `place` replaces ONE range, so writing this
       would swallow whatever is in the hole — a `\todo{}` the reader cannot
       even see. `coalesce` does not build such a run; this is what means it
       cannot start to without being caught. */
    const found = place([word('one', 0), word('two', 40)], narrow('onetwo', 'onXtwo')!)
    expect(found).toHaveProperty('why')
    expect((found as { why: string }).why).toContain('unbroken')
  })

  test('no pieces at all, and a range that is not in the text', () => {
    expect(place([], { at: 0, upto: 0, text: 'x' })).toHaveProperty('why')
    expect(place([word('abc', 0)], { at: 0, upto: 99, text: 'x' })).toHaveProperty('why')
    expect(place([word('abc', 0)], { at: -1, upto: 1, text: 'x' })).toHaveProperty('why')
  })
})

describe('sourceRefuses: the guard that does not trust the caller', () => {
  test('ordinary prose and whitespace are overwritable', () => {
    expect(sourceRefuses('an ordinary run of words')).toBeNull()
    /* Whitespace is allowed HERE and refused by `whyNot` on the other side: a
       newline being replaced is the hard wrap in the middle of a sentence, and
       a newline being written would end a paragraph. */
    expect(sourceRefuses('first\nsecond')).toBeNull()
    expect(sourceRefuses('')).toBeNull()
  })

  test.each(['\\', '{', '}', '$', '&', '#', '^', '_', '~', '%'])(
    'source containing “%s” is never overwritten',
    (character) => {
      expect(sourceRefuses(`some ${character} source`)).toBeString()
    },
  )

  test('it is what stops a command being deleted, whatever the caller claims', () => {
    /* The page decides what to write from the pieces it holds; this decides
       whether the FILE agrees. A bug in the browser, an agent that guessed, or
       a replayed request with the numbers changed cannot get past it. */
    expect(sourceRefuses('\\autocite{jones}')).toBeString()
    expect(sourceRefuses('\\emph{stressed}')).toBeString()
    expect(sourceRefuses('% a comment run')).toBeString()
  })
})

describe('whyNot: what may be typed into a paper', () => {
  test('ordinary prose is written', () => {
    expect(whyNot('a corrected sentence, with punctuation — and an accent: ä')).toBeNull()
    expect(whyNot('')).toBeNull()
  })

  test.each(['\\', '{', '}', '$', '&', '#', '^', '_', '~', '%'])(
    '“%s” is refused rather than escaped',
    (character) => {
      /* Refused, with the reason in the sentence, because escaping is right in
         prose and wrong inside verbatim and maths — and this door cannot tell
         which one it is standing in. The argument is on `SPECIAL`. */
      const why = whyNot(`fifty ${character} of cases`)
      expect(why).toBeString()
      expect(why).toContain('markup')
    },
  )

  test('a line break is refused, because a blank one ends a paragraph', () => {
    expect(whyNot('one line\ntwo lines')).toContain('line break')
    expect(whyNot('a\rb')).toBeString()
    expect(whyNot('a\tb')).toBeString()
  })

  test('a paste of a whole document is refused by size', () => {
    expect(whyNot('a'.repeat(20_001))).toContain('20000')
  })
})

describe('onBoundary', () => {
  const bytes = Buffer.from('aä👍b', 'utf8')

  test('a continuation byte is not a place', () => {
    /* `a` is 1 byte, `ä` is 2, `👍` is 4. So 0, 1, 3, 7 and 8 are boundaries
       and everything between them is inside a character. */
    const places = [0, 1, 3, 7, 8]
    for (let at = 0; at <= bytes.length; at++) {
      expect(onBoundary(bytes, at)).toBe(places.includes(at))
    }
  })

  test('outside the buffer is never a place, and the end always is', () => {
    expect(onBoundary(bytes, -1)).toBe(false)
    expect(onBoundary(bytes, bytes.length + 1)).toBe(false)
    expect(onBoundary(bytes, bytes.length)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * writeRange, against a real paper on a real disk
 * ------------------------------------------------------------------ */

let root = ''
let project = ''
let paperDir = ''

const MAIN = [
  '\\title{A paper that can be corrected}',
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim, in a sentence with a tpyo.',
  '',
  '\\include{chapters/second}',
  '',
  '\\end{document}',
  '',
].join('\n')

const CHAPTER = ['\\section{The second}', '', 'A sentence in a chapter, with an accent: Tiivistelmä.', ''].join('\n')

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-edit-')))
  project = join(root, 'project')
  paperDir = join(project, '.kehikot', 'paper', 'a-paper')
  mkdirSync(join(paperDir, 'chapters'), { recursive: true })
  writeFileSync(join(paperDir, 'main.tex'), MAIN)
  writeFileSync(join(paperDir, 'chapters', 'second.tex'), CHAPTER)
  /* A file the paper does not `\include`, to prove the door will not write to
     whatever happens to be lying beside a paper. */
  writeFileSync(join(paperDir, 'scratch.tex'), 'notes to self\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const open = () => readPaper('a-paper', project)!
const mainNow = () => readFileSync(join(paperDir, 'main.tex'), 'utf8')

/** Where a string starts in a file, in BYTES, which is what the door takes. */
function at(source: string, needle: string): number {
  return bytesOf(source.slice(0, source.indexOf(needle)))
}

describe('writeRange: the edit that lands', () => {
  test('a typo is corrected, and nothing else in the file moves', () => {
    const paper = open()
    const from = at(MAIN, 'tpyo')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from, to: from + 4, text: 'typo', was: paper.hashes['main.tex']!, },
      project,
    )
    expect(written.ok).toBe(true)
    expect(mainNow()).toBe(MAIN.replace('tpyo', 'typo'))
  })

  test('an insertion, a deletion, and both leave the rest of the file byte-identical', () => {
    const paper = open()
    const from = at(MAIN, 'sentence')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from, to: from, text: 'long ', was: paper.hashes['main.tex']! },
      project,
    )
    expect(written.ok).toBe(true)
    expect(mainNow()).toBe(MAIN.replace('in a sentence', 'in a long sentence'))

    const again = open()
    const cut = at(mainNow(), 'long ')
    expect(
      writeRange(
        'a-paper',
        { file: 'main.tex', from: cut, to: cut + 5, text: '', was: again.hashes['main.tex']! },
        project,
      ).ok,
    ).toBe(true)
    expect(mainNow()).toBe(MAIN)
  })

  test('a chapter is written through its own hash and its own offsets', () => {
    /*
     * The failure this rules out is the quiet one: a paper is `main.tex` plus
     * its chapters, every offset is per file, and both files have a byte 40. An
     * edit that took the wrong file's hash would be refused as stale — which is
     * safe — but one that took the wrong file's OFFSETS would land in a real
     * place in the wrong document.
     */
    const paper = open()
    expect(Object.keys(paper.hashes).sort()).toEqual(['chapters/second.tex', 'main.tex'])
    const from = at(CHAPTER, 'Tiivistelmä')
    const written = writeRange(
      'a-paper',
      {
        file: 'chapters/second.tex',
        from,
        to: from + bytesOf('Tiivistelmä'),
        text: 'Yhteenveto',
        was: paper.hashes['chapters/second.tex']!,
      },
      project,
    )
    expect(written.ok).toBe(true)
    expect(readFileSync(join(paperDir, 'chapters', 'second.tex'), 'utf8')).toBe(
      CHAPTER.replace('Tiivistelmä', 'Yhteenveto'),
    )
    /* And `main.tex` was not touched, which its hash proves better than a
       comparison of its text would. */
    expect(open().hashes['main.tex']).toBe(paper.hashes['main.tex'])
  })

  test('an accented file is edited in bytes and not in characters', () => {
    /*
     * `Tiivistelmä` has one two-byte character in it, so every offset after the
     * `ä` differs between the two counting schemes. Editing the word AFTER it
     * is the case a character-counting door gets wrong by exactly one, which
     * looks like an off-by-one and is a corrupted file.
     */
    const source = 'Tiivistelmä ja päätelmä ja loppu.\n'
    writeFileSync(join(paperDir, 'chapters', 'second.tex'), source)
    const paper = open()
    const from = at(source, 'loppu')
    const written = writeRange(
      'a-paper',
      {
        file: 'chapters/second.tex',
        from,
        to: from + bytesOf('loppu'),
        text: 'alku',
        was: paper.hashes['chapters/second.tex']!,
      },
      project,
    )
    expect(written.ok).toBe(true)
    expect(readFileSync(join(paperDir, 'chapters', 'second.tex'), 'utf8')).toBe(
      'Tiivistelmä ja päätelmä ja alku.\n',
    )
  })

  test('the answer carries a hash that the next edit can be made against', () => {
    const paper = open()
    const from = at(MAIN, 'tpyo')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from, to: from + 4, text: 'typo', was: paper.hashes['main.tex']! },
      project,
    )
    expect(written.ok).toBe(true)
    /* The same string a fresh read would hand out, which is what makes it
       possible for the door to answer a write and a re-read in one reply
       without the two disagreeing. */
    expect(written.ok && written.hash).toBe(open().hashes['main.tex']!)
  })
})

describe('writeRange: the file moved underneath, which is the refusal that matters', () => {
  test('an edit against a hash that is no longer the file is refused, and writes nothing', () => {
    const paper = open()
    const stale = paper.hashes['main.tex']!
    /* Somebody else — an author in a real editor, an agent rewriting a chapter
       — changes the file after the page read it. */
    writeFileSync(join(paperDir, 'main.tex'), MAIN.replace('\\section{A claim}', '\\section{A claim, restated}'))
    const now = mainNow()

    const from = at(MAIN, 'tpyo')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from, to: from + 4, text: 'typo', was: stale },
      project,
    )
    expect(written.ok).toBe(false)
    expect(written.ok === false && written.stale).toBe(true)
    expect(mainNow()).toBe(now)
  })

  test('a same-LENGTH edit by somebody else is still caught, which is why it is a hash', () => {
    /*
     * The whole argument for not using `sourceLength`. A spelling correction by
     * another writer is a same-length rewrite almost by construction, and a
     * length check waves it through — after which these offsets are measured
     * against a document that no longer exists and the splice lands in text
     * nobody meant to touch.
     */
    const paper = open()
    const stale = paper.hashes['main.tex']!
    const moved = MAIN.replace('The claim, in a sentence', 'The CLAIM, in a sentence')
    expect(moved.length).toBe(MAIN.length)
    writeFileSync(join(paperDir, 'main.tex'), moved)

    const from = at(MAIN, 'tpyo')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from, to: from + 4, text: 'typo', was: stale },
      project,
    )
    expect(written.ok === false && written.stale).toBe(true)
    expect(mainNow()).toBe(moved)
  })

  test('two edits against the same read: the first lands, the second is stale', () => {
    /* Two containers, or one container and one very quick reader. The second
       edit is arithmetically fine and describes a document that stopped
       existing a moment ago, which is exactly the case a range-local check
       cannot see. */
    const paper = open()
    const was = paper.hashes['main.tex']!
    const first = at(MAIN, 'tpyo')
    expect(writeRange('a-paper', { file: 'main.tex', from: first, to: first + 4, text: 'typo', was }, project).ok).toBe(
      true,
    )
    const second = at(MAIN, 'claim,')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from: second, to: second + 5, text: 'point', was },
      project,
    )
    expect(written.ok === false && written.stale).toBe(true)
  })

  test('no hash at all is a staleness refusal, not a write', () => {
    const from = at(MAIN, 'tpyo')
    const written = writeRange('a-paper', { file: 'main.tex', from, to: from + 4, text: 'typo', was: '' }, project)
    expect(written.ok === false && written.stale).toBe(true)
    expect(mainNow()).toBe(MAIN)
  })
})

describe('writeRange: everything it refuses', () => {
  const good = () => ({ file: 'main.tex', from: at(MAIN, 'tpyo'), to: at(MAIN, 'tpyo') + 4, was: '' })

  test('a file the paper does not include, however real it is', () => {
    const written = writeRange(
      'a-paper',
      { ...good(), file: 'scratch.tex', from: 0, to: 1, text: 'x', was: 'anything' },
      project,
    )
    expect(written.ok).toBe(false)
    expect(readFileSync(join(paperDir, 'scratch.tex'), 'utf8')).toBe('notes to self\n')
  })

  test('a path that climbs out of the paper', () => {
    writeFileSync(join(project, 'secrets.tex'), 'private\n')
    for (const file of ['../../../secrets.tex', '/etc/hosts', 'chapters/../../secrets.tex']) {
      const written = writeRange('a-paper', { ...good(), file, from: 0, to: 0, text: 'x', was: 'y' }, project)
      expect(written.ok).toBe(false)
    }
    expect(readFileSync(join(project, 'secrets.tex'), 'utf8')).toBe('private\n')
  })

  test('a range that is not inside the file', () => {
    const paper = open()
    const was = paper.hashes['main.tex']!
    const bytes = Buffer.byteLength(MAIN)
    for (const range of [
      { from: -1, to: 4 },
      { from: 0, to: bytes + 1 },
      { from: 10, to: 4 },
      { from: 1.5, to: 4 },
      { from: Number.NaN, to: 4 },
    ]) {
      const written = writeRange('a-paper', { file: 'main.tex', ...range, text: 'x', was }, project)
      expect(written.ok).toBe(false)
      expect(written.ok === false && written.stale).toBe(false)
    }
    expect(mainNow()).toBe(MAIN)
  })

  test('a range that cuts a character in half', () => {
    const source = 'Tiivistelmä ja loppu.\n'
    writeFileSync(join(paperDir, 'chapters', 'second.tex'), source)
    const paper = open()
    /* One byte into the two-byte `ä`. A door counting characters would think
       this a perfectly ordinary offset. */
    const inside = at(source, 'ä') + 1
    const written = writeRange(
      'a-paper',
      { file: 'chapters/second.tex', from: inside, to: inside + 1, text: 'x', was: paper.hashes['chapters/second.tex']! },
      project,
    )
    expect(written.ok).toBe(false)
    expect(written.ok === false && written.why).toContain('half')
    expect(readFileSync(join(paperDir, 'chapters', 'second.tex'), 'utf8')).toBe(source)
  })

  test('LaTeX markup, which is the refusal a reader will actually meet', () => {
    const paper = open()
    const from = at(MAIN, 'tpyo')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from, to: from + 4, text: '50% of it', was: paper.hashes['main.tex']! },
      project,
    )
    expect(written.ok).toBe(false)
    /* And the file still says `tpyo`, rather than having had the rest of the
       line commented out. */
    expect(mainNow()).toBe(MAIN)
  })

  test('an edit that changes nothing', () => {
    const paper = open()
    const from = at(MAIN, 'tpyo')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from, to: from + 4, text: 'tpyo', was: paper.hashes['main.tex']! },
      project,
    )
    expect(written.ok).toBe(false)
  })

  test('it never creates a file, and never leaves a scratch one behind', () => {
    const paper = open()
    const from = at(MAIN, 'tpyo')
    writeRange(
      'a-paper',
      { file: 'chapters/third.tex', from: 0, to: 0, text: 'x', was: 'anything' },
      project,
    )
    expect(readdirSync(join(paperDir, 'chapters'))).toEqual(['second.tex'])

    /* And after a write that DID happen, nothing of the temporary survives. */
    expect(
      writeRange(
        'a-paper',
        { file: 'main.tex', from, to: from + 4, text: 'typo', was: paper.hashes['main.tex']! },
        project,
      ).ok,
    ).toBe(true)
    expect(readdirSync(paperDir).sort()).toEqual(['chapters', 'main.tex', 'scratch.tex'])
  })

  test('an epic that is not one, and a project that has no such paper', () => {
    expect(writeRange('../../etc', { ...good(), text: 'x', was: 'y' }, project).ok).toBe(false)
    expect(writeRange('a-paper', { ...good(), text: 'x', was: 'y' }, null).ok).toBe(false)
    expect(writeRange('no-such-paper', { ...good(), text: 'x', was: 'y' }, project).ok).toBe(false)
    expect(mainNow()).toBe(MAIN)
  })
})

describe('the edit door', () => {
  const send = (body: Record<string, unknown>) =>
    answer(
      'POST',
      '/api/edit',
      new URLSearchParams(`epic=a-paper&project=${encodeURIComponent(project)}`),
      body,
    )

  test('a correction lands and the paper comes back re-read', () => {
    /*
     * One answer rather than two, so the page cannot spend the gap between a
     * write and a re-read holding offsets it already knows are wrong. Checked
     * by asking the returned paper for the hash: if it were the paper as it was
     * BEFORE the write, the next edit made against it would be refused as
     * stale, which is the symptom this shape exists to prevent.
     */
    const paper = open()
    const from = at(MAIN, 'tpyo')
    const reply = send({
      ticket: TICKET,
      file: 'main.tex',
      from,
      to: from + 4,
      text: 'typo',
      was: paper.hashes['main.tex']!,
    })
    expect(reply?.status).toBe(200)
    const body = reply?.body as { ok: boolean; paper: { hashes: Record<string, string> } }
    expect(body.ok).toBe(true)
    expect(body.paper.hashes['main.tex']).toBe(open().hashes['main.tex'])
    expect(mainNow()).toContain('typo')
  })

  test('a stale edit is a 409 and carries the paper as it now is', () => {
    const paper = open()
    writeFileSync(join(paperDir, 'main.tex'), MAIN.replace('A claim', 'A claim, restated'))
    const from = at(MAIN, 'tpyo')
    const reply = send({
      ticket: TICKET,
      file: 'main.tex',
      from,
      to: from + 4,
      text: 'typo',
      was: paper.hashes['main.tex']!,
    })
    expect(reply?.status).toBe(409)
    const body = reply?.body as { stale: boolean; paper: { hashes: Record<string, string> } }
    expect(body.stale).toBe(true)
    /* The re-read rides along, because the page's copy being out of date is the
       reason it was refused and the read is what it was going to have to do. */
    expect(body.paper.hashes['main.tex']).toBe(open().hashes['main.tex'])
  })

  test('every other refusal is a 400 and leaves the paper alone', () => {
    const paper = open()
    const from = at(MAIN, 'tpyo')
    const reply = send({
      ticket: TICKET,
      file: 'main.tex',
      from,
      to: from + 4,
      text: '\\emph{typo}',
      was: paper.hashes['main.tex']!,
    })
    expect(reply?.status).toBe(400)
    expect((reply?.body as { stale: boolean; paper?: unknown }).stale).toBe(false)
    expect((reply?.body as { paper?: unknown }).paper).toBeUndefined()
    expect(mainNow()).toBe(MAIN)
  })

  test('a body with no numbers in it is refused rather than read as byte zero', () => {
    /* `Number('')` is 0, which is a byte offset. A door that coerced would read
       a missing `from` as "the top of the file". */
    const paper = open()
    const reply = send({ ticket: TICKET, file: 'main.tex', text: 'x', was: paper.hashes['main.tex']! })
    expect(reply?.status).toBe(400)
    expect(mainNow()).toBe(MAIN)
  })

  test('an edit with no project named is a 409 and not a guess', () => {
    const reply = answer('POST', '/api/edit', new URLSearchParams('epic=a-paper'), {
      ticket: TICKET,
      file: 'main.tex',
      from: 0,
      to: 1,
      text: 'x',
      was: 'y',
    })
    expect(reply?.status).toBe(409)
    expect(mainNow()).toBe(MAIN)
  })
})
