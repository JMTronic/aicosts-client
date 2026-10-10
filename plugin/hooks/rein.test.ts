import { expect, test } from 'claude-code/testing'

import { basisUrl, fehlerText, parseDevicePoll, parseDeviceStart, STANDARD_BASIS_URL, statsUrl } from './geraet'
import { branchAusHead, elternPfade, gitdirAusDatei, normalisiereRemote } from './git'
import type { BandStats } from '../types'
import { bandKosten, echtFaktor, formatEuro, formatUsd, leseModus, modusText, monatKurz, formatTokens, parseKostenArgs, parseStats } from './stats'

test('Remote-Normalisierung wie im CLI und auf dem Server', () => {
  expect(normalisiereRemote('git@github.com:JMTronic/aicosts.git')).toBe('github.com/jmtronic/aicosts')
  expect(normalisiereRemote('https://user:geheim@github.com:443/JMTronic/aicosts.git/')).toBe('github.com/jmtronic/aicosts')
  expect(normalisiereRemote('ssh://git@host.example:2222/a/b.git')).toBe('host.example/a/b')
  expect(normalisiereRemote('/srv/repos/projekt/')).toBe('/srv/repos/projekt')
  expect(normalisiereRemote('')).toBe(null)
  expect(normalisiereRemote(null)).toBe(null)
})

test('Branch aus .git/HEAD und Worktree-Verweis', () => {
  expect(branchAusHead('ref: refs/heads/feature/neu\n')).toBe('feature/neu')
  expect(branchAusHead('3f2a9c0d1e')).toBe(null)
  expect(gitdirAusDatei('gitdir: /repo/.git/worktrees/x\n', '/wt')).toBe('/repo/.git/worktrees/x')
  expect(gitdirAusDatei('gitdir: ../repo/.git/worktrees/x', '/wt')).toBe('/wt/../repo/.git/worktrees/x')
  expect(elternPfade('/a/b/c')).toEqual(['/a/b/c', '/a/b', '/a', '/'])
})

test('Device-Start: gültige Antwort und Abwehr fremder Formate', () => {
  const ok = JSON.stringify({
    device_code: 'x'.repeat(43),
    user_code: 'ABCD-2345',
    verification_url: 'https://aicosts.netlify.app/verbinden?code=ABCD-2345',
    interval: 5,
    expires_in: 600,
  })
  expect(parseDeviceStart(ok)?.user_code).toBe('ABCD-2345')
  expect(parseDeviceStart(ok)?.interval).toBe(5)
  expect(parseDeviceStart(JSON.stringify({ ...JSON.parse(ok), user_code: 'abc' }))).toBe(null)
  expect(parseDeviceStart('kein json')).toBe(null)
})

test('Device-Poll: alle Zustände', () => {
  expect(parseDevicePoll(200, '{"status":"pending"}')).toEqual({ status: 'pending' })
  expect(parseDevicePoll(200, '{"status":"consumed"}')).toEqual({ status: 'verbraucht' })
  expect(parseDevicePoll(404, '{"status":"unknown","fehler":"device_code_unbekannt"}')).toEqual({ status: 'verbraucht' })
  expect(parseDevicePoll(429, '{"status":"slow_down"}')).toEqual({ status: 'slow_down' })
  expect(parseDevicePoll(200, '{"status":"expired"}')).toEqual({ status: 'expired' })
  expect(parseDevicePoll(200, '{"status":"denied"}')).toEqual({ status: 'denied' })
  expect(
    parseDevicePoll(200, JSON.stringify({ status: 'approved', token: 'aic_abcdefgh1234', workspace_name: 'Team', ingest_url: 'https://x.example/functions/v1/ingest/' })),
  ).toEqual({ status: 'approved', token: 'aic_abcdefgh1234', workspace: 'Team', ingestUrl: 'https://x.example/functions/v1/ingest' })
  expect(parseDevicePoll(200, JSON.stringify({ status: 'approved' })).status).toBe('fehler')
  expect(parseDevicePoll(500, 'x').status).toBe('fehler')
})

test('Adressen und Fehlertexte', () => {
  expect(basisUrl(undefined)).toBe(STANDARD_BASIS_URL)
  expect(basisUrl('http://evil.example')).toBe(STANDARD_BASIS_URL)
  expect(basisUrl('http://localhost:54321/functions/v1/')).toBe('http://localhost:54321/functions/v1')
  expect(statsUrl('https://a.example/ingest/')).toBe('https://a.example/ingest/stats')
  expect(fehlerText(401, '')).toContain('/aicosts login')
  expect(fehlerText(400, '{"fehler":"kaputt"}')).toBe('HTTP 400: kaputt')
})

test('Stats-Antwort und Formatierung', () => {
  const text = JSON.stringify({
    version: 1,
    monat: '2026-10',
    gesamt: { tokens: 1_200_000_000, output_tokens: 5_000_000, kosten_usd: 412.5, sessions: 30 },
    session: null,
  })
  expect(parseStats(text)?.gesamt.kostenUsd).toBe(412.5)
  expect(parseStats(text)?.session).toBe(null)
  expect(parseStats('{"version":2}')).toBe(null)
  expect(monatKurz('2026-03')).toBe('Mär')
  expect(formatTokens(1500)).toBe('1.5k')
  expect(formatTokens(2_500_000)).toBe('2.50M')
})

const MIT_FAKTOR = JSON.stringify({
  version: 1,
  monat: '2026-10',
  gesamt: { tokens: 668_590_000, output_tokens: 5_000_000, kosten_usd: 268.65, sessions: 30, echt_eur: 90 },
  session: { id: 's1', tokens: 1000, output_tokens: 10, kosten_usd: 7.48, echt_eur: 1.65 },
  faktor: { monat: '2026-10', eur_pro_usd_projekt: 0.22041393, eur_pro_usd_gesamt: 0.27551741, abo_hinterlegt: true },
})

test('Stats-Antwort mit echten Kosten (neue Felder)', () => {
  const s = parseStats(MIT_FAKTOR)
  expect(s?.gesamt.echtEur).toBe(90)
  expect(s?.session?.echtEur).toBe(1.65)
  expect(s?.faktor).toEqual({ monat: '2026-10', eurProUsdProjekt: 0.22041393, eurProUsdGesamt: 0.27551741, aboHinterlegt: true })
})

test('Stats-Antwort ohne neue Felder (älterer Server) bleibt gültig', () => {
  const s = parseStats(JSON.stringify({ version: 1, monat: '2026-10', gesamt: { tokens: 1, output_tokens: 1, kosten_usd: 2 }, session: null }))
  expect(s?.gesamt.echtEur).toBe(null)
  expect(s?.faktor).toBe(null)
  // unvollständiger oder kaputter Faktor → null, Rest bleibt
  const kaputt = JSON.parse(MIT_FAKTOR)
  kaputt.faktor = { monat: '2026-10', eur_pro_usd_projekt: 'x', eur_pro_usd_gesamt: 1, abo_hinterlegt: true }
  kaputt.gesamt.echt_eur = null
  const k = parseStats(JSON.stringify(kaputt))
  expect(k?.faktor).toBe(null)
  expect(k?.gesamt.echtEur).toBe(null)
  expect(k?.gesamt.kostenUsd).toBe(268.65)
})

test('Euro-Format deutsch mit Tausenderpunkt', () => {
  expect(formatEuro(3.124)).toBe('3,12 €')
  expect(formatEuro(90)).toBe('90,00 €')
  expect(formatEuro(1234.5)).toBe('1.234,50 €')
  expect(formatEuro(1_234_567.891)).toBe('1.234.567,89 €')
  expect(formatEuro(0)).toBe('0,00 €')
  expect(formatEuro(0.004)).toBe('0,00 €')
  expect(formatEuro(Number.NaN)).toBe('0,00 €')
  expect(formatUsd(7.484)).toBe('$7.48')
})

test('Moduswahl und Rückfälle', () => {
  const s = parseStats(MIT_FAKTOR) as BandStats
  // echt: Session anteilig mit Projektfaktor, Monat vom Server
  expect(bandKosten('echt', true, s, 7.48)).toEqual({ session: '≈1,65 €', monat: '90,00 €', zusatz: null, grund: 'echt' })
  // api: wie bisher, ohne Zusatz
  expect(bandKosten('api', true, s, 7.48)).toEqual({ session: '$7.48', monat: '$268.65', zusatz: null, grund: 'api_gewaehlt' })
  // nicht verbunden
  expect(bandKosten('echt', false, null, 7.48)).toEqual({ session: '$7.48', monat: null, zusatz: 'API', grund: 'nicht_verbunden' })
  // kein Faktor (älterer Server)
  const alt = { ...s, faktor: null }
  expect(bandKosten('echt', true, alt, 7.48)).toMatchObject({ session: '$7.48', monat: '$268.65', zusatz: 'API', grund: 'kein_faktor' })
  // noch kein Serverstand
  expect(bandKosten('echt', true, null, 1).grund).toBe('kein_faktor')
  // kein Abo hinterlegt
  const ohneAbo = { ...s, faktor: { ...s.faktor!, aboHinterlegt: false } }
  expect(bandKosten('echt', true, ohneAbo, 7.48)).toMatchObject({ session: '$7.48', zusatz: 'API', grund: 'kein_abo' })
  expect(echtFaktor('echt', true, s).faktor?.eurProUsdProjekt).toBe(0.22041393)
})

test('Kostenmodus: Argumente, gespeicherter Wert, Statuszeilen', () => {
  expect(parseKostenArgs('echt')).toBe('echt')
  expect(parseKostenArgs(' API ')).toBe('api')
  expect(parseKostenArgs('usd')).toBe('api')
  expect(parseKostenArgs(undefined)).toBe('zeigen')
  expect(parseKostenArgs('')).toBe('zeigen')
  expect(parseKostenArgs('bitcoin')).toBe(null)
  expect(leseModus('api')).toBe('api')
  expect(leseModus(undefined)).toBe('echt')
  expect(leseModus(42)).toBe('echt')
  const s = parseStats(MIT_FAKTOR)
  const zeilen = modusText('echt', true, s)
  expect(zeilen[0]).toContain('echt (EUR)')
  expect(zeilen[1]).toContain('Session 0,2204 €/$')
  expect(zeilen[1]).toContain('Monat 0,2755 €/$')
  expect(modusText('echt', false, null)).toEqual(['Kosten im Band: echt (EUR) – Anzeige: USD (API-Gegenwert) – nicht verbunden', 'Faktor: –'])
})
