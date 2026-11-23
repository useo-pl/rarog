#!/usr/bin/env bash
#
# Pełny restart serwera Raroga — wykonawca `rarog restart` (`pnpm run restart`, `server/src/cli/restart.ts`).
#
# tsx NIE przeładowuje kodu na żywo — każda zmiana w server/ albo shared/ wymaga tego
# restartu.
# Restart nie rusza paneli w herdr: sesje `claude` żyją dalej, Rarog po starcie
# odtwarza je resyncem z `agent.list`.
#
# Front `rarog restart` bierze blokadę, ustala nadzorcę serwera, sprawdza konfigurację (`rarog serve --check`)
# i dopiero wtedy woła ten skrypt z parametrami `RAROG_RESTART_*` i `RAROG_LOG`. Środowisko serwera składa
# `rarog serve` z ~/.config/rarog; ten skrypt tylko steruje cyklem życia: zatrzymuje, uruchamia i sprawdza health.
# Bez parametrów odmawia, zanim cokolwiek zatrzyma.
#
# TRZY drogi startu, każdą wybiera front, bo dwaj nadzorcy nie mogą bić się o jeden port:
# - macOS, launchd service `ai.rarog.server` (`RAROG_RESTART_LABEL`) → stop here, then `launchctl kickstart`
#   without `-k` (launchd starts `rarog serve` unless `KeepAlive` already did; `KeepAlive` keeps it up after that);
# - macOS bez usługi (`RAROG_RESTART_SERVE=rarog`) → `nohup node bin/rarog.mjs serve`;
# - Linux (platforma z `uname -s`): wyłącznie jednostka systemd --user `rarog.service` (`RAROG_RESTART_UNIT`,
#   `systemctl --user restart`); bez niej odmowa — `nohup` obok nadzorcy z `Restart=always` dałby drugi serwer.
set -euo pipefail
cd "$(dirname "$0")/.."
# Korzeń instalacji (klon albo katalog paczki npm) bez dowiązań: `rarog serve` robi tu `chdir` przed `execve`,
# więc to katalog roboczy serwera tej instalacji (filtr wzorców stopu niżej).
INSTALL_DIR="$(pwd -P)"

# --- Parametry od `rarog restart` ---
# Każdy poza zdaniem naprawy hooka to WYBÓR z zamkniętej listy, nigdy komenda do wykonania; zła albo brakująca
# wartość = kod 64, zanim cokolwiek się zatrzyma. Wartości nie wypisujemy: parametr nie przyszedł od `rarog restart`.
#   RAROG_RESTART_LABEL  etykieta usługi launchd (`ai.rarog.server`), tylko na macOS;
#   RAROG_RESTART_SERVE  `rarog` = start bez usługi przez `nohup node bin/rarog.mjs serve`, tylko na macOS;
#   RAROG_RESTART_UNIT   jednostka systemd --user (`rarog.service`), tylko na Linuksie;
#   RAROG_RESTART_PORT   port serwera z `rarog serve --check` (1–65535), zawsze;
#   RAROG_LOG            log serwera (`<katalog danych>/server.log`), zawsze;
#   RAROG_RESTART_HOOK_REPAIR  zdanie naprawy kopii hooka przy `hook: stale` z komendami tej instalacji
#                        (`server/src/install/repair.ts`), zawsze; tylko wypisywane, nigdy wykonywane; znak
#                        sterujący (także nowa linia) albo ponad 300 znaków = kod 64.
# Wybór startu jest dokładnie jeden: etykieta, `SERVE` albo jednostka.
SERVICE_LABEL="ai.rarog.server"
UNIT_NAME="rarog.service"
bad_param() {
  echo "restart.sh: bad parameter $1 — only \`rarog restart\` (pnpm run restart) sets it." >&2
  exit 64
}
missing_param() {
  echo "restart.sh: missing parameter $1 — only \`rarog restart\` (pnpm run restart) sets it." >&2
  exit 64
}
case "${RAROG_RESTART_LABEL:-}" in
  '' | "$SERVICE_LABEL") ;;
  *) bad_param RAROG_RESTART_LABEL ;;
esac
case "${RAROG_RESTART_PORT:-}" in
  '') ;;
  *[!0-9]* | 0*) bad_param RAROG_RESTART_PORT ;;
  *) if [ "${#RAROG_RESTART_PORT}" -gt 5 ] || [ "$RAROG_RESTART_PORT" -gt 65535 ]; then
       bad_param RAROG_RESTART_PORT
     fi ;;
esac
case "${RAROG_RESTART_SERVE:-}" in
  '' | rarog) ;;
  *) bad_param RAROG_RESTART_SERVE ;;
esac
case "${RAROG_RESTART_UNIT:-}" in
  '' | "$UNIT_NAME") ;;
  *) bad_param RAROG_RESTART_UNIT ;;
esac
HOOK_REPAIR="${RAROG_RESTART_HOOK_REPAIR:-}"
case "$HOOK_REPAIR" in
  *[[:cntrl:]]*) bad_param RAROG_RESTART_HOOK_REPAIR ;;
esac
[ "${#HOOK_REPAIR}" -le 300 ] || bad_param RAROG_RESTART_HOOK_REPAIR
if [ -n "${RAROG_RESTART_UNIT:-}" ] && [ -n "${RAROG_RESTART_LABEL:-}${RAROG_RESTART_SERVE:-}" ]; then
  {
    echo "restart.sh: RAROG_RESTART_UNIT excludes RAROG_RESTART_LABEL and RAROG_RESTART_SERVE — the parameters"
    echo "are set only by \`rarog restart\` (pnpm run restart)."
  } >&2
  exit 64
fi
if [ -n "${RAROG_RESTART_LABEL:-}" ] && [ -n "${RAROG_RESTART_SERVE:-}" ]; then
  {
    echo "restart.sh: RAROG_RESTART_LABEL and RAROG_RESTART_SERVE exclude each other — only"
    echo "\`rarog restart\` (pnpm run restart) sets the parameters."
  } >&2
  exit 64
fi

PLATFORM="$(uname -s)"
if [ "$PLATFORM" = Linux ]; then
  if [ -z "${RAROG_RESTART_UNIT:-}" ]; then
    {
      echo "restart.sh: on Linux only the systemd --user unit $UNIT_NAME starts the server — use"
      echo "\`rarog restart\` (pnpm run restart), which checks it and passes it to this script; without the unit:"
      echo "rarog service install. Nothing was stopped."
    } >&2
    exit 1
  fi
else
  if [ -n "${RAROG_RESTART_UNIT:-}" ]; then
    # Jednostki systemd poza Linuksem nie ma: `rarog restart` nigdy jej tu nie poda.
    bad_param RAROG_RESTART_UNIT
  fi
  if [ -z "${RAROG_RESTART_LABEL:-}${RAROG_RESTART_SERVE:-}" ]; then
    # Uruchomiony wprost: wybór startu, port i log ustala front, a środowisko serwera składa `rarog serve`.
    {
      echo "restart.sh: this script runs under \`rarog restart\` — run \`pnpm run restart\` (rarog restart), which"
      echo "checks the config and passes the parameters to this script. Nothing was stopped."
    } >&2
    exit 1
  fi
fi
[ -n "${RAROG_RESTART_PORT:-}" ] || missing_param RAROG_RESTART_PORT
LOG="${RAROG_LOG:-}"
[ -n "$LOG" ] || missing_param RAROG_LOG
[ -n "$HOOK_REPAIR" ] || missing_param RAROG_RESTART_HOOK_REPAIR

# Usługa z etykiety musi być załadowana PRZED zatrzymaniem: `nohup` obok jej plistu dałby drugiego nadzorcę,
# a odmowa po zatrzymaniu zostawiłaby serwer wyłączony. Front widział ją załadowaną przed chwilą.
if [ -n "${RAROG_RESTART_LABEL:-}" ]; then
  LAUNCHD_TARGET="gui/$(id -u)/$RAROG_RESTART_LABEL"
  if ! launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
    {
      echo "ERROR: service $LAUNCHD_TARGET is not loaded (no nohup start next to the service). Check:"
      echo "launchctl print $LAUNCHD_TARGET, then pnpm run restart. Nothing was stopped."
    } >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$LOG")"

# Port z konfiguracji — jedyny fakt o serwerze, który NIE zależy od tego, jak tsx składa argv.
PORT="$RAROG_RESTART_PORT"
# Chwila startu tego skryptu: `/health` niesie `uptime`, więc da się sprawdzić, czy odpowiada
# proces MŁODSZY od restartu, czy stary, którego nikt nie zabił (patrz health check niżej).
SCRIPT_START="$(date +%s)"

# --- Stop: proces node/tsx (`rarog serve` robi `execve` na tsx, w paczce npm na node, więc procesu frontu CLI
# już nie ma) ---
#
# The FIRST criterion is the PORT, not argv. Command-line patterns are coupled to a tsx implementation detail:
# `pgrep -f "tsx server/src/index.ts"` matches nothing (the `.bin/tsx` wrapper has the shebang
# `#!/usr/bin/env node`, so the word "tsx" never stands next to the script path), and a loader pattern catches
# only the CHILD process, never the parent that launchd supervises. A tsx bump that stops passing
# `--import …/loader.mjs` would break the mechanism silently: `running()` would say "no server" and the new
# instance would die on EADDRINUSE in the log. The port does not depend on any of that.
#
# Wzorce argv ZOSTAJĄ jako uzupełnienie (dziś poprawne: w klonie `cli.mjs …` to rodzic,
# `loader.mjs …` potomek; w paczce npm jeden proces `node server/src/index.js`, bez tsx) — łapią
# proces, który jeszcze nie zdążył zabindować portu, i działają tam, gdzie nie ma `lsof` (proces
# złapany wzorcem jest nasz tylko w katalogu roboczym tej instalacji, `production_candidate` niżej). Pod
# launchd cały blok też ma sens: ubija zabłąkany serwer z `nohup` sprzed instalacji usługi,
# który inaczej trzymałby port, a instancja launchd padałaby w pętli.
STOP_PATTERNS=("cli.mjs server/src/index.ts" "loader.mjs server/src/index.ts" "node server/src/index.js")

# PID-y NASŁUCHUJĄCE na porcie. Bez `lsof` (odchudzony PATH, Linux bez pakietu) `ss` z iproute2:
# `users:(("node",pid=408,fd=3))`, a pól `pid=` może być kilka (pomiar na systemd 255). Bez
# obu pusto — wtedy zostają wzorce.
listeners() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -Hltnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9][0-9]*' | cut -d= -f2 | sort -u || true
  fi
}

# The demo server (`pnpm run demo:server` from agent worktrees under the `ios-check.sh` XCUITest) has the same
# argv, and a bare `pkill -f` on the pattern would kill it on EVERY production restart. So a process caught by
# a pattern is our server only when its environment (`ps -E`) has neither `RAROG_DEMO=1` nor a `RAROG_PORT`
# other than this restart's port. An environment that cannot be read (the process already exited) → not ours.
# On Linux procps-ng does not know `ps -E` ("unsupported SysV option"): the BSD form `ps eww` gives the same
# shape (the command, then the environment after a space).
# Wartość porównujemy dosłownie: `+18952` czy `018952` serwer też przyjmuje (`Number(raw)` w `config.ts`),
# więc każdy zapis inny niż port tego restartu to cudzy serwer.
# Najpierw jednak katalog roboczy: wzorce mają ścieżkę względną (`node server/src/index.js` pasuje do serwera
# każdego projektu Node o takim układzie, bez żadnej zmiennej Raroga), więc naszym jest tylko proces, którego
# katalog roboczy to korzeń tej instalacji (`INSTALL_DIR`). Katalogu nie da się odczytać → nie nasz.
PORT_ENV_RE=' RAROG_PORT=([^ ]*)'
pid_cwd() {
  if [ "$PLATFORM" = Linux ]; then
    readlink "/proc/$1/cwd" 2>/dev/null || true
  else
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true
  fi
}
production_candidate() {
  local line
  [ "$(pid_cwd "$1")" = "$INSTALL_DIR" ] || return 1
  if [ "$PLATFORM" = Linux ]; then
    line="$(ps eww -o command= -p "$1" 2>/dev/null)" || return 1
  else
    line="$(ps -Eww -o command= -p "$1" 2>/dev/null)" || return 1
  fi
  [ -n "$line" ] || return 1
  case " $line " in *" RAROG_DEMO=1 "*) return 1 ;; esac
  if [[ " $line" =~ $PORT_ENV_RE ]] && [ "${BASH_REMATCH[1]}" != "$PORT" ]; then
    return 1
  fi
  return 0
}

pattern_pids() {
  local pattern pid
  for pattern in "${STOP_PATTERNS[@]}"; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
      if production_candidate "$pid"; then echo "$pid"; fi
    done
  done
}

# PID of the instance launchd runs under the service label: `pid = N` at the top level of `launchctl print` (one tab;
# nested blocks are indented deeper). Empty without a label or without a running instance. That process is the
# server of this service by definition, so it skips the port and working directory filters: after a port change in
# config.json the old server listens on the old port with the old `RAROG_PORT`, and neither `listeners` nor
# `pattern_pids` finds it. It has to stop here, because `kickstart` without `-k` leaves a running instance alone.
service_pid() {
  [ -n "${RAROG_RESTART_LABEL:-}" ] || return 0
  launchctl print "$LAUNCHD_TARGET" 2>/dev/null | awk '/^\tpid = [0-9]+$/ { print $3; exit }' || true
}

running() {
  [ -n "$(listeners)" ] && return 0
  [ -n "$(pattern_pids)" ] && return 0
  return 1
}

# PIDs that `stop_once` signalled. Under a supervisor the wait and SIGKILL below look only at these: launchd
# (`KeepAlive`) and systemd (`Restart=always`) start a new instance as soon as the old one exits, so "something
# listens on the port" says nothing about the old process. The new instance belongs to the start step
# (`kickstart`, `systemctl --user restart`) and gets no signal here.
SIGNALLED=()

stop_once() {
  local signal="$1" pid
  # Tablica, nie gołe rozwinięcie: `listeners` potrafi zwrócić kilka PID-ów (zabłąkana
  # instancja obok nowej), a `set -u` nie lubi pustej tablicy w rozwinięciu.
  SIGNALLED=()
  while IFS= read -r pid; do [ -n "$pid" ] && SIGNALLED+=("$pid"); done <<EOF
$(listeners)
EOF
  while IFS= read -r pid; do [ -n "$pid" ] && SIGNALLED+=("$pid"); done <<EOF
$(pattern_pids)
EOF
  while IFS= read -r pid; do [ -n "$pid" ] && SIGNALLED+=("$pid"); done <<EOF
$(service_pid)
EOF
  [ "${#SIGNALLED[@]}" -eq 0 ] || kill "$signal" "${SIGNALLED[@]}" 2>/dev/null || true
}

# Signalled PIDs that have not exited, one per line. A zombie has exited (it holds no port) and only waits for
# its parent to reap it, so it counts as gone. Only a confirmed zombie is skipped: when `ps` fails or prints
# nothing, the PID stays on the list and the next `kill -0` sees a real exit.
signalled_alive() {
  local pid state
  [ "${#SIGNALLED[@]}" -gt 0 ] || return 0
  for pid in "${SIGNALLED[@]}"; do
    kill -0 "$pid" 2>/dev/null || continue
    state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
    case "$state" in *Z*) ;; *) echo "$pid" ;; esac
  done
}

stop_once -TERM
if [ "$PLATFORM" = Linux ] || [ -n "${RAROG_RESTART_LABEL:-}" ]; then
  for _ in $(seq 1 20); do
    [ -n "$(signalled_alive)" ] || break
    sleep 0.25
  done
  survivors=()
  while IFS= read -r pid; do [ -n "$pid" ] && survivors+=("$pid"); done <<EOF
$(signalled_alive)
EOF
  if [ "${#survivors[@]}" -gt 0 ]; then
    echo "Server did not exit after SIGTERM — sending SIGKILL." >&2
    kill -KILL "${survivors[@]}" 2>/dev/null || true
    sleep 1
  fi
else
  # No supervisor (`nohup` start): nothing restarts the server behind this script, so whatever still listens on
  # the port or matches the patterns is an old server, also one that began to listen after the first scan.
  for _ in $(seq 1 20); do
    running || break
    sleep 0.25
  done
  if running; then
    echo "Server did not exit after SIGTERM — sending SIGKILL." >&2
    stop_once -KILL
    sleep 1
  fi
fi

# --- Start ---
if [ "$PLATFORM" = Linux ]; then
  # `restart` jednostki (`Restart=always`) zabija całą jej grupę cgroup — rodzica i potomka tsx — i
  # startuje od nowa. Kod 0 nie znaczy zdrowia (proces padający od razu i zajęty port też dają 0),
  # więc rozstrzyga health niżej; kod różny od 0 to błąd, nigdy przejście na `nohup`.
  echo "start: systemd --user ($RAROG_RESTART_UNIT) — systemctl --user restart"
  unit_status=0
  systemctl --user restart "$RAROG_RESTART_UNIT" || unit_status=$?
  if [ "$unit_status" -ne 0 ]; then
    {
      echo "ERROR: systemctl --user restart $RAROG_RESTART_UNIT exited with code $unit_status — the server"
      echo "did not start (no nohup start next to the unit). Check: systemctl --user status"
      echo "$RAROG_RESTART_UNIT, log: $LOG"
    } >&2
    exit 1
  fi
elif [ -n "${RAROG_RESTART_LABEL:-}" ]; then
  # The old process has exited (the stop step above waits for it, including the instance launchd reported under
  # the label), so whatever runs under the label now was started after it, with the code and config on disk. `KeepAlive` respawns the job as soon as the old process exits;
  # `kickstart` without `-k` starts it only when that has not happened yet, and never a second instance: launchd
  # runs one process per label. `-k` would kill the respawned instance seconds after its start, and launchd
  # throttles a job that ran shorter than its throttle interval (10 s by default): "Pushing respawn out by
  # 10 seconds", the restart window that hooks waiting for consent see as a server that is gone. A restart within
  # 10 s of the previous start still waits for that throttle: `kickstart` does not override it.
  echo "start: launchd ($LAUNCHD_TARGET) — kickstart"
  launchctl kickstart "$LAUNCHD_TARGET"
else
  # Bez usługi (`RAROG_RESTART_SERVE=rarog`) log jest NADPISYWANY przy każdym starcie (pod launchd —
  # dopisywany, bo plik otwiera launchd). `node` to węzeł `rarog restart` (stoi pierwszy w PATH);
  # `rarog serve` sam składa środowisko serwera z ~/.config/rarog i odcina resztę środowiska tego
  # skryptu.
  echo "start: nohup node bin/rarog.mjs serve (service $SERVICE_LABEL is not loaded)"
  nohup node bin/rarog.mjs serve >"$LOG" 2>&1 &
  disown
fi

# --- Health check ---
# `/health` niesie readiness: `herdr` (żywy ping gniazda) i `term` (terminal złożony).
# Sam status 200 znaczy tylko „Node wstał" — Rarog bez herdr to pusta lista i baner, więc
# restart z martwym herdr MA być czerwony, a nie wyglądać na udany.
# `-m 5` > sufit pingu herdr w serwerze (1,5 s): przy half-open herdr odpowiedź przychodzi
# później, ale przychodzi — ucięcie połączenia w połowie dawałoby fałszywe „nie odpowiada".
HERDR_RETRIES=10
for _ in $(seq 1 20); do
  sleep 0.5
  if body="$(curl -sf -m 5 "http://127.0.0.1:$PORT/health")"; then
    # A server busy right after its start (reading many transcripts) can miss its herdr ping deadline on the first
    # /health. A few more answers tell that from a dead herdr, which stays false through every retry.
    herdr_retries=0
    while ! printf '%s' "$body" | grep -q '"herdr":true' && [ "$herdr_retries" -lt "$HERDR_RETRIES" ]; do
      if [ "$herdr_retries" -eq 0 ]; then
        echo "herdr: false on the first /health — retrying for up to $HERDR_RETRIES s"
      fi
      herdr_retries=$((herdr_retries + 1))
      sleep 1
      if next="$(curl -sf -m 5 "http://127.0.0.1:$PORT/health")"; then body="$next"; fi
    done
    echo "OK: $body"
    echo "log: $LOG"
    # JSON z serwera jest zwarty (JSON.stringify bez spacji) — grep po parze klucz:wartość
    # wystarcza i nie dokłada zależności od jq/node w skrypcie startowym.
    herdr=false; term=false
    if printf '%s' "$body" | grep -q '"herdr":true'; then herdr=true; fi
    if printf '%s' "$body" | grep -q '"term":true'; then term=true; fi
    # `hook` to SŁOWO, nie bool: ok / missing / mismatch / stale (starszy serwer mówi `brak` zamiast
    # `missing`; skrypt drukuje słowo, jakie przyszło, i porównuje tylko ze `stale`) — rejestracja hooka treści
    # w ustawieniach Claude Code i zgodność kopii w ~/.claude/hooks/rarog/ z repo.
    # Nie jest warunkiem zielonego restartu (Rarog bez hooka działa na kartach z ekranu), ale
    # ma być widoczne, bo degradacja jest inaczej cicha.
    hook="$(printf '%s' "$body" | sed -n 's/.*"hook":"\([a-z]*\)".*/\1/p')"
    echo "herdr: $herdr · term: $term · hook: ${hook:-?}"
    if [ "$hook" = stale ]; then
      printf 'hook: the copy in ~/.claude/hooks/rarog/ differs from the repo — %s\n' "$HOOK_REPAIR"
    fi
    # Czy odpowiada NOWY proces? `/health` niesie `uptime`, a my znamy chwilę startu tego
    # skryptu — proces starszy od restartu znaczy, że zatrzymanie chybiło i pracujesz dalej
    # na kodzie sprzed zmiany. To jest DOKŁADNIE ta awaria, przy której restart jest konieczny
    # (tsx nie przeładowuje kodu na żywo), a bez tego sprawdzenia kończyła się zielonym „OK".
    uptime_s="$(printf '%s' "$body" | sed -n 's/.*"uptime":\([0-9][0-9]*\).*/\1/p')"
    elapsed=$(( $(date +%s) - SCRIPT_START ))
    if [ -n "$uptime_s" ] && [ "$uptime_s" -gt $((elapsed + 5)) ]; then
      {
        echo "ERROR: /health is answered by a process older than this restart (uptime ${uptime_s}s"
        echo "> ${elapsed}s since the script started) — the stop MISSED, and the new instance"
        echo "probably failed with EADDRINUSE. Check: lsof -ti tcp:$PORT, log: $LOG"
      } >&2
      exit 3
    fi
    if [[ "$herdr" != true ]]; then
      {
        echo "ERROR: Rarog is up, but the herdr socket does not respond — the session list will be empty."
        echo "Check: that herdr runs (\`herdr agent list\`), that the socket"
        echo "\$HOME/.config/herdr/herdr.sock exists, and the server log: $LOG"
      } >&2
      exit 2
    fi
    exit 0
  fi
done
echo "Server does not respond on /health — last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
