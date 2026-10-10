import { expect, test } from 'claude-code/testing'

import type { CacheState } from '../types'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, formatRemaining, migrateSettings, parseCacheArgs, remainingMs, shouldPing } from './cache'

const MIN = 60_000
const idle = (lastActivityAt: number | null, pings = 0): CacheState => ({
  lastActivityAt,
  isRunning: false,
  pings,
  lastPing: null,
})

test('Restzeit läuft ab der letzten Aktivität', () => {
  expect(remainingMs(idle(0), DEFAULT_SETTINGS, 20 * MIN)).toBe(40 * MIN)
  expect(remainingMs(idle(null), DEFAULT_SETTINGS, 0)).toBe(null)
})

test('Ping erst kurz vor Ablauf, nur im Leerlauf und bis zum Limit', () => {
  expect(shouldPing(idle(0), DEFAULT_SETTINGS, 50 * MIN)).toBe(false)
  expect(shouldPing(idle(0), DEFAULT_SETTINGS, 58 * MIN)).toBe(true)
  expect(shouldPing({ ...idle(0), isRunning: true }, DEFAULT_SETTINGS, 58 * MIN)).toBe(false)
  expect(shouldPing(idle(0, 12), DEFAULT_SETTINGS, 58 * MIN)).toBe(false)
  expect(shouldPing(idle(0), DEFAULT_SETTINGS, 61 * MIN)).toBe(false)
  expect(shouldPing(idle(0), { ...DEFAULT_SETTINGS, keepAlive: false }, 58 * MIN)).toBe(false)
})

test('5-Minuten-TTL pingt eine Minute vorher', () => {
  const s = { ...DEFAULT_SETTINGS, ttlMinutes: 5 }
  expect(shouldPing(idle(0), s, 3 * MIN)).toBe(false)
  expect(shouldPing(idle(0), s, 4.5 * MIN)).toBe(true)
})

test('Formatierung der Restzeit', () => {
  expect(formatRemaining(42 * MIN + 5000)).toBe('42 Min')
  expect(formatRemaining(2 * MIN + 7000)).toBe('2:07')
})

test('Befehlsargumente von /cache', () => {
  expect(parseCacheArgs('', DEFAULT_SETTINGS)?.action).toBe('status')
  expect(parseCacheArgs('aus', DEFAULT_SETTINGS)?.settings.keepAlive).toBe(false)
  expect(parseCacheArgs('ttl 5', DEFAULT_SETTINGS)?.settings.ttlMinutes).toBe(5)
  expect(parseCacheArgs('max 8', DEFAULT_SETTINGS)?.settings.maxPings).toBe(8)
  expect(parseCacheArgs('ttl 7', DEFAULT_SETTINGS)).toBe(null)
})

test('Standard sind 12 Pings, alter Standard 3 wird einmalig angehoben', () => {
  expect(DEFAULT_SETTINGS.maxPings).toBe(12)
  expect(migrateSettings(undefined, undefined).maxPings).toBe(12)
  expect(migrateSettings({ maxPings: 3 }, undefined).maxPings).toBe(12)
  expect(migrateSettings({ maxPings: 8 }, undefined).maxPings).toBe(8)
  expect(migrateSettings({ maxPings: 3 }, SETTINGS_VERSION).maxPings).toBe(3)
  expect(migrateSettings({ keepAlive: false }, undefined).keepAlive).toBe(false)
})
