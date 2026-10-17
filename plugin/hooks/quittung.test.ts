import { expect, test } from 'claude-code/testing'

import { ablehnungsText, fuegeHinweiseHinzu, HINWEISE_MAX, leseHinweise, uploadText, werteAntwortAus } from './quittung'

const IDS = ['sess-a', 'sess-b', 'sess-c']
const json = (v: unknown): string => JSON.stringify(v)

test('Quittung: voller Erfolg mit Einzelergebnissen', () => {
  const a = werteAntwortAus(
    json({
      upserted: 3, unassigned: 1, uebersprungen: 0, abgelehnt: 0,
      ergebnisse: IDS.map(session_id => ({ session_id, status: 'gespeichert', grund: null })),
    }),
    IDS,
  )
  expect(a.ok).toBe(true)
  if (!a.ok) return
  expect(a.quittiert.map(e => e.session_id)).toEqual(IDS)
  expect(a.ohneErgebnis).toEqual([])
  expect(a.altServer).toBe(false)
})

test('Quittung: gemischter Batch, Session ohne Eintrag bleibt offen', () => {
  const a = werteAntwortAus(
    json({
      upserted: 1, unassigned: 0, uebersprungen: 1, abgelehnt: 0,
      ergebnisse: [
        { session_id: 'sess-a', status: 'gespeichert', grund: null },
        { session_id: 'sess-b', status: 'uebersprungen', grund: 'geringere_quelle' },
      ],
    }),
    IDS,
  )
  expect(a.ok).toBe(true)
  if (!a.ok) return
  expect(a.quittiert).toEqual([
    { session_id: 'sess-a', status: 'gespeichert', grund: null },
    { session_id: 'sess-b', status: 'uebersprungen', grund: 'geringere_quelle' },
  ])
  expect(a.ohneErgebnis).toEqual(['sess-c'])
})

test('Quittung: älterer Server ohne ergebnisse', () => {
  // sauber: alles gespeichert (unassigned ist Teilmenge von upserted)
  const ok = werteAntwortAus(json({ upserted: 3, unassigned: 3, abgelehnt: 0 }), IDS)
  expect(ok.ok).toBe(true)
  if (ok.ok) {
    expect(ok.altServer).toBe(true)
    expect(ok.quittiert.length).toBe(3)
  }
  // der in der Übergabe reproduzierte Fall: abgelehnt ohne Einzelergebnis → nichts quittieren
  const r3 = werteAntwortAus(json({ upserted: 0, unassigned: 0, abgelehnt: 1 }), ['sess-a'])
  expect(r3.ok).toBe(false)
  // übersprungen, oder Anzahl passt nicht
  expect(werteAntwortAus(json({ upserted: 2, unassigned: 0, uebersprungen: 1, abgelehnt: 0 }), IDS).ok).toBe(false)
  expect(werteAntwortAus(json({ upserted: 2, unassigned: 0, abgelehnt: 0 }), IDS).ok).toBe(false)
  expect(werteAntwortAus(json({ upserted: 4, unassigned: 0, abgelehnt: 0 }), IDS).ok).toBe(false)
})

test('Quittung: ungültige Antworten erzeugen keinen Erfolg', () => {
  const faelle: string[] = [
    'kein json',
    json(null),
    json([1, 2]),
    json({ upserted: 3, unassigned: 0 }),
    json({ upserted: -1, unassigned: 0, abgelehnt: 0 }),
    json({ upserted: 1.5, unassigned: 0, abgelehnt: 0 }),
    json({ upserted: '3', unassigned: 0, abgelehnt: 0 }),
    json({ upserted: 3, unassigned: 0, abgelehnt: 0, uebersprungen: 'x' }),
    json({ upserted: 1, unassigned: 2, abgelehnt: 0 }),
    json({ upserted: 1, unassigned: 0, abgelehnt: 0, uebersprungen: 0, ergebnisse: {} }),
    // unbekannter Status / Grund
    json({ upserted: 0, unassigned: 0, abgelehnt: 0, uebersprungen: 0, ergebnisse: [{ session_id: 'sess-a', status: 'vielleicht', grund: null }] }),
    json({ upserted: 0, unassigned: 0, abgelehnt: 1, uebersprungen: 0, ergebnisse: [{ session_id: 'sess-a', status: 'abgelehnt', grund: 'mondphase' }] }),
    // nicht gesendete oder doppelte Session
    json({ upserted: 1, unassigned: 0, abgelehnt: 0, uebersprungen: 0, ergebnisse: [{ session_id: 'fremd', status: 'gespeichert', grund: null }] }),
    json({
      upserted: 2, unassigned: 0, abgelehnt: 0, uebersprungen: 0,
      ergebnisse: [{ session_id: 'sess-a', status: 'gespeichert', grund: null }, { session_id: 'sess-a', status: 'gespeichert', grund: null }],
    }),
    // Zähler passen nicht zu den Einzelergebnissen
    json({ upserted: 2, unassigned: 0, abgelehnt: 0, uebersprungen: 0, ergebnisse: [{ session_id: 'sess-a', status: 'gespeichert', grund: null }] }),
    json({ upserted: 1, unassigned: 0, abgelehnt: 0, uebersprungen: 0, ergebnisse: [{ session_id: 'sess-a', status: 'abgelehnt', grund: 'fremde_session' }] }),
    // Grund bei gespeicherter Session
    json({ upserted: 1, unassigned: 0, abgelehnt: 0, uebersprungen: 0, ergebnisse: [{ session_id: 'sess-a', status: 'gespeichert', grund: 'fremde_session' }] }),
    json({ upserted: 1, unassigned: 0, abgelehnt: 0, uebersprungen: 0, ergebnisse: ['sess-a'] }),
  ]
  for (const f of faelle) expect(werteAntwortAus(f, IDS).ok).toBe(false)
})

test('Quittung: Texte für Upload, Ablehnung und Hinweise', () => {
  const q = [
    { session_id: 'sess-a', status: 'gespeichert' as const, grund: null },
    { session_id: 'sess-b', status: 'uebersprungen' as const, grund: 'geringere_quelle' as const },
    { session_id: '0123456789abcdef', status: 'abgelehnt' as const, grund: 'fremde_session' as const },
  ]
  const text = uploadText(q, 1)
  expect(text).toContain('Hochgeladen: 2 Session(s), davon 1 übersprungen (bessere Erfassung auf dem Server).')
  expect(text).toContain('1 abgelehnt')
  expect(text).toContain('1 ohne Ergebnis')
  expect(uploadText(q.slice(2), 0)).not.toContain('Hochgeladen')
  expect(ablehnungsText(q)).toBe('Session 01234567… gehört einem anderen Nutzer – nicht übernommen')
  expect(ablehnungsText(q.slice(0, 2))).toBe(null)

  const h1 = fuegeHinweiseHinzu([], q, 1)
  expect(h1.map(h => h.session_id)).toEqual(['sess-b', '0123456789abcdef'])
  // später gespeichert → Hinweis verschwindet
  const h2 = fuegeHinweiseHinzu(h1, [{ session_id: 'sess-b', status: 'gespeichert', grund: null }], 2)
  expect(h2.map(h => h.session_id)).toEqual(['0123456789abcdef'])
  // begrenzt und robust beim Lesen
  const viele = Array.from({ length: 9 }, (_, i) => ({ session_id: `s${i}`, status: 'abgelehnt' as const, grund: null }))
  expect(fuegeHinweiseHinzu([], viele, 3).length).toBe(HINWEISE_MAX)
  expect(leseHinweise([{ session_id: 'x', status: 'kaputt', grund: null, zeit: 1 }, ...h2, 'müll'])).toEqual(h2)
  expect(leseHinweise(undefined)).toEqual([])
})
