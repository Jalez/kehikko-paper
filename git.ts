import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * The paper's own history, and the one thing this module must never do to it.
 *
 * ## What this is for
 *
 * A paper is a `.tex` file in somebody's repository, and `store.ts` says at the
 * top that the worst thing this app could do is become a second place where one
 * lives. That argument is about STORAGE, and it is still right. This file is
 * the other half of it: if the paper's history is the real one, then a change
 * this app makes to the paper belongs IN that history, made where the paper is,
 * rather than as an untracked diff somebody finds later and cannot attribute.
 *
 * So: a suggestion accepted here makes one commit, and pressing Save makes one
 * commit for whatever has changed since the last. Nothing else here commits.
 *
 * ## The repository is somebody else's, and it is not the paper's
 *
 * This is the fact the whole file is shaped around. A paper lives at
 * `<project>/.kehikot/paper/<epic>/`, and the project is very often NOT the
 * root of a repository — the thesis this was written against sits several
 * levels inside a repository that also holds coursework, notes and scripts. A
 * commit made here therefore lands in a repository full of work that has
 * nothing to do with the paper, next to whatever its owner had half-finished at
 * the moment they accepted a typo fix.
 *
 * Two rules follow, and they are the only two rules in this file that are not
 * negotiable.
 *
 * **1. It commits by PATH, and the paths are always inside the paper.** Every
 * invocation ends in `-- :(literal,top)<the paper's directory>`, which is git's
 * "commit the contents of these paths" mode. In that mode git builds the commit
 * from HEAD plus the working-tree state of the named paths, and what is staged
 * ANYWHERE ELSE is not consulted and not recorded. Measured against a
 * repository with an unrelated file staged: the commit contained one file, and
 * `git status` afterwards still showed the unrelated file staged and
 * uncommitted, exactly as it was. `:(literal,…)` turns off pathspec globbing so
 * a directory with a `*` or a `!` in its name is a directory and not a pattern;
 * `:(top)` makes it relative to the repository root rather than to whatever
 * directory git was invoked from.
 *
 * `git add` is run first, and it is run with the SAME pathspec, for one reason:
 * a paper that has never been committed is untracked, and pathspec-mode commit
 * refuses an untracked path with "no changes added to commit". Staging by
 * explicit path can only ever stage what is under the paper's own directory. It
 * is never `git add -A`, never `git add .`, and never a path this module did
 * not compute itself from the epic and the project.
 *
 * **2. It refuses rather than guesses.** Detached HEAD, a merge or rebase in
 * progress, no identity configured, no repository at all, a paper the
 * repository is told to ignore — each is a state where a commit made by a
 * program is a commit somebody has to undo. Each one answers with a sentence
 * naming the thing to do about it.
 *
 * ## What it will never do
 *
 * No push. No fetch. No branch created, switched or deleted. No `--amend`, no
 * `--force`, no rebase, no reset, no stash, no tag. No `commit -a`. Nothing
 * that reads or writes a second repository. "The current branch" means whatever
 * branch is checked out, and this file contains no code that could change which
 * one that is.
 *
 * ## The bytes are already written before anything here runs
 *
 * `writeRange` renames the new file over the old one and returns. Only then is
 * a commit attempted. That ordering is deliberate and it is the answer to the
 * one failure that would be unforgivable in the other direction: a commit that
 * refuses must never be able to lose an edit. It cannot, because the edit is on
 * disk and this never touches the working tree — the worst a refusal here can
 * do is leave a correct file uncommitted, and say so.
 *
 * ## Hooks are the repository's own, and they are not bypassed
 *
 * No `--no-verify`. A repository with a pre-commit hook has one because its
 * owner wanted one, and a program that quietly skipped it would be writing
 * commits that break their own rules. The cost is that a hook which fails takes
 * the commit with it — and that is reported with the hook's own message, over a
 * paper that is already correct on disk. The same goes for signing: if
 * `commit.gpgsign` is set, this signs, and a signature that cannot be made is a
 * refusal rather than an unsigned commit slipped past a policy.
 */

/** How long any one git invocation may take before it is given up on. */
const TIMEOUT_MS = 15_000

/** The most of an agent's sentence that goes into a commit body. */
const MAX_WHY = 600

/** The most of an agent's name that goes into a trailer. */
const MAX_BY = 120

/**
 * What the paper's directory looks like to git right now.
 *
 * Three answers and not two, for the reason `/api/papers` gives about its own
 * three fields: "there is nothing to commit" and "this cannot be committed at
 * all" are different sentences, the Save button draws a different state for
 * each, and collapsing them would tell somebody their work was saved when the
 * repository had refused to have it.
 */
export type Standing =
  /** A commit here would work, and these are the paths it would carry. */
  | { at: 'ready'; files: string[] }
  /** Nothing has changed under the paper since the last commit. Not an error. */
  | { at: 'clean' }
  /**
   * There is no repository here at all, which is not a fault and not a refusal.
   *
   * Told apart from `refused` deliberately, and the difference is what a reader
   * sees. A paper in a plain folder is a perfectly ordinary way to use this
   * module — it was the only way until this feature — and a page that answered
   * every accepted suggestion with "this could not be committed" would be
   * reporting the ABSENCE of a feature as a failure, once per typo, forever. So
   * this state draws no Save button and says nothing. `refused` is the other
   * thing: there IS a repository, it is the right one, and something about its
   * current state means a commit would be wrong — which a person must be told.
   */
  | { at: 'nogit' }
  /** Committing is not possible, and `why` is a sentence a person can act on. */
  | { at: 'refused'; why: string }

/** What happened when a commit was attempted. */
export type Committed =
  | { at: 'committed'; sha: string; files: string[] }
  | { at: 'clean' }
  | { at: 'nogit' }
  | { at: 'refused'; why: string }

interface Ran {
  ok: boolean
  out: string
  err: string
}

/**
 * One git invocation, with no shell and no way for a path to become a flag.
 *
 * `spawnSync` with an argument array, so nothing here is parsed by `sh` and a
 * directory called `; rm -rf ~` is a directory. Every pathspec is preceded by
 * `--` at the call site, so a path can never be read as an option either.
 *
 * The environment is trimmed rather than inherited whole:
 *
 *  - `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS`/`SSH_ASKPASS` emptied, because a
 *    git that asks for a passphrase inside a request handler is a request that
 *    never answers. Nothing here talks to a remote, but a signing key can ask.
 *  - `GIT_OPTIONAL_LOCKS=0` on the reads, so asking what has changed cannot
 *    take the index lock out from under an editor the person is working in.
 *  - `GIT_PAGER=cat`, for the same reason every script sets it.
 *  - `GIT_DIR` and `GIT_WORK_TREE` are REMOVED. This process may have been
 *    started from inside another repository — it usually is, in development —
 *    and an inherited `GIT_DIR` would silently redirect every command in this
 *    file at that one. That is the only way anything here could touch a
 *    repository other than the paper's, and it is closed at the source.
 */
function run(dir: string, args: string[], locks: boolean): Ran {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_COMMON_DIR
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = ''
  env.SSH_ASKPASS = ''
  env.GIT_PAGER = 'cat'
  if (!locks) env.GIT_OPTIONAL_LOCKS = '0'

  const result = spawnSync('git', args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) return { ok: false, out: '', err: result.error.message }
  return {
    ok: result.status === 0,
    /* Trailing whitespace only, and this is not a nicety. `git status
       --porcelain` puts the two status letters in columns one and two, and an
       unstaged modification leaves column one BLANK — so a full `trim()` eats
       that leading space and every path afterwards is short by a character.
       That was a real bug, caught by a test asserting a filename. */
    out: (result.stdout ?? '').replace(/\s+$/, ''),
    err: (result.stderr ?? '').trim(),
  }
}

/**
 * The repository the paper is in, and the pathspec naming the paper inside it.
 *
 * `--show-toplevel` from the paper's own directory, so this is the repository
 * that actually contains the file — not one guessed from the project path, and
 * not one inherited from wherever this process was started. In a submodule it
 * answers the submodule, which is correct: that is where those bytes have their
 * history.
 */
function repoOf(dir: string, only?: readonly string[]): { root: string; specs: string[] } | null {
  const top = run(dir, ['rev-parse', '--show-toplevel'], false)
  if (!top.ok || !top.out) return null
  const root = top.out

  /* Every pathspec starts life as an absolute path under the paper's directory
     and is then made relative to the repository root, so a `..` anywhere in a
     caller's file name shows up as a relative path that climbs out — and is
     refused, rather than silently naming something beside the paper. */
  const spec = (path: string): string | null => {
    const rel = relative(root, path)
    /* An empty relative path would mean this IS the repository root, and the
       pathspec would then be the whole repository — the one thing this file
       exists to make impossible. It cannot happen for a paper, which is always
       `<project>/.kehikot/paper/<epic>/` and therefore four segments deep; it is
       checked anyway, because "it cannot happen" is how a whole-repository
       commit gets written. */
    if (!rel || rel === '.' || rel.startsWith('..')) return null
    return `:(literal,top)${rel.split('\\').join('/')}`
  }

  const whole = spec(dir)
  if (!whole) return null
  if (!only || only.length === 0) return { root, specs: [whole] }

  const narrowed: string[] = []
  for (const file of only) {
    const one = spec(resolve(dir, file))
    /* A named file that does not resolve under the paper falls back to nothing
       rather than to the whole paper. Refusing to commit is a state this module
       already handles; committing more than was asked for is not. */
    if (!one || !one.startsWith(whole)) return null
    narrowed.push(one)
  }
  return { root, specs: narrowed }
}

/**
 * Every reason this repository is not one to commit into right now.
 *
 * Each refusal is a sentence with the action in it, because a person reading it
 * is standing in front of a Save button that did not work and the useful thing
 * to tell them is what to do, not what happened.
 */
function refusal(dir: string, root: string): string | null {
  /* Detached HEAD. `symbolic-ref` is the check rather than `rev-parse
     --abbrev-ref`, because it also answers correctly in a repository with no
     commits yet — where HEAD points at a branch that does not exist, which is
     an ordinary state and NOT a refusal: the commit made there is simply the
     first one on that branch. */
  const head = run(dir, ['symbolic-ref', '--quiet', 'HEAD'], false)
  if (!head.ok) {
    const at = run(dir, ['rev-parse', '--short', 'HEAD'], false)
    return (
      `This repository is not on a branch — HEAD is detached${at.ok && at.out ? ` at ${at.out}` : ''}. `
      + 'Check out a branch and this will be committed to it.'
    )
  }

  /* Something half-finished. Committing into the middle of a merge or a rebase
     would either become the merge commit itself or land on a temporary head
     that the operation is about to throw away — and in both cases the change is
     somewhere its author will not look for it. */
  const gitDir = run(dir, ['rev-parse', '--absolute-git-dir'], false)
  if (gitDir.ok && gitDir.out) {
    const midway: [string, string][] = [
      ['MERGE_HEAD', 'A merge'],
      ['rebase-merge', 'A rebase'],
      ['rebase-apply', 'A rebase'],
      ['CHERRY_PICK_HEAD', 'A cherry-pick'],
      ['REVERT_HEAD', 'A revert'],
      ['BISECT_LOG', 'A bisect'],
    ]
    for (const [entry, name] of midway) {
      if (existsIn(gitDir.out, entry)) {
        return `${name} is in progress in this repository. Finish it or abort it, and this will be committed.`
      }
    }
  }

  /* An identity, and it must be CONFIGURED rather than guessed. Git will happily
     invent `someone@their-laptop.local` from the login name and the hostname
     when `user.email` is unset, and a commit in somebody's thesis attributed to
     an address that does not exist is worse than no commit: it is a wrong
     answer to "who wrote this", written into a history that keeps it. */
  const name = run(dir, ['config', '--get', 'user.name'], false)
  const email = run(dir, ['config', '--get', 'user.email'], false)
  const missing = [!name.ok || !name.out ? 'user.name' : null, !email.ok || !email.out ? 'user.email' : null]
    .filter((one): one is string => one !== null)
  if (missing.length) {
    return (
      `This repository has no ${missing.join(' and no ')} set, so git cannot record who made the change. `
      + `Set it — for example \`git -C ${root} config user.email you@example.com\` — and this will be committed.`
    )
  }

  /* A paper the repository is told to ignore. Without this check the answer
     would be "nothing to commit", which is true of the index and a lie about
     the paper: the file changed, and it is never going to appear in a commit. */
  const ignored = run(dir, ['check-ignore', '--quiet', '--', '.'], false)
  if (ignored.ok) {
    return (
      `${dir} is ignored by git in this repository, so changes to this paper cannot be committed. `
      + 'A `.gitignore` rule covers it — the usual one is `.kehikot/`.'
    )
  }

  return null
}

/**
 * Whether a marker exists inside the git directory.
 *
 * `node:fs` rather than a git command, because these are the entries git itself
 * documents as the markers for an operation in progress, and asking git would
 * be six more processes for a question the filesystem answers once.
 */
function existsIn(gitDir: string, entry: string): boolean {
  return existsSync(join(gitDir, entry))
}

/**
 * What committing this paper would do, without doing any of it.
 *
 * This is what the Save button reads. It runs on the poll beside the proposal
 * list, so it must be cheap and must never take a lock — see `run`.
 */
export function standing(dir: string | null, only?: readonly string[]): Standing {
  if (!dir) return { at: 'nogit' }
  const repo = repoOf(dir, only)
  if (!repo) return { at: 'nogit' }
  const no = refusal(dir, repo.root)
  if (no) return { at: 'refused', why: no }

  const changed = run(dir, ['status', '--porcelain', '-z', '--', ...repo.specs], false)
  if (!changed.ok) {
    return { at: 'refused', why: `git could not say what has changed here: ${firstLine(changed.err)}` }
  }
  const files = namesIn(changed.out)
  return files.length ? { at: 'ready', files } : { at: 'clean' }
}

/**
 * Commit whatever has changed under the paper, as one commit, on this branch.
 *
 * `subject` and `body` are composed by the caller — see `doors.ts`, which has
 * the two shapes and the argument for what each one records.
 *
 * Nothing to commit is not an error and never was: accepting a change that
 * produces bytes identical to the ones already there, or pressing Save with
 * nothing changed, answers `clean` and does nothing.
 */
export function commitPaper(
  dir: string | null,
  subject: string,
  body: string,
  only?: readonly string[],
): Committed {
  const where = standing(dir, only)
  if (where.at !== 'ready') return where
  /* `standing` has already answered `nogit` for both of these; they are here so
     the types are narrowed by the code rather than by a comment. */
  if (!dir) return { at: 'nogit' }
  const repo = repoOf(dir, only)
  if (!repo) return { at: 'nogit' }

  /* Staged by the paper's own pathspec and nothing else. See the essay: this is
     here for the untracked case, which pathspec-mode commit refuses on its own,
     and it can reach nothing outside the paper's directory. */
  const staged = run(dir, ['add', '--', ...repo.specs], true)
  if (!staged.ok) {
    return { at: 'refused', why: `git would not stage this paper's files: ${firstLine(staged.err)}` }
  }

  const message = body ? `${subject}\n\n${body}` : subject
  /*
   * `--cleanup=whitespace` and not the default.
   *
   * The default is `strip`, which deletes every line beginning with `#`. The
   * body of one of these commits is a sentence an agent wrote, and a sentence
   * beginning with a `#` — a section number, a channel, a LaTeX comment being
   * discussed — would silently become an empty commit body. Whitespace cleanup
   * still trims the blank lines and leaves the words alone.
   *
   * `--only` is implied by the pathspec and is written out anyway, because it
   * is the flag that says what this whole file is about and a reader should not
   * have to know that a trailing pathspec implies it.
   */
  const made = run(dir, ['commit', '--only', '--cleanup=whitespace', '-m', message, '--', ...repo.specs], true)
  if (!made.ok) {
    return {
      at: 'refused',
      why:
        `The change is written to the file, but git would not commit it: ${firstLine(made.err) || firstLine(made.out)}`,
    }
  }
  const sha = run(dir, ['rev-parse', '--short', 'HEAD'], false)
  return { at: 'committed', sha: sha.ok ? sha.out : '', files: where.files }
}

/**
 * The paths out of `git status --porcelain -z`.
 *
 * `-z` because a `.tex` file with a space or a quote in its name comes back
 * quoted and escaped in the ordinary format, and unquoting that correctly is a
 * parser nobody should write twice. NUL-separated records need no unquoting at
 * all.
 *
 * A rename emits two records — the new path then the old — and this keeps both
 * rather than trying to pair them: the list is shown to a person and counted,
 * and an extra path in a display is a smaller wrong than a dropped one.
 */
function namesIn(out: string): string[] {
  return out
    .split('\0')
    .map((record) => (record.length > 3 ? record.slice(3) : ''))
    .filter((one) => one.length > 0)
}

/** The first line of git's complaint, bounded, because it goes on a page. */
function firstLine(text: string): string {
  const line = text.split('\n').find((one) => one.trim().length > 0) ?? ''
  return line.trim().slice(0, 300)
}

/**
 * A commit message for a suggestion somebody accepted.
 *
 * ## Who it says made this change
 *
 * The AUTHOR is the person, by not being set at all: git uses the repository's
 * configured `user.name` and `user.email`, which is why those being unset is a
 * refusal rather than something to work around. That is the honest reading of
 * what happened. An agent WROTE the words; it could not put them in the file,
 * and the thing that changed the paper was a person deciding to. A commit is a
 * record of a change to a repository, and the person who made that change is
 * the person who pressed Accept.
 *
 * `--author` naming the agent was considered and refused. It would attribute a
 * decision the agent is deliberately unable to make — the whole point of
 * `propose_edit` not writing — to the agent, and it would put a fabricated
 * email address in somebody's history, since `by` is free text an agent chose
 * for itself and is trusted for nothing.
 *
 * So the proposer is recorded as a TRAILER instead. `Proposed-by:` and not
 * `Co-authored-by:`, deliberately: `Co-authored-by` is parsed by git and by
 * forges, which expect `Name <email>` and will attach the commit to whatever
 * account that address belongs to. Handing that mechanism a string an agent
 * made up is how somebody else's face ends up on a commit they never saw.
 * `Proposed-by:` is a plain trailer, read by people.
 *
 * The `why` sentence goes in the body, which is the one place a reader of the
 * history will look for the reason. It is the agent's own words, bounded and
 * flattened, and it is never trusted for anything but being displayed.
 */
export function acceptMessage(file: string, why: string, by: string): { subject: string; body: string } {
  const who = oneLine(by, MAX_BY)
  const reason = oneLine(why, MAX_WHY)
  /*
   * `by` is what the proposal carries, and today it is always the string
   * `propose_edit` fills in, because that tool takes no argument for it: this
   * module genuinely does not know which agent on the canvas made a suggestion.
   * The trailer says what is known rather than more than that. If the tool ever
   * grows a `by` argument, this line already carries it — and the reason it
   * would still not be a `Co-authored-by` is two paragraphs up.
   */
  const trailer = `Proposed-by: ${who || 'an agent that did not say who it was'}`
  return {
    subject: `Accept a suggested change in ${oneLine(file, 120)}`,
    /* The reason, a blank line, then the trailer — the shape git itself expects,
       so `git interpret-trailers` and every tool built on it find it. A proposal
       with no sentence in it leaves the body as the trailer alone rather than as
       a blank line followed by one. */
    body: reason ? `${reason}\n\n${trailer}` : trailer,
  }
}

/**
 * A commit message for Save.
 *
 * It says what a person did — pressed Save — and lists what was in it, and it
 * deliberately claims nothing about WHERE the changes came from. Save commits
 * whatever has changed under the paper since the last commit, and some of that
 * may have been typed in this reader while some of it was typed in the author's
 * real editor with the file open beside this page. A subject saying "typed in
 * the reader" would be a guess this program cannot check.
 */
export function saveMessage(epic: string, files: string[]): { subject: string; body: string } {
  if (files.length === 1) return { subject: `Save ${oneLine(files[0] ?? '', 120)}`, body: '' }
  return {
    subject: `Save the ${oneLine(epic, 80)} paper`,
    body: ['Changed since the last commit:', '', ...files.map((one) => `  ${oneLine(one, 200)}`)].join('\n'),
  }
}

/**
 * Free text from an agent, made safe to put in a commit message.
 *
 * Control characters out, newlines collapsed to spaces, bounded. A commit
 * message is not a security boundary and this is not pretending to be one — it
 * is that a trailer has to be one line to be a trailer, and that a subject with
 * a carriage return in it makes `git log --oneline` print something a person
 * cannot read.
 */
function oneLine(text: string, max: number): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/* ------------------------------------------------------------------ *
 * Git's own layers as the baseline of a review
 *
 * A change is reviewable when the working file differs from what the author
 * last ACCEPTED, and where there is a repository git already keeps exactly that
 * in two places: the index (what has been staged) and HEAD (what is committed).
 * The baseline of a file is its content in the index, or in HEAD when the
 * index has none. Accepting a change stages it — `hash-object -w` and
 * `update-index --cacheinfo`, no patch machinery — and committing commits what
 * was staged. Everything below is argv, no shell, the same trimmed
 * environment as `run`, and never `add -A`.
 * ------------------------------------------------------------------ */

interface RanRaw {
  ok: boolean
  out: Buffer
  err: string
}

function runRaw(dir: string, args: string[], options: { input?: Buffer | string; env?: Record<string, string> } = {}): RanRaw {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  delete env.GIT_COMMON_DIR
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = ''
  env.SSH_ASKPASS = ''
  env.GIT_PAGER = 'cat'
  Object.assign(env, options.env ?? {})
  const result = spawnSync('git', args, {
    cwd: dir,
    env: env as NodeJS.ProcessEnv,
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
  if (result.error) return { ok: false, out: Buffer.alloc(0), err: result.error.message }
  return { ok: result.status === 0, out: Buffer.from(result.stdout ?? ''), err: (result.stderr ?? '').toString().trim() }
}

export interface IndexEntry {
  mode: string
  sha: string
}

/** What git says about the files under one paper's directory right now. All paths are relative to that directory. */
export interface GitView {
  /** The paper's directory relative to the repository root, with a trailing slash ("" at the root). */
  prefix: string
  index: Map<string, IndexEntry>
  head: Map<string, IndexEntry>
  /** In neither, and not ignored. */
  untracked: Set<string>
  /** Mid-merge: no baseline is claimed for these. */
  unmerged: Set<string>
  /** What git is in the middle of ("a merge", "a rebase", …), or null. Paper stages and restores nothing meanwhile. */
  operation: string | null
}

const blobs = new Map<string, string>()

/**
 * The repository's view of a paper's directory, or null when there is none to
 * compare with: no work tree, git missing, or the paper's folder ignored.
 */
export function gitView(dir: string): GitView | null {
  const inside = runRaw(dir, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.toString().trim() !== 'true') return null
  if (runRaw(dir, ['check-ignore', '--quiet', '--', '.']).ok) return null
  const prefix = runRaw(dir, ['rev-parse', '--show-prefix'])
  if (!prefix.ok) return null
  const index = new Map<string, IndexEntry>()
  const unmerged = new Set<string>()
  const staged = runRaw(dir, ['ls-files', '-s', '-z'])
  if (!staged.ok) return null
  for (const record of staged.out.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, sha, stage] = record.slice(0, tab).split(' ') as [string, string, string]
    const path = record.slice(tab + 1)
    if (stage !== '0') unmerged.add(path)
    else index.set(path, { mode, sha })
  }
  const head = new Map<string, IndexEntry>()
  const tree = runRaw(dir, ['ls-tree', '-r', '-z', 'HEAD'])
  if (tree.ok) {
    for (const record of tree.out.toString('utf8').split('\0')) {
      const tab = record.indexOf('\t')
      if (tab === -1) continue
      const [mode, type, sha] = record.slice(0, tab).split(' ') as [string, string, string]
      if (type === 'blob') head.set(record.slice(tab + 1), { mode, sha })
    }
  }
  const untracked = new Set<string>()
  const other = runRaw(dir, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (other.ok) for (const path of other.out.toString('utf8').split('\0')) if (path) untracked.add(path)
  return { prefix: prefix.out.toString().trim(), index, head, untracked, unmerged, operation: operationIn(dir) }
}

/** The repository's own folder (`.git`, or a worktree's) for a directory inside it, or null when there is none. */
export function gitDirOf(dir: string): string | null {
  const gitDir = runRaw(dir, ['rev-parse', '--absolute-git-dir'])
  return gitDir.ok ? gitDir.out.toString().trim() || null : null
}

/** The markers git itself documents for an operation in progress; the filesystem answers, not six processes. */
function operationIn(dir: string): string | null {
  const gitDir = runRaw(dir, ['rev-parse', '--absolute-git-dir'])
  if (!gitDir.ok) return null
  const at = gitDir.out.toString().trim()
  const midway: [string, string][] = [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['BISECT_LOG', 'a bisect'],
  ]
  for (const [entry, name] of midway) if (existsSync(join(at, entry))) return name
  return null
}

/** The text of a blob, or null. Blobs never change, so what was read is kept. */
export function gitBlob(dir: string, sha: string): string | null {
  const had = blobs.get(sha)
  if (had !== undefined) return had
  const got = runRaw(dir, ['cat-file', 'blob', sha])
  if (!got.ok) return null
  const text = got.out.toString('utf8')
  if (blobs.size > 400) blobs.clear()
  blobs.set(sha, text)
  return text
}

/** The path a file has in the index: relative to the repository root. */
const inIndex = (view: GitView, file: string) => `${view.prefix}${file}`.split('\\').join('/')

/** Stage `text` as the content of `file`: the blob is written, the index entry points at it. */
export function stageText(dir: string, view: GitView, file: string, text: string, mode = '100644'): boolean {
  const made = runRaw(dir, ['hash-object', '-w', '--stdin'], { input: text })
  if (!made.ok) return false
  const sha = made.out.toString().trim()
  const put = runRaw(dir, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${inIndex(view, file)}`], { env: {} })
  return put.ok
}

/** `git add` of one file by literal path: a new file accepted. */
export function stageFile(dir: string, view: GitView, file: string): boolean {
  return runRaw(dir, ['add', '--', `:(literal,top)${inIndex(view, file)}`]).ok
}

/** Take a deleted file out of the index: a deletion accepted. */
export function unstageFile(dir: string, view: GitView, file: string): boolean {
  return runRaw(dir, ['rm', '--cached', '-q', '--', `:(literal,top)${inIndex(view, file)}`]).ok
}

/** What committing the paper's STAGED files would carry; `clean` when nothing is staged under it. */
export function standingStaged(dir: string): Standing {
  const repo = repoOf(dir)
  if (!repo) return { at: 'nogit' }
  const no = refusal(dir, repo.root)
  if (no) return { at: 'refused', why: no }
  const hasHead = runRaw(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok
  const changed = hasHead
    ? runRaw(dir, ['diff', '--cached', '--name-only', '--relative', '-z', '--', '.'])
    : runRaw(dir, ['ls-files', '-z', '--', '.'])
  if (!changed.ok) return { at: 'refused', why: `git could not say what is staged here: ${firstLine(changed.err)}` }
  const files = changed.out.toString('utf8').split('\0').filter(Boolean)
  return files.length ? { at: 'ready', files } : { at: 'clean' }
}

/**
 * Commit what is STAGED under the paper's directory, and nothing else.
 *
 * Built in a scratch index: HEAD's tree, with the real index's entries under
 * the paper laid over it. The commit is made against that index
 * (`GIT_INDEX_FILE`), so hooks run as they would, what is staged elsewhere in
 * the repository is not in it and stays staged, and what is only in the
 * working tree is not in it either — which is the point: an unreviewed change
 * is not committed. The real index is untouched; its paper entries equal the
 * new HEAD's afterwards.
 */
export function commitStaged(dir: string | null, subject: string, body: string): Committed {
  if (!dir) return { at: 'nogit' }
  const where = standingStaged(dir)
  if (where.at !== 'ready') return where
  const gitPath = runRaw(dir, ['rev-parse', '--absolute-git-dir'])
  if (!gitPath.ok) return { at: 'nogit' }
  const scratch = join(gitPath.out.toString().trim(), `paper-index.${process.pid}.${Math.random().toString(36).slice(2, 8)}`)
  const env = { GIT_INDEX_FILE: scratch }
  const cleanup = () => {
    try {
      rmSync(scratch, { force: true })
    } catch {
      /* a leftover scratch index is only a file in .git */
    }
  }
  try {
    const hasHead = runRaw(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok
    const base = runRaw(dir, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env })
    if (!base.ok) return { at: 'refused', why: `git could not prepare the commit: ${firstLine(base.err)}` }
    const mine = runRaw(dir, ['ls-files', '-z', '--', '.'], { env })
    const names = mine.out.toString('utf8').split('\0').filter(Boolean)
    if (names.length) {
      runRaw(dir, ['update-index', '--force-remove', '-z', '--stdin'], { env, input: `${names.join('\0')}\0` })
    }
    const staged = runRaw(dir, ['ls-files', '-s', '-z', '--full-name', '--', '.'])
    const entries = staged.out.toString('utf8')
    if (entries) {
      const put = runRaw(dir, ['update-index', '-z', '--add', '--index-info'], { env, input: entries })
      if (!put.ok) return { at: 'refused', why: `git could not prepare the commit: ${firstLine(put.err)}` }
    }
    const message = body ? `${subject}\n\n${body}` : subject
    const made = runRaw(dir, ['commit', '--cleanup=whitespace', '-m', message], { env })
    if (!made.ok) {
      return {
        at: 'refused',
        why: `Your accepted changes are in the index, but git would not commit them: ${firstLine(made.err) || firstLine(made.out.toString())}`,
      }
    }
    const sha = runRaw(dir, ['rev-parse', '--short', 'HEAD'])
    return { at: 'committed', sha: sha.ok ? sha.out.toString().trim() : '', files: where.files }
  } finally {
    cleanup()
  }
}
