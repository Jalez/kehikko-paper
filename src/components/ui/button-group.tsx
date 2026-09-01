import type * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * shadcn's button group, with the two changes a container this narrow needs.
 *
 * Upstream's version is a row of buttons whose adjacent corners are squared off
 * and whose adjacent borders are collapsed, so several presses read as one
 * control. That is exactly what an approve/reject pair wants: they are one
 * decision with two answers, not two unrelated things that happen to be beside
 * each other.
 *
 * ## What was changed, and why, in the same spirit as `sidebar.tsx`
 *
 * **It wraps.** Upstream is `flex` with no wrapping, on the reasonable
 * assumption that a group of two or three buttons fits on a line. This module's
 * container is routinely 220 pixels wide and the group can carry a third button —
 * `Accept all`, when several suggestions are waiting — so a row that would not
 * wrap would push the group past the edge of the paper. Horizontal scroll is
 * the one thing this module refuses, and it refuses it here too.
 *
 * The corner-squaring is written so that it survives the wrap: it applies to
 * horizontal neighbours only, which is what `:not(:first-child)` gives on a
 * wrapped row anyway — a button that starts a second line keeps a squared LEFT
 * edge it did not earn. That is a cosmetic imperfection at one width, accepted
 * knowingly, because the alternative is measuring the row.
 *
 * **`role="group"` and a required label.** Upstream leaves the accessible name
 * to the caller. It is required here because this group floats over a document
 * and there may be several of them on one screen, one per suggested change: a
 * screen reader meeting three unlabelled groups of Accept and Reject has been
 * told nothing at all about which paragraph each one is for.
 */
export function ButtonGroup({
  className,
  label,
  ...props
}: React.ComponentProps<'div'> & { label: string }) {
  return (
    <div
      data-slot="button-group"
      role="group"
      aria-label={label}
      className={cn(
        'flex flex-wrap items-center gap-px',
        /* The corner and border collapsing, on horizontal neighbours. `gap-px`
           rather than `gap-0` so the two buttons are separated by a hairline
           even when both are filled — otherwise Accept and Reject in two solid
           colours meet with no seam and read as one wide button. */
        '[&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none',
        className,
      )}
      {...props}
    />
  )
}
