import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BURST_INTERVAL_MS,
  FRAME_BURST,
  MAX_IDENTIFY_LABEL,
  captureFrameBurst,
  captureThumbnail,
  captureVideoFrame,
  cropRegion,
  extractLabelText,
  hasApiKey,
  identifyComponent,
  reasonSpatial,
  segmentImage,
} from './metaApi'
import { clearLogs, getLogs } from './logger'

const fetchMock = vi.fn()

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const queue = chunks.map((c) => encoder.encode(c))
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> =>
      queue.length > 0
        ? { done: false, value: queue.shift() }
        : { done: true, value: undefined },
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { getReader: () => reader },
  } as unknown as Response
}

function sparkEnvelope(content: string): unknown {
  return { choices: [{ message: { content } }] }
}

function errorResponse(status: number, bodyText: string): Response {
  return { ok: false, status, text: async () => bodyText } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fetchMock.mockReset()
  clearLogs()
})

describe('reasonSpatial', () => {
  it('sends the frame, phrase, and context and returns the parsed result', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'test-key-123')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(
        sparkEnvelope(
          JSON.stringify({
            target_label: 'Blend door',
            approx_x: 40,
            approx_y: 60,
            speech_response: 'Found it',
            display_mode: 'speech_and_visual',
          }),
        ),
      ),
    )

    const result = await reasonSpatial('data:image/jpeg;base64,AAA', 'show blend door', 'ctx')

    expect(result).toEqual({
      target_label: 'Blend door',
      approx_x: 40,
      approx_y: 60,
      speech_response: 'Found it',
      display_mode: 'speech_and_visual',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.meta.ai/v1/chat/completions')
    expect(init.headers['Authorization']).toBe('Bearer test-key-123')
    const body = JSON.parse(init.body) as {
      model: string
      messages: [{ content: string }, { content: [{ text: string }] }]
    }
    expect(body.model).toBe('muse-spark-1.3')
    expect(body.messages[0].content).toContain('approx_x')
    expect(body.messages[1].content[0].text).toContain('show blend door')
  })

  it('clamps coordinates and defaults missing fields', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse(sparkEnvelope(JSON.stringify({ approx_x: 150 }))))

    const result = await reasonSpatial('img', 'phrase', '')
    expect(result).toEqual({
      target_label: '',
      approx_x: 100,
      approx_y: 50,
      speech_response: null,
      display_mode: 'visual_only',
    })
  })

  it('sends a frame burst oldest-first with the last marked current', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(sparkEnvelope(JSON.stringify({ target_label: 'x' }))),
    )

    await reasonSpatial(['a', 'b', 'c'], 'phrase', 'ctx')
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as {
      messages: [{ content: string }, { content: [{ text: string }] }]
    }
    expect(body.messages[1].content[0].text).toContain('Frames: 3 oldest-first, last is current.')
    expect(body.messages[1].content.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: 'a' } },
      { type: 'image_url', image_url: { url: 'b' } },
      { type: 'image_url', image_url: { url: 'c' } },
    ])
  })

  it('parses plural points, clamped and capped', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    const points = [
      { x: 10, y: 20 },
      { x: 150, y: -5 },
      { x: 'nope', y: 30 },
      ...Array.from({ length: 8 }, (_, i) => ({ x: i, y: i })),
    ]
    fetchMock.mockResolvedValue(
      jsonResponse(sparkEnvelope(JSON.stringify({ target_label: 'bolts', points }))),
    )

    const result = await reasonSpatial('img', 'show all bolts', '')
    expect(result.points).toEqual([
      { x: 10, y: 20 },
      { x: 100, y: 0 },
      ...Array.from({ length: 6 }, (_, i) => ({ x: i, y: i })),
    ])
  })

  it('omits points for singular targets and requests them for plural ones', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(sparkEnvelope(JSON.stringify({ target_label: 'x' }))),
    )

    const result = await reasonSpatial('img', 'phrase', '')
    expect(result.points).toBeUndefined()
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as { messages: [{ content: string }] }
    expect(body.messages[0].content).toContain('points')
  })

  it('normalizes a non-string speech response to null', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(sparkEnvelope(JSON.stringify({ target_label: 'x', speech_response: 42 }))),
    )

    const result = await reasonSpatial('img', 'phrase', '')
    expect(result.speech_response).toBeNull()
  })

  it('throws on HTTP errors and invalid JSON', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))
    await expect(reasonSpatial('img', 'p', '')).rejects.toThrow('Muse Spark 500')

    fetchMock.mockResolvedValueOnce(jsonResponse(sparkEnvelope('not json')))
    await expect(reasonSpatial('img', 'p', '')).rejects.toThrow()
  })

  it('includes the server error body in failures, truncated', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(errorResponse(400, '{"error":"unknown field \\"point\\""}'))
    await expect(reasonSpatial('img', 'p', '')).rejects.toThrow(
      'Muse Spark 400: {"error":"unknown field \\"point\\""}',
    )
    expect(getLogs().some((e) => e.message.includes('unknown field'))).toBe(true)

    fetchMock.mockResolvedValueOnce(errorResponse(400, 'x'.repeat(600)))
    await expect(reasonSpatial('img', 'p', '')).rejects.toThrow(/^Muse Spark 400: x{500}$/)

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('no body')
      },
    } as unknown as Response)
    await expect(reasonSpatial('img', 'p', '')).rejects.toThrow('Muse Spark 500')
  })

  it('includes the server error body in SAM failures', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(errorResponse(400, 'bad mask_encoding'))
    await expect(collect(segmentImage('img', 'screw'))).rejects.toThrow(
      'SAM 400: bad mask_encoding',
    )
  })

  it('logs API failures with their status', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))
    await expect(reasonSpatial('img', 'p', '')).rejects.toThrow()
    expect(getLogs().some((e) => e.level === 'error' && e.message.includes('HTTP 500'))).toBe(
      true,
    )
  })
})

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of gen) out.push(item)
  return out
}

describe('extractLabelText', () => {
  it('sends the frame with a transcription prompt and returns findings', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(sparkEnvelope(JSON.stringify({ findings: ['ABC-123', '24V DC'] }))),
    )

    const result = await extractLabelText('data:image/jpeg;base64,AAA')
    expect(result).toEqual(['ABC-123', '24V DC'])
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as {
      model: string
      messages: [{ content: string }, { content: [{ text: string }, { image_url: { url: string } }] }]
    }
    expect(body.model).toBe('muse-spark-1.3')
    expect(body.messages[0].content).toContain('findings')
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,AAA')
  })

  it('demands verbatim transcription with no invented characters', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(sparkEnvelope(JSON.stringify({ findings: ['ABC-123'] }))),
    )

    await extractLabelText('img')
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as {
      messages: [{ content: string }, { content: [{ text: string }] }]
    }
    const system: string = body.messages[0].content
    expect(system).toContain('verbatim')
    expect(system).toContain('never paraphrase')
    expect(system).toContain('invent characters')
    expect(system).toContain('key-value pairs together')
    expect(system).toContain('0/O')
    expect(system).toContain('small print')
    expect(body.messages[1].content[0].text).toContain('verbatim')
  })

  it('sanitizes findings: trims, drops non-strings and empties, caps at 10', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    const findings = ['  padded  ', '', '   ', 42, null, ...Array.from({ length: 12 }, (_, i) => `P-${i}`)]
    fetchMock.mockResolvedValue(jsonResponse(sparkEnvelope(JSON.stringify({ findings }))))

    const result = await extractLabelText('img')
    expect(result).toEqual(['padded', ...Array.from({ length: 9 }, (_, i) => `P-${i}`)])
  })

  it('returns an empty list when findings are missing or malformed', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse(sparkEnvelope(JSON.stringify({}))))
    await expect(extractLabelText('img')).resolves.toEqual([])
    fetchMock.mockResolvedValueOnce(jsonResponse(sparkEnvelope(JSON.stringify({ findings: 'nope' }))))
    await expect(extractLabelText('img')).resolves.toEqual([])
  })

  it('throws on HTTP errors', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'boom'))
    await expect(extractLabelText('img')).rejects.toThrow('Muse Spark 500')
  })
})

describe('segmentImage', () => {
  it('sends a point prompt in token grammar and yields stream events', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"type":"response.output_text.delta","delta":"<0f>"}\n',
        'data: {"type":"response.completed"}\n',
        'data: {"no-type":true}\n',
        'data: not-json\n',
        ': comment\n',
        'data: [DONE]\n',
      ]),
    )

    const events = await collect(
      segmentImage('img', 'screw', { x: 320, y: 120, width: 640, height: 480 }),
    )
    expect(events).toEqual([
      { type: 'response.output_text.delta', delta: '<0f>' },
      { type: 'response.completed' },
    ])
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as {
      model: string
      stream: boolean
      input: [{ content: [{ text: string }] }]
      metadata: Record<string, unknown>
    }
    expect(body.model).toBe('sam-3.1')
    expect(body.stream).toBe(true)
    expect(body.input[0].content[0].text).toBe('<0f>1<|point;x=320;y=120;w=640;h=480|>')
    expect(body.metadata).toEqual({ mask_encoding: 'one_bit' })
  })

  it('sends one object per point when given an array', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(sseResponse([]))

    await collect(
      segmentImage('img', 'bolt', [
        { x: 10, y: 20, width: 640, height: 480 },
        { x: 30, y: 40, width: 640, height: 480 },
      ]),
    )
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as {
      input: [{ content: [{ text: string }] }]
    }
    expect(body.input[0].content[0].text).toBe(
      '<0f>1<|point;x=10;y=20;w=640;h=480|>,2<|point;x=30;y=40;w=640;h=480|>',
    )
  })

  it('sends a bare noun phrase when no point is given', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(sseResponse([]))

    const events = await collect(segmentImage('img', 'screw'))
    expect(events).toEqual([])
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as {
      input: [{ content: [{ text: string }] }]
      metadata: Record<string, unknown>
    }
    expect(body.input[0].content[0].text).toBe('screw')
    expect(body.metadata).toEqual({ mask_encoding: 'one_bit' })
  })

  it('sends a box prompt plus center point for a circled region', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(sseResponse([]))

    await collect(
      segmentImage('img', 'circled part', undefined, {
        x1: 10,
        y1: 20,
        x2: 30,
        y2: 40,
        width: 640,
        height: 480,
      }),
    )
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as {
      input: [{ content: [{ text: string }] }]
    }
    expect(body.input[0].content[0].text).toBe(
      '<0f>1<|box;x1=10;y1=20;x2=30;y2=40;w=640;h=480|><|point;x=20;y=30;w=640;h=480|>',
    )
  })

  it('ignores a degenerate box and falls back to the point prompt', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(sseResponse([]))

    await collect(
      segmentImage(
        'img',
        'screw',
        { x: 320, y: 120, width: 640, height: 480 },
        { x1: 30, y1: 40, x2: 10, y2: 20, width: 640, height: 480 },
      ),
    )
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as {
      input: [{ content: [{ text: string }] }]
    }
    expect(body.input[0].content[0].text).toBe('<0f>1<|point;x=320;y=120;w=640;h=480|>')
  })

  it('throws on HTTP errors', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(sseResponse([], 503))
    await expect(collect(segmentImage('img', 'screw'))).rejects.toThrow('SAM 503')
  })

  it('keeps a trailing SSE line that lacks a newline', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"type":"response.output_text.delta","delta":"tail"}']),
    )
    await expect(collect(segmentImage('img', 'screw'))).resolves.toEqual([
      { type: 'response.output_text.delta', delta: 'tail' },
    ])
  })

  it('throws a clear error when the stream body is missing', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: null } as unknown as Response)
    await expect(collect(segmentImage('img', 'screw'))).rejects.toThrow('SAM empty response')
  })

  it.each<[string, number]>([
    ['reasonSpatial', 30000],
    ['segmentImage', 60000],
  ])('%s aborts hung requests after its timeout', { timeout: 10000 }, async (fn, timeoutMs) => {
    vi.useFakeTimers()
    try {
      vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
      vi.stubGlobal('fetch', fetchMock)
      fetchMock.mockImplementation(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'))
            })
          }),
      )
      const pending =
        fn === 'reasonSpatial' ? reasonSpatial('img', 'p', '') : collect(segmentImage('img', 'screw'))
      const assertion = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(timeoutMs + 1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('hasApiKey', () => {
  it('reflects whether the env var is set', () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    expect(hasApiKey()).toBe(true)
    vi.stubEnv('VITE_META_MODEL_API_KEY', '')
    expect(hasApiKey()).toBe(false)
    vi.stubEnv('VITE_META_MODEL_API_KEY', undefined)
    expect(hasApiKey()).toBe(false)
  })
})

describe('captureFrameBurst', () => {
  it('spaces captures by the interval and drops empty frames', async () => {
    vi.useFakeTimers()
    try {
      const video = document.createElement('video')
      let resolved: string[] | null = null
      const pending = captureFrameBurst(video, 3, 300).then((frames) => {
        resolved = frames
      })
      await vi.advanceTimersByTimeAsync(599)
      expect(resolved).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(resolved).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults to the configured burst size and interval', async () => {
    vi.useFakeTimers()
    try {
      const video = document.createElement('video')
      const start = Date.now()
      const pending = captureFrameBurst(video)
      await vi.advanceTimersByTimeAsync((FRAME_BURST - 1) * BURST_INTERVAL_MS)
      await pending
      expect(Date.now() - start).toBe((FRAME_BURST - 1) * BURST_INTERVAL_MS)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('captureVideoFrame', () => {
  it('returns empty string when no frame is available', () => {
    const video = document.createElement('video')
    expect(captureVideoFrame(video)).toBe('')
    expect(
      captureVideoFrame({ videoWidth: 0, videoHeight: 480 } as HTMLVideoElement),
    ).toBe('')
    expect(
      captureVideoFrame({ videoWidth: 640, videoHeight: 0 } as HTMLVideoElement),
    ).toBe('')
  })

  it('captures a frame as a JPEG data URL', () => {
    const drawImage = vi.fn()
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    try {
      const video = document.createElement('video')
      Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true })
      expect(captureVideoFrame(video)).toBe('data:image/jpeg;base64,')
      expect(drawImage).toHaveBeenCalledTimes(1)
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('downscales 4K frames to 1920 on the longest side', () => {
    const drawImage = vi.fn()
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    try {
      const video = document.createElement('video')
      Object.defineProperty(video, 'videoWidth', { value: 3840, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 2160, configurable: true })
      captureVideoFrame(video)
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080)
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('passes smaller frames through uncapped', () => {
    const drawImage = vi.fn()
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    try {
      const video = document.createElement('video')
      Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true })
      captureVideoFrame(video)
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720)
    } finally {
      ctxSpy.mockRestore()
    }
  })
})

describe('captureThumbnail', () => {
  it('returns empty string when no frame is available', () => {
    const video = document.createElement('video')
    expect(captureThumbnail(video)).toBe('')
  })

  it('downscales the frame to the max width', () => {
    const drawImage = vi.fn()
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    try {
      const video = document.createElement('video')
      Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true })
      expect(captureThumbnail(video)).toBe('data:image/jpeg;base64,')
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 240)
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('never upscales small frames', () => {
    const drawImage = vi.fn()
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    try {
      const video = document.createElement('video')
      Object.defineProperty(video, 'videoWidth', { value: 160, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 120, configurable: true })
      captureThumbnail(video)
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 160, 120)
    } finally {
      ctxSpy.mockRestore()
    }
  })
})

describe('cropRegion', () => {
  function sizedVideo(w: number, h: number): HTMLVideoElement {
    const video = document.createElement('video')
    Object.defineProperty(video, 'videoWidth', { value: w, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: h, configurable: true })
    return video
  }

  it('returns empty string when no frame is available', () => {
    expect(cropRegion(document.createElement('video'), { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(
      '',
    )
    expect(
      cropRegion(sizedVideo(0, 480), { x1: 0, y1: 0, x2: 10, y2: 10 }),
    ).toBe('')
  })

  it('crops the padded box with a 9-arg drawImage', () => {
    const drawImage = vi.fn()
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    try {
      const video = sizedVideo(640, 480)
      expect(cropRegion(video, { x1: 100, y1: 100, x2: 199, y2: 199 })).toBe(
        'data:image/jpeg;base64,',
      )
      // 100x100 box with 20% padding grows 20px on every side.
      expect(drawImage).toHaveBeenCalledWith(video, 80, 80, 140, 140, 0, 0, 140, 140)
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('clamps padding at the frame edges', () => {
    const drawImage = vi.fn()
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    try {
      const video = sizedVideo(640, 480)
      cropRegion(video, { x1: 0, y1: 0, x2: 49, y2: 49 })
      // 50x50 box pads 10px; the left/top clamp to the frame edge.
      expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 60, 60, 0, 0, 60, 60)
      drawImage.mockClear()
      cropRegion(video, { x1: 600, y1: 440, x2: 639, y2: 479 })
      // 40x40 box pads 8px; the right/bottom clamp to the frame edge.
      expect(drawImage).toHaveBeenCalledWith(video, 592, 432, 48, 48, 0, 0, 48, 48)
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('honors a zero pad fraction', () => {
    const drawImage = vi.fn()
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    try {
      const video = sizedVideo(640, 480)
      cropRegion(video, { x1: 100, y1: 100, x2: 199, y2: 199 }, 0)
      expect(drawImage).toHaveBeenCalledWith(video, 100, 100, 100, 100, 0, 0, 100, 100)
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('returns empty string when the context is unavailable', () => {
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(null)
    try {
      expect(
        cropRegion(sizedVideo(640, 480), { x1: 0, y1: 0, x2: 10, y2: 10 }),
      ).toBe('')
    } finally {
      ctxSpy.mockRestore()
    }
  })
})

describe('identifyComponent', () => {
  it('names the component from the crop', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(sparkEnvelope(JSON.stringify({ label: 'M6 hex bolt' }))),
    )

    await expect(identifyComponent('data:image/jpeg;base64,CROP')).resolves.toBe('M6 hex bolt')
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ]
    expect(url).toBe('https://api.meta.ai/v1/chat/completions')
    expect(init.headers['Authorization']).toBe('Bearer k')
    const body = JSON.parse(init.body) as {
      model: string
      messages: [{ content: string }, { content: [{ text: string }, { image_url: { url: string } }] }]
    }
    expect(body.model).toBe('muse-spark-1.3')
    expect(body.messages[0].content).toContain('label')
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,CROP')
  })

  it('trims the label and caps it at the maximum length', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(
      jsonResponse(sparkEnvelope(JSON.stringify({ label: '  M6 hex bolt  ' }))),
    )
    await expect(identifyComponent('img')).resolves.toBe('M6 hex bolt')

    fetchMock.mockResolvedValueOnce(
      jsonResponse(sparkEnvelope(JSON.stringify({ label: 'y'.repeat(200) }))),
    )
    const capped = await identifyComponent('img')
    expect(capped).toBe('y'.repeat(MAX_IDENTIFY_LABEL))
    expect(MAX_IDENTIFY_LABEL).toBe(80)
  })

  it('returns an empty string when the label is missing or malformed', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse(sparkEnvelope(JSON.stringify({}))))
    await expect(identifyComponent('img')).resolves.toBe('')
    fetchMock.mockResolvedValueOnce(jsonResponse(sparkEnvelope(JSON.stringify({ label: 42 }))))
    await expect(identifyComponent('img')).resolves.toBe('')
    fetchMock.mockResolvedValueOnce(jsonResponse(sparkEnvelope(JSON.stringify({ label: '   ' }))))
    await expect(identifyComponent('img')).resolves.toBe('')
  })

  it('throws on HTTP errors', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(errorResponse(500, 'boom'))
    await expect(identifyComponent('img')).rejects.toThrow('Muse Spark 500')
  })
})
