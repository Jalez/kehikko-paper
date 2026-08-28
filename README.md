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

One environment variable, and no default:

| Variable              | Means                                                    |
| --------------------- | -------------------------------------------------------- |
| `KEHIKKO_PAPERS_DIR`  | the directory holding one folder per epic                 |
| `KEHIKKO_ROADMAP_DIR` | a roadmap checkout; `data/papers` under it is used        |
| `PORT`                | 7870 by default                                           |
| `ROADMAP_ORIGIN`      | who may frame this page; the local host by default        |

Neither of the first two set is an ordinary state with a screen of its own,
saying what to set. It is deliberately not an error and deliberately not a
default path: the program this was extracted from had `../05_drafts/thesis_latex`
compiled into it, which is the line that made it one person's app rather than a
module.

A paper is `<papers>/<epic>/main.tex`, plus whatever it `\include`s. Nothing is
cached: the file is opened on every read, so a paper edited in an editor is a
paper the next read shows.

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

There is also no KaTeX. Not one of the eleven papers in this roadmap contains a
`$`, an `equation` or an `align` — measured, not assumed — so an equation is
shown as its own LaTeX in a monospace box rather than shipping a typesetting
library for a case that does not occur. `parse.ts` keeps the raw LaTeX on the
block, so the day a paper has maths in it, that is the one branch that changes.

## Two fences on the epic name

`\include{../../../.ssh/id_rsa}` is a string somebody can type. So:

1. `SLUG` — the shape check, applied before any filesystem call, refusing
   identically whether or not the epic exists.
2. `confine()` — resolves the real path and refuses anything that did not land
   under the papers directory. This is the one that matters for include targets,
   which legitimately contain slashes and never go through the shape check, and
   for symlinks, which a string comparison cannot see.

`read_source` goes further: it will only open a file the paper itself named, so
"what does the paper say" cannot become "what is lying around next to it".

## The doors

| Path                              | |
| --------------------------------- | ----------------------------------------- |
| `/app`                            | the page |
| `/.well-known/roadmap-module.json`| the manifest |
| `/healthz`                        | |
| `/api/papers`                     | every epic with a paper, and whether this app was configured at all |
| `/api/paper?epic=…`               | one paper, parsed, chapters folded in |
| `/api/source?epic=…&file=…`       | the raw `.tex` of one file the paper names |
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
page/           document, styles, block rendering, and the one file that knows
                about both the wire and the papers
wire/           the mailbox and the bridge, copied from References and Journeys
test/           parse, store, doors, wire — 70 tests, no browser needed
```

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
