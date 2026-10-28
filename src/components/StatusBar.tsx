import type { Status } from '../types'

interface StatusBarProps {
  status: Status
}

const LABELS: Record<Status, string> = {
  off: '[ OFF ]',
  listening: '[ 🟢 LISTENING... ]',
  analyzing: '[ ⚡ ANALYZING... ]',
  error: '[ ⚠ ERROR ]',
}

/**
 * Inline status pill. Positioning is owned by the parent (the Header badge
 * row); this component only renders the label with its live-region semantics.
 */
export default function StatusBar({ status }: StatusBarProps) {
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
