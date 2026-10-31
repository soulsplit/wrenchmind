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

/** DOMException name of a getUserMedia failure, or '' for unknown shapes. */
function errorName(error: unknown): string {
  if (error instanceof DOMException) return error.name
  const name = (error as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' ? name : ''
}

/**
 * Actionable message for a getUserMedia failure. The DOMException name is
 * the only signal distinguishing a dismissed prompt from a busy or missing
 * camera, so callers must pass the caught error through instead of a
 * static string. Unknown shapes keep the legacy generic message.
 */
export function describeCameraError(error: unknown): string {
  switch (errorName(error)) {
    case 'NotAllowedError':
      return (
        'Camera permission was dismissed — tap Allow in the prompt, ' +
        'or re-enable it in site settings and reload.'
      )
    case 'NotReadableError':
      return 'Camera is busy — close other tabs or apps using it, then reload.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable camera found on this device.'
    default:
      return 'Camera access denied'
  }
}

/**
 * Actionable message for a mic getUserMedia failure. Mirrors
 * describeCameraError so mic and camera diagnoses stay unified; callers
 * must pass the caught error through. Unknown shapes keep the generic mic message.
 */
export function describeMicError(error: unknown): string {
  switch (errorName(error)) {
    case 'NotAllowedError':
      return (
        'Microphone permission was dismissed — tap Allow in the prompt, ' +
        'or re-enable it in site settings and reload.'
      )
    case 'NotReadableError':
      return 'Microphone is busy — close other tabs or apps using it, then reload.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable microphone found on this device.'
    default:
      return 'Microphone access denied'
  }
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
