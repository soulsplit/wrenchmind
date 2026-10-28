import { useCallback, useEffect, useRef, useState } from 'react'
import type { Callout, GuidanceResult, MaskRecord, OverlayKind, Status } from '../types'
import {
  captureFrameBurst,
  captureThumbnail,
  captureVideoFrame,
  extractLabelText,
  hasApiKey,
  reasonSpatial,
  segmentImage,
} from '../services/metaApi'
import type { SamPointPrompt } from '../services/metaApi'
import { parseSamStream } from '../services/samParser'
import { cancelSpeech, speakText } from '../services/speechOutput'
import { fetchGuidance } from '../services/guidanceApi'
import { downloadReport, shareReport } from '../services/report'
import { VoiceAssistant } from '../services/voiceAssistant'
import { permissionBlocker, secureContextBlocker } from '../services/mediaSupport'
import { logDebug, logError, logInfo, logWarn } from '../services/logger'
import QueryBar from './QueryBar'
import Header from './Header'
import HudCard from './HudCard'
import Sidebar, { useDesktopLayout } from './Sidebar'
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
  const stepIndexRef = useRef(0)
  stepIndexRef.current = stepIndex
  const [emptyTarget, setEmptyTarget] = useState(false)
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && !navigator.onLine,
  )
  const guidanceReqRef = useRef(0)
  // Desktop layout branch (lg+): the feed narrows to 2/3 and the sidebar
  // hosts the guidance card; the bottom-docked card unmounts to avoid
  // duplicating it.
  const isDesktop = useDesktopLayout()
  // Keyboard lift: the bottom dock alone rides above the visual viewport.
  const keyboardShift = useKeyboardShift()

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
    for (const { rec, kind, label } of overlaysRef.current) {
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
      if (label) {
        ctx.save()
        ctx.shadowBlur = 0
        ctx.font = 'bold 24px system-ui, sans-serif'
        const badgeY = Math.max(28, box.y1 - 4)
        const badgeW = ctx.measureText(label).width + 16
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)'
        ctx.fillRect(box.x1, badgeY - 28, badgeW, 28)
        ctx.fillStyle = STROKE[kind]
        ctx.fillText(label, box.x1 + 8, badgeY - 7)
        ctx.restore()
      }
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
        const track = stream.getVideoTracks()[0]
        const mode = track?.getSettings?.().facingMode
        setActualFacing(mode === 'environment' || mode === 'user' ? mode : 'unknown')
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
      setTorchOn(false)
      setHasTorch(false)
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
      const pixelPts = target.points
        .map((p) => toPixelPoint(p.x, p.y, video.videoWidth, video.videoHeight))
        .filter((p): p is SamPointPrompt => p !== undefined)
      const prompt = pixelPts.length > 1 ? pixelPts : pixelPts[0]
      const recs = await parseSamStream(segmentImage(img, target.label, prompt))
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
        setStepPhotos({})
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
        if (command === 'next') {
          const shot = captureThumbnail(video)
          if (shot) {
            setStepPhotos((prev) => ({ ...prev, [current]: shot }))
            logInfo('photo', `checkpoint pinned to step ${current + 1}`)
          }
        }
        const step = card.steps[next]
        const finished = command === 'next' && current === count - 1
        const line = finished
          ? 'Procedure complete.'
          : `Step ${next + 1} of ${count}: ${step.title}. ${step.detail}${step.warning ? ` Warning: ${step.warning}` : ''}`
        logInfo('step', `"${phrase}" → step ${next + 1}/${count}`)
        setStatus('speaking')
        await speakText(line)
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
          const frame = captureVideoFrame(video)
          if (!frame) throw new Error('No video frame')
          const found = await extractLabelText(frame)
          if (found.length === 0) {
            logInfo('label', 'no legible markings')
            setStatus('speaking')
            await speakText('I could not read any markings. Try moving closer.')
          } else {
            setFindings(found)
            logInfo('label', `${found.length} markings: ${found.slice(0, 3).join('; ')}`)
            setStatus('speaking')
            await speakText(`Label reads: ${found.join('. ')}`)
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
        const frames = await captureFrameBurst(video)
        if (frames.length === 0) throw new Error('No video frame')
        logDebug('camera', `burst: ${frames.length} frames`)
        const img = frames[frames.length - 1]
        // Rolling conversation memory ("phrase -> label (x,y) | ..."): the
        // inferred job context both calls share. No explicit scoping field —
        // the tool stays generic across every kind of repair.
        const ctxStr = assistant?.getContextString() ?? ''
        const result = await reasonSpatial(frames, phrase, ctxStr)
        if (!result.target_label) {
          logWarn('reason', 'no target in response')
          if (!trackingRef.current) setEmptyTarget(true)
        } else {
          logInfo(
            'reason',
            `"${result.target_label}" @ (${result.approx_x},${result.approx_y}) [${result.display_mode}]`,
          )
        }
        if (result.target_label && !trackingRef.current) {
          const kind = classifyTarget(result.target_label)
          // Plural commands ("all bolts") isolate every instance in one SAM
          // call; singular targets keep the existing single-point path.
          const targetPts =
            result.points && result.points.length > 1
              ? result.points
              : [{ x: result.approx_x, y: result.approx_y }]
          const pixelPts = targetPts
            .map((p) => toPixelPoint(p.x, p.y, video.videoWidth, video.videoHeight))
            .filter((p): p is SamPointPrompt => p !== undefined)
          const prompt = pixelPts.length > 1 ? pixelPts : pixelPts[0]
          const recs = await parseSamStream(
            segmentImage(img, result.target_label, prompt),
          )
          const spans = recs
            .slice(0, 3)
            .map((r) => `${r.box.x2 - r.box.x1 + 1}x${r.box.y2 - r.box.y1 + 1}`)
            .join(',')
          logDebug(
            'segment',
            `${recs.length} masks [${spans}] in ${video.videoWidth}x${video.videoHeight}`,
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
            x: result.approx_x,
            y: result.approx_y,
            kind,
          })
          draw()
          armRefresh(result.target_label, targetPts)
          requestGuidance(result.target_label, phrase, ctxStr)
          trackingRef.current = true
          setTracking(true)
        } else if (trackingRef.current) {
          logDebug('phrase', 'tracking locked — visuals frozen, answering by voice')
        }
        // Speak only in speech_and_visual mode with a non-null response.
        // visual_only and null responses stay silent (visual-only).
        if (result.display_mode === 'speech_and_visual' && result.speech_response) {
          setStatus('speaking')
          await speakText(result.speech_response)
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

  const flipCamera = () => {
    // The overlay belongs to the old scene: clear it before switching.
    resetOverlays()
    logInfo('camera', 'switching camera')
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
      />
      {/*
        Bottom dock: error toast, HUD card, and thumb-reachable query input
        stack vertically so nothing can collide at 360px width.
      */}
      <div
        data-testid="bottom-dock"
        className="absolute bottom-0 inset-x-0 z-10 flex flex-col gap-2 transition-transform"
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
            className="pointer-events-none self-start inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white"
          >
            <span className="motion-safe:animate-pulse inline-block h-2 w-2 rounded-full bg-cyan-300" />
            Analyzing…
          </div>
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
