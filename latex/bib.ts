import { parseInline, type CiteSource, type Segment } from './parse.ts'

/**
 * The bibliography, resolved the way cross-references are.
 *
 * ## What was wrong
 *
 * A citation in the source is a key — `\autocite{vanlehn2011relative}` — and
 * the reading view was showing the key, in brackets. That is unreadable as
 * prose, and the owner's words for it were "the quoted names of people" not
 * showing up. It was also worse than unreadable: a citation that resolves to a
 * real entry and one that names an entry nobody ever added looked the same,
 * a word in brackets, and the second is the one that comes out of LaTeX as a
 * bold `[?]`.
 *
 * So the `.bib` the paper names is parsed, and every citation is drawn as its
 * author and year the way `biblatex`'s APA style prints it — which is the
 * style this thesis uses and the one the PDF was checked against. A key with
 * no entry keeps its bracketed form with a `?` in it, and its tooltip says
 * what is wrong. That honesty is the feature: the author needs to see the
 * broken citation here, before the compile does.
 *
 * ## Enough BibTeX to cite from, and no more
 *
 * What a citation needs is the author list, the year, and enough of the rest
 * to recognise the entry on a card. Fields this does not understand are
 * skipped rather than guessed at, `@string` abbreviations and `#`
 * concatenation are not expanded, and a `crossref` is not followed. A
 * bibliography that leans on those renders its author and year from what is
 * in the entry itself, which for every entry in this thesis is everything.
 *
 * ## The names are decoded by the parser, not by a second table
 *
 * `K\"uttler` is not a name anybody recognises. The field values are run
 * through `parseInline`, which already knows every accent escape, `\&`, `~`
 * and the brace groups that protect capitals — so this file has no accent
 * table of its own to fall out of step with the one in `parse.ts`.
 */

export interface BibEntry {
  key: string
  /** article, book, inproceedings … */
  type: string
  /** Surnames, in the order the entry gives them. */
  authors: string[]
  year: string
  title: string
  /** Journal, book or proceedings title, when the entry names one. */
  venue: string
  /** Where the source itself can be read, when the entry says. */
  doi: string
  url: string
}

export type BibIndex = Map<string, BibEntry>

/**
 * What a paper's citations resolve against: the entries, and which files they
 * came from — the second so that a citation nothing resolved can say whether
 * the key is missing from `references.bib` or the paper named no bibliography
 * at all, which are different faults with different fixes.
 */
export interface Bibliography {
  entries: BibIndex
  /** The `.bib` files the paper named, relative to its root, that were read. */
  files: string[]
}

/** No bibliography at all: every key unresolved, and the note says why. */
export const NO_BIBLIOGRAPHY: Bibliography = { entries: new Map(), files: [] }

/**
 * The `.bib` files a preamble names, in the order it names them.
 *
 * `\addbibresource{references.bib}` is biblatex's spelling and
 * `\bibliography{a,b}` is BibTeX's, which takes several and leaves off the
 * extension. Both are read, because a paper written for one and compiled with
 * the other is not this reader's business to judge. Read off the raw source
 * rather than the blocks because both live in the preamble, which the parser
 * folds into one opaque block.
 *
 * Nothing else is searched. A `.bib` lying beside `main.tex` that the paper
 * never names is not the paper's bibliography, in the same way a picture in
 * `figures/` the paper never includes is not one of its figures — see
 * `figures` on `Paper` in `store.ts`, which is the same rule for the same
 * reason.
 */
export function bibFilesNamed(preamble: string): string[] {
  const out: string[] = []
  const add = (name: string) => {
    const file = name.trim()
    if (!file) return
    const withExt = file.endsWith('.bib') ? file : `${file}.bib`
    if (!out.includes(withExt)) out.push(withExt)
  }
  for (const m of preamble.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) add(m[1] ?? '')
  for (const m of preamble.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) for (const name of (m[1] ?? '').split(',')) add(name)
  return out
}

/**
 * Parse one `.bib` file.
 *
 * Entries are found by their `@type{key,` head and skipped when the shape is
 * wrong, so a `%` comment mentioning an `@` sign — the first line of this
 * thesis's bibliography — is not read as an entry. A key defined twice keeps
 * the FIRST definition, which is what BibTeX does (it warns and ignores the
 * repeat).
 */
export function parseBib(src: string): BibIndex {
  const index: BibIndex = new Map()

  for (let i = src.indexOf('@'); i !== -1; i = src.indexOf('@', i + 1)) {
    const head = /^@(\w+)\s*\{\s*([^,\s]+)\s*,/.exec(src.slice(i, i + 200))
    if (!head) continue
    const type = head[1]!.toLowerCase()
    /* `@comment`, `@preamble` and `@string` are not entries. The last of them
       is the one whose absence is felt: a bibliography that abbreviates its
       journals through `@string` renders them as the abbreviation's name. */
    if (type === 'comment' || type === 'preamble' || type === 'string') continue

    const bodyStart = i + head[0].length
    const bodyEnd = entryEnd(src, i + head[0].indexOf('{'))
    const fields = parseFields(src.slice(bodyStart, bodyEnd))

    const key = head[2]!
    if (!index.has(key)) {
      index.set(key, {
        key,
        type,
        authors: splitAuthors(fields.author ?? fields.editor ?? ''),
        year: (fields.year ?? fields.date ?? '').slice(0, 4),
        title: clean(fields.title ?? ''),
        venue: clean(fields.journal ?? fields.booktitle ?? fields.publisher ?? ''),
        doi: clean(fields.doi ?? ''),
        url: clean(fields.url ?? fields.howpublished ?? ''),
      })
    }
    i = bodyEnd
  }

  return index
}

/** Index of the brace that closes the entry opened at `open`. */
function entryEnd(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return src.length
}

/**
 * `field = {value}`, `field = "value"`, `field = 1998` — brace-aware, and the
 * values returned RAW. Splitting an author list has to see the braces that
 * protect a corporate name, so decoding happens after that and not here.
 */
function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)\s*=\s*/g
  let m: RegExpExecArray | null

  while ((m = re.exec(body)) !== null) {
    const name = m[1]!.toLowerCase()
    let i = m.index + m[0].length
    let value: string

    if (body[i] === '{' || body[i] === '"') {
      const close = body[i] === '{' ? '}' : '"'
      let depth = 0
      const start = ++i
      for (; i < body.length; i++) {
        if (close === '}' && body[i] === '{') depth++
        else if (body[i] === close) {
          if (depth === 0) break
          depth--
        }
      }
      value = body.slice(start, i)
      i++
    } else {
      const end = body.indexOf(',', i)
      value = body.slice(i, end === -1 ? body.length : end)
      i = end === -1 ? body.length : end
    }

    out[name] = value.trim()
    re.lastIndex = i
  }
  return out
}

/**
 * A field's value as prose: accents composed, braces gone, `~` a space, `--`
 * an en dash, hard wraps collapsed.
 *
 * Through the parser rather than through a regex, for the reason in the
 * essay at the top. The one thing added on the way out is the dash, which is
 * not inline markup to the parser but is one to a page range.
 */
function clean(value: string): string {
  return parseInline(value, 0, value.length)
    .map((s) => s.text)
    .join('')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Surnames, in the order the entry gives them.
 *
 * "Graesser, Arthur C. and Lu, Shulan" → Graesser, Lu. The comma form is
 * unambiguous; "Given Surname" takes the last word, which is wrong for a
 * "van der" and right for everybody in this bibliography. A name braced whole
 * — `{World Health Organization}` — is a corporate author and is kept whole,
 * which is what the braces are for. "and others" is BibTeX's own spelling of
 * et al., and it is dropped here so the count is right: three names and an
 * "others" is four authors, not three.
 */
export function splitAuthors(field: string): string[] {
  if (!field) return []
  return field
    .split(/\s+and\s+/i)
    .map((name) => name.trim())
    .filter((name) => name && name.toLowerCase() !== 'others')
    .map((name) => {
      if (bracedWhole(name)) return clean(name)
      const surname = name.includes(',') ? name.split(',')[0]! : name.split(/\s+/).pop()!
      return clean(surname)
    })
    .filter(Boolean)
}

/**
 * Whether a name is ONE brace group and nothing else.
 *
 * `startsWith('{') && endsWith('}')` is the obvious test and it is wrong on
 * this thesis: `{Quiroga P{\'e}rez}, Jos{\'e}` starts with a brace and ends
 * with one, and is a two-word surname protected by braces followed by a given
 * name whose accent happens to close the string. Read that way it rendered as
 * "(Quiroga Pérez, José et al., 2020)" where the PDF says "(Quiroga Pérez et
 * al., 2020)". So the first group is walked to where it closes, and the name
 * is corporate only if that is the end.
 */
function bracedWhole(name: string): boolean {
  if (!name.startsWith('{')) return false
  let depth = 0
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '\\') {
      i++
      continue
    }
    if (name[i] === '{') depth++
    else if (name[i] === '}') {
      depth--
      if (depth === 0) return i === name.length - 1
    }
  }
  return false
}

/**
 * The author part of an APA citation.
 *
 * One name stands alone, two are joined, three or more become "et al." — the
 * rule biblatex-apa applies from a work's first citation, and what the
 * compiled thesis prints. The joiner is the caller's because APA uses "&"
 * inside parentheses and "and" in running text: "(Braun & Clarke, 2006)" but
 * "Braun and Clarke (2019)", both of which are on the PDF's pages.
 */
export function authorList(entry: BibEntry, joiner: '&' | 'and' = '&'): string {
  const a = entry.authors
  if (a.length === 0) return entry.key
  if (a.length === 1) return a[0]!
  if (a.length === 2) return `${a[0]} ${joiner} ${a[1]}`
  return `${a[0]} et al.`
}

/**
 * Where to read the source.
 *
 * A DOI is the durable one, so it wins over a URL that may already have
 * rotted. Neither is invented: an entry that says nothing gets no link, and
 * the card says so rather than sending the reader to a search engine.
 */
export function entryLink(entry: BibEntry): string | null {
  if (entry.doi) {
    const doi = entry.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    return `https://doi.org/${doi}`
  }
  if (/^https?:\/\//i.test(entry.url)) return entry.url
  return null
}

/** The whole entry on one line, for the card and the tooltip. */
export function describe(entry: BibEntry): string {
  const bits = [
    entry.authors.length ? entry.authors.join(', ') : null,
    entry.year || null,
    entry.title || null,
    entry.venue || null,
  ].filter(Boolean)
  return `${bits.join(' · ')} [${entry.key}]`
}

/** What the card behind a citation shows, one card per key. */
export function citeSources(keys: readonly string[], bib: Bibliography): CiteSource[] {
  return keys.map((key) => {
    const entry = bib.entries.get(key)
    if (!entry) return { key, label: key, detail: missing(key, bib), link: null }
    return {
      key,
      label: entry.year ? `${authorList(entry, 'and')} (${entry.year})` : authorList(entry, 'and'),
      detail: describe(entry),
      link: entryLink(entry),
    }
  })
}

/** The sentence for a key nothing resolved, naming the fault it has. */
function missing(key: string, bib: Bibliography): string {
  if (bib.files.length === 0) return `${key} — the paper names no bibliography (\\addbibresource)`
  return `${key} — no entry with this key in ${bib.files.join(', ')}`
}

/**
 * The commands that put the author in the sentence rather than in brackets.
 * `citet` is natbib's spelling of `textcite`.
 */
const TEXTUAL = new Set(['textcite', 'citet', 'citeauthor', 'citeyear', 'fullcite'])

/**
 * What a citation should show.
 *
 * The command decides the shape and the bibliography decides the words.
 * `\textcite` puts the author in the sentence and the year in brackets;
 * `\citeauthor` and `\citeyear` give one or the other; everything else — and
 * `\autocite` is everything else in this thesis — is parenthetical. Several
 * keys in one parenthesis are SORTED by author and year, because that is what
 * biblatex-apa does: `\autocite{woolf2009building,vanlehn2011relative}` prints
 * "(VanLehn, 2011; Woolf, 2009)" in the PDF, and a reader comparing the two
 * should not find them disagreeing about the order of two names.
 *
 * A key with no entry keeps its bracketed key with a `?` on it — "[ghost?]" —
 * and goes last. A made-up author would hide exactly the mistake the author
 * needs to catch.
 */
export function citeText(cmd: string | undefined, keys: readonly string[], bib: Bibliography): string {
  const textual = cmd !== undefined && TEXTUAL.has(cmd)
  const known = keys.filter((key) => bib.entries.has(key)).map((key) => bib.entries.get(key)!)
  const unknown = keys.filter((key) => !bib.entries.has(key))
  const ordered = textual ? known : [...known].sort(byAuthorAndYear)

  const parts = ordered.map((entry) => {
    switch (cmd) {
      case 'citeauthor':
        return authorList(entry, 'and')
      case 'citeyear':
        return entry.year || `[${entry.key}?]`
      case 'fullcite':
        return describe(entry)
      case 'textcite':
      case 'citet':
        return entry.year ? `${authorList(entry, 'and')} (${entry.year})` : authorList(entry, 'and')
      default:
        return entry.year ? `${authorList(entry)}, ${entry.year}` : authorList(entry)
    }
  })
  for (const key of unknown) parts.push(`[${key}?]`)

  return textual ? parts.join('; ') : `(${parts.join('; ')})`
}

function byAuthorAndYear(a: BibEntry, b: BibEntry): number {
  const byAuthor = authorList(a).localeCompare(authorList(b), 'en', { sensitivity: 'base' })
  return byAuthor !== 0 ? byAuthor : a.year.localeCompare(b.year)
}

/** The tooltip: every entry behind this citation, or what is missing. */
function citeNote(keys: readonly string[], bib: Bibliography): string {
  return keys
    .map((key) => {
      const entry = bib.entries.get(key)
      return entry ? describe(entry) : missing(key, bib)
    })
    .join('\n')
}

/**
 * Resolve one citation segment. Anything else is returned as it was.
 *
 * Still derived, and the offsets untouched — the same contract `resolveRef`
 * keeps, for the same reason: "(VanLehn, 2011)" is this module's rendering of
 * `\autocite{vanlehn2011relative}` and there is no byte in the file that a
 * cursor between the `V` and the `a` could honestly be said to sit on.
 */
export function resolveCite(segment: Segment, bib: Bibliography): Segment {
  if (!segment.styles.includes('cite') || !segment.keys?.length) return segment
  const unresolved = segment.keys.some((key) => !bib.entries.has(key))
  return {
    ...segment,
    text: citeText(segment.cmd, segment.keys, bib),
    literal: false,
    note: citeNote(segment.keys, bib),
    ...(unresolved ? { unresolved } : {}),
    sources: citeSources(segment.keys, bib),
  }
}
