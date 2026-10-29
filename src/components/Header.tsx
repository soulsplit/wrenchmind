import { useState } from 'react'
import type { Status } from '../types'
import { Dots, FLASHLIGHT, Icon, PAUSE_BARS } from './Icon'
import StatusBar from './StatusBar'
import Toggle from './Toggle'
import QrShare from './QrShare'
import LogPanel from './LogPanel'

interface HeaderProps {
  status: Status
  /** True while a camera stream is attached and playing; badge dims otherwise. */
  live: boolean
  /** True while locked onto an identified item; follow-ups answer by voice. */
  tracking: boolean
  voiceOn: boolean
  onVoiceToggle: (next: boolean) => void
  /** Actual facing from the stream's track settings; 'unknown' (desktop) renders CAMERA. */
  facing: 'environment' | 'user' | 'unknown'
  multiCamera: boolean
  onSwitchCamera: () => void
  onClearView: () => void
  onExportReport: () => void
  torchOn: boolean
  /** True when the active camera track reports torch capability. */
  hasTorch: boolean
  onTorchToggle: (next: boolean) => void
  /** True while the frame is frozen for tap-to-outline work. */
  frozen: boolean
  onFreezeToggle: (next: boolean) => void
  /** Optional instruction pill appended to the badge row; null hides it. */
  hint?: string | null
}

/**
 * Pin-top mobile header zone: an h-14 bar (brand + freeze/flashlight quick
 * toggles + overflow toggle) with the LIVE/facing/status badge row docked
 * over the feed beneath it. The flashlight toggle hides while frozen
 * (stopping the camera tracks kills the torch track, so it would be dead).
 * Voice toggle, QR share, logs, and secondary controls all live behind the
 * overflow menu, which closes after any item press (the inline Logs
 * disclosure expands inside the menu instead).
 *
 * No backdrop-blur/transform on this tree by design: QrShare's share dialog
 * is `position: fixed`, and a filter would re-anchor it to the header.
 */
export default function Header({
  status,
  live,
  tracking,
  voiceOn,
  onVoiceToggle,
  facing,
  multiCamera,
  onSwitchCamera,
  onClearView,
  onExportReport,
  torchOn,
  hasTorch,
  onTorchToggle,
  frozen,
  onFreezeToggle,
  hint,
}: HeaderProps) {
  const [overflowOpen, setOverflowOpen] = useState(false)
  // Tracks the QR dialog so QrShare stays mounted (trigger hidden) while its
  // dialog is open even though opening it closes the overflow menu.
  const [qrOpen, setQrOpen] = useState(false)
  const closeOverflow = () => setOverflowOpen(false)

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
        {(live || frozen) && (
          <button
            type="button"
            aria-label="Freeze frame"
            aria-pressed={frozen}
            onClick={() => onFreezeToggle(!frozen)}
            className={`min-h-[48px] min-w-[48px] px-3 rounded-lg flex items-center justify-center active:scale-95 transition ${
              frozen ? 'bg-green-500 text-white' : 'bg-white/10 text-white'
            }`}
          >
            <Icon d={PAUSE_BARS} />
          </button>
        )}
        {hasTorch && !frozen && (
          <button
            type="button"
            aria-label="Flashlight"
            aria-pressed={torchOn}
            onClick={() => onTorchToggle(!torchOn)}
            className={`min-h-[48px] min-w-[48px] px-3 rounded-lg flex items-center justify-center active:scale-95 transition ${
              torchOn ? 'bg-green-500 text-white' : 'bg-white/10 text-white'
            }`}
          >
            <Icon d={FLASHLIGHT} />
          </button>
        )}
        <div className="flex-1" aria-hidden="true" />
        <button
          type="button"
          onClick={() => setOverflowOpen((was) => !was)}
          aria-expanded={overflowOpen}
          aria-label="More options"
          className="min-h-[48px] min-w-[48px] px-3 rounded-lg bg-white/10 text-white flex items-center justify-center active:scale-95 transition"
        >
          <Dots />
        </button>
      </div>
      {(overflowOpen || qrOpen) && (
        <div
          className={
            overflowOpen
              ? 'absolute flex flex-col items-stretch gap-2 w-64 rounded-xl bg-black/90 border border-white/20 p-3'
              : undefined
          }
          style={
            overflowOpen
              ? {
                  top: 'calc(3.5rem + env(safe-area-inset-top))',
                  right: 'max(1rem, env(safe-area-inset-right))',
                }
              : undefined
          }
        >
          {overflowOpen && (
            <Toggle
              checked={voiceOn}
              onChange={(next) => {
                onVoiceToggle(next)
                closeOverflow()
              }}
              label="Voice mode"
            />
          )}
          <QrShare
            onOpen={() => {
              setQrOpen(true)
              closeOverflow()
            }}
            onClose={() => setQrOpen(false)}
            hideTrigger={!overflowOpen}
          />
          {overflowOpen && <LogPanel />}
          {overflowOpen && multiCamera && (
            <button
              type="button"
              onClick={() => {
                onSwitchCamera()
                closeOverflow()
              }}
              aria-label="Switch camera"
              className="min-h-[48px] w-full bg-white/90 text-black px-4 py-3 rounded-lg font-bold shadow text-base active:scale-95 transition"
            >
              Switch camera
            </button>
          )}
          {overflowOpen && (
            <button
              type="button"
              onClick={() => {
                onClearView()
                closeOverflow()
              }}
              className="min-h-[48px] w-full bg-white/90 text-black px-4 py-3 rounded-lg font-bold shadow text-base active:scale-95 transition"
            >
              Clear AR View
            </button>
          )}
          {overflowOpen && (
            <button
              type="button"
              onClick={() => {
                onExportReport()
                closeOverflow()
              }}
              className="min-h-[48px] w-full bg-white/90 text-black px-4 py-3 rounded-lg font-bold shadow text-base active:scale-95 transition"
            >
              Export Report
            </button>
          )}
        </div>
      )}
      <div
        className="px-4 pt-2 flex items-center gap-2 flex-wrap"
        style={{
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
        }}
      >
        {frozen ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white"
            role="status"
            aria-label="Frame frozen"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            FROZEN
          </span>
        ) : (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white ${live ? '' : 'opacity-60'}`}
            role="status"
            aria-label={live ? 'Camera live' : 'Camera off air'}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${live ? 'bg-red-500' : 'bg-white/30'}`}
              aria-hidden="true"
            />
            {live ? 'LIVE' : 'NO FEED'}
          </span>
        )}
        {live && (
          <span className="inline-flex items-center rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">
            {facing === 'environment'
              ? 'REAR CAMERA'
              : facing === 'user'
                ? 'FRONT CAMERA'
                : 'CAMERA'}
          </span>
        )}
        {tracking && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-300" aria-hidden="true" />
            Tracking
          </span>
        )}
        <StatusBar status={status} />
        {hint && !overflowOpen && (
          <span className="inline-flex items-center rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-200">
            {hint}
          </span>
        )}
      </div>
    </header>
  )
}
