import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeCameraError, permissionBlocker, secureContextBlocker } from './mediaSupport'

const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
const originalPermissions = Object.getOwnPropertyDescriptor(navigator, 'permissions')

function restore(prop: 'secure' | 'media' | 'perms'): void {
  if (prop === 'secure') {
    if (originalSecureContext) {
      Object.defineProperty(window, 'isSecureContext', originalSecureContext)
    } else {
      delete (window as unknown as Record<string, unknown>)['isSecureContext']
    }
  }
  if (prop === 'media') {
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
    } else {
      delete (navigator as unknown as Record<string, unknown>)['mediaDevices']
    }
  }
  if (prop === 'perms') {
    if (originalPermissions) {
      Object.defineProperty(navigator, 'permissions', originalPermissions)
    } else {
      delete (navigator as unknown as Record<string, unknown>)['permissions']
    }
  }
}

afterEach(() => {
  restore('secure')
  restore('media')
  restore('perms')
  vi.restoreAllMocks()
})

describe('secureContextBlocker', () => {
  it('reports insecure contexts', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    const message = secureContextBlocker('Camera') ?? ''
    expect(message).toContain('HTTPS')
    expect(message).toContain('localhost')
  })

  it('reports missing media devices', () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    expect(secureContextBlocker('Microphone')).toContain('not available')
  })

  it('returns null when the environment allows media', () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    })
    expect(secureContextBlocker('Camera')).toBeNull()
  })
})

describe('permissionBlocker', () => {
  it('reports a blocked permission', async () => {
    Object.defineProperty(navigator, 'permissions', {
      value: { query: vi.fn(async () => ({ state: 'denied' })) },
      configurable: true,
    })
    await expect(permissionBlocker('camera', 'Camera access')).resolves.toContain(
      'site settings',
    )
  })

  it('returns null when the permission is promptable', async () => {
    Object.defineProperty(navigator, 'permissions', {
      value: { query: vi.fn(async () => ({ state: 'prompt' })) },
      configurable: true,
    })
    await expect(permissionBlocker('camera', 'Camera access')).resolves.toBeNull()
  })

  it('returns null when the Permissions API is missing or throws', async () => {
    Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true })
    await expect(permissionBlocker('camera', 'Camera access')).resolves.toBeNull()
    Object.defineProperty(navigator, 'permissions', {
      value: {
        query: vi.fn(async () => {
          throw new Error('nope')
        }),
      },
      configurable: true,
    })
    await expect(permissionBlocker('microphone', 'Microphone access')).resolves.toBeNull()
  })
})

describe('describeCameraError', () => {
  it('maps a dismissed prompt to the allow-again message', () => {
    expect(describeCameraError(new DOMException('dismissed', 'NotAllowedError'))).toContain(
      'tap Allow',
    )
  })

  it('maps busy hardware to the close-other-tabs message', () => {
    expect(describeCameraError(new DOMException('busy', 'NotReadableError'))).toContain(
      'Camera is busy',
    )
  })

  it('maps missing hardware to the no-camera message', () => {
    expect(describeCameraError(new DOMException('none', 'NotFoundError'))).toContain(
      'No usable camera',
    )
    expect(describeCameraError(new DOMException('none', 'OverconstrainedError'))).toContain(
      'No usable camera',
    )
  })

  it('keeps the legacy generic message for unknown shapes', () => {
    expect(describeCameraError(new Error('denied'))).toBe('Camera access denied')
    expect(describeCameraError(null)).toBe('Camera access denied')
    expect(describeCameraError('nope')).toBe('Camera access denied')
  })
})
