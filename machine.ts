import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { moduleFolder } from 'kehikot-module-protocol'
import { registryDir } from 'kehikot-module-protocol/serve'

import { ID } from './manifest.ts'

/**
 * This module's state about a project that is NOT the project's: kept in the
 * machine's Kehikot folder, beside the module registry, so it never travels in
 * the project's git history.
 *
 *     <Kehikot machine folder>/module-state/paper/<project hash>/<epic>/…
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

/** The folder one project's state is in. */
export function projectState(project: string): string {
  return join(stateRoot(), short(project))
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
    mkdirSync(dirname(path), { recursive: true })
    const scratch = `${path}.${process.pid}.tmp`
    writeFileSync(scratch, `${JSON.stringify(value)}\n`)
    renameSync(scratch, path)
    return true
  } catch {
    return false
  }
}

export function removeState(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
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
