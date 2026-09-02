import * as LabelPrimitive from '@radix-ui/react-label'
import type * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * shadcn's label, unchanged.
 *
 * It is here because `Checkbox` is a Radix primitive rather than an
 * `<input type="checkbox">`, and a native `<label>` around a `<button
 * role="checkbox">` does not toggle it — a browser only forwards a label press
 * to a labelable element, and a button is not one. Radix's Label knows the
 * difference and forwards the press itself, which is the whole reason shadcn
 * pairs the two.
 *
 * The `peer-disabled` rules are upstream's and they are what makes a tick and
 * its word grey out together rather than the word staying black beside a
 * control nobody can press.
 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none',
        'group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
