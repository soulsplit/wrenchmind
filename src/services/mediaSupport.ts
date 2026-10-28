/**
 * Precise media-failure diagnostics. Browsers reject getUserMedia without
 * prompting on insecure origins or when the permission is already blocked;
 * these helpers tell those cases apart so the UI can say what to do.
 */

/** Non-null when the environment itself blocks camera/mic access. */
export function secureContextBlocker(kind: 'Camera' | 'Microphone'): string | null {
  // Browsers always define isSecureContext as a boolean; only an explicit
  // false means insecure (non-browser runtimes leave it undefined).
  if (window.isSecureContext === false) {
    return (
      `${kind} needs HTTPS or localhost — browsers block it on plain HTTP. ` +
      'On this device open the localhost URL; on your phone open the HTTPS tunnel URL.'
    )
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    return `${kind} is not available in this browser.`
  }
  return null
}

/** Non-null when the permission is already in the blocked state. */
export async function permissionBlocker(
  name: 'camera' | 'microphone',
  label: string,
): Promise<string | null> {
  try {
    const status = await navigator.permissions?.query({ name: name as PermissionName })
    if (status?.state === 'denied') {
      return (
        `${label} is blocked for this site. ` +
        "Re-enable it in the browser's site settings, then retry."
      )
    }
  } catch {
    /* Permissions API unavailable — fall through to the generic message. */
  }
  return null
}
