# Code map

One line for every directory of the server, the shared contract, the relays, the `rarog` command, the scripts and
the app, and one line for every top-level file of `server/src` and `server/src/herdr`. Use it to find where
a change goes before reading code; the module header of each file says the rest. Three directories keep their own
file map with a guard, in the header of their `index.ts`: `server/src/herdr/dialogs/`,
`server/src/herdr/background/` and `server/src/herdr/commands/`.

The guard `server/test/code-map-guard.test.ts` keeps this map complete in both directions: a new directory or file
without a line fails it with the ready line to add, and a line for something that is gone fails it too. Tests
(`server/test/`, `shared/test/`), fixtures (`shared/fixtures/`, `server/test/fixtures/`) and documents are not
mapped here; the build layout and the parts of the stack are in [architecture.md](architecture.md).

## Server: `server/src`

- `server/src/` — the Rarog server: HTTP on 127.0.0.1, sessions in herdr panes, SSE to the app.

Top-level files:

- `server/src/index.ts` — server entry: config → herdr supervisor → manager → SSE hub → router →
  `node:http`.
- `server/src/config.ts` — server configuration; the only place that reads `process.env`, through `readEnv`.
- `server/src/config-env.ts` — registry of every environment variable the server reads, and the pass lists for
  child processes.
- `server/src/router.ts` — hand-written HTTP router: Origin check, authentication, then the routes.
- `server/src/sse.ts` — `SseHub`: registry of open SSE streams and broadcast of protocol events.
- `server/src/health.ts` — `/health`, the only endpoint without authentication, and its payload.
- `server/src/permissions.ts` — pending interactions: permission requests and questions waiting for a human.
- `server/src/risk.ts` — classifier of "red" actions; a UX signal, not a security boundary.
- `server/src/device-effects.ts` — what the rest of the server does when a device is unpaired or a new one paired.
- `server/src/client-log.ts` — `POST /api/client-log`: diagnostics the app sends without a cable.
- `server/src/cli-store.ts` — where the CLI store lives and how a project directory in it is named.
- `server/src/cli-version.ts` — the Claude Code release a session process runs versus the installed one.
- `server/src/live-sessions.ts` — which engine sessions are open now, from `claude agents --json`.
- `server/src/session-list.ts` — engine sessions from the official Claude Code API, as resumable sessions.
- `server/src/session-label.ts` — the session label (`session` in `project · session`), pure functions.
- `server/src/transcript-import.ts` — read-only import of a session's history from the tail of its transcript file.
- `server/src/fs-browse.ts` — directory browser for the New Session form (`GET /api/fs`), with the parent steps and
  the row rule that creating a directory reuses.
- `server/src/fs-mkdir.ts` — creating one directory in a listed directory: gate, name rule, one request at a time.
- `server/src/fs-mkdir-child.ts` — the child process that creates the directory inside the checked parent.
- `server/src/git-status.ts` — local `git status` per session, the source of the `git-status` event.
- `server/src/git-config-guard.ts` — filter drivers off for git reads: driver names from the config key list.
- `server/src/git-sandbox.ts` — git reads under `sandbox-exec` on macOS: the git programs, the profile, the probe.
- `server/src/git-work-tree.ts` — the work tree of git reads: the session directory or its nearest ancestor with `.git`.
- `server/src/git-watch.ts` — watcher of the `.git` directory, a session-independent trigger of `git-status`.
- `server/src/git-diff.ts` — per-file session diff: the changed file list and the patch of one file.
- `server/src/git-stats.ts` — git cost counter: one `server.log` line per window.
- `server/src/safe-read.ts` — reading and appending regular files only, and listing a directory through its `dev` and
  `ino`, in directories an agent can write.
- `server/src/hidden-chars.ts` — code point ranges of characters that hide or reorder text on screen.
- `server/src/text.ts` — outside text on its way to the wire or the log: clipping, control characters, labels, builds.
- `server/src/usage.ts` — plan limits (5-hour and weekly windows) from the Claude Code status line.
- `server/src/mac-stats.ts` — Mac load: CPU, RAM and disk, one sampler per process.
- `server/src/tailnet.ts` — name of the tailnet the server is in, for the app.
- `server/src/version.ts` — server version, capabilities and machine system from one source.
- `server/src/version-watch.ts` — a new Claude Code or herdr version: one `server.log` line and a push.
- `server/src/log-timestamps.ts` — ISO 8601 UTC time at the start of every server log line.
- `server/src/log-timestamps-install.ts` — side-effect import that installs the log time; `index.ts` loads it
  first.
- `server/src/shutdown.ts` — process exit after SIGTERM and SIGINT: closes run together, then a fuse.

Directories:

- `server/src/auth/` — authentication: device keys and their store, pairing, the principal of a request, Origin
  rule, failure limiter, admin and consent sockets; `index.ts` is the only entry.
- `server/src/bootstrap/` — server start pieces that `main()` in `server/src/index.ts` calls: hook files, device
  keys, push, terminal, iroh, `/health` probes, manager options, consent channel, PR status, SSE hub, router and the
  supervisor's agent set signal for `alive.json`, the Inbox; the herdr runtime (`loadHerdr`) stays in `index.ts`.
- `server/src/cli/` — the `rarog` command, one module per command; `main.ts` dispatches.
- `server/src/cli/screen/` — step screen of `rarog` commands: step lines with marks, colour and progress, width and
  short paths, the run log file under `<dataDir>/logs/`, question forms `[y/N]`, `[Y/n]`, `[y/N/d]`.
- `server/src/cli/templates/` — launchd plist and `systemd --user` unit used by `rarog service install`.
- `server/src/companion/` — voice agent server side: the question behind `POST /api/sessions/:id/companion/ask`,
  condensing a conversation file for Sonnet, the isolated `claude -p` call, the secret mask and the Sonnet instruction
  (`docs/companion.md`).
- `server/src/config/` — configuration parsers per area (listening, demo, herdr, roots and cwd checks, push,
  terminal, dictation, flags, clients, Claude account, macOS-protected folders, the work area, session files); they
  never read the environment, `config.ts` passes values.
- `server/src/demo/` — demo mode: fake herdr supervisor, seeds, the demo file tree, demo control routes, review-mode
  route table.
- `server/src/demo/content/` — demo content sets per language (`en`, `pl`), their contract and the loader of named
  sets (`RAROG_DEMO_CONTENT`), chosen once at start.
- `server/src/drivers/` — session drivers: the herdr driver facade, the mock driver, runtime helpers, tool text.
- `server/src/drivers/herdr/` — modules of the herdr driver: sending to the pane, the queue of messages sent while a
  turn runs, the turn watchdog and send numbers, the form and CLI registry fallbacks, the transcript follower, pull
  request refresh, CLI registry reads of the consent channel, the prompt Claude Code hands back to its field after Esc,
  refusals of a decision and their audit funnel.
- `server/src/files/` — session files: the session gate, one path rule for listing a directory and opening a file
  in the session directory, the listing of one directory with git's `ignored` labels, the index of the session's
  files (a walk by that listing, narrowed by `git ls-files`), the download of one file (the limit, the sender, the
  downloads in flight by device) and the refusals of the routes.
- `server/src/folder-gate/` — macOS-guarded home folders: the types of their states and refusal, the work-area disk
  port (one disk operation, sync or async, as plain values), the line codec of those values, the helper process
  that runs those operations for one folder (`helper.ts`), the relay thread and its client that start, call and
  kill the helpers (`relay-worker.ts`, `client.ts`), which guarded folder a path lies in (`folders.ts`), the state
  of each folder with its checks and rechecks (`gate.ts`) and the one gate of the process, disabled by default
  (`install.ts`).
- `server/src/inbox/` — Inbox cards: one card per session from its conversation file, and their removals.
- `server/src/install/` — installation layout: install mode and root, data directory of the service, service
  target, repair commands, the pinned Claude SDK, package manager facts.
- `server/src/iroh/` — iroh listener: a QUIC stream as an HTTP connection; `adapter.ts` alone loads the library.
- `server/src/notes/` — project notes store: one text document per directory.
- `server/src/notify/` — push notifications and the Live Activity: scheduler (`index.ts`), pure policy, presence,
  sending through APNs or the relay, push encryption.
- `server/src/pr-status/` — session PRs on GitHub: the `gh` source (batched query), the fixed-map source, the facts
  memory (author, creation time, title, `gh` login) with its one-time verification, the URL → state tracker with its
  rhythm and pauses; `gh.ts` alone starts `gh`.
- `server/src/routes/` — REST route groups (sessions, devices, push, terminal, notes, limits, projects, system);
  `router.ts` calls them only after the Origin, credential and body checks.
- `server/src/sessions/` — session manager, session, state machine, ring buffer, send registry, CLI registry,
  interrupt windows, attach slots, git row of cards, context window, herdr pane lifecycle events, driver events
  (`init`, `history`, `agent-state`), launch checks and launch slots, session restart, queued echo, consent
  channel cards, the PR list and its state on cards, activity row clocks (turn start, activity age), project root
  scan, recent projects, manager errors, manager API.
- `server/src/term/` — emergency console: a persistent shell in a herdr pane, idle reaper, WebSocket transport.
- `server/src/voice/` — Soniox: a temporary key in exchange for the permanent one, which never leaves the server.

## herdr integration: `server/src/herdr`

- `server/src/herdr/` — everything Rarog knows about herdr and the Claude Code panes in it.

Files:

- `server/src/herdr/index.ts` — public entry of the integration, which `server/src/index.ts` loads at start; the
  manager imports the modules it uses directly (`uploads.ts`, `jsonl-follow.ts`, `types.ts`, `commands/`, …).
- `server/src/herdr/types.ts` — shared types of the integration: supervisor, manager, driver and socket client.
- `server/src/herdr/socket.ts` — the only code that knows the herdr unix socket and NDJSON; method allow-list.
- `server/src/herdr/client.ts` — typed facade over the socket: response shapes and herdr error codes.
- `server/src/herdr/supervisor.ts` — which `claude` agents live in herdr, in what state and mode.
- `server/src/herdr/answer-recheck.ts` — status recheck of a pane after a dialog answer, for a lost `idle` push.
- `server/src/herdr/launcher.ts` — turning a directory into a live agent: the whole pane creation procedure.
- `server/src/herdr/start-dialog-wait.ts` — a start dialog herdr reads as ready ends the launch wait as `blocked`;
  the poll for the session id after it.
- `server/src/herdr/argv.ts` — `claude` arguments for `agent.start`: builder and closed allow-list.
- `server/src/herdr/trust.ts` — whether `claude` will ask for folder trust in a directory.
- `server/src/herdr/identity.ts` — session identity across server restarts, and the hidden-session store.
- `server/src/herdr/provenance.ts` — pane provenance: formats of Rarog agent names and pane titles.
- `server/src/herdr/label-code.ts` — the `rt:` and `rc:` suffix of a pane label in Crockford base32, pure functions.
- `server/src/herdr/label-migration.ts` — old-format pane labels: the normalizer for every reader and the rewrite pass.
- `server/src/herdr/project-workspace.ts` — project workspace: the project lock and the read the resolver uses.
- `server/src/herdr/workspace-resolver.ts` — pure decision which herdr workspace gets a new session or terminal.
- `server/src/herdr/mode-cycle.ts` — switching a pane's permission mode; the only place that knows `shift+tab`.
- `server/src/herdr/audit.ts` — append-only log of everything Rarog sent to a pane, with refusal reasons.
- `server/src/herdr/transcript-path.ts` — locating a session's transcript file by its UUID.
- `server/src/herdr/jsonl-follow.ts` — transcript follower: the session's `.jsonl` file → event stream.
- `server/src/herdr/history-steps.ts` — the history path of a transcript tail, shared by the follower and the driver.
- `server/src/herdr/input-segments.ts` — a transcript tail split at every turn input: result class, card text, id.
- `server/src/herdr/jsonl-pending.ts` — narrow parser of raw transcript lines: pending tool input, mode, model.
- `server/src/herdr/jsonl-activity.ts` — the activity row of a tool call, from the transcript tail.
- `server/src/herdr/jsonl-usage.ts` — context window of a session from its transcript, pure functions.
- `server/src/herdr/jsonl-queue.ts` — human prompts waiting in the CLI queue, counted from the transcript, pure.
- `server/src/herdr/session-pulse.ts` — session pulse: signs of life while the main transcript is silent.
- `server/src/herdr/statusline.ts` — Claude Code status line payload: the only source of a session's window size.
- `server/src/herdr/uploads.ts` — attachments from the phone → files the agent in the pane can read.
- `server/src/herdr/uploads-registry.ts` — list of the directories that got attachments, read by the start sweep.
- `server/src/herdr/ultracode.ts` — Claude Code words about ultracode and the reader of its trace in the transcript.
- `server/src/herdr/hook-commands.ts` — one definition of what Rarog writes into `~/.claude/settings.json`.
- `server/src/herdr/hook-config.ts` — bridge to Claude Code hooks: roots, the hook copy, is the hook registered.
- `server/src/herdr/line-diff.ts` — line diff of two texts as `diff -u` hunks, shown before the hook copy is written.
- `server/src/herdr/consent-evidence.ts` — consent channel evidence in the transcript: facts of one turn.
- `server/src/herdr/consent-subagent.ts` — consent channel evidence in a subagent file: facts of the agent's run.
- `server/src/herdr/consent-step.ts` — a consent channel step nobody stops on: an exception leaves one log line.

Directories (file maps in their `index.ts`):

- `server/src/herdr/background/` — background tasks of a session, its artifacts and pull requests
  ([background-tasks.md](background-tasks.md)).
- `server/src/herdr/commands/` — slash commands: catalog, discovery, registry of CLI forms
  ([slash-commands.md](slash-commands.md)).
- `server/src/herdr/dialogs/` — Claude Code dialogs: what stands on screen, which card, what may be approved
  ([dialogs.md](dialogs.md)).
- `server/src/herdr/dialogs/cards/` — decision card types and builders, card ids, option roles.
- `server/src/herdr/dialogs/decide/` — pure decision which card stands on the phone, with its inputs and reasons.
- `server/src/herdr/dialogs/hook/` — permission hook contract: dumps the hook writes, answers Rarog writes.
- `server/src/herdr/dialogs/layer1/` — consent channel: cycle, signed answers, secret registry, cards, proof.
- `server/src/herdr/dialogs/layer1/hook-list/` — the session's `PermissionRequest` hooks, read-only, as evidence.
- `server/src/herdr/dialogs/layer2/` — cards of a dialog block without numbered options, with matching and
  stability.
- `server/src/herdr/dialogs/policy/` — option policy: which option to pick, escalation, terminal-only dialogs.
- `server/src/herdr/dialogs/screen/` — pure functions over pane screen text: dialog kinds, blocks, options.
- `server/src/herdr/dialogs/send/` — keys sent to a pane: form submit, key sequences, the trust step.
- `server/src/herdr/dialogs/shadow/` — shadow mode: `alive.json` and its log, shadow files, hook liveness.

## Shared contract: `shared/src`

- `shared/src/` — contract of server and app: zod schemas and `PROTOCOL_VERSION` (`protocol.ts`), tolerant
  decoder, REST, relay and iroh constants, pairing link, data directory rule.
- `shared/src/protocol/` — contract areas that `protocol.ts` re-exports: model, slash commands, directory browser,
  background tasks, attachments, resume, diff, git, activity, dictation, terminal, notes, herdr status.
- `shared/src/sentences/` — registry of server sentences shown in the app: code → English template → arguments.

## Relays

- `relay/` — push relay: a Cloudflare Worker, its own pnpm project ([relay/README.md](../relay/README.md)).
- `relay/src/` — relay core, APNs client, JWT, payload policy, client key and pass, Worker adapter.
- `relay/test/` — relay tests, including the payload policy against `shared/fixtures/relay/`.
- `relay/scripts/` — `smoke.mjs`: relay smoke measurements, plain Node.
- `relay-auth/` — iroh relay device registry: a Cloudflare Worker with Durable Objects
  ([relay-auth/README.md](../relay-auth/README.md)).
- `relay-auth/src/` — registry core, Durable Objects, Apple gate (DeviceCheck), crypto, Worker adapter.
- `relay-auth/test/` — registry tests, including runs in `workerd`.
- `relay-vps/` — iroh relay on a VPS: configuration, systemd units, firewall, traffic cap, watchdogs, access
  adapter, install script ([relay-vps/README.md](../relay-vps/README.md)).
- `relay-vps/test/` — tests of the access adapter, units, configuration, scripts and watchdog.
- `relay-vps/test/fixtures/` — deliberately broken shell and TOML files for the check tests.

## Command and scripts

- `bin/` — `rarog.mjs`: checks the Node version, loads `server/src/cli/main.ts` and returns its exit code.
- `scripts/` — repository scripts: server restart, the repository check, iOS build and test helpers, package
  build and audit, copy and sentence catalog checks.
- `scripts/hooks/` — Claude Code hook scripts: permission hook (`rarog-pending.mjs`) with its consent channel,
  context hook, status line script, tall dialog guard, `cwd` filter of both hooks (`work-area.mjs`).
- `scripts/lib/` — shared modules of scripts and guards: private literal and pattern scan, repository file list,
  CI summary, TOML check.

## Native app: `native/Rarog`

- `native/Rarog/` — the iOS and iPadOS app ([native/Rarog/README.md](../native/Rarog/README.md)).
- `native/Rarog/docs/` — the app's area documents: code rules, core, UI, file layout, Xcode project, tests,
  installing.
- `native/Rarog/Localization/` — rules for the app's English copy.
- `native/Rarog/Rarog.xcodeproj/` — Xcode project: app, widget and notification service extensions, test targets.
- `native/Rarog/Rarog/` — app target: app, delegate (APNs), environment, system adapters for the core.
- `native/Rarog/Rarog/AppIcon.icon/` — app icon: `icon.json` and its SVG layers.
- `native/Rarog/Rarog/Assets.xcassets/` — asset catalog of the app target.
- `native/Rarog/RarogNotificationService/` — notification service extension: banner title and body after
  decryption.
- `native/Rarog/RarogWidgets/` — WidgetKit extension: the aggregate Live Activity.
- `native/Rarog/RarogUIKitTests/` — UIKit tests on real views in the simulator.
- `native/Rarog/RarogUITests/` — UI tests (XCUITest) against the demo server.

Packages (each with `Package.swift`; dependencies in `native/Rarog/README.md`):

- `native/Rarog/Packages/RarogContract/` — client side of the SSE and REST contract; no UIKit, tests on macOS.
- `native/Rarog/Packages/RarogContract/Sources/RarogContract/` — frame types, tolerant decoder, REST bodies, Live
  Activity state, APNs payload.
- `native/Rarog/Packages/RarogContract/Sources/RarogContract/Copy/` — copy language and locale, server sentence
  descriptors, `ServerText`.
- `native/Rarog/Packages/RarogContract/Sources/RarogContract/Push/` — push decryption, envelope and open target.
- `native/Rarog/Packages/RarogContract/Sources/RarogContractFixtures/` — test library: golden SSE frames read from
  `shared/fixtures/sse/` and the copy catalog baseline; the app does not link it.
- `native/Rarog/Packages/RarogContract/Tests/RarogContractTests/` — contract tests: golden frames, decoder rules,
  copy catalogs.
- `native/Rarog/Packages/RarogContract/Tests/RarogContractTests/Legacy/` — frozen decoders of an older app, which
  must still read current server frames.
- `native/Rarog/Packages/RarogContract/Tests/RarogContractTests/Resources/` — a text catalog for the lookup test in
  an explicit language.
- `native/Rarog/Packages/RarogTransport/` — transport: SSE byte parser, REST client with the device key and
  Origin, mutation gate; depends only on RarogContract.
- `native/Rarog/Packages/RarogTransport/Sources/RarogTransport/` — REST client per area, device credential and
  Keychain, push keys and opening.
- `native/Rarog/Packages/RarogTransport/Sources/RarogTransport/RelayAccess/` — iroh relay registry client: the
  machine that decides, the actor that runs its effects, the stored state and the HTTP client of the registry.
- `native/Rarog/Packages/RarogTransport/Sources/RarogTransport/Tunnel/` — iroh tunnel: the protocols the adapter
  implements, generation machine, runtime, endpoint lease, loopback proxy and the app's iroh key in Keychain.
- `native/Rarog/Packages/RarogTransport/Sources/RarogTransportTesting/` — in-memory doubles of the tunnel and the
  relay registry (endpoint, streams, HTTP, clock) for the tests of every layer above the tunnel protocols.
- `native/Rarog/Packages/RarogTransport/Tests/RarogTransportTests/` — transport tests.
- `native/Rarog/Packages/RarogTransport/Tests/RarogTransportTests/Legacy/` — frozen decoder of the Keychain entry of
  an older app, which must still read the entry a current build writes.
- `native/Rarog/Packages/RarogCore/` — app core: `@Observable` store, SSE reducers, connection loop,
  compatibility, outbox, presence; no UIKit.
- `native/Rarog/Packages/RarogCore/Sources/RarogCore/` — the store (`RarogStore+<Area>`), reducers, outbox,
  pairing, push routing.
- `native/Rarog/Packages/RarogCore/Sources/RarogCore/Copy/` — core copy and its text catalog.
- `native/Rarog/Packages/RarogCore/Sources/RarogCore/Dictation/` — dictation route: device choice, policy,
  services.
- `native/Rarog/Packages/RarogCore/Sources/RarogCore/Transport/` — server identity of the app's data space (HTTPS
  origin or iroh EndpointId) and the transport switch that lends the client of the current tunnel generation.
- `native/Rarog/Packages/RarogCore/Sources/RarogCore/VoiceAgent/` — voice agent settings: consent, voice choice.
- `native/Rarog/Packages/RarogCore/Tests/RarogCoreTests/` — core tests.
- `native/Rarog/Packages/RarogCore/Tests/RarogCoreTests/Fixtures/` — snapshot of the catalog keys.
- `native/Rarog/Packages/RarogCore/Tests/RarogCoreTests/Legacy/` — frozen decoder of the data space pointer of an
  older app, which must still enter the space a current build writes.
- `native/Rarog/Packages/RarogCore/Tests/RarogCoreTests/Support/` — test doubles: fake transport, terminal and
  pairing, frames, virtual clock.
- `native/Rarog/Packages/RarogActivity/` — Live Activity: ActivityKit attributes, copy, Lock Screen and Dynamic
  Island views.
- `native/Rarog/Packages/RarogActivity/Sources/RarogActivity/` — attributes, presentation, palette and views.
- `native/Rarog/Packages/RarogActivity/Sources/RarogActivity/Copy/` — the package's text catalog and `L`.
- `native/Rarog/Packages/RarogActivity/Tests/RarogActivityTests/` — copy, presentation and contrast tests.
- `native/Rarog/Packages/RarogActivity/Tests/RarogActivityTests/Fixtures/` — snapshot of the catalog keys.
- `native/Rarog/Packages/RarogTerminal/` — terminal adapter: the only package that imports SwiftTerm.
- `native/Rarog/Packages/RarogTerminal/Sources/RarogTerminal/` — `SwiftTermSurface`, links, edge reader, scroll
  momentum, symbols font.
- `native/Rarog/Packages/RarogTerminal/Sources/RarogTerminal/Resources/NerdFontsSymbols/` — Symbols Nerd Font
  Mono with its license and notice.
- `native/Rarog/Packages/RarogTerminal/Tests/RarogTerminalTests/` — tests of the SwiftTerm surface.
- `native/Rarog/Packages/RarogIroh/` — iroh adapter: the only package that imports IrohLib.
- `native/Rarog/Packages/RarogIroh/Sources/RarogIroh/` — tunnel transport over IrohLib, Ed25519 signing with the
  app's iroh key, library errors mapped to tunnel failures.
- `native/Rarog/Packages/RarogIroh/Tests/RarogIrohTests/` — unit and signature vector tests; tests on the live
  library run with `RAROG_TEST_IROH=1`.
- `native/Rarog/Packages/RarogUI/` — views: SwiftUI for navigation, list and cards; UIKit for the transcript and
  the message field.
- `native/Rarog/Packages/RarogUI/Tests/RarogUILogicTests/` — logic tests of RarogUI on macOS.
- `native/Rarog/Packages/RarogUI/Tests/RarogUILogicTests/Fixtures/` — snapshot of the catalog keys.

RarogUI sources (`native/Rarog/Packages/RarogUI/Sources/RarogUI/…`):

- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Copy/` — copy registry `UICopy+<Area>` over the text catalog.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/` — markdown parser, layout, links, syntax highlighting.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Model/` — presentation models and screen state, built on macOS.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/` — session screen: `SessionViewController` with its
  area extensions, composer, prompt bar.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Attachments/` — attachment intake, rules, shelf, images.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Cards/` — permission, question, dialog and state cards.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Copy/` — code block copy button and selection copy.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Rows/` — transcript row views.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Voice/` — dictation in the composer: recorder,
  microphone, Soniox stream.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Voice/Realtime/` — voice agent: session projection, secret
  mask, OpenAI Realtime client, the voice chat audio engine, the tools wired to the store, the end-of-conversation
  rules, the composer button with its bars and the states of the status row.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Voice/System/` — system dictation (speech recognition on
  the device).
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/ShortcutSheet/` — shortcut sheet under a held Cmd: key events,
  the 1.5 s hold, the rows per focus place, the panel on the window and its controller.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Switcher/` — session switcher and its rows.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Terminal/` — terminal screen: window, chrome, edges, history.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Theme/` — palette tokens, colors, corner radii.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Theme/TextStyle/` — text style table, scaling and the app font.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/` — root view, detail, app commands, banners, toasts.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/About/` — About model, licenses and product links.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Banners/` — new device and push banners.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Common/` — shared controls: gauges, hover, menu pill.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Dictation/` — the Dictation screen and choice.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Header/` — session header: background tasks, git, diff.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Inbox/` — the Inbox screen: cards, replies, dictation, voice.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Inspector/` — inspector panel and its toggle.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/List/` — session list and project tree.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/List/Footer/` — list footer: usage line and panel.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/NewSession/` — New Session and recent sessions sheets.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Notes/` — project notes: editor, reader, conflict.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Pairing/` — pairing: scanner, start view, controls.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Presentation/` — sheet and popover hosting, Esc dismiss.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Projects/` — project tab bar and empty project view.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/SessionControl/` — header session slot, result seen.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Settings/` — Settings list and its Server, Pairing and About pages.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/ShortcutSettings/` — shortcut section of the Settings pages and recording.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/TextScale/` — app text size: scene override, keys, Settings page.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/Usage/` — the Usage sheet.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/VoiceAgent/` — voice agent settings page and consent.
