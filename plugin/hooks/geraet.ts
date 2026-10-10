// Geräte-Login (Device-Flow) und Adressen der AICosts-Cloud – reine Funktionen ohne $.

/** Standard-Basis der AICosts-Cloud; überschreibbar über $.store-Schlüssel `basisUrl` */
export const STANDARD_BASIS_URL = 'https://foqfktblxfuckkjqyfii.supabase.co/functions/v1'

const ohneSlash = (url: string): string => url.trim().replace(/\/+$/, '')

/** Nur https (oder http auf localhost für Tests) ist als Basis erlaubt */
export const istErlaubteUrl = (url: unknown): url is string =>
  typeof url === 'string' && (/^https:\/\/[^\s/]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url))

export const basisUrl = (override: unknown): string => (istErlaubteUrl(override) ? ohneSlash(override) : STANDARD_BASIS_URL)

export const deviceStartUrl = (basis: string): string => `${ohneSlash(basis)}/device/start`
export const devicePollUrl = (basis: string): string => `${ohneSlash(basis)}/device/poll`
export const standardIngestUrl = (basis: string): string => `${ohneSlash(basis)}/ingest`
export const statsUrl = (ingest: string): string => `${ohneSlash(ingest)}/stats`

export interface DeviceStart {
  device_code: string
  user_code: string
  verification_url: string
  /** Sekunden zwischen zwei Abfragen */
  interval: number
  /** Sekunden bis zum Ablauf */
  expires_in: number
}

const istObjekt = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Antwort von `POST /device/start`; null bei unbekanntem Format */
export const parseDeviceStart = (text: string): DeviceStart | null => {
  const d = parse(text)
  if (!istObjekt(d)) return null
  const { device_code, user_code, verification_url, interval, expires_in } = d
  if (typeof device_code !== 'string' || device_code.length < 16) return null
  if (typeof user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(user_code)) return null
  if (typeof verification_url !== 'string' || !/^https?:\/\//.test(verification_url)) return null
  const iv = typeof interval === 'number' && Number.isFinite(interval) ? Math.min(Math.max(Math.round(interval), 1), 60) : 5
  const ex = typeof expires_in === 'number' && Number.isFinite(expires_in) ? Math.min(Math.max(Math.round(expires_in), 30), 3600) : 600
  return { device_code, user_code, verification_url, interval: iv, expires_in: ex }
}

export type PollErgebnis =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'verbraucht' }
  | { status: 'approved'; token: string; workspace: string | null; ingestUrl: string | null }
  | { status: 'fehler'; grund: string }

/** Antwort von `POST /device/poll` (HTTP-Status + Text) */
export const parseDevicePoll = (httpStatus: number, text: string): PollErgebnis => {
  const d = parse(text)
  const status = istObjekt(d) ? d.status : undefined
  if (httpStatus === 429 || status === 'slow_down') return { status: 'slow_down' }
  // Code schon abgeholt oder dem Server unbekannt: Login neu starten
  if (status === 'consumed' || status === 'unknown' || httpStatus === 404) return { status: 'verbraucht' }
  if (httpStatus < 200 || httpStatus >= 300) return { status: 'fehler', grund: `HTTP ${httpStatus}` }
  if (status === 'pending' || status === 'expired' || status === 'denied') return { status }
  if (status === 'approved' && istObjekt(d)) {
    const token = d.token
    if (typeof token !== 'string' || !/^aic_[A-Za-z0-9_-]{8,}$/.test(token)) return { status: 'fehler', grund: 'Token fehlt' }
    const workspace = typeof d.workspace_name === 'string' ? d.workspace_name.slice(0, 200) : null
    const ingestUrl = istErlaubteUrl(d.ingest_url) ? ohneSlash(d.ingest_url) : null
    return { status: 'approved', token, workspace, ingestUrl }
  }
  return { status: 'fehler', grund: 'unbekannte Antwort' }
}

/** Fehlertext einer Server-Antwort, kurz und ohne Token (der Server sendet keinen) */
export const fehlerText = (httpStatus: number, text: string): string => {
  if (httpStatus === 401) return 'Token ungültig oder widerrufen – bitte /aicosts login'
  const d = parse(text)
  const meldung = istObjekt(d) && typeof d.fehler === 'string' ? `: ${d.fehler.slice(0, 200)}` : ''
  return `HTTP ${httpStatus}${meldung}`
}
