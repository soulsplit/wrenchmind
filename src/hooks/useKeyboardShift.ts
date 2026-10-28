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
      if (viewport !== null && viewport !== undefined) {
        const sync = () => {
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
