import type { BandStats, UsageFigures } from '../types'

const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

const istObjekt = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const zahl = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

// Liest einen Verbrauchsblock; null bei falscher Form
const leseWerte = (v: unknown): UsageFigures | null => {
  if (!istObjekt(v)) return null
  const tokens = zahl(v.tokens)
  const outputTokens = zahl(v.output_tokens)
  const kostenUsd = zahl(v.kosten_usd)
  if (tokens === null || outputTokens === null || kostenUsd === null) return null
  return { tokens, outputTokens, kostenUsd }
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
  return { monat: daten.monat, gesamt, session: leseWerte(daten.session) }
}

/** "2026-10" → "Okt" */
export const monatKurz = (monat: string): string => MONATE[Number(monat.split('-')[1]) - 1] ?? monat

/** Token kurz: 1.2k, 3.45M */
export const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens)}`
}
