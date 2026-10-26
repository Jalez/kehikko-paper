import { useEffect, useState } from 'react'

/**
 * Whether this page is on a screen somebody is looking at (2.8.0): what the page's own asking of
 * its server waits on (`use-changes.ts`).
 *
 * `document.visibilityState` alone is not it inside Kehikot. A host keeps the page of a folded
 * container, and of a kehikko the person switched away from, running and hidden — and the page of
 * a hidden frame still says `visible`. So four things are asked, and all must hold:
 *
 * - **`hidden` is false**: what the host's context says — this container folded, or the canvas on
 *   "All epics", under which an epic's paper is covered. The caller reads it (`use-paper.ts`).
 * - **The page has a size.** A host draws the page of a container that is not on the open kehikko
 *   at no size at all; `innerWidth` and `innerHeight` are 0 there, and a `resize` says when.
 * - **Its document is visible**: the window or tab is not hidden.
 * - **Some of it is on screen** (`IntersectionObserver` on the page's own root): a container
 *   scrolled out of the canvas has none. Where there is no observer, this one counts as on screen.
 */
export function useShown(hidden: boolean): boolean {
  const [sized, setSized] = useState(hasSize)
  const [visible, setVisible] = useState(isVisible)
  const [onScreen, setOnScreen] = useState(true)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const sizeNow = () => setSized(hasSize())
    const visibleNow = () => setVisible(isVisible())
    window.addEventListener('resize', sizeNow)
    document.addEventListener('visibilitychange', visibleNow)
    let observer: IntersectionObserver | null = null
    if (typeof IntersectionObserver === 'function') {
      try {
        observer = new IntersectionObserver((entries) => {
          const last = entries[entries.length - 1]
          if (!last) return
          /* Area, not `isIntersecting`: a page drawn at no size can still touch the viewport's edge. */
          const seen = last.isIntersecting && last.intersectionRect.width > 0 && last.intersectionRect.height > 0
          setOnScreen(seen)
        })
        observer.observe(document.documentElement)
      } catch {
        observer = null
      }
    }
    sizeNow()
    visibleNow()
    return () => {
      window.removeEventListener('resize', sizeNow)
      document.removeEventListener('visibilitychange', visibleNow)
      observer?.disconnect()
    }
  }, [])

  return !hidden && sized && visible && onScreen
}

function hasSize(): boolean {
  if (typeof window === 'undefined') return true
  return window.innerWidth > 0 && window.innerHeight > 0
}

function isVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}
