import { describe, expect, test } from 'bun:test'

import { buildLabelIndex, mapSegments, refText, resolveRef, type LabelIndex } from '../latex/labels.ts'
import { parseLatex, type Block, type Segment } from '../latex/parse.ts'

/**
 * The label index, on the things that make a number wrong.
 *
 * The truth these encode is what the compiled thesis prints, and the cases
 * are the ones a naive counter gets wrong: a reference forward to a chapter
 * that has not been read yet, the starred abstract that takes no number, the
 * appendix that turns chapters into letters, a paper with no chapters at all,
 * and a label the author defined twice.
 */

/** One file's blocks, stamped with the file the way `readPaper` stamps them. */
function file(path: string, src: string): (Block & { file: string })[] {
  return parseLatex(src, path).blocks.map((b) => ({ ...b, file: path }))
}

const MAIN = [
  '\\documentclass{report}',
  '\\begin{document}',
  '\\chapter*{Abstract}',
  '\\label{ch:abstract}',
  'Not numbered.',
  '\\include{chapters/one}',
  '\\include{chapters/two}',
  '\\appendix',
  '\\include{chapters/extra}',
  '\\end{document}',
].join('\n')

const ONE = [
  '\\chapter{Introduction}',
  '\\label{ch:introduction}',
  '',
  'Returns as future work in Chapter~\\ref{ch:conclusion}, Section~\\ref{sec:concl-future}.',
  '',
  '\\section{Background}',
  '\\label{sec:intro-bg}',
  '',
  '\\subsection{Deeper}',
  '\\label{sec:intro-deeper}',
  '',
  '\\subsubsection{Deepest}',
  '\\label{sec:intro-deepest}',
  '',
  '\\begin{figure}',
  '\\includegraphics{a.png}',
  '\\caption{A flow, as in Chapter~\\ref{ch:conclusion}.}',
  '\\label{fig:flow}',
  '\\end{figure}',
  '',
  '\\begin{lstlisting}[caption={A prompt, with a comma},label={lst:one},breaklines=true]',
  'x = 1',
  '\\end{lstlisting}',
  '',
  '\\begin{equation*}a=b\\label{eq:starred}\\end{equation*}',
  '\\begin{equation}c=d\\label{eq:real}\\end{equation}',
].join('\n')

const TWO = [
  '\\chapter{Conclusion}',
  '\\label{ch:conclusion}',
  '',
  '\\section{Summary}',
  '\\label{sec:concl-summary}',
  '',
  '\\section{Future work}',
  '\\label{sec:concl-future}',
  '',
  '\\begin{figure}\\includegraphics{b.png}\\caption{Another.}\\label{fig:second}\\end{figure}',
  '\\begin{table}\\caption{A table.}\\label{tab:one}\\end{table}',
].join('\n')

const EXTRA = ['\\chapter{Extra}', '\\label{ch:extra}', '', '\\section{Bits}', '\\label{sec:bits}', '',
  '\\begin{figure}\\caption{Appendix figure.}\\label{fig:appendix}\\end{figure}'].join('\n')

/** The thesis-shaped paper, folded the way `readPaper` folds it. */
function thesis(): (Block & { file: string })[] {
  const out: (Block & { file: string })[] = []
  for (const block of file('main.tex', MAIN)) {
    if (block.kind !== 'include') {
      out.push(block)
      continue
    }
    const src = block.target === 'chapters/one' ? ONE : block.target === 'chapters/two' ? TWO : EXTRA
    out.push(...file(`${block.target}.tex`, src))
  }
  return out
}

const index: LabelIndex = buildLabelIndex(thesis())

describe('numbering, counted the way LaTeX counts', () => {
  test('a starred chapter takes no number, so the introduction is Chapter 1', () => {
    /* The thesis opens with `\chapter*{Abstract}` and `\chapter*{Tiivistelmä}`.
       A counter that saw those would call the introduction Chapter 3. */
    expect(index.has('ch:abstract')).toBe(false)
    expect(index.get('ch:introduction')?.number).toBe('1')
  })

  test('sections go four levels deep under their chapter', () => {
    expect(index.get('sec:intro-bg')?.number).toBe('1.1')
    expect(index.get('sec:intro-deeper')?.number).toBe('1.1.1')
    expect(index.get('sec:intro-deepest')?.number).toBe('1.1.1.1')
    expect(index.get('sec:concl-future')?.number).toBe('2.2')
  })

  test('floats start again in each chapter and carry its number', () => {
    expect(index.get('fig:flow')?.number).toBe('1.1')
    expect(index.get('fig:second')?.number).toBe('2.1')
    expect(index.get('tab:one')?.number).toBe('2.1')
  })

  test('a listing is numbered from its option-group label', () => {
    /* `\begin{lstlisting}[caption={…},label={lst:x}]` is the only place a
       listing's label can be, and the caption has a comma in it. */
    expect(index.get('lst:one')).toMatchObject({ number: '1.1', kind: 'listing', title: 'A prompt, with a comma' })
  })

  test('a starred equation is skipped and a numbered one counted', () => {
    expect(index.has('eq:starred')).toBe(false)
    expect(index.get('eq:real')?.number).toBe('1.1')
  })

  test('after \\appendix the chapters are letters, and so is what they hold', () => {
    expect(index.get('ch:extra')?.number).toBe('A')
    expect(index.get('sec:bits')?.number).toBe('A.1')
    expect(index.get('fig:appendix')?.number).toBe('A.1')
  })

  test('a paper with no chapters numbers its sections and figures plainly', () => {
    /* Every roadmap paper on this machine is an article: `\section` is the
       top, and a figure is "Figure 2", not "Figure 0.2". */
    const article = file(
      'main.tex',
      '\\begin{document}\n\\section{One}\\label{s:one}\n\\subsection{Sub}\\label{s:sub}\n' +
        '\\begin{figure}\\caption{x}\\label{f:a}\\end{figure}\n\\section{Two}\\label{s:two}\n' +
        '\\begin{figure}\\caption{y}\\label{f:b}\\end{figure}\n\\appendix\n\\section{Extra}\\label{s:extra}\n\\end{document}',
    )
    const plain = buildLabelIndex(article)
    expect(plain.get('s:one')?.number).toBe('1')
    expect(plain.get('s:sub')?.number).toBe('1.1')
    expect(plain.get('s:two')?.number).toBe('2')
    expect(plain.get('f:a')?.number).toBe('1')
    expect(plain.get('f:b')?.number).toBe('2')
    expect(plain.get('s:extra')?.number).toBe('A')
  })

  test('\\frontmatter switches numbering off and \\mainmatter switches it on', () => {
    const book = file(
      'main.tex',
      '\\begin{document}\n\\frontmatter\n\\chapter{Preface}\\label{ch:preface}\n\\mainmatter\n\\chapter{Real}\\label{ch:real}\n\\end{document}',
    )
    const numbered = buildLabelIndex(book)
    expect(numbered.has('ch:preface')).toBe(false)
    expect(numbered.get('ch:real')?.number).toBe('1')
  })

  test('a label defined twice takes the last definition, and says so', () => {
    /* What LaTeX does: the `.aux` is read top to bottom, the second
       `\newlabel` overwrites the first, and a warning nobody reads is printed.
       The number shown is the PDF's number, and the fault is in the note. */
    const twice = buildLabelIndex(
      file('main.tex', '\\begin{document}\n\\section{A}\\label{sec:x}\n\\section{B}\\label{sec:x}\n\\end{document}'),
    )
    expect(twice.get('sec:x')).toMatchObject({ number: '2', definedTwice: true })
    const seg: Segment = { text: '§sec:x', srcStart: 0, srcEnd: 10, literal: false, styles: ['ref'], keys: ['sec:x'], cmd: 'ref' }
    expect(resolveRef(seg, twice).note).toContain('defined twice')
  })
})

describe('what a reference reads as', () => {
  const ref = (cmd: string, ...keys: string[]): Segment => ({
    text: `§${keys.join(', ')}`,
    srcStart: 0,
    srcEnd: 10,
    literal: false,
    styles: ['ref'],
    keys,
    cmd,
  })

  test('a \\ref forward to a chapter parsed after it resolves to the number', () => {
    /* `ch:conclusion` is in the SECOND included file and is referred to from
       the first. The index is built over the whole paper before any segment
       is rewritten, which is the whole reason resolution is not in the parser. */
    expect(resolveRef(ref('ref', 'ch:conclusion'), index).text).toBe('2')
    expect(resolveRef(ref('ref', 'sec:concl-future'), index).text).toBe('2.2')
  })

  test('\\autoref and \\Cref name the kind, and \\cref lower-cases it', () => {
    expect(refText('autoref', ['fig:flow'], index)).toBe('Figure 1.1')
    expect(refText('Cref', ['ch:conclusion'], index)).toBe('Chapter 2')
    expect(refText('cref', ['ch:conclusion'], index)).toBe('chapter 2')
    expect(refText('Cref', ['sec:concl-summary', 'sec:concl-future'], index)).toBe('Sections 2.1 and 2.2')
  })

  test('\\eqref brackets, \\nameref spells the title out', () => {
    expect(refText('eqref', ['eq:real'], index)).toBe('(1.1)')
    expect(refText('nameref', ['ch:conclusion'], index)).toBe('Conclusion')
  })

  test('a label that does not exist keeps its placeholder and is marked', () => {
    /* A made-up number, or nothing, would hide a broken reference that will
       come out of LaTeX as `??`. */
    const resolved = resolveRef(ref('ref', 'ch:nowhere'), index)
    expect(resolved.text).toBe('§ch:nowhere')
    expect(resolved.unresolved).toBe(true)
    expect(resolved.note).toContain('no such label')
    expect(resolved.target).toBeUndefined()
  })

  test('\\pageref keeps its placeholder, because a page is a fact about the PDF', () => {
    expect(refText('pageref', ['ch:conclusion'], index)).toBe('§ch:conclusion')
  })

  test('a resolved reference is still derived, keeps its offsets, and knows its block', () => {
    const resolved = resolveRef({ ...ref('ref', 'ch:conclusion'), srcStart: 40, srcEnd: 59 }, index)
    expect(resolved.literal).toBe(false)
    expect([resolved.srcStart, resolved.srcEnd]).toEqual([40, 59])
    expect(resolved.target?.file).toBe('chapters/two.tex')
    expect(resolved.note).toBe('Chapter 2 — Conclusion')
  })

  test('something that is not a reference comes back as the same object', () => {
    const word: Segment = { text: 'word', srcStart: 0, srcEnd: 4, literal: true, styles: [] }
    expect(resolveRef(word, index)).toBe(word)
  })
})

describe('the walk over every place segments live', () => {
  test('a reference in a caption and one in a table cell are both rewritten', () => {
    const blocks = file(
      'x.tex',
      '\\begin{figure}\\caption{As in Chapter~\\ref{ch:conclusion}.}\\end{figure}\n' +
        '\\begin{table}\\caption{See \\ref{ch:conclusion}}\n\\begin{tabular}{ll}\na & \\ref{ch:conclusion} \\\\\n\\end{tabular}\\end{table}',
    )
    const resolved = blocks.map((b) => mapSegments(b, (s) => resolveRef(s, index)))
    const figure = resolved.find((b) => b.kind === 'figure')
    expect(figure?.kind === 'figure' && figure.caption.map((s) => s.text).join('')).toBe('As in Chapter 2.')
    const table = resolved.find((b) => b.kind === 'table')
    expect(table?.kind === 'table' && table.caption.map((s) => s.text).join('')).toBe('See 2')
    expect(table?.kind === 'table' && table.grid?.rows[0]?.cells[1]?.segments.map((s) => s.text).join('').trim()).toBe('2')
  })

  test('a block with nothing to rewrite is the same object, not a copy', () => {
    const block = file('x.tex', 'Plain prose.')[0]!
    expect(mapSegments(block, (s) => resolveRef(s, index))).toBe(block)
  })
})
