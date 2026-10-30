import { describe, expect, it } from 'vitest'
import { idleNudgeDue, isSelfEcho, repairVoicePhrase } from './voicePhrasing'

describe('repairVoicePhrase', () => {
  it('trims and collapses whitespace', () => {
    expect(repairVoicePhrase('  show   me  the bolt  ')).toBe('show me the bolt')
  })

  it('strips wake-word openers', () => {
    expect(repairVoicePhrase('hey wrenchmind, show me the bolt')).toBe('show me the bolt')
    expect(repairVoicePhrase('Hi, wrenchmind show screws')).toBe('show screws')
    expect(repairVoicePhrase('wrenchmind done')).toBe('done')
    expect(repairVoicePhrase('ok next')).toBe('next')
  })

  it('strips trailing sentence punctuation', () => {
    expect(repairVoicePhrase('done!')).toBe('done')
    expect(repairVoicePhrase('what is this?')).toBe('what is this')
  })

  it('leaves plain commands untouched', () => {
    expect(repairVoicePhrase('back')).toBe('back')
    expect(repairVoicePhrase('repeat')).toBe('repeat')
  })
})

describe('isSelfEcho', () => {
  const NOW = 10_000
  const SPOKEN = 'The alternator belt is loose and cracked.'

  it('drops a near-duplicate heard right after speaking', () => {
    expect(isSelfEcho(SPOKEN, SPOKEN, NOW - 500, NOW)).toBe(true)
    expect(
      isSelfEcho('the alternator belt is loose and cracked!', SPOKEN, NOW - 500, NOW),
    ).toBe(true)
  })

  it('keeps short control words even when the reply mentioned them', () => {
    const said = 'Say repeat to hear the step again, or done to continue.'
    expect(isSelfEcho('repeat', said, NOW - 500, NOW)).toBe(false)
    expect(isSelfEcho('done', said, NOW - 500, NOW)).toBe(false)
    expect(isSelfEcho('back', said, NOW - 500, NOW)).toBe(false)
  })

  it('keeps unrelated phrases and stale echoes', () => {
    expect(isSelfEcho('show me the fuse', SPOKEN, NOW - 500, NOW)).toBe(false)
    expect(isSelfEcho(SPOKEN, SPOKEN, NOW - 10_000, NOW)).toBe(false)
    expect(isSelfEcho(SPOKEN, null, NOW - 500, NOW)).toBe(false)
    expect(isSelfEcho('', SPOKEN, NOW - 500, NOW)).toBe(false)
  })
})

describe('idleNudgeDue', () => {
  it('fires only after sustained silence', () => {
    expect(idleNudgeDue(0, 119_999)).toBe(false)
    expect(idleNudgeDue(0, 120_000)).toBe(true)
    expect(idleNudgeDue(50_000, 100_000)).toBe(false)
  })
})
