import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answerAt as answer } from '../doors.ts'
import { forgetAllProposals, outcomesFor } from '../proposals.ts'

/**
 * #70: accepting one suggestion set aside every suggestion linked to it through a chain of overlaps,
 * and kept each as "declined by the author". A long rewrite overlapping the accepted change and ten
 * small suggestions inside the rewrite made one item of all of them; accepting the first declined the
 * ten, which nobody had seen or chosen. Accepting a change sets aside only what is about the same
 * words as it, and keeps those as superseded; the rest stay pending.
 */

const SOURCE = [
  '\\begin{document}',
  'English abstract: the system grades essays.',
  'Tiivistelmä: järjestelmä arvioi esseitä nopeasti ja hyvin.',
  '\\end{document}',
  '',
].join('\n')

let root = ''
let project = ''
let main = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-superseded-')))
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

function tool(name: string, args: Record<string, unknown>): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  return (reply?.body as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text ?? ''
}
/* Each from a session of its own, as in #70: one filer's second suggestion over its own words revises the first. */
let filer = 0
const suggest = (find: string, replace: string) => {
  const said = tool('propose_edit', { project, epic: 'a-paper', file: 'main.tex', find, replace, why: 'Better.', agent: `session-${++filer}` })
  expect(said).toStartWith('Filed as ')
  return said.replace(/^Filed as (\S+)\..*$/s, '$1')
}
const pending = () =>
  ((answer('GET', '/api/proposals', new URLSearchParams({ epic: 'a-paper', project }), null)?.body as { proposals: { id: string; alt?: string }[] })
    .proposals)
const decide = (id: string, decision: string) =>
  answer('POST', '/api/proposal', new URLSearchParams({ epic: 'a-paper', project }), { id, decision }, TICKET)

describe('accepting one version of a passage', () => {
  test('sets aside only what overlaps it, as superseded, and leaves the rest of the chain pending', () => {
    const english = suggest('grades essays', 'assesses essays')
    /* One long rewrite from the English sentence into the Finnish one: overlaps all of them. */
    const rewrite = suggest('the system grades essays.\nTiivistelmä: järjestelmä arvioi esseitä nopeasti', 'a system scores essays.\nTiivistelmä: ohjelma arvioi esseitä pian')
    const quick = suggest('nopeasti', 'ripeästi')
    const well = suggest('järjestelmä', 'ohjelmisto')
    /* One item: everything is tied together through the rewrite. */
    const item = new Set(pending().map((p) => p.alt))
    expect(item.size).toBe(1)
    expect([...item][0]).toBeDefined()

    expect(decide(english, 'accept')?.status).toBe(200)
    expect(readFileSync(main, 'utf8')).toContain('the system assesses essays.')

    const left = pending().map((p) => p.id).sort()
    expect(left).toEqual([quick, well].sort())
    const outcomes = outcomesFor(project, 'a-paper')
    const ofRewrite = outcomes.find((o) => o.id === rewrite)!
    expect(ofRewrite.state).toBe('dropped')
    expect(ofRewrite.supersededBy).toBe(english)
    expect(outcomes.some((o) => o.state === 'rejected')).toBe(false)

    /* The page's list says what it was: set aside by the accepted change, the whole passage quoted. */
    const facts = answer('GET', '/api/proposals', new URLSearchParams({ epic: 'a-paper', project }), null)?.body as {
      declined: { id: string; how: string; old: string; from?: number }[]
    }
    const said = facts.declined.find((d) => d.id === rewrite)!
    expect(said.how).toBe('superseded')
    expect(said.old).toBe('the system grades essays.\nTiivistelmä: järjestelmä arvioi esseitä nopeasti')
    expect(typeof said.from).toBe('number')

    const listed = tool('list_proposals', { project, epic: 'a-paper' })
    expect(listed).toContain(`${rewrite}\tmain.tex\tstate: superseded: the author accepted ${english}`)
    expect(listed).not.toContain('declined by the author')
  })

  test('cancelling the item still declines every version in it, as the person asked', () => {
    const english = suggest('grades essays', 'assesses essays')
    const rewrite = suggest('the system grades essays.\nTiivistelmä: järjestelmä arvioi esseitä nopeasti', 'a system scores essays.\nTiivistelmä: ohjelma arvioi esseitä pian')
    expect(decide(english, 'reject')?.status).toBe(200)
    expect(pending()).toEqual([])
    expect(outcomesFor(project, 'a-paper').find((o) => o.id === rewrite)?.state).toBe('rejected')
  })
})
