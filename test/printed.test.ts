import { describe, expect, test } from 'bun:test'

import { letters, printed, spanOf } from '../src/pdf/printed.ts'

/** The pattern as one readable string: its letters, with `·` wherever a gap stands before one. */
const shown = (source: string): string => {
  const pattern = printed(source)
  return [...pattern.text].map((ch, k) => (pattern.gap[k]! > 0 ? `·${ch}` : ch)).join('')
}

describe('one character, as the letters it is compared by', () => {
  test('letters and digits, lowercase; nothing else is anything', () => {
    expect(letters('A')).toBe('a')
    expect(letters('7')).toBe('7')
    for (const ch of [' ', '\n', '.', ',', '-', '–', '—', '“', '”', '‘', '’', '"', '`', '(', '%', '&', '_', '~', '\u00ad', '•']) expect(letters(ch)).toBe('')
  })

  test('a ligature is its letters', () => {
    expect(letters('ﬁ')).toBe('fi')
    expect(letters('ﬂ')).toBe('fl')
    expect(letters('ﬀ')).toBe('ff')
    expect(letters('ﬃ')).toBe('ffi')
    expect(letters('ﬄ')).toBe('ffl')
  })

  test('an accented letter is the letter under the accent, whichever way the PDF spells it', () => {
    expect([...'Tässä työssä'].map(letters).join('')).toBe('tassatyossa')
    /* An engine without the glyph prints the letter and a dieresis beside it. */
    expect([...'Ta\u0308ssa\u0308 tyo\u0308ssa\u0308'].map(letters).join('')).toBe('tassatyossa')
    expect([...'a¨'].map(letters).join('')).toBe('a')
    expect([...'Åbo Šafařík Grubišić'].map(letters).join('')).toBe('abosafarikgrubisic')
    expect(letters('ß')).toBe('ss')
    expect(letters('ø')).toBe('o')
    expect(letters('Æ')).toBe('ae')
    expect(letters('ł')).toBe('l')
  })

  test('a raised digit is the digit', () => {
    expect(letters('²')).toBe('2')
  })
})

describe('what a piece of LaTeX prints', () => {
  test('prose is its letters: spaces, line breaks, ties, quotes, dashes and escaped signs are not compared', () => {
    expect(shown('The agent ``Kiran\'\' asks --- in 45--48\\% of cases~--\nan open question.')).toBe('theagentkiranasksin4548ofcasesanopenquestion')
    expect(shown('R\\&D, snake\\_case, \\#1, \\$5, \\{braces\\}')).toBe('rdsnakecase15braces')
    expect(shown('a\\,b\\ c\\-d \\\\ e')).toBe('abcde')
  })

  test('a comment is gone to the end of its line, and an escaped percent sign is not a comment', () => {
    expect(shown('kept % dropped \\cite{x}\nnext')).toBe('keptnext')
    expect(shown('95\\% of them % but not this\nagree')).toBe('95ofthemagree')
    expect(shown('% a whole line\n% and another\n')).toBe('')
  })

  test('formatting prints its argument', () => {
    expect(shown('the \\emph{graded} and \\textbf{open \\textit{chat}} surface, \\texttt{llama3.1:8b}')).toBe('thegradedandopenchatsurfacellama318b')
    expect(shown('{\\bfseries Bold} and {\\itshape slanted}')).toBe('boldandslanted')
    expect(shown('\\enquote{Better than multiple choice}')).toBe('betterthanmultiplechoice')
    expect(shown('\\href{https://example.org/x}{the site}')).toBe('thesite')
  })

  test('a citation or a reference is a gap, and what it names is not looked for', () => {
    expect(shown('to be gamed~\\parencite{grubisic2025}. Cutting')).toBe('tobegamed·cutting')
    expect(shown('\\textcite[p.~3]{chugh2025} warn')).toBe('·warn')
    expect(shown('in Sections~\\ref{sec:meth-setting} and~\\ref{sec:meth-grading}.')).toBe('insections·and')
    expect(shown('Table~\\autoref{tab:x} and \\cref{fig:y} show')).toBe('table·and·show')
    expect(printed('gamed \\parencite{a,b}. Cutting').gap.find((gap) => gap > 0)).toBeGreaterThanOrEqual(200)
  })

  test('maths is a gap as wide as what it may print', () => {
    expect(shown('React ($r=0.14$, 95\\% CI $[-0.14,\\,0.41]$) and Redux')).toBe('react·95ci·andredux')
    expect(shown('Here $g$ is an effect size')).toBe('here·isaneffectsize')
    expect(shown('before \\(a+b\\) after \\[ E = mc^2 \\] end $$x$$ done')).toBe('before·after·end·done')
    expect(shown('\\begin{equation}\n d = \\frac{a}{b}\n\\end{equation}\nwhere')).toBe('·where')
  })

  test('a command nobody has heard of is a gap, with its arguments', () => {
    expect(shown('before \\vspace*{2em} after')).toBe('beforeafter')
    expect(shown('before \\addvspace{2em} after')).toBe('before·after')
    expect(shown('the \\educhat{} system and \\missing[now]{say why} more')).toBe('the·systemand·more')
    /* Wide enough for the argument, should the command print it. */
    const pattern = printed('a \\term{chat as an exercise} b')
    expect(pattern.text).toBe('ab')
    expect(pattern.gap[1]).toBeGreaterThan('chatasanexercise'.length)
  })

  test('a heading and a caption print a number or a label first', () => {
    expect(shown('\\section{Thematic analysis of the rationales}\\label{sec:x}\nThe free-text')).toBe('·thematicanalysisoftherationalesthefreetext')
    expect(shown('\\chapter[Short]{Literature Review}')).toBe('·literaturereview')
    expect(shown('\\caption{Categories of the thematic analysis.}')).toBe('·categoriesofthethematicanalysis')
  })

  test('lists, environments and tables: what is typed between the commands', () => {
    expect(shown('\\begin{itemize}\n  \\item Opens the activity\n  \\item[Kiran] asks\n\\end{itemize}')).toBe('·openstheactivity·kiranasks')
    expect(shown('\\begin{tabular}{lrr}\n\\hline\nCategory & $n$ & mean \\\\\n\\hline\nGrading & 81 & 2.52 \\\\[2pt]\n\\end{tabular}')).toBe('category·meangrading81252')
    expect(shown('Positive overall experience and engagement & 117 & 27.5 & 100 & 4.60')).toBe('positiveoverallexperienceandengagement117275100460')
    expect(shown('\\multicolumn{2}{c}{Rated} & \\textcolor{red}{low}')).toBe('ratedlow')
    expect(shown('\\begin{figure}[p]\n\\centering\n\\includegraphics[width=\\textwidth]{figures/flow.pdf}\n\\caption{The flow.}\n\\end{figure}')).toBe('·theflow')
  })

  test('a footnote is a gap where its mark stands; a picture is a gap where it stands; a listing is its letters', () => {
    expect(shown('the platform\\footnote{Plussa is the course platform.} offers')).toBe('theplatform·offers')
    expect(shown('before\n\\begin{tikzpicture}\n\\node {You are a tutor};\n\\end{tikzpicture}\nafter')).toBe('before·after')
    /* A listing prints what is typed in it, as typed; its caption is printed somewhere beside it. */
    expect(shown('before\n\\begin{lstlisting}[caption={A prompt}]\nYou are a tutor. Score <= 0.2 \\emph{x}\n\\end{lstlisting}\nafter')).toBe('before·youareatutorscore02emphxafter')
    expect(shown('\\begin{verbatim}\n50% of {question}\n\\end{verbatim}')).toBe('50ofquestion')
  })

  test('accents typed as commands are the letter under them', () => {
    expect(shown('T\\"ass\\"a ty\\"oss\\"a, Grubi\\v{s}i\\\'{c}, Fran\\c cois, \\AA bo, stra\\ss e, sm\\o rrebr\\o d')).toBe('tassatyossagrubisicfrancoisabostrassesmorrebrod')
    expect(shown('Tässä työssä tarkastellaan sääntöjä')).toBe('tassatyossatarkastellaansaantoja')
  })

  test('every letter remembers where it was typed', () => {
    const source = 'An \\emph{open} question~\\cite{k}.'
    const pattern = printed(source)
    expect(pattern.text).toBe('anopenquestion')
    expect(pattern.src.map((at) => source[at]).join('')).toBe('Anopenquestion')
    expect(pattern.src[2]).toBe(source.indexOf('open'))
  })
})

describe('a passage with a little of what stands round it', () => {
  const text = [
    '% Chapter 2',
    '\\section{Chatbots}',
    '',
    'The third is the rigid judge familiar from earlier tutoring systems. Here answer',
    'validation converts a tool meant to help into an obstacle to be',
    'gamed~\\parencite{grubisic2025}. Cutting',
    'across all three is a calibration problem. Reviews warn that novices over-trust a model',
    'when it assists~\\parencite{chugh2025}.',
    '',
    'The next paragraph is not context.',
  ].join('\n')
  const core = (from: number, to: number) => {
    const { pattern, core } = spanOf(text, from, to)
    return { before: pattern.text.slice(0, core[0]), said: pattern.text.slice(core[0], core[1]), after: pattern.text.slice(core[1]) }
  }

  test('the passage is the core, and up to forty-eight letters either side come with it', () => {
    const from = text.indexOf('Cutting')
    const to = text.indexOf('problem.') + 'problem.'.length
    const got = core(from, to)
    expect(got.said).toBe('cuttingacrossallthreeisacalibrationproblem')
    expect(got.before).toBe('nconvertsatoolmeanttohelpintoanobstacletobegamed')
    expect(got.before.length).toBe(48)
    expect(got.after).toBe('reviewswarnthatnovicesovertrustamodelwhenitassis')
  })

  test('nothing from another paragraph, and nothing from a comment line above', () => {
    const from = text.indexOf('The third')
    const got = core(from, from + 'The third is'.length)
    expect(got.before).toBe('')
    expect(got.said).toBe('thethirdis')
    const last = text.indexOf('when it assists')
    expect(core(last, last + 'when it assists'.length).after).toBe('')
  })

  test('a passage that begins in the middle of a line is read from the start of its paragraph, so no command is cut in half', () => {
    const from = text.indexOf('Cutting')
    const { pattern, core: at } = spanOf(text, from, from + 7)
    expect(pattern.text.slice(at[0], at[1])).toBe('cutting')
    /* The citation before it is a gap, not the letters of its key. */
    expect(pattern.text).not.toContain('grubisic')
    expect(pattern.gap[at[0]]).toBeGreaterThan(0)
  })

  test('a few letters of a word are those letters', () => {
    const from = text.indexOf('calibration') + 2
    expect(core(from, from + 4).said).toBe('libr')
  })

  test('punctuation at its ends is said, and markup is not punctuation', () => {
    const from = text.indexOf('Cutting')
    const to = text.indexOf('problem.') + 'problem.'.length
    expect(spanOf(text, from, to).punctuated).toEqual({ before: false, after: true })
    expect(spanOf('He said (see below) and left', 8, 19).punctuated).toEqual({ before: true, after: true })
    expect(spanOf('an \\emph{open} question', 3, 14).punctuated).toEqual({ before: false, after: false })
  })

  test('a passage that opens or closes with a citation or maths says so', () => {
    const closes = 'short summaries \\autocite{graesser2004}. Two features'
    expect(spanOf(closes, 0, closes.indexOf(' Two'))).toMatchObject({ gapped: { before: false, after: true }, punctuated: { before: false, after: true } })
    expect(spanOf(closes, 0, closes.indexOf(' \\autocite')).gapped).toEqual({ before: false, after: false })
    const opens = 'is new. \\textcite{chugh2025} warn that'
    expect(spanOf(opens, opens.indexOf('\\textcite'), opens.length).gapped).toEqual({ before: true, after: false })
    /* Only maths: no letter of its own, and all of it a gap. A comment is neither. */
    expect(spanOf('so $d=-0.85$ holds', 3, 12).gapped).toEqual({ before: true, after: false })
    expect(spanOf('so\n% a note\nholds', 3, 11).gapped).toEqual({ before: false, after: false })
    expect(spanOf('so a value of $d=-0.85$ holds', 3, 23).gapped).toEqual({ before: false, after: true })
  })

  test('a stretch that prints nothing has no core', () => {
    const { core: at } = spanOf(text, 0, text.indexOf('\n'))
    expect(at[1] - at[0]).toBe(0)
    const label = 'Some text.\n\\label{sec:x}\nMore text.'
    const found = spanOf(label, label.indexOf('\\label'), label.indexOf('\nMore'))
    expect(found.core[1] - found.core[0]).toBe(0)
  })

  test('real passages from the thesis this was measured on', () => {
    const range = 'were broadly stable across the four modules, in\nthe range 45--48. These two patterns are interpreted in Chapter~\\ref{ch:discussion}.'
    const a = range.indexOf('modules')
    const got = spanOf(range, a, range.indexOf(' These'))
    expect(got.pattern.text.slice(got.core[0], got.core[1])).toBe('modulesintherange4548')
    const stats = 'It was small with intervals spanning zero after the\nReact ($r=0.14$, 95\\% CI $[-0.14,\\,0.41]$) and Redux ($r=0.21$) modules.'
    const all = spanOf(stats, 0, stats.length)
    expect(all.pattern.text).toBe('itwassmallwithintervalsspanningzeroafterthereact95ciandreduxmodules')
    expect(all.pattern.gap.filter((gap) => gap > 0).length).toBe(3)
  })
})
