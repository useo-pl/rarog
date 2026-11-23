#!/usr/bin/env bash
# Kopia cert_dir relaya (konto ACME i certyfikat Let's Encrypt). Bez kopii utrata VPS to nowe zamówienie
# certyfikatu, a Let's Encrypt wydaje najwyżej 5 duplikatów na tydzień.
#
#   relay-certs-backup.sh [cel]
#
# Zawsze składa archiwum lokalne /var/backups/iroh-relay/certs.tar (katalog 0700, plik 0600, tryby i właściciel
# plików w środku zachowane). Cel: argument, inaczej RELAY_BACKUP_TARGET z /etc/iroh-relay/backup.conf (pusty =
# kopia tylko lokalna, nic nie wychodzi z VPS). Cel z dwukropkiem (`host:katalog/`) idzie przez scp, bez niego to
# katalog lokalny (np. zamontowany wolumen). Archiwum w celu dostaje nazwę z datą UTC. Odtworzenie:
# install.sh --certs <archiwum>. Porażka wysyłki = alert (syslog relay-alert i plik alertów), kod 1.
set -euo pipefail

CERT_PARENT="${RELAY_CERT_PARENT:-/var/lib/iroh-relay}"
BACKUP_DIR="${RELAY_BACKUP_DIR:-/var/backups/iroh-relay}"
CONF="${RELAY_BACKUP_CONF:-/etc/iroh-relay/backup.conf}"
ALERT_LOG="${RELAY_ALERT_LOG:-/var/log/relay-alert.log}"

target="${1:-}"
if [[ -z "$target" && -r "$CONF" ]]; then
  target="$(sed -n 's/^RELAY_BACKUP_TARGET=\(.*\)$/\1/p' "$CONF" | tail -n 1)"
fi

alert() {
  local msg
  msg="ALERT relay-certs-backup: $1 ($(date -u +%FT%TZ))"
  logger -t relay-alert -p daemon.crit "$msg" || true
  echo "$msg" >>"$ALERT_LOG" || true
}

if [[ ! -d "$CERT_PARENT/certs" ]]; then
  alert "missing directory $CERT_PARENT/certs"
  exit 1
fi

umask 077
mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
archive="$BACKUP_DIR/certs.tar"
tar -C "$CERT_PARENT" --numeric-owner -cf "$archive.tmp" certs
chmod 0600 "$archive.tmp"
mv -f "$archive.tmp" "$archive"

if [[ -z "$target" ]]; then
  echo "relay-certs-backup: archive $archive; no target, nothing sent"
  exit 0
fi

name="iroh-relay-certs-$(date -u +%Y%m%dT%H%M%SZ).tar"
if [[ "$target" == *:* ]]; then
  if ! scp -q -p -o BatchMode=yes "$archive" "${target%/}/$name"; then
    alert "scp to the target failed"
    exit 1
  fi
else
  if ! install -m 0600 "$archive" "${target%/}/$name"; then
    alert "writing to the target directory failed"
    exit 1
  fi
fi
echo "relay-certs-backup: archive $archive, copy $name at the target"
