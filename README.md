# Paper

The paper an epic is aimed at, read as prose rather than as LaTeX.

An app: a page, a reader over a directory of `.tex` files, and an MCP door. A
host may frame it and then it follows whichever epic the canvas is on — but
nothing here needs one. Open `http://127.0.0.1:7870/app?project=/path/to/thesis&epic=thesis`
and the whole reader is there, reading that one paper off this machine.

It shows **the paper for the epic the canvas is on, and nothing else**. There is
no list of the other papers, no margin rail, and no sentence under the page
explaining which paper it is: the container header already carries this module's name
and the canvas already says which epic it is on.

```bash
./run.sh                # 7870, and there is nothing to configure
bun run register        # tell a host on this machine where this answers
bun test
bun run typecheck
```

## Where the papers come from

**The open project.** A paper lives in the project it is about, and the project
is the one the host names in `roadmap.context.projectPath` — the same
convention notes, checklist and journeys already keep. There is nothing to set.

| Where                                        | Means                                              |
| -------------------------------------------- | -------------------------------------------------- |
| `<project>/.kehikot/paper/<epic>/main.tex`   | a paper. The only place one is looked for          |
| `PORT`                                       | 7870 by default                                    |
| `ROADMAP_ORIGIN`                             | who may frame this page; the local host by default |

A paper is that directory's `main.tex`, plus whatever it `\include`s. Nothing
is cached: the file is opened on every read, so a paper edited in an editor is
the paper the next read shows.

No project is an ordinary state with a screen of its own, and it is deliberately
not an error and deliberately not a guess. The program this was extracted from
had `../05_drafts/thesis_latex` compiled into it, which is the line that made it
one person's app rather than a module.

### One place, and why there is no second one

A paper is a folder with a `main.tex` in it, under
`<project>/.kehikot/paper/`, named for the epic it belongs to. That is the
whole rule. A thesis is not a special case: it is one paper in that folder,
with its `chapters/`, `figures/`, `.cls` and `references.bib` beside it.

There used to be two roads. The default was `<project>/data/papers/<epic>/`,
and a `<project>/.kehikot/paper/papers.json` named the exceptions — one line
per epic, `{"papers": {"thesis": "."}}` for a project that was itself one
paper. It went because it was config that grows an entry every time somebody's
layout does not match a guess, and because two roads to a paper meant reading
either one alone never told you which had applied.

The argument that put papers outside `.kehikot/` was that the folder is a
program's working material and a paper is the opposite — the thing the person
is writing, with its own history. That was true while `.kehikot/` was ignored by
git, which would have made a thesis a document with no history. It is not true
now: whether that folder is committed is a per-project setting in the host, so
a project whose papers live there keeps it in its history and says so in one
place.

A project with an unusual layout moves its files. It does not declare itself
special.

### One project at a time, and each confined to itself

Every door takes a project and none of them defaults one — `process.cwd()` is
this module's own directory, and "the only project with papers" is right until
there are two. The page is told by the host; an unframed page is told by its own
URL (`/app?project=/abs/path&epic=thesis`); an agent at `/mcp` passes `project`
and is refused with a sentence if it does not.

The confinement root is the **paper's** directory, not the project's, so one
epic's `\include` cannot reach into the next epic's paper or into the rest of
somebody's repository. See `confine` in `store.ts`, which resolves the parent of
a path that does not exist rather than trusting a lexical prefix.

## What it does

- Reads `context.epic` from the greeting and from every `roadmap.context`, and
  shows that epic's paper.
- `epic: null` is an ordinary state with its own screen, not an error — it is
  what the canvas looks like before anybody opens anything.
- Fetching is keyed to the epic **changing**. The host sends a context after
  every selection change anywhere on the canvas, and re-reading on each of those
  would throw the paper away and lose the reader's place mid-sentence.
- Asks a host for **nothing**. `declares.uses` is empty. `epics:read` used to be
  there to draw one line — the epics a host knew about that had no paper — under
  a picker that no longer exists, and a capability asked for and never used is a
  permission somebody has to keep granting a program that will not call it.
- Parses LaTeX into blocks that keep their byte offsets, expands the macros a
  paper defines for itself (`\gh{111}` reads as `gh#111`, as it does in the
  PDF), and renders headings, prose, lists, figures, tables and annotations.

## How it reads: whole A4 pages, in one scrolling column

The reader is React, Tailwind v4 and shadcn — the same stack as Checklist and
for the same reason, which is that a control here should be the control it is
everywhere else on the canvas.

**A whole page, not as much of one as fits.** The sheet is 794×1123 CSS pixels,
which is A4 at 96dpi, and it is scaled to the width of the container by one
`transform: scale`. Every proportion inside it is fixed: the measure is always
the same number of characters, the margins are always the same fraction of the
sheet, a figure is always the same share of the page. Only the apparent size
changes. Measured at 220, 280, 320, 400 and 1200 pixels, in both themes: the
rendered aspect ratio is 1.4144 every time, against √2 = 1.41421.

The cost is stated rather than hidden. At 220 pixels the scale is 0.247 and the
body type draws at under four pixels — a thumbnail of a page, which is what
"show the whole page" means at that width. Clamping the scale instead would put
half a sheet behind the edge of a container, and dragging sideways to read is the one
thing this module refuses.

**Pagination is a property of the DOCUMENT, not of the container.** Because the page
box is fixed, `src/reader/pages.ts` derives its line budget from that box —
`CHARS_PER_LINE` and `LINES_PER_PAGE` are computed from `PAGE`, not typed in —
and takes nothing else. The thesis is 55 pages at 220px and 55 pages at 1200px;
resizing a container cannot move a reader, because there is nothing about the container
for the paginator to see. That property used to hold by accident, because the
weights happened not to consult the container; now it holds because the box the type
is set in cannot vary.

The breaks are still an ESTIMATE and the page still says so under them. A LaTeX
compiler's float placement, widow control and hyphenation move the real ones.

**Scrolling, not page turns.** Every page is laid out in one column and the
reader scrolls through them the way they scroll a PDF, with the join between one
sheet and the next visible as it passes. The page number is a READOUT — it
follows the scroll and is not something to press, because a number that looks
pressable and is not is worse than no number. `PageUp`, `PageDown`, `Home`,
`End` and the arrows reach the column: it is focusable, and a key pressed while
focus is on the sections trigger is forwarded to it rather than doing nothing.

**Nothing is virtualised, and that is a decision.** The whole thesis is 55 pages,
2,437 DOM nodes and 16,101 words rendered at once, first paint in ~610ms against
a Vite dev server. Virtualising would cost three things that do not throw when
they break: `scrollIntoView` on an unrendered page does nothing, so a
`roadmap.goto` at the end of the paper fails silently; the browser's own
find-in-page can only see what is in the DOM; and a highlight anchored to page 30
cannot be resolved. Measured, the cost of rendering everything was not there.

**The sections are a shadcn sidebar beside the paper.** Collapsed to nothing by
default, because a container is routinely 280 pixels wide and a table of contents open
by default is a reader who asked for a paper being handed an index of it. The
trigger opens and closes it; a press on a section scrolls that page into view,
smoothly, so the reader can see how far they went.
`src/components/ui/sidebar.tsx` says exactly which three things about upstream's
version were changed for a container and why — the short version is that upstream
positions itself against the VIEWPORT, swaps to a `Sheet` at a viewport
breakpoint, and takes ⌘B globally, and all three are the wrong answer inside
somebody else's canvas.

**Gutter tags.** Every block carries a short tag naming its kind — `§` heading,
`¶` paragraph, `fig`, `tab`, `eq`, `list`, `code`, `%`, `pre`, `inc`, `cmd`,
`env` — revealed on hover, in the sheet's own left margin. It is structural truth
about how the LaTeX parsed, and the fastest way to see that what reads as a table
was parsed as `unknown`. Because that margin is now a fixed fraction of a fixed
page, there is no longer a width at which the tag is silently not drawn.

**Highlight a passage** and a small panel says what you selected and where it
lives — `chapters/2_bridge.tex` bytes 4120–4380 — with a button that copies that
citation. `≈` means the selection crossed a macro expansion and was widened
outward to a boundary this program can justify rather than to a fabricated
offset. It posts nothing.

### What was removed, and where it went

**The margin rail is gone**, and so are the pins that anchored it. `notes.ts`
argued — correctly — that a `\todo{}` is a margin note in the compiled PDF and
that a run of `%` lines carries the reasoning behind the section under it, so
both belonged beside the text rather than in it. That argument was not wrong; the
decision is the reader's, and annotation is becoming a module of its own, which
makes this a MOVE rather than a loss.

What was load-bearing about the rail is kept: the author's words are still on the
page. A `\todo{}` is set inline in the copy-editor's amber, visibly not the
argument, and a source comment keeps its rule and its muted colour. The one thing
that goes with the rail is the `◆` glyph the parser emits in front of a note,
because a pin pointing at nothing is a character in the middle of a sentence.

**The picker is gone.** It listed every paper on this machine with a muted line
naming the epics that had none. What replaces it is nothing: which paper is on
screen is the canvas's answer. The three honest screens stay — no epic open, an
epic with no paper, nobody has said where the papers are — because those are
facts a reader has to be told rather than an affordance for browsing. Unframed,
`?epic=…` in the address says which one paper to read; it is not a list and
cannot become one.

**`selection.ts` stays, and publishes nothing yet.** A Notes module should be
able to attach a note to the passage a reader has highlighted here. The canvas
`selection` on `roadmap.context` is the wrong pipe for it: that field carries
tracker refs (`gh#105`) and every module that reads it looks the string up in a
tracker, so a byte range posted there would be handed to Journeys and to
References as an issue neither can find. A passage needs a shape of its own, and
that shape has two ends, one of which does not exist yet. `src/use-selection.ts`
holds the selection in one place, with the open question written down and the
two-line addition named.

## What it does not do, on purpose

**It writes nothing.** The program this was extracted from was a workbench: a
`POST /api/edits` that rewrote the author's thesis, a SQLite work queue, a
margin-notice thread, and an MCP surface of eleven tools, seven of which
mutated. None of it is here.

That is not only scope. It had `app.use(cors())` — no options, wide open — in
front of that write path, so any page in any tab could read the origin and post
to it. The lesson taken from that is not "be careful with the write path"; it is
**do not put a permissive header on an origin that answers anything you care
about.** So:

- `manifest.ts` declares `storage: true`, which makes a host frame this page
  with `allow-same-origin`. With a real origin, this page's own `/api` calls are
  ordinary same-origin requests and no CORS is involved at all.
- `vite.config.ts` has **no `server.cors`**, and must not grow one. Measured:
  `curl -H 'Origin: https://evil.example' http://127.0.0.1:7870/app` comes back
  with no `Access-Control-Allow-Origin` at all.
- There is no ticket, because there is nothing to gate. If a write path is ever
  added it needs all three back — a per-process ticket printed into the page,
  `storage: true` kept so the ticket is not readable cross-origin, and a comment
  saying plainly what the ticket does and does not separate. The essay is at the
  top of `doors.ts`.

### Figures are drawn, and two kinds deliberately are not

For a long time a figure was a dashed box with a filename in it, and the comment
saying why was right: serving the image would mean "a door that reads arbitrary
files out of somebody else's tree and answers them with a guessed content type".
The thesis is the first corpus here with real figures in it, and that objection
is answered rather than overruled. Four checks, each load-bearing:

1. The epic passes `SLUG`.
2. The file must be one the **paper itself named** — collected from the parsed
   `\includegraphics` targets, never from a directory listing. A private PNG
   sitting in `figures/` that the author never included stays unreachable.
3. The extension must be in a table in `store.ts`, and the `Content-Type` sent
   is that table's constant. It is never sniffed and never guessed from the
   bytes. `x-content-type-options: nosniff` and
   `content-security-policy: default-src 'none'; sandbox` ride along, because a
   browser deciding for itself what these bytes are would undo check 3 on its own.
4. `confine()` still stands underneath, catching `\includegraphics{../../x.png}`
   and a symlink out of the tree.

**SVG and PDF are refused.** An SVG is a document, it can carry `<script>`, and
this app would serve it from the same origin as its own `/api` — the origin
`manifest.ts` argues so carefully for keeping. A PDF cannot go in an `<img>` at
all, so serving it would mean an embedded viewer on that same origin with a
larger surface. Both keep the filename box. The thesis on this machine has three
PNG figures, which render, and one PDF figure, which does not: a visible,
explicable gap rather than a silent one.

There is also no KaTeX. Not one of the twenty-two `.tex` files in this roadmap
contains a `$`, an `equation` or an `align` — measured, not assumed — so an
equation is shown as its own LaTeX in a monospace box rather than shipping a
typesetting library for a case that does not occur. `parse.ts` keeps the raw
LaTeX on the block, so the day a paper has maths in it, that is the one branch
that changes.

And there is no `tailwind.config.js`. Tailwind v4 is configured in CSS, in
`src/index.css`, which is also where the dark variant is defined — as a class
the wire sets from `roadmap.context.theme` rather than `prefers-color-scheme`,
because the theme this page has to agree with is the roadmap's and not the
reader's operating system's. The one place the media query is consulted is
`main.tsx`, to decide what that class starts as on a page nobody is framing.

## Two fences on the epic name

`\include{../../../.ssh/id_rsa}` is a string somebody can type. So:

1. `SLUG` — the shape check, applied before any filesystem call, refusing
   identically whether or not the epic exists.
2. `confine()` — resolves the real path and refuses anything that did not land
   under **that paper's own root**. This is the one that matters for include
   targets, which legitimately contain slashes and never go through the shape
   check, and for symlinks, which a string comparison cannot see. With two
   configured roots it is applied per root: one root can never resolve a path
   against the other's, and a path outside every root is refused.

`read_source` goes further: it will only open a file the paper itself named, so
"what does the paper say" cannot become "what is lying around next to it".
`/api/figure` applies the same rule to images, plus an extension allowlist — see
below.

## The doors

| Path                              | |
| --------------------------------- | ----------------------------------------- |
| `/app`                            | the page |
| `/.well-known/roadmap-module.json`| the manifest |
| `/healthz`                        | |
| `/api/papers`                     | every epic with a paper, and whether this app was configured at all — the page reads only the second half, the MCP `list_papers` tool the first |
| `/api/paper?epic=…`               | one paper, parsed, chapters folded in |
| `/api/source?epic=…&file=…`       | the raw `.tex` of one file the paper names |
| `/api/figure?epic=…&file=…`       | one image the paper names — bytes, not JSON |
| `/mcp`                            | `list_papers`, `read_paper`, `read_source` |

All of it is middleware in front of the one Vite server. A module is one origin
or it is nothing — and two ports is exactly where the wide-open `cors()` in the
program this replaces came from.

## Layout

```
manifest.ts     what a host reads, and the essays on storage and the protocol
doors.ts        every door but the page, as one function with no socket
store.ts        the papers directory, the two fences, \include folded in
latex/parse.ts  LaTeX -> source-mapped blocks (carried over; see its own header)
page/           the document shell, and nothing drawn in it
src/
  main.tsx         mounts React, seeds the theme, imports the mailbox for effect
  app.tsx          the screens and the goto answer
  use-paper.ts     the ONE place the wire and the papers meet
  use-selection.ts what is highlighted, and the open question about publishing it
  index.css        the theme, the dark variant, the sheet, the scroll column
  reader/          pages.ts (the A4 page box and pure pagination),
                   paginated.tsx (the scrolling column and the sections),
                   blocks.tsx (the gutter), segments.tsx, ask.tsx
  lib/             selection.ts (a highlight -> a source range), utils.ts
  components/ui    shadcn's button, badge and sidebar
wire/           the mailbox and the bridge, copied from References and Journeys
test/           parse, store, doors, wire, reader — 134 tests, no browser needed
```

`src/reader/` knows about LaTeX and nothing about the wire. `wire/` knows about
the wire and nothing about papers. `use-paper.ts` is the only place the two meet,
and deliberately the only one: two places deciding which paper is on screen would
eventually disagree, and that is the one question this app cannot afford to be
confused about.

Everything the client imports from `store.ts` comes in with `import type`.
`store.ts` imports `node:fs`, and a value import of it would put a `node:` module
in the browser bundle — a page that loads, fires `load`, gets greeted and never
answers, with `tsc` and `bun test` both perfectly happy. Only a browser sees it.

## The two bugs every module here has hit

Both are fixed here the same way they are fixed everywhere else, and the reasons
are written where the code is:

- **The greeting race.** A host greets on the frame's `load` event, which is
  before an application is necessarily ready. `wire/mailbox.ts` records every
  message always and replays the backlog to each subscriber, so a greeting that
  arrived first is still answered.
- **Store the connection before listening.** The mailbox replays synchronously,
  so a handler can fire inside `connect()` before its return value is assigned.
  Written the obvious way, everything the handler tries to send goes nowhere,
  with no error and no timeout.
