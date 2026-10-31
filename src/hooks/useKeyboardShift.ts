import { useEffect, useState } from 'react'

/**
 * Minimal structural shape of the VirtualKeyboard API
 * (https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard).
 * Declared locally because the TS DOM lib has no VirtualKeyboard types.
 */
interface MinimalVirtualKeyboard {
  overlaysContent: boolean
  readonly boundingRect?: { readonly height: number }
  addEventListener(type: 'geometrychange', listener: (event: Event) => void): void
  removeEventListener(type: 'geometrychange', listener: (event: Event) => void): void
}

function isMinimalVirtualKeyboard(value: unknown): value is MinimalVirtualKeyboard {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<MinimalVirtualKeyboard>
  return (
    'overlaysContent' in candidate &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  )
}

function getVirtualKeyboard(): MinimalVirtualKeyboard | undefined {
  if (typeof navigator === 'undefined') return undefined
  if (!('virtualKeyboard' in navigator)) return undefined
  const vk = (navigator as Navigator & { virtualKeyboard?: unknown }).virtualKeyboard
  return isMinimalVirtualKeyboard(vk) ? vk : undefined
}

function readGeometryHeight(event: Event): number {
  const target = event.target as { boundingRect?: { height?: unknown } } | null
  const height = target?.boundingRect?.height
  return typeof height === 'number' && Number.isFinite(height) ? Math.max(0, height) : 0
}

/**
 * Clamps a raw keyboard lift so the dock's top edge never rises above the
 * header's bottom edge (both in the pane's offset coordinates, which ignore
 * the lift transform itself). Unmeasurable layouts (missing refs, zero
 * rects) and already-overlapping docks pass the lift through unchanged.
 */
export function resolveKeyboardShift(
  shift: number,
  dock: Pick<HTMLElement, 'offsetTop'> | null,
  header: Pick<HTMLElement, 'offsetTop' | 'offsetHeight'> | null,
): number {
  if (!(shift > 0)) return 0
  if (!dock || !header) return shift
  const maxShift = dock.offsetTop - (header.offsetTop + header.offsetHeight)
  if (!(maxShift > 0)) return shift
  return Math.min(shift, maxShift)
}

/**
 * Returns how far (px) the bottom dock must lift above the on-screen
 * keyboard. Returns 0 when the keyboard is closed or unsupported.
 */
export function useKeyboardShift(): number {
  const [shift, setShift] = useState(0)

  useEffect(() => {
    // (1) PRIMARY: VirtualKeyboard API.
    const vk = getVirtualKeyboard()
    if (vk !== undefined) {
      let didSetOverlay = false
      try {
        vk.overlaysContent = true
        didSetOverlay = true
      } catch {
        didSetOverlay = false
      }
      // Sync in case the keyboard is already open at mount.
      const initialHeight = vk.boundingRect?.height ?? 0
      if (initialHeight > 0) setShift(initialHeight)

      const onGeometryChange = (event: Event) => {
        setShift(readGeometryHeight(event))
      }
      vk.addEventListener('geometrychange', onGeometryChange)
      return () => {
        vk.removeEventListener('geometrychange', onGeometryChange)
        if (didSetOverlay) {
          try {
            vk.overlaysContent = false
          } catch {
            // Host dropped the API mid-session; nothing to restore.
          }
        }
      }
    }

    // (2) FALLBACK: the strip of the layout viewport the keyboard covers.
    // Reading innerHeight against visualViewport.height separates a keyboard
    // overlay (visual shrinks, layout holds) from chrome show/hide, rotation,
    // and desktop resizes (both move together → 0) and from resizes-content
    // keyboards (both shrink → the shrunken root already shows the dock).
    if (typeof window !== 'undefined') {
      const viewport: VisualViewport | null | undefined = window.visualViewport
      // Exotic shims may expose dimensions without the listener interface.
      if (
        viewport !== null &&
        viewport !== undefined &&
        typeof viewport.addEventListener === 'function'
      ) {
        const sync = () => {
          // Pinch page-zoom also shrinks the visual viewport; only a
          // scale-1 shrink is a keyboard overlay.
          if (viewport.scale !== 1) {
            setShift(0)
            return
          }
          setShift(Math.max(0, window.innerHeight - viewport.height))
        }
        sync()
        viewport.addEventListener('resize', sync)
        return () => {
          viewport.removeEventListener('resize', sync)
        }
      }
    }

    // (3) Neither API: no shift.
    return undefined
  }, [])

  return shift
}
