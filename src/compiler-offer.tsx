import { Button } from '@/components/ui/button.tsx'

import type { BuildStatus } from '../compile/build.ts'
import type { PieceStatus } from '../compile/install.ts'
import type { PieceId } from '../compile/toolchain.ts'
import { useToolchain } from './use-toolchain.ts'

/**
 * The one place the page offers to download anything.
 *
 * Two situations, one button each:
 *
 *  - **No compiler on this machine.** The pane says what a compiler is and
 *    offers the whole of what `compile/toolchain.ts` names.
 *  - **A compile failed because the machine's biber is the wrong release** for
 *    the engine's biblatex, and the right one is in that table. The pane
 *    offers that one piece, in place of advice to go and install it by hand.
 *
 * In both, what will be downloaded, how much, from which host and into which
 * folder is on screen BEFORE the press, and nothing is fetched without it:
 * opening a paper downloads nothing. While it runs there is a bar and Cancel;
 * when it fails there is the reason and Retry.
 *
 * Where there is nothing this module can fetch — a platform with no row, or a
 * paper that names an engine the machine lacks — it says what `build.how`
 * says, as the page always did.
 */
export function CompilerOffer({
  build,
  onInstalled,
  pollMs,
}: {
  build: BuildStatus
  /**
   * An install this page started has ended. `complete` is whether everything
   * asked for is in place; when it is not, a piece may be all the same — a
   * cancelled install of both leaves the Tectonic it had finished.
   */
  onInstalled: (what: 'compiler' | 'biber', complete: boolean) => void
  pollMs?: number
}) {
  const none = build.engines.length === 0
  const mismatch = build.engine && build.last && !build.last.ok && build.last.biber?.fetchable ? build.last.biber : null
  const what: 'compiler' | 'biber' | null = none ? 'compiler' : mismatch ? 'biber' : null
  const { toolchain, unreachable, install, cancel } = useToolchain((complete) => {
    if (what) onInstalled(what, complete)
  }, pollMs)

  const fallback =
    !build.engine && build.how ? (
      <div className="shrink-0 border-b px-2 py-2 text-[0.75rem] leading-relaxed" role="status" data-no-engine>
        <p className="mb-1 font-medium">The paper cannot be compiled here</p>
        <p className="text-muted-foreground">{build.how}</p>
      </div>
    ) : null

  if (!what) return fallback
  /* Not yet answered: say nothing rather than flash the hand-install advice
     at somebody who is about to be offered a button. */
  if (!toolchain) return unreachable ? fallback : null
  if (!toolchain.supported) return fallback

  const wanted: PieceStatus[] = toolchain.pieces.filter((one) => !one.installed && (what === 'compiler' || one.id === 'biber'))
  const running = toolchain.running
  if (!wanted.length && !running) return fallback
  const ids: PieceId[] = wanted.map((one) => one.id)
  const size = megabytes(wanted.reduce((sum, one) => sum + one.bytes, 0))
  const failed = !running ? (unreachable ?? toolchain.error) : null
  const label = what === 'compiler' ? `Install the compiler (about ${size} MB)` : `Install biber ${mismatch!.need} (about ${size} MB)`

  return (
    <div className="shrink-0 border-b px-2 py-2 text-[0.75rem] leading-relaxed" role="status" data-compiler-offer={running ? 'installing' : failed ? 'failed' : 'offer'} data-offer-for={what}>
      {what === 'compiler' ? (
        <>
          <p className="mb-1 font-medium">This paper needs a compiler to become a PDF</p>
          <p className="text-muted-foreground">
            A LaTeX paper is written as source text, and a compiler is the program that turns that text into the PDF. None was found on this
            machine, so there is no PDF to show yet; the source can still be edited and saved.
          </p>
        </>
      ) : (
        <>
          <p className="mb-1 font-medium">{mismatch!.have ? 'The bibliography needs a different biber' : 'The bibliography needs biber'}</p>
          <p className="text-muted-foreground">
            Nothing is wrong in the paper. The compiler’s biblatex is {mismatch!.biblatex}, which only works with biber {mismatch!.need}, and this
            machine has {mismatch!.have ? `biber ${mismatch!.have}` : 'no biber'}.
          </p>
        </>
      )}

      {running ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-installing>
          <progress className="h-1.5 min-w-24 flex-1" max={toolchain.total || 1} value={toolchain.received} aria-label="Download progress" />
          <span className="text-muted-foreground tabular-nums">
            {megabytes(toolchain.received)} of {megabytes(toolchain.total)} MB
          </span>
          <Button variant="outline" size="container" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          {failed && (
            <p className="mt-2 text-(--gone)" data-install-error>
              {failed}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="container" onClick={() => void install(ids)} data-install>
              {failed ? `Retry: ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label}
            </Button>
          </div>
        </>
      )}

      <p className="text-muted-foreground mt-2" data-what-is-fetched>
        {running ? 'Downloading ' : 'This downloads '}
        {wanted.length
          ? wanted.map((one, i) => (
              <span key={one.id}>
                {i > 0 && (i === wanted.length - 1 ? ' and ' : ', ')}
                {NAMES[one.id]} {one.version} ({megabytes(one.bytes)} MB, from {one.host})
              </span>
            ))
          : 'the last of it'}
        , checks {wanted.length === 1 ? 'it' : 'each'} against a checksum fixed in this module, and keeps {wanted.length === 1 ? 'it' : 'them'} in{' '}
        <code className="font-mono break-all">{toolchain.dir}</code>. Nothing else on the machine is changed, and nothing is downloaded until the
        button is pressed.
        {what === 'compiler' && ' The first compile then fetches the LaTeX packages the paper uses, once. A TeX Live or MacTeX on the machine is found and used instead.'}
      </p>
    </div>
  )
}

const NAMES: Record<PieceId, string> = { tectonic: 'Tectonic', biber: 'biber' }

/** Megabytes, the way a download is described to a person. Not imported from `toolchain.ts`: that file reads archives and is the server's. */
function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1_000_000))
}
