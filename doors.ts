import { ID, MANIFEST, VERSION } from './manifest.ts'
import {
  isEpic,
  listPapers,
  papersDir,
  readFigure,
  readPaper,
  readSource,
  thesisRoot,
  type PaperRoot,
} from './store.ts'

/**
 * Every door this app answers on that is not the page itself.
 *
 * ## Why this is a file of functions rather than a server
 *
 * Lifted, argument and all, from Journeys, because the argument is not about
 * journeys. A module is ONE ORIGIN or it is nothing: the protocol refuses a
 * manifest whose `entry` points anywhere but the origin that served the
 * manifest, and it is right to — a program that could name somebody else's page
 * would be a program that could have the host frame somebody else. So the
 * manifest, the health check, the MCP door and this app's own `/api` are all
 * middleware in front of the one server that serves the page, and this file
 * holds the deciding without holding a socket. `answer()` takes a method, a
 * path, a query and a body and returns a status and a document; `vite.config.ts`
 * adapts a node request to it in a dozen lines.
 *
 * ## There is no write path here, and that is the headline
 *
 * The program this was extracted from had one. `POST /api/edits` wrote to the
 * author's thesis on disk, guarded by an `expectedText` match — a good guard —
 * and sat behind `app.use(cors())` with no options at all. That is a
 * wide-open cross-origin policy in front of a path that mutates somebody's
 * writing: any page in any tab, on any site, could read that origin and post to
 * it. Nothing of that shape is carried across, in any form:
 *
 *  - There is no route here that writes a byte. `readPaper` and `readSource`
 *    open files; nothing in this repository has a `writeFileSync` in it.
 *  - There is therefore no ticket. Journeys mints one because it takes writes,
 *    and is careful to say in its own comments that a ticket is not an
 *    authorization check. A ticket here would protect nothing and would be a
 *    secret printed into a page for decoration.
 *  - There is no `server.cors` line in `vite.config.ts`, and `manifest.ts`
 *    declares `storage: true` instead, so the page keeps a real origin and its
 *    own `/api` calls are ordinary same-origin requests that involve no CORS at
 *    all. The essay is in both those files.
 *
 * If a write path is ever wanted here — accepting a correction to a paragraph,
 * say — it must arrive with all three of those back: a ticket minted per
 * process and printed into the page, `storage: true` kept so the ticket is not
 * readable cross-origin, and a comment saying plainly that the ticket separates
 * "this app's own page" from "something else on this machine that guessed the
 * port", and separates nothing else.
 *
 * ## Reads are not gated, and that is deliberate
 *
 * `/api/papers` and `/api/paper` answer anybody who asks on loopback. A paper
 * in this roadmap is a document its author is publishing; gating a read would
 * mean an agent's `curl` needed a credential to look at a page it can already
 * open in a browser, which buys nothing and costs the thing that makes this app
 * usable from a terminal. What IS guarded is the shape of the epic name and the
 * resolved path underneath it — see the two fences in `store.ts` — because "read
 * the open epic's paper" turning into "read anything on this disk" is the real
 * hazard on a read-only server.
 */

/* ------------------------------------------------------------------ *
 * Everything that arrives, bounded before it is looked at
 *
 * Nothing here trusts its caller. The page is one caller, an agent over MCP is
 * another, and a third is whatever else is running on this machine and found
 * the port — this listens on loopback, which is a fence around the machine and
 * not around the programs on it. A string has a length before it has a meaning.
 * ------------------------------------------------------------------ */

const MAX_SLUG = 80
const MAX_PATH = 200

function str(value: unknown, max: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max)
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/** A status and a document. Nothing here writes bytes; the adapter does that. */
export interface Reply {
  status: number
  /** `null` means "answer with no body", which is what a notification gets. */
  body: unknown
  /**
   * An image, when the answer is one, with the content type to send it under.
   *
   * The one non-JSON answer this app has. It is a separate field rather than a
   * `body` that is sometimes bytes so that the adapter cannot serve an image
   * as `application/json` or a refusal as `image/png` by forgetting a branch —
   * a refusal here is still an ordinary JSON `body`, and `binary` is present
   * only when there really are bytes.
   *
   * The type comes from `store.ts`'s extension table and never from the bytes.
   * See the essay there.
   */
  binary?: { bytes: Uint8Array; type: string }
}

const ok = (body: unknown): Reply => ({ status: 200, body })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

/**
 * The sentence this app says when it has not been told where to look.
 *
 * One string, used by the page, by `/api/papers` and by every MCP tool, because
 * a person reading it in a terminal and a person reading it in a pane are
 * looking at the same problem and should be given the same instruction. It says
 * what to set rather than that something is unset: "no papers directory" is a
 * fact somebody can do nothing with.
 */
const UNCONFIGURED =
  'This app has not been told where the papers are. Set KEHIKKO_PAPERS_DIR to the directory holding one ' +
  'folder per epic, or KEHIKKO_ROADMAP_DIR to a roadmap checkout. For a single document that is not part of ' +
  'a roadmap — a thesis, with its own main.tex at the top of its own repository — set KEHIKKO_THESIS_DIR to ' +
  'that directory instead, or as well. Then restart it.'

/* ------------------------------------------------------------------ *
 * The MCP door
 * ------------------------------------------------------------------ */

interface ToolCall {
  (args: Record<string, unknown>): string
}

/**
 * Where this process may read, as one question with one answer.
 *
 * There are two roots now — the papers directory and, optionally, one thesis —
 * and every door below needs both. Asking separately in seven places is how one
 * door ends up handling one root and not the other, and that failure is not a
 * crash: it is a tool answering "nobody has told me where to look" while the
 * page beside it is showing the paper. `configured` is the disjunction for
 * exactly that reason — somebody who set only `KEHIKKO_THESIS_DIR` has
 * configured this app perfectly well.
 */
function where(): { dir: string | null; thesis: PaperRoot | null; configured: boolean } {
  const dir = papersDir()
  const thesis = thesisRoot()
  return { dir, thesis, configured: dir !== null || thesis !== null }
}

/** The places this process is reading from, for a sentence in a refusal. */
function places(w: { dir: string | null; thesis: PaperRoot | null }): string {
  return [w.dir, w.thesis?.dir].filter(Boolean).join(' and ') || 'nowhere'
}

/**
 * What an agent can do to the papers, which is read them.
 *
 * Three tools and no fourth. The program this was extracted from had eleven,
 * and seven of those wrote: `apply_edit`, `revert_edit`, the work queue, the
 * notice thread. They are not here, and the omission is the point of the
 * extraction rather than an unfinished part of it — an agent editing a paper
 * should be editing the `.tex` file with the tools it already has, in a
 * repository with a history, not through an HTTP door that keeps its own undo
 * table because "there is no git in the thesis directory". There is git in this
 * one.
 *
 * `read_source` exists alongside `read_paper` because the two answer different
 * questions and collapsing them would make one of the answers a lie. Prose is
 * what the paper SAYS; source is what an agent has to see before it changes a
 * sentence, since the rendering deliberately drops `\label`, collapses the
 * preamble and expands the paper's own macros. An agent handed only the prose
 * and asked to edit would be guessing at markup it had never been shown.
 */
const TOOLS: Record<string, { description: string; schema: object; run: ToolCall }> = {
  list_papers: {
    description:
      'Every epic on this machine that has a paper, with the title the paper gives itself and how many .tex ' +
      'files it is assembled from. Start here — an epic with no paper is simply absent from this list, which ' +
      'is not the same as an epic that does not exist.',
    schema: { type: 'object', properties: {} },
    run() {
      const w = where()
      if (!w.configured) return UNCONFIGURED
      const all = listPapers(w.dir, w.thesis)
      if (!all.length) return `No papers under ${places(w)}.`
      return all.map((p) => `${p.epic}\t${p.files} file(s)\t${p.title ?? '(no \\title)'}`).join('\n')
    },
  },

  read_paper: {
    description:
      'One epic\'s paper as prose, in reading order, with its \\include chapters folded in where they belong. ' +
      'Headings are marked with the number of hashes matching their depth. This is what a reader sees; it is ' +
      'NOT the source, and the markup that was dropped to produce it cannot be recovered from it. Use ' +
      'read_source before editing.',
    schema: {
      type: 'object',
      properties: { epic: { type: 'string', description: 'e.g. modes-are-modules' } },
      required: ['epic'],
    },
    run(args) {
      const epic = str(args.epic, MAX_SLUG)
      if (!isEpic(epic)) return 'that is not an epic name'
      const w = where()
      if (!w.configured) return UNCONFIGURED
      const paper = readPaper(epic, w.dir, w.thesis)
      if (!paper) {
        const known = listPapers(w.dir, w.thesis).map((p) => p.epic).join(', ')
        return `no paper for "${epic}" here. Known: ${known}`
      }
      const lines: string[] = [`# ${paper.title ?? paper.epic}`, '']
      for (const block of paper.blocks) {
        if (block.kind === 'heading') {
          lines.push('', `${'#'.repeat(Math.min(6, block.level + 1))} ${text(block.segments)}`, '')
        } else if (block.kind === 'paragraph') {
          lines.push(text(block.segments))
        } else if (block.kind === 'list') {
          for (const item of block.items) lines.push(`  - ${text(item)}`)
        } else if (block.kind === 'equation') {
          lines.push(`    ${block.latex}`)
        } else if (block.kind === 'verbatim') {
          lines.push('```', block.raw, '```')
        } else if (block.kind === 'table') {
          lines.push(`[table${block.label ? ` ${block.label}` : ''}] ${text(block.caption)}`)
        } else if (block.kind === 'figure') {
          lines.push(`[figure ${block.graphics.join(', ')}] ${text(block.caption)}`)
        }
        /* comment, preamble, structure and unknown blocks are left out on
           purpose. They are real source and they are not the argument, and an
           agent asked to summarise a paper should not have to skip past a
           `fontspec` invocation to find the first sentence. `read_source` is
           where every byte is available. */
      }
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    },
  },

  read_source: {
    description:
      'The raw .tex of one file of one paper, exactly as it is on disk. The file must be one the paper itself ' +
      'names — main.tex, or something it \\includes — so this cannot be used to read a scratch file lying ' +
      'beside the paper. Read this before proposing an edit; the prose view drops \\label, folds the preamble ' +
      'away and expands the paper\'s own macros.',
    schema: {
      type: 'object',
      properties: {
        epic: { type: 'string' },
        file: { type: 'string', description: 'e.g. main.tex or chapters/wire.tex. Defaults to main.tex.' },
      },
      required: ['epic'],
    },
    run(args) {
      const epic = str(args.epic, MAX_SLUG)
      if (!isEpic(epic)) return 'that is not an epic name'
      const w = where()
      if (!w.configured) return UNCONFIGURED
      const paper = readPaper(epic, w.dir, w.thesis)
      if (!paper) return `no paper for "${epic}" here`
      const file = str(args.file, MAX_PATH) || 'main.tex'
      const source = readSource(epic, file, w.dir, w.thesis)
      if (source === null) {
        return `"${epic}" does not name a file called "${file}". It is made of: ${paper.files.join(', ')}`
      }
      return source
    },
  },
}

/** Rendered text of a run of segments, as one line. */
function text(segments: { text: string }[]): string {
  return segments
    .map((s) => s.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

function mcp(rpc: Rpc): Reply {
  const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: rpc.id ?? null, result })

  if (rpc.method === 'initialize') {
    return reply({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: ID, version: VERSION },
      instructions:
        'The papers the epics in this roadmap are aimed at: LaTeX on disk, read as prose. This server reads ' +
        'files and writes none — there is deliberately no edit tool, because a paper lives in a repository ' +
        'with a history and should be edited there. It reads no tracker and holds no credential, so nothing ' +
        'here can tell you whether the work a paper cites has landed.',
    })
  }
  /* A notification carries no id and is answered with nothing. */
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) {
    return { status: 202, body: null }
  }

  if (rpc.method === 'tools/list') {
    return reply({
      tools: Object.keys(TOOLS).map((name) => ({
        name,
        description: TOOLS[name]!.description,
        inputSchema: TOOLS[name]!.schema,
      })),
    })
  }

  if (rpc.method === 'tools/call') {
    const name = String(rpc.params?.name ?? '')
    /* `hasOwn`, because `name` is a string the caller chose and a bare lookup
       finds `constructor` on the prototype of any plain object — after which
       `.run(args)` is a TypeError thrown out of a request handler rather than
       an answer saying there is no such tool. */
    if (!Object.hasOwn(TOOLS, name)) {
      const shown = name.length > 60 ? `${name.slice(0, 60)}…` : name
      return reply({ content: [{ type: 'text', text: `no tool "${shown}" here` }], isError: true })
    }
    const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>
    try {
      return reply({ content: [{ type: 'text', text: TOOLS[name]!.run(args) }] })
    } catch (e) {
      return reply({
        content: [{ type: 'text', text: `that could not be read: ${(e as Error).message}` }],
        isError: true,
      })
    }
  }

  return {
    status: 404,
    body: { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: String(rpc.method) } },
  }
}

/**
 * Every door but the page, as one function.
 *
 * `null` means "this path is not ours", and the caller passes it on to Vite —
 * which is how the page, the client module and Vite's own hot-reload socket
 * keep working without being enumerated here.
 */
export function answer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): Reply | null {
  if (path === '/healthz') return ok({ ok: true, id: ID, version: VERSION })

  if (path === '/mcp') {
    if (method !== 'POST') return bad('the MCP door takes POST', 405)
    if (!body || typeof body.method !== 'string') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    }
    return mcp(body as Rpc)
  }

  if (path === '/api/papers' && method === 'GET') {
    const dir = papersDir()
    /*
     * `configured` and `papers` are separate fields rather than one empty list,
     * because "there are no papers here" and "nobody has said where to look"
     * are two different sentences and the page shows different screens for
     * them. Collapsing them is the exact failure the host's own holdings code
     * is written to avoid: an app that says "no epics" and quietly means "I was
     * not configured" has told somebody the opposite of the truth.
     */
    const thesis = thesisRoot()
    /*
     * `configured` is true if EITHER root was named, not only the first.
     *
     * The second root made this a real bug rather than a nicety: somebody with
     * only `KEHIKKO_THESIS_DIR` set has configured this app perfectly well, and
     * a `configured: false` beside a non-empty `papers` list would put the
     * page's "nobody has told me where to look" screen in front of a reader
     * whose thesis is sitting right there in the list. `dir` stays exactly what
     * it was — the papers directory or null — because the page prints it in the
     * unconfigured screen, and inventing a directory there would be worse than
     * printing none.
     */
    return ok({
      ok: true,
      configured: dir !== null || thesis !== null,
      dir,
      thesis: thesis?.dir ?? null,
      papers: listPapers(dir, thesis),
    })
  }

  if (path === '/api/paper' && method === 'GET') {
    const epic = str(query.get('epic'), MAX_SLUG)
    /* Refused the same way whether or not the paper exists. A refusal that
       distinguished "no such paper" from "not an epic name" would be a way to
       enumerate what is on this disk. */
    if (!isEpic(epic)) return bad('that is not an epic name')
    const w = where()
    if (!w.configured) return { status: 503, body: { ok: false, error: UNCONFIGURED, configured: false } }
    const paper = readPaper(epic, w.dir, w.thesis)
    if (!paper) return bad(`no paper for "${epic}" under ${places(w)}`, 404)
    return ok({ ok: true, paper })
  }

  if (path === '/api/figure' && method === 'GET') {
    /*
     * The only door here that answers with something other than JSON, and the
     * only one that reads a file the paper did not `\\include`.
     *
     * The reading view used to draw a dashed box with a filename in it for
     * every figure, and the comment explaining why said serving the image would
     * mean "a door that reads arbitrary files out of somebody else's tree and
     * answers them with a guessed content type". That is the right objection
     * and it is answered rather than overruled: the file must be one the paper
     * itself named (`Paper.figures`), the type is a constant looked up by
     * extension in `store.ts` rather than guessed, SVG and PDF are refused
     * outright, and `confine` still stands underneath all three.
     *
     * `nosniff` and a `default-src 'none'` policy ride along because a browser
     * that decides for itself what these bytes are would undo the third check
     * on its own.
     */
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const file = str(query.get('file'), MAX_PATH)
    if (!file) return bad('which figure')
    const figure = readFigure(epic, file)
    /* One refusal for "no such paper", "the paper does not name that file" and
       "this app will not serve that kind of file", for the reason every other
       refusal here is undifferentiated: a reply that distinguished them would
       report what is on this disk. */
    if (!figure) return bad('that paper does not name a figure by that name', 404)
    return { status: 200, body: null, binary: figure }
  }

  if (path === '/api/source' && method === 'GET') {
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const file = str(query.get('file'), MAX_PATH) || 'main.tex'
    const w = where()
    const source = readSource(epic, file, w.dir, w.thesis)
    if (source === null) return bad('that paper does not name a file by that name', 404)
    return ok({ ok: true, epic, file, source })
  }

  /* An unknown path under `/api/` is ours to refuse rather than Vite's to try
     and serve as a source file. Anything else is not ours at all. */
  if (path.startsWith('/api/')) return bad('not here', 404)
  return null
}

export { MANIFEST }
