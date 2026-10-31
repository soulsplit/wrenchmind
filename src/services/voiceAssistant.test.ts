import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { VoiceAssistant } from './voiceAssistant'
import {
  KEYWORDS,
  buildHandshake,
  downsampleTo24k,
  encodeS16LE,
} from './realtimeTranscribe'
import { clearLogs, getLogs } from './logger'

type Frame = string | ArrayBuffer

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeWebSocket.CONNECTING
  binaryType = 'blob'
  bufferedAmount = 0
  sent: Frame[] = []
  closeCode: number | null = null
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(frame: Frame): void {
    this.sent.push(frame)
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED
    this.closeCode = code
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  receiveText(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  receiveRaw(data: string): void {
    this.onmessage?.({ data })
  }

  serverClose(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code })
  }

  fail(): void {
    this.onerror?.({})
    this.serverClose(1006)
  }
}

class FakeWorkletNode {
  static instances: FakeWorkletNode[] = []
  port: { onmessage: ((ev: { data: ArrayBuffer }) => void) | null } = { onmessage: null }

  constructor(
    public context: unknown,
    public name: string,
  ) {
    FakeWorkletNode.instances.push(this)
  }

  connect(): void {
    /* graph edge stub */
  }

  disconnect(): void {
    /* graph edge stub */
  }

  emit(chunk: ArrayBuffer): void {
    this.port.onmessage?.({ data: chunk })
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  sampleRate = 48000
  state: 'suspended' | 'running' | 'closed' = 'suspended'
  resume = vi.fn(async (): Promise<void> => {
    this.state = 'running'
  })
  close = vi.fn(async (): Promise<void> => {
    this.state = 'closed'
  })
  audioWorklet = { addModule: vi.fn() as Mock<(url: string) => Promise<void>> }
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }))

  constructor() {
    FakeAudioContext.instances.push(this)
  }
}

const EXPECTED_HANDSHAKE = {
  authorization: { accessToken: 'Bearer test-key' },
  audioEncoding: 'PCM_24KHZ',
  model: 'muse-voice-transcribe-1.0',
  mode: 'ENDPOINTING',
  languageBias: ['English'],
  keywords: [...KEYWORDS],
  emitAudioProgress: false,
}

function installAudio(): void {
  const w = window as unknown as Record<string, unknown>
  w['AudioContext'] = FakeAudioContext
  w['AudioWorkletNode'] = FakeWorkletNode
}

function uninstallAudio(): void {
  const w = window as unknown as Record<string, unknown>
  delete w['AudioContext']
  delete w['AudioWorkletNode']
}

function stubSocket(): void {
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
}

function mockMicrophone(granted: boolean): {
  tracks: { stop: Mock }[]
  getUserMedia: Mock
} {
  const tracks = [{ stop: vi.fn() }]
  const getUserMedia = vi.fn(async () => {
    if (!granted) throw new Error('denied')
    return { getTracks: () => tracks } as unknown as MediaStream
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia } as unknown as MediaDevices,
    configurable: true,
  })
  return { tracks, getUserMedia }
}

async function startListening(callbacks?: {
  onPhrase?: Mock
  onError?: Mock
  onInterim?: Mock
  onSpeechStart?: Mock
  onSpeechEnd?: Mock
}): Promise<{
  assistant: VoiceAssistant
  onPhrase: Mock
  onError: Mock
  onInterim: Mock
  onSpeechStart: Mock
  onSpeechEnd: Mock
  tracks: { stop: Mock }[]
  getUserMedia: Mock
}> {
  installAudio()
  stubSocket()
  const { tracks, getUserMedia } = mockMicrophone(true)
  const onPhrase = callbacks?.onPhrase ?? vi.fn()
  const onError = callbacks?.onError ?? vi.fn()
  const onInterim = callbacks?.onInterim ?? vi.fn()
  const onSpeechStart = callbacks?.onSpeechStart ?? vi.fn()
  const onSpeechEnd = callbacks?.onSpeechEnd ?? vi.fn()
  const assistant = new VoiceAssistant({ onPhrase, onError, onInterim, onSpeechStart, onSpeechEnd })
  await assistant.start()
  return { assistant, onPhrase, onError, onInterim, onSpeechStart, onSpeechEnd, tracks, getUserMedia }
}

function latestSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
}

function openAndAck(ws: FakeWebSocket, sessionId = 's1'): void {
  ws.open()
  ws.receiveText({ sessionId })
}

function binaryFrames(ws: FakeWebSocket): Frame[] {
  return ws.sent.filter((f) => typeof f !== 'string')
}

beforeEach(() => {
  FakeWebSocket.instances = []
  FakeWorkletNode.instances = []
  FakeAudioContext.instances = []
  clearLogs()
  vi.stubEnv('VITE_META_MODEL_API_KEY', 'test-key')
})

afterEach(() => {
  uninstallAudio()
  delete (window as unknown as Record<string, unknown>)['isSecureContext']
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('memory', () => {
  it('keeps only the 5 most recent entries and formats context', () => {
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
    for (let i = 0; i < 6; i++) {
      assistant.pushMemory({ phrase: `p${i}`, label: `l${i}`, x: i, y: i })
    }
    const mem = assistant.getMemory()
    expect(mem).toHaveLength(5)
    expect(mem[0].phrase).toBe('p1')
    expect(assistant.getContextString()).toContain('p1 -> l1 (1,1)')
    expect(assistant.getContextString()).not.toContain('p0')
    assistant.clearMemory()
    expect(assistant.getMemory()).toEqual([])
    expect(assistant.getContextString()).toBe('')
  })
})

describe('handshake and ack gating', () => {
  it('sends the Muse handshake as the first frame on open', async () => {
    const { assistant, getUserMedia } = await startListening()
    expect(assistant.isListening()).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = latestSocket()
    expect(ws.url).toBe('wss://api.meta.ai/v1/asr/realtime')
    expect(ws.sent).toHaveLength(0)
    ws.open()
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0] as string)).toEqual(EXPECTED_HANDSHAKE)
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
    expect(FakeWorkletNode.instances).toHaveLength(1)
    expect(FakeWorkletNode.instances[0].name).toBe('pcm-worklet')
    const addModule = FakeAudioContext.instances[0].audioWorklet.addModule
    expect(addModule).toHaveBeenCalledTimes(1)
    expect(String(addModule.mock.calls[0][0])).toContain('pcmWorklet.js')
    assistant.stop()
  })

  it('sends audio only after the typeless session ack', async () => {
    const { assistant } = await startListening()
    const ws = latestSocket()
    ws.open()
    const node = FakeWorkletNode.instances[0]
    node.emit(new ArrayBuffer(128))
    expect(binaryFrames(ws)).toHaveLength(0)
    // A typed frame carrying a sessionId is not the ack.
    ws.receiveText({ type: 'transcript', sessionId: 's1', transcript: 'half' })
    node.emit(new ArrayBuffer(128))
    expect(binaryFrames(ws)).toHaveLength(0)
    ws.receiveText({ sessionId: 's1' })
    node.emit(new ArrayBuffer(128))
    expect(binaryFrames(ws)).toHaveLength(1)
    assistant.stop()
  })

  it('drops audio while more than 5s is buffered', async () => {
    const { assistant } = await startListening()
    const ws = latestSocket()
    openAndAck(ws)
    // 5s * 24kHz * 2 bytes.
    ws.bufferedAmount = 240000 + 1
    FakeWorkletNode.instances[0].emit(new ArrayBuffer(128))
    expect(binaryFrames(ws)).toHaveLength(0)
    ws.bufferedAmount = 0
    FakeWorkletNode.instances[0].emit(new ArrayBuffer(128))
    expect(binaryFrames(ws)).toHaveLength(1)
    assistant.stop()
  })
})

describe('transcription frames', () => {
  it('emits trimmed phrases on speechComplete', async () => {
    const onPhrase = vi.fn()
    const { assistant } = await startListening({ onPhrase })
    openAndAck(latestSocket())
    latestSocket().receiveText({ type: 'speechComplete', transcript: '  show screws ' })
    expect(onPhrase).toHaveBeenCalledWith('show screws')
    latestSocket().receiveText({ type: 'speechComplete', transcript: '   ' })
    expect(onPhrase).toHaveBeenCalledTimes(1)
    assistant.stop()
  })

  it('resets the restart ladder on speechComplete', async () => {
    vi.useFakeTimers()
    const { assistant } = await startListening()
    openAndAck(latestSocket())
    latestSocket().receiveText({ type: 'error', message: 'boom' })
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    openAndAck(latestSocket())
    latestSocket().receiveText({ type: 'speechComplete', transcript: 'go' })
    latestSocket().receiveText({ type: 'error', message: 'boom' })
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
    assistant.stop()
  })

  it('resets the restart ladder on session ack', async () => {
    vi.useFakeTimers()
    const { assistant } = await startListening()
    openAndAck(latestSocket())
    latestSocket().receiveText({ type: 'error', message: 'boom' })
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    openAndAck(latestSocket())
    // The ack reset the ladder: the next failure backs off from 500ms again.
    latestSocket().receiveText({ type: 'error', message: 'boom' })
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
    assistant.stop()
  })

  it('forwards interim partials to onInterim without dispatching', async () => {
    const onPhrase = vi.fn()
    const onInterim = vi.fn()
    const { assistant } = await startListening({ onPhrase, onInterim })
    openAndAck(latestSocket())
    latestSocket().receiveText({ type: 'transcript', transcript: 'half', final: false })
    latestSocket().receiveText({ type: 'transcript', transcript: '  half done ' })
    latestSocket().receiveText({ type: 'transcript', transcript: '   ' })
    expect(onInterim).toHaveBeenCalledWith('half')
    expect(onInterim).toHaveBeenCalledWith('half done')
    expect(onInterim).toHaveBeenCalledTimes(2)
    expect(onPhrase).not.toHaveBeenCalled()
    expect(assistant.isListening()).toBe(true)
    assistant.stop()
  })

  it('fires speech boundary callbacks and keeps debug logs', async () => {
    const onSpeechStart = vi.fn()
    const onSpeechEnd = vi.fn()
    const { assistant } = await startListening({ onSpeechStart, onSpeechEnd })
    openAndAck(latestSocket())
    latestSocket().receiveText({ type: 'speechStart' })
    latestSocket().receiveText({ type: 'speechEnd' })
    expect(onSpeechStart).toHaveBeenCalledTimes(1)
    expect(onSpeechEnd).toHaveBeenCalledTimes(1)
    const debug = getLogs().filter((e) => e.level === 'debug' && e.tag === 'voice')
    expect(debug.some((e) => e.message.includes('speechStart'))).toBe(true)
    expect(debug.some((e) => e.message.includes('speechEnd'))).toBe(true)
    assistant.stop()
  })

  it('ignores malformed and unknown frames', async () => {
    const onPhrase = vi.fn()
    const onError = vi.fn()
    const { assistant } = await startListening({ onPhrase, onError })
    openAndAck(latestSocket())
    latestSocket().receiveRaw('not json')
    latestSocket().receiveText({ type: 'mystery', transcript: 'x' })
    expect(onPhrase).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(assistant.isListening()).toBe(true)
    assistant.stop()
  })
})

describe('errors and restarts', () => {
  it('reconnects with backoff after a server error frame', async () => {
    vi.useFakeTimers()
    const { assistant, tracks } = await startListening()
    const first = latestSocket()
    openAndAck(first)
    first.receiveText({ type: 'error', message: 'overloaded' })
    expect(first.closeCode).toBe(1000)
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    // Reconnects recycle the socket; the mic stays alive.
    expect(tracks[0].stop).not.toHaveBeenCalled()
    assistant.stop()
  })

  it('reconnects after an abnormal server close', async () => {
    vi.useFakeTimers()
    const { assistant } = await startListening()
    openAndAck(latestSocket())
    latestSocket().serverClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    assistant.stop()
  })

  it('reconnects after a clean server close while listening (session rotation)', async () => {
    vi.useFakeTimers()
    const { assistant } = await startListening()
    openAndAck(latestSocket())
    latestSocket().serverClose(1000)
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    assistant.stop()
  })

  it('reconnects when the session ack never arrives', async () => {
    vi.useFakeTimers()
    const { assistant } = await startListening()
    latestSocket().open()
    await vi.advanceTimersByTimeAsync(9999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    assistant.stop()
  })

  it('schedules a single restart when an error frame and close arrive together', async () => {
    vi.useFakeTimers()
    const { assistant } = await startListening()
    openAndAck(latestSocket())
    latestSocket().receiveText({ type: 'error', message: 'x' })
    latestSocket().serverClose(1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    assistant.stop()
  })

  it('caps restarts and reports when the cap is reached', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const { assistant } = await startListening({ onError })
    for (let i = 0; i < 9; i++) {
      latestSocket().receiveText({ type: 'error', message: 'bad' })
      await vi.advanceTimersByTimeAsync(20000)
    }
    expect(onError).toHaveBeenCalledWith('Voice assistant stopped after repeated errors')
    expect(assistant.isListening()).toBe(false)
    // 1 initial + 8 restarts; the 9th error hits the cap.
    expect(FakeWebSocket.instances).toHaveLength(9)
  })
})

describe('start', () => {
  it('errors when audio capture is unsupported', async () => {
    uninstallAudio()
    stubSocket()
    mockMicrophone(true)
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    expect(onError).toHaveBeenCalledWith('Speech recognition not supported on this device')
    expect(assistant.isListening()).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('errors when AudioWorkletNode is missing', async () => {
    installAudio()
    delete (window as unknown as Record<string, unknown>)['AudioWorkletNode']
    stubSocket()
    mockMicrophone(true)
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    expect(onError).toHaveBeenCalledWith('Speech recognition not supported on this device')
    expect(assistant.isListening()).toBe(false)
  })

  it('errors when the API key is missing', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', '')
    installAudio()
    stubSocket()
    mockMicrophone(true)
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    expect(onError).toHaveBeenCalledWith('API key missing: set VITE_META_MODEL_API_KEY in .env')
    expect(assistant.isListening()).toBe(false)
  })

  it('explains insecure contexts', async () => {
    installAudio()
    stubSocket()
    mockMicrophone(true)
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    try {
      const onError = vi.fn()
      const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
      await assistant.start()
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('HTTPS'))
      expect(assistant.isListening()).toBe(false)
    } finally {
      delete (window as unknown as Record<string, unknown>)['isSecureContext']
    }
  })

  it('errors when the microphone is denied', async () => {
    installAudio()
    stubSocket()
    mockMicrophone(false)
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    expect(onError).toHaveBeenCalledWith('Microphone access denied')
    expect(assistant.isListening()).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(getLogs().some((e) => e.level === 'error' && e.tag === 'voice')).toBe(true)
  })

  it('diagnoses the mic denial from the thrown error', async () => {
    installAudio()
    stubSocket()
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('dismissed', 'NotAllowedError')
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia } as unknown as MediaDevices,
      configurable: true,
    })
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('tap Allow'))
    expect(assistant.isListening()).toBe(false)
  })

  it('resumes the audio context on start', async () => {
    const { assistant } = await startListening()
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(1)
    assistant.stop()
  })

  it('ignores a second start while already listening', async () => {
    const { assistant } = await startListening()
    await assistant.start()
    expect(FakeWebSocket.instances).toHaveLength(1)
    assistant.stop()
  })

  it('stays stopped when stop() wins the race with a pending start', async () => {
    installAudio()
    stubSocket()
    let resolveMic!: (stream: MediaStream) => void
    const trackStop = vi.fn()
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveMic = resolve
        }),
    )
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia } as unknown as MediaDevices,
      configurable: true,
    })
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    const started = assistant.start()
    assistant.stop()
    resolveMic({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream)
    await started
    expect(assistant.isListening()).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(FakeAudioContext.instances).toHaveLength(0)
  })
})

describe('stop', () => {
  it('sends endStream and keeps reading until the server close', async () => {
    const onPhrase = vi.fn()
    const { assistant } = await startListening({ onPhrase })
    const ws = latestSocket()
    openAndAck(ws)
    assistant.stop()
    expect(assistant.isListening()).toBe(false)
    expect(ws.sent[ws.sent.length - 1]).toBe(JSON.stringify({ type: 'endStream' }))
    expect(ws.closeCode).toBeNull()
    ws.receiveText({ type: 'speechComplete', transcript: 'late phrase' })
    expect(onPhrase).toHaveBeenCalledWith('late phrase')
    ws.serverClose(1000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('still ends the stream gracefully when stopping before the ack', async () => {
    const { assistant } = await startListening()
    const ws = latestSocket()
    ws.open()
    assistant.stop()
    expect(ws.sent[ws.sent.length - 1]).toBe(JSON.stringify({ type: 'endStream' }))
    ws.serverClose(1000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('tears down without endStream when stopping before open', async () => {
    const { assistant } = await startListening()
    const ws = latestSocket()
    assistant.stop()
    expect(ws.sent).toHaveLength(0)
    expect(ws.closeCode).toBe(1000)
    expect(assistant.isListening()).toBe(false)
  })

  it('ignores server errors after stop()', async () => {
    const onError = vi.fn()
    const { assistant } = await startListening({ onError })
    const ws = latestSocket()
    openAndAck(ws)
    assistant.stop()
    ws.receiveText({ type: 'error', message: 'late' })
    ws.serverClose(1006)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('releases the mic and closes the audio context', async () => {
    const { assistant, tracks } = await startListening()
    openAndAck(latestSocket())
    expect(tracks[0].stop).not.toHaveBeenCalled()
    assistant.stop()
    latestSocket().serverClose(1000)
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledTimes(1)
  })

  it('retires draining media synchronously when start() follows stop() in the drain window', async () => {
    const { assistant, tracks } = await startListening()
    const firstCtx = FakeAudioContext.instances[0]
    const oldWs = latestSocket()
    openAndAck(oldWs)
    assistant.stop()
    // Old media is still held for the graceful drain.
    expect(tracks[0].stop).not.toHaveBeenCalled()
    await assistant.start()
    // Retired synchronously: no leaked mic track or AudioContext.
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(firstCtx.close).toHaveBeenCalledTimes(1)
    expect(oldWs.closeCode).toBe(1000)
    const newWs = latestSocket()
    expect(newWs).not.toBe(oldWs)
    expect(assistant.isListening()).toBe(true)
    // The dead socket can no longer touch the new session.
    oldWs.serverClose(1000)
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    // The new session transcribes normally.
    openAndAck(newWs)
    FakeWorkletNode.instances[1].emit(new ArrayBuffer(128))
    expect(binaryFrames(newWs)).toHaveLength(1)
    assistant.stop()
  })

  it('does not let the drain close timer tear down the restarted session', async () => {
    vi.useFakeTimers()
    const { assistant } = await startListening()
    const oldWs = latestSocket()
    openAndAck(oldWs)
    assistant.stop()
    await assistant.start()
    await vi.advanceTimersByTimeAsync(10000)
    expect(assistant.isListening()).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(oldWs.closeCode).toBe(1000)
    assistant.stop()
  })
})

describe('buildHandshake', () => {
  it('builds the realtime handshake frame', () => {
    expect(buildHandshake('test-key')).toEqual(EXPECTED_HANDSHAKE)
  })
})

describe('downsampleTo24k', () => {
  it('halves 48kHz input', () => {
    const out = downsampleTo24k(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]), 48000)
    expect([...out]).toEqual([0, 2, 4, 6])
  })

  it('passes 24kHz input through unchanged', () => {
    const input = new Float32Array([0.5, -0.25, 0.125])
    expect(downsampleTo24k(input, 24000)).toBe(input)
  })

  it('resamples odd rates to 24kHz', () => {
    const input = new Float32Array(441).fill(1)
    const out = downsampleTo24k(input, 44100)
    expect(out.length).toBe(240)
    expect([...out].every((v) => Number.isFinite(v))).toBe(true)
  })

  it('handles empty and invalid input', () => {
    expect(downsampleTo24k(new Float32Array(0), 48000).length).toBe(0)
    expect(downsampleTo24k(new Float32Array([1, 2]), 0).length).toBe(0)
  })
})

describe('encodeS16LE', () => {
  it('encodes clamped little-endian samples', () => {
    const buf = encodeS16LE(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]))
    expect(buf.byteLength).toBe(14)
    const view = new DataView(buf)
    const got = Array.from({ length: 7 }, (_, i) => view.getInt16(i * 2, true))
    expect(got).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768])
  })
})

describe('pcmWorklet.js', () => {
  interface WorkletInstance {
    port: { postMessage: (buf: ArrayBuffer) => void }
    process: (inputs: Float32Array[][]) => boolean
  }

  function loadWorklet(sampleRate: number): {
    name: string
    instance: WorkletInstance
    posted: ArrayBuffer[]
  } {
    // The worklet ships from public/ (Vite does not bundle AudioWorklet
    // modules from src/); these tests execute that exact shipped file.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'pcmWorklet.js'),
      'utf8',
    )
    const posted: ArrayBuffer[] = []
    let name = ''
    class StubProcessor {
      port = {
        postMessage: (buf: ArrayBuffer): void => {
          posted.push(buf)
        },
      }
    }
    const registerProcessor = (n: string): void => {
      name = n
    }
    const factory = new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      'sampleRate',
      `${src}\nreturn PcmWorkletProcessor;`,
    ) as (
      base: typeof StubProcessor,
      reg: typeof registerProcessor,
      rate: number,
    ) => new () => WorkletInstance
    const Ctor = factory(StubProcessor, registerProcessor, sampleRate)
    return { name, instance: new Ctor(), posted }
  }

  it('registers as pcm-worklet and stays alive', () => {
    const { name, instance } = loadWorklet(48000)
    expect(name).toBe('pcm-worklet')
    expect(instance.process([[new Float32Array(128)]])).toBe(true)
  })

  it('downsamples a 48kHz block to 24kHz s16le', () => {
    const { instance, posted } = loadWorklet(48000)
    instance.process([[new Float32Array(128).fill(0.5)]])
    expect(posted).toHaveLength(1)
    expect(posted[0].byteLength).toBe(128)
    expect(new DataView(posted[0]).getInt16(0, true)).toBe(16384)
  })

  it('passes 24kHz input through', () => {
    const { instance, posted } = loadWorklet(24000)
    instance.process([[new Float32Array(128).fill(-1)]])
    expect(posted).toHaveLength(1)
    expect(posted[0].byteLength).toBe(256)
    expect(new DataView(posted[0]).getInt16(0, true)).toBe(-32768)
  })

  it('posts silence when the input is empty', () => {
    const { instance, posted } = loadWorklet(48000)
    instance.process([])
    instance.process([[]])
    expect(posted).toHaveLength(2)
    for (const buf of posted) {
      expect(buf.byteLength).toBe(256)
      expect(new Uint8Array(buf).every((b) => b === 0)).toBe(true)
    }
  })
})
