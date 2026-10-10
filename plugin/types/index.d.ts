// Werte des Plugins in $.state (je Session, überstehen Hot-Reloads)

// Einstellungen für Cache-Anzeige und Keep-Alive, sessionübergreifend in $.store
export type CacheSettings = {
  ttlMinutes: number
  keepAlive: boolean
  maxPings: number
}

// Ergebnis des letzten Keep-Alive-Pings
export type PingInfo = {
  at: number
  isOk: boolean
  cacheReadTokens: number
  note: string
}

// Laufzeitstand des Prompt-Caches der Haupt-Session
export type CacheState = {
  lastActivityAt: number | null
  isRunning: boolean
  pings: number
  lastPing: PingInfo | null
}

// Session-Summen aus dem eigenen Journal (über Neustarts), alle Stränge
export type SessionSumme = {
  tokens: number
  outputTokens: number
}

// Monatswerte laut Server (`POST /ingest/stats`)
export type UsageFigures = {
  tokens: number
  outputTokens: number
  kostenUsd: number
}

export type BandStats = {
  monat: string
  gesamt: UsageFigures
  session: UsageFigures | null
}

// Verbindung zur AICosts-Cloud (ohne Token)
export type Verbindung = {
  verbunden: boolean
  workspace: string | null
}

declare module 'claude-code' {
  interface PluginState {
    aicosts: {
      summe: SessionSumme
      settings: CacheSettings
      cache: CacheState
      tick: number
      stats: BandStats | null
      verbindung: Verbindung
    }
  }
}
