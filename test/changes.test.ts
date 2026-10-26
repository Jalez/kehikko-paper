import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { answerAt as answer } from '../doors.ts'
import { forgetAllProposals } from '../proposals.ts'
import { watchDoor, watching } from '../watch.ts'
import { host } from './host.ts'

/**
 * 2.8.0: a page keeps up with a paper by one answer, `/api/changes`, asked when the server says
 * something moved (`/api/watch`), instead of two polls every four seconds each.
 *
 * - `/api/changes` is `/api/proposals` and `/api/uncommitted` in one, with a tag; `since` that is
 *   still the tag is a few bytes.
 * - `/api/watch` says `changed` for an edit to the `.tex` (in place, or by an editor's rename over
 *   it), a suggestion filed through `propose_edit`, and a `git add` from a terminal — and nothing
 *   for an event that moved nothing.
 */

const SOURCE = ['\\title{Watched}', '\\begin{document}', 'The first paragraph says something.', '', 'The second one too.', '\\end{document}', ''].join('\n')
const epic = 'watched'

let root = ''
let project = ''
let paper = ''
let main = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-changes-')))
  project = join(root, 'work')
  paper = join(project, '.kehikot', 'paper', epic)
  mkdirSync(paper, { recursive: true })
  main = join(paper, 'main.tex')
  writeFileSync(main, SOURCE)
  forgetAllProposals()
  host.reset()
})
const opened: Opened[] = []
afterEach(async () => {
  /* A test that failed half-way leaves no stream behind for the next. */
  for (const one of opened.splice(0)) await one.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
  forgetAllProposals()
  host.reset()
})

const changes = (since?: string) =>
  answer('GET', '/api/changes', new URLSearchParams({ project, epic, ...(since !== undefined ? { since } : {}) }), null)?.body as Record<string, unknown>

function propose(find: string, replace: string): string {
  const reply = answer('POST', '/mcp', new URLSearchParams(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'propose_edit', arguments: { project, epic, file: 'main.tex', find, replace, why: 'Because.' } },
  })
  return ((reply?.body as { result?: { content?: { text?: string }[] } })?.result?.content?.[0]?.text) ?? ''
}

describe('/api/changes', () => {
  test('is both answers in one, with a tag', () => {
    const both = changes()
    const proposals = answer('GET', '/api/proposals', new URLSearchParams({ project, epic }), null)?.body as Record<string, unknown>
    const uncommitted = answer('GET', '/api/uncommitted', new URLSearchParams({ project, epic }), null)?.body as Record<string, unknown>
    expect(both).toMatchObject({ ok: true, proposals: proposals.proposals, auto: proposals.auto, standing: uncommitted.standing, hashes: uncommitted.hashes })
    expect(typeof both.tag).toBe('string')
    expect(String(both.tag)).toMatch(/^[0-9a-f]{16}$/)
  })

  test('since the same tag is a few bytes, and an edit is a new tag', () => {
    const tag = String(changes().tag)
    const quiet = changes(tag)
    expect(quiet).toEqual({ ok: true, same: true, tag })
    expect(JSON.stringify(quiet).length).toBeLessThan(60)
    writeFileSync(main, SOURCE.replace('something', 'something else'))
    const after = changes(tag)
    expect(after.same).toBeUndefined()
    expect(after.tag).not.toBe(tag)
  })

  test('a suggestion filed is a new tag', () => {
    const tag = String(changes().tag)
    expect(propose('says something', 'says it')).toMatch(/^Filed as /)
    const after = changes(tag)
    expect(after.tag).not.toBe(tag)
    expect((after.proposals as unknown[]).length).toBe(1)
  })

  test('no project answers as the two did: nothing waiting', () => {
    const body = answer('GET', '/api/changes', new URLSearchParams({ epic }), null)?.body as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, proposals: [], standing: { at: 'nogit' }, hashes: null })
  })
})

/* ------------------------------------------------------------------ the stream */

interface Opened {
  events: { event: string; data: Record<string, unknown> }[]
  next(event: string, ms?: number): Promise<Record<string, unknown>>
  quiet(ms: number): Promise<boolean>
  close(): Promise<void>
}

async function open(asker: 'page' | 'program' | 'elsewhere' = 'page'): Promise<Opened | Response> {
  const url = new URL(`http://127.0.0.1:7870/api/watch?${new URLSearchParams({ project, epic })}`)
  const response = await watchDoor(new Request(url), { asker, url, ticket: null })
  if (!response) throw new Error('the door did not answer')
  if (response.status !== 200) return response
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: Opened['events'] = []
  let buffered = ''
  let seen = 0
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) return
      buffered += decoder.decode(value)
      let at: number
      while ((at = buffered.indexOf('\n\n')) !== -1) {
        const block = buffered.slice(0, at)
        buffered = buffered.slice(at + 2)
        const event = /^event: (.*)$/m.exec(block)?.[1]
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (event && data) events.push({ event, data: JSON.parse(data) })
      }
    }
  })()
  const waitFor = async (until: () => boolean, ms: number) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (until()) return true
      await new Promise((done) => setTimeout(done, 20))
    }
    return until()
  }
  let closed = false
  const made: Opened = {
    events,
    async next(event, ms = 3_000) {
      const ok = await waitFor(() => events.slice(seen).some((one) => one.event === event), ms)
      if (!ok) throw new Error(`no ${event} within ${ms} ms; heard ${JSON.stringify(events)}`)
      const index = events.findIndex((one, i) => i >= seen && one.event === event)
      seen = index + 1
      return events[index]!.data
    },
    async quiet(ms) {
      const before = events.length
      await waitFor(() => events.length > before, ms)
      return events.length === before
    },
    async close() {
      if (closed) return
      closed = true
      await reader.cancel()
      await pump
    },
  }
  opened.push(made)
  return made
}

const git = (...args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })

describe('/api/watch', () => {
  test('says ready with the tag the page will read, and changed when the .tex is edited in place', async () => {
    const stream = (await open()) as Opened
    const ready = await stream.next('ready')
    expect(ready.tag).toBe(changes().tag)
    writeFileSync(main, SOURCE.replace('first', 'opening'))
    const changed = await stream.next('changed')
    expect(changed.tag).toBe(changes().tag)
    expect(changed.tag).not.toBe(ready.tag)
    await stream.close()
  })

  test('an editor that writes a copy and renames it over the file is a change', async () => {
    const stream = (await open()) as Opened
    await stream.next('ready')
    const copy = join(paper, '.main.tex.swp')
    writeFileSync(copy, SOURCE.replace('second', 'last'))
    renameSync(copy, main)
    await stream.next('changed')
    await stream.close()
  })

  test('a suggestion filed through propose_edit is a change, with nothing on disk moved', async () => {
    const stream = (await open()) as Opened
    await stream.next('ready')
    expect(propose('says something', 'says it')).toMatch(/^Filed as /)
    await stream.next('changed')
    await stream.close()
  })

  test('a git add from a terminal is a change; a commit after it too', async () => {
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    const stream = (await open()) as Opened
    await stream.next('ready')
    writeFileSync(main, SOURCE.replace('second', 'other'))
    await stream.next('changed')
    const before = changes()
    git('add', '-A')
    /* Staging changes what is waiting to be saved in a paper tracked in git. */
    await stream.next('changed')
    expect(changes().standing).not.toEqual(before.standing)
    git('commit', '-q', '-m', 'second')
    await stream.next('changed')
    await stream.close()
  })

  test('an event that moves nothing says nothing', async () => {
    const stream = (await open()) as Opened
    await stream.next('ready')
    writeFileSync(main, SOURCE)
    writeFileSync(join(paper, 'notes.txt'), 'not part of the paper')
    rmSync(join(paper, 'notes.txt'))
    expect(await stream.quiet(1_200)).toBe(true)
    await stream.close()
  })

  test('one watcher per paper, gone with the last page', async () => {
    const a = (await open()) as Opened
    const b = (await open('program')) as Opened
    await a.next('ready')
    await b.next('ready')
    expect(watching()).toEqual({ papers: 1, pages: 2 })
    writeFileSync(main, SOURCE.replace('first', 'one'))
    await a.next('changed')
    await b.next('changed')
    await a.close()
    expect(watching()).toEqual({ papers: 1, pages: 1 })
    await b.close()
    expect(watching()).toEqual({ papers: 0, pages: 0 })
  })

  test('refuses another site, a bad epic, and a folder the host does not hold', async () => {
    expect(((await open('elsewhere')) as Response).status).toBe(403)
    const url = new URL(`http://127.0.0.1:7870/api/watch?${new URLSearchParams({ project, epic: '../x' })}`)
    expect((await watchDoor(new Request(url), { asker: 'page', url, ticket: null }))!.status).toBe(400)
    host.auto = false
    const other = join(root, 'elsewhere')
    mkdirSync(other)
    const foreign = new URL(`http://127.0.0.1:7870/api/watch?${new URLSearchParams({ project: other, epic })}`)
    expect((await watchDoor(new Request(foreign), { asker: 'page', url: foreign, ticket: null }))!.status).toBe(409)
    const elsewhere = new URL('http://127.0.0.1:7870/api/paper')
    expect(await watchDoor(new Request(elsewhere), { asker: 'page', url: elsewhere, ticket: null })).toBeUndefined()
  })
})
