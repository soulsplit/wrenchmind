import { useState } from 'react'
import type { Status } from '../types'
import StatusBar from './StatusBar'
import Toggle from './Toggle'
import QrShare from './QrShare'
import LogPanel from './LogPanel'

interface HeaderProps {
  status: Status
  voiceOn: boolean
  onVoiceToggle: (next: boolean) => void
  facing: 'environment' | 'user'
  multiCamera: boolean
  onSwitchCamera: () => void
  onClearView: () => void
}

/**
 * Pin-top mobile header zone: an h-14 bar (brand, voice toggle, one-tap QR,
 * overflow for logs + secondary controls) with the LIVE/facing/status badge
 * row docked over the feed beneath it.
 *
 * No backdrop-blur/transform on this tree by design: QrShare's share dialog
 * is `position: fixed`, and a filter would re-anchor it to the header.
 */
export default function Header({
  status,
  voiceOn,
  onVoiceToggle,
  facing,
  multiCamera,
  onSwitchCamera,
  onClearView,
}: HeaderProps) {
  const [overflowOpen, setOverflowOpen] = useState(false)

  return (
    <header
      className="absolute top-0 inset-x-0 z-20"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div
        className="h-14 px-4 flex items-center gap-2 bg-black/70"
        style={{
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
        }}
      >
        <span className="min-w-0 truncate text-xs font-bold tracking-wide text-white">
          WRENCHMIND
        </span>
        <Toggle checked={voiceOn} onChange={onVoiceToggle} label="Voice" />
        <div className="flex-1" aria-hidden="true" />
        <QrShare />
        <button
          type="button"
          onClick={() => setOverflowOpen((was) => !was)}
          aria-expanded={overflowOpen}
          aria-label="More options"
          className="min-h-[48px] min-w-[48px] px-3 rounded-lg bg-white/10 text-white font-bold text-xl leading-none active:scale-95 transition"
        >
          ⋯
        </button>
      </div>
      {overflowOpen && (
        <div
          className="absolute flex flex-col items-end gap-2 rounded-xl bg-black/90 border border-white/20 p-3"
          style={{
            top: 'calc(3.5rem + env(safe-area-inset-top))',
            right: 'max(1rem, env(safe-area-inset-right))',
          }}
        >
          <LogPanel />
          {multiCamera && (
            <button
              type="button"
              onClick={onSwitchCamera}
              aria-label="Switch camera"
              className="min-h-[48px] bg-white/90 text-black px-4 py-3 rounded-lg font-bold shadow text-base active:scale-95 transition"
            >
              Switch camera
            </button>
          )}
          <button
            type="button"
            onClick={onClearView}
            className="min-h-[48px] bg-white/90 text-black px-4 py-3 rounded-lg font-bold shadow text-base active:scale-95 transition"
          >
            Clear AR View
          </button>
        </div>
      )}
      <div
        className="px-4 pt-2 flex items-center gap-2 flex-wrap"
        style={{
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
        }}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
          LIVE
        </span>
        <span className="inline-flex items-center rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">
          {facing === 'environment' ? 'REAR CAMERA' : 'FRONT CAMERA'}
        </span>
        <StatusBar status={status} />
      </div>
    </header>
  )
}
