import { useEffect, useState } from 'react'

/** Matches Tailwind's `lg` breakpoint: the desktop 2/3 feed + 1/3 panel split. */
const DESKTOP_QUERY = '(min-width: 1024px)'

function matchesDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DESKTOP_QUERY).matches
  )
}

/**
 * True once the viewport reaches the desktop layout breakpoint. Scanner uses
 * this to mount the sidebar (and unmount the bottom-docked card) so the
 * guidance card exists exactly once — never duplicated across dock + panel.
 * Defaults to the mobile layout when matchMedia is unavailable.
 */
export function useDesktopLayout(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(matchesDesktop)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(DESKTOP_QUERY)
    setIsDesktop(list.matches)
    if (typeof list.addEventListener !== 'function') return
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])

  return isDesktop
}
