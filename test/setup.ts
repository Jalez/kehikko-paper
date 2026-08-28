import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * A document, for the tests that render one.
 *
 * Registered globally rather than per-file because half the value of these
 * tests is that they run the real components: the words on screen and the page
 * a reader lands on are the thing being asserted, and a fake renderer would let
 * a component say something different from what it says in a browser.
 */
GlobalRegistrator.register()
