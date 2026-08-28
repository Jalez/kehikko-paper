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

if [ -z "${KEHIKKO_PAPERS_DIR:-}" ] && [ -z "${KEHIKKO_ROADMAP_DIR:-}" ]; then
  echo "paper: neither KEHIKKO_PAPERS_DIR nor KEHIKKO_ROADMAP_DIR is set." >&2
  echo "paper: starting anyway; the page will say so rather than pretending there are no papers." >&2
fi

exec bunx vite --host 127.0.0.1 --port "${PORT:-7870}" --strictPort
