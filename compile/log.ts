/**
 * What an engine said went wrong, as a file and a line.
 *
 * ## Three dialects of one sentence
 *
 * A failed compile is only useful if the error can be pressed and the cursor
 * lands on the line. Engines say where in three ways and this reads all three:
 *
 *  - **Tectonic**, on stderr: `error: chapters/wire:12: Undefined control
 *    sequence`. Note the file is spelled the way the paper `\input` it —
 *    usually with no `.tex` — which is why `resolve` is passed in.
 *  - **`-file-line-error`**, which `engine.ts` asks every TeX Live engine for:
 *    `./chapters/wire.tex:12: Undefined control sequence.`
 *  - **Classic TeX**, in the log: a line beginning `! `, then some lines later
 *    `l.12 \foo`. No file at all; the line is kept and the file left null
 *    rather than guessed, because a guess that opens the wrong chapter at line
 *    12 is worse than a message that says only "line 12".
 *
 * ## What is NOT reported
 *
 * `Overfull \hbox` and `Underfull \hbox`. A real paper has dozens, none of them
 * is why a compile failed, and a panel that opens on forty badness reports
 * teaches a person to stop reading the panel.
 *
 * Pure: text in, a list out.
 */

export interface Problem {
  severity: 'error' | 'warning'
  /** Relative to the paper, and one of its own files — or null when the engine did not say, or named somebody else's. */
  file: string | null
  /** One-based, or null. */
  line: number | null
  message: string
}

const MAX_PROBLEMS = 40
const MAX_MESSAGE = 400

/**
 * @param output  what the engine wrote to stdout and stderr
 * @param log     the `.log` it left, or ''
 * @param resolve turns the name an engine used into one of the paper's files, or null
 */
export function problemsFrom(output: string, log: string, resolve: (name: string) => string | null): Problem[] {
  const out: Problem[] = []
  const seen = new Set<string>()
  const add = (problem: Problem) => {
    const message = tidy(problem.message)
    if (!message) return
    const key = `${problem.severity}\0${problem.file}\0${problem.line}\0${message}`
    if (seen.has(key) || out.length >= MAX_PROBLEMS) return
    seen.add(key)
    out.push({ ...problem, message })
  }

  for (const raw of output.split('\n')) {
    const line = raw.trimEnd()

    /* Tectonic: `error: file:12: message` / `warning: file:12: message`. */
    const tectonic = /^(error|warning):\s+(.*)$/.exec(line)
    if (tectonic) {
      const severity = tectonic[1] as 'error' | 'warning'
      const rest = tectonic[2]!
      /* The sentence Tectonic ends every failed run with. It is the fact that
         there WAS an error, said after the error. */
      if (/^halted on potentially-recoverable error/.test(rest)) continue
      const placed = /^(.+?):(\d+):\s*(.*)$/.exec(rest)
      if (placed) add({ severity, file: resolve(placed[1]!), line: Number(placed[2]), message: placed[3]! })
      else add({ severity, file: null, line: null, message: rest })
      continue
    }

    /* `-file-line-error`: `./main.tex:12: message`. Anchored on a `.tex`-ish
       name so that a timestamp or a URL in ordinary chatter is not an error. */
    const placed = /^(\.{0,2}\/?[^\s:]+\.(?:tex|cls|sty|bib|bbl|ltx)):(\d+):\s*(.*)$/.exec(line)
    if (placed) add({ severity: 'error', file: resolve(placed[1]!), line: Number(placed[2]), message: placed[3]! })
  }

  /* The log, for what stderr did not carry: classic `!` errors when nothing
     above found one, and LaTeX's own warnings — an undefined reference or
     citation is the warning an author most needs and Tectonic prints none. */
  const lines = log.split('\n')
  const hadError = out.some((one) => one.severity === 'error')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (!hadError && line.startsWith('! ')) {
      let at: number | null = null
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
        const where = /^l\.(\d+)\b/.exec(lines[j]!)
        if (where) {
          at = Number(where[1])
          break
        }
      }
      add({ severity: 'error', file: null, line: at, message: line.slice(2) })
      continue
    }
    const warned = /^(?:LaTeX|Package|Class)(?: \S+)? Warning: (.*)$/.exec(line)
    if (warned) {
      /* A log wraps at 79 columns, so the sentence may run on. Joined until it
         ends, with a small bound, since a warning with no full stop exists. */
      let message = warned[1]!
      for (let j = i + 1; j < Math.min(lines.length, i + 4) && !/\.\s*$/.test(message); j += 1) message += lines[j]!.replace(/^\(\S+\)\s+/, ' ')
      const where = /on input line (\d+)/.exec(message)
      add({ severity: 'warning', file: null, line: where ? Number(where[1]) : null, message })
    }
  }

  /* Errors first: they are why there is no new PDF. */
  return [...out.filter((one) => one.severity === 'error'), ...out.filter((one) => one.severity === 'warning')]
}

function tidy(message: string): string {
  const text = message.replace(/^!\s*/, '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
}

/**
 * The end of what an engine printed, for the panel under the errors.
 *
 * The END, because that is where an engine says why it stopped, and capped
 * because a runaway paper can print megabytes before it is killed.
 */
export function tailOf(output: string, max = 6000): string {
  const text = output.trimEnd()
  if (text.length <= max) return text
  const cut = text.slice(text.length - max)
  const line = cut.indexOf('\n')
  return `…\n${line === -1 ? cut : cut.slice(line + 1)}`
}
