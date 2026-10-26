export interface SpatialResult {
  target_label: string
  /** Approximate target x in 0-100 viewport percent. */
  approx_x: number
  /** Approximate target y in 0-100 viewport percent. */
  approx_y: number
  speech_response: string | null
  display_mode: 'visual_only' | 'speech_and_visual'
}

export interface MaskBox {
  /** Inclusive source-pixel corners; w/h are the raster dims covering (x1,y1)-(x2,y2). */
  x1: number
  y1: number
  x2: number
  y2: number
  w: number
  h: number
}

export interface MaskRecord {
  frame: number
  /** Position in the parsed output. */
  ordinal: number
  /** Stable per-object id from the SAM response (sparse, not positional). */
  objectId: string
  box: MaskBox
  /** Row-major binary raster, length w*h, origin at (x1,y1). */
  raster: Uint8Array
}

export type Status = 'off' | 'listening' | 'analyzing' | 'error'

export interface MemoryEntry {
  phrase: string
  label: string
  x: number
  y: number
  timestamp: number
}

export type OverlayKind = 'component' | 'connector' | 'fastener'

export interface Callout {
  label: string
  /** Viewport percent 0-100. */
  x: number
  /** Viewport percent 0-100. */
  y: number
  kind: OverlayKind
}
