import { expect, test } from 'claude-code/testing'

import {
  engineKosten,
  leseJournal,
  markiereHochgeladen,
  MAX_AGENTS,
  neuesJournal,
  STRANG_WEITERE,
  summe,
  verbucheAntwort,
  verbucheEingabe,
  verbucheKontext,
  verbucheKosten,
  verbucheTurnStart,
  type AntwortUsage,
} from './journal'

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0)
const MIN = 60_000

const usage = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): AntwortUsage => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

test('Hauptstrang und Subagent landen in getrennten Strängen', () => {
  const j = neuesJournal('s1', T0, true)
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 10, 200, 5000, 300), durationMs: 30_000, ende: T0 + MIN, cacheTtlMinuten: 60 })
  verbucheAntwort(j, { agentId: 'a1b2', usage: usage('claude-haiku-5-5', 5, 1911, 20_000, 700), durationMs: 10_000, ende: T0 + 2 * MIN, cacheTtlMinuten: 60 })
  verbucheAntwort(j, { agentId: 'a1b2', usage: usage('claude-haiku-5-5', 1, 50, 1000, 0), durationMs: 2_000, ende: T0 + 3 * MIN, cacheTtlMinuten: 60 })

  const main = j.nutzung['main|claude-opus-5-5|standard']
  expect(main?.anfragen).toBe(1)
  // Hauptstrang mit 1-h-TTL: Cache-Schreiben zählt als 1 h
  expect(main?.cache_write_1h_tokens).toBe(300)
  expect(main?.cache_write_5m_tokens).toBe(0)
  const sub = j.nutzung['a1b2|claude-haiku-5-5|standard']
  expect(sub?.anfragen).toBe(2)
  expect(sub?.output_tokens).toBe(1961)
  // Subagenten: Cache-Schreiben als 5 Minuten
  expect(sub?.cache_write_5m_tokens).toBe(700)
  expect(j.agents.a1b2?.turns).toBe(2)
  expect(j.modelle).toEqual({ 'claude-opus-5-5': 1 })
  expect(j.engine).toEqual({ input: 16, output: 2161, cache_read: 26_000, cache_write: 1000 })
  expect(summe(j)).toEqual({ tokens: 16 + 2161 + 26_000 + 1000, outputTokens: 2161 })
  expect(j.dirty).toBe(true)
})

test('Agent-IDs werden bereinigt, „main“ ist reserviert, zu viele werden zusammengefasst', () => {
  const j = neuesJournal('s1', T0, true)
  verbucheAntwort(j, { agentId: 'main', usage: usage('claude-haiku-5-5', 1, 1), durationMs: 1, ende: T0, cacheTtlMinuten: 60 })
  verbucheAntwort(j, { agentId: 'a/b c', usage: usage('claude-haiku-5-5', 1, 1), durationMs: 1, ende: T0, cacheTtlMinuten: 60 })
  expect(Object.keys(j.agents).sort()).toEqual(['a_b_c', 'agent-main'])
  for (let i = 0; i < MAX_AGENTS + 5; i += 1) {
    verbucheAntwort(j, { agentId: `x${i}`, usage: usage('claude-haiku-5-5', 1, 1), durationMs: 1, ende: T0, cacheTtlMinuten: 60 })
  }
  expect(Object.keys(j.agents).length).toBe(MAX_AGENTS + 1)
  expect(j.agents[STRANG_WEITERE]?.turns).toBeGreaterThan(0)
})

test('Haiku 5.5: Preisstufe „lang“ erst über 100.000 Prompt-Token', () => {
  const j = neuesJournal('s1', T0, true)
  // genau 100.000 → standard
  verbucheAntwort(j, { agentId: 'h', usage: usage('claude-haiku-5-5', 1000, 10, 98_000, 1000), durationMs: 1, ende: T0, cacheTtlMinuten: 60 })
  // 100.001 → lang
  verbucheAntwort(j, { agentId: 'h', usage: usage('claude-haiku-5-5-20261001', 1001, 10, 98_000, 1000), durationMs: 1, ende: T0, cacheTtlMinuten: 60 })
  // andere Modelle haben keine Langstufe
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 1, 10, 500_000, 0), durationMs: 1, ende: T0, cacheTtlMinuten: 60 })
  expect(j.nutzung['h|claude-haiku-5-5|standard']?.anfragen).toBe(1)
  expect(j.nutzung['h|claude-haiku-5-5-20261001|lang']?.anfragen).toBe(1)
  expect(j.nutzung['main|claude-opus-5-5|standard']?.anfragen).toBe(1)
})

test('Stunden-Buckets in UTC nach Antwortende, auch über Mitternacht', () => {
  const j = neuesJournal('s1', T0, true)
  const kurzVor = Date.UTC(2026, 9, 10, 23, 59, 30)
  const kurzNach = Date.UTC(2026, 9, 11, 0, 0, 10)
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 100, 10), durationMs: 60_000, ende: kurzVor, cacheTtlMinuten: 60 })
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 200, 20), durationMs: 60_000, ende: kurzNach, cacheTtlMinuten: 60 })
  verbucheAntwort(j, { agentId: 'a', usage: usage('claude-haiku-5-5', 300, 30), durationMs: 1000, ende: kurzNach + 1000, cacheTtlMinuten: 60 })
  const stunden = Object.keys(j.stunden).map(Number).sort()
  expect(stunden).toEqual([Date.UTC(2026, 9, 10, 23), Date.UTC(2026, 9, 11, 0)])
  const nach = j.stunden[String(Date.UTC(2026, 9, 11, 0))]
  expect(nach?.[0]).toBe(500)
  expect(nach?.[1]).toBe(50)
  expect((nach?.[4] ?? 0) > 0).toBe(true)
  // Antwort ohne Token erzeugt keine Stunde
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 0, 0), durationMs: 1, ende: T0 + 5 * 3_600_000, cacheTtlMinuten: 60 })
  expect(Object.keys(j.stunden).length).toBe(2)
})

test('Eingriffe: Agent = Antwortdauer, Eingabe = Antwortende bis nächste echte Eingabe', () => {
  const j = neuesJournal('s1', T0, true)
  verbucheTurnStart(j)
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 1, 1), durationMs: 90_000, ende: T0 + 2 * MIN, cacheTtlMinuten: 60 })
  // Subagent-Antworten verändern die Wartezeit nicht
  verbucheAntwort(j, { agentId: 'a', usage: usage('claude-haiku-5-5', 1, 1), durationMs: 5000, ende: T0 + 3 * MIN, cacheTtlMinuten: 60 })
  verbucheEingabe(j, T0 + 7 * MIN)
  verbucheTurnStart(j)
  // Benachrichtigung startet einen Turn ohne echte Eingabe → keine Eingabe-Spanne
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 1, 1), durationMs: 10_000, ende: T0 + 8 * MIN, cacheTtlMinuten: 60 })
  verbucheTurnStart(j)
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 1, 1), durationMs: 10_000, ende: T0 + 9 * MIN, cacheTtlMinuten: 60 })
  verbucheEingabe(j, T0 + 12 * MIN)
  // zweite Eingabe ohne Antwort dazwischen → nichts
  verbucheEingabe(j, T0 + 13 * MIN)
  expect(j.eingriffe).toEqual([
    ['a', T0 + 30_000, T0 + 2 * MIN],
    ['e', T0 + 2 * MIN, T0 + 7 * MIN],
    ['a', T0 + 8 * MIN - 10_000, T0 + 8 * MIN],
    ['a', T0 + 9 * MIN - 10_000, T0 + 9 * MIN],
    ['e', T0 + 9 * MIN, T0 + 12 * MIN],
  ])
})

test('Keep-Alive-Ping zählt nur Token, beendet keine Wartezeit', () => {
  const j = neuesJournal('s1', T0, true)
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 1, 1), durationMs: 1000, ende: T0, cacheTtlMinuten: 60 })
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 3, 2, 90_000, 0), durationMs: 0, ende: T0 + 57 * MIN, cacheTtlMinuten: 60, nurNutzung: true })
  verbucheEingabe(j, T0 + 70 * MIN)
  expect(j.eingriffe).toEqual([
    ['a', T0 - 1000, T0],
    ['e', T0, T0 + 70 * MIN],
  ])
  expect(j.modelle['claude-opus-5-5']).toBe(1)
  expect(j.nutzung['main|claude-opus-5-5|standard']?.anfragen).toBe(2)
})

test('Resume: Journal wird gelesen und fortgesetzt, Kosten über Prozessgrenzen', () => {
  const j = neuesJournal('s1', T0, true)
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 10, 20), durationMs: 1000, ende: T0, cacheTtlMinuten: 60 })
  verbucheKosten(j, 1.25)
  verbucheKontext(j, 50_000, 1_000_000)
  const text = JSON.stringify(j)

  const r = leseJournal(text, 's1')
  expect(r).not.toBe(null)
  if (r === null) return
  // neuer Prozess: Engine-Zähler beginnt bei 0 → alter Stand wird Abschnitt
  verbucheKosten(r, 0)
  verbucheKosten(r, 0.5)
  verbucheAntwort(r, { usage: usage('claude-opus-5-5', 5, 5), durationMs: 1000, ende: T0 + MIN, cacheTtlMinuten: 60 })
  verbucheKontext(r, 40_000, 1_000_000)
  expect(engineKosten(r)).toBe(1.75)
  expect(r.nutzung['main|claude-opus-5-5|standard']?.anfragen).toBe(2)
  expect(r.kontextMax).toBe(50_000)
  expect(r.vollstaendig).toBe(true)
  // Engine stellt den Stand selbst wieder her (Wert steigt weiter) → kein Doppelzählen
  const q = leseJournal(text, 's1')
  if (q === null) return
  verbucheKosten(q, 1.25)
  verbucheKosten(q, 1.4)
  expect(engineKosten(q)).toBe(1.4)
})

test('Kaputtes oder fremdes Journal wird verworfen', () => {
  expect(leseJournal('{kaputt', 's1')).toBe(null)
  expect(leseJournal(JSON.stringify(neuesJournal('s2', T0, true)), 's1')).toBe(null)
  expect(leseJournal(JSON.stringify({ ...neuesJournal('s1', T0, true), v: 99 }), 's1')).toBe(null)
  expect(leseJournal(JSON.stringify({ ...neuesJournal('s1', T0, true), nutzung: null }), 's1')).toBe(null)
})

test('Upload räumt dirty nur ohne zwischenzeitliche Änderung', () => {
  const j = neuesJournal('s1', T0, true)
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 1, 1), durationMs: 1, ende: T0, cacheTtlMinuten: 60 })
  const rev = j.rev
  verbucheAntwort(j, { usage: usage('claude-opus-5-5', 1, 1), durationMs: 1, ende: T0, cacheTtlMinuten: 60 })
  markiereHochgeladen(j, rev, T0 + 1)
  expect(j.dirty).toBe(true)
  markiereHochgeladen(j, j.rev, T0 + 2)
  expect(j.dirty).toBe(false)
  expect(j.letzterUpload).toBe(T0 + 2)
})
