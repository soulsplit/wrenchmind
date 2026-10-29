import { useEffect, useState } from 'react'
import type { GuidanceResult } from '../types'
import { ifixitSearchUrl, type FixitGuide } from '../services/ifixitApi'

interface HudCardProps {
  guidance: GuidanceResult | null
  pending: boolean
  stepIndex: number
  onStepChange: (index: number) => void
  onScanAnother: () => void
  /** iFixit guide hits; undefined while loading, empty when none found. */
  guides?: FixitGuide[]
}

const SHELL = 'w-full rounded-2xl bg-black/80 backdrop-blur-md p-4 flex flex-col gap-3'

/** Card size mode: slim bar, docked card, or tall docked card. */
type CardMode = 'normal' | 'minimized' | 'maximized'

const ICON_BUTTON =
  'min-h-[48px] min-w-[48px] shrink-0 rounded-lg bg-white/15 text-white active:scale-95 transition flex items-center justify-center'

/** Stroke icon; the accessible name always comes from the owning button. */
function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
    >
      <path d={d} />
    </svg>
  )
}

const CHEVRON_UP = 'M18 15l-6-6-6 6'
const CHEVRON_DOWN = 'M6 9l6 6 6-6'
const EXPAND_CORNERS = 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5'
const SHRINK_CORNERS = 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5'

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
 * buttons stay pinned and reachable (M4 landscape). Tri-state sizing:
 * minimized (slim bar), normal (44dvh docked card), maximized (80dvh docked
 * card) — maximized stays in the dock so findings, input, and step buttons
 * remain reachable.
 */
export default function HudCard({
  guidance,
  pending,
  stepIndex,
  onStepChange,
  onScanAnother,
  guides,
}: HudCardProps) {
  const [mode, setMode] = useState<CardMode>('normal')
  // A fresh scan always re-opens the card at normal size; step changes
  // keep its state.
  useEffect(() => {
    setMode('normal')
  }, [guidance])

  if (!guidance) {
    if (!pending) return null
    return <SkeletonCard />
  }

  const steps = guidance.steps
  const safeIndex = steps.length > 0 ? Math.min(Math.max(0, stepIndex), steps.length - 1) : 0
  const step = steps[safeIndex]

  if (mode === 'minimized') {
    return (
      <section aria-label="Repair guidance" className="w-full rounded-2xl bg-black/80 backdrop-blur-md px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-base font-bold text-white">
            {guidance.title}
          </div>
          {step && (
            <div className="shrink-0 text-sm font-semibold text-white/70">
              Step {safeIndex + 1} of {steps.length}
            </div>
          )}
          <button
            type="button"
            onClick={() => setMode('normal')}
            aria-expanded={false}
            aria-label="Expand steps"
            className={ICON_BUTTON}
          >
            <Icon d={CHEVRON_UP} />
          </button>
        </div>
      </section>
    )
  }

  const maximized = mode === 'maximized'
  return (
    <section
      aria-label="Repair guidance"
      className={`${SHELL} ${maximized ? 'max-h-[80dvh]' : 'max-h-[44dvh]'}`}
    >
      <div className="min-h-0 overflow-y-auto flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-xl font-bold tracking-tight text-white">
            {guidance.title}
          </h2>
          <button
            type="button"
            onClick={() => setMode('minimized')}
            aria-expanded={true}
            aria-label="Minimize steps"
            className={ICON_BUTTON}
          >
            <Icon d={CHEVRON_DOWN} />
          </button>
          {maximized ? (
            <button
              type="button"
              onClick={() => setMode('normal')}
              aria-expanded={true}
              aria-label="Restore steps"
              className={ICON_BUTTON}
            >
              <Icon d={SHRINK_CORNERS} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setMode('maximized')}
              aria-expanded={true}
              aria-label="Maximize steps"
              className={ICON_BUTTON}
            >
              <Icon d={EXPAND_CORNERS} />
            </button>
          )}
        </div>

        {step ? (
          <div className="rounded-xl bg-white/5 p-3 flex flex-col gap-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-white/60">
              Step {safeIndex + 1} of {steps.length}
            </div>
            <div className="text-lg font-semibold text-white">{step.title}</div>
            <div className="text-base text-white/85">{step.detail}</div>
            {step.warning && <div className="text-base text-amber-300">⚠ {step.warning}</div>}
          </div>
        ) : (
          <div className="text-base text-white/70">No steps available.</div>
        )}

        {guidance.specs.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-white/60">
              Specs
            </div>
            <ul className="flex flex-col gap-0.5">
              {guidance.specs.map((spec, i) => (
                <li key={`${spec.label}-${i}`} className="text-sm font-mono text-white/85">
                  {spec.label}: {spec.value}
                </li>
              ))}
            </ul>
            <div className="text-xs text-amber-200/80">Verify all specs against the manual.</div>
          </div>
        )}

        {guidance.tools.length > 0 && (
          <div className="text-sm text-white/70">Tools: {guidance.tools.join(', ')}</div>
        )}

        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-300/90">
            Warnings
          </div>
          {guidance.warnings.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {guidance.warnings.map((warning, i) => (
                <li key={`${warning}-${i}`} className="text-base text-amber-200">
                  ⚠ {warning}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-base text-amber-200/80">
              No specific warnings listed — verify all work against the manual.
            </div>
          )}
        </div>

        <div className="text-sm text-white/70 flex flex-col gap-0.5">
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

        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-white/60">
            Guides via iFixit
          </div>
          {guides !== undefined &&
            (guides.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {guides.map((guide, i) => (
                  <li key={`${guide.url}-${i}`} className="text-sm text-white/85">
                    <a
                      href={guide.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cyan-300 underline"
                    >
                      {guide.title}
                    </a>
                    {guide.difficulty && (
                      <span className="text-white/60"> · {guide.difficulty}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-white/70">No iFixit guides found for this part.</div>
            ))}
          <div className="text-xs text-white/60">External links open iFixit in a new tab.</div>
          <a
            href={ifixitSearchUrl(guidance.title)}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-cyan-300 underline"
          >
            Search iFixit for {guidance.title}
          </a>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {step && (
          // Handlers pass raw stepIndex (the owner clamps); only the
          // disabled states use safeIndex, which is display-only here.
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
