import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearLogs,
  formatLogs,
  getLogs,
  log,
  logError,
  logInfo,
  setConsoleEnabled,
  subscribe,
} from './logger'

afterEach(() => {
  clearLogs()
  setConsoleEnabled(false)
  vi.restoreAllMocks()
})

describe('logger', () => {
  it('records entries with sequence, timestamp, level, tag, and message', () => {
    logInfo('camera', 'started')
    logError('api', 'failed')
    const entries = getLogs()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ seq: 0, level: 'info', tag: 'camera', message: 'started' })
    expect(entries[1].seq).toBe(1)
    expect(Date.parse(entries[0].time)).not.toBeNaN()
  })

  it('evicts the oldest entries past the cap', () => {
    for (let i = 0; i < 250; i++) {
      log('debug', 't', `m${i}`)
    }
    const entries = getLogs()
    expect(entries).toHaveLength(200)
    expect(entries[0].message).toBe('m50')
    expect(entries[199].message).toBe('m249')
  })

  it('formats entries as plain-text log lines', () => {
    logInfo('voice', 'listening')
    const text = formatLogs()
    expect(text).toContain('[INFO]')
    expect(text).toContain('[voice]')
    expect(text).toContain('listening')
  })

  it('notifies subscribers and supports unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    logInfo('t', 'one')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    logInfo('t', 'two')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clears entries and notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    try {
      logInfo('t', 'one')
      clearLogs()
      expect(getLogs()).toEqual([])
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })

  it('mirrors to the console per level when enabled', () => {
    setConsoleEnabled(true)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    log('debug', 't', 'd')
    logInfo('t', 'i')
    log('warn', 't', 'w')
    logError('t', 'e')
    expect(debug).toHaveBeenCalledWith('[t] d')
    expect(info).toHaveBeenCalledWith('[t] i')
    expect(warn).toHaveBeenCalledWith('[t] w')
    expect(error).toHaveBeenCalledWith('[t] e')
  })

  it('stays silent on the console when disabled', () => {
    setConsoleEnabled(false)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logInfo('t', 'i')
    expect(info).not.toHaveBeenCalled()
    expect(getLogs()).toHaveLength(1)
  })
})
