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

**Cross-references and citations read as the PDF prints them.** `\ref{ch:conclusion}`
draws as `6`, `\autoref` and `\Cref` as `Chapter 6`, `\nameref` as the
chapter's title; `\autocite{vanlehn2011relative}` draws as `(VanLehn, 2011)` and
`\textcite{braunclarke2019reflexive}` as `Braun and Clarke (2019)`, in the
author–year form biblatex's APA style prints. The numbers are recomputed from
the source on every read — chapters, sections, figures, tables, equations and
listings counted in `\include` order, appendix chapters lettered, starred
headings skipped — and never read out of an `.aux` file, so they are right for
a paper that has never been compiled and for one edited a moment ago. The
bibliography is the `.bib` the preamble names with `\addbibresource` or
`\bibliography`, confined to the paper's root like everything else. Hovering
either says what it resolved to. A reference is a link to the block it names;
a citation opens a card with the whole entry and, where the bibliography
records a DOI or URL, a link to read it. A key nothing resolves stays visible
as `§key` or `[key?]` and says so in its tooltip, because that reference will
come out of LaTeX as `??` or `[?]` and this is where the author should meet it
first. `latex/labels.ts` and `latex/bib.ts` say how; the numbering was checked
against the compiled thesis.

### Correcting a sentence, in the prose rather than in the source

Tick **Edit** beside the page number and the paper becomes typeable in place: a
typo is fixed where you are reading it, and the `.tex` file on disk is what
changes. There is no raw-source box, and this is not one in disguise.

**Text whose source can be reproduced from what you see may be typed into.**
That is ordinary prose, including a paragraph the author hard-wrapped: a run of
whitespace in the source draws as one space, and the rule inverts, so one space
written back over the whole run draws as one space. It is not a citation:
`\autocite{jones}` draws as `(Jones, 2020)` — or as `[jones?]` when the
bibliography has no such key — and nothing recovers the command from either. Nor an escape — `\%`
drawn as `%` would comment out the rest of the line if it were written back as
itself, and `~` is a non-breaking space somebody chose.

Those refuse the cursor — a browser will not place a caret outside an editing
host, so the refusal costs no code and cannot be got round by a keyboard, a drag
or a paste — and pressing one selects it whole and says why. Their source form
is deliberately not revealed: rendered prose with markup showing in the middle
of it is two languages on one page, and editing the revealed markup is a source
editor, which is the thing this view exists not to be. On the real thesis this
leaves 97% of the characters typeable; `dev/typeable.probe.ts` is how that is
measured, and the remainder is citations, references, inline maths and 56
characters of escapes.

**This is deliberately NOT the `literal` flag**, and one flag doing both jobs
was a real bug rather than a tidiness point. `literal` says the rendered
characters are the source characters one for one — a claim about MAPPING, which
`src/lib/selection.ts` depends on and must never be told wrongly. A wrapped
paragraph fails it, correctly. Editing was hung off the same flag, so every
paragraph in a hard-wrapped thesis was locked while its headings, having no wrap
inside them, stayed editable: measured at 1% against 100%, and reported as "so I
can edit the titles of sections but not the text itself?". `literal` is
unchanged; `typeable` is the separate claim, and `place()` in `latex/edit.ts`
maps a change in what you see onto the file through the pieces a run was merged
from — exactly inside a literal piece, snapped over a whitespace gap, refused
anywhere else.

An edit that consumes a gap turns that one hard wrap into a space. The document
is unchanged and the source line gets longer; an edit that merely abuts a wrap
leaves it alone.

**LaTeX markup is refused rather than escaped.** Typing `50%` gets a sentence,
not a silently written `\%`. Escaping is exact in prose and wrong inside
`verbatim`, inside `lstlisting` and inside maths, and a span knows its styles
rather than its environment — so a door that transformed what you typed would be
right in the common case and wrong wherever people put code. Enter commits,
Escape puts it back, and a line break is refused because a blank one ends a
paragraph.

**The server checks what it is about to overwrite.** Every legitimate edit
replaces either the inside of a literal run — which holds no LaTeX special
character, because the parser breaks a literal run at every one of them — or a
run of whitespace. So a range whose bytes contain a `\`, a `{`, a `%` or an `&`
is refused outright, whatever the caller claims about it. That is what stops a
bug in the page, an agent that guessed, or a replayed request with the numbers
changed from deleting a command, a citation or a comment.

**A file that moved is refused, and nothing is written.** Every edit carries the
SHA-256 of the file as this page last read it; the server re-reads and compares
before it splices, and answers 409 with the paper as it now is. Not
`sourceLength`, which is blind to every same-length rewrite — and a spelling
correction made by the author in their real editor is a same-length rewrite
almost by construction. Not the old `expectedText` match either: an edit *above*
a range makes that range name different text, which a quote check cannot see.
The cost is stated rather than hidden — a paper being autosaved from an editor
will refuse corrections from this page until it re-reads, which is one round
trip.

**What an edit does to anchors.** A passage or a note anchored below the edit
point moves by the change in length, and this module does not move it. That is
part of why the range written is narrowed to the characters that actually
changed rather than to the whole span.

### A change an agent suggests, approved where it is read

An agent can now suggest a change to the prose, and the person reading the paper
answers it. `propose_edit` on the MCP door takes the text to replace and the text
to put there — not a byte range — and files the suggestion. **Nothing is written
to the `.tex`.** The change is drawn into the paper where it happens, what leaves
struck through in red and what arrives in green, with a small card in the
reading column pointing at the changed words themselves: the reason for the
change, Accept, Reject, and where in the paper this one is.

**A byte range is not something a person can check before approving it.** That is
the whole reason the change is drawn in the prose and not listed in a panel. A
panel saying "in `chapters/2_bridge.tex`, bytes 4120–4137, replace X with Y" makes
the reader find the place themselves and then trust that the panel was talking
about it, which is exactly what goes wrong when a program asks for approval it has
not made checkable.

**It is drawn once, and the control points at it.** It used to be drawn twice —
the same red and green in the card as well as in the prose — because at 220
pixels the sheet is scaled to 0.25, the body type draws at 3.7 real pixels
(measured), and the inline diff is correctly placed and illegible. The owner read
it at that width and said the repetition was redundant, and the argument for it
had quietly expired: it was doing two jobs, saying what the change is and saying
where in the paragraph it is, and only the first was ever a duplicate. The card
is now anchored to the changed span, so the second job is done by the anchoring.

**The card is part of the document, not of the window.** It was a Radix
popover for one release: portalled to the end of `document.body`, `position:
fixed`, positioned by Floating UI on every scroll event, flipped and shifted
against the reading column, hidden when the words left it. That is the right
machine for a tooltip and the wrong one for an annotation, and the owner saw
both halves of the mismatch — the card "doesn't really stay still when user is
scrolling", and "if there are changes next to one another the dialogs can get
obstructed by eachother". A card outside the scroll container has to be chased
by script after the compositor has already moved the words, so it wobbles
against them; the flip against the column's edge was an 88px jump mid-scroll;
and Floating UI positions each card against its own anchor with no knowledge of
any other, so two changes on consecutive lines got two cards in the same place,
one Accept button under the other card (2,730px² of overlap, measured).

So the cards are absolutely positioned children of the reading column now, in
the column's own coordinates, laid out once per layout by `placeCards` in
`reader/proposed.tsx` and never per scroll: the column is what scrolls, so the
browser moves them with the words on the compositor thread, and hiding when the
words leave is what the column's `overflow` does anyway. What the portal was
really for is kept — the card is outside the transformed sheet, so it draws at
its own size while the anchor is measured through the transform by
`getBoundingClientRect`, and there is still no reciprocal of the scale anywhere
in this codebase. What the popover was doing that had to be switched off —
focus trapping, dismissal on Escape and on an outside click — a div does not do.

Because one pass lays out every card on the paper, it can lay them out against
each other: above the words by default, left-aligned and kept inside the column;
below them when there is no room above on the sheet (the old "first block on a
sheet" rule, decided from the rectangle rather than the packing); and never on
top of another card — a later card tries the other side of its words, then is
stacked under whatever it still lands on, and a stacked card loses its arrow
rather than point at the wrong thing. The earlier card in document order keeps
its place; the reader meets that one first.

Measured in a headless Chrome by `dev/proposals.drive.mjs`, before and after, at
460 and at 220: the two cards on consecutive lines overlap by 0px² and both
Accept buttons answer to `elementFromPoint` (before: 2,730px², one under the
other); the card's distance from its words is one number across 47 scroll frames
and it stays on one side (before: two numbers, two sides); and the card is never
drawn anywhere else before the next paint (before: every frame).

**Two counts, one list.** `x of y` sits beside Accept and Reject, and the chrome
row still says `y suggested` next to `Accept all`. They are the length and the
index of the same array, which `PaginatedView` sorts once into document order, so
they cannot drift. That order is the order a reader meets the changes by
scrolling — not the oldest-first order `Accept all` writes in, which nothing on
screen prints.

**The diff is at token level and the write is at character level**, and the two
are different jobs. `narrow` decides which bytes are replaced and works in
characters, so an anchor in the rest of the sentence is left in bytes nothing
touched. `diffWords` decides what is drawn and works in tokens, because a
character-level diff of "market" becoming "farm" keeps `mark` and reports `et`
out, `rm` in — minimal, true and unreadable.

**Prose only, and it is checked against the text the agent quoted.** A proposal
whose `find` or `replace` holds any of `\ { } $ & # ^ _ ~ %` is refused. That is
deliberately stricter than the write path, which checks the bytes actually being
replaced, and the reason is a case a test caught: `\autocite{jones}` becoming
`\autocite{smith}` narrows to `jones` becoming `smith`, neither of which holds a
special character. Those bytes are safe to write and the suggestion is still wrong
to accept — those five characters render as part of `[jones]`, so there is no
honest way to draw a change to them, and a suggestion this page cannot draw is one
somebody is being asked to approve without seeing.

#### Where a pending suggestion lives

**In this process's memory, for as long as it runs.** Not in the page: an agent
proposes over `/mcp`, which is a request to the server, so a page holding the list
would never hear about one. Not on the disk either — whether `.kehikot/` is
committed is a per-project setting in the host, so a `proposals.json` beside the
paper would put a half-considered suggestion nobody accepted into the author's git
history; and it is the SQLite work queue this module's extraction deliberately
dropped, with a different file extension.

The cost is stated rather than hidden: restart the server and every pending
suggestion is gone. Nothing was written and nothing was destroyed — the paper is
exactly as it was, which is the whole promise of a proposal — but an agent's work
has to be done again. That is the same lifetime the write ticket has, for the same
reason: a thing written down outlives the process that minted it.

#### What stops an agent applying its own change

**Two doors with different keys, and not a flag.** `propose_edit` is on `/mcp` and
cannot write. Accepting is `POST /api/proposal`, which demands the ticket this
process mints per run and prints into the page. The MCP door emits no ticket,
holds no ticket, and has no tool that returns one.

The limit is worth saying plainly, because a fence described as more than it is
becomes decoration. This is not a boundary between a person and an agent. An agent
with a shell on this machine can fetch `/app`, read the ticket out of it and post
— and could equally have skipped all of it and written to the `.tex` with `sed`.
What it guarantees is a property of the door this module OFFERS: an agent
following that door cannot change a paper behind the back of the person reading
it, and `guidance` in the manifest now tells every agent on the canvas so.

There is deliberately **no server-side auto-approve**, for the same reason. A flag
the server held would be a flag anything able to reach the server could set, and a
caller that can set it has approved its own change on the reader's behalf.

#### The Auto tick, and where it is remembered

Beside the Edit checkbox, off by default, and independent of it — Edit is about
whether *you* may type, and this is about what happens to somebody else's
suggestion, which can arrive while a paper is being read rather than written. With
it on, the PAGE presses Accept, with the ticket, exactly as a finger would.
Ticking it does not sweep up suggestions already waiting: those were shown to
somebody who did not answer them, and applying them retroactively would write
changes as the side effect of setting a preference.

A change applied by this tick is committed exactly as one somebody pressed a
button for — more worth saying, if anything, because nobody was looking when it
happened, and the commit is then the only place that change is written down as
having occurred. See the section on the paper's own repository below.

It is remembered in **`localStorage`, keyed by project and epic**. Not
`state.set`: that is per MODULE and this is a decision about one PAPER — a reader
who agreed that an agent may rewrite this epic's paper has not agreed the same
about the next one — and the unframed page, which this README treats as a
first-class way to use the module, has no host to keep it. Not on the server,
because a permission that travels in a git repository is a permission nobody
granted. `localStorage` works here where it does not work for most modules for one
specific reason: `manifest.ts` declares `storage: true` and this page therefore has
a real origin. This is the first thing in the module that uses the storage it has
been asking for.

#### Two suggestions in one file

Applying one moves every byte offset after it, so the second describes a place
that no longer means what it meant, and the hash it carries no longer matches the
file. The answer is **rebase**, in `latex/propose.ts`: a suggestion that does not
overlap the applied range is shifted by the change in length and restamped with
the file's new hash, which is not a guess but the same arithmetic the file itself
underwent. A suggestion that DOES overlap is dropped and said out loud, because it
described bytes that have been rewritten and there is nowhere honest to put it.

The rebase runs after a typed correction too, not only after an accept: a reader
fixing a typo two paragraphs above a pending suggestion has moved its bytes just
as surely.

Accept-all sits beside the count in the chrome row and applies them oldest first,
one at a time so each is measured against the file the one before it produced. It
is deliberately **not** in the floating control: a button meaning "and the other
four as well" repeated above each of five changes is five controls each claiming
to speak for all of them, and pressing the one above the paragraph you happened to
be reading writes four changes you have not scrolled to. What IS in the control is
a readout of which change this is — `2 of 4` — which speaks only for itself.

Rejecting opens no file at all. There is no path from that branch of the door to a
filesystem call, and `test/proposals.test.ts` asserts the bytes are identical.

#### What approval does not change

**Anchors still move.** An accepted suggestion writes bytes exactly as a typed
correction does, so a note or a passage below it shifts by the same amount and
nothing here migrates it — the section above says so and it is still true.
Approval changes only who decided. What it does add is that the arithmetic such a
migration would need is now written down, pure and tested, in `rebase`; it is
applied to this module's own pending suggestions, which it is the only writer of,
and to nothing belonging to anybody else.

#### What no test here can prove

happy-dom lays nothing out: `getBoundingClientRect` is all zeroes and so is
`offsetWidth`, so the layout pass in `ProposalControls` runs over rectangles about
nothing. The tests cover which characters are marked, which runs refuse the caret,
which ELEMENT the control was anchored to, that the card no longer repeats the
diff, that the two counts are one list, what the buttons say — and, because
`placeCards` is pure, the RULE by which cards yield to each other, stated as
numbers. They cannot cover where a card actually lands, whether it holds still
under a scroll, or whether the count fits beside the buttons.

Those are checked in a headless Chrome by `dev/proposals.drive.mjs`, which files
three suggestions through the MCP door, scrolls, presses Accept, and measures —
unframed for the geometry and framed, in an iframe with a greeting carrying a
passage, for the walk. It is a driver and not a test: it needs the module running
against a scratch `ROADMAP_MODULES_DIR`, and it writes to the paper it is pointed
at. What is still unchecked by anything: how it looks and reads to a person, and
whether the card covers prose somebody wanted at either width.

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

### A change that lands has a commit, in the paper's own repository

A paper is a `.tex` file in somebody's repository with its own history, and
`store.ts` opens by saying the worst thing this app could do is become a second
place where one lives. That is about STORAGE and it is still right. This is the
other half of it: if the paper's history is the real one, then a change this app
makes belongs IN it, rather than as an untracked diff somebody finds a week
later and cannot attribute.

**One accepted suggestion is one commit. Save is one commit.** Nothing else here
commits, and typing does not: a reader fixing four typos in a paragraph has made
one change to their paper, not four, and a commit per blur would fill a thesis's
history with a letter each. Accepting is the opposite — a discrete decision
about somebody else's suggestion, with a before, an after and a reason, which is
exactly the shape of a commit.

#### What Save means, since the file is already written

Typing goes to `POST /api/edit` on blur or Enter and lands in the `.tex`
immediately. That is not an implementation detail waiting to be tidied away
behind a button; it is the property the whole module rests on. Nothing is
cached, `readPaper` opens the file every time, and the author may have the same
file open in a real editor. Buffering edits in the page until somebody pressed
Save would make this app hold a second, newer copy of a paper it has spent its
life refusing to hold.

So **Save commits what has changed since the last commit**, and the write path is
untouched. The control reads `Save 2` when two paths would go in and `Save` when
none would — the count in the label as well as in the filled variant, because
this module's rule is that every colour on the page is paired with something that
is not a colour, and at 220 pixels a number is what a reader can check.

It is pressable in every state it is drawn in, including the two where pressing
changes nothing. A disabled button can only explain itself in a `title`, which is
a hover, which a touch screen does not have — and "nothing has changed since the
last commit" is precisely what somebody pressing Save wants to be told. Pressing
with nothing to commit does nothing to the repository and says so; pressing when
git has refused does nothing and says why.

#### The repository is somebody else's, and it is not the paper's

This is the fact `git.ts` is shaped around. A paper lives at
`<project>/.kehikot/paper/<epic>/`, and the project is very often not the root of
a repository — the thesis on this machine sits several levels inside one that
also holds coursework and scripts. A commit made here therefore lands next to
whatever its owner had half-finished at the moment they accepted a typo fix.

**So it commits by PATH, and never the index.** Every invocation ends in
`-- :(literal,top)<a path inside the paper>`, which is git's "commit the contents
of these paths" mode: the commit is built from HEAD plus the working-tree state
of the named paths, and what is staged anywhere else is not consulted and not
recorded. Measured against a repository with an unrelated file staged — the
commit held one file, and `git status` afterwards still showed the unrelated file
staged and uncommitted, exactly as it was. `:(literal,…)` turns off pathspec
globbing so a directory with a `*` in its name is a directory; `:(top)` makes the
path relative to the repository root rather than to the working directory.

`git add` runs first with the same pathspec, because a paper that has never been
committed is untracked and pathspec-mode commit refuses an untracked path. It is
never `git add -A`, never `git add .`, and never a path this module did not
compute itself from the epic and the project.

**An accept commits the one file it names**; Save commits the paper's directory.
The narrower scope on accept is not caution for its own sake: a commit scoped to
the whole paper would sweep in a chapter the author had been editing beside this
page, under a subject saying a suggestion was accepted. That is still the paper
and still not somebody else's work — it is the wrong sentence about it, in the
history somebody will read to find out when a change was made. What cannot be
separated out is another uncommitted change in the SAME file, because a per-path
commit has no finer grain than a path, and Save is where the rest belongs.

**And it never pushes, branches, amends, resets, stashes or tags.** "The current
branch" means whatever branch is checked out. There is no code in `git.ts` that
could change which one that is, and none that reads or writes a second
repository — `GIT_DIR` and `GIT_WORK_TREE` are stripped from the environment
before every invocation, because this process is usually started from inside a
repository of its own and an inherited `GIT_DIR` is the one way a command here
could point somewhere else.

#### It refuses rather than guesses, and the edit is never lost

The bytes are on disk before any of this runs. `writeRange` renames the new file
over the old one and returns; only then is a commit attempted, so a refusal is a
sentence over a paper that is already correct. That ordering is the whole of the
safety, and it is why the commit is not attempted first with the write made
conditional on it.

| When | What it says |
| ---- | ------------ |
| HEAD is detached | This repository is not on a branch — HEAD is detached at `abc1234`. Check out a branch and this will be committed to it. |
| A merge, rebase, cherry-pick, revert or bisect is in progress | A merge is in progress in this repository. Finish it or abort it, and this will be committed. |
| `user.name` or `user.email` is unset | This repository has no `user.email` set, so git cannot record who made the change. Set it — `git -C … config user.email you@example.com` — and this will be committed. |
| The paper is in a `.gitignore` | `…/.kehikot/paper/thesis` is ignored by git in this repository, so changes to this paper cannot be committed. A `.gitignore` rule covers it — the usual one is `.kehikot/`. |
| There is no repository at all | Nothing. The Save button is not drawn and no sentence appears. |

The last row is a state and not a refusal, and the difference is what a reader
sees. A paper in a plain folder is a perfectly ordinary way to use this module —
it was the only way until commits existed — and a page that answered every
accepted suggestion with "this could not be committed" would be reporting the
absence of a feature as a failure, once per typo, forever.

The identity check is deliberately for a CONFIGURED identity. Git will invent
`someone@their-laptop.local` from the login name and the hostname when
`user.email` is unset, and a commit in somebody's thesis attributed to an address
that does not exist is worse than no commit.

Hooks are the repository's own and are not bypassed. There is no `--no-verify`: a
repository with a `pre-commit` hook has one because its owner wanted one. The
cost is that a hook which fails takes the commit with it, reported with the
hook's own message over a paper that is already correct on disk. Signing is the
same — if `commit.gpgsign` is set this signs, and a signature that cannot be made
is a refusal rather than an unsigned commit slipped past a policy.

#### What the commits say, and who they say made the change

The AUTHOR is the person, by not being set at all: git uses the repository's own
`user.name` and `user.email`, which is why those being unset is a refusal rather
than something to work around. That is the honest reading of what happened. An
agent WROTE the words and could not put them in the file — the whole point of
`propose_edit` not writing — and the thing that changed the repository was a
person deciding to.

`--author` naming the agent was considered and refused: it attributes a decision
the agent is deliberately unable to make, and it would put a fabricated address
in somebody's history, since `by` is free text an agent chose for itself and is
trusted for nothing. The proposer is a TRAILER instead, and `Proposed-by:` rather
than `Co-authored-by:` — the latter is parsed by git and by forges, which expect
`Name <email>` and attach the commit to whatever account that address belongs to.
Handing that mechanism a name an agent made up is how somebody else's face ends
up on a commit they never saw.

```
Accept a suggested change in main.tex

A misspelling in the first claim.

Proposed-by: an agent
```

The `why` sentence is the body, because that is where a reader of the history
looks for the reason. `Proposed-by:` says `an agent` today and not more, because
`propose_edit` takes no argument for who is proposing and this module genuinely
does not know which agent on a canvas made a suggestion — the trailer says what
is known. The cleanup is `--cleanup=whitespace` and not git's default `strip`,
which deletes every line beginning with `#`: an agent talking about section
numbering writes one, and it would silently become an empty commit body.

Save's message says what a person did and claims nothing about where the changes
came from, because some of them may have been typed in a real editor with the
file open beside this page:

```
Save the thesis paper

Changed since the last commit:

  .kehikot/paper/thesis/main.tex
  .kehikot/paper/thesis/chapters/2_bridge.tex
```

One changed file makes it `Save main.tex` with no body.

#### The controls are shadcn, including the ticks

Edit and Auto used to be `<input type="checkbox">` with `accent-color` set, which
draws the operating system's widget with one colour changed — so the two controls
that decide whether this page may change somebody's thesis were the only things
in the chrome row that did not belong to the canvas they sit on. The box, the
tick, the focus ring, the dark treatment and the disabled state were all the
browser's opinion, and `accent-color` is the entire extent of what a stylesheet
may say about them.

They are `components/ui/checkbox.tsx` now — shadcn's, on `@radix-ui/react-checkbox`
— paired with `components/ui/label.tsx`, which is there because a Radix checkbox
is a `<button role="checkbox">` and a native `<label>` does not forward a press
to one. One thing was changed from upstream, and it is the same thing
`button.tsx` changed: a `container` size, because upstream's `size-4` is a
quarter of the height of the chrome row in a container 220 pixels wide.
`Accept all` and `Save` are `Button`.

None of the three uses a container query, and that is worth saying because the
proposal card cannot: the card portals out of `@container container`, so a
`@sm/container:` rule inside it has nothing to ask. The chrome row is in the
ordinary tree and a container query would work there — it simply is not needed,
because the row already wraps.

Measured in a headless Chrome at 220 and at 900, both light: the row is one line
at 900 and two at 220, with no horizontal scroll at either; `Save 1` draws filled
and `Save` draws outlined. What was NOT measured is the framed case, the dark
theme, and how the three controls read to a person.

## What it does not do, on purpose

**It writes four things and no others.** The program this was extracted from was a
workbench: a `POST /api/edits` that rewrote the author's thesis, a SQLite work
queue, a margin-notice thread, and an MCP surface of eleven tools, seven of which
mutated. Four doors here write — `POST /api/paper`, which starts a paper where
there is none and refuses if anything is already there, `POST /api/edit`, which
replaces one byte range in one file the paper itself names,
`POST /api/proposal`, which accepts or rejects a change somebody has suggested,
and `POST /api/save`, which writes no bytes at all and commits the ones already
on disk. The third is a decision rather than a new way of writing: accepting one
goes through the same `writeRange` as a typed correction, with the same hash
check and the same refusals. There is still no create, no delete, no rename, no
move, no undo table and no queue.

**One tool on the MCP door is not a read, and it writes nothing.** `propose_edit`
puts a change in front of the person reading the paper. It touches no `.tex`: the
paper is unchanged until somebody presses Accept, and Accept is an HTTP POST
carrying this process's ticket, which the MCP door neither emits nor can be asked
for. For markup, a citation, a heading or the structure of a document there is
still no tool at all, and there should not be — an agent changing those should be
editing the `.tex` with the tools it already has, in a repository with a history.

That is not only scope. The old program had `app.use(cors())` — no options, wide
open — in front of its write path, so any page in any tab could read the origin
and post to it. The lesson taken from that is not "be careful with the write
path"; it is **do not put a permissive header on an origin that answers anything
you care about.** So:

- `manifest.ts` declares `storage: true`, which makes a host frame this page
  with `allow-same-origin`. With a real origin, this page's own `/api` calls are
  ordinary same-origin requests and no CORS is involved at all. That was a
  convenience for the reads; it is load-bearing for the writes.
- `vite.config.ts` has **no `server.cors`**, and must not grow one. Measured:
  `curl -H 'Origin: https://evil.example' http://127.0.0.1:7870/app` comes back
  with no `Access-Control-Allow-Origin` at all.
- There is a ticket now, and it is exactly what this section used to say a write
  path would need: minted per process, printed into the page, demanded by both
  writers in the body. It separates "this app's own page" from "something else
  on this machine that guessed the port", and it separates nothing else — it is
  not an authorization check, and anything that can read the page can read it,
  which is why the two bullets above are the ones holding it up. The essay is at
  the top of `doors.ts`.

### Anchors move, and this module does not move them

An edit shifts every byte offset after it by the change in length. Passages
published to the canvas and notes held in other modules are absolute byte ranges
into these files, so an anchor **below** an edit point now names text a little
to the left or right of what it named, and an anchor **inside** the replaced
range names bytes that no longer exist as they were.

Nothing here migrates them, and this is the honest statement of that rather than
a plan. What the design does do is keep the damage as small as it can be: the
range written is narrowed to the characters that actually changed, so fixing one
letter shifts everything after it by zero or one byte and leaves every anchor in
the same paragraph inside a range that was never touched. A correction that
changes no lengths — a letter for a letter — moves nothing at all.

The two mitigations that are NOT claimed: nothing rewrites another module's
stored ranges, and nothing warns before an edit that an anchor sits in it.

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
| `/api/proposals?epic=…`           | the changes suggested about one paper that nobody has answered — a read, and ungated like the others |
| `/api/proposal` (POST)            | accept or reject one. Ticketed; accepting is `writeRange`, and then one commit |
| `/api/uncommitted?epic=…`         | whether this paper has anything to commit, and whether a commit here would work — a read, ungated |
| `/api/save` (POST)                | commit what has changed under the paper. Ticketed; writes no bytes |
| `/mcp`                            | `list_papers`, `read_paper`, `read_source`, `propose_edit`, `list_proposals` |

All of it is middleware in front of the one Vite server. A module is one origin
or it is nothing — and two ports is exactly where the wide-open `cors()` in the
program this replaces came from.

## Layout

```
manifest.ts     what a host reads, and the essays on storage and the protocol
doors.ts        every door but the page, as one function with no socket
store.ts        the papers directory, the two fences, \include folded in
proposals.ts    the suggestions nobody has answered, and why they live in memory
git.ts          the paper's own history: one commit per accepted change, and
                every reason this refuses to make one
latex/parse.ts  LaTeX -> source-mapped blocks (carried over; see its own header)
latex/edit.ts   a typed change -> a byte range, and a byte range -> a place on screen
latex/propose.ts a quoted sentence -> a proposal, and what an applied edit does to one
latex/diff.ts   the picture of a change, in tokens rather than characters
page/           the document shell, and nothing drawn in it
src/
  main.tsx         mounts React, seeds the theme, imports the mailbox for effect
  app.tsx          the screens and the goto answer
  use-paper.ts     the ONE place the wire and the papers meet
  use-selection.ts what is highlighted, and the open question about publishing it
  remembered.ts    the one preference this page keeps, and where it keeps it
  index.css        the theme, the dark variant, the sheet, the scroll column
  reader/          pages.ts (the A4 page box and pure pagination),
                   paginated.tsx (the scrolling column and the sections),
                   blocks.tsx (the gutter), segments.tsx, proposed.tsx, ask.tsx
  lib/             selection.ts (a highlight -> a source range), utils.ts
  components/ui    shadcn's button, badge, button group, checkbox, label,
                   popover and sidebar
wire/           the mailbox and the bridge, copied from References and Journeys
test/           parse, store, doors, wire, reader, proposals, git, saving — 386 tests,
                no browser needed
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
