import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDesktopLayout } from './useDesktopLayout'

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

function installMatchMedia(matches: boolean): {
  listeners: Set<(e: { matches: boolean }) => void>
  list: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
} {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  const list = {
    matches,
    addEventListener: vi.fn((_type: string, cb: (e: { matches: boolean }) => void) => {
      listeners.add(cb)
    }),
    removeEventListener: vi.fn((_type: string, cb: (e: { matches: boolean }) => void) => {
      listeners.delete(cb)
    }),
  }
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn(() => list),
    configurable: true,
    writable: true,
  })
  return { listeners, list }
}

function emit(listeners: Set<(e: { matches: boolean }) => void>, matches: boolean): void {
  act(() => {
    for (const cb of [...listeners]) cb({ matches } as MediaQueryListEvent)
  })
}

afterEach(() => {
  if (originalMatchMedia !== undefined) {
    Object.defineProperty(window, 'matchMedia', originalMatchMedia)
  } else {
    delete (window as unknown as Record<string, unknown>)['matchMedia']
  }
  vi.restoreAllMocks()
})

describe('useDesktopLayout', () => {
  it('defaults to the mobile layout when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    const { result } = renderHook(() => useDesktopLayout())
    expect(result.current).toBe(false)
  })

  it('reflects a desktop viewport at mount', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useDesktopLayout())
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1024px)')
    expect(result.current).toBe(true)
  })

  it('reflects a mobile viewport at mount', () => {
    installMatchMedia(false)
    const { result } = renderHook(() => useDesktopLayout())
    expect(result.current).toBe(false)
  })

  it('follows viewport crossings after mount', () => {
    const { listeners } = installMatchMedia(false)
    const { result } = renderHook(() => useDesktopLayout())
    expect(result.current).toBe(false)
    emit(listeners, true)
    expect(result.current).toBe(true)
    emit(listeners, false)
    expect(result.current).toBe(false)
  })

  it('removes the change listener on unmount', () => {
    const { list } = installMatchMedia(false)
    const { unmount } = renderHook(() => useDesktopLayout())
    expect(list.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    unmount()
    expect(list.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('stays inert when addEventListener is missing', () => {
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => ({ matches: true })),
      configurable: true,
      writable: true,
    })
    const { result, unmount } = renderHook(() => useDesktopLayout())
    expect(result.current).toBe(true)
    expect(() => unmount()).not.toThrow()
  })
})
