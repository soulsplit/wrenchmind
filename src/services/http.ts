import { logWarn } from './logger'

export interface FetchTimeoutOptions {
  timeoutMs: number
  /** Logger tag for the timeout warning. */
  tag: string
  /** Human label in the timeout message. */
  label: string
}

/** Buffered body readers whose completion settles the deadline. */
const BUFFERED_METHODS = ['arrayBuffer', 'blob', 'formData', 'json', 'text'] as const

/**
 * Settle the deadline when a streamed body finishes, errors, or is
 * cancelled; a stalled read in between still trips the pending timer.
 */
function trackReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  settle: () => void,
): ReadableStreamDefaultReader<Uint8Array> {
  if (typeof reader.read === 'function') {
    const read = reader.read.bind(reader)
    reader.read = async () => {
      try {
        const chunk = await read()
        if (chunk.done) settle()
        return chunk
      } catch (e) {
        settle()
        throw e
      }
    }
  }
  if (typeof reader.cancel === 'function') {
    const cancel = reader.cancel.bind(reader)
    reader.cancel = async (reason?: unknown) => {
      try {
        return await cancel(reason)
      } finally {
        settle()
      }
    }
  }
  return reader
}

/**
 * Keep the abort deadline alive through body consumption: buffered reads
 * settle it on completion and streamed reads on done/error/cancel, while a
 * body that never resolves still trips the absolute head+body timeout.
 * Bodies without a reader settle at once (nothing further to cover).
 */
function trackBody(res: Response, settle: () => void): Response {
  for (const method of BUFFERED_METHODS) {
    const original: unknown = res[method]
    if (typeof original !== 'function') continue
    const bound = (original as () => Promise<unknown>).bind(res)
    res[method] = (async () => {
      try {
        return await bound()
      } finally {
        settle()
      }
    }) as never
  }
  const body = res.body
  if (!body || typeof body.getReader !== 'function') {
    settle()
    return res
  }
  const getReader = body.getReader.bind(body)
  body.getReader = (() => trackReader(getReader(), settle)) as typeof body.getReader
  return res
}

/**
 * fetch() with an abort timeout covering the response head and body.
 * Logs and aborts on expiry; the timer clears once the body settles.
 * Callers distinguish aborts from HTTP errors themselves.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  { timeoutMs, tag, label }: FetchTimeoutOptions,
): Promise<Response> {
  const controller = new AbortController()
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    logWarn(tag, `${label} timed out after ${timeoutMs}ms`)
    controller.abort()
  }, timeoutMs)
  const settle = () => {
    settled = true
    clearTimeout(timer)
  }
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    try {
      return trackBody(res, settle)
    } catch {
      // Non-standard response shape: fall back to head-only coverage.
      settle()
      return res
    }
  } catch (e) {
    settle()
    throw e
  }
}

/** Best-effort snippet of an HTTP error body for diagnosis (truncated). */
export async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text ? `: ${text.slice(0, 500)}` : ''
  } catch {
    return ''
  }
}

/** Narrow unknown JSON to a record for field access. Arrays are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed non-empty string, or null when the value is missing or blank. */
export function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
