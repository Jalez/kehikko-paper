import { describe, expect, test } from 'bun:test'

import { findMacros, parseLatex, type Macro, type Segment } from '../latex/parse.ts'

/**
 * The parser, on the two things that were changed when it was carried over and
 * on the one invariant that must survive being carried anywhere.
 *
 * The bulk of this file came from the program this module replaces and was
 * already exercised there. What is tested here is what is new: macro expansion,
 * the todonotes behaviour that had to change once the margin rail went away,
 * and the offset guarantee, which is the property the whole file is organised
 * around and therefore the one worth re-checking after every edit.
 */

const text = (segments: { text: string }[]) => segments.map((s) => s.text).join('')

/**
 * One paragraph of inline content, parsed the way a document is.
 *
 * Through `parseLatex` and never through `parseInline` directly, because the
 * macro table is module state that `parseLatex` installs — see the essay on
 * `Macro`. A test that called `parseInline` on a bare range would find no
 * macros and would quietly be testing the fallback, which is the behaviour half
 * of this file exists to replace.
 */
function inlineOf(src: string, macros?: ReadonlyMap<string, Macro>): Segment[] {
  const doc = parseLatex(`\\begin{document}\n\n${src}\n\n\\end{document}`, 'x.tex', macros)
  const paragraph = doc.blocks.find((b) => b.kind === 'paragraph')
  return paragraph && 'segments' in paragraph ? paragraph.segments : []
}

describe('the offset invariant', () => {
  /**
   * Every literal segment maps 1:1 onto the source it claims.
   *
   * This is the guarantee that makes every other claim in the file honest. A
   * derived segment says "the rendering differs here, do not trust an offset
   * inside me"; a literal one says the opposite, and a literal segment whose
   * text does not match its own range would be the parser lying about the one
   * thing it exists to be trusted on.
   */
  test('a literal segment’s text is exactly the source it points at', () => {
    const src = [
      '\\section{A heading with \\emph{emphasis}}',
      '',
      'A paragraph with \\texttt{code}, a citation \\autocite{knuth1984} and a ref \\ref{sec:x}.',
      '',
      '\\begin{itemize}',
      '\\item One thing',
      '\\item Another thing',
      '\\end{itemize}',
    ].join('\n')

    let checked = 0
    for (const block of parseLatex(src, 'main.tex').blocks) {
      const runs = 'segments' in block ? [block.segments] : 'items' in block ? block.items : []
      for (const run of runs) {
        for (const segment of run) {
          if (!segment.literal) continue
          expect(src.slice(segment.srcStart, segment.srcEnd)).toBe(segment.text)
          checked += 1
        }
      }
    }
    /* A test that checked nothing would pass silently, which is the failure
       mode of every loop-shaped assertion. */
    expect(checked).toBeGreaterThan(5)
  })

  test('an expanded macro claims no offsets inside itself', () => {
    /* The text `gh#` appears nowhere in `\gh{111}`, so every segment produced by
       an expansion has to be derived and carry the range of the whole call.
       A literal one here would be the parser inventing a byte range. */
    const macros = findMacros('\\newcommand{\\gh}[1]{\\texttt{gh\\##1}}')
    const segments = inlineOf('See \\gh{111} for this.', macros)
    let derived = 0
    for (const segment of segments) {
      if (!segment.text.includes('gh#') && !segment.text.includes('111')) continue
      expect(segment.literal).toBe(false)
      derived += 1
    }
    expect(derived).toBeGreaterThan(0)
  })
})

describe('macros a paper defines for itself', () => {
  const macros = findMacros(
    [
      '\\newcommand{\\gh}[1]{\\texttt{gh\\##1}}',
      '\\newcommand{\\mr}[1]{\\texttt{!#1}}',
      '\\newcommand{\\work}[1]{\\par\\smallskip\\noindent\\emph{#1}\\par\\smallskip}',
      '\\newcommand{\\nothing}{plain}',
    ].join('\n'),
  )

  test('one-argument definitions are found and no-argument ones are left alone', () => {
    expect([...macros.keys()].sort()).toEqual(['gh', 'mr', 'work'])
  })

  test('\\gh{111} reads as gh#111 rather than as the bare number', () => {
    /* Without expansion the unknown-command fallback applies — drop the
       wrapper, keep the argument — and a reference to a piece of work renders
       as a number. The reading view would then disagree with the PDF about what
       the paper says, which is the one thing it must not do. */
    expect(text(inlineOf('The work is \\gh{111} and \\mr{1801}.', macros))).toBe(
      'The work is gh#111 and !1801.',
    )
  })

  test('the escaped hash in a macro body stays a hash', () => {
    /* `\\#` is TeX's escaped hash and is not a parameter. A naive substitution
       of every `#1` is right here by luck and wrong on `\\#1`. */
    const one = findMacros('\\newcommand{\\h}[1]{\\##1 and \\#1}')
    expect(text(inlineOf('\\h{7}', one))).toContain('#7')
  })

  test('a macro that expands into another does not recurse forever', () => {
    const loop = findMacros('\\newcommand{\\a}[1]{\\a{#1}}')
    expect(text(inlineOf('\\a{x}', loop))).toBe('x')
  })

  test('nesting through a style survives, so \\work{\\gh{1}} is emphasised', () => {
    const segments = inlineOf('\\work{\\gh{111}}', macros)
    expect(text(segments)).toBe('gh#111')
    expect(segments.every((s) => s.styles.includes('emph'))).toBe(true)
  })
})

describe('todonotes, with no margin rail to put them on', () => {
  /**
   * The one behaviour changed rather than copied. Where this parser came from,
   * a `\missing{...}` collapsed to a pin and its text was lifted onto a rail
   * that could answer it. There is no rail here, so keeping that would mean the
   * text of every annotation silently disappearing behind a ◆ pointing at
   * nothing — and the page would still look complete, which is what makes it
   * the worst kind of loss.
   */
  test('the note’s text stays in the reading flow behind its pin', () => {
    const segments = inlineOf('A claim \\missing{find a citation for this} that needs support.')
    expect(text(segments)).toContain('find a citation for this')
    expect(text(segments)).toContain('◆')
  })

  test('the note is marked as not being the argument', () => {
    const segments = inlineOf('\\thought{is this true?}')
    expect(segments.length).toBeGreaterThan(0)
    expect(segments.every((s) => s.styles.includes('todo'))).toBe(true)
  })
})

describe('scanning past the end of the source', () => {
  /**
   * `/[a-zA-Z]/.test(undefined)` is `true`, because `test` stringifies its
   * argument and "undefined" is all letters. Silencing the index type with a
   * `!` would therefore have made a file ending mid-command read a name off the
   * end of the string instead of stopping.
   */
  test('a file that ends mid-command parses rather than running away', () => {
    expect(() => parseLatex('\\begin{document}\n\nA sentence and then \\emph', 'x.tex')).not.toThrow()
    expect(() => parseLatex('\\', 'x.tex')).not.toThrow()
    expect(() => parseLatex('', 'x.tex')).not.toThrow()
  })
})

describe('block ids', () => {
  test('two parses of the same source produce the same ids', () => {
    /* The counter used to run for the life of the process, so the second read
       of a paper renumbered every heading and an anchor a reader had in front
       of them scrolled nowhere. */
    const src = '\\begin{document}\n\n\\section{One}\n\nText.\n\n\\section{Two}\n\n\\end{document}'
    const a = parseLatex(src, 'x.tex').blocks.map((b) => b.id)
    const b = parseLatex(src, 'x.tex').blocks.map((b) => b.id)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(2)
  })
})
