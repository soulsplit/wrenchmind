import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpeechService, splitSpeechChunks } from './speechOutput'
import { clearLogs, getLogs } from './logger'

class FakeVoice {
  default = false

  constructor(
    public name: string,
    public lang: string,
  ) {}
}

class FakeUtterance {
  voice: FakeVoice | null = null
  rate = 1
  pitch = 1
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null

  constructor(public text: string) {}
}

class FakeSpeechSynthesis {
  voices: FakeVoice[] = []
  spoken: FakeUtterance[] = []
  cancels = 0
  onvoiceschanged: (() => void) | null = null

  getVoices(): FakeVoice[] {
    return this.voices
  }

  speak(utterance: FakeUtterance): void {
    this.spoken.push(utterance)
  }

  cancel(): void {
    this.cancels += 1
  }

  endLast(): void {
    this.spoken[this.spoken.length - 1]?.onend?.()
  }

  failLast(error = 'synthesis-failed'): void {
    this.spoken[this.spoken.length - 1]?.onerror?.({ error })
  }
}

let synth: FakeSpeechSynthesis

function installSynth(voices: FakeVoice[] = []): void {
  synth = new FakeSpeechSynthesis()
  synth.voices = voices
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: FakeUtterance,
    configurable: true,
  })
}

beforeEach(() => {
  clearLogs()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['speechSynthesis']
  delete (window as unknown as Record<string, unknown>)['SpeechSynthesisUtterance']
  vi.useRealTimers()
})

describe('splitSpeechChunks', () => {
  it('returns no chunks for blank text', () => {
    expect(splitSpeechChunks('   ')).toEqual([])
  })

  it('keeps short text in one chunk', () => {
    expect(splitSpeechChunks('Done.')).toEqual(['Done.'])
  })

  it('splits on sentence boundaries under the target', () => {
    const chunks = splitSpeechChunks('First sentence here. Second one follows now.', 30)
    expect(chunks).toEqual(['First sentence here.', 'Second one follows now.'])
  })

  it('merges short sentences up to the target', () => {
    expect(splitSpeechChunks('One. Two. Three.', 30)).toEqual(['One. Two. Three.'])
  })

  it('hard-splits a single overlong sentence', () => {
    const chunks = splitSpeechChunks('abcdefghij', 4)
    expect(chunks).toEqual(['abcd', 'efgh', 'ij'])
  })
})

describe('SpeechService', () => {
  // ~124-char sentences: each fits one chunk, any pair exceeds the target.
  const seg = (word: string): string => `${word} `.repeat(60) + 'end.'
  // Flush microtask chains (voice resolution + utterance start).
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('resolves silently when speechSynthesis is absent', async () => {
    const service = new SpeechService()
    await expect(service.speakText('hello')).resolves.toBeUndefined()
    expect(service.isSpeaking()).toBe(false)
    expect(await service.getAvailableVoices()).toEqual([])
  })

  it('resolves without speaking on blank text', async () => {
    installSynth()
    const service = new SpeechService()
    await service.speakText('  ')
    expect(synth.spoken).toHaveLength(0)
  })

  it('speaks one chunk and resolves on end', async () => {
    installSynth([new FakeVoice('Default', 'en-US')])
    const service = new SpeechService()
    const done = service.speakText('Done.')
    expect(service.isSpeaking()).toBe(true)
    await flush()
    expect(synth.spoken).toHaveLength(1)
    expect(synth.spoken[0].text).toBe('Done.')
    synth.endLast()
    await done
    expect(service.isSpeaking()).toBe(false)
  })

  it('applies the selected voice, rate, and pitch', async () => {
    const neural = new FakeVoice('Google US English Neural', 'en-US')
    installSynth([new FakeVoice('Plain', 'en-US'), neural])
    const service = new SpeechService({ rate: 1.1, pitch: 0.9 })
    const done = service.speakText('Hi.')
    await flush()
    expect(synth.spoken[0].voice).toBe(neural)
    expect(synth.spoken[0].rate).toBe(1.1)
    expect(synth.spoken[0].pitch).toBe(0.9)
    synth.endLast()
    await done
  })

  it('prefers US English, then any English, then default', async () => {
    const us = new FakeVoice('Plain US', 'en-US')
    const uk = new FakeVoice('Plain UK', 'en-GB')
    installSynth([uk, us])
    const pickedUs = new SpeechService()
    void pickedUs.speakText('x')
    await flush()
    expect(synth.spoken[0].voice).toBe(us)
    synth.endLast()

    installSynth([new FakeVoice('French', 'fr-FR'), uk])
    const pickedEn = new SpeechService()
    void pickedEn.speakText('x')
    await flush()
    expect(synth.spoken[synth.spoken.length - 1]?.voice).toBe(uk)
  })

  it('waits for async voice loading via voiceschanged', async () => {
    installSynth([])
    const service = new SpeechService()
    const done = service.speakText('Hi.')
    await flush()
    expect(synth.spoken).toHaveLength(0)
    const late = new FakeVoice('Late Voice', 'en-US')
    synth.voices = [late]
    synth.onvoiceschanged?.()
    await flush()
    expect(synth.spoken).toHaveLength(1)
    expect(synth.spoken[0].voice).toBe(late)
    synth.endLast()
    await done
  })

  it('falls back after the voice timeout', async () => {
    vi.useFakeTimers()
    installSynth([])
    const service = new SpeechService({ voiceTimeoutMs: 500 })
    const done = service.speakText('Hi.')
    await vi.advanceTimersByTimeAsync(600)
    expect(synth.spoken).toHaveLength(1)
    expect(synth.spoken[0].voice).toBeNull()
    synth.endLast()
    await done
  })

  it('chains chunks in order and resolves after the last', async () => {
    installSynth([new FakeVoice('V', 'en-US')])
    const service = new SpeechService()
    const done = service.speakText(`${seg('a')} ${seg('b')} ${seg('c')}`)
    await flush()
    expect(synth.spoken.map((u) => u.text)).toEqual([seg('a')])
    synth.endLast()
    await flush()
    synth.endLast()
    await flush()
    expect(synth.spoken.map((u) => u.text)).toEqual([seg('a'), seg('b'), seg('c')])
    synth.endLast()
    await done
  })

  it('continues past a failed chunk', async () => {
    installSynth([new FakeVoice('V', 'en-US')])
    const service = new SpeechService()
    const done = service.speakText(`${seg('a')} ${seg('b')}`)
    await flush()
    synth.failLast('interrupted')
    await flush()
    expect(synth.spoken).toHaveLength(2)
    expect(getLogs().some((e) => e.level === 'warn')).toBe(true)
    synth.endLast()
    await done
  })

  it('settles a cancelled speak silently and drops the queue', async () => {
    installSynth([new FakeVoice('V', 'en-US')])
    const service = new SpeechService()
    const done = service.speakText(`${seg('a')} ${seg('b')}`)
    await flush()
    service.cancelSpeech()
    await expect(done).resolves.toBeUndefined()
    // One cancel from speakText preemption, one explicit.
    expect(synth.cancels).toBe(2)
    expect(service.isSpeaking()).toBe(false)
    // Stale end events from the cancelled utterance speak nothing further.
    synth.endLast()
    await flush()
    expect(synth.spoken).toHaveLength(1)
  })

  it('preempts older speech with newer speech', async () => {
    installSynth([new FakeVoice('V', 'en-US')])
    const service = new SpeechService()
    const first = service.speakText('First long paragraph here.')
    await flush()
    const second = service.speakText('Second.')
    await flush()
    await expect(first).resolves.toBeUndefined()
    expect(synth.spoken[synth.spoken.length - 1]?.text).toBe('Second.')
    synth.endLast()
    await second
  })

  it('logs the selected voice for LogPanel diagnosis', async () => {
    installSynth([new FakeVoice('Nice Voice', 'en-US')])
    const service = new SpeechService()
    const done = service.speakText('Hi.')
    await flush()
    synth.endLast()
    await done
    expect(getLogs().some((e) => e.message.includes('Nice Voice'))).toBe(true)
  })

  it('lists available voices for future UI', async () => {
    installSynth([new FakeVoice('A', 'en-US'), new FakeVoice('B', 'de-DE')])
    const service = new SpeechService()
    await expect(service.getAvailableVoices()).resolves.toEqual([
      { name: 'A', lang: 'en-US' },
      { name: 'B', lang: 'de-DE' },
    ])
  })
})
