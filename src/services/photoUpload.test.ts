import { afterEach, describe, expect, it, vi } from 'vitest'
import { UPLOAD_MAX_SIDE, decodePhotoFile } from './photoUpload'

const BITMAP = { width: 4000, height: 3000, close: vi.fn() }

function stubBitmap(bitmap: unknown, impl?: () => Promise<unknown>): void {
  vi.stubGlobal(
    'createImageBitmap',
    impl ?? vi.fn(async () => bitmap),
  )
}

function stubContext(drawImage = vi.fn()): void {
  vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('decodePhotoFile', () => {
  it('downscales the longest side to the upload cap', async () => {
    stubBitmap(BITMAP)
    const drawImage = vi.fn()
    stubContext(drawImage)
    const canvas = await decodePhotoFile(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    expect(canvas.width).toBe(UPLOAD_MAX_SIDE)
    expect(canvas.height).toBe(1440)
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(BITMAP.close).toHaveBeenCalled()
  })

  it('never upscales small photos', async () => {
    stubBitmap({ width: 640, height: 480 })
    stubContext()
    const canvas = await decodePhotoFile(new File(['x'], 'small.png', { type: 'image/png' }))
    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(480)
  })

  it('rejects with a user-facing message for unreadable files', async () => {
    stubBitmap(null, async () => {
      throw new Error('decode failed')
    })
    stubContext()
    await expect(decodePhotoFile(new File(['x'], 'bad.jpg'))).rejects.toThrow(
      'Could not read that photo',
    )
  })

  it('rejects when no 2d context is available', async () => {
    stubBitmap({ width: 100, height: 100 })
    vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(decodePhotoFile(new File(['x'], 'a.png'))).rejects.toThrow(
      'Could not read that photo',
    )
  })
})
