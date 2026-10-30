import { describe, expect, it } from 'vitest'
import {
  KEYWORDS,
  LANGUAGE_BIAS,
  TARGET_SAMPLE_RATE,
  TRANSCRIBE_MODEL,
  buildHandshake,
  downsampleTo24k,
  encodeS16LE,
} from './realtimeTranscribe'

describe('downsampleTo24k', () => {
  it('returns an empty array for empty input', () => {
    expect(downsampleTo24k(new Float32Array(0), 48000)).toEqual(new Float32Array(0))
  })

  it('zero-copies when already at 24kHz', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(downsampleTo24k(input, TARGET_SAMPLE_RATE)).toBe(input)
  })

  it('returns empty for non-finite or non-positive rates', () => {
    const input = new Float32Array([0.1, 0.2])
    expect(downsampleTo24k(input, 0)).toEqual(new Float32Array(0))
    expect(downsampleTo24k(input, -44100)).toEqual(new Float32Array(0))
    expect(downsampleTo24k(input, Number.NaN)).toEqual(new Float32Array(0))
    expect(downsampleTo24k(input, Number.POSITIVE_INFINITY)).toEqual(new Float32Array(0))
  })

  it('halves a 48kHz signal with linear interpolation', () => {
    const input = new Float32Array([0, 10, 20, 30])
    expect(Array.from(downsampleTo24k(input, 48000))).toEqual([0, 20])
  })

  it('doubles an 8kHz signal with linear interpolation', () => {
    const input = new Float32Array([0, 10])
    // ratio 8000/24000 = 1/3: 6 output samples stepping 1/3 through input.
    const out = downsampleTo24k(input, 8000)
    expect(out.length).toBe(6)
    const expected = [0, 10 / 3, 20 / 3, 10, 10, 10]
    expect(out.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      expect(out[i]).toBeCloseTo(expected[i], 5)
    }
  })

  it('handles 44.1kHz without dropping to empty', () => {
    const input = new Float32Array([1, 2, 3, 4])
    const out = downsampleTo24k(input, 44100)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]).toBeCloseTo(1, 5)
  })
})

describe('encodeS16LE', () => {
  function decoded(samples: Float32Array): number[] {
    const buf = encodeS16LE(samples)
    expect(buf.byteLength).toBe(samples.length * 2)
    const view = new DataView(buf)
    return Array.from(samples, (_, i) => view.getInt16(i * 2, true))
  }

  it('encodes silence and full-scale extremes', () => {
    expect(decoded(new Float32Array([0]))).toEqual([0])
    expect(decoded(new Float32Array([1]))).toEqual([32767])
    expect(decoded(new Float32Array([-1]))).toEqual([-32768])
  })

  it('clamps out-of-range samples', () => {
    expect(decoded(new Float32Array([2]))).toEqual([32767])
    expect(decoded(new Float32Array([-2]))).toEqual([-32768])
    expect(decoded(new Float32Array([1.5, -1.5]))).toEqual([32767, -32768])
  })

  it('scales mid-range values', () => {
    expect(decoded(new Float32Array([0.5]))).toEqual([Math.round(0.5 * 0x7fff)])
    expect(decoded(new Float32Array([-0.5]))).toEqual([Math.round(-0.5 * 0x8000)])
  })
})

describe('buildHandshake', () => {
  it('returns the expected realtime handshake shape', () => {
    const hs = buildHandshake('secret-key')
    expect(hs).toEqual({
      authorization: { accessToken: 'Bearer secret-key' },
      audioEncoding: 'PCM_24KHZ',
      model: TRANSCRIBE_MODEL,
      mode: 'ENDPOINTING',
      languageBias: [...LANGUAGE_BIAS],
      keywords: [...KEYWORDS],
      emitAudioProgress: false,
    })
  })

  it('copies array fields so callers cannot mutate the defaults', () => {
    const hs = buildHandshake('k')
    expect(hs.languageBias).not.toBe(LANGUAGE_BIAS)
    expect(hs.keywords).not.toBe(KEYWORDS)
    hs.languageBias.push('mutated')
    expect(LANGUAGE_BIAS).not.toContain('mutated')
  })
})
