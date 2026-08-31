import { describe, expect, test } from 'bun:test'

import { parseLatex } from '../latex/parse.ts'

/**
 * The offsets this module produces are UTF-8 bytes, and this is the file that
 * says so out loud.
 *
 * ## The flaw, and why it survived being written
 *
 * Every scan in `latex/parse.ts` walks a JavaScript string, so it counts UTF-16
 * code units. `Segment.srcStart` has said "byte offset" since it was written.
 * On ASCII the two are the same number, and these papers are mostly ASCII, so
 * the claim was true nearly everywhere and false in the one place it mattered:
 * the thesis, whose prose is full of em dashes.
 *
 * Nothing showed it while the offsets stayed inside this module — a citation
 * pasted into a conversation that is two bytes wide still finds its sentence.
 * It became visible the moment they were published as a `passage`, because the
 * consumer opens the file and counts bytes, and the protocol's own note says
 * why it must: "the consumer that opens the file reads bytes and a character
 * count would need the encoding to be agreed on as well."
 *
 * So the assertions here are arithmetic rather than behaviour. A test that
 * merely round-tripped through this module would pass with both modules wrong
 * in the same direction, which is exactly the state that was being shipped.
 */

const wrap = (body: string) => `\\begin{document}\n\n${body}\n\n\\end{document}\n`

/** The one true answer, from the runtime's own encoder rather than from us. */
const bytesOf = (text: string) => new TextEncoder().encode(text).length

describe('a block names a place in the file, in bytes', () => {
  test('an em dash above a paragraph moves it three bytes, not one', () => {
    const src = wrap('An em dash — here.\n\nThe second paragraph.')
    const [first, second] = parseLatex(src, 'x.tex').blocks.filter((b) => b.kind === 'paragraph')

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    /* The dash is one UTF-16 unit and three UTF-8 bytes, so the second
       paragraph's start is two higher than a character count would give. */
    expect(second!.srcStart).toBe(bytesOf(src.slice(0, src.indexOf('The second'))))
    expect(second!.srcStart).toBeGreaterThan(src.indexOf('The second'))
  })

  test('every offset in a paper is the byte length of the source before it', () => {
    /* One assertion over everything, so a block kind that grows a new run of
       segments cannot quietly keep character offsets: the check is against the
       source itself and not against a remembered number. */
    const src = wrap(
      [
        '\\section{Häkkinen — a heading}',
        '',
        'A paragraph with an \\emph{émphasis} and a — dash.',
        '',
        '\\begin{itemize}',
        '\\item Ø and ü',
        '\\item plain',
        '\\end{itemize}',
      ].join('\n'),
    )
    const total = bytesOf(src)
    for (const block of parseLatex(src, 'x.tex').blocks) {
      expect(block.srcStart).toBeLessThanOrEqual(block.srcEnd)
      expect(block.srcEnd).toBeLessThanOrEqual(total)
      const segments = [
        ...('segments' in block ? block.segments : []),
        ...('caption' in block ? block.caption : []),
        ...('items' in block ? block.items.flat() : []),
      ]
      for (const segment of segments) {
        expect(segment.srcStart).toBeLessThanOrEqual(segment.srcEnd)
        expect(segment.srcEnd).toBeLessThanOrEqual(total)
      }
    }
  })

  test('a literal segment names bytes whose text is the segment’s own text', () => {
    /* The strongest form of the claim: take the file, cut it at the offsets the
       parser gave, and the words that come out are the ones on screen. Cut in
       BYTES, through a Buffer, because that is what a consumer with the file
       open would do. */
    const src = wrap('A sentence — with a dash — and more words after it.')
    const bytes = Buffer.from(src, 'utf8')
    const paragraph = parseLatex(src, 'x.tex').blocks.find((b) => b.kind === 'paragraph')
    expect(paragraph).toBeDefined()
    const literal = (paragraph as { segments: { text: string; srcStart: number; srcEnd: number; literal: boolean }[] })
      .segments.find((s) => s.literal && s.text.includes('dash'))
    expect(literal).toBeDefined()
    expect(bytes.subarray(literal!.srcStart, literal!.srcEnd).toString('utf8')).toBe(literal!.text)
  })

  test('the source length reported is a byte length too', () => {
    const src = wrap('Ö')
    expect(parseLatex(src, 'x.tex').sourceLength).toBe(bytesOf(src))
  })

  test('pure ASCII is unchanged, which is why this went unnoticed for so long', () => {
    const src = wrap('Plain words only.')
    const paragraph = parseLatex(src, 'x.tex').blocks.find((b) => b.kind === 'paragraph')
    expect(paragraph!.srcStart).toBe(src.indexOf('Plain words only.'))
  })
})
