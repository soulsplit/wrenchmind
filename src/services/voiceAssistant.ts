import type { MemoryEntry } from '../types'
import { hasApiKey } from './metaApi'
import { permissionBlocker, secureContextBlocker } from './mediaSupport'
import { logDebug, logError, logInfo, logWarn } from './logger'
import {
  CLOSE_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_BUFFERED_BYTES,
  REALTIME_URL,
  buildHandshake,
} from './realtimeTranscribe'

export interface VoiceAssistantCallbacks {
  onPhrase: (phrase: string) => void
  onError: (message: string) => void
  /** Live partial transcript while the user is still speaking (captions). */
  onInterim?: (transcript: string) => void
  /** Fired when the model hears speech begin (barge-in, ack blip). */
  onSpeechStart?: () => void
  /** Fired when the model hears speech stop (turn endpoint ack). */
  onSpeechEnd?: () => void
}

type AudioContextCtor = typeof AudioContext
type WorkletNodeCtor = new (ctx: AudioContext, name: string) => AudioWorkletNode

function getAudioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as Record<string, unknown>
  const ctor = w['AudioContext'] ?? w['webkitAudioContext']
  if (typeof ctor === 'function') return ctor as AudioContextCtor
  return null
}

function getWorkletNodeCtor(): WorkletNodeCtor | null {
  const ctor = (window as unknown as Record<string, unknown>)['AudioWorkletNode']
  if (typeof ctor === 'function') return ctor as WorkletNodeCtor
  return null
}

const MAX_RESTARTS = 8
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10000
const MEMORY_LIMIT = 5

function backoffDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
}

/**
 * Continuous transcription loop over Meta Muse Voice Transcribe realtime:
 * mic -> AudioWorklet (24kHz s16le) -> websocket, with exponential-backoff
 * reconnects, a bounded restart cap, and rolling short-term memory.
 */
export class VoiceAssistant {
  private ws: WebSocket | null = null
  private acked = false
  private closing = false
  private listening = false
  private restartAttempts = 0
  private restartTimer: number | null = null
  private ackTimer: number | null = null
  private closeTimer: number | null = null
  private audioCtx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private memory: MemoryEntry[] = []
  private callbacks: VoiceAssistantCallbacks
  /** Audio chunks dropped by backpressure; reset per connection. */
  private droppedChunks = 0
  /** Bumped on every start()/stop() so stale async continuations bail out. */
  private startEpoch = 0

  constructor(callbacks: VoiceAssistantCallbacks) {
    this.callbacks = callbacks
  }

  isListening(): boolean {
    return this.listening
  }

  /** Audio chunks dropped by backpressure on the current connection. */
  getDroppedChunks(): number {
    return this.droppedChunks
  }

  getMemory(): MemoryEntry[] {
    return [...this.memory]
  }

  pushMemory(entry: Omit<MemoryEntry, 'timestamp'>): void {
    this.memory.push({ ...entry, timestamp: Date.now() })
    if (this.memory.length > MEMORY_LIMIT) {
      this.memory.splice(0, this.memory.length - MEMORY_LIMIT)
    }
  }

  getContextString(): string {
    return this.memory.map((m) => `${m.phrase} -> ${m.label} (${m.x},${m.y})`).join(' | ')
  }

  clearMemory(): void {
    this.memory = []
  }

  async start(): Promise<void> {
    if (this.listening) return
    const epoch = ++this.startEpoch
    const AC = getAudioContextCtor()
    const WorkletCtor = getWorkletNodeCtor()
    if (!AC || !WorkletCtor || typeof WebSocket !== 'function') {
      logError('voice', 'speech recognition unsupported on this device')
      this.callbacks.onError('Speech recognition not supported on this device')
      return
    }
    const apiKey = import.meta.env.VITE_META_MODEL_API_KEY
    if (!hasApiKey() || typeof apiKey !== 'string' || apiKey.length === 0) {
      logError('voice', 'missing VITE_META_MODEL_API_KEY')
      this.callbacks.onError('API key missing: set VITE_META_MODEL_API_KEY in .env')
      return
    }
    const blocker = secureContextBlocker('Microphone')
    if (blocker) {
      logError('voice', blocker)
      this.callbacks.onError(blocker)
      return
    }
    // The mic stays open for the whole session; tracks stop on stop().
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch {
      if (epoch !== this.startEpoch) return
      const hint =
        (await permissionBlocker('microphone', 'Microphone access')) ?? 'Microphone access denied'
      logError('voice', hint)
      this.callbacks.onError(hint)
      return
    }
    if (epoch !== this.startEpoch) {
      VoiceAssistant.releaseStart(stream, null)
      return
    }
    // Build the graph in locals; publish only on the current epoch so a
    // stop()/start() that won the race keeps its own state intact.
    const audioCtx = new AC()
    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume()
      if (epoch !== this.startEpoch) {
        VoiceAssistant.releaseStart(stream, audioCtx)
        return
      }
      // The worklet ships from public/: Vite does not bundle AudioWorklet
      // modules referenced via `new URL`, so it never reaches dist from src.
      await audioCtx.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcmWorklet.js`)
      if (epoch !== this.startEpoch) {
        VoiceAssistant.releaseStart(stream, audioCtx)
        return
      }
      const sourceNode = audioCtx.createMediaStreamSource(stream)
      const workletNode = new WorkletCtor(audioCtx, 'pcm-worklet')
      workletNode.port.onmessage = (event: MessageEvent) => this.sendAudio(event.data)
      sourceNode.connect(workletNode)
      if (epoch !== this.startEpoch) {
        VoiceAssistant.releaseStart(stream, audioCtx)
        return
      }
      this.audioCtx = audioCtx
      this.micStream = stream
      this.sourceNode = sourceNode
      this.workletNode = workletNode
    } catch {
      VoiceAssistant.releaseStart(stream, audioCtx)
      if (epoch !== this.startEpoch) return
      logError('voice', 'audio capture graph failed to start')
      this.callbacks.onError('Speech recognition not supported on this device')
      return
    }

    this.listening = true
    this.restartAttempts = 0
    this.connect()
    logInfo('voice', 'listening started')
  }

  stop(): void {
    this.startEpoch++
    if (this.listening) logInfo('voice', 'listening stopped')
    this.listening = false
    this.clearRestartTimer()
    this.clearAckTimer()
    this.restartAttempts = 0
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Graceful end: signal end-of-stream and keep the socket draining to
      // the server close so the final endpointing transcript is captured.
      // Media teardown waits for finishClose/the close timeout; tearing it
      // down first would drop the mic while the drain is still in flight.
      if (!this.closing) {
        this.closing = true
        try {
          ws.send(JSON.stringify({ type: 'endStream' }))
        } catch {
          this.teardownSocket()
          this.teardownMedia()
          return
        }
      }
      if (this.ws === ws) {
        this.clearCloseTimer()
        this.closeTimer = window.setTimeout(() => {
          this.closeTimer = null
          if (this.ws === ws) {
            logWarn('voice', 'server close timed out; forcing close')
            this.teardownSocket()
            this.teardownMedia()
          }
        }, CLOSE_TIMEOUT_MS)
      }
    } else {
      this.teardownSocket()
      this.teardownMedia()
    }
  }

  private connect(): void {
    if (!this.listening) return
    // Shared key gate (see metaApi.hasApiKey): never open the transcribe
    // socket without a key, so no handshake can send "Bearer undefined".
    // Restart paths can reach connect() long after start()'s gate.
    const apiKey = import.meta.env.VITE_META_MODEL_API_KEY
    if (!hasApiKey() || typeof apiKey !== 'string' || apiKey.length === 0) {
      logError('voice', 'missing VITE_META_MODEL_API_KEY')
      this.callbacks.onError('API key missing: set VITE_META_MODEL_API_KEY in .env')
      this.stop()
      return
    }
    this.teardownSocket()
    this.acked = false
    this.closing = false
    this.droppedChunks = 0
    const ws = new WebSocket(REALTIME_URL)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      if (ws !== this.ws) return
      try {
        ws.send(JSON.stringify(buildHandshake(apiKey)))
      } catch {
        this.reconnect()
        return
      }
      this.clearAckTimer()
      this.ackTimer = window.setTimeout(() => {
        this.ackTimer = null
        if (ws !== this.ws || this.acked || !this.listening || this.closing) return
        logWarn('voice', 'transcribe ack timed out; reconnecting')
        this.reconnect()
      }, HANDSHAKE_TIMEOUT_MS)
    }
    ws.onmessage = (event: MessageEvent) => {
      if (ws !== this.ws) return
      this.handleMessage(event.data)
    }
    ws.onerror = () => {
      if (ws !== this.ws) return
      // onclose follows and drives the restart; avoid double-scheduling.
      logWarn('voice', 'transcribe socket error')
    }
    ws.onclose = (event: CloseEvent) => {
      if (ws !== this.ws) return
      this.ws = null
      this.clearAckTimer()
      if (this.closing || !this.listening) {
        this.finishClose(event.code)
        return
      }
      // Covers abnormal drops and the 60-min server session rotation.
      logWarn('voice', `transcribe session closed (${event.code}); reconnecting`)
      this.scheduleRestart()
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      logWarn('voice', 'ignoring malformed transcribe frame')
      return
    }
    // The {sessionId} ack gates all audio: the server sends it typelessly,
    // but also accept a typed session-created frame so audio gating cannot
    // lock permanently if the wire contract gains a type discriminator.
    // Other typed frames carrying a sessionId (e.g. transcript partials)
    // are not the ack.
    const frameType = msg['type']
    if (
      typeof msg['sessionId'] === 'string' &&
      (frameType === undefined ||
        (typeof frameType === 'string' && /session/i.test(frameType)))
    ) {
      this.acked = true
      this.clearAckTimer()
      logInfo('voice', 'transcribe session acknowledged')
      return
    }
    if (typeof frameType === 'string' && /session[-_ ]?created/i.test(frameType)) {
      this.acked = true
      this.clearAckTimer()
      logInfo('voice', 'transcribe session acknowledged')
      return
    }
    switch (msg['type']) {
      case 'speechComplete': {
        // Successful result resets the backoff ladder and cancels a pending restart.
        this.restartAttempts = 0
        this.clearRestartTimer()
        const transcript = typeof msg['transcript'] === 'string' ? msg['transcript'].trim() : ''
        if (transcript) this.callbacks.onPhrase(transcript)
        break
      }
      case 'transcript': {
        // Interim partials; endpointed text arrives as speechComplete.
        // Forwarded for live captions and barge-in (never dispatched).
        const partial = typeof msg['transcript'] === 'string' ? msg['transcript'].trim() : ''
        if (partial) this.callbacks.onInterim?.(partial)
        break
      }
      case 'speechStart':
        logDebug('voice', String(msg['type']))
        this.callbacks.onSpeechStart?.()
        break
      case 'speechEnd':
        logDebug('voice', String(msg['type']))
        this.callbacks.onSpeechEnd?.()
        break
      case 'error': {
        const detail = typeof msg['message'] === 'string' ? msg['message'] : 'unknown error'
        logWarn('voice', `transcribe error: ${detail}`)
        if (!this.closing && this.listening) this.reconnect()
        break
      }
      default:
        logDebug('voice', `ignoring unknown frame: ${String(msg['type'])}`)
        break
    }
  }

  private sendAudio(chunk: unknown): void {
    if (!this.listening || this.closing || !this.acked) return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!(chunk instanceof ArrayBuffer) || chunk.byteLength === 0) return
    // Blocks arrive in real time; drop (never queue) past ~5s buffered.
    // Drops stay silent on the wire but surface via a counter and a
    // throttled warn so slow networks are visible in the log.
    if (ws.bufferedAmount + chunk.byteLength > MAX_BUFFERED_BYTES) {
      this.droppedChunks += 1
      if (this.droppedChunks === 1 || this.droppedChunks % 50 === 0) {
        logWarn('voice', `transcribe backpressure: dropped ${this.droppedChunks} audio chunk(s)`)
      } else {
        logDebug('voice', `transcribe backpressure: dropped chunk ${this.droppedChunks}`)
      }
      return
    }
    try {
      ws.send(chunk)
    } catch {
      /* transient; the next block retries */
    }
  }

  private reconnect(): void {
    this.teardownSocket()
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (!this.listening) return
    // Error frame and close often fire for one failure; schedule only once.
    if (this.restartTimer !== null) return
    if (this.restartAttempts >= MAX_RESTARTS) {
      logError('voice', 'restart cap reached; stopping')
      this.callbacks.onError('Voice assistant stopped after repeated errors')
      this.stop()
      return
    }
    const delay = backoffDelay(this.restartAttempts)
    this.restartAttempts += 1
    logWarn('voice', `restart ${this.restartAttempts}/${MAX_RESTARTS} in ${delay}ms`)
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null
      if (!this.listening) return
      this.connect()
    }, delay)
  }

  private finishClose(code: number): void {
    this.clearCloseTimer()
    this.closing = false
    this.acked = false
    logInfo('voice', `transcribe session closed (${code})`)
    // Graceful-stop drain complete: release the mic graph now that the
    // final endpointing transcript has had its chance to arrive.
    this.teardownMedia()
  }

  private teardownSocket(): void {
    this.clearAckTimer()
    this.clearCloseTimer()
    const ws = this.ws
    this.ws = null
    this.acked = false
    this.closing = false
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
  }

  private teardownMedia(): void {
    const node = this.workletNode
    this.workletNode = null
    if (node) {
      node.port.onmessage = null
      try {
        node.disconnect()
      } catch {
        /* already torn down */
      }
    }
    const source = this.sourceNode
    this.sourceNode = null
    if (source) {
      try {
        source.disconnect()
      } catch {
        /* already torn down */
      }
    }
    const stream = this.micStream
    this.micStream = null
    if (stream) stream.getTracks().forEach((t) => t.stop())
    const ctx = this.audioCtx
    this.audioCtx = null
    if (ctx) void ctx.close().catch(() => undefined)
  }

  private static releaseStart(stream: MediaStream, ctx: AudioContext | null): void {
    stream.getTracks().forEach((t) => t.stop())
    if (ctx) void ctx.close().catch(() => undefined)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== null) {
      window.clearTimeout(this.ackTimer)
      this.ackTimer = null
    }
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
  }
}
