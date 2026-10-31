import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import QrShare from './QrShare'
import { getShareWarning } from '../services/share'

beforeEach(() => {
  window.localStorage.clear()
})

describe('getShareWarning', () => {
  it('warns for loopback addresses', () => {
    expect(getShareWarning('http://localhost:5173/wrenchmind/')).toContain('only works on this device')
    expect(getShareWarning('http://127.0.0.1:5173/')).toContain('only works on this device')
  })

  it('warns for plain HTTP on the network', () => {
    expect(getShareWarning('http://192.168.1.2:5173/wrenchmind/')).toContain('requires HTTPS')
  })

  it('stays silent for tunnel URLs and garbage', () => {
    expect(getShareWarning('https://abc.trycloudflare.com/wrenchmind/')).toBeNull()
    expect(getShareWarning('not a url')).toBeNull()
  })
})

describe('QrShare', () => {
  it('opens a dialog with a QR code for the current URL', () => {
    render(<QrShare />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('QR'))
    const dialog = screen.getByRole('dialog', { name: 'Share via QR code' })
    expect(dialog).toBeInTheDocument()
    expect(dialog.querySelector('svg')).toBeInTheDocument()
    expect(dialog).toHaveTextContent(window.location.href)
  })

  it('shows the loopback warning on localhost', () => {
    render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    expect(screen.getByRole('dialog')).toHaveTextContent('only works on this device')
  })

  it('encodes a pasted tunnel URL and remembers it', () => {
    const tunnel = 'https://abc.trycloudflare.com/wrenchmind/'
    const { unmount } = render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    fireEvent.change(screen.getByLabelText(/Share URL/), { target: { value: tunnel } })
    expect(screen.getByLabelText(`QR code for ${tunnel}`)).toBeInTheDocument()
    expect(screen.queryByText(/only works on this device/)).not.toBeInTheDocument()
    unmount()

    render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    expect(screen.getByLabelText(`QR code for ${tunnel}`)).toBeInTheDocument()
  })

  it('resets to the current page on request', () => {
    render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    fireEvent.change(screen.getByLabelText(/Share URL/), {
      target: { value: 'https://abc.trycloudflare.com/wrenchmind/' },
    })
    fireEvent.click(screen.getByText('Use current page'))
    expect(screen.getByLabelText(`QR code for ${window.location.href}`)).toBeInTheDocument()
    expect(window.localStorage.getItem('wrenchmind.shareUrl')).toBeNull()
  })

  it('keeps the last valid URL when the input is invalid', () => {
    render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    const qr = () => screen.getByLabelText(`QR code for ${window.location.href}`)
    expect(qr()).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Share URL/), { target: { value: 'not a url' } })
    expect(qr()).toBeInTheDocument()
    expect(screen.getByText(/Enter a valid URL/)).toBeInTheDocument()
  })

  it('rejects non-http(s) URLs as invalid', () => {
    render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    const qr = () => screen.getByLabelText(`QR code for ${window.location.href}`)
    expect(qr()).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Share URL/), {
      target: { value: 'ftp://example.com/wrenchmind/' },
    })
    expect(qr()).toBeInTheDocument()
    expect(screen.getByText(/Enter a valid URL/)).toBeInTheDocument()
  })

  it('keeps a half-typed draft when the parent re-renders', () => {
    // onClose is an inline arrow from Header: its identity churn must not
    // reset the dialog mid-word.
    const { rerender } = render(<QrShare onClose={() => undefined} />)
    fireEvent.click(screen.getByText('QR'))
    fireEvent.change(screen.getByLabelText(/Share URL/), { target: { value: 'not a url' } })
    rerender(<QrShare onClose={() => undefined} />)
    expect(screen.getByLabelText(/Share URL/)).toHaveValue('not a url')
    expect(screen.getByText(/Enter a valid URL/)).toBeInTheDocument()
  })

  it('labels the dialog by its heading and scrolls on short viewports', () => {
    render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    const dialog = screen.getByRole('dialog', { name: 'Share via QR code' })
    expect(dialog).toHaveAttribute('aria-labelledby', 'qr-share-title')
    expect(dialog).toHaveClass('max-h-full', 'overflow-y-auto')
  })

  it('shrinks the QR code on short viewports', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true })
    try {
      render(<QrShare />)
      fireEvent.click(screen.getByText('QR'))
      const svg = screen.getByRole('dialog').querySelector('svg')
      expect(svg?.getAttribute('width')).toBe(String(Math.floor(300 * 0.35)))
    } finally {
      if (original) Object.defineProperty(window, 'innerHeight', original)
    }
  })

  it('keeps the full-size QR code on tall viewports', () => {
    render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    const svg = screen.getByRole('dialog').querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('256')
  })

  it('restores focus to the trigger on every close path', () => {
    render(<QrShare />)
    const trigger = screen.getByRole('button', { name: 'QR' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('Close'))
    expect(trigger).toHaveFocus()

    trigger.focus()
    fireEvent.click(trigger)
    const backdrop = document.querySelector('div.fixed')
    if (!backdrop) throw new Error('missing backdrop')
    fireEvent.click(backdrop)
    expect(trigger).toHaveFocus()

    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(trigger).toHaveFocus()
  })

  it('closes via Close button, backdrop, and Escape', () => {
    render(<QrShare />)
    fireEvent.click(screen.getByText('QR'))
    fireEvent.click(screen.getByText('Close'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('QR'))
    const backdrop = document.querySelector('div.fixed')
    if (!backdrop) throw new Error('missing backdrop')
    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('QR'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
