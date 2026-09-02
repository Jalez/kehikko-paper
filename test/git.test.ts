import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { acceptMessage, commitPaper, saveMessage, standing } from '../git.ts'
import { forgetAllProposals } from '../proposals.ts'

/**
 * A change accepted here makes a commit, and the commit is only ever the paper.
 *
 * ## The property this file exists to hold
 *
 * **A commit made by this module can never carry somebody else's work.** A
 * paper lives at `<project>/.kehikot/paper/<epic>/`, and the project is very
 * often several levels inside a repository full of unrelated things — the
 * thesis this was written against sits in a repository that also holds
 * coursework and scripts. So the interesting case is not "does it commit"; it
 * is "what happens when the person accepting a typo fix had something else
 * half-staged", and that is the first `describe` below.
 *
 * Every test here builds a real repository in a temporary directory and runs
 * real git in it. There is no mock, deliberately: what is being asserted is the
 * behaviour of one specific git invocation under conditions this program cannot
 * control, and a fake would only ever assert what its author believed git does.
 *
 * ## What is not tested here
 *
 * The commit hook path. A repository with a `pre-commit` hook that fails takes
 * the commit down with it, by design — hooks are the repository owner's and are
 * not bypassed — and the refusal is reported over a paper that is already
 * correct on disk. That is asserted for the SHAPE of a refusal (`git would not
 * commit it`, file unchanged) through the identity refusal below, which is
 * cheaper to arrange and exercises the same branch.
 */

const SOURCE = [
  '\\title{A committed paper}',
  '\\begin{document}',
  '\\section{A claim}',
  '',
  'The claim has a tpyo in it and it runs on for long enough that the',
  'author wrapped the line, the way a real paper is written, and ends.',
  '',
  '\\end{document}',
  '',
].join('\n')

let root = ''
/** The repository. The PROJECT is deliberately buried inside it. */
let repo = ''
let project = ''
let paperDir = ''
let main = ''
let unrelated = ''

/** Real git, in the scratch repository, with no shell between. */
function git(...args: string[]): { ok: boolean; out: string } {
  const ran = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  return { ok: ran.status === 0, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim() }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-git-')))
  repo = join(root, 'coursework')
  /* Four levels between the repository root and the paper, which is the real
     shape: the repository is somebody's whole degree and the paper is one
     folder in one project inside it. A test where the project IS the repository
     root would pass with a pathspec that named the whole tree. */
  project = join(repo, 'year-two', 'drafts', 'thesis')
  paperDir = join(project, '.kehikot', 'paper', 'a-paper')
  mkdirSync(paperDir, { recursive: true })
  main = join(paperDir, 'main.tex')
  writeFileSync(main, SOURCE)
  unrelated = join(repo, 'notes.md')
  writeFileSync(unrelated, 'notes somebody is in the middle of\n')

  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.name', 'A Person')
  git('config', 'user.email', 'person@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-q', '-m', 'the repository before any of this')
  forgetAllProposals()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  forgetAllProposals()
})

const onDisk = () => readFileSync(main, 'utf8')

/** One MCP tool call, answered as the text it returns. */
function tool(name: string, args: Record<string, unknown>): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const result = (reply?.body as { result?: { content?: { text?: string }[] } })?.result
  return result?.content?.[0]?.text ?? ''
}

function suggest(find: string, replace: string, why = 'It reads better.'): string {
  const said = tool('propose_edit', { project, epic: 'a-paper', file: 'main.tex', find, replace, why })
  return said.replace(/^Filed as (\S+)\..*$/s, '$1')
}

function accept(id: string) {
  return answer('POST', '/api/proposal', new URLSearchParams({ epic: 'a-paper', project }), {
    id,
    decision: 'accept',
    ticket: TICKET,
  })
}

function save() {
  return answer('POST', '/api/save', new URLSearchParams({ epic: 'a-paper', project }), { ticket: TICKET })
}

function uncommitted() {
  const reply = answer('GET', '/api/uncommitted', new URLSearchParams({ epic: 'a-paper', project }), null)
  return (reply?.body as { standing: { at: string; files?: string[]; why?: string } }).standing
}

const said = (reply: ReturnType<typeof accept>) => String((reply?.body as { said?: string })?.said ?? '')

const subjects = () => git('log', '--format=%s').out.split('\n').filter((one) => one.length > 0)

describe('a commit can never carry somebody else’s work', () => {
  /*
   * The one that matters. Somebody has staged an unrelated file — half a
   * commit they were in the middle of composing — and then accepts a typo fix
   * in their paper. Committing their staged work for them would be the worst
   * thing this feature could do, and it is the default behaviour of `git
   * commit` with no pathspec.
   */
  test('an unrelated staged change is not in the commit, and is still staged afterwards', () => {
    writeFileSync(unrelated, 'notes somebody had half-staged\n')
    git('add', 'notes.md')
    expect(git('status', '--porcelain').out).toContain('M  notes.md')

    const id = suggest('tpyo', 'typo')
    expect(accept(id)?.status).toBe(200)

    /* One file in the commit, and it is the paper's. */
    const inCommit = git('show', '--name-only', '--format=', 'HEAD').out.split('\n').filter((one) => one)
    expect(inCommit).toEqual(['year-two/drafts/thesis/.kehikot/paper/a-paper/main.tex'])

    /* And their work is exactly where they left it: staged, uncommitted. */
    expect(git('status', '--porcelain').out).toContain('M  notes.md')
    expect(readFileSync(unrelated, 'utf8')).toBe('notes somebody had half-staged\n')
  })

  test('accepting commits the one file it names, not the rest of the paper', () => {
    /* A chapter the author was in the middle of, beside the file the suggestion
       is about. Committing it under "Accept a suggested change in main.tex"
       would be the wrong sentence about somebody's work — inside the paper, so
       not somebody else's, but not what the message says either. Save is where
       the rest belongs. */
    const chapter = join(paperDir, 'chapter-two.tex')
    writeFileSync(chapter, 'A chapter the author was in the middle of.\n')
    git('add', '--', 'year-two/drafts/thesis/.kehikot/paper/a-paper/chapter-two.tex')
    git('commit', '-q', '-m', 'a chapter')
    writeFileSync(chapter, 'A chapter the author is STILL in the middle of.\n')

    const id = suggest('tpyo', 'typo')
    expect(accept(id)?.status).toBe(200)
    const inCommit = git('show', '--name-only', '--format=', 'HEAD').out.split('\n').filter((one) => one)
    expect(inCommit).toEqual(['year-two/drafts/thesis/.kehikot/paper/a-paper/main.tex'])
    /* And the chapter is still waiting, which is what Save is for. */
    const where = uncommitted()
    expect(where.at).toBe('ready')
    expect(where.files).toEqual(['year-two/drafts/thesis/.kehikot/paper/a-paper/chapter-two.tex'])
  })

  test('an unrelated UNSTAGED change is untouched too', () => {
    writeFileSync(unrelated, 'notes somebody is typing\n')
    const id = suggest('tpyo', 'typo')
    expect(accept(id)?.status).toBe(200)
    /* `M notes.md` and not ` M notes.md`: the helper above trims, and porcelain
       leaves column one blank for a change that is not staged. */
    expect(git('status', '--porcelain').out).toContain('M notes.md')
    expect(readFileSync(unrelated, 'utf8')).toBe('notes somebody is typing\n')
  })

  test('Save commits the paper and leaves the rest of the repository alone', () => {
    writeFileSync(unrelated, 'still theirs\n')
    git('add', 'notes.md')
    /* A correction typed in the reader, through the ordinary write path, which
       does NOT commit — that is what Save is for. */
    const at = SOURCE.indexOf('tpyo')
    answer('POST', '/api/edit', new URLSearchParams({ epic: 'a-paper', project }), {
      file: 'main.tex',
      from: at,
      to: at + 4,
      text: 'typo',
      was: hashOfMain(),
      ticket: TICKET,
    })
    expect(subjects()).toHaveLength(1)

    expect(save()?.status).toBe(200)
    const inCommit = git('show', '--name-only', '--format=', 'HEAD').out.split('\n').filter((one) => one)
    expect(inCommit).toEqual(['year-two/drafts/thesis/.kehikot/paper/a-paper/main.tex'])
    expect(git('status', '--porcelain').out).toContain('M  notes.md')
  })
})

describe('what the commits say', () => {
  test('an accepted suggestion is authored by the person and names the proposer', () => {
    const id = suggest('tpyo', 'typo', 'A misspelling in the first claim.')
    accept(id)
    const message = git('log', '-1', '--format=%s%n%n%b').out
    expect(message).toContain('Accept a suggested change in main.tex')
    expect(message).toContain('A misspelling in the first claim.')
    /* What the proposal actually carries. `propose_edit` takes no argument for
       who is proposing, so this module does not know which agent on the canvas
       made the suggestion, and the trailer says exactly that much. */
    expect(message).toContain('Proposed-by: an agent')
    /* The AUTHOR is the person, taken from the repository's own identity. An
       agent wrote the words and could not put them in the file; the thing that
       changed the repository was somebody pressing Accept. */
    expect(git('log', '-1', '--format=%an <%ae>').out).toBe('A Person <person@example.com>')
    /* And never `Co-authored-by`, which forges parse and attach to accounts —
       handing that mechanism a name an agent chose for itself is how somebody
       else's face ends up on a commit they never saw. */
    expect(message).not.toContain('Co-authored-by')
  })

  test('a proposal carrying no name still gets a trailer, saying so', () => {
    expect(acceptMessage('main.tex', 'It is misspelled.', '').body)
      .toContain('Proposed-by: an agent that did not say who it was')
  })

  test('a why with a leading # survives, because cleanup is whitespace and not strip', () => {
    /* The default `--cleanup=strip` deletes every line beginning with `#`, and
       an agent talking about section numbering writes one. */
    const id = suggest('tpyo', 'typo', '#2 is misspelled.')
    accept(id)
    expect(git('log', '-1', '--format=%b').out).toContain('#2 is misspelled.')
  })

  test('a newline or a control character in an agent’s words cannot break the trailer', () => {
    const message = acceptMessage('main.tex', 'a\nreason\r\nover lines', 'a\nname withcontrol')
    expect(message.body.split('\n').filter((one) => one.startsWith('Proposed-by:'))).toHaveLength(1)
    expect(message.body).toContain('Proposed-by: a name with control')
    expect(message.subject.includes('\n')).toBe(false)
  })

  test('Save names one file, or the paper when there are several', () => {
    expect(saveMessage('thesis', ['main.tex']).subject).toBe('Save main.tex')
    const many = saveMessage('thesis', ['main.tex', 'chapters/two.tex'])
    expect(many.subject).toBe('Save the thesis paper')
    expect(many.body).toContain('chapters/two.tex')
  })

  test('each accepted suggestion is its own commit', () => {
    const first = suggest('tpyo', 'typo')
    const second = suggest('the way a real paper is written', 'as a real paper is written')
    accept(first)
    accept(second)
    expect(subjects().filter((one) => one.startsWith('Accept a suggested change'))).toHaveLength(2)
  })
})

describe('nothing to commit is not an error', () => {
  test('Save with nothing changed commits nothing and says so', () => {
    expect(uncommitted().at).toBe('clean')
    const before = git('rev-parse', 'HEAD').out
    const reply = save()
    expect(reply?.status).toBe(200)
    expect((reply?.body as { committed: boolean }).committed).toBe(false)
    expect(said(reply)).toBe('Nothing has changed since the last commit.')
    expect(git('rev-parse', 'HEAD').out).toBe(before)
  })

  test('a paper with a change waiting says so, and names the files', () => {
    writeFileSync(main, `${SOURCE}% a line somebody added in their editor\n`)
    const where = uncommitted()
    expect(where.at).toBe('ready')
    expect(where.files).toEqual(['year-two/drafts/thesis/.kehikot/paper/a-paper/main.tex'])
  })

  test('a paper that has never been committed is committed, untracked and all', () => {
    /* `git commit -- <path>` alone refuses an untracked path with "no changes
       added to commit", which is why `git add` runs first — by the same
       pathspec, so it can reach nothing outside the paper. */
    const fresh = join(paperDir, 'chapter-one.tex')
    writeFileSync(fresh, 'A new chapter nobody has committed.\n')
    expect(uncommitted().at).toBe('ready')
    expect(save()?.status).toBe(200)
    expect(git('show', '--name-only', '--format=', 'HEAD').out)
      .toContain('year-two/drafts/thesis/.kehikot/paper/a-paper/chapter-one.tex')
  })
})

describe('it refuses rather than guesses, and the edit is never lost', () => {
  /* Every case here writes the bytes first and then declines to commit them.
     The assertion that matters in all of them is the same one: the file on disk
     holds the correction. */

  test('a detached HEAD refuses, and the correction still lands', () => {
    git('checkout', '-q', '--detach')
    const where = uncommitted()
    expect(where.at).toBe('refused')
    expect(where.why).toContain('not on a branch')
    expect(where.why).toContain('Check out a branch')

    const id = suggest('tpyo', 'typo')
    const reply = accept(id)
    expect(reply?.status).toBe(200)
    expect(onDisk()).toContain('typo')
    expect(said(reply)).toContain('not on a branch')
  })

  test('a merge in progress refuses', () => {
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), `${git('rev-parse', 'HEAD').out}\n`)
    const where = uncommitted()
    expect(where.at).toBe('refused')
    expect(where.why).toContain('A merge is in progress')
    expect(where.why).toContain('Finish it or abort it')
  })

  test('a rebase in progress refuses', () => {
    mkdirSync(join(repo, '.git', 'rebase-merge'), { recursive: true })
    expect(uncommitted().why).toContain('A rebase is in progress')
  })

  test('a cherry-pick in progress refuses', () => {
    writeFileSync(join(repo, '.git', 'CHERRY_PICK_HEAD'), `${git('rev-parse', 'HEAD').out}\n`)
    expect(uncommitted().why).toContain('A cherry-pick is in progress')
  })

  test('no identity refuses, names what is missing, and the edit still lands', () => {
    /* Set to nothing rather than unset. A repository-local `--unset` falls
       back to the machine's global identity, which the developer running this
       has and a clean CI box does not — a test that passed on one and not the
       other. An empty value is local, is what `--get` answers, and is exactly
       the state the check is about: git knows no name to put on the commit. */
    git('config', 'user.email', '')

    const where = standing(paperDir)
    expect(where.at).toBe('refused')
    if (where.at !== 'refused') return
    expect(where.why).toContain('user.email')
    expect(where.why).toContain('config user.email you@example.com')

    const id = suggest('tpyo', 'typo')
    accept(id)
    expect(onDisk()).toContain('typo')
    expect(subjects()).toHaveLength(1)
  })

  test('a paper git is told to ignore refuses, and says which rule', () => {
    writeFileSync(join(repo, '.gitignore'), '.kehikot/\n')
    git('add', '.gitignore')
    git('commit', '-q', '-m', 'ignore the working folder')
    git('rm', '-r', '-q', '--cached', 'year-two/drafts/thesis/.kehikot')
    git('commit', '-q', '-m', 'and stop tracking it')

    const where = uncommitted()
    expect(where.at).toBe('refused')
    expect(where.why).toContain('is ignored by git')
    expect(where.why).toContain('.kehikot/')

    const id = suggest('tpyo', 'typo')
    accept(id)
    expect(onDisk()).toContain('typo')
  })

  test('a paper in no repository at all is silent, and is not an error', () => {
    /* The state a paper in a plain folder is in, which was the only way to use
       this module until commits existed. It draws no Save button and says
       nothing — reporting the absence of a feature as a failure, once per typo
       forever, is the shape this state exists to avoid. */
    const plain = join(root, 'no-repo', '.kehikot', 'paper', 'a-paper')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'main.tex'), SOURCE)
    expect(standing(plain).at).toBe('nogit')
    expect(commitPaper(plain, 'never', '').at).toBe('nogit')
  })
})

describe('it does nothing to a repository but add to it', () => {
  test('the branch is the one that was checked out, and no other branch appears', () => {
    git('checkout', '-q', '-b', 'a-side-branch')
    const before = git('branch', '--format=%(refname:short)').out.split('\n').sort()
    const id = suggest('tpyo', 'typo')
    accept(id)
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').out).toBe('a-side-branch')
    expect(git('branch', '--format=%(refname:short)').out.split('\n').sort()).toEqual(before)
  })

  test('nothing before HEAD is rewritten: the previous commit is still there', () => {
    const before = git('rev-parse', 'HEAD').out
    const id = suggest('tpyo', 'typo')
    accept(id)
    expect(git('rev-parse', 'HEAD~1').out).toBe(before)
    expect(subjects()).toHaveLength(2)
  })

  test('an inherited GIT_DIR cannot redirect a commit at another repository', () => {
    /* This process is usually started from inside a repository of its own. An
       inherited `GIT_DIR` is the one way a command in `git.ts` could touch a
       repository that is not the paper's, and it is removed at the source. */
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: elsewhere })
    const was = process.env.GIT_DIR
    process.env.GIT_DIR = join(elsewhere, '.git')
    try {
      const id = suggest('tpyo', 'typo')
      accept(id)
    } finally {
      if (was === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = was
    }
    expect(subjects()).toHaveLength(2)
    const there = spawnSync('git', ['log', '--oneline'], { cwd: elsewhere, encoding: 'utf8' })
    expect((there.stdout ?? '').trim()).toBe('')
  })
})

/** The hash the write door demands, read the way the page reads it. */
function hashOfMain(): string {
  const reply = answer('GET', '/api/paper', new URLSearchParams({ epic: 'a-paper', project }), null)
  return (reply?.body as { paper: { hashes: Record<string, string> } }).paper.hashes['main.tex'] ?? ''
}
