/** Meta Muse Voice Transcribe realtime wire helpers (audio in, phrases out). */

export const REALTIME_URL = 'wss://api.meta.ai/v1/asr/realtime'
export const TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0'
export const TARGET_SAMPLE_RATE = 24000
/** Window for the server's typeless {sessionId} ack before reconnecting. */
export const HANDSHAKE_TIMEOUT_MS = 10000
/** Fallback force-close after endStream if the server never closes. */
export const CLOSE_TIMEOUT_MS = 5000
/** ~5s of 24kHz s16le mono; sends past this are dropped, never queued. */
export const MAX_BUFFERED_BYTES = TARGET_SAMPLE_RATE * 2 * 5
export const LANGUAGE_BIAS = ['English']
/**
 * Domain terms the recognizer otherwise mishears: part vocabulary plus the
 * hands-free step commands ("done", "back", "repeat", ...) so short control
 * utterances survive endpointing intact. Biasing steers, never guarantees.
 */
export const KEYWORDS = [
  'bolt',
  'torque',
  'hex',
  'Torx',
  'gasket',
  'valve',
  'bearing',
  'fuse',
  'washer',
  'nut',
  'screw',
  'belt',
  'filter',
  'sensor',
  'pump',
  'plug',
  'wire',
  'clip',
  'done',
  'back',
  'repeat',
  'next',
  'previous',
]

export interface TranscribeHandshake {
  authorization: { accessToken: string }
  audioEncoding: 'PCM_24KHZ'
  model: string
  mode: 'ENDPOINTING'
  languageBias: string[]
  keywords: string[]
  emitAudioProgress: false
}

/** First JSON text frame on a fresh connection (server expects it <10s in). */
export function buildHandshake(apiKey: string): TranscribeHandshake {
  return {
    authorization: { accessToken: `Bearer ${apiKey}` },
    audioEncoding: 'PCM_24KHZ',
    model: TRANSCRIBE_MODEL,
    mode: 'ENDPOINTING',
    languageBias: [...LANGUAGE_BIAS],
    keywords: [...KEYWORDS],
    emitAudioProgress: false,
  }
}

/** Linear-interpolation resample to 24kHz mono; zero-copy when already 24kHz. */
export function downsampleTo24k(input: Float32Array, inputRate: number): Float32Array {
  if (input.length === 0) return new Float32Array(0)
  if (inputRate === TARGET_SAMPLE_RATE) return input
  if (!Number.isFinite(inputRate) || inputRate <= 0) return new Float32Array(0)
  const ratio = inputRate / TARGET_SAMPLE_RATE
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** Clamped float mono to signed 16-bit little-endian PCM. */
export function encodeS16LE(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return buf
}
