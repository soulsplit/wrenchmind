import type { Status } from '../types'

interface StatusBarProps {
  status: Status
}

const LABELS: Record<Exclude<Status, 'analyzing'>, string> = {
  off: '[ OFF ]',
  listening: '[ 🟢 LISTENING... ]',
  error: '[ ⚠ ERROR ]',
}

/**
 * Inline status pill. Positioning is owned by the parent (the Header badge
 * row); this component only renders the label with its live-region semantics.
 * Renders nothing while analyzing — the dock's Analyzing pill owns that
 * state (visually and for screen readers) to avoid a duplicate indicator.
 */
export default function StatusBar({ status }: StatusBarProps) {
  if (status === 'analyzing') return null
  return (
    <div
      className="bg-black/70 text-white px-3 py-1 rounded-full text-xs font-mono whitespace-nowrap"
      role="status"
      aria-live="polite"
    >
      {LABELS[status]}
    </div>
  )
}
