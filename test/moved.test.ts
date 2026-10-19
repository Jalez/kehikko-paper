import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { held } from 'kehikot-module-protocol/client'
import { DOOR_PROJECT_SAYS } from 'kehikot-module-protocol/serve'

import { TICKET, answer } from '../doors.ts'
import { heldAtProject } from '../src/held-at-project.ts'
import { autoApproveKey, autoApproveWas, rememberAutoApprove } from '../src/remembered.ts'
import { forgetVouched, onProjectLeft, vouched } from '../stale.ts'
import { host } from './host.ts'

/**
 * A project is its id, not its folder. The door asks the host which folder it means and works on
 * that one: a former path is followed, a stranger's folder at the old path is not written to, and
 * with no host nothing is read or written. What this process holds in memory under a path is let
 * go of when the project leaves it.
 */
const ID = 'proj-paper-one'
const MAIN = '\\documentclass{article}\n\\begin{document}\nHello there.\n\\end{document}\n'
let dir = ''
let OLD = ''
let NEW = ''
const nothing = new URLSearchParams()

beforeEach(() => {
  host.reset()
  forgetVouched()
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'paper-moved-')))
  OLD = join(dir, 'before')
  NEW = join(dir, 'after')
})
afterEach(() => {
  host.reset()
  forgetVouched()
  rmSync(dir, { recursive: true, force: true })
})

function renamed(): void {
  mkdirSync(join(OLD, '.kehikot', 'paper', 'thesis'), { recursive: true })
  writeFileSync(join(OLD, '.kehikot', 'paper', 'thesis', 'main.tex'), MAIN)
  renameSync(OLD, NEW)
  host.auto = false
  host.projects.set(NEW, ID)
  host.moved.set(OLD, { to: NEW, id: ID })
}

const at = (project: string) => new URLSearchParams({ epic: 'thesis', project })
/** What the file hashes to now, read at `where`, so a save says what it was typed over. */
const hashAt = async (where: string) => {
  const read = await answer('GET', '/api/source', new URLSearchParams({ epic: 'thesis', file: 'main.tex', project: where }), null)
  return (read?.body as { hash: string }).hash
}
const save = async (project: string, text: string, was: string) => answer('POST', '/api/file', at(project), { file: 'main.tex', text, was }, TICKET)

describe('a project whose folder moved', () => {
  test('a read with the former path is followed, answers about the new folder, and says so', async () => {
    renamed()
    const reply = await answer('GET', '/api/papers', new URLSearchParams({ project: OLD }), null)
    const body = reply?.body as { said?: string; papers: { epic: string }[] }
    expect(body.said).toBe(DOOR_PROJECT_SAYS.followed(OLD, NEW))
    expect(body.papers.map((p) => p.epic)).toEqual(['thesis'])
  })

  test('a write with the former path lands in the new folder, and nothing is made at the old one', async () => {
    renamed()
    const changed = MAIN.replace('Hello', 'Goodbye')
    const reply = await save(OLD, changed, await hashAt(NEW))
    expect((reply?.body as { said?: string }).said).toBe(DOOR_PROJECT_SAYS.followed(OLD, NEW))
    expect(readFileSync(join(NEW, '.kehikot', 'paper', 'thesis', 'main.tex'), 'utf8')).toBe(changed)
    expect(existsSync(OLD)).toBe(false)
  })

  test('a tool call with the former path is followed, and says so', async () => {
    renamed()
    const reply = await answer('POST', '/mcp', nothing, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_papers', arguments: { project: OLD } },
    })
    const result = (reply?.body as { result: { content: { text: string }[]; isError?: boolean } }).result
    expect(result.isError).not.toBe(true)
    expect(result.content[0]?.text).toContain('thesis')
    expect(result.content.at(-1)?.text).toBe(DOOR_PROJECT_SAYS.followed(OLD, NEW))
  })

  test('an unrelated folder made at the old path is refused, and nothing is written there', async () => {
    renamed()
    mkdirSync(join(OLD, '.kehikot', 'paper', 'thesis'), { recursive: true })
    writeFileSync(join(OLD, '.kehikot', 'paper', 'thesis', 'main.tex'), MAIN)
    host.moved.set(OLD, { to: NEW, id: 'proj-someone-else' })
    const reply = await save(OLD, 'overwritten', '')
    expect(reply?.status).toBe(409)
    expect((reply?.body as { error: string }).error).toBe(DOOR_PROJECT_SAYS.moved(NEW))
    expect(readFileSync(join(OLD, '.kehikot', 'paper', 'thesis', 'main.tex'), 'utf8')).toBe(MAIN)
    expect(readFileSync(join(NEW, '.kehikot', 'paper', 'thesis', 'main.tex'), 'utf8')).toBe(MAIN)

    const tool = await answer('POST', '/mcp', nothing, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_papers', arguments: { project: OLD } },
    })
    const result = (tool?.body as { result: { content: { text: string }[]; isError?: boolean } }).result
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(DOOR_PROJECT_SAYS.moved(NEW))
  })

  test('a folder the host does not hold is refused, though it exists', async () => {
    mkdirSync(join(OLD, '.kehikot', 'paper', 'thesis'), { recursive: true })
    writeFileSync(join(OLD, '.kehikot', 'paper', 'thesis', 'main.tex'), MAIN)
    host.auto = false
    const reply = await save(OLD, 'nope', '')
    expect((reply?.body as { error: string }).error).toBe(DOOR_PROJECT_SAYS.notProject(OLD))
    expect(readFileSync(join(OLD, '.kehikot', 'paper', 'thesis', 'main.tex'), 'utf8')).toBe(MAIN)
  })

  test('with no host running a door refuses, and writes nothing', async () => {
    mkdirSync(join(OLD, '.kehikot', 'paper', 'thesis'), { recursive: true })
    writeFileSync(join(OLD, '.kehikot', 'paper', 'thesis', 'main.tex'), MAIN)
    host.up = false
    const reply = await save(OLD, 'nope', '')
    expect(reply?.status).toBe(409)
    expect((reply?.body as { error: string }).error).toBe(DOOR_PROJECT_SAYS.notProject(OLD))
    expect(readFileSync(join(OLD, '.kehikot', 'paper', 'thesis', 'main.tex'), 'utf8')).toBe(MAIN)
  })

  test('a request without the ticket is refused before the host is asked', async () => {
    renamed()
    host.asked.length = 0
    const reply = await answer('POST', '/api/file', at(OLD), { file: 'main.tex', text: 'x' }, null)
    expect(reply?.status).toBe(403)
    expect(host.asked).toEqual([])
  })
})

describe('what is held in memory under a path', () => {
  test('is let go of when the project moved from it, when another project is there, and when the folder is gone', () => {
    const left: string[] = []
    onProjectLeft((project) => left.push(project))
    const A = join(dir, 'a')
    const B = join(dir, 'b')
    mkdirSync(A)
    mkdirSync(B)

    vouched(A, ID)
    vouched(A, ID)
    expect(left).toEqual([])

    vouched(B, 'proj-other', A)
    expect(left).toContain(A)

    left.length = 0
    vouched(B, 'proj-a-different-one')
    expect(left).toContain(B)

    left.length = 0
    vouched(A, ID)
    rmSync(A, { recursive: true })
    vouched(B, 'proj-a-different-one')
    expect(left).toContain(A)
  })
})

describe('what the page holds across a rename', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  test('unsaved words kept under the id are still there when the path changes', () => {
    const unsaved = held('test.paper.unsaved')
    const words = { base: '', text: 'half a sentence', aim: 'a file' }
    heldAtProject(unsaved, { projectId: ID, projectPath: OLD })?.keep('thesis\0main.tex', words)
    expect(heldAtProject(unsaved, { projectId: ID, projectPath: NEW })?.read('thesis\0main.tex')).toEqual(words)
  })

  test('unsaved words an earlier page kept under the path are moved under the id, once', () => {
    const unsaved = held('test.paper.unsaved2')
    const words = { base: '', text: 'older', aim: 'a file' }
    unsaved.at(OLD).keep('thesis\0main.tex', words)
    expect(heldAtProject(unsaved, { projectId: ID, projectPath: OLD })?.read('thesis\0main.tex')).toEqual(words)
    expect(unsaved.at(OLD).any()).toBe(false)
    expect(heldAtProject(unsaved, { projectId: ID, projectPath: NEW })?.read('thesis\0main.tex')).toEqual(words)
  })

  test('the Auto accept tick follows the id, and the path’s older tick is moved once', () => {
    rememberAutoApprove(autoApproveKey(OLD, 'thesis'), true)
    const key = autoApproveKey(NEW, 'thesis', ID)
    expect(autoApproveWas(key, autoApproveKey(OLD, 'thesis'))).toBe(true)
    expect(autoApproveWas(autoApproveKey(OLD, 'thesis'))).toBe(false)
    expect(autoApproveWas(autoApproveKey('/somewhere/else', 'thesis', ID))).toBe(true)
    expect(autoApproveWas(autoApproveKey('/somewhere/else', 'thesis', 'proj-other'))).toBe(false)
  })
})
