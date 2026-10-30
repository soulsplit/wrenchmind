import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Header from './Header'
import { APP_VERSION } from '../version'

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

function expectMenuOpen() {
  expect(screen.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('switch', { name: 'Voice mode' })).toBeInTheDocument()
}

function expectMenuClosed() {
  expect(screen.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('switch', { name: 'Voice mode' })).not.toBeInTheDocument()
  expect(screen.queryByText('Logs')).not.toBeInTheDocument()
  expect(screen.queryByText('Hide Logs')).not.toBeInTheDocument()
}

describe('Header', () => {
  it('renders brand, status, and LIVE/facing badges', () => {
    renderHeader({ status: 'listening' })
    expect(screen.getByText('WRENCHMIND')).toBeInTheDocument()
    expect(screen.getByText('Listening')).toBeInTheDocument()
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(screen.getByText('REAR CAMERA')).toBeInTheDocument()
  })

  it('shows the app version in the top bar', () => {
    renderHeader()
    const badge = screen.getByTestId('app-version')
    expect(badge).toHaveTextContent(`v${APP_VERSION}`)
    expect(badge).toHaveAttribute('title', `Version ${APP_VERSION}`)
  })

  it('hides the hint pill while the overflow menu is open', () => {
    renderHeader({ hint: 'Drag to circle a part' })
    expect(screen.getByText('Drag to circle a part')).toBeInTheDocument()
    openOverflow()
    expect(screen.queryByText('Drag to circle a part')).not.toBeInTheDocument()
    openOverflow()
    expect(screen.getByText('Drag to circle a part')).toBeInTheDocument()
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

  it('shows the flashlight quick toggle in the top bar only with torch support', () => {
    renderHeader()
    expect(screen.queryByRole('button', { name: 'Flashlight' })).not.toBeInTheDocument()
  })

  it('wires the flashlight quick toggle to its callback', () => {
    const props = renderHeader({ hasTorch: true })
    // Visible without opening the overflow: it lives in the top bar.
    const toggle = screen.getByRole('button', { name: 'Flashlight' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(props.onTorchToggle).toHaveBeenCalledWith(true)
  })

  it('reflects the torch state on the quick toggle', () => {
    renderHeader({ hasTorch: true, torchOn: true })
    const toggle = screen.getByRole('button', { name: 'Flashlight' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveClass('bg-green-500', 'text-white')
  })

  it('hides the flashlight quick toggle while frozen even with torch support', () => {
    renderHeader({ hasTorch: true, frozen: true })
    expect(screen.queryByRole('button', { name: 'Flashlight' })).not.toBeInTheDocument()
  })

  it('renders quick toggles with exact names, hidden icons, and 48px targets', () => {
    renderHeader({ hasTorch: true })
    const freeze = screen.getByRole('button', { name: 'Freeze frame' })
    expect(freeze).toHaveClass('min-h-[48px]', 'min-w-[48px]')
    expect(freeze).toHaveAttribute('aria-pressed', 'false')
    expect(freeze).toHaveClass('bg-white/10', 'text-white')
    expect(freeze.querySelector('[aria-hidden="true"]')?.tagName).toBe('svg')
    const torch = screen.getByRole('button', { name: 'Flashlight' })
    expect(torch).toHaveClass('min-h-[48px]', 'min-w-[48px]')
    expect(torch.querySelector('[aria-hidden="true"]')?.tagName).toBe('svg')
    expect(screen.getByRole('button', { name: 'More options' }).querySelector('svg')).toBeInTheDocument()
  })

  it('shows the freeze quick toggle in the top bar when live', () => {
    renderHeader()
    expect(screen.getByRole('button', { name: 'Freeze frame' })).toBeInTheDocument()
  })

  it('hides the freeze quick toggle when the camera is off air', () => {
    renderHeader({ live: false })
    expect(screen.queryByRole('button', { name: 'Freeze frame' })).not.toBeInTheDocument()
  })

  it('keeps the freeze quick toggle while frozen even when off air', () => {
    renderHeader({ live: false, frozen: true })
    expect(screen.getByRole('button', { name: 'Freeze frame' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reports freeze toggles through the callback', () => {
    const props = renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'Freeze frame' }))
    expect(props.onFreezeToggle).toHaveBeenCalledWith(true)
  })

  it('reflects the frozen state on the quick toggle', () => {
    renderHeader({ frozen: true })
    const toggle = screen.getByRole('button', { name: 'Freeze frame' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveClass('bg-green-500', 'text-white')
  })

  it('keeps freeze and flashlight out of the overflow', () => {
    renderHeader({ hasTorch: true })
    openOverflow()
    expect(screen.queryByRole('switch', { name: 'Freeze frame' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Flashlight' })).not.toBeInTheDocument()
    // Exactly one of each: the top-bar quick toggle, not an overflow duplicate.
    expect(screen.getAllByRole('button', { name: 'Freeze frame' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Flashlight' })).toHaveLength(1)
  })

  it('wires the overflow controls to their callbacks', () => {
    const props = renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    expect(props.onSwitchCamera).toHaveBeenCalledTimes(1)
    // The menu closes after each press, so reopen it between controls.
    openOverflow()
    fireEvent.click(screen.getByText('Clear AR View'))
    expect(props.onClearView).toHaveBeenCalledTimes(1)
    openOverflow()
    fireEvent.click(screen.getByText('Export Report'))
    expect(props.onExportReport).toHaveBeenCalledTimes(1)
  })

  it('closes the menu after the voice toggle is pressed', () => {
    const props = renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('switch', { name: 'Voice mode' }))
    expect(props.onVoiceToggle).toHaveBeenCalledWith(true)
    expectMenuClosed()
  })

  it('closes the menu after the camera switch is pressed', () => {
    const props = renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Switch camera' }))
    expect(props.onSwitchCamera).toHaveBeenCalledTimes(1)
    expectMenuClosed()
  })

  it('closes the menu after Clear AR View is pressed', () => {
    const props = renderHeader()
    openOverflow()
    fireEvent.click(screen.getByText('Clear AR View'))
    expect(props.onClearView).toHaveBeenCalledTimes(1)
    expectMenuClosed()
  })

  it('closes the menu after Export Report is pressed', () => {
    const props = renderHeader()
    openOverflow()
    fireEvent.click(screen.getByText('Export Report'))
    expect(props.onExportReport).toHaveBeenCalledTimes(1)
    expectMenuClosed()
  })

  it('closes the menu when the QR trigger opens the dialog', () => {
    renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'QR' }))
    expect(screen.getByRole('dialog', { name: 'Share via QR code' })).toBeInTheDocument()
    expectMenuClosed()
    expect(screen.queryByRole('button', { name: 'QR' })).not.toBeInTheDocument()
  })

  it('keeps the dialog usable after the menu closes for QR', () => {
    renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'QR' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Share via QR code' })).not.toBeInTheDocument()
    expectMenuClosed()
    openOverflow()
    expectMenuOpen()
    expect(screen.getByRole('button', { name: 'QR' })).toBeInTheDocument()
  })

  it('keeps the menu open while the Logs disclosure expands and its buttons run', () => {
    renderHeader()
    openOverflow()
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
    expectMenuOpen()
    expect(screen.getByRole('button', { name: 'Hide Logs' })).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Application log' })).toBeInTheDocument()

    // Download needs blob-URL and anchor-click stubs in the test environment.
    const createObjectURL = URL.createObjectURL
    const revokeObjectURL = URL.revokeObjectURL
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      expectMenuOpen()
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
      expectMenuOpen()
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
      expectMenuOpen()
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL })
      anchorClick.mockRestore()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Hide Logs' }))
    expectMenuOpen()
    expect(screen.queryByRole('log', { name: 'Application log' })).not.toBeInTheDocument()
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

  it('keeps a long hint pill to a single truncated line', () => {
    renderHeader({ hint: 'Drag to circle a part · tap to identify' })
    const text = screen.getByText('Drag to circle a part · tap to identify')
    // Inner span ellipsizes; the pill itself never exceeds the badge row.
    expect(text).toHaveClass('truncate')
    expect(text.parentElement).toHaveClass('max-w-full')
    expect(text.parentElement).toHaveAttribute('title', 'Drag to circle a part · tap to identify')
  })
})
