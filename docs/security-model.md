# Security model

Threat model: Rarog is remote code execution on the Mac as the user who started the server. Every layer below
states what it really protects against, so it gives no false sense of safety.

## Layers

1. **Network: a reverse proxy with TLS on a private network.** The server has no port forwarding from the internet,
   and its DNS name points to a private-network address (for example a tailnet, range `100.64.0.0/10`). The reverse
   proxy lets through only loopback and that range (`remote_ip 127.0.0.1 ::1 100.64.0.0/10`) and answers 403 for the
   rest. **This layer cuts off only the local network** (someone on the same Wi-Fi running `curl --resolve` against
   the Mac's address). **It does not protect against other devices in the same address space:** a VPN client can be
   joined to several private networks at once (for example the tailnets of clients), and the CGNAT range
   `100.64/10` they all use covers their devices too. Only the app credential (item 3) stops them. With
   `RAROG_IROH=1` a second path runs next to this one, without the reverse proxy and the private network: "Layer 1b"
   below.
2. **Excluded from a generic port proxy.** A reverse proxy that exposes every local port under its own name
   (pattern `<port>.<host>`) would expose the backend on 8930 with no configuration, so Rarog's port must be cut out
   of such a rule.
3. **App credential.** The only credential is the device key from pairing with a code: the header
   `Authorization: Rarog-Device <id>.<secret>` in REST, SSE and the WebSocket upgrade of the emergency console (the
   full shell from the phone, "Emergency console" below). One function checks it, `authenticate`
   (`server/src/auth/principal.ts`); this document calls it the credential gate ("Pairing and device keys" below).
   Only `/health`, `/api/pair` (the credential is the code in the body) and `/api/login` skip the gate; the plain
   demo (`RAROG_DEMO=1` without the review code) adds a fourth, `POST /api/demo/pairing` for the UI tests of the app.
   It revokes every device of the demo store and returns a pairing code. That store is its own file,
   `devices.demo.json`, so a demo key opens no server without demo on the same data directory and the route revokes
   none of that server's devices ("Review demo server" below). The server has no token or cookie login: it never
   reads `Cookie`, never sends `Set-Cookie`, and `POST /api/login` answers a fixed 410 `login-retired` without
   reading the body. The gate refuses with 401: no header → `unauthorized`, a bad or unknown key or a foreign scheme
   → `device-unknown`, the key of a revoked device → `device-revoked`.
   **Attempt limiter:** 10 FAILED attempts in 60 s → `429` with `Retry-After`, one global budget for a bad
   `/api/pair` code and an unknown key; a missing header and `/api/login` do not count. A valid code and key always
   pass, and a successful pairing resets the budget. Only failures count on purpose: `/api/pair` is public and
   `100.64/10` holds other people's devices (item 1), so a budget charged for EVERY attempt would let a foreign peer
   lock the owner out.
   **Revoking all devices at once** has two paths, and there is NO `/api/logout-all`:
   `rarog devices revoke --all` over the admin socket works without a restart ("Pairing and device
   keys"); incrementing `RAROG_AUTH_EPOCH` in `env` in `~/.config/rarog/config.json` and restarting works from the
   config file alone, without the admin socket or the network (every key record carries the epoch it was issued
   in). In the plain demo `POST /api/demo/pairing` also revokes every device, but only those of `devices.demo.json`.
   Mutations (POST, PUT, DELETE) also check `Origin` against `RAROG_ORIGINS`. The key travels only in the
   header, never in a URL.
4. **Backend.** The TCP bind is hard-coded to 127.0.0.1 (a test rejects 0.0.0.0); the UDP port of the iroh listener
   is layer 1b. `rarog serve` builds the server environment only from names in the registry
   `server/src/config-env.ts`: plain values from `env` in `~/.config/rarog/config.json`, secrets from the parent
   process environment (for example a secrets manager wrapper in `service.wrapper` of the launchd service
   `ai.rarog.server`), never a whole shell secrets file; a name outside the registry never reaches the server.
   Variables, flags and killswitches: `docs/server-config.md`, "Server environment: variables and flags". `redact()`
   runs on everything that goes to logs; headers and body of `/api/pair` are never logged; no endpoint returns the
   environment. Accepted on purpose: the agent runs code as the same user and BY DEFINITION can read that user's
   secret files. Sandboxing the backend does not change that: Rarog protects the access channel, not the agent.

### Layer 1b: iroh listener (`RAROG_IROH=1`)

iroh is a QUIC networking library with relays and direct connections between endpoints. Without the flag this layer
does not exist: the native iroh module never loads and no UDP port opens. With the flag the server accepts a second
path that bypasses layers 1 and 2, so the boundary here is only encryption, the app credential and the limits below.
Code: `server/src/iroh/` (listener) and `server/src/auth/` (rules of the iroh socket).

- **Network.** The QUIC endpoint binds UDP on all interfaces (`0.0.0.0` and `[::]`, port from `RAROG_IROH_PORT` or
  from the OS) and keeps a connection to the relay from `RAROG_IROH_RELAY`. It publishes no address to a lookup
  service and resolves no DNS name other than the relay's. The library's port mapper has no switch: it looks for
  the router (UPnP, NAT-PMP, PCP) and asks it for a UDP port mapping. Where the router grants one, the port is
  reachable from the internet while the server runs; turning port mapping off on the router closes it.
- **Who can connect.** Through the relay a client needs the server's EndpointId (it is in the pairing link). On a
  direct path it does not: the client sends no server name, and the server presents its key, which is the
  EndpointId, to any client that reaches the UDP port and offers the ALPN. The EndpointId is therefore neither a
  secret nor a boundary. The library gives every connected client, before any credential, the server's address
  candidates for a direct path: the mapped address, the public address reported by the relay and the addresses of
  the local interfaces.
- **Encryption.** Only QUIC with TLS to the server key and ALPN `rarog-http/1` reaches HTTP; another ALPN closes the
  connection before the first HTTP byte. The EndpointId is the server's public key, so a client with the link knows
  whom it talks to; the client's EndpointId is not checked, because the credential is the device key, as over TCP.
  Each bidirectional stream is one HTTP/1.1 connection to the same routes.
- **Authentication boundary.** The iroh socket has the same credential gate as TCP, and `/api/login` answers 404.
  Mutations and the console upgrade pass only with `Origin: https://iroh.rarog.invalid`, a domain that resolves
  nowhere, so a web page cannot use it; the TCP socket does not accept it, and an origin from `RAROG_ORIGINS` gets
  403 over iroh (`server/src/auth/origin.ts`). The failure limiter counts the peer as `iroh:<first 12 characters of
  the EndpointId>`; `X-Forwarded-For` means nothing here. `POST /api/pair` is public, as over TCP. `/health` needs
  no key either, but over iroh it answers only `{"ok":true}`: its fields go only to a loopback caller over TCP.
- **Authenticated connection.** A QUIC connection is authenticated while it has at least one active device (a
  successful key or `POST /api/pair` on it adds one). A revocation removes the device from every connection
  (`server/src/device-effects.ts`), and a connection left without a device falls back under the pre-authentication
  limits with a fresh 60 s deadline.
- **Pre-authentication limits** (`IROH_LIMITS` in `server/src/iroh/listener.ts`): 16 handshakes in progress (the
  excess is refused without a handshake), 64 connections (a new one over the limit evicts the oldest
  unauthenticated one, so a flood never closes a device's connection; when all are authenticated, the new one is
  closed), 60 s of life without a device, 16 bidirectional streams before authentication and 32 after (the excess
  gets `reset` and `stop`); unidirectional streams get `stop` at once and nobody reads datagrams. Closing a stream
  whose native operations do not finish within 2 s closes the whole connection. Refusals are logged through a
  budget (the first line of each kind in a 60 s window, then a summary).
- **SSE write buffer** (`SSE_WRITE_BUFFER_MAX` in `server/src/sse.ts`, 11 MiB, twice a full ring plus the snapshot
  image budget): an authenticated stream, over TCP or iroh, whose unsent bytes (socket buffer plus compressor input)
  pass the ceiling plus twice the largest frame it was sent is destroyed with one log line that carries the stream
  scope and device id only, so a device that stops reading holds at most that much server memory per stream.
- **Server key `RAROG_IROH_KEY`** (64 hex characters, `openssl rand -hex 32`) is the server's identity: the
  EndpointId derives from it. It is a secret (through `service.wrapper` or the secrets file `private.env`, never
  `config.json`); `redact()` removes it from logs and `GET /api/admin/iroh` does not return it. **Theft:** whoever has
  the key can pose as the server to iroh clients and receive their device keys, so: a new key, a restart, revoking
  every device (`rarog devices revoke --all`) and pairing again. **Loss without a copy:** a new key means
  a new EndpointId, so devices pair again. **Backup:** with the other server secrets ("Lost Mac" in the emergency
  runbook).

## Permission UX against approval fatigue

- The full command and the full diff, always: monospace, scrolling instead of an ellipsis; `cwd` and the project
  name on the permission card, so nobody approves something in the wrong repo. The command block has a cap counted in
  LINES (10, and 16 in the wide iPad column), so it MUST show a "showing N of M lines" indicator: a cap without one
  would silently cut the text being approved. The accessibility label carries the full `cwd`.
- The risk classifier (`risk.ts`) marks `rm`/`rmdir`/`dd`, `git push --force` and `git reset --hard`, `sudo`,
  `curl` piped into a shell or an interpreter (`sh`, `bash`, `zsh`, `python`, `node` and the like, also by path),
  `wget` into any pipe, `wrangler` and `heroku` deploys, and the paths `.ssh`, `.claude` and `.secrets` in the home
  directory as `risk: "red"`. A `git push` without `--force` is an ordinary card. There is no hold-to-approve: the
  command is on the card, so holding would add friction, not information. Three things carry the risk at once: the
  header color, the word in the label and a wider gap between the two decision buttons (24 pt instead of 8 pt),
  because the thumb's margin of error is a matter of risk.
- Allow (filled, permission color) and Deny (outline in the error color) stand in one row, with touch targets of at
  least 44 pt; Allow ALWAYS has the permission color, because two identical buttons for OPPOSITE decisions invite a
  mistake. Allow is not a system button, so Space or Enter with keyboard focus does not trigger it. A card without
  recognized options (fail closed) has no Allow button and says WHERE the decision is possible: in the terminal.
- **The sandbox network dialog is approved from the phone only with "Yes".** "Network request outside of sandbox"
  has no hook and no jsonl entry (jsonl is the session transcript file), so the `SandboxNetwork` card is built from
  the screen and carries the host. Allow picks the digit of the option that is exactly "Yes", Deny is Esc. "Yes" is
  not one connection: the next connections to the same host in the same session go through without a dialog (Claude
  Code 2.1.322, 2 of 2). "Yes, and don't ask again for <host>", which writes a rule to the project settings, stays at
  the desk: the card carries no `alwaysLabel`, and `allow-always` from an outdated or foreign client is refused in
  the driver (`terminal-only`). With the consent channel on, this dialog gets its digit only as a measured consent
  dialog under invariant N4 (next point).
- **With the consent channel on, a consent dialog gets a digit only under invariant N4 or with the emergency Allow
  button.** The classes `permission` and `sandbox` get no digit at `main` and `all`, except two "Yes" digits. The
  first is the one of a measured consent dialog (invariant N4): the sandbox
  network dialog and the dialog of an MCP tool with `requiresUserInteraction`, whose dialog a plain hook `allow` does
  not close (Claude Code 2.1.322). The digit goes out only when the dialog is the only one on top without a queue
  counter, has the measured shape line by line, has the identity of the card (the host; for MCP the header and an
  argument frame equal to the call input of the transcript entry the card was built from), no hook consent request
  of the session waits (a channel card holding the dialog, or a live registration of the session without a card,
  a subagent's too, however old), a fresh registry read gives the class of the shape, and a fresh screen read right
  before the key gives the same shape and identity, with the hook check repeated after it. The second is the
  emergency Allow button of a tool permission dialog to which Rarog's hook left no trace for 3 s: the card is the
  one the `off` path would show, proven by the screen against its transcript entry, and it carries the button only
  when no hook trace, hook request or hook process of the session is seen, no foreign `PermissionRequest` hook stands
  in the current settings, the server is past its restart grace, and a subagent's dialog (title suffix) is in `all`.
  Its residual risk: in `all` its digit can land in the dialog of an identical subagent call whose hook does not run
  (not reached on Claude Code 2.1.331, where the card of a foreground subagent's dialog without a hook has no approve
  button), and a foreign hook removed from a settings file after the session start, but still loaded, is not seen. It
  approves the one call: no always option, and right before the key the same shields, a fresh screen read, the rule
  once more and the pending call of the card. A hook that registers after the key is released and its request
  settled without a button. Anything else means no digit (`docs/dialogs.md`, "Rules: what must not be relaxed").
- **No Allow action in a notification.** A push only informs and opens the app.
- **A session this app version cannot read: the app sends nothing.** An unknown state or engine turns the frame
  decoder's value into the `unsupported` sentinel. The gate stands in ONE place: `MutationGate` in the native app's
  transport (`RarogTransport/MutationGate.swift`; `MutationRules` in `RarogCore` supplies the state) refuses, before
  sending, every request other than `GET`/`HEAD` to `/api/sessions/<id>/…` while that session is `unsupported`, with
  a sentence asking to update the app. Outside this gate stay reads, creating a session, mutations addressed by
  directory (the console, `/api/term`) and general requests; the same gate enforces app–server version
  compatibility. It is a CLIENT gate, a convenience, not a boundary. An unknown engine is NEVER read as Claude,
  because a missing `engine` field means Claude and the sentinel is a field value.
- Permission modes per project (`plan`/`acceptEdits`/`bypassPermissions`) live on the server; yolo only for repos in
  `RAROG_YOLO_ROOTS` (default EMPTY, meaning nowhere).
- **Choosing a mode is not a security gate.** Measured live on Claude Code 2.1.241 in a clean pane: a session started
  with `--permission-mode manual` ran `ls` and `rm -f` WITHOUT a permission dialog, while `AskUserQuestion` did block;
  with `permissions.defaultMode: "auto"` in the account's `settings.json` a `manual` session does not stop at the
  first `Bash`. The gates are whether a session may be started at all (`RAROG_HERDR_LAUNCH`, the pane cap, the
  directory roots) and what the account's `permissions` say. To make a pane ask about `Bash`, set it in
  `settings.json`; Rarog does not override it (rule 9 of "Starting sessions from the phone").

## Push notifications

- **Content.** The title has the kind's emoji, the event kind and the project (the emoji carries only the KIND,
  never a detail); the body has the tool and the session label. NEVER full commands, code or paths: the lock screen
  and the Notification Center history are readable by bystanders. The rule is about the SCREEN, not the transport,
  so it holds on every channel.
- **Channel: APNs of the native app, the only one.** The banner leaves the Mac over HTTP/2, straight to APNs with a
  key on the Mac or through the push relay (below), with content from `notify/content.ts` (kind, project, tool,
  question text, result sentence; never the command or `displayText`). The `done` push (end of a turn) reaches the
  app as a badge only: no title, body or sound, so Apple never sees the result sentence. Pushes are best effort.
  Three failed ATTEMPTS in a row to one token, a switched-off environment for the entry's path, or an entry with no
  path → `degradedSince` in `POST /api/push/apns/status` → the app shows a notifications-not-working banner, with
  the cause when known (`degradedReason`: `pass-missing`, `env-mismatch`). Log lines carry the event kind, the
  project, the channel result and counts, never the banner title or body; the schedule lines (`push: armed …`)
  carry no session label (a logger spy in `notify-push-crypto.test.ts`). A banner approves nothing: a tap only opens
  the session, and the target travels in the payload as the session id, without a token. Without the full set of
  `RAROG_APNS_*` and without `RAROG_PUSH_RELAY_URL`, Rarog sends no pushes.
- **Banner text is end-to-end encrypted (server and the app's notification service extension).** An entry gets a v3
  payload if and only if `RAROG_PUSH_E2E` is on (the default), the last registration carried `pushFormats` with 3,
  and the entry's `deviceId` has an ACTIVE record in `devices.json` (the source of `pushKey`). Title, body, kind,
  session and console travel in a `rarog {v: 3, kid, n, c}` block under ChaCha20-Poly1305 with a key from
  HKDF-SHA256(`pushKey`, info `rarog-push-banner-v1`), AAD `rarog-push/3|<kid>` and a random nonce; `aps.alert` is a
  fixed placeholder with `mutable-content: 1`. An entry whose last registration declared `locKeys: true` gets the
  placeholder as the app's catalog keys (`title-loc-key` `push.placeholder.title`, `loc-key` `push.placeholder.body`,
  without `loc-args`), any other entry the literal; either way it is a constant that carries no content. There is no
  plain banner variant: an entry without a v3 payload is skipped with a log line, and `RAROG_PUSH_E2E=0` means no
  banners at all.
  - *In the clear (for Apple, the relay and Cloudflare):* the token, the `kid`, a length bucket of the plaintext
    (padded to a multiple of 256 B), send time, priority and TTL (together they reveal the event CLASS: urgent
    10 / 600 s, done 5 / 3600 s, `device-paired` and `version-changed` 10 / 86400 s, `weekly-limit` 10 / up to
    86400 s; in the last day before the weekly reset its TTL reveals the time left to the reset),
    `apns-collapse-id` and `thread-id` as a hash of the session id (banners of one session can be linked;
    `weekly-limit` has `apns-collapse-id` as a hash of the window's reset instant, so banners of one window can be
    linked), the badge and whether there is an alert.
  - *Replay:* the AAD binds only the `kid`, so the relay, Cloudflare or Apple can replay a ciphertext and change clear
    `aps` fields (badge, `thread-id`, `apns-collapse-id`): a duplicated banner or a wrong badge, never foreign
    content. `exp` in the plaintext gives the receiver a freshness bound (the extension keeps the placeholder when
    `now > exp + 300 s`); a tap does not check `exp`.
  - *Receiver:* the notification service extension decrypts with the push key from the shared Keychain group; every
    failure (no key, phone before the first unlock, wrong `kid`, AEAD, validation, stale `exp`, timeout) keeps the
    placeholder. Content never reaches the extension's logs or `client.log`. The app also accepts a plain `rarog` v1
    (the server never sends it; UI tests use it) and an unsigned `rarogOpen`: whoever can push to the token can forge
    at most a navigation target, not content or an action.
  - *Boundary:* a process that reads the server's `dataDir` knows every device's `pushKey` (`devices.json`, its
    `.bak` and `.tmp` files) and can forge an encrypted banner. Rarog does NOT promise to close this: a sandboxed agent
    can read `dataDir` ("Pairing and device keys"). The push key does not rotate (rotation means pairing again), and a
    backup of the data directory carries the push keys.
- **APNs key** (an EC P-256 key file from the Apple portal, Sandbox, team-scoped) lives outside the repo with
  `chmod 600`; the server environment holds only its location (`RAROG_APNS_KEY_PATH`) and Key ID
  (`RAROG_APNS_KEY_ID`). A team key sends to every app of the team,
  so a leak affects every project that uses it. The server refuses a key file with permissions other than 600 or 400
  (the channel does not start; the server does). The key content is on the `redact()` list (`logSecrets` in
  `config.ts`) even with `RAROG_PUSH=0`, and never enters the console, git or `claude agents`. The provider JWT
  changes every 50 minutes, so the APNs module logs ONLY the response code and reason (test in `notify-apns.test.ts`).
  A leaked key lets someone SEND banners, not read them. **Leak runbook:** revoke the key in the Apple portal (Keys →
  Revoke), create a new one, store it outside the repo with `chmod 600`, put the new location and Key ID into the
  server environment and run `rarog restart`. Devices need not register again.
- **Token registry** `apns-devices.json` (`0o600` in `dataDir`). A device token is an ADDRESS: with the APNs key it
  sends a banner, it reads nothing. `/api/push/apns*` sits behind the credential and Origin gates; token status goes
  by POST (a query string would land in proxy logs); logs carry only counts; the test push is limited to 1 per 60 s
  per token. The server accepts only its own `RAROG_APNS_TOPIC` (another topic, or none, → 400 `topic-mismatch`
  without a write), so the client never chooses the topic under which the team key sends; a server without a key
  accepts only the relay app's topic (`RELAY_APP_TOPIC` in `shared/src/relay.ts`). An entry carries the `deviceId`
  whose key made the registration, and a file entry without `topic` or `deviceId` is dropped on read. The
  registry also holds **relay passes**, the ability to send to THIS token through the relay, with the token's
  protection: only in this file, never in a log, an HTTP response or the environment (logger spies in
  `notify-relay-sender.test.ts` and `notify-relay-pass.test.ts`). Lost phone: `rm <dataDir>/apns-devices.json` and a
  restart removes tokens and passes ("Emergency runbook").
- **Push relay (`relay/`): the production Worker `rarog-relay` on `push.rarog.ai` with policy `v2`, used when
  `RAROG_PUSH_RELAY_URL` is set.** Contract, payload policy and operations: `relay/README.md`. The power boundaries:
  - *Server side.* Passes are ordered only for Rarog app entries; a send without a valid pass goes with the Mac key
    when there is one, otherwise not at all (`pass-missing`). The relay address is accepted only as an `https`
    origin, requests follow no redirects, and a pass is bound to the relay origin. An empty `RAROG_PUSH_RELAY_URL`
    sends everything with the Mac key. A failed order (`push: relay pass … failed`) is retried after a wait.
  - *What it holds.* The app publisher's APNs key and the pass HMAC key (`PASS_KEYS`, with no copy outside Cloudflare)
    in Worker secrets, and no storage: no tokens, passes or content are kept. In flight it sees the token, the pass
    and the payload; banners are always encrypted, the Live Activity state is in the clear. The log is one line per
    request from an allow-list of fields, without the token, its hash, the pass, the payload or `authorization`.
  - *Who can send.* Anyone who knows a real Rarog app token gets an `alert` pass (Apple must accept a silent test
    push to it), so a process that reads `apns-devices.json` could send a banner. Policy `v2` (`ALERT_POLICY`,
    guarded by `relay/test/config.test.ts`) rejects every plain banner with 400 `payload-rejected`: fixed `aps.alert`
    text, closed key sets, canonical JSON. A relay rollback therefore goes only to a version with `v2`. Not closed:
    the relay passes Live Activity `content-state` unread, so a `liveactivity` pass holder can put their own text
    (60 characters per field) on the Live Activity, and one known token allows spamming one device with the
    placeholder.
  - *Limits.* Per-address, per-device and per-parent counters, checked AFTER the pass for `/v1/push`, so nobody
    exhausts someone else's limit without a pass; Cloudflare counters are approximate, a brake, not a cap. A browser
    page cannot send through the relay (a required custom header, `OPTIONS` without CORS).
  - *Cloudflare account.* Whoever can deploy Worker code can read the APNs key secret, so the right to deploy on the
    relay's account is a power boundary like the key itself. There is no hard spending cap.
  - *Relay runbooks* (rotation or leak of `PASS_KEYS`, leak of the relay's APNs key): `relay/README.md`,
    "Operations".
- **Live Activity of the native app.** It stays up to 8 h on the lock screen and in the Dynamic Island, longer than
  any banner, so its rule is stricter. Its state carries ONLY numbers (waiting, working, finished), up to two
  workflow runs (project, the script NAME as a slug, phase number and title, agent counts, phase progress), the
  plan's usage percentages, Mac load and the id of the leading session. NEVER the question text, the permission's
  tool, the session label, a step with a command, the result sentence, `displayText`, a run description or a task
  description without the shape of a script name. Its only alert is the `done` chime with FIXED texts
  (`LIVE_ACTIVITY_CHIME`, or its catalog keys `push.chime.title` and `push.chime.body` for an entry that declared
  `locKeys: true`). The contract (`liveActivityContentStateSchema`) has no fields for the forbidden content and
  caps strings at 60 characters; guards stand in a server test on the WHOLE payload with a command in each field
  (`notify-live-activity.test.ts`), the golden frames (`shared/test/apns-fixtures.test.ts`) and Swift
  (`ApnsFramesTests`, `LiveActivityContractTests`, `LiveActivityInputTests`). An activity token is an ADDRESS like a
  device token and never reaches a log. This Live Activity, the sessions board, has no actions. Signing out ends it
  locally; the server ends it 10 min before the system's 8 h limit and deletes the `liveActivity` block after `410`,
  and in any case 8 h after the start. Without updates the Live Activity marks its data as stale after 15 minutes.
- **Voice Live Activity of the native app.** The second Live Activity stands only while the locked-phone trial is
  on and a voice conversation or a message-field dictation records (`docs/companion.md`, "Locked phone (trial)").
  The app starts, updates and ends it itself, without a push type, so nothing from the server reaches it. Its state
  carries ONLY the kind (conversation or dictation), a phase from a closed set, the start time of the system timer,
  the scope (all sessions or one session) and, for one session, its project and session name as the app's list
  shows them, each through the voice agent's secret mask (`MicrophoneSubject.of`) and cut to 80 characters
  (`VoiceActivityAttributes.ContentState`; `VoiceActivityAttributesTests` checks the encoded keys): NEVER a prompt,
  dictated text or a question. While the recording runs, the Lock Screen shows that project and session name to
  anyone who holds the phone. Its one action, End (Stop for a dictation), is a `LiveActivityIntent` (`EndVoiceActivityIntent`) that declares
  `IntentAuthenticationPolicy.alwaysAllowed`, which Apple's documentation describes as letting the intent run at
  any time, including when the device is locked. The intent declares no unlock because it only stops the
  microphone the way the user's own end does: it sends nothing, a dictation keeps its text in the field unsent,
  and it opens no app. If the system runs it on a locked phone, whoever holds the phone can stop a recording and
  nothing more. Its `client.log` lines name the kind and nothing else.

## iroh relay on a VPS (`relay-vps/`)

The iroh relay carries the app's QUIC connections to the Rarog server when the two sides cannot connect directly
(layer 1b). It runs on the project's own VPS in the EU; files, installation, limits and tests: `relay-vps/README.md`.

- **What the relay sees:** the IP address and EndpointId of both sides, times and amount of data. The content is
  end-to-end encrypted (QUIC TLS to the server key), so the relay can neither read nor alter it: posing as the server
  needs the server's key, not the relay.
- **The access hook fails open.** For every connection a loopback adapter (`access-adapter.mjs`) asks the registry
  Worker at `WORKER_URL` about the client's EndpointId, with the relay's bearer token and a 3 s deadline. Only an
  explicit 403 with body `false` is a refusal (remembered for 15 s); every other result admits the client. So while
  the Worker does not answer, or with a wrong bearer (a watchdog alert), the relay admits everyone, and the cost
  boundary is the traffic cap and connection budget.
- **Cost caps:** `tc` at 100 Mbit/s with fq_codel is a start condition of the relay (a relay without the cap cannot
  run, and a cron job stops it when the qdisc is missing), plus `nftables` connection budgets per IPv4 address and
  per IPv6 /64 (`relay-vps/nftables.conf`): new TCP connections to 80 and 443 at most 10/s and 50 concurrent per
  address, 50/s and 8000 concurrent globally; UDP 7842 (QAD, QUIC address discovery) 10/s per address and 50/s
  globally. The per-connection read limit is not the cost cap, because every new connection gets a full burst.
- **Processes and secrets:** the relay runs as the system user `iroh-relay` with `CAP_NET_BIND_SERVICE` only,
  `ProtectSystem=strict`, umask 0077 and systemd limits (`LimitNOFILE=65536`, `MemoryMax=1G`, `TasksMax=512`); the
  adapter runs as `DynamicUser` (`MemoryMax=256M`, `TasksMax=64`). The adapter and the metrics listen only on
  loopback; the relay program is pinned by sha256 in
  `install.sh`. The hook's bearer lives in a root-owned 0600 `EnvironmentFile` and leaves the VPS only as the Worker's
  secret; a leak means a new value on both sides. The certificate and ACME keys live in the relay's 0700 state
  directory, with a local 0600 backup.
- **Log and retention:** relay warnings carry the client's IP address and port and a shortened EndpointId; the
  adapter's decision line carries the first 10 hex characters of the EndpointId without an address. A prefix is not a
  hash: it still identifies the device. Both stay in journald for 7 days. Nothing records a full
  EndpointId or content.
- **Health:** alerts go to syslog with the tag `relay-alert`, and the canary `scripts/relay-canary.mjs` checks
  admission, refusal, read limit and burst from outside (the relay's `/healthz` returns a fixed "ok").

## iroh relay registry (`relay-auth/`)

The Cloudflare Worker `rarog-relay-auth` decides whom the iroh relay admits: a live app or server entry without an
administrator's refusal. Routes, quotas, storage consistency, configuration and deployment: `relay-auth/README.md`.

- **Getting in.** An app entry needs a signature with the app's iroh key (Ed25519, `issuedAt` within ±300 s) and
  proof from Apple (a DeviceCheck token or a successful silent APNs test push). The proof says "an Apple device with
  the publisher's app", not "this person"; device quotas, a daily brake and per-address limits bound how many keys
  one device or address can bring in. A server gets in only through a sponsorship by a registered app, so a foreign
  key without the app has no way to an entry.
- **Replay.** A signature has no one-time number: the same request within 300 s has the effect of the first. The
  routes are idempotent, and TLS protects requests in transit.
- **What it stores:** EndpointIds, the app–server sponsorship graph with random ids, expiry times, the refusal list,
  counters and a SHA-256 hash of the device token for the APNs gate (30 days). No DeviceCheck or APNs token, IP
  address or signature. An entry without app activity disappears after 90 days, a refusal after a year. A server
  without a live app is admitted at most until the removal trace runs (about 10 minutes), not for the sponsorship's
  term; the one exception is described in the README.
- **Where it stores it:** Durable Objects in the EU jurisdiction, which run and keep data only in the EU. The refusal
  list's KV mirror and Workers Logs are not bound to a region.
- **Secrets and their power:** `RELAY_HOOK_SECRET` (the relay's bearer) lets its holder check whether a key is in
  the registry; `ADMIN_SECRET` sets and lifts refusals, and a refusal of an app also shuts out the servers it alone
  sponsors. Both bearers need at least 32 characters, and a shorter one counts as missing; the gate's Apple key
  changes DeviceCheck bits or sends silent pushes. Each lives only in Worker secrets and the owner's secrets
  manager; a leak means a new value.
- **Fail open.** In shadow mode (`ENFORCE` other than `1`) the hook admits everyone; when enforcing, a Worker that
  does not know answers with no decision and the adapter admits. A refusal reaches the hook with the KV `cacheTtl`
  (60 s) plus propagation delay.
- **Log:** one line per request with allow-listed fields, no proof token, signature, bearer, IP address or server
  list; a full EndpointId appears only in shadow mode or during the `DIAG_UNTIL` window.
- **Cost of a flood:** headers, a 16 KiB body cap and per-address limits come before signature checks and Durable
  Objects; the hook routes are outside the zone Rate Limiting rule, because the adapter would turn a 429 into an
  admission. At the gate one client bucket (an IPv4 address, an IPv6 /48) holds at most one of the 32 queue places,
  so signed registrations from one client cannot block the others'; clients behind one NAT address register one
  after another.

## Resource caps and supply chain

- **Two caps with different roles:** the creation throttle (1 per 5 s, 40 per hour) and the **cap on Rarog's live
  panes** (`RAROG_MAX_PANES`, default **30**, from `DEFAULT_MAX_PANES` in code). The cap is NOT a security boundary,
  only a flood barrier against a loop creating panes without end, because the throttle counts RATE, not the total.
  The same phone usually has an SSH client to the Mac, so the perimeter is the private network plus Rarog's
  credential. Panes created by hand in herdr are not counted: Rarog did not create them.
- **Supply chain:** backend 5 direct deps (`zod`, `@rarog/shared`, `ws` for the console,
  `@anthropic-ai/claude-agent-sdk` for `listSessions()` and `@number0/iroh` for the iroh listener; APNs is
  `node:http2` and `node:crypto`). There is no web front end; the native app's pins, SwiftTerm 1.19.0 among them,
  are in `native/Rarog/README.md`. `ignore-scripts=true`, and `pnpm` installs from the lockfile. The repo root has
  two dependencies: `qrcode` 1.5.4 (MIT, no install scripts) for the QR code in `rarog pair`, and `tsx` 4.23.12,
  which runs the server (`rarog serve`); the server imports neither. `server/test/docs-zgodnosc.test.ts` holds the
  closed list with a reason per entry, so a new dependency without an entry fails the test.
- **The one native dependency** is `@number0/iroh`, pinned exactly. Its N-API module comes prebuilt in the platform
  package from `optionalDependencies`, without an install script. In the server process only
  `server/src/iroh/adapter.ts` loads it, outside it only the relay canary `scripts/relay-canary.mjs` in its own
  process (guard `server/test/iroh-granice.test.ts`); the npm package builder `scripts/package.mjs` never loads it.
- **The Claude SDK in the npm package** is not a dependency: `rarog setup` downloads it after asking, into
  `<dataDir>/sdk/<version>/`, with `npm ci` from a pin that has `integrity` for every entry, without install scripts
  or optional dependencies, and `node_modules` must hold exactly one package (`docs/distribution.md`, "Claude SDK").
  The directory is `0700`, owned by the server's user, a symlink is a refusal, and the server imports the SDK only
  when the package entry point, after `realpath`, lies in the version directory. Whoever can write `dataDir` can swap
  the SDK code the server runs at start, so `sdk/` has the regime of the rest of the data directory.
- **No package may run an install script:** `allowBuilds` in `pnpm-workspace.yaml` has not a single `true`; its only
  entry, `esbuild: false`, is a refusal written out. herdr creates the pseudo-terminal, and Rarog talks to it
  through a process and NDJSON.
- **The native app's one counterpart of an install script** is the SwiftTerm build plugin
  (`SwiftTermBuildInfoPlugin`), which runs at every build without asking (`-skipPackagePluginValidation`). The
  boundary is the `exact` pin and the commit (`revision`) from the two `Package.resolved` files, enforced by
  xcodebuild and `swift test` flags (guard `native-deps-pin.test.ts`).
- **`@anthropic-ai/claude-agent-sdk` comes in THIN.** A full install pulls optional platform packages and, through
  the peer `@modelcontextprotocol/sdk`, a whole HTTP stack (express, hono, ajv, body-parser) Rarog never imports.
  `ignoredOptionalDependencies` plus `autoInstallPeers: false` give 4.6 MB and one package, so the advisory surface
  does not grow.
- **The repo carries no data of the owner's installation**; the publishing guards enforce it. Structural patterns
  (an e-mail address, a MagicDNS suffix, a home directory with a login, and other data classes) always run; the name
  guard skips with a message where the private literals file is absent. Guards: `docs/publishing.md`.

## Work area: where Rarog starts, lists and reads

The project roots (`RAROG_PROJECT_ROOTS`) and the pane roots (`RAROG_HERDR_ROOTS`) each mark out a work area;
`rarog setup` suggests the home directory (`~`) for a new install, unless an installed hook copy differs from the
install (then `~/Projects`: an older copy reads only the roots). A path lies in the work area of a root list when:

- it lies in a root;
- it does not enter a hidden entry directly in that root (`~/.cache`, `~/.config` under the root `~`);
- it does not lie in a macOS-protected folder of home (`Desktop`, `Documents`, `Downloads`, `Library`, `Movies`,
  `Music`, `Pictures`; `server/src/config/protected-dirs.ts`), unless a root lies in that folder
  (`~/Documents/Projects`). A root `~` or `/` does not open them. Finding a protected folder compares names the way
  the default macOS disk folds them, not only by case, so `DESKTOP` and `Deſktop` (with a long s, U+017F) both name
  `Desktop`. A root in such a folder opens only the paths that match its spelling apart from letter case: the root
  `~/Documents/strasse` does not open `~/Documents/straße`, which is another folder on a case-sensitive disk.

One predicate, `insideWorkArea` in `server/src/config/work-area.ts`, answers for every consumer: the session and
terminal start (`validateProjectCwd`), the directory browser and creating a directory in it ("Creating a directory
from the New Session form" below), the project scan, pane scope (item 6 of "herdr sessions" below), the diff, the
session file listing and download ("Session files: listing and download" below), the command list, the voice agent,
attachment reads, and the permission and context hooks (`roots.json`). A protected folder is refused on the text of the path,
before the first `stat`, because a read there makes macOS ask for access, and nobody answers that prompt on a Mac used
remotely. Symlinks are resolved one segment at a time
(`resolveInWorkArea`), and the walk stops before an excluded folder, so `<root>/link -> ~/Desktop/x` is refused
without a read in `Desktop`. The walk starts from the roots and home in their on-disk form, so a root that is a
symlink to home (`/srv/home -> ~`) keeps `/srv/home/Desktop` out too. Pane scope, the diff, the command list, the
voice agent and attachment reads judge their directory this way as well (`inWorkAreaOnDisk`). There only the roots
and home resolve before the text check, and the text counts a root in both forms, so a root that is a symlink into a
protected folder (`/srv/code -> ~/Desktop/project`) opens the physical path a pane reports, as in the hooks, while
the rest of that folder is refused before any disk call for the directory. A path that resolves into the roots meets
the whole rule again there, so `<root ~>/visible -> ~/.cache/x` stays out, as in the hooks. A directory the walk
cannot resolve (deleted, unreadable) and a link that leads out of every root keep the verdict of their text, unless
the link ends in an excluded folder. The git row of a card (`git status` and the `.git` watcher) also serves a pane
outside the roots, but never a directory in an excluded folder, as written or through a symlink
(`inExcludedOnDisk`); there too only the roots resolve before the check, and a root that is a symlink into a
protected folder opens the physical path a pane reports. The project scan judges each folder as written and by its
name under the resolved root. The browser compares the resolved directory with the roots in the letter case stored
on disk, so a root written in another case still lists its folders. The hooks carry a copy of the walk
(`scripts/hooks/work-area.mjs`; one table of cases keeps the two equal). They too resolve only the roots before the
text check, so a root that is a symlink into a protected folder opens the path a session reports, and for them a
`cwd` that does not resolve is outside. The start and the browser keep a stricter rule on top: no hidden segment at
any depth below the root. Pane scope and the hooks allow a hidden folder deeper down, so agent worktrees under
`<project>/.claude/worktrees/` stay in scope.

The folder gate (`RAROG_FOLDER_GATE`, on by default on macOS; `docs/macos-folders.md`) changes no verdict above. With
it, a disk call of the work area whose target lies in a protected folder of home (a root there, or a symlink that
leads there) runs in a helper process of that folder, and a folder whose helper does not answer within 1 s is closed
until it answers: calls in it are refused with the sentence of its state, without the disk. Metadata, and so the
symlink walk, stays in the server process, because macOS answers it without a window. A walk that meets a closed
folder counts it as excluded, never as a segment it cannot resolve, so the directory is outside the work area, git
does not run there, and the browser answers 404 with the sentence of the folder's state. Pane scope alone ignores the
folder's state (item 6 of "herdr sessions").

The real boundary stays Rarog's credential: an agent in Auto mode reads the disk with the user's rights anyway. A
wide work area adds visible folder names of home and the risk of a start in the wrong place; the Claude Code trust
dialog still stands (item 8 of "Starting sessions from the phone", home is never trusted). A narrower area is a
matter of explicit roots in `config.json` and `rarog restart` (`docs/server-config.md`, "`rarog setup`").

## Creating a directory from the New Session form

`POST /api/fs/mkdir {parent, name}` creates one empty directory in a directory the browser lists, with the user's
rights (`server/src/fs-mkdir.ts`). It never overwrites, never removes (no `rmdir` after a refusal), creates one level
only and runs no `git init`. A device key can already start a session there and ask the agent for the same, so the
route adds a shorter way, not a new power, and stands under the switches that guard sessions.

**Switches.** Every demo, `RAROG_HERDR_LAUNCH=0` and `RAROG_HERDR_SEND=0` refuse it with 409 `mkdir-disabled`
before any disk access. The listing of a directory tells the app with `canCreate`, and the route asks again. In
review mode the route does not exist (class `absent`, "Review demo server").

**Name rule**, text only, before the disk: no lone surrogate; 1 to 255 bytes of UTF-8 after NFC; no leading dot (so
not `.` or `..`); no `/`, `:` or character of the classes `Cc`, `Cf`, `Zl` and `Zp` (controls, bidi and zero-width
marks, line separators); no white space at either end; and the name must be a row the listing could show
(`isListedChild` in `server/src/fs-browse.ts`: not `node_modules`, and under the root `~` not a protected folder of
home, compared the way the disk folds names, so `Movieſ` is refused even when `Movies` does not exist). A bad name is
400 `dir-name-invalid`, a protected folder 400 `path-not-allowed`. The NFC form goes to the disk and into the answer.

**Order:** the switches; the name; one request at a time in the whole server (another one in flight is 429
`mkdir-busy`); the parent steps of the listing (`resolveListedDir`: absolute, no hidden segment, in the roots and the
work area as written and after the symlink walk, 404 when missing); the name as a row of that parent; then the device
check again and the start of the child in the same tick, with no `await` between them. The server writes one log line
in English with the path as JSON after secrets are wiped, so a parent name with a line break, ESC or a bidi mark stays
on one line; a refusal logs neither the parent nor the name.

**The child.** The directory is made by a child process, never in the server process: `node` from `process.execPath`
with `--input-type=module -e` and a fixed source (`server/src/fs-mkdir-child.ts`), no shell, an empty environment
(no `NODE_OPTIONS`, no `PATH`), `cwd` `/`, no stdin or stderr, 10 s and then `SIGKILL`. It gets the parent exactly as
the server resolved it on disk (`realpath`), changes into it, refuses with `MOVED` when `process.cwd()` is another
path, and creates one relative segment there. Its working directory is the directory object it entered, so a segment
of the path that an agent swaps for a symlink after that point does not move the write. It prints one code from a
closed list. Only exit code 0 with `OK` is success; `EEXIST` is 409 `dir-exists` (a directory, a file or a symlink,
dangling or not, already has the name; nothing is overwritten), `MOVED` is 400 `path-not-allowed`, a missing parent
404, and a signal, the time limit, another code or no answer 500. Its arguments and stderr never reach the log.

**What it does not guarantee:**

- An agent that writes in the parent's tree can move the directory after the check, only to a place it can write
  itself (outside the roots too, such as its temporary directory); the answer then names a path where the new
  directory is not.
- Between the server's check and the child's change of directory, an agent can point the parent path at a directory
  outside the work area. The child refuses (`MOVED`), but it has entered that directory, and reading its own working
  directory opens it. Whether that raises the macOS access prompt for a protected folder (`~/Desktop/x`) is not
  measured.
- A directory in a tree an agent writes need not be empty when a session starts in it.
- A device revoked after the child started does not undo the directory.
- Not measured: Linux, Node 22.15, case-sensitive volumes and network shares.

## herdr sessions: Rarog writes to a terminal it does not own

herdr is the terminal multiplexer Rarog runs sessions in. Rarog has no engine process of its own: it attaches to a
LIVE `claude` pane in herdr, and this is the only kind of Rarog session, so the rules below apply to the whole
product. The target belongs to the user and runs real client code. The powers to start a process, close a pane and
send a digit: "Starting sessions from the phone" below.

1. **The only real boundary is Rarog's credential.** Both allow-lists (methods and keys) live in the same process as
   the HTTP router, and the herdr socket authorizes only by file permissions. They are **guards against a
   programmer's mistake** and against a silent widening of scope, not a security boundary: whoever has Rarog's
   credential has an execution channel on the Mac.
2. **Socket method allow-list** (`server/src/herdr/socket.ts`), checked BEFORE any bytes are written. The list is
   `READ_METHODS ∪ MUTATING_METHODS`, and a test counts the set difference, so no method joins without an explicit
   read-or-write decision and none bypasses `RAROG_HERDR_SEND=0`. `subscribe()` passes the same gate
   (`assertMethodAllowed`). Today the list has 23 methods: 11 reads (`ping`, `agent.list`, `agent.get`,
   `agent.read`, `events.subscribe`, `pane.list`, `pane.read`, `pane.process_info`, `pane.layout`, `tab.get`,
   `workspace.list`) and 12 writes (`agent.prompt`, `agent.send_keys`, `agent.focus`, `workspace.create`,
   `tab.create`, `agent.start`, `pane.report_metadata`, `tab.close`, `pane.close`, `pane.rename`, `tab.rename`,
   `pane.send_input`). The principles:
   - **Outside the list by contract:** `server.stop`, `server.live_handoff`, `server.reload_config`, `agent.rename`,
     `agent.wait`, `pane.split`, `pane.move`, `pane.send_text`, `pane.send_keys`, `pane.input.set`,
     `workspace.close`, `session.snapshot`, `integration.*`, `plugin.*`, `worktree.*`, `layout.*`, `popup.*`,
     `notification.show`. `pane.send_text` and `pane.send_keys` would write into someone else's shell past every
     gate in this document.
   - **`pane.send_input` is paste only.** Its only caller is `HerdrClient.pasteText`, which builds a body with
     `pane_id` and `text` and never `keys`, so herdr pastes the text (bracketed paste) and presses nothing. The
     driver calls it only for a message to a Claude pane during a turn, after a fresh `agent.get` shows the same
     Claude session at that pane address (the method also writes to a pane without an agent) and after the checks
     in `docs/dialogs.md`, "Sending while a turn runs". It is a WRITE: `RAROG_HERDR_SEND=0` switches it off.
   - **Console pane ownership.** `pane.close` is the only method that closes something addressed by PANE, and herdr
     pane ids are positional, so its ONLY caller (`term/herdr-backend.ts`) closes only a pane that carries the
     `rarog-term` token in a FRESH `pane.list`. Three READS of a console pane share that gate: `pane.read`,
     `pane.process_info` and `pane.layout` (point 10 of "Emergency console"). They are reads on purpose: with
     `RAROG_HERDR_SEND=0` Rarog still sees its own shell, and they change nothing.
   - **`workspace.list` is a READ** (labels and checkout paths, `worktree.checkout_path`/`repo_root`) for choosing
     where to open the tab of a new session or console, because `pane.cwd` drifts with every `cd`. The facade lets in
     only the id, the label and the two paths. It adds no power: a wrong choice puts a Rarog tab into another
     workspace (cosmetic), and ownership gates look at the pane token, not the workspace.
   - **Labels are WRITES.** `pane.rename` and `tab.rename` change what the Mac shows (the pane label is proof of
     origin and survives a herdr restart). `RAROG_HERDR_SEND=0` switches them off. The
     callers are the launcher (its fresh pane and tab), the console backend (fresh console panes and tabs, label
     migration onto a pane that already carries the token) and the supervisor (the Claude tab label follows the card
     label, migration of Claude panes without an origin label). The facade rejects an empty string and control
     characters (herdr does not normalize labels). A pane label leads with the pane's tab label (40 code points at
     most) and ends with the origin; the description repeats what the tab label already shows in the herdr snapshot
     (a card title, a name given by hand, a console tab's directory name), so it exposes nothing new. Only a pane
     alone in its tab gets one, and a bare origin label gets it by migration under the same gates.
   - **The right to `tab.rename` after a tab exists** applies ONLY to a single-pane tab (`tab.get`, a read, every
     time) whose pane carries Rarog's origin label (`rarog-claude …` with the `claude` agent, or `rarog-term <id>`
     with that identity's token). A tab label that differs from the computed one, from the one Rarog set and from
     "1" given by `workspace.create` is MANUAL and stays untouched. Every write follows a fresh `pane.list`. Migrating
     unlabeled Claude tabs is a heuristic, not proof of authorship: a mistake renames a tab that holds a Rarog agent.
     A label gives recognition, not power: ownership of a Claude pane comes from the agent name `rarog-<6 hex>` ∪ the
     agent keys of the current process, and anyone with socket access can set a label, as they can a token.
   - **After a herdr restart nothing from Rarog's registry reaches a pane address without fresh proof.** A blind
     re-stamp would hit a positional address that may belong to another pane. The only stamp is the console token
     `reconcile` restores, ONLY to a pane whose label ends in `rarog-term <id>` in a fresh `pane.list`, with the
     value from that label, re-read right before every write. Two panes with one identity, or the label next to
     another token, is a conflict: nothing happens. A false hit is possible (anyone with socket access can set such
     a label) but adds no exposure, because the same access can write the token, and adoption still requires the
     identity to be the hash of the pane's path.
3. **Key allow-list** (`herdr/dialogs/send/keys.ts`, `ALLOWED_KEYS`): `escape`, `ctrl+c` and the digits `1`…`9`.
   **`up` and `down` are NOT on it, by design:** choosing by POSITION is what rule 15 of "Starting sessions from the
   phone" forbids. **`enter` is not on it either.** It has a SEPARATE single-key path
   (`herdr/dialogs/send/form-submit.ts`, client method `sendFormSubmit`) for an `AskUserQuestion` form with a
   preview, where a digit only moves the highlight (measured, CLI 2.1.246): `enter` goes out only after proof from a
   FRESH screen that exactly one `❯` stands on the CHOSEN label of THE SAME question, outside note mode, exactly once,
   within the same lock. `shift+tab` (cycles the permission mode of the WHOLE session) has a THIRD separate path
   (`herdr/mode-cycle.ts`, `sendModeCycle`), called only from the driver's "press → read the footer → compare" loop
   (`setMode`), with a cap of 6 presses and a stop when the footer is not visible or a turn starts. The folder trust
   dialog without digits has a FOURTH separate path (`herdr/dialogs/send/trust-step.ts`, client method
   `sendTrustStep`, one key per call): `down` only while `❯` stands on "No", then `enter` only while `❯` stands on
   "Yes", each after a FRESH screen shows the full trust dialog with the card's fingerprint and folder, the folder
   (on one line, never pieced together from a wrap) equal to the session `cwd`, the same card, blocked state and
   engine session. The card, blocked state and engine session are checked again right before the key, with nothing
   awaited before the send. Any other read stops the path without a key, and the path never sends `escape` (Esc
   ends the `claude` process there). A wrong key here opens someone else's repo hooks and settings, so a test guards
   that no other send path uses these keys (`docs/dialogs.md`, "Folder trust dialog without digits"). A message to a
   Claude pane during a turn has a FIFTH separate path (`herdr/dialogs/send/prompt-submit.ts`, client method
   `sendPromptSubmit`): exactly `enter`, at most once per paste, only after the pasted text stands in the prompt
   field and the CLI session registry and the consent hook show no dialog (`docs/dialogs.md`, "Sending while a turn
   runs"); a test guards that only the driver calls it, from one place. A layer 2 card (`docs/dialog-card.md`,
   "Answer") has a SIXTH separate path (`herdr/dialogs/send/key-row.ts`, client method `sendDialogKey`): exactly one
   of `up`, `down`, `left`, `right`, `tab` and `enter` per call, and only a key that a footer segment of the block
   names ("→ to adjust", "Enter to confirm"; measured, CLI 2.1.322). The phone sends the label, never the key: the
   digit or key comes from the server's record of the card occurrence. Every key of such a card, digits and Esc
   included, goes out only after the layer 2 step: the occurrence still stands, the process registry reports
   `waiting` with class `dialog` and no hook consent request waits, a FRESH screen shows the same block fingerprint
   with the tapped label on the same digit or key, and right before the key, with nothing awaited, there is no hook
   registration, the same engine session and the same card. One occurrence gives at most one key; the next key needs
   a new card after a new pair of equal reads. A test guards that only the driver calls `sendDialogKey` and that these
   keys stay off `ALLOWED_KEYS`. The step cannot close one gap: herdr has no atomic compare-and-send, so a dialog
   swapped at the desk in the milliseconds between the last read and the key gets that key. The verify read after the
   key then logs `other-dialog` with a warning; nothing can undo the key. Taking the prompt queue back into the app
   has a SEVENTH separate path (`herdr/dialogs/send/take-back-keys.ts`, client method `sendTakeBackKey`): exactly one
   of `up`, `down` and `ctrl+u` per call, checked before the socket. In the prompt field none of them sends anything
   to the agent (measured, CLI 2.1.328): `up` on an empty field takes every prompt of the CLI queue back into the
   field, `down` brings back the field after `up` opened a history entry on an empty queue, and `ctrl+u` deletes one
   screen line of the field without interrupting the turn. They stay off `ALLOWED_KEYS` because the arrows move the
   highlight of a standing dialog: in a permission dialog `up` moved it from the first option to the last, in an
   `AskUserQuestion` form `up` and `down` both moved it, and `ctrl+u` changed neither (measured, CLI 2.1.328). On
   the shared list the arrows would open choice by position to every path. This path never sends `enter` or a digit,
   so a permission dialog or form that gets one of these keys instead of the prompt field gets a moved highlight
   and no answer (measured, CLI 2.1.328); Enter pressed at the Mac then confirms the option the highlight stands on.
   A test guards that nothing but the driver's queue take-back module (`server/src/drivers/herdr/queue-take-back.ts`)
   may call `sendTakeBackKey`, from one place, and that the three keys stay off `ALLOWED_KEYS`. `ctrl+v`, `ctrl+d`,
   `ctrl+z` and letters stay outside every list.
4. **Text channel allow-list** (`herdr/commands/`). A `!` prefix is rejected (`#` passes). Text shaped like a CLI
   command goes out only under a canonical name from the session catalog: the registry of measured built-in commands
   (`registry.ts`) ∪ skills and commands from disk in the described subset (`discover.ts`; `docs/slash-commands.md`,
   "Session catalog and discovery"). A refusal is EXPLICIT (400 with the name and a hint) and leaves a `refuse`
   entry with reason `command-not-allowed` in `herdr-audit.log` (rule 8). An argument that redirects an allowed skill
   to a command outside the list (`/code-review ultra`) is refused; so is a name in the command name shape without a
   slash (how the CLI treats it is unmeasured) and text equal to an exit word (`quit`). Recognition matters for
   security, because a command skips the stall guard, which can send text a SECOND time; the manager classifies once
   and a second guard in the driver classifies again from the same snapshot, and a mismatch is a refusal. A deny-list
   of exact names would not be a boundary: the CLI runs a prefix (`/usa` → `/usage`), an alias (`/settings x=1` →
   `/config x=1`) and a different letter case (`docs/slash-commands.md`, "Measurements"). `/model` and `/effort` go
   only through the internal path, `/exit` only through the restart path, and `/rc` and `/remote-control` are off the
   list (Remote Control is turned on only from the terminal and the Claude app).
   **`/model` and `/effort` are off the free-text allow-list because `/model` overwrites `~/.claude/settings.json`**,
   the account's GLOBAL default model. The only path is a confirmed endpoint (`POST /api/sessions/:id/model`) with an
   explicit warning about the global effect; Rarog does not restore the previous value (that would race other
   sessions). The same endpoint turns ultracode on and off (`/effort ultracode`, `/effort ultracode off`), accepted
   only whole and from the command registry. Ultracode works only in this session but is a new power in someone
   else's pane (per the `workflows` docs a turn costs more tokens, and in `auto` mode the CLI does not ask before the
   first workflow), so the change requires a Claude Code process of at least `ULTRACODE_MIN_CLI` (400 otherwise). The
   app's list (`GET /api/sessions/:id/commands`) is the same snapshot behind the catalog's read gates (a pane out of
   scope, Codex, or a directory outside the work area → 400), because it carries skill names and descriptions.
5. **The pane's permission mode is read and shown** (chip `manual`/`plan`/`auto`/`bypass`), and a send to a pane in
   `bypass permissions` requires `cwd ∈ RAROG_YOLO_ROOTS` (the same rule applies when STARTING a session). Membership
   is computed on the REALPATH (`isInsideAnyRootReal`): a symlink inside a yolo root that points to another repo is
   not yolo, and an unresolvable path fails closed. A message that waits in the driver's paste queue during a turn
   passes the same text gate again, with the pane's CURRENT mode, before every key it sends (an Esc pair that clears
   the field, the paste, the Enter); a refusal ends the message with the reason in the transcript, so a switch to
   `bypass` while the message waits sends nothing. `auto`, `plan` and `manual` are not blocked (most real panes run
   in `auto`); the user must SEE the mode on the chip before dictating. The chip is a BUTTON that toggles `plan` ↔
   `auto` (`POST /api/sessions/:id/mode`) with the `/model` gates plus a known starting mode (400) that is not
   `bypass` (409). Rarog never targets `bypass` and never moves out of it; every press is audited.
6. **Pane scope is the work area of `RAROG_HERDR_ROOTS`** (default: `RAROG_PROJECT_ROOTS`; "Work area" above). With
   the root `~` that is every Claude pane in home outside its hidden entries and the protected folders. Scope ignores
   the folder gate: a pane in a protected folder that a root opens stays in scope while macOS keeps that folder closed,
   also after a `cd` into it, and the features in `docs/macos-folders.md`, "What a closed folder refuses", refuse
   instead. A pane outside the work area shows as an out-of-scope card (state and project) without a transcript,
   sends, `ctrl+c`, dialog denial or SCREEN EXCERPT. Scope is LIVE: a `cd` out of the work area forces a reattach of
   the driver (Rarog's per-pane reader and writer), so the pane loses transcript and send together with the directory
   change.
   A consent channel card of such a pane gets no approval: `allow` is 400 before the server writes an answer file,
   the same refusal as with `RAROG_HERDR_SEND=0` or a read-only supervisor. The gate is computed on the session card
   that handles the conversation, and a live card of the same conversation outside the roots refuses too (the hook
   may belong to that pane). A decision through another card of the same conversation (the card of a pane the
   conversation moved away from) is 410 with no file. Denial and release still go to the hook file, because they
   approve nothing and take the card off the phone; no key reaches the pane.
   The same gate covers the files NEXT to the transcript (a workflow run's journal and script, subagent transcripts
   `<session>/subagents/agent-<id>.jsonl`, the same data class). From a subagent file Rarog takes the time of the last
   entry and the starts of its own background commands; the phone gets their TEXT (`ownTasks[].command`, up to 1000
   characters, at most 20 per agent), the same class as the main file's task list, and the app does not write it to
   disk (`SnapshotCacheFile.scrub`). The agent id passes a shape guard before it reaches a path. The preference
   `RAROG_AGENT_FILES=0` turns this reading off.
   Rarog reads the main file WHOLE on attach. The part before the history window streams only to the background task
   reducer and the session's artifact list (`docs/artifacts.md`); only lines about tasks or with an artifact address
   are parsed, and a publish result never gives the file path, `instructions` or the file list. A pane that falls
   out of scope loses both lists when its driver is swapped. Conversation content from before the window never
   reaches the transcript, the log or the disk; the log carries only counts.
   For the session's pull request list (`docs/pull-requests.md`) Rarog reads the main file and ALL subagent and
   workflow agent files of the conversation, also of finished agents. In a workflow agent file this is the content
   (the `Bash` calls and their results), not only the tag of the first line that the run layout reader takes. Only
   lines with `create`, `/pull/`, `backgroundTaskId` or `task-notification` are parsed, and only the PR URL,
   repository, number, time and the literal `--title` value leave the server; the command body, paths and output
   never do. Subagent and workflow agent files
   are read only when `RAROG_AGENT_FILES` allows it. One file outside the conversation files is read too: the
   output file of a recognized `gh pr create` that ran in the background, named by the CLI's end notification in
   the same conversation file. The agent in the sandbox can write that directory, so the path must have the CLI's
   shape (`…/<uuid>/tasks/<task id>.output`, absolute, without `..`) and the file is read through `safe-read.ts`:
   no symlink, a regular file only, at most 64 KiB; anything else gives no PR. Only the PR URL leaves that file.
   The app does not write the list to disk (`SnapshotCacheFile.scrub`), because the URL names the repository, also
   a private one.
   For the session's scheduled tasks (`docs/scheduled-tasks.md`) Rarog reads the main file again, whole and then
   incrementally, never a subagent file. Only lines with a cron tool, run or carry literal, or the id of a pending
   cron call, are parsed; the task id, pattern, times and the prompt (one line, at most 120 UTF-16 units) leave the
   server.
7. **Write channel limits:** `MAX_HERDR_PROMPT_BYTES = 512 kB` (a herdr pane takes large pastes at the Mac), C0/ANSI
   sanitizing, a cap of 240 sends per hour globally, and 1 s per session between `/model` or mode-cycle commands.
   Without them the `/messages` endpoint (body limit 120 MB) would push 120 MB of bracketed paste into the live
   pane's pty. The throttle protects against a loop in Rarog's code. A prompt counts only toward the hourly cap: it
   reaches the pane in order of acceptance through the session's send queue, so a quick second prompt waits there
   instead of getting a 429.
8. **Audit log** (`<dataDir>/herdr-audit.log`, 0600, rotated at 8 MB): every `prompt` and `send_keys` with a sha256
   of the whole text and its first 200 characters **AFTER redaction** (`redactAuditText`: process secrets, and every
   `KEY=value` keeps the name and masks the value). The full text never reaches the file. A `prompt` the voice agent
   sent (`source` of the message body) carries `"sender":"voice-agent"`; that is the only value that reaches the file,
   and a prompt without it is a message as any other (`docs/companion.md`, "Sending from the conversation"). The
   closed union of methods has eleven values: `prompt`, `send_keys`, `approve`, `launch`, `close_tab`, `model_change`,
   `restart`, `refuse`,
   `degrade` (a card without a decision), `answer-hook` (an `AskUserQuestion` answer delivered through the HOOK
   CHANNEL, without a key) and `block-card` (a card built from the screen alone: block fingerprint, option count and
   button verdict, no content; `docs/dialogs.md`, "Case shape in the log"). `refuse`, `degrade` and `block-card` are
   the only methods where not one byte went to the pane; `refuse` and `degrade` carry a reason from a closed list
   (`REFUSE_REASONS` in `shared/src/protocol.ts`, plus `command-not-allowed` from `AUDIT_ONLY_REFUSE_REASONS` with
   only the first token of the message, redacted, at most 64 characters) and the SHAPE of the case (card and call
   ids, card source, numbers from the screen), without keys or content. Ids from the hook dump are untrusted: a
   value outside the id shape never reaches the file (`auditShapeFields`), and `toolName` from a hook card is
   redacted and capped at 200 characters like a label. Two reasons are worth knowing: `consent-dialog` is a CLI
   consent prompt herdr does NOT see (status `idle`,
   recognized by screen shape, no approval on the card), and `form-submit` is the only reason AFTER a sent key (the
   digit went, `enter` did not). Screen-path reasons are computed from the screen read (`unreadable`, `multi-select`
   and `no-jsonl` count separately), and the full context of a refusal lies in `refusals/` (rule 9 of "Starting
   sessions from the phone"). A dialog reported by the CLI session registry (`status: waiting`) gets the ordinary
   judgment; its class (`cliDialog`, a closed list) goes on the card and into the `degrade` entry, adding no buttons.
9. **The protocol gate is a minimum.** The gate reads the `protocol` number of herdr's `ping`. No number, or a
   number below the minimum of the tested set (`KNOWN_PROTOCOLS` in `server/src/herdr/socket.ts`, `{22}`, measured
   on herdr 0.9.0–0.9.5), turns integration off. Every number at or above the minimum gets full integration, also
   one above the tested maximum, and writes follow `RAROG_HERDR_SEND` exactly as on a tested number, so a newer
   herdr does not stop Rarog. Numbers 20 and 21 are below the minimum: on 20 `agent.prompt` has other semantics, and
   the dialog parser is measured on 22. Invariant: only the set's MINIMUM gates, so dropping or replacing its oldest
   number turns that protocol off. On an untested number these checks still hold. The method allow-list
   (`ALLOWED_METHODS`, writes only from `MUTATING_METHODS`) is checked before any byte reaches the socket. A response
   that is not JSON, not an object or carries another request's id fails as unavailable. The client parses read
   results with schemas that ignore new fields: a missing required field or a field of another type makes the result
   an error or drops its entry (an `agent.list` entry), and a missing optional field is read as absent. Write results
   get less: `agent.prompt` and `agent.start` check only the response envelope, and `agent.start` reads an `argv` it
   cannot parse as empty (the field is for audit only). A screen Rarog cannot match to its dialog gives a card
   without approve buttons, only deny (`degradedCard` in `server/src/herdr/dialogs/cards/build.ts`).
   None of them notices a write method that keeps its shape and changes its meaning, and the protocol number does
   not either (herdr 0.8.2 changed `agent prompt` without a new number).
   `RAROG_HERDR_SEND=0` turns writes off on such a herdr. Adding a number after `herdr update` records a measurement
   and changes nothing at runtime: read the changelog and `herdr api schema --json` for the allow-listed methods,
   then run
   `RAROG_TEST_HERDR=1 pnpm test server/test/term-integration.test.ts` outside the sandbox (the block creates its
   OWN workspace and closes it, also after a failure; a red console paste test means a paste would go out as a
   series of Enters). This does NOT catch changes in herdr's state detection rules, which herdr fetches from the
   network; checking herdr's verdict on the dialog fixtures: `docs/dialogs.md`,
   "Dialog detection in herdr". `capabilities.endpoint_protocol_generation` from the pong is only a diagnostic field
   (`HerdrSocketStatus.generation`), never a gate. The gate's memo clears on EVERY socket loss, so after
   `herdr update --handoff` the first request pings again.
10. **Traversal.** `agentSessionId` goes into the `join()` of the transcript path, so it must pass
    `ENGINE_SESSION_ID_PATTERN`. The value comes from herdr, but Rarog treats it as UNTRUSTED input.
11. **The screen does not leak beyond SSE.** Screen text may be stored only from `--source detection`: the dialog
    excerpt ON the session card (`SessionSummary.herdrDialogScreen`, never in the transcript) and the screen tail on a
    failed pane start (`HerdrLaunchTimeoutError`, `goneReason` → `stateDetail`). From `--source visible` Rarog stores
    only the recognized mode, never text (the screen can hold `.env` content or a key in a command); the only
    `visible` in `supervisor.ts` handles the mode footer, guarded by a contract test. A push for a herdr session
    carries only the project name and a waiting line ("Push notifications"). The global channel carries
    `SessionSummary.waitingFor`: the FIRST line of the decision's content, cut to 120 characters, and for a tool
    without a `command` field only the PATH (`Edit`, `Write`, `Read`); never plan content (`ExitPlanMode`), the
    degraded card's sentence or the screen excerpt. The global and the session channel differ in subscription scope,
    not in permission.
12. **Uploads:** the directory `<cwd>/.rarog-uploads/` with `0700`, files `0600`, a 48 h sweep on write and at start,
    and an entry in `<cwd>/.git/info/exclude` (not in someone else's tracked `.gitignore`). The directory sits in the
    pane's workspace on purpose: a file outside it would trigger a `Read` dialog for every attachment. Writes,
    thumbnail reads, the sweep and the `exclude` entry touch only this directory (`UPLOAD_DIR_NAME`).
    - **The start sweep runs in the background:** the server listens without waiting for it.
    - **The start sweep cleans only directories the server wrote to.** Every successful attachment write records
      the real path (`realpath`) of its `<cwd>` in `<dataDir>/uploads-dirs.json`, and so does a write the folder
      gate refused (`docs/macos-folders.md`), because a write its helper did not answer in time may still land
      (`server/src/herdr/uploads-registry.ts`; `0600`, atomic write, writes queued in one chain); a `<cwd>` whose
      real path cannot be read is not recorded. The start sweep reads that list and lists no root. With the folder
      gate on, it enters no protected folder of home before the gate holds that folder `open`; that part of the sweep
      waits and runs when the folder opens. An entry is the
      `<cwd>`, and the sweep appends `.rarog-uploads` itself, so the registry reaches no other directory and grants
      no new power; an entry outside the current roots is swept too, because the server wrote there. Before the
      sweep, `realpath` of the entry must give the entry itself. When the project directory or a parent has since
      become a symlink, `<cwd>/.rarog-uploads` would lie in another tree: the entry leaves the list with one log
      line, and no file is touched. An entry whose `.rarog-uploads` is gone, is not a directory, or is empty after
      the sweep leaves the list too; a missing project directory or a read error does not stop the other entries,
      and an entry that could not be read stays for the next start.
    - **Without the registry, one walk of the roots.** When the file is missing, or unreadable (one log line), the
      sweep walks each root of `RAROG_HERDR_ROOTS` three levels down, skips hidden folders and `node_modules`, and
      does not enter the macOS-protected folders in the home directory (`Desktop`, `Documents`, `Downloads`,
      `Library`, `Movies`, `Music`, `Pictures`; `server/src/config/protected-dirs.ts`): reading one makes macOS ask
      for access, and nobody answers that prompt on a Mac used remotely. A root that lies in such a folder
      (`~/Documents/Projects`) is swept as usual. Home and roots are compared in their real on-disk form, so a root
      that names home in another case or through a symlink does not open those folders. With the folder gate on, a
      root in a protected folder that the gate does not hold `open` yet is swept when the folder opens, and only
      while its path still resolves to itself: a directory that has since become a symlink is skipped with one log
      line, and no file under it is touched. The walk then writes the
      registry with the directories where files remain or whose `.rarog-uploads` could not be read, so the next
      start reads the registry, walks nothing, and tries the unread ones again. It writes the registry only after
      every part of the walk ran, a root that waited for its folder included. The walk enters no symlinked
      directory, so its entries are real paths. An
      attachment write that finds no registry file keeps its directory in memory until the walk writes the file, so
      a server stopped during the walk, or before a waiting folder opened, walks again at the next start.
    - **Rarog does not follow symlinks.** `.rarog-uploads` and `.git` as symlinks (git materializes them on an
      ordinary `clone`) get an `lstat` BEFORE `mkdir`/`chmod`/`readdir`/`unlink`: a symlink is an `UploadError`, and
      the sweep skips it. Otherwise the startup sweep would delete files older than 48 h in the symlink's TARGET.
    - **Regular files only:** image and `.git/info/exclude` reads go through `safe-read.ts` ("Special files in the
      project directory").
    - **Files take THE SAME path as images** and differ only in limits and in the original name being part of the
      name on disk: `<unix-ms>-<8 hex>-<sanitized name>`. Sanitizing counts code points and takes the `basename` after
      `/` **and** `\` (the name is untrusted input): `[^A-Za-z0-9._-]` → `-`, a leading dot gets the prefix
      `FALLBACK_UPLOAD_NAME` plus `-`, at most 80 characters, and a result without a letter or digit becomes
      `FALLBACK_UPLOAD_NAME`.
    - **The limits are a shared contract** (`shared/src/protocol.ts`, enforced before the write, 413 without touching
      the disk): 4 files per message, 27 MB per `dataUrl` (20 MB of raw file), a 120-character name, a mandatory
      `;base64,`; images 5 per message and about 1.5 MB per `dataUrl` (`MAX_IMAGES_PER_MESSAGE`,
      `MAX_IMAGE_DATA_URL_BYTES`). `POST /api/sessions/:id/messages` is the ONLY endpoint with a raised body cap
      (120 MB); the rest of the API stays at 64 kB.
    - **The file type is NOT restricted**, on purpose: Rarog opens and parses nothing, it writes bytes and appends the
      path to the prompt; the agent asks for `Read` permission outside trusted directories anyway.
    - **Neither the path nor the BYTES of an attachment enter the transcript.** The user echo carries the text and
      attachment cards (`kind`, `name`, `bytes`, `mime`) only: a local Mac path is not conversation content, and the
      bytes already lie in `.rarog-uploads`.
    - **The server thumbnail is the ONLY read path into `.rarog-uploads`.** An IMAGE card carries `file`, the bare
      name Rarog gave, and the app asks for the bytes with `GET /api/sessions/:id/uploads/:file` behind the
      credential gate. The server adds the directory from the SESSION's `cwd`; the name must pass the pattern `write`
      uses (`UPLOAD_IMAGE_FILE_PATTERN`), so `..`, a slash and a user's PDF fail BEFORE `join`; the file opens with
      `O_NOFOLLOW` and `fstat` on the same descriptor; file attachments never leave this way. Every miss is 404 and an
      image tile. For history from jsonl the name comes from the companion entry `[Image: source: …]` (`isMeta`) only
      when the path's tail after `/.rarog-uploads/` passes the pattern; an image pasted in the terminal stays
      `IMAGE_PLACEHOLDER`.
13. **No shell execution.** Rarog talks to herdr over the socket, and every child process of the server is a program
    from a closed list, started without a shell (`execFile`/`spawn` with an argument array): `git` ("Git reads"), the
    console controller `herdr terminal session control <pane> --takeover` ("Emergency console"),
    `tailscale status --json --peers=false` (the tailnet name), `claude agents --json` (the recent sessions list and
    the two-writer gate: Rarog does not start `claude --resume` on a conversation a live `claude` process still
    writes, because two processes would write one transcript), `/usr/sbin/sysctl -n kern.memorystatus_level`
    (Mac load), `claude -p` with the isolation flags of `server/src/companion/cli-literals.ts` (the voice agent,
    started only from `server/src/companion/cli.ts`; "Voice agent: questions about a session through `claude -p`")
    and `node` from `process.execPath` with a fixed `-e` source that creates one directory
    (`server/src/fs-mkdir-child.ts`; "Creating a directory from the New Session form").
14. **Local socket only.** An absolute path without `..`, and the file must be a unix socket (`isSocket()`). No TCP.
15. **Hiding ≠ closing.** `close()` WITHOUT `closePanel` on a herdr session does not touch the pane: it detaches the
    driver and removes the card, and the live pane comes back at the next resync. The UI uses this path only for
    `resumable` sessions; × on a session with a pane closes the pane. The manager's `dispose()` and Rarog's SIGTERM
    send not a single byte to panes: a driver with `ownsProcess: false` never gets `interrupt()`.
16. **Fail closed at start.** herdr integration is not optional: without it Rarog shows NOT A SINGLE session, and an
    unavailable socket means an empty list and a banner, never a 500. The herdr killswitches are `RAROG_HERDR_SEND=0`
    (see, but do not touch) and `RAROG_HERDR_LAUNCH=0`, the default (create no panes); rule 18 of "Starting sessions
    from the phone" lists all killswitches.
17. **The risk classifier gets the FULL input, or nothing.** The permission card's content comes from the jsonl, so
    `classifyRisk` sees the call's whole `tool_input`. A card without input (a dialog outside the jsonl, a name
    mismatch, a failed parse) gets `risk: 'red'` **without asking the classifier** and no Allow buttons
    (`canAllow: false`).

## Starting sessions from the phone: three powers

Rarog has no gate that ENFORCES consent in its own process: the CLI in the pane enforces consent, and Rarog sends
it only text and keys. **This is the most important sentence of this section.** Everything else (allow-lists of
methods, keys, flags) is a guard against a programmer's mistake, not a security boundary, and is named so. The 18
rules below keep the three powers, **start a process, close a pane, press a digit**, as narrow as possible.

1. **The only real boundary is Rarog's credential** (the device key). Whoever has a device key can start a
   `claude` process on the Mac.
2. **Creating and closing methods are writes:** `workspace.create`, `tab.create`, `agent.start`,
   `pane.report_metadata` and `tab.close` are in `MUTATING_METHODS`, so `RAROG_HERDR_SEND=0` covers creation.
3. **`claude` flag allow-list and ZERO positional arguments.** `agent.start` types a line into the pane's SHELL, so
   every argv element is shell text. Allowed: `--session-id`, `--model`, `--effort`, `--permission-mode`,
   `--resume`, `--fork-session`. `--effort` carries a level from `EFFORT_LEVELS` or `ultracode` (the CLI then sets
   `xhigh`; ultracode with another level throws while building argv); ultracode raises the cost of a turn, so it has a
   Claude Code version gate. Values pass `ARG_VALUE_PATTERN` (`^[A-Za-z0-9._:@=[\]-]{1,64}$`; brackets for
   `opus[1m]`), so `'`, `$( )`, a backtick, a space and `\n` cannot get in. Never: `--dangerously-skip-permissions`,
   `--system-prompt`, `--append-system-prompt`, `--mcp-config`, `--settings`, `--add-dir`, `--continue`.
4. **The user's prompt NEVER enters argv.** It goes as `agent.prompt` after `interactive_ready`, the same channel as
   every other send (`assertSendable`, throttle, audit). `agent.start` carries an explicit `timeout_ms`
   (`HERDR_START_WAIT_MS` = 60 s, socket cap 65 s; in herdr 0.9.x `timeout_ms` is the LIFETIME of the start record).
   An UNKNOWN start result (transport timeout, broken socket) does NOT clean up the tab: `agent.start` may have run,
   and a blind `closeTab` would kill a pane with a live agent. The tab stays a visible orphan until the next resync;
   cleanup follows only a DEFINITE herdr refusal.
5. **`bypassPermissions` at start requires `RAROG_YOLO_ROOTS`.** The same rule as for sends, except that here Rarog
   CHOOSES the mode. Membership by REALPATH (rule 5 of "herdr sessions"): a symlink does not widen the boundary.
   A start with no mode chosen passes no `--permission-mode`, so Claude Code takes the mode from its settings, and
   the repository's own `.claude/settings.json` is one of them. Measured on Claude Code 2.1.325 in a folder never
   opened before: the folder trust dialog comes first, with "No, exit" as the default answer; after "Yes",
   `defaultMode: "bypassPermissions"` from that file starts the session in Manual mode, and `defaultMode:
   "acceptEdits"` starts it in accept-edits mode. The Claude Code documentation (permission modes, settings)
   says `bypassPermissions` and `auto` do not take effect from project or local settings from Claude Code 2.1.257
   on, and that the other values do. So with Claude Code 2.1.257 or newer a repository cannot start a session in
   bypass outside `RAROG_YOLO_ROOTS`; with an older one it can, once the folder is trusted. Bypass as the default
   in the account's own `settings.json` stays the owner's choice, which Rarog does not override.
6. **Creation is opt-in** (`RAROG_HERDR_LAUNCH=0` by default), with a throttle (1 per 5 s, 40 per hour) and a
   **flood barrier** `RAROG_MAX_PANES` (30 by default; "Resource caps and supply chain"). herdr does not limit tabs
   (61 measured); the throttle counts rate, not total, so only the barrier stops a slow build-up.
7. **Rarog closes any pane.** Closing only its own tabs would protect multi-user access, which this system does not
   have: Rarog and herdr are tools of one person. × closes the pane regardless of `launchedByRarog`; the technical
   conditions remain (a known tab address, the write channel on) plus a two-tap confirmation in the UI.
8. **An untrusted directory is a WARNING, not a refusal.** The trust dialog is on the closed signature list
   (`KNOWN_DIALOGS`): with numbered options the phone confirms it with a digit, without digits (CLI 2.1.319) through
   the arrow path in item 3, and a render the trust parser rejects gets a card that says to answer in the terminal.
   Rarog checks `hasTrustDialogAccepted` BEFORE the start under the key the CLI uses: in a git repository only the
   repository root (for a worktree the main checkout; a nested repo or submodule has its own key), outside a
   repository the directory and its parents (the CLI inherits trust there), never the home directory (the CLI does
   not store that trust). A `stat` error while looking for `.git` counts as untrusted. Then Rarog creates the pane,
   returns `trustPrompt: true` **and**
   writes a warning into the transcript (an HTTP response is seen by one device for a moment, the transcript by
   every device). `HerdrUntrustedCwdError` in `herdr/types.ts` is a fail-closed reserve nothing throws; restoring the
   refusal takes throwing it, mapping it in the router and handling it in the app.
9. **The permission hook is PASSIVE, and only a CLI command in the user's terminal installs it.**
   `scripts/hooks/rarog-pending.mjs` dumps what the session waits on into `<dataDir>/pending/` (0700/0600, atomic
   write with a random temp suffix and `flag: 'wx'`, always exit 0, because a hook error must not break the
   session). The driver reads a dump with a TTL (10 minutes,
   60 for `AskUserQuestion` and for `Bash`, the latter only with screen evidence after 10) and cross-checks the tool
   name against the screen. The hook listens to `PermissionRequest` (a dialog really stands) and to `PreToolUse`
   ONLY for `AskUserQuestion`. Installing it in `~/.claude/settings.json` is a PERMANENT account configuration change,
   the operator's decision at the desk: `rarog hooks install` (the permission entries) and the Settings step
   of `rarog setup` (the hook entries, `statusLine`, the two Rarog paths in `sandbox.filesystem.denyRead`, the two
   write block rules in `permissions.deny`) write
   Rarog's own entries only in a terminal, after one `[y/N/d]` question that names what changes (`d` shows the diff
   on the screen, never in a log), with a backup in the data directory. The `denyRead` and write block operations
   only append, never remove a path or a rule. The same setup question covers `herdr integration install claude` when
   herdr's Claude integration is missing; after "y" setup runs it after Rarog's write, and herdr, not Rarog, then adds
   its own `SessionStart` entry there (herdr 0.9.5). In the npm package `rarog service uninstall` removes exactly
   those Rarog entries the same way, the two `denyRead` paths and the two write block rules included, after the same
   `[y/N/d]` question, and leaves herdr's entry alone. No flag skips the question, and only these three CLI modules
   (hooks, the settings step of setup, service) import the writer (`server/test/hook-granica-guard.test.ts`); the
   server, `restart` and the doctors never write the file, and project settings files are never written. A command
   that looks like Rarog's but is not one Rarog printed is a conflict shown verbatim, never removed.
   `rarog hooks doctor` only READS the file, and `rarog hooks print` prints the block for a manual paste.
   Limit: Claude Code does not know Rarog's lock, so a Claude Code write of the same file in the milliseconds between
   Rarog's second read and its `rename` is lost. `/hooks` from the phone is outside the command allow-list, and
   without the hook Rarog works on the screen card. Mechanics, TTLs and files: `docs/dialogs.md`, "Permission hook"
   and "Writing the hook entries". While `alive.json` carries `markers: true`, the hook also writes a request marker
   into `<dataDir>/markers/` (same rights, the FULL `tool_input` up to the dump cap) and never removes it; the server
   removes it, at the latest the start cleanup after 7 days (`architecture.md`, "Persistent state on disk").
   - **Hook code outside the checkout.** Claude Code runs the hook OUTSIDE the sandbox on every permission dialog of
     the account, while an agent in the sandbox can write the checkout. The settings command therefore points at a
     hook copy in `~/.claude/hooks/rarog/`, which imports nothing outside the copy and `node:`
     (`server/test/hook-granica-guard.test.ts`). Only manual commands in the user's terminal write it
     (`rarog hooks install` and `rarog setup`), and only
     `rarog service uninstall` removes it, after its own question: only names from a closed list in the code, as
     regular files, in a real directory of the user below the home directory whose manifest lists only those names
     and matches the sha256 of at least one listed file, and with no Rarog entry back in `~/.claude/settings.json`;
     other files and the directory with them stay. Before each removal the command checks again that the path leads
     to the same directory (real path and inode). Node has no `unlinkat` relative to a directory descriptor, so this
     narrows the window between check and removal without closing it: a Claude Code sandbox session cannot write
     under `~/.claude/hooks/` (protected path), and a process of the same user outside the sandbox can delete these
     files anyway. The server never calls these commands.
     Claude Code, not Rarog, protects the copy from sandbox writes (measured on CLI 2.1.311). Installation takes only
     committed state, which an agent can create, so it is a trail in `git log`, not a wall; a copy that differs from
     the source is `stale` in `/health`, `restart.sh` and `hooks:doctor`, which says to review the `git log` of
     `scripts/hooks` first; `rarog setup` prints the same `git log` before it asks to update the copy. From the npm
     package (no git) the commands print the difference against the copy, with
     control, bidi and zero-width characters escaped, ask in the terminal and write exactly the shown bytes. Only the
     installation the service starts writes the copy (`docs/dialogs.md`, "The copy is written by the installation the
     service starts"). Limits: `node` comes from the Claude Code process PATH; without the sandbox (the Claude Code
     default) `~/.claude/hooks/` is protected only for the Edit tool, and a relative `node_modules/.bin` in that PATH
     could supply another `node`; the copy commands refuse when the copy directory leads outside HOME through a
     symlink; Rarog ignores `CLAUDE_CONFIG_DIR`.
   - **The `statusLine` script lives in the same copy** (`scripts/hooks/rarog-statusline.mjs`), because the
     `statusLine` command also runs outside the sandbox and its dump directory `~/.claude/statusline/` is writable
     from it. The script imports only `node:` modules, takes the dump name from `session_id` only at
     `^[A-Za-z0-9-]{1,128}$`, refuses a symlinked directory and writes through a `wx` 0600 temp file and `rename`;
     a directory swap between its second `lstat` and `rename` stays a window for a process that can write
     `~/.claude`. The chain (`RAROG_STATUSLINE_CHAIN`) runs through `sh -c` the command the user put into their own
     `statusLine` setting; Rarog does not choose it. The Settings step of `rarog setup` moves that command into
     the chain byte for byte, after a question with its own clause about it, only when no dump in
     `~/.claude/statusline/` is younger than one hour.
   - **The context hook lives in the same copy** (`scripts/hooks/rarog-context.mjs`, a `SessionStart` entry that
     the Settings step of `rarog setup` writes after its question). It reads only its stdin (`hook_event_name`, `cwd`),
     `HERDR_ENV` and `<dataDir>/roots.json`, with the data directory rule of the permission hook; it writes nothing,
     opens no network connection and imports only `node:` modules and the `cwd` filter `work-area.mjs` of the same
     copy, which it shares with the permission hook. Its only output is one fixed paragraph about the
     question marker, and only in a herdr pane in the Rarog work area; it never decides about a tool and always exits
     0. `hook` in `/health` does not count its entry.
   - **A dump is card content, NEVER a decision about a TOOL.** The hook never ALLOWS a tool and never waits on
     `PreToolUse` (that holds back the form in the user's terminal, measured). Two exceptions to "never waits", both
     on `PermissionRequest`: the ANSWER channel below, and shadow mode, which returns NOTHING. Shadow mode is a
     measurement mode of the hook as a decision channel: the server writes `<dataDir>/alive.json` every 10 s with
     the effective mode of `RAROG_CONSENT_CHANNEL` (`all` by default, which runs as `shadow` when its start
     conditions do not hold; at `off` the hook does not wait, except a hook that starts during a server restart: it
     waits up to the restart grace for the next server's channel, without a decision and without a registration, and
     exits without a decision when the channel does not open; `docs/dialogs.md`, "Restart break";
     `docs/server-config.md`). In mode `shadow`, before it
     sends a digit or `escape` from the phone, the server puts a shadow file with the tapped decision into
     `<dataDir>/shadow/`; the hook picks it up and exits with empty stdout. The server still sends the same key into
     the pane as in mode `off`, so the key alone carries the decision about the tool and no power is added
     (`docs/dialogs.md`, "Server in shadow mode"). Trail: `<dataDir>/shadow.jsonl` (ids and reasons, no
     `tool_input`), `<dataDir>/decisions/` and `<dataDir>/alive.jsonl`.
   - **The tall dialog guard is the hook's only decision without a person, and it is a REFUSAL.** On
     `PermissionRequest` for `Bash` in a herdr session under Rarog's roots with `tallDialogGuard: true` in
     `roots.json`, the hook returns `deny` when the dialog will not fit the session pane, telling the model this
     refuses the FORM, not the operation. **Power shrinks, it does not grow:** each shorter call stops at an ordinary
     dialog with a screen digit. The hook returns `allow` for no tool and never touches `updatedPermissions`. Trail:
     `<dataDir>/guard.jsonl` (counts without the command). Off switch: `RAROG_TALL_DIALOG_GUARD=0` and a restart
     (`docs/dialogs.md`, "Tall dialog guard").
   - **Two hook boundaries, both fail closed.** (a) The user settings entry covers EVERY Claude Code session on the
     account, client repositories too, so the hook compares `cwd` (after resolving symlinks) with the work area of
     the roots in `<dataDir>/roots.json`, written at start from `RAROG_HERDR_ROOTS` with the excluded folders in
     `exclude` ("Work area" above; the hook checks the path as given against the roots as written and resolved
     before any disk access for it, then resolves it one segment at a time and stops before an excluded folder, then
     checks the resolved path). With the root `~` that
     takes in every session in home outside its hidden entries and the protected folders, client repositories there
     too. A `roots.json` without `exclude` gets the plain root check; an `exclude` that is not a list of absolute
     paths counts as no file. Outside, or in a
     programmatic session (`CLAUDE_CODE_ENTRYPOINT` equal to `sdk-cli`, measured on CLI 2.1.314 for `claude -p`, or to
     `sdk-ts` or `sdk-py`, unmeasured values Rarog treats as programmatic too), it exits without a
     write, a wait or a refusal, and a missing or empty file means "write nowhere". (b) The hook payload is UNTRUSTED
     INPUT written by the agent process. So a dump never chooses a digit (the digit comes from the screen), and its
     content enters the card only after a cross-check with the screen: for a permission, input visible on screen (for
     `Bash`, the whole command INSIDE the dialog frame); for `AskUserQuestion`, the question text and the full set of
     labels; for `ExitPlanMode`, the plan file name in the dialog footer. A mismatch is fail closed; the options to send
     always come from the SCREEN. The driver deletes a dump after every decision sent from Rarog (digit or `escape`),
     and `sweepPendingHooks` sweeps expired dumps at every server start, so a dialog settled at the desk leaves its file
     with the full `tool_input` until the next start. Channel visibility: `hook` in `/health`
     (`ok`/`missing`/`mismatch`/`stale`), printed by `restart.sh`; the age of the last firing (`hookSeenAgo`) sits
     BEHIND AUTH in `GET /api/version`.
   - **Operation content is the dialog's identity.** A `Bash` permission whose screen shows an operation frame gets
     buttons only when the frame shows the command from the card's source: the name "Bash" does not tell two calls
     apart. When a jsonl entry and a hook dump disagree, the screen decides; when both match, the card has no
     buttons. Right before the digit a fresh screen must give the same body fingerprint (`bodyPrint`) as the screen
     the card came from, and a hook-based card requires the same dump generation. A card from the screen alone has
     buttons only when it shows the header and operation of a dialog visible in full. Exact rules (subagent
     permissions, queued dialogs, truncated frames, the plan footer as fingerprint): `docs/dialogs.md`, "Permission
     dialog operation". Known limits, both on the refusal side: after a full-width frame line it is unknown whether
     the CLI split a word or ate a space; a command with tabs or control characters ends in a refusal.
   - **The `answers/` directory is the ANSWER channel for `AskUserQuestion`,** the only place where the hook WAITS
     and RETURNS something. It polls for `<dataDir>/answers/<engine session>/<key>.json` up to the registered cap
     (`timeout: 86400`, 24 h; measured: the CLI accepts 86 400 s, and an `allow` after over 3600 s still worked);
     Rarog writes the file after a tap,
     and the hook returns `decision: {behavior: 'allow', updatedInput: {…tool_input, answers}}` with the COMPLETE
     answer set. **Four boundaries, all fail closed:** (a) `allow` goes out ONLY for `AskUserQuestion`, a tool that
     executes nothing, and `answers` is literally the person's answer; (b) the file exists only for sessions under
     the roots; (c) the HOOK computes the file key (`<prompt_id>-<sha256(questions) up to 16 chars>-<nonce>`) and
     checks session, key and time, so a file from a PREVIOUS question does not work; (d) the channel BYPASSES the
     herdr client, so `RAROG_HERDR_SEND=0` cuts it at the source. **The race with the desk is safe both ways:** on
     `Esc` the CLI kills the hook, on a digit it ignores the hook's `allow`. **The screen fallback stays mandatory:**
     Rarog waits at most 3 s for the file to be consumed, then deletes it and sends the digit. The file may also carry
     `annotations` (a note on the chosen option and its ORIGINAL preview; accepted by CLI 2.1.288 and 2.1.293): the
     hook accepts a note only for a question the file answers, a `preview` LITERALLY from that question's options,
     a note of at most 8192 characters, answers with notes of at most 32768 and no foreign fields, or it rejects the
     WHOLE file. Rarog writes notes only for a question with `notes: true` on the card (hook channel, single choice
     with a preview, a CLI process of at least 2.1.288) and only for one option from the list, otherwise 400; an
     answer with a note NEVER falls back to the digit path (422 `send-failed`), and the log gets only the NUMBER of
     notes. Same regime as `pending/`
     (`0700`/`0600`, atomic write, a 10-minute sweep at start); log method `answer-hook`; a NON-EMPTY `answers/` in
     `rarog hooks doctor` means the hook did not collect.
   - **The `refusals/` directory is the SECOND surface with screen content.** On every refusal Rarog writes
     `<dataDir>/refusals/<ISO-ts>-<reason>.txt` with the pane's SCREEN TEXT, the hook dump metadata (**without
     `tool_input`**), the jsonl status and Rarog's version, because a log entry alone cannot explain a refusal (a mode
     gate refusal writes `…-mode-unknown.txt`). **The risk is the same as for `pending/`:** a permission dialog shows
     the command literally. Hence `0600` files in `0700`, atomic writes, 48 h retention and a cap of 200 files, swept
     at start AND after every write. Only a dump of a layer 2 dialog (a picker, a slash command view, a model
     confirmation) that shows no consent trace lives longer: `….dialog.txt`, 14 days, its own cap of 500 files. It
     needs registry class `dialog`, no tool name, hook dump, jsonl entry or tool identifier, and a screen without a
     tool consent or a question form (`dialogs.md`, "Refusal diagnostics"). The class alone does not qualify,
     because the registry can say `dialog` while the last screen read still shows a consent; any doubt keeps 48 h,
     so the screen of a consent dialog never gets the longer retention. `RAROG_REFUSAL_DUMPS=0` turns
     writing off while the start sweep keeps running, so the directory empties. Writing is best effort: the refusal
     reaches the person anyway. The consent channel writes here too: a main-thread card without proof whose top shows
     a line outside Rarog's closed lists leaves its screen once per card (`dialogs.md`, "Refusal diagnostics");
     `server.log` gets only counts, because an agent can write that line.
   - **The `notes/` directory is a surface of ANOTHER class.** The three above carry someone else's content and have
     retention; project notes are text the user writes and keeps forever:
     `<dataDir>/notes/<sha256(realpath(cwd)) up to 16 chars>.json`, ONE document `{cwd, text, updatedAt}` per
     directory, `0600` in `0700`, atomic write, **no sweep and no TTL**. Only a person deletes them (saving EMPTY text
     with `PUT /api/notes`, or `rm`). The client is the native app.
     - **Audio NEVER reaches the server:** dictation goes from the device to Soniox or to Apple speech recognition
       ("Dictation"), and only the final transcript reaches Rarog as text.
     - **No Claude session sees notes:** no endpoint for an agent, no export to project files, nothing goes into a
       prompt. Changing this is a separate decision.
     - **Moving a project directory CUTS OFF its notes** (the hash comes from `realpath`); the file stays on disk, and
       manual recovery uses the `cwd` field: `grep -l '"cwd":"<previous path>"' <dataDir>/notes/*.json`, then rename the
       file to the hash of the new path.
     - **Unsaved text stays on the device** (`<server space>/note-drafts/`, "Native client" below), until the server
       has exactly the field, because a note is the only Rarog content nobody can recreate.
     - **ONE BIT per project leaves `notes/`:** the `sessions-snapshot` frame carries `notesCwds`, the directories
       with a non-empty note, paths the client knows from the session list anyway, and not one character of content.
     - **Killswitch `RAROG_NOTES=0`** (rule 18) closes the endpoints (404) and removes `notesCwds` from EVERY
       `sessions-snapshot` frame. It does NOT touch the files: it takes away access, and deleting a person's
       sentences is that person's act.
10. **`~/.claude.json` is read in narrow mode:** Rarog takes only the named fields and drops the rest of the parsed
    file. One boolean field, nothing else logged, including the exception
    text from `JSON.parse` (parser messages can quote the file). The plan limits (`usage.ts`) share ONE reader,
    `readClaudeJson`: a file of at most 4 MiB (`CLAUDE_JSON_MAX_BYTES`), one `JSON.parse`, the rest dropped. It takes
    `oauthAccount.emailAddress` and, for `GET /api/usage/details`, from the key `cachedUsageUtilization` that Claude
    Code writes ONLY `fetchedAtMs` and per entry of `utilization.limits[]` the `kind`, `percent`, `resets_at` and
    `scope.model.display_name`. The reading counts only when its `accountUuid` equals a non-empty
    `oauthAccount.accountUuid` from the same file; account ids are compared in memory, never sent or stored. A read or
    parse error gives no field and at most a fixed log line, never file content, numbers or the exception.
    **These readers NEVER write Claude Code configuration files**, verified by sha256 before and after; the only
    Claude Code configuration Rarog writes is its own hook entries, from the `rarog` command (item 9). The command catalog
    (`herdr/commands/discover.ts`) reads the same way: two keys from the settings files (`enabledPlugins`,
    `skillOverrides`), scope, `projectPath` and install path from `~/.claude/plugins/installed_plugins.json` (only
    under `~/.claude/plugins/`, after realpath), a few manifest fields, and from `SKILL.md` and `commands/*.md` only
    frontmatter (the first 64 kB; `description` and `argument-hint` cleaned and cut to 200 characters for the app).
    The log carries path and error code, never content; from claude.ai skills (`skills/synced/`) only directory names.
11. **`resumeFrom` is validated by the `cwd` from the TRANSCRIPT, not by the UUID alone.** `--resume <uuid from
    another directory>` works, so one POST field would load a whole session history from outside the roots onto the
    phone. The `cwd` from the file's tail must be the card's directory or lie below it (`transcriptCwdBelongs` in
    `sessions/manager.ts`, the same rule on session restart), compared by path segments. The two-writer gate counts
    from a fresh `agent.list`, NOT from the RAM index (cleared when a session is HIDDEN, while the hidden pane still
    writes its file). After both directory gates Rarog reads the mode and effort the conversation ended on and passes
    them on resume; ultracode comes back only when the conversation ended with it and the installed Claude Code
    supports it, otherwise a system sentence in the transcript says so. **`bypassPermissions` from the file never
    carries over:** bypass, `dontAsk` and an unknown mode give an explicit `--permission-mode manual` (an empty flag
    would hand over `defaultMode` from the Claude Code settings, possibly bypass outside `RAROG_YOLO_ROOTS`).
12. **The environment of a new pane clears two classes of variables** (`RAROG_CLAUDE_ENV_CLEAR`): nested session
    markers (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`) and variables that tie the pane to
    ANOTHER Claude Code session (`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
    `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_PID`, `CLAUDE_TMPDIR`, `CLAUDE_EFFORT`). With an
    inherited `CLAUDE_CODE_CHILD_SESSION` the CLI saves no transcript (Claude Code docs, "Errors", "Session saving
    warnings"), and an inherited `sdk-*` entrypoint would make the permission hook ignore the session (rule 9). Per
    the docs the messaging socket and token are an inbox each session exports itself ("Cross-session messaging",
    "The session's inbox socket"), and a Rarog pane carries no one else's. `CLAUDE_CODE_OAUTH_TOKEN` is cleared too:
    the pane logs in with the `/login` credentials, and a token in the server environment would bill the API instead
    of the subscription. The only variable Rarog SETS is `DISABLE_AUTO_UPDATE=true` (`PANE_SHELL_ENV` in
    `config.ts`): the oh-my-zsh update prompt in a fresh pane eats the first letter of the command `agent.start`
    types (`command not found: laude`). **Measured limit:** clearing reaches only the shell start; an interactive zsh
    runs `~/.zshrc`, and if that loads a key file, the keys come back IN FULL before `claude` starts (a tab with
    `ANTHROPIC_API_KEY=sk-test-injected` → the `claude` process saw the value from that file). The complement is the
    installer's shell setup: do not export Anthropic keys in interactive shells (a `case $- in *i*)` guard).
13. **Permissions: content from jsonl, digits from the screen, a mismatch fails closed.** Neither source suffices:
    jsonl has no option numbers, and the screen cuts `tool_input` to the pane width (so the `risk.ts` rule
    `sciezki-sekretow`, Polish for "secret paths", which marks `.ssh`, `.claude` and `.secrets` in the home
    directory, might miss it). Both must name the same tool, and only the dialog BLOCK the CLI draws gives the
    screen's tool name (a title from a closed map, the `Ask rule` line, an MCP header); the agent writes the `⏺` line,
    description, command and scrollback, so they give no name (`docs/dialogs.md`, "Dialog block").
14. **Buttons only for dialogs Rarog UNDERSTANDS.** A dialog without a jsonl counterpart gets a screen excerpt ON THE
    CARD, `risk: 'red'` and only Deny (Esc), never Allow buttons: a generic "draw buttons from whatever you parsed"
    would be the most dangerous feature in this project. A known dialog (`trust`, `model`) is recognized only in the
    dialog block, and before the digit a fresh screen must show a dialog of the same kind and identity
    (`ActiveReq.dialogIdentity`), otherwise `screen-changed` and zero keys. Dialogs on the closed list
    `TERMINAL_DIALOGS` (the "Session paused" pause after a model safety flag, "Background work is running") get a card
    with full content, but EVERY option of today's card is `terminalOnly`. Buttons with their literal labels come only
    from the layer 2 card (`RAROG_DIALOG_LAYER2=1`), and only for an entry whose every option and Esc have a measured
    key and effect; each key goes through the layer 2 step after a fresh read with the same block fingerprint
    (`docs/dialog-card.md`, "Answer"). "Exit and stop tasks" stops the background tasks, so it is such a button too.
    On "Session paused" Rarog never sends `escape`, and a digit only from its layer 2 card
    (`docs/dialogs.md`, "CLI dialogs answered in the terminal").
15. **The digit is chosen by the option LABEL, never by position.** The parser reads the digit from the text
    (`^(\d)\.\s+(.+)$`) and must see the COMPLETE list 1…N; an incomplete list, a repeated digit or label, or `0` →
    `null`, fail closed. A label missing on `allow` is a **no-op and a log entry**, and the driver rebuilds the card
    from what stands in the pane NOW (zero keys stay zero keys). **A standing dialog is read AGAIN while it stands**,
    every four seconds of `blocked`: a card describing ANOTHER dialog than the standing one invites approving
    something unseen. `#digitStillHolds` (a fresh read and an assertion by label) stands before the digit anyway.
16. **The audit answers "what was approved"**, not only "which digit was sent": `approve` with `toolName` and
    `optionLabel`, `launch` with `cwd`/`argv`/`paneId`/`tabId`, `close_tab` with `tabId`.
17. **There is no session registry, so it has no surface.** Zero transcripts in `<dataDir>`. The full list of what
    lies there is item "Persistent state on disk" in `docs/architecture.md`, the list for the "what to delete"
    runbook. Three files matter for this model:
    - `prompt-queue.json` (the paste queue, `docs/dialogs.md`, "Sending while a turn runs") holds the TEXT of a
      message sent while a turn runs, from its acceptance until its first paste, so a restart does not lose it; from
      the first paste on the entry has no text. A voice agent message keeps its sender there (`source`), for the
      audit line of a restored paste. The file is `0600` in the data directory and written atomically
      (tmp + rename); the text never goes to the log. After a restart an entry goes only to a pane of the same engine
      session inside the roots; any other pane gets nothing and the entry is dropped. A queued entry older than 6 h is
      not restored. Deleting the file loses the messages that still wait for a paste.
    - `outbox-ids.json` (idempotent sends from the native client) keeps per entry ONLY `clientMessageId`, the Rarog
      session id, a sha256 of the message (text plus attachment names, MIME types and bytes) and the time. The hash of
      a short message ("yes", "ok") can be guessed with a dictionary, so the file is `0600`, never in the log or a
      push; entries expire after 24 h (cap 2000). Deleting the file costs at most a duplicate retry, never a message.
    - `herdr-hidden.json` keeps `aliases` (`engineSessionId → sessionId`) and `seen` (a state number, the manual
      unread flag and `by: "voice-agent"` for the voice agent's receipt), LRU 200 each, zero content, and no
      `hidden` section, so the `cwd` and `title` of other projects' panes are not on disk.
18. **There are FIVE killswitches, and they are disjoint:** `RAROG_HERDR_SEND=0` (no writes to panes, creation
    included), `RAROG_HERDR_LAUNCH=0` (no new panes, the default), `RAROG_TERM=0` (no emergency console, the
    default), `RAROG_PUSH=0` (no notifications) and `RAROG_NOTES=0` (no project notes; notes are ON by default).
    Values and how to set them: `docs/server-config.md`, "Server environment: variables and flags".
    - The console depends on the first two: its shell lives in a herdr PANE, so `RAROG_HERDR_LAUNCH=0` or
      `RAROG_HERDR_SEND=0` block creating a console (point 1 of "Emergency console"). `RAROG_TERM=0` does not touch
      `claude` sessions.
    - Creating a directory from the New Session form depends on the first two as well: either one refuses
      `POST /api/fs/mkdir` with 409 `mkdir-disabled` ("Creating a directory from the New Session form").
    - The first three take away POWER over the Mac; `RAROG_PUSH=0` silences only the OUTGOING channel (useful for a
      lost phone); `RAROG_NOTES=0` takes content Rarog keeps forever out of a device key's reach without deleting it.
    - **Rarog has no git mutations and needs no switch for them:** `git switch`, `pull` and `push` from the iPad go
      only through the console (lazygit under `Cmd+G`), so `RAROG_TERM=0` cuts them off.
    - `RAROG_HERDR_SEEN_FOCUS=0` is NOT a sixth killswitch: it governs only `agent.focus`, a write method that
      `RAROG_HERDR_SEND=0` covers. `RAROG_HERDR_TAB_LABELS=0` governs only renames after a tab exists, also writes
      (runbook "Tab name set by Rarog" below).
    - `RAROG_CODEX_STATUS=0` is NOT a sixth killswitch either: the flag (ON by default) lets `agent === 'codex'` panes
      into the sidebar as STATE-ONLY entries and adds no power. Such an entry has `inScope: false` (no jsonl
      follower), the `readMode` gate forbids reading a Codex pane's SCREEN, and the SERVER refuses the session channel
      (`…/messages`, `…/model`, `…/answers/:qId` and the diff routes 400, `…/resume` and `…/close` with `closePanel:
      true` 409). The only mutation is `agent.focus` (`POST …/focus`), which the app does not call. A Codex started
      in RAROG'S CONSOLE is reached through that console, and its row only shortens the way to a power already open.
    - `RAROG_PR_STATUS=0` is NOT a sixth killswitch: it turns off an outbound read channel (the state of session PRs
      from GitHub, "PR status: the state of session PRs from GitHub") that approves and sends nothing.
    - `RAROG_CLI_WAITING=0` and `RAROG_AGENT_FILES=0` are preferences: the first turns off the fast read of the
      `~/.claude/sessions/` registry, the second the reading of subagent files ("Claude Code version of a session" and
      rule 6 of "herdr sessions"). Neither reader approves or sends anything.
    - **Both boundaries, reading and closing, can be broken by a RACE, not a rule.** So a late snapshot with an OLDER
      `state_change_seq` does not change the pane's engine, and a HISTORICAL card does not close the pane of a
      successor that inherits its `herdrKey` (the key must point at that card in the manager's index, and `closeTab`
      on an `engine: 'codex'` entry refuses in the supervisor).

## Emergency console: a full shell from the phone

The emergency console is a power separate from everything above: it is **not** a channel into a `claude` pane but
a **full shell with the user's permissions**, with no key allow-list and no text guard. On purpose. The exposure
equals an SSH client on the same phone: Rarog adds no new CLASS of access, only convenience. The points below
describe where this power ends.

1. **Killswitch `RAROG_TERM`**, OFF by default (opt-in, like `RAROG_HERDR_LAUNCH`). Missing or `0` means no
   feature: `POST /api/term` and `GET /api/term/:id/history` return 404, a WS upgrade ends in `socket.destroy()`,
   and `GET /api/version` gives `termEnabled: false`. The `RAROG_HERDR_*` killswitches **do apply**, because the
   shell lives in a herdr pane: `POST /api/term` refuses with 409 `herdr-launch-off` or `herdr-send-off`. They do
   NOT block keyboard input and pastes (`in` and `pa` frames) into an EXISTING console pane, which go through the
   `herdr terminal session control` process stream, not the socket; but a WS socket exists only for a registry
   entry, and with `RAROG_HERDR_SEND=0` `registry.open` refuses. Reading the history (`pane.read`) is a read and
   stays. Only `RAROG_TERM=0` turns the console off completely.
2. **Access gates, all fail closed.** The server listens only on 127.0.0.1 (layer 4). The WS upgrade checks BEFORE
   `handleUpgrade` a valid credential (`authenticate`) **and** `Origin` against `RAROG_ORIGINS` (an upgrade opens a
   shell, so it gets the mutation gate). Every refusal is `socket.destroy()`, without an HTTP response.
3. **The directory enters TWO ways, and both end in `validateProjectCwd`** (the work area of `RAROG_PROJECT_ROOTS`,
   also after resolving symlinks).
   `POST /api/term`: the client NEVER gives a `cwd` on upgrade, only an id (`sha256(realpath(cwd))` cut to 16 hex),
   and an id outside the registry cannot become a path. ADOPTION of shells that survived a Rarog restart
   (`adoptSurvivors`): the backend supplies the `cwd` (from `term-herdr.json`, or the current `pane.cwd`), which
   passes `realpath`, then a CRYPTOGRAPHIC gate (the pane's `rarog-term` token must equal `termIdFor(realpath, s)`
   for some `s = 1…TERM_SLOTS_MAX`, or the id of one of the two popup roles, `realpath + NUL + "lazygit"` or
   `realpath + NUL + "popup"`, computed from ITS OWN path), then
   `validateProjectCwd`. **The only input Rarog types into a shell on its own** is the fixed bytes ` exec lazygit\r`
   (a code literal), once, into a FRESH pane of the `lazygit` role; into the `popup` role pane (Cmd+F) it types
   NOTHING. `role` is an enum of three values, and start content does not go through the API.
4. **Resource caps.** `RAROG_TERM_MAX` counts LIVE PTYs in the whole of Rarog (4 by default), `TERM_SLOTS_MAX = 4`
   counts registry entries in ONE project; above either, `POST` returns 409. A WS frame ≤ 16 kB in the library and
   ≤ 8 kB of input in code (a non-text frame or more is a protocol error and a close); a whole paste ≤ 512 kB
   (`TERM_MAX_PASTE_BYTES`; above 1 MiB herdr silently drops input), excess rejected whole. A socket with a buffer
   over 256 kB is dropped, and a ping every 25 s without a pong by the next one means `terminate()`.
5. **Zero content logging.** Neither shell output nor input reaches ANY file. Only the supervisor writes
   `herdr-audit.log`, so the console's herdr calls leave their trace in `server.log` (`term: new tab …`,
   `term: new workspace …`, `term: close …`) together with the lifecycle (`POST` with cwd and id, socket open and
   close, PTY spawn, kill and fall, the reaper's closes). **The price is named in the runbook (step 5): after a phone
   theft it is IMPOSSIBLE to reconstruct what was typed in the emergency console.** An NDJSON line the parser does not
   understand is logged as REASON and LENGTH; from the controller process only the `stderr` tail, as the exit reason;
   a paste leaves at most `paste over the cap` with a byte count or `input in the middle of a paste`.
6. **Rarog's secrets do not reach the console.** The only thing Rarog INJECTS into the pane's shell is the marker
   `RAROG_TERM_PANE=1` (a contract test checks there is nothing else). The env slice for the feature is built FROM
   SCRATCH from a closed list (`TERM_ENV_PASSTHROUGH`: `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`, `PATH`),
   with an exact-list contract test, so `SONIOX_API_KEY` and other server secrets do not pass; `SSH_AUTH_SOCK` is not
   on it (the herdr shell supplies the agent socket for `git push`). herdr, not Rarog, starts the shell, and an
   interactive zsh runs `~/.zshrc`, so the user's own keys are in the shell as in any terminal of theirs. The
   guarantee is one sentence: RAROG'S secrets do not leak from the server process towards the console. **The same
   guarantee covers `git` processes:** their environment comes from `GIT_ENV_PASSTHROUGH` (`HOME`, `PATH`, `TMPDIR`,
   `LANG` plus the `GIT_*` variables of the server env), because a `process.env` base would hand `SONIOX_API_KEY` and
   the APNs key entries to programs git runs from repository config.
7. **Rarog runs no terminal server of its own.** Shells live in herdr panes; outside herdr there are no Rarog shells
   it does not see.
8. **Shells do not live forever.** Two mechanisms, both through `pane.close` of ONE pane: an explicit close
   (`DELETE /api/term/:id`) and an idle reaper at server START for Rarog shells without a client and without
   activity for `RAROG_TERM_IDLE_DAYS` (7 by default; age from `<dataDir>/term-herdr.json`). Accepted: a shell with a
   long-running SILENT process is reaped too, with an agent in it. The reaper first asks whether the backend MAY open
   a console (`refusal()`), so at `RAROG_HERDR_LAUNCH=0` or `RAROG_HERDR_SEND=0` it does not even read `pane.list`. A
   pane with our token that the file lacks gets a "now" mark: "unknown" never means "reap". A third, narrow path is in
   point 10.
9. **A transport failure turns the feature off EXPLICITLY, never silently:** the backend refusal (`refusal()` → 409
   with a code) and a respawn fuse (three controller falls in 30 s put the console into `failed`, `err` frame,
   further WS rejected). A failed assembly of the console MODULE leaves an error line and the feature off.
10. **The shell lives in a herdr pane, so the console IS in the control plane.** The pane is visible on the Mac
    (tab `rarog <slot> · <directory>`), and Rarog creates, stamps, names and closes it through allow-listed methods,
    so under `RAROG_HERDR_LAUNCH` and `RAROG_HERDR_SEND`. Limits:
    - **Closing AND TAKING OVER a pane share one gate at the ONLY caller** (`term/herdr-backend.ts`): both
      `pane.close` and spawning the controller with `--takeover` first ask a FRESH `pane.list` whether the pane at
      the address carries a `rarog-term` token whose VALUE equals THIS console's identity
      (`termIdFor(realpath(cwd), slot)`). Not from registry memory: herdr pane ids are positional (`w15:p1`), and the
      mere PRESENCE of a token would protect a person's pane but not another project's shell.
    - **The controller environment is CLOSED:** `HOME`, `PATH`, `TMPDIR` (`HOME` locates the herdr socket).
    - **`pane.read` enters NARROWLY:** the scrollback of ONE pane as text without ANSI (`recent_unwrapped`,
      `strip_ansi`, cap 5000 lines), behind the same ownership gate, so a pane outside the set is 404, not someone
      else's scrollback. One read per tap, no pump, no SSE; `server.log` gets only the pane address and line count
      (tests with a fake logger in `term-herdr-backend.test.ts` and `term-router.test.ts`). Copying to the clipboard is
      an explicit EXPORT on a gesture.
    - **`pane.process_info` reads the PROCESS NAME and nothing else** (console tab labels). Only `pid`, `name` and
      `argv0` enter the server; `argv`, `cmdline` and `cwd` are cut when the client facade MAPS the response
      (`readPaneProcess` in `herdr/client.ts`; the schema is loose, so the mapping is the boundary), because a command
      line can hold a whole secret. The pill gets ONE WORD (`argv0` or `name`, `basename`, lowercase, ≤ 12 characters;
      `zsh` on an error). Same ownership gate, called ONLY from a cache with a 5 s TTL. Two other callers read only
      panes Rarog created itself: the supervisor's `closeShellTab` (session restart, below) and the launcher, once,
      after a failed wait for readiness (session id mismatch or timeout), on the pane it has just created. The
      launcher writes `pid name argv0` of each process (each control character shown as `?`) into ONE `server.log`
      line next to the last `agent.get` reading; nothing else from the answer leaves that line, and a failed read prints
      `foreground: unknown`.
    - **`pane.layout` reads the tab GEOMETRY and nothing else:** pane ids and rectangle sizes, one read per controller
      release after the grace period, capped at 1 s, to size OUR pane through our controller (`terminal.resize`).
    - **Socket read-only mode has one source, and the 409 knows it.** The source is `RAROG_HERDR_SEND=0`: `refusal()`
      turns it into the 409 before a console starts, and the socket's write gate bounces the same writes again.
    - **Recovering panes after a herdr restart closes and creates nothing:** `reconcile` restores a token from a
      label ending in `rarog-term <id>` and labels a pane that carries the token, behind `refusal()`, `dispose()`
      and the socket's write gate. The only close outside an explicit close and the reaper is an EXPLICIT open of the
      `lazygit` role (`POST`, never adoption) on a pane of this console whose foreground holds exactly one process, a
      shell, after a SECOND read right before `pane.close`; anything else in the foreground keeps the pane.
    - **A paste executes nothing from the clipboard.** The server wraps the paste in `ESC[200~…ESC[201~` itself, so
      `term/paste.ts` first strips `ESC[200~` and `ESC[201~` (also with the 8-bit CSI U+009B) until none remain;
      otherwise `ESC[201~rm -rf ~\r` on the clipboard would end the paste in zsh and run the rest. A paste reaches
      herdr WHOLE or not at all.
    - **The console is not invisible:** a shell from the phone is a herdr tab anyone at the Mac sees, an exposure of
      console content on the Mac screen.

## Dictation: microphone, the Soniox key and Apple speech recognition

The points are numbered 15–18 because code and other documents cite them by these numbers. For the same reason
points 17 (notifications) and 18 (no web front end) stay in this section, although they are not about dictation.
The condition at the end of the section covers retention on the Soniox side.

The app dictates by one of two routes, and the person picks one on the Dictation screen before the first
recording: System Dictation (Apple speech recognition) or Soniox via the paired server. A build with
`RAROG_VOICE_SONIOX = NO` has no Soniox option. The screen names the provider, says what leaves the device and
links to the dictation part of the privacy policy. Choosing records nothing: the microphone opens at the next tap.
The app never switches the provider by itself: a Soniox choice that the server does not offer opens the screen
again, and a failure on one route never falls back to the other.

15. **The permanent Soniox key never leaves the server.** It lives only in the server process environment
    (`SONIOX_API_KEY`), from `~/.config/rarog/secret/private.env` (a 0600 file in a 0700 directory) or from the
    secrets manager behind `service.wrapper`. `rarog dictation set-key` writes it into that file from standard
    input (in a terminal without echo), never from argv, and prints no part of it (`docs/server-config.md`,
    "`rarog dictation`: the Soniox key"). The phone gets a TEMPORARY key minted per connection attempt by
    `POST /api/voice/token`: `single_use`, about 60 s to open the connection, a session ≤ 15 min, a random
    `client_reference_id`, `Cache-Control: no-store`, a throttle of 3 s plus 60 per hour; a reconnect mints a new
    key. The endpoint accepts only an empty body (`{}`); anything else is 400. No key in env → `voiceEnabled: false`
    in `GET /api/version` and 503 `voice_unconfigured`. The microphone is never a dead button: without a Soniox
    route the Dictation screen shows the Soniox option as unavailable and offers System Dictation.
    `SENSITIVE_KEY_PARTS` in `auth/redact.ts` catches both `apiKey` and `api_key` (the Soniox response field), with
    a regression test; measured live: neither key is in the endpoint response, `herdr-audit.log` or the server log.
    The app passes the temporary key only in the WebSocket protocol list (`soniox-api-key`) and only with the
    `snx_temp_` prefix, never in the start frame or in the `Authorization` header Apple reserves for the system. The
    device stores no Soniox key. The same permanent key also gives the voice agent's speech keys, a second kind of
    temporary key with its own throttle (`POST /api/companion/speech-token`, "Voice agent: questions about a session
    through `claude -p`").
16. **Audio does not pass through the server on either route.** On the Soniox route the phone streams PCM straight
    to `wss://stt-rt.eu.soniox.com`. On the system route Apple speech recognition (`SFSpeechRecognizer`) runs on the
    device wherever the device has a speech model for the language, and the request then requires on-device
    recognition; for a language without such a model the audio goes to Apple's speech recognition servers, and the
    screen says so. The system route makes no request to Rarog or to Soniox. Rarog sees not one sample and stores
    neither audio nor transcript (the transcript goes only into the app's field).
17. **Notifications inform, never approve.** Apple sees an APNs banner in full, and on the device it lands on the lock
    screen and in Notification Center history, readable by bystanders. Hence one hard limit independent of transport:
    for a blocking matter the banner carries **only the tool name** (`Bash`, `Write`), NEVER `displayText`, the string
    that most often carries a secret (`export KEY=…`, `curl -H "Authorization: …"`). Details need the app, and the app
    needs the credential. `done` and `failure` carry one result sentence and the error text. A test in
    `server/test/manager.test.ts` enforces this through the real scheduler and APNs payload. The APNs key goes only
    into the provider JWT and is on the `redact()` list whether or not the channel is on ("Push notifications").
    `RAROG_PUSH=0` silences banners and Live Activity; without the full set of `RAROG_APNS_*` the channel is off
    (`POST /api/presence` is a no-op), which **is not a start-up error**. The demo never pushes. A tap opens the
    session, and the target travels as a bare session id (or the console id of a Codex entry), WITHOUT the device key,
    which would otherwise settle in Notification Center history.
18. **There is no web front end.** The server serves no HTML or scripts, so the reverse proxy passes only `/api/*`
    and `/health` to Rarog's port and returns 404 for any other path. `/api/*` JSON responses carry no CSP or
    `Permissions-Policy` headers: the native app does not execute server content as code.

**Condition on the Soniox account:** "Soniox RT does not store audio or transcripts by default" is **an account
setting, not a law of nature**. Rarog's code does not and cannot check it: the installer confirms in the Soniox panel
that audio and transcript retention is off before dictation goes into daily use.

## Voice agent: questions about a session through `claude -p`

The voice agent lets a paired device talk about one Claude Code session (`docs/companion.md`). `RAROG_COMPANION=1`
turns it on; it is off by default and in every demo, and it works only with the server's OpenAI key and its Soniox
key from the EU region. No voice agent route approves anything or writes anything in a project, and none sends
anything to a pane: the one way the voice agent reaches a pane is a prompt of its mode across sessions through the
ordinary message route (below), and both flags stop it, so they are its kill switch. The only other state the voice
agent changes on the server is the `seen` marker of a result it read (below), behind the same flags. The boundary in
short; the full list stands in `docs/companion.md`, "Security":

- **What leaves the Mac.** For a question about the session, its condensed conversation file goes to Anthropic
  through Claude Code on the owner's subscription, through `claude -p` without tools, MCP servers, user settings or
  Rarog's secrets (rule 13 of "herdr sessions"). The voice conversation runs between the phone and OpenAI Realtime,
  and the agent's answers are read aloud by Soniox in the EU; the server carries no audio.
- **The last turns of any session.** With `RAROG_COMPANION_SESSIONS=1` as well (off by default and in every demo),
  `GET /api/sessions/:id/companion/turns` gives a paired device the last 1–3 turns of the current engine conversation
  of any Claude Code session in scope, also one whose screen it does not have open (`docs/companion.md`, "Turns
  route"). It is the content the session stream already gives that device; the route writes nothing to disk (rule 17
  of "herdr sessions" holds), keeps nothing between reads and sends the turns to no other service. The response
  carries an opaque token of the engine conversation, never its id.
- **Which sessions the voice agent may see.** With the same two flags, `GET /api/companion/sessions` lists the
  sessions of that mode: one row per Claude Code session in scope (the gate of the turns route), with its id, the
  conversation token, `stateSince` and whether its last answer asks the owner, and no text (`docs/companion.md`,
  "Session catalog"). A session without a row is not the voice agent's to see: a Codex session, a pane out of scope
  and a session directory outside the roots get none. The catalog is built from the server's memory and writes
  nothing.
- **A prompt from the conversation.** With the same two flags, the voice agent can cause a prompt to be typed into a
  Claude Code session whose screen the device does not have open, through `POST /api/sessions/:id/messages` with
  `source: "voice-agent"` and the conversation token it read (`docs/companion.md`, "Sending from the conversation").
  The prompt runs at once and cannot be taken back, so this is a power of its own. Its gates, in order:
  1. the two flags on the server;
  2. the mode's own consent in the app, on top of the voice agent's;
  3. the exact reading: the app has Soniox read the project, the session and the exact prompt aloud, and the text it
     sends is the text it read (`docs/companion.md`, "Conversation across sessions");
  4. the user's confirmation in an utterance that began after the reading ended, by the app's count of the input
     audio; a cut reading, a reading not read and a word that began during it send nothing, and speech after the
     model asked for the send stops it until the app's outbox takes the prompt, and so does any sound over the
     agent's answer after the confirming utterance, also one the app takes for noise;
  5. the conversation token captured when the prompt was shown: the app sends nothing when the catalog shows another
     token, a dialog, or a turn the session started since, and the server answers 409 with nothing in the pane when
     the session writes another engine conversation than the one of the token;
  6. the server's gates: a body with only one of the two fields (400), either flag off (503 for a body that carries
     both, and the restart that applies the flag drops the agent's prompts still queued), the gates of the message
     route with its throttle (240 sends an hour for all sessions), and `RAROG_HERDR_SEND=0`, which refuses every
     send;
  7. the audit entry: the agent's prompts carry `sender` in the audit log (rule 8 of "herdr sessions").

  What it does not protect against: the model judges whether the utterance is a yes, and anyone near the phone can
  say it. The confirmation lives in the app and is not a server guarantee; the server cannot tell an unmarked body
  from a typed message, and a paired device could always send prompts. To turn it off: `RAROG_COMPANION_SESSIONS=0`
  and `rarog restart` ("Emergency runbook").
- **A result marked as received.** With the same two flags, `POST /api/sessions/:id/seen` with
  `{by: "voice-agent", conversation, readMark}` from a turns read marks the result the agent read as received, with
  `seenBy` on the row (`docs/companion.md`, "Picking up a result"). It cancels the session's pending push
  notification and, while herdr shows a standing `done` badge, calls `agent.focus`, which switches the view of every
  attached herdr client on the Mac, behind the gates of the person's receipt (`RAROG_HERDR_SEEN_FOCUS=0`,
  `RAROG_HERDR_SEND=0`, read-only herdr). A wrong pick-up hides a result from the owner, and an outside model drives
  the agent, so the server takes only the result the agent read. What stops it on the server: either flag off (503),
  a session outside the session catalog (404), and a 409 with nothing changed for a session outside `waiting-input`
  or with a permission card, question or consent card in `pending` waiting on it, for another engine conversation
  than the one of the token the agent read, for a message in the session's memory newer than that read or another
  `stateSince` (another `readMark`), and for a turns read that returned no messages or a message trimmed to the
  ceiling of one message, whose mark names no read and meets no session's mark. A turn shorter than the
  supervisor's `working` grace whose messages the server has not followed from the conversation file yet is outside
  that check. The body without `by` is the app's own receipt, which any paired device can send.
- **The keys stay on the server.** `OPENAI_API_KEY` and `SONIOX_API_KEY` are in `logSecrets` and in no response. A
  paired device gets only short-lived OpenAI keys (60 s) and temporary Soniox speech keys (600 s), each behind a
  throttle shared by all devices, so every paired device can spend the accounts' money within those limits: the
  OpenAI key belongs to a separate project with only Realtime access and a budget limit.
- **Revocation.** A revoked device gets no new key and its questions in flight are killed; keys already issued run
  out on their own ("Emergency runbook").

## PR status: the state of session PRs from GitHub

The server asks GitHub for the state (`open`, `draft`, `merged`, `closed`) of the PRs that sessions created
(`docs/pull-requests.md`, "State on GitHub"). `RAROG_PR_STATUS` is on by default; `0` turns the channel off. It is not
a killswitch: the channel approves nothing, sends nothing to a pane and gives a device no new power. It is an outbound
channel, so this section says where it goes and what it carries.

- **Where and whose account.** Only `github.com`, through the GitHub CLI (`gh`) with its active account for
  `github.com`: the login the user made with `gh auth login`. Rarog has no GitHub token of its own and never reads
  the one `gh` keeps; `GH_TOKEN` and Rarog's secrets do not pass into the process.
- **What it sends.** Owner, repository name and PR number of each PR on a session list, as GraphQL variables on
  stdin (never in argv), at most 50 per call. **What it gets:** the state and the draft flag of each PR and the rate limit counters.
  Nothing else from the answer is kept, and none of it reaches the log.
- **When.** Only while at least one app has the SSE stream open, and rarely: one call per 50 PRs, then every 5 min
  for open, draft and closed PRs, every 30 min for PRs without a state, never again for a merged one. Failures pause every
  call for 30 min, GitHub's rate limit until its reset (at most 1 h). This channel does not touch git and does not
  run without a client, so the rule against polling GitHub in the background holds
  (`architecture.md`, "Data model: what does not exist", no `git fetch` in the background).
- **The process.** `gh` starts only from `server/src/pr-status/gh.ts` (`server/test/pr-status-granice.test.ts`):
  the first executable of a closed list of absolute directories, `execFile` without a shell, fixed argv, an
  environment cut to `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR` and `PATH`, 20 s with `SIGKILL`, 1 MiB of stdout and
  of stderr. `rarog doctor` runs `gh auth status --active --no-refresh --hostname github.com` through the same
  module: read-only (`--no-refresh` keeps `gh` from refreshing and storing a token), and not in the demo.
- **The log** gets one line per failure or pause: the kind of failure, the number of PRs and the pause, never
  a repository name, a URL or anything `gh` printed.
- **Demo and review mode** never start `gh`: the states come from a fixed map
  (`server/test/demo-review-proces.test.ts`).

## Inbox: the last message of every session on request

The Inbox (`docs/implementation-spec.md`, "Inbox") puts the last message of the agent's latest turn of every Claude
Code session in scope in one place. `RAROG_INBOX` is on by default; `0` takes the capability, the stream events and
the routes away (503). It is not a killswitch: it approves nothing and sends nothing to a pane.

- **What a device gets.** Any paired device can read the text of every session's card (`GET /api/inbox`, at most
  12,000 characters each) and the heads of the cards on a stream opened with `inbox=1`. The same devices read the
  same text today through the session stream, which gives the whole transcript of any session in scope, so the Inbox
  adds no reach; it gathers what a device could read one session at a time. A Codex pane, a pane out of scope and a
  closed session have no card. The route goes through the same three gates as every route (`Origin` for a mutation,
  the device key, the device again after the body), and a device revoked before its request gets nothing.
- **A decision card's pending card.** For a decision card whose permission or question card is still pending, the
  route reads that card the way the session stream does when it opens; a consent channel card then counts as shown
  on a device, which is true, because the device is receiving it. The card tracker itself never reads it.
- **What lies on disk.** `<dataDir>/inbox.json` (`0600`, written atomically) keeps the removals: per entry the
  session id, an opaque hash of the turn, the card kind, the dialog kind and an opaque hash of the dialog's identity,
  the moment of a failure, and whether the removal received the result. No text, no path, no command. The open
  sessions keep their entries; those of closed sessions are capped at 500. A damaged file reads as no removals, and the
  next removal replaces it; deleting it brings back the removed cards and nothing else ("Persistent state on disk" in
  `docs/architecture.md`).
- **A removal is a receipt.** Removing a `result` card of a session in `waiting-input` receives the result like
  opening the session in the app: the push for that result goes, the unread dot goes, and for a standing `done` in
  herdr Rarog focuses the pane on the Mac (`agent.focus`, only with `RAROG_HERDR_SEND` and `RAROG_HERDR_SEEN_FOCUS`
  on). So a stolen key can hide results and move the Mac's view, as it can today by opening sessions. Removing a
  `decision` or `failed` card only hides it on every device; the decision stays in the session and in the terminal.
  A restore takes the receipt back only when the removal gave it.
- **Demo and review mode.** The cards come from the demo sessions in memory, and removals go to `inbox.json` of the
  demo data directory; a demo restart does not bring them back into force.

## Tailnet name in the header

Rarog runs `tailscale status --json --peers=false` (`server/src/tailnet.ts`) to say in the AGENTS header which tailnet
the server is in. Read only, `status` only: literal arguments, `execFile` without a shell, a closed absolute list of
program paths (`/opt/homebrew/bin`, `/usr/local/bin`, the App Store application package, `/usr/bin`, `/usr/sbin`),
no PATH lookup; `--peers=false` keeps other devices' addresses out. The result goes ONLY to `GET /api/version`,
behind the credential gate, never to `/health` (a regression test in `server/test/router.test.ts`): the tailnet name
is network topology, and `/health` needs no key, even where its fields go only to a loopback caller. Failures and a
1.5 s timeout give `null`; the reading is valid for 60 s with a single flight, so requests do not spawn a process each.
No demo mode runs it: the plain demo answers with the fixed `example.ts.net` of its content set and the review mode
with `null`, so a demo shown or recorded does not reveal the host's tailnet.

## Claude Code version of a session: the CLI process registry

Rarog reads two Claude Code locations to show that a session runs an older release than the installed one
(`server/src/cli-version.ts`), both in narrow mode like `~/.claude.json` in rule 10 of "Starting sessions from the
phone", and writes neither:

- **`~/.local/bin/claude`:** one `readlink(2)` and a `stat` of the target; the result is the release number from
  `versions/<X.Y.Z>`.
- **`~/.claude/sessions/`:** a name filter runs BEFORE any read. Only `<pid>.json` of a live pid
  (`process.kill(pid, 0)`; signal 0 sends nothing) gets a read, up to 16 KiB, a regular file without a symlink (the
  session sandbox writes this directory, measured on Claude Code 2.1.311). Six fields are taken: `pid` (must equal
  the file name), `sessionId`, `version`, `status`, `waitingFor` (mapped to Rarog's closed list of dialog classes)
  and `startedAt`. The
  `<pid>.<hash>.key` files (the peer channel secret between sessions) NEVER get a `stat` or a read, checked by tests
  with a counting fake. The log gets two fixed lines at most ("CLI registry: unknown shape", "CLI registry: unknown
  dialog class"). The result (`SessionSummary.cliUpdate`) is two release numbers behind the credential gate.
- **The registry adds no power.** With `RAROG_CLI_WAITING` ≠ `0` the manager reads it every 1.5 s; `status: waiting`
  triggers a fresh screen read, and the card and digits still come from the screen through the same gates. Its
  effects are the waiting state, a card at most without a decision, and a refusal to send text into a dialog.
  `startedAt` of the only live process of a conversation lets the background task state machine drop a subagent whose
  last sign of life is older (`docs/background-tasks.md`); nothing goes to the pane, the phone or the log.
- **The version signal adds no power** (`server/src/version-watch.ts`). It keeps the installed release from the same
  `readlink` and the herdr version from the validated `ping` of the resync tick in `<dataDir>/versions-seen.json`
  (`0o600`), and on a change sends one `version-changed` push and one log line. File, push and line carry only
  version numbers that match `VERSION_RE` (up to 20 characters: letters, digits, `.`, `+`, `-`); a value outside it
  is ignored. The push has no session and no tap target.
- **The consent canary push adds no power** (`server/src/notify/consent-canary-push.ts`). It reads
  `<dataDir>/consent-canary.json` through the same reader as the proof rule's version gate and never writes it,
  keeps the announced results in `<dataDir>/consent-canary-pushed.json` (`0o600`, read through the regular-file gate)
  and sends one push per new result of a release. File, push and log line carry only a release number in the canary
  file's shape (digits and dots) and one of `pass`, `fail`, `unmeasured`. The push has no session; it changes no
  proof rule, which follows the canary file alone.
- **The weekly-limit signal adds no power** (`server/src/notify/weekly-limit.ts`). It reads the weekly windows from
  the same status line dumps as the tile (`rate_limits` only), keeps the reset instants of delivered pushes in
  `<dataDir>/weekly-limit-alerts.json` (`0o600`, read through the regular-file gate) and sends one `weekly-limit`
  push per window. File, push and log line carry only a percent and a reset instant: no account, session, path or
  token. The push has no session and no tap target, and the signal exists only with the APNs channel.

**Session restart adds no power: it combines two existing ones.** `POST /api/sessions/:id/restart` is `/exit` into
the pane (a write: `RAROG_HERDR_SEND`) and `claude --resume` in a new tab (`RAROG_HERDR_LAUNCH`, start throttle, pane
cap, two-writer gate, the env cleared per rule 12 of "Starting sessions from the phone"). Missing either power means
a refusal before `/exit`. Without an update, a restart exists only as Restart and Send under the note of a prompt
blocked by a `UserPromptSubmit` hook (body `{resend: {seq, id}}`). Limits:

- **`/exit` is FIXED text** (`RESTART_EXIT_COMMAND`) sent through the driver's slash command path; free-text `/exit`
  is refused (rule 4 of "herdr sessions"), so this is the ONLY way `/exit` reaches a pane.
- **Nothing is lost silently.** Before `/exit` Rarog checks freshly that the session is idle, the prompt field on the
  Mac is EMPTY in its whole area, the CLI registry holds exactly one `idle` process of the conversation and
  `claude agents --json` answers. The new process gets the permission mode read from the footer 1:1 (unreadable →
  refusal; `bypass` only in `RAROG_YOLO_ROOTS`).
- **A background task blocks the restart, checked twice** (before the other checks and right before `/exit`,
  `tasksBlockRestart`). Limit: a DORMANT subagent is not on the list, and own tasks of other shapes are unknown, so a
  restart kills them without a refusal (`docs/background-tasks.md`, "Known gaps").
- **A question on exit cancels the restart with one Esc.** When the session waits on a dialog after `/exit`, Rarog
  reads the screen once (2 s limit) and then sends one Esc whatever the read gave. On the exit dialog "Background work
  is running" Esc means "Stay" (measured on CLI 2.1.322, `kontrolny/wyjscie-tlo-2.1.322.txt`): the process and its
  tasks stay. When that dialog is on the screen, the transcript note names up to three of its task lines, each cut
  to 80 characters, and counts the rest; another dialog, a failed read or a late one gives the general note. This
  catches tasks the checks above do not list, such as a scheduled task.
- **The previous tab closes only when empty** (`closeShellTab`): a fresh `pane.list` and `tab.get` show one pane,
  `agent.get` finds no agent and `pane.process_info` shows EXACTLY one foreground process that is a shell. A split
  with a user pane or a program started after `claude` (`claude; nvim`) stays.
- **Resending is an existing write power under the user's gesture:** the prompt goes ONCE as the new process's start
  prompt (`agent.prompt`, never `--resume` argv), through the same text guard; the SERVER supplies the text from its
  send registry, and the body carries only the note's `seq` and the block's `id`, so a late tap from a second device
  cannot send someone else's prompt (409).
- **Clearing the field before `/exit` is `escape` keys under the user's gesture,** only with the driver's one-shot
  consent (`blockedLeftover`: the field holds the prompt of the last Rarog send the hook blocked), at most three Esc
  pairs, and the restart continues only with the WHOLE field empty. **Accepted risk:** text added at the Mac to the
  blocked prompt without sending is lost with it. `RAROG_PROMPT_BLOCK=0` turns clearing off.
- **Log:** `restart` with `reason` (`cli-update` or `prompt-blocked`) next to its parts (`prompt` with `/exit`,
  `launch` with `--resume`, possibly `close_tab`, and on resend `send_keys` and `prompt`). A restart canceled by
  a question on exit leaves a line in `server.log` with the number of task lines read, never their text.

## Git reads (git line, session diff): Rarog only reads git

Rarog does not change repositories: there is no `git switch`, `pull` or `push` from the phone and no `/api/git/*`
route. A person changes a repo from the iPad in the console (lazygit under `Cmd+G`), so under `RAROG_TERM`. The server
runs git only for the git line in the header (`git status --porcelain=v2 --branch --untracked-files=all`,
`git log -1`), the session diff: whole (`GET /api/sessions/:id/diff`) or per file (`GET …/diff/files`, the change
list, and `GET …/diff/file?path=…`, one file's patch), and the `ignored` labels of the session file listing
(`git check-ignore`, "Session files: listing and download" below). Limits:

- **The server chooses the directory, not the client.** Everything runs in the SESSION's `cwd`, behind the credential
  gate; the whole diff and the list take no path from the request, and untracked files the whole diff adds (at most
  20, through `git diff --no-index -- /dev/null <file>`) come from `ls-files --others --exclude-standard` in the same
  directory. A Codex card gets 400 on every diff route.
- **The file route uses a path only when it stands, character for character, on the list git printed for the session
  `cwd` in the same request** (`collectDiffFile` in `server/src/git-diff.ts`): the union of
  `git --literal-pathspecs diff --no-ext-diff --relative --name-status -z HEAD` and
  `git ls-files --others --exclude-standard -z`; absence is 404 `diff-file-not-found`. A pre-check (400 `bad-path`:
  no NUL, up to 4096 bytes, no leading or trailing `/`, no `..` or `.` segment) is shape filtering, not the boundary.
  A rename source is added by the SERVER from `--name-status`. A git failure never poses as 404 or an empty list (503
  `git-failed`, also for a timeout, a failed start, a killed process, and a path missing from a list cut by the read
  cap). A git refusal (exit code ≠ 0) means an empty list from that source only when the probe
  `git rev-parse --verify HEAD` confirms there is nothing to compare with (outside a repo, or a repo without `HEAD`);
  any other refusal is 503. The change list (`…/diff/files`) adds line counts from `numstat` (names and numbers only,
  with their own 1.5 s budget). Known limit: a file name that is not valid UTF-8 never matches the list and gets 404.
  Why this suffices: `--relative` keeps entries outside `cwd` off the list, an ignored file (`.env`) or
  an unchanged one is not on it, `ls-files` does not descend into a symlink, and `--literal-pathspecs` makes
  `docs/*.md` a path, not a pattern. Evidence: `server/test/git-diff.test.ts` (fake git) and
  `server/test/git-diff-repo.test.ts` (real git).
- **The diff does not leave scope, the session directory or the repo** (one gate, `diffSession` in
  `server/src/sessions/session-scope.ts`, for all three routes): a session outside the work area of
  `RAROG_HERDR_ROOTS` gets 400, and the gate checks the directory the read WILL use (`session.cwd`, which does not
  follow `cd`); every `git diff HEAD` runs with `--relative`, so a session
  in a repo subdirectory does not get the whole repo's patch; only a REGULAR file goes to `--no-index`
  (`probeUntracked`), because for a symlink to a directory git compares `/dev/null` with `<symlink>/null` and would hand
  out a file from outside the repo (measured on git 2.54, `server/test/git-file-details.test.ts`), so a symlink gets a
  block the server builds from the `readlink` target. Images from `.rarog-uploads/` do not leave an out-of-scope session
  or a Codex entry either (404, `readUploadWithinRoots`). Accepted risk: between the type check and git's read, a
  process with write access to the session directory can swap a file for a symlink; it runs as the same user, and the
  diff goes to the owner's device.
- **Every read names its repository and work tree; git does not look for them.** Before each read the
  runner resolves the session `cwd` (`realpath`) and walks up to the first directory with a `.git` entry of any kind
  (a directory, the file of a linked worktree or a submodule, a symlink), checking names with `lstat` only
  (`server/src/git-work-tree.ts`). Every command, and the config names read before it, gets
  `--git-dir=<that directory>/.git` and `--work-tree=<that directory>` right after the guards. Git puts `--work-tree`
  over `core.worktree` from repository config, which the agent writes. Without it, a
  `core.worktree` that points next to the project makes `status` list the files there, and `git diff HEAD` hands out
  the content of one as soon as the index has an entry with its name; a nested `.git/` in a project subdirectory does
  the same for a read from that subdirectory (measured on git 2.54, also under the macOS sandbox below, which blocks
  programs, not file reads). With `--git-dir` a `.git` entry that git does not take for a repository (an empty
  directory, a dangling symlink) ends the read; git's own search would skip such an entry, take the repository above
  and lay its index over the session directory, so the diff would carry committed files from outside it. With no
  `.git` up to the root git does not start, and the read answers as git does outside a repository (exit code 128).
  A session directory that cannot be resolved counts as a failed start. Callers cannot pass either option (`global`
  is a closed list, below). Git does not check who owns a repository it is given by name (`safe.directory`); the
  guards below stay. Not closed: git metadata in the session directory that points to another repository, either a
  `.git` file (`gitdir: <other repo>/.git`) or a `.git` directory whose `commondir` names it, makes `git diff HEAD`
  show that repository's committed content as deleted lines. A linked worktree and a submodule point to their
  repository the same way, so the runner cannot tell them apart. The pinned directory is a path, not an open
  directory: a session that can write the directory above it can swap it between the check and the start of git.
  That content goes only to the owner's paired devices. Evidence: `server/test/git-work-tree.test.ts`, real git,
  each hostile case with a control run of plain git that hands out the file.
- **Git is called ONLY with an argument array, never through a shell**, without stdin, with a 5 s timeout (then
  `SIGKILL`) and an 8 MB read cap; patches are cut at 512 kB (`MAX_DIFF_PATCH_BYTES`, `MAX_DIFF_FILE_PATCH_BYTES`) and
  the list at 500 entries (`MAX_DIFF_LIST_FILES`), each with `truncated`.
- **The log carries no file paths:** `git: diff list <ms> ms` or `git: diff file <ms> ms`, with a code on a refusal.
- **Rarog's secrets do not enter git:** the environment comes from `GIT_ENV_PASSTHROUGH` (point 6 of "Emergency
  console"), plus `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0` (no password prompt, no index touch).
- **Reads run no programs from repository config.** Repository config is agent data (the
  session sandbox writes `.git`, and Rarog's git runs outside the sandbox). The only runner (`spawnGitArgs` in
  `server/src/git-status.ts`, argv from `gitArgv`) puts `-c core.fsmonitor=false`, `-c log.showSignature=false`,
  `-c safe.bareRepository=explicit`, `-c core.hooksPath=/dev/null` and `-c diff.submodule=short` before EVERY
  subcommand. Right after the subcommand, every `diff` gets `--no-textconv`, `--no-ext-diff` (`diff.external` would
  replace the patch with a program's output) and `--ignore-submodules=dirty`, `log` gets `--no-ext-diff`, and
  `status` gets `--ignore-submodules=dirty`. The runner sets `GIT_NO_LAZY_FETCH=1` and an empty `GIT_ALLOW_PROTOCOL`
  last, over any `GIT_*` value the server passes through. What the flags close:
  - `safe.bareRepository=explicit`: a directory with `HEAD`, `objects` and `refs` inside the project is not taken for
    a repository, so its `config` (a `core.worktree`, a filter) never applies. Git honours this key only from
    protected config, and the command line counts as protected. A session directory that is itself a bare repository
    has no git line and no diff, unless a directory above it has `.git`: then the reads belong to that repository.
  - `--ignore-submodules=dirty`: git checks whether a submodule is dirty by running `git status` inside it, under the
    submodule's own config and filters. The flag skips that check, so a submodule whose only change is in its working
    tree shows neither in the git line nor in the diff; a new commit checked out in it still shows.
  - `core.hooksPath=/dev/null`: no hook runs, neither from `.git/hooks` nor from a repository's `core.hooksPath`.
    Reads do not write the index (`GIT_OPTIONAL_LOCKS=0`), so `post-index-change` does not fire either way.
  - `diff.submodule=short`: the `log` and `diff` formats would read a submodule's history or diff inside it.
  - `GIT_NO_LAZY_FETCH=1`: a repository with a missing object and a promisor remote does not fetch the object when
    `diff` needs it; the fetch would run `remote.<name>.uploadpack` or the transport of an `ext::` URL. An empty
    `GIT_ALLOW_PROTOCOL` allows no transport, so an `ext::` URL runs nothing even with `protocol.ext.allow=always` in
    repository config (`-c protocol.allow=never` would not do: repository config overrides it per protocol).

  **The session diff needs git 2.44 or newer**, the first version that honours `GIT_NO_LAZY_FETCH`. The runner reads
  `git version` once per `PATH`; with an older git, or output it cannot read, it refuses every `diff` without
  starting it. The change list and the file route then answer 503 `git-failed`, the whole diff is empty, and the git
  line has no line counts; `status`, `log -1`, `ls-files`, `rev-parse` and `check-ignore` still run, because a lazy
  fetch was measured on `diff` only. Callers pass `{ global, sub, rest }`: `global` accepts only `--literal-pathspecs`,
  `sub` only `status`, `log`, `diff`, `ls-files`, `rev-parse` or `check-ignore` (`GIT_SUBCOMMANDS`), checked again at
  run time, so a "subcommand" `-c` cannot override the guards; the version read is the runner's own fixed command,
  outside that list. `server/test/pliki-zwykle-guard.test.ts` checks that the literal `'git'` appears once, in the
  runner.
  Evidence on real git 2.54, each case with a control run of plain git that does start the program:
  `server/test/git-konfiguracja-repo.test.ts`. `GIT_CONFIG_GLOBAL=/dev/null` is not used: without `~/.gitconfig`
  `ls-files` loses the global `core.excludesFile`.

  **Filter drivers are emptied before every git process.** Git runs `filter.<name>.clean` or `process` when it hashes a
  working-tree file whose stat changed: on `status` (a change that keeps the size), on `diff` of a changed file and on
  `diff --no-index` of an untracked one. Before each git process the runner reads the config key names (`git config
  --null --name-only --list`, its own fixed command like the version read) in the same directory, with the same guards
  and environment, so it sees the same config files. For every `filter.<name>.*` key, from any scope (repository,
  worktree, `include.path`, global, system, the `GIT_*` pairs the server passes through), it sets `clean`, `smudge` and
  `process` of that driver to empty and `required` to `false`. These go through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n`
  / `GIT_CONFIG_VALUE_n` after any pairs the server passes through, not `-c`, which cuts a name at its first `=` (code:
  `server/src/git-config-guard.ts`). The runner takes `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS` and `GIT_EXEC_PATH` out of the
  environment of every git process: the first moves only the names read to another file, so a driver of the
  repository would stay unlisted, a pair in the second wins over the pairs that empty a driver, and the third would
  choose the directory git takes its own programs from. The read is refused and git does not
  start, with a failure that carries no exit code, when the names read fails, times out or reaches its 1 MiB cap, when a
  driver name is not valid UTF-8 (the environment cannot carry it byte for byte), or when the server's own
  `GIT_CONFIG_COUNT` is not plain digits. The names read and the git process share the 5 s timeout (1.5 s for line
  counts). Cost: Git LFS and every other filter are off in Rarog's reads, so a file under LFS whose stat changed shows
  as modified in the git line and the diff. Limit without the sandbox below: a driver written to the config between the
  names read and the start of git stays on for that one process. Evidence: cases with a control run in
  `server/test/git-konfiguracja-repo.test.ts`, and `server/test/git-diff-repo.test.ts` for the session diff.

  **On macOS every git process also starts under `sandbox-exec`.** The flags, the environment and the emptied drivers
  above are layer 1: they close the paths someone listed. Layer 2 closes the rest on macOS. The profile allows
  everything except starting a program and the network: git may start only the `git` that `PATH` gives (on macOS the
  `/usr/bin/git` shim) and the `git` in git's exec path (the git of the selected developer directory), matched by
  resolved path, and it opens no connection. A program from repository config therefore starts on no path, listed or
  not, and a driver written between the names read and the start of git does not run either: git reports the failed
  filter on stderr, and status answers with the file listed as modified. A script does not start even when it is named
  `git`, because its interpreter is a program too. The sandbox starts the `git` of the exec path, not the shim: on a
  cold cache the shim starts `xcodebuild` to find the developer directory, the profile denies that, and the read would
  end with exit code 71. The runner probes once per environment (`PATH`): it reads `git --exec-path`
  without the sandbox (that command reads no repository) and runs `git version` under the profile; the server runs this
  probe at start, before the first read (not in demo mode, which runs no git). The answer holds for the life of the
  process: after `xcode-select --switch` to another developer directory the runner keeps starting the git it found at
  the probe until the server restarts. When the profile cannot be applied, git runs with layer 1 only and the server
  writes one log line, `git: sandbox-exec is not applied (<reason>); git reads run with layer 1 only (…)`. Reasons: not
  macOS, no git on `PATH`, a `git` in the exec path that is a script, or `sandbox-exec` under another sandbox (it ends
  with exit code 71). Measured on macOS 27.2 with git 2.54: the profile applies under a launchd user agent, and it adds
  about 5 ms to a `git status` and 8 ms to a `git version`. Linux has no such sandbox, so two paths stay open there: a
  program reachable by a path layer 1 does not close, and a driver written in the window between the names read and the
  start of git. Code: `server/src/git-sandbox.ts`. Evidence: `server/test/git-konfiguracja-repo.test.ts` runs plain git,
  without layer 1, under the runner's sandbox: no filter driver, no lazy fetch through `ext::` or `uploadpack`, and no
  connection of a lazy fetch over `git://`, each with a control run of plain git that does start the program or connect;
  it also checks that every git process of a read goes through `sandbox-exec`, and the log line when the profile cannot
  be applied.

## Special files in the project directory

An agent in the sandbox writes the project directory, `.git`, the project's `.claude` and `.rarog-uploads`, so it can
put a FIFO, a device or a symlink under a name the server reads. Without a guard one `mkfifo` hangs the server: a
synchronous open of a FIFO without a writer stops the event loop, and an asynchronous `open` holds one of the four
libuv pool threads forever.

**Rule:** a file from a place the agent writes is opened only through `server/src/safe-read.ts`: `O_NONBLOCK` and
`O_NOCTTY` (a FIFO opens at once); `O_NOFOLLOW` where a symlink is the vector (`.git`, `.rarog-uploads`,
`~/.claude/statusline`, `~/.claude/sessions`; symlinked `SKILL.md` files and `~/.claude/skills` directories are a
feature); `fstat` on THE SAME descriptor (a non-file gives `null`, with no window for a swap); a read cap with
`{ bytes, truncated }` (an image 4 MB, a `.git` file and `commondir` 4 kB, `exclude` 64 kB); writing
`.git/info/exclude` only by appending to a regular file (`O_WRONLY | O_APPEND | O_CREAT | O_NONBLOCK | O_NOFOLLOW`,
`fstat().isFile()` before the first byte). The `gitdir:` and `commondir` targets must be directories before
`fs.watch` opens them.

**Writability measurement (Claude Code 2.1.311, session sandbox):** `~/.claude/statusline/` and `~/.claude/sessions/`
are writable, so the status bar dump and the CLI process registry go through the helper; `~/.claude/projects/` is
refused. **Reads outside the helper** are listed in `server/test/pliki-zwykle-guard.test.ts` (`WYJATKI`, each with a
reason): the server data directory, transcripts in `~/.claude/projects`, `~/.claude/settings.json`, `~/.claude.json`,
the push key file from the server config and the checkout's `package.json`. The guard collects bindings from import
lines (alias, namespace, `promises`), and a dynamic import or `require` of `fs` is forbidden. A new `fs` read in
`server/src` without an entry fails `pnpm test`.

## Session files: listing and download

`GET /api/sessions/:id/files?dir=…` (`docs/implementation-spec.md`, "Session files") lists one directory under the
session directory: names, kinds, file sizes and git's `ignored` label. `GET /api/sessions/:id/files/raw?path=…` sends
the bytes of one file there. `GET /api/sessions/:id/files/index` gives the paths of the files under the session
directory, for the app's search. `RAROG_FILES` is on by default; `0` takes the three routes and the `files` and
`file-index` capabilities away. It is not a killswitch: it approves nothing and sends nothing to a pane.

- **What a device gets.** Any paired device lists any directory under the directory of a Claude Code session in
  scope and downloads any file there up to the limit, including directories and files git ignores. A name kept out of
  git without a leading dot (`config/master.key`, `*.pem`) is listed with its size and sent like any other. The same
  devices can already start a session and ask the agent to read such a file, and outside a repository there is no git
  rule to lean on, so the routes add no reach. The `ignored` label is information, not a boundary: when git fails,
  the labels go and the listing stays, and a download never asks git.
- **What it never shows or sends.** A segment or an entry that starts with a dot (`.env`, `.git`, `.github`),
  `node_modules` in any letter case, a symlink, a special file (FIFO, socket, device), a file with more than one hard
  link (a hard link to a file outside the session directory would pass every path check), a path outside the session
  directory, an entry outside the work area ("Work area: where Rarog starts, lists and reads" above) and a name that is
  not valid UTF-8. A Codex entry, a pane out of scope and a session without a herdr pane get 400 before any disk call.
- **One path rule** (`server/src/files/path-rule.ts`) for the requested directory or file, in this order: the shape
  check (as on the diff routes); the text: a hidden segment, `node_modules` and the work area of `RAROG_HERDR_ROOTS` on
  `cwd + dir`, so a macOS-protected folder of home is refused before any disk call; a walk from the session directory
  one segment at a time, where the parent's entries must hold the segment byte for byte (letter case and Unicode form
  too) and each segment must be a directory, never a symlink; then `realpath`, which must be exactly the session
  directory on disk plus `dir`, inside the work area. After the read the directory must still be the one the walk
  found (`dev` and `ino`), else 404. Each entry gets its own `lstat` and must still be of the kind the read gave, so
  an entry swapped for a symlink since the read is left out. A mount point under the session directory is a directory
  like any other and stays on the listing.
- **The open of a file** walks the same way, the last segment a regular file, and then opens through `openRead` of
  the work-area port (`server/src/folder-gate/disk.ts`), which calls `openRegularFile` of `server/src/safe-read.ts`
  in the server process, or in the folder's helper process for a file in a protected folder of home (`O_NOFOLLOW`,
  `O_NONBLOCK`, so a FIFO answers at once). The
  `fstat` of that descriptor must show a regular file with one hard link (a second link may name a file outside the
  session directory). After the open, `realpath` of the path must again be the walked place, and its `stat` must carry
  the descriptor's `dev` and `ino`; else 404 with the descriptor closed.
- **The download** (`server/src/files/session-download.ts`, `server/src/files/send-file.ts`). The limit,
  `RAROG_FILES_MAX_MB` (1 to 1024 MB), is checked on the `fstat` of the open descriptor before the first byte: 413
  with the size and the limit. The bytes come from that one descriptor through the port's handle, exactly the
  `fstat` size in pieces of 64 KiB at their own offsets, so a file swapped or appended after the open does not change
  what goes out, and a file cut
  while it is sent destroys the response. One piece per download is held in memory, never the file. The response
  carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. The device is checked again after the open,
  before the headers, and the download is registered under it with no wait in between: revoking the device destroys
  the response and closes the file, over TCP and over iroh ("Pairing and device keys" below). A client that goes away
  closes the file too.
- **The read binds to the directory, not its path** (`readDirectoryByIdentity` in `server/src/safe-read.ts`). On
  Linux the directory is opened with `O_DIRECTORY | O_NOFOLLOW`, its `fstat` must carry the `dev` and `ino` of the
  walk, and the entries come from the descriptor through `/proc/self/fd/<fd>`. On macOS the entries come through
  `/.vol/<dev>/<ino>`: the kernel turns the inode back into its current path within the one call, so a swap made
  before the call does not redirect it.
- **The `ignored` label** comes from `git check-ignore` through the only git runner ("Git reads" above: the closed
  list of subcommands, the guards, the pinned repository, the macOS sandbox). It runs in the listed directory, so a
  nested repository and a submodule answer with their own `.gitignore` and `info/exclude`. Every name goes after `--`
  and after `./`, because `check-ignore` refuses `--literal-pathspecs` (git 2.54.0), and a name that starts with `:`
  would otherwise read as pathspec magic; names go 200 per process, as arguments, since the runner gives git no stdin.
  Only an output line in the form `./<name>` counts. A line in another form, a broken C-style quote, an exit code
  other than 0 or 1 in any batch, a timeout or a capped read drops every label of the listing; exit code 1 means that
  batch has nothing ignored. A tracked file gets no label.
- **The index** (`server/src/files/file-index.ts`) reaches no further than the listing: every directory it walks is
  read by the listing and its path rule, so it holds no path a listing would not show. Git only narrows it to the
  files git does not ignore (`git ls-files` through the same runner, in the session directory); a path git names
  that the walk does not find never reaches the index. The walk is bounded: one walk at a time per session directory,
  with requests during it sharing its answer, and ceilings of 20 000 paths, 2 MiB of body and a soft budget of 3 s,
  past which the index comes with `truncated: true`. The device is checked again after the walk. A search pattern
  never reaches the server: the app matches the index itself.
- **Demo and review mode.** Every demo session lists one fixed project from memory, indexes it and sends its files
  from memory; no disk call, no git.

Accepted risk:

- On macOS the read through `/.vol` narrows the window of a swap of the directory for a symlink during the read, but
  does not close it: Node has no descriptor-based directory read there. The checks after the read narrow it further.
- A volume without `/.vol` support (some network file systems, FAT) answers 404 for every listing on macOS.
- A swap of an intermediate directory for a symlink between the walk and the open of a file is narrowed by the check
  after the open (the path resolves to the walked place, whose file is the one the descriptor holds), not closed for
  every order of steps.
- Swapping a directory needs a process that writes in the session directory, and such a process already reads the
  user's files with the user's rights; the listing and the download go only to the owner's paired devices.

Evidence: `server/test/files-sciezka.test.ts` (the path rule, with a disk that counts calls and swaps a directory
between two of them), `server/test/session-files-repo.test.ts` (real git: hidden and special entries, the label in a
nested repository, a submodule and a session directory without git, quoted names, failed batches),
`server/test/session-files.test.ts` (the route, the refusals, the switch, the demo), `server/test/file-index.test.ts`
and `server/test/file-index-repo.test.ts` (the index: what a listing leaves out, a directory swapped during the walk,
the ceilings and the budget, one walk at a time, the scope from git with a nested repository and a submodule),
`server/test/session-files-raw.test.ts` (the download: the limit from the variable, exact bytes, a file appended or
cut while it is sent, a client gone, a revocation over TCP and over iroh, the demo) and `server/test/safe-read.test.ts`
(the exact reader).

## Pairing and device keys

The server's only credential is the device key from pairing with a code (item 3 of "Layers"). Code:
`server/src/auth/` (`device.ts`, `devices-store.ts`, `pairing.ts`, `admin.ts`, `principal.ts`); the effects of
revocation: `server/src/device-effects.ts`. Pairing from the app and the `rarog` commands: `docs/distribution.md`,
"Pairing from the app". What the app keeps on the device: "Native client" below.

**The key's power** is the whole Rarog API: approving dialogs, the emergency console, notes and dictation. Four routes
act on the device record: issuing and cancelling a code for a new device (`POST` and `DELETE /api/pairings`), the
device list (`GET /api/devices`, `GET /api/devices/me`), Forget Server (`POST /api/devices/forget`, revokes itself)
and APNs token registration (`POST /api/push/apns`).

**Credential.** `Authorization: Rarog-Device <deviceId>.<secret>` in REST, SSE and the console's WebSocket upgrade;
`deviceId` is 16 random bytes (public), the secret 32 random bytes (base64url). Only the `sha256` of the secret is on
disk, compared in constant time. The `Origin` gate for mutations applies with a valid key too. The key is checked a
SECOND time, synchronously, right after the request body arrives (`bodyRechecks` in `readJsonBody`, the router's only
body path), so a device revoked while its body was flowing does not finish the action. A key expires after 30 days
without use (`lastSeenAt`, moved at most once a minute), and a record without A SINGLE request for 10 minutes after
pairing (the `/api/pair` response got lost) expires as an orphan. A
record carries the epoch of its issue: a start with another `RAROG_AUTH_EPOCH` revokes all keys (`revokedBy: admin`).

**Store `<dataDir>/devices.json`** (`0o600`, tmp+rename, a permanent `serverId`): records with id, secret hash, push
key, `kid`, label, build, dates, epoch and code creator, plus tombstones of revoked devices. The push key lies in the
clear because the server encrypts banner content with it ("Push notifications": whoever reads this file can forge an
encrypted banner). `devices.json.bak` keeps the previous version limited to active devices and tombstones (a revoked
device does not come back from the copy, even when its tombstone fell off the list capped at 200; a tombstone on the
`creator` chain of an active device stays above the cap); an unreadable main
file means the state from the copy and a log line; both files unreadable mean an empty store, every device pairs
again, and `/health` says `authStore: "broken"` to a loopback caller. A main file or copy with a format `version`
higher than this server knows (written by a newer Rarog) is never overwritten or deleted, even next to a readable copy:
`rarog serve`, `rarog serve --check` and the server start refuse with a line naming the file, its version and the
known version, so going back to an older Rarog keeps the pairings. Under launchd the refusal repeats on every service
start, as with a broken `config.json`, until the matching version is installed. Only whoever knows a revoked device's
secret gets 401 `device-revoked` with date and cause; the rest of the world sees `device-unknown`.

**Pairing.** A code is 32 random bytes (base64url), valid 5 minutes, single use, kept as a hash in process memory
(a server restart erases it). The
pairing link `https://rarog.ai/pair#v=1&u=<address>&k=<EndpointId>&r=<relay>&c=<code>` (an HTTPS address, an iroh
EndpointId with its relay, or both) carries data in the FRAGMENT, so a browser does not send the code in a request.
`POST /api/pair` is public (the code is the credential). After reading the body the server takes ONE
synchronous step without `await` (expiry, creator still active, consumption, the new record counted as active), and
only then writes; a write error rolls the record back and answers 500 (the code is burned). So two parallel requests
with one code end
in one 200 and one 404, and no second "first" device can pair. A wrong, used or expired code is one 404
`pair-unknown`; wrong attempts do not burn a pending code (256 bits rule out guessing). One throttle budget covers a
wrong code and an unknown key in REST, SSE and WebSocket (10 failures per 60 s, then 429; valid ones always pass).

**Who opens a pairing link.** Rarog builds the universal link `https://rarog.ai/pair#…`; the link parsers of the
server and the app also read the same fragment after the custom scheme `rarog://pair#`. The app's scanner and its link
field read the text themselves and bypass the system's routing. A link opened outside the app (the Camera, Messages,
Mail) goes through iOS. Any app can declare the `rarog` scheme, and iOS does not define which app opens a link when two
apps declare the same scheme, so a `rarog://pair#…` link opened that way can reach another app together with the
code, and whoever redeems the code within its 5 minutes pairs with the server. The universal link closes this: iOS
opens `https://rarog.ai/pair#…` only in the app that the domain names in its association file
(`/.well-known/apple-app-site-association`, which iOS fetches through Apple's CDN), and the app claims the domain
with the `applinks:rarog.ai` entitlement (`native/Rarog/docs/app-target.md`). A `rarog://` link opened outside the
app keeps the exposure.

The universal link has its own boundary: when iOS does not hand it to the app, a browser opens it. That happens on a
device without the app, after the person chose to open the domain in Safari (iOS remembers that choice per domain),
for a link tapped on a page of the same domain, and for a link clicked in a terminal on the Mac. The browser does
not send the fragment in the request, but the code then stands in the address of a `rarog.ai` page: it is visible
to that page, to the browser history and to browser extensions with access to the page. Such a code stays single
use and expires 5 minutes after it was issued, and its creator can cancel it at once (below).

**Label and build.** The device sends its label and build number when it pairs, so both are input from outside and
reach the app's device list and the owner's terminal (`rarog devices`). The label loses control characters and every
character hidden on the consent card (`CARD_HIDDEN_RANGES` in `server/src/hidden-chars.ts`: text direction marks,
zero-width characters other than the emoji joiner U+200D, tag characters U+E0000–U+E007F, the variation selectors
U+E0100–U+E01EF, the Hangul fillers, the soft hyphen), then whitespace folds to one space and the label is cut to
64 code points; an empty result is `device`. Tag characters go whole, so a regional flag such as Scotland's shows
as a black flag. The build is at most 10 ASCII digits after trimming, anything else is `null`. The device list
(`GET /api/devices`), the admin list (active devices and tombstones, also in the revoke replies) and `rarog devices`
apply the same rules again on the way out, so no stored record bypasses them (`sanitizeLabel` and `sanitizeBuild`
in `server/src/text.ts`).

**Who issues a code.** Consent to a new device is a code issued on an already paired phone:

- **the admin socket** (the CLI on the Mac) issues a code ONLY when the server has no active device (first device,
  recovery); with an active one it refuses with 409 `device-active`: "The server already has a paired device; pair
  new ones from the app: Settings → Pairing → Pair New Device.";
- **a paired device** issues a code through `POST /api/pairings`; the code remembers its creator (`creator` in the new
  record and the device list). One unused code per creator; revocation or expiry of the creator invalidates its codes.

The creator of a code can cancel it at once, so a code its owner gave up on does not stay usable for the rest of its
5 minutes. A device cancels its own unused code with `DELETE /api/pairings` (key, Origin gate, empty body; 204 also
when there was none; codes of other creators stay). `rarog pair` cancels its code through the admin socket
(`DELETE /api/admin/pairings/:pairingId`) when SIGINT, SIGTERM or SIGHUP (a closed terminal) comes while it waits,
waiting at most 2 s for the answer, and exits with 128 + the signal number after one line: `pairing code cancelled`,
`could not cancel the pairing code; it expires at HH:MM`, or, when the signal met the redemption (409
`pairing-redeemed`), that the code was already used and the device is paired (`rarog devices`). Once `rarog pair`
has seen the code used, a signal cancels nothing.

After pairing, the other active devices with `alerts: true` get a `device-paired` push (`push.paired-title`) with
the new device's label. The push is best effort; the lasting trace is the device list, which the app compares after
every `hello`, showing a New device notice in the list's banner strip until the person closes it.

**Admin socket `<dataDir>/run/admin.sock`** (directory `0o700`, socket `0o600`) is the ONLY place for `/api/admin/*`
routes; on port 8930 they do not exist. Access to it is THE OWNER'S POWER: a pairing code (a permanent device, and
with it approving dialogs), revoking devices, releasing consent channel cards to the terminal
(`POST /api/admin/dialogs/release`) and the consent channel kill switch until the server restarts
(`POST /api/admin/dialogs/off`). The socket does not check who connects (Node gives no peer credentials of a unix
socket), so any process that connects has all of these routes. Reason for a socket instead of the port (measured in
the Claude Code session sandbox): an agent in the sandbox
reads the server data directory and connects to `127.0.0.1:8930`, so an admin token in a file or a route on the port
would give it pairing, and with it approving its own dialogs and a console outside the sandbox; the sandbox does not
pass connections to unix sockets by default. `X-Forwarded-For` is no boundary. The socket is created AFTER a
successful `listen` on the port; a live socket of another process stays untouched, a dead one (after a crash) is
removed and created anew, and a path longer than 103 bytes means no socket while the server keeps running. The
consent channel routes return 503 `consent-unavailable` while the server has no control of the channel, and the
release route returns 503 `channel-closed` outside the effective modes `main` and `all`.

**Consent channel registration socket `<dataDir>/run/consent.sock`** (the same directory `0o700`, socket `0o600`) has
two routes. `POST /register`: at `PermissionRequest` the hook registers through it a random secret the server signs
the answer file with. `POST /claim`: the hook's receipt of a signed `allow` it has taken, signed with the same secret
under its own prefix; the hook gives `allow` to the CLI only when the server confirms that the file is the record's
live `allow` (same `decisionAt`, state `sent` or `claimed`). So a copy of an old `allow` with a valid signature (a
`.revoked` file renamed back, a file written back after a revoke) gives nothing. A wrong receipt signature and an
unknown key get the same 403, so the answer does not tell whether a key exists. Admin routes do not exist on this
socket (404), and neither route exists on the admin socket. The separate file narrows power: a process with access to
this socket can at most block a card by registering the same key, and delay a session's consent card without the allow
button by up to 3 s per accepted main-thread registration (the card waits for the channel card). A second, different
registration of a key blocks it for good (409 `key-blocked`), and the server signs nothing under it, because it cannot
tell which registration came from the hook. After a server restart the new process has no secret, so it takes a
registration of a key that already has a record only where recovery expects one, within the restart grace G and for a
record whose hook `ps` finds alive (`docs/dialogs.md`, "Channel cycle"): every identity field equal to the record's
(session, `promptId`, `agentId`, pid, hook start, `inputSha256`, `cardSha256`), and for a record with a signed answer
file a secret that verifies that file, so only the secret the hook sent the stopped process; this holds also when the
hook took the file before it registered again. The hook sends the secret again; the server still keeps it in memory
only and writes it nowhere. Any other registration of such a key blocks it. A `pending` record that waited for its
hook never gets the allow button back in that server process, also after the hook registered again: the button needs
the transcript history continuous from the hook start, and nobody read the transcript while the server was down, so
a "Yes" at the desk followed by a truncation of the file would read as a call still waiting. Deny and release stay.
The identity fields of a `pending` record are readable from its dump, so a process with access to this socket can
register first in that window: the hook's own registration then blocks the key and the card ends without a decision
from the phone. That is the blocking power above, plus a deny or release from the phone that may be signed for the
wrong secret before the block; no hook takes a file its own secret does not verify, so nothing runs. Approving or
releasing from this socket is impossible: a receipt needs the live hook's secret and confirms only an `allow` the
server already signed. The secret registry lives only in the server process memory; the secret reaches no answer,
log or file, and the answer and log carry no card hash either.
The registry starts closed and refuses every registration (503) until the server opens the channel. With the channel
open it checks on its own, without `alive.json`: the body shape (up to 32 KiB, an unknown field or an unknown
`alwaysVersion` = 400), a main-thread
request at effective `main` (a subagent request = 503; at effective `all` a subagent request is accepted too), sending
on and the session on the observed list (otherwise 503); at most 64 live registrations per session and 1024 in total
(429). The server never signs `allow` or `deny` for a subagent request on its own: without a decision from a device
the only answer it signs for it is `release`, after 10 s without proof (at once when the session hook list gives no proof
for the life of the session process, `docs/dialogs.md`, "Channel cycle") or when the card ends without a claimed
answer while its hook waits (the hook exits without a decision, the dialog stays in the terminal). An entry lives at
most the hook `timeout` plus 10 min from acceptance. The socket exists only in a channel mode that needs hook registration:
with `off` and `shadow` there is none, and a hook without the socket does not wait, except in the restart break
(`docs/dialogs.md`, "Restart break"): there it waits for the next server's socket at most the restart grace, and
registers only on a fresh `alive.json` with the channel open for its request. Start, modes and replacing a dead
socket work as for the admin socket.

**The approve button without the top of the screen holds only on a measured Claude Code release.** The `channel`
proof rule gives a consent card the approve button from the hook channel alone, because on the measured releases
a signed `allow` reaches only the hook that waits for its own call, and a late `allow` after a decision at the desk
runs nothing (`docs/dialogs.md`, "`PermissionRequest` hook behavior"). If a new release tied the late `allow` of an
orphaned hook to whatever dialog stands at that moment, the phone would approve a command it never showed. So the
rule holds on releases up to the package constant `CONSENT_CHANNEL_MEASURED_CLI` except the exact releases it
excludes (a release under it that did not pass the measurement for both request kinds), and on exact releases that
`<dataDir>/consent-canary.json` lists as passed, per request kind. Every other release gets the screen top rule,
which needs the dialog alone on top of the screen, and so does a release and kind with a failed entry, also up to
the constant. A file the server does not trust (a mode other than `0600`, not a regular file, not JSON, a field
outside the contract) counts as no file: the package constant alone, never more (`docs/dialogs.md`, "Proof rule").
A change of a kind's rule to the screen top takes away every proof taken under `channel` at once: the cycle asks
the gate again at each view of a card with the approve button, at the decision and before the signature, so an
observation that started before the change gives no button. A proof keeps the rule of its own request, so a
subagent's MCP request, whose hidden proof always needs the full screen-rule checks, keeps its button. The data
directory is `0o700`, and the write block rules of `rarog setup` keep a Claude Code session that loads the user
settings from writing it ("Guarantee boundary"), so only the owner's account outside the sandbox adds a release.
Without those rules a session started in `~` writes the file and can add a release. Rollback:
`RAROG_CONSENT_PROOF=screen` and `rarog restart`, or removing the file (the package constant
alone).

**The phone approves only a call whose whole input reached it.** A channel card carries every input field in full up
to the hook's input ceiling, 1 MiB of compact JSON (`HOOK_TOOL_INPUT_MAX_BYTES`); the card's presentation may take
64 KiB more for indentation (`CONSENT_DISPLAY_MAX`). Over either ceiling the card is `truncated`: no text leaves the
server and there is no approve button, while deny and release keep working. The app shows a text over 32 KiB as a
preview in the card block, and the whole input is one tap away in a read-only window. Until that window has appeared
for the card on the session screen, the approve button, the "always" option and the plan approval stay greyed with a
line that asks to open the full request, and the screen's decision handler sends none of them; deny always works.
The mark comes from the window's content appearing, not from the request to open it, so a window closed, or swapped
for another one, before it appeared leaves the card locked. The session screen holds the mark per card, so after a switch to another
session or an app restart the card asks for the window again. The signed answer covers the card hash over the whole
input (`cardSha256`), never the preview.

**"Always" from the phone adds only what Claude Code itself proposed (N2).** A channel card's "always" makes the hook
answer `allow` with `updatedPermissions`, so Claude Code keeps the permission for the calls that follow (docs:
https://code.claude.com/docs/en/hooks, "Permission update entries"). That is more power than one `allow`, so it
has its own bounds. The updates come only from the hook's own stdin `permission_suggestions`: the signed file carries
the sha256 of the list inside the MAC, never the list, and the hook refuses a file whose hash differs from its stdin
list. Only a closed list goes out, checked by the server before the card shows the option and again by the hook:
`addRules` with behavior `allow` for this session or the project's `.claude/settings.local.json`, mode
`acceptEdits` for this session, a working directory for this session. `replaceRules`, `removeRules`, `deny` and `ask`
rules, any other mode (`bypassPermissions` too), `projectSettings` and `userSettings` never get the option, and
neither does a plan card. The card shows every update literally with its destination. `allow-always` passes every
gate of `allow` (approve button, roots, sending on, a supervisor that is not read-only) and is refused the same way;
the record keeps the written updates. Off switch: `RAROG_CONSENT_ALWAYS=off` and a restart (`docs/server-config.md`).
An older hook copy never writes updates: it does not offer the option and rejects such a file.

**Guarantee boundary.** Blocked: the path where access to the admin socket, or a one-off innocent-looking pairing
command run outside the sandbox, gives the agent a permanent device it uses to approve its own dialogs. With a paired
device the socket issues no code. An agent in the sandbox has no access to the sockets: `connect()` to a unix socket
gets EPERM (Claude Code 2.1.311 with `herdr.sock`; 2.1.325 with a socket in a stand-in `<dataDir>/run/`, with and
without the write block rules below). It can read the data directory. Whether it writes the data directory and
`~/.config/rarog` depends on where the session started: a session started outside them gets "Operation not
permitted" there (2.1.311, `touch`), while a session started in `~` writes them unless the write block rules hold
("Write block for the Rarog state" below). A sandbox config can open unix sockets to it
(`sandbox.network.allowUnixSockets` with the `<dataDir>/run/` directory, or `sandbox.network.allowAllUnixSockets:
true`): such an agent can at most block a card through the registration socket, and with the admin socket it has the
owner's power (pairing, revoking, release and kill switch of the consent channel) and falls outside this boundary like
an owner process outside the sandbox. `rarog doctor` warns about such entries, and about a second `PermissionRequest`
hook, in `~/.claude/settings.json`; it does not see project settings, so the line warns and does not protect. The
agent has no write access to the hook copy Claude Code runs outside the
sandbox (protected by Claude
Code itself, measured on CLI 2.1.311). **Not closed: the sandboxed agent can change the server code that runs
outside the sandbox** (the class "code from an installation outside the sandbox"). launchd and `restart.sh` run the
server from the install directory, and `hooks:install` copies the hook from it. In a
clone that is the checkout, which an agent in the sandbox writes: a change shows in `git status` and `git log`, but
nothing blocks it. An npm package under nvm or pnpm is in the same class (from a Claude Code session started in `~`, a
sandbox write to the global npm directory and to `~/Library/pnpm` passes, measured on macOS), without a git trail: the
difference shown before the write protects the hook copy (with a question, except right after an update installed
the package: "Hook copy written by the update"), nothing protects the server code. The data directory, whose `sdk/`
holds code the server imports at start, and `~/.config/rarog`, whose `config.json` names programs the server and the
service run, fall outside this class only while the write block rules hold (below). A Node installation outside
home is narrower; `rarog doctor` notes it when the install directory lies under `$HOME`. The width of this class
depends on the user's sandbox config. NOT blocked: a process running freely as the owner can change `devices.json` and
restart the server ("we protect the access channel, not the agent", item 4 of "Layers"). Recovery after losing the
only phone is open to such a process too, and is DETECTABLE, not blocked: a revoked device sees 401 `device-revoked`
with `revokedAt` and `revokedBy` on its next connection, with no immediate notification (revocation deletes the APNs
tokens). The app then deletes the key and shows a lasting Device Revoked screen until pairing again; the
same after 30 days without use of all devices. There is no recovery key outside the Mac.

**Write block for the Rarog state.** The Settings step of `rarog setup` appends two rules to `permissions.deny` in
`~/.claude/settings.json`: `Edit(//<dataDir>/**)` and `Edit(//<home>/.config/rarog/**)`, for the data directory of
the installed service (`docs/dialogs.md`, "Writing the hook entries"). Claude Code merges `Edit` deny rules into the
sandbox configuration, and outside the sandbox applies them to its file tools, to file commands it recognizes in
Bash and to the targets of Bash redirections, not to a script that opens files itself
(https://code.claude.com/docs/en/sandboxing, https://code.claude.com/docs/en/permissions). Measured on Claude Code
2.1.325, macOS, in a session started in a stand-in home that holds both directories, with the result read on disk:

- Bash in the sandbox gets "Operation not permitted" for every write there: a new or overwritten file (also in
  `answers/`, also from `node`), `mkdir`, `cp`, a rename, `unlink`, a new file, symlink or FIFO in `run/`, a write
  through a symlink from the working directory, a hard link to a file there, a path in another letter case, and `mv`
  of either directory or of a parent directory (also without `run/` and without the `denyRead` paths).
- The Write and Edit tools get "File is in a directory that is denied by your permission settings", also for a path
  in another letter case, and the files stay unchanged.
- Both write a file in the working directory. A file outside the two directories is written also through a symlink
  that lies in `~/.config/rarog`, and edited by its own path when such a symlink points to it: the rules cover paths
  in the two directories, not link targets outside them.

What the block keeps from a session started in `~`: a forged answer to `AskUserQuestion` in another session (files
in `answers/` carry no signature), `alive.json`, `roots.json` (wider roots widen the hook's scope), `pending/`,
`markers/` and new names in `run/` (a denial of service of the consent channel), a release added to
`consent-canary.json` (the proof rule above), and for the next server start code in `sdk/`, a device in
`devices.json` that approves the agent's own dialogs, text in `prompt-queue.json` pasted into another session's pane,
and the programs the server and the service run, named in `config.json` (`RAROG_HERDR_BIN`, `service.wrapper`).
Limits: the rules act only in a session that loads the user settings file, and only on paths. A command that runs
outside the sandbox writes the state through a child process (after a permission prompt, or with none in
`bypassPermissions`, which `RAROG_YOLO_ROOTS` allows), and so do hooks and the status line command, which Claude Code
runs outside the sandbox with the user's access (the permission hook writes `pending/` that way). Linux is unmeasured.
A session in `~` writes the npm installation either way ("code from an installation outside the sandbox" above).
Without the rules (the question answered "n", or a session that does not load the user settings) a session started
in `~` writes everything in the list above. `rarog doctor` has a line for the block: both rules = ok, a missing rule =
a warning with the rule and `rarog setup` as the fix, and a data directory with a character that permission rules
read as a pattern gives no rule and never ok. It compares literally and reads only `~/.claude/settings.json`, so an
equivalent rule in another spelling warns, and the line warns, it does not protect. The line and the block of
`rarog hooks print` name the data directory of the installed service, whatever the shell they run in computes;
without a service they take `--data-dir` (doctor) or the rule on the environment. The cost: a Claude Code session
does not edit `~/.config/rarog/config.json`; the owner edits it in a terminal.

**Revocation** (from the socket, Forget Server, expiry, a stale epoch) at once turns the record into a tombstone,
invalidates that creator's unused codes and CLOSES the device's running SSE streams and open consoles (marked with its
`deviceId` when opened; a check at open alone would not cut off a live shell). The console socket is cut
synchronously (an `err` frame and code 1008; frames after the cut go to the bin; no close confirmation within 2 s,
`TERM_REVOKE_TERMINATE_MS`, drops the socket). It also kills the `claude -p` process of every voice agent question
the device has in flight and closes those responses without a body, and it destroys the responses of the device's
session file downloads in flight and closes their files ("Session files: listing and download" above). Finally it ends
the device's Live Activity and deletes the APNs tokens registered with its key. A route whose long step can outlast
a revocation checks the device again before it answers: the temporary Soniox dictation key (`POST /api/voice/token`),
the voice agent's keys, the three diff routes and the session file routes, so a device revoked meanwhile gets 401
`device-revoked` and nothing the step produced.

**Logs and `redact()`.** Device lines carry the id, creator and counts, never the secret, hash, push key, code or
label. `redact()` masks `authorization`, `secret*`, `pushKey` and the value `Rarog-Device <…>` anywhere in text
(device secrets are created at pairing, so a static secret list does not know them).

**Lost phone runbook (device key).** Commands on the Mac or over SSH, in a shell outside the
agent sandbox (the CLI talks to the admin socket; `docs/distribution.md`, "The `rarog` command"):

1. Devices and tombstones: `rarog devices`.
2. Revoke one: `rarog devices revoke <deviceId>`. Effect at once: 401 `device-revoked`, SSE and console
   closed, APNs tokens and codes deleted. The same command revokes, with the same effects, every active device paired
   through it: with a code from it, from a device paired with its code, and so on (the `creator` chain, also through
   devices revoked or expired since; the tombstones on such a chain stay above the cap of 200). The command lists them with
   their pairing date; one of your own devices on that list pairs again with a code. The id of a device that is no
   longer active (it forgot the server or expired) revokes only what was paired through it. Forget Server in the app
   revokes only the device itself. `persist-failed` means the revocation holds until a restart: fix the disk and
   repeat the same command, which saves the revocation to disk (the command says the device was already revoked).
3. The ONLY phone lost: `rarog devices revoke --all`, then `rarog pair` for the new device.
4. Without Node:

       curl --unix-socket <dataDir>/run/admin.sock -X POST -d '{"id":"<deviceId>"}' http://admin/api/admin/devices/revoke

   `<dataDir>` is `--data-dir` or `RAROG_DATA_DIR`, otherwise `~/.local/share/rarog` (`docs/server-config.md`,
   "Data directory").

## Review demo server

A demo server for app review: `RAROG_DEMO=1` with `RAROG_DEMO_REVIEW_CODE` (settings and start-up checks:
`docs/server-config.md`, "Demo review mode"). It serves only fictional sessions and is meant to be reachable from the
internet, so its boundary is the credential and a closed route table, not the network (item 1 of "Layers").

**Who authenticates with what.**

- **Device key** (item 3 of "Layers"): the only credential that opens API routes. A reviewer's device gets one by
  pairing with the review code; the record is kept in `devices.json` in the explicit data directory.
- **Review code**: `POST /api/pair` with the value of `RAROG_DEMO_REVIEW_CODE`, compared in constant time. It does
  not expire, is not used up and revokes no other device; at 10 active devices it gets 429 `demo-review-full`. Any
  other code takes the normal path: 404 `pair-unknown` and the attempt limiter.
- **`Origin`** stays the CSRF gate for mutations, and `RAROG_ORIGINS` is exactly one `https` origin; any other
  entry, `null` included, refuses the start. It is no credential: no route opens to an allowed `Origin` alone.
- **No token or cookie**, as on every server: `Cookie` opens nothing (401).
- **Admin socket**: stays, so `rarog devices` and `rarog devices revoke` work on the demo host. Access to it is access
  to the host account.
- **`RAROG_AUTH_EPOCH`**: a new epoch and a restart revoke every reviewer device; a new code alone revokes nothing.

**Route classes.** Every request passes the route table `server/src/demo/review-routes.ts` after the credential gate
and before any route handler (`classifyReviewRoute` in `server/src/router.ts`). Without a key every path except
`/health`, `/api/pair` and `/api/login` is 401 first, as on any server.

- `allow`: the route works as in the plain demo, method and body checks included: `/health`, `/api/version`,
  `/api/pair`, `/api/devices` (also `/me` and `/forget`), `/api/stream`, `/api/notes`, `/api/client-log`,
  `/api/presence`, projects, resumable sessions, usage, `/api/mac`, `/api/models`, `/api/fs`, `/api/voice/token`,
  push registration (a no-op without APNs), `/api/sessions` and the 19 actions under `/api/sessions/:id/` (sub-paths
  such as `diff/files` or `uploads/:file` take the class of their action).
- `retired`: `/api/login`, the fixed 410 `login-retired`.
- `refuse`: `POST /api/pairings` → 403 `demo-review` (`demo.review-refused`). A paired device issues no code, so the
  number of reviewer devices depends only on the review code and its cap.
- `absent`: 404 `not-found`, the answer for an unknown path, for every path outside the table (default deny). This
  covers routes the router knows: `/api/demo/pairing` (the UI-test code of the plain demo, which revokes every
  device of its store), the terminal
  routes under `/api/term` (the terminal is off in every demo), the voice agent routes `/api/companion/*` and
  `/api/sessions/:id/companion/*` (`ask` and `turns`; no demo has them), `POST /api/fs/mkdir` (creating a
  directory starts a child process; the plain demo refuses it with 409) and `/api/admin/*` (served only on the admin
  socket).
  A route added to the router without a table entry does not exist in review mode.

The WebSocket upgrade does not pass through the router: with the terminal off the server closes the socket without an
HTTP response. `server/test/demo-review-routes.test.ts` keeps two static helper guards: it lists the routes from the
router source and every route group module in `server/src/routes/` (the router calls a group only after the
credential gate and the route class) and fails on a route without a class, a dead table entry or a match form it
does not recognize, and it fails on a new HTTP entry point (`request`, `upgrade` and related listeners,
`createServer`) in `server/src/index.ts`.
They see only the constructs they recognize; the default deny is what holds when they miss one.

**Host isolation.** A review-mode process starts no child process and, apart from its data directory, reads nothing
in the home directory of the account it runs under. In place of host reads it uses fixed values from the content set:
the server name in the pairing response instead of the host name, and the default model and effort of a new session
instead of `~/.claude/settings.json`. It does not assemble the hook probe (`/health` reports `hook: missing`), the
tailnet reader (no `tailscale status`, `tailnet: null`), the dictation stub (`voiceEnabled: false`,
`POST /api/voice/token` → 503) or the UI-test control M1 (`POST /api/demo/control` → 404). Usage and the directory browser
stay fictional, as in every demo. `server/test/demo-review-proces.test.ts` starts the real server with every child
process call and every file read under `HOME` recorded, sends a series of valid requests to allowed routes, and
fails on any record; the same series in the plain demo shows the reads of `~/.claude/settings.json`. The plain demo
does not read the host's tailnet or name either: it answers with the fixed tailnet of its content set and the fixed
server name `Mac`, and runs no `tailscale` (same test).

**Reviewer data on disk and restart.** At start the review-mode server deletes `client.log` and `client.log.1` in its
data directory: the diagnostics that reviewers' apps sent to `/api/client-log` before the restart. A missing file is
nothing to do. Any other error ends the start with exit code 1 and a line with the file name and the error code: a
server that cannot delete its own file cannot save a pairing either. The plain demo and a normal server keep both
files. A restart restores the seed sessions and drops notes, images and messages held in memory; `devices.json`
stays, so paired reviewer devices keep working until a new epoch or `rarog devices revoke` removes them.

**Plain demo keys stay out of `devices.json`.** The plain demo keeps its devices in `devices.demo.json`; review
mode and a server without demo read only `devices.json` (`docs/server-config.md`, "Data directory"). A key issued
by the unauthenticated `POST /api/demo/pairing` therefore opens nothing on those servers. The server cannot tell a
demo record that already sits in `devices.json` from a real one and keeps it: Rarog releases without
`devices.demo.json` wrote plain demo keys there. A data directory that ever served such a plain demo needs a review
on the first start of a server without demo or of a review server on it:

1. `rarog devices` (with `--data-dir` for a directory other than the default) lists the active devices over the
   admin socket: label, who issued the pairing code (the Mac or another device) and last use.
2. `rarog devices revoke <id>` revokes every entry that is not one of your devices, together with the devices
   paired through it.
3. Without a list you trust, a new `RAROG_AUTH_EPOCH` and a restart revoke every device at once, without the admin
   socket or the network ("Layers", item 3); your devices then pair again.

**Threat model.** An attacker from the internet can send any request to `/api/*` with forged headers. Without the
review code that yields `/health`, `/api/pair` attempts under the limiter and refusals. With a leaked code: up to 10
devices that read and write the fictional sessions the reviewer sees. All paired devices share one state, so
reviewers see each other's messages and devices (`GET /api/devices` lists every active record). A key holder can also
tie up process memory, because `POST /api/sessions/:id/messages` accepts up to 120 MB per request: a denial of service
with a key, not a data leak. Limits: the code goes only to the reviewer, rotation means a new code, a new epoch and a
restart, the cap of 10 devices, and the sessions are demo seeds driven by the mock driver.

## Native client: what is stored on the iPad

Directory layout of the per-server spaces: `native/Rarog/docs/app-target.md`, "Data on the device". The security properties:

- **The device key in the Keychain.** Two `kSecClassGenericPassword` items with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no iCloud sync, no backup to another device: (1) service
  `ai.rarog.app.server` in the app's PRIVATE group (`$(AppIdentifierPrefix)ai.rarog.app`) with `deviceId`, secret, the
  server's routes (HTTPS address, iroh EndpointId and relay, at least one of them), `serverId` and a copy of the push
  key, under the account `host[:port]` when there is an address, otherwise `iroh:<EndpointId>`; (2) service
  `ai.rarog.app.push` in a group SHARED with the notification extension (`$(AppIdentifierPrefix)ai.rarog.app.shared`)
  with the push key alone. A stored iroh pair that fails validation is read as absent with a line in `client.log`, so
  an item with an address keeps the device key and the push key; an item with no valid route is unreadable, and the
  app refuses to write one. The extension (`ai.rarog.app.notification-service`) has ONLY that group in its
  entitlements, so it does not see the device secret, and reads it only through the narrow `PushKeyReader`
  (entitlements guard: `server/test/product-identity-guard.test.ts`). The secret leaves the device only in the
  `Authorization` header (TLS, or the iroh connection) and never reaches logs; `client.log` gets at most `deviceId`.
  Over iroh the app's HTTP client talks plain HTTP/1.1 to its own proxy on `127.0.0.1` (a port from the system, one
  per generation and one per upload), which turns every accepted local TCP connection into a stream of the QUIC
  connection to the server and does not check who connected. So the `Authorization` header crosses that loopback hop
  in the clear; QUIC TLS encrypts it to the server key, and every request passes the server's credential gate as on TCP.
  The key disappears only after 401 `device-revoked` of THIS device (addressed by `deviceId`) and after Forget Server;
  other 401s keep it. A Keychain unreadable before the first unlock means "waiting", not "no key".
- **The iroh identity in the Keychain** (`IrohIdentityStore`, RarogTransport): a third item, service
  `ai.rarog.app.iroh`, account `device`, in the app's private group,
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no iCloud sync. It holds the secret key of the app's iroh
  endpoint (32 bytes) as JSON `{"version": 1, "secret": "<base64>", "createdAt": "<ISO 8601>"}`, one per device and
  independent of the server, so pairing again and Forget Server keep the app's EndpointId. The key is generated only
  when the item is missing and written before it is returned; the item is never rewritten. A locked Keychain, a
  refused read or write, or an unreadable item (another `version`, a secret that is not 32 bytes) make iroh
  unavailable with the reason, never a key kept only in memory or a new key over an existing item. Reads go through
  one actor, so concurrent first reads write once, and a writer that loses with `errSecDuplicateItem` reads the stored
  key. The endpoint publishes no address and does no lookup; it uses the relay of the current server and, for Pair,
  the relay `r` of the pairing link. Its EndpointId is the same toward every server and relay it reaches, so it
  identifies the device. A direct path to a server on the same network goes through the iOS Local Network permission
  (`NSLocalNetworkUsageDescription` in `Info.plist`).
- **The relay registry client** (`RelayAccess`, RarogTransport; the app builds one per process in
  `RelayAccessWiring.swift`). It reads the iroh identity at every start, so the identity item exists from the first
  start, also on a device that never reaches a server over iroh. Two more items in the service `ai.rarog.app.iroh`,
  with the identity item's group and attributes and no secret: `relay-access`, a cache of the app's registry entry (the
  app's EndpointId, the registry origin, the entry's expiry, the last sync, the sponsored servers' EndpointIds with
  their expiry, a failure counter, the next attempt and the last problem), and `relay-optout`, the record of Remove Me
  from the Registry (the app's EndpointId, the registry, the time and whether the registry confirmed it). The app
  talks to a registry only for a server whose relay has one (`RelayAuthWire.registries`; a user's own relay has
  none): before pairing over iroh (register the app, sponsor the link's server, at most 8 s before `POST /api/pair`),
  and when a sync is due on cold start, a return to the foreground, the identity becoming readable or a new server
  list (at most every 6 h while the entry and the sponsorships are live), after a failed iroh attempt (at most every
  10 min), and on Remove Me from the Registry. After a failure the next attempt waits (from 1 min doubling up to 6 h
  without an answer, 1 h or 24 h after a refusal). A request carries the app's EndpointId, the sponsored server
  EndpointIds, the time, a signature with the app's iroh key and the header
  `x-rarog-relay-client: rarog-app/<version>+<build>`; `register` also carries a fresh DeviceCheck token, which the
  registry checks with Apple and does not store.
  The registry never blocks the app: a failure, a refusal or a relay without a registry is a status on the Server
  screen, and HTTPS and iroh connections go on as before. `client.log` gets one line per process with the app's full
  EndpointId (`relay-access: app <EndpointId>`), and its other `relay-access:` lines carry no token, signature or
  request body.
- **Pairing never swaps the server silently.** A pairing link from a QR code (camera only after a tap), from paste or
  opened by the system always ends in a confirmation card naming the server, and nothing goes out without Pair (or
  Replace, below). The link carries the HTTPS address `u`, the server's iroh EndpointId `k` with its relay `r`, or
  both; `u` and `r` must be `https` (exception for `u`: the loopback demo server of UI tests), and `k` comes only with
  `r`. A link with `k` pairs over iroh, also when it has `u`: one connection to `k` through `r`, which proves the
  server key and closes as soon as `POST /api/pair` returns. The card names the `u` host, or, when there is no `u`,
  `iroh · ` with the first 8 characters of `k` and the full EndpointId below. A link with `k` also shows the server
  key fingerprint, the first 16 characters of `k` in groups of 4; it only informs, because the check is the
  comparison of full keys. The app keeps one server, so a link to another server than the paired one pairs only after
  Replace: another `k`, a `k` while the paired server has no iroh key (nothing to compare), or, for a link without
  `k`, another `u` origin. Its card warns that pairing swaps the paired server and names it, with Cancel first as the
  default action; Pair is not there. A device with no pairing (first pairing, or revoked) has no key to compare the
  link with, so its card has no warning. After pairing the server's iroh route comes from the server (the pairing
  reply, then `GET /api/version`); a server reachable only over iroh can change only its relay, because another
  EndpointId is another server (`distribution.md`, "Pairing from the app"). A code for a new device shows as a QR
  with a countdown and leaves the screen when Settings closes.
- **Per-server data in separate spaces** (`Application Support/servers/<space>/`). The app reads and writes ONLY the
  space named by the pointer `servers/.current.json`, written atomically BEFORE every `rename`, so server isolation
  does not depend on deletion succeeding. Another server identity (the address after `ServerOrigin` normalization, or
  the EndpointId of a server reachable only over iroh) means a new space; pairing again over iroh to the same `k` with
  the same `serverId` keeps the space, because the connection proves the server key. Otherwise a new space, and the
  previous one moves to `servers-trash/`, emptied in the background and at every start. After Replace the new key
  never opens the space of the pairing it swaps, also under the same address: a fresh space goes on the pointer before
  the key goes to the Keychain, so the other server never gets the outbox and drafts. A Keychain refusal writes the
  previous pointer back, so the paired key keeps its data; a disk that refuses that write, or a process killed before
  the Keychain write, leaves the paired key with the empty space and the previous data in the trash. A disk that
  refuses the fresh pointer ends the pairing. A device without a key (for
  example revoked on the server) keeps the pointer and has nothing to compare: pairing with the pointer's address enters
  the space waiting there, because a pointer by address does not know the server key. Server-dependent preferences
  (project paths, session ids) are cleared on entering a new space (marker `rarog.server.preferences-space`, checked
  at every choice, also after the process was killed).
- **Forget Server** first invalidates the server's data on disk, before anything deletes the key; a disk that allows
  none of these steps stops Forget before the request. So a process killed at any moment leaves no readable data of
  this server. Then `POST /api/devices/forget` (best effort, at most 15 s, the budget of one tunnel attempt, so a
  tunnel still connecting after a return from the background gets through) and locally both Keychain items, the APNs
  token, the Live Activity, the space and unsent attachments. Without a network Forget revokes nothing on the server:
  the key leaves only the device, and its record stays active until it expires after 30 days without use, or until
  `rarog devices revoke <deviceId>` on the Mac (the lost phone runbook above). The previous key after pairing with
  another one is revoked the same way, in the background.
- **No token and no cookie on the device.** The HTTP client has no cookie store and ignores `Set-Cookie`. Mutations
  carry `Origin` and pass one client gate (`MutationGate`); the boundary stays the server rules. `Origin` is not
  secret (the app sets it from `RarogConfig`, as any non-browser client can), so the `Origin` gate stops only a
  request a browser sends from a foreign page; the device key protects against the rest.
- **Outbox, drafts and note drafts** keep unsent text and attachment content until the echo or a confirmed write,
  with class `completeUntilFirstUserAuthentication` and `isExcludedFromBackup` on `servers/`. Working files in the
  app's temporary directory: `rarog-attachments/` (copies of attachments from the bar above the field, cleared on
  first use in a process) and `rarog-send-*.json` (a request body for one send, deleted after it, also after an
  error; at start the app removes any such file a killed process left). An image preview writes a file to
  `tmp/rarog-preview/` with class `complete` and deletes it on close, and thumbnails live only in process memory
  (`NSCache`, up to 120 items).
- **Preferences** in `UserDefaults` hold paths, session ids, flags and dates, zero conversation content:
  `rarog.projectTabs`, `rarog.projectHistory`, `rarog.listCollapsed`, `rarog.newSession`,
  `rarog.transcript.lastSeen`, `rarog.collapsedProjects`, `rarog.pinnedProjects`, `rarog.sessionHistory`,
  `rarog.inspectorOpen`, `rarog.inspectorChangesCollapsed`, `rarog.push.snoozedUntil`, the pairing state
  `rarog.server.revoked`, `rarog.devices.known.<serverId>` and `rarog.devices.notices.<serverId>` (Forget Server
  removes both for the forgotten server), and the dictation choice `rarog.dictation.choice`.
- **Dictation:** no Soniox secret on the device: the app gets only a TEMPORARY Soniox key per connection attempt.
  The dictation choice (`system` or `soniox`) belongs to the device, so another server, logout and Forget Server
  leave it. The microphone works only between two taps (or ⌥⌘M) and stops on going to the background and on a
  session change.
- **List cache** (`<space>/list/sessions.json`): the last FRESH session list (project, directory, session label,
  state and its time, branch, counters and last commit, model). Before writing, these are removed: the standing
  decision summary (`waitingFor`), the recognized dialog with its screen excerpt, transient activity, state detail,
  the turn summary, background task descriptions and commands, and the session's whole artifact, pull request and
  scheduled task lists (a scheduled task's prompt is text the session runs at a set time). The file is
  valid 24 h, holds at most 2 MB, has class `completeUntilFirstUserAuthentication` and is outside backup; a 401
  deletes it. The cached list is read only: no card actions, and mutations wait in the gate for a fresh state (closing
  a session needs only a fresh list).
- **Transcript content is not stored on the device**: it comes from the server on entering a session.
- **Console.** Console content reaches no log, disk or cache (a guard in `SourceGuardTests`), and the clipboard only
  by a gesture (Copy, Cmd+C, Copy All): OSC 52 from a shell program does not touch the clipboard, and OSC 7 is
  ignored (`SwiftTermSurface`).
- **The app switcher snapshot** shows the last screen, a transcript or console too: the app does not cover it when
  going to the background. On purpose.

## npm package publishing channel

The npm package `@rarog/server` lands on every machine that installs it, so the publishing channel is a boundary:
whoever can release a version runs code at every user of the package. The workflow and the tarball audit:
`docs/publishing.md`, "Publishing the npm package".

**Boundary.** A version becomes installable only after `npm stage approve` with the package owner's 2FA; until then
it is staged and `npm i @rarog/server` does not get it. One path leads to staged: the `publish` job of
`.github/workflows/publish.yml` in the public repo, the only one with `id-token: write`, in the `npm` environment. The
package's trusted publisher accepts an OIDC token only from that workflow file, repo and environment, and only for
`npm stage publish`. The package has "Require two-factor authentication and disallow tokens", so no npm token
publishes it, and the workflow has no secrets. The `npm` environment admits only `v*` tags and has no required
reviewer: whoever can start the workflow on such a tag gets a version to staged, and the only human approval on the
path is `npm stage approve`.

**Blocked:**

- **Taking over the public repo or the GitHub account** gives at most a staged version and cannot publish a different
  tarball unnoticed. Before approval, the staged tarball (`npm stage download`) must have the sha256 that the `build`
  job reported for the release run, and its files must match, file by file (`scripts/package-audit.mjs
  --files-only`), a tarball that the owner's release tooling built on the owner's machine from the export tree that
  passed the release gate, building and running nothing fetched from GitHub. The sha256 ties the staged version to
  that run; the file comparison stops content that differs from the tested sources. On any mismatch nothing is
  approved, and the version is rejected (`npm stage reject`).
- **Taking over the npm account without the 2FA device** gives at most a staged version (`npm stage publish` does not
  ask for 2FA; `npm stage approve` and `npm publish` do), so the approval step ends the owner's npm session with
  `npm logout` on every exit, after a refusal or an interruption too.
- **Swapping the tarball between workflow jobs:** `sbom-ubuntu`, `sbom-macos` and `publish` check the artifact's
  sha256 against the output of the `build` job that built and audited it.
- **Injection through workflow inputs:** version and name reach scripts through environment variables, never through
  `${{ }}` in script text; the version must be X.Y.Z or X.Y.Z-beta.N, the name has one allowed value
  (`@rarog/server`, any other is refused), and publishing starts only from a `v<version>` tag.

**Beta versions** take the same path and the same approval as stable ones. The `build` job derives the dist-tag from
the version, and `publish` takes it only from that job's output and accepts only `beta` or `latest`: a beta goes out
with `--tag beta`, a stable version without `--tag`, so npm tags it `latest` and refuses a version lower than the
current `latest`. A plain `npm i @rarog/server` resolves `latest` and does not install a beta.

**The SBOM is a record, not a gate of the boundary.** `publish` waits for `sbom-ubuntu` only. A red `sbom-macos`
(for example, a macOS-only difference in the installed dependencies) marks the run red and does not keep the version
from staged; its SBOM artifact is missing then.

**`rarog update` installs only a release of this workflow.** An installed version updates itself only to one tarball
that npm downloaded and the update checked: its sha512 equals the registry's `dist.integrity`, npm's own signature
check (`npm audit signatures`) finds nothing invalid or missing, and the update itself checks the version's SLSA
provenance: Sigstore's certificate authority, pinned in the code, issued its signing certificate, that certificate's
key signed the statement, the certificate names `.github/workflows/publish.yml` of `useo-pl/rarog` at the tag
`v<version>`, and the statement names this file. npm's list of verified attestations only carries the provenance; it
is not the proof, because a registry can write that list. npm then installs exactly that file
(`docs/server-config.md`, "`rarog update`"). Whoever takes over the npm account or a token and publishes a version
outside the workflow, without provenance or with provenance from another repo, workflow or tag, gets no update of an
existing installation: the update stops before any install and names what does not match. The check needs npm 11.12 or
newer and npm's sigstore host (`tuf-repo-cdn.sigstore.dev`); without them the update stops without installing. The
update does not read the transparency log or compare the certificate's validity with a clock (npm does), and it does
not read the certificate's OIDC issuer. A new Sigstore certificate authority stops every update until a version that
pins it is installed by hand; that refusal says the certificate can be a new Sigstore certificate or a forged
attestation and points to the releases page of the repository, with no install command. The first install
(`npm i -g @rarog/server`) and the command the app shows (`npm i -g @rarog/server@latest && rarog update`) trust
the registry, because their `npm i -g` installs before any check; such a version is checked by hand
(`SECURITY.md`, "Releases"). Outside the tarball the package depends only on `@number0/iroh` and its platform
packages, at exact versions; it carries no `npm-shrinkwrap.json`, because npm 11.19 does not read one from a tarball
installed as a file.

**Not blocked:** malicious code in the sources themselves (the comparison catches only content different from the
sources; source code goes through review); a malicious dependency version that got into the lockfile (the tarball's
dependencies come from the lockfile with `integrity`, iroh is pinned); a bad version reaching a user without a
package age gate right after approval (a version older than 72 hours cannot be removed; the response is
`npm deprecate @rarog/server@<version> "<reason>"` and a fix version). Provenance is no boundary of publishing: a
version without it takes the same path through human approval. It is the boundary of `rarog update` (above).

## Hook copy written by the update

Claude Code runs the hook copy in `~/.claude/hooks/rarog/` outside the sandbox. Every path that writes the copy first
computes its diff against the installation and then writes only the buffers that diff shows. `rarog setup`, `rarog
hooks install` and `rarog update --finish` started by hand ask `[y/N]` after the diff; without a terminal they write
nothing.

One path writes without the question: `rarog update --finish` of the version that the same update run has just
installed. `rarog update` writes `installed.version` and `installed.root` into the update lock after its
`npm i -g --ignore-scripts` and starts the new version's finish with the lock token. Only when `installed.root` is the
finishing installation and `installed.version` its version does the finish write the copy, with the diff in the run
log. A finish by hand, an inherited lock without `installed`, and `installed` naming another root keep the question.
`server/test/hook-granica-guard.test.ts` (rule 4) fails when anything else sets the field that skips the question;
`server/test/rarog-update.test.ts` checks the behaviour.

This does not widen the boundary. The copy's source is the package directory, which an agent in the sandbox can
write under nvm or pnpm in the home directory ("Pairing and device keys", "Guarantee boundary"). Whoever writes there
also replaces the server code the service runs outside the sandbox, so a question before the copy does not stop
them; after an install it only asks a person to read bytes they have just asked npm for. Where no install has just
happened, the question stays, so a package directory changed between updates still waits for a person. The rest
holds on this path too: the copy's directory is protected by Claude Code, a copy changed after its install is not
overwritten (the doctor's warning instead), and no copy is written next to a service that starts another
installation.

## Emergency runbook

**Lost or stolen phone** (goal: cut off within 60 s). One device is revoked from the admin socket without a restart
(`rarog devices revoke <id>`; runbook in "Pairing and device keys"), together with every device paired through it,
so a code issued on the lost phone leaves no device behind; this also kills the device's voice agent questions in
flight and their `claude -p` processes, and the device gets no new short-lived OpenAI key or Soniox speech key (one
already issued expires within 60 s and 600 s). The steps below cut everyone off:

1. Increment `RAROG_AUTH_EPOCH` in the server config (`env` in `~/.config/rarog/config.json`) and run
   `rarog restart`: all paired devices are revoked. This needs no network and no admin socket. The launchd service
   `ai.rarog.server` keeps the server up: `rarog restart` stops it and starts it with `launchctl kickstart`,
   `KeepAlive` brings a `pkill`ed server back within 10 s, and only `rarog service uninstall` (`bootout` and plist
   removal) stops it for good.
2. Remove the device from the private network (the VPN admin panel): this cuts the network channel.
3. In an emergency, without a restart (the `STOP_PATTERNS` of `scripts/restart.sh`: the tsx parent and its child,
   also under `rarog serve`):

       pkill -f 'cli.mjs server/src/index.ts'; pkill -f 'loader.mjs server/src/index.ts'

   A server from the npm package
   (`node server/src/index.js`, a pattern other projects' servers match too) is stopped by port:
   `kill $(lsof -nP -iTCP:8930 -sTCP:LISTEN -t)`. Under launchd this buys only 10 s (step 1).
4. **Killswitches, each set to `0` in `env`, then a restart:**
   - `RAROG_HERDR_SEND=0`: nothing goes to live panes (prompt, `ctrl+c`, `escape`, digits), and creation, closing and
     labels stop too, because those methods are in `MUTATING_METHODS`; reads stay. `RAROG_HERDR_LAUNCH=0` creates no
     panes (the DEFAULT). Viewing stays in both cases.
   - `RAROG_TERM=0` turns off the emergency console. The two above block CREATING a console (409) but do not push the
     keyboard out of an open one; to finish off the shells, close the `rarog-term` panes in herdr (or restart the
     herdr server, which kills pane processes; the panes come back with a bare shell and recover their token).
   - `RAROG_PUSH=0` stops notifications and Live Activity updates (the Live Activity shows stale data after 15 minutes;
     the app ends it after `apnsEnabled: false`, the system after 8 h at most). After a THEFT it is not urgent (a push
     carries no credential and approves nothing); for a LOST phone it keeps project content off a stranger's lock
     screen. More precise: `rm <dataDir>/apns-devices.json`
     and a restart removes the tokens of ALL devices, Live Activity tokens included; healthy devices register again at
     the next app start.
   - `RAROG_COMPANION=0` (the default) turns the voice agent routes off: 503 `companion-disabled`, and the speech key
     route 503 `companion-speech-unconfigured`. It removes the stolen key's way to ask Sonnet about sessions, to read
     the last turns of sessions, to get short-lived OpenAI keys and to get temporary Soniox speech keys, and it is the
     kill switch of the voice agent's prompts: a message whose body carries `source` and `expectedConversation` gets
     the same 503, and so does the voice agent's pick-up of a result (a `seen` body with `by`).
     `RAROG_COMPANION_SESSIONS=0` (the default) turns off only the mode across sessions: the turns route, the session
     catalog, those messages and those pick-ups (503 `companion-sessions-disabled`). The restart that applies
     either flag also drops the voice agent's prompts still waiting in the paste queue: nothing of them is pasted,
     and `server.log` gets `prompt-queue: <n> voice agent message(s) not sent: the voice agent's sends are off`.
     A prompt already pasted stays in the pane's field. Neither flag stops a stolen key from sending an unmarked
     prompt; `RAROG_HERDR_SEND=0` does.
   - `RAROG_PR_STATUS=0` stops the calls to GitHub through `gh` (not a killswitch: a stolen key gets no power from
     them, only the state of PRs the sessions already list). Use it when `gh` misbehaves or the GitHub account must
     not be used; `gh auth logout` stops the calls without a restart.
   - `RAROG_NOTES=0`: `/api/notes` returns 404, so project notes leave the stolen key's reach. It deletes no files;
     `rm -rf <dataDir>/notes/` does, and that is IRREVERSIBLE.
   - **Repositories:** there is no git switch, because Rarog only reads git; `git switch`/`pull`/`push` from the iPad
     go only through the console, so `RAROG_TERM=0` cuts them off. Commits pushed before the cut stay on the remote.
5. **Review `<dataDir>/herdr-audit.log` from the time of the theft**, the only source of what really went to a
   `claude` PANE (console tabs are only in `server.log`: `term: new tab/workspace …`, `term: close …`). Look for
   `launch` (`cwd`, full `argv`, `paneId`, `tabId`), `approve` with `toolName` and `optionLabel` (what was
   APPROVED), `close_tab`, `prompt` (sha256 of the whole text and the first 200 characters; the voice agent's prompts
   carry `"sender":"voice-agent"`, so `grep '"sender":"voice-agent"'` lists them) and `restart` (next to its parts:
   `prompt` with `/exit`, `launch` with `--resume`, possibly `close_tab`, `send_keys` and `prompt`).
   **The exception, to be read literally: emergency console content CANNOT be reconstructed from ANY log.** The
   console records neither input nor output, anywhere; `server.log` shows only the LIFECYCLE (which directory opened,
   `term: open <id> … cwd=…`, socket attach and detach, PTY start, fall and kill). What was TYPED is not known and
   will not be. The trade is deliberate: a full shell that does not eavesdrop on its user's secrets. Whoever needs
   "what was done" has `RAROG_TERM=0`, not a content log.

**Anthropic auth renewal:** Rarog keeps no Anthropic token. Panes log in with the `/login` credentials, and
`CLAUDE_CODE_OAUTH_TOKEN` is cleared in them (rule 12 of "Starting sessions from the phone"); an expiry shows as a pane
asking to log in, renewed with `claude /login` on the Mac. There is no daily smoke query:
`curl -s localhost:8930/health` on the Mac says Rarog's process is alive, plus two readiness booleans (`herdr`, a
socket ping valid for 2 s so the endpoint without a key is no cheap connect to the daemon; `term`, the console
assembled) and the hook channel state (`hook` = `ok`/`missing`/`mismatch` from the entries in `~/.claude/settings.json`, or `stale` when
the hook copy differs from the repo: configuration, not activity). The age of the last hook firing (`hookSeenAgo`, per
copy input file `hookSeenAgoByFile`) goes only behind the credential gate in `GET /api/version`: `hook-seen.json` is
written on EVERY dialog in every Claude session under Rarog's roots, so with 1 s resolution and a 5 s cache a caller
without a key could build a profile of when and how often this person approves tools. Even for the loopback caller
`/health` carries only values CONSTANT between restarts plus `uptime`, and no session names, directories or content.
The fields go only to a TCP request whose `Host` is `127.0.0.1:<port>` or `localhost:<port>` for the server's own
port and which carries no proxy header (`X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`, `X-Real-IP`, any
`Tailscale-*`). A tailnet peer, an iroh client, a web page that points its own name at the Mac (DNS rebinding) and a
request through a proxy get only `{"ok":true}`, and no probe runs for them. The remainder: a proxy that rewrites `Host`
to the loopback address and adds none of these headers gets the fields.

**`GET /api/usage` touches neither the Claude account credentials nor the network.** Plan limits come ONLY from the
freshest status bar dump in `~/.claude/statusline/` left by the user's `statusLine` script (`server/src/usage.ts` over
`readFreshestRateLimits` in `server/src/herdr/statusline.ts`). Rarog reads no token from the Keychain or the CLI
credentials file, runs no `security` and calls no Anthropic API: Anthropic's rules for third party tools forbid
collecting, storing and proxying claude.ai credentials (https://code.claude.com/docs/en/legal-and-compliance).
`server/test/usage.test.ts` fails on any attempt (`fetch` and `node:child_process` are fakes). No dump with a live
window is 503 `usage-unavailable`. From the dump Rarog takes ONLY `rate_limits`, the modification time and
`cost.total_api_duration_ms`. The last one only goes into a fingerprint in server memory that tells an API call from
a redraw, never into a response; paths, session names and costs stay on the Mac. **What reaches the phone:** usage
percentages of the 5 h window and the week, reset dates, `source: 'cli'`, the time the dump's numbers last changed
(`fetchedAt`), `stale: true` after 15 minutes and **the account e-mail** (from
`oauthAccount.emailAddress` in `~/.claude.json`, rule 10 of "Starting sessions from the phone"). The e-mail is there
on purpose: limits are counted for the account Claude Code is logged into ON THE MAC, and without it the numbers are
true and unverifiable at once. The dump carries no account, so after an account change the e-mail stands next to the
previous account's percentages until a session leaves a new dump, and a session logged in another way (for example a
token from env) can leave the freshest dump of another account for good. Whoever does not want the e-mail on the phone
removes the read, not a field in the client. **`GET /api/usage/details`** has the same shape without `source`, plus
the per-model week with the model name, read per rule 10; a reading of another account than `oauthAccount` gives
`{}`. Behind the credential gate (401); another method → 405.

**Forget a console pane:** the pane from Rarog should become an ordinary pane of the person without closing the
shell. Rarog recognizes the pane by TWO marks and both must go (from the label alone recovery restores the token, from
the token alone migration adds the label back):

    herdr pane rename <pane> --clear
    herdr pane report-metadata <pane> --source rarog-term --clear-token rarog-term

Then `rarog restart`. The pane address goes BEFORE the options (measured on herdr 0.9.3: with `--clear <pane>` the
CLI takes `--clear` as the address). Check: `herdr pane list` shows the pane without `label` and `rarog-term` token,
and `server.log` after the restart has neither `recovered token` nor `migration` for that address. The
`RAROG_TEST_HERDR=1` block in `server/test/term-integration.test.ts` runs the same sequence.

**Tab name set by Rarog:** a herdr tab got a name from Rarog you do not want (a Claude card label or
`rarog <slot> · <directory>`). Rarog does not overwrite a manual label, so for ONE tab give it your own:
`herdr tab rename <tab> "<name>"` (a Claude pane label then leads with that name after the next card label change
or `rarog restart`).
To stop Rarog naming tabs after creation: `"RAROG_HERDR_TAB_LABELS": "0"` in `env`
in `config.json` and `rarog restart`; labels set at creation stay. This is a PREFERENCE, not a killswitch:
`RAROG_HERDR_SEND=0` turns off both renames independently. Rarog does not undo labels it set.

**Turning off the iroh listener** depends on whether the installation also has an HTTPS path. The server needs at
least one access path: outside demo mode it refuses to start without `RAROG_ORIGINS` (the HTTPS path through the
reverse proxy) unless iroh is on. With `RAROG_ORIGINS` (a reverse proxy in the private network),
`"RAROG_IROH": "0"` in `env` in `~/.config/rarog/config.json` and `rarog restart` suffice: the UDP port
disappears and the native module does not load. Without `RAROG_ORIGINS` (access only over iroh) the server does not
start after `RAROG_IROH=0`, so either restore `RAROG_ORIGINS` and the reverse proxy together, or stop
the service for good (`rarog service uninstall`). A suspected theft of the iroh key: "Layer 1b", the
point about the server key.

**Mac reboot:** with FileVault and no auto-login, the Mac is unreachable after a reboot until someone logs in, the
deliberate price of an encrypted disk. After login the launchd service `ai.rarog.server` (`RunAtLoad` + `KeepAlive`,
domain `gui/$UID`) starts Rarog, and a fallen process returns within 10 s. `rarog service install` creates the server
log `<dataDir>/server.log` with mode 0600 before launchd or systemd opens it and sets an existing log to 0600; the
supervisor appends to it and keeps the mode, and the server process umask stays as it is. "Silence = ok" stays
open on purpose: there is no watchdog outside the Mac, and an alarm would not shorten the outage. The app shows the
outage as a server-not-responding banner.

**Lost Mac** (theft, fire, dead disk): the Mac is the ONLY server machine, so everything `git clone` cannot recreate
must exist elsewhere. Restore order:

1. **The Mac configuration repo and, for a clone install, the clone of the Rarog repo**, the former with
   `~/.claude/settings.json` (the herdr hook, the `disableRemoteControl` flag) and the `statusLine` script (without
   it there are no plan limits). A local `main` without a push is no archive.
2. **Server secrets** (`SONIOX_API_KEY`, `OPENAI_API_KEY`, the APNs key entries `RAROG_APNS_*`, and with the iroh
   listener `RAROG_IROH_KEY`; a lost APNs key file is issued again in the Apple portal, "Push notifications"; a lost
   iroh key means a new EndpointId, "Layer 1b"). On the new machine, recreate the way the service fetches them
   (`service.wrapper` in `config.json`); without it the wrapper ends BEFORE `rarog serve`.
3. **Rarog itself:** `npm i -g @rarog/server`, with no extra steps. In a clone, run `pnpm install` instead; there the
   commands of step 4 run as `node bin/rarog.mjs <command>` until `service install` links `rarog` into `~/.local/bin`.
4. **`~/.config/rarog/config.json`**, then **`rarog service install`** (in a person's terminal, because
   the pre-install check calls the wrapper), then `rarog hooks install` (in your own terminal outside the
   sandbox): after the copy it shows the diff of `~/.claude/settings.json` and writes the hook entries after "y".
5. **`claude /login`** on the new machine; the CLI login and private network access are recreated by logging in, not
   backed up. SSH keys are worth a second medium but are replaceable.

Rarog's state on disk (`<dataDir>`) fits in a few megabytes. Session aliases and APNs tokens recreate themselves, and
the logs are traces, not state. Without a copy, project notes (`<dataDir>/notes/`) are lost, and without
`devices.json` every device pairs again. A disk backup (for example Time Machine) covers the data directory unless
excluded, and with it `devices.json` with push keys in the clear, so such a backup is protected like the disk itself.