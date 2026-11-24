#!/bin/bash
# CI-Diagnose und -Freigabe des Bedienungshilfen-Rechts für den Helfer (nur auf einem Runner benutzen, nie auf einem echten Mac).
# Aufruf: tcc.sh <autark-mac-helper>
# Schreibt Zeilen "TCC: …". Ändert nur die TCC-Datenbanken des Runners; scheitert nie (Exit 0), die Zeilen sagen, was geklappt hat.

HELPER="$1"
trusted() { "$HELPER" --probe 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('trusted'))" 2>/dev/null; }

echo "TCC: macOS $(sw_vers -productVersion) build $(sw_vers -buildVersion), arch $(uname -m), user $(id -un)"
echo "TCC: $(csrutil status 2>&1 | head -1)"
echo "TCC: trusted before = $(trusted)"

# Prozesskette von diesem Skript nach oben: eines dieser Programme ist der „verantwortliche“ Prozess, dem macOS das Recht zuordnet.
chain=()
pid=$$
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -z "$pid" ] || [ "$pid" -le 1 ] && break
  exe=$(ps -o comm= -p "$pid" 2>/dev/null | sed 's/^ *//')
  [ -n "$exe" ] && chain+=("$exe")
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
PY=$(python3 -c "import sys,os; print(os.path.realpath(sys.executable))" 2>/dev/null)
HELPER_ABS=$(cd "$(dirname "$HELPER")" && pwd)/$(basename "$HELPER")
clients=("$HELPER_ABS" "${chain[@]}" "$PY" /bin/bash /bin/sh /usr/bin/python3)
echo "TCC: chain = ${chain[*]}"

for db in "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "/Library/Application Support/com.apple.TCC/TCC.db"; do
  echo "TCC: rows in $db:"
  sudo sqlite3 "$db" "select service, client, auth_value from access where service='kTCCServiceAccessibility';" 2>&1 | head -20 | sed 's/^/TCC:   /'
done

if [ "$(trusted)" != "True" ]; then
  echo "TCC: not trusted, inserting Accessibility grants for ${#clients[@]} clients"
  seen=""
  for client in "${clients[@]}"; do
    case " $seen " in *" $client "*) continue ;; esac
    seen="$seen $client"
    for db in "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "/Library/Application Support/com.apple.TCC/TCC.db"; do
      sudo sqlite3 "$db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) VALUES ('kTCCServiceAccessibility', '$client', 1, 2, 4, 1, 0);" 2>&1 | sed "s|^|TCC:   insert $client: |"
    done
  done
  sudo killall tccd 2>/dev/null
  sleep 2
  echo "TCC: trusted after insert = $(trusted)"
fi
echo "TCC: final trusted = $(trusted)"
exit 0
