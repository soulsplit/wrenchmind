import { logError, logWarn } from './logger'

const SEARCH_BASE = 'https://www.ifixit.com/api/2.0/search/'
const SEARCH_TIMEOUT_MS = 15000
const DEFAULT_LIMIT = 5

/** One iFixit search hit kept for the HUD: a repair guide, wiki, or Q&A thread. */
export type FixitGuideKind = 'guide' | 'wiki' | 'question'

export interface FixitGuide {
  /** Hit title. */
  title: string
  /** Canonical https URL (guide, wiki, or Answers thread). */
  url: string
  /** API `summary` (`text` for questions); empty when the hit carries none. */
  summary: string
  /** Guide difficulty (e.g. "Moderate"); null for wikis and questions. */
  difficulty: string | null
  /** API `dataType`, narrowed to the three kept kinds. */
  kind: FixitGuideKind
}

/** Join a voice phrase and part label into one iFixit query; blanks drop out. */
export function buildQuery(phrase: string, label: string): string {
  return [phrase.trim(), label.trim()].filter(Boolean).join(' ')
}

/** Deep link to the iFixit site search for a query. */
export function ifixitSearchUrl(query: string): string {
  return `https://www.ifixit.com/Search?query=${encodeURIComponent(query)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Trimmed non-empty string, or null when the value is missing or blank. */
function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Best-effort snippet of an HTTP error body for diagnosis (truncated). */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text ? `: ${text.slice(0, 500)}` : ''
  } catch {
    return ''
  }
}

const KEPT_KINDS = new Set(['guide', 'wiki', 'question'])

/** Narrow one raw hit to a FixitGuide; null when the hit is unusable. */
function cleanGuide(entry: unknown): FixitGuide | null {
  if (!isRecord(entry)) return null
  const dataType = entry['dataType']
  if (typeof dataType !== 'string' || !KEPT_KINDS.has(dataType)) return null
  const title = cleanString(entry['title'])
  if (!title) return null
  const url = cleanString(entry['url'])
  if (!url || !/^https?:\/\//.test(url)) return null
  return {
    title,
    url,
    summary: cleanString(entry['summary'] ?? entry['text']) ?? '',
    difficulty: cleanString(entry['difficulty']),
    kind: dataType as FixitGuideKind,
  }
}

/**
 * Search iFixit for repair guides (verified live: no auth, JSON, browser
 * fetch allowed, 429s when rate limited). Keeps guide/wiki/question hits,
 * stable-sorts guides and wikis before questions, and returns the top
 * `limit`. Blank queries and non-positive limits return [] without fetching.
 */
export async function searchGuides(
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<FixitGuide[]> {
  const trimmed = query.trim()
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  if (!trimmed || count === 0) return []
  const controller = new AbortController()
  const timer = setTimeout(() => {
    logWarn('ifixit', `search timed out after ${SEARCH_TIMEOUT_MS}ms`)
    controller.abort()
  }, SEARCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${SEARCH_BASE}${encodeURIComponent(trimmed)}`, {
      signal: controller.signal,
    })
    if (!res.ok) {
      const suffix = await errorDetail(res)
      logError('ifixit', `search failed: HTTP ${res.status}${suffix}`)
      throw new Error(`iFixit ${res.status}${suffix}`)
    }
    const data: unknown = await res.json()
    if (!isRecord(data)) return []
    const message = data['message']
    if (typeof message === 'string' && message.trim()) throw new Error(message.trim())
    const results = data['results']
    if (!Array.isArray(results)) return []
    const kept = results
      .map((entry, index) => ({ guide: cleanGuide(entry), index }))
      .filter((item): item is { guide: FixitGuide; index: number } => item.guide !== null)
    kept.sort((a, b) => {
      const rankA = a.guide.kind === 'question' ? 1 : 0
      const rankB = b.guide.kind === 'question' ? 1 : 0
      return rankA - rankB || a.index - b.index
    })
    return kept.slice(0, count).map((item) => item.guide)
  } finally {
    clearTimeout(timer)
  }
}
