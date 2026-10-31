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

// Script-driven Image double for the decodeViaElement fallback: the test
// fires onload/onerror itself since happy-dom never loads blob URLs.
class FakeImage {
  static instances: FakeImage[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width = 640
  height = 480
  src = ''

  constructor() {
    FakeImage.instances.push(this)
  }
}

function stubElementFallback(revokeObjectURL = vi.fn()): void {
  FakeImage.instances = []
  vi.stubGlobal('createImageBitmap', undefined)
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL })
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

  it('rejects files over 25MB before decoding', async () => {
    const createImageBitmap = vi.fn(async () => BITMAP)
    vi.stubGlobal('createImageBitmap', createImageBitmap)
    stubContext()
    const file = new File(['x'], 'huge.jpg', { type: 'image/jpeg' })
    Object.defineProperty(file, 'size', { value: 25 * 1024 * 1024 + 1 })
    await expect(decodePhotoFile(file)).rejects.toThrow('Could not read that photo')
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('decodes files exactly at the 25MB cap', async () => {
    stubBitmap(BITMAP)
    stubContext()
    const file = new File(['x'], 'edge.jpg', { type: 'image/jpeg' })
    Object.defineProperty(file, 'size', { value: 25 * 1024 * 1024 })
    const canvas = await decodePhotoFile(file)
    expect(canvas.width).toBe(UPLOAD_MAX_SIDE)
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

  it('decodes via an <img> element when createImageBitmap is unavailable', async () => {
    const revokeObjectURL = vi.fn()
    stubElementFallback(revokeObjectURL)
    const drawImage = vi.fn()
    stubContext(drawImage)
    const pending = decodePhotoFile(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    expect(FakeImage.instances).toHaveLength(1)
    expect(FakeImage.instances[0].src).toBe('blob:photo')
    FakeImage.instances[0].onload?.()
    const canvas = await pending
    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(480)
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo')
  })

  it('revokes the object URL when the <img> fallback fails to decode', async () => {
    const revokeObjectURL = vi.fn()
    stubElementFallback(revokeObjectURL)
    stubContext()
    const pending = decodePhotoFile(new File(['x'], 'bad.jpg'))
    const assertion = expect(pending).rejects.toThrow('Could not read that photo')
    expect(FakeImage.instances).toHaveLength(1)
    FakeImage.instances[0].onerror?.()
    await assertion
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo')
  })

  it('rejects zero-dimension sources and still closes them', async () => {
    const close = vi.fn()
    stubBitmap({ width: 0, height: 480, close })
    stubContext()
    await expect(decodePhotoFile(new File(['x'], 'empty.png'))).rejects.toThrow(
      'Could not read that photo',
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('rejects when drawing the still throws, still closing the source', async () => {
    const close = vi.fn()
    stubBitmap({ width: 100, height: 100, close })
    stubContext(
      vi.fn(() => {
        throw new Error('draw failed')
      }),
    )
    await expect(decodePhotoFile(new File(['x'], 'a.png'))).rejects.toThrow(
      'Could not read that photo',
    )
    expect(close).toHaveBeenCalledTimes(1)
  })
})
