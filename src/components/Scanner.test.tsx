import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import Scanner from './Scanner'
import { fetchWithTimeout } from '../services/http'
import {
  approxToStage,
  calloutStyle,
  clampZoomPan,
  identifyWithContext,
  overlayUiScale,
  pinchZoom,
  stageBoxToMedia,
  tapToMedia,
  zoomAt,
} from '../services/feedStage'
import {
  captureFrameBurst,
  captureVideoFrame,
  cropRegion,
  extractLabelText,
  identifyComponent,
  reasonSpatial,
  segmentImage,
} from '../services/metaApi'
import { parseSamStream } from '../services/samParser'
import { decodePhotoFile } from '../services/photoUpload'
import { fetchGuidance } from '../services/guidanceApi'
import { searchGuides } from '../services/ifixitApi'
import {
  cancelSpeech,
  getAvailableVoices,
  getPreferredVoiceName,
  isSpeaking,
  playAckBlip,
  setPreferredVoiceName,
  speakText,
  warmUpSpeechVoices,
} from '../services/speechOutput'
import { useKeyboardShift } from '../hooks/useKeyboardShift'
import { useDesktopLayout } from '../hooks/useDesktopLayout'
import type { SamStreamEvent } from '../services/metaApi'
import type { VoiceAssistantCallbacks } from '../services/voiceAssistant'
import type { GuidanceResult, MaskRecord, SpatialResult } from '../types'
import { validGuidanceFixture } from '../test/guidanceFixtures'
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

vi.mock('../services/ifixitApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ifixitApi')>()
  return { ...actual, searchGuides: vi.fn() }
})

vi.mock('../services/metaApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/metaApi')>()
  return {
    ...actual,
    captureFrameBurst: vi.fn(),
    captureVideoFrame: vi.fn(),
    cropRegion: vi.fn(),
    extractLabelText: vi.fn(),
    identifyComponent: vi.fn(),
    reasonSpatial: vi.fn(),
    segmentImage: vi.fn(),
  }
})

vi.mock('../services/samParser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/samParser')>()
  return { ...actual, parseSamStream: vi.fn(async () => []) }
})

vi.mock('../services/guidanceApi', () => ({
  fetchGuidance: vi.fn(),
}))

vi.mock('../services/photoUpload', () => ({
  decodePhotoFile: vi.fn(),
}))

vi.mock('../services/speechOutput', () => ({
  speakText: vi.fn(),
  cancelSpeech: vi.fn(),
  isSpeaking: vi.fn(),
  getAvailableVoices: vi.fn(),
  getPreferredVoiceName: vi.fn(),
  setPreferredVoiceName: vi.fn(),
  warmUpSpeechVoices: vi.fn(),
  playAckBlip: vi.fn(),
}))

vi.mock('../hooks/useKeyboardShift', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useKeyboardShift')>()
  return {
    ...actual,
    useKeyboardShift: vi.fn(() => 0),
  }
})

vi.mock('../hooks/useDesktopLayout', () => ({
  useDesktopLayout: vi.fn(() => false),
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
  // Phone-like default: the track reports a rear facing mode.
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ facingMode: 'environment' }),
  } as unknown as MediaStreamTrack
  stream.getVideoTracks = () => [track]
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

function openOverflow(): void {
  // Idempotent: the menu closes after every item press, so only toggle it
  // open when a menu-only item (Voice mode) is not already visible.
  if (screen.queryByRole('switch', { name: 'Voice mode' })) return
  fireEvent.click(screen.getByRole('button', { name: 'More options' }))
}

/** Press the top-bar Freeze frame quick toggle (lives outside the overflow menu). */
function pressFreezeFrame(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Freeze frame' }))
}

async function enableVoiceMode(): Promise<void> {
  openOverflow()
  fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
  // handleToggle awaits assistant.start() before setting voiceOn: flush the
  // toggle continuation and its re-render so speech is gated on afterwards.
  await act(async () => {})
}

/** Zoom in via wheel gestures (1.2x per tick, no tap suppression). */
function wheelZoomIn(times = 1): void {
  const stage = screen.getByTestId('zoom-stage')
  for (let i = 0; i < times; i++) {
    fireEvent.wheel(stage, { deltaY: -100, clientX: 100, clientY: 100 })
  }
}

function torchStream(applyImpl?: () => Promise<void>): {
  stream: MediaStream
  applyConstraints: Mock
} {
  const applyConstraints = vi.fn(applyImpl ?? (async () => {}))
  const stream = new MediaStream()
  if (typeof stream.getTracks !== 'function') {
    stream.getTracks = () => []
  }
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ facingMode: 'environment' }),
    getCapabilities: () => ({ torch: true }),
    applyConstraints,
  } as unknown as MediaStreamTrack
  stream.getVideoTracks = () => [track]
  return { stream, applyConstraints }
}

function mockCameraStream(stream: MediaStream): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => stream), enumerateDevices: vi.fn(async () => []) },
    configurable: true,
  })
}

/** Fresh stream whose getTracks() returns a stoppable fake track (FAKE_STREAM has none). */
function trackedStream(): { stream: MediaStream; stop: Mock } {
  const stop = vi.fn()
  const stream = new MediaStream()
  const track = {
    stop,
    getSettings: () => ({ facingMode: 'environment' }),
  } as unknown as MediaStreamTrack
  stream.getTracks = () => [track]
  stream.getVideoTracks = () => [track]
  return { stream, stop }
}

function mockCameraWithStream(stream: MediaStream): Mock {
  const getUserMedia = vi.fn(async (): Promise<MediaStream> => stream)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
    configurable: true,
  })
  return getUserMedia
}

function captureDownload(): { blob: Blob | null } {
  const captured: { blob: Blob | null } = { blob: null }
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn((blob: Blob) => {
      captured.blob = blob
      return 'blob:fake'
    }),
    configurable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return captured
}

function mockCanvas2d(): () => void {
  const ctx = new Proxy(
    { marker: 'ctx', drawImage: vi.fn(), measureText: () => ({ width: 10 }) },
    {
      get: (target, prop) => {
        if (prop === 'createImageData') {
          return (w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
            width: w,
            height: h,
          })
        }
        const value = (target as Record<PropertyKey, unknown>)[prop]
        return value ?? (() => undefined)
      },
      set: () => true,
    },
  )
  const ctxSpy = vi
    .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  return () => ctxSpy.mockRestore()
}

function getVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video')
  if (!video) throw new Error('missing video element')
  return video
}

function setVideoDims(container: HTMLElement, w = 640, h = 480): void {
  const video = getVideo(container)
  Object.defineProperty(video, 'videoWidth', { value: w, configurable: true })
  Object.defineProperty(video, 'videoHeight', { value: h, configurable: true })
}

function mockMediaControls(): {
  play: Mock
  pause: Mock
  restore: () => void
} {
  const proto = window.HTMLVideoElement.prototype as unknown as Record<string, unknown>
  const originalPlay = Object.getOwnPropertyDescriptor(proto, 'play')
  const originalPause = Object.getOwnPropertyDescriptor(proto, 'pause')
  const play = vi.fn(async () => {})
  const pause = vi.fn(() => {})
  Object.defineProperty(proto, 'play', { value: play, configurable: true, writable: true })
  Object.defineProperty(proto, 'pause', { value: pause, configurable: true, writable: true })
  return {
    play,
    pause,
    restore: () => {
      if (originalPlay) {
        Object.defineProperty(proto, 'play', originalPlay)
      } else {
        delete proto['play']
      }
      if (originalPause) {
        Object.defineProperty(proto, 'pause', originalPause)
      } else {
        delete proto['pause']
      }
    },
  }
}

beforeEach(() => {
  assistants.length = 0
  clearLogs()
  vi.stubEnv('VITE_META_MODEL_API_KEY', 'test-key')
  vi.mocked(captureFrameBurst).mockReset().mockResolvedValue(['data:image/jpeg;base64,AAA'])
  vi.mocked(captureVideoFrame).mockReset().mockReturnValue('data:image/jpeg;base64,AAA')
  vi.mocked(cropRegion).mockReset().mockReturnValue('data:image/jpeg;base64,CROP')
  vi.mocked(identifyComponent).mockReset().mockResolvedValue('M6 hex bolt')
  vi.mocked(parseSamStream).mockReset().mockResolvedValue([])
  vi.mocked(reasonSpatial).mockReset()
  vi.mocked(extractLabelText).mockReset().mockResolvedValue([])
  vi.mocked(segmentImage).mockReset().mockReturnValue(emptyEvents())
  // Default mirrors the stub: guidance unavailable, AR pipeline unaffected.
  vi.mocked(fetchGuidance).mockReset().mockRejectedValue(new Error('not implemented'))
  vi.mocked(searchGuides).mockReset().mockResolvedValue([])
  vi.mocked(speakText).mockReset().mockResolvedValue(undefined)
  vi.mocked(cancelSpeech).mockReset()
  vi.mocked(decodePhotoFile).mockReset()
  vi.mocked(isSpeaking).mockReset().mockReturnValue(false)
  vi.mocked(getAvailableVoices).mockReset().mockResolvedValue([])
  vi.mocked(getPreferredVoiceName).mockReset().mockReturnValue(null)
  vi.mocked(setPreferredVoiceName).mockReset()
  vi.mocked(warmUpSpeechVoices).mockReset()
  vi.mocked(playAckBlip).mockReset()
  vi.mocked(useKeyboardShift).mockReset().mockReturnValue(0)
  vi.mocked(useDesktopLayout).mockReset().mockReturnValue(false)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Scanner', () => {
  it('renders the initial viewfinder UI', async () => {
    mockCamera(true)
    render(<Scanner />)
    expect(screen.getByText('WRENCHMIND')).toBeInTheDocument()
    expect(screen.queryByText('[ OFF ]')).not.toBeInTheDocument()
    expect(await screen.findByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('REAR CAMERA')).toBeInTheDocument()
    expect(screen.getByLabelText('Query text')).toBeInTheDocument()
    openOverflow()
    expect(screen.getByRole('switch', { name: 'Voice mode' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
    expect(screen.getByText('Clear AR View')).toBeInTheDocument()
  })

  it('switches between back and front cameras', async () => {
    const getUserMedia = mockCamera(true)
    render(<Scanner />)
    openOverflow()
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith({
        video: {
          facingMode: 'environment',
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith({
        video: {
          facingMode: 'user',
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      }),
    )
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledTimes(3),
    )
  })

  it('leaves the mobile rear feed unmirrored', () => {
    mockCamera(true)
    render(<Scanner />)
    expect(screen.getByLabelText('Live camera feed')).not.toHaveClass('-scale-x-100')
  })

  it('mirrors the mobile front camera', async () => {
    const stream = new MediaStream()
    if (typeof stream.getTracks !== 'function') {
      stream.getTracks = () => []
    }
    const track = {
      stop: vi.fn(),
      getSettings: () => ({ facingMode: 'user' }),
    } as unknown as MediaStreamTrack
    stream.getVideoTracks = () => [track]
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(async (): Promise<MediaStream> => stream),
        enumerateDevices: vi.fn(async (): Promise<{ kind: string }[]> => []),
      },
      configurable: true,
    })
    render(<Scanner />)
    await waitFor(() =>
      expect(screen.getByLabelText('Live camera feed')).toHaveClass('-scale-x-100'),
    )
  })

  it('logs the negotiated capture resolution', async () => {
    const stream = new MediaStream()
    if (typeof stream.getTracks !== 'function') {
      stream.getTracks = () => []
    }
    const track = {
      stop: vi.fn(),
      getSettings: () => ({ facingMode: 'environment', width: 3840, height: 2160 }),
    } as unknown as MediaStreamTrack
    stream.getVideoTracks = () => [track]
    mockCameraStream(stream)
    render(<Scanner />)
    expect(await screen.findByText('LIVE')).toBeInTheDocument()
    await waitFor(() =>
      expect(getLogs().some((e) => e.message.includes('negotiated 3840x2160'))).toBe(true),
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
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    expect(screen.queryByText('Screw')).not.toBeInTheDocument()
    // Scene-only flip: the job's memory survives the switch.
    expect(assistants[0].clearMemory).not.toHaveBeenCalled()
  })

  it('hides the switcher when only one camera exists', async () => {
    mockCamera(true, [{ kind: 'videoinput' }])
    render(<Scanner />)
    openOverflow()
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Switch camera' })).not.toBeInTheDocument()
    })
  })

  it('keeps the switcher with multiple cameras', async () => {
    mockCamera(true, [{ kind: 'videoinput' }, { kind: 'videoinput' }, { kind: 'audioinput' }])
    render(<Scanner />)
    openOverflow()
    // No state change to wait on when cameras > 1: wait for the enumeration
    // call itself, then prove the switcher survived it.
    const enumerateDevices = vi.mocked(navigator.mediaDevices.enumerateDevices)
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
  })

  it('reflects the camera facing in the header badge', async () => {
    // Phone-like: each opened track reports the facing that was requested.
    const streamFor = (facingMode: string): MediaStream => {
      const stream = new MediaStream()
      if (typeof stream.getTracks !== 'function') {
        stream.getTracks = () => []
      }
      const track = {
        stop: vi.fn(),
        getSettings: () => ({ facingMode }),
      } as unknown as MediaStreamTrack
      stream.getVideoTracks = () => [track]
      return stream
    }
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const mode = (constraints.video as MediaTrackConstraints | undefined)?.facingMode
      return streamFor(typeof mode === 'string' ? mode : 'environment')
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
      configurable: true,
    })
    render(<Scanner />)
    expect(await screen.findByText('REAR CAMERA')).toBeInTheDocument()
    openOverflow()
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith({
        video: {
          facingMode: 'environment',
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    expect(await screen.findByText('FRONT CAMERA')).toBeInTheDocument()
    expect(screen.queryByText('REAR CAMERA')).not.toBeInTheDocument()
  })

  it('surfaces camera denial as a visible error', async () => {
    mockCamera(false)
    render(<Scanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera access denied')
  })

  it('retries camera acquisition from the error toast', async () => {
    const gum = mockCamera(false)
    render(<Scanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera access denied')
    const attempts = gum.mock.calls.length
    expect(attempts).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Try camera again' }))
    await waitFor(() => expect(gum.mock.calls.length).toBeGreaterThan(attempts))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('names the real cause when getUserMedia rejects with a named error', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('busy', 'NotReadableError')
        }),
        enumerateDevices: vi.fn(async () => []),
      },
      configurable: true,
    })
    render(<Scanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera is busy')
  })

  it('dims the LIVE badge when the camera never starts', async () => {
    mockCamera(false)
    render(<Scanner />)
    expect(await screen.findByText('NO FEED')).toBeInTheDocument()
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
  })

  it('labels a desktop-style camera with no facing mode as CAMERA', async () => {
    const track = { stop: vi.fn(), getSettings: () => ({}) } as unknown as MediaStreamTrack
    const stream = new MediaStream()
    if (typeof stream.getTracks !== 'function') {
      stream.getTracks = () => []
    }
    stream.getVideoTracks = () => [track]
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn(async () => stream),
        enumerateDevices: vi.fn(async () => []),
      },
      configurable: true,
    })
    render(<Scanner />)
    expect(await screen.findByText('CAMERA')).toBeInTheDocument()
    expect(screen.queryByText('REAR CAMERA')).not.toBeInTheDocument()
  })

  it('toggles voice listening through the assistant', async () => {
    mockCamera(true)
    render(<Scanner />)
    openOverflow()
    const toggle = screen.getByRole('switch', { name: 'Voice mode' })
    fireEvent.click(toggle)
    expect(await screen.findByText('Listening')).toBeInTheDocument()
    expect(assistants[0].start).toHaveBeenCalledTimes(1)
    openOverflow()
    fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
    expect(screen.queryByText('[ OFF ]')).not.toBeInTheDocument()
    openOverflow()
    expect(screen.getByRole('switch', { name: 'Voice mode' })).toHaveAttribute('aria-checked', 'false')
    expect(assistants[0].stop).toHaveBeenCalledTimes(1)
  })

  it('surfaces assistant errors and switches off', async () => {
    mockCamera(true)
    render(<Scanner />)
    openOverflow()
    fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
    await screen.findByText('Listening')
    act(() => {
      assistants[0].callbacks.onError('Microphone access denied')
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access denied')
    expect(screen.queryByText('[ OFF ]')).not.toBeInTheDocument()
    openOverflow()
    expect(screen.getByRole('switch', { name: 'Voice mode' })).toHaveAttribute('aria-checked', 'false')
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
    openOverflow()
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

  it('lifts the bottom dock above the keyboard', () => {
    mockCamera(true)
    vi.mocked(useKeyboardShift).mockReturnValue(120)
    render(<Scanner />)
    const dock = screen.getByTestId('bottom-dock')
    expect(dock).toHaveClass('transition-transform')
    expect(dock.style.transform).toBe('translateY(-120px)')
  })

  it('clamps the keyboard lift so the dock stops at the header bottom', () => {
    // Dock top at 250, header bottom at 100: a 300px lift clamps to 150px.
    mockCamera(true)
    vi.mocked(useKeyboardShift).mockReturnValue(300)
    const { rerender } = render(<Scanner />)
    const dock = screen.getByTestId('bottom-dock')
    const header = dock.parentElement?.querySelector('header')
    if (!header) throw new Error('pane header missing')
    Object.defineProperty(dock, 'offsetTop', { value: 250, configurable: true })
    Object.defineProperty(header, 'offsetTop', { value: 0, configurable: true })
    Object.defineProperty(header, 'offsetHeight', { value: 100, configurable: true })
    rerender(<Scanner />)
    expect(screen.getByTestId('bottom-dock').style.transform).toBe('translateY(-150px)')
  })

  it('pins the query bar below the dock scroll region', () => {
    mockCamera(true)
    render(<Scanner />)
    const dock = screen.getByTestId('bottom-dock')
    expect(dock).toHaveClass('max-h-[calc(100dvh-8rem)]', 'pointer-events-none')
    expect(dock.className).not.toContain('overflow-y-auto')
    const scroller = screen.getByTestId('dock-scroll')
    expect(scroller).toHaveClass('overflow-y-auto')
    expect(dock).toContainElement(scroller)
    const query = screen.getByRole('form', { name: 'Text query' })
    expect(dock).toContainElement(query)
    expect(scroller).not.toContainElement(query)
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
    // The queued phrase ran, but tracking stays locked on the first item.
    expect(await screen.findByText('Blend door')).toBeInTheDocument()
    expect(screen.queryByText('Screw')).not.toBeInTheDocument()
  })

  it('freezes visuals on locked follow-ups but still speaks the answer', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial)
      .mockResolvedValueOnce({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: 'first',
        display_mode: 'speech_and_visual',
      })
      .mockResolvedValueOnce({
        target_label: 'Bolt',
        approx_x: 80,
        approx_y: 80,
        speech_response: 'second',
        display_mode: 'speech_and_visual',
      })
    render(<Scanner />)
    await enableVoiceMode()
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Screw')).toBeInTheDocument()
    expect(screen.getByText('Tracking')).toBeInTheDocument()
    const segments = vi.mocked(segmentImage).mock.calls.length
    await act(async () => {
      assistants[0].callbacks.onPhrase('show bolts')
    })
    expect(screen.getByText('Screw')).toBeInTheDocument()
    expect(screen.queryByText('Bolt')).not.toBeInTheDocument()
    expect(vi.mocked(segmentImage).mock.calls.length).toBe(segments)
    expect(vi.mocked(fetchGuidance).mock.calls.length).toBe(1)
    expect(reasonSpatial).toHaveBeenCalledTimes(2)
    expect(speakText).toHaveBeenCalledWith('second')
  })

  it('re-targets after Scan Another Part unlocks tracking', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial)
      .mockResolvedValueOnce({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      .mockResolvedValueOnce({
        target_label: 'Bolt',
        approx_x: 80,
        approx_y: 80,
        speech_response: null,
        display_mode: 'visual_only',
      })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Screw')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Scan Another Part'))
    expect(screen.queryByText('Tracking')).not.toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('show bolts')
    })
    expect(await screen.findByText('Bolt')).toBeInTheDocument()
  })

  it('advances the guidance step on "done" and speaks the next step', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await enableVoiceMode()
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    vi.mocked(speakText).mockClear()
    await act(async () => {
      assistants[0].callbacks.onPhrase('done')
    })
    expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
    expect(screen.getByText('Release belt tension')).toBeInTheDocument()
    // No re-query: the command is answered locally.
    expect(reasonSpatial).toHaveBeenCalledTimes(1)
    expect(speakText).toHaveBeenCalledTimes(1)
    const spoken = vi.mocked(speakText).mock.calls[0][0] as string
    expect(spoken).toContain('Step 2 of 3')
    expect(spoken).toContain('Release belt tension')
    expect(spoken).toContain('Keep fingers clear of the tensioner spring.')
  })

  it('"back" and "repeat" navigate without re-querying', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await enableVoiceMode()
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('next')
    })
    expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('back')
    })
    expect(await screen.findByText('Step 1 of 3')).toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('repeat')
    })
    expect(await screen.findByText('Step 1 of 3')).toBeInTheDocument()
    expect(reasonSpatial).toHaveBeenCalledTimes(1)
    const calls = vi.mocked(speakText).mock.calls
    const lastSpoken = calls[calls.length - 1][0] as string
    expect(lastSpoken).toContain('Step 1 of 3')
  })

  describe('voice conversation', () => {
    it('strips wake words before dispatch', async () => {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
      render(<Scanner />)
      await enableVoiceMode()
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('hey wrenchmind, done')
      })
      expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
    })

    it('drops the app’s own speech feeding back through the mic', async () => {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: 'Found the alternator screw right here.',
        display_mode: 'speech_and_visual',
      })
      vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
      render(<Scanner />)
      await enableVoiceMode()
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      await waitFor(() => expect(speakText).toHaveBeenCalled())
      // Let the fire-and-forget reply stamp its echo window.
      await act(async () => {})
      const calls = vi.mocked(reasonSpatial).mock.calls.length
      await act(async () => {
        assistants[0].callbacks.onPhrase('Found the alternator screw right here.')
      })
      expect(vi.mocked(reasonSpatial).mock.calls.length).toBe(calls)
      // Short control words still pass even when the reply mentioned them.
      await act(async () => {
        assistants[0].callbacks.onPhrase('repeat')
      })
      expect(vi.mocked(reasonSpatial).mock.calls.length).toBe(calls)
    })

    it('yields the floor when the user barges in', async () => {
      mockCamera(true)
      render(<Scanner />)
      await enableVoiceMode()
      vi.mocked(isSpeaking).mockReturnValue(true)
      assistants[0].callbacks.onSpeechStart?.()
      expect(cancelSpeech).toHaveBeenCalledTimes(1)
      vi.mocked(isSpeaking).mockReturnValue(false)
      assistants[0].callbacks.onSpeechStart?.()
      expect(cancelSpeech).toHaveBeenCalledTimes(1)
    })

    it('blips when the turn endpoint lands', async () => {
      mockCamera(true)
      render(<Scanner />)
      await enableVoiceMode()
      assistants[0].callbacks.onSpeechEnd?.()
      expect(playAckBlip).toHaveBeenCalledTimes(1)
    })

    it('captions interim speech and clears on dispatch', async () => {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      render(<Scanner />)
      await enableVoiceMode()
      expect(screen.queryByTestId('voice-caption')).not.toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onInterim?.('show the scr')
      })
      const caption = screen.getByTestId('voice-caption')
      expect(caption).toHaveTextContent('show the scr')
      // Interim words are visual only; announcing each partial stutters.
      expect(caption).toHaveAttribute('aria-live', 'off')
      expect(caption).not.toHaveAttribute('role')
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(screen.queryByTestId('voice-caption')).not.toBeInTheDocument()
    })

    it('offers a voice picker that pins the speech voice', async () => {
      mockCamera(true)
      vi.mocked(getAvailableVoices).mockResolvedValue([
        { name: 'Test Voice', lang: 'en-US' },
      ])
      render(<Scanner />)
      await enableVoiceMode()
      expect(warmUpSpeechVoices).toHaveBeenCalled()
      openOverflow()
      const select = screen.getByLabelText('Speech voice')
      expect(select).toHaveValue('')
      fireEvent.change(select, { target: { value: 'Test Voice' } })
      expect(setPreferredVoiceName).toHaveBeenCalledWith('Test Voice')
    })

    it('nudges after sustained silence in voice mode', async () => {
      vi.useFakeTimers()
      try {
        mockCamera(true)
        render(<Scanner />)
        await enableVoiceMode()
        vi.mocked(speakText).mockClear()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(119_000)
        })
        expect(speakText).not.toHaveBeenCalled()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        expect(speakText).toHaveBeenCalledTimes(1)
        expect(vi.mocked(speakText).mock.calls[0][0]).toMatch(/Still here/)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('does not hijack phrases that merely contain command words', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('show me the next bolt')
    })
    expect(reasonSpatial).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Step 1 of 3')).toBeInTheDocument()
  })

  it('reads label markings on "read this label"', async () => {
    mockCamera(true)
    vi.mocked(extractLabelText).mockResolvedValue(['ABC-123', '24V DC'])
    render(<Scanner />)
    await enableVoiceMode()
    await act(async () => {
      assistants[0].callbacks.onPhrase('read this label')
    })
    expect(await screen.findByText('ABC-123')).toBeInTheDocument()
    expect(screen.getByText('24V DC')).toBeInTheDocument()
    expect(screen.getByTestId('label-findings')).toBeInTheDocument()
    // Long OCR tokens must wrap inside the toast, not push it wider.
    for (const chip of [screen.getByText('ABC-123'), screen.getByText('24V DC')]) {
      expect(chip).toHaveClass('max-w-full', 'break-all')
    }
    expect(reasonSpatial).not.toHaveBeenCalled()
    expect(segmentImage).not.toHaveBeenCalled()
    const calls = vi.mocked(speakText).mock.calls
    expect(calls[calls.length - 1][0]).toContain('ABC-123')
  })

  it('handles illegible labels gracefully', async () => {
    mockCamera(true)
    vi.mocked(extractLabelText).mockResolvedValue([])
    render(<Scanner />)
    await enableVoiceMode()
    await act(async () => {
      assistants[0].callbacks.onPhrase('read the label')
    })
    expect(screen.queryByTestId('label-findings')).not.toBeInTheDocument()
    const calls = vi.mocked(speakText).mock.calls
    expect(calls[calls.length - 1][0]).toContain('could not read')
  })

  it('does not treat label-like sentences as label reads', async () => {
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
      assistants[0].callbacks.onPhrase('can you read this label for me')
    })
    expect(reasonSpatial).toHaveBeenCalledTimes(1)
    expect(extractLabelText).not.toHaveBeenCalled()
  })

  it('clears findings with Clear AR View', async () => {
    mockCamera(true)
    vi.mocked(extractLabelText).mockResolvedValue(['ABC-123'])
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('read this label')
    })
    expect(await screen.findByText('ABC-123')).toBeInTheDocument()
    openOverflow()
    fireEvent.click(screen.getByText('Clear AR View'))
    expect(screen.queryByText('ABC-123')).not.toBeInTheDocument()
  })

  it('exports findings in the repair report', async () => {
    mockCamera(true)
    vi.mocked(extractLabelText).mockResolvedValue(['ABC-123'])
    const captured: { blob: Blob | null } = { blob: null }
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        captured.blob = blob
        return 'blob:fake'
      }),
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('read this label')
    })
    expect(await screen.findByText('ABC-123')).toBeInTheDocument()
    openOverflow()
    fireEvent.click(screen.getByText('Export Report'))
    await waitFor(() => expect(captured.blob).not.toBeNull())
    await expect(captured.blob?.text()).resolves.toContain('<li>ABC-123</li>')
  })

  it('pins a photo checkpoint when advancing steps', async () => {
    const restoreCanvas = mockCanvas2d()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Belt',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
      const captured = captureDownload()
      const { container } = render(<Scanner />)
      setVideoDims(container)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show belt')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('done')
      })
      expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
      openOverflow()
      fireEvent.click(screen.getByText('Export Report'))
      await waitFor(() => expect(captured.blob).not.toBeNull())
      await expect(captured.blob?.text()).resolves.toContain(
        '<img alt="Step 1 photo" src="data:image/jpeg;base64,">',
      )
    } finally {
      restoreCanvas()
    }
  })

  it('pins a photo checkpoint when advancing steps with the Next Step button', async () => {
    const restoreCanvas = mockCanvas2d()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Belt',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
      const captured = captureDownload()
      const { container } = render(<Scanner />)
      setVideoDims(container)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show belt')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Next Step' }))
      expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
      openOverflow()
      fireEvent.click(screen.getByText('Export Report'))
      await waitFor(() => expect(captured.blob).not.toBeNull())
      await expect(captured.blob?.text()).resolves.toContain(
        '<img alt="Step 1 photo" src="data:image/jpeg;base64,">',
      )
    } finally {
      restoreCanvas()
    }
  })

  it('pins no photo when stepping back with the button', async () => {
    const restoreCanvas = mockCanvas2d()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Belt',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
      const captured = captureDownload()
      const { container } = render(<Scanner />)
      setVideoDims(container)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show belt')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Next Step' }))
      expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(await screen.findByText('Step 1 of 3')).toBeInTheDocument()
      openOverflow()
      fireEvent.click(screen.getByText('Export Report'))
      await waitFor(() => expect(captured.blob).not.toBeNull())
      const text = (await captured.blob?.text()) ?? ''
      // Forward pinned step 1; stepping back adds no second photo.
      expect(text.match(/<img alt="Step \d+ photo"/g)).toHaveLength(1)
      expect(text).toContain('<img alt="Step 1 photo"')
    } finally {
      restoreCanvas()
    }
  })

  it('keeps gathered steps in the report after Clear AR View', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Belt',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    const captured = captureDownload()
    const { container } = render(<Scanner />)
    setVideoDims(container)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show belt')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    openOverflow()
    fireEvent.click(screen.getByText('Clear AR View'))
    expect(screen.queryByText('Remove the belt cover')).not.toBeInTheDocument()
    openOverflow()
    fireEvent.click(screen.getByText('Export Report'))
    await waitFor(() => expect(captured.blob).not.toBeNull())
    const text = (await captured.blob?.text()) ?? ''
    expect(text).toContain('<h2>Earlier this session</h2>')
    expect(text).toContain('<h2>MID-DRIVE DRIVE BELT</h2>')
    expect(text).toContain('[&gt;] Step 1: Remove the belt cover')
    expect(text).not.toContain('No repair guidance was generated this session.')
  })

  it('exports both procedures when a new scan supersedes the last', async () => {
    const media = mockMediaControls()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Belt',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      const alternator = {
        ...validGuidanceFixture,
        title: 'ALTERNATOR BELT',
        steps: [{ title: 'Loosen pivot bolt', detail: 'Crack it, do not remove.' }],
      }
      vi.mocked(fetchGuidance).mockResolvedValueOnce(validGuidanceFixture).mockResolvedValueOnce(alternator)
      const captured = captureDownload()
      const { container } = render(<Scanner />)
      setVideoDims(container)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show belt')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      // Unfreezing releases the tracking lock while keeping guidance, so the
      // next phrase fetches fresh guidance that supersedes the first.
      await screen.findByText('LIVE')
      pressFreezeFrame()
      expect(await screen.findByText('FROZEN')).toBeInTheDocument()
      pressFreezeFrame()
      await screen.findByText('LIVE')
      await act(async () => {
        assistants[0].callbacks.onPhrase('show alternator')
      })
      expect(await screen.findByText('Loosen pivot bolt')).toBeInTheDocument()
      openOverflow()
      fireEvent.click(screen.getByText('Export Report'))
      await waitFor(() => expect(captured.blob).not.toBeNull())
      const text = (await captured.blob?.text()) ?? ''
      expect(text).toContain('<h2>ALTERNATOR BELT</h2>')
      expect(text).toContain('<h2>Earlier this session</h2>')
      expect(text).toContain('<h2>MID-DRIVE DRIVE BELT</h2>')
      expect(text).toContain('[&gt;] Step 1: Loosen pivot bolt')
      expect(text).toContain('[&gt;] Step 1: Remove the belt cover')
    } finally {
      media.restore()
    }
  })

  it('does not capture checkpoints on back or repeat', async () => {
    const restoreCanvas = mockCanvas2d()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Belt',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
      const captured = captureDownload()
      const { container } = render(<Scanner />)
      setVideoDims(container)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show belt')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('done')
      })
      await act(async () => {
        assistants[0].callbacks.onPhrase('back')
      })
      await act(async () => {
        assistants[0].callbacks.onPhrase('repeat')
      })
      openOverflow()
      fireEvent.click(screen.getByText('Export Report'))
      await waitFor(() => expect(captured.blob).not.toBeNull())
      const text = (await captured.blob?.text()) ?? ''
      expect(text.match(/<img alt="Step \d+ photo"/g)).toHaveLength(1)
    } finally {
      restoreCanvas()
    }
  })

  it('clears checkpoints with Clear AR View', async () => {
    const restoreCanvas = mockCanvas2d()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Belt',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
      const captured = captureDownload()
      const { container } = render(<Scanner />)
      setVideoDims(container)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show belt')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('done')
      })
      expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
      openOverflow()
      fireEvent.click(screen.getByText('Clear AR View'))
      openOverflow()
      fireEvent.click(screen.getByText('Export Report'))
      await waitFor(() => expect(captured.blob).not.toBeNull())
      await expect(captured.blob?.text()).resolves.not.toContain('<img')
    } finally {
      restoreCanvas()
    }
  })

  it('shares the report when the platform accepts it', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Belt',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    const captured = captureDownload()
    const share = vi.fn(async () => {})
    Object.defineProperty(navigator, 'canShare', { value: vi.fn(() => true), configurable: true })
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    try {
      render(<Scanner />)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show belt')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      openOverflow()
      fireEvent.click(screen.getByText('Export Report'))
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
      expect(captured.blob).toBeNull()
      expect(getLogs().some((e) => e.message.includes('repair report shared'))).toBe(true)
    } finally {
      const nav = navigator as unknown as Record<string, unknown>
      delete nav['canShare']
      delete nav['share']
    }
  })

  it('shows the flashlight toggle when the track supports torch', async () => {
    const { stream } = torchStream()
    mockCameraStream(stream)
    render(<Scanner />)
    const toggle = await screen.findByRole('button', { name: 'Flashlight' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggles torch via applyConstraints', async () => {
    const { stream, applyConstraints } = torchStream()
    mockCameraStream(stream)
    render(<Scanner />)
    const toggle = await screen.findByRole('button', { name: 'Flashlight' })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] }),
    )
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: false }] }),
    )
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('hides the flashlight toggle without torch support', async () => {
    mockCamera(true)
    render(<Scanner />)
    expect(await screen.findByText('LIVE')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Flashlight' })).not.toBeInTheDocument()
  })

  it('turns torch off when the new camera lacks it', async () => {
    const { stream } = torchStream()
    mockCameraStream(stream)
    render(<Scanner />)
    const toggle = await screen.findByRole('button', { name: 'Flashlight' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
    mockCamera(true)
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Flashlight' })).not.toBeInTheDocument()
    })
  })

  it('stays off when the torch constraint is rejected', async () => {
    const { stream } = torchStream(async () => {
      throw new Error('denied')
    })
    mockCameraStream(stream)
    render(<Scanner />)
    const toggle = await screen.findByRole('button', { name: 'Flashlight' })
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(getLogs().some((e) => e.message.includes('flashlight'))).toBe(true)
    })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('fetches iFixit guides on scan and shows them in the card', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Belt',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    vi.mocked(searchGuides).mockResolvedValue([
      {
        title: 'Lenovo Laptop Not Charging',
        url: 'https://www.ifixit.com/Troubleshooting/Lenovo_Laptop/Not+Charging/539059',
        summary: '',
        difficulty: null,
        kind: 'wiki',
      },
    ])
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show belt')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    expect(searchGuides).toHaveBeenCalledWith('show belt Belt', 3)
    const link = await screen.findByRole('link', { name: 'Lenovo Laptop Not Charging' })
    expect(link).toHaveAttribute(
      'href',
      'https://www.ifixit.com/Troubleshooting/Lenovo_Laptop/Not+Charging/539059',
    )
  })

  it('keeps the card intact when guide lookup fails', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Belt',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    vi.mocked(searchGuides).mockRejectedValue(new Error('iFixit 429'))
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show belt')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    expect(
      await screen.findByRole('link', { name: `Search iFixit for ${validGuidanceFixture.title}` }),
    ).toBeInTheDocument()
    expect(screen.getByText('No iFixit guides found for this part.')).toBeInTheDocument()
  })

  it('refetches guides per scan after Scan Another', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Belt',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show belt')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    expect(searchGuides).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Scan Another Part'))
    await act(async () => {
      assistants[0].callbacks.onPhrase('show tensioner')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    expect(searchGuides).toHaveBeenCalledTimes(2)
    expect(vi.mocked(searchGuides).mock.calls[1][0]).toBe('show tensioner Belt')
  })

  it('unlocks tracking when switching cameras', async () => {
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
    expect(await screen.findByText('Tracking')).toBeInTheDocument()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    expect(screen.queryByText('Tracking')).not.toBeInTheDocument()
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

  it('isolates every instance for plural commands in one call', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Bolt',
      approx_x: 50,
      approx_y: 50,
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
        { x: 50, y: 60 },
      ],
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(parseSamStream).mockResolvedValueOnce([
      {
        frame: 0,
        ordinal: 0,
        objectId: '1',
        box: { x1: 0, y1: 0, x2: 1, y2: 1, w: 2, h: 2 },
        raster: Uint8Array.from([1, 0, 0, 0]),
      },
      {
        frame: 0,
        ordinal: 1,
        objectId: '2',
        box: { x1: 4, y1: 4, x2: 5, y2: 5, w: 2, h: 2 },
        raster: Uint8Array.from([1, 0, 0, 0]),
      },
      {
        frame: 0,
        ordinal: 2,
        objectId: '3',
        box: { x1: 8, y1: 8, x2: 9, y2: 9, w: 2, h: 2 },
        raster: Uint8Array.from([1, 0, 0, 0]),
      },
    ])
    const { container } = render(<Scanner />)
    const video = container.querySelector('video')
    if (!video) throw new Error('missing video element')
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true })
    await act(async () => {
      assistants[0].callbacks.onPhrase('show all bolts')
    })
    expect(await screen.findByText('3 × Bolt')).toBeInTheDocument()
    expect(segmentImage).toHaveBeenCalledTimes(1)
    expect(segmentImage).toHaveBeenCalledWith('data:image/jpeg;base64,AAA', 'Bolt', [
      { x: 64, y: 96, width: 640, height: 480 },
      { x: 192, y: 192, width: 640, height: 480 },
      { x: 320, y: 288, width: 640, height: 480 },
    ])
    expect(getLogs().some((e) => e.message.includes('isolated 3'))).toBe(true)
  })

  it('numbers each isolated instance on the canvas', async () => {
    const fillText = vi.fn()
    const fillRect = vi.fn()
    const drawImage = vi.fn()
    const compositeOps: string[] = []
    const fillStyles: string[] = []
    const ctx = new Proxy(
      { marker: 'ctx', fillText, fillRect, drawImage, measureText: () => ({ width: 10 }) },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          const value = (target as Record<PropertyKey, unknown>)[prop]
          return value ?? (() => undefined)
        },
        set: (target, prop, value) => {
          if (prop === 'globalCompositeOperation') compositeOps.push(value as string)
          if (prop === 'fillStyle') fillStyles.push(value as string)
          return Reflect.set(target as object, prop, value)
        },
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Bolt',
        approx_x: 50,
        approx_y: 50,
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        {
          frame: 0,
          ordinal: 0,
          objectId: '1',
          box: { x1: 0, y1: 40, x2: 1, y2: 41, w: 2, h: 2 },
          raster: Uint8Array.from([1, 0, 0, 0]),
        },
        {
          frame: 0,
          ordinal: 1,
          objectId: '2',
          box: { x1: 4, y1: 40, x2: 5, y2: 41, w: 2, h: 2 },
          raster: Uint8Array.from([1, 0, 0, 0]),
        },
      ])
      render(<Scanner />)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show all bolts')
      })
      await screen.findByText('2 × Bolt')
      expect(fillText).toHaveBeenCalledWith('1', expect.any(Number), expect.any(Number))
      expect(fillText).toHaveBeenCalledWith('2', expect.any(Number), expect.any(Number))
      // Spotlight: full-frame dim, raster holes punched via drawImage.
      expect(fillStyles).toContain('rgba(0, 0, 0, 0.55)')
      expect(fillRect).toHaveBeenCalledWith(0, 0, window.innerWidth, window.innerHeight)
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 40)
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 4, 40)
      expect(compositeOps[0]).toBe('destination-out')
      expect(compositeOps[compositeOps.length - 1]).toBe('source-over')
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('keeps plural targets through the refresh loop', async () => {
    vi.useFakeTimers()
    try {
      mockCamera(true)
      const points = [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ]
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Bolt',
        approx_x: 50,
        approx_y: 50,
        points,
        speech_response: null,
        display_mode: 'visual_only',
      })
      const { container } = render(<Scanner />)
      const video = container.querySelector('video')
      if (!video) throw new Error('missing video element')
      Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true })
      await act(async () => {
        assistants[0].callbacks.onPhrase('show all bolts')
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100)
      })
      expect(segmentImage).toHaveBeenCalledTimes(2)
      const expected = [
        { x: 64, y: 96, width: 640, height: 480 },
        { x: 192, y: 192, width: 640, height: 480 },
      ]
      expect(vi.mocked(segmentImage).mock.calls[1]).toEqual([
        'data:image/jpeg;base64,AAA',
        'Bolt',
        expected,
      ])
    } finally {
      vi.useRealTimers()
    }
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
      openOverflow()
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
        openOverflow()
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
      })
      expect(screen.getByText('Listening')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        openOverflow()
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
      })
      expect(screen.queryByText('[ OFF ]')).not.toBeInTheDocument()
      await act(async () => {
        openOverflow()
      })
      expect(screen.getByRole('switch', { name: 'Voice mode' })).toHaveAttribute('aria-checked', 'false')
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
      // Locked follow-up answers without re-segmenting.
      expect(segmentImage).toHaveBeenCalledTimes(1)
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

  it('speaks confirmations in speech-and-visual mode', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: 'done',
      display_mode: 'speech_and_visual',
    })
    render(<Scanner />)
    await enableVoiceMode()
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    expect(speakText).toHaveBeenCalledTimes(1)
    expect(speakText).toHaveBeenCalledWith('done')
  })

  it('shows a speaking badge during playback then returns to listening', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: 'done',
      display_mode: 'speech_and_visual',
    })
    let releaseSpeak!: () => void
    vi.mocked(speakText).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSpeak = resolve
        }),
    )
    render(<Scanner />)
    openOverflow()
    fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
    await screen.findByText('Listening')
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    expect(speakText).toHaveBeenCalledWith('done')
    expect(await screen.findByText('Speaking')).toBeInTheDocument()
    await act(async () => {
      releaseSpeak()
    })
    expect(await screen.findByText('Listening')).toBeInTheDocument()
  })

  it('stays silent with voice mode off', async () => {
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
      assistants[0].callbacks.onPhrase('go')
    })
    expect(await screen.findByText('Screw')).toBeInTheDocument()
    expect(speakText).not.toHaveBeenCalled()
    expect(screen.queryByText('Speaking')).not.toBeInTheDocument()
  })

  it('step commands advance silently with voice mode off', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('done')
    })
    expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
    expect(speakText).not.toHaveBeenCalled()
  })

  it('stays silent in visual-only mode', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: 'done',
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    expect(speakText).not.toHaveBeenCalled()
  })

  it('stops speech when clearing the AR view', async () => {
    mockCamera(true)
    render(<Scanner />)
    openOverflow()
    fireEvent.click(screen.getByText('Clear AR View'))
    expect(cancelSpeech).toHaveBeenCalled()
  })

  it('exports the repair report from the overflow menu', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Belt',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    const captured: { blob: Blob | null } = { blob: null }
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        captured.blob = blob
        return 'blob:fake'
      }),
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show belt')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    assistants[0].getMemory.mockReturnValue([
      { phrase: 'show belt', label: 'Drive belt', x: 1, y: 2, timestamp: 1 },
      { phrase: 'show tensioner', label: 'Tensioner', x: 3, y: 4, timestamp: 2 },
      { phrase: 'show belt again', label: 'Drive belt', x: 1, y: 2, timestamp: 3 },
    ])
    openOverflow()
    fireEvent.click(screen.getByText('Export Report'))
    await waitFor(() => expect(captured.blob).not.toBeNull())
    await expect(captured.blob?.text()).resolves.toContain('<h2>MID-DRIVE DRIVE BELT</h2>')
    await expect(captured.blob?.text()).resolves.toContain('Working on: Drive belt, Tensioner')
    expect(getLogs().some((e) => e.message.includes('repair report downloaded'))).toBe(true)
  })

  it('stops speech on unmount', async () => {
    mockCamera(true)
    const { unmount } = render(<Scanner />)
    unmount()
    expect(cancelSpeech).toHaveBeenCalled()
  })

  it.each<[string, string, string]>([
    ['Electrical connector', '#ffff00', 'rgb(255, 255, 0)'],
    ['Mounting screw', '#ff0000', 'rgb(255, 0, 0)'],
    ['Blend door', '#00ffff', 'rgb(0, 255, 255)'],
  ])('marks %s with the %s callout dot', async (label, hex, rgb) => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: label,
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    const pill = await screen.findByText(label)
    const style = pill.querySelector('span')?.getAttribute('style') ?? ''
    expect(style.includes(hex) || style.includes(rgb)).toBe(true)
  })

  it('warns when reasoning returns no target', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: '',
      approx_x: 0,
      approx_y: 0,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('nothing here')
    })
    expect(getLogs().some((e) => e.level === 'warn' && e.message.includes('no target'))).toBe(
      true,
    )
    expect(segmentImage).not.toHaveBeenCalled()
    expect(screen.queryByText('[ OFF ]')).not.toBeInTheDocument()
  })

  it('shows an error when no frame is captured', async () => {
    mockCamera(true)
    vi.mocked(captureFrameBurst).mockResolvedValue([])
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    expect(await screen.findByText('Error')).toBeInTheDocument()
  })

  it('ignores phrases after unmount', async () => {
    mockCamera(true)
    const { unmount } = render(<Scanner />)
    const callbacks = assistants[0].callbacks
    unmount()
    await act(async () => {
      callbacks.onPhrase('late phrase')
    })
    expect(reasonSpatial).not.toHaveBeenCalled()
  })

  it('stops the stream when unmounted mid-init', async () => {
    let resolveStream!: (stream: MediaStream) => void
    const stop = vi.fn()
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve
        }),
    )
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: async () => [] },
      configurable: true,
    })
    const { unmount } = render(<Scanner />)
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1)
    })
    unmount()
    await act(async () => {
      resolveStream({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('warns when video autoplay is blocked', async () => {
    const play = vi.fn(async () => {
      throw new Error('blocked')
    })
    const proto = window.HTMLVideoElement.prototype as unknown as Record<string, unknown>
    const original = Object.getOwnPropertyDescriptor(proto, 'play')
    Object.defineProperty(proto, 'play', { value: play, configurable: true, writable: true })
    try {
      mockCamera(true)
      render(<Scanner />)
      await waitFor(() => {
        expect(
          getLogs().some((e) => e.level === 'warn' && e.message.includes('autoplay')),
        ).toBe(true)
      })
    } finally {
      if (original) {
        Object.defineProperty(proto, 'play', original)
      } else {
        delete proto['play']
      }
    }
  })

  it('keeps the switcher when enumeration fails', async () => {
    mockCamera(true)
    const md = navigator.mediaDevices as unknown as { getUserMedia: unknown }
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: md.getUserMedia,
        enumerateDevices: vi.fn(async () => {
          throw new Error('nope')
        }),
      },
      configurable: true,
    })
    render(<Scanner />)
    openOverflow()
    // A failed enumeration keeps the switcher: wait for the attempt, then
    // prove the switcher is still shown.
    const enumerateDevices = vi.mocked(navigator.mediaDevices.enumerateDevices)
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
  })

  it('paints mask overlays on the canvas', async () => {
    const ctx = new Proxy(
      { marker: 'ctx' },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          return (target as Record<PropertyKey, unknown>)[prop] ?? (() => undefined)
        },
        set: () => true,
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        {
          frame: 0,
          ordinal: 0,
          objectId: '0',
          box: { x1: 0, y1: 0, x2: 1, y2: 1, w: 2, h: 2 },
          raster: Uint8Array.from([1, 0, 0, 0]),
        },
      ])
      render(<Scanner />)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(screen.getByText('Screw')).toBeInTheDocument()
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('skips canvas churn when idle and already sized', async () => {
    const clearRect = vi.fn()
    const fillRect = vi.fn()
    const ctx = new Proxy(
      { marker: 'ctx', fillRect },
      {
        get: (target, prop) => {
          if (prop === 'clearRect') return clearRect
          return (target as Record<PropertyKey, unknown>)[prop] ?? (() => undefined)
        },
        set: () => true,
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
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
        assistants[0].callbacks.onPhrase('first')
      })
      await act(async () => {
        assistants[0].callbacks.onPhrase('second')
      })
      expect(clearRect).toHaveBeenCalledTimes(1)
      // Idle: no overlays, so no spotlight dim fill.
      expect(fillRect).not.toHaveBeenCalled()
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('keeps the overlay when a refresh fails', async () => {
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
      expect(screen.getByText('Screw')).toBeInTheDocument()
      vi.mocked(parseSamStream).mockRejectedValueOnce(new Error('boom'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100)
      })
      expect(segmentImage).toHaveBeenCalledTimes(2)
      expect(screen.getByText('Screw')).toBeInTheDocument()
      expect(getLogs().some((e) => e.level === 'warn' && e.message.includes('refresh failed'))).toBe(
        true,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers to listening after a pipeline failure', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockRejectedValue(new Error('network down'))
    render(<Scanner />)
    openOverflow()
    fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
    await screen.findByText('Listening')
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Error')).toBeInTheDocument()
  })

  it('fetches guidance alongside segmentation and renders the HUD card', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Blend door',
      approx_x: 40,
      approx_y: 60,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show me the blend door')
    })
    expect(await screen.findByText('MID-DRIVE DRIVE BELT')).toBeInTheDocument()
    expect(fetchGuidance).toHaveBeenCalledWith('Blend door', 'show me the blend door', '')
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('Warnings')).toBeInTheDocument()
    expect(screen.getByText('Verify all specs against the manual.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next Step' }))
    expect(screen.getByText('Release belt tension')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Remove the belt cover')).toBeInTheDocument()
  })

  it('shows a guidance skeleton while the fetch is pending', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    let release!: (value: GuidanceResult) => void
    vi.mocked(fetchGuidance).mockImplementationOnce(
      () =>
        new Promise<GuidanceResult>((resolve) => {
          release = resolve
        }),
    )
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByRole('status', { name: 'Loading guidance' })).toBeInTheDocument()
    await act(async () => {
      release(validGuidanceFixture)
    })
    expect(await screen.findByText('MID-DRIVE DRIVE BELT')).toBeInTheDocument()
  })

  it('reserves card-slot height while guidance loads and resolves', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    let release!: (value: GuidanceResult) => void
    vi.mocked(fetchGuidance).mockImplementationOnce(
      () =>
        new Promise<GuidanceResult>((resolve) => {
          release = resolve
        }),
    )
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByRole('status', { name: 'Loading guidance' })).toBeInTheDocument()
    expect(screen.getByTestId('hud-slot')).toHaveClass('min-h-[160px]')
    await act(async () => {
      release(validGuidanceFixture)
    })
    expect(await screen.findByText('MID-DRIVE DRIVE BELT')).toBeInTheDocument()
    expect(screen.getByTestId('hud-slot')).toHaveClass('min-h-[160px]')
  })

  it('keeps the AR pipeline when guidance fetch fails', async () => {
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
    expect(await screen.findByText('Screw')).toBeInTheDocument()
    expect(screen.queryByText('MID-DRIVE DRIVE BELT')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(
        screen.queryByRole('status', { name: 'Loading guidance' }),
      ).not.toBeInTheDocument()
    })
    expect(
      getLogs().some((e) => e.level === 'warn' && e.message.includes('guidance unavailable')),
    ).toBe(true)
  })

  it('fires guidance and guides before segmentation so lookups overlap it', async () => {
    // Intended behavior change: guidance needs only the reason label, so it
    // fires right after reasonSpatial instead of after SAM.
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Screw')).toBeInTheDocument()
    const guidanceOrder = vi.mocked(fetchGuidance).mock.invocationCallOrder[0]
    const guidesOrder = vi.mocked(searchGuides).mock.invocationCallOrder[0]
    const segmentOrder = vi.mocked(segmentImage).mock.invocationCallOrder[0]
    expect(guidanceOrder).toBeLessThan(segmentOrder)
    expect(guidesOrder).toBeLessThan(segmentOrder)
  })

  it('logs the manual search at fire time plus per-stage timings', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    expect(
      getLogs().some((e) => e.tag === 'guidance' && e.message.includes('searching manual for')),
    ).toBe(true)
    expect(getLogs().some((e) => e.tag === 'reason' && /\d+ms/.test(e.message))).toBe(true)
    expect(getLogs().some((e) => e.tag === 'segment' && /\d+ms/.test(e.message))).toBe(true)
    expect(
      getLogs().some((e) => e.tag === 'guidance' && /\d+ steps\) in \d+ms/.test(e.message)),
    ).toBe(true)
  })

  it('keeps gathered steps when segmentation fails after the early fire', async () => {
    // Intended behavior change: steps for a named part stay valid even when
    // segmentation then fails, so the error path clears nothing.
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(parseSamStream).mockRejectedValueOnce(new Error('SAM down'))
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(fetchGuidance).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
  })

  it('clears guidance and overlays on Scan Another Part', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('MID-DRIVE DRIVE BELT')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Scan Another Part' }))
    expect(screen.queryByText('MID-DRIVE DRIVE BELT')).not.toBeInTheDocument()
    expect(screen.queryByText('Screw')).not.toBeInTheDocument()
    expect(assistants[0].clearMemory).toHaveBeenCalledTimes(1)
  })

  it('mounts cleanly under StrictMode so guidance still resolves', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(
      <StrictMode>
        <Scanner />
      </StrictMode>,
    )
    // StrictMode double-mounts effects; the second mount must leave the
    // mounted guard true or the guidance resolver bails forever.
    const live = assistants[assistants.length - 1]
    await act(async () => {
      live.callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
  })

  it('drops an in-flight phrase result after Clear AR View changes the scene', async () => {
    mockCamera(true)
    let releaseReason!: (value: SpatialResult) => void
    vi.mocked(reasonSpatial).mockImplementationOnce(
      () =>
        new Promise<SpatialResult>((resolve) => {
          releaseReason = resolve
        }),
    )
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    openOverflow()
    fireEvent.click(screen.getByText('Clear AR View'))
    await act(async () => {
      releaseReason({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
    })
    // Computed against the old scene: no paint, no guidance lookup.
    expect(screen.queryByText('Screw')).not.toBeInTheDocument()
    expect(fetchGuidance).not.toHaveBeenCalled()
  })

  it('a late camera stream cannot clobber an uploaded photo', async () => {
    let resolveStream!: (stream: MediaStream) => void
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve
        }),
    )
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
      configurable: true,
    })
    const still = document.createElement('canvas')
    still.width = 640
    still.height = 480
    vi.mocked(decodePhotoFile).mockResolvedValue(still)
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))
      const file = new File(['bytes'], 'engine.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [file] } })
      expect(await screen.findByAltText('Uploaded photo')).toBeInTheDocument()
      expect(screen.getByText('FROZEN')).toBeInTheDocument()
      const { stream, stop } = trackedStream()
      await act(async () => {
        resolveStream(stream)
      })
      // Let the attach continuation run: the still must survive it.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      expect(screen.getByAltText('Uploaded photo')).toBeInTheDocument()
      expect(screen.getByText('FROZEN')).toBeInTheDocument()
      expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
      expect(stop).toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('a stale error timer cannot wipe a newer analyzing status', async () => {
    vi.useFakeTimers()
    try {
      mockCamera(true)
      let releaseReason!: (value: SpatialResult) => void
      vi.mocked(reasonSpatial)
        .mockRejectedValueOnce(new Error('network down'))
        .mockImplementationOnce(
          () =>
            new Promise<SpatialResult>((resolve) => {
              releaseReason = resolve
            }),
        )
      render(<Scanner />)
      await enableVoiceMode()
      expect(screen.getByText('Listening')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(screen.getByText('Error')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('show bolts')
      })
      expect(screen.getByText('Analyzing…')).toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100)
      })
      expect(screen.getByText('Analyzing…')).toBeInTheDocument()
      await act(async () => {
        releaseReason({
          target_label: 'Bolt',
          approx_x: 80,
          approx_y: 80,
          speech_response: null,
          display_mode: 'visual_only',
        })
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an older reply cannot downgrade a newer analyzing status', async () => {
    mockCamera(true)
    let releaseSpeak!: () => void
    vi.mocked(speakText).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSpeak = resolve
        }),
    )
    let releaseReason!: (value: SpatialResult) => void
    vi.mocked(reasonSpatial)
      .mockResolvedValueOnce({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: 'found it',
        display_mode: 'speech_and_visual',
      })
      .mockImplementationOnce(
        () =>
          new Promise<SpatialResult>((resolve) => {
            releaseReason = resolve
          }),
      )
    render(<Scanner />)
    await enableVoiceMode()
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Speaking')).toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('show bolts')
    })
    expect(screen.getByText('Analyzing…')).toBeInTheDocument()
    await act(async () => {
      releaseSpeak()
    })
    expect(screen.getByText('Analyzing…')).toBeInTheDocument()
    expect(screen.queryByText('Listening')).not.toBeInTheDocument()
    await act(async () => {
      releaseReason({
        target_label: 'Bolt',
        approx_x: 80,
        approx_y: 80,
        speech_response: null,
        display_mode: 'visual_only',
      })
    })
  })

  it('switching cameras preserves the job while clearing the scene', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    vi.mocked(extractLabelText).mockResolvedValue(['ABC-123'])
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('read this label')
    })
    expect(await screen.findByText('ABC-123')).toBeInTheDocument()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    // Scene-only: paint, callout, and tracking go...
    expect(screen.queryByText('Screw')).not.toBeInTheDocument()
    expect(screen.queryByText('Tracking')).not.toBeInTheDocument()
    // ...but findings, guidance, and memory survive the switch.
    expect(screen.getByText('ABC-123')).toBeInTheDocument()
    expect(screen.getByText('Remove the belt cover')).toBeInTheDocument()
    expect(assistants[0].clearMemory).not.toHaveBeenCalled()
  })

  it('step commands work without an API key', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Step 1 of 3')).toBeInTheDocument()
    vi.stubEnv('VITE_META_MODEL_API_KEY', '')
    await act(async () => {
      assistants[0].callbacks.onPhrase('done')
    })
    expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument()
    expect(reasonSpatial).toHaveBeenCalledTimes(1)
  })

  it('files the live procedure when a superseding scan fires', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Belt',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    vi.mocked(fetchGuidance)
      .mockResolvedValueOnce(validGuidanceFixture)
      .mockRejectedValueOnce(new Error('manual offline'))
    const captured = captureDownload()
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show belt')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      // Unfreezing unlocks tracking while keeping the card, so the next
      // phrase fires a fresh guidance request that supersedes it — and
      // files it first, even though the fetch then fails.
      await screen.findByText('LIVE')
      pressFreezeFrame()
      expect(await screen.findByText('FROZEN')).toBeInTheDocument()
      pressFreezeFrame()
      await screen.findByText('LIVE')
      await act(async () => {
        assistants[0].callbacks.onPhrase('show alternator')
      })
      expect(fetchGuidance).toHaveBeenCalledTimes(2)
      openOverflow()
      fireEvent.click(screen.getByText('Export Report'))
      await waitFor(() => expect(captured.blob).not.toBeNull())
      const text = (await captured.blob?.text()) ?? ''
      expect(text).toContain('<h2>Earlier this session</h2>')
      expect(text).toContain('<h2>MID-DRIVE DRIVE BELT</h2>')
    } finally {
      media.restore()
    }
  })
})

describe('Scanner states (Wave 3)', () => {
  async function phraseWithTarget(label: string, x: number, y: number): Promise<HTMLElement> {
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: label,
      approx_x: x,
      approx_y: y,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    return screen.findByText(label)
  }

  function styleAttr(element: HTMLElement): string {
    return element.getAttribute('style') ?? ''
  }

  it('clamps left-edge callout pills so they never overflow the viewport', async () => {
    mockCamera(true)
    const pill = await phraseWithTarget('Edge screw', 2, 60)
    expect(pill).toHaveClass('backdrop-blur-md', 'rounded-full')
    expect(styleAttr(pill)).toContain('calc(2%')
    expect(styleAttr(pill)).toContain('env(safe-area-inset-left)')
    expect(styleAttr(pill)).toContain('translate(0, calc(-100% - 8px))')
  })

  it('clamps right-edge callout pills so they never overflow the viewport', async () => {
    mockCamera(true)
    const pill = await phraseWithTarget('Far connector', 98, 60)
    expect(styleAttr(pill)).toContain('calc(98%')
    expect(styleAttr(pill)).toContain('env(safe-area-inset-right)')
    expect(styleAttr(pill)).toContain('translate(-100%, calc(-100% - 8px))')
  })

  it('drops top-edge callout pills below their point', async () => {
    mockCamera(true)
    const pill = await phraseWithTarget('High bolt', 50, 5)
    expect(styleAttr(pill)).toContain('top: 5%')
    expect(styleAttr(pill)).toContain('translate(-50%, 8px)')
  })

  it('centers mid-viewport callout pills above their point', async () => {
    mockCamera(true)
    const pill = await phraseWithTarget('Blend door', 40, 60)
    expect(styleAttr(pill)).toContain('left: 40%')
    expect(styleAttr(pill)).toContain('translate(-50%, calc(-100% - 8px))')
  })

  it('announces callouts through a status region', async () => {
    mockCamera(true)
    await phraseWithTarget('Blend door', 40, 60)
    expect(screen.getByRole('status', { name: 'Located: Blend door' })).toBeInTheDocument()
  })

  it('flips desktop voice callouts into stage coords', async () => {
    vi.mocked(useDesktopLayout).mockReturnValue(true)
    mockCamera(true)
    await phraseWithTarget('Blend door', 40, 60)
    // The model answers in raw-frame coords; the mirrored stage shows that
    // content at 100 - 40.
    expect(
      styleAttr(screen.getByRole('status', { name: 'Located: Blend door' })),
    ).toContain('left: 60%')
  })

  it('maps voice callouts through the cover fit when aspects mismatch', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Side bolt',
      approx_x: 25,
      approx_y: 50,
      speech_response: null,
      display_mode: 'visual_only',
    })
    const { container } = render(<Scanner />)
    setVideoDims(container, 640, 480)
    // Portrait stage, landscape frame: 25% across the frame crops to ~5.6%.
    const stage = screen.getByTestId('zoom-stage')
    Object.defineProperty(stage, 'clientWidth', { value: 300, configurable: true })
    Object.defineProperty(stage, 'clientHeight', { value: 400, configurable: true })
    await act(async () => {
      assistants[0].callbacks.onPhrase('side bolt')
    })
    const pill = await screen.findByText('Side bolt')
    expect(styleAttr(pill)).toContain('5.555')
    expect(styleAttr(pill)).not.toContain('left: 25%')
  })

  it('paints neon outlines while keeping per-kind colors', async () => {
    const writes: Array<[string, unknown]> = []
    const ctx = new Proxy(
      { marker: 'ctx' },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          return (target as Record<PropertyKey, unknown>)[prop] ?? (() => undefined)
        },
        set: (_target, prop, value) => {
          writes.push([String(prop), value])
          return true
        },
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    try {
      mockCamera(true)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        {
          frame: 0,
          ordinal: 0,
          objectId: '0',
          box: { x1: 0, y1: 0, x2: 1, y2: 1, w: 2, h: 2 },
          raster: Uint8Array.from([1, 0, 0, 0]),
        },
      ])
      await phraseWithTarget('Electrical connector', 40, 60)
      expect(writes).toContainEqual(['lineWidth', 3])
      expect(writes).toContainEqual(['shadowColor', '#ffff00'])
      expect(writes).toContainEqual(['shadowBlur', 12])
      expect(writes).toContainEqual(['strokeStyle', '#ffff00'])
    } finally {
      ctxSpy.mockRestore()
    }
  })

  it('dismisses the error dock through a 48px focus-visible target', async () => {
    mockCamera(false)
    render(<Scanner />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Camera access denied')
    expect(alert).toHaveClass('bg-black/85')
    expect(alert.className).not.toContain('backdrop-blur')
    const dismiss = screen.getByRole('button', { name: 'Dismiss error' })
    expect(dismiss).toHaveClass('min-h-[48px]', 'min-w-[48px]')
    expect(dismiss.className).toContain('focus-visible:ring-2')
    expect(dismiss.className).toContain('motion-safe:active:scale-95')
    const retry = screen.getByRole('button', { name: 'Try camera again' })
    expect(retry.className).toContain('focus-visible:ring-2')
    fireEvent.click(dismiss)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an offline banner that clears on reconnect', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      mockCamera(true)
      render(<Scanner />)
      expect(await screen.findByText(/You're offline/)).toBeInTheDocument()
      expect(screen.getByTestId('dock-status')).toHaveTextContent("You're offline")
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
      act(() => {
        window.dispatchEvent(new window.Event('offline'))
        window.dispatchEvent(new window.Event('online'))
      })
      await waitFor(() => {
        expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument()
      })
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'onLine', original)
      } else {
        delete (navigator as unknown as Record<string, unknown>)['onLine']
      }
    }
  })

  it('announces dock banners through a single live region', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      mockCamera(true)
      render(<Scanner />)
      const region = await screen.findByTestId('dock-status')
      expect(region).toHaveAttribute('role', 'status')
      expect(region).toHaveTextContent("You're offline")
      // No nested live regions: one announcement stream for all banners.
      expect(region.querySelectorAll('[role="status"],[role="alert"]')).toHaveLength(0)
      // Solid scrims, not per-frame backdrop blur over the video feed.
      for (const banner of Array.from(region.children)) {
        expect(banner).toHaveClass('bg-black/85')
        expect(banner.className).not.toContain('backdrop-blur')
      }
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'onLine', original)
      } else {
        delete (navigator as unknown as Record<string, unknown>)['onLine']
      }
    }
  })

  it('shows an empty-target notice when reasoning finds nothing', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: '',
      approx_x: 0,
      approx_y: 0,
      speech_response: null,
      display_mode: 'visual_only',
    })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('nothing here')
    })
    expect(await screen.findByText(/No matching part found/)).toBeInTheDocument()
    expect(screen.getByTestId('dock-status')).toHaveTextContent('No matching part found')
  })

  it('clears the empty-target notice on the next successful scan', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial)
      .mockResolvedValueOnce({
        target_label: '',
        approx_x: 0,
        approx_y: 0,
        speech_response: null,
        display_mode: 'visual_only',
      })
      .mockResolvedValueOnce({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('nothing here')
    })
    expect(await screen.findByText(/No matching part found/)).toBeInTheDocument()
    await act(async () => {
      assistants[0].callbacks.onPhrase('show screws')
    })
    expect(await screen.findByText('Screw')).toBeInTheDocument()
    expect(screen.queryByText(/No matching part found/)).not.toBeInTheDocument()
  })

  it('shows a motion-safe analyzing indicator while reasoning is in flight', async () => {
    mockCamera(true)
    let release!: (value: SpatialResult) => void
    vi.mocked(reasonSpatial).mockImplementationOnce(
      () =>
        new Promise<SpatialResult>((resolve) => {
          release = resolve
        }),
    )
    render(<Scanner />)
    await act(async () => {
      assistants[0].callbacks.onPhrase('go')
    })
    const indicator = screen.getByText('Analyzing…')
    expect(indicator).toBeInTheDocument()
    expect(indicator).toHaveClass('self-center')
    expect(indicator.querySelector('span')).toHaveClass('motion-safe:animate-pulse')
    expect(screen.getByText('Analyzing…')).toBeInTheDocument()
    await act(async () => {
      release({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
    })
    expect(await screen.findByText('Screw')).toBeInTheDocument()
    expect(screen.queryByText('Analyzing…')).not.toBeInTheDocument()
  })
})

describe('Scanner freeze frame', () => {
  async function waitForLive(): Promise<void> {
    // Camera init is microtasks only (no timers), so this drains under
    // both real and fake timers.
    for (let i = 0; i < 100 && !screen.queryByText('LIVE'); i++) {
      await act(async () => {})
    }
    expect(screen.getByText('LIVE')).toBeInTheDocument()
  }

  async function freezeFrame(): Promise<void> {
    await waitForLive()
    pressFreezeFrame()
  }

  function tapTarget(): HTMLElement {
    return screen.getByLabelText('Circle or tap to identify a part')
  }

  function setTapRect(
    el: HTMLElement,
    rect: { left: number; top: number; width: number; height: number } = {
      left: 0,
      top: 0,
      width: 640,
      height: 480,
    },
  ): void {
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({
        ...rect,
        x: rect.left,
        y: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        toJSON: () => ({}),
      }),
      configurable: true,
    })
  }

  function maskRecord(box: MaskRecord['box'], objectId = '0'): MaskRecord {
    return {
      frame: 0,
      ordinal: 0,
      objectId,
      box,
      raster: Uint8Array.from([1, 0, 0, 0]),
    }
  }

  it('shows the tap layer while the feed is live', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await waitForLive()
      const layer = tapTarget()
      expect(layer).toBeInTheDocument()
      expect(layer.className).toContain('focus-visible:ring-2')
    } finally {
      media.restore()
    }
  })

  it('freezing pauses the video and stops refresh ticks while masks persist', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      const { stream, stop } = trackedStream()
      mockCameraWithStream(stream)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(screen.getByText('Screw')).toBeInTheDocument()
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await freezeFrame()
      // Freeze snapshots a still and stops the tracks; the video is never paused.
      expect(media.pause).not.toHaveBeenCalled()
      expect(stop).toHaveBeenCalledTimes(1)
      expect(getVideo(container).srcObject).toBeNull()
      expect(screen.getByAltText('Frozen frame')).toBeInTheDocument()
      expect(screen.getByText('FROZEN')).toBeInTheDocument()
      expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Screw')).toBeInTheDocument()
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('resuming wipes AR annotations without re-arming refresh', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(screen.getByText('Screw')).toBeInTheDocument()
      expect(screen.getByText('Tracking')).toBeInTheDocument()
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await freezeFrame()
      expect(screen.getByText('Screw')).toBeInTheDocument()
      // Frozen-scene paint is stale once live: the wipe forces a full clear.
      const clearRect = vi.fn()
      const ctxSpy = vi
        .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ clearRect } as unknown as CanvasRenderingContext2D)
      try {
        pressFreezeFrame()
        await waitForLive()
      } finally {
        ctxSpy.mockRestore()
      }
      expect(clearRect).toHaveBeenCalledWith(0, 0, 640, 480)
      expect(screen.queryByText('Screw')).not.toBeInTheDocument()
      expect(screen.queryByText('Tracking')).not.toBeInTheDocument()
      expect(
        getLogs().some((e) => e.message.includes('frame live — AR annotations cleared')),
      ).toBe(true)
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('resuming without a tracked target does not re-arm refresh', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      render(<Scanner />)
      await freezeFrame()
      pressFreezeFrame()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(segmentImage).not.toHaveBeenCalled()
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('outlines the tapped part, names it, speaks it, and pushes memory', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      openOverflow()
      fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
      await act(async () => {})
      const layer = tapTarget()
      expect(layer).toHaveClass('cursor-crosshair', 'z-[5]')
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
        maskRecord({ x1: 0, y1: 0, x2: 9, y2: 9, w: 10, h: 10 }, '1'),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(segmentImage).toHaveBeenCalledWith('data:image/jpeg;base64,AAA', 'tapped part', {
        x: 320,
        y: 220,
        width: 640,
        height: 480,
      })
      // The largest mask wins the crop.
      expect(cropRegion).toHaveBeenCalledTimes(1)
      expect(vi.mocked(cropRegion).mock.calls[0][1]).toEqual({
        x1: 300,
        y1: 200,
        x2: 340,
        y2: 240,
        w: 41,
        h: 41,
      })
      expect(identifyComponent).toHaveBeenCalledWith('data:image/jpeg;base64,CROP')
      const pill = await screen.findByText('M6 hex bolt')
      expect(pill.getAttribute('style')).toContain('left: 50%')
      expect(speakText).toHaveBeenCalledWith('M6 hex bolt')
      expect(assistants[0].pushMemory).toHaveBeenCalledWith({
        phrase: 'tap to outline',
        label: 'M6 hex bolt',
        x: 50,
        y: (220 / 480) * 100,
      })
    } finally {
      media.restore()
    }
  })

  it('identifies the layer center on keyboard activation', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.keyDown(layer, { key: 'Enter' })
      })
      expect(segmentImage).toHaveBeenCalledWith('data:image/jpeg;base64,AAA', 'tapped part', {
        x: 320,
        y: 240,
        width: 640,
        height: 480,
      })
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('treats Space like Enter and ignores other keys', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.keyDown(layer, { key: ' ' })
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        fireEvent.keyDown(layer, { key: 'a' })
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('keeps a cyan outline with fallback speech for unknown parts', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      vi.mocked(identifyComponent).mockResolvedValue('')
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      openOverflow()
      fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
      await act(async () => {})
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      const pill = await screen.findByText('Unknown part')
      const style = pill.querySelector('span')?.getAttribute('style') ?? ''
      expect(style.includes('#00ffff') || style.includes('rgb(0, 255, 255)')).toBe(true)
      const calls = vi.mocked(speakText).mock.calls
      expect(calls[calls.length - 1][0]).toContain('could not identify')
      expect(assistants[0].pushMemory).toHaveBeenCalledWith({
        phrase: 'tap to outline',
        label: 'Unknown part',
        x: 50,
        y: (220 / 480) * 100,
      })
    } finally {
      media.restore()
    }
  })

  it('falls back to a tap-centered crop when SAM returns no masks', async () => {
    const strokeRect = vi.fn()
    const fillRect = vi.fn()
    const drawImage = vi.fn()
    const compositeOps: string[] = []
    const fillStyles: string[] = []
    const ctx = new Proxy(
      { marker: 'ctx', strokeRect, fillRect, drawImage, measureText: () => ({ width: 10 }) },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          return (target as Record<PropertyKey, unknown>)[prop] ?? (() => undefined)
        },
        set: (target, prop, value) => {
          if (prop === 'globalCompositeOperation') compositeOps.push(value as string)
          if (prop === 'fillStyle') fillStyles.push(value as string)
          return Reflect.set(target as object, prop, value)
        },
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    mockCamera(true)
    const media = mockMediaControls()
    try {
      vi.mocked(identifyComponent).mockResolvedValue('Blend door')
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      openOverflow()
      fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
      await act(async () => {})
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([])
      // Freeze snapshots via drawImage: clear it so the not-called assertion
      // below covers only the SAM/identify path.
      drawImage.mockClear()
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(await screen.findByText('Blend door')).toBeInTheDocument()
      expect(cropRegion).toHaveBeenCalledTimes(1)
      const box = vi.mocked(cropRegion).mock.calls[0][1] as MaskRecord['box']
      expect(box.x1).toBeLessThanOrEqual(320)
      expect(box.x2).toBeGreaterThanOrEqual(320)
      expect(box.y1).toBeLessThanOrEqual(220)
      expect(box.y2).toBeGreaterThanOrEqual(220)
      expect(strokeRect).toHaveBeenCalled()
      // Spotlight: full-frame dim plus a mask-less box hole via fillRect.
      expect(fillStyles).toContain('rgba(0, 0, 0, 0.55)')
      expect(fillRect).toHaveBeenCalledWith(0, 0, 640, 480)
      expect(fillRect).toHaveBeenCalledWith(
        box.x1,
        box.y1,
        box.x2 - box.x1 + 1,
        box.y2 - box.y1 + 1,
      )
      expect(drawImage).not.toHaveBeenCalled()
      expect(compositeOps[0]).toBe('destination-out')
      expect(compositeOps[compositeOps.length - 1]).toBe('source-over')
      expect(speakText).toHaveBeenCalledWith('Blend door')
    } finally {
      media.restore()
      ctxSpy.mockRestore()
    }
  })

  it('removes one outline on a 500ms long-press without re-segmenting', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(screen.getByText('M6 hex bolt')).toBeInTheDocument()
      const segments = vi.mocked(segmentImage).mock.calls.length
      await act(async () => {
        fireEvent.pointerDown(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      await act(async () => {
        fireEvent.pointerUp(layer, { clientX: 320, clientY: 220 })
      })
      // The release click is consumed by the long-press.
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(segmentImage).toHaveBeenCalledTimes(segments)
      expect(screen.queryByText('M6 hex bolt')).not.toBeInTheDocument()
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('cancels the long-press when the finger drifts', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    // Deterministic hold duration: the stage's drift branch keys off
    // Date.now() - t0, which fake timers may or may not mock depending on
    // the Vitest version. Pin the clock so the 1000ms hold past the 500ms
    // long-press delay is explicit, not timing-dependent under happy-dom.
    let now = 1_000_000
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      mockCamera(true)
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValue([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(screen.getByText('M6 hex bolt')).toBeInTheDocument()
      const segments = vi.mocked(segmentImage).mock.calls.length
      await act(async () => {
        fireEvent.pointerDown(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        fireEvent.pointerMove(layer, { clientX: 335, clientY: 220 })
      })
      // Simulate the finger resting past the long-press delay while the
      // 15px drift already cancelled the press timer.
      now += 1000
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      await act(async () => {
        fireEvent.pointerUp(layer, { clientX: 335, clientY: 220 })
      })
      await act(async () => {
        fireEvent.click(layer, { clientX: 335, clientY: 220 })
      })
      // No removal; the drifted release is neither a tap nor a circle.
      expect(segmentImage).toHaveBeenCalledTimes(segments)
      expect(screen.getByText('M6 hex bolt')).toBeInTheDocument()
    } finally {
      dateSpy.mockRestore()
      media.restore()
      vi.useRealTimers()
    }
  })

  it('does not fetch guides for frozen-frame taps', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
      expect(searchGuides).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('numbers re-added outlines uniquely after a removal', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    const fillText = vi.fn()
    const ctx = new Proxy(
      { marker: 'ctx', fillText, measureText: () => ({ width: 10 }) },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          const value = (target as Record<PropertyKey, unknown>)[prop]
          return value ?? (() => undefined)
        },
        set: () => true,
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    try {
      mockCamera(true)
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream)
        .mockResolvedValueOnce([
          maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
        ])
        .mockResolvedValueOnce([
          maskRecord({ x1: 80, y1: 80, x2: 120, y2: 120, w: 41, h: 41 }),
        ])
        .mockResolvedValueOnce([
          maskRecord({ x1: 500, y1: 300, x2: 540, y2: 340, w: 41, h: 41 }),
        ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        fireEvent.click(layer, { clientX: 100, clientY: 100 })
      })
      await act(async () => {
        fireEvent.pointerDown(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      await act(async () => {
        fireEvent.pointerUp(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        fireEvent.click(layer, { clientX: 520, clientY: 320 })
      })
      expect(fillText).toHaveBeenCalledWith('3', expect.any(Number), expect.any(Number))
    } finally {
      ctxSpy.mockRestore()
      media.restore()
      vi.useRealTimers()
    }
  })

  it('ignores taps while a tap analysis is in flight', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      let release!: (value: MaskRecord[]) => void
      vi.mocked(parseSamStream).mockImplementationOnce(
        () =>
          new Promise<MaskRecord[]>((resolve) => {
            release = resolve
          }),
      )
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        fireEvent.click(layer, { clientX: 100, clientY: 100 })
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        release([])
      })
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('ignores taps without an API key', async () => {
    vi.stubEnv('VITE_META_MODEL_API_KEY', '')
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(segmentImage).not.toHaveBeenCalled()
      expect(identifyComponent).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('resumes the feed when flipping cameras while frozen', async () => {
    const { stream } = trackedStream()
    const getUserMedia = mockCameraWithStream(stream)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      await freezeFrame()
      expect(screen.getByText('FROZEN')).toBeInTheDocument()
      expect(screen.getByAltText('Frozen frame')).toBeInTheDocument()
      expect(getUserMedia).toHaveBeenCalledTimes(1)
      openOverflow()
      fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
      // Flip clears the still at once and re-acquires exactly once.
      expect(screen.queryByText('FROZEN')).not.toBeInTheDocument()
      expect(screen.queryByAltText('Frozen frame')).not.toBeInTheDocument()
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      expect(getUserMedia).toHaveBeenCalledTimes(2)
    } finally {
      media.restore()
    }
  })

  it('moves through analyzing, speaking, and listening on a tap', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      let releaseMasks!: (value: MaskRecord[]) => void
      vi.mocked(parseSamStream).mockImplementationOnce(
        () =>
          new Promise<MaskRecord[]>((resolve) => {
            releaseMasks = resolve
          }),
      )
      let releaseSpeak!: () => void
      vi.mocked(speakText).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSpeak = resolve
          }),
      )
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      openOverflow()
      fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
      expect(await screen.findByText('Listening')).toBeInTheDocument()
      await waitForLive()
      pressFreezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(screen.getByText('Analyzing…')).toBeInTheDocument()
      await act(async () => {
        releaseMasks([maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 })])
      })
      expect(await screen.findByText('Speaking')).toBeInTheDocument()
      await act(async () => {
        releaseSpeak()
      })
      expect(await screen.findByText('Listening')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('maps taps through the zoom stage to the tapped media pixel', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      wheelZoomIn()
      // 1.2x: the 640x480 view reports a 768x576 transformed box.
      const layer = tapTarget()
      setTapRect(layer, { left: 0, top: 0, width: 768, height: 576 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 384, clientY: 288 })
      })
      expect(segmentImage).toHaveBeenCalledWith(
        'data:image/jpeg;base64,AAA',
        'tapped part',
        { x: 320, y: 240, width: 640, height: 480 },
      )
    } finally {
      media.restore()
    }
  })

  it('mirrors the feed, still, and overlay canvas on desktop', async () => {
    vi.mocked(useDesktopLayout).mockReturnValue(true)
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      expect(screen.getByLabelText('Live camera feed')).toHaveClass('-scale-x-100')
      expect(container.querySelector('canvas')).toHaveClass('-scale-x-100')
      setVideoDims(container, 640, 480)
      await freezeFrame()
      expect(screen.getByAltText('Frozen frame')).toHaveClass('-scale-x-100')
    } finally {
      media.restore()
    }
  })

  it('flips desktop tap prompts to raw-frame pixels', async () => {
    vi.mocked(useDesktopLayout).mockReturnValue(true)
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer, { left: 0, top: 0, width: 320, height: 240 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 80, clientY: 120 })
      })
      // A quarter across the mirrored stage is three quarters across the frame.
      expect(segmentImage).toHaveBeenCalledWith(
        'data:image/jpeg;base64,AAA',
        'tapped part',
        { x: 480, y: 240, width: 640, height: 480 },
      )
    } finally {
      media.restore()
    }
  })

  it('counter-flips badge glyphs on the mirrored desktop canvas', async () => {
    vi.mocked(useDesktopLayout).mockReturnValue(true)
    mockCamera(true)
    const media = mockMediaControls()
    const calls: Array<[string, unknown[]]> = []
    const ctx = new Proxy(
      { marker: 'ctx' },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          if (prop === 'measureText') {
            return () => ({ width: 12 })
          }
          if (typeof prop !== 'string') return undefined
          const value = (target as Record<PropertyKey, unknown>)[prop]
          if (typeof value !== 'undefined') return value
          return (...args: unknown[]) => {
            calls.push([prop, args])
          }
        },
        set: () => true,
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer, { left: 0, top: 0, width: 320, height: 240 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 80, clientY: 120 })
      })
      // The badge still draws, but mirrored in backing-store pixels so the
      // CSS flip restores readable glyphs on screen.
      expect(calls).toContainEqual(['fillText', ['1', expect.any(Number), expect.any(Number)]])
      expect(calls).toContainEqual(['translate', [expect.any(Number), 0]])
      expect(calls).toContainEqual(['scale', [-1, 1]])
    } finally {
      ctxSpy.mockRestore()
      media.restore()
    }
  })

  it('paints badge glyphs unflipped on the unmirrored canvas', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    const calls: Array<[string, unknown[]]> = []
    const ctx = new Proxy(
      { marker: 'ctx' },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          if (prop === 'measureText') {
            return () => ({ width: 12 })
          }
          if (typeof prop !== 'string') return undefined
          const value = (target as Record<PropertyKey, unknown>)[prop]
          if (typeof value !== 'undefined') return value
          return (...args: unknown[]) => {
            calls.push([prop, args])
          }
        },
        set: () => true,
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer, { left: 0, top: 0, width: 320, height: 240 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 80, clientY: 120 })
      })
      expect(calls).toContainEqual(['fillText', ['1', expect.any(Number), expect.any(Number)]])
      expect(calls).not.toContainEqual(['scale', [-1, 1]])
    } finally {
      ctxSpy.mockRestore()
      media.restore()
    }
  })

  it('suppresses the tap when a zoomed drag traces instead', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      wheelZoomIn()
      const layer = tapTarget()
      setTapRect(layer)
      fireEvent.pointerDown(layer, { pointerId: 1, clientX: 320, clientY: 220 })
      fireEvent.pointerMove(layer, { pointerId: 1, clientX: 200, clientY: 220 })
      fireEvent.pointerUp(layer, { pointerId: 1, clientX: 200, clientY: 220 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 200, clientY: 220 })
      })
      expect(segmentImage).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('still outlines when the drift stays below the pan threshold', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      wheelZoomIn()
      const layer = tapTarget()
      setTapRect(layer, { left: 0, top: 0, width: 768, height: 576 })
      fireEvent.pointerDown(layer, { pointerId: 1, clientX: 384, clientY: 288 })
      fireEvent.pointerMove(layer, { pointerId: 1, clientX: 388, clientY: 288 })
      fireEvent.pointerUp(layer, { pointerId: 1, clientX: 388, clientY: 288 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 388, clientY: 288 })
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
    } finally {
      media.restore()
    }
  })

  function setStageDims(w: number, h: number): void {
    const stage = screen.getByTestId('zoom-stage')
    Object.defineProperty(stage, 'clientWidth', { value: w, configurable: true })
    Object.defineProperty(stage, 'clientHeight', { value: h, configurable: true })
  }

  function setStageRect(rect: { left: number; top: number; width: number; height: number }): void {
    const stage = screen.getByTestId('zoom-stage')
    Object.defineProperty(stage, 'getBoundingClientRect', {
      value: () => ({
        ...rect,
        x: rect.left,
        y: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        toJSON: () => ({}),
      }),
      configurable: true,
    })
  }

  function traceLoop(layer: HTMLElement, x1: number, y1: number, x2: number, y2: number): void {
    fireEvent.pointerDown(layer, { pointerId: 1, clientX: x1, clientY: y1 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: x2, clientY: y1 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: x2, clientY: y2 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: x1, clientY: y2 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: x1, clientY: y1 })
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: x1, clientY: y1 })
  }

  it('identifies the circled region with a box prompt', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      setStageDims(320, 240)
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        traceLoop(layer, 100, 100, 200, 200)
      })
      expect(segmentImage).toHaveBeenCalledWith(
        'data:image/jpeg;base64,AAA',
        'circled part',
        undefined,
        { x1: 200, y1: 200, x2: 400, y2: 400, width: 640, height: 480 },
      )
      expect(cropRegion).toHaveBeenCalledWith(
        expect.anything(),
        { x1: 200, y1: 200, x2: 400, y2: 400 },
        0.2,
      )
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
      expect(assistants[0].pushMemory).toHaveBeenCalledWith({
        phrase: 'circle to identify',
        label: 'M6 hex bolt',
        x: 46.875,
        y: 62.5,
      })
    } finally {
      media.restore()
    }
  })

  it('draws the trace trail while circling and clears it on release', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      setStageDims(320, 240)
      const layer = tapTarget()
      fireEvent.pointerDown(layer, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(layer, { pointerId: 1, clientX: 200, clientY: 100 })
      const trail = screen.getByTestId('trace-trail')
      expect(trail.querySelector('polyline')?.getAttribute('points')).toBe(
        '100.0,100.0 200.0,100.0',
      )
      await act(async () => {
        fireEvent.pointerUp(layer, { pointerId: 1, clientX: 200, clientY: 100 })
      })
      expect(screen.queryByTestId('trace-trail')).not.toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('maps the circled region through the zoom stage', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      setStageDims(320, 240)
      wheelZoomIn()
      // 1.2x around (100,100) pans to (-20,-20): the transformed box
      // starts there at 384x288.
      setStageRect({ left: -20, top: -20, width: 384, height: 288 })
      const layer = tapTarget()
      await act(async () => {
        traceLoop(layer, 100, 100, 220, 220)
      })
      // Client coords divide back to the (100,100)-(200,200) loop.
      expect(segmentImage).toHaveBeenCalledWith(
        'data:image/jpeg;base64,AAA',
        'circled part',
        undefined,
        { x1: 200, y1: 200, x2: 400, y2: 400, width: 640, height: 480 },
      )
    } finally {
      media.restore()
    }
  })

  it('cancels the circle when a second finger starts a pinch', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      setStageDims(320, 240)
      const layer = tapTarget()
      fireEvent.pointerDown(layer, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(layer, { pointerId: 1, clientX: 200, clientY: 100 })
      expect(screen.getByTestId('trace-trail')).toBeInTheDocument()
      fireEvent.pointerDown(layer, { pointerId: 2, clientX: 250, clientY: 100 })
      expect(screen.queryByTestId('trace-trail')).not.toBeInTheDocument()
      fireEvent.pointerMove(layer, { pointerId: 2, clientX: 300, clientY: 100 })
      fireEvent.pointerUp(layer, { pointerId: 2, clientX: 300, clientY: 100 })
      fireEvent.pointerUp(layer, { pointerId: 1, clientX: 200, clientY: 100 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 200, clientY: 100 })
      })
      expect(segmentImage).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('retries a failed tap identify with a wide-context crop', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      vi.mocked(identifyComponent).mockRejectedValueOnce(new Error('boom'))
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
      expect(identifyComponent).toHaveBeenCalledTimes(2)
      expect(vi.mocked(cropRegion).mock.calls[1][2]).toBe(1.0)
    } finally {
      media.restore()
    }
  })

  it('shows the circle hint while live and frozen', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      // Freezing needs a real frame: zero-dimension video refuses.
      setVideoDims(container, 640, 480)
      expect(screen.queryByText('Drag to circle a part · tap to identify')).not.toBeInTheDocument()
      await waitForLive()
      expect(screen.getByText('Drag to circle a part · tap to identify')).toBeInTheDocument()
      pressFreezeFrame()
      expect(await screen.findByText('FROZEN')).toBeInTheDocument()
      expect(screen.getByText('Drag to circle a part · tap to identify')).toBeInTheDocument()
      pressFreezeFrame()
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      expect(screen.getByText('Drag to circle a part · tap to identify')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('rotates coach-mark hints every 8 seconds while live', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      render(<Scanner />)
      await waitForLive()
      // The voice hint only rotates once the one-time coach is dismissed.
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss voice tip' }))
      expect(screen.getByText('Drag to circle a part · tap to identify')).toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(8000)
      })
      expect(screen.getByText('Hold an outline to remove it')).toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(8000)
      })
      expect(screen.getByText('Pinch back to 1x to circle a part')).toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(8000)
      })
      expect(screen.getByText('Voice mode lives in the ⋯ menu')).toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(8000)
      })
      expect(screen.getByText('Drag to circle a part · tap to identify')).toBeInTheDocument()
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('rotates the voice hint out while the coach mark is visible', async () => {
    window.localStorage.removeItem('wrenchmind.voiceCoachSeen')
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      render(<Scanner />)
      await waitForLive()
      expect(screen.getByText(/Voice mode is in the/)).toBeInTheDocument()
      // Six rotations: the voice hint never appears alongside the coach.
      for (let i = 0; i < 6; i++) {
        expect(screen.queryByText('Voice mode lives in the ⋯ menu')).not.toBeInTheDocument()
        await act(async () => {
          vi.advanceTimersByTime(8000)
        })
      }
      expect(screen.queryByText('Voice mode lives in the ⋯ menu')).not.toBeInTheDocument()
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('sends capture-space prompts and remaps records on 4K video (circle)', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 3840, 2160)
      await freezeFrame()
      setStageDims(320, 240)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 690, y1: 450, x2: 1140, y2: 900, w: 451, h: 451 }),
      ])
      const layer = tapTarget()
      await act(async () => {
        traceLoop(layer, 100, 100, 200, 200)
      })
      // Prompt describes the 1920x1080 attached image, not the 4K frame.
      expect(segmentImage).toHaveBeenCalledWith(
        'data:image/jpeg;base64,AAA',
        'circled part',
        undefined,
        { x1: 690, y1: 450, x2: 1140, y2: 900, width: 1920, height: 1080 },
      )
      // The capture-space mask maps back to video pixels (±1px round-trip).
      expect(cropRegion).toHaveBeenCalledWith(
        expect.anything(),
        { x1: 1380, y1: 900, x2: 2281, y2: 1801, w: 902, h: 902 },
        0.2,
      )
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('sends capture-space point prompts on 4K video (tap)', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 3840, 2160)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 240 })
      })
      expect(segmentImage).toHaveBeenCalledWith(
        'data:image/jpeg;base64,AAA',
        'tapped part',
        { x: 960, y: 540, width: 1920, height: 1080 },
      )
    } finally {
      media.restore()
    }
  })

  it('stops every track and clears srcObject when freezing', async () => {
    const { stream, stop } = trackedStream()
    mockCameraWithStream(stream)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      expect(stop).toHaveBeenCalledTimes(1)
      expect(getVideo(container).srcObject).toBeNull()
      expect(media.pause).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('re-acquires the camera with getUserMedia on unfreeze', async () => {
    const { stream } = trackedStream()
    const getUserMedia = mockCameraWithStream(stream)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      expect(getUserMedia).toHaveBeenCalledTimes(1)
      pressFreezeFrame()
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      expect(getUserMedia).toHaveBeenCalledTimes(2)
    } finally {
      media.restore()
    }
  })

  it('renders the frozen still while frozen and clears it once live', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await waitForLive()
      expect(screen.queryByAltText('Frozen frame')).not.toBeInTheDocument()
      pressFreezeFrame()
      expect(screen.getByAltText('Frozen frame')).toBeInTheDocument()
      pressFreezeFrame()
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      expect(screen.queryByAltText('Frozen frame')).not.toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('identifies a frozen tap against the still with the stream stopped', async () => {
    const { stream, stop } = trackedStream()
    mockCameraWithStream(stream)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      expect(stop).toHaveBeenCalledTimes(1)
      expect(getVideo(container).srcObject).toBeNull()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
      // The frame source is the still canvas, not the video element.
      const frameEl = vi.mocked(captureVideoFrame).mock.calls[0][0] as HTMLElement
      expect(frameEl.tagName).toBe('CANVAS')
      const cropEl = vi.mocked(cropRegion).mock.calls[0][0] as HTMLElement
      expect(cropEl.tagName).toBe('CANVAS')
    } finally {
      media.restore()
    }
  })

  it('keeps the still with an error when camera restart fails', async () => {
    const getUserMedia = vi.fn(async (): Promise<MediaStream> => {
      // First call opens the camera; every re-acquire attempt fails.
      if (getUserMedia.mock.calls.length > 1) throw new Error('denied')
      return FAKE_STREAM
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
      configurable: true,
    })
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      expect(screen.getByAltText('Frozen frame')).toBeInTheDocument()
      pressFreezeFrame()
      // The still is kept (never a black flash) with the failure surfaced.
      expect(await screen.findByRole('alert')).toHaveTextContent('Camera access denied')
      expect(screen.getByAltText('Frozen frame')).toBeInTheDocument()
      expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
      // Failed restart falls back to frozen: the still stays tappable and
      // the toggle is back so unfreezing retries the camera.
      expect(screen.getByText('FROZEN')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Freeze frame' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      const attempts = getUserMedia.mock.calls.length
      pressFreezeFrame()
      await waitFor(() => expect(getUserMedia.mock.calls.length).toBeGreaterThan(attempts))
    } finally {
      media.restore()
    }
  })

  it('forces torch off when freezing', async () => {
    const { stream, applyConstraints } = torchStream()
    mockCameraStream(stream)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      const toggle = await screen.findByRole('button', { name: 'Flashlight' })
      fireEvent.click(toggle)
      await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
      await freezeFrame()
      expect(await screen.findByText('FROZEN')).toBeInTheDocument()
      // Hardware first: torch:false reaches the live track before the
      // tracks stop, so the LED cannot stay on after the camera stops.
      await waitFor(() =>
        expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: false }] }),
      )
      expect(
        getLogs().some((e) => e.message.includes('flashlight off (freeze stopped the camera)')),
      ).toBe(true)
      expect(screen.queryByRole('button', { name: 'Flashlight' })).not.toBeInTheDocument()
      pressFreezeFrame()
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      expect(await screen.findByRole('button', { name: 'Flashlight' })).toHaveAttribute(
        'aria-pressed',
        'false',
      )
    } finally {
      media.restore()
    }
  })

  it('still freezes when the torch-off constraint is rejected', async () => {
    const { stream, applyConstraints } = torchStream()
    mockCameraStream(stream)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      const toggle = await screen.findByRole('button', { name: 'Flashlight' })
      fireEvent.click(toggle)
      await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
      // Only the freeze-time torch-off attempt fails; enabling succeeded.
      applyConstraints.mockRejectedValueOnce(new Error('torch off failed'))
      await freezeFrame()
      expect(await screen.findByText('FROZEN')).toBeInTheDocument()
      await waitFor(() =>
        expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: false }] }),
      )
      expect(screen.queryByRole('button', { name: 'Flashlight' })).not.toBeInTheDocument()
      expect(
        getLogs().some((e) => e.message.includes('flashlight off (freeze stopped the camera)')),
      ).toBe(true)
    } finally {
      media.restore()
    }
  })

  it('freezes an uploaded photo like a camera still', async () => {
    mockCamera(true)
    const still = document.createElement('canvas')
    still.width = 640
    still.height = 480
    vi.mocked(decodePhotoFile).mockResolvedValue(still)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      await screen.findByText('LIVE')
      const file = new File(['bytes'], 'engine.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [file] } })
      expect(vi.mocked(decodePhotoFile)).toHaveBeenCalledWith(file)
      const photo = await screen.findByAltText('Uploaded photo')
      expect(photo).toHaveClass('object-contain')
      // The overlay canvas letterboxes in lockstep so masks stay aligned.
      expect(container.querySelector('canvas')).toHaveClass('object-contain')
      expect(screen.getByText('FROZEN')).toBeInTheDocument()
      expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
      // The uploaded still is tappable exactly like a camera freeze.
      expect(screen.getByLabelText('Circle or tap to identify a part')).toBeInTheDocument()
      expect(
        getLogs().some((e) => e.message.includes('photo added — camera stopped')),
      ).toBe(true)
    } finally {
      media.restore()
    }
  })

  it('shows uploaded photos unmirrored even on desktop', async () => {
    vi.mocked(useDesktopLayout).mockReturnValue(true)
    mockCamera(true)
    const still = document.createElement('canvas')
    still.width = 640
    still.height = 480
    vi.mocked(decodePhotoFile).mockResolvedValue(still)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      await screen.findByText('LIVE')
      expect(screen.getByLabelText('Live camera feed')).toHaveClass('-scale-x-100')
      const file = new File(['bytes'], 'label.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [file] } })
      const photo = await screen.findByAltText('Uploaded photo')
      expect(photo).not.toHaveClass('-scale-x-100')
      expect(container.querySelector('canvas')).not.toHaveClass('-scale-x-100')
    } finally {
      media.restore()
    }
  })

  it('silently ignores taps on the upload letterbox bars', async () => {
    mockCamera(true)
    const still = document.createElement('canvas')
    still.width = 640
    still.height = 480
    vi.mocked(decodePhotoFile).mockResolvedValue(still)
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await screen.findByText('LIVE')
      const file = new File(['bytes'], 'engine.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [file] } })
      await screen.findByAltText('Uploaded photo')
      const layer = tapTarget()
      // Portrait view of a landscape photo: 87.5px bars top and bottom.
      setTapRect(layer, { left: 0, top: 0, width: 300, height: 400 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 150, clientY: 40 })
      })
      expect(segmentImage).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('status', { name: /Located:/ })).not.toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('maps taps on an uploaded photo through the contain letterbox', async () => {
    mockCamera(true)
    const still = document.createElement('canvas')
    still.width = 640
    still.height = 480
    vi.mocked(decodePhotoFile).mockResolvedValue(still)
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await screen.findByText('LIVE')
      const file = new File(['bytes'], 'engine.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [file] } })
      await screen.findByAltText('Uploaded photo')
      const layer = tapTarget()
      // Portrait view of a landscape photo: 87.5px bars top and bottom;
      // the center tap must map to frame center through containToMedia.
      setTapRect(layer, { left: 0, top: 0, width: 300, height: 400 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 150, clientY: 200 })
      })
      expect(segmentImage).toHaveBeenCalledWith('data:image/jpeg;base64,AAA', 'tapped part', {
        x: 320,
        y: 240,
        width: 640,
        height: 480,
      })
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('scales badge chrome for high-res frames', async () => {
    mockCamera(true)
    const writes: Array<[string, unknown]> = []
    const ctx = new Proxy(
      { marker: 'ctx' },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          if (prop === 'measureText') return () => ({ width: 12 })
          return (target as Record<PropertyKey, unknown>)[prop] ?? (() => undefined)
        },
        set: (_target, prop, value) => {
          writes.push([String(prop), value])
          return true
        },
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 1920, 1080)
      await freezeFrame()
      // 1080p frame shown at 400px tall: chrome scales by 2.7x.
      const overlay = container.querySelector('canvas')
      if (!overlay) throw new Error('missing overlay canvas')
      Object.defineProperty(overlay, 'getBoundingClientRect', {
        value: () => ({
          left: 0,
          top: 0,
          width: 711,
          height: 400,
          x: 0,
          y: 0,
          right: 711,
          bottom: 400,
          toJSON: () => ({}),
        }),
        configurable: true,
      })
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 900, y1: 500, x2: 1000, y2: 600, w: 101, h: 101 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
      const widths = writes.filter(([k]) => k === 'lineWidth').map(([, v]) => v as number)
      expect(widths.some((w) => Math.abs(w - 8.1) < 0.01)).toBe(true)
      const blurs = writes.filter(([k]) => k === 'shadowBlur').map(([, v]) => v as number)
      expect(blurs.some((b) => Math.abs(b - 32.4) < 0.05)).toBe(true)
      expect(writes.some(([k, v]) => k === 'font' && String(v).includes('64.8'))).toBe(true)
    } finally {
      media.restore()
      ctxSpy.mockRestore()
    }
  })

  it('keeps the live feed when a photo is unreadable', async () => {
    mockCamera(true)
    vi.mocked(decodePhotoFile).mockRejectedValue(new Error('Could not read that photo.'))
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await screen.findByText('LIVE')
      const file = new File(['bytes'], 'engine.heic', { type: 'image/heic' })
      fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [file] } })
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not read that photo')
      expect(screen.queryByAltText('Uploaded photo')).not.toBeInTheDocument()
      expect(screen.getByText('LIVE')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('keeps camera freezes full-bleed cover', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      expect(screen.getByAltText('Frozen frame')).toHaveClass('object-cover')
      expect(container.querySelector('canvas')).toHaveClass('object-cover')
    } finally {
      media.restore()
    }
  })

  it('unfreezing after a tap wipes paint, callout, and tracking with no further ticks', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(screen.getByText('Screw')).toBeInTheDocument()
      expect(screen.getByText('Tracking')).toBeInTheDocument()
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(screen.getByText('M6 hex bolt')).toBeInTheDocument()
      const segments = vi.mocked(segmentImage).mock.calls.length
      expect(segments).toBe(2)
      const clearRect = vi.fn()
      const ctxSpy = vi
        .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ clearRect } as unknown as CanvasRenderingContext2D)
      try {
        pressFreezeFrame()
        await waitForLive()
      } finally {
        ctxSpy.mockRestore()
      }
      expect(clearRect).toHaveBeenCalledWith(0, 0, 640, 480)
      expect(screen.queryByText('M6 hex bolt')).not.toBeInTheDocument()
      expect(screen.queryByText('Tracking')).not.toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(segmentImage).toHaveBeenCalledTimes(segments)
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('preserves guidance HUD and findings chips across unfreeze', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      vi.mocked(fetchGuidance).mockResolvedValue(validGuidanceFixture)
      vi.mocked(extractLabelText).mockResolvedValue(['ABC-123'])
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(await screen.findByText('Remove the belt cover')).toBeInTheDocument()
      await act(async () => {
        assistants[0].callbacks.onPhrase('read this label')
      })
      expect(await screen.findByText('ABC-123')).toBeInTheDocument()
      await freezeFrame()
      pressFreezeFrame()
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      // Job data survives; only AR annotations were wiped.
      expect(screen.getByText('Remove the belt cover')).toBeInTheDocument()
      expect(screen.getByText('ABC-123')).toBeInTheDocument()
      expect(screen.queryByText('Screw')).not.toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('drains a queued phrase after a tap analysis finishes', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      let releaseMasks!: (value: MaskRecord[]) => void
      vi.mocked(parseSamStream).mockImplementationOnce(
        () =>
          new Promise<MaskRecord[]>((resolve) => {
            releaseMasks = resolve
          }),
      )
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Bolt',
        approx_x: 80,
        approx_y: 80,
        speech_response: null,
        display_mode: 'visual_only',
      })
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        assistants[0].callbacks.onPhrase('show bolts')
      })
      expect(reasonSpatial).not.toHaveBeenCalled()
      await act(async () => {
        releaseMasks([])
      })
      // The tap held the lock; its finally must release the queued phrase.
      expect(reasonSpatial).toHaveBeenCalledWith(
        ['data:image/jpeg;base64,AAA'],
        'show bolts',
        '',
      )
    } finally {
      media.restore()
    }
  })

  it('drains a queued phrase after a circle analysis finishes', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      let releaseMasks!: (value: MaskRecord[]) => void
      vi.mocked(parseSamStream).mockImplementationOnce(
        () =>
          new Promise<MaskRecord[]>((resolve) => {
            releaseMasks = resolve
          }),
      )
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Bolt',
        approx_x: 80,
        approx_y: 80,
        speech_response: null,
        display_mode: 'visual_only',
      })
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      setStageDims(320, 240)
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        traceLoop(layer, 100, 100, 200, 200)
      })
      await act(async () => {
        assistants[0].callbacks.onPhrase('show bolts')
      })
      expect(reasonSpatial).not.toHaveBeenCalled()
      await act(async () => {
        releaseMasks([])
      })
      expect(reasonSpatial).toHaveBeenCalledWith(
        ['data:image/jpeg;base64,AAA'],
        'show bolts',
        '',
      )
    } finally {
      media.restore()
    }
  })

  it('drops an in-flight tap result after Clear AR View changes the scene', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      let releaseMasks!: (value: MaskRecord[]) => void
      vi.mocked(parseSamStream).mockImplementationOnce(
        () =>
          new Promise<MaskRecord[]>((resolve) => {
            releaseMasks = resolve
          }),
      )
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      openOverflow()
      fireEvent.click(screen.getByText('Clear AR View'))
      await act(async () => {
        releaseMasks([maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 })])
      })
      expect(screen.queryByText('M6 hex bolt')).not.toBeInTheDocument()
      expect(assistants[0].pushMemory).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('uploading a photo clears the previous scene first', async () => {
    mockCamera(true)
    vi.mocked(reasonSpatial).mockResolvedValue({
      target_label: 'Screw',
      approx_x: 10,
      approx_y: 10,
      speech_response: null,
      display_mode: 'visual_only',
    })
    const still = document.createElement('canvas')
    still.width = 640
    still.height = 480
    vi.mocked(decodePhotoFile).mockResolvedValue(still)
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(await screen.findByText('Screw')).toBeInTheDocument()
      expect(screen.getByText('Tracking')).toBeInTheDocument()
      const file = new File(['bytes'], 'engine.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [file] } })
      expect(await screen.findByAltText('Uploaded photo')).toBeInTheDocument()
      expect(screen.queryByText('Screw')).not.toBeInTheDocument()
      expect(screen.queryByText('Tracking')).not.toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('cancels a pending long-press when the release lands off-layer', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(screen.getByText('M6 hex bolt')).toBeInTheDocument()
      const segments = vi.mocked(segmentImage).mock.calls.length
      await act(async () => {
        fireEvent.pointerDown(layer, { clientX: 320, clientY: 220 })
      })
      // Released over another element: the layer never sees pointerup.
      fireEvent.pointerUp(document.body, { clientX: 10, clientY: 10 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      // No stale removal fired...
      expect(screen.getByText('M6 hex bolt')).toBeInTheDocument()
      // ...and the next tap is not swallowed.
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(vi.mocked(segmentImage).mock.calls.length).toBe(segments + 1)
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('frees the next tap after an off-layer release follows a fired long-press', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(screen.getByText('M6 hex bolt')).toBeInTheDocument()
      const segments = vi.mocked(segmentImage).mock.calls.length
      await act(async () => {
        fireEvent.pointerDown(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      // The hold fired: outline removed, release click suppressed.
      expect(screen.queryByText('M6 hex bolt')).not.toBeInTheDocument()
      fireEvent.pointerUp(document.body, { clientX: 10, clientY: 10 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(vi.mocked(segmentImage).mock.calls.length).toBe(segments + 1)
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('does not arm refresh ticks for scans made while frozen', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      vi.mocked(reasonSpatial).mockResolvedValue({
        target_label: 'Screw',
        approx_x: 10,
        approx_y: 10,
        speech_response: null,
        display_mode: 'visual_only',
      })
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await freezeFrame()
      await act(async () => {
        assistants[0].callbacks.onPhrase('show screws')
      })
      expect(screen.getByText('Screw')).toBeInTheDocument()
      expect(segmentImage).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('switches torch off before stopping tracks on unmount', async () => {
    let releaseOff!: () => void
    const offGate = new Promise<void>((resolve) => {
      releaseOff = resolve
    })
    const { stream, applyConstraints } = torchStream(async (constraints?: {
      advanced?: { torch?: boolean }[]
    }) => {
      if (constraints?.advanced?.[0]?.torch === false) await offGate
    })
    const track = stream.getVideoTracks()[0]
    stream.getTracks = () => [track]
    const stop = track.stop as Mock
    mockCameraStream(stream)
    const media = mockMediaControls()
    try {
      const { container, unmount } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      const toggle = await screen.findByRole('button', { name: 'Flashlight' })
      fireEvent.click(toggle)
      await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
      unmount()
      // The hardware constraint is still in flight: nothing stopped yet.
      expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: false }] })
      expect(stop).not.toHaveBeenCalled()
      await act(async () => {
        releaseOff()
      })
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      media.restore()
    }
  })

  it('keeps an uploaded photo fitted when camera restart fails', async () => {
    const getUserMedia = vi.fn(async (): Promise<MediaStream> => {
      if (getUserMedia.mock.calls.length > 1) throw new Error('denied')
      return FAKE_STREAM
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
      configurable: true,
    })
    const still = document.createElement('canvas')
    still.width = 640
    still.height = 480
    vi.mocked(decodePhotoFile).mockResolvedValue(still)
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await screen.findByText('LIVE')
      const file = new File(['bytes'], 'engine.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [file] } })
      expect(await screen.findByAltText('Uploaded photo')).toBeInTheDocument()
      pressFreezeFrame()
      expect(await screen.findByRole('alert')).toHaveTextContent('Camera access denied')
      // Failure falls back to frozen on the kept still — still an upload.
      expect(screen.getByAltText('Uploaded photo')).toBeInTheDocument()
      expect(screen.getByAltText('Uploaded photo')).toHaveClass('object-contain')
      expect(screen.getByText('FROZEN')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('refuses to freeze when the video has no dimensions yet', async () => {
    const { stream, stop } = trackedStream()
    mockCameraWithStream(stream)
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await screen.findByText('LIVE')
      pressFreezeFrame()
      expect(await screen.findByRole('alert')).toHaveTextContent('Camera frame not ready')
      expect(screen.queryByText('FROZEN')).not.toBeInTheDocument()
      expect(screen.getByText('LIVE')).toBeInTheDocument()
      expect(stop).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })
})

describe('Scanner live gestures', () => {
  async function waitForLive(): Promise<void> {
    for (let i = 0; i < 100 && !screen.queryByText('LIVE'); i++) {
      await act(async () => {})
    }
    expect(screen.getByText('LIVE')).toBeInTheDocument()
  }

  function tapTarget(): HTMLElement {
    return screen.getByLabelText('Circle or tap to identify a part')
  }

  function setTapRect(
    el: HTMLElement,
    rect: { left: number; top: number; width: number; height: number } = {
      left: 0,
      top: 0,
      width: 640,
      height: 480,
    },
  ): void {
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({
        ...rect,
        x: rect.left,
        y: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        toJSON: () => ({}),
      }),
      configurable: true,
    })
  }

  function maskRecord(box: MaskRecord['box'], objectId = '0'): MaskRecord {
    return {
      frame: 0,
      ordinal: 0,
      objectId,
      box,
      raster: Uint8Array.from([1, 0, 0, 0]),
    }
  }

  function setStageDims(w: number, h: number): void {
    const stage = screen.getByTestId('zoom-stage')
    Object.defineProperty(stage, 'clientWidth', { value: w, configurable: true })
    Object.defineProperty(stage, 'clientHeight', { value: h, configurable: true })
  }

  function traceLoop(layer: HTMLElement, x1: number, y1: number, x2: number, y2: number): void {
    fireEvent.pointerDown(layer, { pointerId: 1, clientX: x1, clientY: y1 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: x2, clientY: y1 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: x2, clientY: y2 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: x1, clientY: y2 })
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: x1, clientY: y1 })
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: x1, clientY: y1 })
  }

  it('identifies a live tap with outline, badge, and callout', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    const fillText = vi.fn()
    const ctx = new Proxy(
      { marker: 'ctx', fillText, measureText: () => ({ width: 10 }) },
      {
        get: (target, prop) => {
          if (prop === 'createImageData') {
            return (w: number, h: number) => ({
              data: new Uint8ClampedArray(w * h * 4),
              width: w,
              height: h,
            })
          }
          const value = (target as Record<PropertyKey, unknown>)[prop]
          return value ?? (() => undefined)
        },
        set: () => true,
      },
    )
    const ctxSpy = vi
      .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await waitForLive()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(segmentImage).toHaveBeenCalledWith('data:image/jpeg;base64,AAA', 'tapped part', {
        x: 320,
        y: 220,
        width: 640,
        height: 480,
      })
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
      expect(fillText).toHaveBeenCalledWith('1', expect.any(Number), expect.any(Number))
      // The frame source is the live video, not a still canvas.
      const frameEl = vi.mocked(captureVideoFrame).mock.calls[0][0] as HTMLElement
      expect(frameEl.tagName).toBe('VIDEO')
    } finally {
      ctxSpy.mockRestore()
      media.restore()
    }
  })

  it('treats a small live drift as a tap instead of swallowing it', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    // Deterministic tap duration: the drift branch swallows the release
    // only when Date.now() - t0 >= 500ms. Pin the clock so a quick 15px
    // slide can never look like a slipped long-press removal under
    // happy-dom event batching.
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await waitForLive()
      setStageDims(320, 240)
      const layer = tapTarget()
      setTapRect(layer)
      // 15px drift: past the 10px press slop, short of a 24px circle span.
      // A finger tap that slides a little must still identify, not die.
      await act(async () => {
        fireEvent.pointerDown(layer, { pointerId: 1, clientX: 100, clientY: 100 })
        fireEvent.pointerMove(layer, { pointerId: 1, clientX: 115, clientY: 100 })
        fireEvent.pointerUp(layer, { pointerId: 1, clientX: 115, clientY: 100 })
      })
      await act(async () => {
        fireEvent.click(layer, { clientX: 115, clientY: 100 })
      })
      expect(segmentImage).toHaveBeenCalledTimes(1)
    } finally {
      dateSpy.mockRestore()
      media.restore()
    }
  })

  it('identifies a live circle drag at 1x', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await waitForLive()
      setStageDims(320, 240)
      const layer = tapTarget()
      await act(async () => {
        traceLoop(layer, 100, 100, 200, 200)
      })
      expect(segmentImage).toHaveBeenCalledWith(
        'data:image/jpeg;base64,AAA',
        'circled part',
        undefined,
        { x1: 200, y1: 200, x2: 400, y2: 400, width: 640, height: 480 },
      )
      expect(await screen.findByText('M6 hex bolt')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })

  it('suppresses the live tap after a pinch', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await waitForLive()
      const layer = tapTarget()
      setTapRect(layer)
      fireEvent.pointerDown(layer, { pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerDown(layer, { pointerId: 2, clientX: 200, clientY: 100 })
      fireEvent.pointerMove(layer, { pointerId: 2, clientX: 250, clientY: 100 })
      fireEvent.pointerUp(layer, { pointerId: 2, clientX: 250, clientY: 100 })
      fireEvent.pointerUp(layer, { pointerId: 1, clientX: 100, clientY: 100 })
      await act(async () => {
        fireEvent.click(layer, { clientX: 100, clientY: 100 })
      })
      expect(segmentImage).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('pans a zoomed live drag without tracing or identifying', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await waitForLive()
      setStageDims(320, 240)
      wheelZoomIn()
      const stage = screen.getByTestId('zoom-stage')
      expect(stage.getAttribute('style')).toContain('scale(1.2)')
      const layer = tapTarget()
      fireEvent.pointerDown(layer, { pointerId: 1, clientX: 200, clientY: 200 })
      fireEvent.pointerMove(layer, { pointerId: 1, clientX: 150, clientY: 180 })
      fireEvent.pointerUp(layer, { pointerId: 1, clientX: 150, clientY: 180 })
      expect(screen.queryByTestId('trace-trail')).not.toBeInTheDocument()
      expect(segmentImage).not.toHaveBeenCalled()
      // The drag panned the zoomed stage by (-50,-20) instead of tracing.
      expect(stage.getAttribute('style')).toContain('translate(-50px, -20px)')
      // The pan also consumes the release click.
      await act(async () => {
        fireEvent.click(layer, { clientX: 150, clientY: 180 })
      })
      expect(segmentImage).not.toHaveBeenCalled()
    } finally {
      media.restore()
    }
  })

  it('ignores taps when the camera is dead', async () => {
    mockCamera(false)
    render(<Scanner />)
    expect(await screen.findByText('NO FEED')).toBeInTheDocument()
    expect(screen.queryByLabelText('Circle or tap to identify a part')).not.toBeInTheDocument()
    expect(screen.queryByText('Drag to circle a part · tap to identify')).not.toBeInTheDocument()
    expect(segmentImage).not.toHaveBeenCalled()
  })

  it('removes a live outline on long-press without re-segmenting', async () => {
    vi.useFakeTimers()
    const media = mockMediaControls()
    try {
      mockCamera(true)
      const { container } = render(<Scanner />)
      setVideoDims(container, 640, 480)
      await waitForLive()
      const layer = tapTarget()
      setTapRect(layer)
      vi.mocked(parseSamStream).mockResolvedValueOnce([
        maskRecord({ x1: 300, y1: 200, x2: 340, y2: 240, w: 41, h: 41 }),
      ])
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(screen.getByText('M6 hex bolt')).toBeInTheDocument()
      const segments = vi.mocked(segmentImage).mock.calls.length
      await act(async () => {
        fireEvent.pointerDown(layer, { clientX: 320, clientY: 220 })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      await act(async () => {
        fireEvent.pointerUp(layer, { clientX: 320, clientY: 220 })
      })
      // The release click is consumed by the long-press.
      await act(async () => {
        fireEvent.click(layer, { clientX: 320, clientY: 220 })
      })
      expect(segmentImage).toHaveBeenCalledTimes(segments)
      expect(screen.queryByText('M6 hex bolt')).not.toBeInTheDocument()
    } finally {
      media.restore()
      vi.useRealTimers()
    }
  })

  it('shows the gesture hint pill while live', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      render(<Scanner />)
      await waitForLive()
      expect(screen.getByText('Drag to circle a part · tap to identify')).toBeInTheDocument()
    } finally {
      media.restore()
    }
  })
})

describe('Scanner zoom', () => {
  function stageStyle(): string {
    return screen.getByTestId('zoom-stage').getAttribute('style') ?? ''
  }

  it('clamps gesture zoom at 4x', () => {
    mockCamera(true)
    render(<Scanner />)
    wheelZoomIn(8)
    expect(stageStyle()).toContain('scale(4)')
  })

  it('shows a zoom chip that resets to 1x when tapped', () => {
    mockCamera(true)
    render(<Scanner />)
    expect(screen.queryByRole('button', { name: /Reset zoom/ })).not.toBeInTheDocument()
    wheelZoomIn()
    const chip = screen.getByRole('button', { name: 'Reset zoom (currently 1.2x)' })
    expect(chip).toHaveTextContent('1.2× · tap to reset')
    expect(chip).toHaveClass('min-h-[44px]')
    expect(chip.className).toContain('focus-visible:ring-2')
    fireEvent.click(chip)
    expect(stageStyle()).toContain('scale(1)')
    expect(screen.queryByRole('button', { name: /Reset zoom/ })).not.toBeInTheDocument()
  })

  it('zooms at the cursor with the wheel and ignores ctrl-wheel', () => {
    mockCamera(true)
    render(<Scanner />)
    const stage = screen.getByTestId('zoom-stage')
    fireEvent.wheel(stage, { deltaY: -100, clientX: 100, clientY: 100 })
    expect(stageStyle()).toContain('scale(1.2)')
    // jsdom has no WheelEvent: the fallback Event drops ctrlKey, so set it
    // explicitly to exercise the browser page-zoom passthrough branch.
    const ctrlWheel = createEvent.wheel(stage, { deltaY: -100, clientX: 100, clientY: 100 })
    Object.defineProperty(ctrlWheel, 'ctrlKey', { value: true })
    fireEvent(stage, ctrlWheel)
    expect(stageStyle()).toContain('scale(1.2)')
    fireEvent.wheel(stage, { deltaY: 100, clientX: 100, clientY: 100 })
    expect(stageStyle()).toContain('scale(1)')
  })

  it('ignores meta-wheel so browser zoom keeps working', () => {
    mockCamera(true)
    render(<Scanner />)
    const stage = screen.getByTestId('zoom-stage')
    const metaWheel = createEvent.wheel(stage, { deltaY: -100, clientX: 100, clientY: 100 })
    Object.defineProperty(metaWheel, 'metaKey', { value: true })
    fireEvent(stage, metaWheel)
    expect(stageStyle()).toContain('scale(1)')
  })

  it('pinch-zooms around the gesture midpoint', () => {
    mockCamera(true)
    render(<Scanner />)
    const stage = screen.getByTestId('zoom-stage')
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 300, clientY: 100 })
    expect(stageStyle()).toContain('scale(2)')
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 300, clientY: 100 })
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 100 })
  })

  it('resets zoom when switching cameras', async () => {
    mockCamera(true)
    render(<Scanner />)
    wheelZoomIn()
    expect(stageStyle()).toContain('scale(1.2)')
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    await waitFor(() => expect(stageStyle()).toContain('scale(1)'))
  })

  it('keeps zoom across freeze and unfreeze', async () => {
    mockCamera(true)
    const media = mockMediaControls()
    try {
      const { container } = render(<Scanner />)
      // Freezing needs a real frame: zero-dimension video refuses.
      setVideoDims(container, 640, 480)
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      wheelZoomIn()
      pressFreezeFrame()
      expect(await screen.findByText('FROZEN')).toBeInTheDocument()
      expect(stageStyle()).toContain('scale(1.2)')
      pressFreezeFrame()
      expect(await screen.findByText('LIVE')).toBeInTheDocument()
      expect(stageStyle()).toContain('scale(1.2)')
    } finally {
      media.restore()
    }
  })
})

describe('tapToMedia', () => {
  it('maps centered taps without cropping', () => {
    expect(
      tapToMedia(160, 120, { left: 0, top: 0, width: 320, height: 240 }, 640, 480),
    ).toEqual({
      point: { x: 320, y: 240, width: 640, height: 480 },
      x: 50,
      y: 50,
    })
  })

  it('inverts the centered crop of a portrait frame in a landscape view', () => {
    const tap = tapToMedia(200, 150, { left: 0, top: 0, width: 400, height: 300 }, 480, 640)
    expect(tap?.point).toEqual({ x: 240, y: 320, width: 480, height: 640 })
    expect(tap?.x).toBe(50)
    expect(tap?.y).toBe(50)
  })

  it('inverts the centered crop of a landscape frame in a portrait view', () => {
    const tap = tapToMedia(150, 200, { left: 0, top: 0, width: 300, height: 400 }, 640, 480)
    expect(tap?.point).toEqual({ x: 320, y: 240, width: 640, height: 480 })
    expect(tap?.x).toBe(50)
    expect(tap?.y).toBe(50)
  })

  it('inverts the letterboxed fit of a landscape frame in a portrait view', () => {
    // Contain: 640x480 in 300x400 scales by 0.46875 to 300x225, centered
    // with 87.5px bars top and bottom. Center tap hits frame center.
    const tap = tapToMedia(
      150,
      200,
      { left: 0, top: 0, width: 300, height: 400 },
      640,
      480,
      1,
      false,
      'contain',
    )
    expect(tap?.point).toEqual({ x: 320, y: 240, width: 640, height: 480 })
    expect(tap?.x).toBe(50)
    expect(tap?.y).toBe(50)
  })

  it('ignores taps on contain letterbox bars', () => {
    // Contain: 640x480 in 300x400 leaves 87.5px bars top/bottom. Bar taps
    // resolve undefined so the caller can silently ignore them.
    expect(
      tapToMedia(150, 40, { left: 0, top: 0, width: 300, height: 400 }, 640, 480, 1, false, 'contain'),
    ).toBeUndefined()
    expect(
      tapToMedia(150, 380, { left: 0, top: 0, width: 300, height: 400 }, 640, 480, 1, false, 'contain'),
    ).toBeUndefined()
  })

  it('ignores taps on contain side bars', () => {
    // Contain: 480x640 in 400x300 scales by 0.46875 to 225x300, centered
    // with 87.5px bars left and right.
    expect(
      tapToMedia(40, 150, { left: 0, top: 0, width: 400, height: 300 }, 480, 640, 1, false, 'contain'),
    ).toBeUndefined()
  })

  it('clamps out-of-frame taps into the media bounds', () => {
    expect(
      tapToMedia(-50, 1000, { left: 0, top: 0, width: 320, height: 240 }, 640, 480),
    ).toEqual({
      point: { x: 0, y: 479, width: 640, height: 480 },
      x: 0,
      y: 100,
    })
  })

  it('returns undefined without media or element dimensions', () => {
    const rect = { left: 0, top: 0, width: 320, height: 240 }
    expect(tapToMedia(10, 10, rect, 0, 480)).toBeUndefined()
    expect(tapToMedia(10, 10, rect, 640, 0)).toBeUndefined()
    expect(
      tapToMedia(10, 10, { left: 0, top: 0, width: 0, height: 240 }, 640, 480),
    ).toBeUndefined()
  })

  it('treats an explicit 1x stage scale as the identity', () => {
    expect(
      tapToMedia(160, 120, { left: 0, top: 0, width: 320, height: 240 }, 640, 480, 1),
    ).toEqual({
      point: { x: 320, y: 240, width: 640, height: 480 },
      x: 50,
      y: 50,
    })
  })

  it('inverts the stage scale for a zoomed, unpanned view', () => {
    // 320x240 view at 2x: the 640x480 transformed box shows media center-left.
    const tap = tapToMedia(320, 240, { left: 0, top: 0, width: 640, height: 480 }, 640, 480, 2)
    expect(tap?.point).toEqual({ x: 320, y: 240, width: 640, height: 480 })
    expect(tap?.x).toBe(50)
    expect(tap?.y).toBe(50)
  })

  it('resolves taps under zoom with pan from the transformed rect', () => {
    // Same 2x stage panned 100px left: client (60, 120) sits a quarter across.
    const tap = tapToMedia(60, 120, { left: -100, top: 0, width: 640, height: 480 }, 640, 480, 2)
    expect(tap?.point).toEqual({ x: 160, y: 120, width: 640, height: 480 })
    expect(tap?.x).toBe(25)
    expect(tap?.y).toBe(25)
  })

  it('combines the stage scale with the object-cover crop', () => {
    // Portrait 480x640 frame in a 400x300 view at 2x (800x600 transformed).
    const tap = tapToMedia(400, 300, { left: 0, top: 0, width: 800, height: 600 }, 480, 640, 2)
    expect(tap?.point).toEqual({ x: 240, y: 320, width: 480, height: 640 })
    expect(tap?.x).toBe(50)
    expect(tap?.y).toBe(50)
  })

  it('returns undefined for a non-positive stage scale', () => {
    const rect = { left: 0, top: 0, width: 640, height: 480 }
    expect(tapToMedia(10, 10, rect, 640, 480, 0)).toBeUndefined()
    expect(tapToMedia(10, 10, rect, 640, 480, -2)).toBeUndefined()
  })

  it('mirrors the prompt against the stage width when the feed is flipped', () => {
    // Tap a quarter across the displayed stage: the raw frame holds that
    // content three quarters across, while the callout stays at the tap.
    const tap = tapToMedia(80, 120, { left: 0, top: 0, width: 320, height: 240 }, 640, 480, 1, true)
    expect(tap?.point).toEqual({ x: 480, y: 240, width: 640, height: 480 })
    expect(tap?.x).toBe(25)
    expect(tap?.y).toBe(50)
  })
})

describe('clampZoomPan', () => {
  it('pins pan to zero at 1x', () => {
    expect(clampZoomPan(1, -50, -30, 320, 240)).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('clamps the scale to the 1-4x range', () => {
    expect(clampZoomPan(0.5, 0, 0, 320, 240).scale).toBe(1)
    expect(clampZoomPan(9, 0, 0, 320, 240).scale).toBe(4)
  })

  it('keeps the scaled content covering the viewport', () => {
    // 320x240 at 2x spans [-320, 0] x [-240, 0].
    expect(clampZoomPan(2, 40, 30, 320, 240)).toEqual({ scale: 2, x: 0, y: 0 })
    expect(clampZoomPan(2, -400, -300, 320, 240)).toEqual({ scale: 2, x: -320, y: -240 })
    expect(clampZoomPan(2, -100, -100, 320, 240)).toEqual({ scale: 2, x: -100, y: -100 })
  })

  it('zeroes pan when the viewport is unknown', () => {
    expect(clampZoomPan(2, -100, -100, 0, 0)).toEqual({ scale: 2, x: 0, y: 0 })
  })

  it('snaps float dust back to exactly 1x', () => {
    expect(clampZoomPan(1.2 * (1 / 1.2), -50, -30, 320, 240)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    })
  })

  it('pins pan while contain content is smaller than the viewport', () => {
    // 640x480 in 300x400 contains to 300x225: at 1x both axes pin centered.
    expect(clampZoomPan(1, -50, -30, 300, 400, 'contain', 640, 480)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    })
    // At 1.5x the width covers (clamped to [-150, 0]) while the height
    // still pins centered at (400/2)*(1-1.5) = -100.
    expect(clampZoomPan(1.5, -100, -50, 300, 400, 'contain', 640, 480)).toEqual({
      scale: 1.5,
      x: -100,
      y: -100,
    })
  })

  it('clamps contain pan against the fitted content box once it covers', () => {
    // At 2x the 300x225 content spans 600x450: x covers ([-300, 0]), y covers
    // ([-225, -175]) so the image cannot leave the viewport.
    expect(clampZoomPan(2, -100, -100, 300, 400, 'contain', 640, 480)).toEqual({
      scale: 2,
      x: -100,
      y: -175,
    })
    expect(clampZoomPan(2, -400, -300, 300, 400, 'contain', 640, 480)).toEqual({
      scale: 2,
      x: -300,
      y: -225,
    })
  })

  it('falls back to cover clamping without contain video dims', () => {
    expect(clampZoomPan(2, -100, -100, 300, 400, 'contain', 0, 0)).toEqual({
      scale: 2,
      x: -100,
      y: -100,
    })
  })
})

describe('zoomAt', () => {
  it('zooms around the focal point, keeping its content fixed', () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 100, 320, 240)).toEqual({
      scale: 2,
      x: -100,
      y: -100,
    })
  })

  it('returns to the origin when zooming back out to 1x', () => {
    expect(zoomAt({ scale: 2, x: -100, y: -100 }, 0.5, 100, 100, 320, 240)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    })
  })

  it('returns the same state when the factor hits a range limit', () => {
    const zoomed = { scale: 4, x: -100, y: -100 }
    expect(zoomAt(zoomed, 2, 100, 100, 320, 240)).toBe(zoomed)
    const plain = { scale: 1, x: 0, y: 0 }
    expect(zoomAt(plain, 0.5, 100, 100, 320, 240)).toBe(plain)
  })
})

describe('stageBoxToMedia', () => {
  it('maps a trace bbox through the cover inverse', () => {
    expect(stageBoxToMedia(80, 60, 240, 180, 320, 240, 640, 480)).toEqual({
      box: { x1: 160, y1: 120, x2: 480, y2: 360 },
      x: 50,
      y: 50,
    })
  })

  it('orders reversed corners', () => {
    expect(stageBoxToMedia(240, 180, 80, 60, 320, 240, 640, 480)?.box).toEqual({
      x1: 160,
      y1: 120,
      x2: 480,
      y2: 360,
    })
  })

  it('clamps out-of-frame loops into the media bounds', () => {
    expect(stageBoxToMedia(-100, -100, 1000, 1000, 320, 240, 640, 480)?.box).toEqual({
      x1: 0,
      y1: 0,
      x2: 639,
      y2: 479,
    })
  })

  it('returns undefined without stage or media dimensions', () => {
    expect(stageBoxToMedia(0, 0, 10, 10, 0, 240, 640, 480)).toBeUndefined()
    expect(stageBoxToMedia(0, 0, 10, 10, 320, 240, 0, 480)).toBeUndefined()
    expect(stageBoxToMedia(NaN, 0, 10, 10, 320, 240, 640, 480)).toBeUndefined()
  })

  it('mirrors the box against the stage width when the feed is flipped', () => {
    // Loop over the left quarter of the displayed stage: the raw frame
    // holds it on the right, while the callout stays over the loop.
    expect(stageBoxToMedia(40, 60, 120, 180, 320, 240, 640, 480, true)).toEqual({
      box: { x1: 400, y1: 120, x2: 560, y2: 360 },
      x: 25,
      y: 50,
    })
  })

  it('maps the letterboxed image area to the full frame in contain mode', () => {
    // Contain: 640x480 in 300x400 shows 300x225 centered (87.5px bars).
    // Looping exactly the image area resolves to the full frame.
    expect(stageBoxToMedia(0, 87.5, 300, 312.5, 300, 400, 640, 480, false, 'contain')).toEqual({
      box: { x1: 0, y1: 0, x2: 639, y2: 479 },
      x: 50,
      y: 50,
    })
  })

  it('ignores loops fully inside the contain bars', () => {
    expect(stageBoxToMedia(50, 10, 250, 60, 300, 400, 640, 480, false, 'contain')).toBeUndefined()
  })

  it('clamps loops straddling the image edge into the frame', () => {
    // Loop from the top bar into the image: the bar corner clamps to the
    // image edge, so the box still resolves instead of failing.
    const region = stageBoxToMedia(0, 40, 300, 200, 300, 400, 640, 480, false, 'contain')
    expect(region?.box).toEqual({ x1: 0, y1: 0, x2: 639, y2: 240 })
  })
})

describe('pinchZoom', () => {
  it('matches zoomAt for a pure spread around a fixed midpoint', () => {
    expect(pinchZoom({ scale: 1, x: 0, y: 0 }, 2, 100, 100, 100, 100, 320, 240)).toEqual({
      scale: 2,
      x: -100,
      y: -100,
    })
  })

  it('pans by the midpoint delta when the spread holds steady', () => {
    expect(
      pinchZoom({ scale: 2, x: -100, y: -100 }, 1, 150, 100, 200, 100, 320, 240),
    ).toEqual({ scale: 2, x: -50, y: -100 })
  })

  it('combines spread and midpoint tracking in one step', () => {
    expect(pinchZoom({ scale: 1, x: 0, y: 0 }, 2, 100, 100, 150, 150, 320, 240)).toEqual({
      scale: 2,
      x: -50,
      y: -50,
    })
  })

  it('clamps the pan into the covering range', () => {
    const zoomed = pinchZoom({ scale: 2, x: -100, y: -100 }, 1, 100, 100, 1000, 100, 320, 240)
    expect(zoomed).toEqual({ scale: 2, x: 0, y: -100 })
  })
})

describe('approxToStage', () => {
  it('preserves percents when the frame fills the stage', () => {
    expect(approxToStage(25, 50, 320, 240, 640, 480)).toEqual({ x: 25, y: 50 })
  })

  it('maps through the cover crop when aspects mismatch', () => {
    // Portrait stage, landscape frame: the sides crop, so 25% across the
    // frame lands ~5.6% across the stage.
    const pt = approxToStage(25, 50, 300, 400, 640, 480)
    expect(pt.x).toBeCloseTo(5.56, 1)
    expect(pt.y).toBeCloseTo(50, 5)
  })

  it('flips in media space before the cover fit when mirrored', () => {
    const pt = approxToStage(25, 50, 300, 400, 640, 480, true)
    expect(pt.x).toBeCloseTo(94.44, 1)
    expect(pt.y).toBeCloseTo(50, 5)
  })

  it('maps through the contain letterbox', () => {
    // Frame top-left lands below the top bar, not at the stage corner.
    const pt = approxToStage(0, 0, 300, 400, 640, 480, false, 'contain')
    expect(pt.x).toBeCloseTo(0, 5)
    expect(pt.y).toBeCloseTo(21.875, 2)
    expect(approxToStage(50, 50, 300, 400, 640, 480, false, 'contain')).toEqual({ x: 50, y: 50 })
  })

  it('flips in media space before the contain fit when mirrored', () => {
    expect(approxToStage(0, 50, 300, 400, 640, 480, true, 'contain')).toEqual({ x: 100, y: 50 })
  })

  it('falls back to a mirror flip without stage or media dims', () => {
    expect(approxToStage(25, 50, 0, 0, 640, 480)).toEqual({ x: 25, y: 50 })
    expect(approxToStage(25, 50, 300, 400, 0, 0, true)).toEqual({ x: 75, y: 50 })
  })
})

describe('overlayUiScale', () => {
  it('scales backing-store chrome to a constant display size', () => {
    expect(overlayUiScale(400, 1080)).toBeCloseTo(2.7, 5)
    expect(overlayUiScale(400, 2160)).toBeCloseTo(5.4, 5)
  })

  it('returns 1 without display or canvas dims', () => {
    expect(overlayUiScale(0, 1080)).toBe(1)
    expect(overlayUiScale(400, 0)).toBe(1)
    expect(overlayUiScale(NaN, 1080)).toBe(1)
  })
})

describe('calloutStyle', () => {
  it('keeps edge anchoring for unzoomed pills', () => {
    expect(calloutStyle(2, 60).transform).toContain('translate(0,')
    expect(calloutStyle(98, 60).transform).toContain('translate(-100%,')
    expect(calloutStyle(50, 5).transform).toContain('translate(-50%, 8px)')
  })

  it('carries safe-area insets with a minimum gutter on edge pills', () => {
    const left = calloutStyle(2, 60)
    expect(left.left).toContain('calc(2%')
    expect(left.left).toContain('env(safe-area-inset-left)')
    expect(left.left).toContain('0.5rem')
    const right = calloutStyle(98, 60)
    expect(right.left).toContain('env(safe-area-inset-right)')
    expect(right.left).toContain('0.5rem')
  })

  it('re-projects the pill through zoom instead of parking at 1x', () => {
    // Quarter point at 2x centered on a 400x300 stage lands at the origin.
    const style = calloutStyle(25, 25, {
      zoom: { scale: 2, x: -200, y: -150 },
      stageW: 400,
      stageH: 300,
    })
    expect(style.top).toContain('0%')
  })

  it('clamps the pill between the header and dock', () => {
    const top = calloutStyle(50, 95, { stageW: 400, stageH: 800, headerH: 100, dockH: 200 })
    expect(top.top).toContain('75%')
    const bottom = calloutStyle(50, 2, { stageW: 400, stageH: 800, headerH: 100, dockH: 200 })
    expect(bottom.top).toContain('12.5%')
  })
})

describe('identifyWithContext', () => {
  const box = { x1: 10, y1: 20, x2: 30, y2: 40 }
  const video = {} as HTMLVideoElement

  it('returns the tight-crop name without a second attempt', async () => {
    await expect(identifyWithContext(video, box)).resolves.toBe('M6 hex bolt')
    expect(cropRegion).toHaveBeenCalledTimes(1)
    expect(cropRegion).toHaveBeenCalledWith(video, box, 0.2)
    expect(identifyComponent).toHaveBeenCalledTimes(1)
  })

  it('retries with a wide crop when the tight crop is unnamed', async () => {
    vi.mocked(identifyComponent).mockResolvedValueOnce('')
    await expect(identifyWithContext(video, box)).resolves.toBe('M6 hex bolt')
    expect(cropRegion).toHaveBeenCalledTimes(2)
    expect(cropRegion).toHaveBeenNthCalledWith(2, video, box, 1.0)
    expect(identifyComponent).toHaveBeenCalledTimes(2)
  })

  it('retries with a wide crop when the tight attempt throws', async () => {
    vi.mocked(identifyComponent).mockRejectedValueOnce(new Error('boom'))
    await expect(identifyWithContext(video, box)).resolves.toBe('M6 hex bolt')
    expect(identifyComponent).toHaveBeenCalledTimes(2)
  })

  it('returns empty only when both attempts miss', async () => {
    vi.mocked(identifyComponent).mockResolvedValue('')
    await expect(identifyWithContext(video, box)).resolves.toBe('')
    expect(identifyComponent).toHaveBeenCalledTimes(2)
  })
})

describe('fetchWithTimeout body deadline', () => {
  it('aborts a stalled body after the absolute deadline', async () => {
    vi.useFakeTimers()
    try {
      const fetchStub = vi.fn()
      fetchStub.mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
            cancel: async () => {},
          }),
        },
      } as unknown as Response)
      vi.stubGlobal('fetch', fetchStub)
      const res = await fetchWithTimeout(
        'https://example.com/stream',
        {},
        { timeoutMs: 1000, tag: 't', label: 'L' },
      )
      const [, init] = fetchStub.mock.calls[0] as [string, { signal: AbortSignal }]
      expect(init.signal.aborted).toBe(false)
      // Headers arrived long ago; the unconsumed body still trips the deadline.
      await vi.advanceTimersByTimeAsync(1500)
      expect(init.signal.aborted).toBe(true)
      expect(res.ok).toBe(true)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('clears the deadline once the buffered body is consumed', async () => {
    vi.useFakeTimers()
    try {
      const fetchStub = vi.fn()
      fetchStub.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ hello: 'world' }),
        body: null,
      } as unknown as Response)
      vi.stubGlobal('fetch', fetchStub)
      const res = await fetchWithTimeout(
        'https://example.com/json',
        {},
        { timeoutMs: 1000, tag: 't', label: 'L' },
      )
      await res.json()
      const [, init] = fetchStub.mock.calls[0] as [string, { signal: AbortSignal }]
      await vi.advanceTimersByTimeAsync(1500)
      expect(init.signal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

describe('segmentImage early close', () => {
  it('cancels the SSE reader when the consumer stops early', async () => {
    const actual = await vi.importActual<typeof import('../services/metaApi')>('../services/metaApi')
    vi.stubEnv('VITE_META_MODEL_API_KEY', 'test-key')
    const cancel = vi.fn(async () => {})
    const read = vi.fn(async () => ({
      done: false,
      value: new TextEncoder().encode('data: {"type":"response.completed"}\n\n'),
    }))
    const fetchStub = vi.fn()
    fetchStub.mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchStub)
    try {
      const gen = actual.segmentImage('img', 'screw')
      const first = await gen.next()
      expect(first.done).toBe(false)
      await gen.return(undefined)
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
