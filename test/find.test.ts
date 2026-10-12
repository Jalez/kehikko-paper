import { describe, expect, test } from 'bun:test'

import type { PageRect } from '../compile/synctex.ts'
import { linesOf, locate, read } from '../src/pdf/find.ts'
import { spanOf } from '../src/pdf/printed.ts'
import type { Run } from '../src/pdf/words.ts'

/*
 * Pages as pdf.js hands them over, drawn by hand: eight points a character so
 * an offset is easy to read, ten points high, lines twelve apart. Nothing in
 * `find.ts` depends on the characters being the same width, only on `xs`.
 */
const run = (x: number, y: number, text: string): Run => ({ x, y, w: text.length * 8, h: 10, text, xs: Array.from({ length: text.length + 1 }, (_, i) => i * 8) })
const LEFT = 70
const page = (n: number, lines: readonly string[], top = 100) => ({ page: n, runs: lines.map((text, i) => run(LEFT, top + i * 12, text)) })
/** SyncTeX's answer for some printed lines of a page: late, as its are — a few letters in from the margin. */
const hinted = (n: number, lines: readonly number[], top = 100): PageRect[] => lines.map((i) => ({ page: n, x: LEFT + 24, y: top + i * 12, w: 400, h: 10 }))
/** The mark for `passage` of `source`, looked for in `pages`. */
const mark = (pages: readonly { page: number; runs: Run[] }[], source: string, passage: string, hint: readonly PageRect[]) => {
  const from = source.indexOf(passage)
  if (from === -1) throw new Error(`the test's source does not say: ${passage}`)
  return locate(read(pages), spanOf(source, from, from + passage.length), hint)
}
/** What a rectangle covers of a line drawn by `page`: the characters whose middles are inside it. */
const under = (rect: PageRect, text: string) => [...text].filter((_, i) => LEFT + i * 8 + 4 >= rect.x && LEFT + i * 8 + 4 <= rect.x + rect.w).join('')

const PARA = [
  'in their own words, and received a verdict, followed by a hint, a',
  'follow-up question or the next item; the score computed when they ran out was the',
  'exercise grade (Rajala et al., 2026). EduChat keeps what the agent says with the taught',
  'material, and the students found that the students liked it.',
]
const SOURCE = [
  'in their own words, and received a verdict, followed by',
  'a hint, a follow-up question or the next item; the score computed when they ran',
  'out was the exercise grade~\\parencite{rajala2026}. EduChat keeps what the agent says with the',
  'taught material, and the students found that the students liked it.',
].join('\n')

describe('a passage is marked where its words are printed', () => {
  const pages = [page(10, PARA)]

  test('a few words inside a line: from the first letter to the last, and no further', () => {
    const { rects, how } = mark(pages, SOURCE, 'received a verdict', hinted(10, [0]))
    expect(how).toBe('words')
    expect(rects.length).toBe(1)
    expect(under(rects[0]!, PARA[0]!)).toBe('received a verdict')
    expect(rects[0]!.page).toBe(10)
  })

  test('a passage typed over three source lines and printed over three others: first word to the end of its line, whole lines, up to its last word', () => {
    const passage = 'followed by\na hint, a follow-up question or the next item; the score computed when they ran\nout was the exercise grade'
    const { rects, how } = mark(pages, SOURCE, passage, hinted(10, [0, 1, 2]))
    expect(how).toBe('words')
    expect(rects.map((rect, i) => under(rect, PARA[i]!))).toEqual(['followed by a hint, a', PARA[1]!, 'exercise grade'])
    /* To the very ends of the printed lines between, not to where SyncTeX's rectangle stopped. */
    expect(rects[0]!.x + rects[0]!.w).toBeCloseTo(LEFT + PARA[0]!.length * 8 + 1, 3)
    expect(rects[1]!.x).toBeCloseTo(LEFT - 1, 3)
  })

  test('SyncTeX is a word late and the mark is not: the first word of a source line that was printed at the end of the line above', () => {
    /* SyncTeX names only the second printed line for this source line. */
    const { rects } = mark(pages, SOURCE, 'a hint, a follow-up question', hinted(10, [1]))
    expect(rects.map((rect, i) => under(rect, PARA[i]!))).toEqual(['a hint, a', 'follow-up question'])
  })

  test('the citation in the middle of the passage is inside the mark, though the source does not spell what it prints', () => {
    const { rects, how } = mark(pages, SOURCE, 'exercise grade~\\parencite{rajala2026}. EduChat keeps', hinted(10, [2]))
    expect(how).toBe('words')
    expect(under(rects[0]!, PARA[2]!)).toBe('exercise grade (Rajala et al., 2026). EduChat keeps')
  })

  test('a sentence that closes with its citation is marked to the full stop after it; one that stops before the citation is not', () => {
    const sentence = 'out was the exercise grade~\\parencite{rajala2026}.'
    expect(under(mark(pages, SOURCE, sentence, hinted(10, [2])).rects.at(-1)!, PARA[2]!)).toBe('exercise grade (Rajala et al., 2026).')
    expect(under(mark(pages, SOURCE, 'out was the exercise grade', hinted(10, [2])).rects.at(-1)!, PARA[2]!)).toBe('exercise grade')
  })

  test('a passage that opens with a citation is marked from what the citation printed', () => {
    const printedAs = ['The format is new. Chugh et al. (2025) warn that novices over-trust a model.']
    const source = 'The format is new. \\textcite{chugh2025} warn that novices over-trust a model.'
    const { rects } = mark([page(16, printedAs)], source, '\\textcite{chugh2025} warn that novices', hinted(16, [0]))
    expect(under(rects[0]!, printedAs[0]!)).toBe('Chugh et al. (2025) warn that novices')
  })

  test('a passage that is only a citation, or only maths, is what was printed between its neighbours', () => {
    /* With the punctuation that touches it: which of it the citation printed and which the sentence, nothing here can tell. */
    expect(under(mark(pages, SOURCE, '\\parencite{rajala2026}', hinted(10, [2])).rects[0]!, PARA[2]!)).toBe('(Rajala et al., 2026).')
    const printedAs = ['Confidence was below neutral (d = −0.85) and moderate later.']
    const source = 'Confidence was below neutral ($d=-0.85$) and moderate later.'
    const { rects, how } = mark([page(35, printedAs)], source, '$d=-0.85$', hinted(35, [0]))
    expect(how).toBe('words')
    expect(under(rects[0]!, printedAs[0]!)).toBe('(d = −0.85)')
  })

  test('punctuation the passage ends with is inside the mark; punctuation it does not have is not', () => {
    expect(under(mark(pages, SOURCE, 'a verdict,', hinted(10, [0])).rects[0]!, PARA[0]!)).toBe('a verdict,')
    expect(under(mark(pages, SOURCE, 'a verdict', hinted(10, [0])).rects[0]!, PARA[0]!)).toBe('a verdict')
    expect(under(mark(pages, SOURCE, 'liked it.', hinted(10, [3])).rects[0]!, PARA[3]!)).toBe('liked it.')
  })

  test('a few letters of a word are those letters', () => {
    expect(under(mark(pages, SOURCE, 'erdic', hinted(10, [0])).rects[0]!, PARA[0]!)).toBe('erdic')
  })

  test('a word printed twice on one line: the words round it say which', () => {
    const second = SOURCE.lastIndexOf('the students')
    const found = locate(read(pages), spanOf(SOURCE, second, second + 'the students'.length), hinted(10, [3]))
    expect(found.how).toBe('words')
    expect(found.rects[0]!.x).toBeCloseTo(LEFT + PARA[3]!.lastIndexOf('the students') * 8 - 1, 3)
    const first = SOURCE.indexOf('the students')
    expect(locate(read(pages), spanOf(SOURCE, first, first + 'the students'.length), hinted(10, [3])).rects[0]!.x).toBeCloseTo(LEFT + PARA[3]!.indexOf('the students') * 8 - 1, 3)
  })

  test('where the letters are found by proportion, when a run was not measured', () => {
    const plain = [{ page: 10, runs: PARA.map((text, i) => ({ x: LEFT, y: 100 + i * 12, w: text.length * 8, h: 10, text })) }]
    expect(under(mark(plain, SOURCE, 'received a verdict', hinted(10, [0])).rects[0]!, PARA[0]!)).toBe('received a verdict')
  })
})

describe('what the page does to a sentence', () => {
  test('a word hyphenated over two lines, a ligature, curly quotes and a dash', () => {
    const printedAs = ['The agent “Kiran” asks an open ques-', 'tion — and the ﬁrst oﬃcial answer is classi-', 'ﬁed as correct.']
    const source = 'The agent ``Kiran\'\' asks an open question --- and the first official answer is classified as correct.'
    const { rects, how } = mark([page(3, printedAs)], source, 'open question --- and the first official answer is classified', hinted(3, [0, 1]))
    expect(how).toBe('words')
    expect(rects.map((rect, i) => under(rect, printedAs[i]!))).toEqual(['open ques-', 'tion — and the ﬁrst oﬃcial answer is classi-', 'ﬁed'])
  })

  test('Finnish: ä and ö as one glyph or as a letter and a dieresis, and typed either way', () => {
    const whole = ['Tässä työssä tarkastellaan sääntöjä,', 'joilla opiskelijoiden vastauksia', 'arvioidaan.']
    const split = ['Ta¨ssa¨ tyo¨ssa¨ tarkastellaan sa¨a¨nto¨ja¨,', 'joilla opiskelijoiden vastauksia', 'arvioidaan.']
    for (const printedAs of [whole, split]) {
      for (const source of ['Tässä työssä tarkastellaan sääntöjä, joilla opiskelijoiden vastauksia arvioidaan.', 'T\\"ass\\"a ty\\"oss\\"a tarkastellaan s\\"a\\"ant\\"oj\\"a, joilla opiskelijoiden vastauksia arvioidaan.']) {
        const passage = source.slice(source.indexOf('tarkastellaan'), source.indexOf(' vastauksia'))
        const { rects, how } = mark([page(2, printedAs)], source, passage, hinted(2, [0]))
        expect(how).toBe('words')
        expect(rects.length).toBe(2)
        expect(under(rects[0]!, printedAs[0]!).startsWith('tarkastellaan s')).toBe(true)
        expect(under(rects[1]!, printedAs[1]!)).toBe('joilla opiskelijoiden')
      }
    }
  })

  test('maths in the passage: the mark runs over it, from the words before to the words after', () => {
    const printedAs = ['It was small after the React (r = 0.14, 95% CI [−0.14, 0.41]) and Redux modules.']
    const source = 'It was small after the React ($r=0.14$, 95\\% CI $[-0.14,\\,0.41]$) and Redux modules.'
    const { rects, how } = mark([page(31, printedAs)], source, 'the React ($r=0.14$, 95\\% CI $[-0.14,\\,0.41]$) and Redux', hinted(31, [0]))
    expect(how).toBe('words')
    expect(under(rects[0]!, printedAs[0]!)).toBe('the React (r = 0.14, 95% CI [−0.14, 0.41]) and Redux')
  })

  test('a heading is marked without its number', () => {
    const printedAs = ['4.3.1 Thematic analysis of the rationales', 'The free-text responses form the corpus.']
    const source = '\\subsection{Thematic analysis of the rationales}\\label{sec:x}\n\nThe free-text responses form the corpus.'
    const { rects, how } = mark([page(32, printedAs)], source, '\\subsection{Thematic analysis of the rationales}', hinted(32, [0]))
    expect(how).toBe('words')
    expect(under(rects[0]!, printedAs[0]!)).toBe('Thematic analysis of the rationales')
  })
})

describe('a passage that crosses a page', () => {
  const foot = ['the rationales show most students accepting the format while some', 'kept their dissatisfaction for the grader. The answer is that students']
  const head = ['found the activity usable but not yet trustworthy. Later the students', 'said the activity was not trustworthy at any sampling temperature.']
  const source = [...foot, ...head].join('\n')
  /* The foot of one page — a footnote and the page number — and the running head of the next. */
  const pages = [
    { page: 38, runs: [...page(38, foot, 700).runs, run(LEFT, 760, '3 Plussa is the course platform.'), run(290, 800, '38')] },
    { page: 39, runs: [run(LEFT, 40, 'Chapter 5. Discussion'), ...page(39, head, 100).runs] },
  ]
  const hint = [...hinted(38, [0, 1], 700), ...hinted(39, [0, 1], 100)]

  test('is marked on both pages, and nothing between them is: not the footnote, the page number or the running head', () => {
    const { rects, how } = mark(pages, source, 'The answer is that students\nfound the activity usable', hint)
    expect(how).toBe('words')
    expect(rects.map((rect) => [rect.page, Math.round(rect.y)])).toEqual([[38, 714], [39, 102]])
    expect(under(rects[0]!, foot[1]!)).toBe('The answer is that students')
    expect(under(rects[1]!, head[0]!)).toBe('found the activity usable')
  })

  test('SyncTeX put the paragraph on two pages and the passage is all on one: only that page is marked', () => {
    const after = mark(pages, source, 'found the activity usable but not yet trustworthy', hint)
    expect(after.rects.map((rect) => rect.page)).toEqual([39])
    const before = mark(pages, source, 'accepting the format while some', hint)
    expect(before.rects.map((rect) => rect.page)).toEqual([38])
  })

  test('a word broken across the page break', () => {
    const broken = [
      { page: 38, runs: [...page(38, ['kept their dissatisfaction for the grader. The answer is that stu-'], 700).runs, run(290, 800, '38')] },
      { page: 39, runs: [run(LEFT, 40, 'Chapter 5. Discussion'), ...page(39, ['dents found the activity usable but not yet trustworthy.'], 100).runs] },
    ]
    const { rects, how } = mark(broken, 'kept their dissatisfaction for the grader. The answer is that students found the activity usable but not yet trustworthy.', 'The answer is that students found the activity', hint)
    expect(how).toBe('words')
    expect(rects.map((rect) => rect.page)).toEqual([38, 39])
    expect(under(rects[1]!, 'dents found the activity usable but not yet trustworthy.')).toBe('dents found the activity')
  })
})

describe('tables and columns', () => {
  /* A row whose first cell wrapped: its second line is BELOW the numbers that follow it in the source. */
  const cells = (y: number, first: string, rest: readonly string[]) => [run(100, y, first), ...rest.map((text, i) => run(400 + i * 90, y, text))]
  const table = {
    page: 32,
    runs: [
      ...cells(600, 'Category', ['n', '% of 426', 'mean']),
      ...cells(612, 'Positive overall experience and', ['117', '27.5', '4.60']),
      run(100, 624, 'engagement'),
      ...cells(636, 'Question clarity and feedback', ['91', '21.4', '2.40']),
      run(100, 648, 'quality'),
      ...cells(660, 'Not about the activity', ['87', '20.4', '2.00']),
    ],
  }
  const source = [
    'Category & $n$ & \\% of 426 & mean \\\\',
    '\\hline',
    'Positive overall experience and engagement & 117 & 27.5 & 4.60 \\\\',
    'Question clarity and feedback quality & 91 & 21.4 & 2.40 \\\\',
    'Not about the activity & 87 & 20.4 & 2.00 \\\\',
  ].join('\n')

  test('a row of a table whose first cell wrapped: the cell’s second line and the numbers beside its first', () => {
    const { rects, how } = mark([table], source, 'Question clarity and feedback quality & 91 & 21.4 & 2.40', [{ page: 32, x: 100, y: 636, w: 500, h: 10 }])
    expect(how).toBe('words')
    const at = rects.map((rect) => `${Math.round(rect.y)}:${Math.round(rect.x + 1)}-${Math.round(rect.x + rect.w - 1)}`)
    expect(at).toEqual(['638:100-332', '638:400-416', '638:490-522', '638:580-612', '650:100-156'])
  })

  test('a row that did not wrap', () => {
    const { rects, how } = mark([table], source, 'Not about the activity & 87', [{ page: 32, x: 100, y: 660, w: 300, h: 10 }])
    expect(how).toBe('words')
    expect(rects.length).toBe(2)
  })

  test('the same row in two tables: the one whose cells are together, never the label of one and the numbers of the other', () => {
    const first = { page: 33, runs: [run(100, 300, 'Grading and technical reliability'), run(400, 300, '20'), run(490, 300, '24')] }
    const second = { page: 34, runs: [run(100, 200, 'Grading and technical reliability'), run(400, 200, '72'), run(490, 200, '2.6')] }
    const row = 'Grading and technical reliability & 72 & 2.6 \\\\'
    const { rects, how } = mark([first, second], row, 'Grading and technical reliability & 72 & 2.6', [{ page: 34, x: 100, y: 200, w: 400, h: 10 }])
    expect(how).toBe('words')
    expect(rects.map((rect) => rect.page)).toEqual([34, 34, 34])
  })

  test('two columns: a passage runs down its own column and never into the one beside it', () => {
    const left = ['Large language models have turned', 'conversational interfaces into a', 'practical part of teaching.']
    const right = ['The answer is that students found', 'the activity usable but not yet', 'trustworthy at any temperature.']
    const two = { page: 1, runs: left.flatMap((text, i) => [run(60, 100 + i * 12, text), run(60 + 40 * 8, 100 + i * 12, right[i]!)]) }
    const { rects, how } = mark([two], left.join('\n'), 'have turned\nconversational interfaces into a\npractical part', [{ page: 1, x: 60, y: 100, w: 260, h: 34 }])
    expect(how).toBe('words')
    expect(rects.length).toBe(3)
    for (const rect of rects) expect(rect.x + rect.w).toBeLessThan(60 + 40 * 8)
  })
})

describe('when the words are not found, the printed lines SyncTeX named — whole, and nothing tighter', () => {
  const pages = [page(10, PARA)]

  test('a passage that is not on the page at all', () => {
    const source = 'A sentence that was typed after the PDF was made and is in no way printed on it.'
    const found = locate(read(pages), spanOf(source, 0, source.length), hinted(10, [1]))
    expect(found.how).toBe('lines')
    expect(found.rects.length).toBe(1)
    expect(under(found.rects[0]!, PARA[1]!)).toBe(PARA[1]!)
  })

  test('a passage that prints nothing — a comment, a label', () => {
    const source = 'Some text.\n% a note to self\nMore text.'
    const from = source.indexOf('%')
    const found = locate(read(pages), spanOf(source, from, source.indexOf('\nMore')), hinted(10, [2]))
    expect(found.how).toBe('lines')
    expect(under(found.rects[0]!, PARA[2]!)).toBe(PARA[2]!)
  })

  test('the same sentence printed twice, and SyncTeX names neither: not one of them picked', () => {
    const twice = [page(4, ['The format is new.', 'Students liked the exercise format a great deal.']), page(9, ['Students liked the exercise format a great deal.', 'It is still new.'])]
    const source = 'Students liked the exercise format a great deal.'
    const far = [{ page: 6, x: 70, y: 300, w: 200, h: 10 }]
    const found = locate(read(twice), spanOf(source, 0, source.length), far)
    expect(found.how).toBe('lines')
    expect(found.rects).toEqual(far)
  })

  test('the same sentence printed twice, and SyncTeX names one: that one', () => {
    const twice = [page(4, ['The format is new.', 'Students liked the exercise format a great deal.']), page(9, ['Students liked the exercise format a great deal.', 'It is still new.'])]
    const source = 'Students liked the exercise format a great deal.'
    const found = locate(read(twice), spanOf(source, 0, source.length), hinted(9, [0]))
    expect(found.how).toBe('words')
    expect(found.tie).toBe(true)
    expect(found.rects.map((rect) => rect.page)).toEqual([9])
  })

  test('printed once, and SyncTeX named another page: the words are believed, when there are enough of them', () => {
    const found = mark(pages, SOURCE, 'the score computed when they ran', hinted(3, [0]))
    expect(found.how).toBe('words')
    expect(found.rects[0]!.page).toBe(10)
    /* Two letters found somewhere SyncTeX did not say are not a passage found. */
    const short = 'xx it xx'
    expect(locate(read(pages), spanOf(short, 3, 5), hinted(3, [0])).how).toBe('lines')
  })

  test('with no rectangles from SyncTeX and nothing found, nothing is drawn', () => {
    const source = 'Nothing like this is printed anywhere here.'
    expect(locate(read(pages), spanOf(source, 0, source.length), []).rects).toEqual([])
  })

  test('the lines are the PDF’s own: from where their text begins to where it ends', () => {
    const rects = linesOf(read(pages), [{ page: 10, x: 200, y: 112, w: 100, h: 10 }, { page: 10, x: 90, y: 124, w: 500, h: 10 }])
    expect(rects.map((rect) => [Math.round(rect.x + 1), Math.round(rect.x + rect.w - 1)])).toEqual([[LEFT, LEFT + PARA[1]!.length * 8], [LEFT, LEFT + PARA[2]!.length * 8]])
    /* A rectangle over nothing the PDF says is kept as it is; so is one as tall as a figure. */
    const blank = { page: 10, x: 70, y: 400, w: 100, h: 10 }
    expect(linesOf(read(pages), [blank])).toEqual([blank])
    const figure = { page: 10, x: 60, y: 96, w: 500, h: 60 }
    expect(linesOf(read(pages), [figure])).toEqual([figure])
  })
})

describe('a source the PDF has not caught up with', () => {
  const pages = [page(10, PARA)]
  const line = 'a hint, a follow-up question or the next item; the score computed when they ran'
  const at = (source: string) => {
    const from = source.indexOf('a hint')
    const to = source.indexOf('\nout was')
    return locate(read(pages), spanOf(source, from, to), hinted(10, [1]))
  }
  const before = at(SOURCE)

  test('letters typed in the middle of the line the caret is on: the mark does not move', () => {
    const typed = SOURCE.replace('or the next item', 'or qqqqqqq the next item')
    const found = at(typed)
    expect(found.how).toBe('words')
    expect(found.rects).toEqual(before.rects)
  })

  test('letters typed at the end of it, and at its beginning', () => {
    expect(at(SOURCE.replace(line, `${line} qqqq`)).rects).toEqual(before.rects)
    expect(at(SOURCE.replace(line, `qqqq ${line}`)).rects).toEqual(before.rects)
  })

  test('one command that prints something unexpected costs the mark nothing', () => {
    const source = SOURCE.replace('the next item', '\\textsuperscript{the} next item')
    expect(at(source).rects).toEqual(before.rects)
  })

  test('a line rewritten altogether is not found between its neighbours: the lines SyncTeX named', () => {
    const source = SOURCE.replace(line, 'nothing here is what was compiled, not one word of this sentence was')
    expect(at(source).how).toBe('lines')
  })
})
