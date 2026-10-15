import { diffBlocks, type Block } from './hunks.ts'

/**
 * Two people changed one file from the same starting point: `base` is what both
 * read, `mine` what this editor holds, `theirs` what is on disk now. When the
 * stretches of lines each changed do not touch, both changes are kept and the
 * merged text is answered. When they do, `null`: there is a conflict, and
 * neither is chosen for anybody.
 *
 * Line blocks, so two changes to one line (however far apart in it) are a
 * conflict rather than a guess about which words win. The same change made on
 * both sides is kept once.
 */
export function mergeThree(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs) return mine
  if (base === mine) return theirs
  if (base === theirs) return mine
  const a = diffBlocks(base, mine).map((b) => ({ ...b, side: 'mine' as const, text: mine.slice(b.newFrom, b.newTo) }))
  const b = diffBlocks(base, theirs).map((x) => ({ ...x, side: 'theirs' as const, text: theirs.slice(x.newFrom, x.newTo) }))
  const touches = (x: Block, y: Block): boolean => {
    const xz = x.oldFrom === x.oldTo
    const yz = y.oldFrom === y.oldTo
    if (xz && yz) return x.oldFrom === y.oldFrom
    if (xz) return y.oldFrom < x.oldFrom && x.oldFrom < y.oldTo
    if (yz) return x.oldFrom < y.oldFrom && y.oldFrom < x.oldTo
    return x.oldFrom < y.oldTo && y.oldFrom < x.oldTo
  }
  const edits: { from: number; to: number; text: string }[] = []
  for (const x of a) {
    const clash = b.find((y) => touches(x, y))
    if (clash) {
      /* The very same change on both sides is no conflict. */
      if (clash.oldFrom === x.oldFrom && clash.oldTo === x.oldTo && clash.text === x.text) continue
      return null
    }
    edits.push({ from: x.oldFrom, to: x.oldTo, text: x.text })
  }
  for (const y of b) edits.push({ from: y.oldFrom, to: y.oldTo, text: y.text })
  let out = base
  for (const e of edits.sort((p, q) => q.from - p.from || q.to - p.to)) out = out.slice(0, e.from) + e.text + out.slice(e.to)
  return out
}
