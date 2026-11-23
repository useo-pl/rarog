#!/usr/bin/env bash
# Sufit ruchu wychodzącego relaya: htb 100 Mbit/s z fq_codel na interfejsie VPS. Bez tego drzewa relay nie startuje.
#   apply  — zakłada drzewo qdisc (relay-tc.service, oneshot); pełne drzewo zostawia bez zmian
#   check  — kod 0 tylko przy pełnym drzewie: htb 1: root, klasa 1:10 100Mbit, fq_codel 10: pod 1:10
#            (ExecStartPre relaya; sam fq_codel w roocie, domyślny w Ubuntu, NIE przechodzi)
#   cron   — check; przy braku zatrzymuje iroh-relay i pisze ALERT (syslog relay-alert + plik alertów)
# Interfejs: zmienna RELAY_TC_IF, inaczej linia RELAY_TC_IF=<nazwa> z /etc/iroh-relay/tc.conf (pisze go install.sh;
# czytana, nie wykonywana), inaczej eth0.
set -euo pipefail

CONF="${RELAY_TC_CONF:-/etc/iroh-relay/tc.conf}"
IF="${RELAY_TC_IF:-}"
if [[ -z "$IF" && -r "$CONF" ]]; then
  IF="$(sed -n 's/^RELAY_TC_IF=\([A-Za-z0-9_.-]*\)$/\1/p' "$CONF" | tail -n 1)"
fi
IF="${IF:-eth0}"
ALERT_LOG="${RELAY_ALERT_LOG:-/var/log/relay-alert.log}"

# Pełne drzewo zostaje (htb nie ma operacji change: `tc qdisc replace` na istniejącym htb 1: kończy się błędem
# „Change operation not supported”), każde inne idzie do kosza i powstaje od zera.
apply() {
  if check 2>/dev/null; then return 0; fi
  tc qdisc del dev "$IF" root 2>/dev/null || true
  tc qdisc add dev "$IF" root handle 1: htb default 10
  tc class add dev "$IF" parent 1: classid 1:10 htb rate 100mbit ceil 100mbit
  tc qdisc add dev "$IF" parent 1:10 handle 10: fq_codel
  check
}

check() {
  local q c
  q="$(tc qdisc show dev "$IF")"
  c="$(tc class show dev "$IF")"
  grep -q '^qdisc htb 1: root ' <<<"$q" || { echo "relay-tc: no htb 1: root on $IF" >&2; return 1; }
  grep -q '^qdisc fq_codel 10: parent 1:10 ' <<<"$q" || { echo "relay-tc: no fq_codel 10: under 1:10" >&2; return 1; }
  grep -Eq '^class htb 1:10 root .*rate 100Mbit ceil 100Mbit' <<<"$c" || { echo "relay-tc: class 1:10 is not 100Mbit" >&2; return 1; }
  return 0
}

# Najpierw stop, potem alert: porażka logger albo zapisu pliku (pełny dysk) nie może zostawić relaya bez sufitu.
cron_check() {
  if check 2>/dev/null; then return 0; fi
  systemctl stop iroh-relay.service || true
  local msg
  msg="ALERT relay-tc: no qdisc on $IF, stopping iroh-relay ($(date -u +%FT%TZ))"
  logger -t relay-alert -p daemon.crit "$msg" || true
  echo "$msg" >>"$ALERT_LOG" || true
  return 1
}

case "${1:-}" in
  apply) apply ;;
  check) check ;;
  cron) cron_check ;;
  *) echo "usage: $0 apply|check|cron" >&2; exit 2 ;;
esac
