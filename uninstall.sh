#!/bin/sh
# AICosts-Deinstallation für macOS
#
# Aufruf:  curl -fsSL https://raw.githubusercontent.com/JMTronic/aicosts-client/main/uninstall.sh | sh
#
# Entfernt das Plugin aicosts@aicosts und den Marketplace „aicosts“.
# Lokale Daten (Journal unter ~/.aicosts/plugin/ und der Plugin-Speicher mit
# dem Anmelde-Token) bleiben erhalten, außer AICOSTS_PURGE=1 ist gesetzt oder
# die Rückfrage (nur bei interaktivem Terminal) wird mit „j“ beantwortet.
#
# Umgebungsvariablen:
#   AICOSTS_CLAUDE=/pfad/zu/claude   anderes Claude-Code-Binary verwenden
#   AICOSTS_PURGE=1                  lokale Daten ohne Rückfrage löschen
#   CLAUDE_CONFIG_DIR                wird wie von Claude Code beachtet

set -eu

MP_NAME=aicosts
PLUGIN_ID=aicosts@aicosts

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'Hinweis: %s\n' "$*" >&2; }
die() { printf '\nFehler: %s\n' "$*" >&2; exit 1; }

cl() { "$CLAUDE" "$@" </dev/null; }

# Prüft per JXA, ob ein Eintrag in einer JSON-Liste vorkommt
# list_has <json> <feld> <wert> [<feld2> <wert2>]
list_has() {
  osascript -l JavaScript - "$@" <<'JXA'
function run(argv) {
  var list = JSON.parse(argv[0]);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e[argv[1]] === argv[2] && (argv.length < 5 || e[argv[3]] === argv[4])) return 'ja';
  }
  return 'nein';
}
JXA
}

find_claude() {
  if [ -n "${AICOSTS_CLAUDE:-}" ]; then
    [ -x "$AICOSTS_CLAUDE" ] || die "AICOSTS_CLAUDE zeigt nicht auf ein ausführbares Programm: $AICOSTS_CLAUDE"
    printf '%s\n' "$AICOSTS_CLAUDE"; return 0
  fi
  if command -v claude 2>/dev/null; then return 0; fi
  for bin in "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude; do
    [ -x "$bin" ] && { printf '%s\n' "$bin"; return 0; }
  done
  return 1
}

main() {
  [ "$(uname -s)" = Darwin ] || die "Dieses Skript ist nur für macOS."
  CLAUDE=$(find_claude) || die "Claude Code nicht gefunden."

  CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  PLUGINS_DIR=${CLAUDE_CODE_PLUGIN_CACHE_DIR:-$CONFIG_DIR/plugins}
  DATA_DIR="$HOME/.aicosts/plugin"

  say "AICosts-Deinstallation"

  step "Plugin $PLUGIN_ID"
  plist=$(cl plugin list --json 2>/dev/null) || die "\`claude plugin list\` ist fehlgeschlagen."
  if [ "$(list_has "$plist" id "$PLUGIN_ID" scope user)" = ja ]; then
    out=$(cl plugin uninstall "$PLUGIN_ID" --scope user 2>&1) || die "Deinstallation fehlgeschlagen:
$out"
    say "Deinstalliert."
  else
    say "Nicht installiert (Scope user)."
  fi

  step "Marketplace „$MP_NAME“"
  mlist=$(cl plugin marketplace list --json 2>/dev/null) || die "\`claude plugin marketplace list\` ist fehlgeschlagen."
  if [ "$(list_has "$mlist" name "$MP_NAME")" = ja ]; then
    out=$(cl plugin marketplace remove "$MP_NAME" 2>&1) || die "Entfernen des Marketplace fehlgeschlagen:
$out"
    say "Entfernt."
  else
    say "Nicht vorhanden."
  fi

  # Lokale Daten: Journal und Plugin-Speicher ($.store, enthält den Token).
  # Der Speicher liegt unter <plugins>/store/aicosts_<marketplace>-<hash>.json
  # und wird von `claude plugin uninstall` nicht entfernt.
  step "Lokale Daten"
  STORES=
  for f in "$PLUGINS_DIR"/store/aicosts_*.json; do
    [ -f "$f" ] && STORES="$STORES$f
"
  done
  if [ ! -d "$DATA_DIR" ] && [ -z "$STORES" ]; then
    say "Keine lokalen Daten gefunden."
  else
    PURGE=${AICOSTS_PURGE:-0}
    if [ "$PURGE" != 1 ] && [ -t 0 ]; then
      printf 'Lokale AICosts-Daten (Journal und Anmelde-Token) löschen? [j/N] '
      read -r answer || answer=
      case $answer in j | J | ja | Ja | y | Y) PURGE=1 ;; esac
    fi
    if [ "$PURGE" = 1 ]; then
      if [ -d "$DATA_DIR" ]; then rm -rf "$DATA_DIR"; say "Gelöscht: $DATA_DIR"; fi
      printf "%s" "$STORES" | while IFS= read -r f; do
        if [ -n "$f" ]; then rm -f "$f"; say "Gelöscht: $f"; fi
      done
    else
      say "Behalten (löschen mit AICOSTS_PURGE=1):"
      if [ -d "$DATA_DIR" ]; then say "  $DATA_DIR"; fi
      printf "%s" "$STORES" | while IFS= read -r f; do
        if [ -n "$f" ]; then say "  $f (Plugin-Speicher mit Anmelde-Token)"; fi
      done
    fi
  fi

  step "Fertig"
  say "Claude Code neu starten, damit laufende Sessions das Plugin entladen."
}

main "$@"
