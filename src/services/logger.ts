export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  seq: number
  time: string
  level: LogLevel
  tag: string
  message: string
}

type Listener = () => void

const MAX_ENTRIES = 200

let seq = 0
let entries: LogEntry[] = []
const listeners = new Set<Listener>()
let consoleEnabled = true

/** Disable console mirroring (used by the test setup to keep output clean). */
export function setConsoleEnabled(enabled: boolean): void {
  consoleEnabled = enabled
}

function mirror(level: LogLevel, tag: string, message: string): void {
  if (!consoleEnabled) return
  const text = `[${tag}] ${message}`
  if (level === 'debug') console.debug(text)
  else if (level === 'info') console.info(text)
  else if (level === 'warn') console.warn(text)
  else console.error(text)
}

export function log(level: LogLevel, tag: string, message: string): void {
  entries.push({ seq: seq++, time: new Date().toISOString(), level, tag, message })
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  mirror(level, tag, message)
  listeners.forEach((listener) => listener())
}

export function logDebug(tag: string, message: string): void {
  log('debug', tag, message)
}

export function logInfo(tag: string, message: string): void {
  log('info', tag, message)
}

export function logWarn(tag: string, message: string): void {
  log('warn', tag, message)
}

export function logError(tag: string, message: string): void {
  log('error', tag, message)
}

export function getLogs(): LogEntry[] {
  return [...entries]
}

export function clearLogs(): void {
  entries = []
  listeners.forEach((listener) => listener())
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function formatLogs(): string {
  return entries
    .map((e) => `[${e.time}] [${e.level.toUpperCase()}] [${e.tag}] ${e.message}`)
    .join('\n')
}
