/**
 * A picked part compiled on its own: what can be, and how it is asked for.
 *
 * ## The LaTeX way
 *
 * LaTeX has had the answer since 1985. A paper pulls its chapters in with
 * `\include`, and `\includeonly{chapters/methods}` in the preamble then
 * typesets that chapter alone — with its real chapter, section, figure and
 * page numbers, and with every reference to another chapter resolved — because
 * each `\include`d file has an `.aux` of its own, holding its labels and the
 * state of every counter at its end, and the files left out are read from
 * those instead of being typeset.
 *
 * So nothing here generates a document. `\includeonly{…}` is given to the
 * engine from OUTSIDE `main.tex`, ahead of it, and the source is the same
 * whichever part is picked: the paper is never edited and never copied.
 *
 * What it costs is said by LaTeX too. The numbers of the chapters left out are
 * those the LAST FULL BUILD saved. An edit that makes the picked chapter a page
 * longer shows at once in that chapter; that the next chapter now starts a page
 * later is not known until the whole paper is compiled again. `build.ts` says
 * when that is.
 *
 * ## What cannot be compiled on its own
 *
 * `\includeonly` filters the files `main.tex` pulls in with `\include`, and
 * nothing else. A chapter pulled in with `\input` flows on from the one before
 * it on the same sheet and has no `.aux` of its own: there is no "that file
 * alone" to ask the engine for. `planOf` says which it is, and for a part that
 * cannot be, the one sentence the pane then shows — rather than the pages of
 * the whole paper that part's file happened to print on, which look like the
 * part and are mostly its neighbours'.
 *
 * Pure: no disk and no process. `build.ts` does what this decides.
 */

/** The file every paper starts from. `store.ts` has the same word; this file imports nothing so the page can use it. */
const MAIN = 'main.tex'

/** How one file of a paper is pulled in. The shape of `Paper.pulls` in `store.ts`. */
export interface Pulled {
  by: string
  with: string
  as: string
}

/** As much of a paper as deciding reads. */
export interface Pullable {
  files: readonly string[]
  pulls?: Readonly<Record<string, Pulled>>
  narrowsItself?: boolean
}

export type Plan =
  /** `only` is what `\includeonly` is given, in the paper's order; `files` is every picked file it covers. */
  | { only: string[]; files: string[]; cannot?: undefined }
  | { cannot: string; only?: undefined }

/**
 * What `\includeonly` can be given without anything else on the line reading
 * it differently: the engine's own list separator is a comma, LaTeX removes
 * spaces from the list, and `latexmk` hands the line to a shell.
 */
const CARRIED = /^[A-Za-z0-9_.\/-]+$/

/**
 * How the picked files can be compiled on their own — or the sentence saying
 * why they cannot. Null when there is nothing picked to compile.
 *
 * `picked` is the files of the paper the picked parts own, in the paper's
 * order (`Narrowed.files`). Every one of them has to be reachable through
 * `\includeonly`: pulled in by `main.tex` with `\include`, or pulled in — at
 * any depth, by any command — by a picked file that is. One that is not makes
 * the whole selection one that cannot be shown on its own: showing the others
 * and leaving that one out would be a part with a hole in it and nothing
 * saying so.
 */
export function planOf(picked: readonly string[], paper: Pullable, where = 'the picked part'): Plan | null {
  if (!picked.length) return null
  const pulls = paper.pulls ?? {}
  const said = (why: string): Plan => ({ cannot: `No page is shown for ${where}: ${why}` })
  if (paper.narrowsItself) return said('main.tex has an \\includeonly of its own, which overrules one given from outside.')

  const included = (file: string) => pulls[file]?.with === 'include' && pulls[file]?.by === MAIN
  const only: string[] = []
  for (const file of picked) {
    const pull = pulls[file]
    if (!pull) return said(`${file} is the file the whole paper is compiled from, and only a file it pulls in with \\include can be compiled on its own.`)
    if (included(file)) {
      if (!CARRIED.test(pull.as)) return said(`the name of ${file} has a character \\includeonly cannot carry.`)
      only.push(pull.as)
      continue
    }
    /* Not `\include`d itself. It is still in the part's PDF when a picked file
       that IS pulls it in — a chapter's own table, a section split out. */
    let above = pull.by
    let covered = false
    for (let depth = 0; depth < 16 && above !== MAIN; depth += 1) {
      if (included(above) && picked.includes(above)) {
        covered = true
        break
      }
      const next = pulls[above]
      if (!next) break
      above = next.by
    }
    if (!covered) return said(`${pull.by} pulls ${file} in with \\${pull.with}, and only a file pulled in with \\include can be compiled on its own.`)
  }
  return { only, files: [...picked] }
}

/** What is put ahead of `main.tex` on the engine's line. */
export function onlyLine(only: readonly string[]): string {
  return `\\includeonly{${only.join(',')}}`
}

/** The name of the two-line file Tectonic is given, which has no "ahead of the file" on its command line. */
export const DRIVER = 'kehikot-only'

/** That file: the same line, and then the paper. */
export function driverText(only: readonly string[]): string {
  return `${onlyLine(only)}\\input{${MAIN}}\n`
}

/**
 * Which of a full build's files the next compile has to be able to read.
 *
 * Everything the engine wrote EXCEPT what it writes for people or for this
 * module: the PDF, the SyncTeX table, the logs, and `latexmk`'s own
 * bookkeeping. Said by what is left out, because what has to be kept is not a
 * list anybody can finish — `.aux` and `.bbl`, and then `.toc`, `.lof`, `.out`,
 * `.nav`, a glossary's, an index's, whatever the paper's packages write.
 */
export function isIntermediate(name: string): boolean {
  return !/\.(pdf|log|blg|fls|fdb_latexmk|synctex|xdv)$|\.synctex\.gz$/.test(name) && !name.endsWith('.tmp')
}

/**
 * Which kept selections go, when one more has been made.
 *
 * A part's PDF is kept so that coming back to a selection costs nothing. It is
 * a megabyte or two of derived files per selection, and a paper with seven
 * parts has a hundred and twenty-seven selections: so the last few USED are
 * kept and the rest are removed, oldest first. `current` is never removed.
 */
export function toEvict(kept: readonly { key: string; used: number }[], keep: number, current: string): string[] {
  const others = kept.filter((one) => one.key !== current).sort((a, b) => b.used - a.used)
  return others.slice(Math.max(0, keep - 1)).map((one) => one.key)
}

/** How many selections' builds are kept per paper. */
export const KEPT_PARTS = 4

/**
 * The references and citations a log says it could not resolve.
 *
 * A part compiled alone reads every other chapter's numbers from the last
 * full build. A `\ref` to a label that build has never seen — it was typed
 * since — prints `??`, and the log says so in these words. `build.ts` reads
 * them to know when the whole paper has to be compiled before the part is
 * right.
 */
export function unresolved(log: string): string[] {
  const out = new Set<string>()
  const joined = log.replace(/\r/g, '')
  for (const found of joined.matchAll(/(?:LaTeX|Package (?:natbib|biblatex)) Warning: (Reference|Citation) [`']([^']*)'/g)) out.add(`${found[1]} ${found[2]}`)
  return [...out]
}
