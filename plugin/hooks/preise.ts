// Listenpreise (USD pro Million Token) – nur als Gewicht für die Stunden-Verteilung.
// Verbindlich rechnet der Server mit seiner eigenen Preistabelle.
// Stand: Preisseite von Anthropic, 2026-10-09.

export interface Preis {
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
}

export type Preisstufe = 'standard' | 'lang'

/** Token-Zähler einer Nutzungszeile (Namen wie im Upload-Vertrag) */
export interface TokenZaehler {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_5m_tokens: number
  cache_write_1h_tokens: number
}

const p = (input: number, output: number, cache_read: number, cache_write_5m: number, cache_write_1h: number): Preis => ({
  input,
  output,
  cache_read,
  cache_write_5m,
  cache_write_1h,
})

export const PREISE: Readonly<Record<string, Partial<Record<Preisstufe, Preis>>>> = {
  'claude-fable-5-1': { standard: p(10, 50, 0.25, 12.5, 20) },
  'claude-fable-5': { standard: p(10, 50, 1, 12.5, 20) },
  'claude-opus-5-5': { standard: p(4, 20, 0.2, 5, 8) },
  'claude-opus-5': { standard: p(5, 25, 0.5, 6.25, 10) },
  'claude-opus-4-8': { standard: p(5, 25, 0.5, 6.25, 10) },
  'claude-opus-4-7': { standard: p(5, 25, 0.5, 6.25, 10) },
  'claude-opus-4-6': { standard: p(5, 25, 0.5, 6.25, 10) },
  'claude-sonnet-5-5': { standard: p(2, 10, 0.1, 2.5, 4) },
  'claude-sonnet-5': { standard: p(2, 10, 0.2, 2.5, 4) },
  'claude-sonnet-4-6': { standard: p(3, 15, 0.3, 3.75, 6) },
  'claude-haiku-5-5': { standard: p(0.1, 0.5, 0.01, 0.125, 0.2), lang: p(0.5, 2.5, 0.05, 0.625, 1) },
  'claude-haiku-4-5': { standard: p(1, 5, 0.1, 1.25, 2) },
}

/** Haiku 5.5: Anfragen mit Prompt (input + cache_read + cache_write) über dieser Grenze kosten mehr */
export const HAIKU_55_LANG_SCHWELLE = 100_000

/** Entfernt ein Datumssuffix wie -20251001 */
export const basisModell = (modell: string): string => modell.replace(/-\d{8}$/, '')

/**
 * Preisstufe aus der Prompt-Größe. Das Plugin sieht je Antwort nur die SUMME aller Anfragen
 * (turn.complete); bei Antworten mit mehreren Anfragen ist die Stufe deshalb nur genähert
 * (eher zu oft „lang“). Siehe README, Abschnitt „Genauigkeit“.
 */
export const preisstufeFuer = (modell: string, promptTokens: number): Preisstufe =>
  basisModell(modell) === 'claude-haiku-5-5' && promptTokens > HAIKU_55_LANG_SCHWELLE ? 'lang' : 'standard'

/** Kosten in USD oder null, wenn kein Preis bekannt ist */
export const kostenUsd = (modell: string, stufe: string, t: TokenZaehler): number | null => {
  const eintrag = PREISE[modell] ?? PREISE[basisModell(modell)]
  const preis = eintrag?.[stufe as Preisstufe]
  if (!preis) return null
  return (
    (t.input_tokens * preis.input +
      t.output_tokens * preis.output +
      t.cache_read_tokens * preis.cache_read +
      t.cache_write_5m_tokens * preis.cache_write_5m +
      t.cache_write_1h_tokens * preis.cache_write_1h) /
    1_000_000
  )
}
