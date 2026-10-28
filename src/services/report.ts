import type { GuidanceResult } from '../types'
import { getLogs } from './logger'

export interface ReportInput {
  guidance: GuidanceResult | null
  stepIndex: number
  /** Recent target labels inferred from conversation; empty when unknown. */
  workingOn?: string[]
  /** Transcribed label markings; omitted when none were read. */
  findings?: string[]
  /** Step checkpoints: 0-based step index plus JPEG data URL. */
  photos?: { step: number; dataUrl: string }[]
}

/** Max checkpoint photos embedded per report; data URLs bloat fast. */
export const MAX_REPORT_PHOTOS = 10

/**
 * Build a markdown repair report: the procedure with step progress plus
 * the session log. Debug chatter is dropped; info/warn/error stays.
 */
export function buildReport({ guidance, stepIndex, workingOn, findings, photos }: ReportInput): string {
  const lines: string[] = [
    '# WrenchMind Repair Report',
    `Generated: ${new Date().toISOString()}`,
    `Working on: ${workingOn && workingOn.length > 0 ? workingOn.join(', ') : 'not established'}`,
    '',
  ]
  if (!guidance) {
    lines.push('No repair guidance was generated this session.', '')
  } else {
    lines.push(`## ${guidance.title}`)
    lines.push(
      guidance.manualTitle ? `Manual: ${guidance.manualTitle}` : 'Manual: not found — verify against your manual.',
    )
    lines.push('', '### Steps')
    const photoByStep = new Map(
      [...(photos ?? [])].sort((a, b) => a.step - b.step).slice(0, MAX_REPORT_PHOTOS).map((p) => [p.step, p.dataUrl] as const),
    )
    guidance.steps.forEach((step, i) => {
      const mark = i < stepIndex ? '[x]' : i === stepIndex ? '[>]' : '[ ]'
      lines.push(`${mark} Step ${i + 1}: ${step.title} — ${step.detail}`)
      if (step.warning) lines.push(`    Warning: ${step.warning}`)
      const photo = photoByStep.get(i)
      if (photo) lines.push(`![Step ${i + 1} photo](${photo})`)
    })
    if (guidance.specs.length > 0) {
      lines.push('', '### Specs (verify against the manual)')
      for (const spec of guidance.specs) lines.push(`- ${spec.label}: ${spec.value}`)
    }
    if (guidance.tools.length > 0) lines.push('', `Tools: ${guidance.tools.join(', ')}`)
    lines.push('', '### Warnings')
    if (guidance.warnings.length > 0) {
      for (const warning of guidance.warnings) lines.push(`- ${warning}`)
    } else {
      lines.push('- No specific warnings listed — verify all work against the manual.')
    }
    if (guidance.sources.length > 0) {
      lines.push('', '### Sources')
      for (const source of guidance.sources) lines.push(`- [${source.title}](${source.url})`)
    }
    lines.push('')
  }
  if (findings && findings.length > 0) {
    lines.push('### Findings')
    for (const finding of findings) lines.push(`- ${finding}`)
    lines.push('')
  }
  lines.push('### Session log')
  const kept = getLogs().filter((e) => e.level !== 'debug')
  if (kept.length === 0) {
    lines.push('(empty)')
  } else {
    for (const e of kept) {
      lines.push(`[${e.time}] [${e.level.toUpperCase()}] [${e.tag}] ${e.message}`)
    }
  }
  return lines.join('\n')
}

function reportFilename(): string {
  return `wrenchmind-report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
}

/** Download the report as a timestamped markdown file. */
export function downloadReport(input: ReportInput): void {
  const blob = new Blob([buildReport(input)], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = reportFilename()
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

interface ShareNavigator {
  canShare?: (data: { files: File[] }) => boolean
  share?: (data: { files: File[]; title?: string }) => Promise<void>
}

/**
 * Share the report through the OS share sheet. True when the sheet
 * accepted it; false when sharing is unavailable, the file is rejected,
 * or the user dismissed it — the caller falls back to downloadReport.
 * Everything before navigator.share() is synchronous so the call keeps
 * its user activation.
 */
export async function shareReport(input: ReportInput): Promise<boolean> {
  try {
    const nav = navigator as Navigator & ShareNavigator
    if (typeof nav.canShare !== 'function' || typeof nav.share !== 'function') return false
    const file = new File([buildReport(input)], reportFilename(), { type: 'text/markdown' })
    if (!nav.canShare({ files: [file] })) return false
    await nav.share({ files: [file], title: 'WrenchMind Repair Report' })
    return true
  } catch {
    return false
  }
}
