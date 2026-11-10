import { LIMITS, type FooterItemInput } from 'kehikot-module-protocol'

/**
 * What this page declares for the container's footer (`kehikot.footer`, protocol 2.38.0).
 *
 * The rule the two rows follow: the header is how the paper is set up and what
 * can be started on it (the pane, the file of the picked parts, Auto accept,
 * Compile, Commit, the answers to a suggestion), the footer is what is going on
 * now. So the footer is the line that used to sit over the editor — which file
 * is open and whether it is saved, how the build stands, the section and the
 * page — and the readouts that used to ride in the header's words: the compile
 * time and the page count from Compile's result, "the last compile failed" from
 * the PDF option, the warnings from the log's label, what the changes are
 * compared with, and which suggestion is current. Previous and Next suggestion
 * walk that readout, so they stand beside it here; "← main.tex" goes back from
 * the file named beside it. Folded to two rows, a container shows its header
 * and this footer, so this is what a person reads there.
 *
 * Declared only when the host says it draws a footer (`drawsFooter === true`);
 * with any other host the page draws its own line and the header carries the
 * readouts as it always did (`headerOf` with `footed` false). Pure, so what is
 * declared is what is tested; declared again only when its JSON differs.
 */

export interface FooterState {
  /** The file open in the editor. */
  file: string
  /** The file the whole paper starts from, when the open file is another and going back is offered. */
  main: string | null
  /** Where the editor's text stands against the disk. */
  saved: 'clean' | 'dirty' | 'saving' | 'failed'
  /** A save or a read that went wrong, in words, or null. */
  failure: string | null
  /** Null until the server has said where the build stands; then the engine, or null when there is none. */
  engine: string | null | undefined
  compiling: boolean
  /** The last run: whether it made a PDF, how long it took, and its first error. */
  ran: { ok: boolean; ms: number; first: string | null } | null
  warnings: number
  pages: number | null
  /** The PDF on show is of text that has changed since. */
  stale: boolean
  /** The run was not held to the paper's folder: the sentence for it, or null. */
  unconfined: string | null
  /** The section the caret is in, and the page of the PDF on show. */
  section: string | null
  page: number | null
  /**
   * The suggestions as the person walks them: how many stops, "2 of 5" for the
   * current one or null, and whether Next just found no more.
   */
  suggest: { stops: number; position: string | null; noMore: boolean }
  /** What the changes are compared with, in words, or why they cannot be answered just now. */
  baseline: string | null
  readOnly: boolean
  /** The changes accepted on this paper since it was opened, and how many of them automatically. */
  accepted?: { count: number; auto: number }
  /** Suggestions whose text has changed under them since they were made. */
  outOfDate?: number
}

/** The ids of what can be pressed in the footer. Previous and Next keep the header's ids: they were there. */
export const FOOT = {
  MAIN: 'main',
  PREV: 'sg-prev',
  NEXT: 'sg-next',
} as const

/** One line cut to fit with an ellipsis. */
export function clip(text: string, most: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= most ? one : `${one.slice(0, most - 1)}…`
}
const text = (words: string) => clip(words, LIMITS.FOOTER_TEXT)
const tip = (words: string) => clip(words, LIMITS.FOOTER_TOOLTIP)

const SAVED = { clean: 'Saved', dirty: 'Unsaved', saving: 'Saving…', failed: 'Not saved' } as const

/** How the build stands, in the few words a footer text has: news while it is, the seconds and pages once it has compiled. */
export function buildOf(state: Pick<FooterState, 'engine' | 'compiling' | 'ran' | 'warnings' | 'pages' | 'stale'>): { text: string; level: 'normal' | 'warn' | 'critical'; tooltip: string } | null {
  if (state.engine === undefined) return null
  if (state.engine === null) return { text: 'No engine', level: 'warn', tooltip: 'No LaTeX engine is installed on this machine yet; the PDF pane offers one.' }
  if (state.compiling) return { text: 'Compiling…', level: 'normal', tooltip: `Compiling with ${state.engine}.` }
  const { ran } = state
  if (!ran) return null
  if (!ran.ok) {
    const first = ran.first ?? 'no PDF was made'
    return { text: text(`Failed: ${first}`), level: 'critical', tooltip: tip(`The last compile failed: ${first}`) }
  }
  const warned = state.warnings ? ` · ${state.warnings} warning${state.warnings === 1 ? '' : 's'}` : ''
  const said = `${(ran.ms / 1000).toFixed(1)} s${state.pages ? ` · ${state.pages} pp.` : ''}${warned}`
  if (state.stale) return { text: text(`${said} · earlier save`), level: 'warn', tooltip: tip(`Compiled in ${said}. The PDF is of an earlier save.`) }
  return { text: text(said), level: state.warnings ? 'warn' : 'normal', tooltip: tip(`Compiled in ${said}.`) }
}

/** The footer's items for a state. */
export function footerItems(state: FooterState): FooterItemInput[] {
  const items: FooterItemInput[] = []

  if (state.main) {
    items.push({ kind: 'run', id: FOOT.MAIN, label: clip(`← ${state.main}`, LIMITS.HEADER_LABEL), tooltip: tip(`Back to ${state.main}, the file the whole paper starts from`) })
  }
  items.push({ kind: 'text', id: 'file', text: text(state.file), tooltip: tip(`Editing ${state.file}`) })
  items.push({
    kind: 'text',
    id: 'saved',
    text: SAVED[state.saved],
    level: state.saved === 'failed' ? 'critical' : 'normal',
    ...(state.failure ? { tooltip: tip(state.failure) } : {}),
  })
  if (state.failure) items.push({ kind: 'text', id: 'failure', text: text(state.failure), level: 'critical', tooltip: tip(state.failure) })

  const q = state.suggest
  if (q.stops > 0) {
    items.push({ kind: 'run', id: FOOT.PREV, label: 'Previous suggestion', icon: 'chevron-left', shortcut: '⌥[', align: 'center' })
    items.push({
      kind: 'text',
      id: 'suggestion',
      text: q.position ? `Suggestion ${q.position}` : `${q.stops} suggestion${q.stops === 1 ? '' : 's'} waiting`,
      align: 'center',
      tooltip: tip(q.position ? `Suggestion ${q.position} waiting on this paper.` : 'Put the caret in a marked passage, or press Next suggestion, to choose which one.'),
    })
    items.push({
      kind: 'run',
      id: FOOT.NEXT,
      label: 'Next suggestion',
      icon: 'chevron-right',
      shortcut: '⌥]',
      align: 'center',
      ...(q.noMore ? { result: 'No more changes' } : {}),
    })
  }
  if (state.baseline) {
    items.push({
      kind: 'text',
      id: 'baseline',
      text: text(state.baseline.startsWith('compared') ? `Changes ${state.baseline}` : state.baseline),
      align: 'center',
      level: state.readOnly ? 'warn' : 'normal',
      /* The first to go: a fact about the comparison, not about the paper. Unless it says why nothing can be answered. */
      optional: !state.readOnly,
      tooltip: tip(state.baseline),
    })
  }

  if (state.outOfDate) {
    const n = state.outOfDate
    items.push({
      kind: 'text',
      id: 'out-of-date',
      text: `${n} out of date`,
      level: 'warn',
      align: 'center',
      tooltip: tip(`${n} suggestion${n === 1 ? ' was' : 's were'} made on text that has changed since. The header's Cancel out-of-date suggestions clears ${n === 1 ? 'it' : 'them'}.`),
    })
  }
  const accepted = state.accepted
  if (accepted && accepted.count > 0) {
    const auto = accepted.auto ? `, ${accepted.auto} automatically` : ''
    items.push({
      kind: 'text',
      id: 'accepted',
      text: `${accepted.count} accepted`,
      align: 'center',
      optional: true,
      tooltip: tip(`${accepted.count} change${accepted.count === 1 ? '' : 's'} accepted${auto}. The header's Accepted changes lists them; Cancel the last accepted change undoes one.`),
    })
  }

  const build = buildOf(state)
  if (build) {
    items.push({
      kind: 'text',
      id: 'build',
      text: build.text,
      level: build.level,
      align: 'end',
      tooltip: tip(state.unconfined ? `${build.tooltip} ${state.unconfined}` : build.tooltip),
    })
  }
  if (state.section) items.push({ kind: 'text', id: 'section', text: text(state.section), align: 'end', optional: true, tooltip: tip(state.section) })
  if (state.page !== null && state.pages) items.push({ kind: 'text', id: 'page', text: `p. ${state.page}/${state.pages}`, align: 'end', tooltip: `Page ${state.page} of ${state.pages}` })
  return items
}
