import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

/** Warns when the shared URL won't work on a phone, or null when it will. */
export function getShareWarning(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    return 'This address only works on this device. Open the tunnel or network URL in this browser first, then scan.'
  }
  if (url.protocol === 'http:') {
    return 'HTTP only: the page will open but the camera requires HTTPS — use the tunnel URL.'
  }
  return null
}

/** Shows a QR code of the current page URL for opening it on another device. */
export default function QrShare() {
  const [open, setOpen] = useState(false)
  const [href, setHref] = useState('')

  useEffect(() => {
    if (!open) return
    setHref(window.location.href)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open ])

  return (
    <div className="flex flex-col items-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[48px] bg-white/90 text-black px-4 py-2 rounded-lg font-bold shadow text-base active:scale-95 transition"
      >
        QR
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="flex flex-col items-center gap-3 rounded-lg bg-white p-6 max-w-full"
            role="dialog"
            aria-modal="true"
            aria-label="Share via QR code"
            onClick={(event) => event.stopPropagation()}
          >
            <QRCodeSVG value={href} size={256} aria-label={`QR code for ${href}`} />
            <div className="text-sm text-black/70 break-all max-w-[280px] text-center">{href}</div>
            {href && getShareWarning(href) && (
              <div className="text-sm text-amber-700 bg-amber-100 rounded px-3 py-2 max-w-[280px] text-center">
                {getShareWarning(href)}
              </div>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
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
