import type { Proposal } from '../latex/propose.ts'
import { indexAt, type Eol } from './lib/offsets.ts'

/**
 * Suggestions, as the page walks and draws them.
 *
 * Pure, so that "which one is next" and "where does it sit in the text on
 * screen" are tests and not paragraphs.
 *
 * ## A stop is what a person answers
 *
 * A suggestion filed on its own is a stop. Suggestions filed under one group
 * (a move is an insertion and a deletion) are ONE stop: they are accepted and
 * rejected together, so stepping onto one and then another of them would be
 * two visits to a single decision.
 */

export interface Stop {
  /** `p:<id>` for a lone suggestion, `g:<group>` for a group, `a:<alt>` for versions of one passage. */
  key: string
  /** Versions of one passage, of which ONE is answered (the others go with it), rather than parts of one change. */
  versions?: boolean
  ids: string[]
  file: string
  /** The member that leads: the one earliest in the file. */
  lead: Proposal
  members: Proposal[]
}

export const stopKeyOf = (p: Pick<Proposal, 'id' | 'group' | 'alt'>): string => (p.alt ? `a:${p.alt}` : p.group ? `g:${p.group}` : `p:${p.id}`)

/**
 * The stops in reading order: the files as the Go menu lists them (which is
 * the order `main.tex` pulls them in), then position within the file. A
 * suggestion about a file that is not listed — outside a part pick — is not a
 * stop: the narrowing rule applies to what is walked as it does to what is drawn.
 */
export function stopsOf(proposals: readonly Proposal[], listed: readonly string[]): Stop[] {
  const by = new Map<string, Proposal[]>()
  for (const p of proposals) {
    if (!listed.includes(p.file)) continue
    const key = stopKeyOf(p)
    by.set(key, [...(by.get(key) ?? []), p])
  }
  const stops: Stop[] = []
  for (const [key, members] of by) {
    const versions = key.startsWith('a:')
    /* Versions: what is in the file now first, then the suggestions in the order they came. Parts of a change: in the file. */
    const sorted = versions
      ? [...members].sort((a, b) => Number(b.kind === 'disk') - Number(a.kind === 'disk') || a.at - b.at)
      : [...members].sort((a, b) => a.from - b.from)
    stops.push({ key, ...(versions ? { versions } : {}), ids: sorted.map((m) => m.id), file: sorted[0]!.file, lead: sorted[0]!, members: sorted })
  }
  return stops.sort(
    (a, b) => listed.indexOf(a.file) - listed.indexOf(b.file) || a.lead.from - b.lead.from || a.lead.at - b.lead.at,
  )
}

/** The stop one step from `from` (null = before the first), wrapping. Null when there are none. */
export function step(stops: readonly Stop[], from: string | null, by: 1 | -1): Stop | null {
  if (!stops.length) return null
  const at = from === null ? -1 : stops.findIndex((s) => s.key === from)
  if (at < 0) return by === 1 ? stops[0]! : stops[stops.length - 1]!
  return stops[(at + by + stops.length) % stops.length]!
}

/** "2 of 5", or null when `current` is not one of them. */
export function position(stops: readonly Stop[], current: string | null): string | null {
  const at = current === null ? -1 : stops.findIndex((s) => s.key === current)
  return at < 0 ? null : `${at + 1} of ${stops.length}`
}

/**
 * Where a suggestion sits in the text the editor holds, and what would stand
 * there: the whole passage the agent quoted, replaced by what it proposed.
 *
 * Null when it cannot be drawn in place truthfully — the editor holds text
 * that is not the text the suggestion was measured against (unsaved typing
 * moved it). It is then simply not drawn there; nothing is guessed.
 */
export function placement(
  p: Proposal,
  text: string,
  eol: Eol,
): { from: number; to: number; replacement: string; quoted: boolean } | null {
  const nf = indexAt(text, p.from, eol)
  const nt = indexAt(text, p.to, eol)
  const flat = (s: string) => s.replace(/\r\n/g, '\n')
  if (text.slice(nf, nt) !== flat(p.was_text)) return null
  /* A suggestion whose quote changed is drawn where it was found, as a mark and
     a tag only: nothing is offered to put in its place. */
  if (p.held) return { from: nf, to: nt, replacement: '', quoted: false }
  if (p.asked && (p.kind ?? 'staged') === 'staged') {
    const find = flat(p.asked.find)
    /* The quoted passage that CONTAINS the changed range; the nearest one, so a
       repeated sentence cannot be taken for another place. */
    const w = text.indexOf(find, Math.max(0, nf - find.length))
    if (w !== -1 && w <= nf && w + find.length >= nt) {
      return { from: w, to: w + find.length, replacement: flat(p.asked.replace), quoted: true }
    }
  }
  return { from: nf, to: nt, replacement: flat(p.text), quoted: false }
}
