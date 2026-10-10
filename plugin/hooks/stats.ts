import type { BandStats, KostenFaktor, Kostenmodus, UsageFigures } from '../types'

const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

const istObjekt = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const zahl = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

// Liest einen Verbrauchsblock; null bei falscher Form. echt_eur ist optional (ältere Server liefern es nicht).
const leseWerte = (v: unknown): UsageFigures | null => {
  if (!istObjekt(v)) return null
  const tokens = zahl(v.tokens)
  const outputTokens = zahl(v.output_tokens)
  const kostenUsd = zahl(v.kosten_usd)
  if (tokens === null || outputTokens === null || kostenUsd === null) return null
  return { tokens, outputTokens, kostenUsd, echtEur: zahl(v.echt_eur) }
}

// Liest den Umrechnungsfaktor; null bei fehlendem oder unvollständigem Block
const leseFaktor = (v: unknown): KostenFaktor | null => {
  if (!istObjekt(v) || typeof v.monat !== 'string') return null
  const projekt = zahl(v.eur_pro_usd_projekt)
  const gesamt = zahl(v.eur_pro_usd_gesamt)
  if (projekt === null || gesamt === null || typeof v.abo_hinterlegt !== 'boolean') return null
  return { monat: v.monat, eurProUsdProjekt: projekt, eurProUsdGesamt: gesamt, aboHinterlegt: v.abo_hinterlegt }
}

/** Wertet die Antwort von `POST /ingest/stats` aus (Version 1); null bei unbekanntem Format */
export const parseStats = (text: string): BandStats | null => {
  let daten: unknown
  try {
    daten = JSON.parse(text)
  } catch {
    return null
  }
  if (!istObjekt(daten) || daten.version !== 1 || typeof daten.monat !== 'string') return null
  const gesamt = leseWerte(daten.gesamt)
  if (gesamt === null) return null
  return { monat: daten.monat, gesamt, session: leseWerte(daten.session), faktor: leseFaktor(daten.faktor) }
}

/** "2026-10" → "Okt" */
export const monatKurz = (monat: string): string => MONATE[Number(monat.split('-')[1]) - 1] ?? monat

/** Token kurz: 1.2k, 3.45M */
export const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens)}`
}

/** USD wie bisher: $7.48 */
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`

/** Euro deutsch, 2 Nachkommastellen, Tausenderpunkt: 1.234,56 € */
export const formatEuro = (eur: number): string => {
  const wert = Number.isFinite(eur) ? eur : 0
  const [ganz = '0', dezimal = '00'] = Math.abs(wert).toFixed(2).split('.')
  const mitPunkten = ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${wert < 0 && Math.abs(wert) >= 0.005 ? '-' : ''}${mitPunkten},${dezimal} €`
}

/** Faktor kurz deutsch: 0,2204 */
export const formatFaktor = (f: number): string => f.toFixed(4).replace('.', ',')

// ---------------------------------------------------------------------------
// Kostenmodus

export const STANDARD_MODUS: Kostenmodus = 'echt'

export const istKostenmodus = (v: unknown): v is Kostenmodus => v === 'echt' || v === 'api'

/** Gespeicherten Modus lesen; alles Unbekannte → Standard „echt“ */
export const leseModus = (v: unknown): Kostenmodus => (istKostenmodus(v) ? v : STANDARD_MODUS)

/** Argument von `/aicosts kosten …`: Modus, „zeigen“ (leer) oder null (unbekannt) */
export const parseKostenArgs = (arg: string | undefined): Kostenmodus | 'zeigen' | null => {
  const a = (arg ?? '').trim().toLowerCase()
  if (a === '') return 'zeigen'
  if (a === 'echt' || a === 'eur') return 'echt'
  if (a === 'api' || a === 'usd') return 'api'
  return null
}

/** Warum (k)ein Euro-Wert gezeigt wird */
export type KostenGrund = 'echt' | 'api_gewaehlt' | 'nicht_verbunden' | 'kein_faktor' | 'kein_abo'

/** Prüft, ob echte Kosten gezeigt werden können; liefert dann den Faktor */
export const echtFaktor = (
  modus: Kostenmodus,
  verbunden: boolean,
  stats: BandStats | null,
): { grund: KostenGrund; faktor: KostenFaktor | null } => {
  if (modus === 'api') return { grund: 'api_gewaehlt', faktor: null }
  if (!verbunden) return { grund: 'nicht_verbunden', faktor: null }
  const f = stats?.faktor ?? null
  if (stats === null || f === null || stats.gesamt.echtEur === null) return { grund: 'kein_faktor', faktor: null }
  if (!f.aboHinterlegt) return { grund: 'kein_abo', faktor: null }
  return { grund: 'echt', faktor: f }
}

export type BandKosten = {
  /** Kosten der laufenden Session */
  session: string
  /** Monatssumme (ohne Monat/Token-Präfix); null ohne Serverstand */
  monat: string | null
  /** gedämpfter Zusatz „API“ beim Rückfall auf USD im Modus „echt“ */
  zusatz: string | null
  grund: KostenGrund
}

/**
 * Kostenwerte fürs Band.
 * echt: Session = Live-USD × Projektfaktor (anteilig, „≈“), Monat = gesamt.echt_eur vom Server.
 * api:  wie bisher in USD. Rückfall (nicht verbunden, kein Faktor, kein Abo): USD mit Zusatz „API“.
 */
export const bandKosten = (
  modus: Kostenmodus,
  verbunden: boolean,
  stats: BandStats | null,
  sessionUsd: number,
): BandKosten => {
  const { grund, faktor } = echtFaktor(modus, verbunden, stats)
  if (faktor !== null && stats !== null && stats.gesamt.echtEur !== null) {
    return {
      session: `≈${formatEuro(sessionUsd * faktor.eurProUsdProjekt)}`,
      monat: formatEuro(stats.gesamt.echtEur),
      zusatz: null,
      grund,
    }
  }
  return {
    session: formatUsd(sessionUsd),
    monat: stats === null ? null : formatUsd(stats.gesamt.kostenUsd),
    zusatz: grund === 'api_gewaehlt' ? null : 'API',
    grund,
  }
}

const GRUND_TEXT: Readonly<Record<KostenGrund, string>> = {
  echt: 'echte Kosten in EUR',
  api_gewaehlt: 'API-Gegenwert in USD',
  nicht_verbunden: 'USD (API-Gegenwert) – nicht verbunden',
  kein_faktor: 'USD (API-Gegenwert) – Server liefert noch keinen Faktor',
  kein_abo: 'USD (API-Gegenwert) – im Dashboard ist für den Monat kein Abo hinterlegt',
}

/** Zeilen für /aicosts status bzw. /aicosts kosten */
export const modusText = (modus: Kostenmodus, verbunden: boolean, stats: BandStats | null): string[] => {
  const { grund } = echtFaktor(modus, verbunden, stats)
  const f = stats?.faktor ?? null
  return [
    `Kosten im Band: ${modus === 'echt' ? 'echt (EUR)' : 'api (USD)'} – Anzeige: ${GRUND_TEXT[grund]}`,
    f === null
      ? 'Faktor: –'
      : `Faktor ${monatKurz(f.monat)}: Session ${formatFaktor(f.eurProUsdProjekt)} €/$ (anteilig), Monat ${formatFaktor(f.eurProUsdGesamt)} €/$ (inkl. Gemeinkosten)${f.aboHinterlegt ? '' : ', kein Abo hinterlegt'}`,
  ]
}
