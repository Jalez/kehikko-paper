import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * shadcn's badge, used here for the small standing facts: which page of how
 * many, and what a note is.
 *
 * `whitespace-nowrap` is deliberate at 220px. A badge that wraps to two lines
 * reads as two badges, and "3 / 11" broken across a line break reads as neither
 * number.
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[0.65rem] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-muted text-muted-foreground',
        outline: 'text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
