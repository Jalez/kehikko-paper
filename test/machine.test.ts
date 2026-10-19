import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { epicsWithState, paperState, projectIdOf, projectState, stateRoot, writeJson } from '../machine.ts'

/**
 * Machine state survives a project being renamed or moved: it is filed under
 * the project's id (protocol 2.1.0, `.kehikot/project.json`) when there is one,
 * and moved there from the old path hash the first time the id is seen.
 * Everything is under scratch directories (`test/setup.ts` points the state root at one).
 */

/* A fresh id per test: the state root is shared by the whole file. */
let ID = ''
const hash = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 16)

let base = ''
beforeEach(() => {
  ID = crypto.randomUUID()
  base = mkdtempSync(join(tmpdir(), 'paper-machine-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function project(name: string, id: string | null): string {
  const dir = join(base, name)
  mkdirSync(join(dir, '.kehikot'), { recursive: true })
  if (id) writeFileSync(join(dir, '.kehikot', 'project.json'), JSON.stringify({ id, createdAt: null }))
  return dir
}

describe('where a project’s machine state is filed', () => {
  test('a project with an id is filed under the id', () => {
    const dir = project('a', ID)
    expect(projectIdOf(dir)).toBe(ID)
    expect(projectState(dir)).toBe(join(stateRoot(), `id-${ID}`))
    expect(paperState(dir, 'thesis')).toBe(join(stateRoot(), `id-${ID}`, 'thesis'))
  })

  test('without an id (an older host) it is the path hash, as before', () => {
    const dir = project('b', null)
    expect(projectIdOf(dir)).toBeNull()
    expect(projectState(dir)).toBe(join(stateRoot(), hash(dir)))
  })

  test('a project.json that does not parse is no id', () => {
    const dir = project('c', null)
    writeFileSync(join(dir, '.kehikot', 'project.json'), '{"id":"NOT AN ID"}')
    expect(projectState(dir)).toBe(join(stateRoot(), hash(dir)))
  })

  test('the state follows the folder through a rename', () => {
    const dir = project('before', ID)
    writeJson(join(paperState(dir, 'thesis'), 'review.json'), { auto: true })
    const moved = join(base, 'after')
    renameSync(dir, moved)
    expect(readFileSync(join(paperState(moved, 'thesis'), 'review.json'), 'utf8')).toContain('"auto":true')
    expect(epicsWithState(moved)).toEqual(['thesis'])
  })
})

describe('moving state kept under the path to the id', () => {
  test('the hash folder of the current path becomes the id folder the first time the id is seen', () => {
    const dir = project('d', null)
    writeJson(join(paperState(dir, 'thesis'), 'suggestions.json'), { version: 1, pending: [] })
    const byPath = join(stateRoot(), hash(dir))
    expect(existsSync(byPath)).toBe(true)

    writeFileSync(join(dir, '.kehikot', 'project.json'), JSON.stringify({ id: ID, createdAt: null }))
    expect(existsSync(join(paperState(dir, 'thesis'), 'suggestions.json'))).toBe(true)
    expect(existsSync(byPath)).toBe(false)
    expect(existsSync(join(stateRoot(), `id-${ID}`, 'thesis', 'suggestions.json'))).toBe(true)
  })

  test('when the id already has state, only the epics it lacks are moved', () => {
    const dir = project('e', null)
    writeJson(join(paperState(dir, 'old'), 'review.json'), { from: 'path' })
    writeJson(join(paperState(dir, 'both'), 'review.json'), { from: 'path' })
    const byPath = join(stateRoot(), hash(dir))
    const byId = join(stateRoot(), `id-${ID}`)
    writeJson(join(byId, 'both', 'review.json'), { from: 'id' })

    writeFileSync(join(dir, '.kehikot', 'project.json'), JSON.stringify({ id: ID, createdAt: null }))
    expect(projectState(dir)).toBe(byId)
    expect(readFileSync(join(byId, 'old', 'review.json'), 'utf8')).toContain('path')
    expect(readFileSync(join(byId, 'both', 'review.json'), 'utf8')).toContain('"id"')
    /* The one both had is not destroyed. */
    expect(existsSync(join(byPath, 'both', 'review.json'))).toBe(true)
    expect(existsSync(join(byPath, 'old'))).toBe(false)
  })

  test('a hash folder for a path the project no longer has is left alone', () => {
    const dir = project('f', null)
    writeJson(join(paperState(dir, 'thesis'), 'review.json'), { auto: true })
    const orphan = join(stateRoot(), hash(dir))
    const moved = join(base, 'g')
    renameSync(dir, moved)
    writeFileSync(join(moved, '.kehikot', 'project.json'), JSON.stringify({ id: ID, createdAt: null }))
    expect(epicsWithState(moved)).toEqual([])
    expect(existsSync(join(orphan, 'thesis', 'review.json'))).toBe(true)
  })
})
