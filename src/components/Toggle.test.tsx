import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Toggle from './Toggle'

describe('Toggle', () => {
  it('shows the enable label when off and reports the next state on click', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Voice mode' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('shows the disable label when on', () => {
    const onChange = vi.fn()
    render(<Toggle checked={true} onChange={onChange} />)
    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveTextContent('Disable Voice mode')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('uses a custom label when provided', () => {
    render(<Toggle checked={false} onChange={() => undefined} label="Custom" />)
    expect(screen.getByRole('switch', { name: 'Custom' })).toBeInTheDocument()
  })

  it('derives the disable label from a custom label when on', () => {
    render(<Toggle checked={true} onChange={() => undefined} label="Custom" />)
    expect(screen.getByRole('switch', { name: 'Custom' })).toHaveTextContent('Disable Custom')
  })

  it('uses the high-contrast confirm fill when on', () => {
    render(<Toggle checked={true} onChange={() => undefined} />)
    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveClass('bg-confirm-deep', 'text-white')
    expect(toggle.className).not.toContain('bg-green-500')
  })

  it('gates press scaling behind motion-safe', () => {
    render(<Toggle checked={false} onChange={() => undefined} />)
    expect(screen.getByRole('switch').className).toContain('motion-safe:active:scale-95')
  })
})
