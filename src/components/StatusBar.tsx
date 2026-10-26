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

export default function StatusBar({ status }: StatusBarProps) {
  return (
    <div
      className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-full text-sm font-mono whitespace-nowrap"
      style={{ marginTop: 'env(safe-area-inset-top)' }}
      role="status"
      aria-live="polite"
    >
      {LABELS[status]}
    </div>
  )
}
