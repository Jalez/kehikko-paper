import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { answer } from '../doors.ts'
import { ID } from '../manifest.ts'

/**
 * The doors, called the way `vite.config.ts` calls them: a method, a path, a
 * query and a body.
 *
 * The property under test throughout is that nothing here writes and nothing
 * here can be talked into reading outside the papers directory. The program
 * this was extracted from had a `POST /api/edits` behind an unconfigured
 * `cors()`; the first test below is the guard that stops that shape coming
 * back, and it is written as an enumeration rather than a comment because a
 * comment cannot fail.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-paper-doors-'))
const papers = join(root, 'papers')

beforeAll(() => {
  mkdirSync(join(papers, 'a-paper'), { recursive: true })
  writeFileSync(
    join(papers, 'a-paper', 'main.tex'),
    [
      '\\title{Something argued}',
      '\\begin{document}',
      '\\section{A claim}',
      '',
      'The claim, in a sentence.',
      '',
      '\\end{document}',
    ].join('\n'),
  )
  process.env.KEHIKKO_PAPERS_DIR = papers
})

afterAll(() => {
  delete process.env.KEHIKKO_PAPERS_DIR
  rmSync(root, { recursive: true, force: true })
})

const get = (path: string, query = '') => answer('GET', path, new URLSearchParams(query), null)
const post = (path: string, body: Record<string, unknown> | null) =>
  answer('POST', path, new URLSearchParams(), body)

describe('there is no write path', () => {
  /*
   * Every POST this app will accept, enumerated. `/mcp` is the only one, and
   * every tool behind it reads. If a route is ever added that writes, this test
   * fails and whoever added it has to come and read the essay in `doors.ts`
   * about the ticket, the origin and the CORS header that must arrive with it.
   */
  test.each(['/api/edits', '/api/paper', '/api/papers', '/api/source', '/api/notice', '/api/work'])(
    'POST %s is refused',
    (path) => {
      const reply = post(path, { anything: 'at all' })
      expect(reply?.status).toBeGreaterThanOrEqual(400)
    },
  )

  test('the MCP door offers only tools that read', () => {
    const reply = post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = ((reply?.body as { result: { tools: { name: string }[] } }).result.tools ?? []).map(
      (t) => t.name,
    )
    expect(tools).toEqual(['list_papers', 'read_paper', 'read_source'])
  })
})

describe('the ordinary doors', () => {
  test('health says who is answering', () => {
    expect(get('/healthz')?.body).toMatchObject({ ok: true, id: ID })
  })

  test('the paper list says whether anybody has configured this', () => {
    /* Two fields, not one empty list. "No papers here" and "nobody said where to
       look" are different sentences and the page draws different screens. */
    const body = get('/api/papers')?.body as { configured: boolean; papers: unknown[] }
    expect(body.configured).toBe(true)
    expect(body.papers).toHaveLength(1)
  })

  test('one paper comes back parsed, with its chapters in reading order', () => {
    const body = get('/api/paper', 'epic=a-paper')?.body as {
      ok: boolean
      paper: { title: string; outline: { text: string }[] }
    }
    expect(body.ok).toBe(true)
    expect(body.paper.title).toBe('Something argued')
    expect(body.paper.outline.map((h) => h.text)).toEqual(['A claim'])
  })

  test('an epic with no paper is a 404 and not an empty document', () => {
    expect(get('/api/paper', 'epic=nothing-here')?.status).toBe(404)
  })

  test('a name that is not an epic name is refused the same way whatever exists', () => {
    /* Identical refusals, so the door cannot be used to enumerate what is on
       this disk by timing or by wording. */
    const a = get('/api/paper', 'epic=' + encodeURIComponent('../../etc/passwd'))
    const b = get('/api/paper', 'epic=' + encodeURIComponent('Not A Slug'))
    expect(a?.status).toBe(400)
    expect(a?.body).toEqual(b?.body as object)
  })

  test('a path under /api that is not ours is refused rather than handed to Vite', () => {
    /* Otherwise Vite tries to serve it as a source file, and an unknown API
       path answers 200 with compiled TypeScript. */
    expect(get('/api/anything')?.status).toBe(404)
  })

  test('a path that is not ours at all is passed on', () => {
    expect(get('/page/main.ts')).toBeNull()
  })
})

describe('the MCP door', () => {
  test('an unknown tool name is an answer rather than a thrown error', () => {
    /* `constructor` is on the prototype of every plain object, so a bare lookup
       would find a function and calling `.run` on it would be a TypeError out
       of a request handler instead of a sentence. */
    const reply = post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'constructor' } })
    expect(reply?.status).toBe(200)
    expect((reply?.body as { result: { isError: boolean } }).result.isError).toBe(true)
  })

  test('read_paper answers prose, not markup', () => {
    const reply = post('/mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_paper', arguments: { epic: 'a-paper' } },
    })
    const text = (reply?.body as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(text).toContain('The claim, in a sentence.')
    expect(text).not.toContain('\\begin{document}')
  })

  test('read_source answers markup, because an edit cannot be made from prose', () => {
    const reply = post('/mcp', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read_source', arguments: { epic: 'a-paper' } },
    })
    const text = (reply?.body as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(text).toContain('\\begin{document}')
  })

  test('a notification is answered with nothing at all', () => {
    const reply = post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(reply).toEqual({ status: 202, body: null })
  })

  test('a GET on the MCP door is refused', () => {
    expect(get('/mcp')?.status).toBe(405)
  })
})
