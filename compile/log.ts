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
 * ## A fourth: what a tool Tectonic ran said
 *
 * Tectonic runs `biber` itself for a `biblatex` paper, and when that fails it
 * prints three `error:` lines that are only a frame — "the external tool
 * exited with an error code; its stdout was:", "its stderr was:", "the
 * external tool exited with error code 2" — with the tool's own words between
 * rules of `=` signs, on lines that begin with nothing this reader knew. So a
 * person was shown the frame and none of the picture: "exited with error code
 * 2", and not biber's plain statement that it and the bundled `biblatex` are
 * of different releases. The lines between the rules are read here: biber's
 * `ERROR - ` lines become errors, with the sentences that follow them, and a
 * block that has no such line is kept whole, since something in it is why.
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
export function problemsFrom(
  output: string,
  log: string,
  resolve: (name: string) => string | null,
  advise: (said: string) => string | null = biberAdvice,
): Problem[] {
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

  /* Inside what a tool Tectonic ran printed: null when not, else the lines so
     far. `opened` is whether the first rule of `=` has been passed. */
  let quoted: string[] | null = null
  let opened = false

  for (const raw of output.split('\n')) {
    const line = raw.trimEnd()

    if (quoted) {
      if (RULE.test(line)) {
        if (!opened) opened = true
        else {
          for (const problem of saidByTool(quoted, advise)) add(problem)
          quoted = null
        }
        continue
      }
      /* A frame with no rule after it is not a frame; read the line as usual. */
      if (opened) {
        quoted.push(line)
        continue
      }
      if (line) quoted = null
      else continue
    }

    if (FRAME.test(line)) {
      quoted = []
      opened = false
      continue
    }

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

  /* Output that ended inside a tool's block — a killed run — still said it. */
  if (quoted && opened) for (const problem of saidByTool(quoted, advise)) add(problem)

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

/** The two `error:` lines Tectonic puts around a tool's output. They say nothing themselves. */
const FRAME = /^error:\s+(?:the external tool exited with an error code; )?its (?:stdout|stderr) was:\s*$/
const RULE = /^={20,}\s*$/

/**
 * What a tool said, out of the lines Tectonic quoted.
 *
 * Biber prefixes every line with its level. An `ERROR - ` line is the error,
 * and the unprefixed lines after it are the rest of the same sentence — biber
 * wraps its explanation onto them — so they are joined to it. `INFO - ` is
 * chatter. A block with no `ERROR - ` in it and something else is kept as one
 * message: a tool that failed without a level is still the reason.
 */
function saidByTool(lines: readonly string[], advise: (said: string) => string | null): Problem[] {
  const out: Problem[] = []
  let current: Problem | null = null
  const rest: string[] = []
  for (const line of lines) {
    const levelled = /^(ERROR|WARN|INFO|DEBUG)\s+-\s+(.*)$/.exec(line)
    if (levelled) {
      current = null
      if (levelled[1] === 'ERROR' || levelled[1] === 'WARN') {
        current = { severity: levelled[1] === 'ERROR' ? 'error' : 'warning', file: null, line: null, message: levelled[2]!.replace(/^Error:\s*/, '') }
        out.push(current)
      }
      continue
    }
    if (!line.trim()) continue
    if (current) current.message += ` ${line.trim()}`
    else rest.push(line.trim())
  }
  if (!out.some((one) => one.severity === 'error') && rest.length) {
    out.unshift({ severity: 'error', file: null, line: null, message: rest.slice(-6).join(' ') })
  }
  const advice = advise(out.map((one) => one.message).join('\n'))
  if (advice) out.push({ severity: 'error', file: null, line: null, message: advice })
  return out
}

/**
 * What to do about the one tool failure worth a sentence of its own.
 *
 * Biber and `biblatex` must be of the same release — biber 2.N goes with
 * biblatex 3.N — and nothing keeps them so: the `biblatex` is whichever one
 * the engine's bundle carries, and the biber is whichever one is on this
 * machine. Biber's own message names both versions and says to consult a
 * compatibility matrix; this says which biber to get, because that is the
 * only thing a person can change, and that the paper is not at fault.
 */
export function biberAdvice(said: string): string | null {
  const found = biberMismatch(said)
  if (!found) return null
  return (
    `Nothing is wrong in the paper. The engine’s biblatex is ${found.biblatex} and the biber installed on this machine is ${found.have}; ` +
    `they have to be of the same release, which for biblatex ${found.biblatex} is biber ${found.need}. ` +
    `Install that biber and put it first on the PATH, or compile with a TeX Live install (latexmk), where the two come matched.`
  )
}

/**
 * The same failure, where this module can fetch the biber that is needed:
 * what is wrong, and that the button beside it is the way out. `build.ts`
 * passes this to `problemsFrom` in place of `biberAdvice` when it can.
 */
export function biberOffer(said: string): string | null {
  const found = biberMismatch(said)
  if (!found) return null
  return (
    `Nothing is wrong in the paper. The engine’s biblatex is ${found.biblatex} and the biber installed on this machine is ${found.have}; ` +
    `they have to be of the same release, which for biblatex ${found.biblatex} is biber ${found.need}. ` +
    `Paper can download biber ${found.need} and use it for this: the button is beside this message.`
  )
}

/**
 * Tectonic went to run biber and there was none: its whole statement is
 * "Running external tool biber ..." and then the operating system's "No such
 * file or directory". Nothing in that names biber as what is missing, so this
 * does.
 */
export function biberAbsent(output: string): boolean {
  return /Running external tool biber \.\.\.[\s\S]*^error: No such file or directory \(os error 2\)/m.test(output)
}

/** What to say when there is no biber at all. `fetchable` is whether the page has a button for it. */
export function noBiber(need: string, fetchable: boolean): string {
  return (
    `Nothing is wrong in the paper. Its bibliography is made by biber, and there is no biber on this machine. ` +
    (fetchable
      ? `Paper can download biber ${need}, the release that matches the engine’s biblatex: the button is beside this message.`
      : `Install biber ${need}, the release that matches the engine’s biblatex, or compile with a TeX Live install (latexmk), which has its own.`)
  )
}

export interface BiberMismatch {
  /** The biber that ran, or null when there was none to run. */
  have: string | null
  /** The biblatex whose control file it refused. */
  biblatex: string
  /** The biber that biblatex goes with. */
  need: string
}

/** Biber's own statement that it and the biblatex are of different releases, as the three versions in it. */
export function biberMismatch(said: string): BiberMismatch | null {
  const versions = /biber \((\d+)\.(\d+)\) and biblatex \((\d+)\.(\d+)\) versions are incompatible/.exec(said)
  if (!versions) return null
  return { have: `${versions[1]}.${versions[2]}`, biblatex: `${versions[3]}.${versions[4]}`, need: `2.${versions[4]}` }
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
