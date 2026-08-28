/**
 * The document, assembled per request.
 *
 * ## Why this is a string and not an `index.html`
 *
 * Journeys generates its document because it has to carry a write ticket into
 * the page without a door that hands the ticket out. There is no ticket here —
 * this app takes no writes — so that reason does not apply, and the shape is
 * kept for the other one from that file: `entry` is `/app`, and under Vite dev
 * an extensionless path is not free. A request for `/app` sitting next to an
 * `app.tsx` resolves to that module and answers `200 text/javascript` with
 * compiled source. A browser loads such a document happily and runs nothing in
 * it: the frame's `load` fires, the host greets it, and nothing answers. The
 * pane then reads "loaded its page and did not answer the host's greeting",
 * which is true and says nothing about why. Claiming `/app` in middleware,
 * before Vite's resolver sees it, is what makes that impossible — and a
 * middleware that claims a path has to have a document to answer with.
 *
 * ## Nothing is drawn here
 *
 * There is a root element and one script. Every heading, paragraph, sheet and
 * margin card is built by React from what this program's own store answers,
 * because all of it depends on which epic is open — and because a page redrawn
 * after a page turn must not have this file and the client holding two versions
 * of the same sentence.
 *
 * The stylesheet is no longer inlined here. It was, while the client was
 * vanilla DOM and the whole sheet was one string in `page/styles.ts`: one round
 * trip rather than two on a page drawn inside somebody else's frame. Tailwind
 * is imported by `src/main.tsx` and served by Vite now, and the trade went the
 * other way — a stylesheet substituted into a template literal is a place where
 * one stray backtick serves half a sheet followed by a syntax error in the
 * middle of the markup, and the round trip it saved was to the same loopback
 * process that served this document.
 *
 * ## The one script, and why its type matters
 *
 * `<script type="module">`, which is what Vite serves and what a browser needs
 * in order to `import`. It is also the exact thing an opaque origin cannot
 * fetch without a permissive CORS header — see the essay on `server.cors` in
 * `vite.config.ts`. If this page ever loads in a frame and does nothing at all,
 * that header, or the `storage: true` that makes it unnecessary, is the first
 * thing to check, and the browser console is the only place it is visible.
 *
 * The second thing to check is an import in the client that reached a `node:`
 * module. `store.ts` imports `node:fs` and the client imports its TYPES; a
 * value import of the same file would blow up at evaluation time in the
 * browser, with `tsc` and `bun test` both clean, and the symptom is identical
 * to the CORS one — a page that loads and never answers the greeting.
 */
const PAGE_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paper</title>
</head>
<body>
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>
`

/** The page. */
export function page(): string {
  return PAGE_SHELL
}
