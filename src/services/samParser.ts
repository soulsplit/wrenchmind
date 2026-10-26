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
