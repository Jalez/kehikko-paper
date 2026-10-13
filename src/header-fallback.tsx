import type { HeaderItemInput } from 'kehikot-module-protocol'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * The header's items, for a page whose host draws no header.
 *
 * ## Why this exists at all
 *
 * Everything this page used to have in a toolbar is declared to the host now
 * (`header.ts`) and drawn in the container's own row. Two pages have nobody to
 * draw it: one opened by its address, and one framed by a host older than the
 * header. The first can be told (`where`). The second cannot: the greeting
 * carries the wire protocol's whole number and nothing about what a host
 * draws, and a host that does not know `kehikot.header` drops it in silence.
 *
 * So: ONE control, twenty pixels square, laid over the top right corner of the
 * page where it takes no row, with the same items behind it and the same
 * handler the host's presses reach. It is there on a page nobody frames, and
 * on a framed page until a press has arrived from a host — which only a host
 * that draws the header sends. That is remembered (`headerDrawn`), so on such
 * a host it is gone from the first press on, for good.
 *
 * It is not the host's menus copied: no Radix, no portal, a plain panel under
 * a button. Long lists are a native select, which is the one control that
 * holds sixty sections in a container 220 pixels wide.
 */

const DRAWN_KEY = 'kehikot.paper.header-drawn'

/** Whether a host has ever pressed a header item on this page's origin: such a host draws the header. */
export function headerDrawn(): boolean {
  try {
    return window.localStorage.getItem(DRAWN_KEY) === 'yes'
  } catch {
    return false
  }
}

export function rememberHeaderDrawn(): void {
  try {
    window.localStorage.setItem(DRAWN_KEY, 'yes')
  } catch {
    /* It is hidden for this page's life all the same. */
  }
}

type Press = (press: { item: string; value?: string | boolean }) => unknown

const MENUS = [
  { title: 'View', kinds: ['switch', 'toggle'] },
  { title: 'Go', kinds: ['go'] },
  { title: 'Run', kinds: ['run'] },
] as const

/** More options than this are a select rather than a row each. */
const INLINE = 4

const ROW = 'hover:bg-accent flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left disabled:opacity-50'

export function HeaderFallback({ items, onPress }: { items: readonly HeaderItemInput[]; onPress: Press }) {
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) {
      setArmed(null)
      return
    }
    const away = (event: Event) => {
      if (box.current && event.target instanceof Node && box.current.contains(event.target)) return
      setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', away)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', away)
    }
  }, [open])

  if (!items.length) return null
  const busy = items.some((item) => item.kind === 'run' && item.state === 'busy')
  const failed = !busy && items.some((item) => item.kind === 'run' && item.state === 'failed')

  return (
    <div ref={box} className="absolute top-0.5 right-0.5 z-40 text-[0.72rem]" data-header-fallback>
      <button
        type="button"
        aria-label={`Menu${busy ? ' — running' : failed ? ' — the last run failed' : ''}`}
        aria-expanded={open}
        title="View, go and run"
        className={cn(
          'bg-background/90 hover:bg-accent relative flex size-5 items-center justify-center rounded border leading-none',
          failed && 'text-(--gone)',
        )}
        onClick={() => setOpen((was) => !was)}
      >
        ⋯
        {busy || failed ? (
          <span className={cn('absolute -top-0.5 -right-0.5 size-1.5 rounded-full', failed ? 'bg-(--gone)' : 'bg-foreground animate-pulse')} aria-hidden />
        ) : null}
      </button>
      {open && (
        <div role="menu" className="bg-background absolute top-full right-0 mt-0.5 max-h-[80cqh] w-56 max-w-[calc(100cqw-1rem)] overflow-auto rounded border p-1 shadow-md">
          {MENUS.map((menu) => {
            const mine = items.filter((item) => (menu.kinds as readonly string[]).includes(item.kind))
            if (!mine.length) return null
            return (
              <div key={menu.title} role="group" aria-label={menu.title} className="border-b py-0.5 last:border-b-0">
                <p className="text-muted-foreground px-1.5 text-[0.65rem]">{menu.title}</p>
                {mine.map((item) => (
                  <Rows
                    key={item.id}
                    item={item}
                    armed={armed === item.id}
                    onArm={setArmed}
                    onPress={(press, stay) => {
                      setArmed(null)
                      if (!stay) setOpen(false)
                      void onPress(press)
                    }}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Rows({
  item,
  armed,
  onArm,
  onPress,
}: {
  item: HeaderItemInput
  armed: boolean
  onArm(id: string | null): void
  onPress(press: { item: string; value?: string | boolean }, stay?: boolean): void
}) {
  if (item.kind === 'toggle') {
    return (
      <button type="button" role="menuitemcheckbox" aria-checked={item.checked} className={ROW} data-item={item.id} onClick={() => onPress({ item: item.id, value: !item.checked }, true)}>
        <span className="w-3 shrink-0">{item.checked ? '✓' : ''}</span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </button>
    )
  }
  if (item.kind === 'run') {
    const busy = item.state === 'busy'
    return (
      <button
        type="button"
        role="menuitem"
        className={cn(ROW, armed && 'text-(--gone)')}
        data-item={item.id}
        disabled={busy || Boolean(item.disabled)}
        title={item.disabled ?? undefined}
        onClick={() => {
          if (item.confirm && !armed) onArm(item.id)
          else onPress({ item: item.id })
        }}
      >
        <span className="min-w-0 flex-1 truncate">{armed ? 'Press again to confirm' : busy ? `${item.label}…` : item.label}</span>
        {item.result && !armed ? (
          <span className={cn('max-w-28 shrink-0 truncate text-[0.65rem]', item.state === 'failed' ? 'text-(--gone)' : 'text-muted-foreground')} title={item.result}>
            {item.result}
          </span>
        ) : null}
      </button>
    )
  }
  const on = item.kind === 'switch' ? item.value : null
  if (item.options.length > INLINE) {
    return (
      <label className="flex min-w-0 items-center gap-1.5 px-1.5 py-0.5">
        <span className="text-muted-foreground max-w-[45%] shrink-0 truncate" title={item.label}>
          {item.label}
        </span>
        <select
          className="border-input bg-background min-w-0 flex-1 rounded border px-1 py-0.5"
          aria-label={item.label}
          data-item={item.id}
          value={on ?? ''}
          onChange={(event) => event.target.value && onPress({ item: item.id, value: event.target.value }, item.kind === 'switch')}
        >
          {on === null && <option value="">…</option>}
          {item.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <>
      <p className="text-muted-foreground truncate px-1.5 pt-0.5 text-[0.65rem]" title={item.label}>
        {item.label}
      </p>
      {item.options.map((option) => (
        <button
          key={option.id}
          type="button"
          role={on === null ? 'menuitem' : 'menuitemradio'}
          aria-checked={on === null ? undefined : option.id === on}
          className={ROW}
          data-item={item.id}
          data-option={option.id}
          onClick={() => onPress({ item: item.id, value: option.id }, item.kind === 'switch')}
        >
          {on !== null && <span className="w-3 shrink-0">{option.id === on ? '✓' : ''}</span>}
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
        </button>
      ))}
    </>
  )
}
