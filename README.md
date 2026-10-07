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
the source is still edited and saved, the PDF pane says how to install an
engine, and that is all: a second, approximate rendering of the paper is the
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

**An engine, found on this machine.** `compile/engine.ts` looks on `PATH` and
where Homebrew and MacTeX install for `tectonic`, `latexmk`, `pdflatex`,
`xelatex` and `lualatex`, and uses the first it finds, in that order. When
there is none the PDF pane says so and says what to install
(`brew install tectonic` is the smallest).

**A paper can name its engine**, in the paper: `% !TEX program = xelatex` in
the first lines of `main.tex` — the magic comment TeXShop, TeXstudio and VS
Code's LaTeX Workshop already read. If that engine is not installed the page
says so rather than using another.

**A `.tex` file is a program, and it is somebody else's.** Every engine is
spawned from an argument array — there is no shell anywhere — with shell escape
explicitly off, a closed stdin, a three-minute timeout, a cap on how much
output is kept, and an environment holding `HOME`, `PATH` and little else.
Tectonic runs `--untrusted`; `latexmk` runs `-norc`, since a `.latexmkrc` is
Perl. Engines run in a process group of their own so that stopping one stops
what it started.

**One compile at a time per paper, and the latest save wins.** A newer request
kills the compile in flight — by the pid of the child this process spawned,
never by name — and starts again.

**Tectonic is asked cached-first.** Its first run uses `--only-cached`, which
skips a network round trip on every compile; only when that fails for want of a
file is it run again allowed to fetch. A paper's first compile on a machine may
therefore take as long as downloading its packages does.

**The bare engines** (`pdflatex`, `xelatex`, `lualatex`) are run twice and do
not run BibTeX or biber; a bibliography wants `latexmk` or Tectonic. The TeX
Live argument lists are pinned by tests and have **not** been run against real
binaries: the machine this was written on has only Tectonic.

**Class and style files beside `main.tex` are found**, as are files in
subfolders that the paper names with their folder (`\input{chapters/a}`,
`\usepackage{style/shout}`). A `.sty` in a subfolder named WITHOUT its folder
is not found, because an extra search path is one of the things `--untrusted`
turns off, and safe is the default worth keeping.

### Where the build goes

**The operating system's temporary directory**: `<tmpdir>/kehikot-paper/<hash
of the paper's real path>/`, holding `work/` (the engine's output directory,
emptied before each run) and `good/` (the PDF, SyncTeX file and a small
`meta.json` from the last run that produced a PDF).

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

- **Source to PDF** is exact to the source line: one rectangle per printed line
  those source lines reached, as wide as the part they produced.
- **PDF to source** is exact to the source line under the click.
- **Finer than a line** is done by matching against the PDF's own text
  (`src/pdf/words.ts`): the clicked word is looked for on the named line and
  selected, and the first and last words of a selection are looked for under
  ALL of its rectangles — a source line is often printed over two — so that
  the rectangles it does not reach are dropped and the two it ends in are
  pulled in. A word's position in a run of PDF text is an estimate by
  proportion, good to a character or two, so a pulled-in end keeps two
  characters of margin rather than risk cutting into the word. When no match
  is found the line-level answer stands, and nothing is ever widened past it.

Measured on a 20-page paper (661 prose lines, 1,177 words clicked), with
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
  a formula is told apart.
- **Floats** answer from where they landed. A caption goes to its line; the
  image itself and the cells of a table go to the line of the environment or
  nearby.
- **What a macro typeset** — the title block, a table of contents, a
  bibliography printed from a `.bbl` — answers with the line of the command
  that called it (`\maketitle`), or not at all when it came from the class.
- **A hyphenated word** is found by SyncTeX but not by the word match, so that
  end of a selection's highlight stays at the line-level answer.
- **A caret on a line that printed nothing** — a comment, a `\label` — draws
  nothing until *Show in PDF* is pressed, which goes to the nearest line that
  did.

The table also yields, per file of the paper, which pages it reached and with
which lines (`pageMap`). The page uses it to say which page the caret is on,
and it is what a later "show only the pages of these parts" will read.

## What other modules are told

One thing, and its shape is unchanged: `passage.set`, with
`{ path, page, from, to, quoted, section }`.

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

What arrives is one thing too: the passage the canvas holds. A range in one of
this paper's files is opened, scrolled to and marked in the source — exactly,
since the anchor is in bytes of the very file the editor holds — and shown in
the PDF through SyncTeX. A section with no range goes to its heading. After
adopting somebody else's passage this page says nothing until a person touches
it, so it cannot answer its own echo (`shouldPublish`, with tests).

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

*Auto* accepts suggestions that arrive while it is ticked. It is the person
saying yes in advance, for this paper, in this browser; nothing an agent can
call sets it.

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
| `GET /api/build`, `/api/pdf` | where the build stands; the last good PDF |
| `POST /api/compile` | compile, superseding a compile in flight |
| `GET /api/sync` | `file`+`line`[+`to`] → rectangles; `page`+`x`+`y` → file and line |
| `GET /api/proposals`, `POST /api/proposal` | suggestions waiting; accept or reject one |
| `GET /api/uncommitted`, `POST /api/save` | where the repository stands; commit |
| `GET /api/templates` | the built-in starting points |
| `POST /mcp` | the six tools |

Every POST but `/mcp` demands the ticket printed into this process's page.
There is no CORS header and the manifest declares `storage: true`, so the page
keeps a real origin and the ticket is not readable from another one.

## Layout

```
manifest.ts          what a host reads
doors.ts             every door, as functions; vite.config.ts adapts them
store.ts             papers on disk: reading, the two writers, starting one
templates.ts         the built-in starting points
compile/engine.ts    which engine and its arguments (pure)
compile/log.ts       an engine's errors as file and line (pure)
compile/synctex.ts   the SyncTeX reader, both directions, the page map (pure)
compile/build.ts     the queue, the build folder, the spawn
latex/               the parser, labels, bibliography, proposals, diff
proposals.ts, git.ts suggestions in memory; commits
src/                 the page: workspace.tsx, editor/, pdf/, the hooks
```
