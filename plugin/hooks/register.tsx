import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CacheSettings, CacheState, SessionSumme, Verbindung } from '../types'
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  cacheColor,
  formatRemaining,
  migrateSettings,
  parseCacheArgs,
  remainingMs,
  shouldPing,
} from './cache'
import {
  basisUrl,
  devicePollUrl,
  deviceStartUrl,
  fehlerText,
  istErlaubteUrl,
  parseDevicePoll,
  parseDeviceStart,
  standardIngestUrl,
  statsUrl,
} from './geraet'
import { branchAusHead, elternPfade, gitdirAusDatei, normalisiereRemote } from './git'
import {
  leseJournal,
  markiereHochgeladen,
  neuesJournal,
  summe,
  verbucheAntwort,
  verbucheEingabe,
  verbucheKontext,
  verbucheKosten,
  verbucheTurns,
  verbucheTurnStart,
  type Journal,
} from './journal'
import { baueSession, istLeer, pruefeSession, PAYLOAD_SCHEMA_VERSION, type IngestPayload } from './payload'
import { formatTokens, monatKurz, parseStats } from './stats'

// Plugin „aicosts“: Band (Kontext, Kosten, Cache), Cache-Keep-Alive, Live-Erfassung und Upload an die AICosts-Cloud.
// DATENSCHUTZ: Es werden nur Kennzahlen erfasst und gesendet – niemals Prompt- oder Antworttext.
// Der Token liegt nur in $.store und wird nie angezeigt oder geloggt.

/** Muss mit .claude-plugin/plugin.json übereinstimmen */
export const VERSION = '0.1.1'
const PARSER_VERSION = `aicosts-plugin/${VERSION}`

// Schwellen für den Übergabe-Hinweis, in Prozent des Kontextfensters
const HANDOFF_SOON_AT = 70
const HANDOFF_NOW_AT = 85
const BAR_WIDTH = 24
// Takt für Countdown und Keep-Alive-Prüfung
const TICK_MS = 15_000
const PING_PROMPT = 'Cache-Keepalive. Antworte nur mit: ok'
// Upload entprellt nach der letzten Antwort
const UPLOAD_NACH_MS = 20_000
// Monatssumme höchstens so oft vom Server holen
const STATS_ABSTAND_MS = 60_000
// Nach Sessionstart: offene Uploads anderer Sessions nachholen
const NACHHOLEN_NACH_MS = 5_000
const NACHHOLEN_TAGE = 14
const NACHHOLEN_MAX = 50

// Schlüssel in $.store
const K_TOKEN = 'token'
const K_WORKSPACE = 'workspace'
const K_INGEST = 'ingestUrl'
const K_BASIS = 'basisUrl'
const K_SETTINGS = 'cacheSettings'
const K_SETTINGS_VERSION = 'cacheSettingsVersion'
const K_STATS = 'statsCache'
const K_LETZTER_UPLOAD = 'letzterUpload'
const K_LETZTER_FEHLER = 'letzterFehler'

const emptyCache: CacheState = { lastActivityAt: null, isRunning: false, pings: 0, lastPing: null }
const leereSumme: SessionSumme = { tokens: 0, outputTokens: 0 }
const getrennt: Verbindung = { verbunden: false, workspace: null }

const summeAtom = atom({ plugin: 'aicosts', key: 'summe' } as const, leereSumme)
const settings = atom({ plugin: 'aicosts', key: 'settings' } as const, DEFAULT_SETTINGS)
const cache = atom({ plugin: 'aicosts', key: 'cache' } as const, emptyCache)
const tick = atom({ plugin: 'aicosts', key: 'tick' } as const, 0)
const stats = atom({ plugin: 'aicosts', key: 'stats' } as const, null)
const verbindung = atom({ plugin: 'aicosts', key: 'verbindung' } as const, getrennt)

// Geschützte Leerzeichen verhindern Umbrüche innerhalb eines Segments
const NBSP = '\u00a0'
const noBreak = (text: string): string => text.replace(/ /g, NBSP)

const formatBar = (percent: number): string => {
  const filled = Math.round((Math.min(percent, 100) / 100) * BAR_WIDTH)
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

const handoffHint = (percent: number): { text: string; color: string } => {
  if (percent >= HANDOFF_NOW_AT) return { text: 'Übergabe jetzt empfohlen', color: 'error' }
  if (percent >= HANDOFF_SOON_AT) return { text: 'Übergabe bald einplanen', color: 'warning' }
  return { text: 'Kontext unkritisch', color: 'success' }
}

const cacheLabel = (c: CacheState, s: CacheSettings, now: number): { text: string; color: string } => {
  const pings = s.keepAlive ? ` ♻ ${c.pings}/${s.maxPings}` : ' ♻ aus'
  if (c.isRunning) return { text: `Cache aktiv${pings}`, color: 'success' }
  const rest = remainingMs(c, s, now)
  if (rest === null) return { text: `Cache –${pings}`, color: 'dim' }
  if (rest <= 0) return { text: `Cache abgelaufen${pings}`, color: 'error' }
  return { text: `Cache ${formatRemaining(rest)}${pings}`, color: cacheColor(rest) }
}

const zeitText = (ms: number): string => {
  try {
    return new Date(ms).toLocaleString('de-DE')
  } catch {
    return new Date(ms).toISOString()
  }
}

// ---------------------------------------------------------------------------
// Laufzeitstand des Moduls (geht bei Hot-Reload verloren; das Journal liegt auf der Platte)

let journal: Journal | null = null
let journalLaden: Promise<Journal | null> | null = null
let schreibKette: Promise<void> = Promise.resolve()
let uploadTimer: Timer | null = null
let laeuftUpload = false
let statsZuletzt = 0
let laedtStats = false
let offenAnzahl = 0
let isPinging = false
let login: { abgebrochen: boolean } | null = null

const homeVerzeichnis = async ($: EngineInterface): Promise<string | null> => {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home === undefined || home.length === 0 ? null : home.replace(/[\\/]+$/, '')
}

const journalOrdner = async ($: EngineInterface): Promise<string | null> => {
  const home = await homeVerzeichnis($)
  return home === null ? null : `${home}/.aicosts/plugin/journal`
}

/** Schreibt ein Journal (Aufrufe nacheinander, Fehler werden geschluckt) */
const speichere = ($: EngineInterface, j: Journal): Promise<void> => {
  const text = JSON.stringify(j)
  schreibKette = schreibKette
    .then(async () => {
      const ordner = await journalOrdner($)
      if (ordner !== null) await $.fs.write(`${ordner}/${j.session_id}.json`, text)
    })
    .catch(() => undefined)
  return schreibKette
}

/** Git-Angaben aus $.session.repo() und .git/HEAD (ohne git-Programm) */
const leseGit = async ($: EngineInterface, cwd: string): Promise<Pick<Journal, 'git_repo' | 'git_root' | 'git_branch'>> => {
  const repo = await $.session.repo().catch(() => null)
  let branch: string | null = null
  if (repo !== null) {
    for (const pfad of elternPfade(cwd)) {
      const punktGit = `${pfad}/.git`
      const stat = await $.fs.stat(punktGit).catch(() => null)
      if (stat === null) continue
      let gitdir: string | null = punktGit
      if (stat.kind === 'file') gitdir = gitdirAusDatei(await $.fs.read(punktGit).catch(() => ''), pfad)
      if (gitdir !== null) branch = branchAusHead(await $.fs.read(`${gitdir}/HEAD`).catch(() => ''))
      break
    }
  }
  return { git_repo: normalisiereRemote(repo?.remote ?? null), git_root: repo?.root ?? null, git_branch: branch }
}

const aktualisiereMeta = async ($: EngineInterface, j: Journal): Promise<void> => {
  const cwd = await $.session.cwd()
  const git = await leseGit($, cwd)
  if (j.cwd === cwd && j.git_repo === git.git_repo && j.git_root === git.git_root && j.git_branch === git.git_branch) return
  Object.assign(j, { cwd }, git)
  j.rev += 1
  j.dirty = true
}

const zeigeSumme = async ($: EngineInterface, j: Journal): Promise<void> => {
  const s = summe(j)
  const alt = await read($, summeAtom)
  if (alt.tokens !== s.tokens || alt.outputTokens !== s.outputTokens) await update($, summeAtom, () => s)
}

/** Lädt oder erzeugt das Journal der aktuellen Session (wechselt bei /clear automatisch) */
const aktuellesJournal = async ($: EngineInterface): Promise<Journal | null> => {
  const sid = await $.session.id()
  if (journal !== null && journal.session_id === sid) return journal
  if (journalLaden !== null) {
    const j = await journalLaden
    if (j !== null && j.session_id === sid) return j
  }
  const alt = journal
  journalLaden = (async (): Promise<Journal | null> => {
    // Vorherige Session (z. B. nach /clear) noch hochladen
    if (alt !== null && alt.dirty) void hochladen($, [alt])
    const ordner = await journalOrdner($)
    let j: Journal | null = null
    if (ordner !== null) {
      const text = await $.fs.read(`${ordner}/${sid}.json`).catch(() => null)
      if (text !== null) j = leseJournal(text, sid)
    }
    if (j === null) {
      const now = await $.clock.now()
      const turns = await $.session.turns().catch(() => 1)
      const startedAt = (await $.session.usage()).startedAt
      const gestartet = typeof startedAt === 'number' && startedAt > 0 && startedAt <= now ? startedAt : now
      // Vollständig nur, wenn das Plugin die Session vor dem ersten Turn sieht
      j = neuesJournal(sid, gestartet, turns === 0)
      j.turns = turns
    }
    await aktualisiereMeta($, j).catch(() => undefined)
    journal = j
    await zeigeSumme($, j)
    return j
  })()
  try {
    return await journalLaden
  } finally {
    journalLaden = null
  }
}

/** Führt eine Änderung am Journal aus und speichert es; Fehler stören die Session nie */
const mitJournal = async ($: EngineInterface, fn: (j: Journal) => void | Promise<void>): Promise<void> => {
  try {
    const j = await aktuellesJournal($)
    if (j === null) return
    const rev = j.rev
    await fn(j)
    // Leere Sessions (z. B. claude -p ohne Antwort) legen keine Datei an
    if (j.rev !== rev && !istLeer(j)) {
      await speichere($, j)
      await zeigeSumme($, j)
    }
  } catch {
    // Erfassung ist Nebensache: nie die Session stören
  }
}

// ---------------------------------------------------------------------------
// Upload

const ingestAdresse = async ($: EngineInterface): Promise<string> => {
  const gespeichert = await $.store.get(K_INGEST)
  if (istErlaubteUrl(gespeichert)) return gespeichert
  return standardIngestUrl(basisUrl(await $.store.get(K_BASIS)))
}

const leseToken = async ($: EngineInterface): Promise<string | null> => {
  const t = await $.store.get(K_TOKEN)
  return typeof t === 'string' && t.length > 0 ? t : null
}

const setzeFehler = async ($: EngineInterface, text: string | null): Promise<void> => {
  if (text === null) await $.store.delete(K_LETZTER_FEHLER)
  else await $.store.set(K_LETZTER_FEHLER, { zeit: await $.clock.now(), text })
}

/**
 * Lädt die übergebenen Journale hoch (nur geänderte, nicht leere). Fehler werden gemerkt und beim
 * nächsten Anlass erneut versucht (Journal bleibt „dirty“). Rückgabe: kurze Meldung für /aicosts sync.
 */
const hochladen = async ($: EngineInterface, journale: Journal[]): Promise<string> => {
  if (laeuftUpload) return 'Upload läuft bereits.'
  laeuftUpload = true
  try {
    const token = await leseToken($)
    if (token === null) return 'Nicht verbunden – zuerst /aicosts login.'
    const kandidaten = journale.filter((j, i) => j.dirty && !istLeer(j) && journale.findIndex(x => x.session_id === j.session_id) === i)
    if (kandidaten.length === 0) return 'Nichts zu senden – alles aktuell.'
    const revs = kandidaten.map(j => j.rev)
    const sessions = kandidaten.map(j => baueSession(j, PARSER_VERSION))
    const gueltig = sessions.filter(s => pruefeSession(s).length === 0)
    if (gueltig.length < sessions.length) {
      const erste = sessions.find(s => pruefeSession(s).length > 0)
      await setzeFehler($, `Session ${erste?.session_id ?? '?'} ungültig: ${erste ? pruefeSession(erste)[0] : ''}`)
    }
    if (gueltig.length === 0) return 'Keine gültige Session zu senden.'
    const payload: IngestPayload = { schema_version: PAYLOAD_SCHEMA_VERSION, sessions: gueltig }
    const antwort = await $.http.fetch(await ingestAdresse($), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!antwort.ok) {
      const meldung = fehlerText(antwort.status, antwort.text)
      await setzeFehler($, meldung)
      return `Upload fehlgeschlagen: ${meldung}`
    }
    const now = await $.clock.now()
    const gesendet = new Set(gueltig.map(s => s.session_id))
    for (const [i, j] of kandidaten.entries()) {
      if (!gesendet.has(j.session_id)) continue
      markiereHochgeladen(j, revs[i] ?? -1, now)
      await speichere($, j)
    }
    offenAnzahl = Math.max(0, offenAnzahl - gueltig.filter(s => s.session_id !== journal?.session_id).length)
    await $.store.set(K_LETZTER_UPLOAD, { zeit: now, sessions: gueltig.length })
    if (gueltig.length === sessions.length) await setzeFehler($, null)
    return `Hochgeladen: ${gueltig.length} Session(s).`
  } catch {
    await setzeFehler($, 'Netzwerkfehler – wird später erneut versucht').catch(() => undefined)
    return 'Upload fehlgeschlagen (Netzwerk). Wird später erneut versucht.'
  } finally {
    laeuftUpload = false
  }
}

/** Upload entprellt anstoßen: 20 s nach der letzten Antwort */
const planeUpload = ($: EngineInterface): void => {
  uploadTimer?.cancel()
  uploadTimer = $.clock.after(UPLOAD_NACH_MS, () => {
    uploadTimer = null
    if (journal !== null) void hochladen($, [journal])
  })
}

/** Offene (nicht hochgeladene) Journale anderer Sessions der letzten Tage */
const offeneJournale = async ($: EngineInterface): Promise<Journal[]> => {
  const ordner = await journalOrdner($)
  if (ordner === null) return []
  const eintraege = await $.fs.list(ordner).catch(() => [])
  const grenze = (await $.clock.now()) - NACHHOLEN_TAGE * 86_400_000
  const kandidaten = eintraege
    .filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.mtimeMs >= grenze)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, NACHHOLEN_MAX)
  const offen: Journal[] = []
  for (const e of kandidaten) {
    const sid = e.name.slice(0, -'.json'.length)
    if (sid === journal?.session_id) continue
    const text = await $.fs.read(`${ordner}/${e.name}`).catch(() => null)
    const j = text === null ? null : leseJournal(text, sid)
    if (j !== null && j.dirty && !istLeer(j)) offen.push(j)
  }
  offenAnzahl = offen.length
  return offen
}

const allesNachholen = async ($: EngineInterface): Promise<string> => {
  const andere = await offeneJournale($)
  return hochladen($, [...(journal !== null ? [journal] : []), ...andere])
}

// ---------------------------------------------------------------------------
// Monatssumme vom Server

const zeigeVerbindung = async ($: EngineInterface): Promise<void> => {
  const token = await leseToken($)
  const ws = await $.store.get(K_WORKSPACE)
  const neu: Verbindung = { verbunden: token !== null, workspace: typeof ws === 'string' ? ws : null }
  const alt = await read($, verbindung)
  if (alt.verbunden !== neu.verbunden || alt.workspace !== neu.workspace) await update($, verbindung, () => neu)
}

const ladeStats = async ($: EngineInterface, erzwingen = false): Promise<void> => {
  if (laedtStats) return
  const now = await $.clock.now()
  if (!erzwingen && now - statsZuletzt < STATS_ABSTAND_MS) return
  laedtStats = true
  statsZuletzt = now
  try {
    const token = await leseToken($)
    if (token === null) return
    const antwort = await $.http.fetch(statsUrl(await ingestAdresse($)), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: await $.session.id() }),
    })
    if (!antwort.ok) return
    const parsed = parseStats(antwort.text)
    if (parsed === null) return
    await update($, stats, () => parsed)
    await $.store.set(K_STATS, antwort.text)
  } catch {
    // Server nicht erreichbar: letzter Stand bleibt stehen
  } finally {
    laedtStats = false
  }
}

// ---------------------------------------------------------------------------
// Geräte-Login

const pollen = ($: EngineInterface, basis: string, deviceCode: string, intervalSek: number, bis: number, lauf: { abgebrochen: boolean }): void => {
  $.clock.after(intervalSek * 1000, async () => {
    if (lauf.abgebrochen) return
    if ((await $.clock.now()) > bis) {
      login = null
      $.ui.toast('AICosts: Code abgelaufen – bitte /aicosts login erneut ausführen.')
      return
    }
    let naechstes = intervalSek
    try {
      const antwort = await $.http.fetch(devicePollUrl(basis), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      })
      const ergebnis = parseDevicePoll(antwort.status, antwort.text)
      if (ergebnis.status === 'approved') {
        login = null
        await $.store.set(K_TOKEN, ergebnis.token)
        if (ergebnis.workspace !== null) await $.store.set(K_WORKSPACE, ergebnis.workspace)
        else await $.store.delete(K_WORKSPACE)
        if (ergebnis.ingestUrl !== null) await $.store.set(K_INGEST, ergebnis.ingestUrl)
        else await $.store.delete(K_INGEST)
        await setzeFehler($, null)
        await zeigeVerbindung($)
        $.ui.toast(`AICosts verbunden${ergebnis.workspace !== null ? `: ${ergebnis.workspace}` : ''}`)
        void allesNachholen($).then(() => ladeStats($, true))
        return
      }
      if (ergebnis.status === 'expired' || ergebnis.status === 'denied') {
        login = null
        $.ui.toast(ergebnis.status === 'denied' ? 'AICosts: Verbindung im Dashboard abgelehnt.' : 'AICosts: Code abgelaufen – bitte /aicosts login erneut ausführen.')
        return
      }
      if (ergebnis.status === 'verbraucht') {
        login = null
        $.ui.toast('AICosts: Code ist schon verwendet oder unbekannt – bitte /aicosts login erneut ausführen.')
        return
      }
      if (ergebnis.status === 'slow_down') naechstes = intervalSek + 5
    } catch {
      // Netzwerkfehler: einfach weiter versuchen, bis der Code abläuft
    }
    pollen($, basis, deviceCode, naechstes, bis, lauf)
  })
}

// Rechnername für die Token-Bezeichnung im Dashboard: macOS-Computername, sonst Windows/Unix-Variablen
const rechnerName = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const mac = await $.process.run(['scutil', '--get', 'ComputerName'], { timeoutMs: 2000 })
    const name = mac.stdout.trim()
    if (mac.exitCode === 0 && name !== '') return name
  } catch {
    // kein macOS oder Prozessstart nicht erlaubt
  }
  return (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME'))
}

const starteLogin = async ($: EngineInterface): Promise<string> => {
  if (login !== null) login.abgebrochen = true
  const basis = basisUrl(await $.store.get(K_BASIS))
  const geraet = await rechnerName($)
  let antwort
  try {
    antwort = await $.http.fetch(deviceStartUrl(basis), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'aicosts-plugin', version: VERSION, ...(geraet ? { geraet: geraet.slice(0, 100) } : {}) }),
    })
  } catch {
    return 'AICosts-Server nicht erreichbar. Bitte Internetverbindung prüfen und erneut versuchen.'
  }
  if (antwort.status === 429) return 'Zu viele Anmeldeversuche. Bitte in einigen Minuten erneut versuchen.'
  const start = antwort.ok ? parseDeviceStart(antwort.text) : null
  if (start === null) return `Anmeldung konnte nicht gestartet werden (${fehlerText(antwort.status, antwort.text)}).`
  const lauf = { abgebrochen: false }
  login = lauf
  const bis = (await $.clock.now()) + start.expires_in * 1000
  pollen($, basis, start.device_code, start.interval, bis, lauf)
  const kopiert = await $.ui.copy({ text: start.verification_url }).catch(() => ({ isCopied: false as const }))
  return [
    'AICosts mit diesem Rechner verbinden:',
    `  1. Link öffnen: ${start.verification_url}${kopiert.isCopied ? '  (in die Zwischenablage kopiert)' : ''}`,
    `  2. Code prüfen: ${start.user_code}`,
    '  3. Workspace wählen und „Gerät verbinden“ klicken.',
    `Der Code gilt ${Math.round(start.expires_in / 60)} Minuten. Sobald du bestätigst, erscheint hier eine Meldung.`,
  ].join('\n')
}

const statusText = async ($: EngineInterface): Promise<string> => {
  const token = await leseToken($)
  const ws = await $.store.get(K_WORKSPACE)
  const upload = (await $.store.get(K_LETZTER_UPLOAD)) as { zeit?: number; sessions?: number } | undefined
  const fehler = (await $.store.get(K_LETZTER_FEHLER)) as { zeit?: number; text?: string } | undefined
  const basisOverride = await $.store.get(K_BASIS)
  const j = await aktuellesJournal($).catch(() => null)
  await offeneJournale($).catch(() => [])
  const offenGesamt = offenAnzahl + (j !== null && j.dirty && !istLeer(j) ? 1 : 0)
  return [
    `AICosts-Plugin ${VERSION}`,
    token !== null
      ? `Verbunden: ja${typeof ws === 'string' ? ` (Workspace „${ws}“)` : ''}`
      : 'Verbunden: nein – /aicosts login',
    `Letzter Upload: ${typeof upload?.zeit === 'number' ? `${zeitText(upload.zeit)} (${upload.sessions ?? 0} Session(s))` : '–'}`,
    `Offene Uploads: ${offenGesamt}`,
    `Letzter Fehler: ${typeof fehler?.text === 'string' ? `${fehler.text}${typeof fehler.zeit === 'number' ? ` (${zeitText(fehler.zeit)})` : ''}` : '–'}`,
    ...(j !== null ? [`Diese Session: ${j.vollstaendig ? 'vollständig erfasst' : 'erst seit Plugin-Start erfasst (Teil-Erfassung)'}`] : []),
    ...(istErlaubteUrl(basisOverride) ? [`Server: ${basisOverride}`] : []),
    'Befehle: /aicosts login | status | sync | logout',
  ].join('\n')
}

const logout = async ($: EngineInterface): Promise<string> => {
  if (login !== null) login.abgebrochen = true
  login = null
  const hatte = (await leseToken($)) !== null
  await $.store.delete(K_TOKEN)
  await $.store.delete(K_WORKSPACE)
  await $.store.delete(K_INGEST)
  await $.store.delete(K_STATS)
  await zeigeVerbindung($)
  await update($, stats, () => null)
  return [
    hatte ? 'Abgemeldet: Der Token wurde auf diesem Rechner gelöscht.' : 'Es war kein Token gespeichert.',
    'Der Token kann zusätzlich im Dashboard unter Einstellungen → Ingest-Tokens widerrufen werden.',
    'Die Erfassung läuft lokal weiter; nach /aicosts login wird nachgeladen.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Keep-Alive

const ping = async ($: EngineInterface): Promise<string> => {
  if (isPinging) return 'Ping läuft bereits.'
  isPinging = true
  try {
    const reply = await $.model.fork({ prompt: PING_PROMPT })
    const now = await $.clock.now()
    const cacheReadTokens = reply.isAnswered ? reply.usage.cache_read_input_tokens : 0
    const note = reply.isAnswered ? `Cache gelesen: ${formatTokens(cacheReadTokens)} Token` : `kein Ping: ${reply.reason}`
    await update($, cache, c => ({
      ...c,
      // Nur ein Treffer im Cache verlängert die Lebensdauer
      lastActivityAt: reply.isAnswered && cacheReadTokens > 0 ? now : c.lastActivityAt,
      pings: c.pings + 1,
      lastPing: { at: now, isOk: reply.isAnswered && cacheReadTokens > 0, cacheReadTokens, note },
    }))
    // Auch Pings kosten Token: als Nutzung des Hauptstrangs verbuchen
    if ('usage' in reply && reply.usage !== undefined) {
      const usage = reply.usage
      const ttl = (await read($, settings)).ttlMinutes
      await mitJournal($, j => {
        if (j.letztesModell === null) return
        verbucheAntwort(j, { usage: { ...usage, model: j.letztesModell }, durationMs: 0, ende: now, cacheTtlMinuten: ttl, nurNutzung: true })
      })
    }
    return note
  } finally {
    isPinging = false
  }
}

const cacheStatusText = async ($: EngineInterface): Promise<string> => {
  const s = await read($, settings)
  const c = await read($, cache)
  const rest = remainingMs(c, s, await $.clock.now())
  const restText = c.isRunning ? 'aktiv (Turn läuft)' : rest === null ? 'noch keine Aktivität' : rest <= 0 ? 'abgelaufen' : formatRemaining(rest)
  return [
    `Cache-Restzeit: ${restText} (TTL ${s.ttlMinutes} Min, Annahme)`,
    `Keep-Alive: ${s.keepAlive ? 'an' : 'aus'}, Pings ${c.pings}/${s.maxPings} seit letzter Eingabe`,
    `Letzter Ping: ${c.lastPing ? c.lastPing.note : '–'}`,
    'Befehle: /cache an | aus | ttl 5 | ttl 60 | max <0-24> | ping | status',
  ].join('\n')
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const stored = (await $.store.get(K_SETTINGS)) as Partial<CacheSettings> | undefined
      const storedVersion = (await $.store.get(K_SETTINGS_VERSION)) as number | undefined
      const migrated = migrateSettings(stored, storedVersion)
      await update($, settings, () => migrated)
      if (stored !== undefined && storedVersion !== SETTINGS_VERSION) {
        await $.store.set(K_SETTINGS, migrated)
        await $.store.set(K_SETTINGS_VERSION, SETTINGS_VERSION)
      }

      await $.command.register({ name: 'cache', description: 'Cache-Restzeit und Keep-Alive: an | aus | ttl 5|60 | max N | ping | status' })
      await $.command.register({ name: 'aicosts', description: 'AICosts: login | status | sync | logout', argumentHint: '[login|status|sync|logout]' })

      // Takt: Countdown neu zeichnen und kurz vor Ablauf im Leerlauf pingen
      $.clock.every(TICK_MS, async () => {
        await update($, tick, n => n + 1)
        const s = await read($, settings)
        const c = await read($, cache)
        if (shouldPing(c, s, await $.clock.now())) await ping($).catch(() => undefined)
      })

      // Letzter Stand der Monatssumme sofort zeigen, danach frisch holen
      await zeigeVerbindung($)
      const gespeichert = await $.store.get(K_STATS)
      const alt = typeof gespeichert === 'string' ? parseStats(gespeichert) : null
      if (alt !== null) await update($, stats, () => alt)

      // Journal laden (Resume/Reload) und Kostenstand abgleichen (erkennt neuen Prozess)
      const { cost } = await $.session.usage()
      await mitJournal($, j => verbucheKosten(j, cost?.usd))

      $.clock.after(1_500, () => void ladeStats($, true))
      $.clock.after(NACHHOLEN_NACH_MS, () => void allesNachholen($))
    } catch {
      // Start darf nie scheitern
    }
    return next(e)
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const parsed = parseCacheArgs(e.args, await read($, settings))
    if (parsed === null) return { text: `Unbekannt: "${e.args}".\n${await cacheStatusText($)}` }
    if (parsed.action === 'ping') return { text: `Ping: ${await ping($)}` }
    if (parsed.action === 'set') {
      await update($, settings, () => parsed.settings)
      await $.store.set(K_SETTINGS, parsed.settings)
      await $.store.set(K_SETTINGS_VERSION, SETTINGS_VERSION)
    }
    return { text: await cacheStatusText($) }
  })

  on('command.run', { command: 'aicosts' }, async ($, e) => {
    const [wort = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (wort === 'login') return { text: await starteLogin($) }
    if (wort === 'logout') return { text: await logout($) }
    if (wort === 'sync') {
      const text = await allesNachholen($)
      void ladeStats($, true)
      return { text }
    }
    if (wort === '' || wort === 'status') return { text: await statusText($) }
    return { text: `Unbekannt: "${e.args}".\nBefehle: /aicosts login | status | sync | logout` }
  })

  // Eigene Eingabe (Tastatur oder Handy): Ping-Zähler zurücksetzen, Wartezeit verbuchen
  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
        await update($, cache, c => ({ ...c, pings: 0 }))
        if (e.turnId === undefined) {
          const now = await $.clock.now()
          await mitJournal($, j => verbucheEingabe(j, now))
        }
      }
    } catch {
      // nie die Eingabe blockieren
    }
    return next(e)
  })

  // Nur die Haupt-Session löst turn.start aus
  on('turn.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, cache, c => ({ ...c, isRunning: true, lastActivityAt: now }))
      await mitJournal($, j => verbucheTurnStart(j))
    } catch {
      // ignorieren
    }
    return next(e)
  })

  // Jede Antwort (Hauptstrang und Subagenten) wird verbucht
  on('turn.complete', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      const ttl = (await read($, settings)).ttlMinutes
      const istMain = e.agentId === undefined
      const { context, cost } = await $.session.usage()
      const turns = istMain ? await $.session.turns().catch(() => 0) : 0
      await mitJournal($, j => {
        if (e.usage !== undefined) {
          verbucheAntwort(j, {
            ...(istMain ? {} : { agentId: e.agentId }),
            usage: e.usage,
            durationMs: e.durationMs,
            ende: now,
            cacheTtlMinuten: ttl,
          })
        }
        verbucheKosten(j, cost?.usd)
        if (istMain) {
          verbucheKontext(j, context.tokens, context.window)
          verbucheTurns(j, turns)
        }
      })
      if (istMain) {
        await update($, cache, c => ({ ...c, isRunning: false, lastActivityAt: now }))
        void ladeStats($)
      }
      planeUpload($)
    } catch {
      // ignorieren
    }
    return next(e)
  })

  // Ende: Upload nur anstoßen (Budget 1,5 s), nicht abwarten; Fehlschläge holt der nächste Start nach
  on('session.end', async ($, e, next) => {
    try {
      uploadTimer?.cancel()
      uploadTimer = null
      const j = journal
      if (j !== null && j.session_id === e.sessionId) {
        void hochladen($, [j])
        journal = null
      }
    } catch {
      // ignorieren
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { context, cost } = await $.session.usage()
    const percent = Math.round(context.percent ?? 0)
    const tokens = context.tokens ?? 0
    const hint = handoffHint(percent)
    // Lesen abonniert den Takt, damit der Countdown sich neu zeichnet
    await read($, tick)
    const cacheInfo = cacheLabel(await read($, cache), await read($, settings), await $.clock.now())
    const sum = await read($, summeAtom)
    const verb = await read($, verbindung)
    const monat = await read($, stats)

    const { Box, Text } = $.ui.resolve(e)
    const cacheProps = cacheInfo.color === 'dim' ? { dimColor: true } : { color: cacheInfo.color }
    const monatsSegment = !verb.verbunden
      ? [{ key: 'monat', text: 'nicht verbunden · /aicosts login', props: { dimColor: true } }]
      : monat === null
        ? []
        : [
            {
              key: 'monat',
              text: `${monatKurz(monat.monat)} ${formatTokens(monat.gesamt.tokens)} Token · $${monat.gesamt.kostenUsd.toFixed(2)}`,
              props: { dimColor: true },
            },
          ]

    // Jedes Segment bricht nur als Ganzes um; der Trenner hängt fest am folgenden Segment
    const segments = [
      { key: 'kontext', text: `Kontext ${formatTokens(tokens)} / ${formatTokens(context.window)}`, props: { dimColor: true } },
      { key: 'session', text: `Session ${formatTokens(sum.tokens)} Token (Out ${formatTokens(sum.outputTokens)})`, props: { dimColor: true } },
      { key: 'kosten', text: `$${(cost?.usd ?? 0).toFixed(2)}`, props: { dimColor: true } },
      ...monatsSegment,
      { key: 'cache', text: cacheInfo.text, props: cacheProps },
      { key: 'hinweis', text: hint.text, props: { color: hint.color } },
    ]

    return (
      <Box flexWrap="wrap" columnGap={2}>
        <Text key="balken" color={hint.color} bold wrap="truncate-end">
          {formatBar(percent)} {percent} %
        </Text>
        {segments.map(({ key, text, props }, index) => (
          <Text key={key} wrap="truncate-end">
            {index > 0 && <Text dimColor>·{NBSP}</Text>}
            <Text {...props}>{noBreak(text)}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
