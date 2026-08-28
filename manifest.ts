import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'roadmap-module-protocol'

export const ID = 'roadmap.paper'
export const VERSION = '1.0.0'

/**
 * What this app says about itself when a host asks.
 *
 * The manifest is the smallest half of this program and the only half a host
 * ever reads. Everything else here works with nothing on the other end — open
 * `http://127.0.0.1:7870/app` in a browser and the whole reader is there, with
 * a picker in place of the host's canvas. So read this as a description of the
 * ENRICHMENT, and of an unusually thin one: all this file really asks for is a
 * tab. What arrives through it — which epic the canvas is on — is not something
 * a module has to ask for at all.
 *
 * ## Protocol 2, and the rename that made this file necessary to rewrite
 *
 * The module this was extracted from declared protocol 1, which meant a host
 * running 2 framed it as *incompatible* and never greeted it — a pane that
 * loads a page and then refuses to talk to it, for a reason visible only in the
 * host's own log. The rename is not cosmetic and it reaches into three places
 * here: `epics.list` and `epic.get` are the method names now, `roadmap.context`
 * carries `epic` where it carried `slug`, and a mode's scope is `epic` where it
 * was `journey`. This app reads only the third and the middle one, but the
 * declaration has to be honest about all of it.
 *
 * ## What is declared, and the longer list of what is not
 *
 * - **The one thing this app needs is not declared, because it cannot be.**
 *   Which epic is open arrives unbidden on the greeting and on every
 *   `roadmap.context`, to every module, whatever it declared. So the paper on
 *   screen is drawn from this machine's own disk with nothing asked of anybody,
 *   and every state below is reachable with no host at all.
 * - **`epics:read` — declared, and the only capability asked for.** Not for the
 *   paper: for the gap. This app can see which epics HAVE a paper, because it
 *   is looking at the directory; it cannot see which epics EXIST, because a
 *   directory of papers is not a list of epics. `epics.list` closes that, and
 *   the difference is the whole reason this module is interesting to a reader —
 *   an epic aimed at a paper nobody has written yet is exactly the thing worth
 *   putting on screen, and it is invisible from here without asking.
 *
 *   It is enrichment and is drawn as enrichment. Refused, unanswered, or asked
 *   of a host that has never heard of the method, the picker is still every
 *   paper on this machine and the reader loses one muted line at the bottom of
 *   it. Nothing waits on the answer and nothing is blank until it arrives.
 * - **`steps:read` — not declared.** A paper is prose. It argues for an
 *   arrangement; it does not track work, and a reader that drew a step rail
 *   beside the argument would be a second, worse Journeys.
 * - **`live:read` — not declared.** The papers here write `\gh{41}` and `!1801`
 *   inline, and the temptation to colour those with what a tracker last said is
 *   real. It is refused on purpose: a paper is a document that has to read the
 *   same in the browser and in the compiled PDF, and a reference that is grey
 *   in one and green in the other is two documents. Journeys is where a
 *   reference gets a state; here it is a citation.
 * - **`stage:report` — not declared.** Nothing here does work, so nothing here
 *   has a stage to report.
 * - **`view:navigate` — not declared.** This app is a panel a reader is already
 *   standing in. It wants to be walked TO, which is `roadmap.goto` arriving and
 *   needs no declaration; the day the section list should move the HOST's open
 *   epic rather than only this page's scroll, this is the line that changes.
 * - **Tracker access — not declared, and there is no capability for it.** This
 *   app speaks to no network at all. It reads files.
 * - **`prompt: false`, and the reason rather than the fact.** A prompt is
 *   standing instructions somebody writes FOR a module, and it earns its place
 *   when the module has a decision it would make differently having read them.
 *   This one has none: it parses a `.tex` file and draws it. There is no
 *   generation to steer, no filter to bias, no tone to set. Declaring it true
 *   would put a prompt dialog in the host's chrome that fed a string into a
 *   program with nowhere to put it — and the host owns that dialog, so this app
 *   must not grow one of its own either.
 * - **No extensions.** Nothing here happens that another module would want to
 *   be told about, and `consumes` is unimplemented everywhere, so declaring it
 *   would be declaring an intention this app could not act on.
 *
 * And per the protocol's own README: a declaration is not a request and is not
 * answered. The host refuses whatever it likes at every call whatever is
 * written here, so the page is built to be refused — the epic list arriving
 * adds a line and its absence removes one, and neither is a state a reader has
 * to wait in.
 *
 * ## Storage, and why THIS module asks for it
 *
 * The argument is Journeys', unchanged, and it is worth restating because the
 * conclusion looks wrong from the outside: this module is read-only, so surely
 * it needs no origin?
 *
 * It needs one because it SERVES ITS OWN `/api`. Without `storage: true` a host
 * frames the page without `allow-same-origin`, the page runs on an opaque
 * origin, and an opaque origin matches nothing — so the page's fetches of its
 * own `/api/paper` are cross-origin, and `<script type="module">` is always
 * fetched in CORS mode besides. The server would then have to answer every
 * request with a permissive `Access-Control-Allow-Origin`, or not one line of
 * this page would run. That header is the hazard: it is an invitation to every
 * page in every tab to read this origin.
 *
 * The module this was extracted from went further and had `app.use(cors())`
 * with no options at all, in front of a `POST /api/edits` that wrote to the
 * author's thesis. That combination is not carried across in any form. There is
 * no `server.cors` line in `vite.config.ts`, and there is no write path here at
 * all — see the essay on that in `doors.ts`.
 *
 * What the sandbox gives up is small and worth naming. The origin this page
 * regains is `127.0.0.1:7870`; a host is on `127.0.0.1:4181`. Different ports
 * are different origins, so the page still cannot reach into the host. It can
 * reach itself, which is all it asked for.
 */
export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  /**
   * Parsed rather than shipped as a bare object.
   *
   * The protocol package is explicit that its schemas are a convenience and
   * never the host's check — the host runs its own copy over what arrives on
   * the wire. That cuts both ways: running it HERE is the cheapest way for this
   * app to learn it has written a manifest no host will accept, and to learn it
   * when this file is imported rather than from a host's refusal in somebody
   * else's log.
   */
  protocol: PROTOCOL,
  id: ID,
  name: 'Paper',
  version: VERSION,
  summary: 'The paper this epic is aimed at, read as prose: sections, figures and tables rather than markup.',
  /**
   * What an agent should do about this module being here.
   *
   * Not what it shows — the summary says that, and a host that framed it can
   * see it. This says what its PRESENCE OBLIGES, and a host composes it into
   * the prompt every agent on the canvas is handed, attributed to this module.
   */
  guidance:
    'This epic is aimed at a paper, and the paper is the argument the work is supposed to make ' +
    'true. Read the relevant sections before changing behaviour: if a sentence in it describes ' +
    'what the code does, your change can make that sentence false, and the paper is then part of ' +
    'the work rather than documentation of it. Cite by section when you say a change follows from ' +
    'the paper, so a reader can check you. This module only reads — edit the .tex on disk, and ' +
    'never restate here what the paper already says, because two copies of an argument drift.',
  entry: '/app',
  modes: [{ id: 'paper', label: 'Paper', scope: 'epic' }],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about: 'The papers on this machine: which epics have one, and the prose or the raw source of any section.',
  },
  extensions: { emits: [], consumes: [] },
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: ['epics:read'],
    storage: true,
    prompt: false,
  },
  health: '/healthz',
})
