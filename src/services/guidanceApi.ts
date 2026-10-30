import type { GuidanceResult, GuidanceSource, GuidanceSpec, GuidanceStep } from '../types'
import { logDebug, logError, logWarn } from './logger'
import { cleanString, errorDetail, fetchWithTimeout, isRecord } from './http'

const BASE = 'https://api.meta.ai/v1'
const GUIDANCE_TIMEOUT_MS = 60000
const MODEL = 'muse-spark-1.3'
const MAX_SOURCES = 8

/** Fallback caution guaranteeing the mandatory warnings slot is never empty (D2). */
export const GENERIC_VERIFY_WARNING =
  'Verify all steps and specs against the manual before starting work.'

/** Appended when the model returned no usable spec values. */
export const UNKNOWN_SPEC_WARNING =
  'No verified specs found — check the manual for torque values and capacities before use.'

/** Appended when neither citations nor search results grounded the answer (D10). */
export const UNGROUNDED_WARNING =
  'No repair manual could be retrieved — treat these steps as unverified guidance.'

/**
 * Raw API key; undefined when unset (callers rely on the pipeline's
 * hasApiKey() gate — an unguarded call sends a literal "Bearer undefined").
 */
function key(): string {
  return import.meta.env.VITE_META_MODEL_API_KEY as string
}

/**
 * Strict-subset JSON Schema for the Responses `text.format` parameter
 * (verified: `text.format`, not `response_format`, configures structured
 * output on `/v1/responses`; strict mode requires every object to set
 * `additionalProperties: false` and list all keys in `required`).
 * `sources` is deliberately absent: citation URLs are parsed from
 * `url_citation` annotations client-side, never trusted from model JSON.
 */
const GUIDANCE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          warning: { type: ['string', 'null'] },
        },
        required: ['title', 'detail', 'warning'],
        additionalProperties: false,
      },
    },
    specs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['label', 'value'],
        additionalProperties: false,
      },
    },
    tools: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    manualTitle: { type: ['string', 'null'] },
  },
  required: ['title', 'steps', 'specs', 'tools', 'warnings', 'manualTitle'],
  additionalProperties: false,
}

function buildGuidancePrompt(label: string, phrase: string, context: string): string {
  const contextLine = context.trim() ? `\nSession context: ${context.trim()}` : ''
  return [
    `Part or job: ${label.trim() || 'unknown part'}`,
    `User request: ${phrase.trim() || 'general repair guidance'}`,
    contextLine,
    '',
    'First use web search to find the best-fit repair or user manual for this part or job.',
    'Read the top results and parse the best match as your grounding source.',
    '',
    'Then return STRICT JSON only (no markdown, no code fences, no commentary) with exactly this shape:',
    '{"title": "PART OR JOB TITLE", "steps": [{"title": "short heading", "detail": "plain instructional prose", "warning": "step-local caution or null"}], "specs": [{"label": "...", "value": "..."}], "tools": ["..."], "warnings": ["at least one caution"], "manualTitle": "title of the manual you read, or null if none found"}',
    '',
    'Rules:',
    '- specs: include ONLY values you actually found in the manual or a cited source. If a spec is unknown, emit "specs": [] and add a warnings entry telling the user to verify that spec against the manual. Never invent torque values, capacities, gaps, or part numbers.',
    '- warnings: always include at least one entry reminding the user to verify safety-critical steps and specs against the manual. Model-generated content is never authoritative.',
    '- No numeric confidence field anywhere. Do not state confidence percentages.',
  ].join('\n')
}

/** Keep well-formed string entries; drop everything else. */
function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    const cleaned = cleanString(entry)
    if (cleaned) out.push(cleaned)
  }
  return out
}

function cleanSteps(value: unknown): GuidanceStep[] {
  if (!Array.isArray(value)) return []
  const out: GuidanceStep[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const title = cleanString(entry['title'])
    const detail = cleanString(entry['detail'])
    if (!title || !detail) continue
    const warning = cleanString(entry['warning'])
    out.push(warning ? { title, detail, warning } : { title, detail })
  }
  return out
}

function cleanSpecs(value: unknown): GuidanceSpec[] {
  if (!Array.isArray(value)) return []
  const out: GuidanceSpec[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const label = cleanString(entry['label'])
    const specValue = cleanString(entry['value'])
    if (!label || !specValue) continue
    out.push({ label, value: specValue })
  }
  return out
}

function responseItems(data: unknown): Array<Record<string, unknown>> {
  if (!isRecord(data) || !Array.isArray(data['output'])) return []
  return data['output'].filter(isRecord)
}

/**
 * The final assistant message holds the schema-constrained JSON answer;
 * earlier messages carry intermediate search narration ("I'll search for…")
 * that must NOT be concatenated into the parse (verified by live probe).
 */
function extractFinalJsonText(items: Array<Record<string, unknown>>): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (!item || item['type'] !== 'message' || !Array.isArray(item['content'])) continue
    const text = item['content']
      .filter((block): block is Record<string, unknown> => isRecord(block))
      .filter((block) => block['type'] === 'output_text')
      .map((block) => block['text'])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .join('')
    if (text.trim()) return text
  }
  throw new Error('Guidance response contained no message text')
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced?.[1]) return JSON.parse(fenced[1].trim()) as unknown
    throw new Error('Guidance response was not valid JSON')
  }
}

/**
 * Grounding citations: `url_citation` annotations first (the subset the
 * model actually cited), topped up from opt-in `web_search_call.results`
 * (everything it considered). Model-emitted URLs in the JSON payload are
 * ignored — citations come only from API annotations and search metadata.
 */
function extractSources(items: Array<Record<string, unknown>>): GuidanceSource[] {
  const seen = new Set<string>()
  const out: GuidanceSource[] = []
  const push = (title: unknown, url: unknown): void => {
    if (out.length >= MAX_SOURCES) return
    const cleanUrl = cleanString(url)
    if (!cleanUrl || !/^https?:\/\//.test(cleanUrl)) return
    if (seen.has(cleanUrl)) return
    seen.add(cleanUrl)
    out.push({ title: cleanString(title) ?? cleanUrl, url: cleanUrl })
  }
  for (const item of items) {
    if (item['type'] !== 'message' || !Array.isArray(item['content'])) continue
    for (const block of item['content']) {
      if (!isRecord(block) || block['type'] !== 'output_text') continue
      if (!Array.isArray(block['annotations'])) continue
      for (const annotation of block['annotations']) {
        if (!isRecord(annotation) || annotation['type'] !== 'url_citation') continue
        push(annotation['title'], annotation['url'])
      }
    }
  }
  for (const item of items) {
    if (item['type'] !== 'web_search_call' || !Array.isArray(item['results'])) continue
    for (const result of item['results']) {
      if (!isRecord(result)) continue
      push(result['title'], result['url'])
    }
  }
  return out
}

function validateGuidance(
  payload: unknown,
  label: string,
  items: Array<Record<string, unknown>>,
): GuidanceResult {
  if (!isRecord(payload)) throw new Error('Guidance response was not a JSON object')
  const steps = cleanSteps(payload['steps'])
  if (steps.length === 0) throw new Error('Guidance response contained no valid steps')
  const specs = cleanSpecs(payload['specs'])
  const warnings = cleanStringArray(payload['warnings'])
  if (warnings.length === 0) warnings.push(GENERIC_VERIFY_WARNING)
  if (specs.length === 0 && !warnings.some((w) => /verif|manual|spec/i.test(w))) {
    warnings.push(UNKNOWN_SPEC_WARNING)
  }
  const manualTitle = cleanString(payload['manualTitle'])
  const sources = extractSources(items)
  if (manualTitle === null && sources.length === 0 && !warnings.includes(UNGROUNDED_WARNING)) {
    warnings.push(UNGROUNDED_WARNING)
  }
  if (sources.length === 0) {
    logWarn('guidance', 'response carried no grounding citations or search results')
  }
  return {
    title: cleanString(payload['title']) ?? cleanString(label) ?? 'Repair guidance',
    steps,
    specs,
    tools: cleanStringArray(payload['tools']),
    warnings,
    sources,
    manualTitle,
  }
}

/**
 * Session cache of validated guidance. Keyed by label+phrase: the label
 * alone is unsafe ('torque for belt' vs 'replace belt' need different
 * answers). Failures are never cached.
 */
const guidanceCache = new Map<string, GuidanceResult>()

function cacheKey(label: string, phrase: string): string {
  return `${label.trim().toLowerCase()}\n${phrase.trim().toLowerCase()}`
}

/** Clear the session guidance cache (tests). */
export function clearGuidanceCache(): void {
  guidanceCache.clear()
}

/**
 * Fetch manual-grounded repair guidance (D1/D2/D10). Text-only Responses
 * call: the model web-searches for the best-fit repair/user manual, reads
 * and parses it, then returns strict JSON validated against the
 * GuidanceResult contract. Citation URLs come from API annotations.
 */
export async function fetchGuidance(
  label: string,
  phrase: string,
  context: string,
): Promise<GuidanceResult> {
  const cacheId = cacheKey(label, phrase)
  const cached = guidanceCache.get(cacheId)
  if (cached) {
    logDebug('guidance', `cache hit for "${label.trim()}"`)
    return cached
  }
  const res = await fetchWithTimeout(
    `${BASE}/responses`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: buildGuidancePrompt(label, phrase, context) }],
          },
        ],
        tools: [{ type: 'web_search' }],
        include: ['web_search_call.results'],
        text: {
          format: { type: 'json_schema', name: 'Guidance', schema: GUIDANCE_SCHEMA, strict: true },
        },
      }),
    },
    { timeoutMs: GUIDANCE_TIMEOUT_MS, tag: 'guidance', label: 'guidance' },
  )
  if (!res.ok) {
    const suffix = await errorDetail(res)
    logError('guidance', `guidance request failed: HTTP ${res.status}${suffix}`)
    throw new Error(`Guidance ${res.status}${suffix}`)
  }
  const data: unknown = await res.json()
  if (isRecord(data) && data['status'] === 'failed') {
    logError('guidance', 'guidance response status failed')
    throw new Error('Guidance request failed')
  }
  const items = responseItems(data)
  const payload = parseJsonText(extractFinalJsonText(items))
  const result = validateGuidance(payload, label, items)
  guidanceCache.set(cacheId, result)
  return result
}
