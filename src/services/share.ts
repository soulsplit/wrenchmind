/**
 * Warns when the shared URL won't work on a phone, or null when it will.
 * Localhost only works on the sharing device; plain LAN HTTP opens but
 * can't use the camera (secure-context requirement).
 */
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
