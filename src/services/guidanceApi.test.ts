import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGuidance, GENERIC_VERIFY_WARNING } from './guidanceApi'
import { invalidGuidanceFixture, validGuidanceFixture } from '../test/guidanceFixtures'
import { clearLogs, getLogs } from './logger'

const fetchMock = vi.fn()

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

function errorResponse(status: number, bodyText: string): Response {
  return { ok: false, status, text: async () => bodyText } as unknown as Response
}

interface Citation {
  title: string
  url: string
}

function citation(title: string, url: string): Record<string, unknown> {
  return { type: 'url_citation', title, url, start_index: 0, end_index: 5 }
}

function searchResult(title: string, url: string): Record<string, unknown> {
  return { type: 'text_result', title, url, snippet: 'snippet' }
}

/** Minimal Responses envelope: search call(s) + final message with JSON text. */
function guidanceEnvelope(
  jsonText: string,
  options: { citations?: Citation[]; results?: Citation[]; preamble?: string } = {},
): unknown {
  const output: unknown[] = []
  output.push({
    id: 'ws_1',
    type: 'web_search_call',
    status: 'completed',
    results: (options.results ?? []).map((r) => searchResult(r.title, r.url)),
  })
  if (options.preamble !== undefined) {
    output.push({
      id: 'msg_pre',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: options.preamble, annotations: [] }],
    })
  }
  output.push({
    id: 'msg_final',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: jsonText,
        annotations: (options.citations ?? []).map((c) => citation(c.title, c.url)),
      },
    ],
  })
  return { id: 'resp_1', status: 'completed', model: 'muse-spark-1.3', output }
}

/** Fixture JSON as the model would emit it (schema has no `sources` key). */
function modelJson(payload: object): string {
  const rest = { ...(payload as Record<string, unknown>) }
  delete rest['sources']
  return JSON.stringify(rest)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fetchMock.mockReset()
  clearLogs()
})

describe('fetchGuidance request shape', () => {
  it('posts text-only guidance prompt with web_search, include, and structured output', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'test-key-123')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(
        guidanceEnvelope(modelJson(validGuidanceFixture), {
          citations: [{ title: 'Manual', url: 'https://example.com/manual' }],
        }),
      ),
    )

    await fetchGuidance('BELT', 'replace the belt', 'prior context')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ]
    expect(url).toBe('https://api.meta.ai/v1/responses')
    expect(init.method).toBe('POST')
    expect(init.headers['Authorization']).toBe('Bearer test-key-123')
    const body = JSON.parse(init.body) as {
      model: string
      input: [{ content: [{ text: string }] }]
      tools: unknown[]
      include: unknown[]
      text: { format: { type: string; schema: Record<string, unknown> } }
    }
    expect(body.model).toBe('muse-spark-1.3')
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.include).toEqual(['web_search_call.results'])
    expect(body.text.format.type).toBe('json_schema')
    const prompt = body.input[0].content[0].text
    expect(prompt).toContain('BELT')
    expect(prompt).toContain('replace the belt')
    expect(prompt).toContain('prior context')
    expect(init.body).not.toContain('image')
  })
})

describe('fetchGuidance happy path', () => {
  it('returns the validated fixture with citations as sources', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(
        guidanceEnvelope(modelJson(validGuidanceFixture), {
          citations: validGuidanceFixture.sources,
        }),
      ),
    )

    const result = await fetchGuidance('MID-DRIVE DRIVE BELT', 'replace it', '')
    expect(result).toEqual(validGuidanceFixture)
  })

  it('parses only the final message when earlier messages narrate the search', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(
        guidanceEnvelope(modelJson(validGuidanceFixture), {
          citations: validGuidanceFixture.sources,
          preamble: "I'll search for the mid-drive belt replacement manual.",
        }),
      ),
    )

    const result = await fetchGuidance('BELT', 'replace it', '')
    expect(result.title).toBe(validGuidanceFixture.title)
    expect(result.steps).toHaveLength(validGuidanceFixture.steps.length)
  })

  it('ignores model-emitted sources and uses API citations instead', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(
        guidanceEnvelope(
          JSON.stringify({
            ...JSON.parse(modelJson(validGuidanceFixture)),
            sources: [{ title: 'Fake', url: 'https://fake.example/made-up' }],
          }),
          { citations: [{ title: 'Real', url: 'https://example.com/real' }] },
        ),
      ),
    )

    const result = await fetchGuidance('BELT', 'replace it', '')
    expect(result.sources).toEqual([{ title: 'Real', url: 'https://example.com/real' }])
  })

  it('accepts fenced JSON as a fallback', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(
        guidanceEnvelope(`\`\`\`json\n${modelJson(validGuidanceFixture)}\n\`\`\``, {
          citations: validGuidanceFixture.sources,
        }),
      ),
    )

    const result = await fetchGuidance('BELT', 'replace it', '')
    expect(result.title).toBe(validGuidanceFixture.title)
  })
})

describe('fetchGuidance validator edges', () => {
  function stubValidWith(patch: Record<string, unknown>): void {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    const base = JSON.parse(modelJson(validGuidanceFixture)) as Record<string, unknown>
    fetchMock.mockResolvedValue(
      jsonResponse(
        guidanceEnvelope(JSON.stringify({ ...base, ...patch }), {
          citations: validGuidanceFixture.sources,
        }),
      ),
    )
  }

  it('rejects the invalid fixture', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(guidanceEnvelope(JSON.stringify(invalidGuidanceFixture))),
    )
    await expect(fetchGuidance('BELT', 'x', '')).rejects.toThrow()
  })

  it('drops malformed steps but keeps valid ones', async () => {
    stubValidWith({
      steps: [
        { title: 'Good step', detail: 'Do the thing.' },
        { title: 'Missing detail' },
        { detail: 'Missing title' },
        'not-an-object',
        { title: '  ', detail: 'Blank title' },
      ],
    })
    const result = await fetchGuidance('BELT', 'x', '')
    expect(result.steps).toEqual([{ title: 'Good step', detail: 'Do the thing.' }])
  })

  it('throws when no valid steps remain', async () => {
    stubValidWith({ steps: [{ title: 'No detail' }] })
    await expect(fetchGuidance('BELT', 'x', '')).rejects.toThrow('no valid steps')
  })

  it('throws when steps are missing entirely', async () => {
    stubValidWith({ steps: undefined })
    await expect(fetchGuidance('BELT', 'x', '')).rejects.toThrow('no valid steps')
  })

  it('emits specs:[] plus a warnings entry when specs are unknown', async () => {
    stubValidWith({ specs: 'not-an-array', warnings: ['Wear gloves.'] })
    const result = await fetchGuidance('BELT', 'x', '')
    expect(result.specs).toEqual([])
    expect(result.warnings.length).toBeGreaterThan(1)
    expect(result.warnings.some((w) => /spec|manual/i.test(w))).toBe(true)
  })

  it('drops malformed spec and tool entries', async () => {
    stubValidWith({
      specs: [{ label: 'Torque', value: '6 Nm' }, { label: 'No value' }, null],
      tools: ['T25 Torx', null, 42, '  '],
    })
    const result = await fetchGuidance('BELT', 'x', '')
    expect(result.specs).toEqual([{ label: 'Torque', value: '6 Nm' }])
    expect(result.tools).toEqual(['T25 Torx'])
  })

  it('injects the generic verify warning when warnings are missing or empty', async () => {
    stubValidWith({ warnings: undefined })
    const missing = await fetchGuidance('BELT', 'x', '')
    expect(missing.warnings).toContain(GENERIC_VERIFY_WARNING)

    stubValidWith({ warnings: [] })
    const empty = await fetchGuidance('BELT', 'x', '')
    expect(empty.warnings).toContain(GENERIC_VERIFY_WARNING)
  })

  it('falls back to the caller label when the title is unusable', async () => {
    stubValidWith({ title: 42 })
    const result = await fetchGuidance('FALLBACK LABEL', 'x', '')
    expect(result.title).toBe('FALLBACK LABEL')
  })

  it('normalizes a non-string manualTitle to null', async () => {
    stubValidWith({ manualTitle: 7 })
    const result = await fetchGuidance('BELT', 'x', '')
    expect(result.manualTitle).toBeNull()
  })

  it('throws on non-JSON message text and on missing messages', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse(guidanceEnvelope('not json at all')))
    await expect(fetchGuidance('BELT', 'x', '')).rejects.toThrow('not valid JSON')

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'completed', output: [] }))
    await expect(fetchGuidance('BELT', 'x', '')).rejects.toThrow('no message text')
  })
})

describe('fetchGuidance sources and grounding', () => {
  function stubSources(options: { citations?: Citation[]; results?: Citation[] }): void {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(guidanceEnvelope(modelJson(validGuidanceFixture), options)),
    )
  }

  it('dedupes citations by URL and drops non-http URLs', async () => {
    stubSources({
      citations: [
        { title: 'A', url: 'https://example.com/a' },
        { title: 'A again', url: 'https://example.com/a' },
        { title: 'Bad', url: 'javascript:alert(1)' },
      ],
    })
    const result = await fetchGuidance('BELT', 'x', '')
    expect(result.sources).toEqual([{ title: 'A', url: 'https://example.com/a' }])
  })

  it('tops up from web_search_call results when citations are absent', async () => {
    stubSources({ results: [{ title: 'R1', url: 'https://example.com/r1' }] })
    const result = await fetchGuidance('BELT', 'x', '')
    expect(result.sources).toEqual([{ title: 'R1', url: 'https://example.com/r1' }])
  })

  it('warns loudly when nothing grounded the answer', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    const base = JSON.parse(modelJson(validGuidanceFixture)) as Record<string, unknown>
    fetchMock.mockResolvedValue(
      jsonResponse(
        guidanceEnvelope(JSON.stringify({ ...base, manualTitle: null, warnings: ['Wear gloves.'] })),
      ),
    )
    const result = await fetchGuidance('BELT', 'x', '')
    expect(result.sources).toEqual([])
    expect(result.manualTitle).toBeNull()
    expect(result.warnings.some((w) => /No repair manual could be retrieved/.test(w))).toBe(true)
    expect(getLogs().some((e) => e.level === 'warn' && /grounding/.test(e.message))).toBe(true)
  })
})

describe('fetchGuidance failures', () => {
  it('throws on HTTP errors with a truncated body and logs the status', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(errorResponse(400, '{"error":"bad tool"}'))
    await expect(fetchGuidance('BELT', 'x', '')).rejects.toThrow(
      'Guidance 400: {"error":"bad tool"}',
    )
    expect(getLogs().some((e) => e.message.includes('HTTP 400'))).toBe(true)

    fetchMock.mockResolvedValueOnce(errorResponse(500, 'x'.repeat(600)))
    await expect(fetchGuidance('BELT', 'x', '')).rejects.toThrow(/^Guidance 500: x{500}$/)
  })

  it('throws when the response status is failed', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'k')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'failed', output: [] }))
    await expect(fetchGuidance('BELT', 'x', '')).rejects.toThrow('Guidance request failed')
  })

  it('aborts hung requests after 60s', { timeout: 10000 }, async () => {
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
      const pending = fetchGuidance('BELT', 'x', '')
      const assertion = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(60000 + 1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
