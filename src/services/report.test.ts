import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReport, downloadReport } from './report'
import { clearLogs, logDebug, logError, logInfo, logWarn } from './logger'
import { validGuidanceFixture as guidance } from '../test/guidanceFixtures'

beforeEach(() => {
  clearLogs()
})

describe('buildReport', () => {
  it('renders the procedure with step progress, specs, tools, and warnings', () => {
    logInfo('phrase', '"show belt"')
    logDebug('camera', 'burst: 3 frames')

    const report = buildReport({ guidance, stepIndex: 1, workingOn: ['Drive belt', 'Tensioner'] })

    expect(report).toContain('# WrenchMind Repair Report')
    expect(report).toContain('Working on: Drive belt, Tensioner')
    expect(report).toContain('## MID-DRIVE DRIVE BELT')
    expect(report).toContain('Manual: Example Service Manual')
    expect(report).toContain('[x] Step 1: Remove the belt cover')
    expect(report).toContain('[>] Step 2: Release belt tension')
    expect(report).toContain('[ ] Step 3: Fit the new belt')
    expect(report).toContain('Warning: Keep fingers clear of the tensioner spring.')
    expect(report).toContain('Belt tension: 45 Hz')
    expect(report).toContain('Tools: T25 Torx, Torque wrench')
    expect(report).toContain('Disconnect the battery before starting work.')
    expect(report).toContain('https://example.com/manuals/belt-drive')
    expect(report).toContain('[phrase] "show belt"')
    expect(report).not.toContain('burst: 3 frames')
  })

  it('keeps warnings and errors from the session log', () => {
    logWarn('guidance', 'guidance unavailable: timeout')
    logError('phrase', 'SAM 503')

    const report = buildReport({ guidance: null, stepIndex: 0 })
    expect(report).toContain('No repair guidance was generated this session.')
    expect(report).toContain('Working on: not established')
    expect(report).toContain('[guidance] guidance unavailable: timeout')
    expect(report).toContain('[phrase] SAM 503')
  })
})

describe('downloadReport', () => {
  it('downloads the report as a markdown file', async () => {
    const captured: { blob: Blob | null } = { blob: null }
    const createObjectURL = vi.fn((blob: Blob) => {
      captured.blob = blob
      return 'blob:fake'
    })
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    let download = ''
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        download = this.download
      })

    downloadReport({ guidance, stepIndex: 0 })

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(captured.blob?.type).toBe('text/markdown')
    expect(download).toMatch(/^wrenchmind-report-.*\.md$/)
    expect(click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake')
    await expect(captured.blob?.text()).resolves.toContain('# WrenchMind Repair Report')
  })
})
