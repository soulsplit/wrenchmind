import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import HudCard from './HudCard'
import { validGuidanceFixture } from '../test/guidanceFixtures'
import type { GuidanceResult } from '../types'

function renderCard(guidance: GuidanceResult | null, overrides = {}) {
  const props = {
    guidance,
    pending: false,
    stepIndex: 0,
    onStepChange: vi.fn(),
    onScanAnother: vi.fn(),
    ...overrides,
  }
  render(<HudCard {...props} />)
  return props
}

describe('HudCard', () => {
  it('renders title, sources line, current step, tools, and step progress', () => {
    renderCard(validGuidanceFixture)
    expect(screen.getByText('MID-DRIVE DRIVE BELT')).toBeInTheDocument()
    expect(
      screen.getByText((_, el) => el?.textContent === 'Manual: Example Service Manual'),
    ).toBeInTheDocument()
    const link = screen.getByRole('link', {
      name: 'Example Service Manual, Belt Drive chapter',
    })
    expect(link).toHaveAttribute('href', 'https://example.com/manuals/belt-drive')
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('Remove the belt cover')).toBeInTheDocument()
    expect(
      screen.getByText('Undo the four cover screws and lift the cover clear of the drive.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Tools: T25 Torx, Torque wrench')).toBeInTheDocument()
  })

  it('shows the per-step warning on the step that carries one', () => {
    renderCard(validGuidanceFixture, { stepIndex: 1 })
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()
    expect(screen.getByText('Release belt tension')).toBeInTheDocument()
    expect(
      screen.getByText(
        (_, el) => el?.textContent === '⚠ Keep fingers clear of the tensioner spring.',
      ),
    ).toBeInTheDocument()
  })

  it('always renders the warnings slot, with a generic caution when empty', () => {
    const { unmount } = render(
      <HudCard
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.getByText('Warnings')).toBeInTheDocument()
    expect(
      screen.getByText(
        (_, el) => el?.textContent === '⚠ Disconnect the battery before starting work.',
      ),
    ).toBeInTheDocument()
    unmount()
    const empty: GuidanceResult = { ...validGuidanceFixture, warnings: [] }
    render(
      <HudCard
        guidance={empty}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.getByText('Warnings')).toBeInTheDocument()
    expect(
      screen.getByText('No specific warnings listed — verify all work against the manual.'),
    ).toBeInTheDocument()
  })

  it('renders every spec with the persistent verify treatment', () => {
    renderCard(validGuidanceFixture)
    expect(screen.getByText('Specs')).toBeInTheDocument()
    expect(screen.getByText('Belt tension: 45 Hz')).toBeInTheDocument()
    expect(screen.getByText('Cover screws: T25 Torx, 6 Nm')).toBeInTheDocument()
    expect(screen.getByText('Verify all specs against the manual.')).toBeInTheDocument()
  })

  it('omits the specs block when no spec is known', () => {
    const noSpecs: GuidanceResult = { ...validGuidanceFixture, specs: [] }
    render(
      <HudCard
        guidance={noSpecs}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.queryByText('Specs')).not.toBeInTheDocument()
    expect(screen.queryByText('Verify all specs against the manual.')).not.toBeInTheDocument()
    expect(screen.getByText('Warnings')).toBeInTheDocument()
  })

  it('falls back gracefully without a manual or source links', () => {
    const ungrounded: GuidanceResult = {
      ...validGuidanceFixture,
      manualTitle: null,
      sources: [],
    }
    render(
      <HudCard
        guidance={ungrounded}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.getByText('Manual not found — verify against your manual.')).toBeInTheDocument()
    expect(
      screen.getByText('No source links — verify steps against the manual.'),
    ).toBeInTheDocument()
  })

  it('navigates steps and bounds Back/Next at the ends', () => {
    const props = renderCard(validGuidanceFixture)
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next Step' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next Step' }))
    expect(props.onStepChange).toHaveBeenCalledWith(1)
  })

  it('disables Next Step on the last step', () => {
    renderCard(validGuidanceFixture, { stepIndex: 2 })
    expect(screen.getByText('Step 3 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next Step' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
  })

  it('reports Scan Another Part through the callback', () => {
    const props = renderCard(validGuidanceFixture)
    fireEvent.click(screen.getByRole('button', { name: 'Scan Another Part' }))
    expect(props.onScanAnother).toHaveBeenCalledTimes(1)
  })

  it('orders steps first and sources last', () => {
    renderCard(validGuidanceFixture)
    const nodes = [
      screen.getByText('MID-DRIVE DRIVE BELT'),
      screen.getByText('Step 1 of 3'),
      screen.getByText('Specs'),
      screen.getByText('Tools: T25 Torx, Torque wrench'),
      screen.getByText('Warnings'),
      screen.getByRole('link', { name: 'Example Service Manual, Belt Drive chapter' }),
    ]
    expect(nodes).toHaveLength(6)
    nodes.reduce((prev, next) => {
      expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      return next
    })
  })

  it('uses the enlarged card type ramp', () => {
    renderCard(validGuidanceFixture)
    expect(screen.getByText('Remove the belt cover')).toHaveClass('text-lg')
    expect(
      screen.getByText('Undo the four cover screws and lift the cover clear of the drive.'),
    ).toHaveClass('text-base')
    expect(screen.getByText('Step 1 of 3')).toHaveClass('text-xs')
    expect(screen.getByText('Specs')).toHaveClass('text-xs')
  })

  it('shows a skeleton while guidance is pending', () => {
    renderCard(null, { pending: true })
    expect(screen.getByRole('status', { name: 'Loading guidance' })).toBeInTheDocument()
    expect(screen.queryByText('MID-DRIVE DRIVE BELT')).not.toBeInTheDocument()
  })

  it('renders nothing when idle without guidance', () => {
    const { container } = render(
      <HudCard
        guidance={null}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
