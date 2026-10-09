import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildDir, buildStatus, compile, forgetBuilds, readPdf, syncForward } from '../compile/build.ts'
import { BUILD_HEADER, buildStamp } from 'kehikot-module-protocol'
import { TICKET_HEADER, doorsFetch } from 'kehikot-module-protocol/serve'

import { BUILD, MANIFEST, TICKET, answer, later } from '../doors.ts'

/**
 * The build queue, run for real against an engine that is not one.
 *
 * `engine.test.ts` pins what an engine is TOLD. This is what happens around
 * it: where the output goes, that a failure leaves the last good PDF standing,
 * that a newer compile kills an older one. So that this runs on a machine with
 * no TeX at all — and does not take thirty seconds on one that has it — the
 * "engine" is a few lines of shell called `tectonic`, put first on PATH for
 * the length of this file. It writes the source back out as the "PDF", fails
 * when the source says BROKEN, and dawdles when it says SLOW.
 */

let root = ''
let project = ''
let paper = ''
let bin = ''
let pathWas: string | undefined

const FAKE = `#!/bin/sh
ALL="$*"
while [ $# -gt 1 ]; do
  if [ "$1" = "--outdir" ]; then OUT="$2"; fi
  shift
done
MAIN="$1"
echo "$ALL" >> "$OUT/args"
/bin/pwd > "$OUT/cwd"
echo "note: Running TeX ..." >&2
if /usr/bin/grep -q SLOW "$MAIN"; then /bin/sleep 6; fi
if /usr/bin/grep -q BROKEN "$MAIN"; then
  echo "error: main.tex:3: Undefined control sequence" >&2
  echo "error: halted on potentially-recoverable error as specified" >&2
  exit 1
fi
/bin/cat "$MAIN" > "$OUT/main.pdf"
exit 0
`

const GOOD = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n'
const write = (text: string) => writeFileSync(join(paper, 'main.tex'), text)

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'paper-build-')))
  project = join(root, 'project')
  paper = join(project, '.kehikot', 'paper', 'a-paper')
  bin = join(root, 'bin')
  mkdirSync(paper, { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, 'tectonic'), FAKE)
  chmodSync(join(bin, 'tectonic'), 0o755)
  pathWas = process.env.PATH
  process.env.PATH = `${bin}:${pathWas ?? ''}`
})

afterAll(() => {
  forgetBuilds()
  process.env.PATH = pathWas
  rmSync(buildDir(paper), { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => write(GOOD))

describe('a compile', () => {
  test('makes a PDF, in the temp directory, and leaves the paper’s folder exactly as it was', async () => {
    const status = (await compile('a-paper', project))!
    expect(status.engine).toBe('tectonic')
    expect(status.running).toBe(false)
    expect(status.last).toMatchObject({ ok: true, engine: 'tectonic', timedOut: false, problems: [] })
    expect(status.pdf?.id).toMatch(/^[0-9a-f]{16}$/)
    expect(Buffer.from(readPdf('a-paper', project)!.bytes).toString()).toBe(GOOD)

    expect(readdirSync(paper)).toEqual(['main.tex'])
    expect(buildDir(paper).startsWith(join(realpathSync(tmpdir()), 'kehikot-paper')) || buildDir(paper).startsWith(join(tmpdir(), 'kehikot-paper'))).toBe(true)
    expect(buildDir(paper)).not.toContain(project)
  })

  test('the engine was run in the paper’s folder, untrusted, cached-only first, and only once when that works', async () => {
    await compile('a-paper', project)
    const work = join(buildDir(paper), 'work')
    expect(realpathSync(readFileSync(join(work, 'cwd'), 'utf8').trim())).toBe(paper)
    const runs = readFileSync(join(work, 'args'), 'utf8').trim().split('\n')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toContain('--untrusted')
    expect(runs[0]).toContain('--only-cached')
    expect(runs[0]).not.toContain('shell-escape')
  })

  test('the PDF records which source it was made from', async () => {
    const status = (await compile('a-paper', project))!
    expect(Object.keys(status.pdf!.hashes)).toEqual(['main.tex'])
    expect(buildStatus('a-paper', project)!.pdf!.id).toBe(status.pdf!.id)
  })
})

describe('a compile that fails', () => {
  test('says where, and the last good PDF is still the one served', async () => {
    const good = (await compile('a-paper', project))!
    write(GOOD.replace('Hello.', 'BROKEN \\nope'))
    const bad = (await compile('a-paper', project))!
    expect(bad.last?.ok).toBe(false)
    expect(bad.last?.problems).toEqual([{ severity: 'error', file: 'main.tex', line: 3, message: 'Undefined control sequence' }])
    expect(bad.last?.tail).toContain('Undefined control sequence')
    expect(bad.pdf?.id).toBe(good.pdf!.id)
    expect(Buffer.from(readPdf('a-paper', project)!.bytes).toString()).toBe(GOOD)
    /* …and it says it is of older text, by the hashes it carries. */
    expect(bad.pdf!.hashes['main.tex']).toBe(good.pdf!.hashes['main.tex']!)
  })

  test('with no synctex in the build there is nothing to navigate by, and that is an answer', async () => {
    await compile('a-paper', project)
    expect(syncForward('a-paper', project, 'main.tex', 3, 3)).toBeNull()
  })
})

describe('one at a time, and the latest wins', () => {
  test('a newer compile kills the one running; both callers get the newer result', async () => {
    write(GOOD.replace('Hello.', 'SLOW'))
    const started = Date.now()
    const slow = compile('a-paper', project)
    await new Promise((done) => setTimeout(done, 300))
    expect(buildStatus('a-paper', project)!.running).toBe(true)
    const next = GOOD.replace('Hello.', 'The newer text.')
    write(next)
    const [a, b] = await Promise.all([slow, compile('a-paper', project)])
    /* Well under the six seconds the slow one would have taken. */
    expect(Date.now() - started).toBeLessThan(4000)
    expect(Buffer.from(readPdf('a-paper', project)!.bytes).toString()).toBe(next)
    expect(a!.pdf!.id).toBe(b!.pdf!.id)
    expect(b!.last?.ok).toBe(true)
    expect(b!.running).toBe(false)
  }, 15000)
})

describe('which engine', () => {
  test('a paper that names an engine this machine lacks is told so, and nothing is run', async () => {
    write(`% !TEX program = arara\n${GOOD}`)
    const status = (await compile('a-paper', project))!
    expect(status.engine).toBeNull()
    expect(status.how).toContain('arara')
  })

  test('an epic with no paper is nothing to build', async () => {
    expect(await compile('no-such-paper', project)).toBeNull()
    expect(buildStatus('no-such-paper', project)).toBeNull()
    expect(readPdf('no-such-paper', project)).toBeNull()
  })
})

describe('the doors in front of it', () => {
  const query = () => new URLSearchParams({ epic: 'a-paper', project })

  test('compiling needs the ticket; with it, the answer is the build', async () => {
    expect((await later('POST', '/api/compile', query(), { anything: 1 }))?.status).toBe(403)
    const reply = await later('POST', '/api/compile', query(), {}, TICKET)
    expect(reply?.status).toBe(200)
    expect((reply?.body as { build: { last: { ok: boolean } } }).build.last.ok).toBe(true)
    expect(later('GET', '/api/compile', query(), null)).toBeNull()
    expect(later('POST', '/api/file', query(), {}, TICKET)).toBeNull()
  })

  test('the PDF is served as a PDF, and the status without compiling', async () => {
    await compile('a-paper', project)
    const pdf = answer('GET', '/api/pdf', query(), null)
    expect(pdf?.raw?.type).toBe('application/pdf')
    expect(Buffer.from(pdf!.raw!.bytes as Uint8Array).toString()).toBe(GOOD)
    const status = answer('GET', '/api/build', query(), null)
    expect((status?.body as { build: { engine: string } }).build.engine).toBe('tectonic')
    expect(answer('GET', '/api/pdf', new URLSearchParams({ epic: 'no-such-paper', project }), null)?.status).toBe(404)
  })

  test('through the real doors: the PDF may be kept by the browser, nothing else may, and the ticket is a header', async () => {
    /* The same options `vite.config.ts` names, as one request goes through them. */
    const through = doorsFetch({
      manifest: MANIFEST,
      answer: (method, path, asked, body, ticket) => later(method, path, asked, body, ticket) ?? answer(method, path, asked, body, ticket),
      build: BUILD,
      page: { title: 'Paper', ticket: TICKET },
      maxBodyBytes: 6_000_000,
    })
    const at = (path: string, init?: RequestInit) => through(new Request(`http://127.0.0.1${path}?${query()}`, init))

    await compile('a-paper', project)
    const pdf = (await at('/api/pdf'))!
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    /* Not `no-store`: its address carries the build it came from so that it can
       be kept, and before `doors()` it went out with no cache header at all. */
    expect(pdf.headers.get('cache-control')).toBe('private')
    expect(pdf.headers.get('x-content-type-options')).toBe('nosniff')
    expect(pdf.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(await pdf.text()).toBe(GOOD)

    const status = (await at('/api/build'))!
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(status.headers.get(BUILD_HEADER)).toBe(buildStamp(BUILD))

    /* A write carries the ticket in the header every module uses; without it the refusal is marked. */
    const refused = (await at('/api/compile', { method: 'POST', body: '{}' }))!
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ ok: false, refused: 'ticket' })
    expect((await at('/api/compile', { method: 'POST', body: '{}', headers: { [TICKET_HEADER]: TICKET } }))!.status).toBe(200)

    const page = await (await through(new Request('http://127.0.0.1/app')))!.text()
    expect(page).toContain(`<script id="ticket" type="application/json">${JSON.stringify(TICKET)}</script>`)
    expect(page).toContain('id="build"')
  })

  test('sync asks are checked before they are answered', () => {
    expect(answer('GET', '/api/sync', new URLSearchParams({ epic: 'a-paper', project, file: 'main.tex' }), null)?.status).toBe(400)
    expect(answer('GET', '/api/sync', new URLSearchParams({ epic: 'a-paper', project, page: '0', x: '1', y: '1' }), null)?.status).toBe(400)
    expect(answer('GET', '/api/sync', new URLSearchParams({ epic: 'a-paper', project, page: '1', x: '1', y: '1' }), null)?.status).toBe(200)
  })

  test('the build folder exists where it was said to, with the two halves', async () => {
    await compile('a-paper', project)
    expect(existsSync(join(buildDir(paper), 'good', 'main.pdf'))).toBe(true)
    expect(existsSync(join(buildDir(paper), 'good', 'meta.json'))).toBe(true)
    expect(existsSync(join(buildDir(paper), 'work'))).toBe(true)
  })
})
