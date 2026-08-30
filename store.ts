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

/** A directory holding one paper: a `main.tex` and whatever it includes. */
export interface PaperRoot {
  /** The slug this paper answers to on the wire. */
  epic: string
  /** The directory `main.tex` sits in. Every path is confined to THIS. */
  dir: string
}

/**
 * A second readable root, naming ONE paper rather than a directory of them.
 *
 * ## Why this is a second source and not a thirteenth subdirectory
 *
 * `KEHIKKO_PAPERS_DIR` names a directory of directories: one per epic, each
 * with a `main.tex` inside. A thesis on this machine is not shaped like that.
 * It is a single document — `main.tex`, `chapters/`, `figures/`, a `.cls` and a
 * `references.bib` — living in a repository of its own with its own history,
 * and it is the ONLY thing in that repository. There is no parent directory
 * full of siblings to point at.
 *
 * The three ways to force it into the existing model are all worse than a
 * second variable:
 *
 *  - Point `KEHIKKO_PAPERS_DIR` at the thesis's parent (`05_drafts/`). That
 *    makes every unrelated sibling folder a candidate epic and, worse, makes
 *    the confinement root the parent — so `\include{../thesis_latex/…}` from a
 *    neighbouring folder would resolve INSIDE the root and be served. The fence
 *    would still be doing its job and the job would have become the wrong one.
 *  - Symlink the thesis into `data/papers/thesis`. `confine` realpaths the
 *    root, so this works — and it works by asking the author to put a link to
 *    their thesis inside the roadmap's own data directory, which is a change to
 *    somebody else's repository made so that this app did not have to grow a
 *    variable.
 *  - Copy it in. That is the one thing the essay at the top of this file exists
 *    to forbid.
 *
 * So: a second root, confined separately, with its own slug. `roots()` below is
 * where the two meet, and the meeting is a list rather than a merge — nothing
 * resolves a path against more than the one root it belongs to.
 *
 * The slug defaults to `thesis` and is overridable, because a canvas whose epic
 * is called something else should be able to say so, and because two people
 * with two theses on one machine is not this app's problem to have an opinion
 * about. It goes through `isEpic` like everything else: a slug from the
 * environment is no more trustworthy than a slug from a URL, it just arrives
 * from somebody standing closer.
 */
export function thesisRoot(env: Record<string, string | undefined> = process.env): PaperRoot | null {
  const dir = env.KEHIKKO_THESIS_DIR
  if (!dir) return null
  const epic = env.KEHIKKO_THESIS_EPIC ?? 'thesis'
  if (!isEpic(epic)) return null
  if (!existsSync(join(dir, MAIN))) return null
  return { epic, dir: resolve(dir) }
}

/**
 * Every root this process may read, papers directory first.
 *
 * The order matters exactly once: if somebody sets `KEHIKKO_THESIS_EPIC` to a
 * slug that also exists under the papers directory, the papers directory wins
 * and the thesis becomes unreachable rather than shadowing something. A
 * collision is a misconfiguration either way; this way the thing that was
 * already there keeps working, and the new variable is the one that visibly
 * does nothing.
 */
export function roots(
  dir: string | null = papersDir(),
  thesis: PaperRoot | null = thesisRoot(),
): PaperRoot[] {
  const out: PaperRoot[] = []
  const seen = new Set<string>()
  if (dir) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      entries = []
    }
    for (const entry of entries.sort()) {
      if (!isEpic(entry) || seen.has(entry)) continue
      const root = confine(dir, entry)
      if (!root) continue
      seen.add(entry)
      out.push({ epic: entry, dir: root })
    }
  }
  if (thesis && !seen.has(thesis.epic)) {
    /* Confined against ITSELF, which is what `confine(root, '.')` asks: does
       this directory resolve, through every symlink on the way, to itself. A
       `KEHIKKO_THESIS_DIR` that is a symlink is fine — it is the person who
       started this program naming a place. What is not fine is skipping the
       realpath, because every later `confine` inside this root compares
       against it. */
    const real = confine(thesis.dir, '.')
    if (real) out.push({ epic: thesis.epic, dir: real })
  }
  return out
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
 */
export function listPapers(
  dir: string | null = papersDir(),
  thesis: PaperRoot | null = thesisRoot(),
): PaperBrief[] {
  const out: PaperBrief[] = []
  for (const root of roots(dir, thesis)) {
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
export function readPaper(
  epic: string,
  dir: string | null = papersDir(),
  thesis: PaperRoot | null = thesisRoot(),
): Paper | null {
  if (!isEpic(epic)) return null
  const root = roots(dir, thesis).find((r) => r.epic === epic)?.dir
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
export function readFigure(
  epic: string,
  file: string,
  dir: string | null = papersDir(),
  thesis: PaperRoot | null = thesisRoot(),
): Figure | null {
  const paper = readPaper(epic, dir, thesis)
  if (!paper) return null
  if (!paper.figures.includes(file)) return null
  const dot = file.lastIndexOf('.')
  const type = dot === -1 ? undefined : IMAGE_TYPES[file.slice(dot).toLowerCase()]
  if (!type) return null
  const root = roots(dir, thesis).find((r) => r.epic === epic)?.dir
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
export function readSource(
  epic: string,
  file: string,
  dir: string | null = papersDir(),
  thesis: PaperRoot | null = thesisRoot(),
): string | null {
  const paper = readPaper(epic, dir, thesis)
  if (!paper) return null
  if (!paper.files.includes(file)) return null
  const root = roots(dir, thesis).find((r) => r.epic === epic)?.dir
  if (!root) return null
  const path = confine(root, file)
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
