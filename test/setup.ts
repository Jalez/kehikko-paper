import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { beforeEach } from 'bun:test'

/**
 * A document, for the tests that render one.
 *
 * Registered globally rather than per-file because half the value of these
 * tests is that they run the real components: the words on screen and the page
 * a reader lands on are the thing being asserted, and a fake renderer would let
 * a component say something different from what it says in a browser.
 */
GlobalRegistrator.register()

/* This module's machine state (suggestions, baselines, reasons) goes to a
   directory of the run's own, never to the machine's Kehikot folder. */
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.PAPER_STATE_DIR = mkdtempSync(join(tmpdir(), 'kehikot-paper-state-'))
}

/* After the document exists, never as a hoisted import: the client installs its
   one `message` listener as it is evaluated, and with no window yet it would
   install none — every greeting in every test would go unheard. */
const { mailbox, resetServerStanding } = await import('kehikot-module-protocol/client')

/* The page remembers where its reader was, in the tab's session — so that a
   reload comes back to it — and every test in a run shares the one tab. A test
   starts as a tab nobody has been in; `place.test.tsx` is where it does not. */
beforeEach(() => {
  window.sessionStorage.clear()
  /* And whether a host has ever pressed a header item here (`header-fallback.tsx`),
     which a page remembers for good and a test must not inherit: every test
     starts on a page that still draws its own menu. */
  window.localStorage.removeItem('kehikot.paper.header-drawn')
  /* And one fact per page that outlives a test: whether this app's own server
     is answering. `stale` never heals, so a test that left it would cover
     every page after it. */
  resetServerStanding()
  /* And the client's backlog. It keeps what arrived so a late mount can hear
     it, and every test in a run shares the one window: without this, a greeting
     posted in one file is replayed into the next file's freshly mounted page,
     which then stands in that file's project instead of its own. For a suite
     only — a page must never forget its backlog. */
  mailbox.forget?.()
})
