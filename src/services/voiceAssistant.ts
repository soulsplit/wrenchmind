import type { MemoryEntry } from '../types'
import { permissionBlocker, secureContextBlocker } from './mediaSupport'
import { logError, logInfo, logWarn } from './logger'

export interface VoiceAssistantCallbacks {
  onPhrase: (phrase: string) => void
  onError: (message: string) => void
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}

interface SpeechRecognitionEventLike extends Event {
  results: ArrayLike<SpeechRecognitionResultLike> & { length: number }
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string
}

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>
  const ctor = w['SpeechRecognition'] ?? w['webkitSpeechRecognition']
  if (typeof ctor === 'function') return ctor as SpeechRecognitionCtor
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
 * Continuous voice recognition loop with exponential-backoff restarts,
 * a bounded restart cap, and rolling short-term memory of resolved targets.
 */
export class VoiceAssistant {
  private rec: SpeechRecognitionLike | null = null
  private listening = false
  private restartAttempts = 0
  private restartTimer: number | null = null
  private audioCtx: AudioContext | null = null
  private memory: MemoryEntry[] = []
  private callbacks: VoiceAssistantCallbacks
  /** Bumped on every start()/stop() so stale async continuations bail out. */
  private startEpoch = 0

  constructor(callbacks: VoiceAssistantCallbacks) {
    this.callbacks = callbacks
  }

  isListening(): boolean {
    return this.listening
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
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      logError('voice', 'speech recognition unsupported on this device')
      this.callbacks.onError('Speech recognition not supported on this device')
      return
    }
    const blocker = secureContextBlocker('Microphone')
    if (blocker) {
      logError('voice', blocker)
      this.callbacks.onError(blocker)
      return
    }
    // Request mic explicitly so denials surface with a clear message.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      if (epoch !== this.startEpoch) return
      const hint =
        (await permissionBlocker('microphone', 'Microphone access')) ?? 'Microphone access denied'
      logError('voice', hint)
      this.callbacks.onError(hint)
      return
    }
    if (epoch !== this.startEpoch) return
    // Resume a suspended audio context so synthesis/capture can proceed.
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AC) {
        this.audioCtx ??= new AC()
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume()
      }
    } catch {
      /* non-fatal: recognition can still work */
    }
    if (epoch !== this.startEpoch) return

    this.listening = true
    this.restartAttempts = 0
    this.startRecognition(Ctor)
    logInfo('voice', 'listening started')
  }

  stop(): void {
    this.startEpoch++
    if (this.listening) logInfo('voice', 'listening stopped')
    this.listening = false
    this.clearRestartTimer()
    this.restartAttempts = 0
    try {
      this.rec?.stop()
    } catch {
      /* already stopped */
    }
    this.rec = null
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined)
      this.audioCtx = null
    }
  }

  private startRecognition(Ctor: SpeechRecognitionCtor): void {
    if (!this.listening) return
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = 'en-US'
    rec.onresult = (event) => {
      const last = event.results[event.results.length - 1]
      if (last?.isFinal) {
        // Successful result resets the backoff ladder and cancels a pending restart.
        this.restartAttempts = 0
        this.clearRestartTimer()
        const phrase = last[0].transcript.trim()
        if (phrase) this.callbacks.onPhrase(phrase)
      }
    }
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        logError('voice', `recognition error: ${event.error}`)
        this.callbacks.onError('Microphone access denied')
        this.stop()
        return
      }
      logWarn('voice', `recognition error: ${event.error}`)
      this.scheduleRestart()
    }
    rec.onend = () => {
      // onend fires after stop() too; only auto-restart while listening.
      if (this.listening) this.scheduleRestart()
    }
    this.rec = rec
    try {
      rec.start()
    } catch {
      this.scheduleRestart()
    }
  }

  private scheduleRestart(): void {
    if (!this.listening) return
    // onerror and onend often fire for one failure; schedule only once.
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
      const Ctor = getRecognitionCtor()
      if (!Ctor) {
        this.callbacks.onError('Speech recognition not supported on this device')
        this.stop()
        return
      }
      this.startRecognition(Ctor)
    }, delay)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }
}
