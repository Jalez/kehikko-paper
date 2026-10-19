import { existsSync, realpathSync } from 'node:fs'

/**
 * What this process remembers about a project folder, and when to let go of it.
 *
 * Several tables here (suggestions, review state, builds) are held in memory under the project's
 * PATH, because the path is what a request carries. A project is its id, not its path: when the
 * person renames or moves the folder, the host relinks it and the old path stops meaning anything,
 * but a table keyed by it keeps its rows for ever — and, worse, a different project later made at
 * that path would be served the old one's rows. What is on disk is already filed by the project's
 * id (`machine.ts`), so letting go of a row costs a read, never a suggestion.
 *
 * The door tells this file what the host vouched for (`vouched`), and every table registers how to
 * drop its rows for one folder (`onProjectLeft`). A path is left when
 *
 * - the host says the project has MOVED from it (`movedFrom`);
 * - the host now vouches for it as a different project than it last did; or
 * - the folder is not on disk any more.
 *
 * A purge only forgets rows in memory. It never writes, because the path it is told about is the
 * one nothing may be written under.
 */
const purgers = new Set<(project: string) => void>()
const known = new Map<string, string>()

/** A table says how to forget its rows for one project folder. Called with the path as the host spelled it and as it resolves. */
export function onProjectLeft(forget: (project: string) => void): void {
  purgers.add(forget)
}

/** Every spelling a table may have held the folder under: as written, and really (when it still exists). */
function spellings(path: string): string[] {
  try {
    const real = realpathSync(path)
    return real === path ? [path] : [path, real]
  } catch {
    return [path]
  }
}

function leave(path: string): void {
  known.delete(path)
  for (const where of spellings(path)) for (const forget of purgers) forget(where)
}

/** The host vouched for `path` (as project `id`, when it said); `movedFrom` is the path the caller had learnt. */
export function vouched(path: string, id?: string, movedFrom?: string): void {
  if (movedFrom) leave(movedFrom)
  const was = known.get(path)
  if (id && was && was !== id) leave(path)
  known.set(path, id ?? was ?? '')
  for (const one of [...known.keys()]) if (!existsSync(one)) leave(one)
}

/** For tests: forget what was vouched for, without purging anything. */
export function forgetVouched(): void {
  known.clear()
}
