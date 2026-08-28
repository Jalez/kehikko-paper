import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
/**
 * Imported for its side effect, and the order on this page is the whole point.
 *
 * `wire/mailbox.ts` installs the one `message` listener at module scope, so it
 * is listening as part of this bundle being evaluated — which is before React
 * has rendered anything, let alone run an effect. The host greets on the
 * frame's `load` event, and effects run strictly after that, so a listener
 * installed in `useEffect` is installed after the greeting has already been
 * posted and thrown away. See the essay in `mailbox.ts`; it is a bug that costs
 * an afternoon and whose only symptom is a pane reporting a module that will
 * not speak.
 */
import '../wire/mailbox.ts'
import { App } from './app.tsx'

/**
 * The theme, seeded once, before React paints.
 *
 * This is the only place `prefers-color-scheme` is consulted in JavaScript, and
 * it is consulted for one case: a page nobody is framing, where there is no
 * host to have an opinion and the machine's is the only one going. Any
 * `roadmap.context` that arrives overrides it, which is what makes the class on
 * the root element the single answer to "what theme is this" rather than one of
 * two mechanisms that can disagree.
 */
const root = document.documentElement
if (!root.classList.contains('dark') && !root.classList.contains('light')) {
  root.classList.toggle('dark', window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)
}

const mount = document.getElementById('root')
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
