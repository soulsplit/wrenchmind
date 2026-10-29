import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { getShareWarning } from '../services/share'

const SHARE_URL_KEY = 'wrenchmind.shareUrl'

function isValidUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/** A previously saved override (e.g. the tunnel URL), or null. */
function loadSavedUrl(): string | null {
  try {
    const saved = window.localStorage.getItem(SHARE_URL_KEY)
    return saved && isValidUrl(saved) ? saved : null
  } catch {
    return null
  }
}

function saveUrl(url: string): void {
  try {
    window.localStorage.setItem(SHARE_URL_KEY, url)
  } catch {
    /* private mode etc. — the QR still works for this session */
  }
}

function clearSavedUrl(): void {
  try {
    window.localStorage.removeItem(SHARE_URL_KEY)
  } catch {
    /* ignore */
  }
}

interface QrShareProps {
  /** Invoked when the share dialog opens. */
  onOpen?: () => void
  /** Invoked when the share dialog closes. */
  onClose?: () => void
  /** Hides the QR trigger button; the dialog still renders when open. */
  hideTrigger?: boolean
}

/**
 * Shows a QR code for opening the app on another device. Defaults to the
 * current page URL, but the user can paste an override (typically the
 * cloudflared tunnel URL) which is remembered across sessions.
 */
export default function QrShare({ onOpen, onClose, hideTrigger = false }: QrShareProps = {}) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(() => loadSavedUrl() ?? window.location.href)
  const [draft, setDraft] = useState(() => loadSavedUrl() ?? window.location.href)

  const openDialog = (): void => {
    setOpen(true)
    onOpen?.()
  }

  const closeDialog = (): void => {
    setOpen(false)
    onClose?.()
  }

  useEffect(() => {
    if (!open) return
    const initial = loadSavedUrl() ?? window.location.href
    setUrl(initial)
    setDraft(initial)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const onDraftChange = (value: string): void => {
    setDraft(value)
    if (isValidUrl(value)) {
      setUrl(value)
      saveUrl(value)
    }
  }

  const useCurrentPage = (): void => {
    clearSavedUrl()
    setUrl(window.location.href)
    setDraft(window.location.href)
  }

  return (
    <div className="flex flex-col items-start">
      {!hideTrigger && (
        <button
          type="button"
          onClick={openDialog}
          className="min-h-[48px] bg-white/90 text-black px-4 py-2 rounded-lg font-bold shadow text-base active:scale-95 transition"
        >
          QR
        </button>
      )}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={closeDialog}
          role="presentation"
        >
          <div
            className="flex flex-col items-center gap-3 rounded-lg bg-white p-6 max-w-full"
            role="dialog"
            aria-modal="true"
            aria-label="Share via QR code"
            onClick={(event) => event.stopPropagation()}
          >
            <QRCodeSVG value={url} size={256} aria-label={`QR code for ${url}`} />
            <div className="text-sm text-black/70 break-all max-w-[280px] text-center">{url}</div>
            <label
              className="flex flex-col gap-1 w-full max-w-[280px] text-sm text-black/70"
              htmlFor="qr-share-url"
            >
              Share URL (paste the tunnel URL here)
              <input
                id="qr-share-url"
                type="url"
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://…trycloudflare.com/wrenchmind/"
                className="min-h-[48px] px-3 py-2 rounded-lg border border-black/20 text-black text-base outline-none focus:border-black/60"
              />
            </label>
            <button
              type="button"
              onClick={useCurrentPage}
              className="min-h-[48px] px-4 py-2 rounded-lg bg-black/10 text-black font-bold text-base active:scale-95 transition"
            >
              Use current page
            </button>
            {!isValidUrl(draft) ? (
              <div className="text-sm text-amber-700 bg-amber-100 rounded px-3 py-2 max-w-[280px] text-center">
                Enter a valid URL (https://…) — showing the last valid one.
              </div>
            ) : (
              url &&
              getShareWarning(url) && (
                <div className="text-sm text-amber-700 bg-amber-100 rounded px-3 py-2 max-w-[280px] text-center">
                  {getShareWarning(url)}
                </div>
              )
            )}
            <button
              type="button"
              onClick={closeDialog}
              className="min-h-[48px] px-4 py-2 rounded-lg bg-black/90 text-white font-bold text-base"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
