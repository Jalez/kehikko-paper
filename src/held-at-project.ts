import { projectKey } from 'kehikot-module-protocol'
import type { Held, HeldAt } from 'kehikot-module-protocol/client'

/**
 * What this page holds for the open project — by the project's id, not its folder.
 *
 * A person may rename or move the folder while a draft is half typed, and the host then tells the
 * page the new path in its context; the id does not change. So `held` is scoped by `projectKey`
 * (the id when the host sends one, the path otherwise). Drafts kept under the path by an earlier
 * version of this page, or by this one before the host sent an id, are read once: moved under the
 * id, the path's copy forgotten, never overwriting what is already held under the id.
 *
 * `undefined` when there is no project. The same scope gives the same object back, so it can be a
 * dependency.
 */
export function heldAtProject<T>(
  store: Held<T>,
  context: { projectId?: string | null; projectPath?: string | null },
): HeldAt<T> | undefined {
  const key = projectKey(context)
  if (!key) return undefined
  const here = store.at(key.key)
  const path = context.projectPath?.trim()
  if (key.by === 'id' && path && path !== key.key) {
    const old = store.at(path)
    const was = old.all()
    for (const [target, value] of Object.entries(was)) {
      if (here.read(target) === null) here.keep(target, value)
      old.keep(target, null)
    }
  }
  return here
}
