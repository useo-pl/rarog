# rarog-relay — the Rarog push relay

A stateless Cloudflare Worker run by the app's publisher (USEO). A Rarog server without its own APNs key sends push
notifications to the Rarog app through it, and only the relay holds the APNs key. For each device token the server
gets a pass: an HMAC-signed permission to send to that token, valid for 90 days. A Live Activity pass is tied to its
parent device and never outlives the parent's pass. The server sends a ready APNs request; the relay checks the pass,
the headers and the payload, signs the provider JWT and passes Apple's answer back.

**One environment: the Worker `rarog-relay` at `push.rarog.ai` with payload policy `v2` (`wrangler.toml`).** The code
does not limit who may use it: anyone who knows a real Rarog app token gets an `alert` pass (after a test push). The
Rarog server calls the relay when `RAROG_PUSH_RELAY_URL` points at its origin (`docs/server-config.md`). The
server-side client is `server/src/notify/relay-sender.ts` (its requests equal the fixtures), and
`server/src/notify/relay-pass.ts` requests the passes from `/v1/pass`. The relay operator deploys the Worker and runs
every command that needs a secret.

## How it works

- **Stateless.** No KV, D1, R2, Durable Objects or queues. The only bindings are three Rate Limiting counters.
- **Pass.** Device pass: `v1.<kid>.<environment>.alert.<token hash>.<exp>.<HMAC>` (7 fields). Live Activity pass:
  `v2.<kid>.<environment>.liveactivity.<activity token hash>.<parent hash>.<exp>.<HMAC>` (8 fields), where the
  parent hash is the DEVICE token hash from the device pass it was issued for. The version fixes the shape: `v1` is
  only `alert`, `v2` only `liveactivity`, and any other combination is 401 `pass-invalid`. The hash is the first 16
  hex characters of the `sha256` of the lowercase token. `exp` is in epoch seconds (90 days; a Live Activity pass at
  most until the parent's `exp`). The HMAC-SHA256 uses key `kid` from `PASS_KEYS` over the text before the last dot
  (base64url without padding, one accepted form). A pass binds the right to send to one token, environment, type
  and expiry, and a Live Activity pass also to its device: Live Activity limits count per parent, so many activity
  tokens of one device do not multiply its budget. The pass does not bind the topic: the allow-list has a single app
  topic (`ai.rarog.app`, `src/identity.ts`), and `/v1/push` derives the Live Activity topic from it.
- **Token proof.** The relay issues an `alert` pass only after Apple answers 200 to a silent test push under the app
  topic (`apns-push-type: background`, `apns-priority: 5`, `apns-expiration: 0`, `{"aps":{"content-available":1}}`;
  the app has no background mode, so the system drops it). A `liveactivity` pass needs a valid device pass, at most
  10 per 60 s per parent device.
- **Payload policy.** `aps.alert` may carry only fixed text, with no exceptions: the banner placeholder text, or the
  `done` chime of a Live Activity (a fixed title and body with a sound file). Details in "Payload policy" below.
- **Provider JWT.** Deterministic ES256 (`@noble/curves`, RFC 6979) with `iat` rounded down to a 40-minute window:
  every isolate computes the same token, and the token changes every 40 minutes (Apple wants 20–60 minutes, otherwise
  `TooManyProviderTokenUpdates`). The PKCS#8 PEM key becomes a scalar through WebCrypto (`importKey`,
  `exportKey('jwk')`), without `nodejs_compat`. The relay does not sign with WebCrypto, because a WebCrypto
  signature is random.
- **Log.** One JSON line per request with allow-listed fields (`src/log.ts`): route, environment, type, status and
  code, Apple's status and reason, rule, cause, duration, `kid`, and the client version from `X-Rarog-Relay-Client`.
  Never the token, the token hash, the pass, the payload or `authorization`. Worker invocation logs are off
  (`invocation_logs = false`).
- **Platform-free core.** `src/core.ts` gets `fetch`, the clock, the logger and the limiters from outside, and
  `src/worker.ts` is a thin adapter. The core uses no Workers globals, so another adapter can host it (e.g., Node
  with `node:http2`).

Modules in `src/`: `core.ts` (routes, order of checks), `pass.ts` (passes), `client-key.ts` (limiter key from the
client address), `jwt.ts`, `policy.ts` (headers and payload), `alert-policy.ts` (policy literals), `apns.ts`
(request to Apple, 10 s cap), `config.ts` (variables and secrets), `log.ts`, `identity.ts` (app topic), `worker.ts`.

## The `/v1/*` contract

Rules for every route:

- Request and response bodies are JSON with `v: 1`; any other `v` is 400 `bad-request`. Unknown request fields are
  ignored, for compatibility with a newer server. A breaking change gets `/v2/` next to `/v1/`.
- The HTTP body cap is 8 KiB, checked before parsing (also without `Content-Length`); a larger body is 400
  `bad-request`.
- Tokens are hex (32–512 characters, pattern `APNS_TOKEN_RE` in `shared/src/rest.ts`), lowercased BEFORE the hash,
  the pass, the limiter and the APNs URL.
- Units: `exp` in a pass in epoch seconds, `expiresAt` in responses as ISO 8601 UTC, `timestamp` from APNs as Apple
  sends it (epoch milliseconds).
- POST routes require `Content-Type: application/json` (case-insensitive media type; parameters such as `charset`
  allowed) and a non-empty `X-Rarog-Relay-Client` (at most 128 characters, form `name/version`, e.g.
  `rarog-server/<version>`; the relay logs the version). Without them the answer is 400 `bad-request`, before the
  relay reads the body or counts the limit. A simple browser POST carries neither header, and a preflight `OPTIONS`
  gets 405 without CORS headers, so a web page cannot send anything through the relay. `GET /v1/health` needs no
  headers (plain `curl`).
- `shared/fixtures/relay/` has an example of each route and each code (`manifest.json` plus one file per case, with
  the request the relay must send to Apple). Tests compare the code with them byte for byte.

### `POST /v1/pass`

Body: `{v, token, environment, type, topic, devicePass?}`. `environment` is `development` or `production`, `type` is
`alert` or `liveactivity`, and `topic` is the app's bundle id (allow-list: `ai.rarog.app`, single source in
`src/identity.ts`; `server/test/product-identity-guard.test.ts` keeps it equal to `scripts/ios-identity.sh`).
`devicePass` is allowed ONLY with `liveactivity`, and required there.

Order of checks: HTTP headers, body cap, per-address limit, body shape, topic, environment and configuration; then
for `alert` the test push, for `liveactivity` the `devicePass` check (type `alert`, same environment, valid) and
the per-parent limit (key `la:<parent hash>` on the same `RL_PASS`). The address is `CF-Connecting-IP`, or
`CF-Connecting-IPv6` when `CF-Connecting-IP` carries a class E pseudo-address (Cloudflare's Pseudo IPv4 setting
"Overwrite"; `src/worker.ts`). Otherwise `CF-Connecting-IPv6` does not count: Cloudflare forwards client headers,
so the caller would choose its own key. Limiter key: IPv4 as is, IPv6 by /64 (one connection gets a whole /64 from
its provider), IPv4-mapped IPv6 as IPv4, and no address or an unparsable string as the shared bucket `unknown`
(`src/client-key.ts`).

Success: 200 `{v, pass, expiresAt}`.

### `POST /v1/push`

Body: `{v, pass, token, environment, headers, payload}`. `payload` is a JSON STRING that goes to Apple byte for byte
(at most 4096 B of UTF-8). `headers` (an object of strings, at most 16) pass an allow-list: `apns-push-type` equal to
the pass type, `apns-topic` equal to `ai.rarog.app` (`alert`) or `ai.rarog.app.push-type.liveactivity`, and optional
`apns-priority` (`alert`: 1, 5, 10; `liveactivity`: 5, 10), `apns-collapse-id` (printable ASCII, at most 64) and
`apns-expiration` (epoch seconds or 0). The relay sets `authorization` and `content-type` itself.

Order of checks: HTTP headers, body cap, shape, configuration, pass (signature, expiry, environment, token hash),
per-device limit (`RL_PUSH`: banner `a:<token hash>`, Live Activity `la:<parent hash>`), per-address limit
(`RL_PUSH_ADDR`, key as in `/v1/pass`), environment, APNs headers and payload, then Apple. The pass check comes
BEFORE the limits; otherwise a caller without a pass could drain the limit of someone else's token.

Success: 200 `{v, apnsStatus, reason?, timestamp?, renewedPass?: {pass, expiresAt}}` WHENEVER Apple answered,
including Apple's 4xx and 5xx. The server maps them with the same rule as a send with its own key: 200 is `ok`, 410
and 400 with `BadDeviceToken` or `DeviceTokenNotForTopic` are `gone`, the rest is `failed`. `reason` is present when
Apple gave a reason word. `renewedPass` comes only after Apple's 200, when the pass has less than 7 days left or
carries a `kid` other than `PASS_KID`: a renewal, like the test push at issue, proves the token is alive. Only
device passes get `renewedPass`. A Live Activity push does not carry the parent's pass, and a Live Activity pass
must not outlive the parent, so the server renews Live Activity passes through `/v1/pass`
(`server/src/notify/relay-pass.ts`).

### `GET /v1/health`

200 `{v, ok, version, environments, alertPolicy}`. `version` is the version from `package.json` plus
`+<DEPLOY_SHA>`. `environments` lists the environments the relay serves (those in `APNS_ENVIRONMENTS`); it is empty
on any configuration defect, and then `ok` is `false`. A healthy relay answers:

```json
{"v":1,"ok":true,"version":"0.1.0+<sha>","environments":["development","production"],"alertPolicy":"v2"}
```

With `ok: false` the cause is the `config` log line with the problem code, visible in `wrangler tail` (defects:
"Configuration").

### Response matrix

An error is `{v: 1, error: <code>, …fields}`.

| Route | Status | Code (fields) | When |
| --- | --- | --- | --- |
| pass | 200 | `pass`, `expiresAt` | issued |
| pass | 400 | `bad-request` | HTTP headers, shape, `v`, body cap |
| pass | 400 | `topic-not-allowed` | topic outside the allow-list |
| pass | 401 | `pass-invalid` | bad `devicePass` |
| pass | 422 | `token-rejected` (`apnsStatus`, `reason`, `timestamp?`) | dead token (below) |
| pass | 429 | `relay-limited` | per-address or per-parent limit, limiter failure |
| pass | 502 | `apns-error` | other non-200 Apple answer (details only in the log) |
| pass | 502 | `apns-unreachable` | network, 10 s cap |
| pass | 503 | `environment-unavailable` | environment not in `APNS_ENVIRONMENTS`, configuration defect |
| push | 200 | `apnsStatus`, `reason?`, `timestamp?`, `renewedPass?` (`alert`) | Apple answered |
| push | 400 | `bad-request` | HTTP headers, shape, `v`, body cap |
| push | 400 | `payload-rejected` (`rule`) | headers or payload outside the policy |
| push | 401 | `pass-invalid` | signature, expiry, environment, token, shape not matching the version |
| push | 429 | `relay-limited` | per-device or per-address limit |
| push | 502 | `apns-unreachable` | network, 10 s cap |
| push | 503 | `environment-unavailable` | environment not in `APNS_ENVIRONMENTS`, configuration defect |
| health | 200 | `ok`, `version`, `environments`, `alertPolicy` | always |
| other | 404 | `not-found` | unknown path |
| other | 405 | `method-not-allowed` | wrong method (`Allow` header) |
| other | 500 | `internal` | exception in the core (should not happen) |

A dead token is ONLY a 410, or a 400 with `BadDeviceToken` or `DeviceTokenNotForTopic`, so `/v1/pass` never mistakes
an Apple or key failure (502) for one. `reason` in `token-rejected` is Apple's word, or `unknown` when Apple gave
none. `apns-error` carries no Apple fields, so a caller without a pass cannot learn the key's state from the response
(e.g., 403 `InvalidProviderToken`); Apple's status and reason are in the log line (`apns_status`, `reason`, visible
in `wrangler tail`).

## Payload policy

The variable `ALERT_POLICY` takes one value, `v2`; any other value disables the relay (`alert-policy-invalid`). The
literals live in `src/alert-policy.ts`, and a test keeps them equal to `shared/fixtures/relay/alert-policy.json`.

- **`v2`.** A banner (`alert`) has no `aps.alert` (badge only) or the placeholder text, either as a literal (`title`
  `Rarog`, `body` `Nowe powiadomienie`) or as its keys (`title-loc-key` `push.placeholder.title`, `loc-key`
  `push.placeholder.body`), always with `mutable-content: 1`. A Live Activity (`liveactivity`) has no `aps.alert` or
  the `done` chime on `update`, either as a literal equal to the server's `LIVE_ACTIVITY_CHIME` (`title`, `body`,
  `sound: skonczyl.caf`) or as keys in the Live Activity form
  (`{title: {loc-key: push.chime.title}, body: {loc-key: push.chime.body}, sound}`). `loc-args` and
  `title-loc-args` are not allowed: an argument substituted into a template is arbitrary plain text. The server
  sends only encrypted banners: the placeholder with `mutable-content: 1`, and the content encrypted in the
  `rarog` block `{v, kid, n, c}` (format version, id of the device's push key, nonce, ciphertext;
  `server/src/notify/push-crypto.ts`). On the server side the placeholder literal is `RELAY_ALERT_PLACEHOLDER` in
  `shared/src/relay.ts`, which `shared/test/relay-fixtures.test.ts` keeps equal to `alert-policy.json`. The keys go
  to a device entry whose registration declared `locKeys: true` (an app with the keys in its catalog), for the
  banner (`ALERT_PLACEHOLDER_KEYS`) and the chime (`LIVE_ACTIVITY_CHIME_KEYS`, both in
  `server/src/notify/apns-payload.ts`); other entries get the literals. The golden frames of both variants
  (`shared/fixtures/apns-v3/`, `shared/fixtures/apns/`) pass the policy in `test/policy.test.ts`.
- **Closed key sets.** Top level: `alert` allows `aps` and `rarog`, `liveactivity` allows `aps`. `aps` for `alert`:
  `alert`, `badge`, `sound`, `thread-id`, `mutable-content`; for `liveactivity`: `timestamp`, `event` (`update` or
  `end`), `content-state`, `stale-date`, `dismissal-date`, `alert`. The relay passes the `rarog` block and
  `content-state` through without reading them.
- **Canonical form.** `JSON.stringify(JSON.parse(payload)) === payload`. With a duplicated key `JSON.parse` takes the
  last occurrence, while Apple's parser could take the first; without this rule any `alert` could be smuggled in next
  to an allowed one. The server builds payloads with `JSON.stringify`, so it meets the rule.
- **Rules (`rule` in `payload-rejected`):** `headers`, `push-type`, `topic`, `payload-size`, `payload-json`,
  `payload-canonical`, `top-level`, `aps-key`, `aps-value`, `alert`.

A golden frame is a fixture file with the exact APNs headers and payload that the server code produces. Every golden
frame the server sends passes `v2`: the Live Activity frames in `shared/fixtures/apns/` and the format 3 banners in
`shared/fixtures/apns-v3/` (the encrypted banner the server sends, with the `rarog` block at `v: 3`). Every frame
with a changed `aps.alert` fails, including one with a plain title and body. A banner with an envelope under another
top-level key fails on rule `top-level` (`test/policy.test.ts`).

What the policy does not close: the relay passes a Live Activity's `content-state` (project, script name, phase
title, 60 characters each) through unread, because Live Activity content is plain text. Whoever holds a
`liveactivity` pass can write their own text there.

## Configuration

Variables (`[vars]` in `wrangler.toml`, one environment):

- `APNS_TEAM_ID`: the publisher's Apple team (`iss` of the JWT).
- `APNS_ENVIRONMENTS`: `development,production`; one key (Sandbox & Production) serves both.
- `ALERT_POLICY`: `v2` (`test/config.test.ts`); see "Payload policy".
- `PASS_KID`: the `kid` of new passes; it must be a key in `PASS_KEYS`.
- `DEPLOY_SHA`: the deployed commit in `version` (`wrangler deploy --var DEPLOY_SHA:<sha>`).

### Secrets

The operator sets them with `wrangler secret put` from stdin; values never go into the repo.

- `APNS_KEY`: PEM of the APNs key from the Apple portal (PKCS#8).
- `APNS_KEY_ID`: the Key ID of that key.
- `PASS_KEYS`: JSON `{kid: base64 key of at least 32 B}`, at most 8 keys. It is generated straight into Cloudflare
  with NO copy anywhere else, and Cloudflare does not return a secret, so a rotation always replaces the whole
  secret ("Operations" below). A pass can always be issued again (`/v1/pass` with a test push), so a lost key costs
  one new `/v1/pass` request per token, and a key that exists nowhere cannot leak from a secret manager. A second
  relay (e.g., staging) has its own `PASS_KEYS`, so a pass from one relay gets 401 on the other.

Bindings (Rate Limiting; the window is per Cloudflare location and "eventually consistent"):

- `RL_PASS`: `/v1/pass` per address (IPv4, IPv6 by /64) and Live Activity passes per parent device (`la:<hash>`),
  10 per 60 s (`namespace_id` 8101).
- `RL_PUSH`: `/v1/push` per device (banner `a:<token hash>`, Live Activity `la:<parent hash>`), 60 per 60 s (8102).
- `RL_PUSH_ADDR`: `/v1/push` per address (key as in `RL_PASS`), 600 per 60 s (8103). The threshold leaves room for
  CGNAT: servers behind one address share the counter, and a `429` is a failed send attempt.

Only `src/client-key.ts` builds the keys (guard `test/klucz-limitu-guard.test.ts`). `namespace_id` is unique within
a Cloudflare account, so a second Worker on the same account (e.g., staging) gets its own bindings with other numbers.

A limiter failure (an exception from the binding) leaves a `limit-error` log line, and the effect depends on the
route. `/v1/pass` refuses with 429 `relay-limited`: every attempt is a subrequest to Apple with the publisher's key,
and after a 429 the server holds its `/v1/pass` requests for 60 s, while after a 503 it would stop sending through
the relay in that environment for 15 min. `/v1/push` lets the request through, because the pass is already checked
and a refusal would lose push notifications. Any configuration defect (missing secret `APNS_KEY`, `APNS_KEY_ID` or
`PASS_KEYS`, bad PEM, `PASS_KID` outside `PASS_KEYS`, `ALERT_POLICY` other than `v2`) disables both environments: 503
`environment-unavailable`, `ok: false`, and one `config` log line with the problem code (the name, never the value),
visible in `wrangler tail`.

### Account and domain

The Worker `rarog-relay` serves `push.rarog.ai` as a Custom Domain (`workers_dev = false`, `preview_urls = false`).
`wrangler.toml` has no `account_id` field: wrangler takes the account from the environment variable
`CLOUDFLARE_ACCOUNT_ID`, which every wrangler command that talks to Cloudflare needs (`deploy`, `secret put`,
`tail`, `deployments list`, `rollback`, `delete`); `deploy --dry-run` does not. Without the variable wrangler takes
the account from its own cache or the only account of the login, and with several accounts it asks (in
non-interactive mode it exits with an error). An `account_id` field in the file would take precedence over the
variable, so the file has none (`test/config.test.ts`; wrangler 4.151.1). The account is the one that holds the
zone of the domain in `routes`, and the zone must be there before the Custom Domain comes up.

A second environment is a `[env.<name>]` section with its OWN `routes`, `vars` and `ratelimits`. `vars` and
`ratelimits` are not inherited into `[env.*]`, but `routes` is, so without its own `routes` the second environment
would take the first one's domain. `test/config.test.ts` pins one environment (no `[env.*]`).

Publisher values: `APNS_TEAM_ID`, `name` and `routes` in `wrangler.toml` (pinned by `test/config.test.ts`), and the
app topic in `src/identity.ts` (`ai.rarog.app`; `server/test/product-identity-guard.test.ts` keeps it equal to the
app's bundle id and to the server). A relay of your own under another domain changes `routes` together with the
test. The APNs key must belong to the team in `APNS_TEAM_ID`, and the topic to an app of that team.

## Operations

- **WAF rule and budget alert.** Both live in the Cloudflare dashboard, not in the repo. A WAF Rate Limiting rule
  on the paths `/v1/pass` and `/v1/push`, counted per IP, stops traffic before it reaches the Worker, where every
  request counts toward the account's bill. A budget alert (Billing → Billable Usage, data a day late) reports usage
  and stops nothing, so there is no hard spending cap. A WAF block is a 429 without JSON; the server handles it like
  a relay 429 (code `unknown`, its `/v1/pass` requests wait 60 s). The limiter key is correct at any Pseudo IPv4
  setting.
- **Rollback.** The target is always a version with policy `v2`, named by an explicit id from
  `wrangler deployments list`, and afterwards `/v1/health` must return `"alertPolicy":"v2"`. A bare
  `wrangler rollback` takes the previous version whatever its policy, and a policy other than `v2` lets anyone who
  knows a token send plain banners without bringing banner content back: the switch for encrypted content is the
  server flag `RAROG_PUSH_E2E` (`docs/server-config.md`). When no `v2` version fits, the operator deploys a checked
  commit. A relay version that does not know a pass shape answers `401 pass-invalid`; the server drops that pass and
  requests a new one after a backoff (first step 30 s). The limiters do not block a rollback in either direction: the
  window is 60 s and Cloudflare counts per `namespace_id` and key (its docs do not promise a reset on deploy).
- **Relay down or deleted.** When the relay answers 5xx or not at all, a send is a failed attempt, after a `503` the
  server stops sending through the relay in that environment for 15 min, and its `/v1/pass` requests wait with a
  backoff. Devices in the server's registry (`apns-devices.json`) that have no pass get their pushes through the
  server's own APNs key, when the server has one. An empty `RAROG_PUSH_RELAY_URL` plus a server restart turns the
  relay off on the server side.
- **`PASS_KEYS` rotation.** Nobody has a copy of the key, so a rotation replaces the WHOLE secret with a new random
  key under the SAME `kid` (`PASS_KID`). `wrangler secret put` deploys at once with the deployed variables, and
  `PASS_KEYS` without the `PASS_KID` key would be a configuration defect (503 in both environments until the next
  `deploy`). Every existing pass then gets `401 pass-invalid`: the server drops it at its first send and requests a
  new one after the 30 s backoff, so each token loses one send (a device for which the server also has its own APNs
  key gets that send through the server's key meanwhile). The server does not know about the rotation, so a device
  that receives nothing keeps its invalid pass until its first send or its renewal 7 days before expiry. The code
  accepts several `kid`s in `PASS_KEYS` (a device pass with an older `kid` gets `renewedPass` under `PASS_KID`), but
  such an overlap needs the old key's value, and nobody has a copy of it.
- **`PASS_KEYS` leak.** Whoever knows the key can issue a pass for any token they know (the payload policy limits the
  content anyway). The response is a rotation, which invalidates every pass at once.
- **APNs key leak.** Whoever holds the relay's APNs key can SEND push notifications to the apps the key covers (a team
  key covers every app of the publisher's team), not read them. The operator revokes the key in the Apple Developer
  portal (Keys), creates a new APNs key (Sandbox & Production) and sets `APNS_KEY` and `APNS_KEY_ID` again. Passes
  stay valid (the HMAC does not depend on the APNs key), and tokens need no new registration.

## Tests

```bash
pnpm -C relay install       # needs the network; install scripts are off (pnpm-workspace.yaml)
pnpm -C relay test          # vitest in Node: fake fetch, clock, limiters and logger; the test generates an APNs key
pnpm -C relay run typecheck # tsc --noEmit
```

`pnpm run check` at the repo root runs both steps when `relay/node_modules` exists and prints "skipped" otherwise.
Both steps must pass before every deployment, also when `pnpm run check` skipped them. The contract fixtures
(`shared/fixtures/relay/`) use policy `v2` (`env.ALERT_POLICY` in the manifest). The banner `push.*` cases carry the
server's format 3 frame (`apns-v3/alert.blocking.v3.json`; `server/test/relay-fixtures-producenci.test.ts` keeps
them equal), and a plain v1 banner appears only in the rejection case `push.payload-rejected.v1.json` (400, rule
`alert`).

A dry run checks that the Worker builds, without a Cloudflare account, a login or `CLOUDFLARE_ACCOUNT_ID` (wrangler
4.151.1: about 121 KiB, about 35 KiB gzipped):

```bash
pnpm -C relay exec wrangler deploy --dry-run --outdir "$(mktemp -d "$TMPDIR/rarog-relay.XXXXXX")"
```

Local `wrangler dev` has no HTTP/2 to APNs (workerd #4841), so the live test runs on the deployed Worker
("Measurements").

## Measurements

The smoke script runs against the deployed Worker with real tokens from the server's device registry
(`<dataDir>/apns-devices.json`, data directory by the rule in `shared/src/data-dir.mjs`, or a path as the second
argument):

```bash
node relay/scripts/smoke.mjs https://<your-domain> [<path>] [--label <label>] [--activity-label <label>] [--steps 1,2,3]
```

The address is required (`https://` plus the domain from `routes` in `wrangler.toml`); without it the script exits
with code 2 before sending anything. The script picks registry entries by their `label` field, only entries with
topic `ai.rarog.app`, the newest when several match: `--label` (default `iPhone·Rarog`) for the device token of steps
1–2, `--activity-label` (default `iPad·Rarog`) for the Live Activity token of step 3. It prints only statuses and
codes, never tokens or passes.

1. **HTTP/2 from the Worker** (`--steps 1`): `/v1/pass` and `/v1/push` on the `development` token give 200 and
   `apnsStatus=200`, and the device shows the placeholder banner. A single `/v1/pass` can return 502
   `apns-unreachable` (no answer from Apple); the server retries its `/v1/pass` request with a backoff.
2. **Key in production without a production build** (`--steps 2`): `/v1/pass` for the same `development` token in
   `production`. Apple rejects a key it does not accept with 403 (`InvalidProviderToken` or
   `BadEnvironmentKeyIdInToken`), which the relay returns as 502 `apns-error`. The expected 422 `token-rejected` with
   `BadDeviceToken` means Apple accepted the key in `production` and rejected only the development token. For any
   502 `apns-error`, `wrangler tail` shows `apns_status` and `reason`.
3. **Live Activity topic** (`--steps 3`): a `liveactivity` pass and a Live Activity update give 200 when the key
   covers `ai.rarog.app.push-type.liveactivity`, `TopicDisallowed` when it does not. The script's update sends zero
   counters in `content-state` (`waiting`, `working`, `finished`), so the Live Activity shows zeros until the next
   update from the server.
4. **Placeholder banner from keys** (`--steps 4`, only on request; the default steps are 1–3): one `/v1/push` to the
   `--label` device in the environment of its registry entry, with an alert from the catalog keys
   `push.placeholder.title` and `push.placeholder.body`, `mutable-content: 1` and a v3 envelope whose `kid` is
   well-formed but unknown to the device. The notification extension finds no key and shows the placeholder banner,
   localized by the system from the keys. A banner with real content means the device knows that `kid`.
5. **CPU** (`pnpm -C relay exec wrangler tail --format json` on server traffic, field `cpuTime`): a cold isolate (key
   import, first JWT signature) uses 25–62 ms of CPU time, a warm one 2–5 ms. A cold isolate exceeds the Free plan's
   10 ms, so the relay needs a paid Workers plan (CPU cap 30 s).
