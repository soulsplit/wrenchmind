import { describe, expect, it } from 'vitest'
import { APP_VERSION } from './version'
import packageJson from '../package.json'

describe('version', () => {
  it('matches the version in package.json', () => {
    expect(APP_VERSION).toBe(packageJson.version)
  })

  it('is a semver triple', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
