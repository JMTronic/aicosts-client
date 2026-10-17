import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { HttpInit, HttpResponse, On } from 'claude-code'

import { neuesJournal, verbucheAntwort } from './journal'

// Tests über die Engine: Hooks des Plugins mit nachgebildeter Umgebung (Dateien, Netz, Session).

const T0 = Date.UTC(2026, 9, 10, 9, 0, 0)
const HOME = '/home/test'
const JOURNAL = (sid: string): string => `${HOME}/.aicosts/plugin/journal/${sid}.json`

interface Anfrage {
  url: string
  init: HttpInit | undefined
}

interface Welt {
  dateien: Map<string, string>
  anfragen: Anfrage[]
  toasts: string[]
  sitzung: { id: string; turns: number; kosten: number; kontext: number; limits: { kind: string; percentUsed: number; resetsAt?: string }[] }
  uhr: ReturnType<typeof mock.clock>
  speicher: Map<string, unknown>
  /** Änderungszeit je Datei (fs.write setzt eine stetig steigende Zeit) */
  mtimes: Map<string, number>
  /** gelesene Dateien (für die Begrenzung der Lesezugriffe) */
  gelesen: string[]
}

const antwort = (status: number, daten: unknown): HttpResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: {},
  text: JSON.stringify(daten),
})

/** Baut die Umgebung unter dem Plugin auf; `server` beantwortet HTTP-Anfragen */
const welt = (on: On, server: (a: Anfrage) => HttpResponse | Promise<HttpResponse>, store: Record<string, unknown> = {}): Welt => {
  const w: Welt = {
    dateien: new Map(),
    anfragen: [],
    toasts: [],
    sitzung: { id: 'sess-1', turns: 0, kosten: 0, kontext: 20_000, limits: [] },
    uhr: mock.clock(on, { now: T0 }),
    speicher: new Map(),
    mtimes: new Map(),
    gelesen: [],
  }
  let schreibZeit = T0
  const speicher = new Map<string, unknown>(Object.entries(store))
  w.speicher = speicher
  on('store.get', ($, e) => ({ value: speicher.get(e.key) }))
  on('store.set', ($, e) => {
    speicher.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    speicher.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...speicher.keys()] }))
  mock.env(on, { HOME })
  on('fs.read', ($, e) => {
    w.gelesen.push(e.path)
    const text = w.dateien.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.dateien.set(e.path, e.text)
    schreibZeit += 1
    w.mtimes.set(e.path, schreibZeit)
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: [...w.dateien.keys()]
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: w.mtimes.get(p) ?? T0, isLink: false })),
  }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('session.id', () => ({ value: w.sitzung.id }))
  on('session.cwd', () => ({ value: '/projekt' }))
  on('session.turns', () => ({ value: w.sitzung.turns }))
  on('session.repo', () => ({ value: { root: '/projekt', remote: 'git@github.com:Beispiel/Repo.git', internal: false, name: null } }))
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: { tokens: w.sitzung.kontext, window: 1_000_000, percent: 2 },
      rateLimits: w.sitzung.limits,
      cost: { usd: w.sitzung.kosten },
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', async ($, e) => {
    const a = { url: e.url, init: e.init }
    w.anfragen.push(a)
    return { value: await server(a) }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return w
}

const STATS = { version: 1, monat: '2026-10', gesamt: { tokens: 2_000_000, output_tokens: 1000, kosten_usd: 12.5, sessions: 3 }, session: null }

/** Session-IDs eines Upload-Bodys */
const gesendeteIds = (a: Anfrage): string[] =>
  (JSON.parse(a.init?.body ?? '{}') as { sessions?: { session_id: string }[] }).sessions?.map(s => s.session_id) ?? []

/** Server nach neuem Vertrag: alle gespeichert, mit Einzelergebnissen */
const ingestErfolg = (a: Anfrage): HttpResponse => {
  const ids = gesendeteIds(a)
  return antwort(200, {
    upserted: ids.length,
    unassigned: 0,
    uebersprungen: 0,
    abgelehnt: 0,
    ergebnisse: ids.map(session_id => ({ session_id, status: 'gespeichert', grund: null })),
  })
}

const standardServer = (a: Anfrage): HttpResponse => {
  if (a.url.endsWith('/ingest/stats')) return antwort(200, STATS)
  if (a.url.endsWith('/ingest')) return ingestErfolg(a)
  return antwort(404, { fehler: 'unbekannt' })
}

const befehl = ($: Engine, args: string) =>
  $.command.run({ command: 'aicosts', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const fertig = { reason: 'answer' as const, answer: '', isAborted: false }

test('Device-Flow: Code anzeigen, im Hintergrund pollen, Token speichern', async ($, on) => {
  let polls = 0
  const w = welt(on, a => {
    if (a.url.endsWith('/device/start')) {
      return antwort(200, {
        device_code: 'd'.repeat(43),
        user_code: 'WXYZ-2345',
        verification_url: 'https://aicosts.netlify.app/verbinden?code=WXYZ-2345',
        interval: 5,
        expires_in: 600,
      })
    }
    if (a.url.endsWith('/device/poll')) {
      polls += 1
      if (polls === 1) return antwort(200, { status: 'pending' })
      if (polls === 2) return antwort(429, { status: 'slow_down' })
      return antwort(200, { status: 'approved', token: 'aic_testtoken123456', workspace_name: 'Testteam', ingest_url: 'https://cloud.example/functions/v1/ingest' })
    }
    return standardServer(a)
  })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const r = await befehl($, 'login')
  expect(r.text).toContain('WXYZ-2345')
  expect(r.text).toContain('https://aicosts.netlify.app/verbinden?code=WXYZ-2345')
  expect(r.text).not.toContain('d'.repeat(43))
  const start = w.anfragen.find(a => a.url.endsWith('/device/start'))
  expect(JSON.parse(start?.init?.body ?? '{}')).toMatchObject({ client: 'aicosts-plugin', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) })

  await w.uhr.advance(5_000) // pending
  expect(polls).toBe(1)
  await w.uhr.advance(5_000) // slow_down → Abstand +5 s
  expect(polls).toBe(2)
  await w.uhr.advance(5_000)
  expect(polls).toBe(2)
  await w.uhr.advance(5_000) // approved
  expect(polls).toBe(3)
  expect(w.speicher.get('token')).toBe('aic_testtoken123456')
  expect(w.speicher.get('ingestUrl')).toBe('https://cloud.example/functions/v1/ingest')
  expect(w.toasts.some(t => t.includes('Testteam'))).toBe(true)

  const status = await befehl($, 'status')
  expect(status.text).toContain('Verbunden: ja')
  expect(status.text).toContain('Testteam')
  expect(status.text).not.toContain('aic_testtoken123456')

  const ab = await befehl($, 'logout')
  expect(ab.text).toContain('widerrufen')
  expect(w.speicher.get('token')).toBe(undefined)
})

test('Device-Flow: abgelaufener Code meldet sich', async ($, on) => {
  const w = welt(on, a => {
    if (a.url.endsWith('/device/start')) {
      return antwort(200, { device_code: 'e'.repeat(43), user_code: 'ABCD-2345', verification_url: 'https://x.example/v', interval: 5, expires_in: 600 })
    }
    return antwort(200, { status: 'expired' })
  })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await befehl($, 'login')
  await w.uhr.advance(5_000)
  expect(w.toasts.some(t => t.includes('abgelaufen'))).toBe(true)
  expect(w.speicher.get('token')).toBe(undefined)
})

test('Live-Erfassung: Journal je Session, entprellter Upload mit Bearer-Token', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'Hallo geheimer Prompt', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Hallo geheimer Prompt', turnId: 't1' })
  w.sitzung.turns = 1
  w.sitzung.kosten = 0.42
  await w.uhr.advance(30_000)
  await $.turn.complete({
    ...fertig,
    agentId: 'agent-7',
    turnId: 't1',
    durationMs: 8_000,
    usage: { model: 'claude-haiku-5-5', input_tokens: 4, output_tokens: 1911, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 },
  })
  await $.turn.complete({
    ...fertig,
    answer: 'geheime Antwort',
    turnId: 't1',
    durationMs: 30_000,
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 15_000, cache_creation_input_tokens: 1000 },
  })

  const text = w.dateien.get(JOURNAL('sess-1'))
  expect(text).toBeDefined()
  expect(text).not.toContain('geheim')
  const j = JSON.parse(text ?? '{}')
  expect(j.vollstaendig).toBe(true)
  expect(j.git_repo).toBe('github.com/beispiel/repo')
  expect(Object.keys(j.nutzung).sort()).toEqual(['agent-7|claude-haiku-5-5|standard', 'main|claude-opus-5-5|standard'])

  // Upload erst 20 s nach der letzten Antwort
  const vorher = w.anfragen.filter(a => a.url.endsWith('/ingest')).length
  await w.uhr.advance(19_000)
  expect(w.anfragen.filter(a => a.url.endsWith('/ingest')).length).toBe(vorher)
  await w.uhr.advance(2_000)
  const uploads = w.anfragen.filter(a => a.url.endsWith('/ingest'))
  expect(uploads.length).toBe(vorher + 1)
  const letzter = uploads.at(-1)
  expect(letzter?.init?.headers?.Authorization).toBe('Bearer aic_geheim1234567')
  const body = letzter?.init?.body ?? ''
  expect(body).not.toContain('geheim')
  const payload = JSON.parse(body)
  expect(payload.schema_version).toBe(2)
  const s = payload.sessions[0]
  expect(s.quelle).toBe('plugin')
  expect(s.plugin_vollstaendig).toBe(true)
  expect(s.kosten_engine_usd).toBe(0.42)
  expect(s.kontext_fenster_tokens).toBe(1_000_000)
  expect(s.turns).toBe(1)
  expect(s.engine_output_tokens).toBe(2211)
  expect(s.agents).toEqual([{ agent_id: 'agent-7', modell: 'claude-haiku-5-5', turns: 1 }])

  // nach erfolgreichem Upload ist das Journal sauber
  expect(JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}').dirty).toBe(false)
})

test('Upload-Fehler bleibt offen und wird beim Sessionende erneut angestoßen', async ($, on) => {
  let kaputt = true
  const w = welt(on, a => (a.url.endsWith('/ingest') && kaputt ? antwort(500, { fehler: 'down' }) : standardServer(a)), { token: 'aic_geheim1234567' })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' })
  await $.turn.complete({
    ...fertig,
    turnId: 't1',
    durationMs: 1000,
    usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  await w.uhr.advance(21_000)
  expect(JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}').dirty).toBe(true)
  const status = await befehl($, 'status')
  expect(status.text).toContain('HTTP 500: down')
  expect(status.text).toContain('Offene Uploads: 1')

  kaputt = false
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await w.uhr.settle()
  expect(JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}').dirty).toBe(false)
})

const ANTWORT = { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const letzteKosten = (w: Welt): unknown => {
  const uploads = w.anfragen.filter(a => a.url.endsWith('/ingest'))
  return JSON.parse(uploads.at(-1)?.init?.body ?? '{}').sessions?.[0]?.kosten_engine_usd
}

test('Kosten nach der letzten Antwort: entprellter Upload übernimmt den aktuellen Zähler', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' })
  w.sitzung.kosten = 0.3385
  await $.turn.complete({ ...fertig, turnId: 't1', durationMs: 1000, usage: ANTWORT })
  // Hintergrundaufruf von Claude Code ohne turn.complete
  w.sitzung.kosten = 0.36
  await w.uhr.advance(21_000)
  await w.uhr.settle()
  expect(letzteKosten(w)).toBe(0.36)
  const j = JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}')
  expect(j.kosten.basis + j.kosten.letzter).toBe(0.36)
  expect(j.dirty).toBe(false)
})

test('Kosten nach dem letzten Upload: Sessionende lädt den gestiegenen Zähler hoch', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' })
  w.sitzung.kosten = 0.30
  await $.turn.complete({ ...fertig, turnId: 't1', durationMs: 1000, usage: ANTWORT })
  await w.uhr.advance(21_000)
  await w.uhr.settle()
  expect(letzteKosten(w)).toBe(0.3)
  const vorher = w.anfragen.filter(a => a.url.endsWith('/ingest')).length

  // sonst unverändertes Journal: nur der Kostenzähler steigt
  w.sitzung.kosten = 0.36
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  await w.uhr.settle()
  expect(w.anfragen.filter(a => a.url.endsWith('/ingest')).length).toBe(vorher + 1)
  expect(letzteKosten(w)).toBe(0.36)
  expect(JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}').dirty).toBe(false)
})

test('/aicosts sync übernimmt den Zähler nur für die laufende Session', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' })
  w.sitzung.kosten = 0.10
  await $.turn.complete({ ...fertig, turnId: 't1', durationMs: 1000, usage: ANTWORT })
  await w.uhr.advance(21_000)
  await w.uhr.settle()

  // offenes Journal einer anderen Session mit eigenem Kostenstand
  const fremd = JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}')
  w.dateien.set(JOURNAL('sess-alt'), JSON.stringify({ ...fremd, session_id: 'sess-alt', kosten: { basis: 0, letzter: 5 }, dirty: true }))

  w.sitzung.kosten = 0.25
  const r = await befehl($, 'sync')
  expect(r.text).toContain('Hochgeladen: 2 Session(s).')
  const uploads = w.anfragen.filter(a => a.url.endsWith('/ingest'))
  const sessions: { session_id: string; kosten_engine_usd: number }[] = JSON.parse(uploads.at(-1)?.init?.body ?? '{}').sessions
  expect(sessions.find(s => s.session_id === 'sess-1')?.kosten_engine_usd).toBe(0.25)
  expect(sessions.find(s => s.session_id === 'sess-alt')?.kosten_engine_usd).toBe(5)
})

test('Plugin kommt mitten in einer Session dazu: Teil-Erfassung markiert', async ($, on) => {
  const w = welt(on, standardServer)
  w.sitzung.turns = 4
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    ...fertig,
    turnId: 't9',
    durationMs: 1000,
    usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  expect(JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}').vollstaendig).toBe(false)
})

test('Resume: vorhandenes Journal wird fortgesetzt', async ($, on) => {
  const w = welt(on, standardServer)
  w.sitzung.turns = 3
  w.dateien.set(
    JOURNAL('sess-1'),
    JSON.stringify({
      v: 1, session_id: 'sess-1', vollstaendig: true, gestartet: T0 - 3_600_000, beendet: T0 - 1_800_000,
      cwd: '/projekt', git_repo: null, git_root: null, git_branch: null, modelle: { 'claude-opus-5-5': 3 },
      nutzung: { 'main|claude-opus-5-5|standard': { strang: 'main', modell: 'claude-opus-5-5', preisstufe: 'standard', anfragen: 3, input_tokens: 30, output_tokens: 3000, cache_read_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0 } },
      agents: {}, stunden: {}, eingriffe: [], letzteAntwortEnde: T0 - 1_800_000, kontextMax: 10, kontextFenster: 200_000,
      kosten: { basis: 0, letzter: 2 }, engine: { input: 30, output: 3000, cache_read: 0, cache_write: 0 }, turns: 3,
      letztesModell: 'claude-opus-5-5', rev: 9, dirty: false, letzterUpload: null,
    }),
  )
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  w.sitzung.kosten = 0.25
  await $.turn.complete({
    ...fertig,
    turnId: 't4',
    durationMs: 1000,
    usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  const j = JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}')
  expect(j.vollstaendig).toBe(true)
  expect(j.nutzung['main|claude-opus-5-5|standard'].anfragen).toBe(4)
  // neuer Prozess begann bei 0 → 2 + 0,25
  expect(j.kosten.basis + j.kosten.letzter).toBe(2.25)
})

test('/clear: neue Session-ID bekommt ein eigenes Journal', async ($, on) => {
  const w = welt(on, standardServer)
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const u = { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await $.turn.complete({ ...fertig, turnId: 't1', durationMs: 1000, usage: u })
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  w.sitzung.id = 'sess-2'
  await $.turn.complete({ ...fertig, turnId: 't2', durationMs: 1000, usage: u })
  expect(w.dateien.has(JOURNAL('sess-1'))).toBe(true)
  expect(JSON.parse(w.dateien.get(JOURNAL('sess-2')) ?? '{}').vollstaendig).toBe(true)
})

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
}

test('Band zeichnet auf Terminal und Desktop, ohne Login mit Hinweis', async ($, on) => {
  welt(on, standardServer)
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'aicosts', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Kontext\s20\.0k\s\/\s1\.00M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /nicht\sverbunden\s·\s\/aicosts\slogin/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Kontext\sunkritisch/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Band zeigt Session-Summe und Monatswert, wenn verbunden', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567', workspace: 'Team' })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await w.uhr.advance(2_000) // Stats nach 1,5 s
  await $.turn.complete({
    ...fertig,
    turnId: 't1',
    durationMs: 1000,
    usage: { model: 'claude-opus-5-5', input_tokens: 500, output_tokens: 1500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'aicosts', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Session\s2\.0k\sToken\s\(Out\s1\.5k\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Okt\s2\.00M\sToken\s·\s\$12\.50/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Band zeigt die Abo-Limits mit Restzeit, ohne Abo keine', async ($, on) => {
  const w = welt(on, standardServer)
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const ohne = await $.ui.mount({ plugin: 'aicosts', surface: 'terminal', ...BAND })
  expect(await ohne.find({ type: 'Text', text: /Limit/ })).toBeUndefined()
  await ohne.unmount()
  w.sitzung.limits = [
    { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(T0 + 130 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 92, resetsAt: new Date(T0 + 76 * 3_600_000).toISOString() },
  ]
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'aicosts', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^5h-Limit\s23\s%\s\(Reset\sin\s2\sh\s10\smin\)$/ })).toBeDefined()
    const woche = await ui.find({ type: 'Text', text: /^Wochenlimit\s92\s%\s\(Reset\sin\s3\sT\s4\sh\)$/ })
    expect(woche?.props.color).toBe('error')
    await ui.unmount()
  }
})

const STATS_ECHT = {
  version: 1,
  monat: '2026-10',
  gesamt: { tokens: 668_590_000, output_tokens: 1000, kosten_usd: 268.65, sessions: 3, echt_eur: 90 },
  session: null,
  faktor: { monat: '2026-10', eur_pro_usd_projekt: 0.5, eur_pro_usd_gesamt: 0.625, abo_hinterlegt: true },
}

const echtServer = (stats: unknown) => (a: Anfrage): HttpResponse =>
  a.url.endsWith('/ingest/stats') ? antwort(200, stats) : standardServer(a)

test('Band zeigt standardmäßig echte Kosten in EUR', async ($, on) => {
  const w = welt(on, echtServer(STATS_ECHT), { token: 'aic_geheim1234567', workspace: 'Team' })
  w.sitzung.kosten = 7.48
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await w.uhr.advance(2_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'aicosts', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^≈3,74\s€$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Okt\s668\.59M\sToken\s·\s90,00\s€$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/aicosts kosten api|echt schaltet um und wird gespeichert', async ($, on) => {
  const w = welt(on, echtServer(STATS_ECHT), { token: 'aic_geheim1234567', workspace: 'Team' })
  w.sitzung.kosten = 7.48
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await w.uhr.advance(2_000)

  const zeigen = await befehl($, 'kosten')
  expect(zeigen.text).toContain('echt (EUR)')
  expect(zeigen.text).toContain('Session 0,5000 €/$')

  const api = await befehl($, 'kosten api')
  expect(api.text).toContain('Kostenmodus gespeichert: api')
  expect(w.speicher.get('kostenModus')).toBe('api')
  let ui = await $.ui.mount({ plugin: 'aicosts', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^\$7\.48$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Okt\s668\.59M\sToken\s·\s\$268\.65$/ })).toBeDefined()
  await ui.unmount()

  const status = await befehl($, 'status')
  expect(status.text).toContain('Kosten im Band: api (USD)')
  expect(status.text).toContain('Faktor Okt')

  expect((await befehl($, 'kosten bitcoin')).text).toContain('Unbekannt')
  expect(w.speicher.get('kostenModus')).toBe('api')

  await befehl($, 'kosten echt')
  expect(w.speicher.get('kostenModus')).toBe('echt')
  ui = await $.ui.mount({ plugin: 'aicosts', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^≈3,74\s€$/ })).toBeDefined()
  await ui.unmount()
})

test('Gespeicherter Modus „api“ gilt ab Sessionstart', async ($, on) => {
  const w = welt(on, echtServer(STATS_ECHT), { token: 'aic_geheim1234567', kostenModus: 'api' })
  w.sitzung.kosten = 1
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await w.uhr.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'aicosts', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^\$1\.00$/ })).toBeDefined()
  await ui.unmount()
})

test('Rückfall auf USD mit Zusatz „API“: kein Abo, älterer Server, nicht verbunden', async ($, on) => {
  let antwortStats: unknown = { ...STATS_ECHT, faktor: { ...STATS_ECHT.faktor, abo_hinterlegt: false } }
  const w = welt(on, a => (a.url.endsWith('/ingest/stats') ? antwort(200, antwortStats) : standardServer(a)), { token: 'aic_geheim1234567' })
  w.sitzung.kosten = 7.48
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await w.uhr.advance(2_000)
  let ui = await $.ui.mount({ plugin: 'aicosts', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^\$7\.48\sAPI$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /·\s\$268\.65\sAPI$/ })).toBeDefined()
  await ui.unmount()

  // älterer Server ohne neue Felder
  antwortStats = STATS
  await befehl($, 'sync')
  await w.uhr.settle()
  ui = await $.ui.mount({ plugin: 'aicosts', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /·\s\$12\.50\sAPI$/ })).toBeDefined()
  await ui.unmount()

  // abgemeldet
  await befehl($, 'logout')
  ui = await $.ui.mount({ plugin: 'aicosts', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^\$7\.48\sAPI$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /nicht\sverbunden/ })).toBeDefined()
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// R3: Quittierung nur bestätigter Sessions

/** Offenes (oder sauberes) Journal einer anderen Session mit gültigem Inhalt, mtime gezielt gesetzt */
const legeJournalAn = (w: Welt, sid: string, opt: { dirty?: boolean; mtime?: number } = {}): void => {
  const j = neuesJournal(sid, T0 - 3_600_000, true)
  j.cwd = '/projekt'
  verbucheAntwort(j, { usage: ANTWORT, durationMs: 1000, ende: T0 - 1_800_000, cacheTtlMinuten: 60 })
  j.dirty = opt.dirty ?? true
  w.dateien.set(JOURNAL(sid), JSON.stringify(j))
  w.mtimes.set(JOURNAL(sid), opt.mtime ?? T0 - 60_000)
}

const istDirty = (w: Welt, sid: string): boolean => JSON.parse(w.dateien.get(JOURNAL(sid)) ?? '{}').dirty === true

const ingestAnfragen = (w: Welt): Anfrage[] => w.anfragen.filter(a => a.url.endsWith('/ingest'))

test('R3: voller Erfolg mit Einzelergebnissen quittiert und meldet Hochgeladen', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  legeJournalAn(w, 'sess-alt')
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const r = await befehl($, 'sync')
  expect(r.text).toBe('Hochgeladen: 1 Session(s).')
  expect(istDirty(w, 'sess-alt')).toBe(false)
  expect(w.speicher.get('letzterUpload')).toMatchObject({ sessions: 1, uebersprungen: 0, abgelehnt: 0 })
})

test('R3: Ablehnung ohne Einzelergebnisse (älterer Server) wird nicht quittiert', async ($, on) => {
  const w = welt(on, a => (a.url.endsWith('/ingest') ? antwort(200, { upserted: 0, unassigned: 0, abgelehnt: 1 }) : standardServer(a)), {
    token: 'aic_geheim1234567',
  })
  legeJournalAn(w, 'sess-alt')
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const r = await befehl($, 'sync')
  expect(r.text).not.toContain('Hochgeladen')
  expect(r.text).toContain('nicht bestätigt')
  expect(istDirty(w, 'sess-alt')).toBe(true)
  expect(w.speicher.get('letzterUpload')).toBe(undefined)
  const status = await befehl($, 'status')
  expect(status.text).toContain('Offene Uploads: 1')
  expect(status.text).toContain('ohne Einzelergebnisse')
})

test('R3: älterer Server mit sauberem Erfolg quittiert weiterhin alles', async ($, on) => {
  const w = welt(
    on,
    a => (a.url.endsWith('/ingest') ? antwort(200, { upserted: gesendeteIds(a).length, unassigned: 1, abgelehnt: 0 }) : standardServer(a)),
    { token: 'aic_geheim1234567' },
  )
  legeJournalAn(w, 'sess-x')
  legeJournalAn(w, 'sess-y')
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  expect((await befehl($, 'sync')).text).toBe('Hochgeladen: 2 Session(s).')
  expect(istDirty(w, 'sess-x') || istDirty(w, 'sess-y')).toBe(false)
})

test('R3: gemischter Batch quittiert nur Sessions mit Eintrag, Hinweise sichtbar, kein erneuter Versand', async ($, on) => {
  const w = welt(
    on,
    a => {
      if (!a.url.endsWith('/ingest')) return standardServer(a)
      const ids = gesendeteIds(a)
      const ergebnisse = ids
        .filter(id => id !== 'sess-ohne')
        .map(session_id =>
          session_id === 'sess-gut'
            ? { session_id, status: 'gespeichert', grund: null }
            : session_id === 'sess-schutz'
              ? { session_id, status: 'uebersprungen', grund: 'geringere_quelle' }
              : { session_id, status: 'abgelehnt', grund: 'fremde_session' },
        )
      const zahl = (st: string): number => ergebnisse.filter(e => e.status === st).length
      return antwort(200, { upserted: zahl('gespeichert'), unassigned: 0, uebersprungen: zahl('uebersprungen'), abgelehnt: zahl('abgelehnt'), ergebnisse })
    },
    { token: 'aic_geheim1234567' },
  )
  for (const sid of ['sess-gut', 'sess-schutz', 'sess-fremd', 'sess-ohne']) legeJournalAn(w, sid)
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const r = await befehl($, 'sync')
  expect(r.text).toContain('Hochgeladen: 2 Session(s), davon 1 übersprungen (bessere Erfassung auf dem Server).')
  expect(r.text).toContain('1 abgelehnt')
  expect(r.text).toContain('1 ohne Ergebnis')
  expect(istDirty(w, 'sess-gut')).toBe(false)
  expect(istDirty(w, 'sess-schutz')).toBe(false)
  expect(istDirty(w, 'sess-fremd')).toBe(false)
  expect(istDirty(w, 'sess-ohne')).toBe(true)
  expect(w.speicher.get('letzterUpload')).toMatchObject({ sessions: 3, uebersprungen: 1, abgelehnt: 1 })

  const status = await befehl($, 'status')
  expect(status.text).toContain('Letzter Fehler: Session sess-fremd gehört einem anderen Nutzer – nicht übernommen')
  expect(status.text).toContain('Nicht übernommen (zuletzt):')
  expect(status.text).toContain('sess-schutz: uebersprungen – bessere Erfassung auf dem Server behalten')
  expect(status.text).toContain('sess-fremd: abgelehnt – gehört einem anderen Nutzer')
  expect(status.text).toContain('Letzter Upload:')
  expect(status.text).toContain('davon 1 übersprungen, 1 abgelehnt')

  // erneuter Sync sendet nur die unbestätigte Session
  await befehl($, 'sync')
  expect(gesendeteIds(ingestAnfragen(w).at(-1) ?? { url: '', init: undefined })).toEqual(['sess-ohne'])
})

test('R3: ungültiges JSON bei HTTP 200 ist kein Erfolg', async ($, on) => {
  const w = welt(on, a => (a.url.endsWith('/ingest') ? { status: 200, ok: true, headers: {}, text: '<html>oops' } : standardServer(a)), {
    token: 'aic_geheim1234567',
  })
  legeJournalAn(w, 'sess-alt')
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const r = await befehl($, 'sync')
  expect(r.text).not.toContain('Hochgeladen')
  expect(istDirty(w, 'sess-alt')).toBe(true)
  expect((await befehl($, 'status')).text).toContain('kein JSON')
})

test('R3: Änderung während des Uploads bleibt offen', async ($, on) => {
  let freigeben: () => void = () => undefined
  let haengen = true
  // Upload hält an, bis der Test eine weitere Antwort verbucht hat
  const w = welt(
    on,
    async a => {
      if (a.url.endsWith('/ingest') && haengen) {
        haengen = false
        await new Promise<void>(r => {
          freigeben = r
        })
      }
      return standardServer(a)
    },
    { token: 'aic_geheim1234567' },
  )
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '', turnId: 't1' })
  await $.turn.complete({ ...fertig, turnId: 't1', durationMs: 1000, usage: ANTWORT })
  const sync = befehl($, 'sync')
  await w.uhr.settle()
  // Upload steht wirklich in der Anfrage, wenn die nächste Antwort kommt
  expect(haengen).toBe(false)
  expect(ingestAnfragen(w).length).toBe(1)
  await $.turn.complete({ ...fertig, turnId: 't2', durationMs: 1000, usage: ANTWORT })
  freigeben()
  expect((await sync).text).toBe('Hochgeladen: 1 Session(s).')
  expect(istDirty(w, 'sess-1')).toBe(true)
  expect(JSON.parse(w.dateien.get(JOURNAL('sess-1')) ?? '{}').letzterUpload).not.toBe(null)
})

// ---------------------------------------------------------------------------
// R5: Nachholen findet auch ältere offene Journale

test('R5: 50 neuere saubere und ein älteres offenes Journal → wird nachgeholt', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  legeJournalAn(w, 'sess-alt-offen', { mtime: T0 - 5 * 86_400_000 })
  for (let i = 0; i < 50; i += 1) legeJournalAn(w, `sess-sauber-${i}`, { dirty: false, mtime: T0 - 86_400_000 + i })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const r = await befehl($, 'sync')
  expect(r.text).toBe('Hochgeladen: 1 Session(s).')
  expect(istDirty(w, 'sess-alt-offen')).toBe(false)
})

test('R5: mehr als 50 offene werden über aufeinanderfolgende Aufrufe abgearbeitet', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  for (let i = 0; i < 60; i += 1) legeJournalAn(w, `sess-offen-${String(i).padStart(2, '0')}`, { mtime: T0 - 86_400_000 + i })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  expect((await befehl($, 'status')).text).toContain('Offene Uploads: 50+')
  expect((await befehl($, 'sync')).text).toBe('Hochgeladen: 50 Session(s).')
  // die ältesten zuerst
  expect(istDirty(w, 'sess-offen-00')).toBe(false)
  expect(istDirty(w, 'sess-offen-59')).toBe(true)
  expect((await befehl($, 'status')).text).toContain('Offene Uploads: 10')
  expect((await befehl($, 'sync')).text).toBe('Hochgeladen: 10 Session(s).')
  expect([...w.dateien.keys()].filter(p => p.includes('sess-offen-')).some(p => JSON.parse(w.dateien.get(p) ?? '{}').dirty)).toBe(false)
  expect((await befehl($, 'sync')).text).toBe('Nichts zu senden – alles aktuell.')
})

test('R5: beschädigte Datei, aktuelle Session und Altersgrenze', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  w.dateien.set(JOURNAL('sess-kaputt'), '{kaputt')
  w.mtimes.set(JOURNAL('sess-kaputt'), T0 - 10 * 86_400_000)
  legeJournalAn(w, 'sess-zu-alt', { mtime: T0 - 15 * 86_400_000 })
  legeJournalAn(w, 'sess-ok', { mtime: T0 - 13 * 86_400_000 })
  // offenes Journal der laufenden Session (wird nur als aktuelle Session gesendet, nicht doppelt)
  legeJournalAn(w, 'sess-1', { mtime: T0 - 20_000 })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  const r = await befehl($, 'sync')
  expect(r.text).toBe('Hochgeladen: 2 Session(s).')
  expect(gesendeteIds(ingestAnfragen(w).at(-1) ?? { url: '', init: undefined }).sort()).toEqual(['sess-1', 'sess-ok'])
  expect(istDirty(w, 'sess-zu-alt')).toBe(true)
  expect(w.dateien.get(JOURNAL('sess-kaputt'))).toBe('{kaputt')
})

test('R5: Lesezugriffe je Nachholversuch sind begrenzt', async ($, on) => {
  const w = welt(on, standardServer, { token: 'aic_geheim1234567' })
  for (let i = 0; i < 450; i += 1) legeJournalAn(w, `sess-s-${String(i).padStart(3, '0')}`, { dirty: false, mtime: T0 - 86_400_000 + i })
  await $.session.start({ cwd: '/projekt', surface: 'terminal', isInteractive: true })
  w.gelesen.length = 0
  const status = await befehl($, 'status')
  expect(w.gelesen.filter(p => p.includes('sess-s-')).length).toBe(400)
  expect(status.text).toContain('Offene Uploads: 0+')
})
