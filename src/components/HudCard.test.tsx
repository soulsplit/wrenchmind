import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import HudCard from './HudCard'
import { validGuidanceFixture } from '../test/guidanceFixtures'
import type { GuidanceResult } from '../types'
import { ifixitSearchUrl, type FixitGuide } from '../services/ifixitApi'

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

describe('HudCard iFixit guides', () => {
  const guides: FixitGuide[] = [
    {
      title: 'iPhone 13 Battery Replacement',
      url: 'https://www.ifixit.com/Guide/iPhone+13+Battery+Replacement/145896',
      summary: 'iPhone batteries are rated to hold 80% of their capacity.',
      difficulty: 'Moderate',
      kind: 'guide',
    },
    {
      title: 'After replacing battery, iPhone will not connect to WiFi',
      url: 'https://www.ifixit.com/Answers/View/487556/After+replacing+battery',
      summary: 'I replaced battery in my iPhone 5. Now WiFi will not connect.',
      difficulty: null,
      kind: 'question',
    },
  ]

  it('renders the guides section after sources with external links and difficulty', () => {
    renderCard(validGuidanceFixture, { guides })
    const heading = screen.getByText('Guides via iFixit')
    const sourceLink = screen.getByRole('link', {
      name: 'Example Service Manual, Belt Drive chapter',
    })
    expect(sourceLink.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const guideLink = screen.getByRole('link', { name: 'iPhone 13 Battery Replacement' })
    expect(guideLink).toHaveAttribute(
      'href',
      'https://www.ifixit.com/Guide/iPhone+13+Battery+Replacement/145896',
    )
    expect(guideLink).toHaveAttribute('target', '_blank')
    expect(guideLink).toHaveAttribute('rel', 'noreferrer')
    expect(guideLink.parentElement?.textContent).toBe('iPhone 13 Battery Replacement · Moderate')
    expect(screen.getByText('External links open iFixit in a new tab.')).toBeInTheDocument()
  })

  it('omits the difficulty note when the guide has none', () => {
    renderCard(validGuidanceFixture, { guides: [guides[1]] })
    const link = screen.getByRole('link', { name: guides[1].title })
    expect(link.parentElement?.textContent).toBe(guides[1].title)
  })

  it('always shows the fallback search link when guidance is present', () => {
    const expected = ifixitSearchUrl(validGuidanceFixture.title)
    const name = `Search iFixit for ${validGuidanceFixture.title}`
    const { unmount } = render(
      <HudCard
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
        guides={guides}
      />,
    )
    const withGuides = screen.getByRole('link', { name })
    expect(withGuides).toHaveAttribute('href', expected)
    expect(withGuides).toHaveAttribute('target', '_blank')
    expect(withGuides).toHaveAttribute('rel', 'noreferrer')
    unmount()
    const second = render(
      <HudCard
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
        guides={[]}
      />,
    )
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', expected)
    second.unmount()
    render(
      <HudCard
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', expected)
  })

  it('shows the empty guides state but keeps the section and fallback link', () => {
    renderCard(validGuidanceFixture, { guides: [] })
    expect(screen.getByText('Guides via iFixit')).toBeInTheDocument()
    expect(screen.getByText('No iFixit guides found for this part.')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: `Search iFixit for ${validGuidanceFixture.title}` }),
    ).toBeInTheDocument()
  })

  it('shows neither list nor empty note while guides load', () => {
    renderCard(validGuidanceFixture, { guides: undefined })
    expect(screen.getByText('Guides via iFixit')).toBeInTheDocument()
    expect(screen.queryByText('No iFixit guides found for this part.')).not.toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: `Search iFixit for ${validGuidanceFixture.title}` }),
    ).toBeInTheDocument()
  })

  it('renders no guides section without guidance', () => {
    renderCard(null, { pending: true })
    expect(screen.queryByText('Guides via iFixit')).not.toBeInTheDocument()
  })

  it('minimizes to a slim bar that keeps title, step count, and expand', () => {
    renderCard(validGuidanceFixture)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize steps' }))
    expect(screen.getByText('MID-DRIVE DRIVE BELT')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Expand steps' }),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Remove the belt cover')).not.toBeInTheDocument()
    expect(screen.queryByText('Warnings')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next Step' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Scan Another Part' }),
    ).not.toBeInTheDocument()
  })

  it('expands back to the full steps view', () => {
    renderCard(validGuidanceFixture)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize steps' }))
    expect(screen.queryByText('Remove the belt cover')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand steps' }))
    expect(screen.getByText('Remove the belt cover')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next Step' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Minimize steps' }),
    ).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps minimized state across step changes', () => {
    const { rerender } = render(
      <HudCard
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Minimize steps' }))
    rerender(
      <HudCard
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={1}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Expand steps' })).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()
    expect(screen.queryByText('Release belt tension')).not.toBeInTheDocument()
  })

  it('re-opens the card when a fresh scan replaces the guidance', () => {
    const fresh: GuidanceResult = { ...validGuidanceFixture, title: 'ALTERNATOR BELT' }
    const { rerender } = render(
      <HudCard
        guidance={validGuidanceFixture}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Minimize steps' }))
    expect(screen.getByRole('button', { name: 'Expand steps' })).toBeInTheDocument()
    rerender(
      <HudCard
        guidance={fresh}
        pending={false}
        stepIndex={0}
        onStepChange={() => undefined}
        onScanAnother={() => undefined}
      />,
    )
    expect(screen.getByText('ALTERNATOR BELT')).toBeInTheDocument()
    expect(screen.getByText('Remove the belt cover')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Minimize steps' })).toBeInTheDocument()
  })
})
