import { useEffect, useState } from 'react'
import {
  clearLogs,
  formatLogs,
  getLogs,
  subscribe,
  type LogEntry,
  type LogLevel,
} from '../services/logger'

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: 'text-white/50',
  info: 'text-white/90',
  warn: 'text-yellow-300',
  error: 'text-red-400',
}

function downloadLogs(): void {
  const blob = new Blob([formatLogs()], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `wrenchmind-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

async function copyLogs(): Promise<void> {
  try {
    await navigator.clipboard.writeText(formatLogs())
  } catch {
    /* clipboard unavailable */
  }
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className={`whitespace-pre-wrap break-words ${LEVEL_COLOR[entry.level]}`}>
      [{entry.time.slice(11, 19)}] [{entry.level.toUpperCase()}] [{entry.tag}] {entry.message}
    </div>
  )
}

export default function LogPanel() {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<LogEntry[]>([])

  useEffect(() => {
    if (!open) return
    setEntries(getLogs())
    return subscribe(() => setEntries(getLogs()))
  }, [open ])

  return (
    <div className="flex flex-col items-stretch gap-2 w-full">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="min-h-[48px] w-full bg-white/90 text-black px-4 py-2 rounded-lg font-bold shadow text-base active:scale-95 transition"
      >
        {open ? 'Hide Logs' : 'Logs'}
      </button>
      {open && (
        <div className="w-full max-w-full rounded-lg bg-black/85 border border-white/20 p-3">
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => void copyLogs()}
              className="px-3 py-1.5 rounded bg-white/90 text-black text-sm font-bold"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={downloadLogs}
              className="px-3 py-1.5 rounded bg-white/90 text-black text-sm font-bold"
            >
              Download
            </button>
            <button
              type="button"
              onClick={() => clearLogs()}
              className="px-3 py-1.5 rounded bg-white/90 text-black text-sm font-bold"
            >
              Clear
            </button>
          </div>
          <div
            className="max-h-64 overflow-y-auto font-mono text-xs flex flex-col gap-0.5"
            role="log"
            aria-label="Application log"
          >
            {entries.length === 0 ? (
              <div className="text-white/50">No log entries yet.</div>
            ) : (
              entries.map((entry) => <LogLine key={entry.seq} entry={entry} />)
            )}
          </div>
        </div>
      )}
    </div>
  )
}
