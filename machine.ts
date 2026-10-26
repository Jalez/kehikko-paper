import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { moduleFolder, projectFile, projectKey, readProjectFile } from 'kehikot-module-protocol'
import { registryDir } from 'kehikot-module-protocol/serve'

import { ID } from './manifest.ts'
import { touched } from './news.ts'

/**
 * This module's state about a project that is NOT the project's: kept in the
 * machine's Kehikot folder, beside the module registry, so it never travels in
 * the project's git history.
 *
 *     <Kehikot machine folder>/module-state/paper/id-<project id>/<epic>/…
 *     <Kehikot machine folder>/module-state/paper/<project path hash>/<epic>/…   (no id yet)
 *
 * What lives there: suggestions an agent filed and nobody has answered
 * (`suggestions.json`), what the author last accepted when the project has no
 * repository to say so (`baseline/`), the reasons written beside changes, the
 * changes accepted lately and the Auto accept setting (`review.json`).
 *
 * `PAPER_STATE_DIR` moves all of it (the tests point it at a temporary
 * directory); a scratch server that sets `KEHIKOT_MODULES_DIR` gets a scratch
 * one beside its scratch registry without doing anything else.
 *
 * Every write is to a temporary file and a rename, so a crash never leaves half
 * a file, and a file that is missing or cannot be read is an empty state: losing
 * it costs a person a suggestion to file again, never a paper.
 */
export function stateRoot(env: Record<string, string | undefined> = process.env): string {
  return env.PAPER_STATE_DIR || join(dirname(registryDir(env)), 'module-state', moduleFolder(ID))
}

const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * The project's permanent id, from `<project>/.kehikot/project.json` (protocol
 * 2.1.0), or null when the host has not given it one yet. Read from the file
 * rather than from the page's context because the server is handed a path —
 * by the page and by an agent's MCP call alike — and the file is beside it.
 * The host writes that file; this module only reads it.
 */
export function projectIdOf(project: string): string | null {
  const file = projectFile(project)
  if (file === null) return null
  return readProjectFile(readJson(file))?.id ?? null
}

/**
 * The folder one project's state is in.
 *
 * Filed under the project's id when it has one (`id-<id>`), so renaming or
 * moving the project folder keeps its suggestions, baseline and Auto accept;
 * under a hash of the absolute path otherwise, as before 2.1.0. The two are
 * spelled apart (`id-` against bare hex) so a name is never guessed at.
 *
 * The first time a project is seen with an id, what was filed under the hash
 * of the path it has NOW is moved to the id (`adopt`). State kept under a path
 * the project no longer has cannot be matched: the hash does not say which
 * path it was, and this module does not know a project's former paths. Such a
 * folder is left where it is, untouched.
 */
export function projectState(project: string): string {
  const key = projectKey({ projectId: projectIdOf(project), projectPath: project })
  const byPath = join(stateRoot(), short(project))
  if (key === null || key.by === 'path') return byPath
  const byId = join(stateRoot(), `id-${key.key}`)
  adopt(byPath, byId)
  return byId
}

/**
 * Move a project's state from its path hash to its id. The whole folder in one
 * rename when the id has nothing yet; otherwise each epic the id lacks, and
 * the hash folder goes once it is empty. An epic both have stays in both: the
 * id's copy is the one in use, and the other is not destroyed. Never throws.
 */
export function adopt(from: string, to: string): void {
  try {
    if (!existsSync(from)) return
    if (!existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
      return
    }
    for (const entry of readdirSync(from)) {
      if (!existsSync(join(to, entry))) renameSync(join(from, entry), join(to, entry))
    }
    if (readdirSync(from).length === 0) rmdirSync(from)
  } catch {
    /* State is a convenience: a move that failed leaves both folders as they were. */
  }
}

/** The folder one paper's state is in; the epic is a validated slug. */
export function paperState(project: string, epic: string): string {
  return join(projectState(project), epic.replace(/[^A-Za-z0-9._-]/g, '_'))
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Written to a temporary file and renamed. Failures are swallowed: state is a convenience, never a reason to fail a request. */
export function writeJson(path: string, value: unknown): boolean {
  try {
    const text = `${JSON.stringify(value)}\n`
    /* The same state again is not a write, and not news (`news.ts`): a page watching the paper is
       told only of what moved. */
    if (sameText(path, text)) return true
    mkdirSync(dirname(path), { recursive: true })
    const scratch = `${path}.${process.pid}.tmp`
    writeFileSync(scratch, text)
    renameSync(scratch, path)
    touched()
    return true
  } catch {
    return false
  }
}

function sameText(path: string, text: string): boolean {
  try {
    return readFileSync(path, 'utf8') === text
  } catch {
    return false
  }
}

export function removeState(path: string): void {
  try {
    if (!existsSync(path)) return
    rmSync(path, { recursive: true, force: true })
    touched()
  } catch {
    /* nothing to do */
  }
}

/** The epics of one project that have state on this machine. */
export function epicsWithState(project: string): string[] {
  try {
    return readdirSync(projectState(project), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}
