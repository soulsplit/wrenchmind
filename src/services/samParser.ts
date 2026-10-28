import {
  decodeMaskToRaster,
  frameIndexOf,
  parseImageStream,
  recordsOfKind,
} from '@meta-sam/parser'
import type { MaskRecord } from '../types'
import { logWarn } from './logger'

/**
 * Parse a SAM image stream into mask records. Box corners convert from the
 * half-open parsed shape to inclusive wire pixels, then shrink to the tight
 * bounding box of set mask pixels so loose model boxes don't inflate overlays.
 */
export async function parseSamStream(
  events: AsyncIterable<{ readonly type: string }>,
): Promise<MaskRecord[]> {
  const result = await parseImageStream(events).finalResult
  const boxes = new Map(
    recordsOfKind(result.records, 'box').map((box) => [box.objectId, box]),
  )
  const out: MaskRecord[] = []
  for (const maskRec of recordsOfKind(result.records, 'mask')) {
    const box = boxes.get(maskRec.objectId)
    if (!box) continue
    let raster: Uint8Array
    try {
      raster = decodeMaskToRaster(maskRec.mask)
    } catch {
      logWarn('segment', `skipping undecodable mask for object ${maskRec.objectId}`)
      continue
    }
    const w = maskRec.mask.width
    const h = maskRec.mask.height
    const tight = tightBounds(raster, w, h)
    if (!tight) {
      // Empty raster: keep the model box so the record still locates something.
      out.push({
        frame: frameIndexOf(maskRec) ?? 0,
        ordinal: out.length,
        objectId: maskRec.objectId,
        box: {
          x1: box.left,
          y1: box.top,
          x2: box.right - 1,
          y2: box.bottom - 1,
          w,
          h,
        },
        raster,
      })
      continue
    }
    const tw = tight.maxX - tight.minX + 1
    const th = tight.maxY - tight.minY + 1
    const cropped = new Uint8Array(tw * th)
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        cropped[y * tw + x] = raster[(tight.minY + y) * w + tight.minX + x]
      }
    }
    out.push({
      frame: frameIndexOf(maskRec) ?? 0,
      ordinal: out.length,
      objectId: maskRec.objectId,
      box: {
        x1: box.left + tight.minX,
        y1: box.top + tight.minY,
        x2: box.left + tight.maxX,
        y2: box.top + tight.maxY,
        w: tw,
        h: th,
      },
      raster: cropped,
    })
  }
  return out
}

/**
 * Scale a capture-space record back to source-video pixels (nearest
 * neighbor): box corners map through the half-open form so 1px boxes stay
 * non-degenerate, and the raster resamples to the mapped box. Returns the
 * same record when both spaces match; clamps to the video frame.
 */
export function scaleRecordToVideo(
  rec: MaskRecord,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
): MaskRecord {
  if (!fromW || !fromH || !toW || !toH) return rec
  if (fromW === toW && fromH === toH) return rec
  const sx = toW / fromW
  const sy = toH / fromH
  const x1 = Math.min(toW - 1, Math.max(0, Math.round(rec.box.x1 * sx)))
  const y1 = Math.min(toH - 1, Math.max(0, Math.round(rec.box.y1 * sy)))
  const x2 = Math.min(toW - 1, Math.max(0, Math.round((rec.box.x2 + 1) * sx) - 1))
  const y2 = Math.min(toH - 1, Math.max(0, Math.round((rec.box.y2 + 1) * sy) - 1))
  const w = Math.max(1, x2 - x1 + 1)
  const h = Math.max(1, y2 - y1 + 1)
  const ow = rec.box.w
  const oh = rec.box.h
  let raster: Uint8Array
  if (rec.raster.length === 0 || ow <= 0 || oh <= 0) {
    raster = new Uint8Array(0)
  } else if (ow === w && oh === h) {
    raster = rec.raster
  } else {
    raster = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      const srcY = Math.min(oh - 1, Math.floor((y * oh) / h))
      for (let x = 0; x < w; x++) {
        const srcX = Math.min(ow - 1, Math.floor((x * ow) / w))
        raster[y * w + x] = rec.raster[srcY * ow + srcX]
      }
    }
  }
  return { ...rec, box: { x1, y1, x2, y2, w, h }, raster }
}

interface TightBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Bounding box of set pixels in raster coords, or null when none are set. */
function tightBounds(raster: Uint8Array, w: number, h: number): TightBounds | null {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (raster[y * w + x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY }
}
