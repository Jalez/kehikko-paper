import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { accept as takeIn, grouping, hunkIds, hunksOf, ownSave, revert } from '../latex/hunks.ts'
import { forgetAllProposals, restartProposals } from '../proposals.ts'
import { paperState } from '../machine.ts'
import { forgetReview, restartReview } from '../review.ts'

/**
 * Review is triggered by the state of the files.
 *
 * Every test builds a real paper in a temporary directory. The git ones build a
 * real repository there and run real git; nothing here touches a project of
 * anybody's.
 */

const MAIN = [
  '\\title{A reviewed paper}',
  '\\begin{document}',
  '\\section{One}',
  '',
  'The first paragraph says a thing about the market.',
  'It carries on over a second line.',
  '',
  'The second paragraph says another thing about farms.',
  '',
  'The third paragraph is far from the others and says a last thing.',
  '',
  '\\input{two}',
  '',
  '\\end{document}',
  '',
].join('\n')
const TWO = 'A chapter that is pulled in, and says one more thing.\n'

let root = ''
let project = ''
let dir = ''

const params = () => new URLSearchParams({ epic: 'a-paper', project })
const read = (file = 'main.tex') => readFileSync(join(dir, file), 'utf8')
const put = (text: string, file = 'main.tex') => writeFileSync(join(dir, file), text)

type Change = {
  id: string
  file: string
  kind?: string
  group?: string
  why: string
  text: string
  was_text: string
  from: number
  to: number
  held?: string
  adjusted?: boolean
}
type Listing = { proposals: Change[]; auto: boolean; readOnly?: string | null; untracked?: { file: string }[]; baseline: { mode: string; says: string } | null; accepted: { n: number; file: string; by: string }[]; said?: string }

function listing(): Listing {
  return answer('GET', '/api/proposals', params(), null)?.body as Listing
}
const changes = () => listing().proposals
const disk = () => changes().filter((c) => c.kind === 'disk')
function decide(id: string, decision: 'accept' | 'reject', extra: Record<string, unknown> = {}) {
  return answer('POST', '/api/proposal', params(), { id, decision, ...extra }, TICKET)
}
function review(body: Record<string, unknown>) {
  return answer('POST', '/api/review', params(), body, TICKET)
}
function tool(name: string, args: Record<string, unknown>): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: { project, epic: 'a-paper', ...args } },
  })
  return (reply?.body as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text ?? ''
}
function hashOf(file = 'main.tex'): string {
  const paper = answer('GET', '/api/paper', params(), null)
  return (paper?.body as { paper: { hashes: Record<string, string> } }).paper.hashes[file] ?? ''
}
function saveFromEditor(text: string, file = 'main.tex') {
  return answer('POST', '/api/file', params(), { file, text, was: hashOf(file) }, TICKET)
}
function git(...args: string[]): { ok: boolean; out: string } {
  const ran = spawnSync('git', args, { cwd: project, encoding: 'utf8' })
  return { ok: ran.status === 0, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-paper-review-')))
  project = join(root, 'work')
  dir = join(project, '.kehikot', 'paper', 'a-paper')
  mkdirSync(dir, { recursive: true })
  put(MAIN)
  put(TWO, 'two.tex')
  forgetAllProposals()
  forgetReview(project, 'a-paper')
})

afterEach(() => {
  forgetAllProposals()
  forgetReview(project, 'a-paper')
  rmSync(root, { recursive: true, force: true })
})

describe('the pure part: hunks', () => {
  const base = 'one\ntwo is here\nthree\nfour\n'
  const now = 'one\ntwo was here\nthree\nfour\nfive\n'

  test('what differs is found as words, and accepting or reverting all of it is exact', () => {
    const hunks = hunksOf(base, now)
    expect(hunks.map((h) => [h.oldText, h.newText])).toEqual([['is', 'was'], ['', 'five\n']])
    expect(takeIn(base, hunks)).toBe(now)
    expect(revert(now, hunks)).toBe(base)
  })

  test('a hunk keeps its id when the author edits its new text, so a reason written beside it survives', () => {
    const before = hunkIds('f', base, hunksOf(base, now))
    const edited = hunkIds('f', base, hunksOf(base, now.replace('was', 'WAS NOT')))
    expect(edited).toEqual(before)
  })

  test('hunks in one paragraph are one group; a blank line splits them unless they arrived together', () => {
    const text = 'a B c\nsame\nd E f\n\nx Y z\n'
    const hunks = hunksOf('a b c\nsame\nd e f\n\nx y z\n', text)
    expect(hunks).toHaveLength(3)
    expect(grouping(text, hunks)).toEqual([0, 0, 1])
    expect(grouping(text, hunks, [0, 10 * 60_000, 20 * 60_000])).toEqual([0, 0, 1])
    expect(grouping(text, hunks, [0, 0, 1000])).toEqual([0, 0, 0])
  })

  test('an own save carries only the author’s edit into the baseline, and never a foreign hunk', () => {
    const typed = now.replace('one\n', 'ONE\n')
    const { baseline, touched } = ownSave(base, now, typed)
    expect(baseline).toBe(base.replace('one\n', 'ONE\n'))
    expect(touched).toEqual([])
    /* The agent’s two hunks are still there to review. */
    expect(hunksOf(baseline, typed).map((h) => h.newText)).toEqual(['was', 'five\n'])
  })

  test('an own edit inside a foreign hunk leaves the baseline alone there and says it touched it', () => {
    const typed = now.replace('two was here', 'two was HERE')
    const { baseline, touched } = ownSave(base, now, typed)
    expect(baseline).toBe(base)
    expect(touched).toHaveLength(1)
  })
})

describe('a file with no baseline yet', () => {
  test('first sight is the baseline: nothing is flagged', () => {
    const first = listing()
    expect(first.proposals).toEqual([])
    expect(first.baseline?.mode).toBe('snapshot')
    expect(first.baseline?.says).toBe('compared with what you last accepted in Paper')
  })

  test('a file edited BEFORE the first look is not flagged either: the first look is the baseline', () => {
    put(MAIN.replace('market', 'bazaar'))
    expect(changes()).toEqual([])
  })
})

describe('a change made in the files, whoever made it', () => {
  test('an edit from a script is a reviewable change, with where and what', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    const [one] = disk()
    expect(one).toBeDefined()
    expect(one!.file).toBe('main.tex')
    expect(one!.was_text).toBe('bazaar')
    expect(one!.text).toBe('market')
    expect(one!.why).toBe('')
    /* The range is of the file as it is, in bytes. */
    expect(Buffer.from(read()).subarray(one!.from, one!.to).toString()).toBe('bazaar')
  })

  test('Cancel puts back the exact bytes of the baseline, atomically', () => {
    listing()
    const before = Buffer.from(read())
    put(MAIN.replace('market', 'bazaar'))
    const [one] = disk()
    expect(decide(one!.id, 'reject')?.status).toBe(200)
    expect(Buffer.from(read()).equals(before)).toBe(true)
    expect(changes()).toEqual([])
    /* No temporary left beside the file. */
    expect(existsSync(dir) && readFileSync(join(dir, 'main.tex')).length).toBe(before.length)
  })

  test('Accept keeps the file and moves the baseline: nothing to review, and a later edit is a new change', () => {
    listing()
    const edited = MAIN.replace('market', 'bazaar')
    put(edited)
    const [one] = disk()
    expect(decide(one!.id, 'accept')?.status).toBe(200)
    expect(read()).toBe(edited)
    expect(changes()).toEqual([])
    put(edited.replace('farms', 'fields'))
    expect(disk().map((c) => c.was_text)).toEqual(['fields'])
  })

  test('a burst of five edits to one file is one group, not five tags', () => {
    listing()
    let text = MAIN
    for (const [from, to] of [['market', 'bazaar'], ['farms', 'fields'], ['last thing', 'final thing'], ['third paragraph', '3rd paragraph']]) {
      text = text.replace(from!, to!)
      put(text)
      listing()
    }
    const found = disk()
    expect(found.length).toBe(3)
    expect(new Set(found.map((c) => c.group)).size).toBe(1)
    expect(found[0]!.group).toBeDefined()
    /* Answering one answers the group. */
    expect(decide(found[2]!.id, 'accept')?.status).toBe(200)
    expect(changes()).toEqual([])
  })

  test('edits far apart in time and in the text are separate changes', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    const old = new Date(Date.now() - 3600_000)
    utimesSync(join(dir, 'main.tex'), old, old)
    listing()
    put(MAIN.replace('market', 'bazaar').replace('last thing', 'final thing'))
    const found = disk()
    expect(found).toHaveLength(2)
    expect(found[0]!.group).toBeUndefined()
    expect(found[1]!.group).toBeUndefined()
  })

  test('a chapter that is pulled in is reviewed too', () => {
    listing()
    put(TWO.replace('one more', 'a further'), 'two.tex')
    expect(disk().map((c) => c.file)).toEqual(['two.tex'])
  })

  test('typing 14 keys in the editor creates no review', () => {
    listing()
    let text = MAIN
    for (let n = 0; n < 14; n++) {
      text = text.replace('market', `market${'x'.repeat(n + 1)}`.slice(0, 6 + n))
      expect(saveFromEditor(text)?.status).toBe(200)
    }
    expect(changes()).toEqual([])
  })
})

describe('the author’s own saves and a change waiting in the same file', () => {
  test('saving something else does not accept the foreign change, and the baseline moves by the typed edit only', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    expect(disk()).toHaveLength(1)
    const typed = read().replace('last thing', 'last word')
    const saved = saveFromEditor(typed)
    expect(saved?.status).toBe(200)
    /* The foreign hunk is still the only thing to review. */
    expect(disk().map((c) => c.was_text)).toEqual(['bazaar'])
    /* And cancelling it puts the BASELINE back, leaving what the author typed. */
    decide(disk()[0]!.id, 'reject')
    expect(read()).toBe(MAIN.replace('last thing', 'last word'))
    expect(changes()).toEqual([])
  })

  test('typing inside the foreign change keeps it reviewable and marks it adjusted', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    const id = disk()[0]!.id
    saveFromEditor(read().replace('bazaar', 'bazaars'))
    const [after] = disk()
    expect(after!.id).toBe(id)
    expect(after!.was_text).toBe('bazaars')
    expect(after!.adjusted).toBe(true)
    expect(after!.text).toBe('market')
  })
})

describe('the reason beside a change', () => {
  test('the author writes it inline; it survives a reload and an edit of the new text', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    const id = disk()[0]!.id
    expect(review({ action: 'why', id, why: 'Matches the glossary.' })?.status).toBe(200)
    restartReview()
    expect(disk()[0]!.why).toBe('Matches the glossary.')
    saveFromEditor(read().replace('bazaar', 'souk'))
    expect(disk()[0]!.why).toBe('Matches the glossary.')
    expect(disk()[0]!.was_text).toBe('souk')
  })

  test('explain_change attaches a reason to an on-disk change, and to nothing else', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    const id = disk()[0]!.id
    expect(tool('explain_change', { id, why: 'Terminology.' })).toContain('Recorded')
    expect(disk()[0]!.why).toBe('Terminology.')
    expect(tool('explain_change', { id: 'nope', why: 'x' })).toContain('no change')
    expect(tool('explain_change', { id, why: '' })).toContain('Say why')
  })

  test('list_proposals lists staged and on-disk changes with kind, file, order, reason and state', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    const id = disk()[0]!.id
    const filed = tool('propose_edit', { file: 'main.tex', find: 'about farms', replace: 'about fields', why: 'Fields is the term.' })
    expect(filed).toContain('Filed as')
    tool('explain_change', { id, why: 'Terminology.' })
    const lines = tool('list_proposals', {}).split('\n')
    const staged = lines.find((l) => l.includes('Fields is the term.'))!
    const onDisk = lines.find((l) => l.includes('Terminology.'))!
    expect(staged).toContain('kind: staged')
    expect(staged).toContain('state: pending')
    expect(staged.split('\t')[1]).toBe('main.tex')
    expect(onDisk).toContain('kind: disk')
    expect(onDisk).toContain('market -> bazaar')
    expect(onDisk).toMatch(/order: \d of 2/)
  })

  test('no tool accepts, cancels or toggles Auto accept', () => {
    for (const name of ['accept_change', 'cancel_change', 'set_auto_accept', 'auto_accept', 'toggle_auto']) {
      expect(tool(name, { id: 'x', on: true })).toContain('no tool')
    }
    const names = ((answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })?.body as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name)
    expect(names.filter((n) => /accept|cancel|auto|toggle/.test(n))).toEqual([])
    /* The setting is changed over the ticketed page door only. */
    expect(answer('POST', '/api/review', params(), { action: 'auto', on: true })?.status).toBe(403)
    expect(listing().auto).toBe(false)
  })
})

describe('staged suggestions beside changes on disk', () => {
  test('a suggestion and a direct edit nearby are both shown, and the suggestion is found again', () => {
    listing()
    tool('propose_edit', { file: 'main.tex', find: 'about farms', replace: 'about fields', why: 'Fields is the term.' })
    put(MAIN.replace('market', 'bazaar'))
    const all = changes()
    expect(all.map((c) => c.kind ?? 'staged').sort()).toEqual(['disk', 'staged'])
    const staged = all.find((c) => c.kind === undefined)!
    expect(staged.held).toBeUndefined()
    expect(Buffer.from(read()).subarray(staged.from, staged.to).toString()).toBe(staged.was_text)
  })

  test('a quote that is partly rewritten is drawn at the nearest match with Accept held back; Cancel works', () => {
    listing()
    const filed = tool('propose_edit', { file: 'main.tex', find: 'says another thing about farms', replace: 'says another thing about fields', why: 'Fields.' })
    expect(filed).toContain('Filed as')
    put(MAIN.replace('says another thing about farms', 'says another thing about orchards'))
    const staged = changes().find((c) => c.kind === undefined)!
    expect(staged.held).toBe('changed')
    expect(Buffer.from(read()).subarray(staged.from, staged.to).toString()).toContain('says another thing about')
    expect(decide(staged.id, 'accept')?.status).toBe(409)
    expect(read()).toContain('orchards')
    expect(decide(staged.id, 'reject')?.status).toBe(200)
    expect(changes().find((c) => c.kind === undefined)).toBeUndefined()
  })

  test('a quote that is gone is listed, not drawn, and never silently dropped', () => {
    listing()
    tool('propose_edit', { file: 'main.tex', find: 'says another thing about farms', replace: 'says another thing about fields', why: 'Fields.' })
    put(MAIN.replace('The second paragraph says another thing about farms.', 'Entirely different.'))
    const first = listing()
    const staged = first.proposals.find((c) => c.kind === undefined)!
    expect(staged.held).toBe('gone')
    expect(first.said).toContain('out of date')
    expect(changes().find((c) => c.id === staged.id)).toBeDefined()
  })

  test('a suggestion that was out of date comes back when its text does', () => {
    listing()
    tool('propose_edit', { file: 'main.tex', find: 'says another thing about farms', replace: 'says another thing about fields', why: 'Fields.' })
    put(MAIN.replace('says another thing about farms', 'is gone'))
    expect(changes().find((c) => c.kind === undefined)!.held).toBe('gone')
    put(MAIN)
    expect(changes().find((c) => c.kind === undefined)!.held).toBeUndefined()
  })

  test('accepting a suggestion moves the baseline by it: no duplicate change on disk', () => {
    listing()
    tool('propose_edit', { file: 'main.tex', find: 'about farms', replace: 'about fields', why: 'Fields.' })
    const staged = changes()[0]!
    expect(decide(staged.id, 'accept')?.status).toBe(200)
    expect(read()).toContain('about fields')
    expect(changes()).toEqual([])
  })

  test('accepting a suggestion does not accept a foreign change in the same file', () => {
    listing()
    tool('propose_edit', { file: 'main.tex', find: 'about farms', replace: 'about fields', why: 'Fields.' })
    put(MAIN.replace('market', 'bazaar'))
    const staged = changes().find((c) => c.kind === undefined)!
    expect(decide(staged.id, 'accept')?.status).toBe(200)
    expect(disk().map((c) => c.was_text)).toEqual(['bazaar'])
  })
})

describe('suggestions survive a restart', () => {
  test('stage, restart, still listed; the token still revises it', () => {
    listing()
    const filed = tool('propose_edit', { file: 'main.tex', find: 'about farms', replace: 'about fields', why: 'Fields is the term.' })
    const id = filed.match(/Filed as (\S+)\./)![1]!
    const token = filed.match(/Revision token: (\S+)/)![1]!
    restartProposals()
    restartReview()
    expect(changes().map((c) => c.id)).toEqual([id])
    expect(tool('revise_edit', { id, token, why: 'A better reason.' })).toContain('Revised')
    restartProposals()
    expect(changes()[0]!.why).toBe('A better reason.')
    /* Only the hash of a token is ever kept. */
    expect(tool('revise_edit', { id, token: 'wrong', why: 'x' })).toContain('not yours')
    const stored = JSON.stringify(readFileSync(join(paperState(project, 'a-paper'), 'suggestions.json'), 'utf8'))
    expect(stored).not.toContain(token)
  })

  test('one whose quote no longer matches after a restart shows as out of date', () => {
    listing()
    tool('propose_edit', { file: 'main.tex', find: 'says another thing about farms', replace: 'says another thing about fields', why: 'Fields.' })
    restartProposals()
    put(MAIN.replace('The second paragraph says another thing about farms.', 'Gone.'))
    expect(changes().find((c) => c.kind === undefined)!.held).toBe('gone')
  })
})

describe('Auto accept', () => {
  test('is off by default, is the person’s alone, and is remembered per project', () => {
    expect(listing().auto).toBe(false)
    expect(review({ action: 'auto', on: true })?.status).toBe(200)
    expect(listing().auto).toBe(true)
    restartReview()
    expect(listing().auto).toBe(true)
  })

  test('off: a change waits. on: a change that arrives is taken in silently and listed', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    expect(disk()).toHaveLength(1)
    review({ action: 'auto', on: true })
    /* What was waiting when it was ticked is left for a person. */
    expect(disk()).toHaveLength(1)
    put(read().replace('farms', 'fields'))
    const after = listing()
    expect(after.proposals.filter((c) => c.kind === 'disk').map((c) => c.was_text)).toEqual(['bazaar'])
    expect(after.accepted.map((a) => [a.file, a.by])).toEqual([['main.tex', 'auto']])
  })

  test('the most recent accepted changes can be cancelled, restoring the old text', () => {
    listing()
    review({ action: 'auto', on: true })
    put(MAIN.replace('market', 'bazaar'))
    const { accepted } = listing()
    expect(accepted).toHaveLength(1)
    expect(read()).toContain('bazaar')
    expect(review({ action: 'uncommit', n: accepted[0]!.n })?.status).toBe(200)
    expect(read()).toBe(MAIN)
    /* Putting it back is not itself a change to review. */
    expect(listing().proposals).toEqual([])
    expect(listing().accepted).toEqual([])
  })

  test('cancelling an accepted change whose words were rewritten since is refused, in words', () => {
    listing()
    review({ action: 'auto', on: true })
    put(MAIN.replace('market', 'bazaar'))
    const { accepted } = listing()
    put(read().replace('bazaar', 'souk').replace('The first paragraph', 'A paragraph'))
    const refused = review({ action: 'uncommit', n: accepted[0]!.n })
    expect(refused?.status).toBe(409)
  })

  test('the accepted list is bounded', () => {
    listing()
    review({ action: 'auto', on: true })
    let text = MAIN
    for (let n = 0; n < 45; n++) {
      text = `${text}% line ${n}\n`
      put(text)
      listing()
    }
    expect(listing().accepted.length).toBeLessThanOrEqual(20)
  })
})

describe('the message of a commit carries what was accepted, and why', () => {
  test('without git there is nothing to commit, and the reasons are kept for when there is', () => {
    listing()
    put(MAIN.replace('market', 'bazaar'))
    review({ action: 'why', id: disk()[0]!.id, why: 'Terminology.' })
    decide(disk()[0]!.id, 'accept')
    const saved = answer('POST', '/api/save', params(), {}, TICKET)
    expect(saved?.status).toBe(200)
    expect(String((saved?.body as { said: string }).said)).toContain('not inside a git repository')
  })
})

describe('git is the baseline where there is a repository', () => {
  function initRepo() {
    git('init', '-q', '-b', 'main', '.')
    git('config', 'user.name', 'A Person')
    git('config', 'user.email', 'person@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('add', '-A')
    git('commit', '-q', '-m', 'before')
  }
  const indexOf = (file = 'main.tex') => git('show', `:.kehikot/paper/a-paper/${file}`).out
  const headOf = (file = 'main.tex') => git('show', `HEAD:.kehikot/paper/a-paper/${file}`).out

  test('a file unmodified against HEAD has no hunks; the baseline is said to be git', () => {
    initRepo()
    const first = listing()
    expect(first.proposals).toEqual([])
    expect(first.baseline?.mode).toBe('git')
    expect(first.baseline?.says).toBe('compared with what is staged or committed in git')
  })

  test('modified in the working tree: a change. Accept stages the blob exactly; the commit is unchanged', () => {
    initRepo()
    const edited = MAIN.replace('market', 'bazaar')
    put(edited)
    const [one] = disk()
    expect(one).toBeDefined()
    expect(decide(one!.id, 'accept')?.status).toBe(200)
    expect(indexOf()).toBe(edited.trimEnd())
    expect(headOf()).toBe(MAIN.trimEnd())
    expect(git('status', '--porcelain').out).toContain('M  .kehikot/paper/a-paper/main.tex')
    expect(changes()).toEqual([])
    expect(read()).toBe(edited)
  })

  test('already staged: no change (the baseline is the index), and a later edit is compared with the index', () => {
    initRepo()
    const staged = MAIN.replace('market', 'bazaar')
    put(staged)
    git('add', '.kehikot/paper/a-paper/main.tex')
    expect(changes()).toEqual([])
    put(staged.replace('farms', 'fields'))
    expect(disk().map((c) => c.was_text)).toEqual(['fields'])
  })

  test('Cancel restores the baseline text from the index, byte for byte', () => {
    initRepo()
    put(MAIN.replace('market', 'bazaar'))
    git('add', '.kehikot/paper/a-paper/main.tex')
    put(read().replace('farms', 'fields'))
    const before = Buffer.from(read().replace('fields', 'farms'))
    decide(disk()[0]!.id, 'reject')
    expect(Buffer.from(read()).equals(before)).toBe(true)
  })

  test('a file that is untracked is one change, a new file: Accept adds it, Cancel deletes it only when confirmed', () => {
    initRepo()
    put('A fresh chapter.\n', 'three.tex')
    put(MAIN.replace('\\input{two}', '\\input{two}\n\\input{three}'))
    const fresh = changes().filter((c) => c.kind === 'new')
    expect(fresh.map((c) => c.file)).toEqual(['three.tex'])
    const refused = decide(fresh[0]!.id, 'reject')
    expect(refused?.status).toBe(409)
    expect((refused?.body as { needsConfirm?: boolean }).needsConfirm).toBe(true)
    expect(existsSync(join(dir, 'three.tex'))).toBe(true)
    expect(decide(fresh[0]!.id, 'accept')?.status).toBe(200)
    expect(git('ls-files', '.kehikot/paper/a-paper/three.tex').out).toContain('three.tex')
    expect(changes().filter((c) => c.kind === 'new')).toEqual([])
    /* And the other way: a second new file, cancelled with confirmation. */
    put('Another.\n', 'four.tex')
    put(read().replace('\\input{three}', '\\input{three}\n\\input{four}'))
    const second = changes().find((c) => c.kind === 'new' && c.file === 'four.tex')!
    expect(decide(second.id, 'reject', { confirm: true })?.status).toBe(200)
    expect(existsSync(join(dir, 'four.tex'))).toBe(false)
  })

  test('a tracked file that was deleted is one change: Cancel restores it from the baseline', () => {
    initRepo()
    rmSync(join(dir, 'two.tex'))
    put(MAIN.replace('\\input{two}\n', ''))
    const gone = changes().find((c) => c.kind === 'deleted')
    expect(gone?.file).toBe('two.tex')
    expect(decide(gone!.id, 'reject')?.status).toBe(200)
    expect(read('two.tex')).toBe(TWO)
  })

  test('a deleted file accepted is staged as deleted', () => {
    initRepo()
    rmSync(join(dir, 'two.tex'))
    put(MAIN.replace('\\input{two}\n', ''))
    const gone = changes().find((c) => c.kind === 'deleted')!
    expect(decide(gone.id, 'accept')?.status).toBe(200)
    expect(git('status', '--porcelain').out).toContain('D  .kehikot/paper/a-paper/two.tex')
  })

  test('a branch switch just changes what is compared: the view follows', () => {
    initRepo()
    git('checkout', '-q', '-b', 'other')
    put(MAIN.replace('market', 'bazaar'))
    git('add', '-A')
    git('commit', '-q', '-m', 'bazaar')
    expect(changes()).toEqual([])
    git('checkout', '-q', 'main')
    expect(changes()).toEqual([])
    expect(read()).toBe(MAIN)
    put(MAIN.replace('farms', 'fields'))
    expect(disk().map((c) => c.was_text)).toEqual(['fields'])
    git('checkout', '-q', '--', '.')
    expect(changes()).toEqual([])
  })

  test('an own save stages what the author typed and never a foreign change in the same file', () => {
    initRepo()
    put(MAIN.replace('market', 'bazaar'))
    const typed = read().replace('last thing', 'last word')
    expect(saveFromEditor(typed)?.status).toBe(200)
    /* The typed words are staged; the agent’s change is not. */
    expect(indexOf()).toContain('last word')
    expect(indexOf()).not.toContain('bazaar')
    expect(indexOf()).toContain('market')
    expect(disk().map((c) => c.was_text)).toEqual(['bazaar'])
  })

  test('commit commits what was accepted, with the reasons, and says what is still waiting', () => {
    initRepo()
    put(MAIN.replace('market', 'bazaar').replace('farms', 'fields'))
    const both = disk()
    expect(both.length).toBeGreaterThan(0)
    // Accept only the first group.
    const first = both[0]!
    review({ action: 'why', id: first.id, why: 'Terminology.' })
    saveFromEditor(read())
    expect(decide(first.id, 'accept')?.status).toBe(200)
    const left = changes().length
    const saved = answer('POST', '/api/save', params(), {}, TICKET)
    const said = String((saved?.body as { said: string }).said)
    expect(said).toContain('Committed')
    if (left) expect(said).toContain('still waiting for review')
    const message = git('log', '-1', '--format=%B').out
    expect(message).toContain('Accepted changes since the last commit')
    expect(message).toContain('Terminology.')
    expect(headOf()).toContain('bazaar')
    if (left) expect(headOf()).toContain('farms')
  })

  test('a change made by Paper’s own typing is committable at once (the author’s act)', () => {
    initRepo()
    saveFromEditor(MAIN.replace('market', 'MARKET'))
    const standing = answer('GET', '/api/uncommitted', params(), null)?.body as { standing: { at: string; files?: string[] }; measuredBy: string }
    expect(standing.measuredBy).toBe('staged')
    expect(standing.standing.at).toBe('ready')
  })

  test('in the middle of a merge Paper stages nothing, says so, and recovers when it ends', () => {
    initRepo()
    put(MAIN.replace('market', 'bazaar'))
    writeFileSync(join(project, '.git', 'MERGE_HEAD'), `${git('rev-parse', 'HEAD').out}\n`)
    const during = listing()
    expect(during.readOnly).toBe('Git is in the middle of a merge — finish it to review here.')
    /* Shown, but not answerable, and nothing staged. */
    expect(during.proposals.filter((c) => c.kind === 'disk')).toHaveLength(1)
    const refused = decide(disk()[0]!.id, 'accept')
    expect(refused?.status).toBe(409)
    expect(String((refused?.body as { error: string }).error)).toContain('middle of a merge')
    expect(decide(disk()[0]!.id, 'reject')?.status).toBe(409)
    saveFromEditor(read().replace('last thing', 'last word'))
    expect(indexOf()).not.toContain('last word')
    expect(git('diff', '--cached', '--name-only').out).toBe('')
    rmSync(join(project, '.git', 'MERGE_HEAD'))
    expect(listing().readOnly).toBeNull()
    expect(decide(disk()[0]!.id, 'accept')?.status).toBe(200)
  })

  test.each([
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ])('%s is %s in progress', (marker, words) => {
    initRepo()
    if (marker.startsWith('rebase')) mkdirSync(join(project, '.git', marker), { recursive: true })
    else writeFileSync(join(project, '.git', marker), `${git('rev-parse', 'HEAD').out}\n`)
    expect(listing().readOnly).toContain(words)
  })

  test('a file with conflict markers is not diffed as hunks, and is listed as waiting for the conflict to be resolved', () => {
    initRepo()
    put(MAIN.replace('\\section{One}\n', '\\section{One}\n<<<<<<< ours\nmarket\n=======\nbazaar\n>>>>>>> theirs\n'))
    const body = listing()
    expect(body.proposals.filter((c) => c.file === 'main.tex')).toEqual([])
    expect(body.untracked?.map((u) => u.file)).toContain('main.tex')
  })

  test('a paper in a repository that does not track it falls back to the machine snapshot', () => {
    git('init', '-q', '-b', 'main', '.')
    expect(listing().baseline?.mode).toBe('snapshot')
    put(MAIN.replace('market', 'bazaar'))
    expect(disk()).toHaveLength(1)
  })

  test('a paper git is told to ignore falls back too', () => {
    initRepo()
    writeFileSync(join(project, '.gitignore'), '.kehikot/\n')
    git('rm', '-r', '-q', '--cached', '.kehikot')
    expect(listing().baseline?.mode).toBe('snapshot')
  })

  test('CRLF files are not flagged wholesale', () => {
    put(MAIN.replace(/\n/g, '\r\n'))
    git('init', '-q', '-b', 'main', '.')
    git('config', 'user.name', 'A Person')
    git('config', 'user.email', 'person@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.autocrlf', 'true')
    git('add', '-A')
    git('commit', '-q', '-m', 'crlf')
    expect(changes()).toEqual([])
  })
})

describe('no cap on changes', () => {
  test('more than two dozen suggestions are all accepted by the door and all listed', () => {
    listing()
    let text = ''
    for (let n = 0; n < 60; n++) text += `Sentence number ${n} says a thing about topic ${n}.\n\n`
    put(`${MAIN.replace('\\input{two}', text + '\\input{two}')}`)
    listing()
    for (let n = 0; n < 60; n++) {
      const said = tool('propose_edit', { file: 'main.tex', find: `a thing about topic ${n}.`, replace: `a point about topic ${n}.`, why: `Reason ${n}.` })
      expect(said).toContain('Filed as')
    }
    expect(changes().filter((c) => c.kind === undefined)).toHaveLength(60)
  })

  test('a quote or replacement past the limit is refused in words that point at editing the file', () => {
    const said = tool('propose_edit', { file: 'main.tex', find: 'x'.repeat(250_000), replace: 'y', why: 'big' })
    expect(said).toContain('Edit the .tex directly')
    expect(said).toContain('review')
  })

  test('150 changes across five files are all reviewable, and computing them is quick', () => {
    const files = ['two.tex', 'three.tex', 'four.tex', 'five.tex']
    const lines = (tag: string) => Array.from({ length: 40 }, (_, n) => `Line ${n} of ${tag} is plain text that stays put.`).join('\n\n')
    for (const f of files) put(`${lines(f)}\n`, f)
    put(MAIN.replace('\\input{two}', files.map((f) => `\\input{${f.replace('.tex', '')}}`).join('\n')))
    listing()
    for (const f of [...files]) put(read(f).replace(/is plain text/g, 'is changed text'), f)
    put(read().replace('market', 'bazaar').replace('farms', 'fields'))
    const started = performance.now()
    const found = disk()
    const took = performance.now() - started
    expect(found.length).toBe(4 * 40 + 2)
    expect(took).toBeLessThan(1500)
    /* A second poll with nothing moved costs a hash, not a diff. */
    const again = performance.now()
    disk()
    expect(performance.now() - again).toBeLessThan(took + 50)
    expect(new Set(found.map((c) => c.file)).size).toBe(5)
  })

  test('a huge change degrades to one whole block that still has Accept and Cancel', () => {
    const big = Array.from({ length: 5000 }, (_, n) => `Row ${n}.`).join('\n')
    put(`${MAIN}${big}\n`)
    listing()
    const rewritten = Array.from({ length: 5000 }, (_, n) => `Row ${5000 - n}.`).join('\n')
    put(`${MAIN}${rewritten}\n`)
    const found = disk()
    expect(found.length).toBeGreaterThan(0)
    expect(decide(found[0]!.id, 'reject')?.status).toBe(200)
    expect(read()).toBe(`${MAIN}${big}\n`)
  })
})

describe('what is tracked', () => {
  test('a large file is tracked and compared', () => {
    put(`${MAIN}${'x'.repeat(600 * 1024)}\n`)
    listing()
    put(`${MAIN.replace('market', 'bazaar')}${'x'.repeat(600 * 1024)}\n`)
    expect(disk().map((c) => c.was_text)).toEqual(['bazaar'])
    expect(listing().untracked).toEqual([])
  })

  test('baselines of files the paper no longer names are pruned', () => {
    listing()
    put(MAIN.replace('\\input{two}\n', ''))
    listing()
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const state = join(paperState(project, 'a-paper'), 'baseline')
    expect(readdirSync(state).length).toBe(1)
  })
})
