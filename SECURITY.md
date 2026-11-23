# Security

## Threat model

Rarog is remote code execution on your machine, as the user who runs the server. Whoever holds a paired device key
can do what that user can do: through the Claude Code sessions and, with `RAROG_TERM=1`, through a full shell. Each
layer states what it protects against:

- **Network.** The server has two ways in. Over TCP it listens only on `127.0.0.1`, and the way in is a reverse
  proxy with TLS in a private network (for example `tailscale serve`). This keeps out the rest of your local network,
  but not other devices in the same private address range. With iroh on (`RAROG_IROH=1`, which `rarog setup` turns
  on wherever the native iroh module is installed), the server also binds a UDP port for QUIC on all interfaces and
  keeps a connection to an iroh relay: `relay.rarog.ai` by default, or your own (`rarog setup --iroh-relay`). The
  relay carries the connection when the app and the server cannot connect directly and cannot read its content.
  Its client registry (`relay-auth.rarog.ai`, where the app registers itself and sponsors its servers) runs in
  shadow mode on `relay.rarog.ai`: the relay admits every client. The iroh library asks your router for a UDP port
  mapping (UPnP, NAT-PMP, PCP) and has no switch for it: where the router grants one, the UDP port is open to the
  internet while the server runs. Through the relay a client needs the server's EndpointId (it is in the pairing
  link); on a direct connection it does not, because the server presents its key, which is the EndpointId, to any
  client that reaches the port and speaks the protocol. Every connected client gets, before it authenticates, the
  server's addresses for a direct connection: the mapped one, the public one and those of the local interfaces.
  Only QUIC with TLS to the server key reaches HTTP, and in both ways the app credential is the boundary. Turning
  port mapping off on the router closes the mapped port; `rarog setup --tailscale-only` leaves iroh off, so there
  is no UDP port and no address disclosure. Details:
  [docs/security-model.md](docs/security-model.md), sections "Layer 1b: iroh listener (`RAROG_IROH=1`)" and
  "iroh relay registry (`relay-auth/`)".
- **App credential.** The app uses a per-device key from pairing. A pairing code can be used once and expires after
  5 minutes. Once a device is paired, only a paired device can issue a new code; the server's admin socket refuses
  such requests. Revoking a device (`rarog devices revoke`) closes its connections at once.
- **Server environment.** `rarog serve` passes to the server only the variables named in its registry, so API keys
  from your shell stay out. Logs are redacted, and no endpoint returns the environment.
- **Killswitches.** `RAROG_HERDR_SEND`, `RAROG_HERDR_LAUNCH`, `RAROG_TERM`, `RAROG_PUSH` and `RAROG_NOTES` switch
  capabilities off; a change takes effect after a restart.
- **Notifications.** A notification never approves anything; a tap only opens the app. The push relay never gets
  banner text in the clear.

The full model, layer by layer, and the runbook for a lost or stolen phone:
[docs/security-model.md](docs/security-model.md).

## Reporting a vulnerability

Please report privately, not in a public issue, through one of these:

- GitHub private vulnerability reporting: the **Security** tab of this repository, then **Report a vulnerability**;
- email security@rarog.ai.

Include the affected release or commit, the steps to reproduce and what an attacker could gain. The maintainer
handles reports on a best-effort basis, with no guaranteed response time. Fixes ship in the next release.

## Supported versions

Only the latest release of the npm package `@rarog/server` and the latest version of the app get security fixes.
A fix does not go to older releases; update to the latest one.

## Good-faith research

We welcome security research done in good faith, and we will not take legal action against it. Good faith here means:
you test only an installation of your own, you do not access or change other people's data, you do not degrade
the services run by USEO (`push.rarog.ai`, `relay.rarog.ai`, `relay-auth.rarog.ai`) for other users, and you report
what you find privately, as described above, before you publish it.

## Releases

The npm package `@rarog/server` is published only by the workflow `.github/workflows/publish.yml` in this repository,
through npm trusted publishing: the workflow has no secrets, no npm token exists, and the package refuses
publishing with a token. The workflow only stages a version (`npm stage publish`). It becomes installable after
the maintainer downloads the staged tarball, compares it file by file with a tarball built from their own copy of
the source, and approves it with two-factor authentication. Each workflow run also stores a CycloneDX SBOM of the
installed package for Linux and macOS as run artifacts. To check the provenance of a version (repository, workflow
and commit it was built from):

```bash
npm view @rarog/server@<version> dist.attestations
npm audit signatures        # in a project that depends on @rarog/server@<version>
```

## Known limitations

These weaknesses are known and open in the current release:

- **Slow pairing requests.** `POST /api/pair` needs no credential, and the server reads its body (up to 64 KiB, for
  up to 180 s) before it checks the pairing code. The TCP listener has no connection limit, so a client that reaches
  the reverse proxy can hold many connections open by sending bodies slowly. The iroh listener limits connections
  and streams before authentication. The risk is availability, not access.
- **Emergency console with another herdr socket.** The process that attaches the console to its herdr pane
  (`herdr terminal session control`) gets only `HOME`, `PATH` and `TMPDIR` from the server, not the socket named in
  `RAROG_HERDR_SOCKET`, so with a socket other than herdr's default it is not told the configured one. Use the
  console only with herdr's default socket.
- **Shared connection budget of the iroh relay.** The firewall of the iroh relay (`relay-vps/nftables.conf`, also on
  `relay.rarog.ai`) allows at most 50 new connections per second in total, for TCP and for UDP port 7842, after the
  limits per address. Packets from many source addresses, spoofed ones included, can use up this budget, and then
  genuine clients cannot connect through the relay while the flood lasts.
- **Git filter race outside macOS.** Before each git process the server reads the config key names and empties
  every filter driver it finds. A driver written into the repository config between that read and the start of git
  stays on for that one process, so a process that can write the repository, a sandboxed agent included, can make
  Rarog's git run a program outside that sandbox. On macOS git starts under `sandbox-exec`, which lets it start no
  program but git itself; on Linux, or when the profile cannot be applied (the server logs it), the window stays open.
  Details: [docs/security-model.md](docs/security-model.md), section
  "Git reads (git line, session diff): Rarog only reads git".
- **The relay registry does not enforce.** `relay.rarog.ai` admits every client: its registry runs in shadow mode
  (`ENFORCE` other than `1` in `relay-auth/`). When it enforces, the relay still admits a client unless the registry
  answers with an explicit refusal, so an error, a timeout or a wrong bearer admits too. Anyone can use the relay's
  bandwidth within the cost caps on the relay host; the connection content and the app credential are not affected.

## Not vulnerabilities

These are not vulnerabilities in Rarog. Most are known, documented properties of the design:

- The agent runs as your user and can read your files, secrets included. Rarog protects the access channel, not the
  agent.
- The permission mode chosen for a new session is not a security boundary: on Claude Code 2.1.241 a session started
  with `--permission-mode manual` ran `Bash` without a prompt. The boundary is `permissions` in your Claude Code
  settings.
- With `RAROG_TERM=1` the emergency console is a full shell with your user's rights. Its input and output are not
  logged anywhere.
- Devices in the same private address range (for example other tailnets on the same VPN client) reach the reverse
  proxy. The app credential is the boundary.
- A process that runs as your user outside any sandbox can change the server's data directory, revoke your devices
  and pair its own. Nothing blocks it, but it shows: a revoked device displays when and why it was revoked.
- The service runs the server from the repository checkout or from the npm package directory, outside the Claude
  Code sandbox. An agent whose sandbox may write there can change that code, and nothing blocks it. In a checkout
  the change shows in `git status`; in the package directory nothing shows it.
- Live Activity updates carry the Live Activity state (project names, phase titles) unencrypted through the push
  relay and Apple.
- Bugs in Claude Code, herdr, Tailscale, Apple's platforms or Cloudflare: please report them to their vendors.
