import type { GuidanceResult } from '../types'

interface HudCardProps {
  guidance: GuidanceResult | null
  pending: boolean
  stepIndex: number
  onStepChange: (index: number) => void
  onScanAnother: () => void
}

const SHELL = 'w-full rounded-2xl bg-black/80 backdrop-blur-md p-4 flex flex-col gap-3'

function SkeletonCard() {
  return (
    <section aria-label="Repair guidance" className={`${SHELL} max-h-[44dvh]`}>
      <div role="status" aria-label="Loading guidance" aria-busy="true">
        <div className="motion-safe:animate-pulse flex flex-col gap-2" aria-hidden="true">
          <div className="h-6 w-2/3 rounded bg-white/15" />
          <div className="h-3 w-full rounded bg-white/10" />
          <div className="h-3 w-5/6 rounded bg-white/10" />
          <div className="h-16 w-full rounded-xl bg-white/5" />
          <div className="h-3 w-1/2 rounded bg-white/10" />
        </div>
      </div>
    </section>
  )
}

/**
 * Bottom-docked HUD action card for repair guidance (D2 trust posture: model
 * content is never authoritative — specs always carry the verify treatment,
 * the warnings slot always renders, and there is intentionally no numeric
 * confidence anywhere). Content scrolls internally past 44dvh so the step
 * buttons stay pinned and reachable (M4 landscape).
 */
export default function HudCard({
  guidance,
  pending,
  stepIndex,
  onStepChange,
  onScanAnother,
}: HudCardProps) {
  if (!guidance) {
    if (!pending) return null
    return <SkeletonCard />
  }

  const steps = guidance.steps
  const safeIndex = steps.length > 0 ? Math.min(Math.max(0, stepIndex), steps.length - 1) : 0
  const step = steps[safeIndex]

  return (
    <section aria-label="Repair guidance" className={`${SHELL} max-h-[44dvh]`}>
      <div className="min-h-0 overflow-y-auto flex flex-col gap-3">
        <h2 className="text-xl font-bold tracking-tight text-white">{guidance.title}</h2>

        <div className="text-xs text-white/70 flex flex-col gap-0.5">
          {guidance.manualTitle ? (
            <div>
              Manual: <span className="text-white/90">{guidance.manualTitle}</span>
            </div>
          ) : (
            <div>Manual not found — verify against your manual.</div>
          )}
          {guidance.sources.length > 0 ? (
            <div>
              Sources:{' '}
              {guidance.sources.map((source, i) => (
                <span key={`${source.url}-${i}`}>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-300 underline"
                  >
                    {source.title}
                  </a>
                  {i < guidance.sources.length - 1 ? '; ' : ''}
                </span>
              ))}
            </div>
          ) : (
            <div>No source links — verify steps against the manual.</div>
          )}
        </div>

        {step ? (
          <div className="rounded-xl bg-white/5 p-3 flex flex-col gap-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white/60">
              Step {safeIndex + 1} of {steps.length}
            </div>
            <div className="text-base font-semibold text-white">{step.title}</div>
            <div className="text-sm text-white/85">{step.detail}</div>
            {step.warning && <div className="text-sm text-amber-300">⚠ {step.warning}</div>}
          </div>
        ) : (
          <div className="text-sm text-white/70">No steps available.</div>
        )}

        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-300/90">
            Warnings
          </div>
          {guidance.warnings.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {guidance.warnings.map((warning, i) => (
                <li key={`${warning}-${i}`} className="text-sm text-amber-200">
                  ⚠ {warning}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-amber-200/80">
              No specific warnings listed — verify all work against the manual.
            </div>
          )}
        </div>

        {guidance.specs.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white/60">
              Specs
            </div>
            <ul className="flex flex-col gap-0.5">
              {guidance.specs.map((spec, i) => (
                <li key={`${spec.label}-${i}`} className="text-xs font-mono text-white/85">
                  {spec.label}: {spec.value}
                </li>
              ))}
            </ul>
            <div className="text-[11px] text-amber-200/80">
              Verify all specs against the manual.
            </div>
          </div>
        )}

        {guidance.tools.length > 0 && (
          <div className="text-xs text-white/70">Tools: {guidance.tools.join(', ')}</div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {step && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onStepChange(stepIndex - 1)}
              disabled={safeIndex <= 0}
              className="min-h-[48px] flex-1 rounded-lg bg-white/15 text-white font-bold text-base active:scale-95 transition disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => onStepChange(stepIndex + 1)}
              disabled={safeIndex >= steps.length - 1}
              className="min-h-[48px] flex-1 rounded-lg bg-white/90 text-black font-bold text-base active:scale-95 transition disabled:opacity-40"
            >
              Next Step
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onScanAnother}
          className="min-h-[48px] w-full rounded-lg bg-white/15 text-white font-bold text-base active:scale-95 transition"
        >
          Scan Another Part
        </button>
      </div>
    </section>
  )
}
