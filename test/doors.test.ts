import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

/*
 * Two projects, because every door here takes one and the interesting failures
 * are all about being asked the right question against the wrong project.
 *
 * These used to be two environment variables — a papers directory and a thesis
 * directory — set in `beforeAll` and deleted in `afterAll`. They are two
 * project layouts now, which is a better fixture for the same reason it is a
 * better design: a test that reaches into `process.env` is testing the shell
 * this process was started in, and that is not where a paper lives.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-doors-')))

/** A project holding one paper among its other things. */
const roadmap = join(root, 'roadmap')
/** A project whose one paper is a thesis. Same folder, same rule. */
const thesisProject = join(root, 'thesis')
const thesis = join(thesisProject, '.kehikot', 'paper', 'thesis')

beforeAll(() => {
  mkdirSync(join(roadmap, '.kehikot', 'paper', 'a-paper'), { recursive: true })
  writeFileSync(
    join(roadmap, '.kehikot', 'paper', 'a-paper', 'main.tex'),
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
  /* A thesis, with a `figures/` folder beside its `main.tex`. Under the old
     model this was the shape that needed a pointer file, because the document
     sat at the top of its own repository. It sits where papers sit now, and
     nothing about this fixture says which kind of paper it is. */
  mkdirSync(join(thesis, 'figures'), { recursive: true })
  writeFileSync(
    join(thesis, 'main.tex'),
    [
      '\\title{A thesis}',
      '\\begin{document}',
      '\\begin{figure}',
      '\\includegraphics{figures/plot.png}',
      '\\caption{A plot.}',
      '\\end{figure}',
      '\\end{document}',
    ].join('\n'),
  )
  writeFileSync(join(thesis, 'figures', 'plot.png'), PNG)
  writeFileSync(join(thesis, 'figures', 'private.png'), PNG)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The PNG signature, so a served figure can be checked byte for byte. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const get = (path: string, query = '') => answer('GET', path, new URLSearchParams(query), null)
const post = (path: string, body: Record<string, unknown> | null) =>
  answer('POST', path, new URLSearchParams(), body)

/** A query with a project on it, since every read door now needs one. */
const inProject = (project: string, query = '') =>
  query ? `${query}&project=${encodeURIComponent(project)}` : `project=${encodeURIComponent(project)}`

describe('there is no write path', () => {
  /*
   * Every POST this app will accept, enumerated. `/mcp` is the only one, and
   * every tool behind it reads. If a route is ever added that writes, this test
   * fails and whoever added it has to come and read the essay in `doors.ts`
   * about the ticket, the origin and the CORS header that must arrive with it.
   */
  test.each([
    '/api/edits',
    '/api/paper',
    '/api/papers',
    '/api/source',
    '/api/figure',
    '/api/notice',
    '/api/work',
  ])(
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

  test('the paper list is one project’s, and says which', () => {
    /* It used to be every paper on this machine, across two configured roots.
       There is no such list any more and there should never have been one: a
       container is standing in a project, and papers from a project nobody is
       looking at are somebody else's material drawn under this project's name. */
    const body = get('/api/papers', inProject(roadmap))?.body as {
      project: string | null
      keeps: boolean
      papers: { epic: string }[]
    }
    expect(body.project).toBe(roadmap)
    expect(body.keeps).toBe(true)
    expect(body.papers.map((p) => p.epic)).toEqual(['a-paper'])

    const other = get('/api/papers', inProject(thesisProject))?.body as { papers: { epic: string }[] }
    expect(other.papers.map((p) => p.epic)).toEqual(['thesis'])
  })

  test('three emptinesses, told apart rather than collapsed into one list', () => {
    /*
     * The distinction the host's own holdings code is built around, and the one
     * this door has always drawn: an app that says "no papers" and quietly
     * means "nobody told me where to look" has told somebody the opposite of
     * the truth. There is one more of these than there used to be, because
     * "this project was never set up for papers" and "this project has none
     * yet" are also different things to do next.
     */
    const nowhere = get('/api/papers')?.body as { project: string | null; keeps: boolean }
    expect(nowhere.project).toBeNull()
    expect(nowhere.keeps).toBe(false)

    const bare = join(root, 'bare')
    mkdirSync(bare, { recursive: true })
    const unset = get('/api/papers', inProject(bare))?.body as { project: string | null; keeps: boolean }
    expect(unset.project).toBe(bare)
    expect(unset.keeps).toBe(false)

    const empty = join(root, 'empty-roadmap')
    mkdirSync(join(empty, '.kehikot', 'paper'), { recursive: true })
    const nonePlease = get('/api/papers', inProject(empty))?.body as {
      keeps: boolean
      papers: unknown[]
    }
    expect(nonePlease.keeps).toBe(true)
    expect(nonePlease.papers).toEqual([])
  })

  test('a paper asked for with no project is 409, not 404', () => {
    /* There is no answer to "is there a paper for this epic" until there is a
       project to have one in. A 404 would be a claim about a directory this app
       has not been shown. */
    const reply = get('/api/paper', 'epic=a-paper')
    expect(reply?.status).toBe(409)
    expect((reply?.body as { project: string | null }).project).toBeNull()
  })

  test('a paper cannot be read through the wrong project', () => {
    /* The property the two-root arrangement had to keep and the two-project one
       still does: nothing resolves against a root it does not belong to. The
       slug is right, the paper exists on this disk, and the answer is still no. */
    expect(get('/api/paper', inProject(thesisProject, 'epic=a-paper'))?.status).toBe(404)
    expect(get('/api/paper', inProject(roadmap, 'epic=thesis'))?.status).toBe(404)
  })

  test('one paper comes back parsed, with its chapters in reading order', () => {
    const body = get('/api/paper', inProject(roadmap, 'epic=a-paper'))?.body as {
      ok: boolean
      paper: { title: string; outline: { text: string }[] }
    }
    expect(body.ok).toBe(true)
    expect(body.paper.title).toBe('Something argued')
    expect(body.paper.outline.map((h) => h.text)).toEqual(['A claim'])
  })

  test('an epic with no paper is a 404 and not an empty document', () => {
    expect(get('/api/paper', inProject(roadmap, 'epic=nothing-here'))?.status).toBe(404)
  })

  test('a name that is not an epic name is refused the same way whatever exists', () => {
    /* Identical refusals, so the door cannot be used to enumerate what is on
       this disk by timing or by wording. */
    const a = get('/api/paper', inProject(roadmap, 'epic=' + encodeURIComponent('../../etc/passwd')))
    const b = get('/api/paper', inProject(roadmap, 'epic=' + encodeURIComponent('Not A Slug')))
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
      params: { name: 'read_paper', arguments: { project: roadmap, epic: 'a-paper' } },
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
      params: { name: 'read_source', arguments: { project: roadmap, epic: 'a-paper' } },
    })
    const text = (reply?.body as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(text).toContain('\\begin{document}')
  })

  test('every tool refuses without a project rather than guessing one', () => {
    /*
     * The refusal is the feature. Each available default is silently wrong —
     * `process.cwd()` is this module's own directory, "the only project with
     * papers" is right until there are two — and a tool that guessed would
     * answer confidently about a paper nobody asked for.
     */
    for (const name of ['list_papers', 'read_paper', 'read_source']) {
      const reply = post('/mcp', {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name, arguments: { epic: 'a-paper' } },
      })
      const text = (reply?.body as { result: { content: { text: string }[] } }).result.content[0]!.text
      expect(text).toContain('No project is open')
    }
  })

  test('list_papers answers about the project it was given and no other', () => {
    const ask = (project: string) => {
      const reply = post('/mcp', {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'list_papers', arguments: { project } },
      })
      return (reply?.body as { result: { content: { text: string }[] } }).result.content[0]!.text
    }
    expect(ask(roadmap)).toContain('a-paper')
    expect(ask(roadmap)).not.toContain('thesis')
    expect(ask(thesisProject)).toContain('thesis')
  })

  test('a notification is answered with nothing at all', () => {
    const reply = post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(reply).toEqual({ status: 202, body: null })
  })

  test('a GET on the MCP door is refused', () => {
    expect(get('/mcp')?.status).toBe(405)
  })
})

describe('the figure door', () => {
  /*
   * The only door here that answers with something other than JSON, and the
   * only one that opens a file the paper did not `\include`.
   *
   * The reading view used to draw a dashed box with a filename in it for every
   * figure, and the comment saying why called serving the image "a door that
   * reads arbitrary files out of somebody else's tree and answers them with a
   * guessed content type". These tests are the answer to that objection rather
   * than a repeal of it: named-by-the-paper, typed from a table, extension
   * allowlisted, confined. Take any one of the four away and one of these
   * fails.
   */

  test('a raster the paper named comes back as bytes with a type, not as JSON', () => {
    const reply = get('/api/figure', inProject(thesisProject, 'epic=thesis&file=figures%2Fplot.png'))
    expect(reply?.status).toBe(200)
    expect(reply?.body).toBeNull()
    expect(reply?.binary?.type).toBe('image/png')
    expect(Buffer.from(reply!.binary!.bytes).equals(PNG)).toBe(true)
  })

  test('a file sitting beside it that the paper never named is refused', () => {
    /* The check that stops this being a file server. `figures/private.png`
       exists, is a PNG, and is inside the root; it is refused because the paper
       does not name it. */
    const reply = get('/api/figure', inProject(thesisProject, 'epic=thesis&file=figures%2Fprivate.png'))
    expect(reply?.status).toBe(404)
    expect(reply?.binary).toBeUndefined()
  })

  test('a refusal is still JSON, so no branch can serve an error as an image', () => {
    for (const query of [
      'epic=thesis&file=..%2F..%2Fetc%2Fpasswd',
      'epic=thesis&file=main.tex',
      'epic=thesis',
    ]) {
      const reply = get('/api/figure', inProject(thesisProject, query))
      expect(reply?.binary).toBeUndefined()
      expect(reply?.status).toBeGreaterThanOrEqual(400)
    }
  })

  test('an epic name that is not one is refused before any filesystem call', () => {
    expect(get('/api/figure', inProject(thesisProject, 'epic=..%2F..&file=figures%2Fplot.png'))?.status).toBe(400)
  })

  test('one root cannot be asked for the other root’s figure', () => {
    /* Both roots are configured in this file. `a-paper` lives under the papers
       directory and names no figures at all; asking for the thesis's figure
       under its slug must not resolve, because a union of roots is exactly what
       a second root must not become. */
    expect(get('/api/figure', inProject(roadmap, 'epic=a-paper&file=figures%2Fplot.png'))?.status).toBe(404)
  })
})
