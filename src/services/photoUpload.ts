/**
 * Uploaded-photo stills: decode an image file into a canvas that works
 * exactly like a frozen camera frame downstream (display, tap/circle
 * prompts, capture/crop for the APIs).
 */

/** Longest side of an uploaded-photo still; matches the API capture cap. */
export const UPLOAD_MAX_SIDE = 1920

/** Largest file decoded; bigger files are rejected before decode (self-DoS). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Decode via an <img> element where createImageBitmap is unavailable. */
function decodeViaElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('undecodable'))
    }
    img.src = url
  })
}

/**
 * Decode an image file into a still canvas, downscaled to UPLOAD_MAX_SIDE
 * on the longest side (never upscaled). Rejects with a user-facing message
 * when the file is not a readable image.
 */
export async function decodePhotoFile(
  file: File,
  maxSide: number = UPLOAD_MAX_SIDE,
): Promise<HTMLCanvasElement> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('Could not read that photo — try a JPEG or PNG.')
  }
  let source: { width: number; height: number; close?: () => void }
  try {
    if (typeof createImageBitmap === 'function') {
      source = await createImageBitmap(file)
    } else {
      source = await decodeViaElement(file)
    }
  } catch {
    throw new Error('Could not read that photo — try a JPEG or PNG.')
  }
  const { width: w, height: h } = source
  try {
    if (!w || !h) throw new Error('empty')
    const scale = Math.min(1, maxSide / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(w * scale))
    canvas.height = Math.max(1, Math.floor(h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height)
    return canvas
  } catch {
    throw new Error('Could not read that photo — try a JPEG or PNG.')
  } finally {
    source.close?.()
  }
}
