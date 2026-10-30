import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Callout,
  GuidanceResult,
  MaskBox,
  MaskRecord,
  OverlayKind,
  Status,
} from '../types'
import {
  captureDims,
  captureFrameBurst,
  captureThumbnail,
  captureVideoFrame,
  extractLabelText,
  hasApiKey,
  reasonSpatial,
  segmentImage,
  toCaptureBox,
  toCapturePoint,
} from '../services/metaApi'
import type { SamPointPrompt } from '../services/metaApi'
import {
  clampPct,
  clampZoomPan,
  identifyWithContext,
  NO_ZOOM,
  pinchZoom,
  stageBoxToMedia,
  tapToMedia,
  zoomAt,
  ZOOM_MIN,
  type ZoomState,
} from '../services/feedStage'
import { parseSamStream, scaleRecordToVideo } from '../services/samParser'
import { cancelSpeech, speakText } from '../services/speechOutput'
import { fetchGuidance } from '../services/guidanceApi'
import { buildQuery, searchGuides, type FixitGuide } from '../services/ifixitApi'
import { downloadReport, shareReport } from '../services/report'
import type { ProcedureSnapshot } from '../services/report'
import { VoiceAssistant } from '../services/voiceAssistant'
import {
  describeCameraError,
  permissionBlocker,
  secureContextBlocker,
} from '../services/mediaSupport'
import { logDebug, logError, logInfo, logWarn } from '../services/logger'
import QueryBar from './QueryBar'
import Header from './Header'
import HudCard from './HudCard'
import Sidebar from './Sidebar'
import { useDesktopLayout } from '../hooks/useDesktopLayout'
import { useKeyboardShift } from '../hooks/useKeyboardShift'

interface Overlay {
  rec: MaskRecord
  kind: OverlayKind
  /** Number badge for plural isolations; singular targets stay unlabeled. */
  label?: string
}

interface RefreshTarget {
  label: string
  /** 0-100 viewport points; length > 1 keeps a plural isolation tracking. */
  points: { x: number; y: number }[]
}

/**
 * Torch capability/constraint shapes. Absent from this TS DOM lib but
 * present at runtime on supporting devices (Chrome/Android).
 */
interface TorchCapabilities extends MediaTrackCapabilities {
  torch?: unknown
}

interface TorchConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean
}

/** Re-segment cadence while an overlay tracks a moving subject. */
const REFRESH_INTERVAL_MS = 2000

/** Spotlight dim opacity over non-target frame regions. */
const DIM_ALPHA = 0.55

const STROKE: Record<OverlayKind, string> = {
  component: '#00ffff',
  connector: '#ffff00',
  fastener: '#ff0000',
}

function classifyTarget(label: string): OverlayKind {
  const l = label.toLowerCase()
  if (/(connector|plug|wiring|wire|harness|electrical|terminal|cable|socket)/.test(l)) {
    return 'connector'
  }
  if (/(screw|bolt|nut|fastener|torque|clip|rivet|washer|stud)/.test(l)) {
    return 'fastener'
  }
  return 'component'
}

/**
 * Edge-collision placement for callout pills: pills near the left/right edges
 * anchor inward (a left-edge pill grows rightward from its point, a right-edge
 * pill grows leftward) instead of centering off-viewport, and pills near the
 * top drop below their point instead of clipping under the header. Long
 * labels are additionally ellipsized by the pill's own max-width.
 */
function calloutStyle(x: number, y: number): { left: string; top: string; transform: string } {
  const cx = clampPct(x)
  const cy = clampPct(y)
  const tx = cx < 20 ? '0' : cx > 80 ? '-100%' : '-50%'
  const ty = cy < 25 ? '8px' : 'calc(-100% - 8px)'
  return { left: `${cx}%`, top: `${cy}%`, transform: `translate(${tx}, ${ty})` }
}

type StepCommand = 'next' | 'prev' | 'repeat'

/**
 * Hands-free procedure control ("done", "next", "back", "repeat").
 * Full-phrase match only: anything longer ("show me the next bolt") falls
 * through to the normal query pipeline.
 */
function parseStepCommand(phrase: string): StepCommand | null {
  const p = phrase.trim().toLowerCase().replace(/[.?!]+$/, '')
  if (/^(done|next|next step|continue|go on)$/.test(p)) return 'next'
  if (/^(back|go back|previous|previous step)$/.test(p)) return 'prev'
  if (/^(repeat|read step|read it again|say again)$/.test(p)) return 'repeat'
  return null
}

/**
 * Label-read queries ("read this label", "what does this say").
 * Full-phrase match only, like step commands: longer sentences fall
 * through to the normal spatial pipeline.
 */
function isLabelQuery(phrase: string): boolean {
  return /^(read (this|the) label|read this|what does (this|the label) say)\??$/i.test(
    phrase.trim(),
  )
}

/** Hold time promoting a frozen-frame tap to an outline-removing long-press. */
const LONG_PRESS_MS = 500
/** Finger drift cancelling a long-press. */
const LONG_PRESS_SLOP_PX = 10
/** Min trace bbox span (untransformed px) that counts as a circle query. */
const TRACE_MIN_SPAN = 24
/** Min move between recorded trace points; bounds array growth. */
const TRACE_POINT_GAP = 2
/** Cap on recorded trace points per stroke. */
const TRACE_MAX_POINTS = 1000
/** Fraction of the frame's short side used for the tap fallback crop. */
const FALLBACK_CROP_FRACTION = 0.25
/**
 * Rotating coach-mark hints for the badge row; index 0 is the primary
 * gesture hint. Rotation (not stacking) keeps one-line chrome while
 * teaching long-press remove, the 1x circle rule, and voice discovery.
 */
const HINTS = [
  'Drag to circle a part · tap to identify',
  'Hold an outline to remove it',
  'Pinch back to 1x to circle a part',
  'Voice mode lives in the ⋯ menu',
]
/** Coach-mark rotation cadence while the feed is usable. */
const HINT_ROTATE_MS = 8000

/** localStorage gate for the one-time voice-mode coach mark. */
const VOICE_COACH_KEY = 'wrenchmind.voiceCoachSeen'

/** Largest mask by box area; null when SAM returns none. */
function largestMask(recs: MaskRecord[]): MaskRecord | null {
  if (recs.length === 0) return null
  return recs.reduce((a, b) =>
    (b.box.x2 - b.box.x1 + 1) * (b.box.y2 - b.box.y1 + 1) >
    (a.box.x2 - a.box.x1 + 1) * (a.box.y2 - a.box.y1 + 1)
      ? b
      : a,
  )
}

/** Tap-centered box for identification when SAM returns no masks. */
function fallbackBox(point: SamPointPrompt, vw: number, vh: number): MaskBox {
  const size = Math.max(1, Math.floor(Math.min(vw, vh) * FALLBACK_CROP_FRACTION))
  const half = Math.floor(size / 2)
  const x1 = Math.min(vw - size, Math.max(0, point.x - half))
  const y1 = Math.min(vh - size, Math.max(0, point.y - half))
  return { x1, y1, x2: x1 + size - 1, y2: y1 + size - 1, w: size, h: size }
}

/** Convert 0-100 viewport coords to media pixels; undefined when dims are unknown. */
function toPixelPoint(
  ax: number,
  ay: number,
  w: number,
  h: number,
): SamPointPrompt | undefined {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined
  return {
    x: Math.min(w - 1, Math.max(0, Math.floor((ax / 100) * w))),
    y: Math.min(h - 1, Math.max(0, Math.floor((ay / 100) * h))),
    width: w,
    height: h,
  }
}

export default function Scanner() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('off')
  const [error, setError] = useState<string>('')
  const [voiceOn, setVoiceOn] = useState(false)
  const [callout, setCallout] = useState<Callout | null>(null)
  const overlaysRef = useRef<Overlay[]>([])
  /** Cached hole-punch staging canvas; resized per overlay in draw(). */
  const holeRef = useRef<HTMLCanvasElement | null>(null)
  const assistantRef = useRef<VoiceAssistant | null>(null)
  const voiceOnRef = useRef(false)
  voiceOnRef.current = voiceOn
  const busyRef = useRef(false)
  /** FIFO of phrases spoken while analysis is in flight; drained in order. */
  const pendingRef = useRef<string[]>([])
  const pressRef = useRef<{ x: number; y: number; timer: number } | null>(null)
  const suppressTapRef = useRef(false)
  const pointersRef = useRef(new Map<number, { x: number; y: number; sx: number; sy: number; t0: number }>())
  const pinchRef = useRef<{ dist: number; midX: number; midY: number } | null>(null)
  /**
   * Circle-trace stroke in untransformed stage coords; null when idle. The
   * ref leads so pointerup always sees the full path: move updates batch
   * (continuous events), but the release decision must not wait for a
   * render. Both are always assigned together via storeTrace.
   */
  const traceRef = useRef<{ x: number; y: number }[] | null>(null)
  const [trace, setTrace] = useState<{ x: number; y: number }[] | null>(null)
  const storeTrace = (next: { x: number; y: number }[] | null) => {
    traceRef.current = next
    setTrace(next)
  }
  // Tracking lock: once an item is identified, follow-up phrases answer by
  // voice without re-marking. Ref is the source of truth for handlePhrase
  // (keeps its identity stable for the voice lifecycle effect); state mirrors
  // it for rendering. Both are always assigned together.
  const trackingRef = useRef(false)
  const [tracking, setTracking] = useState(false)
  const targetRef = useRef<RefreshTarget | null>(null)
  const refreshRef = useRef<number | null>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [multiCamera, setMultiCamera] = useState(true)
  const [torchOn, setTorchOn] = useState(false)
  const [hasTorch, setHasTorch] = useState(false)
  const [cameraLive, setCameraLive] = useState(false)
  const [frozen, setFrozen] = useState(false)
  const frozenRef = useRef(false)
  frozenRef.current = frozen
  /** Pixel source of truth while frozen; the video element carries no stream. */
  const stillRef = useRef<HTMLCanvasElement | null>(null)
  const [stillUrl, setStillUrl] = useState<string | null>(null)
  /** Bumped on unfreeze to re-acquire the camera via the camera effect. */
  const [restartKey, setRestartKey] = useState(0)
  const [hintIndex, setHintIndex] = useState(0)
  /**
   * One-time voice-mode coach mark. The rotating badge hint also teaches
   * voice discovery, but it scrolls past; this non-rotating pill shows
   * until dismissed once (persisted in localStorage) so first-run users
   * actually see it. Hidden while voice mode is already on.
   */
  const [voiceCoachSeen, setVoiceCoachSeen] = useState(() => {
    try {
      return window.localStorage.getItem(VOICE_COACH_KEY) === '1'
    } catch {
      return false
    }
  })
  const dismissVoiceCoach = () => {
    try {
      window.localStorage.setItem(VOICE_COACH_KEY, '1')
    } catch {
      /* private mode etc. — the pill simply returns next visit */
    }
    setVoiceCoachSeen(true)
  }
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const [actualFacing, setActualFacing] = useState<'environment' | 'user' | 'unknown'>('unknown')
  const [findings, setFindings] = useState<string[]>([])
  /** Photo checkpoint per completed step index; pinned on advance, cleared per job. */
  const [stepPhotos, setStepPhotos] = useState<Record<number, string>>({})
  const [guidance, setGuidance] = useState<GuidanceResult | null>(null)
  const [guidancePending, setGuidancePending] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  // Ref mirrors so the stable handlePhrase can answer step commands
  // without re-subscribing the voice lifecycle effect.
  const guidanceRef = useRef<GuidanceResult | null>(null)
  guidanceRef.current = guidance
  /** Session procedure history for the report; appended on replace/clear, never reset. */
  const guidanceHistoryRef = useRef<ProcedureSnapshot[]>([])
  const stepIndexRef = useRef(0)
  stepIndexRef.current = stepIndex
  const [emptyTarget, setEmptyTarget] = useState(false)
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && !navigator.onLine,
  )
  const guidanceReqRef = useRef(0)
  /** iFixit hits for the current part; undefined while loading. */
  const [guides, setGuides] = useState<FixitGuide[]>()
  const guidesReqRef = useRef(0)
  /** False after unmount: guards fire-and-forget fetches against setState. */
  const mountedRef = useRef(true)
  // Desktop layout branch (lg+): the feed narrows to 2/3 and the sidebar
  // hosts the guidance card; the bottom-docked card unmounts to avoid
  // duplicating it.
  const isDesktop = useDesktopLayout()
  /**
   * Mirror self-view: desktop webcams and front cameras render flipped so
   * the feed acts like a mirror. Display flips via CSS (-scale-x-100 on the
   * video, still, and overlay canvas); taps, circles, and voice approx
   * coords flip back to raw-frame pixels before reaching SAM, while
   * callouts stay in untransformed stage space. The ref mirror keeps the
   * stable handlePhrase voice path flip-aware without re-subscribing.
   */
  const mirrored = isDesktop || actualFacing === 'user'
  const mirroredRef = useRef(mirrored)
  mirroredRef.current = mirrored
  // Keyboard lift: the bottom dock alone rides above the visual viewport.
  const keyboardShift = useKeyboardShift()

  /** Stop every track on the video element and mark the feed dark. */
  const stopTracks = useCallback(() => {
    const video = videoRef.current
    const stream = video?.srcObject as MediaStream | null
    stream?.getTracks().forEach((t) => t.stop())
    if (video) video.srcObject = null
    setCameraLive(false)
  }, [])

  /**
   * Current frame source: the frozen still canvas while frozen, else the
   * live video element. Refs only — []-stable for the voice chain.
   */
  const frameTarget = useCallback((): {
    el: HTMLVideoElement | HTMLCanvasElement | null
    w: number
    h: number
  } => {
    if (frozenRef.current && stillRef.current) {
      const still = stillRef.current
      return { el: still, w: still.width, h: still.height }
    }
    const video = videoRef.current
    return { el: video, w: video?.videoWidth ?? 0, h: video?.videoHeight ?? 0 }
  }, [])

  const draw = useCallback((force = false) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w: fw, h: fh } = frameTarget()
    const w = fw || window.innerWidth
    const h = fh || window.innerHeight
    // Blank canvases stay blank: skip the resize/clear churn when idle.
    if (!force && overlaysRef.current.length === 0 && canvas.width === w && canvas.height === h) {
      return
    }
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Spotlight: dim the full frame, then punch each target back to clear.
    if (overlaysRef.current.length > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${DIM_ALPHA})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = 'destination-out'
      for (const { rec } of overlaysRef.current) {
        const { box, raster } = rec
        if (raster.length > 0) {
          let hole = holeRef.current
          if (!hole) {
            hole = document.createElement('canvas')
            holeRef.current = hole
          }
          hole.width = box.w
          hole.height = box.h
          const holeCtx = hole.getContext('2d')
          if (holeCtx) {
            const img = holeCtx.createImageData(box.w, box.h)
            const pixels = Math.min(raster.length, box.w * box.h)
            for (let i = 0; i < pixels; i++) {
              if (raster[i]) {
                img.data[i * 4 + 3] = 255
              }
            }
            holeCtx.putImageData(img, 0, 0)
            ctx.drawImage(hole, box.x1, box.y1)
          }
        } else {
          // Box corners are inclusive pixels.
          ctx.fillRect(box.x1, box.y1, box.x2 - box.x1 + 1, box.y2 - box.y1 + 1)
        }
      }
      ctx.globalCompositeOperation = 'source-over'
    }
    for (const { rec, kind, label } of overlaysRef.current) {
      const { box } = rec
      ctx.strokeStyle = STROKE[kind]
      ctx.lineWidth = 3
      ctx.shadowColor = STROKE[kind]
      ctx.shadowBlur = 12
      // Box corners are inclusive pixels.
      ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1 + 1, box.y2 - box.y1 + 1)
      if (label) {
        ctx.save()
        ctx.shadowBlur = 0
        ctx.font = 'bold 24px system-ui, sans-serif'
        const badgeY = Math.max(28, box.y1 - 4)
        const badgeW = ctx.measureText(label).width + 16
        // Clamp the badge origin so badgeX + badgeW never exceeds the canvas.
        const badgeX = Math.min(Math.max(0, box.x1), Math.max(0, canvas.width - badgeW))
        if (mirroredRef.current) {
          // Counter-flip: mirror the badge around its own center so the
          // pill lands on the same pixels while the glyphs pre-mirror —
          // the CSS flip then restores readable text on screen. Display
          // only: exports capture the raw video/still, never this canvas.
          ctx.translate(2 * (badgeX + badgeW / 2), 0)
          ctx.scale(-1, 1)
        }
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)'
        ctx.fillRect(badgeX, badgeY - 28, badgeW, 28)
        ctx.fillStyle = STROKE[kind]
        ctx.fillText(label, badgeX + 8, badgeY - 7)
        ctx.restore()
      }
    }
    ctx.shadowBlur = 0
  }, [frameTarget])

  // Surface a missing API key up front instead of failing per phrase.
  useEffect(() => {
    if (!hasApiKey()) {
      logError('config', 'missing VITE_META_MODEL_API_KEY')
      setError('API key missing: set VITE_META_MODEL_API_KEY in .env')
    }
  }, [])

  // Offline banner: reflect connectivity loss without touching the pipeline.
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  // Camera init: preferred facing first, then the other facing, then any camera.
  // Re-runs when the user flips between front and back.
  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    ;(async () => {
      const blocker =
        secureContextBlocker('Camera') ?? (await permissionBlocker('camera', 'Camera access'))
      if (blocker) {
        if (!cancelled) {
          logError('camera', blocker)
          setError(blocker)
          // Failed restart (a still exists, so this is not initial load):
          // fall back to frozen so the still stays tappable and unfreezing
          // retries the camera.
          if (stillRef.current) setFrozen(true)
        }
        return
      }
      const other = facing === 'environment' ? 'user' : 'environment'
      // ideal resolution never fails: capable cameras give up to 4K for the
      // zoomable feed, weaker ones simply negotiate what they support.
      const hiRes = { width: { ideal: 3840 }, height: { ideal: 2160 } }
      const attempts: { label: string; constraints: MediaStreamConstraints }[] = [
        { label: facing, constraints: { video: { facingMode: facing, ...hiRes } } },
        { label: other, constraints: { video: { facingMode: other, ...hiRes } } },
        { label: 'any', constraints: { video: true } },
      ]
      let lastError: unknown = null
      for (const { label, constraints } of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints)
          logInfo('camera', `using ${label} camera`)
          break
        } catch (e) {
          // The exception name is the diagnosis (dismissed prompt vs busy
          // hardware), so it rides into the log and the final message.
          lastError = e
          const name = e instanceof Error ? e.name : 'UnknownError'
          logWarn('camera', `${label} camera unavailable (${name})`)
          stream = null
        }
      }
      if (cancelled) {
        stream?.getTracks().forEach((t) => t.stop())
        return
      }
      if (!stream) {
        const hint =
          (await permissionBlocker('camera', 'Camera access')) ?? describeCameraError(lastError)
        logError('camera', `all camera attempts failed (${hint})`)
        setError(hint)
        // Failed restart (a still exists, so this is not initial load):
        // fall back to frozen so the still stays tappable and unfreezing
        // retries the camera.
        if (stillRef.current) setFrozen(true)
        return
      }
      if (!cancelled) {
        // Ground truth for the badge: the requested facing may have fallen
        // back (desktop webcams report no facingMode at all).
        const track = stream.getVideoTracks()[0]
        const settings = track?.getSettings?.()
        const mode = settings?.facingMode
        setActualFacing(mode === 'environment' || mode === 'user' ? mode : 'unknown')
        if (settings?.width && settings?.height) {
          logInfo('camera', `negotiated ${settings.width}x${settings.height}`)
        }
        // Torch is per-track: recompute on every (re)connect and start dark.
        const caps = track?.getCapabilities?.() as TorchCapabilities | undefined
        setHasTorch(caps?.torch === true)
        setTorchOn(false)
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const cameras = devices.filter((d) => d.kind === 'videoinput')
        if (!cancelled && cameras.length === 1) setMultiCamera(false)
      } catch {
        /* enumeration unavailable — keep the switcher visible */
      }
      if (cancelled) {
        stream?.getTracks().forEach((t) => t.stop())
        return
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try {
          await videoRef.current.play()
          // Re-check after the await: unmount/facing-change during play
          // must not touch the torn-down element.
          if (cancelled) return
          setCameraLive(true)
          // Re-acquire succeeded: drop the still only now so the frame
          // never flashes black during restart.
          stillRef.current = null
          setStillUrl(null)
        } catch {
          if (!cancelled) logWarn('camera', 'video autoplay was blocked')
        }
      }
    })()
    return () => {
      cancelled = true
      stopTracks()
      setFrozen(false)
      setActualFacing('unknown')
      setTorchOn(false)
      setHasTorch(false)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [facing, restartKey, stopTracks])

  // Rotate the badge-row hint while the feed is usable so secondary
  // gestures (long-press remove, 1x circle rule, voice mode) surface
  // without permanent chrome.
  useEffect(() => {
    if (!frozen && !cameraLive) return
    const timer = window.setInterval(
      () => setHintIndex((i) => (i + 1) % HINTS.length),
      HINT_ROTATE_MS,
    )
    return () => window.clearInterval(timer)
  }, [frozen, cameraLive])

  // Reconcile the canvas backing store when the stream's dimensions
  // arrive or change: draw() sizes from videoWidth/Height, and every
  // overlay mutation already calls draw() directly, so no polling loop is
  // needed to track the stream or repaint idle frames.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const sync = () => draw()
    // Size now in case metadata already loaded before this effect ran.
    sync()
    video.addEventListener('loadedmetadata', sync)
    video.addEventListener('resize', sync)
    return () => {
      video.removeEventListener('loadedmetadata', sync)
      video.removeEventListener('resize', sync)
    }
  }, [draw])

  const clearRefresh = useCallback(() => {
    if (refreshRef.current !== null) {
      window.clearTimeout(refreshRef.current)
      refreshRef.current = null
    }
    targetRef.current = null
  }, [])

  // clearRefresh returned as the cleanup: disarms the refresh loop on unmount.
  useEffect(() => clearRefresh, [clearRefresh])

  // Flip the mounted flag so fire-and-forget guidance/guide fetches skip
  // setState after unmount (React 18 ignores it, but refs stay reachable).
  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  // Silence any in-flight speech on unmount so audio never outlives the view.
  useEffect(() => () => cancelSpeech(), [])

  const tickRefresh = useCallback(async () => {
    refreshRef.current = null
    const target = targetRef.current
    const video = videoRef.current
    const rearm = () => {
      if (targetRef.current && refreshRef.current === null) {
        refreshRef.current = window.setTimeout(() => void tickRefresh(), REFRESH_INTERVAL_MS)
      }
    }
    // Pause while a query is in flight; the loop resumes on the next tick.
    if (!target || !video || busyRef.current || !hasApiKey()) {
      rearm()
      return
    }
    try {
      const img = captureVideoFrame(video)
      if (!img) return
      const cap = captureDims(video.videoWidth, video.videoHeight)
      const pixelPts = target.points
        .map((p) => toPixelPoint(p.x, p.y, video.videoWidth, video.videoHeight))
        .filter((p): p is SamPointPrompt => p !== undefined)
        .map((p) => toCapturePoint(p, cap))
      const prompt = pixelPts.length > 1 ? pixelPts : pixelPts[0]
      const recs = (
        await parseSamStream(segmentImage(img, target.label, prompt))
      ).map((rec) => scaleRecordToVideo(rec, cap.width, cap.height, video.videoWidth, video.videoHeight))
      if (targetRef.current !== target) return
      const kind = classifyTarget(target.label)
      const spans = recs
        .slice(0, 3)
        .map((r) => `${r.box.x2 - r.box.x1 + 1}x${r.box.y2 - r.box.y1 + 1}`)
        .join(',')
      logDebug('segment', `refresh: ${recs.length} masks [${spans}]`)
      const numbered = target.points.length > 1
      overlaysRef.current = recs.map((rec, i) => ({
        rec,
        kind,
        ...(numbered ? { label: String(i + 1) } : {}),
      }))
      draw()
    } catch (e) {
      /* keep the previous overlay on transient refresh failures */
      logWarn('segment', `refresh failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      rearm()
    }
  }, [draw])

  const armRefresh = useCallback(
    (label: string, points: { x: number; y: number }[]) => {
      targetRef.current = { label, points }
      if (refreshRef.current === null) {
        refreshRef.current = window.setTimeout(() => void tickRefresh(), REFRESH_INTERVAL_MS)
      }
    },
    [tickRefresh],
  )

  /** Pause re-segmentation ticks without dropping the tracked target. */
  const pauseRefresh = useCallback(() => {
    if (refreshRef.current !== null) {
      window.clearTimeout(refreshRef.current)
      refreshRef.current = null
    }
  }, [])

  /**
   * Freeze-frame workbench switch. Freezing snapshots the current frame to
   * a still canvas, pauses the refresh timeout (masks stay painted), and
   * stops the camera tracks; resuming clears the trace and AR annotations,
   * drops the tracked target, and bumps restartKey to re-acquire the
   * camera via the effect. The still stays rendered until re-acquire
   * succeeds.
   */
  const setFrozenMode = useCallback(
    (next: boolean) => {
      if (next) {
        const video = videoRef.current
        const vw = video?.videoWidth ?? 0
        const vh = video?.videoHeight ?? 0
        if (video && vw > 0 && vh > 0) {
          const still = document.createElement('canvas')
          still.width = vw
          still.height = vh
          still.getContext('2d')?.drawImage(video, 0, 0, vw, vh)
          stillRef.current = still
          setStillUrl(still.toDataURL('image/jpeg', 0.92))
        }
        pauseRefresh()
        stopTracks()
        if (torchOn) {
          setTorchOn(false)
          logInfo('camera', 'flashlight off (freeze stopped the camera)')
        }
        setFrozen(true)
        logInfo('camera', 'frame frozen — camera stopped, circle or tap a part')
        return
      }
      traceRef.current = null
      setTrace(null)
      // Frozen-scene paint is stale once live; job data — findings,
      // guidance, photos, memory — intentionally preserved.
      overlaysRef.current = []
      setCallout(null)
      setEmptyTarget(false)
      clearRefresh()
      trackingRef.current = false
      setTracking(false)
      draw(true)
      setFrozen(false)
      setRestartKey((k) => k + 1)
      logInfo('camera', 'frame live — AR annotations cleared')
    },
    [pauseRefresh, stopTracks, clearRefresh, draw, torchOn],
  )

  /**
   * Fetch repair guidance alongside segmentation. Fire-and-forget on purpose:
   * guidance must never stall or fail the AR phrase pipeline, and the request
   * id drops stale responses when a newer scan supersedes them.
   */
  /**
   * Voice output only happens in voice mode; otherwise the reply stays
   * visual and the status never claims to speak.
   */
  const speakReply = useCallback(async (text: string): Promise<void> => {
    if (!voiceOnRef.current) return
    setStatus('speaking')
    await speakText(text)
  }, [])

  /**
   * File the live procedure into session history before it is replaced or
   * cleared; the report renders these as earlier procedures. Refs only, so
   * the identity stays []-stable for the requestGuidance chain.
   */
  const snapshotGuidance = useCallback(() => {
    const current = guidanceRef.current
    if (current) {
      guidanceHistoryRef.current.push({ guidance: current, stepIndex: stepIndexRef.current })
    }
  }, [])

  const requestGuidance = useCallback((label: string, phrase: string, context: string) => {
    guidanceReqRef.current += 1
    const reqId = guidanceReqRef.current
    setGuidancePending(true)
    logInfo('guidance', `searching manual for "${label}"`)
    const started = performance.now()
    void fetchGuidance(label, phrase, context).then(
      (result) => {
        if (!mountedRef.current || guidanceReqRef.current !== reqId) return
        snapshotGuidance()
        setGuidance(result)
        setStepIndex(0)
        setStepPhotos({})
        logInfo(
          'guidance',
          `"${result.title}" (${result.steps.length} steps) in ${Math.round(performance.now() - started)}ms`,
        )
      },
      (e: unknown) => {
        if (!mountedRef.current || guidanceReqRef.current !== reqId) return
        logWarn('guidance', `guidance unavailable: ${e instanceof Error ? e.message : String(e)}`)
      },
    ).finally(() => {
      if (!mountedRef.current || guidanceReqRef.current !== reqId) return
      setGuidancePending(false)
    })
  }, [snapshotGuidance])

  /**
   * Fetch iFixit guides alongside guidance. Fire-and-forget like guidance:
   * lookup must never stall the AR pipeline, and failures settle to the
   * empty list so the card shows its fallback search link.
   */
  const requestGuides = useCallback((label: string, phrase: string) => {
    guidesReqRef.current += 1
    const reqId = guidesReqRef.current
    setGuides(undefined)
    const query = buildQuery(phrase, label)
    void searchGuides(query, 3).then(
      (result) => {
        if (!mountedRef.current || guidesReqRef.current !== reqId) return
        setGuides(result)
        logInfo('ifixit', `"${query}" (${result.length} guides)`)
      },
      (e: unknown) => {
        if (!mountedRef.current || guidesReqRef.current !== reqId) return
        setGuides([])
        logWarn('ifixit', `guides unavailable: ${e instanceof Error ? e.message : String(e)}`)
      },
    )
  }, [])

  /**
   * Proof-of-work: pin a thumbnail of the finished step for the report.
   * Shared by voice step commands and the on-screen step buttons so the
   * two paths can't drift; []-stable for the voice chain.
   */
  const pinStepPhoto = useCallback(
    (step: number) => {
      const { el } = frameTarget()
      if (!el) return
      const shot = captureThumbnail(el)
      if (shot) {
        setStepPhotos((prev) => ({ ...prev, [step]: shot }))
        logInfo('photo', `checkpoint pinned to step ${step + 1}`)
      }
    },
    [frameTarget],
  )

  // Identity must stay stable (all deps []-stable): the voice effect
  // resubscribes on change, which would recreate the recognizer mid-listen.
  const handlePhrase = useCallback(async (phrase: string) => {
    // Serialize analyses; phrases spoken mid-flight queue FIFO and drain in order.
    if (busyRef.current) {
      pendingRef.current.push(phrase)
      return
    }
    busyRef.current = true
    try {
      const { el, w: vw, h: vh } = frameTarget()
      const assistant = assistantRef.current
      if (!el) return
      if (!hasApiKey()) {
        setError('API key missing: set VITE_META_MODEL_API_KEY in .env')
        setStatus(voiceOnRef.current ? 'listening' : 'off')
        return
      }
      // Step commands bypass the API pipeline: no camera frames, no
      // re-reasoning — the card state plus voice already answer them.
      const command = parseStepCommand(phrase)
      const card = guidanceRef.current
      if (command && card && card.steps.length > 0) {
        const count = card.steps.length
        const current = Math.min(Math.max(0, stepIndexRef.current), count - 1)
        const next =
          command === 'next'
            ? Math.min(current + 1, count - 1)
            : command === 'prev'
              ? Math.max(current - 1, 0)
              : current
        setStepIndex(next)
        // Proof-of-work: pin a thumbnail to the step just finished. Back and
        // repeat re-read without producing evidence.
        if (command === 'next') pinStepPhoto(current)
        const step = card.steps[next]
        const finished = command === 'next' && current === count - 1
        const line = finished
          ? 'Procedure complete.'
          : `Step ${next + 1} of ${count}: ${step.title}. ${step.detail}${step.warning ? ` Warning: ${step.warning}` : ''}`
        logInfo('step', `"${phrase}" → step ${next + 1}/${count}`)
        await speakReply(line)
        setStatus(voiceOnRef.current ? 'listening' : 'off')
        return
      }
      // Label reads bypass spatial reasoning: one frame, one transcription
      // call, findings shown as chips, spoken, and filed for the report.
      if (isLabelQuery(phrase)) {
        setStatus('analyzing')
        setEmptyTarget(false)
        logInfo('phrase', `"${phrase}"`)
        try {
          const frame = captureVideoFrame(el)
          if (!frame) throw new Error('No video frame')
          const found = await extractLabelText(frame)
          if (found.length === 0) {
            logInfo('label', 'no legible markings')
            await speakReply('I could not read any markings. Try moving closer.')
          } else {
            setFindings(found)
            logInfo('label', `${found.length} markings: ${found.slice(0, 3).join('; ')}`)
            await speakReply(`Label reads: ${found.join('. ')}`)
          }
          setStatus(voiceOnRef.current ? 'listening' : 'off')
        } catch (e) {
          logError('label', e instanceof Error ? e.message : String(e))
          setStatus('error')
          window.setTimeout(() => setStatus(voiceOnRef.current ? 'listening' : 'off'), 2000)
        }
        return
      }
      setStatus('analyzing')
      setEmptyTarget(false)
      logInfo('phrase', `"${phrase}"`)
      try {
        const frames = await captureFrameBurst(el)
        if (frames.length === 0) throw new Error('No video frame')
        logDebug('camera', `burst: ${frames.length} frames`)
        const img = frames[frames.length - 1]
        // Rolling conversation memory ("phrase -> label (x,y) | ..."): the
        // inferred job context both calls share. No explicit scoping field —
        // the tool stays generic across every kind of repair.
        const ctxStr = assistant?.getContextString() ?? ''
        const reasonStart = performance.now()
        const result = await reasonSpatial(frames, phrase, ctxStr)
        const reasonMs = Math.round(performance.now() - reasonStart)
        if (!result.target_label) {
          logWarn('reason', `no target in response in ${reasonMs}ms`)
          if (!trackingRef.current) setEmptyTarget(true)
        } else {
          logInfo(
            'reason',
            `"${result.target_label}" @ (${result.approx_x},${result.approx_y}) [${result.display_mode}] in ${reasonMs}ms`,
          )
        }
        if (result.target_label && !trackingRef.current) {
          // Fire first: guidance needs only the label, so the manual and
          // guide lookups overlap the SAM call instead of waiting for it.
          requestGuidance(result.target_label, phrase, ctxStr)
          requestGuides(result.target_label, phrase)
          const kind = classifyTarget(result.target_label)
          // Plural commands ("all bolts") isolate every instance in one SAM
          // call; singular targets keep the existing single-point path.
          const targetPts =
            result.points && result.points.length > 1
              ? result.points
              : [{ x: result.approx_x, y: result.approx_y }]
          const cap = captureDims(vw, vh)
          const pixelPts = targetPts
            .map((p) => toPixelPoint(p.x, p.y, vw, vh))
            .filter((p): p is SamPointPrompt => p !== undefined)
            .map((p) => toCapturePoint(p, cap))
          const prompt = pixelPts.length > 1 ? pixelPts : pixelPts[0]
          const segmentStart = performance.now()
          const recs = (
            await parseSamStream(segmentImage(img, result.target_label, prompt))
          ).map((rec) =>
            scaleRecordToVideo(rec, cap.width, cap.height, vw, vh),
          )
          const segmentMs = Math.round(performance.now() - segmentStart)
          const spans = recs
            .slice(0, 3)
            .map((r) => `${r.box.x2 - r.box.x1 + 1}x${r.box.y2 - r.box.y1 + 1}`)
            .join(',')
          logDebug(
            'segment',
            `${recs.length} masks [${spans}] in ${vw}x${vh} (${segmentMs}ms)`,
          )
          const plural = targetPts.length > 1 && recs.length > 1
          if (plural) logInfo('segment', `isolated ${recs.length} × "${result.target_label}"`)
          overlaysRef.current = recs.map((rec, i) => ({
            rec,
            kind,
            ...(plural ? { label: String(i + 1) } : {}),
          }))
          assistant?.pushMemory({
            phrase,
            label: result.target_label,
            x: result.approx_x,
            y: result.approx_y,
          })
          setCallout({
            label: plural ? `${recs.length} × ${result.target_label}` : result.target_label,
            // The model answers in raw-frame coords; flip into stage space.
            x: mirroredRef.current ? 100 - result.approx_x : result.approx_x,
            y: result.approx_y,
            kind,
          })
          draw()
          armRefresh(result.target_label, targetPts)
          // Guidance was fired before SAM above: steps stay valid even when
          // segmentation throws, so the error path clears nothing.
          trackingRef.current = true
          setTracking(true)
        } else if (trackingRef.current) {
          logDebug('phrase', 'tracking locked — visuals frozen, answering by voice')
        }
        // Speak only in speech_and_visual mode with a non-null response.
        // visual_only and null responses stay silent (visual-only).
        if (result.display_mode === 'speech_and_visual' && result.speech_response) {
          await speakReply(result.speech_response)
        }
        setStatus(voiceOnRef.current ? 'listening' : 'off')
      } catch (e) {
        logError('phrase', e instanceof Error ? e.message : String(e))
        setStatus('error')
        window.setTimeout(() => setStatus(voiceOnRef.current ? 'listening' : 'off'), 2000)
      }
    } finally {
      busyRef.current = false
      const next = pendingRef.current.shift()
      if (next !== undefined) void handlePhrase(next)
    }
  }, [draw, armRefresh, frameTarget, pinStepPhoto, requestGuidance, requestGuides, speakReply])

  /**
   * Shared tap/circle outline tail: numbered badge, overlay, memory,
   * callout, and log line. Stable (refs + setState + draw only) for the
   * query callbacks.
   */
  const presentOutline = useCallback(
    (args: {
      display: string
      kind: OverlayKind
      rec: MaskRecord
      x: number
      y: number
      phrase: string
      channel: string
    }) => {
      // Max-plus-one keeps badges unique across long-press removals.
      const badge = String(
        overlaysRef.current.reduce(
          (m, o) => Math.max(m, Number.parseInt(o.label ?? '', 10) || 0),
          0,
        ) + 1,
      )
      overlaysRef.current = [...overlaysRef.current, { rec: args.rec, kind: args.kind, label: badge }]
      assistantRef.current?.pushMemory({
        phrase: args.phrase,
        label: args.display,
        x: args.x,
        y: args.y,
      })
      setCallout({ label: args.display, x: args.x, y: args.y, kind: args.kind })
      draw()
      logInfo(args.channel, `"${args.display}" outlined (#${badge})`)
    },
    [draw],
  )

  /**
   * Frozen-frame tap-to-outline: segment at the tap point, crop the largest
   * mask (tap-centered fallback when SAM returns none), identify the part,
   * then outline it with a numbered badge, callout, speech, and memory.
   * Ignored while busy or keyless, or with no frame (neither frozen nor
   * live); holds busyRef for the whole flow.
   */
  const handleTap = useCallback(
    async (clientX: number, clientY: number) => {
      if ((!frozen && !cameraLive) || busyRef.current) return
      const { el, w: vw, h: vh } = frameTarget()
      const layer = tapRef.current
      if (!el || !layer) return
      if (!hasApiKey()) {
        setError('API key missing: set VITE_META_MODEL_API_KEY in .env')
        return
      }
      busyRef.current = true
      try {
        setStatus('analyzing')
        setEmptyTarget(false)
        const tap = tapToMedia(
          clientX,
          clientY,
          layer.getBoundingClientRect(),
          vw,
          vh,
          zoomRef.current.scale,
          mirroredRef.current,
        )
        if (!tap) throw new Error('No video frame')
        const img = captureVideoFrame(el)
        if (!img) throw new Error('No video frame')
        logInfo('tap', `tap @ (${tap.x.toFixed(1)},${tap.y.toFixed(1)})`)
        const cap = captureDims(vw, vh)
        const recs = (
          await parseSamStream(
            segmentImage(img, 'tapped part', toCapturePoint(tap.point, cap)),
          )
        ).map((rec) => scaleRecordToVideo(rec, cap.width, cap.height, vw, vh))
        const largest = largestMask(recs)
        const targetBox = largest
          ? largest.box
          : fallbackBox(tap.point, vw, vh)
        const name = await identifyWithContext(el, targetBox)
        if (!name) logWarn('tap', 'identify inconclusive after tight + wide crops')
        const kind = name ? classifyTarget(name) : 'component'
        const display = name || 'Unknown part'
        const rec: MaskRecord = largest ?? {
          frame: 0,
          ordinal: 0,
          objectId: `tap-${overlaysRef.current.length + 1}`,
          box: targetBox,
          raster: new Uint8Array(0),
        }
        presentOutline({
          display,
          kind,
          rec,
          x: tap.x,
          y: tap.y,
          phrase: 'tap to outline',
          channel: 'tap',
        })
        await speakReply(name || 'I could not identify this part.')
        setStatus(voiceOnRef.current ? 'listening' : 'off')
      } catch (e) {
        logError('tap', e instanceof Error ? e.message : String(e))
        setStatus('error')
        window.setTimeout(() => setStatus(voiceOnRef.current ? 'listening' : 'off'), 2000)
      } finally {
        busyRef.current = false
      }
    },
    [frozen, cameraLive, frameTarget, speakReply, presentOutline],
  )

  /**
   * Circle-to-identify: segment inside the traced region (box prompt plus
   * its center point), identify with the context ladder, then outline.
   * Falls back to the user's own box when SAM returns no masks — the user
   * already framed the part. Ignored while busy or keyless, or with no
   * frame (neither frozen nor live).
   */
  const handleCircle = useCallback(
    async (ax: number, ay: number, bx: number, by: number) => {
      if ((!frozen && !cameraLive) || busyRef.current) return
      const { el, w: vw, h: vh } = frameTarget()
      const stage = stageRef.current
      if (!el || !stage) return
      if (!hasApiKey()) {
        setError('API key missing: set VITE_META_MODEL_API_KEY in .env')
        return
      }
      busyRef.current = true
      try {
        setStatus('analyzing')
        setEmptyTarget(false)
        const region = stageBoxToMedia(
          ax,
          ay,
          bx,
          by,
          stage.clientWidth,
          stage.clientHeight,
          vw,
          vh,
          mirroredRef.current,
        )
        if (!region) throw new Error('No video frame')
        const img = captureVideoFrame(el)
        if (!img) throw new Error('No video frame')
        logInfo('circle', `region @ (${region.x.toFixed(1)},${region.y.toFixed(1)})`)
        const cap = captureDims(vw, vh)
        const recs = (
          await parseSamStream(
            segmentImage(
              img,
              'circled part',
              undefined,
              toCaptureBox(
                {
                  ...region.box,
                  width: vw,
                  height: vh,
                },
                cap,
              ),
            ),
          )
        ).map((rec) => scaleRecordToVideo(rec, cap.width, cap.height, vw, vh))
        const largest = largestMask(recs)
        const targetBox = largest ? largest.box : region.box
        const name = await identifyWithContext(el, targetBox)
        if (!name) logWarn('circle', 'identify inconclusive after tight + wide crops')
        const kind = name ? classifyTarget(name) : 'component'
        const display = name || 'Unknown part'
        const rec: MaskRecord = largest ?? {
          frame: 0,
          ordinal: 0,
          objectId: `circle-${overlaysRef.current.length + 1}`,
          box: {
            ...targetBox,
            w: targetBox.x2 - targetBox.x1 + 1,
            h: targetBox.y2 - targetBox.y1 + 1,
          },
          raster: new Uint8Array(0),
        }
        presentOutline({
          display,
          kind,
          rec,
          x: region.x,
          y: region.y,
          phrase: 'circle to identify',
          channel: 'circle',
        })
        await speakReply(name || 'I could not identify this part.')
        setStatus(voiceOnRef.current ? 'listening' : 'off')
      } catch (e) {
        logError('circle', e instanceof Error ? e.message : String(e))
        setStatus('error')
        window.setTimeout(() => setStatus(voiceOnRef.current ? 'listening' : 'off'), 2000)
      } finally {
        busyRef.current = false
      }
    },
    [frozen, cameraLive, frameTarget, speakReply, presentOutline],
  )

  /** Long-press removal: drop the topmost outline containing the tap point. */
  const removeOutlineAt = useCallback(
    (clientX: number, clientY: number) => {
      const layer = tapRef.current
      if (!layer) return
      const { w: vw, h: vh } = frameTarget()
      const tap = tapToMedia(
        clientX,
        clientY,
        layer.getBoundingClientRect(),
        vw,
        vh,
        zoomRef.current.scale,
        mirroredRef.current,
      )
      if (!tap) return
      const { x: mx, y: my } = tap.point
      let hit = -1
      for (let i = overlaysRef.current.length - 1; i >= 0; i--) {
        const { box } = overlaysRef.current[i].rec
        if (mx >= box.x1 && mx <= box.x2 && my >= box.y1 && my <= box.y2) {
          hit = i
          break
        }
      }
      if (hit < 0) return
      overlaysRef.current = overlaysRef.current.filter((_, i) => i !== hit)
      if (overlaysRef.current.length === 0) setCallout(null)
      draw()
      logInfo('tap', 'outline removed (long-press)')
    },
    [draw, frameTarget],
  )

  const cancelPress = useCallback(() => {
    if (pressRef.current) {
      window.clearTimeout(pressRef.current.timer)
      pressRef.current = null
    }
  }, [])

  // Voice assistant lifecycle. Resubscribes whenever handlePhrase identity
  // changes (recreating the recognizer mid-listen), so handlePhrase and its
  // callees must keep []-stable identities — never add state to that chain.
  useEffect(() => {
    const assistant = new VoiceAssistant({
      onPhrase: (phrase) => void handlePhrase(phrase),
      onError: (message) => {
        setError(message)
        setVoiceOn(false)
        setStatus('off')
      },
    })
    assistantRef.current = assistant
    return () => {
      assistant.stop()
      assistantRef.current = null
    }
  }, [handlePhrase])

  const handleToggle = async (next: boolean) => {
    const assistant = assistantRef.current
    if (!assistant) return
    setError('')
    if (next) {
      setStatus('listening')
      await assistant.start()
      setVoiceOn(assistant.isListening())
      if (!assistant.isListening()) setStatus('off')
    } else {
      assistant.stop()
      clearRefresh()
      cancelSpeech()
      setVoiceOn(false)
      setStatus('off')
    }
  }

  // Full scene reset. Zoom intentionally persists (view preference, not
  // scene data); queued pendingRef phrases and an in-flight trace also
  // survive — both resolve against the cleared state harmlessly.
  const resetOverlays = () => {
    overlaysRef.current = []
    setFindings([])
    setStepPhotos({})
    assistantRef.current?.clearMemory()
    clearRefresh()
    cancelSpeech()
    trackingRef.current = false
    setTracking(false)
    setCallout(null)
    setEmptyTarget(false)
    // Invalidate any in-flight guidance fetch and drop the HUD card.
    guidanceReqRef.current += 1
    snapshotGuidance()
    setGuidance(null)
    setGuidancePending(false)
    setStepIndex(0)
    guidesReqRef.current += 1
    setGuides(undefined)
    draw(true)
  }

  const changeStep = (index: number) => {
    const count = guidance?.steps.length ?? 0
    const next = count > 0 ? Math.min(Math.max(0, index), count - 1) : 0
    // Buttons match voice: moving forward pins the finished step, Back
    // re-reads without producing evidence.
    if (next > stepIndex) pinStepPhoto(stepIndex)
    setStepIndex(next)
  }
  const clearOverlay = () => {
    resetOverlays()
    logInfo('view', 'AR view cleared')
  }
  const exportReport = () => {
    const memory = assistantRef.current?.getMemory() ?? []
    const workingOn = [...new Set(memory.map((m) => m.label))].slice(-5)
    const photos = Object.entries(stepPhotos)
      .map(([step, dataUrl]) => ({ step: Number(step), dataUrl }))
      .sort((a, b) => a.step - b.step)
    const input = {
      guidance: guidanceRef.current,
      stepIndex: stepIndexRef.current,
      workingOn,
      findings,
      photos,
      history: [...guidanceHistoryRef.current],
    }
    // Prefer the OS share sheet; download when sharing is unavailable
    // or the user dismisses it.
    void (async () => {
      if (await shareReport(input)) {
        logInfo('report', 'repair report shared')
      } else {
        downloadReport(input)
        logInfo('report', 'repair report downloaded')
      }
    })()
  }

  /**
   * Client point → viewport coords (screen px relative to the stage
   * origin). Zoom focal points live in this space; null without a stage.
   */
  const toViewportPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const stage = stageRef.current
    if (!stage) return null
    const rect = stage.getBoundingClientRect()
    const z = zoomRef.current
    return { x: clientX - (rect.left - z.x), y: clientY - (rect.top - z.y) }
  }

  /**
   * Client point → untransformed stage coords for trace/circle mapping.
   * Relative to the transformed box, like tapToMedia: pan cancels out.
   */
  const toStagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const stage = stageRef.current
    if (!stage) return null
    const rect = stage.getBoundingClientRect()
    const s = zoomRef.current.scale
    return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s }
  }

  const flipCamera = () => {
    // Drop the still and unfreeze before switching; the facing change
    // re-runs the camera effect exactly once (no restartKey bump needed).
    if (frozen) {
      stillRef.current = null
      setStillUrl(null)
      setFrozen(false)
    }
    // The overlay belongs to the old scene: clear it before switching.
    resetOverlays()
    logInfo('camera', 'switching camera')
    setZoom(NO_ZOOM)
    setFacing((was) => (was === 'environment' ? 'user' : 'environment'))
  }

  const toggleTorch = async (next: boolean) => {
    const stream = videoRef.current?.srcObject as MediaStream | null
    const track = stream?.getVideoTracks()[0]
    if (!track?.applyConstraints) return
    try {
      const constraint: TorchConstraintSet = { torch: next }
      await track.applyConstraints({ advanced: [constraint] })
      setTorchOn(next)
      logInfo('camera', `flashlight ${next ? 'on' : 'off'}`)
    } catch {
      logWarn('camera', 'flashlight switch failed')
      setTorchOn(false)
    }
  }

  return (
    <div className="relative w-full h-dvh overflow-hidden bg-black lg:flex">
      {/* Feed pane: overlay master at every size; narrows to 2/3 on desktop. */}
      <div className="relative h-full w-full lg:w-auto lg:min-w-0 lg:flex-1">
      {/*
        Zoom stage: video, canvas, tap layer, and callout scale/pan as one
        so masks and pills stay aligned at every zoom. Origin 0 0 keeps the
        tapToMedia inverse trivial (see tapToMedia). touch-none routes pinch
        gestures to pointer events instead of the browser zoom.
      */}
      <div
        ref={stageRef}
        data-testid="zoom-stage"
        className="absolute inset-0 touch-none"
        style={{
          transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
          transformOrigin: '0 0',
        }}
        onPointerDown={(e) => {
          pointersRef.current.set(e.pointerId, {
            x: e.clientX,
            y: e.clientY,
            sx: e.clientX,
            sy: e.clientY,
            t0: Date.now(),
          })
          if (pointersRef.current.size === 2) {
            const [a, b] = [...pointersRef.current.values()]
            pinchRef.current = {
              dist: Math.hypot(a.x - b.x, a.y - b.y),
              midX: (a.x + b.x) / 2,
              midY: (a.y + b.y) / 2,
            }
            // A second finger cancels the circle stroke: pinch takes over.
            storeTrace(null)
            cancelPress()
            return
          }
          if (
            (frozen || (cameraLive && zoomRef.current.scale <= ZOOM_MIN)) &&
            pointersRef.current.size === 1
          ) {
            const pt = toStagePoint(e.clientX, e.clientY)
            storeTrace(pt ? [pt] : null)
          }
        }}
        onPointerMove={(e) => {
          const pts = pointersRef.current
          const p = pts.get(e.pointerId)
          if (!p) return
          const dx = e.clientX - p.x
          const dy = e.clientY - p.y
          p.x = e.clientX
          p.y = e.clientY
          const stage = stageRef.current
          if (!stage) return
          const z = zoomRef.current
          const vw = stage.clientWidth
          const vh = stage.clientHeight
          if (pts.size >= 2) {
            const [a, b] = [...pts.values()]
            const dist = Math.hypot(a.x - b.x, a.y - b.y)
            const midX = (a.x + b.x) / 2
            const midY = (a.y + b.y) / 2
            const pinch = pinchRef.current
            const mid = toViewportPoint(midX, midY)
            const prevMid = pinch ? toViewportPoint(pinch.midX, pinch.midY) : null
            if (pinch && pinch.dist > 0 && dist > 0 && mid && prevMid) {
              setZoom(
                pinchZoom(z, dist / pinch.dist, prevMid.x, prevMid.y, mid.x, mid.y, vw, vh),
              )
            }
            pinchRef.current = { dist, midX, midY }
            return
          }
          // Frozen (and unzoomed live) single-finger drags trace a circle;
          // zoomed live drags pan.
          if (frozen || (cameraLive && zoomRef.current.scale <= ZOOM_MIN)) {
            const pt = toStagePoint(e.clientX, e.clientY)
            if (pt) {
              const base = traceRef.current ?? []
              const last = base[base.length - 1]
              const near =
                last !== undefined &&
                Math.hypot(pt.x - last.x, pt.y - last.y) < TRACE_POINT_GAP
              if (!near && base.length < TRACE_MAX_POINTS) {
                storeTrace([...base, pt])
              }
            }
            return
          }
          if (z.scale <= ZOOM_MIN) return
          setZoom(clampZoomPan(z.scale, z.x + dx, z.y + dy, vw, vh))
          if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > LONG_PRESS_SLOP_PX) {
            suppressTapRef.current = true
            cancelPress()
          }
        }}
        onPointerUp={(e) => {
          const ended = pointersRef.current.get(e.pointerId)
          pointersRef.current.delete(e.pointerId)
          if (pointersRef.current.size < 2) {
            // A pinch never becomes a tap, even a perfectly still one.
            if (pinchRef.current) suppressTapRef.current = true
            pinchRef.current = null
          }
          const done = traceRef.current
          storeTrace(null)
          if (
            (frozen || (cameraLive && zoomRef.current.scale <= ZOOM_MIN)) &&
            done &&
            done.length > 0
          ) {
            const xs = done.map((pt) => pt.x)
            const ys = done.map((pt) => pt.y)
            const ax = Math.min(...xs)
            const ay = Math.min(...ys)
            const bx = Math.max(...xs)
            const by = Math.max(...ys)
            const span = Math.max(bx - ax, by - ay)
            if (span >= TRACE_MIN_SPAN) {
              suppressTapRef.current = true
              cancelPress()
              void handleCircle(ax, ay, bx, by)
            } else if (span > LONG_PRESS_SLOP_PX) {
              // Below a circle span: quick drifts fall through to a normal
              // tap (finger taps routinely slide a little), but a press
              // held past the long-press delay was a slipped removal, not
              // a tap — swallow it so no stray outline appears.
              if (ended !== undefined && Date.now() - ended.t0 >= LONG_PRESS_MS) {
                suppressTapRef.current = true
                cancelPress()
              }
            }
          }
        }}
        onPointerCancel={(e) => {
          pointersRef.current.delete(e.pointerId)
          if (pointersRef.current.size < 2) pinchRef.current = null
          storeTrace(null)
        }}
        onWheel={(e) => {
          // Plain wheel zooms at the cursor; ctrl/meta-wheel stays the
          // browser's page zoom (preventDefault is unreliable on wheel).
          if (e.ctrlKey || e.metaKey) return
          const stage = stageRef.current
          const focal = toViewportPoint(e.clientX, e.clientY)
          if (!stage || !focal) return
          setZoom(
            zoomAt(
              zoomRef.current,
              e.deltaY < 0 ? 1.2 : 1 / 1.2,
              focal.x,
              focal.y,
              stage.clientWidth,
              stage.clientHeight,
            ),
          )
        }}
      >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        aria-label="Live camera feed"
        className={`absolute inset-0 w-full h-full object-cover${mirrored ? ' -scale-x-100' : ''}`}
      />
      {stillUrl && !cameraLive && (
        <img
          src={stillUrl}
          alt="Frozen frame"
          draggable={false}
          className={`absolute inset-0 w-full h-full object-cover${mirrored ? ' -scale-x-100' : ''}`}
        />
      )}
      {/*
        Same cover geometry as the video: the backing store matches the frame
        aspect, so object-cover aligns frame-pixel masks with the feed.
      */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={`absolute inset-0 w-full h-full object-cover pointer-events-none${mirrored ? ' -scale-x-100' : ''}`}
      />
      {/*
        Tap layer (frozen or live camera): above the canvas, below the
        header (z-20) and bottom dock (z-10). Short taps outline a part;
        drags trace a circle to identify the enclosed region; a 500ms hold
        with minimal drift removes the outline under the finger.
      */}
      {(frozen || cameraLive) && (
        <div
          ref={tapRef}
          role="button"
          tabIndex={0}
          aria-label="Circle or tap to identify a part"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            const rect = tapRef.current?.getBoundingClientRect()
            if (!rect) return
            void handleTap(rect.left + rect.width / 2, rect.top + rect.height / 2)
          }}
          onClick={(e) => {
            if (suppressTapRef.current) {
              suppressTapRef.current = false
              return
            }
            void handleTap(e.clientX, e.clientY)
          }}
          onPointerDown={(e) => {
            cancelPress()
            const { clientX, clientY } = e
            const timer = window.setTimeout(() => {
              pressRef.current = null
              suppressTapRef.current = true
              removeOutlineAt(clientX, clientY)
            }, LONG_PRESS_MS)
            pressRef.current = { x: clientX, y: clientY, timer }
          }}
          onPointerMove={(e) => {
            const press = pressRef.current
            if (!press) return
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) {
              cancelPress()
            }
          }}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          className="absolute inset-0 z-[5] cursor-crosshair bg-transparent touch-none"
        />
      )}
      {trace && trace.length > 1 && (
        <svg
          aria-hidden="true"
          data-testid="trace-trail"
          className="absolute inset-0 w-full h-full pointer-events-none"
        >
          <polyline
            points={trace.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      </div>
      {/*
        Callout pill lives outside the zoom stage so pinch zoom never scales
        its text: stage coords still map 1:1 (both fill the feed pane), while
        the padded wrapper keeps the pill inside the safe area. Width caps in
        pane units so the pill ellipsizes instead of clipping.
      */}
      {callout && (
        <div
          className="absolute inset-0 z-[6] pointer-events-none"
          style={{
            paddingLeft: 'env(safe-area-inset-left)',
            paddingRight: 'env(safe-area-inset-right)',
          }}
        >
          <div
            role="status"
            aria-label={`Located: ${callout.label}`}
            className="absolute bg-black/80 backdrop-blur-md border border-white/20 text-white px-3 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap overflow-hidden text-ellipsis max-w-[calc(100%-2rem)] shadow-lg pointer-events-none"
            style={calloutStyle(callout.x, callout.y)}
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle"
              style={{
                backgroundColor: STROKE[callout.kind],
                boxShadow: `0 0 6px ${STROKE[callout.kind]}`,
              }}
            />
            {callout.label}
          </div>
        </div>
      )}
      <Header
        status={status}
        live={cameraLive}
        tracking={tracking}
        voiceOn={voiceOn}
        onVoiceToggle={(next) => void handleToggle(next)}
        facing={actualFacing}
        multiCamera={multiCamera}
        onSwitchCamera={flipCamera}
        onClearView={clearOverlay}
        onExportReport={exportReport}
        torchOn={torchOn}
        hasTorch={hasTorch}
        onTorchToggle={(next) => void toggleTorch(next)}
        frozen={frozen}
        onFreezeToggle={(next) => setFrozenMode(next)}
        hint={(frozen || cameraLive) ? HINTS[hintIndex % HINTS.length] : null}
      />
      {/*
        Bottom dock: error toast, HUD card, and thumb-reachable query input
        stack vertically so nothing can collide at 360px width.
      */}
      <div
        data-testid="bottom-dock"
        className="absolute bottom-0 inset-x-0 z-10 flex flex-col gap-2 max-h-[90dvh] overflow-y-auto transition-transform"
        style={{
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
          transform: keyboardShift > 0 ? `translateY(${-keyboardShift}px)` : undefined,
        }}
      >
        {error && (
          <div
            role="alert"
            className="w-full rounded-xl bg-black/80 backdrop-blur-md border border-red-500/60 px-4 py-2 flex items-center gap-3"
          >
            <span
              aria-hidden="true"
              className="motion-safe:animate-pulse inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-red-500"
            />
            <p className="flex-1 min-w-0 text-sm font-medium text-white">{error}</p>
            {!cameraLive && !frozen && (
              <button
                type="button"
                onClick={() => {
                  setError('')
                  setRestartKey((k) => k + 1)
                }}
                aria-label="Try camera again"
                className="min-h-[48px] shrink-0 rounded-lg bg-white/15 px-4 text-base font-bold text-white active:scale-95 transition"
              >
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={() => setError('')}
              aria-label="Dismiss error"
              className="min-h-[48px] min-w-[48px] shrink-0 rounded-lg px-3 text-lg font-bold leading-none text-white/80 active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        )}
        {offline && (
          <div
            role="status"
            aria-label="You're offline — connect to analyze the feed and fetch guidance."
            className="w-full rounded-xl bg-black/80 backdrop-blur-md border border-amber-400/60 px-4 py-2.5 flex items-center gap-3"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400"
            />
            <p className="flex-1 min-w-0 text-sm font-medium text-white">
              You&apos;re offline — connect to analyze the feed and fetch guidance.
            </p>
          </div>
        )}
        {emptyTarget && !error && (
          <div
            role="status"
            aria-label="No matching part found — try rephrasing or moving closer."
            className="w-full rounded-xl bg-black/80 backdrop-blur-md border border-white/20 px-4 py-2 flex items-center gap-3"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-300"
            />
            <p className="flex-1 min-w-0 text-sm font-medium text-white">
              No matching part found — try rephrasing or moving closer.
            </p>
            <button
              type="button"
              onClick={() => setEmptyTarget(false)}
              aria-label="Dismiss notice"
              className="min-h-[48px] min-w-[48px] shrink-0 rounded-lg px-3 text-lg font-bold leading-none text-white/80 active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        )}
        {/*
          Processing indicator: the top badge hides while analyzing, so this
          owns the screen-reader announcement. Motion is gated behind
          motion-safe.
        */}
        {status === 'analyzing' && (
          <div
            role="status"
            aria-label="Analyzing"
            className="pointer-events-none self-center inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white"
          >
            <span className="motion-safe:animate-pulse inline-block h-2 w-2 rounded-full bg-cyan-300" />
            Analyzing…
          </div>
        )}
        {/*
          Zoom orientation: the +/- controls were deliberately removed, so
          this chip is the only zoom readout and the only way back to 1x.
        */}
        {zoom.scale > 1.01 && (
          <button
            type="button"
            onClick={() => setZoom(NO_ZOOM)}
            aria-label={`Reset zoom (currently ${zoom.scale.toFixed(1)}x)`}
            className="self-center inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white active:scale-95 transition"
          >
            {zoom.scale.toFixed(1)}× · tap to reset
          </button>
        )}
        {findings.length > 0 && (
          <div
            role="status"
            aria-label="Label findings"
            className="w-full rounded-xl bg-black/80 backdrop-blur-md border border-white/20 px-4 py-2 flex flex-wrap items-center gap-2"
          >
            {findings.map((finding, i) => (
              <span
                key={`${finding}-${i}`}
                className="rounded-full bg-white/15 px-3 py-1 text-sm font-mono text-white"
              >
                {finding}
              </span>
            ))}
          </div>
        )}
        {(guidancePending || guidance) && !isDesktop && (
          <HudCard
            guidance={guidance}
            pending={guidancePending}
            stepIndex={stepIndex}
            onStepChange={changeStep}
            onScanAnother={clearOverlay}
            guides={guides}
          />
        )}
        {(frozen || cameraLive) && !voiceOn && !voiceCoachSeen && (
          <div
            role="status"
            aria-label="Voice mode tip"
            className="w-full rounded-xl bg-black/80 backdrop-blur-md border border-cyan-300/40 px-4 py-2 flex items-center gap-3"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-300"
            />
            <p className="flex-1 min-w-0 text-sm font-medium text-white">
              Voice mode is in the ⋯ menu — go hands-free
            </p>
            <button
              type="button"
              onClick={dismissVoiceCoach}
              aria-label="Dismiss voice tip"
              className="min-h-[48px] min-w-[48px] shrink-0 rounded-lg px-3 text-lg font-bold leading-none text-white/80 active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        )}
        <QueryBar onSubmit={(text) => void handlePhrase(text)} />
      </div>
      </div>
      {isDesktop && (
        <Sidebar
          guidance={guidance}
          pending={guidancePending}
          guides={guides}
          stepIndex={stepIndex}
          onStepChange={changeStep}
          onScanAnother={clearOverlay}
        />
      )}
    </div>
  )
}
