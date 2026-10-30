import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanString, errorDetail, fetchWithTimeout, isRecord } from './http'
import { clearLogs, getLogs } from './logger'

const fetchMock = vi.fn()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  fetchMock.mockReset()
  clearLogs()
})

describe('fetchWithTimeout', () => {
  it('forwards the response and passes the abort signal through', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock.mockResolvedValue({ ok: true, status: 200 } as unknown as Response),
    )
    const res = await fetchWithTimeout(
      'https://example.com/x',
      { method: 'GET' },
      { timeoutMs: 1000, tag: 'api', label: 'probe' },
    )
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, { signal?: AbortSignal }]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('aborts a hung request after timeoutMs and logs the timeout', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        fetchMock.mockImplementation(
          (_url: unknown, init?: { signal?: AbortSignal }) =>
            new Promise<never>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'))
              })
            }),
        ),
      )
      const pending = fetchWithTimeout(
        'https://example.com/hung',
        { method: 'GET' },
        { timeoutMs: 3000, tag: 'api', label: 'hung-probe' },
      )
      const assertion = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(3000 + 1)
      await assertion
      expect(
        getLogs().some(
          (e) => e.tag === 'api' && e.message.includes('hung-probe timed out after 3000ms'),
        ),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not time out a request that settles first', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        fetchMock.mockResolvedValue({ ok: true, status: 200 } as unknown as Response),
      )
      const pending = fetchWithTimeout(
        'https://example.com/fast',
        {},
        { timeoutMs: 5000, tag: 'api', label: 'fast' },
      )
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toMatchObject({ ok: true })
      expect(getLogs().some((e) => e.message.includes('timed out'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('errorDetail', () => {
  it('returns an empty suffix for an empty body', async () => {
    const res = { text: async () => '' } as unknown as Response
    await expect(errorDetail(res)).resolves.toBe('')
  })

  it('prefixes a short body with a colon', async () => {
    const res = { text: async () => '{"error":"bad"}' } as unknown as Response
    await expect(errorDetail(res)).resolves.toBe(': {"error":"bad"}')
  })

  it('truncates long bodies to 500 chars', async () => {
    const res = { text: async () => 'x'.repeat(600) } as unknown as Response
    const detail = await errorDetail(res)
    expect(detail).toBe(`: ${'x'.repeat(500)}`)
    expect(detail.length).toBe(2 + 500)
  })

  it('returns empty when the body cannot be read', async () => {
    const res = {
      text: async () => {
        throw new Error('no body')
      },
    } as unknown as Response
    await expect(errorDetail(res)).resolves.toBe('')
  })
})

describe('isRecord', () => {
  it('narrows plain objects to records', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('rejects null and primitives', () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(true)).toBe(false)
  })
})

describe('cleanString', () => {
  it('trims and keeps non-empty strings', () => {
    expect(cleanString('  hello  ')).toBe('hello')
    expect(cleanString('x')).toBe('x')
  })

  it('returns null for blank, missing, or non-string values', () => {
    expect(cleanString('   ')).toBeNull()
    expect(cleanString('')).toBeNull()
    expect(cleanString(null)).toBeNull()
    expect(cleanString(undefined)).toBeNull()
    expect(cleanString(42)).toBeNull()
    expect(cleanString({})).toBeNull()
  })
})
