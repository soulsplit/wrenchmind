import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Toggle from './Toggle'

describe('Toggle', () => {
  it('shows the enable label when off and reports the next state on click', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Enable Voice Assistant' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('shows the disable label when on', () => {
    const onChange = vi.fn()
    render(<Toggle checked={true} onChange={onChange} />)
    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveTextContent('Disable Voice')
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('uses a custom label when provided', () => {
    render(<Toggle checked={false} onChange={() => undefined} label="Voice" />)
    expect(screen.getByRole('switch', { name: 'Voice' })).toBeInTheDocument()
  })
})
