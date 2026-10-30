/**
 * Voice-side phrase hygiene: wake-word stripping, self-echo suppression, and
 * the idle-reprompt gate. Pure and total so the conversation behavior is
 * unit-testable without the component tree.
 */

/** Wake-word openers users say before the real command. */
const WAKE_WORD_PATTERN = /^(hey|hi|hello|ok|okay)[,\s]+(wrenchmind[,\s]+)?/i
const BARE_WAKE_PATTERN = /^wrenchmind[,\s]+/i

/**
 * Repair a raw transcript before dispatch: trim, collapse whitespace, drop
 * a leading wake word ("hey wrenchmind, show me ..."), and strip trailing
 * sentence punctuation the command matchers do not expect.
 */
export function repairVoicePhrase(phrase: string): string {
  let out = phrase.trim().replace(/\s+/g, ' ')
  out = out.replace(WAKE_WORD_PATTERN, '').replace(BARE_WAKE_PATTERN, '')
  out = out.trim().replace(/[.?!]+$/, '')
  return out.trim()
}

/** Normalize for echo comparison: lowercase alphanumerics and spaces only. */
function echoKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Conservative self-echo check: drop a phrase that merely repeats what the
 * app just spoke (its own speaker feeding the mic). Only near-duplicates
 * drop — short control words ("done", "back", "repeat") always pass, since
 * they legitimately follow spoken instructions that mention them.
 */
export function isSelfEcho(
  phrase: string,
  spokenText: string | null,
  spokenEndedAtMs: number,
  nowMs: number,
  windowMs = 2500,
): boolean {
  if (!spokenText || nowMs - spokenEndedAtMs > windowMs) return false
  const heard = echoKey(phrase)
  const said = echoKey(spokenText)
  if (!heard || !said) return false
  if (heard === said) return true
  const shorter = Math.min(heard.length, said.length)
  if (shorter < 15) return false
  return heard.includes(said) || said.includes(heard)
}

/** Idle-reprompt gate: nudge only after sustained silence. */
export function idleNudgeDue(lastActivityAtMs: number, nowMs: number, idleMs = 120000): boolean {
  return nowMs - lastActivityAtMs >= idleMs
}
