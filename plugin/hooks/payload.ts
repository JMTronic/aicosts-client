// Upload-Vertrag (Payload schema_version 2) und Bau aus dem Journal.
// Gleiche Felder und Grenzen wie die Edge Function `ingest`; Plugin-Ergänzungen: quelle, plugin_vollstaendig.
// DATENSCHUTZ: nur Kennzahlen, kein Prompt-/Antworttext, kein Titel.

import { engineKosten, STRANG_MAIN, STUNDE_MS, type Journal } from './journal'

export const PAYLOAD_SCHEMA_VERSION = 2 as const

/** Grenzen, die der Server streng prüft */
export const INGEST_LIMITS = {
  maxBodyBytes: 5_000_000,
  maxSessions: 500,
  maxAgentsProSession: 200,
  maxNutzungProSession: 1_000,
  maxEingriffeProSession: 5_000,
  maxStundenProSession: 2_000,
} as const

export const ID_MUSTER = /^[A-Za-z0-9._:-]{1,200}$/

export interface IngestNutzung {
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

export interface IngestAgent {
  agent_id: string
  modell: string | null
  turns: number
}

export interface IngestEingriff {
  art: 'eingabe' | 'agent'
  start: string
  ende: string
  anteil: number
}

export interface IngestStunde {
  stunde: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  kosten_usd: number
}

export interface IngestSession {
  session_id: string
  modell: string | null
  effort: string | null
  cwd: string | null
  git_repo: string | null
  git_root: string | null
  git_branch: string | null
  kontext_max_tokens: number | null
  turns: number
  parser_version: string
  gestartet_am: string
  beendet_am: string | null
  kosten_engine_usd: number | null
  kontext_fenster_tokens: number | null
  engine_input_tokens: number
  engine_output_tokens: number
  engine_cache_read_tokens: number
  engine_cache_write_tokens: number
  stunden: IngestStunde[]
  nutzung: IngestNutzung[]
  agents: IngestAgent[]
  eingriffe: IngestEingriff[]
  quelle: 'plugin'
  plugin_vollstaendig: boolean
}

export interface IngestPayload {
  schema_version: typeof PAYLOAD_SCHEMA_VERSION
  sessions: IngestSession[]
}

/** Häufigster Schlüssel (bei Gleichstand alphabetisch erster) */
export const haeufigster = (r: Record<string, number>): string | null => {
  let best: string | null = null
  let n = -1
  for (const [k, v] of Object.entries(r).sort(([a], [b]) => a.localeCompare(b))) {
    if (v > n) {
      best = k
      n = v
    }
  }
  return best
}

const iso = (ms: number): string => new Date(ms).toISOString()
const TAG_MS = 24 * STUNDE_MS

/** Stunden-Buckets; mehr als erlaubt → Zusammenfassung zu UTC-Tagen */
const baueStunden = (j: Journal): IngestStunde[] => {
  const zusammen = (raster: number, quelle: [number, number[]][]): [number, number[]][] => {
    const map = new Map<number, number[]>()
    for (const [t, w] of quelle) {
      const k = Math.floor(t / raster) * raster
      const s = map.get(k) ?? [0, 0, 0, 0, 0]
      w.forEach((x, i) => (s[i] = (s[i] ?? 0) + x))
      map.set(k, s)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }
  let reihe = zusammen(
    STUNDE_MS,
    Object.entries(j.stunden).map(([k, w]): [number, number[]] => [Number(k), [...w]]),
  )
  if (reihe.length > INGEST_LIMITS.maxStundenProSession) reihe = zusammen(TAG_MS, reihe)
  return reihe.slice(-INGEST_LIMITS.maxStundenProSession).map(([t, w]) => ({
    stunde: iso(t),
    input_tokens: w[0] ?? 0,
    output_tokens: w[1] ?? 0,
    cache_read_tokens: w[2] ?? 0,
    cache_write_tokens: w[3] ?? 0,
    kosten_usd: Math.round((w[4] ?? 0) * 1e6) / 1e6,
  }))
}

/** true, wenn die Session noch nichts enthält (kein Token, kein Engine-Wert) → wird nicht hochgeladen */
export const istLeer = (j: Journal): boolean =>
  Object.keys(j.nutzung).length === 0 && (engineKosten(j) ?? 0) === 0

/** Baut eine Payload-Session aus dem Journal */
export const baueSession = (j: Journal, parserVersion: string): IngestSession => {
  const nutzung: IngestNutzung[] = Object.values(j.nutzung)
    .map(n => ({ ...n }))
    .sort((a, b) => `${a.strang}|${a.modell}|${a.preisstufe}`.localeCompare(`${b.strang}|${b.modell}|${b.preisstufe}`))
  const strangIds = new Set(nutzung.map(n => n.strang).filter(s => s !== STRANG_MAIN))
  const agents: IngestAgent[] = [...strangIds].sort().map(id => {
    const a = j.agents[id]
    return { agent_id: id, modell: a ? haeufigster(a.modelle) : null, turns: a?.turns ?? 0 }
  })
  const eingriffe: IngestEingriff[] = j.eingriffe
    .filter(([, s, e]) => e > s)
    .map(([art, s, e]) => ({ art: art === 'e' ? ('eingabe' as const) : ('agent' as const), start: iso(s), ende: iso(e), anteil: 1 }))
    .sort((a, b) => a.start.localeCompare(b.start) || a.art.localeCompare(b.art))
  return {
    session_id: j.session_id,
    modell: haeufigster(j.modelle),
    effort: null,
    cwd: j.cwd,
    git_repo: j.git_repo,
    git_root: j.git_root,
    git_branch: j.git_branch,
    kontext_max_tokens: j.kontextMax,
    turns: j.turns,
    parser_version: parserVersion,
    gestartet_am: iso(j.gestartet),
    beendet_am: iso(Math.max(j.beendet ?? j.gestartet, j.gestartet)),
    kosten_engine_usd: engineKosten(j),
    kontext_fenster_tokens: j.kontextFenster,
    engine_input_tokens: j.engine.input,
    engine_output_tokens: j.engine.output,
    engine_cache_read_tokens: j.engine.cache_read,
    engine_cache_write_tokens: j.engine.cache_write,
    stunden: baueStunden(j),
    nutzung,
    agents,
    eingriffe,
    quelle: 'plugin',
    plugin_vollstaendig: j.vollstaendig,
  }
}

const ganzzahl = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0
const istIso = (v: unknown): boolean => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /[zZ]|[+-]\d\d:\d\d$/.test(v)

/** Prüft eine Session gegen die Server-Regeln; Rückgabe: Fehlermeldungen (leer = gültig) */
export const pruefeSession = (s: IngestSession): string[] => {
  const f: string[] = []
  if (!ID_MUSTER.test(s.session_id)) f.push('session_id ungültig')
  if (!istIso(s.gestartet_am)) f.push('gestartet_am ungültig')
  if (s.beendet_am !== null && !istIso(s.beendet_am)) f.push('beendet_am ungültig')
  if (!ganzzahl(s.turns)) f.push('turns ungültig')
  if (s.kosten_engine_usd !== null && !(Number.isFinite(s.kosten_engine_usd) && s.kosten_engine_usd >= 0)) f.push('kosten_engine_usd ungültig')
  if (s.kontext_fenster_tokens !== null && !(ganzzahl(s.kontext_fenster_tokens) && s.kontext_fenster_tokens >= 1 && s.kontext_fenster_tokens <= 100_000_000)) {
    f.push('kontext_fenster_tokens ungültig')
  }
  for (const k of ['engine_input_tokens', 'engine_output_tokens', 'engine_cache_read_tokens', 'engine_cache_write_tokens'] as const) {
    if (!ganzzahl(s[k])) f.push(`${k} ungültig`)
  }
  if (s.agents.length > INGEST_LIMITS.maxAgentsProSession) f.push('zu viele agents')
  if (s.nutzung.length > INGEST_LIMITS.maxNutzungProSession) f.push('zu viele nutzung-Zeilen')
  if (s.eingriffe.length > INGEST_LIMITS.maxEingriffeProSession) f.push('zu viele eingriffe')
  if (s.stunden.length > INGEST_LIMITS.maxStundenProSession) f.push('zu viele stunden')
  const agentIds = new Set<string>()
  for (const a of s.agents) {
    if (!ID_MUSTER.test(a.agent_id) || a.agent_id === STRANG_MAIN) f.push(`agent_id ungültig: ${a.agent_id}`)
    if (agentIds.has(a.agent_id)) f.push(`agent_id doppelt: ${a.agent_id}`)
    agentIds.add(a.agent_id)
    if (!ganzzahl(a.turns)) f.push('agent turns ungültig')
  }
  const kombis = new Set<string>()
  for (const n of s.nutzung) {
    if (n.strang !== STRANG_MAIN && !agentIds.has(n.strang)) f.push(`strang unbekannt: ${n.strang}`)
    const k = `${n.strang}|${n.modell}|${n.preisstufe}`
    if (kombis.has(k)) f.push(`nutzung doppelt: ${k}`)
    kombis.add(k)
    if (n.modell.length === 0 || n.modell.length > 100) f.push('modell ungültig')
    for (const z of [n.anfragen, n.input_tokens, n.output_tokens, n.cache_read_tokens, n.cache_write_5m_tokens, n.cache_write_1h_tokens]) {
      if (!ganzzahl(z)) f.push(`nutzung-Zahl ungültig: ${k}`)
    }
  }
  for (const e of s.eingriffe) {
    if (!istIso(e.start) || !istIso(e.ende) || Date.parse(e.ende) < Date.parse(e.start)) f.push('eingriff-Zeit ungültig')
    if (!(e.anteil > 0 && e.anteil <= 1)) f.push('eingriff-Anteil ungültig')
  }
  const stunden = new Set<string>()
  for (const h of s.stunden) {
    if (!istIso(h.stunde) || Date.parse(h.stunde) % STUNDE_MS !== 0) f.push('stunde ungültig')
    if (stunden.has(h.stunde)) f.push('stunde doppelt')
    stunden.add(h.stunde)
    if (!(Number.isFinite(h.kosten_usd) && h.kosten_usd >= 0)) f.push('stunde kosten ungültig')
  }
  return f
}

/** Prüft die ganze Payload inkl. Größe */
export const pruefePayload = (p: IngestPayload): string[] => {
  const f: string[] = []
  if (p.schema_version !== PAYLOAD_SCHEMA_VERSION) f.push('schema_version falsch')
  if (p.sessions.length > INGEST_LIMITS.maxSessions) f.push('zu viele Sessions')
  const ids = new Set<string>()
  for (const s of p.sessions) {
    if (ids.has(s.session_id)) f.push(`session_id doppelt: ${s.session_id}`)
    ids.add(s.session_id)
    f.push(...pruefeSession(s).map(m => `${s.session_id}: ${m}`))
  }
  if (new TextEncoder().encode(JSON.stringify(p)).length > INGEST_LIMITS.maxBodyBytes) f.push('Payload zu groß')
  return f
}
