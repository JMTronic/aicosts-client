import { expect, test } from 'claude-code/testing'

import { neuesJournal, verbucheAntwort, verbucheEingabe, verbucheKosten, type Journal } from './journal'
import { baueSession, INGEST_LIMITS, istLeer, pruefePayload, pruefeSession, PAYLOAD_SCHEMA_VERSION } from './payload'

const T0 = Date.UTC(2026, 9, 10, 22, 30, 0)
const MIN = 60_000

const beispiel = (): Journal => {
  const j = neuesJournal('3f2a-session.1', T0, true)
  j.cwd = '/projekt'
  j.git_repo = 'github.com/beispiel/repo'
  j.git_root = '/projekt'
  j.git_branch = 'main'
  j.turns = 2
  verbucheAntwort(j, {
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000 },
    durationMs: 60_000,
    ende: T0 + 5 * MIN,
    cacheTtlMinuten: 60,
  })
  verbucheAntwort(j, {
    agentId: 'agent-1',
    usage: { model: 'claude-haiku-5-5', input_tokens: 3, output_tokens: 1911, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 9000 },
    durationMs: 20_000,
    ende: T0 + 40 * MIN,
    cacheTtlMinuten: 60,
  })
  verbucheEingabe(j, T0 + 50 * MIN)
  verbucheKosten(j, 0.734567891)
  j.kontextFenster = 1_000_000
  j.kontextMax = 42_010
  return j
}

test('Payload aus dem Journal ist gültig und enthält die Plugin-Felder', () => {
  const s = baueSession(beispiel(), 'aicosts-plugin/0.1.0')
  expect(pruefeSession(s)).toEqual([])
  expect(pruefePayload({ schema_version: PAYLOAD_SCHEMA_VERSION, sessions: [s] })).toEqual([])
  expect(s.quelle).toBe('plugin')
  expect(s.plugin_vollstaendig).toBe(true)
  expect(s.modell).toBe('claude-opus-5-5')
  expect(s.kosten_engine_usd).toBe(0.734568)
  expect(s.kontext_fenster_tokens).toBe(1_000_000)
  expect(s.agents).toEqual([{ agent_id: 'agent-1', modell: 'claude-haiku-5-5', turns: 1 }])
  expect(s.nutzung.map(n => `${n.strang}|${n.preisstufe}`)).toEqual(['agent-1|lang', 'main|standard'])
  expect(s.engine_output_tokens).toBe(2411)
  // Stunden über Mitternacht UTC: 22:00 und 23:00 (Antwortende 22:35 und 23:10)
  expect(s.stunden.map(h => h.stunde)).toEqual(['2026-10-10T22:00:00.000Z', '2026-10-10T23:00:00.000Z'])
  expect(s.eingriffe.map(e => [e.art, e.anteil])).toEqual([
    ['agent', 1],
    ['eingabe', 1],
  ])
  expect(s.eingriffe[1]?.start).toBe(new Date(T0 + 5 * MIN).toISOString())
  expect(s.gestartet_am).toBe(new Date(T0).toISOString())
  expect(s.beendet_am).toBe(new Date(T0 + 40 * MIN).toISOString())
})

test('Datenschutz: Payload enthält keine Texte außer Kennzahlen und Metadaten', () => {
  const s = baueSession(beispiel(), 'aicosts-plugin/0.1.0')
  const erlaubt = new Set([
    'session_id', 'modell', 'effort', 'cwd', 'git_repo', 'git_root', 'git_branch', 'kontext_max_tokens', 'turns',
    'parser_version', 'gestartet_am', 'beendet_am', 'kosten_engine_usd', 'kontext_fenster_tokens', 'engine_input_tokens',
    'engine_output_tokens', 'engine_cache_read_tokens', 'engine_cache_write_tokens', 'stunden', 'nutzung', 'agents',
    'eingriffe', 'quelle', 'plugin_vollstaendig',
  ])
  expect(Object.keys(s).filter(k => !erlaubt.has(k))).toEqual([])
})

test('Teil-Erfassung wird markiert, leere Sessions erkannt', () => {
  const j = neuesJournal('x', T0, false)
  expect(istLeer(j)).toBe(true)
  verbucheKosten(j, 0.1)
  expect(istLeer(j)).toBe(false)
  expect(baueSession(j, 'p').plugin_vollstaendig).toBe(false)
})

test('Prüfung meldet Verstöße gegen die Server-Grenzen', () => {
  const s = baueSession(beispiel(), 'p')
  expect(pruefeSession({ ...s, session_id: 'ungültig mit Leerzeichen' }).length).toBeGreaterThan(0)
  expect(pruefeSession({ ...s, agents: [] }).some(f => f.startsWith('strang unbekannt'))).toBe(true)
  expect(pruefeSession({ ...s, nutzung: [...s.nutzung, ...s.nutzung] }).some(f => f.startsWith('nutzung doppelt'))).toBe(true)
  const eingriff = { art: 'eingabe' as const, start: s.gestartet_am, ende: s.gestartet_am, anteil: 1 }
  expect(pruefeSession({ ...s, eingriffe: Array.from({ length: INGEST_LIMITS.maxEingriffeProSession + 1 }, () => eingriff) })).toContain('zu viele eingriffe')
  expect(pruefeSession({ ...s, eingriffe: [{ ...eingriff, anteil: 0 }] })).toContain('eingriff-Anteil ungültig')
  expect(pruefeSession({ ...s, kontext_fenster_tokens: 0 })).toContain('kontext_fenster_tokens ungültig')
  expect(pruefeSession({ ...s, stunden: [{ ...s.stunden[0]!, stunde: '2026-10-10T22:30:00.000Z' }] })).toContain('stunde ungültig')
  expect(pruefePayload({ schema_version: PAYLOAD_SCHEMA_VERSION, sessions: [s, s] }).some(f => f.startsWith('session_id doppelt'))).toBe(true)
})

test('Mehr als 2000 Stunden werden zu UTC-Tagen zusammengefasst', () => {
  const j = neuesJournal('lang', T0, true)
  for (let i = 0; i < 2100; i += 1) j.stunden[String(T0 - (T0 % 3_600_000) + i * 3_600_000)] = [1, 1, 0, 0, 0.000001]
  const s = baueSession(j, 'p')
  expect(s.stunden.length).toBeLessThan(100)
  expect(s.stunden.reduce((a, h) => a + h.input_tokens, 0)).toBe(2100)
  expect(pruefeSession(s)).toEqual([])
})
