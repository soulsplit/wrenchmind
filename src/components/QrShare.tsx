import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { getShareWarning } from '../services/share'

const SHARE_URL_KEY = 'wrenchmind.shareUrl'

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
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
  /**
   * Initial dialog state for mounts that only exist while the dialog is
   * already open (the header mounts a triggerless copy after its menu
   * closes). Uncontrolled after mount.
   */
  defaultOpen?: boolean
}

/**
 * Shows a QR code for opening the app on another device. Defaults to the
 * current page URL, but the user can paste an override (typically the
 * cloudflared tunnel URL) which is remembered across sessions.
 */
export default function QrShare({ onOpen, onClose, hideTrigger = false, defaultOpen = false }: QrShareProps = {}) {
  const [open, setOpen] = useState(defaultOpen)
  const [url, setUrl] = useState(() => loadSavedUrl() ?? window.location.href)
  const [draft, setDraft] = useState(() => loadSavedUrl() ?? window.location.href)
  const dialogRef = useRef<HTMLDivElement>(null)
  // onClose is an inline arrow from Header: read it through a ref so its
  // identity churn never retriggers the dialog effects mid-session.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

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
        onCloseRef.current?.()
        return
      }
      // Trap Tab inside the dialog while it is open.
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Move focus into the dialog on open and restore it on close/unmount.
  // Deps are [open] only so an onClose identity change mid-dialog never
  // yanks focus away and back. Restoring to <body> is skipped: it is never
  // a useful target, and it would steal focus the opener just placed
  // (Header returns focus to its toggle after the QR dialog closes).
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (prev instanceof HTMLElement && prev !== document.body) prev.focus()
    }
  }, [open])

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

  const shareWarning = getShareWarning(url)
  // Shrink the code on short (landscape) viewports so the dialog fits.
  const qrSize = Math.min(256, Math.floor(window.innerHeight * 0.35))

  return (
    <div className="flex flex-col items-stretch w-full">
      {!hideTrigger && (
        <button
          type="button"
          onClick={openDialog}
          className="min-h-[48px] w-full bg-white/90 text-black px-4 py-2 rounded-lg font-bold shadow text-base motion-safe:active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2"
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
            ref={dialogRef}
            tabIndex={-1}
            className="flex flex-col items-center gap-3 rounded-lg bg-white p-6 max-w-full max-h-full overflow-y-auto outline-none"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qr-share-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="qr-share-title" className="text-lg font-bold text-black">
              Share via QR code
            </h2>
            <QRCodeSVG value={url} size={qrSize} aria-label={`QR code for ${url}`} />
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
              className="min-h-[48px] px-4 py-2 rounded-lg bg-black/10 text-black font-bold text-base motion-safe:active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/60"
            >
              Use current page
            </button>
            {!isValidUrl(draft) ? (
              <div className="text-sm text-amber-700 bg-amber-100 rounded px-3 py-2 max-w-[280px] text-center">
                Enter a valid URL (https://…) — showing the last valid one.
              </div>
            ) : (
              shareWarning && (
                <div className="text-sm text-amber-700 bg-amber-100 rounded px-3 py-2 max-w-[280px] text-center">
                  {shareWarning}
                </div>
              )
            )}
            <button
              type="button"
              onClick={closeDialog}
              className="min-h-[48px] px-4 py-2 rounded-lg bg-black/90 text-white font-bold text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/60"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
