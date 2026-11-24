# Distribution: device pairing and the `rarog` command

> On Linux, `rarog restart`, `rarog service`, `rarog doctor` and `rarog setup` are tested against fakes shaped like
> systemd 255 from Ubuntu 24.04, and `tailscale serve` against a fake `tailscale`; neither is verified on a live
> system.

## Overview

- The server pairs a device with a one-time code and then accepts its device key, the header
  `Authorization: Rarog-Device <deviceId>.<secret>`, in REST, SSE and the emergency console WebSocket. There is no
  other credential: `POST /api/login` answers a fixed 410 `login-retired`.
- The native app is called Rarog: bundle id `ai.rarog.app`, link scheme `rarog://`, device label `iPad·Rarog` or
  `iPhone·Rarog`. It keeps the key in its Keychain and without a key shows only the pairing screen. A link in another
  scheme is not a pairing link, and an APNs registration without `topic` gets 400 `topic-mismatch`
  (`docs/server-config.md`, "APNs channel of the native app").
- The App Store is the app's only public channel (status: https://rarog.ai); there is no public test build.
  `scripts/ios-build.sh` and `scripts/ios-install.sh` build and install a development build over a cable or on the
  local network (`native/Rarog/docs/installing.md`, "Installing on the iPad"); a copy under your own Apple team:
  `native/Rarog/docs/installing.md`, "Building your own copy".
- `rarog setup` installs the server on a fresh account (a full run on a live account is unverified). The launchd
  service `ai.rarog.server` (on Linux the `systemd --user` unit `rarog.service`) runs `rarog serve`, which reads
  `~/.config/rarog/config.json` (`docs/server-config.md`).
- Push notifications go through the push relay (`relay/`, a Cloudflare Worker at `push.rarog.ai`) when
  `RAROG_PUSH_RELAY_URL` is set; `rarog setup` writes the production address. For each app entry the server requests
  a relay pass, a signed permission from the relay to send to that one device token for 90 days, and sends with it.
  A `production` entry (a TestFlight build) goes only through the relay; a `development` entry without a pass uses
  the server's own APNs key when there is one. Without a pass the token status says `degradedReason: pass-missing`,
  and the app shows the cause. Contract: `relay/README.md`; the variable: `docs/server-config.md`,
  "Push relay: `RAROG_PUSH_RELAY_URL`".

Security rules, the guarantee boundary and the lost phone runbook:
`docs/security-model.md`, "Pairing and device keys". Routes: `docs/implementation-spec.md`, "Device keys and pairing".

## Pairing from the app

The app always asks "Pair with <host>?", so a link never swaps the server silently. For a link without `u` the card
asks "Pair with iroh · <first 8 characters of the EndpointId>?" and shows the whole EndpointId below, to compare with
`k` in the link from `rarog pair`. A link with `k` also shows the server key fingerprint: the first 16 characters of
`k` in groups of 4. A device key has no fixed expiry: it ends on revoke (`rarog devices revoke`), on Forget Server in
the app, or after 30 days without use.

The app is paired with one server at a time. On a paired device, a link to another server (another `k`; a `k` while
the paired server has no iroh key; or, for a link without `k`, another address) gets a warning that names the paired
server: pairing swaps it. Cancel comes first and is the default action; only Replace pairs, and the device then starts
with empty app data (outbox, drafts), also when the other server has the same address. A device without a pairing
(the first one, or after a revoke) gets no warning, because it has no server to compare the link with.

1. **First device** (the server has no active device): run `rarog pair` on the server machine or over
   SSH or mosh. In the app pick Scan QR Code (the camera, for example on a QR code in a terminal on the iPad screen)
   or I Have a Link (paste the `https://rarog.ai/pair#…` link), or tap the link when the system opens it in the app;
   then Pair. The app enters the session list without a restart, and `rarog pair` ends with
   `Paired: <label> (<deviceId>)`. An iPad with no second device runs `rarog pair` in an SSH client on the same
   iPad and pastes the link with the system paste button next to the field. The app skips whitespace in the link,
   so a link broken across terminal lines works.
2. **Next device**: on a paired device, Settings → Pairing → Pair New Device shows a QR code with a 5-minute
   countdown (single use) and a Share Link button (AirDrop, for example). The new device scans or pastes as above.
   The other devices get a "🔐 New device paired" push notification and a "New device: …" notice in the list.
3. **List and revoke**: Settings → Pairing lists the devices with label, pairing date, code creator and last use.
   Revoking another
   device happens on the server (`rarog devices revoke`); Forget Server revokes the device itself and clears its
   device key, outbox, drafts and notifications; the app's iroh key, and with it the device's EndpointId, stays.

The link sets the route of the pairing. A link with only `u` pairs over HTTPS. A link with `k` and `r`, with or
without `u`, pairs over iroh to that EndpointId, on the iPhone, the iPad and the Mac alike; the address in such a link
is not a fallback, so when iroh does not answer, the pairing fails. The key keeps the address from `u` and the iroh
pair from the pairing reply, or from the link when the reply has none or has one in the wrong shape (a line in
`client.log`). Pair New Device gives a link with every route the device knows: `u`, `k` and `r`, or only `k` and `r`
on a device paired without an address.

After pairing, the device talks to the server over iroh when its key has an iroh pair and the device's iroh endpoint is
ready, and over HTTPS to the address otherwise. After a failed iroh attempt the next connections use the address for 2
minutes, unless the network changes or the address fails its first request too; then iroh is tried again right away. A
connection over the address that works stays until it closes. A device without an address has no other route, so it
tries iroh again soon: after 1, 2, 4 and 8 s, then every 15 s, and at once when the network changes; in between,
requests fail as offline. While the app is in the foreground, one such attempt may take 30 s instead of 15 s. The
iPhone, the iPad and the Mac follow the same rules.

When `GET /api/version` reports another iroh pair, the app saves it into the same Keychain entry, with the same
account and push key, and drops the pair when the server reports `null`. A reply that came over an older route, or was
sent before another change of the pair, is ignored. A device paired without an address changes only the iroh relay
this way: another EndpointId is another server and takes a new pairing (`rarog devices revoke`, then `rarog pair` or a
code from another device). Pairing such a device again through a link with the same `k` and the same server keeps its
outbox and drafts, also when the app stops halfway through the pairing; a link with only `u` proves nothing about the
server key, so it counts as another server: the warning above, and after Replace the device starts with empty data.

A revoked device shows "Device Revoked" with the server, date, time and cause, also after an app restart,
until it pairs again. "Device Not Recognized" (401 without `device-revoked`) keeps the key and
offers Try Again.

## App build number

The build number (`CFBundleVersion`, the `User-Agent: RarogApp/<build>` header, the value the server compares with
`RAROG_MIN_CLIENT_BUILD`) is the commit count of `HEAD`. One function computes it for every script that builds the
app: `ios_build_number` in `scripts/ios-lib.sh`, from `git -C <repo root> rev-list --count HEAD`. A build from Xcode
alone has number 1. The function refuses before `xcodebuild` (exit 1) in a directory without git, in a shallow clone
(`git rev-parse --is-shallow-repository` prints `true`, the count would be too low; `git fetch --unshallow` fixes
it) and on a `RAROG_BUILD_NUMBER` that is not a number greater than the commit count. So `RAROG_BUILD_NUMBER` only
raises the number, for example to install a build of a tagged commit over a newer build. The same code in a clone
with other history gets another number; set `RAROG_MIN_CLIENT_BUILD` from builds of the same repo.

## App release: TestFlight

The release channel is internal TestFlight: the team's internal testers in App Store Connect, with no beta review.
A store build (two export modes, below) goes to external testers and to App Store review.
A TestFlight build and a development build share the bundle id, so a device holds one of them. The Apple Developer
portal needs the App ID `ai.rarog.app` with Push Notifications and Associated Domains and the App IDs
`ai.rarog.app.widgets` and `ai.rarog.app.notification-service` without capabilities
(`native/Rarog/docs/installing.md`, "Installing on the iPad"), and
App Store Connect needs an app record. The upload (`xcrun altool --upload-package`) sends `--bundle-version` and
`--bundle-short-version-string` from the `Info.plist` of the signed app, so App Store Connect sees the numbers the
build carries. A TestFlight build never uses `RAROG_BUILD_NUMBER`, because the next commit would then repeat
a number App Store Connect holds; a build that Apple rejects in processing uses up its number too.
The app declares `ITSAppUsesNonExemptEncryption = false` (system cryptography only), so a build does not wait in
Missing Compliance. A build expires 90 days after upload, and TestFlight does not open it after that.

**Two export modes.** The default export sets `testFlightInternalTestingOnly`, so the build reaches only internal
testers and App Store Connect does not offer it to an external group or to App Store review. The store export
leaves that option out and is the only way to a build for external testers (Beta App Review) or for App Store
review. Both modes run only from a clean `main` and inspect the signed package before upload. Both check
`CFBundleDevelopmentRegion = en` in the app, the widget and the notification extension, and that the privacy
manifest in the package declares the same required-reason APIs and reasons as
`native/Rarog/Rarog/PrivacyInfo.xcprivacy`, with every API category in both files carrying at least one reason.
Both also run `strings` on the three executables and stop on the marker
`RAROG_TEST_ONLY_RELAY_FAKE`, which only test fakes carry, so a release build holds no fake. The store export also
stops on a string that matches a product name the package must not carry; the pattern skips font glyph names such
as `copilot`. Either
mode can keep the `.xcarchive` in a given directory, for the privacy report Xcode builds from an archive. The app
version (`MARKETING_VERSION`) is `1.1.0` in every build configuration; the build number stays the commit count.

**Push environment.** A TestFlight package, like an App Store package, has no provisioning profile (TN3125), so the
app reports `production`; a build with a profile takes its `aps-environment` (rule:
`native/Rarog/docs/installing.md`, "Installing on the iPad", paragraph "Push (APNs)"). A `production` entry gets push
notifications only through the relay. When a device moves from a development build to TestFlight, the server logs
`push: APNs device entry overwritten (development → production)`, and `apns-devices.json` keeps one entry for it.

**Mac with Apple silicon.** The same build runs on a Mac with Apple silicon as an iPad app (Designed for iPad; Apple
derives the minimum macOS from the app's minimum iOS 26). App Store Connect turns it on, not the app project: Apple
Silicon Mac Availability under Pricing and Availability (it also covers the Mac App Store after release) and, per
TestFlight group, Test iPhone and iPad apps on Apple silicon Macs. On the Mac the app pairs by link, lists sessions
and registers a `production` push entry through the relay. Live Activity is off there, and the device label is
`iPad·Rarog` (`userInterfaceIdiom == .pad`). Unmeasured: notification delivery on the Mac and the QR scanner.

**Rolling back a TestFlight build.** The TestFlight app lists Previous Builds until they expire, so a rollback works
from the second upload on.

## The `rarog` command

`rarog` is the server's CLI: `bin/rarog.mjs`, with the code in `server/src/cli/`. Below Node 22.15, or below 23.11
on the 23 line, it stops with one sentence instead of a stack trace; an odd Node line gets a warning. In a clone it
runs the TypeScript through tsx, as `node bin/rarog.mjs <command>` or `pnpm rarog <command>` from the repo
directory; in the npm package it runs the built JavaScript. `rarog service install` links `~/.local/bin/rarog`, so
plain `rarog <command>` works after it. `rarog help` lists the commands:

- `pair`, `devices`: pairing and revoking devices (below);
- `hooks print|install|doctor` (in a clone also `pnpm run hooks:…`): see `docs/dialogs.md`, "Permission hook";
- `hooks statusline [--chain <command>]`: the `statusLine` block for the status line script, see
  `docs/dialogs.md`, "`statusLine` script from the copy";
- `serve`: starts the server with the environment from `config.json`, see
  `docs/server-config.md`, "Config file and `rarog serve`";
- `restart` (in a clone also `pnpm run restart`): see `docs/server-config.md`, "`rarog restart`" and
  "`rarog restart` on Linux";
- `service install|uninstall`: the launchd service, or the `systemd --user` unit on Linux, see
  `docs/server-config.md`, "`rarog service install|uninstall`";
- `doctor [--port …] [--data-dir …]`: a read-only check line by line, see `docs/server-config.md`, "`rarog doctor`";
- `dialogs off`, `dialogs release <sessionId> [--key <key>]`: the kill switch of the consent channel until the server
  restarts, and releasing a session's channel cards to the terminal, see `docs/server-config.md`, "Preferences and
  feature flags" (`RAROG_CONSENT_CHANNEL`);
- `dialogs last-approval --since <ISO time> [--data-dir …]`: read-only; prints the time of the newest phone
  approval that reached the session since that moment, exit 1 when there is none, see `docs/dialogs.md`, "Channel cycle";
- `setup [--tailscale] [--tailscale-only] [--iroh-relay <https url>] [--data-dir <dir>]`: the install, step by step
  (below);
- `update [--beta] [--data-dir …] [--verbose]` and `update --finish`: the newest version from the npm registry
  (with `--beta` the higher of the `beta` and `latest` tags), then its finish (SDK, hook copy, settings entries,
  restart, check), see `docs/server-config.md`, "`rarog update`";
- `dictation set-key|status`: the Soniox dictation key in the secrets file, see `docs/server-config.md`,
  "`rarog dictation`: the Soniox key";
- `voice-agent set-key|set-model <model>|status`: the voice agent's OpenAI key in the secrets file (`set-key` then
  offers to turn the voice agent on in `config.json` when the Soniox key is there too) and its Realtime model in
  `config.json`, see `docs/companion.md`, "`rarog voice-agent`: the OpenAI key and model".

`pair`, `devices` and `dialogs` talk only to the admin socket `<dataDir>/run/admin.sock`. `<dataDir>` is
`--data-dir`, else `RAROG_DATA_DIR`, else `~/.local/share/rarog` (`$XDG_DATA_HOME/rarog` when `XDG_DATA_HOME` is
set), the server's rule from `docs/server-config.md`, "Data directory"; a directory conflict is a refusal (exit 1)
with a fix command. The socket has mode
`0o600` in a `0o700` directory and appears when the server starts. Run the commands in an ordinary shell of the
server's user, locally or over SSH or mosh: a Claude Code agent sandbox cannot reach the socket, by design.

Exit codes of every command: `0` done, `1` refusal or failure (a sentence on stderr), `2` no answer on the socket,
`64` bad invocation, `130` interrupted (Ctrl-C), `143` and `129` ended by SIGTERM or SIGHUP.

### `rarog setup`: install on a fresh account

Requirements: macOS, or Linux with `systemd --user`; Node 22.15 or newer (23.11 or newer on the 23 line), Claude
Code (`claude`), herdr (on `PATH` or `~/.local/bin/herdr`), `curl`, and on Linux procps and `lsof` or `ss`. Setup
prepares the server for iroh, Tailscale, or both:

- iroh, when the native iroh module is installed (Apple silicon, Linux x64 and arm64): setup turns on the iroh
  listener with the production relay, or your own with `--iroh-relay https://host[:port]/`, and generates the server
  key;
- Tailscale, when `tailscale` is in `PATH`: the HTTPS address comes from `tailscale status`. An Intel Mac has no
  iroh module, so it needs Tailscale.

With both, a first setup in a terminal asks before the plan whether the app connects only through Tailscale
(`? Connect the app only through Tailscale? [y/N]`, two lines above it say what each answer means). Both ways are
encrypted. The standard answer, Enter or "n", keeps iroh, so the app connects from any network; "y" leaves iroh out,
so the app reaches the server only in your tailnet. `rarog setup --tailscale-only` chooses Tailscale only without
the question. Either way the answer writes nothing until `Continue?`. Notifications still go through the push relay
with encrypted content; the choice covers only the connection between the app and the server. An existing
installation keeps its transport: `docs/server-config.md`, "Tailscale only", says how to switch by hand and back.

Without Tailscale the server has no HTTPS address, so the pairing link carries only the iroh fields `k` and `r`,
and the app pairs over iroh (section "`rarog pair`: the first device"). In a clone, run `pnpm install` first.

An installation without an address (iroh only) gets the Tailscale address from `rarog setup --tailscale`: setup
shows the address on a pool port as an item of the plan, adds it to `RAROG_ORIGINS` after "y" (nothing else in
`config.json` changes) and maps it in step 4. The server reads it after `rarog restart`. Devices paired before keep
connecting over iroh; to give them the address, run `rarog devices revoke --all`, then `rarog pair`, and pair the
other devices from the first one's app (Settings → Pairing → Pair New Device). A revoked device loses its unsent
messages and drafts, so send or copy them first.

```bash
rarog setup                                         # iroh and/or Tailscale, from what the machine has
rarog setup --iroh-relay https://relay.example.org/
rarog setup --tailscale                             # the Tailscale address for an existing config.json without one
rarog setup --tailscale-only                        # a new config.json with Tailscale only, iroh off
```

Setup first shows a plan of Rarog's own missing parts (`config.json` with the server key, the hook copy of a clone,
the herdr agent on macOS or the herdr unit on Linux, the Claude SDK of the npm package, the service) and asks once,
`Continue? [Y/n]`; "n" stops it before any write with `Nothing changed.`, and `rarog setup --help` lists the commands
for a step-by-step setup. On a plan whose only item is the herdr agent or unit, "n" declines just that item and setup
goes on. For a new
`config.json` the plan says in one line that the work area is the home folder and which key in `config.json` narrows
it. Then setup walks nine steps: a step that changed something or needs attention gets a line of its own; in a run
that changed nothing the rest get one line, `✓ <n> checks ok, nothing changed`, before the closing check (step 7 is
the herdr unit on Linux and the herdr agent on macOS, and does not run elsewhere); a step that asked a question shows
no time. The details, such as the herdr
socket a step waited for or the backup of a settings file, go to a log file in the data directory, and
`rarog setup --verbose` shows them on the screen instead. Of what exists it changes only Rarog's own entries in `~/.claude/settings.json`
(the hook entries, `statusLine`, the Rarog paths in `sandbox.filesystem.denyRead` and the write block rules in
`permissions.deny`) after one `[y/N/d]` question,
together with herdr's installer for the Claude integration, and adds a missing iroh server key and, after their
questions, the voice keys to the secrets file; for anything else it gives a fix command. What each step writes:
`docs/server-config.md`, "`rarog setup`".

Right above the Settings question, the two voice questions, the iroh key question and the first hidden key prompt of
the run, setup prints a short explanation in plain words, indented like a detail line and cyan on a terminal with
colour: what the answer is for (the phone answers Claude's permission prompts, other settings stay and `d` shows the
change) and, for a key, where to get it (`console.soniox.com`, `platform.openai.com/api-keys`) and that a pasted key
stays hidden and only on this computer. Each fits one line at 60 columns, goes to the run log with its question, and
leaves the screen together with the answered question. `Continue?`, the hook copy, status line script and
`tailscale serve` questions have none, and a run without a terminal asks nothing, so it shows none.

1. Tools: checks Node and the required tools and installs none of them. The check runs before the plan: a first
   setup in a terminal (no `config.json` yet) with a tool missing stops there with one sentence naming the tools
   and a `Fix:` line, and writes nothing; an existing `config.json` or a run without a terminal gets this step's
   report instead. With herdr found, it also reads
   `herdr integration status`: without herdr's Claude integration Rarog sees no session. When the `claude:` line says
   `not installed` or another state than `current`, the Settings question (step 6) also covers
   `herdr integration install claude`.
2. `~/.config/rarog/config.json`, an item of the plan: the transport (iroh with its relay and where the server key
   goes, Tailscale or both) and home as the work area: `RAROG_PROJECT_ROOTS` and `RAROG_HERDR_ROOTS` hold `~`, the
   home directory without its hidden folders and the macOS-protected ones. To change it, edit both keys and run
   `rarog restart`. The Tailscale address gets a port of its own from the pool 8931–8960
   (`https://<host>:<P>`), so a reverse proxy or any other server on port 443 stays as it is: a pool port already
   mapped to this server, else 443 already mapped to it (the address then keeps no port), else the first free port.
   A port mapped by another `tailscale serve` site, one where another server answers on a Tailscale IP, and one that
   cannot be checked are skipped without a question; a server on loopback alone does not take a port. No port left,
   or a failing `tailscale status`, leaves iroh only, with the reason; without the iroh module that is a refusal,
   because no transport is left. With iroh it writes the server key to
   `~/.config/rarog/secret/private.env` before `config.json`, and never prints it; a key already in the file stays. An
   existing `config.json` stays as it is, byte for byte (only `--tailscale` adds an address, step 4), and gets no
   question about voice.
   Before writing a new `config.json` setup asks `? Set up dictation with Soniox now? [y/N]`. After "y" it takes
   the key of a Soniox EU project (the user's Soniox account pays) at a hidden prompt, then asks
   `? Set up the voice agent now (OpenAI key, paid)? [y/N]`: every paired phone pays with this OpenAI key, so it
   belongs to a separate OpenAI project with only Realtime and a budget limit, and each phone asks for consent in the
   app. Both keys go to the secrets file, and with both `config.json` gets `RAROG_COMPANION=1`; a key already in the
   file is not asked for. "n" or an empty key leaves that feature off, and its outcome line ends with the command
   that sets it up any time: `rarog dictation set-key` (the voice agent: `rarog voice-agent set-key`, after
   dictation). The app's Settings → Dictation and Settings → Voice Agent show where to get each key; the key itself
   goes in on the Mac. Ctrl-C ends setup with nothing written. The same commands change a key.
3. `~/.config/rarog/secret/private.env` (directory 0700, file 0600): checked. Without iroh it is optional;
   step 2 or `rarog dictation set-key` saves the Soniox dictation key (`SONIOX_API_KEY`) in it, step 2 or
   `rarog voice-agent set-key` the voice agent's OpenAI key (`OPENAI_API_KEY`). With `RAROG_IROH=1` in an existing
   `config.json` and no key in the file, setup asks whether to generate the key.
4. `tailscale serve --bg --https=<P> <port>`: tailnet HTTPS on pool port P to the server port; not used without a
   Tailscale address. Setup runs it after a question, only for an address taken in this run, and right before the
   command checks P again: a mapping made meanwhile, another server on P or a port that cannot be checked now leaves
   it not run. Mappings on other ports stay as they are. An address already in `config.json` without its mapping
   gets the command in `Fix:`. With `--tailscale` this step first writes the address of the plan item, then maps
   it; this machine's address already in `config.json` on a pool port (a run cut short after the write) gets the
   question too.
5. The permission hook copy in `~/.claude/hooks/rarog/` (`docs/dialogs.md`, "Permission hook"): a missing copy is an
   item of the plan in a clone; in the npm package setup first prints the copy's diff against the package and asks.
   A copy that differs from the source (after `npm update` or a new commit in `scripts/hooks/`) gets the update
   `rarog hooks install` does, with the same checks: in a clone setup prints `git log <copy commit>..HEAD --
   scripts/hooks` and asks, in the npm package it prints the copy's diff and asks. A copy changed after its
   installation (a hash that differs from its manifest) gets the doctor's warning and no question. After "n" or
   without a terminal the copy stays, and the summary points at `rarog hooks doctor` and `rarog hooks install`; on
   the screen "n" to the install or the update is `! Hook copy  declined` with `Fix: rarog hooks install`.
6. Settings: one question for Rarog's five entries in `~/.claude/settings.json` and, when step 1 found it
   missing, herdr's session hook: "Add 5 Rarog entries and herdr's hook to ~/.claude/settings.json? [y/N/d]". `d`
   shows the names of the entries, Rarog's diff and a sentence about herdr's entry, then asks again.
   "y" writes Rarog's entries in one write with one
   backup, then runs `herdr integration install claude` (no shell, 30 s limit; herdr 0.9.5 writes a hook script in
   `~/.claude/hooks/` and its own `SessionStart` entry). A herdr error after Rarog's write is a `!` line with
   `Fix: herdr integration install claude`; Rarog's entries stay. "n" writes nothing and points at
   `rarog hooks print`, which prints all five entries. An installation that has every other entry gets the question
   for the missing one alone. The entries:
   - the permission hook and the context hook (`SessionStart`, section "What Rarog needs from Claude Code
     configuration");
   - `statusLine`: the command pointing at the status line script copy in `~/.claude/hooks/rarog/`, from which the
     app takes plan usage limits and context size. A custom command that writes the snapshots itself (one in
     `~/.claude/statusline/` from the last hour) stays as it is; any other custom command is chained behind the Rarog
     script, keeps its output on the status line and gets the same payload on stdin, and the question says so
     (`docs/dialogs.md`, "`statusLine` script from the copy"). Other fields of `statusLine`, such as `padding`, stay;
   - `sandbox.filesystem.denyRead`: the two Rarog paths, `~/.config/rarog/secret` and `<dataDir>/run`, so agent
     sessions read neither the secrets nor the admin socket;
   - `permissions.deny`: the write block rules `Edit(//<dataDir>/**)` and `Edit(//<home>/.config/rarog/**)` for the
     data directory of the installed service, so a Claude Code session that loads these settings does not write
     the Rarog state, also when it started in `~` (what they cover and their limits: `docs/security-model.md`,
     "Pairing and device keys"). The cost: a session does not edit `~/.config/rarog/config.json` either; edit it in
     your own terminal. A data directory whose path has a character that permission rules read as a pattern gives
     no rule, and the step says so.
7. Linux only: when herdr is not running and there is no `herdr.service` unit, the unit is an item of the plan
   (`herdr.service  ~/.config/systemd/user`), with no question of its own. "y" to the plan writes the file but does
   not enable it: `Fix: systemctl --user enable --now herdr.service` starts herdr now and at each login, and the
   Service step waits for this step instead of a second fix. With herdr
   already running it is not in the plan. The unit's `PATH` holds the `claude` and Node directories, because a herdr
   pane inherits `PATH` from the herdr server and `systemd --user` does not read `~/.profile`. An existing unit, also
   one in another directory the manager reads units from, counts once enabled and active.

   macOS: without the herdr agent (section "The `ai.rarog.herdr` herdr agent"), the agent is an item of the plan
   (`herdr agent  ~/Library/LaunchAgents`), with no question of its own. "y" to the plan writes the file and, with
   herdr not running, loads it, which starts herdr: `✓ herdr agent  herdr started`. With herdr already running "y"
   only writes the file, and the agent starts herdr from the next login. An existing agent gets a check and is not in
   the plan. An agent that leaves herdr down carries the one fix, for example `Fix: launchctl kickstart
   gui/<uid>/ai.rarog.herdr, then rarog setup`, and the service step waits for it.
8. The Claude SDK (section "Claude SDK"), an item of the plan: the package downloads the pinned version; a clone has
   it from `pnpm install`. A failed download says `check the network`; a node with no npm next to it (one from
   `pnpm env use`) says to install Node with npm instead.
9. The service (`rarog service install`), an item of the plan, once herdr runs and, in the npm package, the SDK is in
   place; otherwise it waits for the step that did not finish (`– Service  waits for Claude SDK`). When the herdr
   socket does not answer and the herdr step (agent or unit) has a fix, the service waits for that step
   (`– Service  waits for herdr agent`); otherwise setup says to start herdr and run `rarog setup` again.

When the service starts an installation other than the one running setup (a clone instead of the package, or the
reverse) or its target is unreadable, step 5 does not write the hook copy or the script copy and says why. Without a
hook copy that matches its source, step 6 leaves out the hook entries, and without a matching script copy
`statusLine`; an entry in conflict drops out with its own `!` line and `Fix:`, and the rest goes in.

Each problem has one `Fix:`; a step that waits for another one names it without a command. Last comes a check of
the server instead of a full `rarog doctor`. A running service gets up to 30 s for a healthy `/health`: `✓ Check`
lists the fields (hook, SDK, herdr, consent channel), a server still on an older version says `! Check  server runs
<version>` with `Fix: rarog restart` for an npm package and `Fix: rarog service install` for a pnpm package (section
"Install from the npm registry"), and no answer is `✗ Check` with `Fix:` and `Log:`. Without a running service the
check waits for the step that carries the fix (`– Check  waits for Service`). When a new terminal may not find
`rarog` (the package's commands directory is outside `PATH`, or under nvm, fnm or volta, which can start a new
terminal on another Node version), the `Fix:` lines and the pairing command use the absolute command
(`'<node>' '<package>/bin/rarog.mjs' <command>`); a command wider than the screen stands alone on its line, so it
copies whole. Each `✗` line has one sentence, a `Fix:` and a `Log:` line with the run log. The screen ends with
`Done in N s.` and, only when the run ends with exit code 0 (a green check and no `✗` or `!` line before it) while no
device is paired, `Next: rarog pair (QR code for the app)`. Exit code 0 under `!` lines ends with `Done in N s;
1 step above needs a fix.` instead. A second setup with nothing to do and no paired device:

```
 ✓ 9 checks ok, nothing changed
 ✓ Check          hook · SDK · herdr · consent ok

Done in 14 s. Next: rarog pair (QR code for the app)
```

Exit 0 means every step is in place, and `rarog pair` is the last step. Without a terminal setup only reports and
writes nothing, and Ctrl-D answers no. A server started with `rarog serve --data-dir <dir>` needs
`rarog setup --data-dir <dir>`, because the SDK lives in the data directory.
Under `npx` or `pnpm dlx` the package's setup and `service install` refuse and name the permanent install
(`npm i -g @rarog/server` or `pnpm add -g @rarog/server`). The package's setup writes the update command of the
manager that installed it (`npm i -g @rarog/server@latest`, then `rarog restart`, or
`pnpm add -g @rarog/server@latest`, then `rarog service install`) to its log, and with
`--verbose` to the screen; a version number instead of `latest` rolls back.

### The `ai.rarog.server` service and its removal

`rarog service install` installs or reinstalls the service. It first checks everything without stopping
anything (including `rarog serve --check` through `service.wrapper`), then swaps the running service for the new one
on the same data directory, so the server keeps its `serverId` and devices. A flag change needs no reinstall: edit
`~/.config/rarog/config.json`, then `pnpm run restart` in a clone or `rarog restart` in the npm package
(`docs/server-config.md`, "Config file and `rarog serve`").

Removal, also to break a `KeepAlive` loop after a bad start (data and config stay):

```bash
rarog service uninstall
# without the rarog command:
launchctl bootout gui/$UID/ai.rarog.server
rm ~/Library/LaunchAgents/ai.rarog.server.plist
```

In the npm package `rarog service uninstall` then removes Rarog from Claude Code, each part after a question.
First it shows the diff that takes Rarog's entries out of `~/.claude/settings.json` and asks `[y/N]`: the
permission and context hook entries, Rarog's `statusLine`, the two `denyRead` paths and the two write block rules
from `rarog setup`. It is
the same writer as in setup, with a backup in `<dataDir>/claude-settings-backup/` (`docs/dialogs.md`, "Writing the
hook entries"). Other hook entries and a `statusLine` of your own stay; when Rarog's `statusLine` wraps your
command, your command goes back in its place. With no Rarog entries left, it shows which files of the copy directory
`~/.claude/hooks/rarog/` go (only names from a closed list in the code) and which stay, asks, and removes those
files, then the directory when nothing else is left. A directory whose manifest does not prove it is a Rarog copy
(the manifest lists only names from that list, and at least one listed file has the recorded sha256) stays
untouched. When the path stops leading to the directory from the question, removal stops and says what is left. An
answer "n", no terminal, or a conflict (an entry that looks like Rarog's but is not one Rarog printed) leaves the
file as it is and prints the manual steps instead: the blocks and paths to delete from the file,
then the copy directory. The same steps follow when a Rarog entry is back in the file at the moment of removal; the
copy then stays. The rest stays printed: the manager command
`npm uninstall -g @rarog/server` or `pnpm remove -g @rarog/server` (npm runs no package scripts, so nothing does
the steps before it for you) and, optionally, `rm -r` of the data directory and `~/.config/rarog`. The data
directory enters that command only when it has `sdk/` and lies under the home directory; otherwise `uninstall` prints the bare path to
check. It also holds the settings backups, and the step names the backup from this run. Without that last step the
data directory stays, with its devices. In a clone `uninstall` removes the `~/.local/bin/rarog` symlink
when it points to this clone and prints only the reinstall command, because the hook stays with the checkout.

### The `ai.rarog.herdr` herdr agent

On macOS `rarog setup` lists the LaunchAgent `ai.rarog.herdr` (`~/Library/LaunchAgents/ai.rarog.herdr.plist`, step
7 of setup) in its plan, so that herdr runs after a restart of the Mac without a terminal. At each login launchd starts
`herdr server` once; it never restarts it. herdr's output goes to `~/Library/Logs/rarog-herdr.log`. What setup
writes and checks: `docs/server-config.md`, "`rarog setup`".

- A herdr started by hand before the agent (`herdr` in a terminal) keeps running: the agent's `herdr server` exits
  with code 1 and launchd does not try again.
- `herdr server stop` stops herdr until the next login. To start it before that: `launchctl kickstart
  gui/$UID/ai.rarog.herdr`, or `herdr` in a terminal. `rarog doctor` and `rarog setup` print the `kickstart` command
  while the agent is loaded and herdr is not running.
- herdr runs in the login session, so logging out ends herdr and the programs in its panes, as a restart of the Mac
  does. At the next login the agent starts herdr again and the panes come back, but the interrupted work does not.
- At the first start from the agent macOS asks once for each protected folder herdr's panes open (Documents,
  Desktop, Downloads, iCloud Drive) whether herdr may use it; until the answer a pane in that folder waits. The
  answer stays in System Settings, Privacy & Security, Files and Folders, also after a herdr update at the same path.
- System Settings, General, Login Items lists the agent as "herdr" under "Allow in the Background" until its plist is
  removed.

Removal (`rarog service uninstall` leaves the agent and prints the same two commands):

```bash
rm ~/Library/LaunchAgents/ai.rarog.herdr.plist   # no start at the next login; the running herdr stays
launchctl bootout gui/$UID/ai.rarog.herdr        # unload at once: stops herdr and closes its panes
```

### `rarog pair`: the first device

```bash
rarog pair
```

The server issues a code (5 minutes, single use), and `rarog pair` draws a QR code and prints the link
`https://rarog.ai/pair#v=1&u=<server url>&c=<code>`, a universal link that iOS opens in the app. The address is the
first `https://` origin of `RAROG_ORIGINS` or `--url https://…` (a non-https address gets a warning: the app refuses a
link whose address is not https, also one with `k` and `r`). The data sits in the URL fragment, so a browser never
sends the code to `rarog.ai`. The app also reads the same fragment after `rarog://pair#`.

The iroh listener (`RAROG_IROH=1`) lets the app reach the server over iroh, a peer-to-peer transport; see
`docs/server-config.md`, "iroh listener". With it the link also carries the server's EndpointId and relay,
`&k=<EndpointId>&r=<relay>`; an EndpointId or relay in the wrong shape gives a warning and a link without them.
Without an address the link has only `k` and `r`, and the app pairs over iroh ("Pairing from the app"). `rarog pair`
refuses (exit 1) only when the server has neither an address nor the iroh listener: "The server does not know its
address (RAROG_ORIGINS) and does not listen on iroh; give the address: rarog pair --url https://…". Link fields:
`docs/implementation-spec.md`, "Pairing link".

Then `rarog pair` waits for the new device's FIRST authenticated request and ends with one of:

- `Paired: iPhone·Rarog (<deviceId>)`: the device used the code and connected with its key;
- `Code used by "…"; waiting for the first connection (up to 10 min)…`, then after 10 minutes
  `Device … did not connect within 10 min of pairing …`: the pairing reply got lost; the record expires on its own,
  and running `rarog pair` again is enough;
- `The code expired or a newer one took its place`: 5 minutes passed, or another `rarog pair` ran;
- `The server no longer knows this pairing` or `The server stopped responding`: the server restarted during the
  pairing, and codes live only in memory, so start again with `rarog pair`;
- `pairing code cancelled`: Ctrl-C, SIGTERM or a closed terminal while it waits cancels the code on the server, and
  the command exits with 128 + the signal number (130 for Ctrl-C). Without an answer within 2 s the line is
  `could not cancel the pairing code; it expires at HH:MM`; a code used right at that moment leaves the device paired
  (the line points to `rarog devices`).

With at least one active device (not revoked, not expired) `rarog pair` refuses: "The server already has a paired
device; pair new ones from the app: Settings → Pairing → Pair New Device." The code then comes only from a paired
device (`POST /api/pairings`).

**After a relay change.** An app that still reaches the server takes a new `RAROG_IROH_RELAY` from
`GET /api/version`. A device that reaches the server only over iroh (a link without `u`) and no longer gets through
gets the new relay only from a new pairing link. `rarog pair` refuses while any device is active, so revoking one of
several is not enough; the refusal names both ways out:

- an app still reaches the server: pair the other devices from it (Settings → Pairing → Pair New Device); its link
  carries the current relay;
- no device reaches the server: revoke them all, pair the first with `rarog pair` and the rest from its app. The
  server key stays, so the new link has the same `k` and the new `r`:

```bash
rarog devices revoke --all
rarog pair
```

### `rarog devices`: list and revoke

```bash
rarog devices                 # active devices and the most recently revoked
rarog devices revoke <deviceId>
rarog devices revoke --all
```

Each device shows id, label, pairing date, code creator (`with a code from the Mac` for a code from `rarog pair`,
the same text on Linux, or the `deviceId` of the issuing device), last use (`no connection yet` before the first
request) and app build. Up to 10 recently revoked devices follow, with date and cause (`admin`, `forget`,
`expired`). The warning `authStore: broken` opens the list when `devices.json` and its backup were unreadable at
start. A revoke acts at once, without a restart: the device
gets 401 `device-revoked`, its SSE streams and emergency consoles close, and its APNs tokens and unused pairing
codes are dropped.
The same revoke covers every active device paired through it (with its code, or with a code from such a device),
and the CLI lists them with their pairing date. Forget Server in the app revokes only the device itself.

### Lost the only phone

```bash
rarog devices revoke --all
rarog pair
```

With every device revoked the admin socket issues codes again, so the new phone pairs as the first one. Whoever runs
these commands cannot hide it: every revoked device shows `device-revoked` with the date on its next connection, so
the owner of a device learns of the revoke (guarantee boundary:
`docs/security-model.md`, "Pairing and device keys"). `RAROG_AUTH_EPOCH` revokes all devices at once (emergency
runbook in `docs/security-model.md`).

## Install modes and the CLI module map

The server and `rarog` run from a repo clone (tsx runs the `.ts` sources, and the install root is the repo) or from
the npm package (JavaScript from `pnpm run package`, and the root is the package directory).
`server/src/install/mode.ts` derives both from its own URL: `.ts` means mode `clone`, `.js` means mode `package`,
and the root is three levels above `server/src/install/`.

Repair commands in messages follow the mode: in a clone `pnpm run …`, `pnpm install` and
`node bin/rarog.mjs <command>`; in the package `rarog <command>` and, for dependencies (the native iroh module too),
the update command of the manager that installed it. The layout tells the manager: npm installs into
`<prefix>/lib/node_modules/@rarog/server`, pnpm 11 into its store
(`…/links/@rarog/server/<version>/…/node_modules/@rarog/server`), and any other layout gets both commands. npm
commands carry `--prefix <prefix>`, because `npm -g` alone uses the prefix of the current shell's Node (another nvm
version, Homebrew) and would change another installation.

Module map (paths under `server/src/`):

- `install/mode.ts`: `INSTALL_MODE`, `INSTALL_ROOT` and the root's `package.json` (the version for `version.ts`);
- `install/repair.ts`: the repair commands of both modes, for `rarog`, the server and `scripts/restart.sh`;
- `install/service-target.ts`: the entry and the service argv (wrapper, node, `<root>/bin/rarog.mjs`, arguments),
  the source of the launchd plist, the `systemd --user` unit and `serve --check`; `rarog restart` and `rarog doctor`
  compare the service's node and entry with this installation (one rule in `cli/restart.ts`). The module also
  detects a package run from the `npx` cache or by pnpm;
- `install/data-dir.ts`: the data directory for `setup`, `restart` and `doctor` (the flag, the installed service, or
  the rule applied to the service environment, with the mismatch against the shell; `docs/server-config.md`,
  "`rarog setup`");
- `install/sdk.ts` with `sdk-probe.ts`, `sdk-package.json` and `sdk-lock.json`: the Claude SDK;
- `install/evidence.ts`: facts about npm, pnpm and install layouts (section "After an npm or pnpm update");
- `cli/main.ts` routes commands, `cli/io.ts` carries streams, environment and exit codes, `cli/lock.ts` locks the
  commands that change server state or the secrets file, and each command has a module: `devices.ts`, `dialogs.ts`,
  `hooks.ts`, `serve.ts`, `restart.ts`, `service.ts` (with `systemd-unit.ts` and `templates/`), `doctor.ts`, `setup.ts`
  (with the plan screen `setup-plan.ts`, the step modules `setup-config.ts`, `setup-secrets.ts`, `setup-transport.ts`
  with its port check `setup-tailscale-port.ts`, the Tailscale only choice `setup-tailscale-only.ts`,
  `setup-settings.ts`, `setup-herdr-unit.ts`, `setup-herdr-agent.ts`, the voice questions `setup-voice.ts` and their
  shared `setup-context.ts`), `names.ts`, `dictation.ts` and
  `voice-agent.ts` (both with `secrets-file.ts`: one secret written into the secrets file under that lock, also the iroh
  server key of `rarog setup`, and `secret-input.ts`: the question without echo and the whole of standard input;
  `voice-agent.ts` rewrites `config.json` through `config-rewrite.ts`).

`scripts/restart.sh` gets its hook repair sentence from `rarog restart` in `RAROG_RESTART_HOOK_REPAIR` and prints it
when `/health` reports `hook: stale`, that is, when the hook copy in `~/.claude/hooks/rarog/` differs from the
installation's `scripts/hooks/` (`docs/server-config.md`, "`rarog restart`"). It spells out commands itself only in
refusals and
in the `nohup` start of `bin/rarog.mjs serve`.

`server/test/install-guard.test.ts` enforces four rules: `import.meta` appears only in `install/`; repair commands in
strings (clone commands, `npm i -g`, `npm uninstall -g`, `pnpm add -g`, `pnpm remove -g`) only in
`install/repair.ts`; a `.ts` literal in `new URL(…, import.meta.url)` or a `new Worker(…)` path only in `install/`;
and `install/` imports only `node:*`, `@rarog/shared` and its own modules. The exceptions (the native iroh module
resolution in `iroh/adapter.ts`, listed `restart.sh` lines, the SDK package in `install/sdk.ts`) have reasons, and
one without a hit fails the guard.

## npm package

`pnpm run package` (`scripts/package.mjs`) builds, from the tree it runs in after `pnpm install`, the tarball
`rarog-server-<version>.tgz` and the build manifest `rarog-server-<version>.build.json` (files with sha256 hashes,
included packages with licenses, tool versions), into `--out` outside the source tree or into a new temporary
directory. The package is `@rarog/server` with the command `rarog`; the `name` of the root `package.json` (`rarog`,
the private workspace root) does not reach it. `--version` and `--name` set those package manifest fields, and
`--dry-run --json` prints the build manifest only. The registry page fields `description`, `keywords`, `homepage`,
`bugs` and `repository` come unchanged from the root `package.json`.
The packer refuses when `build/` exists, creates it and deletes it at the end. Two builds of one tree give the same
tarball.

The package carries the JavaScript of `server/src` and `shared/src` in the repo layout
(`tsc -p tsconfig.package.json`, no type check), the files the server reads at run time (`bin/rarog.mjs`,
`scripts/hooks/`, `scripts/restart.sh`, `server/src/cli/templates/`, `server/src/install/*.json`, `LICENSE`,
`THIRD-PARTY-NOTICES`, `README.md`) and `@rarog/shared` in `node_modules/`. Any other file in `server/src` or
`shared/src` without a packing rule is a refusal. Production dependencies:

- in the tarball (`bundleDependencies`): `qrcode`, `ws`, `zod` and `@rarog/shared` with their trees, materialized
  with `pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --ignore-scripts`. A license outside MIT,
  ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 and 0BSD, a missing license file, a symlink or a platform package is a
  refusal;
- from the registry: `@number0/iroh`, pinned, because its native module comes in a platform package;
- clone only: tsx;
- never in the package: `@anthropic-ai/claude-agent-sdk` (section "Claude SDK").

A tarball installs with `npm i -g ./rarog-server-<version>.tgz` or `pnpm add -g ./rarog-server-<version>.tgz`.
npm 10 (shipped with Node 22, measured on 10.9.9) ignores `os` and `cpu` of platform packages in a package with
`bundleDependencies` and installs all 11 iroh packages (about 180 MB instead of 12 MB), with an `EBADENGINE`
warning from `engines.npm` `>=11`; so on Node 22 run `npm i -g npm@11` first. npm 11 and pnpm install one platform package.

In the package `bin/rarog.mjs` loads `server/src/cli/main.js` without tsx, and `rarog serve` does an `execve` of the
same node with `server/src/index.js`. The server is then the one process that the stop pattern
`node server/src/index.js` in `scripts/restart.sh` looks for (only with the working directory in the package).
`serve --check` probes the iroh module with `server/src/iroh/module-probe.js`. `server/test/package-build.test.ts`
runs the packer on a fake tree with real emit and `npm pack`.

### Package release

Only the workflow `.github/workflows/publish.yml` publishes to the npm registry, and only the package
`@rarog/server` (its `name` input has no other value, and the workflow refuses any other): it builds and audits the
tarball from the release tag and sends it with `npm stage publish` and an OIDC token, and the staged version waits
until the package owner approves it (`npm stage approve` with 2FA; `docs/publishing.md`, "Publishing the npm package").
The package version equals `version` in `package.json` and the tag `v<version>`. Attestation check:

```bash
npm view @rarog/server@<version> dist.attestations
npm audit signatures        # in a project with @rarog/server@<version> among its dependencies
```

### Install from the npm registry

```bash
npm i -g @rarog/server   # npm 11 or newer; on Node 22 run npm i -g npm@11 first
pnpm add -g @rarog/server
rarog setup
```

Setup in the package walks the same steps as in a clone: it downloads the SDK in step 8 and installs the service in
step 9, both items of its plan screen. An update is `rarog update`: it installs the newest release from the registry
with npm and finishes it (`docs/server-config.md`, "`rarog update`"). `rarog update --beta` installs the higher of the
newest beta and the newest release (the npm dist-tags `beta` and `latest`); without the flag a beta is never
installed, and an installed beta stays until a release above it appears. A rollback is the manager command with a
version number (`npm i -g @rarog/server@0.1.0`), then `rarog update --finish`; an uninstall starts with
`rarog service uninstall`. `rarog update` updates only the package `@rarog/server`, and only with npm. In an
installation of another package with the `rarog` command it refuses without asking npm and names the uninstall of
that package, then the install of `@rarog/server`, then `rarog service install` and `rarog update --finish`: npm
refuses a new package whose command another package of the prefix owns, and only `rarog service install` points the
service at a package installed by hand. With pnpm the update is `pnpm add -g @rarog/server@latest`, and because the pnpm package path holds
the version, the service still points at the old path after every pnpm update or rollback:
`rarog update --finish` and `rarog restart` refuse and name `rarog service install`, which points the service at the
new version. Without write access to the global prefix (Node
from a system installer) `npm i -g` fails with `EACCES`, and npm recommends a Node version manager or a prefix in
the home directory (docs.npmjs.com,
"Resolving EACCES permissions errors when installing packages globally").

With a release age gate (npm `min-release-age`, pnpm `minimumReleaseAge`) a new version installs N days after its
publication; until then the version before it or a clone serves. When the gate holds a version back, `rarog update`
names the day npm lets it in (`rarog <version> is <n> days old; npm installs it from <YYYY-MM-DD>`): the earliest
published version above the installed one that the registry still has, its time from
`npm view @rarog/server time versions` plus the days of `npm config get min-release-age -g` of the same npm, as a UTC
date. With `before` set, or when either value cannot be read, the warning has no date. A clone is also the
contributor's path: `pnpm install` in a checkout, and the server runs from TypeScript through tsx.

### Server update indicator

The app knows the server version it ships with: `ServerRelease.version` in
`native/Rarog/Packages/RarogCore/Sources/RarogCore/ServerRelease.swift`. It compares this value with `version` from
`GET /api/version` by semver: `major.minor.patch`, then a pre-release (`1.0.0-rc.1`) is lower than the release, and
`+…` is ignored. When the server is lower, the list footer shows the row "Server update available" in link ink. A
tap opens the update steps (`ServerUpdateSheet`; a popover beside the detail, a sheet in the stack): both versions,
where to run the command (Mac or VPS), the command on its own line with a copy button, and what it does. The Usage
sheet's machine section names the same command. The command is `ServerRelease.updateCommand(server:release:)`, and
it follows the channel of the app's own `ServerRelease.version`:

- Stable app: `rarog update` for a server from version 0.1.1 on (only `major.minor.patch` is compared, so
  `0.1.1-local.…` counts), `npm i -g @rarog/server@latest && rarog update` below it.
- Beta app (`ServerRelease.version` is `X.Y.Z-beta.N`): `rarog update --beta` for a server from `1.1.0-beta.1` on
  (the first version with the flag; the whole version is compared, so `1.1.0-beta.0` is below and
  `1.1.0-beta.1.local.…` counts), `npm i -g @rarog/server@beta && rarog update --finish` below it. Below the
  threshold npm installs the beta, because the older `rarog update` does not know `--beta`; the new package's
  `rarog update --finish` then does the setup and the restart.

The refusal for an older protocol (`CoreCopy.updateServer`) does not know the server version, so it always shows the
full chain of the app's channel (`ServerRelease.unknownServerCommand`):
`npm i -g @rarog/server@latest && rarog update` in a stable app,
`npm i -g @rarog/server@beta && rarog update --finish` in a beta app. An equal or newer server, a missing field or
an unreadable value (a `v` prefix, a leading zero in a number of the core or the pre-release, such as `1.01.0` or
`1.0.0-rc.01`) show nothing. The app makes no request for this beyond the version probe it already sends, so a new
server release shows up only after an app update. The next probe after `rarog restart` removes the row; a server
switch and a logout remove it at once.
With pnpm or a clone the update is the pnpm command above or `git pull` and `pnpm install` in the clone.

A release that changes `version` in `package.json` changes `ServerRelease.version` in the same commit:
`server/test/wersja-apki-i-serwera.test.ts` fails when the two differ.

### From clone to package

The move keeps the data directory and config, so paired devices stay:

```bash
node bin/rarog.mjs service uninstall   # in the clone: service and the clone's rarog symlink removed, data and config stay
npm i -g @rarog/server
rarog setup
rarog doctor
```

The hook entries and `statusLine` stay, because they point at the copy in `~/.claude/hooks/rarog/`, not at the
clone. For a hook copy from the clone that differs from the package, setup (like `rarog hooks install`) shows the diff
and writes the package's copy after a question (the copy's manifest then carries the package `version` instead of the
clone's `commit`). While the service starts the clone, both refuse unless the copy already has the package's bytes; see
`docs/dialogs.md`, "The copy is written by the installation the service starts". `rarog doctor` warns when another
installation's symlink comes before the package on `PATH`. The move is unverified on a live installation.

### Clone next to the package

When the service runs the npm package, a clone on the same account is not its target: `pnpm run restart` from the
clone refuses without stopping anything, and `doctor` shows a red service line. Both print the package's commands
with the node and entry from the service file, which work from any directory without `PATH`:

```bash
'<node>' '<package>/bin/rarog.mjs' restart           # restart the service from the package
'<node>' '<package>/bin/rarog.mjs' service install   # point the service back at the package
```

Clone code reaches the service as a package: `node scripts/package.mjs --out <dir>` in the clone, an install of the
tarball, then `rarog setup` and `rarog restart` (with pnpm `rarog service install` instead of `rarog restart`,
because the pnpm package path holds the version; section "Install from the npm registry").

`node bin/rarog.mjs service install` from the clone switches the service to the clone only after a `[y/N]` question
in a terminal; without a terminal it refuses before any check. The question lists what changes (entry, node,
`service.wrapper`, data directory, the `~/.local/bin/rarog` symlink, a restart), what stays (devices, `config.json`,
hook copy) and the command back to the package, which also undoes the symlink change (`ln -sfn`). A service file
from which the clone cannot read a target gets the same question, with the reason and no command back. A service on
another clone or on a deleted installation switches without a question. The switch is unverified on a live
installation.

## Claude SDK

The Recent Sessions list comes from `listSessions` in `@anthropic-ai/claude-agent-sdk` (the Claude SDK,
`server/src/session-list.ts`), which reads the CLI store on disk (`~/.claude/projects/`); Rarog calls nothing in it that
runs a conversation. The SDK is under Anthropic's terms (`code.claude.com/docs/en/legal-and-compliance`), not
Rarog's MIT license, so the npm package does not carry it.

A clone gets the SDK from the workspace (`pnpm install`, version in `server/package.json`). The package carries only
the pin: `server/src/install/sdk-package.json` (name, `private`, exact version) and `sdk-lock.json` (an npm lockfile
with `integrity` and `registry.npmjs.org`), both generated by `node scripts/sdk-lock.mjs`.
`server/test/sdk-pin.test.ts` checks them against `server/package.json` and `pnpm-lock.yaml`.

`rarog setup` (step 8) downloads the pinned version into `<dataDir>/sdk/<version>/` as an item of its plan screen, which
names the version, the size and Anthropic's terms, with the terms link alone on the next line, before
`Continue? [Y/n]`. It runs `npm ci` in `<dataDir>/sdk/.tmp-*` with the
npm next to its node (`npm-cli.js`), no install scripts, no optional dependencies (they carry the Claude Code
executable), a time limit, and only the registry, cache, config, proxy and certificate `npm_*` variables of the caller.
The directory becomes the version directory only when `node_modules` holds exactly the pinned SDK and a `listSessions`
probe in a separate process with the service environment passes. `sdk/` and the version directories have mode 0700; no
code runs from a directory with other modes, another owner or a symlink, and setup never changes or deletes an existing
version directory. Offline, `npm ci` fails and setup prints npm's first error; the service then waits, because setup
does not install it without the SDK and `rarog serve --check`, `rarog restart` and `rarog service install` refuse with
the full path and `rarog setup`.

At start the server loads the SDK once, before `listen()`, by an explicit path inside the version directory (checked
after `realpath`, so a copy in a `node_modules` above the package does not count), and probes `listSessions` on an
empty directory. The state goes to the start log, the `sdk` field of `/health` and the SDK line of `rarog doctor`:

- `ok`: the pinned version works (in a clone, the workspace version);
- `stale`: the pinned version is missing and the newest other version in `sdk/` works (for example after a package
  update without `rarog setup`);
- `missing`: no version in `sdk/` (also in the demo, which does not load the SDK);
- `error`: the import or the probe failed.

Every state ends in `listen()`, so sessions, dialogs and the emergency console work. Without the SDK the app shows
an empty Recent Sessions list with no message; `/health` and `rarog doctor` give the reason, and `rarog setup` with
`rarog restart` fixes it. Other versions in `sdk/` stay, because a running server may read them; `rarog doctor` lists
them with their size.

Tests: `server/test/sdk-boundary.test.ts` (the package name in value position only in `server/src/install/sdk.ts`,
only `listSessions` leaves that module, and the function's contract on an empty and on a controlled store with
`CLAUDE_CONFIG_DIR`), `server/test/install-sdk.test.ts` (the download on a fake `npm-cli.js`) and
`server/test/sdk-install-live.test.ts` (the real registry, only with `RAROG_TEST_NETWORK=1`).

## After an npm or pnpm update

`server/src/install/` rests on measured facts about package managers: the `npm ci` flags that install one package,
where `npm-cli.js` sits next to node (nvm, Homebrew), the `_npx` segment of the `npx` cache, `npm_config_user_agent`
from pnpm, the global package directories of npm and pnpm, and the Homebrew `opt/<formula>` symlink through which
the service points at a Homebrew node. The registry `server/src/install/evidence.ts` holds these facts with the
versions they were measured on, and the code reads its values from it. Measured on npm 11.20.0 and 12.2.1 (Node
22.22.3, 24.11.1, 26.10.0) and pnpm 11.4.0. After a new npm or pnpm major version, before a package release:

1. `node scripts/sdk-lock.mjs` in a clean clone leaves the lockfile unchanged (`git diff server/src/install/`).
2. `RAROG_TEST_NETWORK=1 pnpm test server/test/sdk-install-live.test.ts` passes on the new npm.
3. Setup and `service install` from the tarball refuse under `npx` and `pnpm dlx`.
4. After `npm i -g` and `pnpm add -g` of the tarball, the `realpath` of the package directory matches a layout in
   `evidence.ts` (`globalLayouts`).
5. New versions and numbers go to `evidence.ts`, and a behavior change goes to the code that uses the fact.

## Check without the app (`curl`)

For a server diagnosis, pairing works without the app. Run `rarog pair` in one window; in another (an
SSH client on the iPad, for example) take the code (`c=`) and the decoded server address (`u=`) from the link:

```bash
curl -s -X POST -H 'Origin: https://<host>' -H 'Content-Type: application/json' \
  -d '{"v":1,"code":"<code>","label":"curl"}' https://<host>/api/pair
curl -s -H 'Authorization: Rarog-Device <deviceId>.<secret>' https://<host>/api/devices/me
```

The first request returns `deviceId`, `secret` and `pushKey` ONCE. The second is the first authenticated request,
so `rarog pair` ends with `Paired`. The secret stays in the shell history and on screen, so revoke the device after
the check: `rarog devices revoke <deviceId>`.

## Files in `dataDir`

`devices.json` (device keys, mode `0o600`, the persistent `serverId`), its backup `devices.json.bak`, the admin
socket `run/admin.sock` and, only in a consent channel mode that needs hook registration, the registration socket
`run/consent.sock` (the hook's routes `POST /register` and `POST /claim`; `rarog` commands do not use it). Deleting these files
with the server STOPPED is safe: the next start creates a new `serverId` and the sockets, and every device pairs
again. The npm package also keeps `sdk/<version>/` here (section "Claude SDK"). Shape details:
`docs/architecture.md`, "Persistent state on disk"; the power boundary of both sockets: `docs/security-model.md`,
"Pairing and device keys".

## What Rarog needs from Claude Code configuration

No Rarog feature requires a change to the Claude Code memory files (your or a project's instructions for the model):
Rarog never reads or writes them. Of the Claude Code settings Rarog writes only its own entries in
`~/.claude/settings.json` (hook entries, `statusLine`, the Rarog paths in `sandbox.filesystem.denyRead`, the write
block rules in `permissions.deny`), and only
from `rarog setup` (all of them) or `rarog hooks install` (the permission hook entries), each after one `[y/N/d]`
question, in a terminal (`docs/dialogs.md`, "Writing the hook entries"). Per feature:

- **Question highlight.** The app marks a question to you with an orange bar when a reply has its own top-level
  paragraph that starts with the bold marker `**To you:**` (or `**Do Ciebie:**`). The model learns the marker from
  the context hook `scripts/hooks/rarog-context.mjs`, whose `SessionStart` entry `rarog setup` writes (step 6; also in
  the block from `rarog hooks print`), not from a rule in a memory file. Without the entry the bar appears only when
  the model writes the marker unprompted. Whether the model writes it with the hook is not measured.
- **Session detection.** herdr's Claude integration (`herdr integration install claude`) adds herdr's own
  `SessionStart` hook to the Claude Code settings; without it Rarog shows no session. `rarog setup` (step 1) and
  `rarog hooks doctor` read `herdr integration status`. Setup runs the install command after "y" to its Claude
  settings question; the doctor only prints it.
- **Permission and question cards.** The permission hook entries, written by `rarog setup` or `rarog hooks install`
  (`docs/dialogs.md`, "Permission hook"); their state is `hook` in `/health`. Without them the cards come from the
  screen.
- **Rarog state out of a session's reach.** The write block rules in `permissions.deny`, written by `rarog setup`
  (step 6; also in the block from `rarog hooks print`). Without them a session started in `~` writes the data
  directory and `~/.config/rarog` (`docs/security-model.md`, "Pairing and device keys"); `rarog doctor` warns when a
  rule is missing.
- **Plan limits and context size.** A `statusLine` command that dumps the payload to
  `~/.claude/statusline/<session>.json`: the Rarog script or your own command chained behind it, both written by
  `rarog setup` (step 6; the block to paste: `rarog hooks print`, or `rarog hooks statusline [--chain '<command>']`
  for the entry alone), or your own script that
  writes the same file.
- **Workflow labels.** The phase and label come from the workflow run log (CLI 2.1.318), not from a rule; a tag in
  the prompt is only a fallback.
- **Start dialogs of permission modes.** The control set measures them without any `skip…` setting (CLI 2.1.319,
  `docs/dialogs.md`, "Control set").
- **`RAROG_*` variables.** Defaults or what `rarog setup` writes; `RAROG_YOLO_ROOTS` is opt-in.
- **Dictation.** The Soniox key (`rarog dictation set-key`).
- **Voice agent.** The OpenAI key (`rarog voice-agent set-key`), the Soniox key of dictation and `RAROG_COMPANION=1`.

**Context hook.** The hook runs from the hook copy in `~/.claude/hooks/rarog/` (`rarog hooks install`). On every
`SessionStart` it prints one `additionalContext` paragraph only when `HERDR_ENV=1` and the session directory lies in the
work area of the roots in `<dataDir>/roots.json`; in any other case it prints nothing and exits 0. It writes nothing.
The text states the marker format as a fact: the paragraph and everything after it to the end of the reply form the
highlighted block. Its settings entry has its own state, `context:` in `rarog hooks doctor` (`ok`, `missing`, `mismatch`); it is not part
of `hook` in `/health`. Remove the entry to turn the hook off; `rarog setup` adds it back after "y" to its Claude
settings question, together with the other missing entries.

Measured on CLI 2.1.319 in an isolated configuration directory, with a `SessionStart` hook in its user
`settings.json`: while the folder trust dialog is on screen the hook does not run; after the dialog is accepted it
runs in the same session with source `startup`. It also runs with `clear`, `compact` and
`resume`; `fork` is not measured. The context lands in the transcript as `attachment` lines (`hook_success`,
`hook_additional_context`) and goes to the API with every turn of the session.

## What the repo knows about Claude Code

The repo is MIT-licensed, and Anthropic's terms (Consumer Terms §3.3, Commercial Terms likewise) prohibit reverse
engineering Claude Code. So a fact about the CLI enters the repo only from two classes of sources. This is a working
rule, not legal advice.

- **(a) Documentation or a documented interface:** Claude Code docs pages, the mods API, hooks with a payload
  described in the docs, the changelog.
- **(b) Observing the running program:** the screen and the `/` menu, files the CLI produces itself (transcripts,
  the session registry), hook payloads, the native installer's symlink.
- **(c) Reading the program's code** (the CLI executable and the JavaScript that ships with it). Facts of this
  class stay out of the repo.

The slash command registry rests on evidence files from the docs and from live measurements; see
`docs/slash-commands.md`, "After a Claude Code update". Dialog classes (`waitingFor`), screen texts, the hook and the
question card rest on docs and measurements too. A number that no evidence gives is a Rarog cap marked unmeasured
(for example the 8192-character project note).

**The guard `server/test/cli-bez-binarki-guard.test.ts`** keeps class (c) out of the repo. It reads the export view
(tracked files and new unignored ones) in `server/`, `scripts/`, `shared/`, `docs/`, `native/`, `relay/` and `bin/`,
plus every root `.md` file, `package.json` and `pnpm-workspace.yaml`, text files only. In every line and path it
looks for the Polish words the repo uses about program code (`WZORZEC` in `server/test/cli-bez-binarki.ts`). Their
English counterparts (`WZORZEC_ANGIELSKI`) count in every line of `.md`, shell and Python files and inside
TypeScript and JavaScript strings, because elsewhere the English word is a diff field or a variable name. The guard
also counts phrases in both languages that claim knowledge of the CLI's internals or compare Rarog with the CLI
without evidence, the executable's path in the npm package and the names of the CLI's terminal renderer libraries
(`FRAZY`, `FRAZY_NAZWY`; not quoted here, because this document is in scope). A hit passes only through:

1. `KONTEKSTY`: a phrase that ties the word to another program or meaning (the herdr executable, an Apple bundle id
   or API, `altool` flags, the Bundled skills term from the Claude Code docs, npm manifest fields, a diff field).
   It lets through only the words it covers. Use it for a word about another program in many files, with a comment
   naming the program; the phrase must fit only that program, so "old" or "new" before the word does not qualify,
   nor does `server/src/herdr/` in a path, because the Claude Code command registry lives there.
2. `WYJATKI`: one line about another program, with the file, a reason and the whole line without indentation.

A fact about Claude Code never passes by context or exception: it comes from (a) or (b), with its docs page or CLI
version. An entry holds the whole line after `trim()` (a repeated line carries its count in `ile`), so a changed
line comes back as a hit and its entry as dead. The test fails on a hit with no way through (`file:line: text`),
a dead entry, a wrong `ile`, a line under two entries and a context that lets nothing through.

In `native/` and `relay/` the words, their English counterparts and the renderer names are a hit only in a unit
that names Claude Code: a paragraph of a `.md` file, the whole file with its path elsewhere. A name is `claude` in
any form, the `@anthropic-ai/` scope, or a bare "CLI" that does not stand right next to another program from
`OTHER_PROGRAMS` (herdr, Tailscale, the `rarog` command and a few more). The app and the relay mention Claude Code
in few files, and their words mostly name Apple bundle ids and resources, so a line there needs no context or
exception. The phrases in `FRAZY` are hits there with no condition.

**The ban `server/test/cli-fakty-zapadka.test.ts`** catches sentences about CLI behavior without evidence. Its
unit is a block: a paragraph of a document (each list item, heading, table row and code block line on its own), a run
of comment lines, or one line of code, in `.md`, TypeScript, JavaScript, Swift and shell files in the guard's scope.
A block counts when it has the word "CLI", a behavior verb from the list in Polish or English (such as "writes",
"draws", "truncates") and no evidence marker: a CLI version `x.y.z`, a fixture, a docs page, documentation,
a changelog or "unmeasured". A measurement date is not evidence. Any such block in an export view file fails the
test. `pnpm exec tsx scripts/audit-cli-facts.ts` lists the places (`file:from-to`) with the same code. Fix a block by
adding evidence to the sentence (a docs page, a fixture or the CLI version it was measured on), by cutting the
sentence, or, when the heuristic caught a sentence about Rarog next to "CLI", by rewording it so it no longer claims
CLI behavior.
