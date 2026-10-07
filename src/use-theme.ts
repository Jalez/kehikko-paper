import { useEffect, useState } from 'react'

/**
 * Light or dark, read off the document.
 *
 * The host says which with every context and `use-paper.ts` puts a class on
 * the root; `main.tsx` does the same from the system setting when nothing has
 * spoken. The editor needs it as a VALUE — CodeMirror's theme is an extension,
 * not a stylesheet — so this watches the one place both of those write.
 */
export function useTheme(): 'light' | 'dark' {
  const read = () => (typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  const [theme, setTheme] = useState<'light' | 'dark'>(read)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const watch = new MutationObserver(() => setTheme(read()))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    setTheme(read())
    return () => watch.disconnect()
  }, [])
  return theme
}
