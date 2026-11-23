# relay-vps — iroh relay on your own VPS

The iroh relay (`iroh-relay` 1.4.1) at `relay.rarog.ai`: configuration, systemd units, firewall, traffic cap, cron
watchdogs, the access hook adapter, the install script and tests. With `RAROG_IROH=1` the Rarog server connects to
the relay at the address in `RAROG_IROH_RELAY` (`docs/server-config.md`). The relay's security boundary, budgets
and log retention: `docs/security-model.md`, "iroh relay on a VPS".

## Files

`install.sh` copies every file to the VPS; the target path is in parentheses.

- `config.toml` (`/etc/iroh-relay/`): relay on 443 with a Let's Encrypt certificate (TLS-ALPN-01), the iroh
  client's captive-portal probe (`GET /generate_204`) on 80, QAD (QUIC address discovery) on UDP 7842, metrics on
  `127.0.0.1:9090`, a read limit of 3 MB/s with a 16 MB burst per connection, and the access hook `access.http`
  through the adapter on `127.0.0.1:8081`.
- `access-adapter.mjs` (`/opt/relay-vps/`) and `access-adapter.conf` (`/etc/iroh-relay/`): the hook adapter, Node
  without dependencies (section "Access hook" below).
- `iroh-relay.service`, `relay-access.service`, `relay-tc.service` (`/etc/systemd/system/`): relay, adapter and
  traffic cap. The relay requires `relay-tc` (`Requires=`), and its `ExecStartPre` runs `relay-tc.sh check`, so the
  relay does not start without the complete qdisc tree. It only wants the adapter (`Wants=`), so a dead adapter does
  not stop the relay. The adapter has `BindsTo=iroh-relay.service`, so stopping or restarting the relay does the
  same to the adapter. The adapter's `ExecStartPost` waits for its port, so the relay starts with the adapter ready.
- `relay-tc.sh` (`/opt/relay-vps/`): the traffic cap on outgoing traffic. The complete tree is htb `1:` at the
  root, class `1:10` at 100 Mbit/s and fq_codel `10:` under it. `apply` leaves a complete tree as is and builds any
  other from scratch; `check` exits 0 only on the complete tree (Ubuntu's default root fq_codel fails it); `cron`
  stops the relay and writes an alert when the tree is not complete. The interface comes from
  `/etc/iroh-relay/tc.conf`, which `install.sh` writes from the default route.
- `nftables.conf` (`/etc/nftables.conf`): limits on new connections to 80/tcp, 443/tcp and 7842/udp per IPv4
  address, per IPv6 /64 and globally. SSH is accepted only on the Tailscale interface `tailscale0` and dropped on
  every other one. Tailscale on the VPS runs with `--netfilter-mode=off`, so this file holds every firewall rule.
- `relay-watch.mjs` (`/opt/relay-vps/`, state in `/var/lib/relay-watch`): a watchdog that alerts on outgoing
  traffic averaging at least 80% of the 100 Mbit/s `tc` cap over an hour, on 15 TB in a calendar month (UTC), on
  over 6000 established connections on 443 and on `why=status:401` lines in the adapter log. Its state also keeps
  the highest connection count of today and yesterday (UTC).
- `relay-stats.mjs` (`/opt/relay-vps/`, linked as `/usr/local/bin/relay-stats`): a one-screen load summary for root:
  established connections on 443 per source (IPv4 address, IPv6 /64) against the firewall limits, today's and
  yesterday's peak, packet counters of the firewall's drop and reject rules since the last rule load (a service
  start or `nft -f`), the relay's metrics counters, uptime and memory, this month's outgoing traffic and the average
  rate over relay-watch's sample window (up to an hour, labelled with its length), and the access hook's decisions
  of the last 24 h per `src` and `decision`. A section whose read fails says `unavailable` and the
  rest still prints.
- `relay-certs-backup.sh` (`/opt/relay-vps/`): archives `cert_dir` to `/var/backups/iroh-relay/certs.tar` (0600).
  The off-VPS target comes from the argument or from `RELAY_BACKUP_TARGET` in `/etc/iroh-relay/backup.conf`
  (`host:dir/` over scp, or a local directory); with an empty target nothing leaves the VPS.
- `iroh-relay.cron` (`/etc/cron.d/iroh-relay`): `relay-tc.sh cron` and `relay-watch.mjs` every 5 min, backup at 03:17.
- `unattended-upgrades.conf` (`/etc/apt/apt.conf.d/52iroh-relay-reboot`): reboot at 04:00 when an upgrade needs one.
- `journald-relay.conf` (`/etc/systemd/journald.conf.d/60-iroh-relay.conf`) and `rsyslog-relay.conf`
  (`/etc/rsyslog.d/10-iroh-relay.conf`): relay and adapter logs live only in journald, for 7 days.
- `install.sh`: installation and update (section "Installation" below).

Alerts go to syslog (tag `relay-alert`, `daemon.crit`) and to `/var/log/relay-alert.log`.

## Installation

Requirements: Ubuntu 24.04 or newer on x86_64, root, A and AAAA records of the relay name pointing at the VPS
(Let's Encrypt validates the name on 443), and Tailscale running on the VPS, because the firewall accepts SSH only
from the tailnet. `install.sh` checks Tailscale (`tailscale status` and the `tailscale0` interface) before it
changes anything and exits with code 2 when it is not running. From the repo root (`COPYFILE_DISABLE=1` keeps macOS `._*` files out):

```bash
COPYFILE_DISABLE=1 tar -czf - relay-vps | ssh root@<host> 'tar -C /root -xzf - && bash /root/relay-vps/install.sh'
```

`install.sh [--certs <archive>]` runs these steps in order:

1. installs `nodejs`, `nftables`, `iproute2`, `cron`, `unattended-upgrades`, `curl` and `openssl` from the distribution;
2. downloads iroh-relay 1.4.1 from the GitHub release and checks the archive and program sha256 pinned in the script;
3. creates the `iroh-relay` user, copies only the files above that differ from those already on the VPS and saves
   the original `/etc/nftables.conf` once as `/etc/nftables.conf.orig`;
4. generates the hook bearer token into `/etc/iroh-relay/relay.env` (0600) only when missing, without printing it;
5. with `--certs`, restores `cert_dir` from a `relay-certs-backup.sh` archive, only into an empty directory (the
   relay then orders no new certificate); a non-empty `cert_dir` stays as is and the script prints that it skipped
   the archive; it always sets `cert_dir` permissions to 0700 and 0600;
6. when the firewall changed or the qdisc tree is not complete, arms a rollback timer, the transient systemd unit
   `relay-install-cofnij` (180 s; it removes the firewall and the qdisc), and then loads both; it restarts the relay
   only when the relay's files changed.

`install.sh` also links `/usr/local/bin/relay-stats`, so `ssh root@<host> relay-stats` prints the load summary.

A second run without changes restarts nothing. The marker `/etc/iroh-relay/restart-pending` appears before a file
that needs a relay restart is swapped in and goes away only after the restart and the service check, so the next
run finishes an interrupted one. At the end `install.sh` checks each service separately, the adapter included, and
exits with code 1 when one is inactive. When the output mentions the rollback timer, check SSH with a new
connection over the tailnet and stop the timer within 180 s with the command on the last output line,
`systemctl stop relay-install-cofnij.timer`; a timer that fires leaves the VPS without firewall and qdisc, and cron
then stops the relay.

The same script moves the relay to a new address: with a copy of `cert_dir` (`--certs`) the certificate carries
over without a new order. Copy the bearer token from `relay.env` into the `RELAY_HOOK_SECRET` secret of the registry
Worker (`relay-auth/`, the Cloudflare Worker with the relay's device registry) without displaying it; the command
is in `relay-auth/README.md`, "Deployment".

## Access hook

iroh-relay calls the hook `POST /v1/access` with the `X-Iroh-Endpoint-Id` header (64 hex characters) and the bearer
token from `IROH_RELAY_HTTP_BEARER_TOKEN`, and admits a client only on 200 with a body of exactly `true`. The relay
calls the hook without a timeout and waits for the whole body, so an adapter sits between the relay and the
registry Worker (`relay-auth/`). The adapter:

- forwards the request with the bearer token to `WORKER_URL` under a deadline for the whole decision,
  `ADAPTER_DEADLINE_MS` (3000 ms), and reads at most 16 bytes of the body;
- denies (403 `false`) only when the Worker denies explicitly with 403 and a body of exactly `false`, and remembers
  the denial per EndpointId for `ADAPTER_NEG_TTL_MS` (15 s);
- answers 200 `true` in every other case (network or DNS error, delay, incomplete or too long body, 5xx, 401):
  fail-open. The Worker answers 401 to a wrong bearer token, so a wrong token admits everyone; `relay-watch.mjs`
  alerts on the `why=status:401` lines;
- logs one line per decision: `decision`, `src` (`worker`, `failopen`, `cache`), a 10-character EndpointId prefix,
  the elapsed time `ms` and the reason `why`.

While the Worker at `WORKER_URL` does not answer, the relay admits everyone. The fake Worker
`test/fake-worker.mjs` serves tests and live trials (failure modes in its header); it is not a production service.

## Canary

`scripts/relay-canary.mjs` checks the relay from outside, the way a client sees it (it needs `pnpm install` for the
iroh module):

```bash
node scripts/relay-canary.mjs [--relay-only]
```

- `unknown`: a fresh random key; the relay admits it within 10 s in `shadow` mode and rejects it within 10 s in
  `enforce` mode. The registry Worker's `ENFORCE` variable sets the mode (`relay-auth/README.md`); in `shadow` mode
  the Worker answers `true` to every key and only logs its decision.
- `registered`: the first key from `RELAY_CANARY_KEYS` (two comma-separated secret keys with a registry entry) gets
  in within 10 s. Without the variable the step is skipped with a reason.
- `rate`: 60 MB over one connection through the relay alone in 14–18 s, which confirms the 3 MB/s limit and the
  16 MB burst. Sender and receiver run in one process and would connect directly over UDP, so the step runs only
  with `--relay-only` on a machine where UDP other than DNS is blocked. They use the two keys from
  `RELAY_CANARY_KEYS`, or two random keys in `shadow` mode; in `enforce` mode without the variable the step is
  skipped.

Variables: `RELAY_CANARY_URL` (default `https://relay.rarog.ai/`), `RELAY_CANARY_MODE` (the mode the canary
expects: `shadow`, the default, or `enforce`), `RELAY_CANARY_KEYS`. Exit code 0: every step passed or was
skipped; 1: a failure; 2: a bad argument or a missing iroh module.

## How it is checked

`pnpm run check` (`scripts/check.sh`, the repo gate) takes files from `relay-vps/` itself, without subdirectories:

- `bash -n` and ShellCheck on `relay-vps/*.sh`, together with `scripts/*.sh`;
- TOML syntax of `relay-vps/*.toml` through `scripts/lib/toml-check.py`, which uses `tomllib` from the Python 3.11+
  standard library, with no dependency in the repo. Without `python3` with `tomllib` the step prints `skipped`, and
  `--strict` fails the gate with code 3;
- the tests in `relay-vps/test/` in the main vitest run (`pnpm test`); `pnpm run typecheck` checks the types.

CI on Ubuntu runs the same checks as separate steps (`docs/publishing.md`, "CI"). Tests in `relay-vps/test/`:

- `config.test.ts`: the closed key set of `config.toml` (the relay ignores unknown keys, and a missing `[access]`
  admits everyone), the hook without a bearer token in the file, limits, metrics, TLS; skipped without `tomllib`;
- `adapter.test.ts`: the real adapter in front of the fake Worker: allow, deny, the negative cache, each fail-open;
- `units.test.ts`: systemd dependency directions (`BindsTo=`, `Wants=`, `Requires=`, `ExecStartPre`,
  `ExecStartPost`), the same adapter port in `access-adapter.conf`, `config.toml` and `relay-access.service`,
  resource limits, the files in `install.sh`, log retention, the firewall;
- `skrypty.test.ts`: `relay-tc.sh` and `relay-certs-backup.sh` against fake `tc`, `logger`, `systemctl` and `scp`;
- `relay-watch.test.ts`: watchdog decisions (hour window, month, reboot, connections, 401, repeated alerts) and the
  daily connection peak;
- `relay-stats.test.ts`: parsers of `ss`, `nft`, metrics and the adapter log, the report with a failed read, and no
  EndpointId prefix in the output;
- `canary.test.ts`: canary keys, the verdict of the `rate` step, arguments;
- `bramka.test.ts`: `scripts/check.sh` in a fake repo with broken bash, ShellCheck and TOML files from
  `test/fixtures/`; each fails its step. In the repo the fixtures sit in a subdirectory, so the gate's glob skips
  them.
