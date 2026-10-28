import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildQuery, ifixitSearchUrl, searchGuides } from './ifixitApi'
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

/** Minimal iFixit search envelope (verified live shape). */
function searchPayload(results: unknown[]): unknown {
  return {
    search: 'belt',
    offset: 0,
    limit: 100,
    totalResults: results.length,
    moreResults: false,
    results,
  }
}

const guideHit = {
  dataType: 'guide',
  title: 'iPhone 13 Battery Replacement',
  url: 'https://www.ifixit.com/Guide/iPhone+13+Battery+Replacement/145896',
  summary: 'iPhone batteries are rated to hold 80% of their capacity.',
  difficulty: 'Moderate',
}

const wikiHit = {
  dataType: 'wiki',
  title: 'RIDGID R27401 Troubleshooting',
  url: 'https://www.ifixit.com/Wiki/RIDGID_R27401_Troubleshooting',
  summary: 'Efficient fixes/diagnosis for the RIDGID BELT SANDER R2740',
  text: 'Efficient fixes/diagnosis for the RIDGID BELT SANDER R2740',
}

const questionHit = {
  dataType: 'question',
  title: 'After replacing battery, iPhone will not connect to WiFi',
  url: 'https://www.ifixit.com/Answers/View/487556/After+replacing+battery',
  text: 'I replaced battery in my iPhone 5. Now WiFi will not connect.',
}

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  clearLogs()
})

describe('searchGuides request shape', () => {
  it('GETs the encoded query path with no auth', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse(searchPayload([])))

    await searchGuides('iphone battery', 3)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.ifixit.com/api/2.0/search/iphone%20battery')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers).toBeUndefined()
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('searchGuides parse', () => {
  it('maps guide, wiki, and question hits to FixitGuide', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse(searchPayload([guideHit, wikiHit, questionHit])))

    const result = await searchGuides('battery', 5)

    expect(result).toEqual([
      {
        title: 'iPhone 13 Battery Replacement',
        url: 'https://www.ifixit.com/Guide/iPhone+13+Battery+Replacement/145896',
        summary: 'iPhone batteries are rated to hold 80% of their capacity.',
        difficulty: 'Moderate',
        kind: 'guide',
      },
      {
        title: 'RIDGID R27401 Troubleshooting',
        url: 'https://www.ifixit.com/Wiki/RIDGID_R27401_Troubleshooting',
        summary: 'Efficient fixes/diagnosis for the RIDGID BELT SANDER R2740',
        difficulty: null,
        kind: 'wiki',
      },
      {
        title: 'After replacing battery, iPhone will not connect to WiFi',
        url: 'https://www.ifixit.com/Answers/View/487556/After+replacing+battery',
        summary: 'I replaced battery in my iPhone 5. Now WiFi will not connect.',
        difficulty: null,
        kind: 'question',
      },
    ])
  })

  it('falls back to an empty summary when the hit carries neither summary nor text', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchPayload([
          { dataType: 'guide', title: 'T', url: 'https://www.ifixit.com/Guide/T/1' },
        ]),
      ),
    )

    const result = await searchGuides('t', 5)

    expect(result).toEqual([
      { title: 'T', url: 'https://www.ifixit.com/Guide/T/1', summary: '', difficulty: null, kind: 'guide' },
    ])
  })
})

describe('searchGuides filter', () => {
  it('drops unknown dataTypes, malformed hits, and non-http URLs', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchPayload([
          guideHit,
          { ...guideHit, dataType: 'device' },
          { ...guideHit, dataType: 'teardown' },
          { dataType: 'guide', url: 'https://www.ifixit.com/Guide/NoTitle/1' },
          { dataType: 'guide', title: 'No URL' },
          { dataType: 'guide', title: 'Bad URL', url: 'javascript:alert(1)' },
          { dataType: 'guide', title: '  ', url: 'https://www.ifixit.com/Guide/Blank/1' },
          'not-an-object',
          null,
        ]),
      ),
    )

    const result = await searchGuides('battery', 5)

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('iPhone 13 Battery Replacement')
  })

  it('returns [] when results are missing or not an array', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(jsonResponse({ search: 'x' }))
    await expect(searchGuides('x', 5)).resolves.toEqual([])
    fetchMock.mockResolvedValueOnce(jsonResponse([]))
    await expect(searchGuides('x', 5)).resolves.toEqual([])
  })
})

describe('searchGuides sort and cap', () => {
  it('stable-sorts guides and wikis before questions', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const q1 = { ...questionHit, title: 'Q1' }
    const q2 = { ...questionHit, title: 'Q2' }
    const g1 = { ...guideHit, title: 'G1' }
    const g2 = { ...guideHit, title: 'G2' }
    const w1 = { ...wikiHit, title: 'W1' }
    fetchMock.mockResolvedValue(jsonResponse(searchPayload([q1, g1, w1, q2, g2])))

    const result = await searchGuides('battery', 10)

    expect(result.map((g) => g.title)).toEqual(['G1', 'W1', 'G2', 'Q1', 'Q2'])
  })

  it('returns the top limit after sorting', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const q1 = { ...questionHit, title: 'Q1' }
    const g1 = { ...guideHit, title: 'G1' }
    const w1 = { ...wikiHit, title: 'W1' }
    fetchMock.mockResolvedValue(jsonResponse(searchPayload([q1, g1, w1])))

    const result = await searchGuides('battery', 2)

    expect(result.map((g) => g.title)).toEqual(['G1', 'W1'])
  })

  it('returns [] without fetching for blank queries or non-positive limits', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse(searchPayload([guideHit])))

    await expect(searchGuides('   ', 5)).resolves.toEqual([])
    await expect(searchGuides('battery', 0)).resolves.toEqual([])
    await expect(searchGuides('battery', -2)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('searchGuides errors', () => {
  it('throws the API error message shape', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Endpoint not found' }))

    await expect(searchGuides('battery', 5)).rejects.toThrow('Endpoint not found')
  })

  it('throws on HTTP errors with a truncated body and logs the status', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(errorResponse(429, '{"message":"rate limited"}'))
    await expect(searchGuides('battery', 5)).rejects.toThrow(
      'iFixit 429: {"message":"rate limited"}',
    )
    expect(getLogs().some((e) => e.message.includes('HTTP 429'))).toBe(true)

    fetchMock.mockResolvedValueOnce(errorResponse(500, 'x'.repeat(600)))
    await expect(searchGuides('battery', 5)).rejects.toThrow(/^iFixit 500: x{500}$/)
  })

  it('aborts hung requests after 15s', { timeout: 10000 }, async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', fetchMock)
      fetchMock.mockImplementation(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'))
            })
          }),
      )
      const pending = searchGuides('battery', 5)
      const assertion = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(15000 + 1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('buildQuery', () => {
  it('joins trimmed phrase and label', () => {
    expect(buildQuery('  replace the belt ', ' MID-DRIVE ')).toBe('replace the belt MID-DRIVE')
  })

  it('drops blank parts', () => {
    expect(buildQuery('   ', 'belt')).toBe('belt')
    expect(buildQuery('replace it', '')).toBe('replace it')
    expect(buildQuery('', '  ')).toBe('')
  })
})

describe('ifixitSearchUrl', () => {
  it('returns the site search deep link with an encoded query', () => {
    expect(ifixitSearchUrl('iphone battery')).toBe('https://www.ifixit.com/Search?query=iphone%20battery')
    expect(ifixitSearchUrl('belt & pulley')).toBe(
      'https://www.ifixit.com/Search?query=belt%20%26%20pulley',
    )
  })
})
