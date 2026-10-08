import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { createInstaller, extract, toolsDir, trusted, type Installer } from '../compile/install.ts'
import type { Artefact } from '../compile/toolchain.ts'
import { TICKET, answer } from '../doors.ts'
import { tarOf, zipOf, type Entry } from './archives.ts'

/**
 * The installer, run for real against a server that is not one.
 *
 * Everything but the network is the real thing: the files are written,
 * hashed, unpacked and renamed on disk, in a folder of this test's own. The
 * "network" is a function that answers the addresses a row names with bytes
 * this file made — so the cases that matter can be staged: the wrong bytes, a
 * redirect to somewhere else, a connection that dies half way, no connection.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'paper-install-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const TECTONIC = Buffer.from('#!/bin/sh\necho "Tectonic 0.17.0"\n')
const BIBER = Buffer.from(`#!/bin/sh\necho "biber version: 2.17"\n${'# padding\n'.repeat(20_000)}`)

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function row(piece: 'tectonic' | 'biber', archive: Buffer, more: Partial<Artefact> = {}): Artefact {
  return {
    piece,
    version: piece === 'tectonic' ? '0.17.0' : '2.17',
    url: `https://origin.test/${piece}.tar.gz`,
    via: ['mirror.test', '.dl.test'],
    bytes: archive.length,
    sha256: sha(archive),
    format: 'tar.gz',
    entry: piece,
    unpacked: 1_000_000,
    ...more,
  }
}

const tectonicArchive = gzipSync(tarOf([{ name: 'tectonic', data: TECTONIC }]))
const biberArchive = gzipSync(tarOf([{ name: 'biber', data: BIBER }]), { level: 0 })

interface Asked {
  url: string
  range: string | null
}

/** A server: the origin redirects to a mirror, the mirror has the bytes and honours Range. */
function server(files: Record<string, Buffer>, options: { mirror?: string; cutAfter?: number; hold?: Promise<void>; chunk?: number } = {}) {
  const asked: Asked[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const range = new Headers(init?.headers).get('range')
    asked.push({ url, range })
    const { hostname, pathname } = new URL(url)
    if (hostname === 'origin.test') {
      return new Response(null, { status: 302, headers: { location: `${options.mirror ?? 'https://mirror.test'}${pathname}?sig=1` } })
    }
    const bytes = files[pathname.slice(1)]
    if (!bytes) return new Response('no', { status: 404 })
    const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    const rest = bytes.subarray(from)
    const signal = init?.signal
    const step = options.chunk ?? 4096
    let at = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) return controller.error(new DOMException('aborted', 'AbortError'))
        if (options.cutAfter !== undefined && from + at >= options.cutAfter) return controller.error(new TypeError('fetch failed: socket hang up'))
        if (options.hold && at >= step) {
          await Promise.race([options.hold, new Promise<void>((done) => signal?.addEventListener('abort', () => done()))])
          if (signal?.aborted) return controller.error(new DOMException('aborted', 'AbortError'))
        }
        if (at >= rest.length) return controller.close()
        controller.enqueue(rest.subarray(at, at + step))
        at += step
      },
    })
    return new Response(body, { status: from > 0 ? 206 : 200 })
  }) as typeof fetch
  return { fetcher, asked }
}

let dir = ''
let n = 0
beforeEach(() => {
  dir = join(root, `tools-${(n += 1)}`)
})

const make = (artefacts: Artefact[], fetcher: typeof fetch, probe: (path: string) => Promise<string | null> = async () => '3.17'): Installer =>
  createInstaller({ dir, artefacts, fetch: fetcher, probe })

const both = () => [row('tectonic', tectonicArchive), row('biber', biberArchive)]

describe('installing', () => {
  test('each piece is downloaded, checked, unpacked to its own folder, made executable — and only the row’s addresses are asked', async () => {
    const net = server({ 'tectonic.tar.gz': tectonicArchive, 'biber.tar.gz': biberArchive })
    const tools = make(both(), net.fetcher)
    expect(tools.status().pieces.map((one) => one.installed)).toEqual([false, false])
    expect(tools.managed()).toEqual({ tectonic: null, biber: null, biberDir: null })

    const started = tools.install()
    expect(started.running).toBe(true)
    expect(started.total).toBe(tectonicArchive.length + biberArchive.length)
    await tools.settled()

    const after = tools.status()
    expect(after.error).toBeNull()
    expect(after.running).toBe(false)
    expect(after.received).toBe(after.total)
    expect(after.pieces.map((one) => one.installed)).toEqual([true, true])
    expect(tools.managed()).toEqual({ tectonic: join(dir, 'tectonic-0.17.0', 'tectonic'), biber: join(dir, 'biber-2.17', 'biber'), biberDir: join(dir, 'biber-2.17') })
    expect(readFileSync(join(dir, 'tectonic-0.17.0', 'tectonic')).equals(TECTONIC)).toBe(true)
    expect(readFileSync(join(dir, 'biber-2.17', 'biber')).equals(BIBER)).toBe(true)
    expect(statSync(join(dir, 'biber-2.17', 'biber')).mode & 0o111).toBe(0o111)
    /* The biber's folder holds the biber and nothing else: it goes on a PATH. */
    expect(readdirSync(join(dir, 'biber-2.17'))).toEqual(['biber'])
    /* Nothing half-made is left beside them. */
    expect(readdirSync(dir).sort()).toEqual(['biber-2.17', 'tectonic-0.17.0'])
    expect(statSync(dir).mode & 0o077).toBe(0)
    expect(net.asked.map((one) => new URL(one.url).hostname)).toEqual(['origin.test', 'mirror.test', 'origin.test', 'mirror.test'])
  })

  test('again is nothing: what is there is not fetched twice, and one missing piece is fetched alone', async () => {
    const net = server({ 'tectonic.tar.gz': tectonicArchive, 'biber.tar.gz': biberArchive })
    const tools = make(both(), net.fetcher)
    tools.install(['tectonic'])
    await tools.settled()
    expect(tools.status().pieces.map((one) => one.installed)).toEqual([true, false])
    const asked = net.asked.length

    const again = tools.install(['tectonic'])
    expect(again.running).toBe(false)
    expect(again.wanted).toEqual([])
    expect(net.asked.length).toBe(asked)

    tools.install()
    expect(tools.status().wanted).toEqual(['biber'])
    await tools.settled()
    expect(tools.status().pieces.map((one) => one.installed)).toEqual([true, true])
    expect(net.asked.slice(asked).every((one) => one.url.includes('biber'))).toBe(true)
  })

  test('one at a time: a second press while one runs is that install, not another', async () => {
    let release = () => {}
    const hold = new Promise<void>((done) => (release = done))
    const net = server({ 'tectonic.tar.gz': tectonicArchive }, { hold, chunk: 64 })
    const tools = make([row('tectonic', tectonicArchive)], net.fetcher)
    tools.install()
    await new Promise((done) => setTimeout(done, 30))
    const second = tools.install()
    expect(second.running).toBe(true)
    expect(second.received).toBeGreaterThan(0)
    expect(second.received).toBeLessThan(second.total)
    release()
    await tools.settled()
    expect(tools.status().pieces[0]!.installed).toBe(true)
    expect(net.asked.filter((one) => one.url.startsWith('https://mirror.test')).length).toBe(1)
  })
})

describe('what is refused', () => {
  test('bytes that are not the pinned file are deleted, said, and never unpacked', async () => {
    const wrong = Buffer.from(tectonicArchive)
    wrong[wrong.length - 5]! ^= 0xff
    const net = server({ 'tectonic.tar.gz': wrong })
    const tools = make([row('tectonic', tectonicArchive)], net.fetcher)
    tools.install()
    await tools.settled()
    const after = tools.status()
    expect(after.error).toContain('is not the file this module pins')
    expect(after.error).toContain(sha(wrong))
    expect(after.pieces[0]!.installed).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  test('a longer file than the row says is stopped before it is all taken', async () => {
    const net = server({ 'tectonic.tar.gz': Buffer.concat([tectonicArchive, Buffer.alloc(50_000, 1)]) })
    const tools = make([row('tectonic', tectonicArchive)], net.fetcher)
    tools.install()
    await tools.settled()
    expect(tools.status().error).toContain('sent more than')
    expect(tools.managed().tectonic).toBeNull()
  })

  test('a redirect to a host the row does not name is not followed', async () => {
    const net = server({ 'tectonic.tar.gz': tectonicArchive }, { mirror: 'https://elsewhere.test' })
    const tools = make([row('tectonic', tectonicArchive)], net.fetcher)
    tools.install()
    await tools.settled()
    expect(tools.status().error).toContain('somewhere this module does not download from')
    expect(net.asked.map((one) => new URL(one.url).hostname)).toEqual(['origin.test'])
    expect(tools.managed().tectonic).toBeNull()
  })

  test('no network is a sentence about the network', async () => {
    const tools = make([row('tectonic', tectonicArchive)], (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    tools.install()
    await tools.settled()
    expect(tools.status().error).toBe('origin.test could not be reached, so nothing was downloaded. Check that this machine is online and try again.')
  })

  test('a tools folder that somebody else could write into is not installed into or run from', async () => {
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o777)
    expect(trusted(dir)).toBe(false)
    const net = server({ 'tectonic.tar.gz': tectonicArchive })
    const tools = make([row('tectonic', tectonicArchive)], net.fetcher)
    tools.install()
    await tools.settled()
    expect(tools.status().error).toContain('is not this user’s alone')
    expect(net.asked).toEqual([])
    /* And a program already sitting in such a folder is not believed. */
    mkdirSync(join(dir, 'tectonic-0.17.0'))
    writeFileSync(join(dir, 'tectonic-0.17.0', 'tectonic'), TECTONIC, { mode: 0o755 })
    expect(tools.managed().tectonic).toBeNull()
    chmodSync(dir, 0o700)
    expect(tools.managed().tectonic).toBe(join(dir, 'tectonic-0.17.0', 'tectonic'))
  })

  test('a bundle that has moved to another biblatex gets Tectonic, and not the wrong biber', async () => {
    const net = server({ 'tectonic.tar.gz': tectonicArchive, 'biber.tar.gz': biberArchive })
    const tools = make(both(), net.fetcher, async () => '3.20')
    tools.install()
    await tools.settled()
    const after = tools.status()
    expect(after.pieces.map((one) => one.installed)).toEqual([true, false])
    expect(after.error).toContain('biblatex 3.20, which wants biber 2.20')
    expect(net.asked.some((one) => one.url.includes('biber'))).toBe(false)
  })

  test('a bundle that cannot be asked is not a reason to stop', async () => {
    const net = server({ 'tectonic.tar.gz': tectonicArchive, 'biber.tar.gz': biberArchive })
    const tools = make(both(), net.fetcher, async () => null)
    tools.install()
    await tools.settled()
    expect(tools.status().pieces.map((one) => one.installed)).toEqual([true, true])
  })
})

describe('stopping, and carrying on', () => {
  test('cancel stops the download, is not an error, and keeps what arrived', async () => {
    const net = server({ 'biber.tar.gz': biberArchive }, { hold: new Promise(() => {}), chunk: 10_000 })
    const tools = make([row('biber', biberArchive)], net.fetcher)
    tools.install()
    await new Promise((done) => setTimeout(done, 30))
    expect(tools.status().running).toBe(true)
    tools.cancel()
    await tools.settled()
    const after = tools.status()
    expect(after.running).toBe(false)
    expect(after.error).toBeNull()
    expect(after.pieces[0]!.installed).toBe(false)
    expect(readdirSync(dir)).toEqual(['biber-2.17.tar.gz.part'])
  })

  test('a download that died is picked up where it stopped, and the checksum is still of the whole file', async () => {
    const cut = server({ 'biber.tar.gz': biberArchive }, { cutAfter: 40_000 })
    const first = make([row('biber', biberArchive)], cut.fetcher)
    first.install()
    await first.settled()
    expect(first.status().error).toContain('could not be reached')
    const had = statSync(join(dir, 'biber-2.17.tar.gz.part')).size
    expect(had).toBeGreaterThan(0)
    expect(had).toBeLessThan(biberArchive.length)

    const net = server({ 'biber.tar.gz': biberArchive })
    const second = make([row('biber', biberArchive)], net.fetcher)
    const started = second.install()
    expect(started.error).toBeNull()
    await second.settled()
    expect(net.asked.at(-1)!.range).toBe(`bytes=${had}-`)
    expect(second.status().error).toBeNull()
    expect(readFileSync(join(dir, 'biber-2.17', 'biber')).equals(BIBER)).toBe(true)
    expect(readdirSync(dir)).toEqual(['biber-2.17'])
  })

  test('a kept part that is not part of the pinned file fails the checksum and is thrown away, so the next try is clean', async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'biber-2.17.tar.gz.part'), Buffer.alloc(1000, 9))
    const net = server({ 'biber.tar.gz': biberArchive })
    const tools = make([row('biber', biberArchive)], net.fetcher)
    tools.install()
    await tools.settled()
    expect(tools.status().error).toContain('is not the file this module pins')
    expect(existsSync(join(dir, 'biber-2.17.tar.gz.part'))).toBe(false)
    tools.install()
    await tools.settled()
    expect(tools.status().error).toBeNull()
    expect(tools.managed().biber).not.toBeNull()
  })
})

describe('taking the one file out of an archive', () => {
  const unpack = async (entries: Entry[], more: Partial<Artefact> = {}) => {
    mkdirSync(dir, { recursive: true })
    const archive = join(dir, 'a.tar.gz')
    writeFileSync(archive, gzipSync(tarOf(entries)))
    await extract({ format: 'tar.gz', entry: 'biber', unpacked: 1_000_000, ...more }, archive, join(dir, 'out'))
    return readFileSync(join(dir, 'out'))
  }

  test('only that file, wherever it is in the archive, and nothing else is written', async () => {
    const out = await unpack([{ name: 'README', data: Buffer.from('read me') }, { name: 'docs/', type: '5' }, { name: './biber', data: BIBER }, { name: 'LICENSE', data: Buffer.alloc(700, 65) }])
    expect(out.equals(BIBER)).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['a.tar.gz', 'out'])
  })

  test('an archive holding a name that climbs out of the folder is refused whole', async () => {
    await expect(unpack([{ name: '../../.zshrc', data: Buffer.from('x') }, { name: 'biber', data: BIBER }])).rejects.toThrow('no honest archive')
    await expect(unpack([{ name: 'biber', data: BIBER }, { name: '/etc/cron.d/x', data: Buffer.from('x') }])).rejects.toThrow('no honest archive')
  })

  test('a link where the program should be is refused; so is the program twice, missing, too large, or cut short', async () => {
    await expect(unpack([{ name: 'biber', type: '2' }])).rejects.toThrow('is not a file')
    await expect(unpack([{ name: 'biber', data: BIBER }, { name: 'biber', data: BIBER }])).rejects.toThrow('twice')
    await expect(unpack([{ name: 'other', data: BIBER }])).rejects.toThrow('does not hold biber')
    await expect(unpack([{ name: 'biber', data: BIBER }], { unpacked: 100 })).rejects.toThrow('not the size it should be')
    mkdirSync(dir, { recursive: true })
    const whole = tarOf([{ name: 'biber', data: BIBER }])
    writeFileSync(join(dir, 'cut.tar.gz'), gzipSync(whole.subarray(0, 2048)))
    await expect(extract({ format: 'tar.gz', entry: 'biber', unpacked: 1e6 }, join(dir, 'cut.tar.gz'), join(dir, 'out2'))).rejects.toThrow('cut short')
    writeFileSync(join(dir, 'junk.tar.gz'), gzipSync(Buffer.alloc(4096, 3)))
    await expect(extract({ format: 'tar.gz', entry: 'biber', unpacked: 1e6 }, join(dir, 'junk.tar.gz'), join(dir, 'out3'))).rejects.toThrow('not a tar archive')
  })

  test('a zip gives up its one file the same way', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.zip'), zipOf([{ name: 'tectonic.exe', data: TECTONIC }], null))
    await extract({ format: 'zip', entry: 'tectonic.exe', unpacked: 1e6 }, join(dir, 'a.zip'), join(dir, 'out.exe'))
    expect(readFileSync(join(dir, 'out.exe')).equals(TECTONIC)).toBe(true)
  })

  test('a tools folder that is a link to somewhere is not a tools folder', () => {
    mkdirSync(join(dir, 'real'), { recursive: true, mode: 0o700 })
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    expect(trusted(join(dir, 'real'))).toBe(true)
    expect(trusted(join(dir, 'link'))).toBe(false)
    expect(trusted(join(dir, 'absent'))).toBe(false)
  })
})

describe('the doors in front of it', () => {
  const envWas = process.env.KEHIKOT_PAPER_TOOLS_DIR
  const fetchWas = globalThis.fetch
  let fetched = 0
  beforeEach(() => {
    process.env.KEHIKOT_PAPER_TOOLS_DIR = dir
    fetched = 0
    globalThis.fetch = (async () => {
      fetched += 1
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = fetchWas
    if (envWas === undefined) delete process.env.KEHIKOT_PAPER_TOOLS_DIR
    else process.env.KEHIKOT_PAPER_TOOLS_DIR = envWas
  })
  const none = new URLSearchParams()

  test('where the tools go is the temp directory unless it is said otherwise', () => {
    expect(toolsDir({})).toBe(join(tmpdir(), 'kehikot-paper-tools'))
    expect(toolsDir({ KEHIKOT_PAPER_TOOLS_DIR: '/x/tools' })).toBe('/x/tools')
  })

  test('the status is a read: it says what would be fetched and fetches nothing', () => {
    const reply = answer('GET', '/api/toolchain', none, null)
    expect(reply?.status).toBe(200)
    const toolchain = (reply!.body as { toolchain: { dir: string; running: boolean; pieces: { url: string; installed: boolean }[] } }).toolchain
    expect(toolchain.dir).toBe(dir)
    expect(toolchain.running).toBe(false)
    expect(toolchain.pieces.every((one) => one.url.startsWith('https://') && !one.installed)).toBe(true)
    expect(fetched).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  test('starting a download needs the ticket, and so does stopping one', () => {
    expect(answer('POST', '/api/toolchain/install', none, { pieces: ['tectonic'] })?.status).toBe(403)
    expect(answer('POST', '/api/toolchain/install', none, { ticket: 'guess' })?.status).toBe(403)
    expect(answer('POST', '/api/toolchain/install', none, null)?.status).toBe(403)
    expect(answer('POST', '/api/toolchain/cancel', none, {})?.status).toBe(403)
    expect(answer('GET', '/api/toolchain/install', none, null)?.status).toBe(404)
    expect(fetched).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  test('with it, the download starts and the answer does not wait for it; the caller chooses pieces and nothing else', async () => {
    const reply = answer('POST', '/api/toolchain/install', none, { ticket: TICKET, pieces: ['biber', 'rm -rf', 7], url: 'https://example.com/x', dir: '/tmp/x' })
    expect(reply?.status).toBe(200)
    const toolchain = (reply!.body as { toolchain: { running: boolean; wanted: string[]; dir: string } }).toolchain
    expect(toolchain.running).toBe(true)
    expect(toolchain.wanted).toEqual(['biber'])
    expect(toolchain.dir).toBe(dir)
    expect(answer('POST', '/api/toolchain/cancel', none, { ticket: TICKET })?.status).toBe(200)
    /* Wait for it to end, so the fake network's refusal is on record. */
    for (let i = 0; i < 100; i += 1) {
      const now = (answer('GET', '/api/toolchain', none, null)!.body as { toolchain: { running: boolean } }).toolchain
      if (!now.running) break
      await new Promise((done) => setTimeout(done, 10))
    }
    expect((answer('GET', '/api/toolchain', none, null)!.body as { toolchain: { running: boolean } }).toolchain.running).toBe(false)
  })

  test('there is no tool on the MCP door that installs anything', () => {
    const listed = answer('POST', '/mcp', none, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const said = JSON.stringify(listed?.body ?? '')
    expect(said).toContain('read_paper')
    expect(said).not.toMatch(/install|toolchain|download/i)
  })
})
