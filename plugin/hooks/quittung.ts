// Strenge Auswertung der Antwort von `ingest` (HTTP 200): Welche gesendeten Sessions darf das Plugin als
// erledigt quittieren? Rein und getestet (quittung.test.ts), ohne Engine-Zugriffe.
//
// Vertrag: `upserted`, `unassigned`, `abgelehnt` (Zahlen), `uebersprungen` (Zahl, bei sehr altem Server fehlend)
// und – neu, bei altem Server fehlend – `ergebnisse` je Session:
//   { session_id, status: "gespeichert" | "uebersprungen" | "abgelehnt",
//     grund: null | "geringere_quelle" | "fremde_session" | "fremder_workspace" }
// `unassigned` ist laut ingest_upsert eine Teilmenge von `upserted` (gespeichert, aber ohne Projekt).

export type QuittungsStatus = 'gespeichert' | 'uebersprungen' | 'abgelehnt'
export type QuittungsGrund = 'geringere_quelle' | 'fremde_session' | 'fremder_workspace'

export interface SessionErgebnis {
  session_id: string
  status: QuittungsStatus
  grund: QuittungsGrund | null
}

export interface Zaehler {
  upserted: number
  unassigned: number
  uebersprungen: number
  abgelehnt: number
}

export type Auswertung =
  | {
      ok: true
      /** Sessions, die als erledigt markiert werden dürfen (je gesendeter Session höchstens ein Eintrag) */
      quittiert: SessionErgebnis[]
      /** Gesendete Sessions ohne Eintrag in `ergebnisse` – bleiben offen */
      ohneErgebnis: string[]
      /** true: Antwort ohne `ergebnisse` (älterer Server), alles sauber gespeichert */
      altServer: boolean
      zaehler: Zaehler
    }
  | { ok: false; fehler: string }

const STATUS: readonly QuittungsStatus[] = ['gespeichert', 'uebersprungen', 'abgelehnt']
const GRUENDE: readonly QuittungsGrund[] = ['geringere_quelle', 'fremde_session', 'fremder_workspace']

const istObjekt = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const istAnzahl = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

const fehler = (text: string): Auswertung => ({ ok: false, fehler: text })

/**
 * Prüft die Antwort gegen die gesendeten Session-IDs. Jede Unstimmigkeit → `ok: false` (nichts quittieren).
 * `text`: Rohtext der HTTP-Antwort.
 */
export const werteAntwortAus = (text: string, gesendet: readonly string[]): Auswertung => {
  let daten: unknown
  try {
    daten = JSON.parse(text)
  } catch {
    return fehler('Antwort des Servers ist kein JSON')
  }
  if (!istObjekt(daten)) return fehler('Antwort des Servers hat ein unerwartetes Format')
  const { upserted, unassigned, abgelehnt } = daten
  const uebersprungen = daten.uebersprungen === undefined ? 0 : daten.uebersprungen
  if (!istAnzahl(upserted) || !istAnzahl(unassigned) || !istAnzahl(abgelehnt) || !istAnzahl(uebersprungen)) {
    return fehler('Antwort des Servers hat ungültige Zähler')
  }
  if (unassigned > upserted) return fehler('Antwort des Servers ist widersprüchlich (Eingangskorb größer als gespeichert)')
  const zaehler: Zaehler = { upserted, unassigned, uebersprungen, abgelehnt }
  const gesendetSet = new Set(gesendet)

  // Älterer Server ohne Einzelergebnisse: nur ein eindeutig vollständiger Erfolg darf quittiert werden
  if (daten.ergebnisse === undefined) {
    if (abgelehnt !== 0 || uebersprungen !== 0 || upserted !== gesendetSet.size) {
      return fehler(
        `Server meldet ${upserted} gespeichert, ${uebersprungen} übersprungen, ${abgelehnt} abgelehnt ohne Einzelergebnisse – nichts quittiert, wird erneut gesendet`,
      )
    }
    return {
      ok: true,
      quittiert: [...gesendetSet].map(session_id => ({ session_id, status: 'gespeichert', grund: null })),
      ohneErgebnis: [],
      altServer: true,
      zaehler,
    }
  }

  if (!Array.isArray(daten.ergebnisse)) return fehler('Antwort des Servers: „ergebnisse“ ist keine Liste')
  const quittiert: SessionErgebnis[] = []
  const gesehen = new Set<string>()
  const anzahl: Record<QuittungsStatus, number> = { gespeichert: 0, uebersprungen: 0, abgelehnt: 0 }
  for (const e of daten.ergebnisse as unknown[]) {
    if (!istObjekt(e) || typeof e.session_id !== 'string') return fehler('Antwort des Servers: ungültiger Ergebnis-Eintrag')
    const sid = e.session_id
    if (!gesendetSet.has(sid)) return fehler('Antwort des Servers nennt eine nicht gesendete Session')
    if (gesehen.has(sid)) return fehler('Antwort des Servers nennt eine Session doppelt')
    const status = STATUS.find(s => s === e.status)
    if (status === undefined) return fehler('Antwort des Servers: unbekannter Status')
    const grund = e.grund === null || e.grund === undefined ? null : GRUENDE.find(g => g === e.grund)
    if (grund === undefined) return fehler('Antwort des Servers: unbekannter Grund')
    if (status === 'gespeichert' && grund !== null) return fehler('Antwort des Servers: Grund bei gespeicherter Session')
    gesehen.add(sid)
    anzahl[status] += 1
    quittiert.push({ session_id: sid, status, grund })
  }
  if (anzahl.gespeichert !== upserted || anzahl.uebersprungen !== uebersprungen || anzahl.abgelehnt !== abgelehnt) {
    return fehler('Antwort des Servers: Zähler passen nicht zu den Einzelergebnissen')
  }
  return {
    ok: true,
    quittiert,
    ohneErgebnis: [...gesendetSet].filter(sid => !gesehen.has(sid)),
    altServer: false,
    zaehler,
  }
}

/** Kurze ID für Meldungen (Session-IDs sind UUIDs) */
export const kurzId = (sid: string): string => (sid.length > 12 ? `${sid.slice(0, 8)}…` : sid)

/** Deutscher Text zu einer nicht übernommenen Session */
export const grundText = (e: SessionErgebnis): string => {
  if (e.status === 'uebersprungen') return 'bessere Erfassung auf dem Server behalten'
  if (e.grund === 'fremde_session') return 'gehört einem anderen Nutzer – nicht übernommen'
  if (e.grund === 'fremder_workspace') return 'gehört einem anderen Workspace – nicht übernommen'
  return 'vom Server abgelehnt – nicht übernommen'
}

/** Meldung für einen Upload mit gültiger Auswertung (Rückgabetext von /aicosts sync) */
export const uploadText = (quittiert: readonly SessionErgebnis[], ohneErgebnis: number): string => {
  const ueber = quittiert.filter(e => e.status === 'uebersprungen').length
  const abgelehnt = quittiert.filter(e => e.status === 'abgelehnt').length
  const hoch = quittiert.length - abgelehnt
  const teile: string[] = []
  if (hoch > 0) {
    teile.push(`Hochgeladen: ${hoch} Session(s)${ueber > 0 ? `, davon ${ueber} übersprungen (bessere Erfassung auf dem Server)` : ''}.`)
  }
  if (abgelehnt > 0) teile.push(`${abgelehnt} abgelehnt (gehört anderem Nutzer oder Workspace – nicht übernommen).`)
  if (ohneErgebnis > 0) teile.push(`${ohneErgebnis} ohne Ergebnis vom Server – wird erneut gesendet.`)
  return teile.length > 0 ? teile.join(' ') : 'Nichts übernommen.'
}

/** Fehlermeldung für /aicosts status bei abgelehnten Sessions (null: keine Ablehnung) */
export const ablehnungsText = (quittiert: readonly SessionErgebnis[]): string | null => {
  const abgelehnt = quittiert.filter(e => e.status === 'abgelehnt')
  const erste = abgelehnt[0]
  if (erste === undefined) return null
  const weitere = abgelehnt.length > 1 ? ` (und ${abgelehnt.length - 1} weitere)` : ''
  return `Session ${kurzId(erste.session_id)} ${grundText(erste)}${weitere}`
}

/** Höchstzahl gemerkter Hinweise für /aicosts status */
export const HINWEISE_MAX = 5

export interface Hinweis {
  session_id: string
  status: 'uebersprungen' | 'abgelehnt'
  grund: QuittungsGrund | null
  zeit: number
}

const istHinweis = (v: unknown): v is Hinweis =>
  istObjekt(v) &&
  typeof v.session_id === 'string' &&
  (v.status === 'uebersprungen' || v.status === 'abgelehnt') &&
  (v.grund === null || GRUENDE.some(g => g === v.grund)) &&
  typeof v.zeit === 'number'

/** Gespeicherte Hinweise lesen (Unbekanntes wird verworfen) */
export const leseHinweise = (roh: unknown): Hinweis[] => (Array.isArray(roh) ? roh.filter(istHinweis).slice(0, HINWEISE_MAX) : [])

/**
 * Neue Hinweise vorn einfügen. Sessions, die jetzt gespeichert wurden oder erneut gemeldet werden,
 * verlieren ihren alten Hinweis. Höchstens HINWEISE_MAX Einträge.
 */
export const fuegeHinweiseHinzu = (alt: readonly Hinweis[], quittiert: readonly SessionErgebnis[], zeit: number): Hinweis[] => {
  const betroffen = new Set(quittiert.map(e => e.session_id))
  const neu: Hinweis[] = []
  for (const e of quittiert) {
    if (e.status === 'gespeichert') continue
    neu.push({ session_id: e.session_id, status: e.status, grund: e.grund, zeit })
  }
  return [...neu, ...alt.filter(h => !betroffen.has(h.session_id))].slice(0, HINWEISE_MAX)
}

/** Zeile für einen Hinweis in /aicosts status */
export const hinweisZeile = (h: Hinweis): string =>
  `  ${kurzId(h.session_id)}: ${h.status} – ${grundText({ session_id: h.session_id, status: h.status, grund: h.grund })}`
