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
  /** Echte Kosten in EUR (seit Server-Migration 20261011120000); null, wenn der Server sie nicht liefert */
  echtEur: number | null
}

// Umrechnung API-Gegenwert (USD) → echte Kosten (EUR) des Monats, wie im Dashboard
export type KostenFaktor = {
  /** "YYYY-MM" */
  monat: string
  /** EUR je USD für Sessions (anteilig, ohne Gemeinkosten) */
  eurProUsdProjekt: number
  /** EUR je USD für die Monatssumme (inkl. Gemeinkosten) */
  eurProUsdGesamt: number
  aboHinterlegt: boolean
}

export type BandStats = {
  monat: string
  gesamt: UsageFigures
  session: UsageFigures | null
  /** null: Server ohne Faktor (ältere Version oder noch keine Sessions im Monat) */
  faktor: KostenFaktor | null
}

// Anzeige der Kosten im Band: echte Kosten (EUR) oder API-Gegenwert (USD); sessionübergreifend in $.store
export type Kostenmodus = 'echt' | 'api'

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
      modus: Kostenmodus
    }
  }
}
