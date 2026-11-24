# rarog-relay-auth — iroh relay device registry

A Cloudflare Worker with Durable Objects that keeps the registry of iroh keys the Rarog iroh relay admits
(`relay-vps/`, the relay on a VPS). An iroh key is an EndpointId, the public key of an iroh endpoint (64 hex
characters). The app registers its own EndpointId with proof from Apple and sponsors the EndpointIds of its servers.
The relay asks the Worker through the access hook `POST /v1/access` whether to admit a client. Without `ENFORCE=1`
the Worker runs in shadow mode: the hook answers `true` to everyone and only logs the decision it would make.

## How it works

- **App entry.** `register` carries a signature by the app's iroh key and a proof for the gate, the Apple check
  every new entry passes: DeviceCheck (the device token from `DCDevice`) or a test APNs push (the APNs device token).
  An app entry lives 90 days from the app's last `register`, `renew` or `sponsor`.
- **Sponsorship.** `sponsor` records the EndpointId of one of the app's iroh servers for 90 days. A server entry
  lives while at least one sponsorship lives. `renew` with a list of servers extends the app entry and the
  sponsorships on the list; a sponsorship off the list expires on its own.
- **Entry kind** (app or server) is set by the first write and holds while the entry lives: a server's EndpointId
  cannot register as an app (409 `kind-conflict`), and an app cannot be sponsored.
- **Hook.** A live app entry without an admin denial is an allow, and so is a live server entry without one that has
  at least one sponsoring app without a denial; anything else is a deny.
- **Admin denial** (`/v1/admin/deny`) lasts a year regardless of the entry's term and blocks the hook and the app
  routes for that EndpointId (403 `denied`); `/v1/admin/allow` lifts it. Denying an app also removes its entry and
  drops its sponsorships, as `forget` does; after `allow` the app registers again. A sponsorship the app recreates
  while the denial reaches KV (a `register` or `sponsor` in flight, a stale read) does not admit the server either,
  because the hook checks the sponsors' denials. A denied server keeps its entry, and the denial alone blocks it.

## The `/v1/*` contract

One definition: `shared/src/relay-auth.ts` (the Worker imports it by relative path), its Swift mirror
`RelayAuthWire` in `RarogContract`, and the cases and signature vectors in `shared/fixtures/relay-auth/manifest.json`.
Routes, fields, the Ed25519 signing text, response bodies and error codes: `docs/implementation-spec.md`,
"iroh relay registry"; the status of each error code: `RELAY_AUTH_ERROR_STATUS`. Every response is JSON with `v: 1`
and `cache-control: no-store`; the hook answers in plain text. Responses worth knowing per route:

- **`register`**: 400 `gate-mismatch` when the proof's kind differs from the gate (the body carries `gate`), 422
  `proof-rejected`, 429 `limited` or `quota-exceeded`, 502 `gate-unreachable`, 503 `unavailable`.
- **`renew`** and **`sponsor`**: 404 `not-registered` means "register again". `renew` lists in `unsponsored` the
  servers without a live sponsorship of the app and those whose entry refused the extension (an app entry, a server
  at its cap of 32), so the app calls `sponsor` for them. `sponsor` answers 403 `denied` also for
  a denied server, 409 `kind-conflict` when the server is an app, and 429 `quota-exceeded`.
- **`forget`**: 200 also without an entry; it drops the app's sponsorships.
- **`/v1/admin/deny`** and **`allow`** (bearer `ADMIN_SECRET`): 401 `unauthorized` for a wrong bearer, 503 without
  the secret. `deny` answers 500 when dropping a denied app's sponsorships fails; the denial is already stored, and
  repeating `deny` finishes the drops.
- **`GET /v1/health`**: `ok: true` when the Worker accepts registrations, that is a gate is set and the
  configuration has no defect. Without a gate the body says `ok: false` and `gate: null`, with no `config` log line.
  `ok` reflects only the configuration: a full `Gate` queue still answers 503 while `ok` stays `true`.
- **`POST /v1/access`** (bearer `RELAY_HOOK_SECRET`, no body): the decision is 200 `true` or 403 `false`. Other
  responses are not a decision, and the adapter on the VPS admits the client on them: 400 (bad `X-Iroh-Endpoint-Id`
  header), 401, 500 (storage did not answer while enforcing), 503 (no secret or a short one).
- **Outside the contract**: 404 `not-found` for an unknown path, 405 `method-not-allowed` with an `allow` header for
  a wrong method, 500 `internal` for an exception in the Worker (the log line carries no exception text).

Order of checks on the app routes: `Content-Type: application/json` and `X-Rarog-Relay-Client` before reading the
body, a 16 KiB body cap, a limit per client address (`RL_APP`, plus `RL_REGISTER` for `register`), body shape,
configuration, `issuedAt` within ±300 s, signature, admin denial, and only then Durable Objects. A flood of unsigned
requests costs Worker invocations, not Durable Objects or Apple calls. The admin routes check the bearer before the
body; the hook checks the bearer before the EndpointId. When the Rate Limiting counter fails, `register` answers 429
and the other routes let the request through.

## Quotas, terms and idempotency

- **Device quota** (`REGISTER_MONTHLY_QUOTA`, 1–3): new app EndpointIds per device. DeviceCheck keeps it in the
  device's two bits at Apple, a 0–3 counter per calendar month (the month comes from Apple's `last_update_time`;
  bits from another month count as zero). APNs keeps a counter per SHA-256 hash of the device token over 30 days in
  the gate's storage, without the token. The DeviceCheck bits stay at Apple when the registry loses its data, so
  after such a loss devices may find their bits already spent; until `QUOTA_GRACE_UNTIL` exhausted bits do not block
  a registration.
- **Daily brake** (`REGISTER_DAILY_BRAKE`): new registrations per UTC day, one counter per gate; above it 429
  `limited`.
- **Sponsorship quotas**: `SPONSOR_QUOTA` new sponsorships per app in 30 days and `SPONSORED_LIVE_MAX` live at once
  (429 `quota-exceeded`); a server accepts at most 32 sponsorships.
- **Registration idempotency.** `register` on a live entry extends it in one entry operation, without Apple or quota.
  Otherwise the gate checks the brake, the device quota and Apple, then writes the brake, the APNs counter and an
  admission in one atomic write (`Admission`: a random id with a 10-minute term), and only then the entry is created.
  The entry accepts the admission only within its term, stores it with a new incarnation (`epoch`, a fresh id for
  every new app entry) and remembers it as spent until the term ends, also after `forget`. A retry within 10 min
  after an entry failure registers without a second charge or Apple call and creates no second incarnation, even
  when the first response got lost. A registration after `forget` pays like any new one.
- **Sponsorship idempotency.** `sponsor` runs in three steps: a claim at the app (a reservation keyed by
  `(app, server)` with a 10-minute term and a sponsorship id, `ticket`), a write at the server, and a commit at the
  app. A retry after a failure at any step hits the same reservation or the live sponsorship, so a failure costs at
  most one quota unit and never yields a free sponsorship. Before an attempt goes to the server, the app stores the
  sponsorship term the attempt will write there (90 days from the attempt): a live sponsorship is extended, and
  a reservation raises its claim term (`term`) and lives a fresh 10 min (`expiresAt`) from that attempt. The commit
  passes only while the claim is alive and gives the sponsorship the furthest `term` handed to any attempt. After the
  reservation's 10 min `sponsor` ends with 404 `not-registered`. A server refusal
  (`kind-conflict`, the sponsorship cap) returns the quota unit only when the server refused every attempt with this
  reservation. A reservation nobody committed turns into a drop record (`Drop`: a pending drop of the sponsorship at
  the server, which the app entry's alarm runs) at the entry's first write after its term, whatever operation it is.
- **Sponsorship invariant.** A claim is a durable record in the app's object that its incarnation may hold at the
  server a sponsorship with a given `ticket` and a term up to the claim's: a reservation or a sponsorship, at most
  one per server. App–server consistency rests on four rules, which the model-based test (`test/model.test.ts`)
  checks after every step of random interleavings with failures:
  1. Every write at the server follows a durable claim with the same `ticket` and a term no shorter than the one
     written (`sponsor` and `renew` store an extension at the app before the server). A claim's term never
     decreases, and the server never shortens a sponsorship with the same `ticket`.
  2. A claim leaves the app only through a commit (the reservation becomes a sponsorship), through a drop record
     (`forget`, reservation expiry, end of the entry, also with a live sponsorship) or when its term passes, which
     no write at the server exceeds.
  3. Sponsorship quota is returned only when no attempt with that `ticket` could have written at the server.
  4. One gate admission creates at most one incarnation.
- **Incarnations and `forget`.** A sponsorship at the server belongs to `(app, incarnation, ticket)`. The commit and
  the check after `renew` (`orphans`) pass only in the incarnation and for the sponsorship they started with, so the
  Worker undoes at once a write at the server that lands after the reservation's term, after `forget` or after a new
  registration. A drop removes only the sponsorship with its own `ticket`, so a late retry does not touch a newer
  sponsorship of that server. `forget` writes a drop record of the app's sponsorships and reservations and deletes
  the entry in one write, then drops at once; a server failure gives 500, and a repeated `forget` finishes the drops.
  The drop record stays 10 min and its alarm drops once more (a late write from a request in flight); a failed drop
  retries every 10 min until it succeeds.
- **Entry state and terms in one alarm.** The entry object keeps its whole state (entry, drop records, spent
  admissions) in one storage key, so every operation writes it atomically. A Durable Object has one alarm, so after
  each write the entry sets it to the nearest term in its state. The alarm removes what has expired and deletes an
  object with nothing alive; reads skip expired terms also before the alarm. The gate and the denial list clean up
  their counters, admissions and denials with a daily alarm.
- **What the model leaves open.** Three cases, each with the condition that triggers it:
  - Apple writes the DeviceCheck bits before the gate's atomic write. When that write fails, a retry pays a device
    quota unit a second time; the failure never yields an entry without an admission.
  - A write at the server arrives more than 10 min after the app step before it (a reservation, its retry, or an
    extension in `sponsor` or `renew`); meanwhile the claim has turned into a drop record and the drop has run; and
    the Worker handling the request fails before its check after the write (the commit, `orphans` after `renew`).
    Such a write stays until its term (90 days). Without that failure the Worker drops it at once; a server keeps
    one sponsorship per app incarnation, so a newer sponsorship the app committed in the meantime is overwritten and
    lost until the app's next `renew`. The error fails closed: the hook may deny that server until then. The
    model-based test never moves its clock far enough for a paused server write to arrive 10 min or more after the
    app step, so it does not cover this case; without that limit it finds it.
  - A claim without a write at the server: an attempt got a further term, and its write never reached the server.
    The app counts the sponsorship until the claim's term, while the server drops out at the term of its last
    successful write, until the app's next `renew`. This error also fails closed: the hook may deny that server. The
    invariant guards only the server → app direction.

## Durable Objects and the Apple gate

- **`Endpoint`** (`idFromName(endpointId)`): the entry of one EndpointId. **`Gate`** (one object): every new
  registration goes through it in order (entry extension, brake, quota, Apple, admission, entry), with a queue of at
  most 32 requests; further ones get 503. One client bucket (an IPv4 address, an IPv6 /48) holds at most one place:
  its second request while the first waits or runs gets 429 `limited` at once, so one client cannot fill the queue.
  **`Admin`** (one object): the denial list and its mirror in the KV namespace `DENIED`. Each object runs its
  operations one at a time through a queue in code, because the Durable Objects "input gate" (a platform mechanism,
  unrelated to the Apple gate) does not hold other requests while an object waits on an outgoing `fetch` call such as
  the one to Apple. An entry's queue never waits on another entry: other entries are called only from the alarm,
  outside the queue.
- **Data location.** Every object lives in the EU jurisdiction (`JURISDICTION` in `src/config.ts`), so it runs and
  stores its data only in the EU. The KV mirror `DENIED` and Workers Logs are not bound to a region. An object's id
  depends on the jurisdiction, so changing it after deployment yields new, empty objects.
- **Apple calls.** DeviceCheck: `query_two_bits` and `update_two_bits` on the host of the proof's environment
  (`api.devicecheck.apple.com` or `api.development.devicecheck.apple.com`) with an ES256 JWT provider token (`kid` =
  Key ID, `iss` = `APPLE_TEAM_ID`). APNs: a silent background push to the device token
  (`apns-push-type: background`, priority 5, `apns-expiration: 0`, the app's topic); a 200 from Apple is the proof.
- **Apple's response**: a rejected proof (400 about the DeviceCheck device token, 410 or `BadDeviceToken` from APNs)
  is 422 `proof-rejected`; a network error, the 10 s deadline, 429 and 5xx are 502 `gate-unreachable`; a rejection of
  the Worker's own key (401, 403, other 4xx) is 503 `unavailable`.

## Hook and shadow mode

`ENFORCE` other than `1` is shadow mode: the hook always answers 200 `true`, and the log line carries the decision
the Worker would make (`allow`, `deny` or `error`) with the full EndpointId. With `ENFORCE=1` the line carries the
decision without the EndpointId, unless the diagnostic window `DIAG_UNTIL` is open. The Worker keeps no decision
cache. It reads admin denials from KV with `cacheTtl` 60 s, so a new denial reaches the hook within a minute plus KV
propagation between locations, and the adapter on the VPS remembers a Worker deny for another 15 s. The adapter
does not remember allows. A denial applies to a connection only when it passes the hook; connections already
admitted stay until then, which is why step 7 of "Deployment" restarts the relay.

## Log

One JSON line per request (Workers Logs), only fields from the allow-list in `src/log.ts`, each with a checked shape:
event, route, status and code, the rejected field, time, client version from `X-Rarog-Relay-Client`, gate and
registration freshness, Apple's status and reason, the hook decision and mode. Never the proof token or its hash,
the signature, a bearer token, an IP address, the app's server list or an exception message. A `config` line with
a problem code (the name, never the value) appears once per isolate when the configuration has a defect; a
`limit-error` line appears when the Rate Limiting counter does not answer.

## Configuration (`wrangler.toml`)

- **Worker** `rarog-relay-auth`, only on the Custom Domain `relay-auth.rarog.ai` (no `*.workers.dev`, no preview
  URLs), invocation logs off.
- **Variables.** `DEPLOY_SHA`: the version suffix in `/v1/health`. `GATE_KIND`: the gate into the registry,
  `devicecheck` or `apns`; an empty or other value means no gate (`gate: null`, registration 503). The name is not
  `GATE`, because the Durable Object binding carries that one. `ENFORCE`: `1` enforces the hook's decisions, any
  other value is shadow mode. `APPLE_TEAM_ID`: the Apple team of the app's publisher. `REGISTER_MONTHLY_QUOTA`
  (1–3), `REGISTER_DAILY_BRAKE`, `SPONSOR_QUOTA`, `SPONSORED_LIVE_MAX` (1–32): the quotas described under
  "Quotas, terms and idempotency". `QUOTA_GRACE_UNTIL` and `DIAG_UNTIL`: epoch seconds or empty.
- **Variables outside production only.** `CLOCK_OFFSET`: seconds added to the clock of the Worker and the Durable
  Objects, for tests on `workerd`; the Worker subtracts the offset again when it sets a platform alarm, because the
  platform fires alarms on the real clock. `NO_JURISDICTION=1`: the objects without the EU jurisdiction, because
  local `workerd` does not implement jurisdictions ("Jurisdiction restrictions are not implemented in workerd",
  wrangler 4.151.1). The file does not and must not carry either (a guard checks); when set, each produces a
  `config` line, with the code `clock-offset` or `no-jurisdiction`.
- **Secrets** (names only; the operator sets the values): `RELAY_HOOK_SECRET` (the hook bearer, the same as the
  relay's `IROH_RELAY_HTTP_BEARER_TOKEN`), `ADMIN_SECRET` (the admin routes' bearer), `DEVICECHECK_KEY` and
  `DEVICECHECK_KEY_ID` (gate `devicecheck`) or `APNS_KEY` and `APNS_KEY_ID` (gate `apns`): a PKCS#8 PEM key from the
  Apple developer portal and its Key ID. The Worker reads only the selected gate's key.
  `RELAY_HOOK_SECRET` and `ADMIN_SECRET` need at least 32 characters (`openssl rand -hex 32` gives 64). A shorter
  one counts as missing: its routes answer 503 and the log gets a `config` line with the code
  `relay-hook-secret-short` or `admin-secret-short`. The app routes and `/v1/health` do not change.
- **Configuration defect.** A bad quota, `QUOTA_GRACE_UNTIL`, `DIAG_UNTIL` or `CLOCK_OFFSET` value: every app route
  answers 503. A bad Team ID or Key ID, or a missing or bad key for the selected gate: only `register` answers 503,
  and `renew`, `sponsor` and `forget` keep working. Either way `/v1/health` says `ok: false` and the log has a
  `config` line. `/v1/health` keeps answering, and so do the hook and the admin routes, because they need only
  their own secret.
- **Durable Objects** with SQLite storage (migration `v1`): `ENDPOINT` → `Endpoint`, `GATE` → `Gate`,
  `ADMIN` → `Admin`. **KV** `DENIED`: the mirror of the denial list (key = EndpointId, expires with the denial).
- **Counters**: Rate Limiting per client address (IPv4; IPv6 per /64). When Cloudflare's Pseudo IPv4 feature puts
  a 240.0.0.0/4 stand-in into `CF-Connecting-IP`, the Worker takes the real address from `CF-Connecting-IPv6`.
  `RL_APP` 60 per 60 s on each `/v1/app/*` route (`namespace_id` 8201),
  `RL_REGISTER` 10 per 60 s on `register` (8202). A `namespace_id` is unique within an account, so these numbers do
  not overlap with the push relay's counters.
- **Cron** `0 */6 * * *`: a canary that calls `scheduled`, which has no work (alarms handle the terms).

The guard `test/config.test.ts` checks the file against the code (bindings, exported classes, migration, counters,
cron, variables, no variables for outside production, secrets only in a comment) and pins tool versions to
`relay/package.json`.

## Account values

The file holds two values from the operator's account; a deployment on another account changes both:

- **Cloudflare account**: no `account_id` field; wrangler takes the account from the `CLOUDFLARE_ACCOUNT_ID`
  variable, as for the push relay (`relay/README.md`, "Account and domain"). The `rarog.ai` zone must be on that
  account.
- **KV namespace `id`** of `DENIED`: the id from `wrangler kv namespace create`. It is not a secret: without the
  account's API token it gives no access. The guard accepts 32 hex characters or the placeholder
  `PLACEHOLDER-KV-DENIED-ID`, and a deployment with the placeholder fails.

`wrangler deploy --dry-run` works locally without a login and without the account values.

## Deployment

The operator runs the commands with secrets from the repo root, with values from their own secret manager. Every
wrangler command below that talks to Cloudflare needs `CLOUDFLARE_ACCOUNT_ID` in the environment.

1. Tests before every deployment: `pnpm -C relay-auth test && pnpm -C relay-auth run typecheck`.
2. KV namespace (once): `pnpm -C relay-auth exec wrangler kv namespace create DENIED`, then its `id` in place of the
   placeholder in `wrangler.toml` (commit).
3. Secrets (once and on rotation). The hook bearer goes from the VPS straight to Cloudflare without being displayed:

   ```bash
   ssh root@<vps> "sed -n 's/^IROH_RELAY_HTTP_BEARER_TOKEN=//p' /etc/iroh-relay/relay.env" \
     | pnpm -C relay-auth exec wrangler secret put RELAY_HOOK_SECRET
   printf %s "$ADMIN_SECRET" | pnpm -C relay-auth exec wrangler secret put ADMIN_SECRET
   printf %s "$DEVICECHECK_KEY_PEM" | pnpm -C relay-auth exec wrangler secret put DEVICECHECK_KEY
   printf %s "$DEVICECHECK_KEY_ID" | pnpm -C relay-auth exec wrangler secret put DEVICECHECK_KEY_ID
   ```

   The Apple key must have the DeviceCheck service enabled in the developer portal (for gate `apns`: APNs, and the
   secrets `APNS_KEY` and `APNS_KEY_ID`).
4. Gate: `GATE_KIND = "devicecheck"` in `[vars]` (commit). `ENFORCE` stays `"0"`.
5. Deploy and check. On the first deployment the Custom Domain creates the DNS record and the certificate for
   `relay-auth.rarog.ai`.

   ```bash
   pnpm -C relay-auth exec wrangler deploy --var DEPLOY_SHA:"$(git rev-parse --short HEAD)"
   curl -sS https://relay-auth.rarog.ai/v1/health
   ```

   Expected: `{"v":1,"ok":true,"version":"0.1.0+<sha>","gate":"devicecheck","enforce":false}`. `ok: false` with
   `gate: null` means an empty or unknown `GATE_KIND`. `ok: false` with a gate means a configuration defect:
   `pnpm -C relay-auth exec wrangler tail` shows the `config` line with the problem code.
6. Zone WAF rules (Cloudflare dashboard). Rate Limiting: add the paths `/v1/app/register`, `/v1/app/renew`,
   `/v1/app/sponsor`, `/v1/app/forget`, `/v1/admin/deny` and `/v1/admin/allow` to the expression of the zone's
   existing Rate Limiting rule, the push relay's rule from `relay/README.md`, "Operations". Leave out `/v1/access`:
   the adapter calls it from the VPS's single address and would turn a 429 from the rule into `true`. Known routes
   only: a custom rule (Block) on the host `relay-auth.rarog.ai` that lets through only `POST` on the four
   `/v1/app/*` paths, `/v1/access`, `/v1/admin/deny` and `/v1/admin/allow` and `GET /v1/health`, so any other
   request stops before the Worker and does not count toward the bill.
7. Shadow mode: the adapter log on the VPS shows `src=worker` (the decision came from the Worker) instead of
   `src=failopen` (the adapter admitted the client without a Worker decision) and zero 401s, and the Worker's decision
   lines show `allow` for keys in the registry. Then set `ENFORCE = "1"`, deploy as in step 5
   (`"enforce":true`) and restart the relay on the VPS (`systemctl restart iroh-relay`, which restarts the adapter
   too), because connections admitted in shadow mode must pass the hook again.

To switch enforcement off without reverting code, set `ENFORCE = "0"` and deploy as in step 5. An admin denial:

```bash
curl -sS https://relay-auth.rarog.ai/v1/admin/deny -H 'content-type: application/json' \
  -H 'x-rarog-relay-client: rarog-admin/0.1.0' -H "authorization: Bearer $ADMIN_SECRET" \
  -d '{"v":1,"endpointId":"<64 hex characters>"}'
```

## Code

- `src/core.ts`: the core without Workers globals: routing, order of checks, routes, hook.
- `src/registry.ts`: platform-free state machines over an abstract storage (`EndpointBook`, `GateDesk`,
  `DenyBook`): quotas, terms, alarms, the operation queue.
- `src/objects.ts`: the Durable Object classes as thin wrappers around the machines, the clock with `CLOCK_OFFSET`,
  the KV mirror.
- `src/apple.ts`, `src/config.ts`, `src/crypto.ts`, `src/log.ts`: Apple calls through an injected `fetch`; variables
  and secrets to settings with problem codes; Ed25519 (WebCrypto) and constant-time bearer comparison; the log
  allow-list.
- `src/worker.ts`: the Workers adapter (`fetch`, `scheduled`) and the Durable Object class exports. It exports only
  the handler and the classes, because `workerd` rejects any other value export at start.
- `src/wspolne.ts`: the only entry into the push relay's code in `relay/src/` (`apns.ts`, `jwt.ts`, `client-key.ts`,
  `bytes.ts`, `identity.ts` for the app's topic, and `log.ts` with field checks and the allow-list formatter).

## Tests

A separate pnpm project like `relay/`, outside the root workspace. `src/wspolne.ts` pulls `@noble/curves` from
`relay/node_modules`, and `test/model.test.ts` takes `fast-check` from the root install, so the tests need three
installs:

```bash
pnpm install --frozen-lockfile
pnpm -C relay install --frozen-lockfile
pnpm -C relay-auth install --frozen-lockfile
pnpm -C relay-auth run typecheck
pnpm -C relay-auth test
```

- `registry.test.ts`: the state machines on a fake storage, the gate included.
- `consistency.test.ts`: the four app routes interleaved by a latch between objects, with failures before and after
  each effect and lost responses; each counterexample of the model-based test has its own test here.
- `model.test.ts`: the model-based test (fast-check, fixed seed, 3000 runs in a few seconds; `RAROG_MODEL_RUNS=<n>`
  sets the count): random sequences by two apps with failures, alarms and a clock at the edges of terms, checked
  against the four rules of the sponsorship invariant after each step.
- `core.test.ts`: the core in process, with the manifest cases byte for byte and a log spy on every path.
- `apple.test.ts`, `worker.test.ts`: Apple calls on a fake `fetch`; the adapter and the Durable Object classes on
  fake bindings.
- `workerd.test.ts`: a local `workerd` from wrangler (`test/workerd.mjs`; no account, no network) with the real VPS
  adapter `relay-vps/access-adapter.mjs` and a fake Apple.
- `config.test.ts`, `log.test.ts`, `wspolne.test.ts`: guards of `wrangler.toml`, the log allow-list and the only
  entry into `relay/src/`.

`pnpm run check` at the repo root runs the same typecheck and tests in its `relay-auth` step when both
`relay-auth/node_modules` and `relay/node_modules` exist; otherwise the step prints `skipped`. CI installs both
projects and runs the typecheck and the tests.
