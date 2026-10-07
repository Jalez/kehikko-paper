/**
 * Bytes, characters and lines: three ways of naming one place in a file.
 *
 * ## Why this file exists, and why it is pure
 *
 * Everything this module says to anybody else about a place in a paper is a
 * BYTE offset into a file on disk — that is what a note is anchored to, what a
 * quiz question is about, what `list_sections` hands an agent. An editor counts
 * in UTF-16 code units. SyncTeX counts in lines. The page converts between the
 * three on every selection, and a conversion that is one off after the first
 * `ä` is the bug that makes a highlight land a letter to the left in a Finnish
 * thesis and nowhere else. So the arithmetic is here, alone, with tests, and
 * nothing in it touches a DOM.
 *
 * ## Line endings, which is the part that is easy to forget
 *
 * An editor holds text with `\n` between lines whatever the file had. A file
 * saved on Windows has `\r\n`, so every line break before a place adds one byte
 * the editor's text does not contain. `eol` carries that: it is what the file
 * used when it was read, it is put back on save, and every conversion below
 * takes it. A file that MIXES the two is saved with whichever it had first —
 * that is a normalisation, it happens on the first save, and the README says so.
 */

export type Eol = '\n' | '\r\n'

/** What a file uses between lines. The first break decides; a file with none is `\n`. */
export function eolOf(disk: string): Eol {
  const at = disk.indexOf('\n')
  return at > 0 && disk[at - 1] === '\r' ? '\r\n' : '\n'
}

/** The file's text as an editor holds it: one `\n` per line break. */
export function toEditor(disk: string): string {
  return disk.includes('\r') ? disk.replace(/\r\n?/g, '\n') : disk
}

/** The editor's text as it goes back to disk. */
export function toDisk(text: string, eol: Eol): string {
  return eol === '\n' ? text : text.replace(/\n/g, '\r\n')
}

/** UTF-8 length of one UTF-16 code unit at `i`, and how many units it took. */
function unit(text: string, i: number): { bytes: number; units: number } {
  const code = text.charCodeAt(i)
  if (code < 0x80) return { bytes: 1, units: 1 }
  if (code < 0x800) return { bytes: 2, units: 1 }
  /* A high surrogate followed by a low one is one four-byte character. Alone,
     either half is what `TextEncoder` writes as U+FFFD: three bytes. */
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(i + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 }
  }
  return { bytes: 3, units: 1 }
}

/** The byte offset, in the file on disk, of position `index` in the editor's text. */
export function byteAt(text: string, index: number, eol: Eol = '\n'): number {
  const end = Math.max(0, Math.min(index, text.length))
  const extra = eol === '\r\n' ? 1 : 0
  let bytes = 0
  let i = 0
  while (i < end) {
    const one = unit(text, i)
    /* A position in the middle of a surrogate pair is not a place; it counts
       as the place before the pair, which is what an editor's caret does. */
    if (i + one.units > end) break
    bytes += one.bytes
    if (extra && text.charCodeAt(i) === 10) bytes += extra
    i += one.units
  }
  return bytes
}

/**
 * The position in the editor's text of byte `byte` of the file on disk.
 *
 * A byte inside a character — which a rotted anchor can name — answers the
 * start of that character rather than throwing: the caller is about to draw a
 * highlight, and one character wide of a place that no longer exists is the
 * honest drawing.
 */
export function indexAt(text: string, byte: number, eol: Eol = '\n'): number {
  const extra = eol === '\r\n' ? 1 : 0
  let bytes = 0
  let i = 0
  while (i < text.length) {
    const one = unit(text, i)
    const size = one.bytes + (extra && text.charCodeAt(i) === 10 ? extra : 0)
    if (bytes + size > byte) return i
    bytes += size
    i += one.units
  }
  return text.length
}

/** One-based line of a position. */
export function lineAt(text: string, index: number): number {
  const end = Math.max(0, Math.min(index, text.length))
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < end; at = text.indexOf('\n', at + 1)) line += 1
  return line
}

/** The position where one-based `line` starts, clamped to the text. */
export function startOfLine(text: string, line: number): number {
  let at = 0
  for (let n = 1; n < line; n += 1) {
    const next = text.indexOf('\n', at)
    if (next === -1) return at
    at = next + 1
  }
  return at
}

/** The text of one-based `line`, without its break. */
export function textOfLine(text: string, line: number): string {
  const from = startOfLine(text, line)
  const to = text.indexOf('\n', from)
  return text.slice(from, to === -1 ? text.length : to)
}
