import { beforeEach, describe, expect, it, vi } from 'vitest'
import { identifyWithContext } from './feedStage'
import { cropRegion, extractLabelText, identifyComponent } from './metaApi'

vi.mock('./metaApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metaApi')>()
  return {
    ...actual,
    cropRegion: vi.fn(),
    extractLabelText: vi.fn(),
    identifyComponent: vi.fn(),
  }
})

function sizedVideo(w: number, h: number): HTMLVideoElement {
  const video = document.createElement('video')
  Object.defineProperty(video, 'videoWidth', { value: w, configurable: true })
  Object.defineProperty(video, 'videoHeight', { value: h, configurable: true })
  return video
}

beforeEach(() => {
  vi.mocked(cropRegion).mockReset().mockReturnValue('data:image/jpeg;base64,CROP')
  vi.mocked(identifyComponent).mockReset().mockResolvedValue('M6 hex bolt')
  vi.mocked(extractLabelText).mockReset().mockResolvedValue([])
})

describe('identifyWithContext OCR fusion', () => {
  // 21x21 on a 640x480 frame: well under the 4% small-region threshold.
  const smallBox = { x1: 10, y1: 20, x2: 30, y2: 40 }

  it('names an otherwise-unnamed part from its label markings', async () => {
    vi.mocked(identifyComponent).mockResolvedValue('')
    vi.mocked(extractLabelText).mockResolvedValue(['ABC-123'])
    const video = sizedVideo(640, 480)

    await expect(identifyWithContext(video, smallBox)).resolves.toBe('part labeled "ABC-123"')
    expect(extractLabelText).toHaveBeenCalledWith('data:image/jpeg;base64,CROP')
  })

  it('annotates a small-region label with its markings', async () => {
    vi.mocked(extractLabelText).mockResolvedValue(['8.8'])
    const video = sizedVideo(640, 480)

    await expect(identifyWithContext(video, smallBox)).resolves.toBe('M6 hex bolt — "8.8"')
  })

  it('falls back to the ladder result when OCR fails', async () => {
    vi.mocked(extractLabelText).mockRejectedValue(new Error('ocr down'))
    const video = sizedVideo(640, 480)

    await expect(identifyWithContext(video, smallBox)).resolves.toBe('M6 hex bolt')
  })

  it('returns empty when both the ladder and OCR miss', async () => {
    vi.mocked(identifyComponent).mockResolvedValue('')
    vi.mocked(extractLabelText).mockRejectedValue(new Error('ocr down'))
    const video = sizedVideo(640, 480)

    await expect(identifyWithContext(video, smallBox)).resolves.toBe('')
  })

  it('skips OCR for large regions', async () => {
    const video = sizedVideo(640, 480)

    // 320x240 covers a quarter of the frame: no annotation attempted.
    await expect(identifyWithContext(video, { x1: 0, y1: 0, x2: 319, y2: 239 })).resolves.toBe(
      'M6 hex bolt',
    )
    expect(extractLabelText).not.toHaveBeenCalled()
  })

  it('tries the wide crop when the tight crop fails', async () => {
    vi.mocked(cropRegion).mockReturnValueOnce('').mockReturnValue('data:image/jpeg;base64,WIDE')
    const video = sizedVideo(640, 480)

    await expect(identifyWithContext(video, smallBox)).resolves.toBe('M6 hex bolt')
    expect(cropRegion).toHaveBeenCalledTimes(2)
    expect(vi.mocked(cropRegion).mock.calls[1][2]).toBe(1.0)
    expect(identifyComponent).toHaveBeenCalledWith('data:image/jpeg;base64,WIDE')
    // No tight crop, no OCR source: the wide name stands alone.
    expect(extractLabelText).not.toHaveBeenCalled()
  })

  it('returns empty without OCR when every crop is empty', async () => {
    vi.mocked(cropRegion).mockReturnValue('')
    const video = sizedVideo(640, 480)

    await expect(identifyWithContext(video, smallBox)).resolves.toBe('')
    expect(identifyComponent).not.toHaveBeenCalled()
    expect(extractLabelText).not.toHaveBeenCalled()
  })
})
