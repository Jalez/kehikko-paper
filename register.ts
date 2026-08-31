#!/usr/bin/env bun
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { originFor, registerAt } from 'roadmap-module-protocol/serve'

import { ID, PREFERRED_PORT } from './manifest.ts'

/**
 * Tell a host on this machine where this app answers.
 *
 *   bun run register            # or: PORT=7871 bun run register
 *
 * A separate program from `run.sh` on purpose. Registration writes into
 * somebody's home directory and says "frame this", which is a decision a person
 * makes once; a start script that did it quietly would be making that decision
 * on their behalf every time they pressed start.
 *
 * ## The plugin writes this file too, and the paragraph above still holds
 *
 * `serves()` in `vite.config.ts` rewrites this registration every time the
 * server starts, which reads like precisely what is forbidden above. It is not,
 * and the difference is worth spelling out, because collapsing the two loses
 * something whichever way round you do it.
 *
 * ADOPTION is the decision a person makes once, and this program is it. Running
 * this is how an app nobody had put on their canvas gets onto it; deleting the
 * file is how it comes off.
 *
 * The ADDRESS is not a decision anybody made. Nobody chose 7870 — they chose to
 * be framed, and 7870 is a fact about where this process happened to bind, one
 * that changes between one start and the next when something else has the port.
 * A registration still naming the old number is one the host sweeps to find
 * nothing: it reports this app as stopped while it runs one port over, and
 * offers a Start button that would spawn a second copy of it. Rewriting the
 * address keeps the decision the person made TRUE. It does not make one.
 *
 * ## `dir` as well as `url`
 *
 * The url is where to talk to this app; the directory is where to START it. A
 * host that has only the first can frame a running module and can do nothing at
 * all about a stopped one, which on screen is a container saying "nothing is
 * answering" beside a Start button that is not there. With both, the host runs
 * `run.sh` inside this directory — one script, no arguments, for the reason that
 * file gives. It matters more here than in most modules, because `run.sh` is
 * also where the papers roots get their defaults: an app started any other way
 * is an app that has lost the thesis.
 *
 * It comes from this file's own location rather than from a string or from
 * `process.cwd()`, so a checkout moved or cloned somewhere else registers itself
 * correctly by being run. That is the one thing the package cannot work out on
 * its own, which is why it is still spelled here.
 *
 * ## Where a host looks is no longer copied into this file
 *
 * The registry directory, the rule that the FILENAME carries the id — a host
 * sweeps the directory and reads the id off the name, so `roadmap.paper.json` is
 * what makes this `roadmap.paper` — and the shape of the document now live in
 * `roadmap-module-protocol/serve`. This file used to say the path itself, with a
 * note explaining that the copy was deliberate so the directory could stand
 * alone; fourteen deliberate copies of one path are fourteen chances to disagree
 * by a character, and writing to the wrong directory is the worst failure a
 * module can have, because the host finds nothing and finds it silently.
 *
 * `registerAt` MERGES rather than overwrites, so a field somebody set beside the
 * url by hand survives a rewrite that had nothing to do with it.
 */
const port = Number(process.env.PORT ?? PREFERRED_PORT)
const written = registerAt({
  id: ID,
  origin: originFor(port),
  dir: dirname(fileURLToPath(import.meta.url)),
})

console.log(`registered: ${written.file} -> ${written.url} (${written.dir})`)
if (written.was) console.log(`  (was ${written.was.url} in ${written.was.dir})`)
console.log('Start the app with ./run.sh, then reload the host; it sweeps the directory on every read.')
console.log(`If ${port} is taken, ./run.sh moves to the next free port and rewrites this file to match.`)
