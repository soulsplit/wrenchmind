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
 * Pick the best voice: US English quality voice first, then any quality
 * English voice, then US English, then the browser default, then anything.
 * Non-English pools skip straight to default/first. Heuristic by design —
 * installed voices vary per device — and always total (never throws).
 */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const langOf = (voice: SpeechSynthesisVoice): string => voice.lang.toLowerCase()
  const en = voices.filter((voice) => langOf(voice).startsWith('en'))
  const pool = en.length > 0 ? en : voices
  return (
    pool.find((voice) => langOf(voice) === 'en-us' && isQualityVoiceName(voice.name)) ??
    pool.find((voice) => isQualityVoiceName(voice.name)) ??
    pool.find((voice) => langOf(voice) === 'en-us') ??
    pool.find((voice) => voice.default) ??
    pool[0] ??
    null
  )
}

interface SpeechTask {
  chunks: string[]
  index: number
  voice: SpeechSynthesisVoice | null
  resolve: () => void
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
  private task: SpeechTask | null = null
  /** Bumped on every speak/cancel so stale async continuations bail out. */
  private seq = 0

  constructor(options: SpeechServiceOptions = {}) {
    this.rate = options.rate ?? 1
    this.pitch = options.pitch ?? 1
    this.voiceTimeoutMs = options.voiceTimeoutMs ?? VOICE_WAIT_TIMEOUT_MS
  }

  async speakText(text: string): Promise<void> {
    const synth = getSynth()
    const chunks = splitSpeechChunks(text)
    if (!synth || chunks.length === 0) return
    this.cancelSpeech()
    const mine = this.seq
    // Task exists synchronously so isSpeaking()/cancelSpeech() are truthful
    // while voices resolve; utterances start once the voice is known.
    await new Promise<void>((resolve) => {
      const task: SpeechTask = { chunks, index: 0, voice: null, resolve }
      this.task = task
      void this.resolveVoice().then(
        (voice) => {
          if (mine !== this.seq || this.task !== task) return
          task.voice = voice
          logDebug('speech', `speaking ${chunks.length} chunk(s), ${text.length} chars`)
          this.speakNext(task)
        },
        () => {
          if (this.task === task) {
            this.task = null
            task.resolve()
          }
        },
      )
    })
  }

  /** Stop immediately; a pending speakText() resolves silently. */
  cancelSpeech(): void {
    this.seq += 1
    const task = this.task
    this.task = null
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
          if (typeof prev === 'function') prev.call(synth, event)
          window.clearTimeout(timer)
          resolve(synth.getVoices())
        }
      })
    }
    this.voice = pickVoice(voices)
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
    const text = task.chunks[task.index]
    if (text === undefined) {
      this.task = null
      task.resolve()
      return
    }
    task.index += 1
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = this.rate
    utterance.pitch = this.pitch
    if (task.voice) utterance.voice = task.voice
    utterance.onend = () => {
      if (this.task === task) this.speakNext(task)
    }
    utterance.onerror = (event: Event) => {
      const error = (event as { error?: unknown }).error
      logWarn('speech', `chunk failed (${String(error)}); continuing`)
      if (this.task === task) this.speakNext(task)
    }
    synth.speak(utterance)
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
