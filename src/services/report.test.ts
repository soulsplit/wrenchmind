import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReport, downloadReport, shareReport } from './report'
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

  it('lists label findings when present, even without guidance', () => {
    const withGuidance = buildReport({ guidance, stepIndex: 0, findings: ['ABC-123', '24V DC'] })
    expect(withGuidance).toContain('### Findings')
    expect(withGuidance).toContain('- ABC-123')

    const withoutGuidance = buildReport({ guidance: null, stepIndex: 0, findings: ['ABC-123'] })
    expect(withoutGuidance).toContain('### Findings')

    const none = buildReport({ guidance, stepIndex: 0 })
    expect(none).not.toContain('### Findings')
  })

  it('embeds checkpoint photos under their steps, capped at 10', () => {
    const photos = [
      { step: 1, dataUrl: 'data:image/jpeg;base64,AAA' },
      { step: 0, dataUrl: 'data:image/jpeg;base64,BBB' },
    ]
    const report = buildReport({ guidance, stepIndex: 2, photos })
    expect(report).toContain('![Step 1 photo](data:image/jpeg;base64,BBB)')
    expect(report).toContain('![Step 2 photo](data:image/jpeg;base64,AAA)')
    expect(report.indexOf('BBB')).toBeLessThan(report.indexOf('[x] Step 2'))

    const long = {
      ...guidance,
      steps: Array.from({ length: 12 }, (_, i) => ({ title: `S${i}`, detail: 'do it' })),
    }
    const many = Array.from({ length: 12 }, (_, i) => ({ step: i, dataUrl: `data:image/jpeg;base64,P${i}` }))
    const capped = buildReport({ guidance: long, stepIndex: 0, photos: many })
    expect(capped.match(/!\[Step \d+ photo\]/g)).toHaveLength(10)
    expect(capped).not.toContain('P10')

    expect(buildReport({ guidance, stepIndex: 0 })).not.toContain('![Step')
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

describe('shareReport', () => {
  function installShare(impl: { canShare: () => boolean; share: () => Promise<void> }): void {
    Object.defineProperty(navigator, 'canShare', { value: vi.fn(impl.canShare), configurable: true })
    Object.defineProperty(navigator, 'share', { value: vi.fn(impl.share), configurable: true })
  }

  function clearShare(): void {
    const nav = navigator as unknown as Record<string, unknown>
    delete nav['canShare']
    delete nav['share']
  }

  it('shares the report file when the platform accepts it', async () => {
    installShare({ canShare: () => true, share: async () => {} })
    try {
      const ok = await shareReport({ guidance, stepIndex: 0 })
      expect(ok).toBe(true)
      const share = navigator as unknown as { share: (...args: unknown[]) => void }
      expect(vi.mocked(share.share)).toHaveBeenCalledTimes(1)
      const data = vi.mocked(share.share).mock.calls[0][0] as { files: File[]; title: string }
      expect(data.files).toHaveLength(1)
      expect(data.files[0].name).toMatch(/^wrenchmind-report-.*\.md$/)
      await expect(data.files[0].text()).resolves.toContain('# WrenchMind Repair Report')
    } finally {
      clearShare()
    }
  })

  it('returns false when sharing is unavailable', async () => {
    clearShare()
    await expect(shareReport({ guidance, stepIndex: 0 })).resolves.toBe(false)
  })

  it('returns false when the platform rejects the file', async () => {
    installShare({ canShare: () => false, share: async () => {} })
    try {
      await expect(shareReport({ guidance, stepIndex: 0 })).resolves.toBe(false)
      const share = navigator as unknown as { share: (...args: unknown[]) => void }
      expect(vi.mocked(share.share)).not.toHaveBeenCalled()
    } finally {
      clearShare()
    }
  })

  it('returns false when the user dismisses the sheet', async () => {
    installShare({
      canShare: () => true,
      share: async () => {
        throw new DOMException('dismissed', 'AbortError')
      },
    })
    try {
      await expect(shareReport({ guidance, stepIndex: 0 })).resolves.toBe(false)
    } finally {
      clearShare()
    }
  })
})
