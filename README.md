# Paper

The paper an epic is aimed at, read as prose rather than as LaTeX.

An app: a page, a reader over a directory of `.tex` files, and an MCP door. A
host may frame it and then it follows whichever epic the canvas is on — but
nothing here needs one. Open `http://127.0.0.1:7870/app` and the whole reader is
there, with a picker in place of the canvas.

```bash
KEHIKKO_PAPERS_DIR=~/Projects/roadmap/data/papers ./run.sh   # 7870
bun run register        # tell a host on this machine where this answers
bun test
bun run typecheck
```

## Where the papers come from

Environment variables, and no default:

| Variable              | Means                                                    |
| --------------------- | -------------------------------------------------------- |
| `KEHIKKO_PAPERS_DIR`  | the directory holding one folder per epic                 |
| `KEHIKKO_ROADMAP_DIR` | a roadmap checkout; `data/papers` under it is used        |
| `KEHIKKO_THESIS_DIR`  | ONE document: a `main.tex` at the top of its own tree     |
| `KEHIKKO_THESIS_EPIC` | the slug that document answers to. Default `thesis`       |
| `PORT`                | 7870 by default                                           |
| `ROADMAP_ORIGIN`      | who may frame this page; the local host by default        |

None of the first three set is an ordinary state with a screen of its own,
saying what to set. It is deliberately not an error and deliberately not a
default path: the program this was extracted from had `../05_drafts/thesis_latex`
compiled into it, which is the line that made it one person's app rather than a
module.

A paper is `<papers>/<epic>/main.tex`, plus whatever it `\include`s. Nothing is
cached: the file is opened on every read, so a paper edited in an editor is a
paper the next read shows.

### Why a thesis is a second root and not a thirteenth subdirectory

`KEHIKKO_PAPERS_DIR` names a directory of directories. A thesis is not shaped
like that: `main.tex` sits at the top of its own repository with `chapters/`,
`figures/`, a `.cls` and a `references.bib` beside it, and it is the only thing
in there. There is no parent full of siblings to point at.

The three ways of forcing it into the existing model are each worse than a
variable. Pointing `KEHIKKO_PAPERS_DIR` at the thesis's parent makes every
unrelated sibling folder a candidate epic and — worse — makes the confinement
root the parent, so `\include{../other/…}` would resolve *inside* the root and
be served: the fence still doing its job, and the job having become the wrong
one. Symlinking the thesis into `data/papers/thesis` works, and works by asking
the author to put a link to their thesis inside the roadmap's own data directory
so that this app did not have to grow a variable. Copying it in is the one thing
the essay at the top of `store.ts` exists to forbid.

So: a second root, **confined separately**, with its own slug. `roots()` is
where the two meet, and the meeting is a list rather than a merge — nothing
resolves a path against more than the one root it belongs to, and a path outside
every root is refused. A slug that exists under both loses in the thesis root,
so an existing paper keeps working and the new variable is the one that visibly
does nothing.

The slug from the environment goes through the same `SLUG` check as one from a
URL. A variable is set by somebody standing closer, not by somebody more
trustworthy.

## What it does

- Reads `context.epic` from the greeting and from every `roadmap.context`, and
  shows that epic's paper.
- `epic: null` is an ordinary state with its own screen, not an error — it is
  what the canvas looks like before anybody opens anything.
- Fetching is keyed to the epic **changing**. The host sends a context after
  every selection change anywhere on the canvas, and re-reading on each of those
  would throw the paper away and lose the reader's place mid-sentence.
- Asks the host `epics.list` once, on the greeting, for one thing only: which
  epics have **no** paper. That is the one fact a directory of papers cannot
  contain. Refused or unanswered, the line simply is not drawn.
- Parses LaTeX into blocks that keep their byte offsets, expands the macros a
  paper defines for itself (`\gh{111}` reads as `gh#111`, as it does in the
  PDF), and renders headings, prose, lists, figures, tables and annotations.

## How it reads: pages, a margin, and a gutter

The reader is React, Tailwind v4 and shadcn — the same stack as Checklist and
for the same reason, which is that a control here should be the control it is
everywhere else on the canvas.

**Pages, not a scroll.** A paper is shown one sheet at a time, with a page
indicator and next/previous, and the arrow keys turn it. Which blocks are on
which sheet is a PURE FUNCTION of the block list (`src/reader/pages.ts`) —
weighed in lines, packed to a budget, with a heading never left alone at the
foot of a page. It is deliberately not measured. The reader this was rebuilt
from laid a hidden copy of the chapter out and read real pixel heights, which is
more accurate and re-packs itself every time the pane is resized or a font
finishes loading; the reader on page 7 is then silently moved to page 6,
mid-sentence, with no event they could point at. These breaks are an estimate
either way — the compiled PDF's are the compiler's, not this program's — and the
page says so under the controls. A stable estimate is worth more than an
accurate one that moves.

**A margin rail.** A `todonotes` macro is a margin note in the compiled PDF, and
a run of `%` lines in these papers carries the reasoning behind the section under
it. Both belong beside the text rather than in it, so each leaves a pin in the
flow and its words go to a card in the rail, which draws a dashed leader line
back to the exact pin when the pair is lit. Card placement is the one measured
thing in the reader, and it is measured after pagination has already decided, so
it cannot feed back.

**In a narrow pane there is no rail**, and the note's text stays inline behind
its pin as it did before — the fallback `parse.ts` argues for. That switch is a
`@container` query, never a viewport breakpoint: this module is sized by its
pane, and the pane is routinely 300 pixels wide inside a window that is two
thousand. Both presentations are rendered and CSS shows exactly one, which keeps
the width question out of the component tree entirely.

**Gutter tags.** Every block carries a short tag naming its kind — `§` heading,
`¶` paragraph, `fig`, `tab`, `eq`, `list`, `code`, `%`, `pre`, `inc`, `cmd`,
`env` — revealed on hover. It is structural truth about how the LaTeX parsed,
and the fastest way to see that what reads as a table was parsed as `unknown`.
There is no room for a gutter in a narrow pane, so it is not drawn there; it is
never moved inline, because a `¶` in the reading flow is a character in the
argument.

**Highlight a passage** and a small panel says what you selected and where it
lives — `chapters/2_bridge.tex` bytes 4120–4380 — with a button that copies that
citation. `≈` means the selection crossed a macro expansion and was widened
outward to a boundary this program can justify rather than to a fabricated
offset. It posts nothing: the panel it replaces queued work for an agent, and
what was load-bearing about it was never the textarea, it was that a highlight in
a browser can be turned into an exact place in a file on disk.

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
| `/api/papers`                     | every epic with a paper, and whether this app was configured at all |
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
  main.tsx      mounts React, seeds the theme, imports the mailbox for effect
  app.tsx       the screens, the picker, the goto answer
  use-paper.ts  the ONE place the wire and the papers meet
  index.css     the theme, the dark variant, the container query
  reader/       pages.ts (pure pagination), blocks.tsx (the gutter),
                segments.tsx, notes.ts, rail.tsx, paginated.tsx, ask.tsx
  lib/          selection.ts (a highlight -> a source range), utils.ts
  components/ui shadcn's button and badge
wire/           the mailbox and the bridge, copied from References and Journeys
test/           parse, store, doors, wire, reader — 90 tests, no browser needed
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
