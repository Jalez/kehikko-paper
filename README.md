# Paper

The paper an epic is aimed at: its LaTeX source in an editor, and beside it the
PDF a real engine compiles it to.

An app: a page, a store over a project's `.tex` files, a build queue and an MCP
door. A host may frame it and then it follows whichever epic the canvas is on —
but nothing here needs one. Open
`http://127.0.0.1:7870/app?project=/path/to/project&epic=thesis` and the whole
thing is there, working on that one paper on this machine.

```bash
./run.sh                # 7870, and there is nothing to configure
bun run register        # tell a host on this machine where this answers
bun test
bun run typecheck
```

It shows **the paper for the epic the canvas is on, and nothing else**: no list
of other papers, no rail. The container's header already carries this module's
name and the canvas already says which epic it is on.

## What it is, and what it replaced

The left pane is the `.tex` file itself. The right pane is that file compiled
the way LaTeX compiles it — figures, tables, references, and whatever document
class the paper declares — so what is on screen is what will be submitted.
Between them:

- **A save reaches the disk and the PDF follows.** Typing pauses, the file is
  saved, the paper is compiled, the new PDF replaces the old one in place.
- **A selection in the source shows where it came out** in the PDF, and
  **a press on the PDF goes to the line it came from**.
- **An engine's complaint is a line to press.** A compile that fails shows the
  error with its file and line, and the last PDF that compiled stays on screen.
- **A change an agent suggests is a diff** of the `.tex`, which a person accepts
  or rejects.

Until version 2 this module parsed LaTeX itself and drew it as prose, and
editing meant typing into that prose. It could not show a figure, a table or a
document class it had not been taught, and mapping a change in rendered words
back onto source was exact for plain text and refused for everything else. That
reader and its in-prose editing are gone. **The parser is not**: `latex/parse.ts`
still reads every paper, because the section list other modules depend on — and
`read_paper`, `list_sections` on the MCP door — come from it. It no longer draws
anything.

There is no read-only fallback view for a machine with no engine. Without one
the source is still edited and saved, the PDF pane offers to install one (see
"The managed compiler"), and that is all: a second, approximate rendering of the paper is the
thing this version removed.

## Where the papers come from

**The open project.** A paper is a folder with a `main.tex` in it, at
`<project>/.kehikot/paper/<epic>/`, named for the epic it belongs to. That is
the whole rule, found with the protocol's `moduleDir` like every other module's
material. A thesis is not a special case: it is one paper in that folder, with
its `chapters/`, `figures/`, `.cls` and `references.bib` beside it.

| Where                                        | Means                                              |
| -------------------------------------------- | -------------------------------------------------- |
| `<project>/.kehikot/paper/<epic>/main.tex`   | a paper. The only place one is looked for          |
| `PORT`                                       | 7870 by default                                    |
| `KEHIKOT_ORIGINS`                            | who may frame this page; every local host origin by default |

Nothing is cached: a file is opened on every read. Every door takes a project
and none of them defaults one. The confinement root is the **paper's** folder,
not the project's, so one paper's `\input` cannot reach into the next one's —
see `confine` in `store.ts`.

A paper is `main.tex` plus every file it `\input`s, `\include`s or `\subfile`s,
followed to any depth (it was one level before version 2), with a file that
includes itself read once. A target is resolved against the paper's folder, as
TeX does. An `\input` in the middle of a paragraph is not seen by the parser;
put it on its own line.

`\IfFileExists{f}{…}{…}` at the start of a line is resolved the way the engine
resolves it: the true branch is read when `f` (or `f.tex`) is in the paper's
folder, the false branch when it is not. So a part pulled in with
`\IfFileExists{generated/t}{\input{generated/t}}{}` is a file of the paper
exactly when it is on disk.

There is one walk of the includes (`walk` in `store.ts`), and the file list,
the section list, `read_paper`, the hashes the page polls and the count
`list_papers` reports all come from it, so none of them can name a different
set of files from another.

## The editor

CodeMirror 6, through `@uiw/react-codemirror` — the same editor, wrapper and
keys as the Slides module beside this one. It was chosen over a `<textarea>`
(no highlighting, and no way to mark a range that is not the selection) and
over Monaco (megabytes, no LaTeX grammar of its own, built for a window rather
than a panel 280 pixels wide). LaTeX highlighting is CodeMirror's `stex` mode:
a tokenizer that colours commands, braces, maths and comments. It does not
understand the document; the engine does, and its verdict is drawn on the lines
it names.

**Saving.** A pause in typing saves, and so does ⌘S. A save sends the whole
file and the SHA-256 of the file as the editor last read it. The server writes
to a temporary beside the file and renames it over — the whole new file or the
whole old one, never part of either — and writes **nothing** if the file on
disk no longer hashes to what the editor read.

**A file that moved on disk.** Somebody saved from another editor, an agent
rewrote a paragraph, `git checkout` changed branch. If nothing has been typed
here since the last save, the disk's text is taken at once. If something has,
nothing is touched and a person chooses: *Take the disk's*, or *Keep mine*.

**Line endings.** The editor holds `\n`. A file that used `\r\n` gets it back
on save, and byte offsets account for it. A file that mixes the two is saved
with whichever it had first; that normalisation happens on its first save.

## The compiled PDF

**An engine, found on this machine.** `compile/engine.ts` looks for
`tectonic`, `latexmk`, `pdflatex`, `xelatex` and `lualatex` on `PATH`, where
Homebrew and MacTeX install (`/opt/homebrew/bin`, `/usr/local/bin`,
`/Library/TeX/texbin`, `/usr/bin`), and where a TeX Live installs when nothing
has put it on `PATH` — `/usr/local/texlive/<year>/bin/<platform>` and
`/opt/texlive/<year>/bin/<platform>`, newest year first — because an app started
from the Dock does not inherit a terminal's `PATH`. When there is none, the PDF
pane offers to fetch one: see "The managed compiler" below.

**Which one, when there are several.** In this order:

1. The engine the paper names (next paragraph).
2. The person's own Tectonic — unless the paper's bibliography is biber's
   (`biblatex` without `backend=bibtex`) and there is a `latexmk`, which then
   goes first: a TeX Live ships biber and biblatex as a matched pair, and a
   Tectonic uses whichever biber the machine happens to have.
3. `latexmk`, which is a TeX Live. Found, it is used ahead of anything this
   module fetched.
4. The Tectonic this module fetched.
5. `pdflatex`, `xelatex`, `lualatex`, bare.

**A paper can name its engine**, in the paper: `% !TEX program = xelatex` in
the first lines of `main.tex` — the magic comment TeXShop, TeXstudio and VS
Code's LaTeX Workshop already read. If that engine is not installed the page
says so rather than using another.

**A `.tex` file is a program, and it is somebody else's.** Every engine is
spawned from an argument array — there is no shell anywhere — with shell escape
explicitly off, a closed stdin, a three-minute timeout, a cap on how much
output is kept, and an environment holding `HOME`, `PATH` and little else.
Tectonic runs `--untrusted` (and `--keep-intermediates`, into its output
folder: see "A picked part, compiled on its own"); `latexmk` runs `-norc`,
since a `.latexmkrc` is Perl. Engines run in a process group of their own so that stopping one stops
what it started.

**The engines read only the paper, the build folder and the TeX
installation** (`compile/confine.ts`). On macOS every engine — and whatever it
starts: `biber`, `makeindex`, the font generators — runs under a
`sandbox-exec` profile; on Linux under `bwrap` where there is one. Readable:
the paper's folder and the project it is in (a paper draws figures and tables
from elsewhere in its own repository; not the project's `.git` folders or
`.env` files), the build folder, the TeX installation with the person's own
TeX trees, system and personal fonts, and the system's libraries. Writable: the
build folder and this module's cache for the engines in the temporary
directory, where generated fonts, LuaTeX's font cache and an unpacked biber go
— not the paper, and not the person's TeX trees. No network, except Tectonic's
one run that may fetch a package. So a paper that draws on a file OUTSIDE its
project — a figure linked in from another folder — does not compile until the
file is copied in, and the problems list says which file. Where a machine has
nothing to confine an engine with, the engine runs as it did before and the
status line's tooltip says "Not confined".

**One compile at a time per paper, and the latest save wins.** A newer request
kills the compile in flight — by the pid of the child this process spawned,
never by name — and starts again.

**Tectonic is asked cached-first.** Its first run uses `--only-cached`, which
skips a network round trip on every compile; only when that fails for want of a
file is it run again allowed to fetch. A paper's first compile on a machine may
therefore take as long as downloading its packages does.

**The bare engines** (`pdflatex`, `xelatex`, `lualatex`) are run twice and do
not run BibTeX or biber; a bibliography wants `latexmk` or Tectonic. The TeX
Live argument lists — `latexmk`'s included — are pinned by tests and have
**not** been run against real binaries: the machine this was written on has
only Tectonic.

**Class and style files beside `main.tex` are found**, as are files in
subfolders that the paper names with their folder (`\input{chapters/a}`,
`\usepackage{style/shout}`). A `.sty` in a subfolder named WITHOUT its folder
is not found, because an extra search path is one of the things `--untrusted`
turns off, and safe is the default worth keeping.

### The managed compiler

A person should not have to install a TeX distribution to see their PDF. When
no engine is found, the PDF pane says what a compiler is and offers one button,
**Install the compiler**, with what it will download, how much, from where and
into which folder written under it. Nothing is downloaded until that button is
pressed: opening a paper fetches nothing.

**What is downloaded** — and it is all in `compile/toolchain.ts`, as literals:

| Piece | Version | From | Size (macOS, Apple silicon) |
| --- | --- | --- | --- |
| Tectonic | 0.17.0 | `github.com/tectonic-typesetting/tectonic` releases | 21.7 MB |
| biber | 2.17 | `downloads.sourceforge.net/project/biblatex-biber` | 89.4 MB |

About 111 MB, against several gigabytes for a TeX Live. Tectonic is one file
and fetches the LaTeX packages a paper uses the first time it compiles it, into
its own cache. biber is the bibliography tool `biblatex` needs, and it has to be
the release that matches the `biblatex` in Tectonic's bundle: that is 3.17, so
biber 2.17. There are rows for macOS (Apple silicon and Intel), Linux x86-64,
and Linux ARM64 (Tectonic only — the biber project published no 2.17 for it).
Windows has rows and is not offered, because the rest of this module's engine
code is POSIX.

**The same button for the biber alone.** A machine that has Tectonic and a
biber of another release — Homebrew's, say — fails a `biblatex` paper with
biber's refusal, and one with no biber at all fails it with "No such file". The pane then offers to install biber 2.17, which Tectonic is
given ahead of the machine's own, in place of advice to install it by hand.

**How it is fetched** (`compile/install.ts`). Only the address in the table is
asked, and a redirect is followed only to a host the row names
(`release-assets.githubusercontent.com`; `*.dl.sourceforge.net`). The download
must be exactly the pinned length and SHA-256, or it is deleted before anything
is unpacked. Then the ONE file wanted is read out of the archive by this module
— no `tar`, no shell, and no path from an archive is ever a path on disk — made
executable, and renamed into place. One install at a time; Cancel keeps what
arrived and the next press asks for the rest; the checksum is of the whole file
either way. There is no "latest" anywhere: installing a different version is a
change to the table.

**Where the checksums came from.** Tectonic's are the SHA-256 digests GitHub
reports for each release asset. biber's project publishes only SHA-1 (through
SourceForge), so each archive was downloaded, its SHA-1 compared with the
published one, and the SHA-256 computed from those bytes — which guards every
later download against the file changing, and rests on that first download for
the rest. `toolchain.ts` says so beside the table.

**Where it is kept: `<tmpdir>/kehikot-paper-tools/`**, shared by every project
(`tectonic-0.17.0/tectonic`, `biber-2.17/biber`), or wherever
`KEHIKOT_PAPER_TOOLS_DIR` points. Not under any project's `.kehikot/` — a
compiler is the machine's — and not under the home directory, which the
workspace's storage rule keeps modules out of. The temporary directory is the
one machine-level place that rule allows a module, and it is not the right
one: the system may clear it (macOS removes what has not been used for a few
days, Linux empties it on reboot), after which the button is back and the
download is made again. The proper home is a machine-level directory the
protocol hands a module; `toolsDir()` in `install.ts` is the one line that
would change. The folder is created for the current user alone and nothing is
run out of it unless it still is.

**To remove it**, delete that folder — the pane shows its path, and
`node -p "require('os').tmpdir()"` prints the first half. Tectonic's package
cache is separate and its own (`~/Library/Caches/Tectonic` on a Mac,
`~/.cache/Tectonic` on Linux); biber unpacks itself into a `par-…` folder in
the temporary directory on first run.

**Who can start a download.** A person pressing the button, and nothing else:
`POST /api/toolchain/install` needs the page's ticket like every write here,
takes no address, version or path — only which pieces — and there is no MCP
tool for it.

**One thing to expect.** A paper's first compile with a fresh Tectonic
downloads its packages one by one, and for a long document that can outlast
the three-minute limit on a compile (a 61-page thesis took 3 min 18 s here).
What was fetched is kept, the page says so, and the next compile finishes.

### Where the build goes

**The operating system's temporary directory**: `<tmpdir>/kehikot-paper/<hash
of the paper's real path>/`, holding `work/` (the engine's output directory,
emptied before each run), `good/` (the PDF, SyncTeX file and a small
`meta.json` from the last run that produced a PDF, and under `good/aux/` what
that run wrote for the next one to read: every `.aux`, the `.bbl`, the `.toc`)
and `parts/` (one folder per picked selection compiled on its own — see "A
picked part, compiled on its own").

Not beside the paper, and not elsewhere under `.kehikot/`: a build is derived —
losing it costs one compile — it is per machine, and the paper's folder may be
committed, where an `.aux`, a `.log` and a PDF would be in every `git status`
and every commit this module offers to make. No engine is ever given the
paper's folder as its output directory. The cost is that a reboot forgets the
last good PDF and the page compiles on the next open. Tectonic's own package
cache is its own, under the user's cache directory.

## Between the source and the PDF

Through **SyncTeX**, which the engine writes and `compile/synctex.ts` reads —
there is no `synctex` binary on a machine with only Tectonic, the format is
text behind gzip, and it is parsed here.

SyncTeX records boxes and the glue between words, with the source **line** each
was read on. It does not record glyphs and it has no columns. So:

- **PDF to source** is exact to the source line under the click. A press selects the
  word in the source and marks it on the page pressed; the PDF tab stays in
  front, and a double press turns to the Source tab. Finer than the line is
  done by reading the page (`src/pdf/words.ts`): the word under the press is
  looked for on the line SyncTeX named, and selected.
- **Source to PDF is not SyncTeX's answer at all: the passage is looked for in
  the PDF's own text** (`src/pdf/find.ts`). The source is turned into the
  letters it prints (`src/pdf/printed.ts`) — markup dropped, an `\emph{x}` as
  `x`, and a gap wherever it prints something that cannot be spelled: a
  citation, a reference, maths, a command nobody has heard of — and those
  letters are found on the page, across line breaks and hyphens, over the foot
  of one page and the running head of the next, round a float, down one column
  of two. The mark is drawn round the characters that were found, so it begins
  on the passage's first letter and ends on its last, whatever SyncTeX's
  rectangle for those source lines did.
- **SyncTeX is the hint, the tie-breaker and the fallback.** Its rectangles say
  which pages to read first. When the same words are printed twice, the ones
  beside its rectangles are meant. And when the words are not found — the
  passage is a figure, a display, a comment; or the PDF is older than the
  text — what is drawn is the printed lines SyncTeX named, WHOLE and a shade
  lighter: "about here", as Overleaf draws it, and never a tight mark in a
  guessed place.
- **A line being typed on keeps its mark.** The PDF does not have the new
  letters, so the whole passage is not there to be found; the longest
  beginning and the longest ending that are, with a little of what stands
  before and after it, still pin it between them.
- **Where a letter is on the page** is measured, not estimated. pdf.js gives a
  printed line as a string and a width; a line a mark is drawn on is measured
  in the font it is printed in (`offsetsOf` in `src/pdf/pdf-view.tsx`), with
  what is left of its width shared among its spaces, as TeX shared it. When a
  line cannot be measured an edge is found by proportion along it.
- **What it costs.** A page's text is one question to pdf.js, asked once per
  compiled PDF and only for the pages beside where SyncTeX pointed; the whole
  PDF is read only when a passage is not found there. On a 61-page thesis in
  WebKit that is about a millisecond a page — 0.11 s for all 61 — and looking
  for a passage in what was read is under a millisecond (two, across the whole
  PDF, for one that is not there). Measuring a page's letters is the slow part,
  as it always was, and is only done for the pages a mark is drawn on.

Measured on that thesis (pdfLaTeX through latexmk), in WebKit, by pointing at
every passage as a neighbour does and reading back — with Ghostscript, not
pdf.js — the characters that lie under the mark drawn. Of the 180 real passages
the project's slides, questions and notes point at that print anything, the mark
covered the passage's letters and nothing else, within two letters, for 180; of
801 more nobody had tuned anything on — every other sentence of every chapter,
short runs of words, whole paragraphs; 96 with citations, 163 with maths or
commands, 25 across a page break, 20 in tables and captions — for 801. The
method this replaced, which narrowed SyncTeX's rectangles to the passage's
first and last words, scored 177 and 746 on the same passages. Median time
from the pointing to a settled mark: 85 ms, as before.

What it does not do: a fixed-pitch listing is measured by proportion, and the
end of a mark in one can be a letter short; a passage that is only a figure,
or prints nothing — a comment, a `\label`, an `\input` — is the lines SyncTeX
named; and a passage whose words are printed more than once with the same
words round them, away from where SyncTeX points, is those lines too.

For PDF to source, measured on a 20-page paper (661 prose lines, 1,177 words clicked), with

Tectonic: every source line's rectangles were on the printed lines holding its
words; 91% covered both its first and last word within one character's slop; a
click landed on the word's own source line 97.4% of the time, on the adjacent
line 2.2%, and elsewhere 0.4%; 95% of clicks were then placed on the exact word.

Where it is coarser, and why:

- **Text inside a macro argument that spans lines** — an `\emph{…}` wrapped
  over two source lines — is attributed by TeX to the line the argument ENDS
  on. That is most of the "adjacent line" clicks; the word match usually
  recovers the right line.
- **Maths** is one lump: inline maths answers with its line, and nothing inside
  a formula is told apart. A passage with maths IN it is marked from the words
  before to the words after; a passage that is ONLY maths is its printed lines.
- **Floats** answer from where they landed. A caption goes to its line; the
  image itself and the cells of a table go to the line of the environment or
  nearby.
- **What a macro typeset** — the title block, a table of contents, a
  bibliography printed from a `.bbl` — answers with the line of the command
  that called it (`\maketitle`), or not at all when it came from the class.
- **A caret on a line that printed nothing** — a comment, a `\label` — draws
  nothing until the PDF is asked for by name (View → PDF, or Run → *Show this
  line in the PDF*), which goes to the nearest line that
  did.

The table also yields, per file of the paper, which pages it reached and with
which lines (`pageMap`). The page uses it to say which page the caret is on,
and to show only the pages of the parts a person picked — the next section.

Every build has a table of its own, and a mark is asked of the one whose PDF
is on screen. A rectangle answered about the whole paper is not drawn on a
part's own PDF, or the other way round, for the moment it takes to ask again.

## Narrowed to the picked parts of the epic

An epic can be divided into parts, and a person can point the whole canvas at
some of them in the host's bar. A part belongs to the epic and names no module:
the host keeps the list, and each part has `documents` — project-relative
paths, `.kehikot/paper/<epic>/chapters/design.tex` — which the host unions from
what every module publishes for it (protocol 1.2.0). A host older than that
sends the paper-relative `files` instead (`chapters/design.tex`), and this
module is narrowed the same by either.

**One rule, and it is the protocol's.** Every file of the paper says what ties
it to a part with one function, `anchorOf` in `src/focus.ts` — its own
project-relative name, and that of every file that pulls it in short of
`main.tex`, so a chapter's tables come with the chapter — and
`useFocus(context).narrow(files, anchorOf, { noun: 'page', keep })` decides.
`keep` is the file in hand: the one the editor is on. A sheet of the PDF is an
item too, about the files that printed on it, and a sheet a mark is on is kept.
`main.tex` is a file like the others: in a part only when a part lists it, so
the title page and the bibliography it prints are not drawn under a pick.

### Which chapter is a part's

This module's to keep: `<project>/.kehikot/paper/chapters.json`, `part id →
file`, one chapter to a part and a chapter in at most one part (`chapters.ts`).
What it PUBLISHES from that is the protocol's `parts.json` beside it — for each
part the chapter and every file the chapter pulls in — written with
`writeHoldings` after every change to the record or to the paper, and the
canvas is then told (`content.changed`). The record is the decision; the
publication is derived, and can be made again.

- **Reading never writes.** For an epic the record says nothing about, a
  part's chapter is what the parts the host sends already say, and the page is
  narrowed by exactly those. The first time a person SETS a chapter, the whole
  of what the parts said is kept with the one change: adopted once, on a
  deliberate act, so every part keeps the chapter it had.
- **Where it is set.** In the line over the editor, for a file `main.tex`
  pulls in: "Editing `chapters/3_methods.tex` · Saved · *chapter of Methods ▾*".
  No row of its own.
- **A press never quietly takes a chapter from another part.** One chapter to
  a part, so giving a file to a part that already has a chapter does something
  with that one. If the file was another part's chapter the two swap, and
  pressing the old part again restores the record exactly. If the file was no
  part's, the other chapter is left with none — and the option says which
  before it is pressed: "Results · swaps with 4_results.tex", "Results · no
  part for 4_results.tex". Afterwards the page's one line says what else
  moved ("3_methods.tex is now the chapter of Results, and 4_results.tex of
  Methods."), for twelve seconds; a press that moved nothing else says nothing.
- **A part for each chapter.** For an epic with a paper and no parts, the same
  line offers it: one press asks the host for a part to each chapter
  (`parts.set`, under `parts:set`), named by the chapter's first heading, and
  files each chapter under the id the host made.
- **Only on a host that keeps the parts.** The host is asked about an id no
  part of the epic has, which changes nothing (it answers `no-such-part`); one
  that answers `unknown-method`, or declines, is shown neither control. Asked
  once a page load at most, and not at all once this host has said yes in
  this tab (`sessionStorage`, under the host's origin).
- A host goes on unioning what an epic's record said for a part before it kept
  the list. A chapter taken FROM such a part here is taken out of what this
  module publishes, and stays in the part for as long as that record lists it.

**This page has no chapter picker of its own.** It used to have a dropdown of
the paper's files, and under a focus that was a second, private place to choose
a chapter that had already been ticked in the host's bar. It is gone. What is
shown follows the ticks (`fileAfterTicks` and `tabsOf` in `src/focus.ts`):

- **Nothing ticked** is the whole paper: every page of the PDF, and `main.tex`
  in the editor. Every file is still one step away by the two ways that are
  about the paper rather than about a list of its files — a press on the PDF
  opens the file that printed that spot, at that line, and the section list is
  grouped by file, with an entry for a file that has no heading (an abstract, a
  file of tables). When either has taken the editor out of `main.tex`, a small
  `← main.tex` beside the file's name goes back.
- **One part ticked** opens that part's file in the editor, and the PDF shows
  its pages.
- **Several ticked** are tabs above the editor — of those parts' files and no
  others — and the PDF shows the pages of all of them.

**The line over the editor names the file an edit is saved to** — "Editing
`chapters/3_methods.tex` · Saved" — because the editor now changes file when a
tick changes, and nothing else on the page says which file is open.

With some picked (`reacts: ['parts']`):

- **The section list** holds only the files a picked part has, and the file in
  hand; **the tabs** are the picked parts' chapters (a table a chapter pulls in
  is reached by the section list, and has a tab only while it is open).
- **The PDF** is those files compiled on their own, when `main.tex` pulls
  them in with `\include` — the next section. Only the sheets they printed are
  drawn, read off the page map. Every sheet carries its number IN THE PAPER
  (`p. 7 of 20`), because other modules store page numbers and page 7 must
  stay page 7. Nothing is drawn where sheets were left out: no rule, no count.
- **Nothing about the pick while anything is shown.** No line, no "outside"
  on a tab, a sheet or a section group, no "shown anyway". The host's bar says
  which parts are picked, and the narrowed pages and files are the message. There is no "show everything" on this page; the
  focus is lifted where it was set.

The one sentence, and where: when the pick leaves the PDF pane with no page to
draw, the pane says so — inside itself, where there is nothing else (`noPage`
in `src/focus.ts`):

- the protocol's own (`emptySaid`, `narrow(...).empty`) — `No page is in the
  picked part.` — for a part with no chapter, and for files that printed
  nothing;
- they name only files the paper does not include — `No page of this paper is
  in the picked part: it names chapters/desing.tex, which main.tex does not
  include.`
- a file of theirs is pulled in with `\input` — `No page is shown for the
  picked part: main.tex pulls chapters/rule.tex in with \input, and only a
  file pulled in with \include can be compiled on its own.`

Three decisions that are this module's own:

- **A file with unsaved text in it is never taken away by a change of focus.**
  The editor follows the ticks, except out from under somebody typing: a file
  whose text has not reached the disk stays open and editable, and is saved as
  it always is. It is the file in hand, which the rule keeps: the last tab,
  a tab like the others, and the tab of a file in the focus is the way back. It leaves when
  the person leaves it. (Nothing typed is lost either way — every file's text
  is kept and saved whichever is on screen.) A file that is already in the new
  focus is left open too: ticking a second part must not move the reader.
- **A pointer from another module still arrives.** A note or a slide pointing
  at a passage in a file no picked part has is opened and marked as
  before — it is then the file in hand — and the WHOLE PAPER
  is shown at that place for as long as the mark is up; the part's own PDF
  comes back when it is taken down. (A paper narrowed by its pages only — see
  the end of the next section — draws that one page among the picked ones.)
- **A change of focus re-reads nothing of the paper.** `context.parts` is
  carried beside the paper, not into it: no `/api/paper` and no compile. The
  one read is the source of the file the editor moves to, the first time it is
  opened.

Not narrowed, on purpose:

- **The passage this page publishes.** `passage.set` is the same in every
  field. (What it says it is SHOWING does follow the ticks — see "What other
  modules are told".)
- **The MCP door.** `list_papers`, `list_sections`, `read_paper` and
  `read_source` answer about the whole paper whatever is picked. An agent has
  no canvas and no focus; narrowing its reading by what a person happens to be
  looking at would be a tool whose answer changes for a reason it cannot see.

Not done yet: a one-step "pull this paper's chapters in with `\include`"; and
a paper folder that is itself a symlink, whose files the protocol cannot place
in a part (they are counted outside a focus rather than guessed into one).

## A picked part, compiled on its own

Picking a part used to hide the pages of the whole paper its file had not
printed on. With chapters pulled in by `\input` those pages are mostly
somebody else's — the title and the introduction above the chapter, the next
chapter below it — and the pick read as having done nothing.

**It is done the LaTeX way.** A paper pulls its chapters in with `\include`,
and the engine is given `\includeonly{chapters/methods}` AHEAD of `main.tex`,
from outside it. LaTeX then typesets that chapter alone, with its real chapter,
section, figure and page numbers and every reference to another chapter
resolved, because each `\include`d file has an `.aux` of its own and the ones
left out are read from theirs. Nothing is generated and nothing is copied: the
source is the same whichever part is picked, and `main.tex` is never edited.

| Engine | How `\includeonly` is given from outside |
| --- | --- |
| `latexmk` | `-usepretex=\includeonly{…}`, and `-bibtex-`: the bibliography is the whole paper's, and a biber run over one part's citations would renumber it |
| `pdflatex`, `xelatex`, `lualatex` | `\includeonly{…}\input{main.tex}` in place of the file name, with `-jobname=main` |
| Tectonic | a two-line file saying the same, in a mirror of the paper's folder — below |

**What a paper has to do: `\include`, not `\input`.** `\includeonly` filters
the files `main.tex` pulls in with `\include` and nothing else. So:

- a picked file `main.tex` pulls in with `\include` is compiled on its own,
  and anything that file pulls in (its tables, a section in a file of its own)
  comes with it;
- a picked file pulled in with `\input` cannot be, and the pane says so in one
  sentence, in place of the pages, naming the file and who pulls it in. It does
  NOT fall back to the pages of the whole paper that file printed on: they look
  like the part and are mostly not it. One such file in a selection makes the
  whole selection one that cannot be shown — a part with a hole in it and
  nothing saying so would be worse;
- `\include` starts each chapter on a sheet of its own. That is the price, and
  it is the paper's to decide: this module never rewrites an `\input`.

The same sentence is said for `main.tex` itself, for a paper that has an
`\includeonly` of its own (the paper's overrules one given from outside), and
for a file whose name `\includeonly` cannot carry — a space, a comma.

**What is still on the part's PDF, and not drawn.** Whatever `main.tex` writes
in its own body — a title page, an abstract, the table of contents, the
bibliography — is typeset under `\includeonly` too. The page map leaves those
sheets out exactly as it leaves them out of the whole paper: only the sheets
the picked files (and what they pull in) printed are drawn.

**Sheets are not pages, and no sheet number leaves this module.** The methods
chapter alone is a PDF of 22 sheets; its ninth is page 19 of the paper. Other
modules store pages of the paper. So everything SAID about a place — the
label on a sheet, the runs left out, the toolbar's `p. 19/61`, the `page` of
`passage.set` — is the page of the paper, through `pageOfSheet` in
`src/focus.ts`, and everything asked about a place on screen (`/api/sync`,
`/api/pdf`) names the PDF that is on screen with `part=<key>`.

**Which build runs when.** The numbers of the chapters left out are those the
last FULL build saved. An edit that makes the picked chapter a page longer
shows at once in that chapter; that the next chapter now starts a page later
is not known until the whole paper is compiled again. So:

- **a save, with parts picked**, compiles the picked chapters only;
- **the whole paper** is compiled when the pick changes or is lifted and the
  paper is not of the text on disk — that is the person leaving the part —
  when *Compile* is pressed, when a passage outside the part calls the whole
  paper onto the screen, when there is no full build to read numbers from at
  all, and when the part's own log says a reference or citation could not be
  resolved from numbers older than the text (a `\cite` of a key the last full
  build never saw). There is no export in this module to compile before; a
  PDF taken out of the build folder is as old as the last of those;
- one queue for both kinds, so one paper has one engine running, and a newer
  request of either kind kills the one in flight.

**Kept, per selection.** A part's PDF lives in `parts/<key>/` beside the
whole paper's build — `<key>` a hash of what `\includeonly` was given — with
its own SyncTeX and its own record of which text and which full build's
numbers it was made from. The same again is not compiled again: coming back to
a selection is a read of a folder. Its output folder is not emptied between
runs either, so `latexmk` runs the engine once for an edit where a fresh folder
costs three passes. The last four selections used are kept per paper and
older ones removed; one that went is made again when asked for.

Measured on a 61-page thesis (`report`, seven `\include`d chapters, biber,
figures, pgfplots) with `latexmk`, and on a 13-page article with Tectonic:

| | thesis, `latexmk` | article, Tectonic |
| --- | --- | --- |
| the whole paper | 12.2 s | 2.1 s |
| a part, first time | 3.6–3.8 s | 1.8 s |
| a part, after an edit in it | 2.0–2.5 s | 1.8 s |
| a part come back to | 0.02 s | under 0.01 s |

**Tectonic reads only the folder it runs in**, and the `.aux` files may not be
put in the paper's. So for Tectonic the part is compiled in
`parts/<key>/tree/`: the paper's folder mirrored with links — every entry a
link to the paper's own, except the folders an `.aux` has to sit in, which are
real folders of links — with the last full build's intermediates and the
two-line file copied into the MIRROR. Tectonic is also run with
`--keep-intermediates` now, for every build, since it otherwise drops the
`.aux` files a part needs. It runs its own bibliography tool and cannot be told
not to: with BibTeX that is the whole paper's bibliography still (the chapters
left out keep their `\citation` lines), with biber it is the part's alone.

**While the part's own PDF is being made** — a few seconds, the first time a
selection is picked — the pane shows the pages those files printed in the
whole paper, which with `\include` are the same sheets, of the last full
build. It is never blank, and the part's PDF takes their place when it is
there. Each PDF keeps its own scroll: coming back to a selection lands where
it was left, and the whole paper where IT was.

**A paper read by a server that does not say how its files are pulled in** is
narrowed by its pages, as before this existed.

## What other modules are told

Two things. Where the reader is — `passage.set`, with
`{ path, page, from, to, quoted, section }`, its shape unchanged — and which
files are on screen, `showing.set` (below).

- `path` is the absolute path of the `.tex` file, `from`/`to` are byte offsets
  into it, `section` is the heading the caret is under with the title exactly
  as `list_sections` spells it. With nothing selected, `from`, `to` are null
  and `quoted` is empty.
- **`quoted` is now the selected SOURCE**, not rendered prose. It is the bytes
  of the file between `from` and `to`. Notes verifies an anchor by comparing
  the quote with the file's bytes, so a source quote verifies exactly where a
  rendered one across markup never did.
- **`page` is now a page of the compiled PDF**, or null when nothing has
  compiled. It was a page of this module's own estimated pagination. A note
  stored with an old estimated page number is filtered by a number that may no
  longer match under Notes' page scope; it still shows under its document and
  passage scopes.

`showing.set` says which FILES are on screen, since a passage names only the
one the caret is in: `{ refs: [], documents }`, each document a file's absolute
path with no page, range or quote. The file the editor is on is first, since a
list is read from its head, and the rest are in the paper's order. Nothing
ticked is every file of the paper; ticked parts are the files those parts own that the paper
includes, plus the open file when it is kept open outside them; ticked parts
that own no file of the paper are `[]`. It is said when the ticks, the open file or the
paper's file list change, never on a keystroke. The protocol carries sixteen
documents per container: a paper with more says the files some part of the epic
owns after the open one, in its own order, then as many of the rest as fit.

What arrives is one thing: the passage the canvas holds. A range in one of
this paper's files is opened, scrolled to and marked in the source — exactly,
since the anchor is in bytes of the very file the editor holds — and shown in
the PDF through SyncTeX. A section with no range goes to its heading. After
adopting somebody else's passage this page says nothing until a person touches
it, so it cannot answer its own echo (`shouldPublish`, with tests). A part
ticked in the host's bar is a person touching it: the quiet ends and the
passage of the file the tick opened is said. And the passage this page said
before a reload is still its own after it, not somebody else's to walk to.

The caret is left where it was — the passage is marked, not selected — so
while that passage is what this page is showing, the toolbar reads out the
PASSAGE's page and section rather than the caret's. That, and the sentence
saying something pointed here, last until the person goes somewhere of their
own accord: places the caret, picks a file or a section, presses the PDF.

## A change an agent suggests

The MCP door has `list_papers`, `list_sections`, `read_paper`, `read_source`,
`list_proposals` and `propose_edit`, and **no tool that writes a `.tex`**.

`propose_edit` names the text to replace and what replaces it. The suggestion
is held in this server's memory and shown above the source as a diff — what
leaves in red, what arrives in green, the agent's reason beside it — with
Accept and Reject. The file is untouched until a person presses Accept, which
is an HTTP POST carrying a ticket printed into this page and never emitted on
the MCP door. Accepting saves what the editor holds first, then splices, then
commits to the paper's own repository when it has one.

Since version 2 a suggestion may contain LaTeX markup. It was refused before
because a suggestion was drawn into rendered prose and a change inside
`\cite{…}` had nowhere to be drawn; a diff of the source shows exactly the
bytes that would change.

*Accept suggestions as they arrive* (View) accepts suggestions that arrive
while it is ticked. It is the person
saying yes in advance, for this paper, in this browser; nothing an agent can
call sets it.

## The controls are the container's menus

The page has no toolbar. What used to be one — the Source / PDF tabs, the
section list, the picked parts' file tabs, Compile, *Show in PDF*, Commit, the
Auto tick, the log, "chapter of" — is declared to the host
(`kehikot.header`, `src/header.ts`) and drawn in the container's own header
row as View, Go and Run. The page spends no row on any of it; the one line
over the editor names the file, whether it is saved, and the section and page.

| item | kind | menu | |
|---|---|---|---|
| `pane` | switch | View | Source / PDF. Choosing PDF shows the caret's line there |
| `file` | switch | View | the picked parts' chapters, when more than one is picked |
| `chapter` | switch | View | which part the open file is the chapter of |
| `auto` | toggle | View | accept suggestions as they arrive. Person-only |
| `log` | toggle | View | the last compile's warnings and log |
| `section` | go | Go | every file offered and its sections |
| `compile` | run | Run | `agents: true`; busy and failed show on the trigger; its `result` is the seconds and pages, or the first error |
| `reveal` | run | Run | show the caret's line in the PDF — the switch cannot be pressed twice, this can |
| `commit` | run | Run | `confirm: true`, so never an agent's; disabled with the reason when nothing has changed |
| `parts-each` | run | Run | a part for each chapter, in an epic that has none |

The list is declared again only when it is a different list: typing declares
nothing. A compile starting and finishing declares two.

**A host that draws no header.** A page cannot be told whether its host draws
these: the greeting carries the wire protocol's whole number and nothing else,
and an older host drops `kehikot.header` in silence. So the page keeps ONE
control — a small "⋯" at the end of the line over the editor, and over the
PDF's top left corner when the PDF is the only pane; no row either way — with
the same items behind it (`src/header-fallback.tsx`). It is there on a
page opened by its address, and on a framed page until the first
`kehikot.press` arrives, which only a host that draws the header sends; that
is remembered in the browser, and from then on it is gone.

## Templates

The engine compiles whatever the document declares, so a paper in any class —
a venue's, a university's, one sitting beside `main.tex` — already works. A
template is only for the first minute, when an epic has no paper:

- **Built in**: *Article*, *Article in parts* (sections in their own files),
  *IEEE conference* (`IEEEtran`) and *Report or thesis* (`report`, chapters in
  their own files). They are strings in `templates.ts`.
- **From a folder** the person names: a venue's template, another paper. It is
  copied — never followed through symlinks, without dot-folders or build
  products, bounded in files and bytes — and needs a `main.tex`, or exactly one
  top-level `.tex` with a `\documentclass`, which becomes `main.tex`.

Starting a paper refuses when anything is already at that path. Nothing
converts a paper from one template to another: that is editing
`\documentclass` and fixing what the engine then says.

## Commits

A paper lives in somebody's repository. Accepting a suggestion commits that
file, and *Commit* (shown when the paper has uncommitted changes) commits the
paper's files — only the paper's, authored by the person, never amending and
never pushing. `git.ts` says what it refuses and why.

## Doors

| Door | |
| --- | --- |
| `GET /api/paper`, `/api/papers`, `/api/source`, `/api/figure` | the paper's shape, a file's text and hash, a figure |
| `POST /api/paper` | start a paper: empty, `template`, or `folder` |
| `POST /api/file` | save one file whole; 409 with the disk's text when it moved |
| `GET /api/build`, `/api/pdf` | where the build stands; the last good PDF — with `part=<key>`, one selection's own |
| `POST /api/compile` | compile, superseding a compile in flight |
| `GET /api/part`, `POST /api/part` | where the picked files' own build stands; compile them on their own (and the whole paper first when it has to be) |
| `GET /api/toolchain` | the compiler this module can fetch: pieces, sizes, hosts, folder, progress |
| `POST /api/toolchain/install`, `/api/toolchain/cancel` | start fetching the missing pieces (answers at once); stop |
| `GET /api/sync` | `file`+`line`[+`to`] → rectangles; `page`+`x`+`y` → file and line; `part=<key>` asks one selection's own PDF |
| `GET /api/proposals`, `POST /api/proposal` | suggestions waiting; accept or reject one |
| `GET /api/uncommitted`, `POST /api/save` | where the repository stands; commit |
| `GET /api/templates` | the built-in starting points |
| `POST /mcp` | the six tools |

Every POST but `/mcp` demands the ticket printed into this process's page, in
the `x-module-ticket` header. There is no CORS header and the manifest declares
`storage: true`, so the page keeps a real origin and the ticket is not readable
from another one.

The doors are served by `doors()` from `kehikot-module-protocol` (pinned to a
tag), which also prints this process's build into the page and stamps every
answer with it. The page uses the protocol's `useHost`, `ask` and `Cover`: a
page that finds it is older than its server reloads itself once, and one whose
server has stopped says so with a Try again. Whatever was typed and not yet
saved is written to this tab as it changes (`held`), so it is back in the same
file after a reload — and if that file was written by somebody else meanwhile,
it comes back as the ordinary conflict rather than over their version.

## Layout

```
manifest.ts          what a host reads
doors.ts             every door, as functions; the protocol's doors() serves them
store.ts             papers on disk: reading, the two writers, starting one
templates.ts         the built-in starting points
compile/engine.ts    which engine and its arguments (pure)
compile/log.ts       an engine's errors as file and line (pure)
compile/synctex.ts   the SyncTeX reader, both directions, the page map (pure)
compile/build.ts     the queue, the build folder, the spawn
compile/part.ts      a picked part on its own: what can be, and how it is asked for (pure)
compile/toolchain.ts the compiler this module can fetch: pinned addresses, sizes, checksums (pure)
compile/install.ts   fetching it: download, verify, extract one file, rename into place
latex/               the parser, labels, bibliography, proposals, diff
proposals.ts, git.ts suggestions in memory; commits
src/                 the page: workspace.tsx, editor/, pdf/, the hooks
src/focus.ts         the paper narrowed to the picked parts of the epic (pure)
```
