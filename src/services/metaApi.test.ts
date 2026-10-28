import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BURST_INTERVAL_MS,
  FRAME_BURST,
  captureFrameBurst,
  captureVideoFrame,
  hasApiKey,
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
})
