import { useCallback, useEffect, useRef, useState } from 'react'
import type { Callout, MaskRecord, OverlayKind, Status } from '../types'
import {
  captureFrameBurst,
  captureVideoFrame,
  hasApiKey,
  reasonSpatial,
  segmentImage,
} from '../services/metaApi'
import type { SamPointPrompt } from '../services/metaApi'
import { parseSamStream } from '../services/samParser'
import { VoiceAssistant } from '../services/voiceAssistant'
import { permissionBlocker, secureContextBlocker } from '../services/mediaSupport'
import { logDebug, logError, logInfo, logWarn } from '../services/logger'
import StatusBar from './StatusBar'
import Toggle from './Toggle'
import QueryBar from './QueryBar'
import LogPanel from './LogPanel'
import QrShare from './QrShare'

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

function speak(text: string): void {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 1
  window.speechSynthesis.speak(utterance)
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
      ctx.lineWidth = 2
      // Box corners are inclusive pixels.
      ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1 + 1, box.y2 - box.y1 + 1)
    }
  }, [])

  // Surface a missing API key up front instead of failing per phrase.
  useEffect(() => {
    if (!hasApiKey()) {
      logError('config', 'missing VITE_META_MODEL_API_KEY')
      setError('API key missing: set VITE_META_MODEL_API_KEY in .env')
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
        } catch {
          logWarn('camera', 'video autoplay was blocked')
        }
      }
    })()
    return () => {
      cancelled = true
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
        }
        // Speak only in speech_and_visual mode with a non-null response.
        // visual_only and null responses stay silent (visual-only).
        if (result.display_mode === 'speech_and_visual' && result.speech_response) {
          speak(result.speech_response)
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
  }, [draw, armRefresh])

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
      setVoiceOn(false)
      setStatus('off')
    }
  }

  const resetOverlays = () => {
    overlaysRef.current = []
    assistantRef.current?.clearMemory()
    clearRefresh()
    setCallout(null)
    draw(true)
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
    <div className="relative w-screen h-screen overflow-hidden bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />
      {/*
        Same cover geometry as the video: the backing store matches the frame
        aspect, so object-cover aligns frame-pixel masks with the feed.
      */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />
      {callout && (
        <div
          className="absolute -translate-x-1/2 -translate-y-full bg-black/80 text-white px-3 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap pointer-events-none"
          style={{ left: `${callout.x}%`, top: `${callout.y}%` }}
        >
          <span
            className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle"
            style={{ backgroundColor: STROKE[callout.kind] }}
          />
          {callout.label}
        </div>
      )}
      <StatusBar status={status} />
      <div
        className="absolute top-4 left-4 flex gap-2 items-start"
        style={{ marginTop: 'env(safe-area-inset-top)', marginLeft: 'env(safe-area-inset-left)' }}
      >
        <LogPanel />
        <QrShare />
      </div>
      <div
        className="absolute top-4 right-4"
        style={{ marginTop: 'env(safe-area-inset-top)', marginRight: 'env(safe-area-inset-right)' }}
      >
        <Toggle checked={voiceOn} onChange={(next) => void handleToggle(next)} />
      </div>
      <div
        className="absolute bottom-4 right-4 flex flex-col gap-2 items-end"
        style={{ marginBottom: 'env(safe-area-inset-bottom)', marginRight: 'env(safe-area-inset-right)' }}
      >
        {multiCamera && (
          <button
            type="button"
            onClick={flipCamera}
            aria-label="Switch camera"
            className="min-h-[48px] bg-white/90 text-black px-4 py-3 rounded-lg font-bold shadow text-base active:scale-95 transition"
          >
            Switch camera
          </button>
        )}
        <button
          type="button"
          onClick={clearOverlay}
          className="min-h-[48px] bg-white/90 text-black px-4 py-3 rounded-lg font-bold shadow text-base active:scale-95 transition"
        >
          Clear AR View
        </button>
      </div>
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        <QueryBar onSubmit={(text) => void handlePhrase(text)} />
      </div>
      {error && (
        <div
          className="absolute bottom-4 left-4 bg-red-600 text-white px-4 py-2 rounded-lg max-w-[70vw]"
          style={{ marginBottom: 'env(safe-area-inset-bottom)', marginLeft: 'env(safe-area-inset-left)' }}
          role="alert"
        >
          {error}
        </div>
      )}
    </div>
  )
}
