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
    onExportReport: vi.fn(),
    torchOn: false,
    hasTorch: false,
    onTorchToggle: vi.fn(),
    frozen: false,
    onFreezeToggle: vi.fn(),
    ...overrides,
  }
  render(<Header {...props} />)
  return props
}

function openOverflow() {
  fireEvent.click(screen.getByRole('button', { name: 'More options' }))
}

describe('Header', () => {
  it('renders brand, status, and LIVE/facing badges', () => {
    renderHeader({ status: 'listening' })
    expect(screen.getByText('WRENCHMIND')).toBeInTheDocument()
    expect(screen.getByText('[ 🟢 LISTENING... ]')).toBeInTheDocument()
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('REAR CAMERA')).toBeInTheDocument()
  })

  it('holds the voice toggle and QR behind the overflow', () => {
    renderHeader()
    expect(screen.queryByRole('switch', { name: 'Voice mode' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'QR' })).not.toBeInTheDocument()
    openOverflow()
    expect(screen.getByRole('switch', { name: 'Voice mode' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'QR' })).toBeInTheDocument()
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
    openOverflow()
    fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
    expect(props.onVoiceToggle).toHaveBeenCalledWith(true)
  })

  it('opens the QR dialog from the overflow', () => {
    renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'QR' }))
    expect(screen.getByRole('dialog', { name: 'Share via QR code' })).toBeInTheDocument()
  })

  it('keeps logs and secondary controls behind the overflow', () => {
    renderHeader()
    expect(screen.queryByText('Logs')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Switch camera' })).not.toBeInTheDocument()
    expect(screen.queryByText('Clear AR View')).not.toBeInTheDocument()
    expect(screen.queryByText('Export Report')).not.toBeInTheDocument()
    openOverflow()
    expect(screen.getByText('Logs')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch camera' })).toBeInTheDocument()
    expect(screen.getByText('Clear AR View')).toBeInTheDocument()
    expect(screen.getByText('Export Report')).toBeInTheDocument()
  })

  it('shows the flashlight toggle only with torch support', () => {
    renderHeader()
    openOverflow()
    expect(screen.queryByRole('switch', { name: 'Flashlight' })).not.toBeInTheDocument()
  })

  it('wires the flashlight toggle to its callback', () => {
    const props = renderHeader({ hasTorch: true })
    openOverflow()
    const toggle = screen.getByRole('switch', { name: 'Flashlight' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(props.onTorchToggle).toHaveBeenCalledWith(true)
  })

  it('reflects the torch state', () => {
    renderHeader({ hasTorch: true, torchOn: true })
    openOverflow()
    expect(screen.getByRole('switch', { name: 'Flashlight' })).toBeChecked()
  })

  it('wires the overflow controls to their callbacks', () => {
    const props = renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    expect(props.onSwitchCamera).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Clear AR View'))
    expect(props.onClearView).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Export Report'))
    expect(props.onExportReport).toHaveBeenCalledTimes(1)
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

  it('shows the freeze switch in the overflow camera cluster when live', () => {
    renderHeader()
    expect(screen.queryByRole('switch', { name: 'Freeze frame' })).not.toBeInTheDocument()
    openOverflow()
    expect(screen.getByRole('switch', { name: 'Freeze frame' })).toBeInTheDocument()
  })

  it('hides the freeze switch when the camera is off air', () => {
    renderHeader({ live: false })
    openOverflow()
    expect(screen.queryByRole('switch', { name: 'Freeze frame' })).not.toBeInTheDocument()
  })

  it('keeps the freeze switch while frozen even when off air', () => {
    renderHeader({ live: false, frozen: true })
    openOverflow()
    expect(screen.getByRole('switch', { name: 'Freeze frame' })).toBeChecked()
  })

  it('reports freeze toggles through the callback', () => {
    const props = renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('switch', { name: 'Freeze frame' }))
    expect(props.onFreezeToggle).toHaveBeenCalledWith(true)
  })

  it('reflects the frozen state', () => {
    renderHeader({ frozen: true })
    openOverflow()
    expect(screen.getByRole('switch', { name: 'Freeze frame' })).toBeChecked()
  })

  it('shows no FROZEN badge while live and unfrozen', () => {
    renderHeader()
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.queryByText('FROZEN')).not.toBeInTheDocument()
  })

  it('shows FROZEN instead of LIVE while frozen', () => {
    const { rerender } = render(
      <Header
        status="off"
        live
        tracking={false}
        voiceOn={false}
        onVoiceToggle={vi.fn()}
        facing="environment"
        multiCamera
        onSwitchCamera={vi.fn()}
        onClearView={vi.fn()}
        onExportReport={vi.fn()}
        torchOn={false}
        hasTorch={false}
        onTorchToggle={vi.fn()}
        frozen={false}
        onFreezeToggle={vi.fn()}
      />,
    )
    expect(screen.getByRole('status', { name: 'Camera live' })).toHaveTextContent('LIVE')
    rerender(
      <Header
        status="off"
        live
        tracking={false}
        voiceOn={false}
        onVoiceToggle={vi.fn()}
        facing="environment"
        multiCamera
        onSwitchCamera={vi.fn()}
        onClearView={vi.fn()}
        onExportReport={vi.fn()}
        torchOn={false}
        hasTorch={false}
        onTorchToggle={vi.fn()}
        frozen
        onFreezeToggle={vi.fn()}
      />,
    )
    const badge = screen.getByRole('status', { name: 'Frame frozen' })
    expect(badge).toHaveTextContent('FROZEN')
    expect(badge.querySelector('span')).toHaveClass('bg-amber-400')
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
  })

  it('shows the hint pill in the badge row only when provided', () => {
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
      onExportReport: vi.fn(),
      torchOn: false,
      hasTorch: false,
      onTorchToggle: vi.fn(),
      frozen: true,
      onFreezeToggle: vi.fn(),
    }
    const { rerender } = render(<Header {...props} hint="Drag to circle a part" />)
    expect(screen.getByText('Drag to circle a part')).toBeInTheDocument()
    rerender(<Header {...props} hint={null} />)
    expect(screen.queryByText('Drag to circle a part')).not.toBeInTheDocument()
  })
})
