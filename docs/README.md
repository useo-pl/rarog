# Rarog documentation

Every document listed here describes the system as it works today, not plans. If a document and the code disagree,
the document is wrong; it is fixed in the same commit as the change.

Entry files:

| Document | What it covers |
| --- | --- |
| [README.md](../README.md) | what Rarog is, requirements, install, getting the app, services run by USEO, first run, license |
| [SECURITY.md](../SECURITY.md) | short threat model, reporting a vulnerability, supported versions |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | contribution license and credit, language, checks, demo server, change rules |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Contributor Covenant 2.1 and how to report conduct |
| [docs/README.md](README.md) | this index |

In `docs/`:

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | how the system is built: stack, SSE and HTTP endpoints, data model |
| [code-map.md](code-map.md) | one line per source directory: where a change goes |
| [security-model.md](security-model.md) | threat model, what each layer protects against, emergency runbook |
| [server-config.md](server-config.md) | server start (launchd, `systemd --user`), `config.json`, flags |
| [macos-folders.md](macos-folders.md) | the folder gate: disk calls in guarded folders of home run in a helper process |
| [distribution.md](distribution.md) | pairing devices, the `rarog` command, installation with `rarog setup` |
| [dialogs.md](dialogs.md) | how Claude Code dialogs in herdr panes are recognized and answered |
| [dialog-card.md](dialog-card.md) | card with the literal choices of a CLI dialog (layer 2 flag) |
| [start-dialogs.md](start-dialogs.md) | start dialogs herdr reads as ready: recognition, card, no key from the phone |
| [background-tasks.md](background-tasks.md) | background tasks of a session: commands, subagents, workflows |
| [subagent-long-wait.md](subagent-long-wait.md) | how long a subagent in standby has waited on its own command |
| [artifacts.md](artifacts.md) | session artifacts (claude.ai pages) read from the transcript |
| [pull-requests.md](pull-requests.md) | session pull requests: linked by `pr-link`, the user's own per GitHub |
| [scheduled-tasks.md](scheduled-tasks.md) | session scheduled tasks (crons from `CronCreate`) read from the main file |
| [companion.md](companion.md) | the voice agent: server routes, `claude -p` call, secret mask, configuration, security, app |
| [slash-commands.md](slash-commands.md) | Claude Code slash commands the phone can send, and how Rarog learns which exist |
| [localization.md](localization.md) | app language: text catalogs, registries, adding a language, test language |
| [publishing.md](publishing.md) | what the public repository must not carry, its guards, CI |
| [implementation-spec.md](implementation-spec.md) | contract: SSE protocol, HTTP routes, terminal and APNs frames |
| [design.md](design.md) | visual language of the app: tokens, typography, patterns, accessibility |

Outside `docs/`:

| Document | What it covers |
| --- | --- |
| [native/Rarog/README.md](../native/Rarog/README.md) | the iOS and iPadOS app: packages, state, Xcode, tests |
| [native/Rarog/Localization/TRANSLATION.md](../native/Rarog/Localization/TRANSLATION.md) | rules for the app's English copy |
| [relay/README.md](../relay/README.md) | the push relay (Cloudflare Worker at `push.rarog.ai`) |
| [relay-auth/README.md](../relay-auth/README.md) | the iroh relay device registry (Cloudflare Worker) |
| [relay-vps/README.md](../relay-vps/README.md) | the iroh relay on a VPS: its files and how the check covers them |
| [server/test/fixtures/herdr/README.md](../server/test/fixtures/herdr/README.md) | herdr fixtures: origin, anonymization |
