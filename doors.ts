import { ID, MANIFEST, VERSION } from './manifest.ts'
import {
  MAIN,
  PAPERS_AT,
  isEpic,
  keepsPapers,
  listPapers,
  projectOf,
  readFigure,
  readPaper,
  readSource,
  startPaper,
  whereItWouldGo,
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
 *
 * ## Every door here now names a project, and none of them defaults one
 *
 * A paper lives in the project it is about, at
 * `<project>/.kehikot/paper/<epic>/`, so "which paper" is not answerable
 * without "whose". Every read takes a `project` and
 * nothing here supplies a default. The available defaults are each wrong in a
 * way that is silent: `process.cwd()` is THIS MODULE's directory; "the only
 * project that has papers" is right until there are two; a compiled-in path is
 * the line that made the program this was extracted from one person's app. The
 * environment variables this replaces were a fourth, and their failure was
 * measured rather than imagined — see the essay at the head of `store.ts`.
 *
 * The page is told which project by the host, in `roadmap.context.projectPath`,
 * and sends it with every request. An unframed page carries `?project=` in its
 * own URL, beside the `?epic=` it already had. An agent over MCP is told
 * nothing and must say, and is refused with a sentence when it does not. From
 * this file's side all three are a string in a request and none of them is
 * trusted further than `projectOf` will resolve it. This is the argument
 * Journeys makes at the head of its own `doors.ts`, and the reason it is
 * repeated verbatim in shape is that a second module quietly reaching a
 * different conclusion is how a convention stops being one.
 *
 * The widening is worth saying out loud: this door used to read one directory
 * an operator had named in the environment, and now reads a directory named in
 * a request. That is the same posture every other module in this family already
 * has, and the fence around it is the same one — loopback, plus the fact that
 * nothing is a root unless it holds a `main.tex` where a project's own layout
 * or its own pointer file says one is. Pointing this at somebody's home
 * directory yields nothing, because a home directory is not a paper.
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
/** As long as a path may be, matching the protocol's own `LIMITS.PATH`. */
const MAX_PROJECT = 4096

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
 * The sentence this app says when nobody has said which project.
 *
 * One string, used by the page, by `/api/papers` and by every MCP tool, because
 * a person reading it in a terminal and a person reading it in a container are
 * looking at the same problem and should be given the same instruction. It says
 * what to do rather than that something is missing: "no project" is a fact
 * somebody can do nothing with.
 *
 * It replaced a sentence naming three environment variables, and the change is
 * the whole of this pass in one paragraph — where a paper is is a fact about a
 * project, not about a shell.
 */
const NOWHERE =
  'No project is open, so there is nowhere to look for a paper. A paper lives in the project it is about: ' +
  '.kehikot/paper/<epic>/main.tex, in the project the canvas is standing in. Open a ' +
  'project on the canvas, or pass one — `project` on the MCP door, `?project=` in this page’s own URL.'

/**
 * What to say about a project that is open and holds no paper for an epic.
 *
 * Two different sentences, because they are two different things to do next.
 * A project with a `.kehikot/paper/` in it is one this app understands and
 * simply has no paper for THIS epic — write one, or accept that this epic is
 * not about a paper. A project without that folder has never held a paper at
 * all, and the answer is where papers go rather than which file is missing.
 *
 * The distinction is the same one `/api/papers` has always drawn between "there
 * are no papers here" and "nobody said where to look": an app that offers one
 * sentence for both has told somebody the opposite of the truth half the time.
 */
function noPaper(epic: string | null, project: string): string {
  /*
   * Two sentences, and the whole job of having two is that they are different.
   *
   * A project that keeps papers and has none for this epic is one situation; a
   * project that has never held a paper at all is another, and what a person
   * does next is different in each. The bug worth remembering is not that the
   * sentences were wrong, it is that `keepsPapers` used to answer for the wrong
   * folder — it asked whether `.kehikot/` existed, which it does in any project
   * where another module has ever saved anything — so a project with no papers
   * got the sentence written for a project with papers.
   *
   * It is written for a person reading it in a container. This is not a log
   * line: it goes on screen, under a heading, in the space the paper would have
   * been, and it was previously terse enough to read as one — which is what
   * `no paper for "tables-declare-themselves" in /Users/…/hippos-portal` is.
   */
  if (keepsPapers(project)) {
    return epic === null
      ? 'This project keeps papers, but has none in it yet.'
      : `This project has no paper for “${epic}”. There is no folder of that name under ` +
        `${PAPERS_AT}/, or the folder is there and has no ${MAIN} in it.`
  }
  return (
    `This project keeps no papers. A paper lives in ${PAPERS_AT}/<epic>/${MAIN}, beside ` +
    'whatever else this project keeps for its modules — so a project has papers once there is a folder there ' +
    'with a document in it, and needs nothing configured to say so.'
  )
}

/**
 * The project a caller named, resolved — or a refusal saying to name one.
 *
 * Refused rather than defaulted, for the reasons at the head of this file. The
 * two failures are answered with the same sentence on purpose: "you did not say
 * which project" and "the project you named is not a folder on this machine"
 * are distinguishable by a caller who can already look at the disk, and this
 * door will not be the thing that tells them which of two paths exists.
 */
function projectArg(value: unknown): { project: string } | { error: string } {
  const project = projectOf(str(value, MAX_PROJECT))
  return project === null ? { error: NOWHERE } : { project }
}

/* ------------------------------------------------------------------ *
 * The MCP door
 * ------------------------------------------------------------------ */

interface ToolCall {
  (args: Record<string, unknown>): string
}

/**
 * The `project` argument, spelled once for all three tools.
 *
 * It is required on every one of them, and the description says what a host
 * would put in `roadmap.context.projectPath` because that is the string an
 * agent is most likely to be able to find. A tool whose project were optional
 * would be a tool with a default, and the head of this file is about why there
 * is no default that is not silently wrong.
 */
const PROJECT_ARG = {
  type: 'string',
  description: 'Absolute path of the project folder — the same path a host puts in roadmap.context.projectPath',
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
      'Every epic in one project that has a paper, with the title the paper gives itself and how many .tex ' +
      'files it is assembled from. Start here — an epic with no paper is simply absent from this list, which ' +
      'is not the same as an epic that does not exist. Papers are per project: this lists the one you name and ' +
      'has no way to ask about any other.',
    schema: { type: 'object', properties: { project: PROJECT_ARG }, required: ['project'] },
    run(args) {
      const named = projectArg(args.project)
      if ('error' in named) return named.error
      const all = listPapers(named.project)
      if (!all.length) return noPaper(null, named.project)
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
      properties: { project: PROJECT_ARG, epic: { type: 'string', description: 'e.g. modes-are-modules' } },
      required: ['project', 'epic'],
    },
    run(args) {
      const epic = str(args.epic, MAX_SLUG)
      if (!isEpic(epic)) return 'that is not an epic name'
      const named = projectArg(args.project)
      if ('error' in named) return named.error
      const paper = readPaper(epic, named.project)
      if (!paper) {
        const known = listPapers(named.project).map((p) => p.epic).join(', ')
        return known ? `no paper for "${epic}" there. Known: ${known}` : noPaper(epic, named.project)
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
        project: PROJECT_ARG,
        epic: { type: 'string' },
        file: { type: 'string', description: 'e.g. main.tex or chapters/wire.tex. Defaults to main.tex.' },
      },
      required: ['project', 'epic'],
    },
    run(args) {
      const epic = str(args.epic, MAX_SLUG)
      if (!isEpic(epic)) return 'that is not an epic name'
      const named = projectArg(args.project)
      if ('error' in named) return named.error
      const paper = readPaper(epic, named.project)
      if (!paper) return noPaper(epic, named.project)
      const file = str(args.file, MAX_PATH) || 'main.tex'
      const source = readSource(epic, file, named.project)
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
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    /*
     * Three fields rather than one list, because an empty list is three
     * different sentences and the page draws a different screen for each.
     *
     *  - `project: null` — nobody has said which project. Not a fault: it is
     *    where a page starts before a host greets it, and where an unframed
     *    page stays until somebody puts `?project=` in the URL.
     *  - `project` set, `keeps: false` — the project is open and has never held
     *    a paper: there is no `.kehikot/paper/` in it. The answer is where
     *    papers go, not which file is missing. It asks about that folder and
     *    not about `.kehikot/`, which exists wherever any module has saved
     *    anything and would answer yes for a project with no papers at all.
     *  - `project` set, `keeps: true`, `papers: []` — an ordinary project that
     *    has no papers yet, which is a true and unremarkable thing to say.
     *
     * Collapsing any two of these is the failure the host's own holdings code
     * is written to avoid: an app that says "no papers" and quietly means "I
     * was not told where to look" has told somebody the opposite of the truth.
     *
     * `project` is echoed back RESOLVED rather than as it arrived, because the
     * page prints it, and a page printing the string it sent proves only that
     * it can remember its own arguments. What is useful on screen is the
     * directory this server actually looked in.
     */
    return ok({
      ok: true,
      project,
      keeps: keepsPapers(project),
      papers: listPapers(project),
    })
  }

  if (path === '/api/paper' && method === 'GET') {
    const epic = str(query.get('epic'), MAX_SLUG)
    /* Refused the same way whether or not the paper exists. A refusal that
       distinguished "no such paper" from "not an epic name" would be a way to
       enumerate what is on this disk. */
    if (!isEpic(epic)) return bad('that is not an epic name')
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    /* 409 rather than 404: there is no answer to "is there a paper for this
       epic" until there is a project to have one in. A 404 would be a claim
       about a directory this app has not been shown. Journeys says the same
       thing at the same door, in the same words, for the same reason. */
    if (project === null) return { status: 409, body: { ok: false, error: NOWHERE, project: null } }
    const paper = readPaper(epic, project)
    /* `where` rides along on the refusal, because the next thing anybody wants
       to know is where it would have been — and the page draws a button that
       needs it. It is on the refusal rather than fetched separately so the two
       cannot disagree about which epic they are talking about. */
    if (!paper) return { status: 404, body: { ok: false, error: noPaper(epic, project), where: whereItWouldGo(epic, project) } }
    return ok({ ok: true, paper })
  }

  /*
   * Start a paper for an epic: the one door here that writes.
   *
   * A POST because it makes something, and the only body it takes is the epic
   * and the project — there is no content to send. What gets written is in
   * `startPaper`, along with why it refuses rather than overwrites and why this
   * module having exactly one writer is worth saying out loud.
   *
   * The refusal is a 409 and not a 400: "there is already something there" is
   * not a malformed request, it is a request that arrived second, and a page
   * that had drawn the button before somebody else made the folder is the
   * ordinary way to get here.
   */
  if (path === '/api/paper' && method === 'POST') {
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    if (project === null) return { status: 409, body: { ok: false, error: NOWHERE, project: null } }
    const started = startPaper(epic, project)
    if (!started.ok) return bad(started.why, 409)
    return ok({ ok: true, dir: started.dir, paper: readPaper(epic, project) })
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
    /* The project rides on the `<img src>` the reader's browser fetches, the
       same as on every other read. It has to: a figure is confined to its
       paper's root and there is no root without a project. This is the door
       that used to work with no project at all — because there was a directory
       in the environment — and the one where forgetting to pass it would look
       like every image in a paper being broken. */
    const figure = readFigure(epic, file, projectOf(str(query.get('project'), MAX_PROJECT)))
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
    const source = readSource(epic, file, projectOf(str(query.get('project'), MAX_PROJECT)))
    if (source === null) return bad('that paper does not name a file by that name', 404)
    return ok({ ok: true, epic, file, source })
  }

  /* An unknown path under `/api/` is ours to refuse rather than Vite's to try
     and serve as a source file. Anything else is not ours at all. */
  if (path.startsWith('/api/')) return bad('not here', 404)
  return null
}

export { MANIFEST }
