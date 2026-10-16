import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { forgetAllProposals, restartProposals } from '../proposals.ts'
import { forgetReview, restartReview } from '../review.ts'

/**
 * One passage, one review item, whatever tools the agent has.
 *
 * An agent whose tool list was fixed before `revise_edit` existed has only
 * `propose_edit`, and used to file a second overlapping suggestion every time it
 * thought again. The two then sat on the same words as two dialogs. Now a
 * suggestion from the same filer that touches one of its own pending ones is a
 * revision of it, and what two different filers (or a filer and the person's
 * own edit) say about the same words is ONE item with both versions in it.
 */

const SOURCE = [
  '\\title{A revised paper}',
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The market sells students a thing about farms, and the sentence runs on',
  'for long enough that the author wrapped it, and then ends.',
  '',
  'A second paragraph, far from the first, with its own words to change.',
  '',
  '\\end{document}',
  '',
].join('\n')

let root = ''
let project = ''
let main = ''

const params = () => new URLSearchParams({ epic: 'a-paper', project })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikot-paper-revision-')))
  project = join(root, 'work')
  const dir = join(project, '.kehikot', 'paper', 'a-paper')
  mkdirSync(dir, { recursive: true })
  main = join(dir, 'main.tex')
  writeFileSync(main, SOURCE)
  forgetAllProposals()
  forgetReview(project, 'a-paper')
})

afterEach(() => {
  forgetAllProposals()
  forgetReview(project, 'a-paper')
  rmSync(root, { recursive: true, force: true })
})

function tool(name: string, args: Record<string, unknown>): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: { project, epic: 'a-paper', ...args } },
  })
  return (reply?.body as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text ?? ''
}
const propose = (find: string, replace: string, why = 'Because.', extra: Record<string, unknown> = {}) =>
  tool('propose_edit', { file: 'main.tex', find, replace, why, ...extra })
type Item = { id: string; kind?: string; why: string; text: string; was_text: string; revisions?: number; alt?: string; by: string; held?: string }
const items = (): Item[] => ((answer('GET', '/api/proposals', params(), null)?.body as { proposals: Item[] }).proposals)
const idOf = (said: string) => said.match(/(?:Filed as|Revised) (\S+?)[ .]/)?.[1] ?? ''
const decide = (id: string, decision: 'accept' | 'reject') => answer('POST', '/api/proposal', params(), { id, decision }, TICKET)

describe('the same filer says it again', () => {
  const FIND = 'The market sells students a thing about farms'

  test('an agent with only propose_edit files three times on one sentence: one item, revised twice', () => {
    const first = propose(FIND, 'The market sells students a point about farms', 'First thought.')
    expect(first).toContain('Filed as')
    const id = idOf(first)
    const second = propose(FIND, 'The market sells learners a point about farms', 'Second thought.')
    expect(second).toContain(`Revised ${id} (was pending)`)
    const third = propose(FIND, 'The market sells learners a view of farms', 'Third thought.')
    expect(third).toContain(`Revised ${id} (was pending)`)
    const all = items()
    expect(all).toHaveLength(1)
    expect(all[0]!.id).toBe(id)
    expect(all[0]!.revisions).toBe(2)
    expect(all[0]!.why).toBe('Third thought.')
    /* One Accept applies the last words, once. */
    expect(decide(id, 'accept')?.status).toBe(200)
    expect(readFileSync(main, 'utf8')).toContain('The market sells learners a view of farms')
    expect(items()).toEqual([])
  })

  test('a narrower or wider quote over the same words is still a revision; separate words are not', () => {
    const id = idOf(propose('sells students a thing', 'sells students a point', 'One.'))
    expect(propose('market sells students a thing about', 'market sells learners a point about', 'Two.')).toContain(`Revised ${id}`)
    expect(items()).toHaveLength(1)
    /* A different paragraph is another passage. */
    expect(propose('with its own words to change', 'with words of its own to change', 'Elsewhere.')).toContain('Filed as')
    expect(items()).toHaveLength(2)
  })

  test('the token of the first call still revises it, and so does the new one', () => {
    const first = propose(FIND, 'The market sells students a point about farms')
    const id = idOf(first)
    const oldToken = first.match(/Revision token: (\S+)/)![1]!
    const second = propose(FIND, 'The market sells learners a point about farms')
    const newToken = second.match(/Revision token: (\S+)/)![1]!
    expect(newToken).not.toBe(oldToken)
    expect(tool('revise_edit', { id, token: oldToken, why: 'By the first token.' })).toContain('Revised')
    expect(tool('revise_edit', { id, token: newToken, why: 'By the second.' })).toContain('Revised')
    expect(items()[0]!.why).toBe('By the second.')
    expect(tool('revise_edit', { id, token: 'not-a-token', why: 'x' })).toContain('not yours')
  })

  test('it survives a restart: the next call is still a revision of the stored one', () => {
    const id = idOf(propose(FIND, 'The market sells students a point about farms'))
    restartProposals()
    restartReview()
    expect(propose(FIND, 'The market sells learners a point about farms')).toContain(`Revised ${id}`)
    expect(items()).toHaveLength(1)
  })

  test('a suggestion in a group is not folded into', () => {
    const first = propose(FIND, 'The market sells students a point about farms', 'In a group.', { group: 'g' })
    expect(first).toContain('Filed as')
    expect(propose(FIND, 'The market sells learners a point about farms', 'Again.')).toContain('Filed as')
    expect(items().length).toBeGreaterThanOrEqual(2)
  })
})

describe('two different filers, or a filer and the person, on the same words', () => {
  const FIND = 'The market sells students a thing about farms'

  test('another named agent is another filer: both are kept, as ONE item with both versions', () => {
    const a = idOf(propose(FIND, 'The market sells students a point about farms', 'A says.', { agent: 'agent-a' }))
    const b = idOf(propose(FIND, 'The market sells students an idea about farms', 'B says.', { agent: 'agent-b' }))
    expect(a).not.toBe(b)
    const all = items()
    expect(all).toHaveLength(2)
    expect(all[0]!.alt).toBeDefined()
    expect(all[0]!.alt).toBe(all[1]!.alt)
    /* Picking one answers the item: the other is gone with it. */
    expect(decide(b, 'accept')?.status).toBe(200)
    expect(readFileSync(main, 'utf8')).toContain('an idea about farms')
    expect(items()).toEqual([])
  })

  test('cancelling the item cancels every version, and writes nothing', () => {
    propose(FIND, 'The market sells students a point about farms', 'A says.', { agent: 'agent-a' })
    const b = idOf(propose(FIND, 'The market sells students an idea about farms', 'B says.', { agent: 'agent-b' }))
    expect(decide(b, 'reject')?.status).toBe(200)
    expect(items()).toEqual([])
    expect(readFileSync(main, 'utf8')).toBe(SOURCE)
  })

  test('the same named agent revises itself, whatever the other one does', () => {
    const a = idOf(propose(FIND, 'The market sells students a point about farms', 'A one.', { agent: 'agent-a' }))
    propose(FIND, 'The market sells students an idea about farms', 'B one.', { agent: 'agent-b' })
    expect(propose(FIND, 'The market sells students a notion about farms', 'A two.', { agent: 'agent-a' })).toContain(`Revised ${a}`)
    expect(items()).toHaveLength(2)
  })

  test('a change written straight into the file over the words a suggestion is about is ONE item with it', () => {
    listing()
    const s = idOf(propose(FIND, 'The market sells students a point about farms', 'Suggested.'))
    writeFileSync(main, SOURCE.replace('a thing about farms', 'a notion about farms'))
    const all = items()
    /* The suggestion is out of date (its words changed) and shares the passage with the change on disk: one item. */
    expect(all.map((i) => i.kind ?? 'staged').sort()).toEqual(['disk', 'staged'])
    expect(all[0]!.alt).toBeDefined()
    expect(all[0]!.alt).toBe(all[1]!.alt)
    /* Accepting what is on disk answers the item: the stale suggestion goes with it. */
    const disk = all.find((i) => i.kind === 'disk')!
    expect(decide(disk.id, 'accept')?.status).toBe(200)
    expect(items().find((i) => i.id === s)).toBeUndefined()
    expect(items()).toEqual([])
  })

  test('a change on disk elsewhere in the file is a separate item', () => {
    listing()
    propose(FIND, 'The market sells students a point about farms')
    writeFileSync(main, SOURCE.replace('its own words', 'its own few words'))
    const all = items()
    expect(all).toHaveLength(2)
    expect(all.every((i) => i.alt === undefined)).toBe(true)
  })
})

function listing() {
  return items()
}
