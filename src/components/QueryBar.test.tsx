import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import QueryBar from './QueryBar'

describe('QueryBar', () => {
  it('submits trimmed text and clears the input', () => {
    const onSubmit = vi.fn()
    render(<QueryBar onSubmit={onSubmit} onPhotoSelect={vi.fn()} />)
    const input = screen.getByLabelText('Query text')
    fireEvent.change(input, { target: { value: '  show screws  ' } })
    fireEvent.click(screen.getByText('Send'))
    expect(onSubmit).toHaveBeenCalledWith('show screws')
    expect(input).toHaveValue('')
  })

  it('submits on form enter and ignores blank queries', () => {
    const onSubmit = vi.fn()
    render(<QueryBar onSubmit={onSubmit} onPhotoSelect={vi.fn()} />)
    fireEvent.submit(screen.getByLabelText('Text query'))
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'blend door' } })
    fireEvent.submit(screen.getByLabelText('Text query'))
    expect(onSubmit).toHaveBeenCalledWith('blend door')
  })

  it('routes a picked photo to onPhotoSelect', () => {
    const onPhotoSelect = vi.fn()
    render(<QueryBar onSubmit={vi.fn()} onPhotoSelect={onPhotoSelect} />)
    const picker = screen.getByLabelText('Upload photo')
    const file = new File(['bytes'], 'engine.jpg', { type: 'image/jpeg' })
    fireEvent.change(picker, { target: { files: [file] } })
    expect(onPhotoSelect).toHaveBeenCalledWith(file)
  })

  it('ignores an empty pick without calling onPhotoSelect', () => {
    const onPhotoSelect = vi.fn()
    render(<QueryBar onSubmit={vi.fn()} onPhotoSelect={onPhotoSelect} />)
    fireEvent.change(screen.getByLabelText('Upload photo'), { target: { files: [] } })
    expect(onPhotoSelect).not.toHaveBeenCalled()
  })
})
