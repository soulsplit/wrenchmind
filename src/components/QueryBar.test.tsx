import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import QueryBar from './QueryBar'

describe('QueryBar', () => {
  it('submits trimmed text and clears the input', () => {
    const onSubmit = vi.fn()
    render(<QueryBar onSubmit={onSubmit} />)
    const input = screen.getByLabelText('Query text')
    fireEvent.change(input, { target: { value: '  show screws  ' } })
    fireEvent.click(screen.getByText('Send'))
    expect(onSubmit).toHaveBeenCalledWith('show screws')
    expect(input).toHaveValue('')
  })

  it('submits on form enter and ignores blank queries', () => {
    const onSubmit = vi.fn()
    render(<QueryBar onSubmit={onSubmit} />)
    fireEvent.submit(screen.getByLabelText('Text query'))
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'blend door' } })
    fireEvent.submit(screen.getByLabelText('Text query'))
    expect(onSubmit).toHaveBeenCalledWith('blend door')
  })
})
