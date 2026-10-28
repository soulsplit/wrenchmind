import type { MaskBox, SpatialResult } from '../types'
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

/**
 * Longest capture side sent to the APIs. The feed negotiates up to 4K for
 * the zoomable display, but reason/segment/label calls need far less — cap
 * here so a 3-frame burst doesn't upload ~10MB per query on mobile.
 */
export const API_CAPTURE_MAX_SIDE = 1920

/**
 * Capture the current video frame as a base64 JPEG data URL, downscaled to
 * API_CAPTURE_MAX_SIDE on the longest side. Never upscales.
 */
export function captureVideoFrame(video: HTMLVideoElement): string {
  if (!video.videoWidth || !video.videoHeight) return ''
  const scale = Math.min(
    1,
    API_CAPTURE_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight),
  )
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.floor(video.videoWidth * scale))
  c.height = Math.max(1, Math.floor(video.videoHeight * scale))
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(video, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.8)
}

/** Frames captured per query so the reasoner sees motion context. */
export const FRAME_BURST = 3
/** Delay between burst frames. */
export const BURST_INTERVAL_MS = 300

/**
 * Capture the current frame downscaled to a small JPEG data URL for step
 * checkpoints. Never upscales; empty when no frame is available.
 */
export function captureThumbnail(video: HTMLVideoElement, maxWidth = 320): string {
  if (!video.videoWidth || !video.videoHeight) return ''
  const scale = Math.min(1, maxWidth / video.videoWidth)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.floor(video.videoWidth * scale))
  c.height = Math.max(1, Math.floor(video.videoHeight * scale))
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(video, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.7)
}

/**
 * Crop a padded region around a mask box (inclusive corners) from the live
 * video frame. The padded region clamps to the frame edges; empty when no
 * frame is available. Same canvas/toDataURL shape as captureThumbnail, with
 * a 9-arg drawImage selecting the source region.
 */
export function cropRegion(
  video: HTMLVideoElement,
  box: Pick<MaskBox, 'x1' | 'y1' | 'x2' | 'y2'>,
  padFraction = 0.2,
): string {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return ''
  const w = Math.max(1, box.x2 - box.x1 + 1)
  const h = Math.max(1, box.y2 - box.y1 + 1)
  const padX = Math.floor(w * padFraction)
  const padY = Math.floor(h * padFraction)
  const sx = Math.min(vw - 1, Math.max(0, box.x1 - padX))
  const sy = Math.min(vh - 1, Math.max(0, box.y1 - padY))
  const ex = Math.min(vw - 1, Math.max(0, box.x2 + padX))
  const ey = Math.min(vh - 1, Math.max(0, box.y2 + padY))
  const sw = Math.max(1, ex - sx + 1)
  const sh = Math.max(1, ey - sy + 1)
  const c = document.createElement('canvas')
  c.width = sw
  c.height = sh
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
  return c.toDataURL('image/jpeg', 0.8)
}

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

/** Max transcribed markings kept per label read. */
export const MAX_LABEL_FINDINGS = 10

/**
 * Transcribe the visible markings on an equipment label, rating plate, or
 * part. Returns one verbatim string per line or field in reading order
 * (key-value pairs kept together); empty when nothing is legible.
 */
export async function extractLabelText(image: string): Promise<string[]> {
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
              'You are a label transcription assistant. Given an image of an equipment label, rating plate, or part marking, transcribe every visible marking with character-exact fidelity. Return ONLY a JSON object: { "findings": string[] }. Rules: transcribe verbatim — preserve exact case, digits, punctuation, spacing, and units; never paraphrase, expand abbreviations, or invent characters. One entry per physical line or field; keep key-value pairs together on one entry (e.g. "MODEL ABC-123", "24V DC"). Read in top-to-bottom, left-to-right order. Examine small print and stamped, embossed, etched, or faded text closely, including edges and background markings. Join wrapped lines of a single field with one space. Include digits printed under barcodes. Use part-number context to disambiguate lookalike glyphs (0/O, 1/I/l, 5/S, 8/B). Skip illegible fragments rather than guessing. Empty array only when no text is legible at all.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Transcribe all visible markings on this label, verbatim and character-exact, including small print.',
              },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      }),
    },
    REASON_TIMEOUT_MS,
    'muse-spark-labels',
  )
  if (!res.ok) {
    const suffix = await errorDetail(res)
    logError('api', `muse-spark request failed: HTTP ${res.status}${suffix}`)
    throw new Error(`Muse Spark ${res.status}${suffix}`)
  }
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = JSON.parse(text) as { findings?: unknown }
  if (!Array.isArray(parsed.findings)) return []
  return parsed.findings
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_LABEL_FINDINGS)
}

/** Max characters kept from a component identification label. */
export const MAX_IDENTIFY_LABEL = 80

/**
 * Name the component visible in a cropped part image. Returns the short
 * part name, capped; empty only when no mechanical part is visible at all
 * (a generic category beats an empty label for downstream outline speech).
 */
export async function identifyComponent(image: string): Promise<string> {
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
              'You are a component identification assistant. Given a cropped image of a mechanical part, name the component. Return ONLY a JSON object: { "label": string } — the short part name (e.g. "M6 hex bolt", "wiring harness connector"). If unsure of the exact part, return the closest generic category (e.g. "bolt", "electrical connector", "hose", "bracket") rather than an empty string. Empty string only when no mechanical part is visible at all.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Name the component in this crop.' },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      }),
    },
    REASON_TIMEOUT_MS,
    'muse-spark-identify',
  )
  if (!res.ok) {
    const suffix = await errorDetail(res)
    logError('api', `muse-spark request failed: HTTP ${res.status}${suffix}`)
    throw new Error(`Muse Spark ${res.status}${suffix}`)
  }
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = JSON.parse(text) as { label?: unknown }
  if (typeof parsed.label !== 'string') return ''
  return parsed.label.trim().slice(0, MAX_IDENTIFY_LABEL)
}

/** Point prompt in media pixels, per the SAM box/point prompt grammar. */
export interface SamPointPrompt {
  x: number
  y: number
  width: number
  height: number
}

/** Box prompt in media pixels (inclusive corners); sent half-open. */
export interface SamBoxPrompt {
  x1: number
  y1: number
  x2: number
  y2: number
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
 * prompt when the target is already located, a box prompt (plus its center
 * point) for a circled region, or one object per point for plural targets
 * — a single call isolates every instance. Yields raw stream events for
 * the SAM parser; use `parseSamStream` to consume them.
 */
export async function* segmentImage(
  imageBase64: string,
  nounPhrase: string,
  point?: SamPointPrompt | SamPointPrompt[],
  box?: SamBoxPrompt,
): AsyncGenerator<SamStreamEvent> {
  const pts = Array.isArray(point) ? point : point ? [point] : []
  const promptBox =
    box &&
    Number.isInteger(box.x1) &&
    Number.isInteger(box.y1) &&
    Number.isInteger(box.x2) &&
    Number.isInteger(box.y2) &&
    Number.isInteger(box.width) &&
    Number.isInteger(box.height) &&
    box.width > 0 &&
    box.height > 0 &&
    box.x1 >= 0 &&
    box.y1 >= 0 &&
    box.x1 < box.x2 &&
    box.y1 < box.y2 &&
    box.x2 < box.width &&
    box.y2 < box.height
      ? box
      : undefined
  const text = promptBox
    ? buildObjectPrompt({
        size: { width: promptBox.width, height: promptBox.height },
        objects: [
          {
            id: 1,
            prompts: [
              {
                box: {
                  left: promptBox.x1,
                  top: promptBox.y1,
                  right: promptBox.x2 + 1,
                  bottom: promptBox.y2 + 1,
                },
                points: [
                  {
                    x: Math.floor((promptBox.x1 + promptBox.x2) / 2),
                    y: Math.floor((promptBox.y1 + promptBox.y2) / 2),
                  },
                ],
              },
            ],
          },
        ],
      })
    : pts.length > 0
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
