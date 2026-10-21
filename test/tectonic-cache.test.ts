import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { sandboxDenied, tectonicKeeps } from '../compile/build.ts'
import { SANDBOX_EXEC, macArgv, type Places } from '../compile/confine.ts'

/**
 * Where the sandbox lets Tectonic keep its packages. Tectonic 0.17 moved its
 * cache on a Mac from `Caches/Tectonic` to `Caches/TectonicProject.Tectonic`;
 * the sandbox named only the first and every compile died on "Operation not permitted".
 */

let home = ''
beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'paper-keeps-')))
  mkdirSync(join(home, 'Library', 'Caches'), { recursive: true })
  mkdirSync(join(home, '.cache'), { recursive: true })
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('the folders kept for Tectonic', () => {
  test('a Mac keeps both the 0.17 folder and the older one, before either exists', () => {
    expect(tectonicKeeps({}, home, 'darwin')).toEqual([
      join(home, 'Library', 'Caches', 'TectonicProject.Tectonic'),
      join(home, 'Library', 'Caches', 'Tectonic'),
    ])
  })

  test('one that exists is named by its real path', () => {
    mkdirSync(join(home, 'Library', 'Caches', 'Tectonic'), { recursive: true })
    expect(tectonicKeeps({}, home, 'darwin')).toContain(join(home, 'Library', 'Caches', 'Tectonic'))
    rmSync(join(home, 'Library', 'Caches', 'Tectonic'), { recursive: true })
  })

  test('Linux keeps $XDG_CACHE_HOME/Tectonic, or ~/.cache/Tectonic', () => {
    expect(tectonicKeeps({}, home, 'linux')).toEqual([join(home, '.cache', 'Tectonic')])
    expect(tectonicKeeps({ XDG_CACHE_HOME: join(home, '.cache') }, home, 'linux')).toEqual([join(home, '.cache', 'Tectonic')])
  })

  test('TECTONIC_CACHE_DIR wins alone, on every platform', () => {
    const at = join(home, 'mine')
    mkdirSync(at)
    expect(tectonicKeeps({ TECTONIC_CACHE_DIR: at }, home, 'darwin')).toEqual([at])
    expect(tectonicKeeps({ TECTONIC_CACHE_DIR: at }, home, 'linux')).toEqual([at])
  })

  test('a folder that is not there yet is still allowed, if its parent is; a relative or parentless one is not', () => {
    expect(tectonicKeeps({ TECTONIC_CACHE_DIR: join(home, 'not', 'yet') }, home, 'linux')).toEqual([])
    expect(tectonicKeeps({ TECTONIC_CACHE_DIR: join(home, 'later') }, home, 'linux')).toEqual([join(home, 'later')])
    expect(tectonicKeeps({ TECTONIC_CACHE_DIR: 'relative' }, home, 'linux')).toEqual([])
    expect(tectonicKeeps({}, null, 'darwin')).toEqual([])
  })

  test('the sandbox profile receives a not-yet-existing folder as a named parameter', () => {
    const places: Places = { paper: '/p', project: null, build: '/b', cache: '/c', tex: [], kept: tectonicKeeps({}, home, 'darwin'), home }
    const argv = macArgv(places, ['x'])!
    expect(argv).toContain(`KEPT0=${join(home, 'Library', 'Caches', 'TectonicProject.Tectonic')}`)
    expect(argv).toContain(`KEPT1=${join(home, 'Library', 'Caches', 'Tectonic')}`)
  })
})

describe('the sentence for a sandbox refusal', () => {
  const places: Places = { paper: '/p', project: null, build: '/b', cache: '/c', tex: [], kept: ['/h/Library/Caches/X'], home: '/h' }
  const panic = "thread 'main' panicked: called `Result::unwrap()` on an `Err` value: Operation not permitted (os error 1)"
  test('names the sandbox and the cache folder', () => {
    const said = sandboxDenied('tectonic', panic, places)!
    expect(said).toContain('sandbox')
    expect(said).toContain('/h/Library/Caches/X')
    expect(said).toContain('TECTONIC_CACHE_DIR')
  })
  test('says nothing for another engine, another failure or no sandbox', () => {
    expect(sandboxDenied('latexmk', panic, places)).toBeNull()
    expect(sandboxDenied('tectonic', 'error: oops', places)).toBeNull()
    expect(sandboxDenied('tectonic', panic, null)).toBeNull()
  })
})

const tectonic = ['/opt/homebrew/bin/tectonic', '/usr/local/bin/tectonic'].find(existsSync)
const realCache = join(process.env.HOME ?? '', 'Library', 'Caches', 'Tectonic')
const canRun = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && tectonic !== undefined && existsSync(realCache)

/* Skipped without Tectonic, or without a cache to copy: a compile with no network needs the bundle already fetched. */
describe.skipIf(!canRun)('a real Tectonic in the sandbox, with a scratch HOME', () => {
  test('compiles a tiny paper using the kept cache folders', () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'paper-tectonic-')))
    try {
      const fake = join(scratch, 'home')
      mkdirSync(join(fake, 'Library', 'Caches'), { recursive: true })
      cpSync(realCache, join(fake, 'Library', 'Caches', 'Tectonic'), { recursive: true })
      const paper = join(scratch, 'paper')
      const build = join(scratch, 'build')
      mkdirSync(paper)
      mkdirSync(build)
      writeFileSync(join(paper, 'main.tex'), '\\documentclass{article}\\begin{document}Hi\\end{document}')
      const places: Places = { paper, project: null, build, cache: build, tex: [], kept: tectonicKeeps({}, fake, 'darwin'), home: fake }
      const argv = macArgv(places, [tectonic!, '-C', '--outdir', build, join(paper, 'main.tex')])!
      const ran = spawnSync(argv[0]!, argv.slice(1), { cwd: paper, encoding: 'utf8', env: { HOME: fake, PATH: '/usr/bin:/bin' }, timeout: 120_000 })
      expect(ran.stderr).not.toContain('Operation not permitted')
      expect(ran.status).toBe(0)
      expect(existsSync(join(build, 'main.pdf'))).toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 150_000)
})
