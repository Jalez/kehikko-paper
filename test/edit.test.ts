import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { bytesOf, narrow, onBoundary } from '../latex/edit.ts'
import { readPaper, writeFile, writeRange } from '../store.ts'

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

  test('LaTeX markup is written, because what is accepted is a diff of the source the person saw', () => {
    /* This used to be the refusal a reader would actually meet: `50% of it`
       typed into rendered prose would have commented out the rest of the line
       unseen. Nothing is typed into rendered prose any more. The range door is
       what accepting a suggestion uses, and the suggestion is shown as source. */
    const paper = open()
    const from = at(MAIN, 'tpyo')
    const written = writeRange(
      'a-paper',
      { file: 'main.tex', from, to: from + 4, text: '\\emph{typo}~\\cite{knuth}', was: paper.hashes['main.tex']! },
      project,
    )
    expect(written.ok).toBe(true)
    expect(mainNow()).toBe(MAIN.replace('tpyo', '\\emph{typo}~\\cite{knuth}'))
  })

  test('a NUL byte is the one thing no .tex holds', () => {
    const paper = open()
    const from = at(MAIN, 'tpyo')
    const written = writeRange('a-paper', { file: 'main.tex', from, to: from + 4, text: 'ty\0po', was: paper.hashes['main.tex']! }, project)
    expect(written.ok).toBe(false)
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

describe('writeFile: the whole file, guarded by what it was', () => {
  test('a save replaces the text and answers the new hash', () => {
    const paper = open()
    const next = MAIN.replace('tpyo', 'typo') + '\n% a line added at the end\n'
    const written = writeFile('a-paper', { file: 'main.tex', text: next, was: paper.hashes['main.tex']! }, project)
    expect(written.ok).toBe(true)
    expect(mainNow()).toBe(next)
    expect(written.ok && written.hash).toBe(open().hashes['main.tex']!)
  })

  test('a file that moved on disk is refused, stale, and NOTHING of theirs is lost', () => {
    const paper = open()
    const theirs = MAIN.replace('A claim', 'A claim, restated by somebody else')
    writeFileSync(join(paperDir, 'main.tex'), theirs)
    const written = writeFile('a-paper', { file: 'main.tex', text: MAIN.replace('tpyo', 'typo'), was: paper.hashes['main.tex']! }, project)
    expect(written).toMatchObject({ ok: false, stale: true })
    expect(mainNow()).toBe(theirs)
  })

  test('saving what is already there writes nothing and is not an error', () => {
    const paper = open()
    const written = writeFile('a-paper', { file: 'main.tex', text: MAIN, was: paper.hashes['main.tex']! }, project)
    expect(written).toEqual({ ok: true, bytes: Buffer.byteLength(MAIN), hash: paper.hashes['main.tex']! })
  })

  test('it never creates, never reaches a file the paper does not name, and leaves no scratch file', () => {
    const paper = open()
    expect(writeFile('a-paper', { file: 'chapters/third.tex', text: 'x', was: 'anything' }, project).ok).toBe(false)
    expect(writeFile('a-paper', { file: 'scratch.tex', text: 'x', was: 'anything' }, project).ok).toBe(false)
    expect(writeFile('a-paper', { file: '../../outside.tex', text: 'x', was: 'anything' }, project).ok).toBe(false)
    expect(writeFile('a-paper', { file: 'main.tex', text: MAIN + 'more\n', was: paper.hashes['main.tex']! }, project).ok).toBe(true)
    expect(readdirSync(paperDir).sort()).toEqual(['chapters', 'main.tex', 'scratch.tex'])
    expect(readdirSync(join(paperDir, 'chapters'))).toEqual(['second.tex'])
  })

  test('a save with no hash, and a NUL byte, are refused', () => {
    const paper = open()
    expect(writeFile('a-paper', { file: 'main.tex', text: 'x', was: '' }, project)).toMatchObject({ ok: false, stale: true })
    expect(writeFile('a-paper', { file: 'main.tex', text: 'a\0b', was: paper.hashes['main.tex']! }, project).ok).toBe(false)
    expect(mainNow()).toBe(MAIN)
  })

  test('accents survive the round trip byte for byte', () => {
    const paper = open()
    const next = CHAPTER.replace('Tiivistelmä', 'Tiivistelmä – ja lisää ääkkösiä')
    expect(writeFile('a-paper', { file: 'chapters/second.tex', text: next, was: paper.hashes['chapters/second.tex']! }, project).ok).toBe(true)
    expect(readFileSync(join(paperDir, 'chapters', 'second.tex'), 'utf8')).toBe(next)
  })
})

describe('the file door', () => {
  const send = (body: Record<string, unknown>) =>
    answer('POST', '/api/file', new URLSearchParams(`epic=a-paper&project=${encodeURIComponent(project)}`), body)

  test('a save lands and the paper comes back re-read, with the hash the next save needs', () => {
    const paper = open()
    const reply = send({ ticket: TICKET, file: 'main.tex', text: MAIN.replace('tpyo', 'typo'), was: paper.hashes['main.tex']! })
    expect(reply?.status).toBe(200)
    const body = reply?.body as { ok: boolean; hash: string; paper: { hashes: Record<string, string> } }
    expect(body.ok).toBe(true)
    expect(body.hash).toBe(open().hashes['main.tex']!)
    expect(body.paper.hashes['main.tex']).toBe(body.hash)
    expect(mainNow()).toContain('typo')
  })

  test('the last newline of a file is part of the file', () => {
    /* The door's other strings are trimmed on the way in. This one must not
       be: a save that ate the final newline would show in every diff. */
    const paper = open()
    const next = MAIN.trimEnd() + '\n\n\n'
    send({ ticket: TICKET, file: 'main.tex', text: next, was: paper.hashes['main.tex']! })
    expect(mainNow()).toBe(next)
  })

  test('a stale save is a 409 and carries the file as it now is', () => {
    const paper = open()
    const theirs = MAIN.replace('A claim', 'A claim, restated')
    writeFileSync(join(paperDir, 'main.tex'), theirs)
    const reply = send({ ticket: TICKET, file: 'main.tex', text: MAIN.replace('tpyo', 'typo'), was: paper.hashes['main.tex']! })
    expect(reply?.status).toBe(409)
    const body = reply?.body as { stale: boolean; source: string; hash: string }
    expect(body.stale).toBe(true)
    /* What is on disk rides along with its hash, so the page can put the
       choice in front of a person without a second request. */
    expect(body.source).toBe(theirs)
    expect(body.hash).toBe(open().hashes['main.tex']!)
    expect(mainNow()).toBe(theirs)
  })

  test('every other refusal is a 400 and leaves the paper alone', () => {
    const paper = open()
    const reply = send({ ticket: TICKET, file: 'scratch.tex', text: 'x', was: paper.hashes['main.tex']! })
    expect(reply?.status).toBe(400)
    expect((reply?.body as { stale: boolean }).stale).toBe(false)
    expect(mainNow()).toBe(MAIN)
  })

  test('a body with no text in it is refused rather than read as an empty file', () => {
    const paper = open()
    const reply = send({ ticket: TICKET, file: 'main.tex', was: paper.hashes['main.tex']! })
    expect(reply?.status).toBe(400)
    expect(mainNow()).toBe(MAIN)
  })

  test('a save with no project named is a 409 and not a guess', () => {
    const reply = answer('POST', '/api/file', new URLSearchParams('epic=a-paper'), { ticket: TICKET, file: 'main.tex', text: 'x', was: 'y' })
    expect(reply?.status).toBe(409)
    expect(mainNow()).toBe(MAIN)
  })

  test('the door it replaced is gone', () => {
    const reply = answer('POST', '/api/edit', new URLSearchParams(`epic=a-paper&project=${encodeURIComponent(project)}`), {
      ticket: TICKET, file: 'main.tex', from: 0, to: 1, text: 'x', was: open().hashes['main.tex']!,
    })
    expect(reply?.status).toBe(404)
    expect(mainNow()).toBe(MAIN)
  })
})
