// Nutzungslimits des Abos (5-Stunden-Fenster, Woche) fürs Band, rein und getestet.
// Quelle: $.session.usage().rateLimits – gilt fürs ganze Claude-Konto (auch Chat/Cowork), leer ohne Abo
// oder vor der ersten Antwort. Reset relativ zur Uhr, damit keine Zeitzone nötig ist.

/** Ein Limit-Fenster, wie die Engine es liefert (SessionRateLimit) */
export type LimitFenster = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type LimitFarbe = 'dim' | 'warning' | 'error'

export type LimitSegment = {
  key: string
  text: string
  farbe: LimitFarbe
}

/** Ab diesen Prozenten wird das Segment als Warnung bzw. Fehler (Theme-Farben) gezeigt */
export const LIMIT_GELB = 75
export const LIMIT_ROT = 90

const NAMEN: Readonly<Record<string, string>> = {
  five_hour: '5h-Limit',
  seven_day: 'Wochenlimit',
  spend_limit: 'Ausgabenlimit',
}

// Feste Reihenfolge: erst das kurze Fenster, dann die Woche, dann alles Übrige
const RANG: Readonly<Record<string, number>> = { five_hour: 0, seven_day: 1, spend_limit: 2 }

/** Restzeit bis zum Reset: „45 min“, „2 h 10 min“, „3 T 4 h“; abgelaufen → „gleich“ */
export const formatRestzeit = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return 'gleich'
  const minuten = Math.ceil(ms / 60_000)
  if (minuten < 60) return `${minuten} min`
  const stunden = Math.floor(minuten / 60)
  if (stunden < 24) return `${stunden} h ${minuten % 60} min`
  return `${Math.floor(stunden / 24)} T ${stunden % 24} h`
}

/** Prozent deutsch mit höchstens einer Nachkommastelle: 23,5 % */
const formatProzent = (p: number): string => `${(Math.round(p * 10) / 10).toString().replace('.', ',')} %`

const farbeFuer = (p: number): LimitFarbe => (p >= LIMIT_ROT ? 'error' : p >= LIMIT_GELB ? 'warning' : 'dim')

/** Segmente fürs Band, z. B. „5h-Limit 23 % (Reset in 2 h 10 min)“; ungültige Einträge fallen weg */
export const limitSegmente = (fenster: readonly LimitFenster[], jetztMs: number): LimitSegment[] =>
  fenster
    .filter(f => typeof f.kind === 'string' && typeof f.percentUsed === 'number' && Number.isFinite(f.percentUsed))
    .slice()
    .sort((a, b) => (RANG[a.kind] ?? 9) - (RANG[b.kind] ?? 9))
    .map(f => {
      const reset = f.resetsAt === undefined ? Number.NaN : Date.parse(f.resetsAt)
      const restzeit = Number.isFinite(reset) ? ` (Reset in ${formatRestzeit(reset - jetztMs)})` : ''
      return {
        key: `limit-${f.kind}`,
        text: `${NAMEN[f.kind] ?? f.kind} ${formatProzent(f.percentUsed)}${restzeit}`,
        farbe: farbeFuer(f.percentUsed),
      }
    })
