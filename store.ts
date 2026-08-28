import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { findMacros, parseLatex, type Block, type Macro, type ParsedDocument } from './latex/parse.ts'

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
 * ## The directory is named by the environment, and never by this file
 *
 * `KEHIKKO_PAPERS_DIR` points straight at the directory holding one
 * subdirectory per epic. `KEHIKKO_ROADMAP_DIR` is accepted as well and
 * `data/papers` is appended to it, because that is the variable the host in
 * this workspace already reads and pointing two programs at one roadmap should
 * not take two answers to the same question.
 *
 * Neither set is a real state with its own screen and not an error: this
 * program starts, serves, and says it has not been told where to look. The
 * alternative — a default path compiled into the module — was in the program
 * this was extracted from (`../05_drafts/thesis_latex`) and is exactly the line
 * that made it one person's app rather than a module.
 */
export function papersDir(env: Record<string, string | undefined> = process.env): string | null {
  const direct = env.KEHIKKO_PAPERS_DIR
  if (direct) return existsSync(direct) ? resolve(direct) : null
  const roadmap = env.KEHIKKO_ROADMAP_DIR
  if (roadmap) {
    const guess = join(roadmap, 'data', 'papers')
    return existsSync(guess) ? resolve(guess) : null
  }
  return null
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
 * `realpathSync` on the root and on the parent of the target, because a symlink
 * inside the tree pointing out of it resolves after a plain `resolve()` has
 * already declared the string safe.
 */
function confine(root: string, relative: string): string | null {
  const target = resolve(root, relative)
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  let realTarget: string
  try {
    realTarget = realpathSync(target)
  } catch {
    /* A file that does not exist cannot be read, and saying so is the caller's
       job rather than this fence's. But it still must not be reported as inside
       the root when it is not, so the string form is checked. */
    return target.startsWith(`${realRoot}/`) ? target : null
  }
  return realTarget === realRoot || realTarget.startsWith(`${realRoot}/`) ? realTarget : null
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

/** One epic's paper, as little as the picker needs to name it. */
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
  title: string | null
  author: string | null
  /** Every block in reading order, `\include` expanded in place. */
  blocks: PlacedBlock[]
  /** The headings, flattened, for the section list. */
  outline: { id: string; level: number; text: string }[]
  /** Every file that was opened, in the order it was reached. */
  files: string[]
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
 */
export function listPapers(dir: string | null = papersDir()): PaperBrief[] {
  if (!dir) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: PaperBrief[] = []
  for (const entry of entries.sort()) {
    if (!isEpic(entry)) continue
    const main = confine(dir, join(entry, MAIN))
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
      epic: entry,
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
export function readPaper(epic: string, dir: string | null = papersDir()): Paper | null {
  if (!dir || !isEpic(epic)) return null
  const main = confine(dir, join(epic, MAIN))
  if (!main || !existsSync(main)) return null

  let source: string
  try {
    if (statSync(main).size > MAX_TEX_BYTES) return null
    source = readFileSync(main, 'utf8')
  } catch {
    return null
  }

  const root = join(dir, epic)
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

  return { epic, title: braced(source, 'title'), author: braced(source, 'author'), blocks, outline, files }
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
export function readSource(epic: string, file: string, dir: string | null = papersDir()): string | null {
  const paper = readPaper(epic, dir)
  if (!paper || !dir) return null
  if (!paper.files.includes(file)) return null
  const path = confine(join(dir, epic), file)
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
