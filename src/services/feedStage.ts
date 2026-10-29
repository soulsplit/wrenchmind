import { cropRegion, extractLabelText, identifyComponent, sourceDims, type SamPointPrompt } from './metaApi'
import type { MaskBox } from '../types'

/**
 * Feed-stage geometry and region queries: the zoomable media surface's
 * scale/pan math, client→media mapping for taps and circle traces, and the
 * identify retry ladder. Pure except for the Meta API identify calls.
 */

/** Clamp a 0-100 viewport percent into range; non-finite values anchor at 0. */
export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** Feed magnifier range. */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 4

/** Scale + pan (CSS px, origin top-left) applied to the feed stage. */
export interface ZoomState {
  scale: number
  x: number
  y: number
}

export const NO_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 }

/**
 * Clamp pan so the scaled content always covers the viewport: with
 * transform-origin 0 0 the content spans [x, x + vw*s], pinned inside.
 */
export function clampZoomPan(
  scale: number,
  x: number,
  y: number,
  vw: number,
  vh: number,
): ZoomState {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
  // Snap float dust (e.g. wheel 1.2 * 1/1.2) so 1x stays exactly 1x: the
  // pan gate compares against ZOOM_MIN.
  const s = Math.abs(clamped - ZOOM_MIN) < 1e-9 ? ZOOM_MIN : clamped
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) {
    return { scale: s, x: 0, y: 0 }
  }
  const minX = Math.min(0, vw - vw * s)
  const minY = Math.min(0, vh - vh * s)
  return {
    scale: s,
    x: Math.min(0, Math.max(minX, Number.isFinite(x) ? x : 0)),
    y: Math.min(0, Math.max(minY, Number.isFinite(y) ? y : 0)),
  }
}

/**
 * Zoom by factor around a viewport point, keeping the content under it
 * fixed. Unchanged (same ref) when the factor hits a range limit.
 */
export function zoomAt(
  zoom: ZoomState,
  factor: number,
  cx: number,
  cy: number,
  vw: number,
  vh: number,
): ZoomState {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.scale * factor))
  if (scale === zoom.scale) return zoom
  const px = (cx - zoom.x) / zoom.scale
  const py = (cy - zoom.y) / zoom.scale
  return clampZoomPan(scale, cx - px * scale, cy - py * scale, vw, vh)
}

/**
 * One pinch step: zoom by the spread ratio while tracking the midpoint, so
 * a two-finger drag pans even when the spread holds steady. Pure spread
 * matches zoomAt; pure drag pans by the midpoint delta.
 */
export function pinchZoom(
  zoom: ZoomState,
  ratio: number,
  prevX: number,
  prevY: number,
  nextX: number,
  nextY: number,
  vw: number,
  vh: number,
): ZoomState {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.scale * ratio))
  const px = (prevX - zoom.x) / zoom.scale
  const py = (prevY - zoom.y) / zoom.scale
  return clampZoomPan(scale, nextX - px * scale, nextY - py * scale, vw, vh)
}

/**
 * Identify a region with a two-attempt ladder: a tight crop first, then a
 * wide-context crop when the tight one comes back unnamed. An empty crop
 * skips to the next pad rather than aborting. After the ladder, OCR on the
 * tight crop fuses in legible markings: it names an otherwise-unnamed part
 * ("part labeled ...") or annotates a small-region label. Returns '' only
 * when every attempt fails, so transient misses rarely surface as unknown.
 * OCR failures never throw: they fall back to the ladder result.
 */
export async function identifyWithContext(
  source: HTMLVideoElement | HTMLCanvasElement,
  box: Pick<MaskBox, 'x1' | 'y1' | 'x2' | 'y2'>,
): Promise<string> {
  let tightCrop = ''
  let result = ''
  let first = true
  for (const pad of [0.2, 1.0]) {
    const crop = cropRegion(source, box, pad)
    if (first) {
      tightCrop = crop
      first = false
    }
    if (!crop) continue
    try {
      const name = await identifyComponent(crop)
      if (name) {
        result = name
        break
      }
    } catch {
      // Fall through to the wider-context attempt.
    }
  }
  if (!result) {
    if (!tightCrop) return ''
    try {
      const findings = await extractLabelText(tightCrop)
      if (findings[0]) return `part labeled "${findings[0]}"`.slice(0, 80)
    } catch {
      // Fall through to ''.
    }
    return ''
  }
  if (tightCrop) {
    const { w, h } = sourceDims(source)
    const frameArea = w * h
    const boxArea =
      Math.max(1, box.x2 - box.x1 + 1) * Math.max(1, box.y2 - box.y1 + 1)
    if (frameArea > 0 && boxArea / frameArea < 0.04) {
      try {
        const findings = await extractLabelText(tightCrop)
        if (findings[0]) return `${result} — "${findings[0]}"`.slice(0, 80)
      } catch {
        // Fall through to the plain ladder result.
      }
    }
  }
  return result
}

/** A frozen-frame tap resolved to a SAM point prompt plus 0-100 viewport pct. */
export interface TapMedia {
  point: SamPointPrompt
  x: number
  y: number
}

/**
 * Invert object-cover geometry: map a client tap on the displayed element
 * back to media pixels, plus the tap's 0-100 viewport percent for the
 * callout. Undefined when media or element dims are unknown.
 *
 * The measured rect is the zoom-stage (transformed) box: divide back to
 * untransformed geometry first. Pan cancels out of the box-relative
 * fraction, so only the stage scale is needed; percents stay in the
 * untransformed space the in-stage callout is positioned in.
 *
 * When the stage is CSS-mirrored (desktop/front self-view), the prompt
 * flips against the stage width back to raw-frame pixels, while the
 * callout percents stay at the tap: overlays paint in media space on the
 * equally mirrored canvas, so everything lands under the finger.
 */
export function tapToMedia(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  videoW: number,
  videoH: number,
  stageScale = 1,
  mirrored = false,
): TapMedia | undefined {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return undefined
  if (!Number.isFinite(videoW) || !Number.isFinite(videoH) || videoW <= 0 || videoH <= 0) {
    return undefined
  }
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
    return undefined
  }
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return undefined
  if (!Number.isFinite(stageScale) || stageScale <= 0) return undefined
  const w = rect.width / stageScale
  const h = rect.height / stageScale
  const px = (clientX - rect.left) / stageScale
  const py = (clientY - rect.top) / stageScale
  const media = coverToMedia(mirrored ? w - px : px, py, w, h, videoW, videoH)
  return {
    point: { ...media, width: videoW, height: videoH },
    x: clampPct(((clientX - rect.left) / rect.width) * 100),
    y: clampPct(((clientY - rect.top) / rect.height) * 100),
  }
}

/**
 * Object-cover inverse for one untransformed point: the frame scales to
 * cover, cropping the overflow centered. Returns the clamped media pixel.
 */
function coverToMedia(
  px: number,
  py: number,
  w: number,
  h: number,
  videoW: number,
  videoH: number,
): { x: number; y: number } {
  const cover = Math.max(w / videoW, h / videoH)
  const dx = (videoW * cover - w) / 2
  const dy = (videoH * cover - h) / 2
  return {
    x: Math.min(videoW - 1, Math.max(0, Math.round((px + dx) / cover))),
    y: Math.min(videoH - 1, Math.max(0, Math.round((py + dy) / cover))),
  }
}

/** A circled region resolved to a media box plus callout percents. */
export interface MediaRegion {
  /** Inclusive, ordered media-pixel corners. */
  box: { x1: number; y1: number; x2: number; y2: number }
  x: number
  y: number
}

/**
 * Map a circle-trace bounding box (untransformed stage coords) to media
 * pixels. Corners map independently through the cover inverse, so the box
 * stays correct under zoom and pan. Undefined when dims are unknown.
 * Mirrored stages flip both corners against the stage width first; the
 * min/max ordering below keeps the box valid either way.
 */
export function stageBoxToMedia(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  stageW: number,
  stageH: number,
  videoW: number,
  videoH: number,
  mirrored = false,
): MediaRegion | undefined {
  if (![ax, ay, bx, by].every(Number.isFinite)) return undefined
  if (!Number.isFinite(stageW) || !Number.isFinite(stageH) || stageW <= 0 || stageH <= 0) {
    return undefined
  }
  if (!Number.isFinite(videoW) || !Number.isFinite(videoH) || videoW <= 0 || videoH <= 0) {
    return undefined
  }
  const c1 = coverToMedia(mirrored ? stageW - ax : ax, ay, stageW, stageH, videoW, videoH)
  const c2 = coverToMedia(mirrored ? stageW - bx : bx, by, stageW, stageH, videoW, videoH)
  return {
    box: {
      x1: Math.min(c1.x, c2.x),
      y1: Math.min(c1.y, c2.y),
      x2: Math.max(c1.x, c2.x),
      y2: Math.max(c1.y, c2.y),
    },
    x: clampPct((((ax + bx) / 2) / stageW) * 100),
    y: clampPct((((ay + by) / 2) / stageH) * 100),
  }
}
