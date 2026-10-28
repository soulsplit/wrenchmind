import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Sidebar from './Sidebar'
import { validGuidanceFixture } from '../test/guidanceFixtures'
import type { GuidanceResult } from '../types'
import { ifixitSearchUrl, type FixitGuide } from '../services/ifixitApi'

function renderSidebar(guidance: GuidanceResult | null, overrides = {}) {
  const props = {
    guidance,
    pending: false,
    stepIndex: 0,
    onStepChange: vi.fn(),
    onScanAnother: vi.fn(),
    ...overrides,
  }
  render(<Sidebar {...props} />)
  return props
}

describe('Sidebar', () => {
  it('renders a one-third panel with a bounded width for wide viewports', () => {
    renderSidebar(validGuidanceFixture)
    const panel = screen.getByRole('complementary', { name: 'Repair guidance panel' })
    expect(panel).toHaveClass('w-1/3', 'max-w-[480px]', 'flex-col')
  })

  it('stretches the hosted card to the panel height with pinned actions', () => {
    renderSidebar(validGuidanceFixture)
    const panel = screen.getByRole('complementary', { name: 'Repair guidance panel' })
    // Lifts HudCard's mobile 44dvh cap: card fills the panel, its own
    // internal scroll area takes overflow, buttons stay pinned below.
    expect(panel).toHaveClass(
      '[&>section]:flex-1',
      '[&>section]:min-h-0',
      '[&>section]:max-h-none',
    )
    expect(screen.getByRole('region', { name: 'Repair guidance' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next Step' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Scan Another Part' })).toBeInTheDocument()
  })

  it('hosts the full guidance content: title, step, warnings, specs, tools', () => {
    renderSidebar(validGuidanceFixture)
    expect(screen.getByText('MID-DRIVE DRIVE BELT')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('Remove the belt cover')).toBeInTheDocument()
    expect(screen.getByText('Warnings')).toBeInTheDocument()
    expect(screen.getByText('Belt tension: 45 Hz')).toBeInTheDocument()
    expect(screen.getByText('Tools: T25 Torx, Torque wrench')).toBeInTheDocument()
  })

  it('forwards Back/Next step changes from the sidebar', () => {
    const props = renderSidebar(validGuidanceFixture, { stepIndex: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Next Step' }))
    expect(props.onStepChange).toHaveBeenCalledWith(2)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(props.onStepChange).toHaveBeenCalledWith(0)
  })

  it('bounds Back on the first step and Next on the last step', () => {
    const { unmount } = render(
      <Sidebar
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next Step' })).toBeEnabled()
    unmount()
    render(
      <Sidebar
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={2}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Next Step' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
  })

  it('reports Scan Another Part through the callback', () => {
    const props = renderSidebar(validGuidanceFixture)
    fireEvent.click(screen.getByRole('button', { name: 'Scan Another Part' }))
    expect(props.onScanAnother).toHaveBeenCalledTimes(1)
  })

  it('shows the loading skeleton while guidance is pending', () => {
    renderSidebar(null, { pending: true })
    expect(screen.getByRole('status', { name: 'Loading guidance' })).toBeInTheDocument()
    expect(screen.queryByText('No part scanned yet')).not.toBeInTheDocument()
  })

  it('shows the idle placeholder when there is no guidance', () => {
    renderSidebar(null)
    expect(screen.getByText('No part scanned yet')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Point the camera at a part and ask about it — step-by-step guidance appears here.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Repair guidance' })).not.toBeInTheDocument()
  })
})

describe('Sidebar iFixit guides passthrough', () => {
  const guides: FixitGuide[] = [
    {
      title: 'iPhone 13 Battery Replacement',
      url: 'https://www.ifixit.com/Guide/iPhone+13+Battery+Replacement/145896',
      summary: 'iPhone batteries are rated to hold 80% of their capacity.',
      difficulty: 'Moderate',
      kind: 'guide',
    },
  ]

  it('forwards guides to the hosted card', () => {
    renderSidebar(validGuidanceFixture, { guides })
    expect(screen.getByText('Guides via iFixit')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'iPhone 13 Battery Replacement' })
    expect(link).toHaveAttribute('href', guides[0].url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('renders the fallback search link when guides are omitted', () => {
    renderSidebar(validGuidanceFixture)
    expect(screen.getByText('Guides via iFixit')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: `Search iFixit for ${validGuidanceFixture.title}` }),
    ).toHaveAttribute('href', ifixitSearchUrl(validGuidanceFixture.title))
  })
})
