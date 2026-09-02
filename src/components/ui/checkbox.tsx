import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { CheckIcon } from 'lucide-react'
import type * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * shadcn's checkbox, with one size added for this app's normal case.
 *
 * ## Why the hand-rolled one went
 *
 * The Edit and Auto ticks were `<input type="checkbox">` with
 * `accent-[var(--mark)]` on them, inside a bare `<label>`. That drew a native
 * checkbox — the operating system's, not this canvas's — so the two controls in
 * the chrome row were the only things on the page that did not look like the
 * rest of the canvas, and `accent-color` is the entire extent of what a page
 * may say about one. Dark mode, the focus ring, the disabled state and the
 * checked colour were all the browser's opinion rather than this theme's.
 *
 * ## What was changed from upstream, and why
 *
 * One thing: a `container` size, exactly as `button.tsx` added one and for the
 * same reason. Upstream's checkbox is `size-4` — 16 pixels — which is right on
 * a page and is a quarter of the height of the chrome row in a container 220
 * pixels wide, where this module routinely lives. `container` is `size-3.5`
 * with a smaller tick inside it, and it is a variant rather than a `className`
 * at each call site so that every tick in this app is the same size.
 *
 * Everything else is upstream's: the Radix primitive, so the label, the space
 * bar, the focus ring and `aria-checked` are the platform's rather than three
 * more things to get right by hand.
 */
function Checkbox({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & { size?: 'default' | 'container' }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'container' ? 'size-3.5' : 'size-4',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className={size === 'container' ? 'size-2.5' : 'size-3.5'} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
