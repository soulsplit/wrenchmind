import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import LogPanel from './LogPanel'
import { clearLogs, logError, logInfo } from '../services/logger'

afterEach(() => {
  clearLogs()
  vi.restoreAllMocks()
})

describe('LogPanel', () => {
  it('toggles a live log view', () => {
    logInfo('camera', 'started')
    render(<LogPanel />)
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Logs'))
    const view = screen.getByRole('log')
    expect(view).toHaveTextContent('[INFO]')
    expect(view).toHaveTextContent('[camera] started')
    act(() => {
      logError('api', 'boom')
    })
    expect(view).toHaveTextContent('[ERROR]')
    expect(view).toHaveTextContent('[api] boom')
    fireEvent.click(screen.getByText('Hide Logs'))
    expect(screen.queryByRole('log')).not.toBeInTheDocument()
  })

  it('shows an empty state and clears entries', () => {
    render(<LogPanel />)
    fireEvent.click(screen.getByText('Logs'))
    expect(screen.getByRole('log')).toHaveTextContent('No log entries yet.')
    act(() => {
      logInfo('t', 'x')
    })
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.getByRole('log')).toHaveTextContent('No log entries yet.')
  })

  it('copies the formatted log to the clipboard', async () => {
    logInfo('voice', 'listening')
    let copied = ''
    const writeText = vi.fn(async (text: string) => {
      copied = text
    })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(<LogPanel />)
    fireEvent.click(screen.getByText('Logs'))
    fireEvent.click(screen.getByText('Copy'))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(copied).toContain('[INFO]')
    expect(copied).toContain('[voice] listening')
  })

  it('tolerates clipboard failures', () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied')
    })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(<LogPanel />)
    fireEvent.click(screen.getByText('Logs'))
    fireEvent.click(screen.getByText('Copy'))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('log')).toBeInTheDocument()
  })

  it('gives the log actions 44px targets with visible focus', () => {
    render(<LogPanel />)
    fireEvent.click(screen.getByText('Logs'))
    for (const name of ['Copy', 'Download', 'Clear']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveClass('min-h-[44px]')
      expect(button.className).toContain('focus-visible:ring-2')
    }
  })

  it('shows a focus ring on the Logs toggle', () => {
    render(<LogPanel />)
    expect(screen.getByRole('button', { name: 'Logs' }).className).toContain(
      'focus-visible:ring-2',
    )
  })

  it('downloads the log as a .log file', async () => {
    vi.useFakeTimers()
    try {
      logInfo('t', 'x')
      let blobType = ''
      const createObjectURL = vi.fn((blob: Blob) => {
        blobType = blob.type
        return 'blob:fake'
      })
      const revokeObjectURL = vi.fn()
      Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
      Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
      let download = ''
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) {
          download = this.download
        })

      render(<LogPanel />)
      fireEvent.click(screen.getByText('Logs'))
      fireEvent.click(screen.getByText('Download'))
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(blobType).toBe('text/plain')
      expect(download).toMatch(/^wrenchmind-.*\.log$/)
      expect(click).toHaveBeenCalledTimes(1)
      // The blob survives the click for async downloaders; revoked after a delay.
      expect(revokeObjectURL).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5000)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake')
    } finally {
      vi.useRealTimers()
    }
  })
})
