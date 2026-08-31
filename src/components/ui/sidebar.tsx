import { PanelLeft } from 'lucide-react'
import { createContext, use, useCallback, useMemo, useState, type ComponentProps } from 'react'

import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'

/**
 * shadcn's sidebar, kept as shadcn's sidebar and adapted to a PANE.
 *
 * It is here rather than imported because shadcn ships source: `shadcn add
 * sidebar` writes this file into the project and it is then the project's to
 * live with. Three things about upstream's version are wrong inside a module
 * container, and each is changed deliberately rather than by drift — so this comment
 * is the record of what a future `shadcn add sidebar` would overwrite.
 *
 * 1. **Upstream positions the sidebar `fixed inset-y-0` against the VIEWPORT.**
 *    That is right for an application that owns the window and catastrophic for
 *    a module framed in somebody else's canvas: a container 300 pixels wide would
 *    hang a full-height panel down the left of a two-thousand-pixel monitor,
 *    over the containers either side of it. Here the sidebar is an ordinary flex
 *    child of the container and collapses by going to zero width.
 *
 * 2. **Upstream swaps to a `Sheet` below a 768px VIEWPORT breakpoint**, via a
 *    `useIsMobile` hook that reads `window.matchMedia`. Every viewport
 *    breakpoint is the wrong question in this codebase — the container is routinely
 *    300px wide inside a window that is two thousand, so `useIsMobile` would
 *    answer `false` and lay out for a screen the container has fifteen per cent of.
 *    The mobile branch is therefore not carried over at all, and with it go the
 *    dependencies on `Sheet`, `Tooltip`, `Separator`, `Input` and `Skeleton`.
 *    One presentation, correct at every width, is better than two of which one
 *    is chosen by a question nobody here can answer.
 *
 * 3. **Upstream binds ⌘B / Ctrl+B globally.** A module must not take a chord
 *    out of the host's hands: the canvas around this container is a real application
 *    with its own keys, and a container that swallowed one would be a bug reported
 *    against the host. The trigger is a button and only a button.
 *
 * What IS upstream's, unchanged, is the vocabulary — `SidebarProvider`,
 * `Sidebar`, `SidebarTrigger`, `SidebarContent`, `SidebarGroup`, `SidebarMenu`,
 * `SidebarMenuButton`, `SidebarInset` — the `--sidebar-*` theme tokens, the
 * `data-state`/`data-slot` attributes, and the collapse-to-nothing behaviour of
 * `collapsible="offcanvas"`. A control here should be the control it is
 * everywhere else on the canvas.
 */

interface SidebarState {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

const SidebarContext = createContext<SidebarState | null>(null)

export function useSidebar(): SidebarState {
  const context = use(SidebarContext)
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider.')
  return context
}

/**
 * The provider, and the one decision it carries: what OPEN means by default.
 *
 * `defaultOpen` is false here where upstream's is true, and that is the container
 * again. A sidebar open by default in a 280px container is a container showing a table of
 * contents and forty characters of the argument — a reader who asked for a
 * paper and was handed an index of it. Open is a thing the reader asks for; the
 * paper is what they came for.
 */
export function SidebarProvider({
  defaultOpen = false,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = useCallback(() => setOpen((was) => !was), [])
  const value = useMemo<SidebarState>(() => ({ open, setOpen, toggle }), [open, toggle])
  return (
    <SidebarContext value={value}>
      <div
        data-slot="sidebar-wrapper"
        data-state={open ? 'expanded' : 'collapsed'}
        className={cn('flex min-w-0 items-stretch', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext>
  )
}

/**
 * The panel itself.
 *
 * Collapsed it is `width: 0` with `overflow: hidden` and `aria-hidden`, not
 * `display: none`, so the width transition has something to animate and so the
 * reader sees where the thing they just closed went. Its width is
 * `min(14rem, 55%)`: a fixed 16rem — upstream's — is seventy-three per cent of
 * a 220px container, which is a sidebar with a sliver of paper beside it. The
 * percentage is of the PANE, because that is the box this element is laid out
 * in, and it needs no query to be right.
 */
export function Sidebar({ className, children, ...props }: ComponentProps<'div'>) {
  const { open } = useSidebar()
  return (
    <div
      data-slot="sidebar"
      data-state={open ? 'expanded' : 'collapsed'}
      data-collapsible="offcanvas"
      aria-hidden={!open}
      className={cn(
        'shrink-0 overflow-hidden transition-[width] duration-200 ease-linear',
        open ? 'w-[min(14rem,55%)]' : 'w-0',
        className,
      )}
      {...props}
    >
      {/* A width of its own, so the rows do not reflow line by line while the
          panel is animating shut. `max-w-full` keeps it inside the parent's
          clip; there is deliberately no `vw` anywhere here, because a viewport
          unit asks about the monitor and this element is sized by its container. */}
      <div className="flex h-full w-[14rem] max-w-full flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] text-[var(--sidebar-foreground)]">
        {children}
      </div>
    </div>
  )
}

export function SidebarHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="sidebar-header" className={cn('flex flex-col gap-1 p-2', className)} {...props} />
}

export function SidebarContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn('flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2', className)}
      {...props}
    />
  )
}

export function SidebarGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="sidebar-group" className={cn('flex w-full min-w-0 flex-col', className)} {...props} />
}

export function SidebarGroupLabel({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        'px-2 py-1 text-[0.65rem] font-medium tracking-wide text-[var(--sidebar-foreground)]/60 uppercase',
        className,
      )}
      {...props}
    />
  )
}

export function SidebarMenu({ className, ...props }: ComponentProps<'ul'>) {
  return <ul data-slot="sidebar-menu" className={cn('flex w-full min-w-0 flex-col gap-0.5', className)} {...props} />
}

export function SidebarMenuItem({ className, ...props }: ComponentProps<'li'>) {
  return <li data-slot="sidebar-menu-item" className={cn('relative min-w-0', className)} {...props} />
}

/**
 * One pressable row.
 *
 * `whitespace-normal` and `overflow-wrap: anywhere`, against upstream's
 * `truncate`, and for this codebase's own rule rather than taste: NOTHING IS
 * TRUNCATED. A section titled "One thing the app can do, one place it is
 * recorded" clipped to a 130px column reads "One thing the" — and so does the
 * section under it. A reader choosing between two identical stubs is worse off
 * than a reader with a row two lines tall.
 */
export function SidebarMenuButton({
  className,
  isActive,
  ...props
}: ComponentProps<'button'> & { isActive?: boolean }) {
  return (
    <button
      type="button"
      data-slot="sidebar-menu-button"
      data-active={isActive ? 'true' : undefined}
      className={cn(
        'flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left text-[0.75rem] leading-snug',
        'transition-colors [overflow-wrap:anywhere] whitespace-normal',
        'hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-accent-foreground)]',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        'data-[active=true]:bg-[var(--sidebar-accent)] data-[active=true]:font-medium',
        className,
      )}
      {...props}
    />
  )
}

/** The rest of the container, beside the sidebar. `min-w-0` or a wide child wins. */
export function SidebarInset({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="sidebar-inset" className={cn('flex min-w-0 flex-1 flex-col', className)} {...props} />
  )
}

/** The one control that opens and closes it. */
export function SidebarTrigger({ className, onClick, ...props }: ComponentProps<typeof Button>) {
  const { open, toggle } = useSidebar()
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-container"
      aria-expanded={open}
      aria-label={open ? 'Hide sections' : 'Show sections'}
      className={className}
      onClick={(event) => {
        onClick?.(event)
        toggle()
      }}
      {...props}
    >
      <PanelLeft className="size-3.5" />
    </Button>
  )
}
