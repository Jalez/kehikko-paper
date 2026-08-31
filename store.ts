import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { KEHIKOT_DIR, moduleFile } from 'roadmap-module-protocol'

import { findMacros, parseLatex, type Block, type Macro, type ParsedDocument } from './latex/parse.ts'
import { ID } from './manifest.ts'

/**
 * The papers on this machine, and the one rule about where they may come from.
 *
 * ## This app owns no data, and that is a deliberate difference from Journeys
 *
 * Journeys HOLDS its journeys: they live in its own directory, it writes them,
 * and the extraction is only real because that stayed true. This module is the
 * other shape. A paper is a `.tex` file somebody is writing in an editor, in a
 * repository with its own history, and the worst thing this app could do is
 * become a second place where one lives. So there is no store here, no seed, no
 * copy and no cache — `readPaper` opens the file every time it is asked.
 *
 * That is not laziness about performance. A paper is being edited WHILE this is
 * running; the whole value of the page is that a reload shows the sentence the
 * author just wrote. A cache here would show the sentence they wrote before
 * lunch, with every symptom of a working app, which is the failure this
 * codebase has spent the most time on.
 *
 * ## The papers are in the project, and the project is named by the host
 *
 * This used to be two environment variables. `KEHIKKO_PAPERS_DIR` named a
 * directory of directories, one per epic; `KEHIKKO_THESIS_DIR` named a second
 * root holding a single document, because a thesis has no parent full of
 * sibling papers to point at. Both are gone, and what replaced them is the
 * convention every other module in this workspace already keeps: the material
 * lives in the PROJECT the host says is open, and the module derives its
 * location from `roadmap.context.projectPath` rather than from the shell that
 * happened to start it.
 *
 * Three things were wrong with the variables, and only the third is about
 * taste:
 *
 *  1. **They are one restart from gone.** `KEHIKKO_THESIS_DIR` vanished on a
 *     restart during a refactor, and this app answered — correctly, and
 *     uselessly — that nothing on this machine held a paper for the thesis.
 *     Every layer reported truthfully and the thesis simply disappeared. The
 *     defaults in `run.sh` were written to paper over that, which put one
 *     person's home directory in a module's start script.
 *  2. **They are per-machine where the fact is per-project.** Which directory
 *     holds a project's paper is a fact about that project, belongs in it, and
 *     travels with it. A shell variable is a fact about a terminal.
 *  3. **This was the one module in the family that never read `projectPath`.**
 *     Notes, checklist and journeys all locate themselves from the open
 *     project; paper did not, so it was the only container on a canvas that
 *     could be showing another project's material and have no way to know.
 *
 * ## Where a paper is, in two rules
 *
 * **The default is `<project>/data/papers/<epic>/`.** That is exactly the shape
 * the roadmap project already has, so it needs no configuration at all — the
 * arrangement `KEHIKKO_PAPERS_DIR` was pointed at is now simply the default,
 * found by looking rather than by being told.
 *
 * **The exceptions live in `<project>/.kehikot/paper/papers.json`.** For a
 * thesis, the paper IS the project: `main.tex` at the top of its own
 * repository, `chapters/` beside it, and no `data/papers` anywhere. One line in
 * that file — `"thesis": "."` — says so, in the project it is about, versioned
 * with the person's own work rather than with their shell. `.kehikot/<module>/`
 * is where every module in this family keeps what it knows about a project, and
 * paper had never joined the convention.
 *
 * ## What is NOT here: a default project
 *
 * `null` in, nothing out. No `process.cwd()`, which is this module's own
 * directory; no "the only project that has papers", which is right until there
 * are two; no compiled-in path, which is the line that made the program this
 * was extracted from one person's app. A module with no project has nowhere to
 * read, that is an ordinary state, and the page has a screen for it. The
 * protocol package's `kehikotDir` makes this argument first and this file is
 * not going to reach a different conclusion.
 */

/**
 * Where a project keeps its papers unless it says otherwise.
 *
 * Not under `.kehikot/`, and the difference is the whole point of this module.
 * `.kehikot/<module>/` is a program's working material in somebody's
 * repository. A paper is the opposite: it is the thing the person is writing,
 * with its own history, and moving it into a dot-directory named after this app
 * would be exactly the "second place where the paper lives" the essay above
 * refuses. So `.kehikot/paper/` holds a POINTER and never a paper.
 */
const PAPERS_DIR = 'data/papers'

/** The file that names the exceptions. `moduleFile` decides where it sits. */
const POINTERS = 'papers'

/** A directory holding one paper: a `main.tex` and whatever it includes. */
export interface PaperRoot {
  /** The slug this paper answers to on the wire. */
  epic: string
  /** The directory `main.tex` sits in. Every path is confined to THIS. */
  dir: string
}

/**
 * The project as this app names it to itself: absolute, real, a directory — or
 * `null`, which is the ordinary state of no project being open.
 *
 * Realpath'd, because everything downstream compares against it. `confine`
 * measures a resolved path against a resolved root, and a root left as whatever
 * string arrived would make every comparison on this machine's `/tmp` — which
 * is `/private/tmp` — fail for a reason nobody could see from either side.
 *
 * Refused rather than guessed at when it is relative: a relative project path
 * would resolve against whatever directory this module was started in, which is
 * this module's own source tree, and the reader would be served the paper app's
 * repository under the name of their project.
 *
 * `null` for every refusal, with no distinction between "no project", "not
 * absolute" and "there is nothing there". This app is read-only and answers on
 * loopback; a caller who can tell those apart can ask this door which
 * directories exist on the disk, one question at a time.
 */
export function projectOf(projectPath: string | null | undefined): string | null {
  if (typeof projectPath !== 'string') return null
  const raw = projectPath.trim()
  if (!raw || !isAbsolute(raw)) return null
  try {
    const real = realpathSync(raw)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/**
 * The exceptions this project declares, as a map from epic to directory.
 *
 * ## The shape, and why it is this small
 *
 *     { "papers": { "thesis": "." } }
 *
 * One object, one entry per epic, the value a path RELATIVE TO THE PROJECT
 * ROOT. `"."` means the paper is the project itself, which is the thesis case
 * and the case this file was written for. A top-level `papers` key rather than
 * a bare map because a document with a named field can grow a second one
 * without every reader having to guess which shape it is looking at, and
 * because that is how the sibling modules spell their own files.
 *
 * A relative path and never an absolute one. An absolute path in here would be
 * a per-machine fact written into a file that travels with a repository — the
 * exact failure the environment variables had, moved somewhere it would also be
 * committed and shared with everybody who clones it.
 *
 * ## Malformed is empty, and is never an error
 *
 * No file, unreadable file, not JSON, not an object, values that are not
 * strings: all of them mean this project declares no exceptions. That is a
 * deliberate refusal to have an error state here. The file is hand-editable by
 * design, and a typo in it must degrade to "the default applies" rather than to
 * a page that will not draw — a module that answered a stray comma with a
 * broken container would have made the pointer file more dangerous than the
 * variables it replaced.
 *
 * What is NOT tolerated is a path leaving the project. Every value goes through
 * `confine` against the project root, so a `"../../etc"` in a file somebody
 * committed cannot turn this door into a reader of the disk. That check is in
 * `roots()` below, where the root it is measured against is already resolved.
 */
export function pointers(project: string | null): Record<string, string> {
  const path = project === null ? null : moduleFile(project, ID, POINTERS)
  if (path === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const named = (parsed as { papers?: unknown }).papers
  if (!named || typeof named !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [epic, where] of Object.entries(named as Record<string, unknown>)) {
    /* `isEpic` on the key as well as on everything else. This one arrives from
       a file rather than from a request, which makes it no more trustworthy —
       it is joined onto nothing, but it becomes a slug the page and the wire
       both carry, and a key this app accepted that a host would refuse is a
       paper nothing can ever point at. */
    if (!isEpic(epic) || typeof where !== 'string' || !where.trim()) continue
    out[epic] = where.trim()
  }
  return out
}

/**
 * Every root this project offers, exceptions first.
 *
 * ## The exception wins, and that is the opposite of the old rule
 *
 * When the two roots were environment variables, a collision went to the papers
 * directory: the thing already there kept working and the newer variable was
 * the one that visibly did nothing. That was right for two variables set by the
 * same person in the same shell, where neither is more deliberate than the
 * other.
 *
 * It is wrong here. `data/papers/<epic>/` is found by LOOKING — a directory
 * that happens to exist, possibly left behind by a checkout — and a pointer is
 * a sentence somebody wrote down about this project on purpose. When the two
 * disagree, the one with an author behind it wins, or the file is not an
 * exceptions file. There is nothing silent about it either way: the pointer is
 * a line in a file in their own repository.
 *
 * ## Every root is confined and resolved before it is a root
 *
 * `confine(project, …)` for a pointer, so a value in that file cannot name a
 * directory outside the project; `confine(dir, entry)` for a discovered one,
 * which is also what resolves a symlinked epic directory to what it really is.
 * Both matter for the same reason: every later `confine` inside a root compares
 * against the string this function returned, so a root that was not resolved
 * here is a fence measuring against a path the filesystem does not agree with.
 *
 * A root with no `main.tex` under it is not a root. That is what makes an
 * abandoned `data/papers/some-epic/` an epic with no paper rather than an epic
 * whose paper this app failed to render, and it is what stops `"."` in a
 * pointer file from making every project a paper.
 */
export function roots(project: string | null): PaperRoot[] {
  if (project === null) return []
  const out: PaperRoot[] = []
  const seen = new Set<string>()

  for (const [epic, where] of Object.entries(pointers(project))) {
    const dir = confine(project, where)
    if (!dir || seen.has(epic)) continue
    if (!existsSync(join(dir, MAIN))) continue
    seen.add(epic)
    out.push({ epic, dir })
  }

  const papers = confine(project, PAPERS_DIR)
  if (papers) {
    let entries: string[] = []
    try {
      entries = readdirSync(papers)
    } catch {
      entries = []
    }
    for (const entry of entries.sort()) {
      if (!isEpic(entry) || seen.has(entry)) continue
      const dir = confine(papers, entry)
      if (!dir) continue
      seen.add(entry)
      out.push({ epic: entry, dir })
    }
  }
  /* Sorted at the end rather than by construction, because the two sources are
     read in precedence order and that is not the order anybody wants to read a
     list in. A list that reordered itself between two calls looks like a page
     flickering. */
  return out.sort((a, b) => (a.epic < b.epic ? -1 : a.epic > b.epic ? 1 : 0))
}

/**
 * Whether this project is somewhere this app could find a paper at all.
 *
 * Used for one sentence on the page: "there is no paper for this epic" and
 * "this project keeps no papers" are different things to tell somebody, and an
 * empty list cannot tell them apart. It is deliberately not a fence — `roots()`
 * above returns nothing for a project with neither of these, so nothing hangs
 * on the answer.
 */
export function keepsPapers(project: string | null): boolean {
  if (project === null) return false
  return existsSync(join(project, PAPERS_DIR)) || existsSync(join(project, KEHIKOT_DIR))
}

/**
 * The one root an epic's paper is in, or null.
 *
 * A helper rather than three copies of `roots(project).find(…)`, because the
 * three readers below must agree about which directory an epic means. Two of
 * them disagreeing would not be a crash: it would be `read_source` opening a
 * file out of one paper while the page beside it renders another, both of them
 * answering confidently.
 */
function rootFor(epic: string, project: string | null): string | null {
  return roots(project).find((r) => r.epic === epic)?.dir ?? null
}

/**
 * A slug, checked before it is put in a path.
 *
 * This arrives over the wire, from a host, from a URL, or from an agent on the
 * MCP door — three callers and none of them this program. `../../.ssh/id_rsa`
 * is a string, and joining it onto a directory is how "read the open epic's
 * paper" becomes "read anything on this disk". The shape is the check, it is
 * applied before any filesystem call, and it refuses identically whether or not
 * the epic exists: a refusal that arrived faster for a real slug than for an
 * invented one would answer the question it was refusing to answer.
 *
 * The shape check is not the only fence — see `confine` — because a shape check
 * alone has been wrong before on case-insensitive filesystems and under
 * symlinks, and one fence with a hole in it is worse than two.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export function isEpic(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value)
}

/**
 * Resolve a path inside the papers directory, or refuse.
 *
 * The second fence. `SLUG` already forbids a dot and a slash, so nothing shaped
 * like a traversal reaches here — but the include targets inside a `.tex` file
 * do NOT go through `SLUG`, because `\include{chapters/3_methods}` legitimately
 * contains a slash, and an author can write `\include{../../../../etc/passwd}`
 * as easily as anything else. That is not a hostile-author threat model; it is
 * a typo one. Either way the answer is the same: resolve the real path and
 * refuse anything that did not land underneath the root.
 *
 * `realpathSync` on the root as well as on the target, because a symlink inside
 * the tree pointing out of it resolves after a plain `resolve()` has already
 * declared the string safe — and on the root because the answer has to be
 * compared against a real path, and `/tmp` is `/private/tmp` on the machine
 * this workspace's tests run on.
 *
 * ## The leaf may not exist, and that used to be the hole
 *
 * `realpathSync` throws ENOENT for a path whose last component is not there,
 * and a missing leaf is an ordinary state here: `readPaper` asks about
 * `chapters/3_methods.tex` before it knows whether the author has written it,
 * and reports "is not on disk here" — which it can only do if this function
 * hands back a path for the read to fail on. So the throw cannot simply be a
 * refusal.
 *
 * What it used to be instead was a LEXICAL fallback: the unresolved `target`
 * compared, as a string, against the realpath'd root. That blesses a path the
 * filesystem would send somewhere else. Plant a directory symlink inside the
 * root pointing out of it — `<root>/out -> /somewhere/else` — ask for
 * `out/ghost.tex`, and the string starts with the root, so the fence said yes
 * about a path resolving into `/somewhere/else`. Nothing was served through it
 * only because `readFileSync` threw on the next line. That is not a fence; it
 * is a fence with a note asking the next operation to please fail. The day
 * somebody adds an `existsSync`, a write, or any call happy to CREATE the
 * missing leaf, the escape is real, and the reviewer who checked this function
 * would have read the comment above promising the parent was resolved.
 *
 * So the leaf is split off and the PARENT is realpath'd — a real directory,
 * whose symlinks resolve — and the check is made against the answer. A parent
 * that cannot be realpath'd either is refused outright: this program has
 * nothing to say about a path two components deep in a directory that is not
 * there.
 *
 * The explorer's `tree/confine.ts` reached the same rule from the other end and
 * refuses anything it cannot realpath at all, which it can afford because it
 * only ever asks about things it has just listed. Two modules implementing "the
 * fence" two different ways is how one of them ends up wrong — this one did —
 * and the answer is one implementation in `roadmap-module-protocol` that both
 * import. That is not done here on purpose: another agent is in that package as
 * this is written, and a shared fence landed by two hands at once is the worst
 * possible file to have a merge conflict in. It is the next move, and this
 * comment is the note that says so.
 *
 * A refusal is always `null`, with no distinction between "outside", "not
 * there" and "cannot be read". Three refusals is an existence oracle: a caller
 * that can tell them apart can probe for files it is not allowed to see, one
 * question at a time.
 */
export function confine(root: string, relative: string): string | null {
  const target = resolve(root, relative)
  const realRoot = real(root)
  if (realRoot === null) return null

  const realTarget = real(target)
  if (realTarget !== null) return inside(realRoot, realTarget) ? realTarget : null

  /* The leaf is not on disk. Everything ABOVE it must still be, and must still
     land under the root once its symlinks are followed. */
  const parent = dirname(target)
  /* `dirname('/')` is `'/'`. Without this a target at the filesystem root would
     ask the same question forever, or answer it about itself. */
  if (parent === target) return null
  const realParent = real(parent)
  if (realParent === null) return null
  if (!inside(realRoot, realParent)) return null
  return join(realParent, basename(target))
}

/**
 * Whether `path` is `root` or sits beneath it, as directories rather than as
 * strings.
 *
 * The separator is not decoration: `'/paper-evil'.startsWith('/paper')` is
 * true, and a prefix check without it is written by somebody thinking about
 * directories while the language thinks about characters. The root is allowed
 * as itself because `confine(dir, '.')` — which `roots()` uses to resolve a
 * root against itself — asks exactly that question.
 */
function inside(root: string, path: string): boolean {
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * `realpathSync`, or null.
 *
 * A throw here is ENOENT, EACCES or ELOOP, and all three mean the same thing to
 * this program: it is not going to read that. Telling them apart on the way out
 * is the oracle `confine` refuses.
 */
function real(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

const MAIN = 'main.tex'

/**
 * How much of one file will be read.
 *
 * The parser is linear in the source and the papers here are tens of
 * kilobytes, so this is a bound and not a budget. It exists because the
 * directory is somebody else's and a `main.tex` that is actually a 4GB core
 * dump should produce a refusal rather than an out-of-memory in a dev server.
 */
const MAX_TEX_BYTES = 4_000_000

/** One epic's paper, as little as `list_papers` needs to name it. */
export interface PaperBrief {
  epic: string
  /** `\title{…}` from the preamble, when it says one. Never invented. */
  title: string | null
  /** How many `.tex` files the paper is made of, main included. */
  files: number
  bytes: number
}

/** A block, plus which file it came out of — offsets are per-file. */
export type PlacedBlock = Block & { file: string }

export interface Paper {
  epic: string
  /**
   * The directory `main.tex` sits in, absolute, on this machine.
   *
   * ## Why a page needs the root at all
   *
   * Every offset in this structure is per-file and every `file` on a block is
   * RELATIVE to this — `chapters/2_bridge.tex` — which is right for everything
   * inside this app: the fence in `confine` resolves against the root, the
   * reader draws the relative name, and nothing here has to care where the
   * folder is.
   *
   * It stops being enough the moment the page says where somebody is pointing
   * to anybody else. The protocol is explicit that a `passage.path` should be
   * ABSOLUTE, because that is the only spelling two modules can agree on
   * without sharing a root, and it is right: a notes module handed
   * `chapters/2_bridge.tex` would have to guess which of the eleven projects on
   * this machine that is relative to, and a guess that lands on the wrong
   * project's identically-named chapter is worse than no answer.
   *
   * So the root travels with the paper, and the page joins the two. It is the
   * root this app was CONFIGURED with — an environment variable somebody set on
   * purpose — and never anything a reader typed, so publishing it discloses
   * where the operator put their papers and nothing else.
   */
  dir: string
  title: string | null
  author: string | null
  /** Every block in reading order, `\include` expanded in place. */
  blocks: PlacedBlock[]
  /** The headings, flattened, for the section list. */
  outline: { id: string; level: number; text: string }[]
  /** Every file that was opened, in the order it was reached. */
  files: string[]
  /** Every `\includegraphics` target the paper names, in document order. */
  figures: string[]
}

/**
 * Every epic under the papers directory that actually has a paper.
 *
 * A subdirectory with no `main.tex` is not listed. That is a judgement rather
 * than an oversight: the roadmap's `data/papers/` is a directory somebody else
 * maintains, and an empty folder left behind by a `git checkout` is not an epic
 * whose paper this app failed to render — it is an epic with no paper, and the
 * picker offering a button that could only ever say "nothing here" would be
 * offering a way to be disappointed.
 *
 * Sorted by slug so the list is stable between calls. A picker that reordered
 * itself on every read looks like a page that is flickering.
 *
 * Per project, and with no default. `listPapers(null)` is an empty list and
 * never "every paper on this machine": there is no such thing any more, and
 * there was never a caller who wanted one.
 */
export function listPapers(project: string | null): PaperBrief[] {
  const out: PaperBrief[] = []
  for (const root of roots(project)) {
    const main = confine(root.dir, MAIN)
    if (!main || !existsSync(main)) continue
    let source: string
    let bytes: number
    try {
      bytes = statSync(main).size
      if (bytes > MAX_TEX_BYTES) continue
      source = readFileSync(main, 'utf8')
    } catch {
      /* One unreadable paper must not make the other ten unreachable. */
      continue
    }
    out.push({
      epic: root.epic,
      title: braced(source, 'title'),
      files: 1 + includeTargets(source).length,
      bytes,
    })
  }
  return out
}

/**
 * `\title{…}` and `\author{…}`, read off the raw source.
 *
 * Off the SOURCE rather than off the parsed blocks, because both live in the
 * preamble and the parser deliberately folds the whole preamble into one opaque
 * block — nobody wants `fontspec` setup in a reading view. The two facts a
 * reader does want out of it are these, so they are lifted here rather than by
 * teaching the parser about a preamble it is right to ignore.
 *
 * Brace-matched rather than regexed to a closing `}`, because a title
 * containing a braced group (`\title{The \emph{one} rule}`) would otherwise be
 * cut at the first inner brace and the page would show half a title with no
 * sign that it was half of one.
 */
function braced(source: string, command: string): string | null {
  const at = source.indexOf(`\\${command}{`)
  if (at === -1) return null
  let depth = 0
  for (let i = at + command.length + 1; i < source.length; i += 1) {
    const c = source[i]
    if (c === '\\') {
      i += 1
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        const raw = source.slice(at + command.length + 2, i)
        /* Markup reduced to prose the same way the parser does it, so a title
           in the picker and the same title in the reading view are one string
           rather than two that usually agree. */
        const text = raw
          /* `\\` is a line break in a title, not a command — the loop above
             skips it as an escape, so it survives to here and would otherwise
             be printed literally in the picker. The thesis on this machine has
             two of them in `\title{}`. A break becomes a space, because the
             picker's title is one line. */
          .replace(/\\\\/g, ' ')
          .replace(/\\[a-zA-Z]+\s*/g, '')
          .replace(/[{}]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        return text || null
      }
    }
  }
  return null
}

/** Every `\include{…}` / `\input{…}` target in a source, in the order written. */
function includeTargets(source: string): string[] {
  const out: string[] = []
  for (const block of parseLatex(source, MAIN).blocks) {
    if (block.kind === 'include') out.push(block.target)
  }
  return out
}

/**
 * One paper, opened and parsed, with its chapters folded into reading order.
 *
 * ## Why `\include` is expanded here and not in the browser
 *
 * The page could be handed the main file and told to fetch each chapter. It is
 * not, for the reason every opinion in these apps is reached on this side: an
 * order assembled in two places is two orders, and this one disagreeing means a
 * reader is shown the argument's steps in the wrong sequence with nothing on
 * screen saying so. The document order is a fact about the source; it is
 * decided where the source is.
 *
 * One level deep, deliberately. LaTeX's own `\include` cannot nest — it is
 * `\input` that can — and a paper that reached for arbitrary depth would be a
 * paper this reader could be made to walk in a cycle. A target that is itself
 * missing becomes an `unknown` block saying which file was not there, which is
 * a sentence a reader can act on; silently skipping it would present a paper
 * with a hole in it as a complete one.
 */
export function readPaper(epic: string, project: string | null): Paper | null {
  if (!isEpic(epic)) return null
  const root = rootFor(epic, project)
  if (!root) return null
  const main = confine(root, MAIN)
  if (!main || !existsSync(main)) return null

  let source: string
  try {
    if (statSync(main).size > MAX_TEX_BYTES) return null
    source = readFileSync(main, 'utf8')
  } catch {
    return null
  }

  /*
   * The macros come out of `main.tex` and are handed to every chapter.
   *
   * They have to be, and the reason is a one-line bug that looks like a
   * rendering problem: `\gh`, `\mr` and `\work` are defined in the preamble
   * of the main file and used almost exclusively inside `chapters/*.tex`, which
   * have no preamble of their own. A chapter parsed on its own terms finds no
   * definitions, falls back to "drop the wrapper, keep the argument", and
   * renders every reference in the paper as a naked number — `111` where the
   * PDF says `gh#111`. See the essay on `Macro` in the parser.
   */
  const macros: ReadonlyMap<string, Macro> = findMacros(source)
  const parsed = parseLatex(source, MAIN, macros)
  const blocks: PlacedBlock[] = []
  const files: string[] = [MAIN]

  for (const block of parsed.blocks) {
    if (block.kind !== 'include') {
      blocks.push({ ...block, file: MAIN })
      continue
    }
    const relative = block.target.endsWith('.tex') ? block.target : `${block.target}.tex`
    const child = confine(root, relative)
    let chapter: ParsedDocument | null = null
    if (child && existsSync(child)) {
      try {
        if (statSync(child).size <= MAX_TEX_BYTES) chapter = parseLatex(readFileSync(child, 'utf8'), relative, macros)
      } catch {
        chapter = null
      }
    }
    if (!chapter) {
      blocks.push({
        ...block,
        kind: 'unknown',
        raw: `\\include{${block.target}} — this file is named by the paper and is not on disk here.`,
        file: MAIN,
      } as PlacedBlock)
      continue
    }
    files.push(relative)
    for (const inner of chapter.blocks) {
      /* A chapter file has no preamble of its own; when the parser reports one
         it is because the file opens with a comment run before any command, and
         folding that away would drop the provenance note the author wrote at
         the top of the chapter. Comments survive; a real preamble cannot occur
         here because `\begin{document}` cannot. */
      blocks.push({ ...inner, file: relative })
    }
  }

  const outline = blocks
    .filter((b): b is PlacedBlock & { kind: 'heading' } => b.kind === 'heading')
    .map((b) => ({
      id: b.id,
      level: b.level,
      text: b.segments
        .map((s) => s.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    }))

  /*
   * Every image the paper names, collected once here rather than recomputed.
   *
   * It is the `readSource` argument applied to pictures: `/api/figure` checks a
   * requested file against THIS list and not against the filesystem, so "show
   * the figures in this paper" cannot become "serve any file under this
   * directory". A `figures/` folder holding a private PDF the author never
   * included stays unreachable, because the paper never named it.
   */
  const figures: string[] = []
  for (const block of blocks) {
    if (block.kind !== 'figure') continue
    for (const graphic of block.graphics) if (!figures.includes(graphic)) figures.push(graphic)
  }

  return {
    epic,
    /* `root` and not the `dir` argument: `roots()` has already resolved it —
       and for the thesis root, realpath'd it — so this is the folder the fence
       in `confine` measures against rather than the string somebody typed into
       an environment variable. Two spellings of one folder would be two
       different `passage.path`s for one file, and every consumer compares that
       field for EQUALITY. */
    dir: root,
    title: braced(source, 'title'),
    author: braced(source, 'author'),
    blocks,
    outline,
    files,
    figures,
  }
}

/**
 * The image types this app will hand back, and the two it deliberately will not.
 *
 * The content type is looked up here rather than sniffed or guessed from the
 * bytes, because a guessed type is how a file that is not what it claims gets
 * executed as what it claims. A file whose extension is not in this table is
 * not served at all — the reading view keeps showing its filename in a box,
 * which is what it did for every figure before this door existed.
 *
 * SVG is absent on purpose and it is the interesting omission. An SVG is a
 * document, it can carry `<script>`, and this app serves it from
 * `127.0.0.1:7870` — the same origin as its own `/api`. A paper that included a
 * hostile SVG would get script execution against this module's origin, which is
 * precisely the origin `manifest.ts` argues so carefully for keeping.
 *
 * PDF is absent for a duller reason and one honest one. `<img>` cannot draw it,
 * so serving it would mean an `<object>` or an iframe — an embedded viewer on
 * this origin, which is the same hazard as the SVG with a bigger attack
 * surface. The thesis on this machine has one PDF figure and three PNGs; the
 * PDF keeps its filename box, and that is a visible, explicable gap rather than
 * a silent one.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** A bound on one image, for the reason `MAX_TEX_BYTES` exists. */
const MAX_IMAGE_BYTES = 16_000_000

export interface Figure {
  bytes: Uint8Array
  type: string
}

/**
 * One image, if the paper named it and this app is willing to draw it.
 *
 * Four checks, and each one is load-bearing:
 *
 *  1. `isEpic` on the slug, as everywhere.
 *  2. The file must appear in the paper's own `figures` list — see the comment
 *     there. This is the check that stops the door being a file server.
 *  3. The extension must be in `IMAGE_TYPES`, so the type sent is a constant in
 *     this file and never a function of the bytes.
 *  4. `confine` against the paper's own root, which is what catches a
 *     `\includegraphics{../../../.ssh/id_rsa.png}` and a symlink pointing out
 *     of the tree. Check 2 already makes that hard — the author would have to
 *     have written it into their own paper — but this is a typo threat model
 *     more than a hostile one, and the fence costs a line.
 */
export function readFigure(epic: string, file: string, project: string | null): Figure | null {
  const paper = readPaper(epic, project)
  if (!paper) return null
  if (!paper.figures.includes(file)) return null
  const dot = file.lastIndexOf('.')
  const type = dot === -1 ? undefined : IMAGE_TYPES[file.slice(dot).toLowerCase()]
  if (!type) return null
  const root = rootFor(epic, project)
  if (!root) return null
  const path = confine(root, file)
  if (!path) return null
  try {
    if (statSync(path).size > MAX_IMAGE_BYTES) return null
    return { bytes: readFileSync(path), type }
  } catch {
    return null
  }
}

/**
 * The raw source of one file of one paper.
 *
 * Only reachable over the MCP door, and only for a file the paper itself named
 * — `readPaper` records them in `files` and this checks against that list
 * rather than against the filesystem. The difference matters: a check against
 * the filesystem would let an agent name any `.tex` under the epic's directory,
 * including a scratch file the author never included, and "what does the paper
 * say" would quietly become "what is lying around next to it".
 */
export function readSource(epic: string, file: string, project: string | null): string | null {
  const paper = readPaper(epic, project)
  if (!paper) return null
  if (!paper.files.includes(file)) return null
  const root = rootFor(epic, project)
  if (!root) return null
  const path = confine(root, file)
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
