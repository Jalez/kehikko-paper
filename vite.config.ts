import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { doors, serves, type Answer } from 'kehikot-module-protocol/serve'
import { defineConfig, type Plugin } from 'vite'

import { BUILD, MANIFEST, TICKET, answer, later } from './doors.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'

/**
 * Every door this app answers on, served by the one process that serves the
 * page.
 *
 * ## Why they cannot be a second server
 *
 * A module is ONE ORIGIN or it is nothing: the protocol refuses a manifest
 * whose `entry` points anywhere but the origin that served the manifest, and it
 * is right to — a program that could name somebody else's page would be a
 * program that could have the host frame somebody else.
 *
 * That argument is usually made about the manifest and the health check. Here
 * it reaches further, because this module serves its own material: the page
 * fetches `/api/papers` and `/api/paper` as relative paths, which is how the
 * app works with nothing else running at all. Those on a second port would be
 * cross-origin from the page, and this app could not read the papers inside the
 * frame it was extracted to live in. So `doors.ts` holds the deciding and this
 * is the only socket.
 *
 * The program this was extracted from was built the other way — an Express API
 * on 5178 and Vite on 5177 — and that split is precisely what made `cors()`
 * feel necessary there. Two ports is where a permissive CORS policy comes from;
 * removing the second port removes the reason for the header.
 *
 * ## What serves them
 *
 * The protocol's `doors()`: the manifest at both well-known paths, `/app`
 * (generated, with the write ticket and this process's build printed into it,
 * `no-store`, `frame-ancestors`), and `/healthz`, `/mcp` and `/api/*` through
 * `through` below — `later` for the one door that takes seconds, `answer` for
 * every other. See the protocol's docs/module-plumbing.md.
 *
 * ## Why the page is generated rather than a file
 *
 * `/app` is answered with a document built per process, run through Vite's
 * own `transformIndexHtml` so the client and the module graph are injected
 * exactly as they would be for an `index.html` on disk. One reason is the
 * ticket, which has to reach the page without a door of its own. The other is
 * the collision Atlas lost half a day to. `entry` is `/app`, and under Vite dev an extensionless path is not free: a
 * request for `/app` next to an `app.tsx` resolves to that module and answers
 * `200 text/javascript` with compiled source. A browser loads such a document
 * happily and runs nothing in it: the frame's `load` fires, the host greets it,
 * and nothing answers. Here `/app` is claimed before Vite's resolver ever sees
 * it, so no file that happens to sit next to this one can take it.
 */
const through: Answer = (method, path, query, body, ticket) =>
  later(method, path, query, body, ticket) ?? answer(method, path, query, body, ticket)

/** One line at startup, and the reason it is still worth a plugin of its own. */
function says(): Plugin {
  return {
    name: 'paper-says',
    apply: 'serve',
    configureServer(server) {
      /*
       * Say at startup where this program looks — which is no longer a place.
       *
       * There used to be two directories here, read from the environment, and
       * this block printed each with a count of what it found. The one
       * configuration mistake the app could make was being pointed at the
       * wrong directory, and the symptom was a page that loaded perfectly and
       * said every epic had no paper: a working app reporting an empty world.
       * A line at startup turned a confusing afternoon into something somebody
       * had already read.
       *
       * That mistake is not available any more, because there is nothing to
       * configure — a paper is found in the project the host says is open, and
       * this process does not know which project that is until a request names
       * one. So the line says the RULE rather than a path, and there is no
       * count to print because there is nothing yet to count.
       *
       * It is still printed, and still at startup, because the failure it
       * guards has inverted: the person to save an afternoon for now is the one
       * who set `KEHIKKO_PAPERS_DIR` in a shell profile months ago and cannot
       * see why it has stopped doing anything.
       */
      server.config.logger.info(
        'paper: papers come from the open project — <project>/.kehikot/paper/<epic>/main.tex, and nowhere else. '
          + 'KEHIKKO_PAPERS_DIR and KEHIKKO_THESIS_DIR are gone, and so is the papers.json that briefly replaced '
          + 'them; all three are ignored if they are still there.',
      )
    },
  }
}

/**
 * The most a request body may be.
 *
 * Bounded, because the caller is whatever on this machine found the port —
 * loopback is a fence around the machine and not around the programs on it —
 * and a handler that reads until the socket closes is a handler that can be
 * asked to read forever. Six megabytes, because the largest body this app
 * reads is a whole `.tex` file being saved. Past it `doors()` answers 413 and
 * `answer` is never called.
 */
const MAX_BODY_BYTES = 6_000_000

/**
 * The dev server, and the one line that is absent from it.
 *
 * ## No `server.cors` — this module declares storage instead
 *
 * Modules that hold nothing set `cors: true` and have to. A host frames a
 * module WITHOUT `allow-same-origin` unless its manifest declares storage,
 * which puts the page on an opaque origin — and `<script type="module">` is
 * ALWAYS fetched in CORS mode, so with no permissive header not one script in
 * the page runs. The document loads, `load` fires, the host greets it, and
 * nothing answers. `curl` cannot see it, being unsubject to CORS; only the
 * browser console can. That has cost this codebase days.
 *
 * This module cannot go that way, for the reason Journeys found: it serves its
 * own `/api`. A permissive `Access-Control-Allow-Origin` means any page in any
 * tab can read this origin, and Journeys demonstrated the consequence rather
 * than arguing it:
 *
 *     $ curl -H 'Origin: https://evil.example' http://127.0.0.1:7840/app
 *     Access-Control-Allow-Origin: *
 *     ...ticket" type="application/json">"e75d4d01-…
 *
 * This app used to have no ticket to leak, being read-only, so the leak here
 * would have been the smaller one. That has stopped being true: a reader can
 * correct a sentence in place now, `doors.ts` mints a `TICKET`, and
 * `doors()` prints it into the document — which is exactly the string
 * the `curl` above pulled out of Journeys. So the argument for this line's
 * absence is no longer "the leak would be small"; it is the same argument
 * Journeys makes, with the same thing at stake.
 *
 * The second reason stands unchanged and is the older one. The program this was
 * extracted from ran `app.use(cors())` with no options in front of a
 * `POST /api/edits` that wrote to the author's thesis. The lesson from that is
 * not "be careful with the write path", it is "do not put a permissive header
 * on an origin that answers anything you care about". So the manifest declares
 * `storage: true`, this line is gone, and the page's own `/api` calls are
 * ordinary same-origin requests with no CORS involved at all.
 *
 * ## No alias for `kehikot-module-protocol`
 *
 * There used to be one, in every app here, pointing at the protocol's source in
 * the repository they all used to live in. It is gone and must not come back:
 * the package's `exports` are correct, reaching past them is what made a whole
 * class of bug possible, and a module that resolved its contract differently
 * from the host it talks to is a module testing something nobody ships.
 *
 * The `@` alias below is a different thing entirely — it points inside this
 * repository, at `src`, and exists because shadcn's own components are
 * generated with `@/lib/utils` in them and a module rewritten by hand on every
 * `shadcn add` is a module that drifts from upstream.
 *
 * ## Tailwind is configured in CSS, and there is no `tailwind.config.js`
 *
 * v4 reads `src/index.css`: the theme, the dark variant and the container
 * queries all live there. A config file would be a second place the theme lives
 * and the failure mode of two is that one of them is the one somebody edits.
 *
 * ## No `server.port`, because `serves()` is what decides it
 *
 * That last sentence applies to the port as literally as it does to the theme.
 * 7870 was written on the `bunx vite` line in `run.sh` and again in
 * `register.ts`, and true in neither the moment something else held the port:
 * `--strictPort` meant this app printed `Error: Port 7870 is already in use` and
 * exited 1, so a program with no interest in papers could stop the papers from
 * opening. It is `PREFERRED_PORT` in `manifest.ts` now, said once beside the id.
 *
 * `serves()` is FIRST in the plugin list below because it has to claim a port
 * before anything else in this config asks for one. A free 7870 is taken in
 * silence; this module already answering there ends the start cleanly rather
 * than making a second copy; anything else is a loud move to the next free port
 * with the registration rewritten to the port the server ACTUALLY bound, read
 * off `httpServer.address()` after `listening` rather than off what was asked
 * for.
 */
export default defineConfig({
  /**
   * `base: './'`, because this page is served at `/app` here and framed by a
   * host at whatever address that host wrote down. Absolute asset paths are
   * correct in the first case and a guess in the second; relative ones are a
   * fact in both, because the browser resolves them against the document it
   * just fetched.
   */
  base: './',
  plugins: [
    serves({ id: ID, prefer: PREFERRED_PORT }),
    says(),
    doors({
      manifest: MANIFEST,
      answer: through,
      build: BUILD,
      page: { title: 'Paper', ticket: TICKET },
      maxBodyBytes: MAX_BODY_BYTES,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true },
})
