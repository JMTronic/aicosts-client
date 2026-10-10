// Git-Angaben ohne git-Programm: Remote normalisieren, Branch aus .git/HEAD lesen.
// Remote-URLs können Zugangsdaten enthalten – sie werden hier entfernt und nie angezeigt.

/**
 * Normalisiert eine Remote-URL (gleiche Logik wie der Server):
 * lowercase, ohne Schema, ohne Benutzer/Passwort, ohne Port, scp-Stil host:pfad → host/pfad, ohne .git.
 * Pfade (beginnen mit /) bleiben bis auf den abschließenden Slash unverändert.
 */
export const normalisiereRemote = (url: string | null | undefined): string | null => {
  if (url === null || url === undefined) return null
  const roh = url.trim()
  if (roh.length === 0) return null
  if (roh.startsWith('/')) return roh.replace(/\/+$/, '') || null
  let v = roh.toLowerCase()
  const hatteSchema = /^[a-z][a-z0-9+.-]*:\/\//.test(v)
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  v = v.replace(/^[^@/]*@/, '')
  v = hatteSchema ? v.replace(/^([^/:]+):[0-9]*(\/|$)/, '$1$2') : v.replace(/^([^/:]+):/, '$1/')
  v = v.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  return v.length > 0 ? v : null
}

/** Branch aus dem Inhalt von .git/HEAD („ref: refs/heads/main“); null bei losgelöstem HEAD */
export const branchAusHead = (head: string): string | null => {
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim())
  const name = m?.[1]?.trim()
  return name !== undefined && name.length > 0 ? name.slice(0, 300) : null
}

/** Pfad des Git-Verzeichnisses aus einer .git-Datei eines Worktrees („gitdir: /pfad“), relativ zu `basis` aufgelöst */
export const gitdirAusDatei = (inhalt: string, basis: string): string | null => {
  const m = /^gitdir:\s*(.+)$/m.exec(inhalt.trim())
  const pfad = m?.[1]?.trim()
  if (pfad === undefined || pfad.length === 0) return null
  return pfad.startsWith('/') ? pfad : `${basis.replace(/\/+$/, '')}/${pfad}`
}

/** Elternverzeichnisse von `pfad` bis zur Wurzel, beginnend mit `pfad` selbst (höchstens `max`) */
export const elternPfade = (pfad: string, max = 40): string[] => {
  const ergebnis: string[] = []
  let aktuell = pfad.replace(/\/+$/, '') || '/'
  for (let i = 0; i < max; i += 1) {
    ergebnis.push(aktuell)
    if (aktuell === '/' || !aktuell.includes('/')) break
    const schnitt = aktuell.lastIndexOf('/')
    aktuell = schnitt <= 0 ? '/' : aktuell.slice(0, schnitt)
  }
  return ergebnis
}
