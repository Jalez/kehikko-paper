#!/usr/bin/env bash
#
# The one name every module ships this under, so a host that offers to start one
# has a script to run rather than a command line to build.
#
#   - No arguments. A registration names a directory and one script inside it,
#     never a command line: a string a host handed to a shell would make a
#     registration file a place to write shell.
#   - $PORT from the environment. Whoever starts this chose the port; a script
#     that picked its own would answer somewhere nobody is looking. 7870 is the
#     default and the number in the registration too — 7820, 7830, 7840, 7850
#     and 7860 belong to References, Atlas, Journeys, the Orchestrator and
#     Checklist on this machine.
#   - `exec`, and the foreground. A script that forks and returns leaves whoever
#     started it holding a pid that stops nothing, and Stop is only ever offered
#     for what a host started.
#   - `cd` to this script's own directory, so `page/` and `latex/` are found
#     however this was invoked.
#
# ## The one thing this program needs told
#
# `KEHIKKO_PAPERS_DIR`, or `KEHIKKO_ROADMAP_DIR` with `data/papers` under it.
# There is deliberately no default: the app this was extracted from had one
# compiled in (`../05_drafts/thesis_latex`), which is the line that made it one
# person's program rather than a module. Unset, this still starts, still serves,
# and says on its own page what to set — a misconfiguration that announces
# itself is worth far more than one that renders an empty world convincingly.
#
# `KEHIKKO_THESIS_DIR` is a SECOND root and names one document rather than a
# directory of them: a `main.tex` at the top of its own repository, with
# `chapters/`, `figures/` and a `references.bib` beside it. That is the shape
# `../05_drafts/thesis_latex` actually has, and it is why the compiled-in
# default could not simply become a compiled-in `KEHIKKO_PAPERS_DIR` — the
# thesis has no parent directory full of sibling papers to point at. Setting it
# is still somebody's decision, made outside this file; the essay on
# `thesisRoot` in `store.ts` says why it is a variable and not a symlink.
# `KEHIKKO_THESIS_EPIC` renames the slug it answers to; it defaults to `thesis`.
#
# It does NOT register. Registration is a deliberate act by a person — see
# `register.ts` — and a start script that quietly wrote into somebody's home
# directory would be doing it on their behalf.
#
# ## There is no build here, and no `dist`
#
# The argument for one is that starting should be starting: a start that shells
# out to a build is a start that fails when the network is down. The argument is
# fine and the shape is still wrong, because this program is not deployed — it
# runs on the machine of the person editing it. What `dist` actually buys is a
# STALE page served with a 200, every symptom of a working app and none of the
# changes, and that failure has cost this codebase whole afternoons three
# separate times in three different programs. A missing build announces itself.
# A stale one does not.
#
# So Vite serves the page, as Vite is for. The manifest, the health check, the
# MCP door and this app's own `/api` are middleware in front of the same server
# — see `doors()` in `vite.config.ts` — because a module is one origin or it is
# nothing, and because a page that fetched its own papers from a second port
# would be fetching them cross-origin, which is where the wide-open `cors()` in
# the program this replaces came from.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "installing…" >&2
  bun install >&2
fi

# ---------------------------------------------------------------------------
# Where the papers are.
#
# These were documented above and defaulted nowhere, which meant they lived only
# in whichever shell first started this module. That is not a theory: the module
# was restarted during a refactor, lost both roots, and answered — correctly and
# uselessly — that nothing on this machine holds a paper for the thesis. Every
# layer reported truthfully and the thesis simply vanished from view.
#
# It is the same failure the host had with KEHIKKO_ROADMAP_DIR, in a second
# module, for the same reason: a variable with no default is a variable one
# restart away from being gone.
#
# So the defaults live here, in the script that starts this module, and an
# explicit value still wins. Both are checked for what actually makes them a
# root — a directory of papers, and a main.tex — rather than merely existing, so
# a moved folder says so at startup instead of at read time.
if [ -z "${KEHIKKO_PAPERS_DIR:-}" ] && [ -z "${KEHIKKO_ROADMAP_DIR:-}" ] \
   && [ -d "$HOME/Projects/roadmap/data/papers" ]; then
  KEHIKKO_PAPERS_DIR="$HOME/Projects/roadmap/data/papers"
fi
if [ -z "${KEHIKKO_THESIS_DIR:-}" ] \
   && [ -f "$HOME/Claude/Projects/CS-DEGREE/05_drafts/thesis_latex/main.tex" ]; then
  KEHIKKO_THESIS_DIR="$HOME/Claude/Projects/CS-DEGREE/05_drafts/thesis_latex"
fi
export KEHIKKO_PAPERS_DIR KEHIKKO_THESIS_DIR

# Said out loud, at start, in the terminal somebody is looking at — because the
# alternative is finding out from a page that says there is no paper, twenty
# minutes later, and blaming the page.
if [ -n "${KEHIKKO_PAPERS_DIR:-}" ]; then
  echo "paper: papers from $KEHIKKO_PAPERS_DIR" >&2
fi
if [ -n "${KEHIKKO_THESIS_DIR:-}" ]; then
  echo "paper: thesis from $KEHIKKO_THESIS_DIR (epic \"${KEHIKKO_THESIS_EPIC:-thesis}\")" >&2
fi

if [ -z "${KEHIKKO_PAPERS_DIR:-}" ] && [ -z "${KEHIKKO_ROADMAP_DIR:-}" ] && [ -z "${KEHIKKO_THESIS_DIR:-}" ]; then
  echo "paper: no papers root and no thesis root — neither was set and neither default is on this machine." >&2
  echo "paper: starting anyway; the page will say so rather than pretending there are no papers." >&2
fi

exec bunx vite --host 127.0.0.1 --port "${PORT:-7870}" --strictPort
