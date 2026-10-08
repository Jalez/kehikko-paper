import { inflateRawSync } from 'node:zlib'

/**
 * The compiler this module can fetch for a person, written down.
 *
 * ## Why there is one
 *
 * A paper needs an engine and a person should not have to know what a TeX
 * distribution is to see their PDF. So when the machine has none, the page
 * offers one button, and what that button downloads is this table: Tectonic,
 * which is one file and fetches a paper's packages itself, and the `biber`
 * that matches the `biblatex` in Tectonic's bundle. About a hundred megabytes,
 * not six gigabytes.
 *
 * ## Nothing here is looked up
 *
 * Every address, size and checksum is a literal in this file. There is no
 * "latest", no version read from a server, and no address followed that is
 * not written here or is not a redirect to one of the hosts a row names. A
 * download whose SHA-256 is not the one in its row is deleted and never run.
 * Changing what is installed is a change to this file, reviewed like one.
 *
 * ## Where each checksum came from — and what that is worth
 *
 *  - **Tectonic**: the `digest` GitHub's release API reports for each asset of
 *    `tectonic@0.17.0` (GitHub computes it on upload; the Tectonic project
 *    publishes no checksum file of its own). Read on 2026-10-07, and each of
 *    the five archives below was also downloaded that day and hashed to the
 *    same value.
 *  - **biber**: SourceForge publishes SHA-1 and MD5 for each file and no
 *    SHA-256, and the biber project publishes none either. Each archive was
 *    downloaded on 2026-10-07 from `downloads.sourceforge.net`, its SHA-1
 *    compared with the published one (they matched — the SHA-1 is kept beside
 *    each row), and the SHA-256 here COMPUTED from those bytes.
 *
 * A checksum computed from one's own download protects everybody afterwards
 * against the file changing; it does not protect against the first download
 * having been wrong. For biber that first download is vouched for only by
 * SourceForge's SHA-1.
 *
 * ## Which biber, and how that is known rather than assumed
 *
 * biber and `biblatex` are released as a pair: biber 2.N reads the control
 * file biblatex 3.N writes and refuses any other. The biblatex is whichever
 * one Tectonic's bundle carries — 3.17 for both Tectonic 0.16.9 and 0.17.0 on
 * the day above, read with `tectonic -X bundle cat biblatex.sty`. Three places
 * check it instead of trusting that sentence: `biblatexIn` reads the version
 * out of the bundle's own `biblatex.sty` before a biber is fetched; biber's
 * own refusal names both versions and `biberFor` turns the biblatex it names
 * into the biber it needs; and a biber that is not in this table is never
 * fetched — the page says which one is needed instead.
 *
 * Pure. `inflateRawSync` is the only import and it touches nothing.
 */

export type PieceId = 'tectonic' | 'biber'
export type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64'

export interface Artefact {
  piece: PieceId
  version: string
  /** The one address asked. https, and a literal. */
  url: string
  /**
   * Hosts a redirect from `url` may lead to: an exact name, or `.suffix` for
   * any host under it. GitHub and SourceForge both answer with a redirect to
   * where the bytes are; anywhere else is refused before it is asked.
   */
  via: readonly string[]
  /** Of the archive, exactly. A download of any other length is wrong before it is hashed. */
  bytes: number
  sha256: string
  format: 'tar.gz' | 'zip'
  /** The one entry taken out of the archive. Everything else in it is left there. */
  entry: string
  /** Of that entry, unpacked. An upper bound on what extraction may write. */
  unpacked: number
}

export const TECTONIC_VERSION = '0.17.0'
export const BIBER_VERSION = '2.17'
/** The biblatex in the bundle Tectonic 0.17.0 uses, as read on the day in the essay above. */
export const BUNDLE_BIBLATEX = '3.17'

const GITHUB = ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'] as const
const SOURCEFORGE = ['downloads.sourceforge.net', '.dl.sourceforge.net'] as const

const tectonic = (target: string, format: Artefact['format'], bytes: number, sha256: string, unpacked: number): Artefact => ({
  piece: 'tectonic',
  version: TECTONIC_VERSION,
  url: `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${target}.${format}`,
  via: GITHUB,
  bytes,
  sha256,
  format,
  entry: format === 'zip' ? 'tectonic.exe' : 'tectonic',
  unpacked,
})

const biber = (path: string, format: Artefact['format'], bytes: number, sha256: string, unpacked: number): Artefact => ({
  piece: 'biber',
  version: BIBER_VERSION,
  url: `https://downloads.sourceforge.net/project/biblatex-biber/biblatex-biber/${BIBER_VERSION}/binaries/${path}`,
  via: SOURCEFORGE,
  bytes,
  sha256,
  format,
  entry: format === 'zip' ? 'biber.exe' : 'biber',
  unpacked,
})

/* SourceForge's published SHA-1 for the macOS archive: 0050ffda66a97aa83aa2d7e615c23ee3e12a7b63.
   One universal binary (x86_64 and arm64), so both Macs take the same file. */
const BIBER_MAC = biber(
  'MacOS/biber-darwin_universal.tar.gz',
  'tar.gz',
  89_382_426,
  '182e1efa074d8a2a23a8893f2a22440d4e463cce55e4ed02076ac4c0ee0614b2',
  100_477_200,
)

/**
 * What is fetched, per platform.
 *
 * Linux takes Tectonic's static (musl) build, which runs on any distribution.
 * There is no biber 2.17 for Linux on ARM — the project's `ARM` folder for that
 * release is empty — so that row is Tectonic alone and a `biblatex` paper there
 * needs a TeX Live.
 */
export const TOOLCHAIN: Readonly<Record<PlatformKey, readonly Artefact[]>> = {
  'darwin-arm64': [
    tectonic('aarch64-apple-darwin', 'tar.gz', 21_704_674, 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667', 53_998_928),
    BIBER_MAC,
  ],
  'darwin-x64': [
    tectonic('x86_64-apple-darwin', 'tar.gz', 21_790_177, '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80', 55_170_056),
    BIBER_MAC,
  ],
  'linux-x64': [
    tectonic('x86_64-unknown-linux-musl', 'tar.gz', 10_151_914, '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7', 26_401_904),
    /* SourceForge's published SHA-1: a149dc16f6006dc1970cff7681295a46f0fd3ce2. */
    biber('Linux/biber-linux_x86_64.tar.gz', 'tar.gz', 24_636_951, '129d2e0332a57e985ffa253e5e9fbd28ef99af5a068d1b141145211969aa8999', 30_026_008),
  ],
  'linux-arm64': [
    tectonic('aarch64-unknown-linux-musl', 'tar.gz', 9_926_834, 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8', 25_896_944),
  ],
  'win32-x64': [
    tectonic('x86_64-pc-windows-msvc', 'zip', 21_060_223, 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f', 51_538_432),
    /* SourceForge's published SHA-1: 1f00870c645f96c61a4f586f13863e42c3fb83b0. */
    biber('Windows/biber-MSWIN64.zip', 'zip', 25_624_323, 'c103bffc5ae0a7f513e7c26b6d394e9be6cf41952959c5d604ee2e6581b5dea2', 31_734_307),
  ],
}

/**
 * The row for this machine, or null when there is none to offer.
 *
 * Windows has rows above and is not offered: the rest of this module's engine
 * code is POSIX — `PATH` is split on `:`, a path is absolute when it starts
 * with `/` — so a compiler installed there would be a download that then could
 * not be used. The rows are kept for the day that changes.
 */
export function platformKey(platform: string, arch: string): PlatformKey | null {
  const key = `${platform}-${arch}`
  if (platform === 'win32') return null
  return key in TOOLCHAIN ? (key as PlatformKey) : null
}

export function artefactsFor(platform: string, arch: string): readonly Artefact[] {
  const key = platformKey(platform, arch)
  return key ? TOOLCHAIN[key] : []
}

/** `<tools>/tectonic-0.17.0`: one folder per piece and version, so a later version never mixes with this one. */
export function pieceDir(dir: string, artefact: Pick<Artefact, 'piece' | 'version'>): string {
  return `${dir.replace(/\/+$/, '')}/${artefact.piece}-${artefact.version}`
}

/** Where a piece's one file is once installed. */
export function piecePath(dir: string, artefact: Pick<Artefact, 'piece' | 'version' | 'entry'>): string {
  return `${pieceDir(dir, artefact)}/${artefact.entry}`
}

/** The biber that reads what a given biblatex writes: 3.N goes with 2.N. Null for anything that is not a 3.N. */
export function biberFor(biblatex: string): string | null {
  const found = /^3\.(\d{1,3})$/.exec(biblatex.trim())
  return found ? `2.${found[1]}` : null
}

/** The version a `biblatex.sty` says it is, from the line every release has carried: `\def\abx@version{3.17}`. */
export function biblatexIn(sty: string): string | null {
  const found = /\\def\\abx@version\{(\d+\.\d+)[a-z]?\}/.exec(sty)
  return found ? found[1]! : null
}

/** Megabytes, the way a download is described to a person. */
export function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1_000_000))
}

/**
 * Whether an address may be asked for this artefact.
 *
 * The first address is the row's own, compared whole. A redirect may lead only
 * to https on a host the row names. Ports, credentials and any other scheme
 * are refused: an address with `user@` in it is how a host name is made to
 * look like another one.
 */
export function mayFetch(artefact: Pick<Artefact, 'url' | 'via'>, address: string): boolean {
  if (address === artefact.url) return true
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  return artefact.via.some((one) => (one.startsWith('.') ? host.endsWith(one) && host.length > one.length : host === one))
}

/** Whether a finished download is the file its row describes. */
export function verified(artefact: Pick<Artefact, 'bytes' | 'sha256'>, bytes: number, sha256: string): boolean {
  return bytes === artefact.bytes && /^[0-9a-f]{64}$/.test(artefact.sha256) && sha256.toLowerCase() === artefact.sha256
}

/**
 * Whether an archive entry's name is one an honest archive holds.
 *
 * Nothing here is ever written to a path taken from an archive — the one entry
 * wanted goes to a name this module chose — so a hostile name could not
 * escape anyway. An archive that carries one is refused whole all the same:
 * it is not the file that was pinned, whatever its checksum says.
 */
export function safeEntry(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return false
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  return !name.split('/').includes('..')
}

export interface TarHeader {
  name: string
  size: number
  /** '0' a file, '5' a directory, '2' a symbolic link, '1' a hard link, 'x'/'g'/'L' a name for the next entry. */
  type: string
}

/** One 512-byte tar header, or null for the block of zeros that ends an archive. Throws on anything that is not a header. */
export function tarHeader(block: Uint8Array): TarHeader | null {
  if (block.length !== 512) throw new Error('a tar header is 512 bytes')
  if (block.every((byte) => byte === 0)) return null
  const text = (from: number, length: number) => {
    let end = from
    while (end < from + length && block[end] !== 0) end += 1
    return Buffer.from(block.subarray(from, end)).toString('utf8')
  }
  const octal = (from: number, length: number) => {
    const said = text(from, length).trim()
    if (!/^[0-7]*$/.test(said)) throw new Error('that is not a tar archive')
    return said ? parseInt(said, 8) : 0
  }
  /* The checksum is the sum of the header's bytes with its own field read as
     spaces. It is what tells a tar header from 512 bytes of something else. */
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i]!
  if (sum !== octal(148, 8)) throw new Error('that is not a tar archive')
  const prefix = text(257, 6) === 'ustar' ? text(345, 155) : ''
  const name = text(0, 100)
  const type = String.fromCharCode(block[156]!)
  return { name: prefix ? `${prefix}/${name}` : name, size: octal(124, 12), type: type === '\0' ? '0' : type }
}

/**
 * One file out of a zip, held in memory.
 *
 * The central directory is read — it is what an unzipper trusts — every name
 * in it is checked, and the one entry wanted is inflated with a bound on how
 * much may come out. Only "stored" and "deflated" are understood, which is
 * every zip this table names.
 */
export function unzipEntry(zip: Uint8Array, entry: string, max: number): Buffer {
  const view = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = -1
  for (let at = view.length - 22; at >= Math.max(0, view.length - 65_557); at -= 1) {
    if (view.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end === -1) throw new Error('that is not a zip archive')
  const count = view.readUInt16LE(end + 10)
  let at = view.readUInt32LE(end + 16)
  let found: { method: number; packed: number; size: number; local: number } | null = null
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > view.length || view.readUInt32LE(at) !== 0x02014b50) throw new Error('that is not a zip archive')
    const nameLength = view.readUInt16LE(at + 28)
    const name = view.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    if (!safeEntry(name)) throw new Error(`the archive holds a file named ${JSON.stringify(name)}, which no honest archive does`)
    if (name === entry) {
      if (found) throw new Error(`the archive holds ${entry} twice`)
      found = { method: view.readUInt16LE(at + 10), packed: view.readUInt32LE(at + 20), size: view.readUInt32LE(at + 24), local: view.readUInt32LE(at + 42) }
    }
    at += 46 + nameLength + view.readUInt16LE(at + 30) + view.readUInt16LE(at + 32)
  }
  if (!found) throw new Error(`the archive does not hold ${entry}`)
  if (found.size > max) throw new Error(`${entry} in the archive is larger than it should be`)
  if (found.local + 30 > view.length || view.readUInt32LE(found.local) !== 0x04034b50) throw new Error('that is not a zip archive')
  const start = found.local + 30 + view.readUInt16LE(found.local + 26) + view.readUInt16LE(found.local + 28)
  const packed = view.subarray(start, start + found.packed)
  if (packed.length !== found.packed) throw new Error('the zip archive is cut short')
  const out = found.method === 0 ? Buffer.from(packed) : found.method === 8 ? inflateRawSync(packed, { maxOutputLength: max }) : null
  if (!out) throw new Error(`${entry} is packed in a way this does not read`)
  if (out.length !== found.size) throw new Error(`${entry} did not unpack to the size the archive said`)
  return out
}
