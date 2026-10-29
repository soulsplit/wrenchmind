import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import StatusBar from './StatusBar'
import type { Status } from '../types'

describe('StatusBar', () => {
  it.each<[Exclude<Status, 'analyzing' | 'off'>, string]>([
    ['listening', 'Listening'],
    ['speaking', 'Speaking'],
    ['error', 'Error'],
  ])('renders %s as %s', (status, label) => {
    render(<StatusBar status={status} />)
    const el = screen.getByRole('status')
    expect(el).toHaveTextContent(label)
  })

  it('renders nothing while analyzing (the dock pill owns that state)', () => {
    const { container } = render(<StatusBar status="analyzing" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing while off (the voice toggle owns that state)', () => {
    const { container } = render(<StatusBar status="off" />)
    expect(container).toBeEmptyDOMElement()
  })
})
