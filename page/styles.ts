/**
 * The stylesheet, as one string.
 *
 * It is a file of its own because it is a single enormous backtick literal: a
 * stray backtick anywhere inside it closes the string, and what that looks like
 * from the outside is a page that serves half a stylesheet followed by a syntax
 * error in the middle of the markup. One literal per file means a mistake here
 * cannot take the document shell in `document.ts` down with it.
 *
 * It is a string rather than a `.css` file Vite would serve because the
 * document is generated (see `document.ts`), and a generated document inlining
 * its own stylesheet is one round trip rather than two on a page drawn inside
 * somebody else's frame.
 *
 * ## What this page has to get right, and it is not typography
 *
 * A paper read in a 240px pane and a paper read full width are the same
 * document, and the reader has to be able to tell that. Two rules follow:
 *
 * - **Nothing is truncated, anywhere.** There is no `text-overflow`, no
 *   `overflow: hidden` on anything holding words, and no clamped line count. A
 *   heading cut off at "The bridge carries what a panel…" in a narrow pane is a
 *   reader who cannot tell which section they are in, and this app exists to
 *   put the prose in front of somebody.
 * - **The reading measure narrows; it does not scroll sideways.** `max-width`
 *   on the column, `overflow-wrap: anywhere` inherited from the body, and
 *   `min-width: 0` on every flex item that holds text. The one thing on this
 *   page that genuinely cannot reflow is a table, and that gets its own
 *   scroller rather than being allowed to widen the document.
 *
 * ## Why the small-pane rules are container queries
 *
 * This module is framed in panes that are routinely 220 to 400 pixels wide
 * inside a window that is a couple of thousand. A viewport breakpoint asks the
 * wrong question every single time: the window is never narrow and the pane
 * usually is. So `html` carries `container-type: inline-size` and the narrow
 * rules query `pane`, which is the box this page is actually given.
 *
 * The failure that matters is not the obvious one. Nothing gets styled too
 * wide; what happens is a MIN-CONTENT FLOOR, and the symptom is a horizontal
 * scrollbar on the whole document at 220px. Long unbreakable strings build it —
 * a `\\texttt{}` span holding `roadmap-module-protocol`, a label like
 * `sec:extraction`, a URL in a footnote — and each one sets a floor under its
 * own paragraph that nothing narrower can go below. `overflow-wrap: anywhere`
 * rather than `break-word` on purpose: only `anywhere` lowers the min-content
 * contribution, and lowering it is the entire fix.
 *
 * ## Colours
 *
 * `color-scheme: light dark` and the system palette, because the frame around
 * this page has a theme of its own and a module that painted a white page into
 * a dark roadmap would be the first thing anybody noticed about the protocol.
 *
 * The system palette is not enough on its own, which is why `[data-theme]`
 * appears below. `prefers-color-scheme` follows the READER'S OPERATING SYSTEM
 * and knows nothing about the host: a dark roadmap on a machine set to light
 * would frame this page and get a white rectangle. So the host's own answer —
 * it arrives on every `roadmap.context` as `theme` — is written onto the root
 * element and wins where it is set. Where nothing has set it, which is what
 * standing alone looks like, the media query decides.
 *
 * The page paints its own opaque surface rather than borrowing the host's.
 * Measured in the real frame, a host's `<iframe>` element computes to
 * `background-color: rgb(255, 255, 255)` — a white sheet between this document
 * and the host's near-black page — so `transparent` does not mean "the
 * roadmap's background", it means white, in both themes, with light ink on top
 * of it in the dark one. The numbers below are the ones References and Atlas
 * compute to in the same roadmap; sharing a surface with the panes either side
 * is worth more than a background that agrees with this page's own warm ink.
 */
export const STYLES = `
:root {
  color-scheme: light dark;
  --ink: #1c1917;
  --muted: #6b6560;
  --line: #e0dcd7;
  --bg: #ffffff;
  --card: rgba(0,0,0,.02);
  --accent: #0b7285;
  --mark: #9a6700;
  --code: rgba(0,0,0,.05);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ink: #ece8e3;
    --muted: #a29a92;
    --line: #35302b;
    --bg: #0a0a0a;
    --card: rgba(255,255,255,.03);
    --accent: #6cc6d6;
    --mark: #d9a441;
    --code: rgba(255,255,255,.06);
  }
}
:root[data-theme="dark"] {
  --ink: #ece8e3;
  --muted: #a29a92;
  --line: #35302b;
  --bg: #0a0a0a;
  --card: rgba(255,255,255,.03);
  --accent: #6cc6d6;
  --mark: #d9a441;
  --code: rgba(255,255,255,.06);
}

* { box-sizing: border-box; }

/* The pane, named, so the rules at the bottom can ask how wide THIS is rather
   than how wide the window is. */
html {
  container-type: inline-size;
  container-name: pane;
  background: var(--bg);
}

body {
  font: 15px/1.65 ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
  margin: 0;
  padding: 1rem 1rem 4rem;
  color: var(--ink);
  background: var(--bg);
  max-width: 46rem;
  /* Inherited by everything, and the reason a 220px pane can lay this page out
     at all. One unbreakable token in a \\texttt span used to widen the whole
     document; see the essay above. */
  overflow-wrap: anywhere;
}

.head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; margin-bottom: .2rem; }
.head h1 { font-size: 1.15rem; margin: 0; letter-spacing: -.01em; min-width: 0; }
.where { color: var(--muted); font-size: .85rem; min-width: 0; }

/* What this app can see from here. A box, at the top, never a tooltip. */
.sight {
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  padding: .55rem .7rem;
  margin: .8rem 0 1rem;
  font: .87rem/1.5 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--muted);
  background: var(--card);
}
.sight b { color: var(--ink); }
.sight code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .92em;
  background: var(--code);
  padding: .05rem .25rem;
  border-radius: 3px;
}

/* The picker. Every paper on this machine, so the app is usable with nothing
   framing it — and, when something is, so a reader can look at a paper other
   than the open epic's without leaving the pane. */
.picker { display: flex; flex-wrap: wrap; gap: .35rem; margin: 0 0 1rem; }
.picker button {
  font: .8rem/1.3 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: .25rem .6rem;
  cursor: pointer;
  min-width: 0;
  text-align: left;
}
.picker button[aria-pressed="true"] {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.picker button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* The gap the host names: epics with no paper. A sentence, not buttons — there
   is nothing to press. Wraps rather than truncating, like everything here. */
.picker .gap {
  font: .75rem/1.4 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--muted);
  align-self: center;
  min-width: 0;
}

/* The paper itself. */
.paper { margin: 0; }
.paper .title { font-size: 1.45rem; line-height: 1.25; margin: 0 0 .1rem; letter-spacing: -.015em; }
.paper .byline {
  font: .8rem/1.4 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--muted);
  margin: 0 0 1.2rem;
}

/* The section list. A <details> and not a sidebar: at 240px there is no room
   beside the text for anything, and a list that pushed the prose off the pane
   would be a table of contents nobody could read the contents of. Open by
   default only where there is room — see the container query at the bottom. */
.toc { margin: 0 0 1.4rem; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
.toc > summary {
  cursor: pointer;
  padding: .45rem .7rem;
  font: .82rem/1.4 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--muted);
}
.toc ol { list-style: none; margin: 0; padding: 0 .7rem .6rem; }
.toc a {
  display: block;
  padding: .18rem 0;
  color: var(--ink);
  text-decoration: none;
  font: .85rem/1.4 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  border-bottom: 1px solid transparent;
}
.toc a:hover, .toc a:focus-visible { color: var(--accent); border-bottom-color: var(--accent); }
.toc li[data-level="3"] a { padding-left: .9rem; color: var(--muted); }
.toc li[data-level="4"] a { padding-left: 1.8rem; color: var(--muted); }

.paper h2, .paper h3, .paper h4, .paper h5 {
  line-height: 1.3;
  margin: 1.6rem 0 .5rem;
  letter-spacing: -.01em;
  /* The anchors are scroll targets. Without this a heading jumped to from the
     section list lands flush against the top of the pane with the sentence it
     titles already scrolled past the fold. */
  scroll-margin-top: .8rem;
}
.paper h2 { font-size: 1.2rem; }
.paper h3 { font-size: 1.05rem; }
.paper h4 { font-size: .95rem; color: var(--muted); }
.paper h5 { font-size: .9rem; color: var(--muted); font-style: italic; }
.paper p { margin: 0 0 .85rem; }
.paper ul, .paper ol { margin: 0 0 .9rem; padding-left: 1.2rem; }
.paper li { margin: 0 0 .3rem; }

.paper em { font-style: italic; }
.paper strong { font-weight: 650; }
.paper code, .paper .tt {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .9em;
  background: var(--code);
  padding: .05rem .25rem;
  border-radius: 3px;
}
.paper .cite, .paper .xref { color: var(--accent); font-style: normal; }
.paper .todo {
  color: var(--mark);
  background: color-mix(in srgb, var(--mark) 12%, transparent);
  padding: .05rem .2rem;
  border-radius: 3px;
}

.paper .math {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .92em;
  color: var(--accent);
}
.paper .display-math {
  display: block;
  margin: 0 0 .9rem;
  padding: .5rem .7rem;
  border-left: 2px solid var(--line);
  overflow-x: auto;
  white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .85rem;
}

/* Verbatim and any block that fell back to its source. Its own scroller, never
   the document's: code does not reflow, and a paper with one wide listing in it
   must not become a paper you read by dragging sideways. */
.paper pre {
  margin: 0 0 .9rem;
  padding: .55rem .7rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .82rem;
  line-height: 1.5;
  /* Deliberately NOT \`anywhere\`: breaking a line of code at an arbitrary
     column changes what it appears to say. Wide code scrolls; prose wraps. */
  overflow-wrap: normal;
  white-space: pre;
}

/* A table gets a scroller of its own for the same reason, and a caption that
   stays outside it so the caption always wraps. */
.paper .table-wrap { overflow-x: auto; margin: 0 0 .3rem; border: 1px solid var(--line); border-radius: 6px; }
.paper table { border-collapse: collapse; font-size: .85rem; min-width: 100%; }
.paper th, .paper td { padding: .3rem .55rem; text-align: left; vertical-align: top; }
.paper th { font-weight: 650; }
.paper tr.rule-above > * { border-top: 1px solid var(--line); }
.paper .caption {
  font: .8rem/1.45 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--muted);
  margin: 0 0 1rem;
}
.paper figure { margin: 0 0 1rem; }
.paper .graphic {
  border: 1px dashed var(--line);
  border-radius: 6px;
  padding: .6rem .7rem;
  font: .8rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--muted);
}

/* A comment run the author left in the source. Shown rather than dropped: in
   these papers the comments carry the reasoning behind the section under them,
   and a reading view that hid them would be hiding the best writing in the
   file. Marked as not-the-argument so nobody mistakes one for prose. */
.paper .note {
  border-left: 2px solid var(--line);
  padding: .1rem 0 .1rem .7rem;
  margin: 0 0 .9rem;
  font: .84rem/1.55 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--muted);
  white-space: pre-wrap;
}

/* Everything the page says when it is not showing a paper. One class, because
   the four states differ in their words and not in their shape, and a state
   that looked different would read as a different kind of event. */
.state {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: .9rem 1rem;
  margin: .5rem 0;
  background: var(--card);
  font: .9rem/1.55 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
}
.state h2 { font-size: 1rem; margin: 0 0 .35rem; color: var(--ink); }
.state p { margin: 0 0 .5rem; color: var(--muted); }
.state p:last-child { margin-bottom: 0; }
.state code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .9em;
  background: var(--code);
  padding: .05rem .25rem;
  border-radius: 3px;
}

.said {
  font: .82rem/1.5 ui-sans-serif, -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--muted);
  margin: 1.2rem 0 0;
}

/*
 * The narrow pane.
 *
 * 400px is where the roadmap's own panes start being uncomfortable rather than
 * where any particular element breaks — measured, not guessed. Below it the
 * page gives back the padding it can afford to and steps the type down one
 * notch; it does not hide anything, because a pane that is narrow is not a
 * reader who wants to be told less.
 */
@container pane (max-width: 400px) {
  body { padding: .7rem .7rem 3rem; font-size: 14px; }
  .paper .title { font-size: 1.2rem; }
  .paper h2 { font-size: 1.05rem; }
  .paper h3 { font-size: .98rem; }
  .picker button { font-size: .75rem; padding: .2rem .5rem; }
  .sight { padding: .45rem .55rem; font-size: .82rem; }
}
`
