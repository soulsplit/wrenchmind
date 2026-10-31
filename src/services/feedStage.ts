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
 * In contain mode the fitted content box (from the video dims) replaces
 * the viewport box: axes where the content still underfills pin centered
 * instead of panning off-screen.
 */
export function clampZoomPan(
  scale: number,
  x: number,
  y: number,
  vw: number,
  vh: number,
  fit: FitMode = 'cover',
  videoW = 0,
  videoH = 0,
): ZoomState {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
  // Snap float dust (e.g. wheel 1.2 * 1/1.2) so 1x stays exactly 1x: the
  // pan gate compares against ZOOM_MIN.
  const s = Math.abs(clamped - ZOOM_MIN) < 1e-9 ? ZOOM_MIN : clamped
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) {
    return { scale: s, x: 0, y: 0 }
  }
  if (fit === 'contain' && Number.isFinite(videoW) && Number.isFinite(videoH) && videoW > 0 && videoH > 0) {
    const contain = Math.min(vw / videoW, vh / videoH)
    const cw = videoW * contain
    const ch = videoH * contain
    const ox = (vw - cw) / 2
    const oy = (vh - ch) / 2
    const fx = Number.isFinite(x) ? x : 0
    const fy = Number.isFinite(y) ? y : 0
    // Covering axis: content box covers the viewport. Underfilling axis:
    // pin centered (the centered content offset equals the centered stage).
    const nx = cw * s >= vw
      ? Math.min(-ox * s, Math.max(vw - (ox + cw) * s, fx))
      : (vw / 2) * (1 - s)
    const ny = ch * s >= vh
      ? Math.min(-oy * s, Math.max(vh - (oy + ch) * s, fy))
      : (vh / 2) * (1 - s)
    // Normalize -0 (exact-fit edges) so 1x stays exactly {0, 0}.
    return { scale: s, x: nx + 0, y: ny + 0 }
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
  fit: FitMode = 'cover',
  videoW = 0,
  videoH = 0,
): ZoomState {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.scale * factor))
  if (scale === zoom.scale) return zoom
  const px = (cx - zoom.x) / zoom.scale
  const py = (cy - zoom.y) / zoom.scale
  return clampZoomPan(scale, cx - px * scale, cy - py * scale, vw, vh, fit, videoW, videoH)
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
  fit: FitMode = 'cover',
  videoW = 0,
  videoH = 0,
): ZoomState {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.scale * ratio))
  const px = (prevX - zoom.x) / zoom.scale
  const py = (prevY - zoom.y) / zoom.scale
  return clampZoomPan(scale, nextX - px * scale, nextY - py * scale, vw, vh, fit, videoW, videoH)
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
 * How the frame is fitted into the stage: live video and camera freezes use
 * object-cover (full-bleed viewfinder), uploaded photos use object-contain
 * (arbitrary aspect — the whole image must stay visible, letterboxed).
 */
export type FitMode = 'cover' | 'contain'

/**
 * Invert object-contain geometry: the frame scales to fit, letterboxing the
 * leftover bars centered. Points on the bars resolve undefined so callers
 * can silently ignore them instead of outlining an edge sliver.
 */
function containToMedia(
  px: number,
  py: number,
  w: number,
  h: number,
  videoW: number,
  videoH: number,
): { x: number; y: number } | undefined {
  const contain = Math.min(w / videoW, h / videoH)
  const cw = videoW * contain
  const ch = videoH * contain
  const ox = (w - cw) / 2
  const oy = (h - ch) / 2
  if (px < ox || px > ox + cw || py < oy || py > oy + ch) return undefined
  return {
    x: Math.min(videoW - 1, Math.max(0, Math.round((px - ox) / contain))),
    y: Math.min(videoH - 1, Math.max(0, Math.round((py - oy) / contain))),
  }
}

/**
 * Invert the stage fit geometry: map a client tap on the displayed element
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
 * equally mirrored canvas, so everything lands under the finger. Contain
 * bar taps resolve undefined for a silent ignore (see the caller).
 */
export function tapToMedia(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  videoW: number,
  videoH: number,
  stageScale = 1,
  mirrored = false,
  fit: FitMode = 'cover',
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
  if (fit === 'contain') {
    const media = containToMedia(mirrored ? w - px : px, py, w, h, videoW, videoH)
    if (!media) return undefined
    return {
      point: { ...media, width: videoW, height: videoH },
      x: clampPct(((clientX - rect.left) / rect.width) * 100),
      y: clampPct(((clientY - rect.top) / rect.height) * 100),
    }
  }
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
 * pixels. Corners map independently through the fit inverse, so the box
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
  fit: FitMode = 'cover',
): MediaRegion | undefined {
  if (![ax, ay, bx, by].every(Number.isFinite)) return undefined
  if (!Number.isFinite(stageW) || !Number.isFinite(stageH) || stageW <= 0 || stageH <= 0) {
    return undefined
  }
  if (!Number.isFinite(videoW) || !Number.isFinite(videoH) || videoW <= 0 || videoH <= 0) {
    return undefined
  }
  if (fit === 'contain') {
    // Mirror first (the centered box is flip-symmetric), then intersect
    // with the image area: fully-bar loops ignore, straddling loops clamp.
    const flip = (x: number) => (mirrored ? stageW - x : x)
    const contain = Math.min(stageW / videoW, stageH / videoH)
    const cw = videoW * contain
    const ch = videoH * contain
    const ox = (stageW - cw) / 2
    const oy = (stageH - ch) / 2
    const c1x = flip(ax)
    const c2x = flip(bx)
    const loX = Math.min(c1x, c2x)
    const hiX = Math.max(c1x, c2x)
    const loY = Math.min(ay, by)
    const hiY = Math.max(ay, by)
    if (hiX < ox || loX > ox + cw || hiY < oy || loY > oy + ch) return undefined
    const q = (x: number, y: number) =>
      containToMedia(
        Math.min(ox + cw, Math.max(ox, x)),
        Math.min(oy + ch, Math.max(oy, y)),
        stageW,
        stageH,
        videoW,
        videoH,
      )
    const c1 = q(c1x, ay)
    const c2 = q(c2x, by)
    if (!c1 || !c2) return undefined
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

/**
 * Forward fit: model approx percents (raw-frame space) to 0-100 stage
 * percents through the same cover/contain geometry the overlay inverses
 * use. Mirrored stages flip in media space first. Falls back to a plain
 * mirror flip when stage or media dims are unknown.
 */
export function approxToStage(
  approxX: number,
  approxY: number,
  stageW: number,
  stageH: number,
  videoW: number,
  videoH: number,
  mirrored = false,
  fit: FitMode = 'cover',
): { x: number; y: number } {
  const rawX = clampPct(approxX)
  const rawY = clampPct(approxY)
  const fallback = { x: mirrored ? 100 - rawX : rawX, y: rawY }
  if (
    !Number.isFinite(stageW) ||
    !Number.isFinite(stageH) ||
    stageW <= 0 ||
    stageH <= 0 ||
    !Number.isFinite(videoW) ||
    !Number.isFinite(videoH) ||
    videoW <= 0 ||
    videoH <= 0
  ) {
    return fallback
  }
  const fx = (mirrored ? 100 - rawX : rawX) / 100
  const fy = rawY / 100
  if (fit === 'contain') {
    const contain = Math.min(stageW / videoW, stageH / videoH)
    const ox = (stageW - videoW * contain) / 2
    const oy = (stageH - videoH * contain) / 2
    return {
      x: clampPct(((fx * videoW * contain + ox) / stageW) * 100),
      y: clampPct(((fy * videoH * contain + oy) / stageH) * 100),
    }
  }
  const cover = Math.max(stageW / videoW, stageH / videoH)
  const dx = (videoW * cover - stageW) / 2
  const dy = (videoH * cover - stageH) / 2
  return {
    x: clampPct(((fx * videoW * cover - dx) / stageW) * 100),
    y: clampPct(((fy * videoH * cover - dy) / stageH) * 100),
  }
}

/**
 * Backing-store UI scale: canvas pixels per display px, so badge fonts,
 * strokes, and blurs hold a constant on-screen size at any capture
 * resolution. Falls back to 1 without measurable dims.
 */
export function overlayUiScale(displayH: number, canvasH: number): number {
  if (!Number.isFinite(displayH) || !Number.isFinite(canvasH) || displayH <= 0 || canvasH <= 0) {
    return 1
  }
  return canvasH / displayH
}

/** Optional geometry for zoom-aware, chrome-aware callout placement. */
export interface CalloutStyleOpts {
  zoom?: ZoomState
  stageW?: number
  stageH?: number
  headerH?: number
  dockH?: number
}

/**
 * Edge-collision placement for callout pills: edge pills anchor inward and
 * near-top pills drop below their point. With stage geometry the point
 * re-projects through zoom so the pill tracks the zoomed part, clamps into
 * the header/dock-free strip, and carries safe-area insets itself (wrapper
 * padding cannot shift an absolute child) with a 0.5rem minimum gutter.
 */
export function calloutStyle(
  x: number,
  y: number,
  opts: CalloutStyleOpts = {},
): { left: string; top: string; transform: string } {
  const { zoom, stageW = 0, stageH = 0, headerH = 0, dockH = 0 } = opts
  const stageKnown =
    Number.isFinite(stageW) && Number.isFinite(stageH) && stageW > 0 && stageH > 0
  let cx = clampPct(x)
  let cy = clampPct(y)
  if (
    zoom &&
    stageKnown &&
    Number.isFinite(zoom.scale) &&
    zoom.scale > 0 &&
    Number.isFinite(zoom.x) &&
    Number.isFinite(zoom.y)
  ) {
    const sx = (cx / 100) * stageW
    const sy = (cy / 100) * stageH
    cx = clampPct(((sx * zoom.scale + zoom.x) / stageW) * 100)
    cy = clampPct(((sy * zoom.scale + zoom.y) / stageH) * 100)
  }
  let topPct = 0
  if (stageKnown) {
    const hh = Number.isFinite(headerH) && headerH > 0 ? headerH : 0
    const dh = Number.isFinite(dockH) && dockH > 0 ? dockH : 0
    topPct = (hh / stageH) * 100
    const bottomPct = ((stageH - dh) / stageH) * 100
    if (bottomPct >= topPct) cy = Math.min(bottomPct, Math.max(topPct, cy))
  }
  const tx = cx < 20 ? '0' : cx > 80 ? '-100%' : '-50%'
  const chromeKnown = stageKnown && (headerH > 0 || dockH > 0)
  const nearTop = chromeKnown ? cy - topPct < 12 : cy < 25
  const ty = nearTop ? '8px' : 'calc(-100% - 8px)'
  const left =
    cx < 20
      ? `calc(${cx}% + max(0.5rem, env(safe-area-inset-left)))`
      : cx > 80
        ? `calc(${cx}% - max(0.5rem, env(safe-area-inset-right)))`
        : `${cx}%`
  return { left, top: `${cy}%`, transform: `translate(${tx}, ${ty})` }
}
