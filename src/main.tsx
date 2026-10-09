import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
/**
 * Imported for its side effect, and the order on this page is the whole point.
 *
 * The client installs the one `message` listener at module scope, so it is
 * listening as part of this bundle being evaluated — which is before React has
 * rendered anything, let alone run an effect. The host greets on the frame's
 * `load` event, and effects run strictly after that, so a listener installed in
 * `useEffect` is installed after the greeting has already been posted and
 * thrown away. See the essay in the client's `mailbox.ts`; it is a bug that
 * costs an afternoon and whose only symptom is a container reporting a module
 * that will not speak.
 *
 * It is imported HERE, from the entry, rather than from `use-paper.ts` — a
 * module scope that only a lazily-loaded chunk imports is a module scope that
 * has not run yet, which is the same bug wearing a bundler's clothes. The
 * package's `sideEffects` field names the client files for the same reason.
 */
import 'kehikot-module-protocol/client'
import { App } from './app.tsx'

/*
 * The theme is not seeded here any more. The document `doors()` serves decides
 * it in a blocking script, before the first paint and before this file has
 * loaded — what the host said last time, or the machine's own preference for a
 * page nobody is framing — and `useHost` puts the host's word on the root
 * element from the greeting on. The class there is still the single answer to
 * "what theme is this".
 */
const mount = document.getElementById('root')
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
