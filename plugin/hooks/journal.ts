// Journal je Session: kleine Aggregate aus den Plugin-Ereignissen, übersteht Neustarts und Resume.
// DATENSCHUTZ: nur Kennzahlen (Token, Zeiten, Modell, Pfad/Repo) – niemals Prompt- oder Antworttext.

import { kostenUsd, preisstufeFuer } from './preise'

export const JOURNAL_VERSION = 1 as const
export const STRANG_MAIN = 'main'
export const STUNDE_MS = 3_600_000
/** Mehr Subagenten je Session werden im Strang „weitere“ zusammengefasst (Server erlaubt 200) */
export const MAX_AGENTS = 199
export const STRANG_WEITERE = 'agents-weitere'
/** Server erlaubt 5.000 Eingriffe je Session; ältere fallen heraus */
export const MAX_EINGRIFFE = 5_000

/** Token einer Nutzungszeile (Strang × Modell × Preisstufe) */
export interface NutzungsEintrag {
  strang: string
  modell: string
  preisstufe: string
  anfragen: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_5m_tokens: number
  cache_write_1h_tokens: number
}

/** [Input, Output, Cache gelesen, Cache geschrieben, USD-Gewicht] einer UTC-Stunde */
export type StundenWert = [number, number, number, number, number]

/** ['e' = Eingabe | 'a' = Agent, Start ms, Ende ms] */
export type EingriffsSpanne = ['e' | 'a', number, number]

export interface EngineTokens {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export interface Journal {
  v: typeof JOURNAL_VERSION
  session_id: string
  /** true, wenn das Plugin die Session vom ersten Turn an gesehen hat */
  vollstaendig: boolean
  gestartet: number
  /** letzte Aktivität (Ende der letzten Antwort) */
  beendet: number | null
  cwd: string | null
  git_repo: string | null
  git_root: string | null
  git_branch: string | null
  /** Antworten je Modell im Hauptstrang */
  modelle: Record<string, number>
  /** Schlüssel `strang|modell|preisstufe` */
  nutzung: Record<string, NutzungsEintrag>
  agents: Record<string, { modelle: Record<string, number>; turns: number }>
  /** Schlüssel: Stundenbeginn in ms (UTC) */
  stunden: Record<string, StundenWert>
  eingriffe: EingriffsSpanne[]
  /** Ende der letzten Antwort im Hauptstrang, solange noch keine neue Eingabe kam */
  letzteAntwortEnde: number | null
  kontextMax: number | null
  kontextFenster: number | null
  /** Engine-Kosten: Summe abgeschlossener Prozess-Abschnitte + letzter Stand des laufenden */
  kosten: { basis: number; letzter: number } | null
  engine: EngineTokens
  /** echte Nutzereingaben laut Claude Code */
  turns: number
  /** zuletzt verwendetes Modell im Hauptstrang (für Keep-Alive-Pings) */
  letztesModell: string | null
  /** zählt jede Änderung; ein Upload räumt `dirty` nur, wenn sich seitdem nichts geändert hat */
  rev: number
  dirty: boolean
  letzterUpload: number | null
}

export const neuesJournal = (sessionId: string, gestartet: number, vollstaendig: boolean): Journal => ({
  v: JOURNAL_VERSION,
  session_id: sessionId,
  vollstaendig,
  gestartet,
  beendet: null,
  cwd: null,
  git_repo: null,
  git_root: null,
  git_branch: null,
  modelle: {},
  nutzung: {},
  agents: {},
  stunden: {},
  eingriffe: [],
  letzteAntwortEnde: null,
  kontextMax: null,
  kontextFenster: null,
  kosten: null,
  engine: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  turns: 0,
  letztesModell: null,
  rev: 0,
  dirty: false,
  letzterUpload: null,
})

const istObjekt = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Liest ein Journal robust: unbekannte Version, fremde Session-ID oder kaputtes JSON → null
 * (der Aufrufer legt dann ein neues, als unvollständig markiertes Journal an).
 */
export const leseJournal = (text: string, sessionId: string): Journal | null => {
  let daten: unknown
  try {
    daten = JSON.parse(text)
  } catch {
    return null
  }
  if (!istObjekt(daten) || daten.v !== JOURNAL_VERSION || daten.session_id !== sessionId) return null
  const pflicht = ['modelle', 'nutzung', 'agents', 'stunden', 'engine']
  if (pflicht.some(k => !istObjekt(daten[k])) || !Array.isArray(daten.eingriffe)) return null
  if (typeof daten.gestartet !== 'number') return null
  return { ...neuesJournal(sessionId, daten.gestartet, false), ...(daten as Partial<Journal>) } as Journal
}

const zahl = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/** Agent-ID stabil und gültig machen (^[A-Za-z0-9._:-]{1,200}$, nicht 'main') */
export const agentIdBereinigen = (roh: string): string => {
  const id = roh.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 190) || 'agent'
  return id === STRANG_MAIN ? 'agent-main' : id
}

const aendere = (j: Journal): void => {
  j.rev += 1
  j.dirty = true
}

/** Usage einer Antwort wie `turn.complete` sie liefert */
export interface AntwortUsage {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export interface Antwort {
  /** Subagent; fehlt im Hauptstrang */
  agentId?: string
  usage: AntwortUsage
  /** Antwortdauer in ms */
  durationMs: number
  /** Zeitpunkt des Antwortendes (ms) */
  ende: number
  /** Cache-TTL des Hauptstrangs laut Einstellung; ≥ 30 Min → Cache-Schreiben zählt als 1 h */
  cacheTtlMinuten: number
  /** Keep-Alive-Ping: nur Token zählen, keine Antwort im Sinne von Eingriffen/Modellwahl */
  nurNutzung?: boolean
}

/**
 * Verbucht eine Antwort. Preisstufe aus der Summe der Antwort (Näherung, siehe preise.ts).
 * Cache-Schreiben: Hauptstrang nach eingestellter TTL (Claude Code nutzt dort 1 h),
 * Subagenten als 5 Minuten (so in den Transkripten beobachtet).
 */
export const verbucheAntwort = (j: Journal, a: Antwort): void => {
  const u = a.usage
  const modell = (u.model || 'unbekannt').slice(0, 100)
  const input = zahl(u.input_tokens)
  const output = zahl(u.output_tokens)
  const cacheRead = zahl(u.cache_read_input_tokens)
  const cacheWrite = zahl(u.cache_creation_input_tokens)
  const istMain = a.agentId === undefined
  let strang = STRANG_MAIN
  if (!istMain) {
    strang = agentIdBereinigen(a.agentId ?? '')
    if (j.agents[strang] === undefined && Object.keys(j.agents).length >= MAX_AGENTS) strang = STRANG_WEITERE
  }
  const stufe = preisstufeFuer(modell, input + cacheRead + cacheWrite)
  const lang = istMain && a.cacheTtlMinuten >= 30
  const schluessel = `${strang}|${modell}|${stufe}`
  const n = (j.nutzung[schluessel] ??= {
    strang,
    modell,
    preisstufe: stufe,
    anfragen: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
  })
  n.anfragen += 1
  n.input_tokens += input
  n.output_tokens += output
  n.cache_read_tokens += cacheRead
  if (lang) n.cache_write_1h_tokens += cacheWrite
  else n.cache_write_5m_tokens += cacheWrite

  if (istMain && a.nurNutzung === true) {
    // Ping: weder Agent-Zeit noch Wartezeit-Ende
  } else if (istMain) {
    j.modelle[modell] = (j.modelle[modell] ?? 0) + 1
    j.letztesModell = modell
    const dauer = zahl(a.durationMs)
    if (dauer > 0) j.eingriffe.push(['a', a.ende - dauer, a.ende])
    j.letzteAntwortEnde = a.ende
  } else {
    const agent = (j.agents[strang] ??= { modelle: {}, turns: 0 })
    agent.modelle[modell] = (agent.modelle[modell] ?? 0) + 1
    agent.turns += 1
  }

  if (input + output + cacheRead + cacheWrite > 0) {
    const stunde = String(Math.floor(a.ende / STUNDE_MS) * STUNDE_MS)
    const s = (j.stunden[stunde] ??= [0, 0, 0, 0, 0])
    s[0] += input
    s[1] += output
    s[2] += cacheRead
    s[3] += cacheWrite
    s[4] +=
      kostenUsd(modell, stufe, {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_5m_tokens: lang ? 0 : cacheWrite,
        cache_write_1h_tokens: lang ? cacheWrite : 0,
      }) ?? 0
  }

  j.engine.input += input
  j.engine.output += output
  j.engine.cache_read += cacheRead
  j.engine.cache_write += cacheWrite
  j.beendet = Math.max(j.beendet ?? a.ende, a.ende)
  kuerzeEingriffe(j)
  aendere(j)
}

const kuerzeEingriffe = (j: Journal): void => {
  if (j.eingriffe.length > MAX_EINGRIFFE) j.eingriffe.splice(0, j.eingriffe.length - MAX_EINGRIFFE)
}

/**
 * Echte Eingabe (Tastatur oder Handy): Spanne vom Ende der letzten Antwort bis jetzt.
 * Nur wenn seit dieser Antwort kein neuer Turn begonnen hat (sonst arbeitete der Agent).
 */
export const verbucheEingabe = (j: Journal, zeit: number): void => {
  if (j.letzteAntwortEnde !== null && zeit > j.letzteAntwortEnde) {
    j.eingriffe.push(['e', j.letzteAntwortEnde, zeit])
    kuerzeEingriffe(j)
    aendere(j)
  }
  j.letzteAntwortEnde = null
}

/** Ein Turn beginnt (auch ohne echte Eingabe, z. B. Benachrichtigung): die Wartezeit ist vorbei */
export const verbucheTurnStart = (j: Journal): void => {
  j.letzteAntwortEnde = null
}

/**
 * Kostenstand laut Engine ($.session.usage().cost.usd). Fällt der Zähler (neuer Prozess ohne
 * übernommenen Stand), wird der alte Stand als abgeschlossener Abschnitt aufaddiert.
 */
export const verbucheKosten = (j: Journal, usd: number | undefined): void => {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return
  if (j.kosten === null) j.kosten = { basis: 0, letzter: usd }
  else if (usd < j.kosten.letzter - 1e-9) j.kosten = { basis: j.kosten.basis + j.kosten.letzter, letzter: usd }
  else if (usd === j.kosten.letzter) return
  else j.kosten.letzter = usd
  aendere(j)
}

export const engineKosten = (j: Journal): number | null =>
  j.kosten === null ? null : Math.round((j.kosten.basis + j.kosten.letzter) * 1e6) / 1e6

/** Kontext der letzten Antwort im Hauptstrang (Input gesamt) und Fenstergröße */
export const verbucheKontext = (j: Journal, tokens: number | undefined, fenster: number | undefined): void => {
  let geaendert = false
  if (typeof tokens === 'number' && tokens > 0 && (j.kontextMax === null || tokens > j.kontextMax)) {
    j.kontextMax = Math.round(tokens)
    geaendert = true
  }
  if (typeof fenster === 'number' && Number.isInteger(fenster) && fenster > 0 && fenster !== j.kontextFenster) {
    j.kontextFenster = fenster
    geaendert = true
  }
  if (geaendert) aendere(j)
}

export const verbucheTurns = (j: Journal, turns: number): void => {
  if (Number.isInteger(turns) && turns > j.turns) {
    j.turns = turns
    aendere(j)
  }
}

/** Session-Summe für das Band: alle Stränge */
export const summe = (j: Journal): { tokens: number; outputTokens: number } => {
  let tokens = 0
  let outputTokens = 0
  for (const n of Object.values(j.nutzung)) {
    tokens += n.input_tokens + n.output_tokens + n.cache_read_tokens + n.cache_write_5m_tokens + n.cache_write_1h_tokens
    outputTokens += n.output_tokens
  }
  return { tokens, outputTokens }
}

/** Nach erfolgreichem Upload: `dirty` nur räumen, wenn sich seit dem Bau der Payload nichts geändert hat */
export const markiereHochgeladen = (j: Journal, rev: number, zeit: number): void => {
  j.letzterUpload = zeit
  if (j.rev === rev) j.dirty = false
}
