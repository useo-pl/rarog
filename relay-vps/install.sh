#!/usr/bin/env bash
# Instalacja relaya iroh na VPS z Ubuntu (24.04 i nowsze, x86_64), jako root, z katalogu relay-vps/ skopiowanego
# na VPS. Idempotentna: drugi przebieg bez zmian w plikach niczego nie restartuje. Ten sam skrypt odtwarza relay
# pod nowym IP; z kopią cert_dir (--certs) relay nie zamawia nowego certyfikatu.
#
#   bash install.sh [--certs <archiwum certs.tar z relay-certs-backup.sh>]
#
# Przed krokami: zapora wpuszcza SSH tylko z tailscale0, więc bez działającego Tailscale skrypt kończy się kodem 2
# i niczego nie zmienia.
# Kroki:
#   1. pakiety z repo dystrybucji: nodejs, nftables, iproute2, cron, unattended-upgrades, curl, openssl;
#   2. iroh-relay 1.4.1 z wydania GitHub do /usr/local/bin, sumy sha256 archiwum i programu przypięte niżej;
#   3. użytkownik systemowy iroh-relay, pliki z repo: /opt/relay-vps, /etc/iroh-relay, jednostki systemd, cron,
#      unattended-upgrades (restart po aktualizacji o 04:00), retencja dziennika (journald 7 dni, relay poza
#      /var/log/syslog), /etc/nftables.conf (oryginał raz do .orig); the /usr/local/bin/relay-stats link;
#   4. bearer haka w /etc/iroh-relay/relay.env (0600) tylko wtedy, gdy pliku nie ma; wartość nie trafia na ekran;
#   5. kopia cert_dir z --certs tylko do pustego cert_dir; uprawnienia cert_dir zawsze 0700 i 0600;
#   6. zmiana nftables albo brak drzewa qdisc: najpierw wyłącznik czasowy (180 s, cofa zaporę i qdisc), potem
#      nftables i tc; relay startuje albo restartuje się tylko po zmianie swoich plików (znacznik restart-pending
#      przeżywa przerwany przebieg); na końcu każda usługa osobno, nieaktywna = kod 1.
# Po kroku 6 sprawdź SSH NOWYM połączeniem i dopiero wtedy zatrzymaj wyłącznik (polecenie na końcu wyjścia).
# Wyłącznik, który zadziała, zostawia VPS bez zapory i bez qdisc, a cron (relay-tc.sh cron) zatrzymuje wtedy relay.
set -euo pipefail

RELAY_VERSION=1.4.1
RELAY_URL="https://github.com/n0-computer/iroh/releases/download/v${RELAY_VERSION}/iroh-relay-v${RELAY_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
RELAY_TGZ_SHA256=eeceef0f06f04ad2644644cd80dd5733e64da46daf8a9f86d87a5ad5c13b06e4
RELAY_BIN_SHA256=137b3057720a3e26cdc6704d1079594cdbcc34d04f4b5116fc2eb848dce6d027
GUARD_UNIT=relay-install-cofnij

SRC="$(cd "$(dirname "$0")" && pwd)"
CERTS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --certs) CERTS="${2:-}"; shift 2 ;;
    *) echo "usage: bash install.sh [--certs <archive.tar>]" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" != 0 ]]; then echo "install.sh: requires root" >&2; exit 2; fi
if [[ "$(uname -m)" != x86_64 ]]; then echo "install.sh: the pinned relay binary is for x86_64 only" >&2; exit 2; fi
if [[ -n "$CERTS" && ! -r "$CERTS" ]]; then echo "install.sh: missing archive $CERTS" >&2; exit 2; fi
# The firewall lets SSH in only from tailscale0: without a running Tailscale it would cut SSH off (the VPS
# provider's console remains). The check runs before any change on the VPS. `tailscale status` exits 0 in the
# Starting state too, so an explicit BackendState Running and a tailnet address are required.
if grep -Eq '^[[:space:]]*iifname "tailscale0"' "$SRC/nftables.conf"; then
  if ! command -v tailscale >/dev/null 2>&1 \
    || ! tailscale status --json 2>/dev/null | grep -Eq '"BackendState": *"Running"' \
    || ! tailscale ip -4 >/dev/null 2>&1 || ! ip link show tailscale0 >/dev/null 2>&1; then
    echo "install.sh: the firewall lets SSH in only from the tailnet, and Tailscale on the VPS is not running" \
      "(tailscale status --json, tailscale ip -4, ip link show tailscale0); set up Tailscale first (relay-vps/README.md," \
      "Installation)" >&2
    exit 2
  fi
fi

# Zmienione pliki relaya (restart relaya), zapory (wyłącznik i przeładowanie) i dziennika (restart journald, rsyslog).
relay_changed=0
nft_changed=0
journal_changed=0
rsyslog_changed=0

# Znacznik restartu powstaje PRZED podmianą pliku, który wymaga restartu relaya, i znika dopiero po udanym restarcie
# i sprawdzeniu usług: przebieg przerwany w dowolnym miejscu zostawia go, a następny przebieg (który nie widzi już
# różnic w plikach) dokończy restart.
PENDING=/etc/iroh-relay/restart-pending
need_restart() {
  relay_changed=1
  install -d -m 0755 /etc/iroh-relay
  touch "$PENDING"
}

# put <źródło> <cel> <tryb> [relay|nft|journal|rsyslog|-]: kopiuje tylko różny plik.
put() {
  local src="$1" dst="$2" mode="$3" group="${4:--}"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    chmod "$mode" "$dst"
    return 0
  fi
  if [[ "$group" == relay ]]; then need_restart; fi
  install -D -m "$mode" "$src" "$dst"
  echo "install.sh: wrote $dst"
  case "$group" in
    nft) nft_changed=1 ;;
    journal) journal_changed=1 ;;
    rsyslog) rsyslog_changed=1 ;;
  esac
}

echo "== 1. packages"
need=()
for pkg in nodejs nftables iproute2 cron unattended-upgrades curl openssl; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || need+=("$pkg")
done
if [[ ${#need[@]} -gt 0 ]]; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${need[@]}"
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 18 ]]; then echo "install.sh: the adapter requires Node 18+ (found $node_major)" >&2; exit 2; fi

echo "== 2. iroh-relay $RELAY_VERSION"
if [[ -x /usr/local/bin/iroh-relay ]] && sha256sum /usr/local/bin/iroh-relay | grep -q "^$RELAY_BIN_SHA256 "; then
  echo "install.sh: /usr/local/bin/iroh-relay $RELAY_VERSION is already there"
else
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/relay.tgz" "$RELAY_URL"
  echo "$RELAY_TGZ_SHA256  $tmp/relay.tgz" | sha256sum -c --quiet
  tar -C "$tmp" -xzf "$tmp/relay.tgz" ./iroh-relay
  echo "$RELAY_BIN_SHA256  $tmp/iroh-relay" | sha256sum -c --quiet
  need_restart
  install -m 0755 "$tmp/iroh-relay" /usr/local/bin/iroh-relay
  rm -r -- "$tmp"
  echo "install.sh: wrote /usr/local/bin/iroh-relay"
fi

echo "== 3. user and files"
if ! id -u iroh-relay >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/iroh-relay --shell /usr/sbin/nologin iroh-relay
fi
install -d -m 0755 /opt/relay-vps /etc/iroh-relay
install -d -m 0700 /var/lib/relay-watch
put "$SRC/access-adapter.mjs" /opt/relay-vps/access-adapter.mjs 0644 relay
put "$SRC/relay-tc.sh" /opt/relay-vps/relay-tc.sh 0755
put "$SRC/relay-watch.mjs" /opt/relay-vps/relay-watch.mjs 0644
put "$SRC/relay-stats.mjs" /opt/relay-vps/relay-stats.mjs 0755
# relay-stats: load summary for root over SSH; the link changes nothing in the relay, so no restart.
if [[ "$(readlink /usr/local/bin/relay-stats || true)" != /opt/relay-vps/relay-stats.mjs ]]; then
  ln -sfn /opt/relay-vps/relay-stats.mjs /usr/local/bin/relay-stats
  echo "install.sh: link /usr/local/bin/relay-stats"
fi
put "$SRC/relay-certs-backup.sh" /opt/relay-vps/relay-certs-backup.sh 0755
put "$SRC/config.toml" /etc/iroh-relay/config.toml 0644 relay
put "$SRC/access-adapter.conf" /etc/iroh-relay/access-adapter.conf 0644 relay
put "$SRC/iroh-relay.service" /etc/systemd/system/iroh-relay.service 0644 relay
put "$SRC/relay-access.service" /etc/systemd/system/relay-access.service 0644 relay
put "$SRC/relay-tc.service" /etc/systemd/system/relay-tc.service 0644 relay
put "$SRC/iroh-relay.cron" /etc/cron.d/iroh-relay 0644
put "$SRC/unattended-upgrades.conf" /etc/apt/apt.conf.d/52iroh-relay-reboot 0644
put "$SRC/journald-relay.conf" /etc/systemd/journald.conf.d/60-iroh-relay.conf 0644 journal
put "$SRC/rsyslog-relay.conf" /etc/rsyslog.d/10-iroh-relay.conf 0644 rsyslog

iface="$(ip -o route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") {print $(i + 1); exit}}')"
if [[ -z "$iface" ]]; then echo "install.sh: no default route, so the interface to throttle is unknown" >&2; exit 2; fi
tc_conf="$(mktemp)"
printf '# Interface of the tc ceiling (relay-tc.sh, relay-watch.mjs); written by install.sh from the default route.\nRELAY_TC_IF=%s\n' \
  "$iface" >"$tc_conf"
put "$tc_conf" /etc/iroh-relay/tc.conf 0644
rm -f -- "$tc_conf"

if [[ ! -f /etc/iroh-relay/backup.conf ]]; then
  printf '%s\n' '# Target of the cert_dir copy (relay-certs-backup.sh): host:dir/ (scp) or a local directory; empty = local only.' \
    'RELAY_BACKUP_TARGET=' >/etc/iroh-relay/backup.conf
  chmod 0644 /etc/iroh-relay/backup.conf
fi

if [[ -f /etc/nftables.conf && ! -f /etc/nftables.conf.orig ]] && ! grep -q '^table inet relay' /etc/nftables.conf; then
  cp -p /etc/nftables.conf /etc/nftables.conf.orig
  echo "install.sh: original firewall in /etc/nftables.conf.orig"
fi
put "$SRC/nftables.conf" /etc/nftables.conf 0755 nft

echo "== 4. hook bearer"
if [[ ! -f /etc/iroh-relay/relay.env ]]; then
  need_restart
  (
    umask 077
    printf 'IROH_RELAY_HTTP_BEARER_TOKEN=%s\n' "$(openssl rand -hex 32)" >/etc/iroh-relay/relay.env
  )
  echo "install.sh: new bearer in /etc/iroh-relay/relay.env (0600); the same value goes to the Worker secret"
fi
chmod 0600 /etc/iroh-relay/relay.env
chown root:root /etc/iroh-relay/relay.env

echo "== 5. cert_dir"
install -d -m 0700 -o iroh-relay -g iroh-relay /var/lib/iroh-relay /var/lib/iroh-relay/certs
if [[ -n "$CERTS" ]]; then
  if [[ -n "$(find /var/lib/iroh-relay/certs -mindepth 1 -print -quit)" ]]; then
    echo "install.sh: cert_dir is not empty, archive $CERTS skipped"
  else
    need_restart
    tar -C /var/lib/iroh-relay -xpf "$CERTS" certs
    echo "install.sh: cert_dir restored from $CERTS"
  fi
fi
chown -R iroh-relay:iroh-relay /var/lib/iroh-relay/certs
find /var/lib/iroh-relay/certs -type d -exec chmod 0700 {} +
find /var/lib/iroh-relay/certs -type f -exec chmod 0600 {} +

echo "== 6. firewall, tc, services"
if [[ -f "$PENDING" ]]; then relay_changed=1; fi
systemctl daemon-reload
if [[ $journal_changed == 1 ]]; then systemctl restart systemd-journald.service; fi
if [[ $rsyslog_changed == 1 ]] && systemctl is-active --quiet rsyslog.service; then systemctl restart rsyslog.service; fi
systemctl enable --quiet nftables.service relay-tc.service iroh-relay.service cron.service
if ! nft list table inet relay >/dev/null 2>&1; then nft_changed=1; fi
tc_ok=1
/opt/relay-vps/relay-tc.sh check >/dev/null 2>&1 || tc_ok=0
guard=0
if [[ $nft_changed == 1 || $tc_ok == 0 ]]; then
  systemctl stop "$GUARD_UNIT.timer" >/dev/null 2>&1 || true
  systemctl reset-failed "$GUARD_UNIT.service" >/dev/null 2>&1 || true
  systemd-run --quiet --on-active=180 --unit="$GUARD_UNIT" --description="Roll back the relay firewall and tc" \
    /bin/sh -c "nft flush ruleset; tc qdisc del dev $iface root"
  guard=1
  nft -c -f /etc/nftables.conf
  systemctl restart nftables.service
  systemctl restart relay-tc.service
  echo "install.sh: firewall and tc set up under the dead man's switch $GUARD_UNIT (180 s)"
fi
if [[ $relay_changed == 1 ]] || ! systemctl is-active --quiet iroh-relay.service \
  || ! systemctl is-active --quiet relay-access.service; then
  systemctl reset-failed iroh-relay.service relay-access.service >/dev/null 2>&1 || true
  # Restart relaya restartuje też adapter (BindsTo= po stronie adaptera działa jak Requires= z propagacją restartu).
  systemctl restart iroh-relay.service
  echo "install.sh: iroh-relay started"
fi
# Każda jednostka osobno: `systemctl is-active a b` kończy się kodem 0, gdy aktywna jest choć jedna.
failed=()
for unit in iroh-relay.service relay-access.service relay-tc.service nftables.service; do
  state="$(systemctl is-active "$unit" || true)"
  echo "install.sh: $unit $state"
  if [[ "$state" != active ]]; then failed+=("$unit"); fi
done
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "install.sh: inactive: ${failed[*]} (journalctl -u <unit>); the restart marker stays" >&2
  if [[ $guard == 1 ]]; then
    echo "install.sh: check SSH with a NEW connection, then within 180 s: systemctl stop $GUARD_UNIT.timer" >&2
  fi
  exit 1
fi
rm -f -- "$PENDING"
if [[ $guard == 1 ]]; then
  echo "install.sh: check SSH with a NEW connection, then within 180 s: systemctl stop $GUARD_UNIT.timer"
fi
