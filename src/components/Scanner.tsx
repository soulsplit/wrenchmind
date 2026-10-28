import { useCallback, useEffect, useRef, useState } from 'react'
import type { Callout, GuidanceResult, MaskRecord, OverlayKind, Status } from '../types'
import {
  captureFrameBurst,
  captureVideoFrame,
  hasApiKey,
  reasonSpatial,
  segmentImage,
} from '../services/metaApi'
import type { SamPointPrompt } from '../services/metaApi'
import { parseSamStream } from '../services/samParser'
import { cancelSpeech, speakText } from '../services/speechOutput'
import { fetchGuidance } from '../services/guidanceApi'
import { VoiceAssistant } from '../services/voiceAssistant'
import { permissionBlocker, secureContextBlocker } from '../services/mediaSupport'
import { logDebug, logError, logInfo, logWarn } from '../services/logger'
import QueryBar from './QueryBar'
import Header from './Header'
import HudCard from './HudCard'
import Sidebar, { useDesktopLayout } from './Sidebar'

interface Overlay {
  rec: MaskRecord
  kind: OverlayKind
}

interface RefreshTarget {
  label: string
  x: number
  y: number
}

/** Re-segment cadence while an overlay tracks a moving subject. */
const REFRESH_INTERVAL_MS = 2000

const FILL: Record<OverlayKind, [number, number, number]> = {
  component: [0, 255, 255], // cyan
  connector: [255, 255, 0], // yellow
  fastener: [255, 0, 0], // red
}

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

/** Clamp a 0-100 viewport percent into range; non-finite values anchor at 0. */
function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
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
  const [status, setStatus] = useState<Status>('off')
  const [error, setError] = useState<string>('')
  const [voiceOn, setVoiceOn] = useState(false)
  const [callout, setCallout] = useState<Callout | null>(null)
  const overlaysRef = useRef<Overlay[]>([])
  const assistantRef = useRef<VoiceAssistant | null>(null)
  const voiceOnRef = useRef(false)
  voiceOnRef.current = voiceOn
  const busyRef = useRef(false)
  const pendingRef = useRef<string | null>(null)
  const targetRef = useRef<RefreshTarget | null>(null)
  const refreshRef = useRef<number | null>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [multiCamera, setMultiCamera] = useState(true)
  const [cameraLive, setCameraLive] = useState(false)
  const [actualFacing, setActualFacing] = useState<'environment' | 'user' | 'unknown'>('unknown')
  const [guidance, setGuidance] = useState<GuidanceResult | null>(null)
  const [guidancePending, setGuidancePending] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [emptyTarget, setEmptyTarget] = useState(false)
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && !navigator.onLine,
  )
  const guidanceReqRef = useRef(0)
  // Desktop layout branch (lg+): the feed narrows to 2/3 and the sidebar
  // hosts the guidance card; the bottom-docked card unmounts to avoid
  // duplicating it.
  const isDesktop = useDesktopLayout()

  const draw = useCallback((force = false) => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = video.videoWidth || window.innerWidth
    const h = video.videoHeight || window.innerHeight
    // Blank canvases stay blank: skip the resize/clear churn when idle.
    if (!force && overlaysRef.current.length === 0 && canvas.width === w && canvas.height === h) {
      return
    }
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const { rec, kind } of overlaysRef.current) {
      const { box, raster } = rec
      const [r, g, b] = FILL[kind]
      if (raster.length > 0) {
        const img = ctx.createImageData(box.w, box.h)
        const pixels = Math.min(raster.length, box.w * box.h)
        for (let i = 0; i < pixels; i++) {
          if (raster[i]) {
            img.data[i * 4] = r
            img.data[i * 4 + 1] = g
            img.data[i * 4 + 2] = b
            img.data[i * 4 + 3] = 140
          }
        }
        ctx.putImageData(img, box.x1, box.y1)
      }
      ctx.strokeStyle = STROKE[kind]
      ctx.lineWidth = 3
      ctx.shadowColor = STROKE[kind]
      ctx.shadowBlur = 12
      // Box corners are inclusive pixels.
      ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1 + 1, box.y2 - box.y1 + 1)
    }
    ctx.shadowBlur = 0
  }, [])

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
        }
        return
      }
      const other = facing === 'environment' ? 'user' : 'environment'
      const attempts: { label: string; constraints: MediaStreamConstraints }[] = [
        { label: facing, constraints: { video: { facingMode: facing } } },
        { label: other, constraints: { video: { facingMode: other } } },
        { label: 'any', constraints: { video: true } },
      ]
      for (const { label, constraints } of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints)
          logInfo('camera', `using ${label} camera`)
          break
        } catch {
          logWarn('camera', `${label} camera unavailable`)
          stream = null
        }
      }
      if (cancelled) {
        stream?.getTracks().forEach((t) => t.stop())
        return
      }
      if (!stream) {
        const hint = (await permissionBlocker('camera', 'Camera access')) ?? 'Camera access denied'
        logError('camera', `all camera attempts failed (${hint})`)
        setError(hint)
        return
      }
      if (!cancelled) {
        // Ground truth for the badge: the requested facing may have fallen
        // back (desktop webcams report no facingMode at all).
        const mode = stream.getVideoTracks()[0]?.getSettings?.().facingMode
        setActualFacing(mode === 'environment' || mode === 'user' ? mode : 'unknown')
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const cameras = devices.filter((d) => d.kind === 'videoinput')
        if (!cancelled && cameras.length === 1) setMultiCamera(false)
      } catch {
        /* enumeration unavailable — keep the switcher visible */
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try {
          await videoRef.current.play()
          if (!cancelled) setCameraLive(true)
        } catch {
          logWarn('camera', 'video autoplay was blocked')
        }
      }
    })()
    return () => {
      cancelled = true
      setCameraLive(false)
      setActualFacing('unknown')
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [facing])

  useEffect(() => {
    const id = window.setInterval(draw, 200)
    return () => window.clearInterval(id)
  }, [draw])

  const clearRefresh = useCallback(() => {
    if (refreshRef.current !== null) {
      window.clearTimeout(refreshRef.current)
      refreshRef.current = null
    }
    targetRef.current = null
  }, [])

  useEffect(() => clearRefresh, [clearRefresh])

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
      const point = toPixelPoint(target.x, target.y, video.videoWidth, video.videoHeight)
      const recs = await parseSamStream(segmentImage(img, target.label, point))
      if (targetRef.current !== target) return
      const kind = classifyTarget(target.label)
      const spans = recs
        .slice(0, 3)
        .map((r) => `${r.box.x2 - r.box.x1 + 1}x${r.box.y2 - r.box.y1 + 1}`)
        .join(',')
      logDebug('segment', `refresh: ${recs.length} masks [${spans}]`)
      overlaysRef.current = recs.map((rec) => ({ rec, kind }))
      draw()
    } catch (e) {
      /* keep the previous overlay on transient refresh failures */
      logWarn('segment', `refresh failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      rearm()
    }
  }, [draw])

  const armRefresh = useCallback(
    (label: string, x: number, y: number) => {
      targetRef.current = { label, x, y }
      if (refreshRef.current === null) {
        refreshRef.current = window.setTimeout(() => void tickRefresh(), REFRESH_INTERVAL_MS)
      }
    },
    [tickRefresh],
  )

  /**
   * Fetch repair guidance alongside segmentation. Fire-and-forget on purpose:
   * guidance must never stall or fail the AR phrase pipeline, and the request
   * id drops stale responses when a newer scan supersedes them.
   */
  const requestGuidance = useCallback((label: string, phrase: string, context: string) => {
    guidanceReqRef.current += 1
    const reqId = guidanceReqRef.current
    setGuidancePending(true)
    void fetchGuidance(label, phrase, context).then(
      (result) => {
        if (guidanceReqRef.current !== reqId) return
        setGuidance(result)
        setStepIndex(0)
        logInfo('guidance', `"${result.title}" (${result.steps.length} steps)`)
      },
      (e: unknown) => {
        if (guidanceReqRef.current !== reqId) return
        logWarn('guidance', `guidance unavailable: ${e instanceof Error ? e.message : String(e)}`)
      },
    ).finally(() => {
      if (guidanceReqRef.current === reqId) setGuidancePending(false)
    })
  }, [])

  const handlePhrase = useCallback(async (phrase: string) => {
    // Serialize analyses; the latest phrase spoken mid-flight runs next.
    if (busyRef.current) {
      pendingRef.current = phrase
      return
    }
    busyRef.current = true
    try {
      const video = videoRef.current
      const assistant = assistantRef.current
      if (!video) return
      if (!hasApiKey()) {
        setError('API key missing: set VITE_META_MODEL_API_KEY in .env')
        setStatus(voiceOnRef.current ? 'listening' : 'off')
        return
      }
      setStatus('analyzing')
      setEmptyTarget(false)
      logInfo('phrase', `"${phrase}"`)
      try {
        const frames = await captureFrameBurst(video)
        if (frames.length === 0) throw new Error('No video frame')
        logDebug('camera', `burst: ${frames.length} frames`)
        const img = frames[frames.length - 1]
        const ctxStr = assistant?.getContextString() ?? ''
        const result = await reasonSpatial(frames, phrase, ctxStr)
        if (!result.target_label) {
          logWarn('reason', 'no target in response')
          setEmptyTarget(true)
        } else {
          logInfo(
            'reason',
            `"${result.target_label}" @ (${result.approx_x},${result.approx_y}) [${result.display_mode}]`,
          )
        }
        if (result.target_label) {
          const kind = classifyTarget(result.target_label)
          const point = toPixelPoint(
            result.approx_x,
            result.approx_y,
            video.videoWidth,
            video.videoHeight,
          )
          const recs = await parseSamStream(
            segmentImage(img, result.target_label, point),
          )
          const spans = recs
            .slice(0, 3)
            .map((r) => `${r.box.x2 - r.box.x1 + 1}x${r.box.y2 - r.box.y1 + 1}`)
            .join(',')
          logDebug(
            'segment',
            `${recs.length} masks [${spans}] in ${video.videoWidth}x${video.videoHeight}`,
          )
          overlaysRef.current = recs.map((rec) => ({ rec, kind }))
          assistant?.pushMemory({
            phrase,
            label: result.target_label,
            x: result.approx_x,
            y: result.approx_y,
          })
          setCallout({
            label: result.target_label,
            x: result.approx_x,
            y: result.approx_y,
            kind,
          })
          draw()
          armRefresh(result.target_label, result.approx_x, result.approx_y)
          requestGuidance(result.target_label, phrase, ctxStr)
        }
        // Speak only in speech_and_visual mode with a non-null response.
        // visual_only and null responses stay silent (visual-only).
        if (result.display_mode === 'speech_and_visual' && result.speech_response) {
          void speakText(result.speech_response)
        }
        setStatus(voiceOnRef.current ? 'listening' : 'off')
      } catch (e) {
        logError('phrase', e instanceof Error ? e.message : String(e))
        setStatus('error')
        window.setTimeout(() => setStatus(voiceOnRef.current ? 'listening' : 'off'), 2000)
      }
    } finally {
      busyRef.current = false
      const next = pendingRef.current
      pendingRef.current = null
      if (next) void handlePhrase(next)
    }
  }, [draw, armRefresh, requestGuidance])

  // Voice assistant lifecycle.
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

  const resetOverlays = () => {
    overlaysRef.current = []
    assistantRef.current?.clearMemory()
    clearRefresh()
    cancelSpeech()
    setCallout(null)
    setEmptyTarget(false)
    // Invalidate any in-flight guidance fetch and drop the HUD card.
    guidanceReqRef.current += 1
    setGuidance(null)
    setGuidancePending(false)
    setStepIndex(0)
    draw(true)
  }

  const changeStep = (index: number) => {
    const count = guidance?.steps.length ?? 0
    setStepIndex(count > 0 ? Math.min(Math.max(0, index), count - 1) : 0)
  }
  const clearOverlay = () => {
    resetOverlays()
    logInfo('view', 'AR view cleared')
  }

  const flipCamera = () => {
    // The overlay belongs to the old scene: clear it before switching.
    resetOverlays()
    logInfo('camera', 'switching camera')
    setFacing((was) => (was === 'environment' ? 'user' : 'environment'))
  }

  return (
    <div className="relative w-full h-dvh overflow-hidden bg-black lg:flex">
      {/* Feed pane: overlay master at every size; narrows to 2/3 on desktop. */}
      <div className="relative h-full w-full lg:w-auto lg:min-w-0 lg:flex-1">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        aria-label="Live camera feed"
        className="absolute inset-0 w-full h-full object-cover"
      />
      {/*
        Same cover geometry as the video: the backing store matches the frame
        aspect, so object-cover aligns frame-pixel masks with the feed.
      */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />
      {callout && (
        <div
          role="status"
          aria-label={`Located: ${callout.label}`}
          className="absolute bg-black/80 backdrop-blur-md border border-white/20 text-white px-3 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap overflow-hidden text-ellipsis max-w-[calc(100vw-1rem)] shadow-lg pointer-events-none"
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
      )}
      <Header
        status={status}
        live={cameraLive}
        voiceOn={voiceOn}
        onVoiceToggle={(next) => void handleToggle(next)}
        facing={actualFacing}
        multiCamera={multiCamera}
        onSwitchCamera={flipCamera}
        onClearView={clearOverlay}
      />
      {/*
        Bottom dock: error toast, HUD card, and thumb-reachable query input
        stack vertically so nothing can collide at 360px width.
      */}
      <div
        className="absolute bottom-0 inset-x-0 z-10 flex flex-col gap-2"
        style={{
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
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
          Visual-only processing echo: the Header status badge owns the
          screen-reader announcement, so this stays aria-hidden to avoid a
          double announcement. Motion is gated behind motion-safe.
        */}
        {status === 'analyzing' && (
          <div
            aria-hidden="true"
            className="pointer-events-none self-start inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white"
          >
            <span className="motion-safe:animate-pulse inline-block h-2 w-2 rounded-full bg-cyan-300" />
            Analyzing…
          </div>
        )}
        {(guidancePending || guidance) && !isDesktop && (
          <HudCard
            guidance={guidance}
            pending={guidancePending}
            stepIndex={stepIndex}
            onStepChange={changeStep}
            onScanAnother={clearOverlay}
          />
        )}
        <QueryBar onSubmit={(text) => void handlePhrase(text)} />
      </div>
      </div>
      {isDesktop && (
        <Sidebar
          guidance={guidance}
          pending={guidancePending}
          stepIndex={stepIndex}
          onStepChange={changeStep}
          onScanAnother={clearOverlay}
        />
      )}
    </div>
  )
}
