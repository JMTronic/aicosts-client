import { expect, test } from 'claude-code/testing'

import { basisUrl, fehlerText, parseDevicePoll, parseDeviceStart, STANDARD_BASIS_URL, statsUrl } from './geraet'
import { branchAusHead, elternPfade, gitdirAusDatei, normalisiereRemote } from './git'
import { formatTokens, monatKurz, parseStats } from './stats'

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
