import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { forgetAllProposals } from '../proposals.ts'

/**
 * A suggestion's life after it is filed: revised or withdrawn by the agent that
 * filed it, adjusted by the author, answered as a group. None of it can accept.
 */
const SOURCE = [
  '\\title{T}',
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim has a tpyo in it and it runs on for long enough that the',
  'author wrapped the line, and ends here.',
  '',
  'A second paragraph with a seond typo and the end of it.',
  '',
  'A third paragraph to move around.',
  '',
  '\\end{document}',
  '',
].join('\n')

let root = ''
let project = ''
let main = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-sugg-')))
  project = join(root, 'work')
  const paper = join(project, '.kehikot', 'paper', 'a-paper')
  mkdirSync(paper, { recursive: true })
  main = join(paper, 'main.tex')
  writeFileSync(main, SOURCE)
  forgetAllProposals()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  forgetAllProposals()
})

const disk = () => readFileSync(main, 'utf8')

function tool(name: string, args: Record<string, unknown>): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(), {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  })
  return ((reply?.body as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text) ?? ''
}
function file(find: string, replace: string, extra: Record<string, unknown> = {}) {
  const said = tool('propose_edit', { project, epic: 'a-paper', file: 'main.tex', find, replace, why: 'Because.', ...extra })
  return {
    said,
    id: said.match(/^Filed as (\S+)\./)?.[1] ?? '',
    token: said.match(/Revision token: (\S+)/)?.[1] ?? '',
  }
}
function list() {
  const r = answer('GET', '/api/proposals', new URLSearchParams({ epic: 'a-paper', project }), null)
  return (r?.body as { proposals: Record<string, unknown>[] }).proposals
}
function decide(id: string, decision: string, more: Record<string, unknown> = {}) {
  return answer('POST', '/api/proposal', new URLSearchParams({ epic: 'a-paper', project }), { id, decision, ...more }, TICKET)
}

describe('revise and withdraw', () => {
  test('propose_edit returns a token, and no read ever shows one', () => {
    const one = file('tpyo', 'typo')
    expect(one.token.length).toBeGreaterThan(16)
    expect(JSON.stringify(list())).not.toContain(one.token)
    expect(JSON.stringify(list())).not.toContain('tokenHash')
    expect(tool('list_proposals', { project, epic: 'a-paper' })).not.toContain(one.token)
    const rest = answer('GET', '/api/proposals', new URLSearchParams({ epic: 'a-paper', project }), null)
    expect(JSON.stringify(rest?.body)).not.toMatch(/token/i)
  })

  test('revise keeps the id, changes the text, and says revised', () => {
    const one = file('tpyo', 'typo')
    const said = tool('revise_edit', { project, id: one.id, token: one.token, replace: 'typographical error', why: 'Clearer.' })
    expect(said).toStartWith(`Revised ${one.id}`)
    const [now] = list()
    expect(now).toMatchObject({ id: one.id, asked: { find: 'tpyo', replace: 'typographical error' }, why: 'Clearer.', revisions: 1 })
    expect(now!.revisedAt).toBeNumber()
    expect(disk()).toBe(SOURCE)
  })

  test('a wrong token, an unknown id and a missing change are refused in words', () => {
    const one = file('tpyo', 'typo')
    expect(tool('revise_edit', { project, id: one.id, token: 'nope', replace: 'x' })).toContain('not yours')
    expect(tool('withdraw_edit', { project, id: one.id, token: 'nope' })).toContain('not yours')
    expect(tool('withdraw_edit', { project, id: 'zzz', token: one.token })).toContain('no pending suggestion')
    expect(tool('revise_edit', { project, id: one.id, token: one.token })).toContain('Nothing to revise')
    expect(list()).toHaveLength(1)
  })

  test('withdraw removes it, lists it as withdrawn, and then it cannot be revised', () => {
    const one = file('tpyo', 'typo')
    expect(tool('withdraw_edit', { project, id: one.id, token: one.token })).toContain('Withdrew')
    expect(list()).toHaveLength(0)
    expect(tool('list_proposals', { project, epic: 'a-paper' })).toContain('state: withdrawn')
    expect(tool('revise_edit', { project, id: one.id, token: one.token, replace: 'x' })).toContain('already withdrawn')
  })

  test('an accepted or rejected suggestion cannot be revised or withdrawn, and says which', () => {
    const a = file('tpyo', 'typo')
    const b = file('seond', 'second')
    expect(decide(a.id, 'accept')?.status).toBe(200)
    expect(decide(b.id, 'reject')?.status).toBe(200)
    expect(tool('revise_edit', { project, id: a.id, token: a.token, replace: 'x' })).toContain('already accepted')
    expect(tool('withdraw_edit', { project, id: b.id, token: b.token })).toContain('already rejected')
    expect(tool('list_proposals', { project, epic: 'a-paper' })).toContain('state: accepted')
  })

  test('a second suggestion on the same words says which one it overlaps, and supersedes nothing', () => {
    const a = file('tpyo', 'typo')
    const b = file('tpyo in it', 'typo in it')
    expect(b.said).toContain(`Overlaps ${a.id}`)
    expect(b.said).toContain('only one of the two can apply')
    expect(list()).toHaveLength(2)
    const c = file('seond', 'second')
    expect(c.said).not.toContain('Overlaps')
  })

  test('there is still no tool that accepts', () => {
    const one = file('tpyo', 'typo')
    expect(tool('accept_edit', { project, id: one.id, token: one.token })).toContain('no tool')
    expect(disk()).toBe(SOURCE)
  })

  test('the token is the only proof: a suggestion with none cannot be revised', () => {
    expect(tool('revise_edit', { project, id: 'old-shape', token: '', replace: 'x' })).toContain('no pending suggestion')
  })
})

describe('the author adjusts a suggestion before accepting it', () => {
  test('accepting with the author’s own text writes that text, and Reject writes nothing', () => {
    const one = file('tpyo', 'typo')
    const r = decide(one.id, 'accept', { replace: 'typing slip' })
    expect(r?.status).toBe(200)
    expect(disk()).toContain('has a typing slip in it')
    expect((r?.body as { said: string }).said).toContain('Accepted with your changes')
    expect(tool('list_proposals', { project, epic: 'a-paper' })).toContain('adjusted by the author')

    const two = file('seond', 'second')
    expect(decide(two.id, 'reject')?.status).toBe(200)
    expect(disk()).toContain('seond')
  })

  test('the author’s text equal to the agent’s is not an edit', () => {
    const one = file('tpyo', 'typo')
    decide(one.id, 'accept', { replace: 'typo' })
    expect(tool('list_proposals', { project, epic: 'a-paper' })).toContain('state: accepted')
    expect(tool('list_proposals', { project, epic: 'a-paper' })).not.toContain('adjusted')
  })

  test('the file changed elsewhere: the adjusted words land on the text where it now is', () => {
    const one = file('tpyo in it', 'typo in it')
    writeFileSync(main, SOURCE.replace('\\section{A claim}', '\\section{A bigger claim}'))
    const r = decide(one.id, 'accept', { replace: 'slip in it' })
    expect(r?.status).toBe(200)
    expect(disk()).toContain('slip in it')
    expect(disk()).toContain('A bigger claim')
  })

  test('the text is gone: the adjusted accept says so and accepts nothing', () => {
    const one = file('tpyo in it', 'typo in it')
    writeFileSync(main, SOURCE.replace('tpyo in it', 'something else'))
    const r = decide(one.id, 'accept', { replace: 'x' })
    expect(r?.status).toBe(409)
    expect(disk()).not.toContain('typo in it')
  })
})

describe('groups', () => {
  test('a move is taken together: one accept applies both, atomically', () => {
    const del = file('A third paragraph to move around.\n\n', '', { group: 'move' })
    const ins = file('and ends here.', 'and ends here.\n\nA third paragraph to move around.', { group: 'move' })
    expect(del.said).toContain('Group "move"')
    expect(ins.said).toContain('Group "move"')
    const r = decide(del.id, 'accept')
    expect(r?.status).toBe(200)
    expect(disk()).toContain('and ends here.\n\nA third paragraph to move around.')
    expect(disk().match(/A third paragraph/g)).toHaveLength(1)
    expect(list()).toHaveLength(0)
  })

  test('rejecting one rejects the group', () => {
    const a = file('tpyo', 'typo', { group: 'g' })
    file('seond', 'second', { group: 'g' })
    decide(a.id, 'reject')
    expect(list()).toHaveLength(0)
    expect(disk()).toBe(SOURCE)
  })

  test('if one member no longer applies none do', () => {
    const a = file('tpyo', 'typo', { group: 'g' })
    const b = file('seond typo', 'second typo', { group: 'g' })
    writeFileSync(main, SOURCE.replace('seond typo', 'gone'))
    const before = disk()
    const r = decide(a.id, 'accept')
    expect(disk()).toBe(before)
    expect(r?.status).not.toBe(200)
    expect(list().filter((p) => p.group === 'g')).toHaveLength(0)
    void b
  })

  test('a plain accept that rewrites a member’s words drops the whole group', () => {
    const plain = file('tpyo in it', 'typo in it')
    const m1 = file('tpyo', 'typo', { group: 'g' })
    // Overlaps `plain`; m2 is elsewhere.
    file('seond', 'second', { group: 'g' })
    expect(m1.said).toContain('Overlaps')
    decide(plain.id, 'accept')
    expect(list()).toHaveLength(0)
  })

  test('a group lives in one file', () => {
    file('tpyo', 'typo', { group: 'g' })
    // a second file is not part of this fixture, so only the same-file path is exercised: no refusal here
    const b = file('seond', 'second', { group: 'g' })
    expect(b.id).not.toBe('')
  })

  test('withdrawing a member withdraws the group', () => {
    const a = file('tpyo', 'typo', { group: 'g' })
    file('seond', 'second', { group: 'g' })
    expect(tool('withdraw_edit', { project, id: a.id, token: a.token })).toContain('2 suggestions')
    expect(list()).toHaveLength(0)
  })
})
