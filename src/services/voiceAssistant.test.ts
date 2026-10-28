import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceAssistant } from './voiceAssistant'
import { clearLogs, getLogs } from './logger'

interface FakeResultEvent {
  results: { isFinal: boolean; 0: { transcript: string } }[]
}

class FakeRecognition {
  static instances: FakeRecognition[] = []
  static throwOnStart = false
  continuous = false
  interimResults = true
  lang = ''
  onresult: ((event: FakeResultEvent) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  started = false

  constructor() {
    FakeRecognition.instances.push(this)
  }

  start(): void {
    if (FakeRecognition.throwOnStart) throw new Error('start blocked')
    this.started = true
  }

  stop(): void {
    this.started = false
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'suspended' | 'running' = 'suspended'
  resume = vi.fn(async (): Promise<void> => {
    this.state = 'running'
  })
  close = vi.fn(async (): Promise<void> => undefined)

  constructor() {
    FakeAudioContext.instances.push(this)
  }
}

function installRecognition(): void {
  ;(window as unknown as Record<string, unknown>)['SpeechRecognition'] = FakeRecognition
}

function uninstallRecognition(): void {
  const w = window as unknown as Record<string, unknown>
  delete w['SpeechRecognition']
  delete w['webkitSpeechRecognition']
}

function mockMicrophone(granted: boolean): void {
  const getUserMedia = vi.fn(async () => {
    if (!granted) throw new Error('denied')
    return { getTracks: () => [] } as unknown as MediaStream
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia } as unknown as MediaDevices,
    configurable: true,
  })
}

function latestInstance(): FakeRecognition {
  return FakeRecognition.instances[FakeRecognition.instances.length - 1]
}

beforeEach(() => {
  FakeRecognition.instances = []
  FakeRecognition.throwOnStart = false
  FakeAudioContext.instances = []
  clearLogs()
})

afterEach(() => {
  uninstallRecognition()
  vi.useRealTimers()
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

describe('start', () => {
  it('errors when speech recognition is unsupported', async () => {
    uninstallRecognition()
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    expect(onError).toHaveBeenCalledWith('Speech recognition not supported on this device')
    expect(assistant.isListening()).toBe(false)
  })

  it('explains insecure contexts', async () => {
    installRecognition()
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
    installRecognition()
    mockMicrophone(false)
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    expect(onError).toHaveBeenCalledWith('Microphone access denied')
    expect(assistant.isListening()).toBe(false)
    expect(getLogs().some((e) => e.level === 'error' && e.tag === 'voice')).toBe(true)
  })

  it('configures continuous recognition on success', async () => {
    installRecognition()
    mockMicrophone(true)
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
    await assistant.start()
    expect(assistant.isListening()).toBe(true)
    expect(FakeRecognition.instances).toHaveLength(1)
    expect(latestInstance().continuous).toBe(true)
    expect(latestInstance().interimResults).toBe(false)
    expect(latestInstance().lang).toBe('en-US')
    assistant.stop()
  })
})

describe('audio context', () => {
  it('resumes on start and closes on stop', async () => {
    installRecognition()
    mockMicrophone(true)
    Object.defineProperty(window, 'AudioContext', {
      value: FakeAudioContext,
      configurable: true,
    })
    try {
      const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
      await assistant.start()
      expect(FakeAudioContext.instances).toHaveLength(1)
      expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(1)
      assistant.stop()
      expect(FakeAudioContext.instances[0].close).toHaveBeenCalledTimes(1)
    } finally {
      delete (window as unknown as Record<string, unknown>)['AudioContext']
    }
  })
})

describe('results and errors', () => {
  it('emits trimmed final phrases and ignores interim results', async () => {
    installRecognition()
    mockMicrophone(true)
    const onPhrase = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase, onError: () => undefined })
    await assistant.start()
    latestInstance().onresult?.({ results: [{ isFinal: false, 0: { transcript: 'half' } }] })
    expect(onPhrase).not.toHaveBeenCalled()
    latestInstance().onresult?.({ results: [{ isFinal: true, 0: { transcript: '  show screws ' } }] })
    expect(onPhrase).toHaveBeenCalledWith('show screws')
    assistant.stop()
  })

  it('tolerates stop errors from the recognizer', async () => {
    installRecognition()
    mockMicrophone(true)
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
    await assistant.start()
    latestInstance().stop = () => {
      throw new Error('already stopped')
    }
    expect(() => assistant.stop()).not.toThrow()
    expect(assistant.isListening()).toBe(false)
  })

  it('schedules a restart when recognition start throws', async () => {
    vi.useFakeTimers()
    installRecognition()
    mockMicrophone(true)
    FakeRecognition.throwOnStart = true
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
    await assistant.start()
    expect(FakeRecognition.instances).toHaveLength(1)
    FakeRecognition.throwOnStart = false
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeRecognition.instances).toHaveLength(2)
    assistant.stop()
  })

  it('cancels a pending restart when a result arrives', async () => {
    vi.useFakeTimers()
    installRecognition()
    mockMicrophone(true)
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
    await assistant.start()
    latestInstance().onend?.()
    latestInstance().onresult?.({ results: [{ isFinal: true, 0: { transcript: 'go' } }] })
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeRecognition.instances).toHaveLength(1)
    assistant.stop()
  })

  it('reports when recognition disappears mid-restart', async () => {
    vi.useFakeTimers()
    installRecognition()
    mockMicrophone(true)
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    latestInstance().onend?.()
    uninstallRecognition()
    await vi.advanceTimersByTimeAsync(500)
    expect(onError).toHaveBeenCalledWith('Speech recognition not supported on this device')
    expect(assistant.isListening()).toBe(false)
  })

  it('stops without retry on microphone permission errors', async () => {
    installRecognition()
    mockMicrophone(true)
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    latestInstance().onerror?.({ error: 'not-allowed' })
    expect(onError).toHaveBeenCalledWith('Microphone access denied')
    expect(assistant.isListening()).toBe(false)
    expect(FakeRecognition.instances).toHaveLength(1)
  })
})

describe('restarts', () => {
  it('restarts with backoff after onend and stops restarting after stop()', async () => {
    vi.useFakeTimers()
    installRecognition()
    mockMicrophone(true)
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
    await assistant.start()
    latestInstance().onend?.()
    expect(FakeRecognition.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeRecognition.instances).toHaveLength(2)
    assistant.stop()
    latestInstance().onend?.()
    await vi.advanceTimersByTimeAsync(60000)
    expect(FakeRecognition.instances).toHaveLength(2)
  })

  it('ignores a second start while already listening', async () => {
    installRecognition()
    mockMicrophone(true)
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
    await assistant.start()
    await assistant.start()
    expect(FakeRecognition.instances).toHaveLength(1)
    assistant.stop()
  })

  it('stays stopped when stop() wins the race with a pending start', async () => {
    installRecognition()
    let resolveMic!: (stream: MediaStream) => void
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => {
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
    resolveMic({ getTracks: () => [] } as unknown as MediaStream)
    await started
    expect(assistant.isListening()).toBe(false)
    expect(FakeRecognition.instances).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
  })

  it('schedules a single restart when onerror and onend fire together', async () => {
    vi.useFakeTimers()
    installRecognition()
    mockMicrophone(true)
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError: () => undefined })
    await assistant.start()
    latestInstance().onerror?.({ error: 'network' })
    latestInstance().onend?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeRecognition.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60000)
    expect(FakeRecognition.instances).toHaveLength(2)
    assistant.stop()
  })

  it('caps restarts and reports when the cap is reached', async () => {
    vi.useFakeTimers()
    installRecognition()
    mockMicrophone(true)
    const onError = vi.fn()
    const assistant = new VoiceAssistant({ onPhrase: () => undefined, onError })
    await assistant.start()
    for (let i = 0; i < 9; i++) {
      latestInstance().onend?.()
      await vi.advanceTimersByTimeAsync(20000)
    }
    expect(onError).toHaveBeenCalledWith('Voice assistant stopped after repeated errors')
    expect(assistant.isListening()).toBe(false)
    // 1 initial + 8 restarts; the 9th end hits the cap.
    expect(FakeRecognition.instances).toHaveLength(9)
  })
})
