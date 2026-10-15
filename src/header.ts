import { LIMITS, type HeaderItemInput } from 'kehikot-module-protocol'

import type { FileTab } from './focus.ts'
import type { FileJumps } from './lib/sections.ts'

/**
 * What this page declares for the container's header (`kehikot.header`).
 *
 * The host draws these as its View, Go and Run menus, in the row a container
 * already has, so this page spends no row of its own on a toolbar: the tabs,
 * the section list, Compile, "Show in PDF", Commit, the Auto tick, the log
 * and "chapter of" are all here and none of them is drawn in the page.
 *
 * A pure function of what the page knows, so that the list is the same list
 * until something in it changes: the page declares it again only when its
 * JSON differs (`workspace.tsx`), and a keystroke changes nothing here — not
 * the pane, not the sections (those are read from the paper as it is on disk),
 * not the build.
 *
 * ## Ids
 *
 * A press comes back with an option's id, and it is judged against the list
 * as it stands NOW (`pressRefusal`), so an id only has to mean something in
 * the list it is in. Sections are `s<n>`, by their place in the paper's whole
 * section list; files are `f<n>`, by their place in what is listed; the picked
 * parts' chapters are `t<n>`; parts are `p<n>`. A path or a part's id could be
 * longer than an id may be, and these cannot.
 */

export interface HeaderState {
  tab: 'source' | 'pdf'
  /** How many suggestions are waiting: said on the Source option while the PDF is in front. */
  proposals: number
  /** The picked parts' chapters, when there is more than one to be on. */
  tabs: readonly FileTab[]
  file: string
  /** The files offered, in order. */
  listed: readonly string[]
  jumps: readonly FileJumps[]
  auto: boolean
  /** The last run's log: whether there is one, whether it is open, and how many warnings it has. */
  log: { open: boolean; warnings: number } | null
  /** Which part the open file is the chapter of, when that can be set. */
  chapter: { parts: readonly ChapterPart[]; of: string | null } | null
  /** Whether "a part for each chapter" is offered. */
  eachOffered: boolean
  chaptersBusy: boolean
  /** Null until the server has said where the build stands. */
  engine: string | null | undefined
  compiling: boolean
  ran: { ok: boolean; ms: number; first: string | null } | null
  pages: number | null
  /** Whether there is a compiled PDF to show a line in. */
  pdf: boolean
  /** Null when the paper is in no repository; `why` is the sentence for why it cannot be committed just now, or null. */
  commit: { why: string | null } | null
  /**
   * The suggestions as the person walks them. `stops` is how many there are to
   * walk (a group is one), `position` is "2 of 5" for the current one, null
   * when none is current; `editing` while the author's own text is being typed.
   */
  suggest?: { stops: number; position: string | null; editing: boolean; busy: boolean }
}

/** The heading the suggestion items stand under in the Run menu. */
export const SUGGESTIONS = 'Suggestions'

/**
 * A part the open file can be made the chapter of. `moves` is what choosing it
 * would do to the chapter the part already has (`moveOf` in `chapters.ts`):
 * absent or null when the part has none, or has this file.
 */
export interface ChapterPart {
  id: string
  heading: string
  moves?: { file: string; to: string | null } | null
}

/**
 * The words for a part in "chapter of": its name — and, when it already has
 * another chapter, what choosing it does to that one, BEFORE it is chosen. A
 * switch has no place for a result and a press here is not armed, so the
 * option is where a person learns that another chapter moves: it swaps with
 * this file's part, or — this file having none to give back — is left with no
 * part.
 *
 * In that order — the part, what happens, and the file last — because a host
 * draws a submenu a good deal narrower than a label may be long, and cuts what
 * does not fit off the END: what is lost first is the tail of a file's name,
 * and never the word that says a chapter is about to have no part.
 */
export function chapterOption(part: ChapterPart): string {
  const name = cut(part.heading || part.id)
  if (!part.moves) return name
  const says = part.moves.to === null ? ' · no part for ' : ' · swaps with '
  const room = LIMITS.HEADER_LABEL - says.length
  const kept = cut(name, Math.max(room - 8, 1))
  return `${kept}${says}${cut(part.moves.file.split('/').pop() || part.moves.file, room - kept.length)}`
}

/** A label no longer than a label may be, cut with an ellipsis. Never empty. */
export function cut(text: string, max: number = LIMITS.HEADER_LABEL): string {
  const flat = text.replace(/\s+/g, ' ').trim() || '—'
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Two no-break spaces a level: an ordinary space at the start of a menu row is collapsed. */
const INDENT = '  '

/**
 * The places to jump to: each section, and — when more than one file is
 * offered — each file, as the row its sections stand under. As many as a go
 * item may hold; a paper with more loses its deepest headings first, so the
 * chapters are all still there.
 */
export function placesOf(listed: readonly string[], jumps: readonly FileJumps[]): { id: string; label: string }[] {
  const several = listed.length > 1
  const count = (depth: number) =>
    jumps.reduce((n, group) => n + (several || group.sections.length === 0 ? 1 : 0) + group.sections.filter((one) => one.section.level <= depth).length, 0)
  let depth = jumps.reduce((deepest, group) => Math.max(deepest, ...group.sections.map((one) => one.section.level)), 1)
  while (depth > 1 && count(depth) > LIMITS.HEADER_OPTIONS) depth -= 1
  const out: { id: string; label: string }[] = []
  for (const group of jumps) {
    const at = listed.indexOf(group.file)
    if (several) out.push({ id: `f${at}`, label: cut(group.file) })
    else if (group.sections.length === 0) out.push({ id: `f${at}`, label: cut(`Top of ${group.file}`) })
    for (const { index, section } of group.sections) {
      if (section.level > depth) continue
      const indent = INDENT.repeat(Math.max(0, section.level - 1) + (several ? 1 : 0))
      out.push({ id: `s${index}`, label: `${indent}${cut(section.title, LIMITS.HEADER_LABEL - indent.length)}` })
    }
  }
  return out.slice(0, LIMITS.HEADER_OPTIONS)
}

/** What the last run came to, in the few words a run's result has room for. */
export function resultOf(state: Pick<HeaderState, 'ran' | 'pages'>): string | null {
  const { ran } = state
  if (!ran) return null
  if (!ran.ok) return cut(ran.first ?? 'Failed', LIMITS.HEADER_RESULT)
  return cut(`${(ran.ms / 1000).toFixed(1)} s${state.pages ? ` · ${state.pages} pp.` : ''}`, LIMITS.HEADER_RESULT)
}

export function headerOf(state: HeaderState): HeaderItemInput[] {
  const items: HeaderItemInput[] = []
  const failed = state.ran ? !state.ran.ok : false

  items.push({
    kind: 'switch',
    id: 'pane',
    label: 'Pane',
    value: state.tab,
    options: [
      { id: 'source', label: state.tab === 'pdf' && state.proposals ? `Source · ${state.proposals} suggested` : 'Source' },
      /* Choosing it shows the caret's line there: what "Show in PDF" did. */
      { id: 'pdf', label: failed ? 'PDF · the last compile failed' : 'PDF' },
    ],
  })

  if (state.tabs.length > 1 && state.tabs.length <= LIMITS.HEADER_OPTIONS) {
    const on = state.tabs.findIndex((one) => one.file === state.file)
    if (on >= 0) {
      items.push({
        kind: 'switch',
        id: 'file',
        label: 'File of the picked parts',
        icon: 'file-text',
        value: `t${on}`,
        options: state.tabs.map((one, i) => ({ id: `t${i}`, label: cut(one.label) })),
      })
    }
  }

  if (state.chapter && state.chapter.parts.length < LIMITS.HEADER_OPTIONS && !state.chaptersBusy) {
    const on = state.chapter.parts.findIndex((part) => part.id === state.chapter!.of)
    items.push({
      kind: 'switch',
      id: 'chapter',
      label: cut(`${state.file.split('/').pop() ?? state.file} is the chapter of`),
      icon: 'book-open',
      value: on >= 0 ? `p${on}` : 'none',
      options: [{ id: 'none', label: 'no part' }, ...state.chapter.parts.map((part, i) => ({ id: `p${i}`, label: chapterOption(part) }))],
    })
  }

  /* Person-only, like the tick it was: it says nothing about agents, so none can set it. */
  items.push({ kind: 'toggle', id: 'auto', label: 'Accept suggestions as they arrive', checked: state.auto })
  if (state.log) {
    const n = state.log.warnings
    items.push({ kind: 'toggle', id: 'log', label: n ? `Compile log · ${n} warning${n === 1 ? '' : 's'}` : 'Compile log', checked: state.log.open })
  }

  const places = placesOf(state.listed, state.jumps)
  if (places.length) items.push({ kind: 'go', id: 'section', label: state.listed.length > 1 ? 'Files and sections' : 'Sections', icon: 'list-tree', options: places })

  if (state.engine !== undefined) {
    items.push({
      kind: 'run',
      id: 'compile',
      label: 'Compile',
      icon: 'play',
      agents: true,
      state: state.compiling ? 'busy' : failed ? 'failed' : 'idle',
      result: resultOf(state),
      disabled: state.engine ? null : 'No LaTeX engine is installed on this machine yet; the PDF pane offers one.',
    })
  }
  /* The PDF option of the pane switch does this too, once: a switch already on
     PDF — as it stays, side by side in a wide container — cannot be pressed
     again, and this can. */
  items.push({
    kind: 'run',
    id: 'reveal',
    label: 'Show this line in the PDF',
    icon: 'search',
    disabled: state.pdf ? null : 'There is no compiled PDF yet to show this in.',
  })
  if (state.commit) {
    items.push({
      kind: 'run',
      id: 'commit',
      label: 'Commit',
      icon: 'git-commit-horizontal',
      confirm: true,
      disabled: state.commit.why === null ? null : cut(state.commit.why, LIMITS.REASON),
    })
  }
  if (state.suggest) {
    const q = state.suggest
    const none = 'No suggestion is waiting on this paper.'
    const noCurrent = 'Put the caret in a marked passage, or press Next suggestion, to choose which one.'
    const move = (id: string, label: string, icon: string, shortcut: string): HeaderItemInput =>
      ({
        kind: 'run',
        id,
        label: cut(q.position ? `${label} · ${q.position}` : q.stops ? `${label} · ${q.stops} waiting` : label),
        icon,
        shortcut,
        group: SUGGESTIONS,
        disabled: q.stops ? null : none,
        pinned: true,
      }) as HeaderItemInput
    const act = (id: string, label: string, icon: string, shortcut: string, extra: Partial<{ disabled: string | null }> = {}) =>
      ({
        kind: 'run',
        id,
        label,
        icon,
        shortcut,
        group: SUGGESTIONS,
        disabled: !q.stops ? none : q.busy ? 'Another suggestion is being answered.' : q.position === null ? noCurrent : null,
        ...extra,
        /* Accept and Reject are on the suggestion's own tag ("Accept change",
           "Cancel change"), so the frame pins only the walk; these stay in the
           Run menu, with their keys. */
        ...(id === 'sg-accept' && q.busy ? { state: 'busy' } : {}),
      }) as HeaderItemInput
    items.push(
      move('sg-prev', 'Previous suggestion', 'chevron-left', '⌥['),
      move('sg-next', 'Next suggestion', 'chevron-right', '⌥]'),
      act('sg-accept', q.editing ? 'Accept my version' : 'Accept suggestion', 'check', '⌥↵'),
      act('sg-reject', 'Reject suggestion', 'x', '⌥⇧↵'),
      act('sg-edit', q.editing ? 'Stop editing suggestion' : 'Edit suggestion', 'pencil', '⌥E'),
    )
    if (q.stops > 1) {
      items.push({
        kind: 'run',
        id: 'sg-all',
        label: `Accept all ${q.stops} suggestions`,
        group: SUGGESTIONS,
        confirm: true,
        disabled: q.busy ? 'Another suggestion is being answered.' : null,
      })
    }
  }
  if (state.eachOffered) {
    items.push({
      kind: 'run',
      id: 'parts-each',
      label: 'A part for each chapter',
      disabled: state.chaptersBusy ? 'The parts are being added.' : null,
    })
  }
  return items
}
