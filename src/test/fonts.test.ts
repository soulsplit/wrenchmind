import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const EXPECTED_FONTS = [
  { family: 'Inter', weight: '400', file: 'inter-latin-400-normal.woff2' },
  { family: 'Inter', weight: '500', file: 'inter-latin-500-normal.woff2' },
  { family: 'Inter', weight: '600', file: 'inter-latin-600-normal.woff2' },
  { family: 'Inter', weight: '700', file: 'inter-latin-700-normal.woff2' },
  { family: 'JetBrains Mono', weight: '400', file: 'jetbrains-mono-latin-400-normal.woff2' },
  { family: 'JetBrains Mono', weight: '500', file: 'jetbrains-mono-latin-500-normal.woff2' },
  { family: 'JetBrains Mono', weight: '600', file: 'jetbrains-mono-latin-600-normal.woff2' },
] as const

describe('vendored fonts (D4)', () => {
  it('ships the 7 latin-subset woff2 files', () => {
    expect(EXPECTED_FONTS).toHaveLength(7)
    for (const { file } of EXPECTED_FONTS) {
      const path = join(root, 'public', 'fonts', file)
      expect(statSync(path).size).toBeGreaterThan(0)
      const magic = readFileSync(path).subarray(0, 4).toString('ascii')
      expect(magic).toBe('wOF2')
    }
  })

  it('declares a @font-face with font-display: swap for every face', () => {
    const css = readFileSync(join(root, 'src', 'index.css'), 'utf8')
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? []
    expect(faces).toHaveLength(7)
    for (const { family, weight, file } of EXPECTED_FONTS) {
      const face = faces.find((f) => f.includes(file))
      expect(face, `missing @font-face for ${file}`).toBeDefined()
      expect(face).toContain(`font-family: '${family}'`)
      expect(face).toContain(`font-weight: ${weight}`)
      expect(face).toContain('font-display: swap')
      expect(face).toContain("format('woff2')")
    }
  })

  it('has no runtime font CDN dependency', () => {
    const css = readFileSync(join(root, 'src', 'index.css'), 'utf8')
    expect(css).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/)
  })
})
