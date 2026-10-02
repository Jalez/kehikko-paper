import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pdftoppm, readFigure, type Rasterize } from '../store.ts'

/**
 * A PDF figure, drawn as a PNG on the server.
 *
 * Every figure in the thesis on this machine is a PDF, and the reading view
 * used to draw each of them as a dashed box with a filename in it, because an
 * `<img>` cannot draw a PDF and serving one would mean an embedded viewer on
 * this origin. They are rendered to PNG on this side now, and these are the
 * properties that has to keep: the browser gets a PNG and never the PDF, the
 * fence and the paper's own list of figures still decide what can be asked
 * for, a second request is not a second conversion, and a machine with no
 * converter gets the box back rather than a broken picture.
 */

/**
 * A one-page PDF, written out with correct cross-reference offsets, so the
 * real converter has something real to read and no fixture file has to be
 * checked in. A 72 × 72 point page with one filled square on it.
 */
function tinyPdf(): Buffer {
  const content = '0 0 1 rg 10 10 52 52 re f'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** The smallest bytes that pass for a PNG: the signature and an IHDR header. */
function fakePng(width = 10, height = 10): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-paper-figure-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const paper = join(root, '.kehikot', 'paper', 'thesis')
mkdirSync(join(paper, 'figures'), { recursive: true })
writeFileSync(
  join(paper, 'main.tex'),
  [
    '\\begin{document}',
    '\\begin{figure}\\includegraphics{figures/flow.pdf}\\caption{Flow.}\\end{figure}',
    '\\begin{figure}\\includegraphics{../outside.pdf}\\caption{Outside.}\\end{figure}',
    '\\begin{figure}\\includegraphics{figures/fake.pdf}\\caption{Not a PDF.}\\end{figure}',
    '\\begin{figure}\\includegraphics{figures/drawing.svg}\\caption{An SVG.}\\end{figure}',
    '\\end{document}',
  ].join('\n'),
)
writeFileSync(join(paper, 'figures', 'flow.pdf'), tinyPdf())
writeFileSync(join(paper, 'figures', 'unnamed.pdf'), tinyPdf())
writeFileSync(join(paper, 'figures', 'fake.pdf'), 'GIF89a, whatever the name says')
writeFileSync(join(paper, 'figures', 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
writeFileSync(join(root, '.kehikot', 'paper', 'outside.pdf'), tinyPdf())

/** A fresh cache per call, so one test's conversions are not another's hits. */
const freshCache = () => mkdtempSync(join(root, 'cache-'))

/** A converter that counts what it was asked and answers a PNG. */
function counting(): Rasterize & { calls: number } {
  const fn = ((pdf: Uint8Array) => {
    fn.calls += 1
    return pdf.length > 0 ? fakePng() : null
  }) as Rasterize & { calls: number }
  fn.calls = 0
  return fn
}

describe('a PDF figure', () => {
  test('is answered as a PNG of its first page, never as the PDF', () => {
    const rasterize = counting()
    const figure = readFigure('thesis', 'figures/flow.pdf', root, { rasterize, cache: freshCache() })
    expect(figure?.type).toBe('image/png')
    expect(Array.from(figure!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(rasterize.calls).toBe(1)
  })

  test('is drawn once: a second request is served from the cache', () => {
    const rasterize = counting()
    const cache = freshCache()
    const first = readFigure('thesis', 'figures/flow.pdf', root, { rasterize, cache })
    const second = readFigure('thesis', 'figures/flow.pdf', root, { rasterize, cache })
    expect(rasterize.calls).toBe(1)
    expect(second?.bytes).toEqual(first!.bytes)
    expect(readdirSync(cache).filter((f) => f.endsWith('.png'))).toHaveLength(1)
  })

  test('outside the paper’s root is refused, though the paper names it', () => {
    const rasterize = counting()
    expect(readFigure('thesis', '../outside.pdf', root, { rasterize, cache: freshCache() })).toBeNull()
    expect(rasterize.calls).toBe(0)
  })

  test('that the paper does not name is refused, though it sits in figures/', () => {
    const rasterize = counting()
    expect(readFigure('thesis', 'figures/unnamed.pdf', root, { rasterize, cache: freshCache() })).toBeNull()
    expect(rasterize.calls).toBe(0)
  })

  test('that is not a PDF inside is never handed to the converter', () => {
    const rasterize = counting()
    expect(readFigure('thesis', 'figures/fake.pdf', root, { rasterize, cache: freshCache() })).toBeNull()
    expect(rasterize.calls).toBe(0)
  })

  test('with no converter on this machine is a refusal, which the page draws as the filename box', () => {
    const cache = freshCache()
    expect(readFigure('thesis', 'figures/flow.pdf', root, { rasterize: () => null, cache })).toBeNull()
    /* And nothing was kept, so a converter installed later is used at once. */
    expect(readdirSync(cache)).toHaveLength(0)
  })

  test('a converter that answers something other than a PNG is a refusal, not image/png', () => {
    const rasterize: Rasterize = () => new TextEncoder().encode('<html>not a picture</html>')
    expect(readFigure('thesis', 'figures/flow.pdf', root, { rasterize, cache: freshCache() })).toBeNull()
  })
})

describe('an SVG figure', () => {
  test('is still refused: it is a document that can carry script', () => {
    expect(readFigure('thesis', 'figures/drawing.svg', root, { rasterize: counting(), cache: freshCache() })).toBeNull()
  })
})

/* The real converter, where it is installed. Skipped rather than failed on a
   machine without poppler, because what is under test above is this program's
   handling of a converter, and that was tested with a fake. */
const HAVE_PDFTOPPM = ['pdftoppm', '/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm'].some(
  (c) => !spawnSync(c, ['-v']).error,
)
describe.skipIf(!HAVE_PDFTOPPM)('pdftoppm, for real', () => {
  test('draws the first page of a PDF as a PNG at 150 dpi', () => {
    const png = pdftoppm(tinyPdf())
    expect(png).not.toBeNull()
    const view = new DataView(png!.buffer, png!.byteOffset, png!.byteLength)
    /* 72 points at 150 dpi is 150 pixels. */
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([150, 150])
  })

  test('says it could not, rather than throwing, on bytes it cannot read', () => {
    expect(pdftoppm(new TextEncoder().encode('%PDF-1.4 and then nothing'))).toBeNull()
  })

  test('through the door that serves it', () => {
    const figure = readFigure('thesis', 'figures/flow.pdf', root, { cache: freshCache() })
    expect(figure?.type).toBe('image/png')
  })
})
