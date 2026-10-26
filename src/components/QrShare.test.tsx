import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import QrShare, { getShareWarning } from './QrShare'

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
