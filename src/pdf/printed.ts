/**
 * What a piece of LaTeX source PRINTS, as something to look for in a PDF.
 *
 * The page a passage came out on is found by looking for its words in the
 * PDF's own text (`find.ts`). The source does not say those words as the PDF
 * does: `\cite{knuth}` prints `(Knuth, 1984)`, `$n=37$` prints three glyphs in
 * another font, `\emph{x}` prints `x`, a `%` hides the rest of its line. So the
 * source is turned into a PATTERN: the letters and digits it will print, in
 * order, and — wherever it prints something this file cannot spell — a GAP, a
 * number of characters the PDF may say there instead.
 *
 * ## Only letters and digits
 *
 * Both sides are reduced to lowercase letters and digits (`letters`). That one
 * rule is what takes care of everything a justified, hyphenated, ligatured
 * page does to a sentence: spaces and line breaks, the hyphen a word is broken
 * with, `fi` printed as one glyph, `` `` '' `` printed as curly quotes, `--`
 * as a dash, `~` as a space, an accent typed as a macro. None of it is a
 * letter, so none of it is compared.
 *
 * ## When in doubt, a gap
 *
 * A command this file does not know is a gap, and so are its arguments: a
 * macro that prints its argument is still matched (the gap is as wide as the
 * argument and more), and one that prints nothing is too. Guessing that an
 * unknown argument prints would make `\vspace{2em}` four letters that are
 * nowhere on the page.
 *
 * Pure, and tested hard: `test/printed.test.ts`.
 */

/** A piece of source as the letters it prints. The three arrays are one entry per letter. */
export interface Pattern {
  /** Lowercase letters and digits, nothing else. */
  text: string
  /** How many characters the PDF may say before this letter that the source does not spell. Mostly zero. */
  gap: number[]
  /** Where in the source this letter was typed. */
  src: number[]
}

const ODD: Record<string, string> = { ß: 'ss', ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe', ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ı: 'i', ȷ: 'j', þ: 'th', Þ: 'th', ð: 'd', Ð: 'd' }
const known = new Map<string, string>()

/**
 * One character as the letters it is compared by: lowercase, without its
 * accent, a ligature as its letters, and nothing at all for anything that is
 * not a letter or a digit.
 *
 * Accents go because an engine may print `ä` as one glyph or as `a` and a
 * dieresis beside it, and the PDF's text then says either.
 */
export function letters(ch: string): string {
  const had = known.get(ch)
  if (had !== undefined) return had
  let out = ''
  for (const part of ch.normalize('NFKD')) {
    if (ODD[part] !== undefined) out += ODD[part]
    else if (/[\p{L}\p{N}]/u.test(part)) out += part.toLowerCase()
  }
  known.set(ch, out)
  return out
}

/** The widest a gap may grow, however many stand side by side. */
const WIDEST = 6000
/** What a citation or a reference may print: several authors and a year. */
const CITED = 200
/** What a display, a figure or a listing may print where it stands. */
const BLOCK = 3000

/** Commands that print their argument as it is. */
const PRINTS = new Set([
  'emph', 'textbf', 'textit', 'texttt', 'textsc', 'textsf', 'textrm', 'textup', 'textsl', 'textmd', 'textnormal', 'underline', 'mbox', 'hbox',
  'enquote', 'uppercase', 'MakeUppercase', 'lowercase', 'MakeLowercase', 'title', 'author', 'date', 'url', 'nolinkurl', 'path', 'lstinline', 'text', 'foreignquote', 'makebox', 'fbox', 'centerline', 'mathrm', 'textquote',
])
/** Commands that print a number or a label of their own before their argument. */
const HEADS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'caption', 'captionof'])
/** Commands whose LAST argument is what prints; the number is how many come before it. */
const LAST: Record<string, number> = { href: 1, textcolor: 1, colorbox: 1, multicolumn: 2, multirow: 2, hyperref: 0, scalebox: 1, resizebox: 2, foreignlanguage: 1, parbox: 1 }
/** Commands that print nothing, with how many arguments go with them. */
const SILENT: Record<string, number> = {
  label: 1, index: 1, vspace: 1, hspace: 1, pagestyle: 1, thispagestyle: 1, setlength: 2, addtolength: 2, setcounter: 2, addtocounter: 2,
  addcontentsline: 3, bibliographystyle: 1, graphicspath: 1, usepackage: 1, documentclass: 1, selectlanguage: 1, hyphenation: 1, nocite: 1,
  addbibresource: 1, cline: 1, cmidrule: 1, rule: 2, phantom: 1, vphantom: 1, hphantom: 1, end: 1, pagenumbering: 1, renewcommand: 2,
  newcommand: 2, providecommand: 2, definecolor: 3, color: 1, linespread: 1, bibliography: 1, markboth: 2, markright: 1, vskip: 0, hskip: 0,
  noindent: 0, centering: 0, raggedright: 0, raggedleft: 0, tiny: 0, scriptsize: 0, footnotesize: 0, small: 0, normalsize: 0, large: 0,
  Large: 0, LARGE: 0, huge: 0, Huge: 0, bfseries: 0, itshape: 0, ttfamily: 0, rmfamily: 0, sffamily: 0, mdseries: 0, upshape: 0, scshape: 0,
  slshape: 0, normalfont: 0, toprule: 0, midrule: 0, bottomrule: 0, hline: 0, newpage: 0, clearpage: 0, cleardoublepage: 0, pagebreak: 0,
  linebreak: 0, nolinebreak: 0, nopagebreak: 0, par: 0, medskip: 0, bigskip: 0, smallskip: 0, hfill: 0, vfill: 0, quad: 0, qquad: 0,
  appendix: 0, frontmatter: 0, mainmatter: 0, backmatter: 0, ldots: 0, dots: 0, textellipsis: 0, newline: 0, indent: 0, relax: 0,
  arraybackslash: 0, protect: 0, sloppy: 0, fussy: 0, singlespacing: 0, doublespacing: 0, onehalfspacing: 0, textbackslash: 0,
  textasciitilde: 0, textendash: 0, textemdash: 0, textbar: 0, textless: 0, textgreater: 0, textquotedblleft: 0, textquotedblright: 0,
  textquoteleft: 0, textquoteright: 0, slash: 0, space: 0, nobreakspace: 0, thinspace: 0, enspace: 0, null: 0, break: 0, item: -1,
}
/** Commands that ARE letters. */
const SAYS: Record<string, string> = { LaTeX: 'latex', TeX: 'tex', LaTeXe: 'latex2e', ss: 'ss', o: 'o', O: 'o', aa: 'a', AA: 'a', ae: 'ae', AE: 'ae', oe: 'oe', OE: 'oe', l: 'l', L: 'l', i: 'i', j: 'j' }
/** Accents typed as a word: `\v{s}`, `\c c`. The letter under them is what is compared. */
const ACCENTS = new Set(['u', 'v', 'H', 'c', 'd', 'b', 'r', 'k', 't'])
/** Environments whose insides are not prose: a gap where they stand. */
const OPAQUE = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math|tikzpicture|axis|lstlisting|verbatim|minted|algorithm|algorithmic|thebibliography|filecontents|comment)\*?$/
/** Those of them that print what is typed in them, as it is typed. */
const VERBATIM = /^(?:lstlisting|verbatim|minted)\*?$/
/** Environments that take arguments which are not text: how many. */
const TAKES: Record<string, number> = { tabular: 1, 'tabular*': 2, tabularx: 2, tabulary: 2, longtable: 1, array: 1, minipage: 1, subfigure: 1, subtable: 1, wrapfigure: 2, multicols: 1, otherlanguage: 1, adjustbox: 1, list: 2 }

/**
 * The pattern for `source`.
 *
 * `source` should begin where a paragraph does — or anywhere a command is not
 * cut in half — because a pattern read from the middle of `\cite{knuth}` has
 * `nuth` in it. `src` is in indices of `source`, so a caller that wants the
 * letters of part of it reads a paragraph and keeps the letters whose `src`
 * falls in that part: see `spanOf`.
 */
export function printed(source: string): Pattern {
  const out: Pattern = { text: '', gap: [], src: [] }
  let pending = 0
  const wild = (n: number) => {
    pending = Math.min(WIDEST, pending + n)
  }
  const say = (text: string, at: number) => {
    for (const ch of text) {
      const said = letters(ch)
      for (const one of said) {
        out.text += one
        out.gap.push(pending)
        out.src.push(at)
        pending = 0
      }
    }
  }
  /** The index just past the group that opens at `at` (`{` or `[`), or `at` when none does. */
  const past = (at: number, open: string, close: string): number => {
    if (source[at] !== open) return at
    let depth = 0
    for (let i = at; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '\\') i += 1
      else if (ch === open) depth += 1
      else if (ch === close && --depth === 0) return i + 1
    }
    return source.length
  }
  const blanks = (at: number): number => {
    while (at < source.length && (source[at] === ' ' || source[at] === '\t')) at += 1
    return source[at] === '\n' && source[at + 1] !== '\n' ? blanks(at + 1) : at
  }
  /** Skip `n` braced arguments and any bracketed ones among them, as a gap as wide as what was skipped. */
  const skip = (at: number, n: number, gap: boolean): number => {
    for (;;) {
      const next = blanks(at)
      const end = source[next] === '[' ? past(next, '[', ']') : n > 0 && source[next] === '{' ? past(next, '{', '}') : next
      if (end === next) return at
      if (source[next] === '{') n -= 1
      if (gap) wild(Math.ceil((end - next) * 1.5))
      at = end
    }
  }
  /** Read from `at` to `to`; what is in a group that prints is read by the same loop. */
  const read = (at: number, to: number): void => {
    while (at < to) {
      const ch = source[at]!
      if (ch === '%') {
        while (at < to && source[at] !== '\n') at += 1
        continue
      }
      if (ch === '$') {
        const double = source[at + 1] === '$'
        const close = source.indexOf(double ? '$$' : '$', at + (double ? 2 : 1))
        const end = close === -1 ? to : close + (double ? 2 : 1)
        wild(double ? BLOCK : 24 + 2 * (end - at))
        at = end
        continue
      }
      if (ch !== '\\') {
        say(ch, at)
        at += 1
        continue
      }
      const word = /^[a-zA-Z@]+/.exec(source.slice(at + 1, at + 40))?.[0]
      if (!word) {
        const symbol = source[at + 1] ?? ''
        at += 2
        if (symbol === '(' || symbol === '[') {
          const close = source.indexOf(symbol === '(' ? '\\)' : '\\]', at)
          const end = close === -1 ? to : close + 2
          wild(symbol === '(' ? 24 + 2 * (end - at) : BLOCK)
          at = end
        } else if (symbol === '\\') at = skip(at, 0, false)
        continue
      }
      let after = at + 1 + word.length
      if (source[after] === '*') after += 1
      if (word === 'begin') {
        const end = past(blanks(after), '{', '}')
        const name = source.slice(blanks(after) + 1, end - 1)
        if (OPAQUE.test(name)) {
          const close = source.indexOf(`\\end{${name}}`, end)
          const stop = close === -1 ? to : close
          if (VERBATIM.test(name)) {
            /* Printed as typed: its options (a caption, a language) are a gap, its body is letters. */
            const body = skip(end, name.startsWith('minted') ? 1 : 0, true)
            for (let i = body; i < stop; i += 1) say(source[i]!, i)
          } else wild(BLOCK)
          at = close === -1 ? to : close + 6 + name.length
        } else at = skip(end, TAKES[name] ?? 0, false)
        continue
      }
      if (word === 'verb') {
        const close = source.indexOf(source[after]!, after + 1)
        if (close !== -1) say(source.slice(after + 1, close), after + 1)
        at = close === -1 ? to : close + 1
        continue
      }
      if (SAYS[word] !== undefined && !/[a-zA-Z]/.test(source[after] ?? '')) {
        say(SAYS[word], at)
        at = after
        continue
      }
      const silent = SILENT[word]
      if (silent !== undefined) {
        /* `\item` prints a bullet or a number, and `\item[Term]` its term. */
        if (silent === -1) {
          wild(12)
          const next = blanks(after)
          if (source[next] === '[') {
            const end = past(next, '[', ']')
            read(next + 1, end - 1)
            after = end
          }
          at = after
        } else at = skip(after, silent, false)
        continue
      }
      const prints = PRINTS.has(word) || ACCENTS.has(word)
      const head = HEADS.has(word)
      const last = LAST[word]
      if (prints || head || last !== undefined) {
        if (head) wild(40)
        after = skip(after, last ?? 0, false)
        const open = blanks(after)
        if (source[open] === '{') {
          const end = past(open, '{', '}')
          read(open + 1, end - 1)
          at = end
        } else at = after
        continue
      }
      /* A citation, a reference, a footnote — and anything unheard of. */
      wild(/cite|ref$|^ref|footnote|thanks|marginpar|input|include/i.test(word) ? CITED : 60)
      at = skip(after, 9, true)
    }
  }
  read(0, source.length)
  return out
}

/** How much of a paragraph is read around a passage, in characters of source, and how much of it is then looked for. */
const AROUND = 1200
const CONTEXT = 48

/**
 * The pattern for the stretch `from`..`to` of `text`, with a little of what
 * is printed before and after it.
 *
 * The words either side are what tells this "the students" from the one three
 * lines up, with nothing else asked: `core` is the part of the pattern that is
 * the passage itself, and the rest is only there to be found beside it. The
 * paragraph is read from its beginning so that no command is read from its
 * middle; a paragraph ends at a blank line.
 */
export interface Sought {
  pattern: Pattern
  /** Which letters of the pattern are the passage itself; the rest stand round it. */
  core: readonly [number, number]
  /** Whether the passage begins, and ends, with punctuation: the mark is carried over it. */
  punctuated: { before: boolean; after: boolean }
  /** Whether the passage begins, and ends, with something that is a gap — a citation, maths: the mark is carried over what it printed. */
  gapped: { before: boolean; after: boolean }
}

export function spanOf(text: string, from: number, to: number): Sought {
  /* Back to the last blank line; failing one near enough, to the start of a
     line — never the middle of one, where a `%` or a command may be open. */
  const base = Math.max(0, from - AROUND)
  const back = text.slice(base, from)
  let start = base
  let blank: RegExpExecArray | null = null
  const blanks = /\n[ \t]*\n/g
  for (let found = blanks.exec(back); found; found = blanks.exec(back)) blank = found
  if (blank) start = base + blank.index + blank[0].length
  else if (base > 0) start = back.includes('\n') ? base + back.indexOf('\n') + 1 : from
  const ahead = /\n[ \t]*\n/.exec(text.slice(to, to + AROUND))
  const end = ahead ? to + ahead.index : Math.min(text.length, to + AROUND)
  const all = printed(text.slice(start, end))
  let a = all.src.findIndex((at) => at + start >= from)
  if (a === -1) a = all.src.length
  let b = all.src.findIndex((at) => at + start >= to)
  if (b === -1) b = all.src.length
  const lo = Math.max(0, a - CONTEXT)
  const hi = Math.min(all.text.length, b + CONTEXT)
  const gap = all.gap.slice(lo, hi)
  if (gap.length) gap[0] = 0
  /* What the passage has before its first letter and after its last. Something
     that is a gap — a citation it opens or closes with — is part of it, and the
     mark is carried over what that printed; so is punctuation at its very ends. */
  const head = b > a ? text.slice(from, all.src[a]! + start) : ''
  const tail = b > a ? text.slice(all.src[b - 1]! + start + 1, to) : ''
  const sign = (ch: string | undefined) => ch !== undefined && !/[\s\\{}$%&~]/.test(ch)
  /* A passage with no letter of its own may still print: a citation, maths. Then it is all gap, brackets and all. */
  const bare = b > a ? false : printed(`${text.slice(from, to)} x`).gap[0]! > 0
  return {
    pattern: { text: all.text.slice(lo, hi), gap, src: all.src.slice(lo, hi).map((at) => at + start) },
    core: [a - lo, b - lo],
    punctuated: b > a ? { before: sign(head.trimStart()[0]), after: sign(tail.trimEnd().slice(-1)[0]) } : { before: bare, after: bare },
    gapped: b > a ? { before: /[\\$]/.test(head), after: /[\\$]/.test(tail) } : { before: bare, after: false },
  }
}
