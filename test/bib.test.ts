import { describe, expect, test } from 'bun:test'

import {
  NO_BIBLIOGRAPHY,
  authorList,
  bibFilesNamed,
  citeSources,
  citeText,
  describe as describeEntry,
  parseBib,
  resolveCite,
  type Bibliography,
} from '../latex/bib.ts'
import type { Segment } from '../latex/parse.ts'

/**
 * The bibliography, on what the compiled thesis prints.
 *
 * The shapes asserted here were read off the PDF: "(Graesser et al., 2004;
 * Nye et al., 2014)", "Braun and Clarke (2019)", and a multi-key citation
 * sorted into "(VanLehn, 2011; Woolf, 2009)" from source that wrote them the
 * other way round. The one thing not on the PDF's pages is the key with no
 * entry, and that is the case the rendering has to be most honest about.
 */

const BIB = `
% A comment mentioning an @ sign, which is not an entry.
@article{nye2014autotutor,
  author  = {Nye, Benjamin D. and Graesser, Arthur C. and Hu, Xiangen},
  title   = {{AutoTutor} and Family: A Review of 17 Years of Natural Language Tutoring},
  journal = {International Journal of Artificial Intelligence in Education},
  year    = {2014},
}

@article{vanlehn2011relative,
  author  = {VanLehn, Kurt},
  title   = {The Relative Effectiveness of Human Tutoring},
  journal = {Educational Psychologist},
  year    = {2011},
  doi     = {10.1080/00461520.2011.611369}
}

@book{woolf2009building,
  author = {Woolf, Beverly Park},
  title  = {Building Intelligent Interactive Tutors},
  year   = {2009},
}

@book{kuttler2020,
  author = {K\\"uttler, Heinrich and Rockt\\"aschel, Tim and \\v{S}koda, Ji\\v{r}\\'i},
  title  = {A Book},
  year   = {2020},
}

@inproceedings{onlyone2019,
  author    = {Solo, Ada},
  title     = {A Paper},
  booktitle = {Proceedings of Something},
  pages     = {1--10},
  year      = 2019
}

@article{braunclarke2019reflexive,
  author = {Braun, Virginia and Clarke, Victoria},
  title  = {Reflecting on reflexive thematic analysis},
  year   = {2019},
}

@misc{who2021,
  author = {{World Health Organization}},
  title  = {A Report},
  year   = {2021},
  url    = {https://example.org/report},
}

@article{crowd2020,
  author = {First, Ann and Second, Bob and others},
  year   = {2020},
}

@article{perez2020chatbots,
  author = {{Quiroga P{\\'e}rez}, Jos{\\'e} and Daradoumis, Thanasis and {Marqu{\\\`e}s Puig}, Joan Manuel},
  year   = {2020},
}
`

const bib: Bibliography = { entries: parseBib(BIB), files: ['references.bib'] }

describe('reading a .bib', () => {
  test('every entry is read and a comment with an @ in it is not one', () => {
    expect([...bib.entries.keys()].sort()).toEqual([
      'braunclarke2019reflexive', 'crowd2020', 'kuttler2020', 'nye2014autotutor', 'onlyone2019',
      'perez2020chatbots', 'vanlehn2011relative', 'who2021', 'woolf2009building',
    ])
  })

  test('surnames are taken in citation order, and an unbraced year reads', () => {
    expect(bib.entries.get('nye2014autotutor')?.authors).toEqual(['Nye', 'Graesser', 'Hu'])
    expect(bib.entries.get('onlyone2019')?.year).toBe('2019')
    expect(bib.entries.get('onlyone2019')?.venue).toBe('Proceedings of Something')
  })

  test('accents are the letters they stand for, decoded by the parser', () => {
    /* No accent table of its own: `parse.ts` already composes `\\"u` and
       `\\v{s}` into letters, and the bibliography goes through the same code. */
    expect(bib.entries.get('kuttler2020')?.authors).toEqual(['Küttler', 'Rocktäschel', 'Škoda'])
  })

  test('braces protecting a capital vanish and a corporate author stays whole', () => {
    expect(bib.entries.get('nye2014autotutor')?.title).toStartWith('AutoTutor and Family')
    expect(bib.entries.get('who2021')?.authors).toEqual(['World Health Organization'])
  })

  test('"and others" is et al. and not a fourth author', () => {
    expect(bib.entries.get('crowd2020')?.authors).toEqual(['First', 'Second'])
  })

  test('a braced two-word surname with a given name after it is a surname, not a corporation', () => {
    /* From the thesis: `{Quiroga P{\'e}rez}, Jos{\'e}` starts and ends with a
       brace and is not one group. The PDF prints "(Quiroga Pérez et al., 2020)". */
    expect(bib.entries.get('perez2020chatbots')?.authors).toEqual(['Quiroga Pérez', 'Daradoumis', 'Marquès Puig'])
    expect(citeText('autocite', ['perez2020chatbots'], bib)).toBe('(Quiroga Pérez et al., 2020)')
  })
})

describe('how a citation reads', () => {
  test('one author stands alone, two are joined, three or more are et al.', () => {
    expect(authorList(bib.entries.get('onlyone2019')!)).toBe('Solo')
    expect(authorList(bib.entries.get('braunclarke2019reflexive')!)).toBe('Braun & Clarke')
    expect(authorList(bib.entries.get('braunclarke2019reflexive')!, 'and')).toBe('Braun and Clarke')
    expect(authorList(bib.entries.get('nye2014autotutor')!)).toBe('Nye et al.')
  })

  test('\\autocite is parenthetical, with the ampersand APA puts in brackets', () => {
    expect(citeText('autocite', ['nye2014autotutor'], bib)).toBe('(Nye et al., 2014)')
    expect(citeText('parencite', ['braunclarke2019reflexive'], bib)).toBe('(Braun & Clarke, 2019)')
  })

  test('several keys in one parenthesis are sorted the way biblatex-apa sorts them', () => {
    /* The thesis writes `\\autocite{woolf2009building,vanlehn2011relative}`
       and the PDF prints "(VanLehn, 2011; Woolf, 2009)". */
    expect(citeText('autocite', ['woolf2009building', 'vanlehn2011relative'], bib)).toBe('(VanLehn, 2011; Woolf, 2009)')
  })

  test('\\textcite puts the author in the sentence, with "and" rather than "&"', () => {
    /* "Braun and Clarke (2019)" is on the PDF's page 23. */
    expect(citeText('textcite', ['braunclarke2019reflexive'], bib)).toBe('Braun and Clarke (2019)')
    expect(citeText('citet', ['nye2014autotutor'], bib)).toBe('Nye et al. (2014)')
  })

  test('\\citeauthor and \\citeyear give one half each', () => {
    expect(citeText('citeauthor', ['braunclarke2019reflexive'], bib)).toBe('Braun and Clarke')
    expect(citeText('citeyear', ['vanlehn2011relative'], bib)).toBe('2011')
  })

  test('a key the bibliography does not have keeps its key, marked, and last', () => {
    /* A made-up author would hide exactly the mistake the author needs to
       catch: this citation comes out of LaTeX as a bold [?]. */
    expect(citeText('autocite', ['ghost2030'], bib)).toBe('([ghost2030?])')
    expect(citeText('autocite', ['ghost2030', 'nye2014autotutor'], bib)).toBe('(Nye et al., 2014; [ghost2030?])')
  })

  test('an entry is described fully enough to check it is the right source', () => {
    expect(describeEntry(bib.entries.get('nye2014autotutor')!)).toBe(
      'Nye, Graesser, Hu · 2014 · AutoTutor and Family: A Review of 17 Years of Natural Language Tutoring · International Journal of Artificial Intelligence in Education [nye2014autotutor]',
    )
  })
})

describe('the sources behind a citation', () => {
  test('a DOI becomes somewhere to read it, and a URL stands in when there is no DOI', () => {
    expect(citeSources(['vanlehn2011relative'], bib)[0]).toMatchObject({
      label: 'VanLehn (2011)',
      link: 'https://doi.org/10.1080/00461520.2011.611369',
    })
    expect(citeSources(['who2021'], bib)[0]?.link).toBe('https://example.org/report')
    expect(citeSources(['woolf2009building'], bib)[0]?.link).toBeNull()
  })

  test('a doi.org prefix an entry already carries is not doubled', () => {
    const withPrefix: Bibliography = {
      entries: parseBib('@article{k, author = {A, B}, year = {2020}, doi = {https://doi.org/10.5/x}}'),
      files: ['r.bib'],
    }
    expect(citeSources(['k'], withPrefix)[0]?.link).toBe('https://doi.org/10.5/x')
  })

  test('a key with no entry says which file it is missing from, or that none was named', () => {
    expect(citeSources(['ghost'], bib)[0]).toMatchObject({ key: 'ghost', label: 'ghost', link: null })
    expect(citeSources(['ghost'], bib)[0]?.detail).toContain('references.bib')
    expect(citeSources(['ghost'], NO_BIBLIOGRAPHY)[0]?.detail).toContain('names no bibliography')
  })
})

describe('resolving a segment', () => {
  const cite = (cmd: string, ...keys: string[]): Segment => ({
    text: `[${keys.join(', ')}]`,
    srcStart: 12,
    srcEnd: 40,
    literal: false,
    styles: ['cite'],
    keys,
    cmd,
  })

  test('the text is rewritten, the offsets are not, and it stays derived', () => {
    const resolved = resolveCite(cite('autocite', 'vanlehn2011relative'), bib)
    expect(resolved.text).toBe('(VanLehn, 2011)')
    expect([resolved.srcStart, resolved.srcEnd]).toEqual([12, 40])
    expect(resolved.literal).toBe(false)
    expect(resolved.unresolved).toBeUndefined()
    expect(resolved.sources?.map((s) => s.key)).toEqual(['vanlehn2011relative'])
    expect(resolved.note).toContain('[vanlehn2011relative]')
  })

  test('one unknown key among two marks the whole citation and keeps both cards', () => {
    const resolved = resolveCite(cite('autocite', 'nye2014autotutor', 'ghost'), bib)
    expect(resolved.unresolved).toBe(true)
    expect(resolved.sources).toHaveLength(2)
  })

  test('a segment that is not a citation is the same object', () => {
    const word: Segment = { text: 'word', srcStart: 0, srcEnd: 4, literal: true, styles: [] }
    expect(resolveCite(word, bib)).toBe(word)
  })
})

describe('which files a preamble names', () => {
  test('\\addbibresource and \\bibliography are both read, with the extension supplied', () => {
    expect(bibFilesNamed('\\addbibresource{references.bib}\n\\addbibresource[datatype=bibtex]{more}')).toEqual([
      'references.bib',
      'more.bib',
    ])
    expect(bibFilesNamed('\\bibliography{a,b}')).toEqual(['a.bib', 'b.bib'])
    expect(bibFilesNamed('\\usepackage{biblatex}')).toEqual([])
  })
})
