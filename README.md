# AICosts – Client

AICosts zeigt, was deine Arbeit mit Claude Code kostet: je Session, je Projekt und je Monat, mit Subagenten,
Modellen und Arbeitszeit. Dieses Repository enthält den offenen Teil, das Claude-Code-Plugin `aicosts`.
Das Dashboard und die Cloud dahinter sind ein eigener Dienst.

**Schritt-für-Schritt-Anleitung (auch zum Ausdrucken):** https://aicosts.netlify.app/anleitung.html
(Quelle: [`docs/anleitung.html`](docs/anleitung.html), eine eigenständige HTML-Datei, die auch offline funktioniert).

Das Plugin

- zeigt über dem Prompt ein **Band**: Kontext-Füllgrad, Session-Token und Kosten, Monatssumme,
  Cache-Restzeit und einen Hinweis, wann sich eine Übergabe an eine neue Session lohnt.
  Kosten stehen standardmäßig als **echte Kosten in Euro** da (siehe [Kosten im Band](#kosten-im-band)),
- hält im Leerlauf den **Prompt-Cache warm** (Keep-Alive, Standard: höchstens 12 Pings nach deiner letzten Eingabe),
- **erfasst live** jede Antwort (Hauptstrang und Subagenten) und lädt die Kennzahlen in dein AICosts-Dashboard hoch.

Es läuft im Terminal und in der Desktop-App (Code-Tab). Node.js ist nicht nötig.

## Voraussetzungen

- macOS (Windows folgt später)
- Claude Code ab Version 2.1.287 (`claude --version`)
- ein AICosts-Konto (Anmeldung im Dashboard per E-Mail-Link)

## Installation per Einzeiler

Im Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/JMTronic/aicosts-client/main/install.sh | sh
```

Das Skript

1. prüft, ob Claude Code installiert ist und mindestens Version 2.1.287 hat,
2. fügt den Marketplace `JMTronic/aicosts-client` hinzu (unter dem Namen `aicosts`),
3. installiert das Plugin `aicosts@aicosts` für deinen Benutzer,
4. schaltet die automatische Aktualisierung für diesen Marketplace ein,
5. zeigt den nächsten Schritt an: Claude Code neu starten und `/aicosts login` eingeben.

Wer ein Skript vor dem Ausführen lesen möchte, lädt es zuerst herunter:

```sh
curl -fsSL https://raw.githubusercontent.com/JMTronic/aicosts-client/main/install.sh -o install.sh
less install.sh
sh install.sh
```

### Umgebungsvariablen

| Variable | Wirkung |
|---|---|
| `AICOSTS_CLAUDE=/pfad/zu/claude` | anderes Claude-Code-Programm verwenden (ohne Angabe: `claude` im PATH, sonst das der Desktop-App) |
| `AICOSTS_MARKETPLACE=<quelle>` | andere Marketplace-Quelle (owner/repo, Git-URL oder lokaler Pfad) |
| `AICOSTS_FORCE=1` | vorhandenen Marketplace `aicosts` mit anderer Quelle ersetzen (oder `… \| sh -s -- --force`) |
| `AICOSTS_PURGE=1` | nur `uninstall.sh`: lokale Daten ohne Rückfrage löschen |
| `CLAUDE_CONFIG_DIR` | wird wie von Claude Code beachtet |

Variablen gehören hinter die Pipe, z. B. `curl -fsSL … | AICOSTS_FORCE=1 sh`. Dateien, die der Installer ändert,
sichert er vorher als `*.aicosts-bak`. Für GitHub-Marketplaces braucht Claude Code `git`
(Command Line Tools, `xcode-select --install`); der Installer prüft das.

## Manuelle Installation

Im Terminal:

```sh
claude plugin marketplace add JMTronic/aicosts-client --scope user
claude plugin install aicosts@aicosts --scope user
```

Oder in einem Schritt (ein noch nicht bekannter Marketplace wird dabei zuerst hinzugefügt):

```sh
claude plugin install aicosts --marketplace JMTronic/aicosts-client
```

Dasselbe geht in einer laufenden Claude-Code-Session:

```
/plugin install aicosts --marketplace JMTronic/aicosts-client
```

Laufende Sessions laden ein neu installiertes Plugin mit `/reload-plugins`.

**Automatische Updates:** Für Marketplaces von Drittanbietern ist die automatische Aktualisierung standardmäßig
aus. Einschalten in Claude Code: `/plugin` → Reiter **Marketplaces** → `aicosts` → **Enable auto-update**.
Der Einzeiler oben erledigt das bereits.

## Verbinden: `/aicosts login`

1. In Claude Code `/aicosts login` eingeben.
2. Den angezeigten Link öffnen (er liegt auch in der Zwischenablage) und den Code vergleichen.
3. Im Dashboard den Workspace wählen und „Gerät verbinden“ klicken.

Claude Code meldet die erfolgreiche Verbindung. Der Code gilt 10 Minuten. Der Zugangstoken wird nur lokal im
Plugin-Speicher von Claude Code abgelegt und nie angezeigt. Im Dashboard erscheint er unter dem Namen deines
Rechners (macOS-Computername).

## Befehle

| Befehl | Wirkung |
|---|---|
| `/aicosts login` | Rechner mit deinem AICosts-Workspace verbinden (Geräte-Code im Browser bestätigen) |
| `/aicosts status` | Verbindung, Workspace, letzter Upload, offene Uploads, letzte Fehlermeldung, Kostenmodus und Umrechnungsfaktor, Version (auch `/aicosts` ohne Zusatz) |
| `/aicosts sync` | aktuelle Session und noch nicht hochgeladene ältere Sessions sofort hochladen |
| `/aicosts kosten echt` · `/aicosts kosten api` | Kosten im Band als echte Kosten in Euro (Standard) oder als API-Gegenwert in US-Dollar; gilt für alle Sessions. `/aicosts kosten` allein zeigt Modus und Faktor |
| `/aicosts logout` | Token auf diesem Rechner löschen; die Erfassung läuft lokal weiter |
| `/cache` oder `/cache status` | Cache-Restzeit und Keep-Alive anzeigen |
| `/cache an` · `/cache aus` | Keep-Alive ein- bzw. ausschalten (auch `on` · `off`) |
| `/cache ttl 5` · `/cache ttl 60` | Cache-Lebensdauer in Minuten, nach der Anzeige und Keep-Alive rechnen (Standard 60) |
| `/cache max <0–24>` | höchstens so viele Keep-Alive-Pings nach deiner letzten Eingabe (Standard 12) |
| `/cache ping` | sofort einen Keep-Alive-Ping senden |

Ein Keep-Alive-Ping ist eine sehr kurze Anfrage an das Modell deiner Session. Er liest den Cache und kostet
dadurch nur einen Bruchteil einer normalen Anfrage. Wer das nicht möchte, schaltet ihn mit `/cache aus` ab.

## Kosten im Band

Beispiel: `Session 1.25M Token (Out 18.4k) · ≈2,10 € · Okt 45.20M Token · 90,00 €`

| Anzeige | Bedeutung |
|---|---|
| `≈2,10 €` | echte Kosten der laufenden Session, **anteilig**: Claude Codes Kostenzähler (USD zum API-Preis, wie `/cost`) × Umrechnungsfaktor deines Workspace für den Monat (Anteil an Abo und projektlosen Credits, ohne Gemeinkosten – wie die Sessions im Dashboard) |
| `Okt 45.20M Token · 90,00 €` | Monatssumme deiner Sessions im Workspace: Token und echte Kosten inklusive Gemeinkosten. Nutzt nur du den Workspace, ist das genau Abo + projektlose Credits. Direkt einem Projekt gebuchte Kosten sind nicht enthalten (sie stehen nur im Dashboard) |
| `$2.37 API` · `$87.40 API` | Rückfall auf den API-Gegenwert in US-Dollar: nicht verbunden, der Server liefert noch keinen Faktor (z. B. noch keine Session im Monat oder ältere Server-Version) oder im Dashboard ist für den Monat kein Abo hinterlegt |
| `$2.37` · `$87.40` | Modus `api` (`/aicosts kosten api`): API-Gegenwert in US-Dollar wie in Version 0.1 |

Den Umrechnungsfaktor berechnet der Server mit derselben Regel wie der Dashboard-Schalter „Echt (EUR)“.
Der Faktor ändert sich im Laufe des Monats: Je mehr Nutzung, desto weniger kostet ein Dollar API-Gegenwert.

## Updates

Mit eingeschalteter automatischer Aktualisierung holt Claude Code neue Versionen selbst. Von Hand:

```sh
claude plugin marketplace update aicosts
claude plugin update aicosts@aicosts
```

Danach **Claude Code neu starten** (alle Fenster bzw. die Desktop-App). `/reload-plugins` reicht für ein
aktualisiertes Plugin nicht, die alte Version läuft sonst weiter.

## Datenschutz: was das Plugin sendet

Gesendet werden **nur Kennzahlen**, nie Inhalte. Prompts, Antworten, Dateiinhalte, Tool-Ein- und -Ausgaben und
Session-Titel verlassen deinen Rechner nicht in Richtung AICosts.

Ziel ist die AICosts-Cloud unter `https://foqfktblxfuckkjqyfii.supabase.co/functions/v1` (HTTPS). Das Dashboard
liegt unter `https://aicosts.netlify.app`.

**Beim Upload, je Session** (nur wenn du mit `/aicosts login` verbunden bist):

- Session-ID, Start- und Endzeit, Anzahl deiner Eingaben
- Arbeitsverzeichnis (vollständiger Pfad), Git-Repository (normalisierte Remote-Adresse ohne Zugangsdaten),
  Pfad des Repository-Stammverzeichnisses und Branch
- meistgenutztes Modell, Kontextfenster und größte Kontextfüllung
- Token je Strang (Hauptstrang oder Subagent-ID) × Modell × Preisstufe: Input, Output, Cache gelesen,
  Cache geschrieben (5 Min. bzw. 1 Std.), Anzahl Antworten
- je Subagent: ID, Modell und Anzahl Antworten
- Token und ein Kostengewicht je UTC-Stunde (für den Zeitverlauf)
- Kostenstand laut Claude Code (wie `/cost`) und die Token-Summen aller Stränge
- Zeitspannen mit Start und Ende: Antwortdauer des Agenten und Wartezeit bis zu deiner nächsten Eingabe
- Herkunft `plugin`, Plugin-Version und ob die Session vollständig erfasst wurde

**Beim Login:** Plugin-Name und -Version sowie der Computername deines Macs (als Bezeichnung des Tokens im
Dashboard), danach nur der Geräte-Code beim Abfragen.

**Für das Band:** die aktuelle Session-ID, um Session- und Monatssumme abzurufen (im laufenden Betrieb höchstens einmal pro Minute, zusätzlich direkt nach Login, Sync und Sessionstart).

Wie bei jeder Internetverbindung sieht der Server außerdem die IP-Adresse deines Rechners.

**Lokal** legt das Plugin je Session eine kleine Datei mit diesen Kennzahlen an:
`~/.aicosts/plugin/journal/<session-id>.json`. Daraus wird nach Fehlern erneut hochgeladen. Token, Workspace-Name
und Einstellungen liegen im Plugin-Speicher von Claude Code (`~/.claude/plugins/store/`).

Ohne Verbindung arbeitet das Band trotzdem, die Erfassung bleibt lokal.

## Genauigkeit

- Kosten und Token kommen direkt aus Claude Code (Antwort-Usage und Kostenzähler), auch für Subagenten.
- **Preisstufe Haiku 5.5:** Anfragen mit mehr als 100.000 Prompt-Token kosten mehr („lang“). Das Plugin sieht je
  Antwort nur die Summe aller Anfragen dieser Antwort. Besteht eine Antwort aus mehreren Anfragen, wird die Stufe
  aus der Summe bestimmt und eher zu oft „lang“ gewählt. Die Session-Kosten selbst stammen aus Claude Codes
  Kostenzähler und sind davon nicht betroffen, nur die Aufteilung je Modell.
- **Cache-Schreiben:** Claude Code meldet nicht, ob der Cache für 5 Minuten oder 1 Stunde geschrieben wurde. Das
  Plugin rechnet den Hauptstrang nach der eingestellten Cache-TTL (`/cache ttl`, Standard 60 Min. → 1 Stunde) und
  Subagenten mit 5 Minuten.
- „Antworten“ zählen je abgeschlossener Antwort, nicht je einzelner API-Anfrage.
- Sessions, die vor der Installation begonnen haben, werden ab dann erfasst und als Teil-Erfassung markiert.
  Sie überschreiben im Dashboard keine vollständigeren Daten.

## Deinstallation

Am besten zuerst in Claude Code `/aicosts logout` eingeben, damit der Token lokal gelöscht wird.

Per Einzeiler:

```sh
curl -fsSL https://raw.githubusercontent.com/JMTronic/aicosts-client/main/uninstall.sh | sh
```

Oder von Hand:

```sh
claude plugin uninstall aicosts@aicosts
claude plugin marketplace remove aicosts
```

Danach Claude Code neu starten.

Das Skript entfernt Plugin und Marketplace. Lokale Daten bleiben erhalten, es nennt aber ihre Pfade: das Journal
`~/.aicosts/plugin/` und den Plugin-Speicher mit dem Token `~/.claude/plugins/store/aicosts_*.json`
(`claude plugin uninstall` löscht diesen nicht). Mit `… | AICOSTS_PURGE=1 sh` werden beide gelöscht.
Den Token zusätzlich im Dashboard unter Einstellungen → Ingest-Tokens widerrufen.

## Entwicklung

```sh
claude plugin validate .
claude plugin validate plugin
claude plugin test plugin
```

Die Installationsanleitung `docs/anleitung.html` wird zusätzlich vom Dashboard als `/anleitung.html` ausgeliefert
(Kopie im privaten Dashboard-Repo). Nach jeder Änderung dort die Kopie aktualisieren, sonst schlägt ein Test fehl.
Fonts und Logo sind als Base64 eingebettet; die Datei braucht keine externen Ressourcen.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
