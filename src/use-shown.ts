import { useEffect, useState } from 'react'

/**
 * Whether this page is on a screen somebody is looking at (2.8.0): what the page's own asking of
 * its server waits on (`use-changes.ts`).
 *
 * `document.visibilityState` alone is not it inside Kehikot. A host keeps the page of a folded
 * container, and of a kehikko the person switched away from, running and hidden — and the page of
 * a hidden frame still says `visible`. So three things are asked, and all must hold:
 *
 * - **`hidden` is false**: what the host's context says — this container folded, or the canvas on
 *   "All epics", under which an epic's paper is covered. The caller reads it (`use-paper.ts`).
 * - **The page has a size.** A host draws the page of a container that is not on the open kehikko
 *   at no size at all; `innerWidth` and `innerHeight` are 0 there, and a `resize` says when.
 * - **Its document is visible**: the window or tab is not hidden.
 *
 * Not asked (#88, after #56 and #70): whether an `IntersectionObserver` on the page's own root sees
 * it. Inside the desktop app's WebKit view a cross-origin frame's observer could report the page off
 * screen once and never again, and the container sat in plain view holding no suggestions. What it
 * saved was one idle stream for a container scrolled out of the canvas.
 */
export function useShown(hidden: boolean): boolean {
  const [sized, setSized] = useState(hasSize)
  const [visible, setVisible] = useState(isVisible)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const sizeNow = () => setSized(hasSize())
    const visibleNow = () => setVisible(isVisible())
    window.addEventListener('resize', sizeNow)
    document.addEventListener('visibilitychange', visibleNow)
    sizeNow()
    visibleNow()
    return () => {
      window.removeEventListener('resize', sizeNow)
      document.removeEventListener('visibilitychange', visibleNow)
    }
  }, [])

  return !hidden && sized && visible
}

function hasSize(): boolean {
  if (typeof window === 'undefined') return true
  return window.innerWidth > 0 && window.innerHeight > 0
}

function isVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}
