import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The page greets the host before anything heavy has loaded.
 *
 * A host gives a framed page a few seconds to answer its greeting. The answer comes from the
 * protocol's client, which listens from the moment the entry is evaluated — so anything the entry
 * imports statically is evaluated, parsed and run BEFORE the page can answer. pdf.js is a
 * megabyte and a half with its worker; if it were reached by a static import the page would
 * answer late on a busy machine, which is the condition a host used to call "not answering".
 * Measured in WebKit on the built page: the greeting is answered in about 60 ms, pdf.js loads
 * later, when a PDF is first drawn.
 */

const ROOT = join(import.meta.dir, '..')
const SRC = join(ROOT, 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/** Static imports and re-exports of a specifier, at the start of a line. */
const STATIC = /^\s*(?:import|export)\s[^;'"()]*?["']([^"']+)["']/gm

describe('the page answers before pdf.js loads', () => {
  test('nothing in the page imports pdf.js statically: only `import()`, when a PDF is drawn', () => {
    const offenders: string[] = []
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(STATIC)) if (match[1]?.startsWith('pdfjs-dist')) offenders.push(`${file}: ${match[1]}`)
    }
    expect(offenders).toEqual([])
    /* And it IS loaded lazily, so the test above is not passing on a page that lost its PDF. */
    expect(readFileSync(join(SRC, 'pdf', 'pdf-view.tsx'), 'utf8')).toContain("import('pdfjs-dist/legacy/build/pdf.mjs')")
  })

  test('the entry imports the client before the app, so the page listens as it is evaluated', () => {
    const entry = readFileSync(join(SRC, 'main.tsx'), 'utf8')
    const imports = [...entry.matchAll(STATIC)].map((match) => match[1])
    const client = imports.indexOf('kehikot-module-protocol/client')
    const app = imports.indexOf('./app.tsx')
    expect(client).toBeGreaterThanOrEqual(0)
    expect(app).toBeGreaterThan(client)
  })

  test('a page that throws while starting says why: the root is mounted through the reporting mount', () => {
    const entry = readFileSync(join(SRC, 'main.tsx'), 'utf8')
    expect(entry).toContain("from 'kehikot-module-protocol/client/mount'")
    expect(entry).toMatch(/mountPage\(/)
  })
})
