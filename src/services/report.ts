import type { GuidanceResult } from '../types'
import { getLogs } from './logger'

export interface ReportInput {
  guidance: GuidanceResult | null
  stepIndex: number
  /** Recent target labels inferred from conversation; empty when unknown. */
  workingOn?: string[]
}

/**
 * Build a markdown repair report: the procedure with step progress plus
 * the session log. Debug chatter is dropped; info/warn/error stays.
 */
export function buildReport({ guidance, stepIndex, workingOn }: ReportInput): string {
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
    guidance.steps.forEach((step, i) => {
      const mark = i < stepIndex ? '[x]' : i === stepIndex ? '[>]' : '[ ]'
      lines.push(`${mark} Step ${i + 1}: ${step.title} — ${step.detail}`)
      if (step.warning) lines.push(`    Warning: ${step.warning}`)
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

/** Download the report as a timestamped markdown file. */
export function downloadReport(input: ReportInput): void {
  const blob = new Blob([buildReport(input)], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `wrenchmind-report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
