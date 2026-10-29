export interface SpatialResult {
  target_label: string
  /** Approximate target x in 0-100 viewport percent. */
  approx_x: number
  /** Approximate target y in 0-100 viewport percent. */
  approx_y: number
  /**
   * Every visible instance for plural commands ("all bolts"), 0-100 pct.
   * Undefined for singular targets. Clamped and capped by the parser.
   */
  points?: { x: number; y: number }[]
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

export type Status = 'off' | 'listening' | 'analyzing' | 'speaking' | 'error'

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

/**
 * One numbered repair step.
 * D2 trust: model-generated, never authoritative. `warning` is a per-step
 * caution; it does not replace the mandatory top-level `warnings` slot.
 */
export interface GuidanceStep {
  /** Short step heading. */
  title: string
  /** What to do, in plain instructional prose. */
  detail: string
  /** Optional step-local caution (e.g. "hot surface"). */
  warning?: string
}

/**
 * One labeled spec value (torque, capacity, gap, ...).
 * D2 trust: ALWAYS rendered with the persistent "verify against manual"
 * treatment. The pipeline must emit `specs: []` plus a `warnings` entry
 * when a spec is unknown rather than inventing a value. No numeric
 * confidence field exists anywhere on this contract by design —
 * a model-stated percentage would be fabricated authority.
 */
export interface GuidanceSpec {
  label: string
  value: string
}

/**
 * One grounding citation.
 * D2 trust: the visible evidence line that replaces numeric confidence.
 * URLs come from `url_citation` annotations on the grounding call (D10:
 * the model web-searches, reads, and parses the best-fit repair/user
 * manual; see `manualTitle`). Render as links; never fabricate.
 */
export interface GuidanceSource {
  title: string
  url: string
}

/**
 * Shared repair-guidance data model (grill D1/D2/D8/D10).
 * Consumed by the HUD cards now and by voice output later.
 *
 * D2 trust posture: model-generated content is never presented as
 * authoritative. Safety-critical numbers always carry a persistent
 * "verify against manual" treatment, the `warnings` slot is mandatory,
 * and validation constrains formats and refuses to invent unknown specs.
 * POC flaw tolerance accepted; fabricated authority is not.
 * There is intentionally NO numeric confidence field.
 */
export interface GuidanceResult {
  /** Part or job title, e.g. "MID-DRIVE DRIVE BELT". */
  title: string
  /** Ordered repair steps. Must be non-empty; drop malformed entries. */
  steps: GuidanceStep[]
  /**
   * Spec values. Every entry is rendered with verify treatment (see
   * `GuidanceSpec`). Empty array when no spec is known — never invented.
   */
  specs: GuidanceSpec[]
  /** Tool list, e.g. ["T20 Torx", "Trim tool"]. */
  tools: string[]
  /**
   * MANDATORY slot. Must render even when empty (show a generic
   * "verify against manual" caution rather than omitting the slot).
   */
  warnings: string[]
  /**
   * Citation URLs grounding this guidance (D10 manual retrieval).
   * Rendered as the sources line; empty when grounding failed.
   */
  sources: GuidanceSource[]
  /**
   * Title of the manual the model read and parsed as grounding source,
   * or null when no manual was found/parsed (D10). Null strengthens —
   * never weakens — the verify treatment.
   */
  manualTitle: string | null
}
