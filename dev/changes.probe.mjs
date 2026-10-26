/*
 * Paper's calls, before and after, on a scratch host — no browser. The page's requests are made
 * here as each version of the page makes them:
 *
 *   before (Paper main): `/api/proposals` and `/api/uncommitted` every 4 s each while
 *     `document.visibilityState` is visible — which a folded container's page still is.
 *   after (this branch): `use-changes.ts` — shown: one `/api/changes`, the `/api/watch` stream,
 *     `/api/changes?since=<tag>` once a minute and on `changed`; folded: the stream closed, nothing.
 *
 * Counted: the page's requests to Paper, and Paper's `/host/is-project` asks as the host's own
 * record of traffic has them (read through Gamma, `traffic:read`), per minute, SHOWN_MS shown then
 * FOLDED_MS folded. With PUSH=1 (after only) it then checks each kind of change arrives on the
 * stream: an editor's rename, an agent's write, a git checkout, a propose_edit.
 *
 *   HOST_DIR=<kehikko checkout> PAPER_DIR=<paper checkout> VARIANT=before|after node dev/changes.probe.mjs
 *
 * HOST_DIR is a checkout of the Kehikot host: its `dev/scratch-host.mjs` boots the scratch host
 * (scratch HOME and every KEHIKOT_* location, the official list off). Paper is run with scratch
 * KEHIKOT_MODULES_DIR and PAPER_STATE_DIR, so nothing of the machine is read or written. PAPER_DIR
 * must hold a stamped build (`bun run build`); SERVE=vite runs the dev server instead.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, openSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_DIR = process.env.HOST_DIR
const PAPER_DIR = process.env.PAPER_DIR
const VARIANT = process.env.VARIANT ?? 'after'
const SHOWN_MS = Number(process.env.SHOWN_MS ?? 120_000)
const FOLDED_MS = Number(process.env.FOLDED_MS ?? 120_000)
const PUSH = process.env.PUSH === '1'
const SERVE = process.env.SERVE ?? 'run' /* run: serve.ts (ready-built); vite: the dev server */
const BUN = process.env.BUN ?? 'bun'
const { bootHost, scratch, stop } = await import(join(HOST_DIR, 'dev/scratch-host.mjs'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const say = (line) => console.log(`[${VARIANT}${SERVE === 'vite' ? '/vite' : ''}] ${line}`)

let paper = null
try {
  const pageUrl = await bootHost(`paper-${VARIANT}`, { traffic: true })
  const hostPage = new URL(pageUrl).origin
  const gamma = scratch.modules.find((one) => one.id === 'kehikot.gamma').port
  const project = join(scratch.root, 'project-a')
  const epic = 'thesis'
  const dir = join(project, '.kehikot', 'paper', epic)
  mkdirSync(dir, { recursive: true })
  const main = join(dir, 'main.tex')
  const SOURCE = '\\documentclass{article}\n\\begin{document}\n\\section{One}\nThe first claim, said plainly.\n\n\\section{Two}\nThe second claim.\n\\end{document}\n'
  writeFileSync(main, SOURCE)
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe', env: { ...process.env, HOME: join(scratch.root, 'home'), GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@example.invalid', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@example.invalid' } }).toString()
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')

  /* Paper on a port of its own, every location it could write a scratch one. */
  const port = 46_000 + Math.floor(Math.random() * 2_000)
  const origins = [hostPage, `http://127.0.0.1:${scratch.api}`].join(' ')
  const env = { ...process.env }
  for (const key of ['PORT', 'KEHIKOT_ORIGIN', 'KEHIKOT_ORIGINS', 'KEHIKKO_PORT', 'KEHIKKO_API_PORT', 'KEHIKKO_HOST_DIR', 'KEHIKKO_RESTART_FILE']) delete env[key]
  Object.assign(env, {
    HOME: join(scratch.root, 'home'),
    PORT: String(port),
    KEHIKOT_ORIGINS: origins,
    KEHIKOT_ORIGIN: origins,
    KEHIKOT_MODULES_DIR: join(scratch.root, 'modules'),
    KEHIKOT_VERSIONS_DIR: join(scratch.root, 'versions'),
    KEHIKOT_INSTALLS_DIR: join(scratch.root, 'installed'),
    PAPER_STATE_DIR: join(scratch.root, 'paper-state'),
  })
  const log = openSync(join(scratch.root, 'paper.log'), 'a')
  paper = SERVE === 'vite'
    ? spawn(join(PAPER_DIR, 'node_modules/.bin/vite'), ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: PAPER_DIR, env, stdio: ['ignore', log, log] })
    : spawn(BUN, ['run', 'serve.ts'], { cwd: PAPER_DIR, env, stdio: ['ignore', log, log] })
  const at = `http://127.0.0.1:${port}`
  for (let tries = 0; tries < 200; tries += 1) {
    try {
      if ((await fetch(`${at}/healthz`)).ok) break
    } catch {}
    await sleep(100)
  }
  say(`Paper (${SERVE}) at ${at}, pid ${paper.pid}`)

  /* As its own page asks: same-origin. */
  const asPage = { 'sec-fetch-site': 'same-origin' }
  const q = (more = {}) => new URLSearchParams({ project, epic, ...more }).toString()
  const pageAsked = []
  const get = async (path, more) => {
    pageAsked.push({ at: Date.now(), path })
    const response = await fetch(`${at}${path}?${q(more)}`, { headers: asPage })
    return response.json().catch(() => null)
  }

  /* The host's record. */
  let since = 0
  const rows = []
  const read = async () => {
    for (;;) {
      const got = await (await fetch(`http://127.0.0.1:${gamma}/traffic?since=${since}`)).json()
      rows.push(...got.data.calls)
      since = got.data.calls.length ? got.data.calls.at(-1).seq : got.data.newest
      if (got.data.calls.length < 5000) return
    }
  }

  /* ---------------------------------------------------------------- the emulated page */
  let tag = ''
  let stream = null
  let timers = []
  const heard = []
  const openStream = async () => {
    const control = new AbortController()
    const response = await fetch(`${at}/api/watch?${q()}`, { headers: asPage, signal: control.signal })
    pageAsked.push({ at: Date.now(), path: '/api/watch' })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    ;(async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true }))
        if (done) return
        buffered += decoder.decode(value)
        let cut
        while ((cut = buffered.indexOf('\n\n')) !== -1) {
          const block = buffered.slice(0, cut)
          buffered = buffered.slice(cut + 2)
          const event = /^event: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (!event || !data) continue
          const said = JSON.parse(data)
          heard.push({ at: Date.now(), event, tag: said.tag })
          if (said.tag !== tag) void ask()
        }
      }
    })()
    return control
  }
  const ask = async () => {
    const body = await get('/api/changes', { since: tag })
    if (body && typeof body.tag === 'string') tag = body.tag
  }
  const show = async () => {
    if (VARIANT === 'before') {
      const both = () => {
        void get('/api/proposals')
        void get('/api/uncommitted')
      }
      both()
      timers.push(setInterval(both, 4_000))
      return
    }
    await ask()
    stream = await openStream()
    timers.push(setInterval(() => void ask(), 60_000))
  }
  const fold = () => {
    /* The old page cannot tell it is folded: it goes on as it was. */
    if (VARIANT === 'before') return
    for (const timer of timers) clearInterval(timer)
    timers = []
    stream?.abort()
    stream = null
  }

  await read()
  const start = Date.now()
  await show()
  await sleep(SHOWN_MS)
  const foldedAt = Date.now()
  fold()
  await sleep(FOLDED_MS)
  const end = Date.now()
  await read()
  for (const timer of timers) clearInterval(timer)

  const isProject = rows.filter((row) => row.side === 'in' && String(row.path).startsWith('/host/is-project'))
  const perMinute = (list, from, to) => ((list.filter((one) => one.at >= from && one.at < to).length * 60_000) / (to - from)).toFixed(1)
  say(`page → Paper per minute: shown ${perMinute(pageAsked, start, foldedAt)}, folded ${perMinute(pageAsked, foldedAt, end)}`)
  say(`Paper → host /host/is-project per minute (host's record): shown ${perMinute(isProject, start, foldedAt)}, folded ${perMinute(isProject, foldedAt, end)}`)
  const sizes = pageAsked.filter((one) => one.at >= start && one.at < end)
  const byPath = new Map()
  for (const one of sizes) byPath.set(one.path, (byPath.get(one.path) ?? 0) + 1)
  say(`page requests by route over ${Math.round((end - start) / 1000)} s: ${[...byPath].map(([p, n]) => `${p} ${n}`).join(', ')}`)
  if (isProject[0]) say(`an is-project row: ${JSON.stringify({ reason: isProject[0].reason, by: isProject[0].by, via: isProject[0].via, path: String(isProject[0].path).slice(0, 40) })}`)

  /* ---------------------------------------------------------------- push checks */
  if (PUSH && VARIANT === 'after') {
    await show()
    await sleep(1_000)
    const check = async (name, change) => {
      const before = heard.length
      const asked = pageAsked.length
      const t0 = Date.now()
      await change()
      for (let i = 0; i < 100 && heard.length === before; i += 1) await sleep(50)
      const got = heard.slice(before).find((one) => one.event === 'changed')
      await sleep(400)
      say(`push: ${name}: ${got ? `changed after ${got.at - t0} ms, page asked ${pageAsked.length - asked} time(s)` : 'NOTHING within 5 s'}`)
      return Boolean(got)
    }
    await check('an external editor (write a copy, rename it over main.tex)', async () => {
      const copy = join(dir, '.main.tex.tmp')
      writeFileSync(copy, SOURCE.replace('plainly', 'plainly, and again'))
      renameSync(copy, main)
    })
    await check('an agent writing the .tex directly (append)', async () => appendFileSync(main, '% a note an agent added\n'))
    await check('git add from a terminal', async () => git('add', '-A'))
    git('commit', '-q', '-m', 'two')
    await sleep(800)
    await check('git checkout of the previous commit', async () => git('checkout', '-q', 'HEAD~1', '--', '.'))
    await check('a suggestion through propose_edit (MCP)', async () => {
      const reply = await fetch(`${at}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_edit', arguments: { project, epic, file: 'main.tex', find: 'The second claim.', replace: 'The second claim, sharpened.', why: 'Clearer.' } } }),
      })
      const said = await reply.json().catch(() => null)
      const text = said?.result?.content?.[0]?.text ?? JSON.stringify(said)
      if (!/^Filed as/.test(text)) say(`  propose_edit said: ${String(text).slice(0, 160)}`)
    })
    const quiet = heard.length
    await sleep(3_000)
    say(`push: quiet afterwards: ${heard.length === quiet ? 'nothing more said' : `${heard.length - quiet} more event(s)`}`)
    fold()
  }
} catch (error) {
  console.log(`[${VARIANT}] FAILED: ${error?.stack ?? error}`)
} finally {
  if (paper) {
    try {
      process.kill(paper.pid, 'SIGTERM')
    } catch {}
  }
  stop()
  process.exit(0)
}
