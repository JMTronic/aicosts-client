#!/bin/sh
# AICosts-Installer für macOS
#
# Aufruf:  curl -fsSL https://raw.githubusercontent.com/JMTronic/aicosts-client/main/install.sh | sh
#
# Schritte: Claude-Code-Version prüfen, Marketplace „aicosts“ hinzufügen bzw.
# aktualisieren, Plugin aicosts@aicosts installieren bzw. aktualisieren,
# Auto-Update für den Marketplace einschalten.
#
# Benötigt nur Bordmittel von macOS (sh, osascript/JXA). Kein Node, kein jq.
#
# Umgebungsvariablen:
#   AICOSTS_CLAUDE=/pfad/zu/claude   anderes Claude-Code-Binary verwenden
#   AICOSTS_MARKETPLACE=<quelle>     Marketplace-Quelle (owner/repo, Git-URL
#                                    oder lokaler Pfad), Standard: JMTronic/aicosts-client
#   AICOSTS_FORCE=1                  bestehenden Marketplace „aicosts“ mit anderer
#                                    Quelle ersetzen (gleichwertig: Argument --force)
#   CLAUDE_CONFIG_DIR                wird wie von Claude Code beachtet
#
# Das ganze Skript steckt in main(), damit „curl … | sh“ es vollständig
# einliest, bevor etwas ausgeführt wird. Alle Unterprozesse bekommen
# </dev/null, damit keiner den Rest des Skripts von stdin liest.

set -eu

MIN_VERSION=2.1.287
MP_NAME=aicosts
PLUGIN_ID=aicosts@aicosts
DEFAULT_SOURCE=JMTronic/aicosts-client

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'Hinweis: %s\n' "$*" >&2; }
die() { printf '\nFehler: %s\n' "$*" >&2; exit 1; }

# JSON-Helfer über JXA (auf jedem Mac vorhanden)
jxa() {
  osascript -l JavaScript - "$@" <<'JXA'
ObjC.import('Foundation');
function readText(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  return s.isNil() ? null : s.js;
}
function writeText(p, t) {
  return $(t).writeToFileAtomicallyEncodingError(p, false, $.NSUTF8StringEncoding, null);
}
function isObj(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
function run(argv) {
  var cmd = argv[0];
  if (cmd === 'mp-source') {            // mp-source <list-json> <name>
    var list = JSON.parse(argv[1]);
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.name === argv[2]) return (m.source || '?') + ':' + (m.repo || m.url || m.path || '');
    }
    return '';
  }
  if (cmd === 'plugin-state') {         // plugin-state <list-json> <id>
    var pl = JSON.parse(argv[1]);
    for (var j = 0; j < pl.length; j++) {
      var p = pl[j];
      if (p.id === argv[2] && p.scope === 'user') return (p.enabled ? 'enabled' : 'disabled') + ' ' + (p.version || '?');
    }
    return '';
  }
  if (cmd === 'set-auto' || cmd === 'get-auto') {   // <cmd> <datei> <tmp|-> <settings|known> <name>
    var file = argv[1], tmp = argv[2], kind = argv[3], name = argv[4];
    var text = readText(file);
    if (text === null) return 'missing-file';
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return 'invalid'; }
    if (!isObj(obj)) return 'invalid';
    var entry = kind === 'settings'
      ? (isObj(obj.extraKnownMarketplaces) ? obj.extraKnownMarketplaces[name] : undefined)
      : obj[name];
    if (!isObj(entry)) return 'missing-entry';
    if (cmd === 'get-auto') return String(entry.autoUpdate);
    if (entry.autoUpdate === true) return 'unchanged';
    entry.autoUpdate = true;
    var out = JSON.stringify(obj, null, 2) + (/\n$/.test(text) ? '\n' : '');
    if (!writeText(tmp, out)) return 'write-failed';
    return 'changed';
  }
  throw new Error('unbekannter Befehl: ' + cmd);
}
JXA
}

# Claude-Code-Aufruf: nie von stdin lesen
cl() { "$CLAUDE" "$@" </dev/null; }

# Gibt 0 zurück, wenn Version $1 >= $2 (nur Ziffern und Punkte)
version_ge() {
  a=$1 b=$2
  while [ -n "$a" ] || [ -n "$b" ]; do
    x=${a%%.*}; y=${b%%.*}
    case $a in *.*) a=${a#*.} ;; *) a= ;; esac
    case $b in *.*) b=${b#*.} ;; *) b= ;; esac
    x=${x:-0}; y=${y:-0}
    [ "$x" -gt "$y" ] && return 0
    [ "$x" -lt "$y" ] && return 1
  done
  return 0
}

# Version aus „2.1.295 (Claude Code)“ lesen
claude_version() {
  v=$("$1" --version </dev/null 2>/dev/null | head -n 1) || v=
  v=${v%% *}; v=${v%%-*}; v=${v%%+*}
  case $v in '' | *[!0-9.]*) return 1 ;; esac
  printf '%s\n' "$v"
}

# Neueste Claude-Code-Version der Desktop-App (falls vorhanden)
desktop_claude() {
  base="$HOME/Library/Application Support/Claude/claude-code"
  best= bestv=
  for bin in "$base"/*/*/claude.app/Contents/MacOS/claude; do
    [ -x "$bin" ] || continue
    v=$(claude_version "$bin") || continue
    if [ -z "$bestv" ] || ! version_ge "$bestv" "$v"; then best=$bin bestv=$v; fi
  done
  [ -n "$best" ] && printf '%s\n' "$best"
}

# Update-Hinweis passend zur Installationsart
update_hint() {
  target=$1
  if [ -L "$target" ]; then target=$(readlink "$target"); fi
  case $target in
    *"/Application Support/Claude/"*) say "Claude-Desktop-App aktualisieren (Menü Claude > Nach Updates suchen)." ;;
    *Caskroom* | */homebrew/* | */Homebrew/*) say "brew upgrade --cask claude-code" ;;
    *node_modules*) say "npm install -g @anthropic-ai/claude-code@latest" ;;
    *) say "claude update" ;;
  esac
}

# Git wird für GitHub-Marketplaces gebraucht. /usr/bin/git ist ohne
# Command Line Tools nur ein Platzhalter, der einen Dialog öffnet.
need_git() {
  g=$(command -v git 2>/dev/null) || g=
  if [ -n "$g" ] && [ "$g" != /usr/bin/git ]; then return 0; fi
  xcode-select -p >/dev/null 2>&1 </dev/null && return 0
  die "Git fehlt (Xcode Command Line Tools). Bitte zuerst im Terminal \`xcode-select --install\` ausführen und den Installer danach erneut starten."
}

# Auto-Update in einer JSON-Datei setzen: Sicherung, temporäre Datei, mv
set_auto_update() {
  file=$1 kind=$2
  [ -f "$file" ] || { warn "$file fehlt, Auto-Update dort nicht gesetzt."; return 1; }
  tmp="$file.aicosts-tmp.$$"
  cp -p "$file" "$tmp"
  res=$(jxa set-auto "$file" "$tmp" "$kind" "$MP_NAME") || res=error
  case $res in
    changed)
      cp -p "$file" "$file.aicosts-bak"
      mv -f "$tmp" "$file"
      say "Auto-Update gesetzt in $file (Sicherung: $file.aicosts-bak)"
      ;;
    unchanged)
      rm -f "$tmp"
      say "Auto-Update war bereits aktiv in $file"
      ;;
    *)
      rm -f "$tmp"
      warn "Auto-Update in $file nicht gesetzt ($res)."
      return 1
      ;;
  esac
}

main() {
  FORCE=${AICOSTS_FORCE:-0}
  for arg in "$@"; do
    case $arg in
      --force) FORCE=1 ;;
      *) die "Unbekanntes Argument: $arg" ;;
    esac
  done

  say "AICosts-Installer"

  # 1. System und Claude Code prüfen
  step "Prüfe System und Claude Code"
  [ "$(uname -s)" = Darwin ] || die "Dieser Installer ist nur für macOS."

  if [ -n "${AICOSTS_CLAUDE:-}" ]; then
    CLAUDE=$AICOSTS_CLAUDE
    [ -x "$CLAUDE" ] || die "AICOSTS_CLAUDE zeigt nicht auf ein ausführbares Programm: $CLAUDE"
  elif CLAUDE=$(command -v claude 2>/dev/null); then
    :
  elif CLAUDE=$(desktop_claude) && [ -n "$CLAUDE" ]; then
    say "Kein \`claude\` im PATH, verwende Claude Code aus der Desktop-App."
  else
    die "Claude Code nicht gefunden. Installation: https://code.claude.com/docs (z. B. \`curl -fsSL https://claude.ai/install.sh | bash\`), danach den Installer erneut starten."
  fi

  VERSION=$(claude_version "$CLAUDE") || die "Version von $CLAUDE nicht lesbar (\`claude --version\`)."
  say "Claude Code $VERSION ($CLAUDE)"
  if ! version_ge "$VERSION" "$MIN_VERSION"; then
    printf '\nFehler: Claude Code %s ist zu alt, AICosts braucht mindestens %s.\nBitte aktualisieren:\n  %s\n' \
      "$VERSION" "$MIN_VERSION" "$(update_hint "$CLAUDE")" >&2
    if [ -z "${AICOSTS_CLAUDE:-}" ] && D=$(desktop_claude) && [ -n "$D" ] \
      && DV=$(claude_version "$D") && version_ge "$DV" "$MIN_VERSION"; then
      printf 'Danach den Installer erneut starten. Die Desktop-App hat bereits %s; nur für die Desktop-App\ngeht auch: curl -fsSL https://raw.githubusercontent.com/JMTronic/aicosts-client/main/install.sh | AICOSTS_CLAUDE="%s" sh\n' "$DV" "$D" >&2
    else
      printf 'Danach den Installer erneut starten.\n' >&2
    fi
    exit 1
  fi

  CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  PLUGINS_DIR=${CLAUDE_CODE_PLUGIN_CACHE_DIR:-$CONFIG_DIR/plugins}
  SETTINGS="$CONFIG_DIR/settings.json"
  KNOWN="$PLUGINS_DIR/known_marketplaces.json"

  # 2. Marketplace
  SOURCE=${AICOSTS_MARKETPLACE:-$DEFAULT_SOURCE}
  SOURCE_ABS=
  if [ -d "$SOURCE" ]; then SOURCE_ABS=$(cd "$SOURCE" && pwd); fi

  step "Marketplace „$MP_NAME“"
  list=$(cl plugin marketplace list --json 2>/dev/null) || die "\`claude plugin marketplace list\` ist fehlgeschlagen."
  current=$(jxa mp-source "$list" "$MP_NAME") || die "Marketplace-Liste nicht lesbar."

  if [ -n "$current" ]; then
    value=${current#*:}
    if [ "$value" != "$SOURCE" ] && { [ -z "$SOURCE_ABS" ] || [ "$value" != "$SOURCE_ABS" ]; }; then
      if [ "$FORCE" = 1 ]; then
        say "Vorhandener Marketplace „$MP_NAME“ hat die Quelle $current, wird durch $SOURCE ersetzt (--force)."
        out=$(cl plugin marketplace remove "$MP_NAME" 2>&1) || die "Entfernen des alten Marketplace fehlgeschlagen:
$out"
        current=
      else
        warn "Marketplace „$MP_NAME“ existiert bereits mit der Quelle $current (erwartet: $SOURCE)."
        warn "Er wird beibehalten und nur aktualisiert. Umstellen mit: … | AICOSTS_FORCE=1 sh"
      fi
    fi
  fi

  if [ -z "$current" ]; then
    [ -n "$SOURCE_ABS" ] || need_git
    out=$(cl plugin marketplace add "${SOURCE_ABS:-$SOURCE}" --scope user 2>&1) || die "Marketplace konnte nicht hinzugefügt werden:
$out"
    say "Hinzugefügt: ${SOURCE_ABS:-$SOURCE}"
  else
    out=$(cl plugin marketplace update "$MP_NAME" 2>&1) || die "Marketplace-Update fehlgeschlagen:
$out"
    say "Aktualisiert: $current"
  fi

  # 3. Plugin
  step "Plugin $PLUGIN_ID"
  plist=$(cl plugin list --json 2>/dev/null) || die "\`claude plugin list\` ist fehlgeschlagen."
  state=$(jxa plugin-state "$plist" "$PLUGIN_ID") || die "Plugin-Liste nicht lesbar."
  OLD_VERSION=
  if [ -z "$state" ]; then
    out=$(cl plugin install "$PLUGIN_ID" --scope user 2>&1) || die "Installation fehlgeschlagen:
$out"
    say "Installiert."
  else
    OLD_VERSION=${state#* }
    out=$(cl plugin update "$PLUGIN_ID" --scope user 2>&1) || die "Plugin-Update fehlgeschlagen:
$out"
    case $state in
      disabled*)
        out=$(cl plugin enable "$PLUGIN_ID" --scope user 2>&1) || die "Aktivieren fehlgeschlagen:
$out"
        say "War deaktiviert, jetzt aktiviert."
        ;;
    esac
  fi
  plist=$(cl plugin list --json 2>/dev/null) || plist='[]'
  state=$(jxa plugin-state "$plist" "$PLUGIN_ID") || state=
  case $state in
    enabled*) NEW_VERSION=${state#* } ;;
    *) die "Plugin $PLUGIN_ID ist nach der Installation nicht aktiv (Status: ${state:-fehlt})." ;;
  esac
  if [ -n "$OLD_VERSION" ]; then
    if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then say "Bereits aktuell: Version $NEW_VERSION."
    else say "Aktualisiert: $OLD_VERSION -> $NEW_VERSION."; fi
  else
    say "Version $NEW_VERSION."
  fi

  # 4. Auto-Update (kein CLI-Schalter; gleiche Felder wie die /plugin-Oberfläche)
  step "Auto-Update"
  AUTO_OK=1
  set_auto_update "$KNOWN" known || AUTO_OK=0
  set_auto_update "$SETTINGS" settings || AUTO_OK=0
  [ "$AUTO_OK" = 1 ] || warn "Auto-Update ggf. von Hand einschalten: /plugin > Marketplaces > $MP_NAME > Enable auto-update."

  # 5. Abschluss
  step "Fertig"
  if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
    say "AICosts $NEW_VERSION ist installiert, es gab nichts zu aktualisieren."
    say "Falls noch nicht angemeldet: in Claude Code /aicosts login eingeben."
  elif [ -n "$OLD_VERSION" ]; then
    say "AICosts wurde auf $NEW_VERSION aktualisiert."
    say "Claude Code komplett neu starten (Terminal-Sessions und Desktop-App)."
    say "/reload-plugins lädt aktualisierte Plugins NICHT neu."
    say "Falls noch nicht angemeldet: danach /aicosts login eingeben."
  else
    say "AICosts $NEW_VERSION ist installiert."
    say "Claude Code neu starten (laufende Sessions: /reload-plugins), dann /aicosts login eingeben."
  fi
}

main "$@"
