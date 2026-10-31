import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { resolveKeyboardShift, useKeyboardShift } from './useKeyboardShift'

/** Fake VirtualKeyboard: dispatching sets event.target to this object. */
class FakeVirtualKeyboard extends EventTarget {
  overlaysContent = false
  boundingRect = { height: 0 }

  open(height: number): void {
    this.boundingRect = { height }
    this.dispatchEvent(new Event('geometrychange'))
  }

  close(): void {
    this.open(0)
  }
}

/** Fake visualViewport with scripted resizes. */
class FakeVisualViewport extends EventTarget {
  height: number
  width: number
  scale: number

  constructor(height: number, width: number, scale = 1) {
    super()
    this.height = height
    this.width = width
    this.scale = scale
  }

  resize(height: number, width: number = this.width): void {
    this.height = height
    this.width = width
    this.dispatchEvent(new Event('resize'))
  }
}

const originalVkDescriptor = Object.getOwnPropertyDescriptor(navigator, 'virtualKeyboard')
const originalVvDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')

function installVirtualKeyboard(value: unknown): void {
  Object.defineProperty(navigator, 'virtualKeyboard', {
    value,
    configurable: true,
    writable: true,
  })
}

function clearVirtualKeyboard(): void {
  try {
    delete (navigator as unknown as Record<string, unknown>).virtualKeyboard
  } catch {
    // Non-configurable host property; shadow it below instead.
  }
  if ('virtualKeyboard' in navigator) {
    installVirtualKeyboard(undefined)
  }
}

function installVisualViewport(value: unknown): void {
  Object.defineProperty(window, 'visualViewport', {
    value,
    configurable: true,
    writable: true,
  })
}

function clearVisualViewport(): void {
  try {
    delete (window as unknown as Record<string, unknown>).visualViewport
  } catch {
    // Non-configurable host property; shadow it below instead.
  }
  if ((window as unknown as Record<string, unknown>).visualViewport != null) {
    installVisualViewport(null)
  }
}

const originalInnerHeight = window.innerHeight

function setInnerHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  clearVirtualKeyboard()
  clearVisualViewport()
})

afterEach(() => {
  if (originalVkDescriptor !== undefined) {
    Object.defineProperty(navigator, 'virtualKeyboard', originalVkDescriptor)
  } else {
    clearVirtualKeyboard()
  }
  if (originalVvDescriptor !== undefined) {
    Object.defineProperty(window, 'visualViewport', originalVvDescriptor)
  } else {
    clearVisualViewport()
  }
  setInnerHeight(originalInnerHeight)
  vi.restoreAllMocks()
})

describe('useKeyboardShift with VirtualKeyboard API', () => {
  it('returns 0 while the keyboard is closed', () => {
    installVirtualKeyboard(new FakeVirtualKeyboard())
    const { result } = renderHook(() => useKeyboardShift())
    expect(result.current).toBe(0)
  })

  it('returns the exact keyboard height when open', () => {
    const vk = new FakeVirtualKeyboard()
    installVirtualKeyboard(vk)
    const { result } = renderHook(() => useKeyboardShift())
    act(() => {
      vk.open(312)
    })
    expect(result.current).toBe(312)
    act(() => {
      vk.open(250)
    })
    expect(result.current).toBe(250)
  })

  it('returns 0 after the keyboard closes', () => {
    const vk = new FakeVirtualKeyboard()
    installVirtualKeyboard(vk)
    const { result } = renderHook(() => useKeyboardShift())
    act(() => {
      vk.open(300)
    })
    expect(result.current).toBe(300)
    act(() => {
      vk.close()
    })
    expect(result.current).toBe(0)
  })

  it('syncs an already-open keyboard at mount', () => {
    const vk = new FakeVirtualKeyboard()
    vk.boundingRect = { height: 275 }
    installVirtualKeyboard(vk)
    const { result } = renderHook(() => useKeyboardShift())
    expect(result.current).toBe(275)
  })

  it('sets overlaysContent on mount and restores it on unmount', () => {
    const vk = new FakeVirtualKeyboard()
    installVirtualKeyboard(vk)
    const { unmount } = renderHook(() => useKeyboardShift())
    expect(vk.overlaysContent).toBe(true)
    unmount()
    expect(vk.overlaysContent).toBe(false)
  })

  it('removes the geometrychange listener on unmount', () => {
    const vk = new FakeVirtualKeyboard()
    installVirtualKeyboard(vk)
    const removeSpy = vi.spyOn(vk, 'removeEventListener')
    const { unmount } = renderHook(() => useKeyboardShift())
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('geometrychange', expect.any(Function))
  })

  it('still tracks geometry when overlaysContent cannot be set', () => {
    const vk = new FakeVirtualKeyboard()
    Object.defineProperty(vk, 'overlaysContent', {
      get: () => false,
      set: () => {
        throw new Error('read-only')
      },
      configurable: true,
    })
    installVirtualKeyboard(vk)
    const { result, unmount } = renderHook(() => useKeyboardShift())
    act(() => {
      vk.open(123)
    })
    expect(result.current).toBe(123)
    expect(() => unmount()).not.toThrow()
  })

  it('prefers VirtualKeyboard over visualViewport', () => {
    const vk = new FakeVirtualKeyboard()
    const vv = new FakeVisualViewport(800, 400)
    installVirtualKeyboard(vk)
    installVisualViewport(vv)
    const { result } = renderHook(() => useKeyboardShift())
    act(() => {
      vv.resize(400)
    })
    expect(result.current).toBe(0)
    act(() => {
      vk.open(200)
    })
    expect(result.current).toBe(200)
  })
})

describe('useKeyboardShift with visualViewport fallback', () => {
  function renderWithViewport(viewportHeight = 800, width = 400, innerHeight = 800) {
    setInnerHeight(innerHeight)
    const vv = new FakeVisualViewport(viewportHeight, width)
    installVisualViewport(vv)
    const hook = renderHook(() => useKeyboardShift())
    return { vv, ...hook }
  }

  it('ignores a viewport shim without addEventListener', () => {
    setInnerHeight(800)
    installVisualViewport({ height: 400, width: 400, scale: 1 } as VisualViewport)
    const { result } = renderHook(() => useKeyboardShift())
    expect(result.current).toBe(0)
  })

  it('lifts by the occluded strip when the keyboard overlays', () => {
    const { result, vv } = renderWithViewport()
    expect(result.current).toBe(0)
    act(() => {
      vv.resize(500)
    })
    expect(result.current).toBe(300)
    act(() => {
      vv.resize(800)
    })
    expect(result.current).toBe(0)
  })

  it('syncs an already-open keyboard at mount', () => {
    const { result } = renderWithViewport(500, 400, 800)
    expect(result.current).toBe(300)
  })

  it('stays at 0 when browser chrome shows or hides', () => {
    const { result, vv } = renderWithViewport()
    act(() => {
      setInnerHeight(700)
      vv.resize(700)
    })
    expect(result.current).toBe(0)
    act(() => {
      setInnerHeight(800)
      vv.resize(800)
    })
    expect(result.current).toBe(0)
  })

  it('stays at 0 when the keyboard resizes the layout viewport', () => {
    // resizes-content behavior: the shrunken root already keeps the dock
    // visible, so an extra lift would double-compensate.
    const { result, vv } = renderWithViewport()
    act(() => {
      setInnerHeight(500)
      vv.resize(500)
    })
    expect(result.current).toBe(0)
  })

  it('stays at 0 across rotation and tracks the keyboard after it', () => {
    const { result, vv } = renderWithViewport(800, 400, 800)
    act(() => {
      setInnerHeight(400)
      vv.resize(400, 800)
    })
    expect(result.current).toBe(0)
    act(() => {
      vv.resize(200, 800)
    })
    expect(result.current).toBe(200)
  })

  it('clamps when the visual viewport exceeds the layout viewport', () => {
    const { result, vv } = renderWithViewport()
    act(() => {
      vv.resize(900)
    })
    expect(result.current).toBe(0)
  })

  it('removes the resize listener on unmount', () => {
    const { vv, unmount } = renderWithViewport()
    const removeSpy = vi.spyOn(vv, 'removeEventListener')
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('ignores visual shrink while the page is pinch-zoomed', () => {
    setInnerHeight(800)
    const vv = new FakeVisualViewport(800, 400, 2)
    installVisualViewport(vv)
    const { result } = renderHook(() => useKeyboardShift())
    act(() => {
      vv.resize(500)
    })
    expect(result.current).toBe(0)
  })
})

describe('resolveKeyboardShift', () => {
  function box(offsetTop: number, offsetHeight = 0): HTMLElement {
    return { offsetTop, offsetHeight } as HTMLElement
  }

  it('passes small lifts through unchanged', () => {
    // Dock top at 600, header bottom at 100: 500px of headroom.
    expect(resolveKeyboardShift(120, box(600), box(0, 100))).toBe(120)
  })

  it('clamps the lift so the dock top stops at the header bottom', () => {
    expect(resolveKeyboardShift(300, box(250), box(0, 100))).toBe(150)
  })

  it('returns 0 for a closed keyboard', () => {
    expect(resolveKeyboardShift(0, box(600), box(0, 100))).toBe(0)
  })

  it('leaves the lift alone when the layout is unmeasurable', () => {
    // Missing refs (or zero rects in tests): clamping would pin the dock.
    expect(resolveKeyboardShift(120, null, box(0, 100))).toBe(120)
    expect(resolveKeyboardShift(120, box(600), null)).toBe(120)
    expect(resolveKeyboardShift(120, box(0), box(0, 0))).toBe(120)
  })

  it('leaves the lift alone when the dock already overlaps the header', () => {
    expect(resolveKeyboardShift(120, box(50), box(0, 100))).toBe(120)
  })
})

describe('useKeyboardShift without either API', () => {
  it('stays at 0 and unmounts cleanly', () => {
    // Prove the environment is genuinely unsupported before asserting inertia.
    const vk = (navigator as unknown as Record<string, unknown>).virtualKeyboard
    const vkUsable =
      typeof vk === 'object' &&
      vk !== null &&
      'overlaysContent' in vk &&
      typeof (vk as { addEventListener?: unknown }).addEventListener === 'function'
    expect(vkUsable).toBe(false)
    const vv = (window as unknown as Record<string, unknown>).visualViewport
    expect(vv === null || vv === undefined).toBe(true)

    const { result, unmount } = renderHook(() => useKeyboardShift())
    expect(result.current).toBe(0)
    expect(() => unmount()).not.toThrow()
  })
})
