import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  CHEVRON_DOWN,
  CHEVRON_UP,
  Dots,
  EXPAND_CORNERS,
  FLASHLIGHT,
  Icon,
  PAUSE_BARS,
  SHRINK_CORNERS,
} from './Icon'

describe('Icon', () => {
  it('renders a stroked svg with the given path', () => {
    const { container } = render(<Icon d={CHEVRON_UP} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.getAttribute('fill')).toBe('none')
    expect(svg?.getAttribute('class')).toContain('h-6 w-6')
    expect(container.querySelector('path')?.getAttribute('d')).toBe(CHEVRON_UP)
  })

  it('exposes distinct paths for each control glyph', () => {
    const paths = new Set([
      CHEVRON_UP,
      CHEVRON_DOWN,
      EXPAND_CORNERS,
      SHRINK_CORNERS,
      PAUSE_BARS,
      FLASHLIGHT,
    ])
    // Each control maps to its own glyph; a duplicate would render twins.
    expect(paths.size).toBe(6)
    for (const d of paths) {
      expect(typeof d).toBe('string')
      expect(d.length).toBeGreaterThan(0)
    }
  })
})

describe('Dots', () => {
  it('renders three filled dots with no accessible name', () => {
    render(<Dots />)
    const svg = document.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.querySelectorAll('circle')).toHaveLength(3)
    // The owning button supplies the name; the dots stay silent.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
