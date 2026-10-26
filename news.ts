/**
 * Something this process changed that a page watching a paper may need to hear about: a suggestion
 * filed, revised or answered, Auto accept turned on, a reason written beside a change. All of it is
 * this module's state on the machine (`machine.ts`), never in the paper's folder, so no watcher on
 * the folder would see it; `machine.ts` says so here on every write, and `watch.ts` listens.
 *
 * What travels is that something MAY have moved, never what: the listener measures again and stays
 * quiet when nothing did.
 */
type Listener = () => void

const listeners = new Set<Listener>()

/** Tell everybody listening that this process's state changed. Never throws. */
export function touched(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* A listener that failed is its own problem, not the write's. */
    }
  }
}

/** Listen; the function returned stops listening. */
export function onTouched(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
