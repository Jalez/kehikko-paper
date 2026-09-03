import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { forgetAllProposals, keep, pendingFor } from '../proposals.ts'
import { hashesOf } from '../store.ts'

/**
 * The doors' side of a file that moved while nobody here was writing it.
 *
 * Two properties, each the server's half of a page feature:
 *
 *  - **`/api/uncommitted` says what the files ARE.** The standing poll is how
 *    a page hears that the disk moved, so the hashes it carries have to be
 *    the same hashes `/api/paper` hands out — same files, same values — or
 *    the page would either miss a change or report one that did not happen.
 *  - **`/api/proposals` is measured against the disk.** A suggestion filed
 *    against a file that then changed under it is either found again by the
 *    text the agent quoted, exactly once, or dropped and said. It is never
 *    handed out with a hash the door would refuse.
 */

const SOURCE = [
  '\\title{A paper that moves}',
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The first paragraph has a tpyo in it and runs on for long enough that the',
  'author wrapped the line, the way a real paper is written, and ends.',
  '',
  'The second paragraph is the one an agent will suggest a change to, and',
  'it also wraps because that is how a real file is written.',
  '',
  '\\end{document}',
  '',
].join('\n')

let root = ''
let project = ''
let main = ''
const epic = 'moving'

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-external-')))
  project = join(root, 'work')
  const paper = join(project, '.kehikot', 'paper', epic)
  mkdirSync(paper, { recursive: true })
  main = join(paper, 'main.tex')
  writeFileSync(main, SOURCE)
  forgetAllProposals()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  forgetAllProposals()
})

const get = (path: string) => answer('GET', path, new URLSearchParams({ project, epic }), null)?.body as Record<string, unknown>

function tool(name: string, args: Record<string, unknown>): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const result = (reply?.body as { result?: { content?: { text?: string }[] } })?.result
  return result?.content?.[0]?.text ?? ''
}

const suggest = (find: string, replace: string) =>
  tool('propose_edit', { project, epic, file: 'main.tex', find, replace, why: 'It reads better.' })

describe('/api/uncommitted carries what the files are', () => {
  test('the hashes are the same ones /api/paper hands out', () => {
    const standing = get('/api/uncommitted')
    const paper = get('/api/paper').paper as { hashes: Record<string, string> }
    expect(standing.hashes).toEqual(paper.hashes)
    expect(Object.keys(paper.hashes)).toEqual(['main.tex'])
  })

  test('a file rewritten from outside changes its hash and nothing else', () => {
    const before = get('/api/uncommitted').hashes as Record<string, string>
    writeFileSync(main, SOURCE.replace('tpyo', 'typo'))
    const after = get('/api/uncommitted').hashes as Record<string, string>
    expect(after['main.tex']).not.toBe(before['main.tex'])
    /* And is, again, what a fresh read of the paper would say. */
    expect(after).toEqual((get('/api/paper').paper as { hashes: Record<string, string> }).hashes)
  })

  test('a chapter added by \\include appears under the same key the paper uses', () => {
    mkdirSync(join(project, '.kehikot', 'paper', epic, 'chapters'), { recursive: true })
    writeFileSync(join(project, '.kehikot', 'paper', epic, 'chapters', 'two.tex'), 'A chapter.\n')
    writeFileSync(main, SOURCE.replace('\\end{document}', '\\include{chapters/two}\n\\end{document}'))
    const hashes = get('/api/uncommitted').hashes as Record<string, string>
    expect(Object.keys(hashes).sort()).toEqual(['chapters/two.tex', 'main.tex'])
    expect(hashes).toEqual((get('/api/paper').paper as { hashes: Record<string, string> }).hashes)
    expect(hashesOf(epic, project)).toEqual(hashes)
  })

  test('with no project, or no paper, there are no hashes and it is not an error', () => {
    const none = answer('GET', '/api/uncommitted', new URLSearchParams({ epic }), null)?.body as Record<string, unknown>
    expect(none.ok).toBe(true)
    expect(none.hashes).toBeNull()
    const missing = answer('GET', '/api/uncommitted', new URLSearchParams({ project, epic: 'nothing-here' }), null)
      ?.body as Record<string, unknown>
    expect(missing.ok).toBe(true)
    expect(missing.hashes).toBeNull()
  })
})

describe('/api/proposals is measured against the disk', () => {
  test('a suggestion below an outside edit is found again, moved, and restamped', () => {
    expect(suggest('one an agent will suggest', 'one an agent will propose')).toContain('Filed as')
    const [filed] = pendingFor(project, epic)
    /* The author fixes the typo in the FIRST paragraph, in their editor:
       three bytes shorter above the suggestion. */
    writeFileSync(main, SOURCE.replace('a tpyo in it', 'a typo in'))
    const body = get('/api/proposals')
    const [again] = body.proposals as { from: number; to: number; was: string; text: string }[]
    expect(again).toBeDefined()
    expect(again!.from).toBe(filed!.from - 3)
    expect(again!.to).toBe(filed!.to - 3)
    expect(again!.text).toBe(filed!.text)
    expect(again!.was).toBe((get('/api/uncommitted').hashes as Record<string, string>)['main.tex']!)
    expect(body.said).toBe('')
    /* And accepting it now lands, which is the whole point of restamping. */
    const accepted = answer('POST', '/api/proposal', new URLSearchParams({ project, epic }), {
      ticket: TICKET,
      id: filed!.id,
      decision: 'accept',
    })
    expect(accepted?.status).toBe(200)
    expect(readFileSync(main, 'utf8')).toContain('one an agent will propose')
  })

  test('a suggestion whose quoted text is gone is dropped, and said', () => {
    expect(suggest('one an agent will suggest', 'one an agent will propose')).toContain('Filed as')
    writeFileSync(main, SOURCE.replace('the one an agent will suggest a change to', 'rewritten by the author'))
    const body = get('/api/proposals')
    expect(body.proposals).toEqual([])
    expect(String(body.said)).toContain('One suggestion was dropped')
    expect(String(body.said)).toContain('main.tex')
    /* Said once. The next read has nothing to drop and says nothing. */
    expect(get('/api/proposals').said).toBe('')
  })

  test('a suggestion the author applied themselves is dropped too — there is nothing left to suggest', () => {
    expect(suggest('a tpyo in it', 'a typo in it')).toContain('Filed as')
    writeFileSync(main, SOURCE.replace('tpyo', 'typo'))
    const body = get('/api/proposals')
    expect(body.proposals).toEqual([])
    expect(String(body.said)).toContain('dropped')
  })

  test('a suggestion whose quoted text now appears twice is dropped rather than guessed at', () => {
    expect(suggest('a tpyo in it', 'a typo in it')).toContain('Filed as')
    writeFileSync(main, SOURCE.replace('\\end{document}', 'Again a tpyo in it.\n\n\\end{document}'))
    expect(get('/api/proposals').proposals).toEqual([])
  })

  test('an unchanged file costs nothing: the list comes back as it was', () => {
    expect(suggest('a tpyo in it', 'a typo in it')).toContain('Filed as')
    const [filed] = pendingFor(project, epic)
    const [same] = get('/api/proposals').proposals as { id: string; from: number; was: string }[]
    expect(same).toEqual(expect.objectContaining({ id: filed!.id, from: filed!.from, was: filed!.was }))
  })

  test('a proposal kept without what was asked cannot be measured again, and is dropped', () => {
    /* The shape a test builds by hand: no `asked`. Before this feature such a
       proposal would have sat un-acceptable forever; now it goes, and says. */
    const hashes = get('/api/uncommitted').hashes as Record<string, string>
    keep(project, epic, {
      file: 'main.tex',
      from: 10,
      to: 14,
      text: 'x',
      was_text: 'y',
      was: hashes['main.tex']!,
      why: 'why',
      by: 'a test',
    })
    writeFileSync(main, SOURCE.replace('tpyo', 'typo'))
    const body = get('/api/proposals')
    expect(body.proposals).toEqual([])
    expect(String(body.said)).toContain('dropped')
  })

  test('list_proposals on the MCP door sees the same measured list', () => {
    expect(suggest('one an agent will suggest', 'one an agent will propose')).toContain('Filed as')
    writeFileSync(main, SOURCE.replace('the one an agent will suggest a change to', 'rewritten by the author'))
    const said = tool('list_proposals', { project, epic })
    expect(said).toContain('One suggestion was dropped')
    expect(tool('list_proposals', { project, epic })).toBe('Nothing is waiting on that paper.')
  })
})
