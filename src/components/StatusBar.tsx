import type { Status } from '../types'

interface StatusBarProps {
  status: Status
}

const LABELS: Record<Exclude<Status, 'analyzing' | 'off'>, string> = {
  listening: 'Listening',
  speaking: 'Speaking',
  error: 'Error',
}

const DOTS: Record<Exclude<Status, 'analyzing' | 'off'>, string> = {
  listening: 'bg-emerald-400',
  speaking: 'bg-cyan-300',
  error: 'bg-red-500',
}

/**
 * Inline status pill. Positioning is owned by the parent (the Header badge
 * row); this component only renders the label with its live-region semantics.
 * Same pill language as the LIVE/FROZEN badges (dot + uppercase). Renders
 * nothing while analyzing — the dock's Analyzing pill owns that state
 * (visually and for screen readers) to avoid a duplicate indicator — and
 * nothing while off (the voice toggle owns that state).
 */
export default function StatusBar({ status }: StatusBarProps) {
  if (status === 'analyzing' || status === 'off') return null
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white whitespace-nowrap"
      role="status"
      aria-live="polite"
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOTS[status]}`} aria-hidden="true" />
      {LABELS[status]}
    </div>
  )
}
