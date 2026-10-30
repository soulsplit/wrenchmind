// PcmWorkletProcessor: resamples mic input to 24kHz mono s16le and posts
// each block upstream. Plain JS with no imports (worklet scope). Silence
// blocks keep the server paced when the track yields no channel data.
//
// Lives in public/ (not src/): Vite does not bundle AudioWorklet modules
// referenced via `new URL`, so the worklet is copied verbatim to dist and
// loaded through import.meta.env.BASE_URL (covers the /wrenchmind/ Pages
// subpath). Keep the resample/encode math in sync with realtimeTranscribe.
const TARGET_RATE = 24000
const SILENCE_SAMPLES = 128

function resampleTo24k(input, inputRate) {
  if (inputRate === TARGET_RATE) return input
  const ratio = inputRate / TARGET_RATE
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

function encodeS16LE(samples) {
  const buf = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return buf
}

class PcmWorkletProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0]
    const mono =
      channel && channel.length > 0 ? resampleTo24k(channel, sampleRate) : new Float32Array(SILENCE_SAMPLES)
    const buffer = encodeS16LE(mono)
    this.port.postMessage(buffer, [buffer])
    return true
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor)
