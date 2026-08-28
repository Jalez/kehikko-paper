import { STYLES } from './styles.ts'

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
 * ## What is in the markup, and what is drawn
 *
 * Almost nothing is written here. The heading, the state box, the picker's
 * container and the reading column are all the document carries; every heading,
 * paragraph and table is built by the client from what this program's own store
 * answers, because all of it depends on which epic is open.
 *
 * The heading does not always survive: `main.ts` removes `#who` when this page
 * is inside a frame. The host prints the module's name in the pane header and
 * hangs the manifest's `summary` off it as a tooltip, so a page that also
 * printed "Paper" at the top of itself would be saying the name twice and
 * spending a fixed strip of a 340px-tall pane on the repetition. Unframed there
 * is no pane header and nothing else would ever say what this app is, so the
 * heading stays. The test is `window.parent !== window`, which is answerable
 * before first paint and therefore does not blink.
 *
 * What goes is the app's IDENTITY only. `#where` beside it names the epic whose
 * paper is on screen, which is a statement about what is open rather than about
 * what this program is called, and it stays in both cases.
 *
 * ## The one script, and why its type matters
 *
 * `<script type="module">`, which is what Vite serves and what a browser needs
 * in order to `import`. It is also the exact thing an opaque origin cannot
 * fetch without a permissive CORS header — see the essay on `server.cors` in
 * `vite.config.ts`. If this page ever loads in a frame and does nothing at all,
 * that header is the first thing to check and the browser console is the only
 * place it is visible.
 */
const PAGE_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paper</title>
<style>__STYLES__</style>
</head>
<body>
<div class="head">
  <h1 id="who">Paper</h1>
  <span class="where" id="where"></span>
</div>

<p class="sight" id="sight">
  <b>The papers are somebody else&rsquo;s files.</b>
  This app reads a directory of LaTeX &mdash; one folder per epic &mdash; and renders the prose rather than the
  markup. It holds no copy and keeps no cache, so a paper edited in an editor is a paper this page shows on the
  next read. It writes nothing, anywhere, ever. Which epic is open is the host&rsquo;s to say; with no host, the
  list below is every paper on this machine.
</p>

<div class="picker" id="picker"></div>
<div id="paper"></div>
<p class="said" id="said" aria-live="polite"></p>

<script type="module" src="/page/main.ts"></script>
</body>
</html>
`

/**
 * The page, with the stylesheet substituted in.
 *
 * By replacement rather than by interpolation, so this file holds exactly one
 * template literal — the rule `styles.ts` explains at length, and the reason
 * the stylesheet is not simply inlined here.
 *
 * The replacement is given as a FUNCTION. `String.replace` reads `$&`, `$1` and
 * friends out of a replacement string, and a stylesheet is long enough that one
 * will eventually appear in it — at which point the page would be served with a
 * mangled rule, silently, for a reason nobody would find. A function
 * replacement is taken literally.
 */
export function page(): string {
  return PAGE_SHELL.replace('__STYLES__', () => STYLES)
}
