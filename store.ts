import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { KEHIKOT_DIR, moduleDir, moduleFolder } from 'roadmap-module-protocol'

import { NO_BIBLIOGRAPHY, bibFilesNamed, parseBib, resolveCite, type Bibliography } from './latex/bib.ts'
import { onBoundary, sourceRefuses, whyNot } from './latex/edit.ts'
import { buildLabelIndex, mapSegments, resolveRef } from './latex/labels.ts'
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
 * ## Where a paper is: one place
 *
 * **`<project>/.kehikot/paper/<epic>/main.tex`.** That is the whole rule. It is
 * found with `moduleDir(projectPath, ID)` — the same helper every other module
 * in this family uses to find its own folder — so this module now locates
 * itself the way its siblings do rather than by a scheme of its own.
 *
 * ## What was here before, and why one rule replaced two
 *
 * There was a DEFAULT and an EXCEPTION. The default was
 * `<project>/data/papers/<epic>/`, which the roadmap project already had; the
 * exception lived in `<project>/.kehikot/paper/papers.json` and said where a
 * paper was when it was somewhere else — `{"papers": {"thesis": "."}}` for a
 * thesis, where the paper IS the project.
 *
 * It was config that grows by one entry every time somebody's layout does not
 * match a guess, and worse than that: there were two roads to a paper, and
 * reading either one alone did not tell you which had applied. The user's
 * objection was the right one — writing special exceptions for how things work
 * between projects is not sustainable.
 *
 * So there are no exceptions, because there is nothing to be an exception TO.
 * A paper goes where every other module's material for a project goes, in the
 * folder named after the module that owns it, and a project with an unusual
 * layout moves its files rather than declaring itself special.
 *
 * ## The thing that argument had to answer
 *
 * The comment that stood on `PAPERS_DIR` said `.kehikot/paper/` holds a POINTER
 * and never a paper, because `.kehikot/<module>/` is a program's working
 * material in somebody's repository and a paper is the opposite — the thing the
 * person is writing, with its own history.
 *
 * That was a real argument and it was overtaken rather than ignored. What made
 * it true was that `.kehikot/` was IGNORED by git, so a paper in there would
 * have been a thesis with no history. Whether that folder is committed is a
 * per-project setting now — a checkbox in the host, one writer, see
 * `shareKehikot` in the host's `server/projects.ts` — so the folder is no
 * longer a synonym for "not the project's". A project whose papers live here
 * keeps `.kehikot/` in its history, and the setting is where that is said.
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
 *
 * ## This module is no longer read-only, and that is worth saying at the top
 *
 * It was, apart from `startPaper`, and several essays here leaned on it: a
 * reader that has never written cannot have a bug that destroys somebody's
 * afternoon. There are two writers now, and the second one is the serious one.
 * `startPaper` makes a file where there was none and refuses if anything is
 * already there, so the worst it can do is nothing. `writeRange` REPLACES BYTES
 * IN A FILE SOMEBODY IS WRITING, which is the one operation in this repository
 * that can destroy work.
 *
 * It is fenced by everything `startPaper` is fenced by — the slug, the paper's
 * own root, `confine` — plus two of its own:
 *
 *  - **It never creates.** The file must be there already and must be a file.
 *    A write door that can bring a path into being is a write door that can be
 *    talked into planting one.
 *  - **It refuses a file that changed under it.** The caller says what it
 *    believed the file was and this re-reads and compares before it splices.
 *    See the essay on `writeRange`, which is mostly about that, because the
 *    section at the top of this file — nothing is cached, because a paper is
 *    being edited WHILE this is running — is precisely the statement that
 *    somebody else may be in the file, and a blind range-replace against a file
 *    somebody else has edited is the worst thing this module could learn to do.
 */

/**
 * Where a project keeps its papers.
 *
 * Not a string joined onto the project here: `moduleDir` is what knows the
 * folder's name, derives it from this module's id, and refuses an id it will
 * not join onto somebody's root. This module spent a version deciding that for
 * itself and was the only one that did.
 */
function papersDir(project: string): string {
  return moduleDir(project, ID) as string
}

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
 * Every paper this project holds.
 *
 * One directory read, and the folder's name is the epic. There is no second
 * source to reconcile with this one and no precedence rule to get wrong —
 * which is the whole of what deleting the pointer file bought.
 *
 * ## A directory with no `main.tex` is not a paper
 *
 * That is what makes an abandoned `.kehikot/paper/some-epic/` an epic with no
 * paper rather than an epic whose paper this app failed to render, and it is
 * what stops an empty folder left by a checkout from putting a button in a
 * picker that could only ever say "nothing here".
 *
 * ## Every root is confined and resolved before it is a root
 *
 * `confine(papers, entry)` rather than `join`, which is also what resolves a
 * symlinked paper directory to what it really is. Every later `confine` inside
 * a root compares against the string this function returned, so a root that was
 * not resolved here is a fence measuring against a path the filesystem does not
 * agree with.
 */
export function roots(project: string | null): PaperRoot[] {
  if (project === null) return []
  const papers = confine(project, KEHIKOT_DIR)
  const dir = papers === null ? null : papersDir(project)
  if (dir === null) return []

  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const out: PaperRoot[] = []
  for (const entry of entries.sort()) {
    /* `isEpic` on a directory name, because it becomes a slug the page and the
       wire both carry. A folder this app accepted that a host would refuse is a
       paper nothing can ever point at. */
    if (!isEpic(entry)) continue
    const at = confine(dir, entry)
    if (!at || !existsSync(join(at, MAIN))) continue
    out.push({ epic: entry, dir: at })
  }
  return out
}

/**
 * Where this epic's paper would go, whether or not one is there.
 *
 * A path a person can read, copy, and `cd` to. The screen that says "there is
 * no paper here" was a paragraph explaining a convention, which is the wrong
 * shape for the question somebody is actually asking — they want to know where
 * it goes and, most of the time, to put one there. The user's word for the
 * paragraph was "silly", and they were right: a path and a button say it.
 *
 * `null` when there is no project or the epic is not one, because there is no
 * such place then and inventing a plausible-looking path would be worse than
 * saying nothing.
 */
export function whereItWouldGo(epic: string, project: string | null): string | null {
  if (project === null || !isEpic(epic)) return null
  /*
   * `join` and not `confine`, and a test caught the difference.
   *
   * `confine` resolves a real path, which means it answers null for a path that
   * does not exist — and the whole subject here is a directory that does not
   * exist yet, in a project that may have no `.kehikot/paper` at all. Confining
   * would refuse in exactly the case this function was written for: a project
   * that has never held a paper, which is when somebody wants to start one.
   *
   * What makes the shape check enough on its own is that it is the ONLY input.
   * `SLUG` forbids a dot and a slash, so nothing shaped like a traversal can be
   * an epic; the other half of `confine`'s job — resolving symlinks — has
   * nothing to resolve, because there is no entry there to be a symlink. Every
   * path that goes on to be READ still goes through `confine`, in `roots`,
   * against a directory that exists by then.
   */
  return join(papersDir(project), epic)
}

export type Started = { ok: true; dir: string } | { ok: false; why: string }

/**
 * Make the folder for an epic's paper, with a document in it.
 *
 * ## This module was read-only, and this is the one thing it writes
 *
 * Every other door here reads. That was worth keeping and is worth naming when
 * it changes: a reader that has never written cannot have a bug that destroys
 * somebody's afternoon, and every argument in this file about fences was made
 * easier by it. So this is deliberately the narrowest write that answers the
 * question — one directory, one file, and never a second time.
 *
 * ## It refuses rather than overwrites, always
 *
 * If anything is already at that path this returns a refusal and touches
 * nothing, whether that is a paper, a folder somebody made by hand, or a file
 * of the same name. There is no flag to force it. The failure this forecloses
 * is the only one that matters here — a button labelled "start a paper"
 * replacing a paper somebody had already started — and a program that can never
 * do it does not need to be careful about when it does.
 *
 * ## What it writes is a document and not a template
 *
 * `\documentclass{article}`, a title taken from the epic, and an empty
 * `document`. It compiles, the reader draws it immediately, and there is
 * nothing in it to delete before writing. A scaffold full of commented-out
 * suggestions would be this app having opinions about somebody's paper.
 */
export function startPaper(epic: string, project: string | null): Started {
  const dir = whereItWouldGo(epic, project)
  if (dir === null) return { ok: false, why: 'There is nowhere to start a paper: no project is open.' }
  if (existsSync(dir)) return { ok: false, why: `There is already something at ${dir}.` }

  try {
    mkdirSync(dir, { recursive: true })
    const main = join(dir, MAIN)
    /* Checked again after the directory exists, for the reason `makeDir` gives
       in the sibling modules: the only honest moment to ask what is at a path
       is once you are standing on it. */
    if (existsSync(main)) return { ok: false, why: `There is already a ${MAIN} at ${dir}.` }
    writeFileSync(
      main,
      [
        '\\documentclass{article}',
        '',
        `\\title{${epic}}`,
        '',
        '\\begin{document}',
        '',
        '\\maketitle',
        '',
        '\\end{document}',
        '',
      ].join('\n'),
      'utf8',
    )
    return { ok: true, dir }
  } catch (error) {
    return { ok: false, why: `That folder could not be made: ${(error as Error).message}` }
  }
}

/**
 * Whether this project has ever been set up for papers.
 *
 * Used for one sentence: "there is no paper for this epic" and "this project
 * keeps no papers" are different things to tell somebody, and an empty list
 * cannot tell them apart.
 *
 * It asks about `.kehikot/paper/` and NOT about `.kehikot/`, and that one
 * character's difference was a real bug. The old version answered true when
 * `.kehikot/` existed at all — which it does in any project where journeys or
 * references has ever saved something — so a project that had never held a
 * paper was told it "keeps papers", and the reader got the terse sentence meant
 * for a project that has papers and none for this epic. It said the wrong one
 * of two sentences whose entire job is to be different.
 */
export function keepsPapers(project: string | null): boolean {
  if (project === null) return false
  try {
    return statSync(papersDir(project)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The one root an epic's paper is in, or null.
 *
 * A helper rather than three copies of `roots(project).find(…)`, because the
 * three readers below must agree about which directory an epic means. Two of
 * them disagreeing would not be a crash: it would be `read_source` opening a
 * file out of one paper while the page beside it renders another, both of them
 * answering confidently.
 *
 * Exported because `git.ts` needs the directory a paper actually IS, and
 * `whereItWouldGo` is deliberately the wrong answer for that: it joins a path
 * without resolving it, because it is about a place that may not exist yet.
 * This one resolves, confines, and answers null for a paper that is not there —
 * which is exactly what something about to run git in a directory has to know.
 */
export function paperRoot(epic: string, project: string | null): string | null {
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

export const MAIN = 'main.tex'

/**
 * Where a paper lives, spelled once, for the sentences that have to say it.
 *
 * Derived from the same `moduleFolder` that builds the real path rather than
 * written out, so a screen cannot end up naming a directory this module does
 * not read. The old sentences said `data/papers/<epic>/main.tex` in four
 * places, and they were the last things still saying it.
 */
export const PAPERS_AT = `${KEHIKOT_DIR}/${moduleFolder(ID)}`

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
  /**
   * What each of those files WAS when this read opened it, as a hash.
   *
   * ## This is the field the write door stands on
   *
   * Every offset in this structure describes the bytes that were on disk at the
   * moment of this read. A page holding this paper and asking to replace bytes
   * 4120–4380 of a chapter is making a claim that is only true of that version
   * of the file, and this is the evidence it sends back to prove which version
   * it meant — see `writeRange`, which refuses when the file no longer hashes
   * to what the caller was given.
   *
   * ## Why a hash and not `sourceLength`
   *
   * `ParsedDocument.sourceLength` exists and its comment says "for staleness
   * checks", and it is not enough. Length is blind to every edit that does not
   * change it, and the edits this module has to survive are exactly those: an
   * author fixing a typo in a real editor, an agent rewriting a sentence, this
   * app's own door writing four characters over four other characters from a
   * second container. Two of those are same-length rewrites almost by
   * construction — a spelling correction usually is — and a length check would
   * wave every one of them through and splice into a file whose bytes had moved
   * underneath the offsets.
   *
   * SHA-256 over the file's bytes, which costs microseconds on the tens of
   * kilobytes a paper actually is, and the collision this would need in order
   * to be wrong is not something a text editor produces by accident.
   *
   * Keyed by the same relative path as `files`, so the two cannot describe
   * different sets, and computed from the bytes as read rather than from the
   * decoded string, so nothing in the round trip through UTF-16 can make a file
   * hash differently here than it does at the door.
   */
  hashes: Record<string, string>
  /** Every `\includegraphics` target the paper names, in document order. */
  figures: string[]
}

/**
 * What a file was, as one comparable string.
 *
 * Spelled once, because the read and the write both compute it and a hash
 * computed two ways is not a check — it is a check that passes until somebody
 * changes one of the two.
 */
function hashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Every epic under the papers directory that actually has a paper.
 *
 * A subdirectory with no `main.tex` is not listed. That is a judgement rather
 * than an oversight: the folder is in somebody's own repository and they move
 * things around in it, and an empty folder left behind by a `git checkout` is
 * not an epic whose paper this app failed to render — it is an epic with no paper, and the
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
        /* Markup reduced to prose so that a title in the picker and the same
           title in the reading view read as one string.

           An approximation of `parseInline`, and knowingly a coarser one than
           it was: the parser learned accent escapes and these four replacements
           did not, so `\title{Tiivistelm\"a}` would now read `Tiivistelmä` in
           the reading column and `Tiivistelm\"a` here. The divergence is left
           standing on purpose. The proper fix is to route this through
           `parseInline` — these regexes already disagree with it about
           citations, refs and comments — but that would change the rendered
           title of every paper on this machine to close a gap no title in the
           corpus falls into, and a picker that silently renames somebody's
           document is a worse surprise than one showing two characters of TeX.
           What it does NOT do is eat the accent, which is the property that
           matters: whoever meets it can see what happened. The first accented
           title in this corpus is the moment to do it properly here, rather
           than to add a fifth regex. */
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
  const root = paperRoot(epic, project)
  if (!root) return null
  const main = confine(root, MAIN)
  if (!main || !existsSync(main)) return null

  let source: string
  const hashes: Record<string, string> = {}
  try {
    if (statSync(main).size > MAX_TEX_BYTES) return null
    /* The bytes, hashed, and only then decoded. Reading the string and encoding
       it again to hash it would be a hash of what this program made of the file
       rather than of the file, and the two differ for anything that is not
       valid UTF-8 — which would then hash differently at the write door and
       refuse an edit for a reason nobody could see. */
    const bytes = readFileSync(main)
    hashes[MAIN] = hashOf(bytes)
    source = bytes.toString('utf8')
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
        if (statSync(child).size <= MAX_TEX_BYTES) {
          const bytes = readFileSync(child)
          chapter = parseLatex(bytes.toString('utf8'), relative, macros)
          hashes[relative] = hashOf(bytes)
        }
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

  /*
   * Every `\ref` and every `\cite` in the paper, rewritten from its placeholder
   * into what the PDF prints.
   *
   * Here and nowhere else, and this is the one place it CAN be: the parser
   * emits `§ch:conclusion` and `[vanlehn2011relative]` because a single file
   * cannot know what chapter number a label in another file has, or what a key
   * means without the bibliography — see the essay on `Segment.note`. By this
   * line every chapter has been folded into reading order above, which is
   * exactly the knowledge a label index needs, and `root` is where the `.bib`
   * the preamble names can be opened. The same argument that expands
   * `\include` on this side rather than in the browser applies with more
   * force: a number assembled in two places is two numbers.
   *
   * The door gets the same rewriting for free. `read_paper` renders these
   * segments' text, so an agent reading the paper now reads "Chapter 6" and
   * "(VanLehn, 2011)" where it used to read markers — which is what the prose
   * says, and what a proposal about that prose has to quote.
   */
  const labels = buildLabelIndex(blocks)
  const bibliography = readBibliography(root, source)
  for (let i = 0; i < blocks.length; i++) {
    blocks[i] = mapSegments(blocks[i]!, (segment) => resolveCite(resolveRef(segment, labels), bibliography))
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
    hashes,
    figures,
  }
}

/**
 * What every file of a paper IS right now, as hashes and nothing else.
 *
 * ## Why this exists beside `readPaper`, which already answers it
 *
 * `readPaper` hands out `hashes` and could be called for them. It also parses
 * every chapter, builds the label index and opens the bibliography, which is
 * the right price for a paper somebody is about to read and the wrong price
 * for a question asked every four seconds by every open page: "has anything I
 * am showing moved on disk?" That question is answered by the bytes alone.
 * So this reads the bytes, hashes them, and parses only `main.tex` — the one
 * file that has to be parsed to know which other files the paper is made of.
 *
 * ## The same keys, by construction
 *
 * The page compares this answer against `Paper.hashes` file by file, so the
 * two have to agree about which files a paper has: a file present in one and
 * absent from the other would read as a change that never happened. The loop
 * below is the same walk `readPaper` makes — `main.tex`, then each `\include`
 * target that resolves inside the root, exists and is under the size bound —
 * with the parse of the chapter left out. A chapter whose bytes cannot be
 * read is absent here as it is there.
 *
 * `null` when there is no paper at all, which the page reads as "every file I
 * hold has gone" only after it has failed to fetch the paper again; it is not
 * an error and it is not a change to draw.
 */
export function hashesOf(epic: string, project: string | null): Record<string, string> | null {
  if (!isEpic(epic)) return null
  const root = paperRoot(epic, project)
  if (!root) return null
  const main = confine(root, MAIN)
  if (!main || !existsSync(main)) return null

  const hashes: Record<string, string> = {}
  let source: string
  try {
    if (statSync(main).size > MAX_TEX_BYTES) return null
    const bytes = readFileSync(main)
    hashes[MAIN] = hashOf(bytes)
    source = bytes.toString('utf8')
  } catch {
    return null
  }
  for (const target of includeTargets(source)) {
    const relative = target.endsWith('.tex') ? target : `${target}.tex`
    const child = confine(root, relative)
    if (!child || !existsSync(child)) continue
    try {
      if (statSync(child).size > MAX_TEX_BYTES) continue
      hashes[relative] = hashOf(readFileSync(child))
    } catch {
      continue
    }
  }
  return hashes
}

/**
 * The bibliography a paper names, opened and parsed.
 *
 * Only the files the preamble names — `\addbibresource{references.bib}` in
 * this thesis — and each one confined to the paper's root, so a preamble that
 * said `\addbibresource{../../.ssh/config}` would get no bibliography rather
 * than a parse of somebody's keys. That is the `figures` rule again: what the
 * paper names is what this reads, and a `.bib` merely lying beside `main.tex`
 * is not the paper's bibliography.
 *
 * A file that is named and not there is simply absent from `files`, and the
 * citations then say "no entry in" whatever WAS read — or, when nothing was,
 * that the paper names no bibliography. The two sentences are different faults
 * and are kept apart on purpose; see `Bibliography`.
 *
 * Read on every `readPaper`, like everything else here: no cache, so a key
 * added to the `.bib` a moment ago resolves on the next read. It is eighteen
 * kilobytes on the real thesis and the parse is linear.
 */
function readBibliography(root: string, source: string): Bibliography {
  const files: string[] = []
  const entries = new Map(NO_BIBLIOGRAPHY.entries)
  for (const named of bibFilesNamed(source)) {
    const path = confine(root, named)
    if (!path || !existsSync(path)) continue
    try {
      if (statSync(path).size > MAX_TEX_BYTES) continue
      /* First file wins for a key two files both define, which is what BibTeX
         does — it warns and keeps the first. Preferring the later one would
         silently hide the collision. */
      for (const [key, entry] of parseBib(readFileSync(path, 'utf8'))) if (!entries.has(key)) entries.set(key, entry)
      files.push(named)
    } catch {
      continue
    }
  }
  return files.length ? { entries, files } : NO_BIBLIOGRAPHY
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
  const root = paperRoot(epic, project)
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
  const root = paperRoot(epic, project)
  if (!root) return null
  const path = confine(root, file)
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** One replacement asked for: which file, which bytes, what goes there. */
export interface Edit {
  /** Relative to the paper's root, and it must be a file the paper names. */
  file: string
  /** Byte offsets into that file. `from === to` is an insertion. */
  from: number
  to: number
  /** What goes there. Empty is a deletion, which is an ordinary edit. */
  text: string
  /** What the caller believed that file was — `Paper.hashes[file]`. */
  was: string
}

export type Written =
  | { ok: true; bytes: number; hash: string }
  /**
   * A refusal, with `stale` set when the reason was that the file moved.
   *
   * The flag is not decoration: staleness is the one refusal the page must ACT
   * on rather than only report. Every other refusal here means "that edit was
   * not allowed" and the paper on screen is still right; stale means the paper
   * on screen is out of date, so the page has to re-read before it draws
   * anything else. One boolean is cheaper and steadier than parsing a sentence.
   */
  | { ok: false; why: string; stale: boolean }

/**
 * Replace one byte range in one file of one paper.
 *
 * ## The narrowest write that answers the question
 *
 * One file, one contiguous range, one replacement, and no way to name a second.
 * There is no create, no delete, no rename and no move. The reason is the one
 * `startPaper` gives for having no force flag: a door that cannot do a thing
 * does not have to be careful about when it does it, and the things ruled out
 * here are the ones with no undo.
 *
 * ## Concurrency, which is the part that can destroy work
 *
 * Nothing in this module is cached, on purpose, because a paper is being edited
 * WHILE this is running — the author may be in a real editor, an agent may be
 * rewriting a chapter, and a second container may be sending an edit of its
 * own. That is stated at the top of this file as a virtue of the READS, and it
 * is the whole hazard of the writes: every offset a caller holds was derived
 * from a version of the file, and applying it to a different version does not
 * fail. It succeeds, splicing text into the middle of a sentence somebody else
 * wrote, and the reader watching this app sees a paragraph that has gone subtly
 * wrong with nothing on screen saying why.
 *
 * So an edit carries `was`, the hash of the file as the caller last read it —
 * `Paper.hashes[file]`, handed out by `readPaper` — and this re-reads and
 * compares before it touches anything. A different hash means no write and a
 * sentence saying the file moved.
 *
 * The check is deliberately over the WHOLE FILE and not over the replaced
 * range. Range-local checking — "are the bytes I am about to replace still the
 * bytes I saw?" — is the guard the program this was extracted from had
 * (`expectedText`), it is cheaper, and it is not enough: an edit ABOVE the
 * range shifts everything below it, so the old offsets now name different text
 * which may happen to match the quote, and even when it does not, an edit whose
 * offsets are stale is an edit in the wrong place. The hash asks the only
 * question with a safe answer: is this the document those offsets were measured
 * against?
 *
 * The cost is stated rather than hidden: a paper being written in an editor
 * with autosave will refuse edits from this page until the page re-reads. That
 * is the correct trade, it costs one round trip to recover from, and the
 * alternative is a corruption nobody notices for a week.
 *
 * ## The ends have to be real places in a real file
 *
 * `from` and `to` are bytes and they arrive over the wire. They are checked to
 * be whole numbers, in order, inside the file, and on UTF-8 character
 * boundaries — see `onBoundary`. That last one is not paranoia: a cut through
 * the middle of an `ä` writes two half-characters into a file that had none,
 * and this codebase has already lost a bug to characters and bytes being
 * confused for one another (`inBytes`, in the parser).
 *
 * ## And what may be written is not "anything"
 *
 * `whyNot` in `latex/edit.ts` holds that rule, along with the argument for
 * refusing LaTeX's special characters rather than escaping them. It is applied
 * here as well as in the browser, because the browser is one caller of three
 * and the other two were never asked to be polite.
 *
 * ## Written by rename, so a failure leaves the old file standing
 *
 * `writeFileSync` truncates and then writes, so a process killed between the
 * two leaves an empty or half-written thesis. The bytes go to a temporary file
 * beside the real one and are renamed over it, which is atomic within a
 * filesystem: either the whole new file is there or the whole old one is. The
 * mode is copied across, so a file somebody had made read-only for themselves
 * does not come back wearing this process's umask.
 *
 * ## And it looks at what it is about to overwrite
 *
 * `sourceRefuses` is the one check here that does not take the caller's word
 * for anything. Every edit this feature legitimately makes replaces the inside
 * of a literal run — which holds no LaTeX special character, because the parser
 * breaks a literal run at every one of them — or a run of whitespace. So a
 * range whose bytes contain a `\`, a `{`, a `%` or an `&` is not an edit this
 * page could honestly have composed, whatever it says about itself.
 *
 * That is what stops a bug in the browser, an agent that guessed, or a replayed
 * request with the numbers changed from deleting a command, a citation, an
 * escape or a comment. The page decides what to write from the pieces it holds;
 * this decides whether the file agrees.
 */
export function writeRange(epic: string, edit: Edit, project: string | null): Written {
  const no = (why: string, stale = false): Written => ({ ok: false, why, stale })

  if (!isEpic(epic)) return no('That is not an epic name.')
  const paper = readPaper(epic, project)
  if (!paper) return no('There is no paper for that epic in this project.')
  /* The rule `readSource` applies, for the reason it gives: a check against the
     filesystem would let a caller name any `.tex` under the epic's directory,
     so "correct the paper" would quietly become "write to whatever is lying
     around beside it". A file the paper does not include is not the paper. */
  if (!paper.files.includes(edit.file)) {
    return no(`This paper does not name a file called “${edit.file}”. It is made of: ${paper.files.join(', ')}`)
  }
  const root = paperRoot(epic, project)
  if (!root) return no('There is no paper for that epic in this project.')
  const path = confine(root, edit.file)
  if (!path) return no('That file is not inside this paper.')

  /* It never creates, and this is where that is enforced. `existsSync` alone
     would not be the check: a directory exists too, and `writeFileSync` onto
     one throws out of a request handler rather than answering. */
  let bytes: Buffer
  try {
    const found = statSync(path)
    if (!found.isFile()) return no('That is not a file.')
    if (found.size > MAX_TEX_BYTES) return no('That file is too large for this program to rewrite.')
    bytes = readFileSync(path)
  } catch {
    /* Undifferentiated, like every other refusal in this file: "it is not
       there", "it cannot be read" and "it is not a file" told apart is a way of
       asking this door what exists. */
    return no('That file could not be read.')
  }

  if (typeof edit.was !== 'string' || edit.was.length === 0) {
    return no('An edit has to say which version of the file it was measured against.', true)
  }
  if (hashOf(bytes) !== edit.was) {
    return no(
      `${edit.file} has changed since this page read it, so those byte offsets no longer describe it. Nothing was `
        + 'written.',
      true,
    )
  }

  const { from, to, text } = edit
  if (!Number.isInteger(from) || !Number.isInteger(to)) return no('That is not a byte range.')
  if (from < 0 || to < from || to > bytes.length) return no('That range is not inside the file.')
  if (!onBoundary(bytes, from) || !onBoundary(bytes, to)) {
    return no('That range cuts a character in half, so it does not name a place in this file.')
  }
  if (typeof text !== 'string') return no('There is nothing to write there.')
  const refused = whyNot(text)
  if (refused) return no(refused)
  /* What is THERE, not only what is being put there. See the essay above: this
     is the check that does not take the caller's word for anything. */
  const covered = sourceRefuses(bytes.subarray(from, to).toString('utf8'))
  if (covered) return no(covered)

  const replacement = Buffer.from(text, 'utf8')
  /* A no-op is refused rather than performed. Writing identical bytes moves the
     file's mtime, wakes every watcher on it, and invalidates the hash every
     other reader of this paper is holding, in order to change nothing. */
  if (bytes.subarray(from, to).equals(replacement)) return no('That edit changes nothing.')

  const next = Buffer.concat([bytes.subarray(0, from), replacement, bytes.subarray(to)])

  /* Beside the file rather than under `/tmp`, because a rename is only atomic
     within one filesystem and a paper's folder may be on a different one. The
     name carries this process's pid and a random tail so that two writers
     cannot choose the same scratch file. */
  const scratch = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    writeFileSync(scratch, next, { mode: statSync(path).mode })
    renameSync(scratch, path)
  } catch (error) {
    /* The real file is untouched on either failure — that is what the temporary
       is for — so all that is left is not to litter. */
    try {
      rmSync(scratch, { force: true })
    } catch {
      /* Nothing to do and nothing to say: the edit has already failed, and a
         leftover `.tmp` is not the thing the person needs to hear about. */
    }
    return no(`That could not be written: ${(error as Error).message}`)
  }

  return { ok: true, bytes: next.length, hash: hashOf(next) }
}
