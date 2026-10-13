import { fireEvent } from '@testing-library/react'

/**
 * The page's header items, read and pressed the way a person without a
 * header-drawing host does: through the one small control in the page's corner
 * (`src/header-fallback.tsx`). It draws exactly what was declared to the host
 * and calls the handler the host's presses reach, so a test that presses here
 * is pressing the item — `header-page.test.tsx` is where the messages
 * themselves are driven.
 */

const box = () => document.querySelector<HTMLElement>('[data-header-fallback]')

/** Open the menu if it is closed, and answer its panel. */
export function menu(): HTMLElement {
  const root = box()
  if (!root) throw new Error('this page draws no menu of its own')
  if (!root.querySelector('[role="menu"]')) fireEvent.click(root.querySelector('button')!)
  return root.querySelector<HTMLElement>('[role="menu"]')!
}

/** Whether an item is declared. */
export function has(item: string): boolean {
  return box() !== null && menu().querySelector(`[data-item="${item}"]`) !== null
}

/** The options of a switch or a go item: their ids and their words, in order. */
export function options(item: string): { id: string; label: string; on: boolean }[] {
  const panel = menu()
  const select = panel.querySelector<HTMLSelectElement>(`select[data-item="${item}"]`)
  if (select) return [...select.options].filter((one) => one.value).map((one) => ({ id: one.value, label: one.textContent ?? '', on: select.value === one.value }))
  return [...panel.querySelectorAll<HTMLElement>(`[data-item="${item}"][data-option]`)].map((one) => ({
    id: one.getAttribute('data-option')!,
    label: one.querySelector('span:last-child')?.textContent ?? '',
    on: one.getAttribute('aria-checked') === 'true',
  }))
}

/** The option a switch is on, by its words. */
export const on = (item: string): string | null => options(item).find((one) => one.on)?.label ?? null

/** A run's or a toggle's own row. */
export const row = (item: string): HTMLButtonElement | null => menu().querySelector<HTMLButtonElement>(`button[data-item="${item}"]:not([data-option])`)

/** Press an item: an option by its id or its words, a toggle to the state wanted, a run. */
export function press(item: string, value?: string | boolean): void {
  const panel = menu()
  if (typeof value === 'string') {
    const found = options(item).find((one) => one.id === value || one.label.trim() === value)
    if (!found) throw new Error(`"${item}" has no option ${value}: ${options(item).map((one) => `${one.id} ${one.label}`).join(', ')}`)
    const select = panel.querySelector<HTMLSelectElement>(`select[data-item="${item}"]`)
    if (select) fireEvent.change(select, { target: { value: found.id } })
    else fireEvent.click(panel.querySelector(`[data-item="${item}"][data-option="${found.id}"]`)!)
    return
  }
  const button = row(item)
  if (!button) throw new Error(`no "${item}" in the menu`)
  if (typeof value === 'boolean' && (button.getAttribute('aria-checked') === 'true') === value) return
  fireEvent.click(button)
}

/** Which pane is in front. */
export const pane = (): string | null => document.querySelector('[data-pane]')?.getAttribute('data-pane') ?? null
