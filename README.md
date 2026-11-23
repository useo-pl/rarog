# Rarog

Rarog is an iPhone and iPad app plus a server on your Mac or Linux machine for the Claude Code sessions that run in
[herdr](https://herdr.dev), a terminal multiplexer. From the phone you follow every session, answer its permission
prompts and questions, and send it prompts, photos and files.

## What it is

A session is a herdr pane running `claude`, started from the app or by you in a terminal. With the app you can:

- see every session with its transcript, git status line and changed files with their diffs;
- answer permission prompts, questions (`AskUserQuestion`) and plan approvals;
- send prompts, photos and files, dictate (Soniox, an external speech-to-text service, gets the audio straight from
  the phone), interrupt the agent, switch between the `plan` and `auto` permission modes, change the model and
  effort, and turn on ultracode, Claude Code's mode with dynamic workflows on every task (Claude Code 2.1.284 or
  newer);
- start a new session in a project directory and keep notes per project;
- get push notifications, where a tap opens the session, and a Live Activity;
- open an emergency console: a full shell in the project directory, in a herdr pane of its own (flag
  `RAROG_TERM=1`, set by `rarog setup`);
- see Codex panes as rows with their state, without a transcript.

One user, one machine, no accounts. The app reaches the server over iroh (an encrypted QUIC connection, direct or
through a relay) or over HTTPS in your private network (Tailscale or your own reverse proxy). Notifications go
through the push relay (`push.rarog.ai`), and a notification never approves anything. The server only reads git:
`git switch`, `pull` and `push` go through the emergency console. The `rarog` command is in English; the app speaks
English and Polish, follows the device language and falls back to English.

Rarog is remote code execution on your machine: a paired device can do whatever the user who runs the server can do.
Threat model, killswitches (flags that switch capabilities off) and how to report a vulnerability:
[SECURITY.md](SECURITY.md).

## Requirements

- macOS, or Linux with `systemd --user` (Linux is tested against a simulated systemd only).
- Node.js 22.15 or newer (23.11 or newer on the 23 line), git and curl; on Linux also procps (`ps`, `pgrep`) and
  `lsof` or `ss`. The session diff needs git 2.44 or newer: with an older git the git status line still shows, but
  without line counts, and the app gets no diff.
- npm 11 or newer, or pnpm, for the npm package; pnpm 11.4.0 for a clone (`packageManager` in `package.json`).
- Claude Code (`claude`), signed in with `/login`. Do not export `CLAUDE_CODE_OAUTH_TOKEN` or Anthropic API keys in
  interactive shells (for example in `~/.zshrc`): a session would use them instead of that login.
- herdr (`herdr` in `PATH` or `~/.local/bin/herdr`) with API protocol 22 (herdr 0.9.0 to 0.9.5). With an older
  protocol Rarog does not work, with a newer one it only reads.
- A way for the app to reach the server: the iroh listener, where the native iroh module installs (Apple silicon,
  Linux x64 and arm64), or an HTTPS address in a private network: Tailscale (`rarog setup` maps it with
  `tailscale serve`) or your own reverse proxy with TLS. An Intel Mac has no iroh module, so it needs the HTTPS
  address.
- An iPhone or iPad with iOS or iPadOS 26.

## Install

```bash
npm i -g @rarog/server    # or: pnpm add -g @rarog/server
```

The package is `@rarog/server`; its command is `rarog`. With npm older than 11 (npm 10 ships with Node 22), run
`npm i -g npm@11` first. With a minimum release age set in your package manager (npm `min-release-age`, pnpm
`minimumReleaseAge`), a new version of Rarog installs only once it is that old.

To contribute or to run unreleased code, install from a clone:

```bash
git clone https://github.com/useo-pl/rarog.git
cd rarog
pnpm install
```

In a clone, run each `rarog <command>` below as `node bin/rarog.mjs <command>` from the repository directory.

## Get the app

The iPhone and iPad app is coming to the App Store; its status is on [rarog.ai](https://rarog.ai). Until it is
there, there is no public build of the app. You can build your own copy from this repository:
[native/Rarog/docs/installing.md](native/Rarog/docs/installing.md), section "Building your own copy". Privacy policy:
[rarog.ai/privacy](https://rarog.ai/privacy). Support: [rarog.ai/support](https://rarog.ai/support).

## Services run by USEO

By default the server and the app use three services that USEO runs:

- **Push relay, `push.rarog.ai`** (`relay/`). It sends notifications to Apple for the server, which has no Apple key
  of the app. It gets device tokens and encrypted banners, never banner text in the clear; Live Activity updates
  (project names, phase titles) pass through it unencrypted ([relay/README.md](relay/README.md)). To do without it,
  set `"RAROG_PUSH_RELAY_URL": ""` in the `env` map of `config.json`: the server then sends only with your own APNs
  key, which reaches only a build of your own, so an App Store build gets no notifications. `RAROG_PUSH=0` turns
  notifications off.
- **iroh relay, `relay.rarog.ai`** (`relay-vps/`). It carries the encrypted iroh connection when the app and the
  server cannot connect directly. It sees the IP addresses and iroh keys of both sides, times and amount of data, not
  the content. To do without it, run your own iroh relay and give it to a first setup with
  `rarog setup --iroh-relay https://host/` (an existing `config.json`: `RAROG_IROH_RELAY` in `env`), or connect only
  through Tailscale with `rarog setup --tailscale-only`.
- **iroh relay registry, `relay-auth.rarog.ai`** (`relay-auth/`). The app, not the server, registers its iroh key
  there with a proof from Apple and sponsors the iroh keys of its paired servers, so that `relay.rarog.ai` admits
  them. The app contacts it only for servers on `relay.rarog.ai`; with your own iroh relay or Tailscale only it does
  not.

What each service sees and how it is protected: [docs/security-model.md](docs/security-model.md), sections
"Push notifications", "iroh relay on a VPS (`relay-vps/`)" and "iroh relay registry (`relay-auth/`)".

## First run

```bash
rarog setup                                       # iroh and/or Tailscale, from what the machine has
rarog setup --iroh-relay https://relay.example.org/
```

`rarog setup` checks the tools and creates only what is missing, each item after a `[y/N]` question:
`~/.config/rarog/config.json` (iroh with a new server key in the secrets file where the native iroh module is
installed, the HTTPS address from `tailscale status` where `tailscale` is installed), the `tailscale serve`
mapping, the service (launchd on macOS,
`systemd --user` on Linux), a copy of the permission hook and the status line script in `~/.claude/hooks/rarog/`
and, with the npm package, Anthropic's SDK (see License). The hook passes the server the full text of permission
prompts and questions; the status line script passes it the context window size and plan limits. Of what exists
setup changes only the hook copy when it differs from the installed package or clone (after `npm update`) and Rarog's
own entries in `~/.claude/settings.json` (the hook entries, `statusLine`, the Rarog paths in
`sandbox.filesystem.denyRead` and the rules in `permissions.deny` that keep sessions from writing Rarog's state),
after showing the diff and asking. Run `rarog setup` again until it exits
with code 0 (1 means something is missing or wrong; the summary at the end says what). Then pair the phone:

```bash
rarog pair
```

It shows a QR code and a `https://rarog.ai/pair#…` link, single-use and valid for 5 minutes. In the app choose Scan
QR Code or I Have a Link, then Pair. `rarog pair` works only while no device is paired; pair further devices in the
app on a paired one: Settings → Pairing → Pair New Device.

Settings live in the `env` map of `~/.config/rarog/config.json` and take effect after `rarog restart`. `rarog doctor`
checks the installation, and `rarog help` lists every command. Dictation needs `SONIOX_API_KEY=…` in
`~/.config/rarog/secret/private.env` (directory 0700, file 0600). By default the server keeps its state and its log
`server.log` in `~/.local/share/rarog`.

## Where next

Documentation index: [docs/README.md](docs/README.md). Good starting points:

- [docs/distribution.md](docs/distribution.md): pairing, the `rarog` command, `rarog setup` step by step, moving a
  clone installation to the npm package;
- [docs/server-config.md](docs/server-config.md): server start, `config.json`, flags;
- [docs/architecture.md](docs/architecture.md): how the system is built;
- [relay/README.md](relay/README.md): the push relay and what it sees;
- [CONTRIBUTING.md](CONTRIBUTING.md): checks, the demo server, how a pull request ships.

Public documentation, CLI messages and the app interface are in English, and so are most identifiers. Many code
comments, most test titles and some names of test files, scripts and script options are in Polish, the working
language of the team that builds Rarog.

## License

The code is licensed under the MIT License ([LICENSE](LICENSE)). Third-party material has its own licenses, listed
in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES). The MIT License does not cover the Rarog name or logo: the name and
the files of the logo and the app icon (`native/Rarog/Rarog/Assets.xcassets/RarogLogo.imageset/` and
`native/Rarog/Rarog/AppIcon.icon/`) are not licensed under it.

The server uses one function, `listSessions()`, from `@anthropic-ai/claude-agent-sdk`, proprietary software of
Anthropic PBC. Neither this repository nor the `@rarog/server` npm package contains it: in a clone pnpm downloads it
during installation, and with the npm package `rarog setup` downloads it after asking. Anthropic's terms apply to
whoever installs it.

Rarog is an independent project by USEO. It isn't affiliated with or endorsed by Anthropic, OpenAI, Apple or the
herdr project. Their names and the names of their products are trademarks of their respective owners.
