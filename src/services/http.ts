import { logWarn } from './logger'

export interface FetchTimeoutOptions {
  timeoutMs: number
  /** Logger tag for the timeout warning. */
  tag: string
  /** Human label in the timeout message. */
  label: string
}

/**
 * fetch() with an abort timeout. Logs and aborts on expiry; the timer is
 * always cleared. Callers distinguish aborts from HTTP errors themselves.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  { timeoutMs, tag, label }: FetchTimeoutOptions,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    logWarn(tag, `${label} timed out after ${timeoutMs}ms`)
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
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

/** Narrow unknown JSON to a record for field access. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Trimmed non-empty string, or null when the value is missing or blank. */
export function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
