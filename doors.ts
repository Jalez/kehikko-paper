import { randomUUID } from 'node:crypto'

import { acceptMessage, commitPaper, saveMessage, standing, type Committed, type Standing } from './git.ts'
import { MAX_EDIT_BYTES, sourceRefuses, whyNot } from './latex/edit.ts'
import { propose, droppedBecause } from './latex/propose.ts'
import { ID, MANIFEST, VERSION } from './manifest.ts'
import { drop, keep, lostBecause, pendingFor, proposalById, rebaseAll, remeasure } from './proposals.ts'
import {
  MAIN,
  PAPERS_AT,
  hashesOf,
  isEpic,
  keepsPapers,
  listPapers,
  paperRoot,
  projectOf,
  readFigure,
  readPaper,
  readSource,
  startPaper,
  whereItWouldGo,
  writeRange,
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
 * ## There are two write paths here now, and that is the headline
 *
 * This file used to open by saying there were none. The paragraph is kept
 * rather than deleted, because the shape it refused is the shape that must not
 * come back. The program this was extracted from had `POST /api/edits`: it
 * wrote to the author's thesis on disk, guarded by an `expectedText` match — a
 * good guard — and sat behind `app.use(cors())` with no options at all. That is
 * a wide-open cross-origin policy in front of a path that mutates somebody's
 * writing: any page in any tab, on any site, could read that origin and post to
 * it.
 *
 * That paragraph then said what a write path would have to arrive with if one
 * were ever wanted — "accepting a correction to a paragraph, say". This is that
 * day: a reader can now correct a sentence in the paper they are reading, in
 * place. So here is the list it named, kept as a list because it was written as
 * a condition rather than as an aspiration:
 *
 *  - **A ticket minted per process and printed into the page.** `TICKET`,
 *    below; `page/document.ts` puts it in the document; both write doors demand
 *    it in the body. It separates "this app's own page" from "something else on
 *    this machine that guessed the port", and it separates NOTHING else. It is
 *    not an authorization check, anybody who can read the page can read the
 *    ticket, and it is worth nothing at all the moment this origin becomes
 *    readable cross-origin — which is the next point.
 *  - **`storage: true` kept, so the ticket is not readable cross-origin.**
 *    There is still no `server.cors` line in `vite.config.ts` and the manifest
 *    still declares storage, so the page keeps a real origin and its own `/api`
 *    calls are ordinary same-origin requests involving no CORS at all. Journeys
 *    demonstrated the alternative rather than arguing it: `curl -H 'Origin:
 *    https://evil.example'` against a permissive origin printed its ticket
 *    straight out of the page. This app now has a ticket, so it now has that to
 *    lose.
 *  - **A guard on the CONTENT of the write and not only on the caller.** The
 *    `expectedText` match is not carried over as such, and what replaced it is
 *    stronger: a hash of the whole file as the caller last read it, refused
 *    when it no longer matches. The argument is in `writeRange` — an edit ABOVE
 *    a range makes that range name different text, and a quote check cannot see
 *    that.
 *
 * The reads are unchanged and stay ungated, for the reason below. What is gated
 * is exactly the four doors that write: `POST /api/paper`, which starts a paper
 * where there is none, `POST /api/edit`, which replaces bytes in one that is
 * already there, `POST /api/proposal`, which answers a change somebody has
 * suggested — accepting one goes through the same `writeRange` as an edit, so
 * that door adds a decision rather than a way of writing — and `POST /api/save`,
 * which writes no bytes at all and commits the ones already there.
 *
 * ## And there is a fourth thing this file can now do to a person's machine
 *
 * It can make a git commit, in a repository this program does not own. That is
 * a bigger change than the feature sounds, and the whole of the care is in
 * `git.ts`: it commits by PATH and never the index, so what somebody else had
 * staged cannot be swept into a commit made because they accepted a typo fix;
 * it refuses, with a sentence naming what to do, rather than guessing; and it
 * never pushes, never branches, never amends, and never touches a second
 * repository. The bytes are on disk before any of it runs, so a commit that
 * fails can lose nothing.
 *
 * ## There is a tool on the MCP door that is not a read now, and it writes nothing
 *
 * `propose_edit` files a change an agent thinks ought to happen. It changes what
 * this PROCESS is holding and it does not touch a `.tex`: the paper is untouched
 * until a person looking at the change in the prose presses Accept, and Accept
 * is `POST /api/proposal`, which demands the ticket. The MCP door emits no
 * ticket and has no tool that returns one, so the two are separated by different
 * keys rather than by a flag.
 *
 * The limit of that is stated where the door is, and is worth repeating here
 * because this is the file's summary: it is not a fence between a person and an
 * agent. An agent with a shell on this machine can read the ticket out of `/app`
 * — or skip all of this and edit the file with `sed`. What it is is a guarantee
 * about the door this module OFFERS: an agent following it cannot change a paper
 * behind the back of the person reading it.
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
/**
 * As much text as one edit may carry, in UTF-16 units.
 *
 * `MAX_EDIT_BYTES` is the real bound and it is measured in bytes by `whyNot`,
 * one layer down. This is the cruder cut applied before the string is looked at
 * at all, in the same spirit as every other constant here: a string has a
 * length before it has a meaning. It is deliberately generous against the byte
 * bound rather than equal to it, so that the sentence somebody reads about an
 * over-long edit is the one written for that, and not a silent truncation.
 */
const MAX_TEXT = MAX_EDIT_BYTES

/**
 * As long as the sentence beside a suggested change may be.
 *
 * It is drawn in a floating control over a paper that is read at 220 pixels, so
 * the real constraint is not memory — it is that anything longer than this is
 * not a sentence, and a paragraph of reasoning covering the paragraph it is
 * about is worse than no reasoning at all. Clipped rather than refused, unlike
 * the text of the edit itself: a clipped explanation is still the explanation,
 * while a clipped replacement is a DIFFERENT replacement, silently.
 */
const MAX_WHY = 240

/**
 * The write ticket, minted once per process.
 *
 * ## What it is for, and the much longer list of what it is not
 *
 * It says "this request came from the page this process served". That is all.
 * It is printed into the document by `page/document.ts`, so anything that can
 * READ the page can read it, and it therefore proves nothing about who the
 * person at the keyboard is, what they are allowed to change, or whether they
 * meant it. Journeys mints one and is careful to write the same sentence beside
 * it, and the sentence is worth repeating rather than referring to, because a
 * ticket is exactly the kind of thing a later reader assumes is an
 * authorization check.
 *
 * What it actually excludes is narrow and real: this server listens on
 * loopback, which is a fence around the MACHINE and not around the programs on
 * it, so any process here can find the port and post to it. Reads are ungated
 * on purpose — a paper is a document its author is publishing — but a write is
 * different in kind, and something that guessed 7870 should not be able to
 * rewrite a thesis by accident.
 *
 * It is only worth having while this origin is unreadable from other pages,
 * which is what `storage: true` and the absent `server.cors` line buy. See the
 * head of this file.
 *
 * Per process, and never written down. A ticket in a file is a ticket that
 * outlives the process that minted it and can be replayed against the next one.
 */
export const TICKET = randomUUID()

/**
 * Whether a body carried this process's ticket.
 *
 * Compared as a plain string. A timing-safe compare would be the reflex, and it
 * would be theatre here: the caller is a process on this machine that can read
 * the page and simply take the ticket, so there is no secret to extract one
 * byte at a time.
 */
function ticketed(body: Record<string, unknown> | null): boolean {
  return typeof body?.ticket === 'string' && body.ticket === TICKET
}

/**
 * What to say when it did not.
 *
 * A 403 and a sentence naming what is missing rather than a bare refusal,
 * because the caller who hits this is almost always a person's own script or a
 * page served by a stale process — and "no ticket" is a thing they can act on,
 * unlike "forbidden".
 */
const NO_TICKET =
  'A write here has to carry this process’s ticket, which is printed into the page it serves. Reload the page — '
  + 'a ticket from an earlier run of this server is not this one.'

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
  `${PAPERS_AT}/<epic>/${MAIN}, in the project the canvas is standing in. Open a ` +
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
/**
 * What to tell the reader about a commit that was attempted, in one sentence.
 *
 * Empty for the ordinary case where a commit was made and nothing needs saying
 * — no, deliberately NOT empty: it says the short sha. A change that quietly
 * enters somebody's git history without the page saying so is the shape of
 * surprise this whole feature has to avoid, and `git log` afterwards should
 * never be the first a person hears of a commit made in their repository.
 *
 * `clean` is silent on the accept path only because it cannot happen there —
 * `writeRange` refuses an edit that changes nothing — and says so on the Save
 * path, where pressing a button with nothing to save is an ordinary thing to
 * do and deserves an answer rather than a button that appears not to work.
 */
function aboutCommit(made: Committed | Standing): string {
  if (made.at === 'committed') return made.sha ? `Committed as ${made.sha}.` : 'Committed.'
  if (made.at === 'clean') return 'Nothing has changed since the last commit.'
  /* Silent, and that is the point of the state existing — see `Standing`. A
     paper in a plain folder is not a paper with a problem. */
  if (made.at === 'nogit') return ''
  if (made.at === 'ready') return ''
  return made.why
}

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
  if (epic === null) {
    return keepsPapers(project)
      ? 'This project keeps papers, and has none in it yet.'
      : 'This project keeps no papers yet.'
  }
  /* One sentence, because the answer to "why not" is a PATH and the path is
     `where` on this refusal. It used to be a paragraph explaining the
     convention — where papers live, that nothing needs configuring — which is
     the wrong answer to the question somebody is asking, and it read as prose
     in the space a paper would have been. */
  return `This epic has no paper yet. There is no ${MAIN} where one would go.`
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

  /**
   * Suggest a change to the prose, for the person reading the paper to answer.
   *
   * ## This is the only tool here that is not a read, and it still writes nothing
   *
   * The distinction is the whole feature. Nothing on this door can change a
   * `.tex` file. This one files a suggestion in the server's memory; the paper
   * on disk is untouched, and stays untouched until a person looks at the
   * change drawn into the prose they are reading and presses Accept. There is
   * no tool here that presses it, and there is no argument to this one that
   * skips it — see the essay on `/api/proposal`, which is where applying
   * happens and which demands a ticket this door never emits.
   *
   * ## Text rather than byte offsets, and that is not a convenience
   *
   * See `propose` in `latex/propose.ts`. The short version: an agent counting
   * UTF-8 bytes by hand to name a range is an agent whose off-by-four does not
   * fail — it splices a correction into the middle of the wrong word and passes
   * every check this door makes, because the range is real and holds no markup.
   * Naming the text moves the counting to the side that holds the bytes.
   *
   * ## What it refuses, and the rule that is STRICTER here than at the door
   *
   * `whyNot` on what would go there, which is the same function the typed
   * correction runs, for the same reasons — and applied at PROPOSE time rather
   * than at accept time, because a suggestion that could never be applied is
   * not worth putting in front of somebody, and refusing it now tells the agent
   * about it while it is still holding the context.
   *
   * `sourceRefuses` on the whole of `find`, and this is the part that is
   * deliberately stricter than `writeRange`'s version of the same check. The
   * write path applies it to the bytes actually being replaced, which is the
   * right rule there. Here the range is NARROWED before it is stored, and the
   * two come apart in a way that is easy to miss and was caught by a test:
   * `\autocite{jones}` becoming `\autocite{smith}` narrows to `jones` becoming
   * `smith`, and neither of those holds a LaTeX special. The bytes are safe to
   * write. The proposal is still wrong to accept, for a reason that has nothing
   * to do with safety — those five characters render as part of `[jones]`, so
   * `renderedRange` cannot honestly draw a change to them, and a suggestion this
   * page cannot draw is a suggestion sitting in a list that the person is being
   * asked to approve without seeing. The whole promise of this feature is that
   * you look at the change before you answer it.
   *
   * So the rule is about the window the agent QUOTED and not only about the
   * bytes it resolved to: name prose, and the narrowed range inside it is prose
   * too. It over-refuses in one shape — `50\% escape` becoming `90\% escape`
   * narrows to `5` becoming `9`, which is perfectly drawable — and the cost of
   * that is one sentence to the agent telling it to quote `a 50` instead. That
   * is a better trade than a rule with an exception in it.
   *
   * The consequence worth naming is that this door cannot touch a citation, a
   * reference, an escape or a comment. Changing one of those means editing the
   * `.tex` with the tools you already have, which is what this module has
   * always said and still says.
   */
  propose_edit: {
    description:
      'Suggest a change to one sentence of a paper, for the person reading it to accept or reject. This does NOT '
      + 'edit the file: it puts the change in front of the reader, drawn into the prose in green and red where it '
      + 'happens, with Accept and Reject beside it. Name the text to replace rather than a byte range, and give '
      + 'enough of it to be unique in the file — the exact text, as read_source shows it, including the line break '
      + 'if it wraps. Prose only, and this is checked against the text you quote rather than only the part that '
      + 'differs: if find or replace contains any of \\ { } $ & # ^ _ ~ %, it is refused. So quote around a '
      + 'citation or an escape rather than across one — "a 50" rather than "50\\% of" — and edit the .tex '
      + 'directly to change markup, a citation, a heading or the structure of the document.',
    schema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        epic: { type: 'string', description: 'e.g. modes-are-modules' },
        file: { type: 'string', description: 'e.g. main.tex or chapters/wire.tex. Defaults to main.tex.' },
        find: { type: 'string', description: 'The exact text to replace. Must appear exactly once in that file.' },
        replace: { type: 'string', description: 'What goes there. Empty deletes it.' },
        why: { type: 'string', description: 'One sentence the reader sees beside the change, saying why.' },
      },
      required: ['project', 'epic', 'find', 'replace', 'why'],
    },
    run(args) {
      const epic = str(args.epic, MAX_SLUG)
      if (!isEpic(epic)) return 'that is not an epic name'
      const named = projectArg(args.project)
      if ('error' in named) return named.error
      const paper = readPaper(epic, named.project)
      if (!paper) return noPaper(epic, named.project)
      const file = str(args.file, MAX_PATH) || MAIN
      const source = readSource(epic, file, named.project)
      if (source === null) {
        return `"${epic}" does not name a file called "${file}". It is made of: ${paper.files.join(', ')}`
      }
      const was = paper.hashes[file]
      /* Unreachable while `readSource` and `readPaper` agree about which files
         a paper has, and checked because the alternative to a hash is a
         proposal that can never be applied — the door would answer it as
         staleness, which is a true sentence about the wrong problem. */
      if (!was) return `This program could not measure ${file}, so a suggestion about it could not be filed.`

      /* Not trimmed. `str` trims, and a proposal about text ending in a space —
         which is most of them, because prose is words separated by spaces — has
         to name that space or it names something else. This is the one place in
         this file where the caller's whitespace is load-bearing. */
      const find = typeof args.find === 'string' ? args.find.slice(0, MAX_TEXT) : ''
      const replace = typeof args.replace === 'string' ? args.replace.slice(0, MAX_TEXT) : ''
      const why = str(args.why, MAX_WHY)
      if (!why) return 'A suggestion has to say why, in a sentence. The reader sees it beside the change.'

      /* The quoted window, not the narrowed range. See the essay above: the
         narrowed range inside `\autocite{jones}` is the five letters `jones`,
         which hold no special character and are still not a thing this page
         could draw a change to. */
      const covered = sourceRefuses(find)
      if (covered) return covered
      const refused = whyNot(replace)
      if (refused) return refused

      const worked = propose(source, find, replace)
      if ('why' in worked) return worked.why

      const filed = keep(named.project, epic, {
        file,
        from: worked.from,
        to: worked.to,
        text: worked.text,
        was_text: worked.was_text,
        was,
        why,
        by: 'an agent',
        /* Kept so the suggestion can be measured again if the file changes
           under it before anybody answers — see `refile`. */
        asked: { find, replace },
      })
      if (!filed.ok) return filed.why
      return (
        `Filed as ${filed.proposal.id}. It is drawn into the paper where it happens, in green and red, and `
        + 'nothing is written until the reader accepts it. Nothing on this door can accept it for them.'
      )
    },
  },

  /**
   * What is still waiting, so an agent can tell "not answered yet" from "gone".
   *
   * Without it a proposal is posted into silence: an agent that made three
   * suggestions has no way to learn that two were accepted and one was dropped
   * because it covered the same words as another. That is not a nicety — an
   * agent which cannot see the outcome will re-propose, and re-proposing an
   * accepted change is how a paragraph gets edited twice.
   *
   * It says why each one is there and not what it did to the file, because it
   * has not done anything to the file.
   */
  list_proposals: {
    description:
      'The changes suggested for one paper that the reader has not answered yet. A suggestion that is not here '
      + 'was either accepted, rejected, or dropped because another accepted change rewrote the same words. This '
      + 'server holds them in memory only, so a restart forgets them all.',
    schema: {
      type: 'object',
      properties: { project: PROJECT_ARG, epic: { type: 'string' } },
      required: ['project', 'epic'],
    },
    run(args) {
      const epic = str(args.epic, MAX_SLUG)
      if (!isEpic(epic)) return 'that is not an epic name'
      const named = projectArg(args.project)
      if ('error' in named) return named.error
      const gone = lostBecause(settled(named.project, epic))
      const held = pendingFor(named.project, epic)
      if (!held.length) return gone || 'Nothing is waiting on that paper.'
      /* What was dropped is said first, because an agent reading the list to
         learn "was mine accepted" has to be able to tell dropped from taken. */
      return [...(gone ? [gone] : []), ...held.map((p) => `${p.id}\t${p.file}\t${p.was_text} -> ${p.text}\t${p.why}`)].join(
        '\n',
      )
    },
  },
}

/**
 * The pending list, measured against the disk before it is read.
 *
 * ## Why every reader of the list goes through this
 *
 * `rebaseAll` keeps the list right across writes this process makes. This is
 * the other half: a file rewritten by somebody else — an editor, a merge —
 * leaves every proposal on it carrying a hash the door will refuse, and the
 * only honest thing to hand a page or an agent is a list measured against the
 * file as it now is. `remeasure` does the deciding; this is the wiring that
 * gives it a file's hash and source, read fresh, and only for a file it asks
 * about — a list whose hashes all still match costs no read at all.
 *
 * A read that changes what this process holds is a thing worth pausing on,
 * and it is admitted because what changed is not a record but a MEASUREMENT.
 * Nothing on the disk moves; a suggestion that was already un-acceptable
 * becomes acceptable again where the quoted text still is, and is dropped
 * where it is not. Deferring that to a write door would leave the list wrong
 * for exactly as long as nobody pressed anything, which is the whole time a
 * person spends reading. What it answers is the ones dropped, for the caller
 * to say out loud.
 */
function settled(project: string, epic: string): { file: string; why: string }[] {
  return remeasure(project, epic, (file) => {
    const hash = hashesOf(epic, project)?.[file]
    const source = readSource(epic, file, project)
    return hash && source !== null ? { hash, source } : null
  })
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
        'The papers the epics in this roadmap are aimed at: LaTeX on disk, read as prose. Three tools read and ' +
        'one suggests. There is deliberately no tool that EDITS: propose_edit puts a change in front of the ' +
        'person reading the paper, drawn into the prose where it happens, and the file is untouched until they ' +
        'accept it — nothing on this door can accept it for them, and there is no argument that skips them. ' +
        'Use it for prose a reader is looking at. For markup, structure, a new section or a citation, edit the ' +
        '.tex directly with the tools you already have: a paper lives in a repository with a history, and ' +
        'propose_edit refuses any range holding LaTeX markup anyway. It reads no tracker and holds no ' +
        'credential, so nothing here can tell you whether the work a paper cites has landed.',
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
    /* The ticket, on this door as well as on the edit door. It predates the
       ticket and did without one, which was survivable only because the worst
       it can do is nothing — it refuses rather than overwrites. Both writers
       demanding the same thing is one rule to read instead of two, and a reader
       who found one write gated and the other not would reasonably conclude the
       gate was decorative. */
    if (!ticketed(body)) return bad(NO_TICKET, 403)
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    if (project === null) return { status: 409, body: { ok: false, error: NOWHERE, project: null } }
    const started = startPaper(epic, project)
    if (!started.ok) return bad(started.why, 409)
    return ok({ ok: true, dir: started.dir, paper: readPaper(epic, project) })
  }

  /*
   * Replace one byte range in one file of one paper: the door a reader's
   * correction arrives through.
   *
   * ## Everything that decides anything is in `writeRange`
   *
   * This is a shape check and a ticket check and nothing else. Which file may
   * be written, whether the range is inside it, whether the file has moved
   * since the page read it, whether the text is markup — all of that is one
   * function in `store.ts`, so that the browser, an agent and a test are
   * refused by the same code rather than by three copies of a rule.
   *
   * ## The answer carries the paper, re-read
   *
   * Not a bare `ok`. Every offset the page is holding shifted the moment this
   * wrote, and a page that had to ask for the paper in a second request would
   * spend the gap between the two able to send a second edit against offsets it
   * already knows are wrong. So the write and the re-read are one answer, and
   * they cannot disagree about which paper they are describing. This module
   * caches nothing, so the re-read is just another open of the file — the same
   * property the head of `store.ts` argues for, used for the thing it was for.
   *
   * ## The refusal carries the paper too, when it is a stale one
   *
   * `stale` means the page's copy is out of date, which is the one refusal it
   * has to ACT on rather than report, and the thing it must do is exactly the
   * re-read this door has already performed. Sending it on the refusal is what
   * makes "your edit did not land, and here is what the file says now" one
   * round trip instead of a race between two.
   *
   * A 409 for stale — the request arrived second, which is not malformed — and
   * a 400 for everything else, which is the same distinction `POST /api/paper`
   * draws about a folder that already exists.
   */
  if (path === '/api/edit' && method === 'POST') {
    if (!ticketed(body)) return bad(NO_TICKET, 403)
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    if (project === null) return { status: 409, body: { ok: false, error: NOWHERE, project: null } }

    const file = str(body?.file, MAX_PATH)
    if (!file) return bad('which file')
    /* Numbers only. `str` would happily turn a number into a string here and
       `Number('')` is 0, which is a byte offset — so a missing `from` would
       become "the top of the file" rather than a refusal. */
    const from = typeof body?.from === 'number' ? body.from : NaN
    const to = typeof body?.to === 'number' ? body.to : NaN
    const text = typeof body?.text === 'string' ? body.text.slice(0, MAX_TEXT) : null
    if (text === null) return bad('there is nothing to write there')
    const was = str(body?.was, 200)

    const written = writeRange(epic, { file, from, to, text, was }, project)
    if (!written.ok) {
      return {
        status: written.stale ? 409 : 400,
        body: {
          ok: false,
          error: written.why,
          stale: written.stale,
          paper: written.stale ? readPaper(epic, project) : undefined,
        },
      }
    }
    /* Every pending suggestion is now measured against a file that has moved,
       and this is the arithmetic that moves them with it. It runs on THIS path
       — a person typing a correction — as well as on the accept path, because a
       typo fixed two paragraphs above a pending suggestion shifts its bytes
       just as surely as accepting another suggestion would. See `rebaseAll`. */
    const lost = rebaseAll(project, epic, { file, from, to, text }, written.hash)
    return ok({
      ok: true,
      paper: readPaper(epic, project),
      proposals: pendingFor(project, epic),
      said: droppedBecause(lost),
    })
  }

  /*
   * What has been suggested about this paper and not yet answered.
   *
   * Ungated, like every other read here and for the same reason: a proposal is
   * about a paper anything on loopback can already read in full, so gating this
   * would cost an agent's `curl` a credential in exchange for hiding nothing.
   * What is NOT here is any way to change one — see the door below.
   */
  if (path === '/api/proposals' && method === 'GET') {
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    /* No project is not an error on a read that answers with a list: there is
       nowhere to have filed anything, so the honest answer is that nothing is
       waiting. The page polls this, and a refusal every four seconds while
       nobody has a project open would be a container that looks broken. */
    if (project === null) return ok({ ok: true, proposals: [] })
    /* Measured against the disk first — see `settled` — and what that dropped
       rides along as a sentence, because a suggestion vanishing from a page
       while somebody was deciding about it reads as the page losing it. */
    const said = lostBecause(settled(project, epic))
    return ok({ ok: true, proposals: pendingFor(project, epic), said })
  }

  /*
   * Answer one suggestion: accept it, or reject it.
   *
   * ## This is the door that makes approval mean something
   *
   * `propose_edit` on `/mcp` files a suggestion and cannot apply it. This
   * applies one and cannot be reached from `/mcp` at all: it is HTTP, it is a
   * POST, and it demands this process's ticket, which is minted per run and
   * printed into the page. The MCP door emits no ticket, holds no ticket, and
   * has no tool that returns one — so the separation is not a flag somebody
   * could set, it is two doors with different keys.
   *
   * That is the honest extent of it, and the limit belongs in the code rather
   * than in a README nobody is reading at the moment it matters. The ticket
   * separates "this app's own page" from "something else on this machine that
   * guessed the port". It does not separate a person from an agent: an agent
   * with a shell here can fetch `/app`, read the ticket out of it and post to
   * this door — and could equally have skipped all of it and written to the
   * `.tex` with `sed`. What approval buys is not a fence around the disk. It is
   * that the ONE PATH THIS MODULE OFFERS AN AGENT does not write, so an agent
   * following the door it was given cannot change a paper behind the back of
   * the person reading it.
   *
   * ## Auto-approve is not a setting here, and that is deliberate
   *
   * A reader may tick "apply straight away" beside the Edit checkbox. That tick
   * lives in the page, and when it is on the page answers a new suggestion by
   * calling THIS door immediately — with the ticket, exactly as it would if a
   * finger had pressed Accept. There is no server-side flag for it and no
   * argument on this door meaning "the reader said yes in advance".
   *
   * The reason is that a setting the server held would be a setting the server
   * could be talked into. Anything that can post here could post the flag, and
   * a caller that can post the flag has approved its own change on the reader's
   * behalf. Kept in the page, the only thing that can auto-approve is the page
   * a person is looking at, and the strongest statement available about
   * approval stays true: nothing is written that the ticket-holder did not ask
   * for.
   *
   * ## Accepting is the ordinary write path, not a second one
   *
   * `writeRange` — the same function `/api/edit` calls, with the same hash
   * check, the same `sourceRefuses` and the same atomic rename. A proposal
   * carries the hash of the file it was measured against, so one that has gone
   * stale is refused here exactly as a stale typed correction is, with the
   * paper as it now is sent back on the refusal.
   */
  if (path === '/api/proposal' && method === 'POST') {
    if (!ticketed(body)) return bad(NO_TICKET, 403)
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    if (project === null) return { status: 409, body: { ok: false, error: NOWHERE, project: null } }

    const decision = str(body?.decision, 20)
    const id = str(body?.id, 80)

    /* Rejecting writes nothing, and this is the line that says so: the file is
       never opened. A rejected suggestion leaves the paper byte-identical
       because there is no path from here to a filesystem call at all. */
    if (decision === 'reject') {
      if (!proposalById(project, epic, id)) return bad('There is no suggestion by that name waiting here.', 404)
      drop(project, epic, id)
      return ok({ ok: true, proposals: pendingFor(project, epic) })
    }

    if (decision !== 'accept') return bad('A suggestion is accepted or rejected, and this said neither.')

    const proposal = proposalById(project, epic, id)
    if (!proposal) return bad('There is no suggestion by that name waiting here.', 404)

    const written = writeRange(
      epic,
      { file: proposal.file, from: proposal.from, to: proposal.to, text: proposal.text, was: proposal.was },
      project,
    )
    if (!written.ok) {
      /*
       * A refused suggestion is dropped rather than left greyed out on the page.
       *
       * The alternative was considered: keep it, mark it stale, let the reader
       * see that it existed. It is refused because a suggestion that cannot be
       * applied is not a decision anybody can still make — pressing Accept on
       * it will refuse again, identically, for as long as it sits there, and an
       * affordance that never works in the middle of somebody's paper is worse
       * than an empty space. The reason travels back to the reader in this same
       * answer, and the agent learns of it by `list_proposals` finding it gone.
       */
      drop(project, epic, id)
      return {
        status: written.stale ? 409 : 400,
        body: {
          ok: false,
          error: written.why,
          stale: written.stale,
          paper: readPaper(epic, project),
          proposals: pendingFor(project, epic),
        },
      }
    }
    drop(project, epic, id)
    /*
     * One accepted suggestion is one commit, and it is made HERE — after the
     * bytes are on disk and before anything else.
     *
     * ## The order is the whole of the safety
     *
     * `writeRange` has already renamed the new file over the old one. Whatever
     * git does next, the correction stands: there is no branch below this line
     * that can un-write it, and a refusal is a sentence over a paper that is
     * already right. That is the only ordering in which a program allowed to
     * commit into somebody's repository is safe to write, and it is why the
     * commit is not attempted first and the write made conditional on it.
     *
     * ## Why an accept commits and a typed correction does not
     *
     * They are different acts. Accepting is a discrete decision about somebody
     * else's suggestion — there is a before and an after and a reason, which is
     * exactly a commit — and the reader made it once, deliberately, with a
     * button. Typing is continuous: a reader fixing four typos in a paragraph
     * has made one change to their paper, not four, and a commit per blur would
     * fill their history with a letter each. So typing accumulates and `Save`
     * commits it, which is what a person means by saving a document.
     *
     * `Auto` does not change this. With the tick on the page presses Accept as
     * a finger would, so a suggestion applied unasked is committed unasked —
     * which is more of a reason to record it, not less: the commit is the only
     * place that change is written down as having happened.
     */
    const message = acceptMessage(proposal.file, proposal.why, proposal.by)
    /*
     * ONE FILE, and not the whole paper.
     *
     * A pathspec-mode commit takes the working-tree state of the paths it
     * names, so a commit scoped to the paper's directory would sweep in every
     * other uncommitted change under it — a chapter the author had been editing
     * beside this page — under a subject saying a suggestion was accepted. That
     * is not somebody else's work, because it is still the paper; it is the
     * wrong SENTENCE about it, and this history is the one somebody will read
     * to find out when a change was made and why.
     *
     * So an accept commits the one file the suggestion changed, which is the
     * file the message names. What cannot be separated out is another
     * uncommitted change in THAT file — a per-path commit has no finer grain
     * than a path — and Save, which is scoped to the whole paper, is where the
     * rest belongs.
     */
    const made = commitPaper(paperRoot(epic, project), message.subject, message.body, [proposal.file])
    const lost = rebaseAll(
      project,
      epic,
      { file: proposal.file, from: proposal.from, to: proposal.to, text: proposal.text },
      written.hash,
    )
    return ok({
      ok: true,
      paper: readPaper(epic, project),
      proposals: pendingFor(project, epic),
      /* Two sentences that can both be true — a suggestion was dropped by the
         rebase AND the commit was refused — and the reader needs both. Joined
         rather than one overwriting the other. */
      said: [droppedBecause(lost), aboutCommit(made)].filter((one) => one.length > 0).join(' '),
    })
  }

  /*
   * Commit whatever has changed under this paper: what the Save button presses.
   *
   * ## Save does not write the file, because the file is already written
   *
   * Typing in the reader goes to `/api/edit` on blur or Enter, through the
   * ticketed write path, and lands in the `.tex` immediately. That is not an
   * implementation detail to be tidied away behind a Save button — it is the
   * property the whole module rests on. Nothing here is cached, `readPaper`
   * opens the file every time, and the author may be in a real editor with the
   * same file open. Buffering edits in the page until somebody pressed Save
   * would mean this app holding a second, newer copy of a paper it has spent
   * its life refusing to hold, and would reintroduce exactly the divergence
   * `store.ts` opens by arguing against.
   *
   * So Save means what it means for a document already on disk in a repository:
   * COMMIT what has changed since the last commit. The write path is untouched.
   *
   * ## It commits the paper, not only what this page typed
   *
   * The pathspec is the paper's directory, so a chapter the author edited in
   * their real editor five minutes ago goes in too. That is right rather than
   * sloppy: those bytes are part of the paper's state at the moment somebody
   * said "save this", and a commit that deliberately left them out would be a
   * commit whose tree does not match anything that ever existed on disk. The
   * message says only that the paper was saved, and claims nothing about where
   * the changes came from — see `saveMessage`.
   *
   * Nothing to commit answers `ok: true` with a sentence saying so. Pressing
   * Save on an unchanged paper is not a fault, and a 400 would draw an error
   * over somebody's paper for doing nothing wrong.
   */
  if (path === '/api/save' && method === 'POST') {
    if (!ticketed(body)) return bad(NO_TICKET, 403)
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    if (project === null) return { status: 409, body: { ok: false, error: NOWHERE, project: null } }
    const dir = paperRoot(epic, project)
    if (!dir) return bad('There is no paper for that epic in this project.', 404)

    /* Asked before it is done, because the message names the files and the
       files are what `standing` reads. One extra `git status` on a press of a
       button is not a cost worth an argument. */
    const where = standing(dir)
    if (where.at === 'nogit') {
      /* The button that sends this is not drawn when there is no repository, so
         getting here means something other than the page asked — and the honest
         answer to "save this" from a folder with no history is that there is
         nowhere to save it TO, not silence. */
      return ok({
        ok: true,
        committed: false,
        said: `${dir} is not inside a git repository, so there is no history to save this paper to.`,
      })
    }
    if (where.at !== 'ready') {
      return ok({ ok: true, committed: false, said: aboutCommit(where) })
    }
    const message = saveMessage(epic, where.files)
    const made = commitPaper(dir, message.subject, message.body)
    return ok({ ok: true, committed: made.at === 'committed', said: aboutCommit(made) })
  }

  /*
   * Whether there is anything to commit, and whether a commit would work at all.
   *
   * The Save button reads this. It is a READ — it takes no lock, it changes
   * nothing, and it is ungated like every other read here for the reason
   * `/api/proposals` gives: it says less about this machine than `/api/paper`
   * already does.
   *
   * Three answers rather than a boolean, because "nothing has changed" and
   * "this repository will not take a commit" are different things to draw. A
   * button greyed out for the first means the paper is saved; greyed out for
   * the second it means the paper is NOT saved and nothing here is going to
   * save it, which a person has to be told in words.
   */
  if (path === '/api/uncommitted' && method === 'GET') {
    const epic = str(query.get('epic'), MAX_SLUG)
    if (!isEpic(epic)) return bad('that is not an epic name')
    const project = projectOf(str(query.get('project'), MAX_PROJECT))
    /* No project is not an error on a read, the same as `/api/proposals`: there
       is nowhere to have changed anything, so nothing is waiting. The page
       polls this and a refusal every four seconds would be a container that
       looks broken while a reader has simply not opened a project. */
    if (project === null) return ok({ ok: true, standing: { at: 'nogit' }, hashes: null })
    const dir = paperRoot(epic, project)
    if (!dir) return ok({ ok: true, standing: { at: 'nogit' }, hashes: null })
    /*
     * Two answers to one question — "what has changed under this paper since
     * I last looked?" — from the two things that can answer it.
     *
     * `standing` is git's: what would go into a commit. `hashes` is the
     * disk's: what each file of the paper IS right now, keyed exactly as
     * `Paper.hashes` is, so a page can lay the two side by side and learn
     * that a chapter it is showing has been rewritten under it — by an
     * editor, by a merge, by a checkout — without re-reading the paper on
     * every tick to find out. That is the page's only way of hearing about a
     * change this process did not make: nothing pushes, there is no watcher,
     * and the paper door is deliberately not polled, because a paper is tens
     * of kilobytes parsed and a hash is a line. See `hashesOf`.
     *
     * The two ride together rather than on two doors because they are read on
     * the same tick for the same reason, and because they are the same
     * question asked of two witnesses; a `standing` of `clean` beside hashes
     * that differ from the page's is the reader's editor having committed for
     * them, which is a thing worth being able to see in one answer.
     *
     * The union as `git.ts` composed it, not flattened into a row of always-
     * present fields. The page draws a different control for each branch, and
     * a `files: []` sitting beside `at: 'refused'` is an empty list that means
     * nothing pretending to be one that means "none".
     */
    return ok({ ok: true, standing: standing(dir), hashes: hashesOf(epic, project) })
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
