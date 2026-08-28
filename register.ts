#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ID } from './manifest.ts'

/**
 * Tell a host on this machine where this app answers.
 *
 *   bun run register            # or: PORT=7870 bun run register
 *
 * A separate program from `run.sh` on purpose. Registration writes into
 * somebody's home directory and says "frame this", which is a decision a person
 * makes once; a start script that did it quietly would be making that decision
 * on their behalf every time they pressed start.
 *
 * ## The filename is the module id
 *
 * Not a field inside the file — the NAME. A host sweeps the directory and takes
 * the id from the filename, so `roadmap.paper.json` is what makes this
 * `roadmap.paper`. Two files naming the same port under different names are two
 * modules as far as a host is concerned.
 *
 * ## `dir` as well as `url`
 *
 * The url is where to talk to this app; the directory is where to start it. A
 * host that has only the first can frame a running module and can do nothing at
 * all about a stopped one, which in practice means a pane that says "nothing is
 * answering" beside a Start button that is not there. With both, the host runs
 * `run.sh` inside this directory — one script, no arguments, for the reason
 * that file gives.
 *
 * It is this file's own location rather than a string, so a checkout moved or
 * cloned somewhere else registers itself correctly by being run.
 *
 * ## Where a host looks
 *
 * This line must say exactly what the host's own registry sweep says, and it is
 * copied rather than imported because this directory is meant to stand alone.
 * Writing to the wrong directory is the worst failure a module can have: the
 * host finds nothing, and finds it silently.
 */
const registryDir = process.env.ROADMAP_MODULES_DIR ?? join(homedir(), '.roadmap', 'modules')

const port = Number(process.env.PORT ?? 7870)
const origin = `http://127.0.0.1:${port}`
const dir = dirname(fileURLToPath(import.meta.url))

mkdirSync(registryDir, { recursive: true })
const file = join(registryDir, `${ID}.json`)
writeFileSync(file, `${JSON.stringify({ url: origin, dir }, null, 2)}\n`)
console.log(`registered: ${file} -> ${origin} (${dir})`)
console.log('Start the app with ./run.sh, then reload the host; it sweeps the directory on every read.')
