import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Header from './Header'

function renderHeader(overrides: Partial<Parameters<typeof Header>[0]> = {}) {
  const props = {
    status: 'off' as const,
    live: true,
    tracking: false,
    voiceOn: false,
    onVoiceToggle: vi.fn(),
    facing: 'environment' as const,
    multiCamera: true,
    onSwitchCamera: vi.fn(),
    onClearView: vi.fn(),
    ...overrides,
  }
  render(<Header {...props} />)
  return props
}

function openOverflow() {
  fireEvent.click(screen.getByRole('button', { name: 'More options' }))
}

describe('Header', () => {
  it('renders brand, status, voice toggle, QR, and LIVE/facing badges', () => {
    renderHeader({ status: 'listening' })
    expect(screen.getByText('WRENCHMIND')).toBeInTheDocument()
    expect(screen.getByText('[ 🟢 LISTENING... ]')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Voice' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'QR' })).toBeInTheDocument()
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('REAR CAMERA')).toBeInTheDocument()
  })

  it('dims the LIVE badge to NO FEED when the camera is off air', () => {
    renderHeader({ live: false })
    expect(screen.getByText('NO FEED')).toBeInTheDocument()
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Camera off air' })).toHaveClass('opacity-60')
    expect(screen.queryByText('REAR CAMERA')).not.toBeInTheDocument()
  })

  it('labels a camera with unknown facing as CAMERA', () => {
    renderHeader({ facing: 'unknown' })
    expect(screen.getByText('CAMERA')).toBeInTheDocument()
    expect(screen.queryByText('REAR CAMERA')).not.toBeInTheDocument()
  })

  it('shows the TRACKING badge while locked onto an item', () => {
    renderHeader({ tracking: true })
    expect(screen.getByText('Tracking')).toBeInTheDocument()
  })

  it('hides the TRACKING badge when idle', () => {
    renderHeader()
    expect(screen.queryByText('Tracking')).not.toBeInTheDocument()
  })

  it('shows the front-camera badge when facing the user', () => {
    renderHeader({ facing: 'user' })
    expect(screen.getByText('FRONT CAMERA')).toBeInTheDocument()
    expect(screen.queryByText('REAR CAMERA')).not.toBeInTheDocument()
  })

  it('reports voice toggles through the callback', () => {
    const props = renderHeader()
    fireEvent.click(screen.getByRole('switch', { name: 'Voice' }))
    expect(props.onVoiceToggle).toHaveBeenCalledWith(true)
  })

  it('opens the QR dialog in one tap from the header', () => {
    renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'QR' }))
    expect(screen.getByRole('dialog', { name: 'Share via QR code' })).toBeInTheDocument()
  })

  it('keeps logs and secondary controls behind the overflow', () => {
    renderHeader()
    expect(screen.queryByText('Logs')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Switch camera' })).not.toBeInTheDocument()
    expect(screen.queryByText('Clear AR View')).not.toBeInTheDocument()
    openOverflow()
    expect(screen.getByText('Logs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
    expect(screen.getByText('Clear AR View')).toBeInTheDocument()
  })

  it('wires the overflow controls to their callbacks', () => {
    const props = renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    expect(props.onSwitchCamera).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Clear AR View'))
    expect(props.onClearView).toHaveBeenCalledTimes(1)
  })

  it('hides the camera switcher in the overflow with a single camera', () => {
    renderHeader({ multiCamera: false })
    openOverflow()
    expect(screen.queryByRole('button', { name: 'Switch camera' })).not.toBeInTheDocument()
    expect(screen.getByText('Clear AR View')).toBeInTheDocument()
  })

  it('toggles the overflow closed on a second tap', () => {
    renderHeader()
    openOverflow()
    expect(screen.getByText('Logs')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(screen.queryByText('Logs')).not.toBeInTheDocument()
  })
})
