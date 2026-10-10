import type { CacheSettings, CacheState } from '../types'

// 12 Pings ≈ 12 Std. Leerlauf: deckt einen halben Arbeitstag ab (Rechner an, Session wartet)
export const DEFAULT_SETTINGS: CacheSettings = { ttlMinutes: 60, keepAlive: true, maxPings: 12 }

// Früherer Standardwert; wer ihn noch gespeichert hat, wird einmalig auf den neuen Standard gehoben
const LEGACY_DEFAULT_MAX_PINGS = 3
export const SETTINGS_VERSION = 2

// Führt gespeicherte Einstellungen mit den Standards zusammen und hebt alte Standardwerte an
export const migrateSettings = (
  stored: Partial<CacheSettings> | undefined,
  storedVersion: number | undefined,
): CacheSettings => {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
  const isLegacy = (storedVersion ?? 1) < SETTINGS_VERSION
  if (isLegacy && merged.maxPings === LEGACY_DEFAULT_MAX_PINGS) {
    return { ...merged, maxPings: DEFAULT_SETTINGS.maxPings }
  }
  return merged
}

const MINUTE = 60_000

// Vorlauf vor Ablauf, in dem gepingt wird: bei 1 h TTL 3 Min, bei 5 Min TTL 1 Min
export const pingMarginMs = (ttlMinutes: number): number => (ttlMinutes >= 30 ? 3 : 1) * MINUTE

// Verbleibende Cache-Zeit in ms; null = noch keine Aktivität
export const remainingMs = (cache: CacheState, settings: CacheSettings, now: number): number | null => {
  if (cache.lastActivityAt === null) return null
  return cache.lastActivityAt + settings.ttlMinutes * MINUTE - now
}

// Ein Ping lohnt nur im Leerlauf, kurz vor Ablauf, solange der Cache noch lebt und das Limit nicht erreicht ist
export const shouldPing = (cache: CacheState, settings: CacheSettings, now: number): boolean => {
  if (!settings.keepAlive || cache.isRunning) return false
  if (cache.pings >= settings.maxPings) return false
  const rest = remainingMs(cache, settings, now)
  if (rest === null || rest <= 0) return false
  return rest <= pingMarginMs(settings.ttlMinutes)
}

export const formatRemaining = (ms: number): string => {
  if (ms >= 10 * MINUTE) return `${Math.floor(ms / MINUTE)} Min`
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export const cacheColor = (ms: number): string => {
  if (ms <= 3 * MINUTE) return 'error'
  if (ms <= 10 * MINUTE) return 'warning'
  return 'success'
}

// Wertet die Argumente von /cache aus; null = unbekannt
export const parseCacheArgs = (
  args: string,
  settings: CacheSettings,
): { settings: CacheSettings; action: 'status' | 'ping' | 'set' } | null => {
  const [word = 'status', value] = args.trim().toLowerCase().split(/\s+/)
  const number = Number(value)

  if (word === '' || word === 'status') return { settings, action: 'status' }
  if (word === 'ping') return { settings, action: 'ping' }
  if (word === 'an' || word === 'on') return { settings: { ...settings, keepAlive: true }, action: 'set' }
  if (word === 'aus' || word === 'off') return { settings: { ...settings, keepAlive: false }, action: 'set' }
  if (word === 'ttl' && (number === 5 || number === 60)) {
    return { settings: { ...settings, ttlMinutes: number }, action: 'set' }
  }
  if (word === 'max' && Number.isInteger(number) && number >= 0 && number <= 24) {
    return { settings: { ...settings, maxPings: number }, action: 'set' }
  }
  return null
}
