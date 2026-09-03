import * as PopoverPrimitive from '@radix-ui/react-popover'
import type * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * shadcn's popover, with the changes a scaled document needs.
 *
 * ## Why this component is here at all
 *
 * The one thing this module could not do by hand is position a control against
 * a run of words inside a sheet drawn at `transform: scale(0.247)`. Everything
 * about that is arithmetic somebody has to get right twice — once for the
 * offset, once for the size — and the previous attempt got it right by NOT
 * doing it: the control was absolutely positioned against the whole block row,
 * which is the paragraph and not the words, and then counter-scaled by hand
 * with a reciprocal published from the sheet.
 *
 * Radix's popover is Floating UI underneath, and Floating UI positions against
 * `getBoundingClientRect`. That is the VISUAL rectangle — a transformed
 * element reports where it actually is on screen and how big it actually looks
 * — so anchoring to a `<del>` inside the sheet needs no knowledge that the
 * sheet is scaled at all. And the content renders in a PORTAL at the end of
 * `document.body`, outside the transformed subtree, so it is drawn at its own
 * size with no reciprocal anywhere.
 *
 * ## What was changed from upstream, and why
 *
 * **No animation classes.** Upstream's content carries `animate-in`,
 * `fade-in-0`, `zoom-in-95` and the four slide-in variants, which come from
 * `tw-animate-css`. This project does not import it, so those classes compile
 * to nothing and would be four lines of dead string. They are removed rather
 * than left looking like they do something.
 *
 * **No `w-72`, and no `bg-popover`.** Upstream fixes the width at 18rem and
 * paints with `--popover`, neither of which exists usefully here: this page is
 * read in a container 220 pixels wide, where 18rem is wider than the whole
 * column, and the palette in `index.css` has `--card` and no `--popover`. The
 * width is left to the caller — `.proposal-card` bounds it against the space
 * Floating UI measured — and the surface is the card's.
 *
 * **`sideOffset` defaults to 6 rather than 4**, because what this floats over
 * is prose rather than a button, and a control one hairline off a line of text
 * reads as part of the sentence.
 *
 * `Anchor` is re-exported because it is the whole reason this is here. It takes
 * a `virtualRef` — anything with a `getBoundingClientRect` — which is how a
 * control owned by the paragraph gets positioned against a span several
 * components below it. See `proposed.tsx`.
 */
export function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

export function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

export function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

export function PopoverArrow({
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Arrow>) {
  return (
    <PopoverPrimitive.Arrow
      data-slot="popover-arrow"
      /* `fill` and not a background: this is an SVG polygon. The border colour
         cannot be drawn on it without a second, offset copy, so it is filled
         with the card and left unstroked — a seam a reader does not see at the
         sizes this is drawn at. */
      className={cn('fill-[var(--card)]', className)}
      {...props}
    />
  )
}

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-card text-card-foreground z-50 rounded-[var(--radius-sm)] border shadow-md outline-hidden',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
