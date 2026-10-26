import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Scanner from './Scanner'
import {
  captureFrameBurst,
  captureVideoFrame,
  reasonSpatial,
  segmentImage,
} from '../services/metaApi'
import type { SamStreamEvent } from '../services/metaApi'
import type { VoiceAssistantCallbacks } from '../services/voiceAssistant'
import type { SpatialResult } from '../types'
import { clearLogs, getLogs } from '../services/logger'

interface AssistantDouble {
  callbacks: VoiceAssistantCallbacks
  listening: boolean
  start: Mock
  stop: Mock
  isListening: () => boolean
  getContextString: Mock
  pushMemory: Mock
  clearMemory: Mock
  getMemory: Mock
}

const assistants = vi.hoisted(() => [] as AssistantDouble[])

vi.mock('../services/metaApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/metaApi')>()
  return {
    ...actual,
    captureFrameBurst: vi.fn(),
    captureVideoFrame: vi.fn(),
    reasonSpatial: vi.fn(),
    segmentImage: vi.fn(),
  }
})

vi.mock('../services/samParser', () => ({
  parseSamStream: vi.fn(async () => []),
}))

vi.mock('../services/voiceAssistant', () => {
  class MockAssistant {
    listening = false
    start = vi.fn(async (): Promise<void> => {
      this.listening = true
    })
    stop = vi.fn((): void => {
      this.listening = false
    })
    isListening = (): boolean => this.listening
    getContextString = vi.fn((): string => '')
    pushMemory = vi.fn()
    clearMemory = vi.fn()
    getMemory = vi.fn((): unknown[] => [])

    constructor(public callbacks: VoiceAssistantCallbacks) {
      assistants.push(this as unknown as AssistantDouble)
    }
  }
  return { VoiceAssistant: MockAssistant }
})

async function* emptyEvents(): AsyncGenerator<SamStreamEvent> {
  // yields no events
}

const FAKE_STREAM: MediaStream = (() => {
  const stream = new MediaStream()
  // happy-dom's MediaStream omits getTracks(); real browsers implement it.
  if (typeof stream.getTracks !== 'function') {
    stream.getTracks = () => []
  }
  return stream
})()

function mockCamera(granted: boolean, devices: { kind: string }[] = []): Mock {
  const getUserMedia = vi.fn(async (): Promise<MediaStream> => {
    if (!granted) throw new Error('denied')
    return FAKE_STREAM
  })
  const enumerateDevices = vi.fn(async (): Promise<{ kind: string }[]> => devices)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia, enumerateDevices },
    configurable: true,
  })
  return getUserMedia
}

beforeEach(() => {
  assistants.length = 0
  clearLogs()
  vi.stubEnv('VITE_META_MODEL_API_KEY', 'test-key')
  vi.mocked(captureFrameBurst).mockReset().mockResolvedValue(['data:image/jpeg;base64,AAA'])
  vi.mocked(captureVideoFrame).mockReset().mockReturnValue('data:image/jpeg;base64,AAA')
  vi.mocked(reasonSpatial).mockReset()
  vi.mocked(segmentImage).mockReset().mockReturnValue(emptyEvents())
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Scanner', () => {
  it('renders the initial viewfinder UI', () => {
    mockCamera(true)
    render(<Scanner />)
    expect(screen.getByText('[ OFF ]')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable Voice Assistant' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
    expect(screen.getByText('Clear AR View')).toBeInTheDocument()
  })

  it('switches between back and front cameras', async () => {
    const getUserMedia = mockCamera(true)
    render(<Scanner />)
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' } }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'user' } }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledTimes(3),
    )
  })

  it('clears the overlay when switching cameras', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    await screen.findByText('Screw')
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    expect(screen.queryByText('Screw')).not.toBeInTheDocument()
    expect(assistants[0].clearMemory).toHaveBeenCalledTimes(1)
  })

  it('hides the switcher when only one camera exists', async () => {
    mockCamera(true, [{ kind: 'videoinput' }])
    render(<Scanner />)
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Switch camera' })).not.toBeInTheDocument()
    })
  })

  it('keeps the switcher with multiple cameras', async () => {
    mockCamera(true, [{ kind: 'videoinput' }, { kind: 'videoinput' }, { kind: 'audioinput' }])
    render(<Scanner />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
  })

  it('surfaces camera denial as a visible error', async () => {
    mockCamera(false)
    render(<Scanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera access denied')
  })

  it('toggles voice listening through the assistant', async () => {
    mockCamera(true)
    render(<Scanner />)
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)
    expect(await screen.findByText('[ 🟢 LISTENING... ]')).toBeInTheDocument()
    expect(assistants[0].start).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('switch'))
    expect(await screen.findByText('[ OFF ]')).toBeInTheDocument()
    expect(assistants[0].stop).toHaveBeenCalledTimes(1)
  })

  it('surfaces assistant errors and switches off', async () => {
    mockCamera(true)
    render(<Scanner />)
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByText('[ 🟢 LISTENING... ]')
    act(() => {
      assistants[0].callbacks.onError('Microphone access denied')
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access denied')
    expect(screen.getByText('[ OFF ]')).toBeInTheDocument()
  })

  it('runs the phrase pipeline and anchors a callout pill', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Blend door',
      approx_x: 40,
      approx_y: 60,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show me the blend door')
    })
    expect(reasonSpatial).toHaveBeenCalledWith(
      ['data:image/jpeg;base64,AAA'],
      'show me the blend door',
      '',
    )
    expect(segmentImage).toHaveBeenCalledWith('data:image/jpeg;base64,AAA', 'Blend door', undefined)
    expect(assistants[0].pushMemory).toHaveBeenCalledWith({
      phrase: 'show me the blend door',
      label: 'Blend door',
      x: 40,
      y: 60,
    })
    const callout = await screen.findByText('Blend door')
    expect(callout).toBeInTheDocument()
  })

  it('clears overlays, callout, and memory on Clear AR View', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: 'done',
      display_mode: 'speech_and_visual',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    await screen.findByText('Screw')
    fireEvent.click(screen.getByText('Clear AR View'))
    expect(screen.queryByText('Screw')).not.toBeInTheDocument()
    expect(assistants[0].clearMemory).toHaveBeenCalledTimes(1)
  })

  it('renders the overlay canvas with the same cover geometry as the video', () => {
    mockCamera(true)
    const { container } = render(<Scanner />)
    expect(container.querySelector('video')).toHaveClass('object-cover')
    expect(container.querySelector('canvas')).toHaveClass('object-cover')
  })

  it('surfaces a missing API key instead of calling the API', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', '')
    mockCamera(true)
    render(<Scanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent('API key')
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(reasonSpatial).not.toHaveBeenCalled()
  })

  it('queues a phrase spoken while analysis is in flight', async () => {
    mockCamera(true)
    const first: SpatialResult = {
      target_label: 'Blend door',
      approx_x: 1,
      approx_y: 1,
      speech_response: null,
      display_mode: 'visual_only',
    }
    const second: SpatialResult = {
      target_label: 'Screw',
      approx_x: 2,
      approx_y: 2,
      speech_response: null,
      display_mode: 'visual_only',
    }
    let releaseFirst!: (value: SpatialResult) => void
    vi.mocked(reasonSpatial)
      .mockImplementationOnce(
        () =>
          new Promise<SpatialResult>((resolve) => {
            releaseFirst = resolve
          }),
      )
      .mockResolvedValueOnce(second)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('phrase one')
    })
    await act(async () => {
      assistants[0].callbacks.onPhrase('phrase two')
    })
    expect(reasonSpatial).toHaveBeenCalledTimes(1)
    await act(async () => {
      releaseFirst(first)
    })
    expect(reasonSpatial).toHaveBeenCalledTimes(2)
    expect(vi.mocked(reasonSpatial).mock.calls[1][1]).toBe('phrase two')
    expect(await screen.findByText('Screw')).toBeInTheDocument()
  })

  it('sends the burst to reasoning and the latest frame to segmentation', async () => {
    mockCamera(true)
    vi.mocked(captureFrameBurst).mockResolvedValue(['f1', 'f2', 'f3'])
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 5,
      approx_y: 5,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    expect(reasonSpatial).toHaveBeenCalledWith(['f1', 'f2', 'f3'], 'go', '')
    expect(segmentImage).toHaveBeenCalledWith('f3', 'Screw', undefined)
  })

  it('converts approx coords to media-pixel point prompts', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 50,
      approx_y: 25,
      speech_response: null,
      display_mode: 'visual_only',
    })
    const { container } = render(<Scanner />)
    const video = container.querySelector('video')
    if (!video) throw new Error('missing video element')
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true })
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    expect(segmentImage).toHaveBeenCalledWith('data:image/jpeg;base64,AAA', 'Screw', {
      x: 320,
      y: 120,
      width: 640,
      height: 480,
    })
  })

  it('runs typed queries through the same pipeline', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Blend door',
      approx_x: 40,
      approx_y: 60,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'typed query' } })
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText('Blend door')).toBeInTheDocument()
    expect(reasonSpatial).toHaveBeenCalledWith(['data:image/jpeg;base64,AAA'], 'typed query', '')
  })

  it('re-segments on a cadence while the overlay is active', async () => {
    vi.useFakeTimers()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      render(<Scanner />)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100)
      })
      expect(segmentImage).toHaveBeenCalledTimes(2)
      expect(vi.mocked(segmentImage).mock.calls[1]).toEqual([
        'data:image/jpeg;base64,AAA',
        'Screw',
        undefined,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops refreshing after Clear AR View', async () => {
    vi.useFakeTimers()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      render(<Scanner />)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100)
      })
      expect(segmentImage).toHaveBeenCalledTimes(2)
      fireEvent.click(screen.getByText('Clear AR View'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(segmentImage).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops refreshing when voice is toggled off', async () => {
    vi.useFakeTimers()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      render(<Scanner />)
      await act(async () => {
        fireEvent.click(screen.getByRole('switch'))
      })
      expect(screen.getByText('[ 🟢 LISTENING... ]')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        fireEvent.click(screen.getByRole('switch'))
      })
      expect(screen.getByText('[ OFF ]')).toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses refreshing while a query is in flight', async () => {
    vi.useFakeTimers()
    try {
      mockCamera(true)
      const first: SpatialResult = {
        target_label: 'Blend door',
        approx_x: 1,
        approx_y: 1,
        speech_response: null,
        display_mode: 'visual_only',
      }
      const second: SpatialResult = {
        target_label: 'Screw',
        approx_x: 2,
        approx_y: 2,
        speech_response: null,
        display_mode: 'visual_only',
      }
      let releaseSecond!: (value: SpatialResult) => void
      vi.mocked(reasonSpatial)
        .mockResolvedValueOnce(first)
        .mockImplementationOnce(
          () =>
            new Promise<SpatialResult>((resolve) => {
              releaseSecond = resolve
            }),
        )
      render(<Scanner />)
      await act(async () => {
        assistants[0].callbacks.onPhrase('phrase one')
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        assistants[0].callbacks.onPhrase('phrase two')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        releaseSecond(second)
      })
      expect(segmentImage).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('explains insecure contexts instead of a generic denial', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    try {
      mockCamera(true)
      render(<Scanner />)
      expect(await screen.findByRole('alert')).toHaveTextContent('HTTPS')
    } finally {
      delete (window as unknown as Record<string, unknown>)['isSecureContext']
    }
  })

  it('explains blocked camera permissions', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'permissions')
    Object.defineProperty(navigator, 'permissions', {
      value: { query: vi.fn(async () => ({ state: 'denied' })) },
      configurable: true,
    })
    try {
      mockCamera(true)
      render(<Scanner />)
      expect(await screen.findByRole('alert')).toHaveTextContent('site settings')
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'permissions', original)
      } else {
        delete (navigator as unknown as Record<string, unknown>)['permissions']
      }
    }
  })

  it('logs camera failures for diagnosis', async () => {
    mockCamera(false)
    render(<Scanner />)
    await screen.findByRole('alert')
    const errors = getLogs().filter((e) => e.level === 'error' && e.tag === 'camera')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('all camera attempts failed')
  })

  it('logs phrase pipeline stages', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Blend door',
      approx_x: 40,
      approx_y: 60,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show me the blend door')
    })
    await screen.findByText('Blend door')
    expect(getLogs().some((e) => e.tag === 'phrase' && e.message.includes('blend door'))).toBe(
      true,
    )
    expect(
      getLogs().some((e) => e.tag === 'reason' && e.message.includes('"Blend door" @ (40,60)')),
    ).toBe(true)
  })

  it('recovers to listening after a pipeline failure', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockRejectedValue(new Error('network down'))
    render(<Scanner />)
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByText('[ 🟢 LISTENING... ]')
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('[ ⚠ ERROR ]')).toBeInTheDocument()
  })
})
