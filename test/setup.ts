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

/* The page remembers where its reader was, in the tab's session — so that a
   reload comes back to it — and every test in a run shares the one tab. A test
   starts as a tab nobody has been in; `place.test.tsx` is where it does not. */
beforeEach(() => window.sessionStorage.clear())
