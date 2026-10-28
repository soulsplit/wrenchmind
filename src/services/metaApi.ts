import type { SpatialResult } from '../types'
import { buildObjectPrompt } from '@meta-sam/parser'
import { logError, logWarn } from './logger'

const BASE = 'https://api.meta.ai/v1'
const REASON_TIMEOUT_MS = 30000
const SEGMENT_TIMEOUT_MS = 60000

function key(): string {
  return import.meta.env.VITE_META_MODEL_API_KEY as string
}

export function hasApiKey(): boolean {
  const value = import.meta.env.VITE_META_MODEL_API_KEY
  return typeof value === 'string' && value.length > 0
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    logWarn('api', `${label} timed out after ${timeoutMs}ms`)
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Capture the current video frame as a base64 JPEG data URL. */
export function captureVideoFrame(video: HTMLVideoElement): string {
  if (!video.videoWidth || !video.videoHeight) return ''
  const c = document.createElement('canvas')
  c.width = video.videoWidth
  c.height = video.videoHeight
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(video, 0, 0)
  return c.toDataURL('image/jpeg', 0.8)
}

/** Frames captured per query so the reasoner sees motion context. */
export const FRAME_BURST = 3
/** Delay between burst frames. */
export const BURST_INTERVAL_MS = 300

/** Capture a short burst of frames; empty captures are dropped. */
export async function captureFrameBurst(
  video: HTMLVideoElement,
  count: number = FRAME_BURST,
  intervalMs: number = BURST_INTERVAL_MS,
): Promise<string[]> {
  const frames: string[] = []
  for (let i = 0; i < count; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs))
    const frame = captureVideoFrame(video)
    if (frame) frames.push(frame)
  }
  return frames
}

function clampPct(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 50
  return Math.min(100, Math.max(0, n))
}

/** Max instances isolated per plural command; one SAM call covers all of them. */
export const MAX_REASON_POINTS = 8

function clampPoints(value: unknown): { x: number; y: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: { x: number; y: number }[] = []
  for (const entry of value) {
    if (out.length >= MAX_REASON_POINTS) break
    if (typeof entry !== 'object' || entry === null) continue
    const { x, y } = entry as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number') continue
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({ x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) })
  }
  return out.length > 0 ? out : undefined
}

export async function reasonSpatial(
  images: string | string[],
  phrase: string,
  context: string,
): Promise<SpatialResult> {
  const frames = Array.isArray(images) ? images : [images]
  const queryText =
    frames.length > 1
      ? `Frames: ${frames.length} oldest-first, last is current.\nContext: ${context}\nCommand: ${phrase}`
      : `Context: ${context}\nCommand: ${phrase}`
  const res = await fetchWithTimeout(
    `${BASE}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key()}`,
      },
    body: JSON.stringify({
      model: 'muse-spark-1.3',
      messages: [
        {
          role: 'system',
          content:
            'You are an AR mechanical spatial visualizer. Given an image of a mechanical scene, the user spoken command, and previous context, locate the target. Return ONLY a JSON object: { "target_label": string, "approx_x": number (0-100), "approx_y": number (0-100), "points": [{ "x": number, "y": number }] (optional, up to 8: every visible instance when the command is plural, e.g. "all bolts" or "every screw"; omit for singular targets), "speech_response": string | null, "display_mode": "visual_only" | "speech_and_visual" }.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: queryText },
            ...frames.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
      response_format: { type: 'json_object' },
      }),
    },
    REASON_TIMEOUT_MS,
    'muse-spark',
  )
  if (!res.ok) {
    const suffix = await errorDetail(res)
    logError('api', `muse-spark request failed: HTTP ${res.status}${suffix}`)
    throw new Error(`Muse Spark ${res.status}${suffix}`)
  }
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = JSON.parse(text) as Partial<SpatialResult>
  return {
    target_label: typeof parsed.target_label === 'string' ? parsed.target_label : '',
    approx_x: clampPct(parsed.approx_x),
    approx_y: clampPct(parsed.approx_y),
    points: clampPoints(parsed.points),
    speech_response: typeof parsed.speech_response === 'string' ? parsed.speech_response : null,
    display_mode: parsed.display_mode === 'speech_and_visual' ? 'speech_and_visual' : 'visual_only',
  }
}

/** Point prompt in media pixels, per the SAM box/point prompt grammar. */
export interface SamPointPrompt {
  x: number
  y: number
  width: number
  height: number
}

/** A parsed Responses SSE event (shape owned by the API; the parser reads it). */
export interface SamStreamEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Segment an image: concept phrase when only a label is known, a point
 * prompt when the target is already located, or one object per point for
 * plural targets — a single call isolates every instance. Yields raw
 * stream events for the SAM parser; use `parseSamStream` to consume them.
 */
export async function* segmentImage(
  imageBase64: string,
  nounPhrase: string,
  point?: SamPointPrompt | SamPointPrompt[],
): AsyncGenerator<SamStreamEvent> {
  const pts = Array.isArray(point) ? point : point ? [point] : []
  const text =
    pts.length > 0
      ? buildObjectPrompt({
          size: { width: pts[0].width, height: pts[0].height },
          objects: pts.map((p, i) => ({
            id: i + 1,
            prompts: [{ points: [{ x: p.x, y: p.y }] }],
          })),
        })
      : nounPhrase
  const res = await fetchWithTimeout(
    `${BASE}/responses`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key()}`,
      },
    body: JSON.stringify({
      model: 'sam-3.1',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text },
            { type: 'input_image', image_url: imageBase64 },
          ],
        },
      ],
      stream: true,
      metadata: { mask_encoding: 'one_bit' },
      }),
    },
    SEGMENT_TIMEOUT_MS,
    'sam-3.1',
  )
  if (!res.ok) {
    const suffix = await errorDetail(res)
    logError('api', `sam-3.1 request failed: HTTP ${res.status}${suffix}`)
    throw new Error(`SAM ${res.status}${suffix}`)
  }
  if (!res.body) {
    logError('api', 'sam-3.1 empty response body')
    throw new Error('SAM empty response')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const ingest = function* (line: string): Generator<SamStreamEvent> {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return
    try {
      const evt = JSON.parse(payload) as Record<string, unknown>
      if (typeof evt['type'] !== 'string') return
      yield evt as SamStreamEvent
    } catch {
      /* ignore malformed stream chunks */
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) yield* ingest(line)
  }
  if (buffer) yield* ingest(buffer)
}
