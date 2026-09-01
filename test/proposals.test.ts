import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { forgetAllProposals } from '../proposals.ts'

/**
 * A change an agent suggested, and what a person answering it does to the file.
 *
 * ## The property this file exists to hold
 *
 * **Nothing an agent can reach writes to a `.tex` file.** Everything else here
 * is detail around that one sentence, and it is written as an enumeration of
 * the MCP tools rather than as a comment, because a comment cannot fail when
 * somebody adds a fourth writer to that door.
 *
 * ## And the fixture is hard-wrapped, on purpose
 *
 * A feature shipped in this module once under a green suite and was unusable,
 * because its fixture put every paragraph on one line of source — the single
 * document shape in which a paragraph has no collapsed whitespace in it, and so
 * the single shape where the bug could not occur. Every paragraph below wraps,
 * exactly as a `.tex` file somebody writes in an editor does, and there is a
 * citation and an escape in the middle of one of them.
 */

const SOURCE = [
  '\\title{A proposed paper}',
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim has a tpyo in it and it runs on for long enough that the',
  'author wrapped the line, the way a real paper is written, and ends.',
  '',
  'A second paragraph with \\autocite{jones} a citation in the middle of',
  'it, and a 50\\% escape, and prose after them that runs to the end.',
  '',
  '\\end{document}',
  '',
].join('\n')

let root = ''
let project = ''
let main = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-proposals-')))
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

const onDisk = () => readFileSync(main, 'utf8')

/** One MCP tool call, answered as the text it returns. */
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

/** Suggest a change, and answer with the id it was filed under, or the refusal. */
function suggest(find: string, replace: string, why = 'It reads better.'): string {
  return tool('propose_edit', { project, epic: 'a-paper', file: 'main.tex', find, replace, why })
}

const idOf = (said: string): string => said.replace(/^Filed as (\S+)\..*$/s, '$1')

function pending(): { id: string; from: number; to: number; text: string; was_text: string }[] {
  const reply = answer('GET', '/api/proposals', new URLSearchParams({ epic: 'a-paper', project }), null)
  return (reply?.body as { proposals: { id: string; from: number; to: number; text: string; was_text: string }[] })
    .proposals
}

function decide(id: string, decision: string, ticket: unknown = TICKET) {
  return answer('POST', '/api/proposal', new URLSearchParams({ epic: 'a-paper', project }), {
    id,
    decision,
    ticket,
  })
}

describe('nothing an agent can reach writes', () => {
  /*
   * The enumeration. If a fourth tool appears on this door, this test fails and
   * whoever added it has to come here and say, in this list, whether it writes.
   * That is the point: the list is the claim, and it is checked.
   */
  test('the MCP door offers exactly these tools, and only one of them is not a read', () => {
    const reply = answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = ((reply?.body as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name)
    expect(names.sort()).toEqual(['list_papers', 'list_proposals', 'propose_edit', 'read_paper', 'read_source'])
  })

  test('proposing leaves the file byte-identical', () => {
    const before = onDisk()
    const said = suggest('tpyo', 'typo')
    expect(said).toStartWith('Filed as ')
    expect(onDisk()).toBe(before)
    expect(pending()).toHaveLength(1)
  })

  test('there is no MCP tool that accepts one', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    /* The obvious names an agent would reach for, refused by name rather than
       by happening not to exist — so that adding one of them later has to be a
       decision made here. */
    for (const name of ['accept_edit', 'apply_edit', 'edit_paper', 'write_source']) {
      expect(tool(name, { project, epic: 'a-paper', id })).toContain('no tool')
    }
    expect(onDisk()).toBe(SOURCE)
  })

  test('the apply door refuses a caller with no ticket, and writes nothing', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    const reply = decide(id, 'accept', 'a ticket somebody guessed')
    expect(reply?.status).toBe(403)
    expect(onDisk()).toBe(SOURCE)
    expect(pending()).toHaveLength(1)
  })
})

describe('answering one', () => {
  test('rejecting leaves the file byte-identical and forgets the suggestion', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    const reply = decide(id, 'reject')
    expect(reply?.status).toBe(200)
    expect(onDisk()).toBe(SOURCE)
    expect(pending()).toHaveLength(0)
  })

  test('accepting writes exactly the change, and nothing else moves', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    expect(decide(id, 'accept')?.status).toBe(200)
    expect(onDisk()).toBe(SOURCE.replace('tpyo', 'typo'))
    expect(pending()).toHaveLength(0)
  })

  test('the stored range is narrowed to the letters that differ', () => {
    /* A whole clause quoted in order to change two letters replaces two
       letters. Every anchor in the rest of that clause is left in bytes nothing
       touched — the reason `narrow` exists, checked one layer up. */
    suggest('has a tpyo in it', 'has a typo in it')
    const [only] = pending()
    expect(only!.was_text).toBe('py')
    expect(only!.text).toBe('yp')
    expect(only!.to - only!.from).toBe(2)
  })

  test('a change across the author’s hard wrap is proposed and applied', () => {
    /* The case the last fixture in this module could not exhibit. The words
       either side of a wrap are one run on screen and two lines in the file,
       and the newline between them is whitespace, which is writable. */
    const id = idOf(suggest('long enough that the\nauthor wrapped', 'long enough that the author wrapped'))
    expect(id).not.toContain('markup')
    expect(decide(id, 'accept')?.status).toBe(200)
    expect(onDisk()).toContain('long enough that the author wrapped')
  })
})

describe('what a proposal may not be about', () => {
  /*
   * The two below are the reason `sourceRefuses` is applied to the whole quoted
   * window here and not to the narrowed range, and they are worth reading
   * together, because the first one PASSED when this file was first written.
   *
   * `\autocite{jones}` becoming `\autocite{smith}` narrows to `jones` becoming
   * `smith`. Neither string holds a LaTeX special, so the range was safe to
   * write and the proposal was accepted — and it was undrawable, because those
   * five characters render as part of `[jones]` and `renderedRange` will not
   * pretend otherwise. It would have sat in the pending list, invisible in the
   * paper, waiting for somebody to approve a change they could not see. That is
   * the failure this whole feature exists to prevent, arrived at from the
   * inside.
   */
  test('a citation is refused, even though the letters inside it are not markup', () => {
    expect(suggest('\\autocite{jones}', '\\autocite{smith}')).toContain('LaTeX markup')
    expect(pending()).toHaveLength(0)
  })

  test('a replacement holding markup is refused', () => {
    expect(suggest('a 50', 'a 100%')).toContain('LaTeX markup')
    expect(pending()).toHaveLength(0)
  })

  test('quoting across an escape is refused, and quoting beside it is not', () => {
    /* The over-refusal the rule buys, and the one-line way round it. `50\%`
       becoming `90\%` narrows to `5` becoming `9`, which this page could draw
       perfectly well — and the rule refuses it anyway rather than growing an
       exception. What the agent does instead is quote prose. */
    expect(suggest('50\\% escape', '90\\% escape')).toContain('LaTeX markup')
    const id = idOf(suggest('a 50', 'a 90'))
    expect(decide(id, 'accept')?.status).toBe(200)
    expect(onDisk()).toContain('a 90\\% escape')
  })

  test('text that appears twice is refused, and says how many', () => {
    const said = suggest('the ', 'a ')
    expect(said).toContain('times in this file')
    expect(pending()).toHaveLength(0)
  })

  test('text that is not there is refused', () => {
    expect(suggest('a sentence nobody wrote', 'x')).toContain('not in this file')
  })

  test('a proposal that changes nothing is refused', () => {
    expect(suggest('tpyo', 'tpyo')).toContain('changes nothing')
  })

  test('a suggestion with no reason is refused', () => {
    expect(suggest('tpyo', 'typo', '')).toContain('has to say why')
  })
})

describe('two pending in one file', () => {
  /*
   * The failure this section is about: applying one proposal moves every byte
   * offset after it, so the second describes a place that no longer means what
   * it meant. `rebase` is the answer and these are the three cases it has.
   */
  const two = () => {
    const first = idOf(suggest('tpyo', 'typographical'))
    const second = idOf(suggest('prose after them', 'the prose after them'))
    return { first, second }
  }

  test('accepting the earlier one leaves the later one applicable', () => {
    const { first, second } = two()
    expect(decide(first, 'accept')?.status).toBe(200)
    expect(pending()).toHaveLength(1)
    expect(decide(second, 'accept')?.status).toBe(200)
    const after = onDisk()
    expect(after).toContain('a typographical in it')
    expect(after).toContain('and the prose after them that runs')
  })

  test('accepting the later one leaves the earlier one applicable', () => {
    const { first, second } = two()
    expect(decide(second, 'accept')?.status).toBe(200)
    expect(decide(first, 'accept')?.status).toBe(200)
    const after = onDisk()
    expect(after).toContain('a typographical in it')
    expect(after).toContain('and the prose after them that runs')
  })

  test('the surviving one is restamped, so it is not refused as stale', () => {
    const { first, second } = two()
    const before = pending().find((p) => p.id === second)!
    decide(first, 'accept')
    const after = pending().find((p) => p.id === second)!
    /* Its bytes moved by the change in length, and its hash is the file's new
       one — which is the whole of why the second Accept does not answer 409. */
    expect(after.from - before.from).toBe('typographical'.length - 'tpyo'.length)
    expect(after.to - before.to).toBe('typographical'.length - 'tpyo'.length)
  })

  test('one that overlaps what was applied is dropped, and said out loud', () => {
    const first = idOf(suggest('tpyo', 'typo'))
    idOf(suggest('a tpyo in', 'a typo in'))
    expect(pending()).toHaveLength(2)
    const reply = decide(first, 'accept')
    expect(reply?.status).toBe(200)
    expect(pending()).toHaveLength(0)
    expect((reply?.body as { said: string }).said).toContain('dropped')
    /* Refused for the overlapping one, and applied exactly once for the other. */
    expect(onDisk()).toBe(SOURCE.replace('tpyo', 'typo'))
  })

  test('a typed correction moves pending suggestions too', () => {
    /* Not only the accept path. Somebody fixing a typo above a pending
       suggestion has moved its bytes just as surely. */
    const id = idOf(suggest('prose after them', 'the prose after them'))
    const before = pending()[0]!
    const paper = answer('GET', '/api/paper', new URLSearchParams({ epic: 'a-paper', project }), null)
    const hash = (paper?.body as { paper: { hashes: Record<string, string> } }).paper.hashes['main.tex']
    const at = Buffer.from(SOURCE, 'utf8').indexOf('tpyo')
    const wrote = answer('POST', '/api/edit', new URLSearchParams({ epic: 'a-paper', project }), {
      file: 'main.tex',
      from: at,
      to: at + 4,
      text: 'typographical',
      was: hash,
      ticket: TICKET,
    })
    expect(wrote?.status).toBe(200)
    const after = pending()[0]!
    expect(after.from - before.from).toBe('typographical'.length - 'tpyo'.length)
    expect(decide(id, 'accept')?.status).toBe(200)
    expect(onDisk()).toContain('and the prose after them that runs')
  })
})

describe('a file that moved underneath', () => {
  test('a suggestion measured against an older file is refused, and nothing is written', () => {
    const id = idOf(suggest('tpyo', 'typo'))
    /* The author, in their own editor, on the same file. A same-length rewrite,
       which is the case `sourceLength` could never have caught. */
    const meddled = SOURCE.replace('and ends.', 'and ENDS.')
    writeFileSync(main, meddled)
    const reply = decide(id, 'accept')
    expect(reply?.status).toBe(409)
    expect((reply?.body as { stale: boolean }).stale).toBe(true)
    expect(onDisk()).toBe(meddled)
    /* And it is gone rather than left as an affordance that would refuse
       forever. See the essay on the door. */
    expect(pending()).toHaveLength(0)
  })
})

describe('the pending list is per project and per epic', () => {
  test('a suggestion filed against one project is not offered to another', () => {
    const other = join(root, 'elsewhere')
    mkdirSync(join(other, '.kehikot', 'paper', 'a-paper'), { recursive: true })
    writeFileSync(join(other, '.kehikot', 'paper', 'a-paper', 'main.tex'), SOURCE)
    suggest('tpyo', 'typo')
    const reply = answer(
      'GET',
      '/api/proposals',
      new URLSearchParams({ epic: 'a-paper', project: other }),
      null,
    )
    expect((reply?.body as { proposals: unknown[] }).proposals).toHaveLength(0)
  })
})
