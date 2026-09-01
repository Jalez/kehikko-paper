import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { WELL_KNOWN } from 'roadmap-module-protocol'
import { serves } from 'roadmap-module-protocol/serve'
import { defineConfig, type Plugin } from 'vite'

import { MANIFEST, answer, type Reply } from './doors.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'
import { page } from './page/document.ts'

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
 * ## Why the page is generated rather than a file
 *
 * `/app` is answered with a document this process builds, run through Vite's
 * own `transformIndexHtml` so the client and the module graph are injected
 * exactly as they would be for an `index.html` on disk. Journeys does this to
 * carry a write ticket into the page; there is no ticket here, and the reason
 * is the other one from that file — the collision Atlas lost half a day to.
 * `entry` is `/app`, and under Vite dev an extensionless path is not free: a
 * request for `/app` next to an `app.tsx` resolves to that module and answers
 * `200 text/javascript` with compiled source. A browser loads such a document
 * happily and runs nothing in it: the frame's `load` fires, the host greets it,
 * and nothing answers. Here `/app` is claimed before Vite's resolver ever sees
 * it, so no file that happens to sit next to this one can take it.
 */
function doors(): Plugin {
  return {
    name: 'paper-doors',
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

      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        const method = (request.method ?? 'GET').toUpperCase()

        const send = (reply: Reply) => {
          if (reply.binary) {
            /*
             * The one non-JSON answer. `nosniff` so the browser uses the type
             * `store.ts` looked up rather than one it decided from the bytes,
             * and a policy of `default-src 'none'` so that whatever these bytes
             * turn out to be, they load nothing and run nothing on this origin.
             * `sandbox` for the same reason, one layer further out.
             */
            response.statusCode = reply.status
            response.setHeader('content-type', reply.binary.type)
            response.setHeader('x-content-type-options', 'nosniff')
            response.setHeader('content-security-policy', "default-src 'none'; sandbox")
            response.end(Buffer.from(reply.binary.bytes))
            return
          }
          if (reply.body === null) {
            response.statusCode = reply.status
            response.end()
            return
          }
          response.statusCode = reply.status
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.end(JSON.stringify(reply.body, null, 2))
        }

        /* Spelled by the protocol package so that this app and every host
           cannot disagree about it by a character. */
        if (path === WELL_KNOWN) return send({ status: 200, body: MANIFEST })

        if (path === '/app' || path === '/app/' || path === '/') {
          void server
            .transformIndexHtml(request.url ?? '/app', page(), request.originalUrl)
            .then((html) => {
              response.statusCode = 200
              response.setHeader('content-type', 'text/html; charset=utf-8')
              /*
               * Framed by a host and by nothing else — and by nothing at all is
               * fine too, which is what opening this page directly is.
               *
               * `frame-ancestors` is the module's own half of the arrangement:
               * a host says which origins IT will frame, and this says who may
               * frame this. It is deliberately not a list of one: whoever is
               * running this decides, through `ROADMAP_ORIGIN`, and the default
               * is the address the host in this workspace actually serves on.
               */
              response.setHeader(
                'content-security-policy',
                `frame-ancestors 'self' ${process.env.ROADMAP_ORIGIN ?? 'http://127.0.0.1:4181 http://localhost:4181'}`,
              )
              response.end(html)
            })
            .catch(next)
          return
        }

        const ours = path === '/healthz' || path === '/mcp' || path.startsWith('/api/')
        if (!ours) return next()

        /* Only the paths above read a body, and only those wait for one. Vite's
           own middleware stack has to keep seeing an unconsumed request for
           everything else. */
        void body(request)
          .then((parsed) => {
            const reply = answer(method, path, url.searchParams, parsed)
            if (!reply) return next()
            send(reply)
          })
          .catch(next)
      })
    },
  }
}

/**
 * The request body, as JSON, or null.
 *
 * Bounded at a megabyte, because the caller is whatever on this machine found
 * the port — loopback is a fence around the machine and not around the programs
 * on it — and a handler that reads until the socket closes is a handler that
 * can be asked to read forever. The only body this app ever reads is an MCP
 * envelope naming an epic; the bound is a bound rather than a budget.
 *
 * Unparseable is null rather than a throw, and `doors.ts` says "that was not a
 * request" about it. A malformed body is an ordinary answer to give.
 */
const MAX_BODY_BYTES = 1_000_000

async function body(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  if ((request.method ?? 'GET').toUpperCase() !== 'POST') return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const piece = chunk as Buffer
    size += piece.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(piece)
  }
  if (!chunks.length) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

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
 * This app has no ticket to leak, being read-only — so the leak here would be
 * smaller and the fix is the same one, taken for a second reason besides. The
 * program this was extracted from ran `app.use(cors())` with no options in
 * front of a `POST /api/edits` that wrote to the author's thesis. The lesson
 * from that is not "be careful with the write path", it is "do not put a
 * permissive header on an origin that answers anything you care about". So the
 * manifest declares `storage: true`, this line is gone, and the page's own
 * `/api` calls are ordinary same-origin requests with no CORS involved at all.
 *
 * ## No alias for `roadmap-module-protocol`
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
  plugins: [serves({ id: ID, prefer: PREFERRED_PORT }), doors(), react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true },
})
