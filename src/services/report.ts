import type { GuidanceResult } from '../types'
import { getLogs } from './logger'

/** A superseded procedure: the guidance plus the step reached with it. */
export interface ProcedureSnapshot {
  guidance: GuidanceResult
  stepIndex: number
}

export interface ReportInput {
  guidance: GuidanceResult | null
  stepIndex: number
  /** Recent target labels inferred from conversation; empty when unknown. */
  workingOn?: string[]
  /** Transcribed label markings; omitted when none were read. */
  findings?: string[]
  /** Step checkpoints: 0-based step index plus JPEG data URL. */
  photos?: { step: number; dataUrl: string }[]
  /** Earlier procedures, oldest first; rendered without photos. */
  history?: ProcedureSnapshot[]
}

/** Max checkpoint photos embedded per report; data URLs bloat fast. */
export const MAX_REPORT_PHOTOS = 10

/** Escape dynamic text for HTML content and double-quoted attributes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const REPORT_CSS = [
  'body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#111;background:#fff}',
  'h1{font-size:1.5rem}h2{font-size:1.25rem;margin-top:1.5em}h3{font-size:1.05rem;margin-top:1.25em;color:#333}',
  '.meta{color:#555}.print-hint{color:#777;font-size:.9rem}',
  'img{max-width:100%;border:1px solid #ccc;border-radius:8px}',
  '.warning{color:#8a5a00}pre{background:#f4f4f4;padding:12px;border-radius:8px;overflow-x:auto;font-size:.8rem}',
  '@media print{.print-hint{display:none}body{padding:0}}',
].join('')

/**
 * Render one procedure: title, manual, steps with progress marks, specs,
 * tools, warnings, sources. Shared by the current procedure (with photos)
 * and history snapshots (without) so the two paths can't drift.
 */
function renderProcedure(
  out: string[],
  guidance: GuidanceResult,
  stepIndex: number,
  photoByStep?: Map<number, string>,
): void {
  const esc = escapeHtml
  out.push(`<h2>${esc(guidance.title)}</h2>`)
  out.push(
    guidance.manualTitle
      ? `<p>Manual: ${esc(guidance.manualTitle)}</p>`
      : '<p>Manual: not found — verify against your manual.</p>',
  )
  out.push('<h3>Steps</h3>')
  guidance.steps.forEach((step, i) => {
    const mark = i < stepIndex ? '[x]' : i === stepIndex ? '[>]' : '[ ]'
    out.push(`<p>${esc(`${mark} Step ${i + 1}: ${step.title} — ${step.detail}`)}</p>`)
    if (step.warning) out.push(`<p class="warning">Warning: ${esc(step.warning)}</p>`)
    const photo = photoByStep?.get(i)
    if (photo) out.push(`<img alt="Step ${i + 1} photo" src="${esc(photo)}">`)
  })
  if (guidance.specs.length > 0) {
    out.push('<h3>Specs (verify against the manual)</h3>', '<ul>')
    for (const spec of guidance.specs) out.push(`<li>${esc(spec.label)}: ${esc(spec.value)}</li>`)
    out.push('</ul>')
  }
  if (guidance.tools.length > 0) out.push(`<p>Tools: ${esc(guidance.tools.join(', '))}</p>`)
  out.push('<h3>Warnings</h3>', '<ul>')
  if (guidance.warnings.length > 0) {
    for (const warning of guidance.warnings) out.push(`<li>${esc(warning)}</li>`)
  } else {
    out.push('<li>No specific warnings listed — verify all work against the manual.</li>')
  }
  out.push('</ul>')
  if (guidance.sources.length > 0) {
    out.push('<h3>Sources</h3>', '<ul>')
    for (const source of guidance.sources) {
      out.push(`<li><a href="${esc(source.url)}">${esc(source.title)}</a></li>`)
    }
    out.push('</ul>')
  }
}

/**
 * Build a self-contained HTML repair report: the current procedure with
 * step progress and checkpoint photos, earlier procedures gathered this
 * session, plus the session log. Debug chatter is dropped; info/warn/error
 * stays. Static file, no scripts.
 */
export function buildReport({ guidance, stepIndex, workingOn, findings, photos, history }: ReportInput): string {
  const esc = escapeHtml
  const out: string[] = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>WrenchMind Repair Report</title>',
    `<style>${REPORT_CSS}</style>`,
    '</head>',
    '<body>',
    '<h1>WrenchMind Repair Report</h1>',
    `<p class="meta">Generated: ${esc(new Date().toISOString())}</p>`,
    `<p class="meta">Working on: ${workingOn && workingOn.length > 0 ? esc(workingOn.join(', ')) : 'not established'}</p>`,
    '<p class="print-hint">Tip: Print → Save as PDF for a PDF copy.</p>',
  ]
  const past = history ?? []
  if (!guidance && past.length === 0) {
    out.push('<p>No repair guidance was generated this session.</p>')
  } else {
    if (guidance) {
      // First-10-wins by step order: earliest checkpoints survive the cap,
      // and the first photo for a repeated step wins.
      const photoByStep = new Map<number, string>()
      for (const photo of [...(photos ?? [])]
        .sort((a, b) => a.step - b.step)
        .slice(0, MAX_REPORT_PHOTOS)) {
        if (!photoByStep.has(photo.step)) photoByStep.set(photo.step, photo.dataUrl)
      }
      renderProcedure(out, guidance, stepIndex, photoByStep)
    }
    if (past.length > 0) {
      out.push('<h2>Earlier this session</h2>')
      for (const snap of past) renderProcedure(out, snap.guidance, snap.stepIndex)
    }
  }
  if (findings && findings.length > 0) {
    out.push('<h3>Findings</h3>', '<ul>')
    for (const finding of findings) out.push(`<li>${esc(finding)}</li>`)
    out.push('</ul>')
  }
  out.push('<h3>Session log</h3>')
  const kept = getLogs().filter((e) => e.level !== 'debug')
  if (kept.length === 0) {
    out.push('<p>(empty)</p>')
  } else {
    out.push('<pre>')
    for (const e of kept) {
      out.push(esc(`[${e.time}] [${e.level.toUpperCase()}] [${e.tag}] ${e.message}`))
    }
    out.push('</pre>')
  }
  out.push('</body>', '</html>')
  return out.join('\n')
}

function reportFilename(): string {
  return `wrenchmind-report-${new Date().toISOString().replace(/[:.]/g, '-')}.html`
}

/** Download the report as a timestamped HTML file. */
export function downloadReport(input: ReportInput): void {
  const blob = new Blob([buildReport(input)], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = reportFilename()
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke past the click: Safari (and "ask where to save" prompts) fetch
  // the object URL asynchronously, so a synchronous revoke can empty the file.
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
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
    const file = new File([buildReport(input)], reportFilename(), { type: 'text/html' })
    if (!nav.canShare({ files: [file] })) return false
    await nav.share({ files: [file], title: 'WrenchMind Repair Report' })
    return true
  } catch {
    return false
  }
}
