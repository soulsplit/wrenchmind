import { logDebug, logInfo, logWarn } from './logger'

/** Target size for spoken chunks; splits fall on sentence boundaries. */
export const SPEECH_CHUNK_TARGET = 200

/** How long to wait for async voice loading before falling back. */
const VOICE_WAIT_TIMEOUT_MS = 2000

export interface SpeechVoiceInfo {
  name: string
  lang: string
}

export interface SpeechServiceOptions {
  rate?: number
  pitch?: number
  /** Overridable for tests; production waits for real voice loading. */
  voiceTimeoutMs?: number
}

function getSynth(): SpeechSynthesis | null {
  return 'speechSynthesis' in window ? window.speechSynthesis : null
}

/**
 * Rewrite model text into speech-friendly words before handing it to the
 * synthesizer: strip markdown/formatting the voice would read aloud, and
 * expand part codes and units ("M6" -> "M six", "24V DC" -> "24 volt D C")
 * that otherwise sound robotic or wrong. Deterministic and total.
 */
export function normalizeForSpeech(text: string): string {
  let out = text.replace(/\r/g, ' ')
  // Markdown links keep their text; images drop the URL, keep alt text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Inline code, bold/italic markers, headings, quotes, list markers.
  out = out.replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2')
  out = out.replace(/(^|\s)[*_~]{1,2}(\S)/g, '$1$2')
  out = out.replace(/(^|\s)#{1,6}\s+/g, '$1')
  out = out.replace(/(^|\s)>\s?/g, '$1')
  out = out.replace(/(^|\s)[-*]\s+(?=\S)/g, '$1')
  out = out.replace(/(^|\s)\d+[.)]\s+(?=\S)/g, '$1')
  // Punctuation the voice mangles or reads literally.
  out = out.replace(/[·•]/g, ', ')
  out = out.replace(/×/g, ' by ')
  out = out.replace(/→|->/g, ', then ')
  out = out.replace(/&/g, ' and ')
  out = out.replace(/\+/g, ' plus ')
  out = out.replace(/%/g, ' percent ')
  out = out.replace(/°/g, ' degrees ')
  // Metric/imperial part codes: M6 -> "M six", T25 -> "T two five".
  out = out.replace(
    /\b([A-Z])(\d{1,2})\b/g,
    (_, letter: string, digits: string) =>
      `${letter} ${digits.split('').map(numberWord).join(' ')}`,
  )
  // Units spoken as words: 24V / 12 V DC / 5Nm / 8mm / 60Hz.
  out = out
    .replace(/(\d)\s*V\b(?!\w)/gi, '$1 volt')
    .replace(/\bDC\b/g, 'D C')
    .replace(/\bAC\b/g, 'A C')
    .replace(/(\d)\s*Nm\b/gi, '$1 newton meters')
    .replace(/(\d)\s*mm\b/gi, '$1 millimeters')
    .replace(/(\d)\s*cm\b/gi, '$1 centimeters')
    .replace(/(\d)\s*Hz\b/gi, '$1 hertz')
  out = out.replace(/\s+/g, ' ').trim()
  return out
}

/** English word for a single digit; falls back to the digit itself. */
function numberWord(digit: string): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
  const n = Number(digit)
  return Number.isInteger(n) && n >= 0 && n <= 9 ? (words[n] as string) : digit
}

/** Split text into sentence-bounded chunks; overlong sentences hard-split. */
export function splitSpeechChunks(text: string, target = SPEECH_CHUNK_TARGET): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const sentences = normalized.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ''
  const push = (): void => {
    if (current) chunks.push(current)
    current = ''
  }
  for (const sentence of sentences) {
    if (sentence.length > target) {
      push()
      for (let i = 0; i < sentence.length; i += target) {
        const part = sentence.slice(i, i + target).trim()
        if (part) chunks.push(part)
      }
      continue
    }
    const merged = current ? `${current} ${sentence}` : sentence
    if (merged.length <= target) {
      current = merged
    } else {
      push()
      current = sentence
    }
  }
  push()
  return chunks
}

function isQualityVoiceName(name: string): boolean {
  return /neural|natural|premium|enhanced|wavenet|neural2|studio|samantha/i.test(name)
}

/**
 * Curated per-platform voices, most natural first. The generic quality
 * heuristic below stays as fallback; installed voices vary per device,
 * and these names match the best-known mobile/desktop defaults.
 */
const PREFERRED_VOICE_PATTERNS = [
  /google us english/i,
  /samantha/i,
  /microsoft (jenny|aria|guy)( natural)?/i,
  /samsung.*english.*(neural|natural)/i,
  /zira/i,
]

/**
 * Pick the best voice: user override first, then curated platform voices,
 * then US English quality voice, then any quality English voice, then US
 * English, then the browser default, then anything. Non-English pools skip
 * straight to default/first. Heuristic by design — installed voices vary
 * per device — and always total (never throws).
 */
function pickVoice(
  voices: SpeechSynthesisVoice[],
  preferredName: string | null = null,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  if (preferredName) {
    const exact = voices.find((voice) => voice.name === preferredName)
    if (exact) return exact
  }
  const langOf = (voice: SpeechSynthesisVoice): string => voice.lang.toLowerCase()
  const en = voices.filter((voice) => langOf(voice).startsWith('en'))
  const pool = en.length > 0 ? en : voices
  for (const pattern of PREFERRED_VOICE_PATTERNS) {
    const match = pool.find((voice) => pattern.test(voice.name))
    if (match) return match
  }
  return (
    pool.find((voice) => langOf(voice) === 'en-us' && isQualityVoiceName(voice.name)) ??
    pool.find((voice) => isQualityVoiceName(voice.name)) ??
    pool.find((voice) => langOf(voice) === 'en-us') ??
    pool.find((voice) => voice.default) ??
    pool[0] ??
    null
  )
}

/** localStorage gate for the user's chosen speech voice (voice picker). */
const TTS_VOICE_KEY = 'wrenchmind.ttsVoice'

function loadPreferredVoiceName(): string | null {
  try {
    return window.localStorage.getItem(TTS_VOICE_KEY)
  } catch {
    return null
  }
}

interface SpeechTask {
  chunks: string[]
  index: number
  voice: SpeechSynthesisVoice | null
  resolve: () => void
  /** Bumped per chunk so late events from a cancelled utterance are ignored. */
  utteranceSeq: number
  /** Per-chunk watchdog forcing a stuck utterance to settle. */
  watchdog: number | null
}

/** Worst-case ms per spoken char (slow voice + slack), scaled by rate. */
const WATCHDOG_MS_PER_CHAR = 200
/** Floor so short chunks still outlast synth startup latency. */
const WATCHDOG_MIN_MS = 8000
/** Ceiling so a wedged synth cannot stall the queue indefinitely. */
const WATCHDOG_MAX_MS = 120000

/** Generous per-chunk deadline: estimated speech time plus wide slack. */
function chunkWatchdogMs(text: string, rate: number): number {
  const paced = Math.min(Math.max(rate, 0.25), 4)
  return Math.min(
    WATCHDOG_MAX_MS,
    Math.max(WATCHDOG_MIN_MS, (text.length * WATCHDOG_MS_PER_CHAR) / paced),
  )
}

/**
 * Promise-based speech output over window.speechSynthesis: picks the best
 * installed voice, chains sentence-bounded chunks, survives per-chunk
 * errors, and settles (never hangs) on cancel. Silent no-op where the
 * API is absent. A newer speakText() always preempts an older one.
 */
export class SpeechService {
  private readonly rate: number
  private readonly pitch: number
  private readonly voiceTimeoutMs: number
  private voice: SpeechSynthesisVoice | null = null
  private preferredVoiceName: string | null = loadPreferredVoiceName()
  private task: SpeechTask | null = null
  /** Bumped on every speak/cancel so stale async continuations bail out. */
  private seq = 0

  constructor(options: SpeechServiceOptions = {}) {
    this.rate = options.rate ?? 1
    this.pitch = options.pitch ?? 1
    this.voiceTimeoutMs = options.voiceTimeoutMs ?? VOICE_WAIT_TIMEOUT_MS
  }

  /** User's pinned voice from the voice picker; null follows auto-pick. */
  getPreferredVoiceName(): string | null {
    return this.preferredVoiceName
  }

  /** Pin a voice by exact name (persisted); null clears back to auto-pick. */
  setPreferredVoiceName(name: string | null): void {
    this.preferredVoiceName = name
    try {
      if (name) window.localStorage.setItem(TTS_VOICE_KEY, name)
      else window.localStorage.removeItem(TTS_VOICE_KEY)
    } catch {
      /* private mode: keep the in-memory override */
    }
    // Re-resolve against already-loaded voices so the next utterance uses it.
    const synth = getSynth()
    if (synth) {
      const match = name ? synth.getVoices().find((voice) => voice.name === name) ?? null : null
      this.voice = match ?? (name ? this.voice : null)
    }
  }

  /** Resolve (and cache) the voice early so the first utterance starts fast. */
  async warmUp(): Promise<void> {
    await this.resolveVoice()
  }

  async speakText(text: string): Promise<void> {
    const synth = getSynth()
    // Normalize for the ear, not the eye: the synthesizer reads whatever
    // text it gets, so markdown and part codes go through the speech pass.
    const chunks = splitSpeechChunks(normalizeForSpeech(text))
    if (!synth || chunks.length === 0) return
    this.cancelSpeech()
    const mine = this.seq
    // Task exists synchronously so isSpeaking()/cancelSpeech() are truthful
    // while voices resolve; utterances start once the voice is known.
    await new Promise<void>((resolve) => {
      const task: SpeechTask = {
        chunks,
        index: 0,
        voice: null,
        resolve,
        utteranceSeq: 0,
        watchdog: null,
      }
      this.task = task
      void this.resolveVoice().then(
        (voice) => {
          if (mine !== this.seq || this.task !== task) {
            // Preempted while voices resolved: settle the orphaned promise.
            // cancelSpeech() normally resolves it first; resolve is idempotent.
            task.resolve()
            return
          }
          task.voice = voice
          logDebug('speech', `speaking ${chunks.length} chunk(s), ${text.length} chars`)
          this.speakNext(task)
        },
        () => {
          if (this.task === task) {
            this.task = null
          }
          task.resolve()
        },
      )
    })
  }

  /** Stop immediately; a pending speakText() resolves silently. */
  cancelSpeech(): void {
    this.seq += 1
    const task = this.task
    this.task = null
    if (task) this.clearWatchdog(task)
    getSynth()?.cancel()
    task?.resolve()
  }

  isSpeaking(): boolean {
    return this.task !== null
  }

  async getAvailableVoices(): Promise<SpeechVoiceInfo[]> {
    const synth = getSynth()
    if (!synth) return []
    if (synth.getVoices().length === 0) {
      await this.resolveVoice()
    }
    return synth.getVoices().map((voice) => ({ name: voice.name, lang: voice.lang }))
  }

  private async resolveVoice(): Promise<SpeechSynthesisVoice | null> {
    if (this.voice) return this.voice
    const synth = getSynth()
    if (!synth) return null
    let voices = synth.getVoices()
    if (voices.length === 0) {
      voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
        const prev = synth.onvoiceschanged
        const timer = window.setTimeout(() => {
          synth.onvoiceschanged = prev
          resolve(synth.getVoices())
        }, this.voiceTimeoutMs)
        synth.onvoiceschanged = (event) => {
          synth.onvoiceschanged = prev
          if (typeof prev === 'function') prev.call(synth, event)
          window.clearTimeout(timer)
          resolve(synth.getVoices())
        }
      })
    }
    this.voice = pickVoice(voices, this.preferredVoiceName)
    if (this.voice) {
      logInfo(
        'speech',
        `voice: ${this.voice.name} (${this.voice.lang}) [${voices.length} available]`,
      )
    } else {
      logWarn('speech', 'no synthesis voices available; using default')
    }
    return this.voice
  }

  private speakNext(task: SpeechTask): void {
    const synth = getSynth()
    if (this.task !== task || !synth) return
    this.clearWatchdog(task)
    const text = task.chunks[task.index]
    if (text === undefined) {
      this.task = null
      task.resolve()
      return
    }
    task.index += 1
    task.utteranceSeq += 1
    const utteranceSeq = task.utteranceSeq
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = this.rate
    utterance.pitch = this.pitch
    if (task.voice) utterance.voice = task.voice
    // Stale when preempted/cancelled or when the watchdog already moved on.
    const stale = (): boolean => this.task !== task || task.utteranceSeq !== utteranceSeq
    utterance.onend = () => {
      if (!stale()) this.speakNext(task)
    }
    utterance.onerror = (event: Event) => {
      if (stale()) return
      const error = (event as { error?: unknown }).error
      logWarn('speech', `chunk failed (${String(error)}); continuing`)
      this.speakNext(task)
    }
    synth.speak(utterance)
    // Watchdog: speechSynthesis is known to drop end/error events (pipeline
    // pauses, background tabs); force-advance the stuck chunk so the task
    // always settles instead of wedging isSpeaking() forever.
    task.watchdog = window.setTimeout(() => {
      task.watchdog = null
      if (stale()) return
      logWarn('speech', 'utterance watchdog fired; advancing to the next chunk')
      try {
        synth.cancel()
      } catch {
        /* synth already gone */
      }
      this.speakNext(task)
    }, chunkWatchdogMs(text, this.rate))
  }

  private clearWatchdog(task: SpeechTask): void {
    if (task.watchdog !== null) {
      window.clearTimeout(task.watchdog)
      task.watchdog = null
    }
  }
}

const shared = new SpeechService()

export function speakText(text: string): Promise<void> {
  return shared.speakText(text)
}

export function cancelSpeech(): void {
  shared.cancelSpeech()
}

export function isSpeaking(): boolean {
  return shared.isSpeaking()
}

export function getAvailableVoices(): Promise<SpeechVoiceInfo[]> {
  return shared.getAvailableVoices()
}

/** Resolve the speech voice early (voice toggle) so first speech starts fast. */
export function warmUpSpeechVoices(): Promise<void> {
  return shared.warmUp()
}

/** The voice pinned in the voice picker; null follows auto-pick. */
export function getPreferredVoiceName(): string | null {
  return shared.getPreferredVoiceName()
}

/** Pin a speech voice by exact name (persisted); null clears to auto-pick. */
export function setPreferredVoiceName(name: string | null): void {
  shared.setPreferredVoiceName(name)
}

/** Lazily-created blip context, reused across blips (browsers cap contexts). */
let blipCtx: AudioContext | null = null

function getBlipContext(): AudioContext | null {
  const w = window as unknown as Record<string, unknown>
  const Ctor = w['AudioContext'] ?? w['webkitAudioContext']
  if (typeof Ctor !== 'function') return null
  const CtorFn = Ctor as typeof AudioContext
  if (!blipCtx || blipCtx.state === 'closed' || !(blipCtx instanceof CtorFn)) {
    try {
      blipCtx = new CtorFn()
    } catch {
      blipCtx = null
      return null
    }
  }
  return blipCtx
}

/**
 * Short acknowledgement blip on turn endpoint ("got it" feel). Best-effort:
 * silent no-op without AudioContext or on any failure; never throws.
 */
export function playAckBlip(): void {
  try {
    const ctx = getBlipContext()
    if (!ctx) return
    void ctx.resume?.().catch(() => undefined)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.13)
    // The shared context stays open for the next blip.
  } catch {
    /* audio unavailable: stay silent */
  }
}
