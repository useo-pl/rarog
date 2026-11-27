# Server configuration: `rarog serve`, launchd, flags

How the Rarog server starts and where its environment comes from: supervision by launchd (on Linux by
`systemd --user`), the config file `~/.config/rarog/config.json` read by `rarog serve`, killswitches, feature flags
and preferences. The powers of the server and the emergency runbook are in `docs/security-model.md`; the table of
`config.ts` variables is in `architecture.md`, "Configuration".

A new server variable or flag goes into this document. In code it starts as an entry in the registry
`server/src/config-env.ts` (name and kind: `secret`, `process`, `passthrough`, `plain`). `config.ts` reads the
environment only through `readEnv`, typed with the registry names, and passes the values to the area parsers in
`server/src/config/`, which never read the environment themselves; the guard
`server/test/env-registry.test.ts` fails on a name read outside the registry and on an entry nothing
reads. A new `plain` variable has the `RAROG_` prefix (the other names of that kind, except `SONIOX_API_HOST`, are on
a closed list in the guard that can only shrink). A name outside the registry in `config.json`, in the secrets file
or in `--env` makes `rarog serve` refuse with the key name; in the process environment it does not reach the server.
In an installation a `plain` value comes from an entry in `env` in `config.json`, and a new secret also goes into
the list of names that the `service.wrapper` command exports ("Server environment: variables and flags").

## Start and supervision

`rarog restart` is a front that takes a lock, finds the state of the service and
then calls the executor, `scripts/restart.sh`. In a repo clone the server runs on tsx without live reload, so every
change in `server/` or `shared/` needs a restart.

`restart.sh` stops the process listening on port 8930 and processes with the server's argv, the latter only when
their working directory is the installation root (`lsof -d cwd`, on Linux `/proc/<pid>/cwd`) and their environment
has neither `RAROG_DEMO=1` nor a different `RAROG_PORT`. Under the launchd service it also stops the process the
service runs (`pid` from `launchctl print`) without these filters, so a server still on the old port after a port
change in `config.json` stops too. Servers of other projects and the agents' demo servers (XCUITest in
`ios-check.sh`) survive. On macOS the start has two paths:

- the launchd service `ai.rarog.server` is loaded → after the old process exits, `launchctl kickstart` without
  `-k`. `KeepAlive` usually starts the new process right as the old one exits, and `kickstart` starts it when it has
  not; launchd runs one process per label. `-k` would kill that fresh process, and launchd delays the next start of
  a job that ran under 10 s ("Pushing respawn out by 10 seconds" in `/var/log/com.apple.xpc.launchd/launchd.log`),
  so the server would stay down 10 s longer. A restart within 10 s of the previous start still waits for that delay.
  launchd keeps the process alive (`KeepAlive`) and starts it at login (`RunAtLoad`); the domain `gui/$UID` means
  that without auto-login the server comes up after a reboot only once the user logs in;
- no service → a `nohup` start of `bin/rarog.mjs serve`; without `config.json` the restart refuses and points to
  `rarog setup`.

On Linux the only path is the `systemd --user` unit `rarog.service`. `rarog service install` creates the service,
which starts `rarog serve`. Never mix supervisors: `rarog restart` picks the path, so `KeepAlive` and `nohup` do not
fight over the port. The log is `<dataDir>/server.log` (appended under launchd, overwritten on a `nohup` start).
Every line the server writes to stdout and stderr starts with the time in UTC, ISO 8601 with milliseconds, and one
space (`2026-11-10T16:59:23.123Z `). A line that starts after a newline inside the same write continues one log
call (a stack trace, a value with a newline): its time is followed by `| ` (`2026-11-10T16:59:23.123Z |     at …`),
so a value that carries a whole log line never reads as a line the server wrote. Bytes that bypass the
server's stdout and stderr writes, such as Node's own report of an uncaught exception, have no prefix. Output of the
`rarog` commands for a person (`rarog doctor`, `rarog pair`) has no prefix either.

`restart.sh` exits 0 when the new server answers `/health` and herdr (the terminal multiplexer whose panes run the
Claude Code sessions) responds. Exit 2: `/health` still says `herdr: false` after 10 more answers a second apart (a
server busy right after its start can miss the herdr ping on the first one). Exit 3: `/health` is answered by a process
older than the restart, so the stop missed and the new instance probably failed with `EADDRINUSE`. `hook: stale` in
the health line (the hook copy differs from the repo) does not fail the restart.

### `rarog restart`

The lock `~/.config/rarog/lock` is a file with the PID, created with `wx`: a second restart at the same time gets a
refusal with the first one's PID. A dead process's lock is taken over by one process at a time: the taker creates
the takeover file `~/.config/rarog/lock.przejecie` (also with `wx`; the name comes from the code) and reads the lock
again under it, so two restarts that both found the lock dead cannot both go on. The service state comes from
`loadState` in `server/src/cli/restart.ts` (also used by `rarog service` and `rarog doctor`): exit 0 of
`launchctl print gui/<uid>/ai.rarog.server` = loaded, 113 = absent, anything else (another code, a signal, a
timeout) = unknown. Without `launchctl` the state is absent. The paths:

- **unknown** → refusal with the first stderr line of `launchctl`: a wrong guess would start a second server;
- **service loaded** → checks, each a refusal on failure, then `restart.sh` with the label, port and log:
  1. `RAROG_DATA_DIR` and `XDG_DATA_HOME` are empty in this shell and in the `environment` block of
     `launchctl print gui/<uid>`, which the service inherits; otherwise the permission hook (Rarog's hook script,
     which Claude Code runs from `~/.claude/hooks/rarog/`) and the server would use different data directories.
     Fix: run without the variable, or `launchctl unsetenv <name>` in Terminal.app on the Mac screen, outside herdr
     (from SSH, mosh and herdr it reaches another domain, `user/<uid>`). A printout the front cannot read (a non-zero
     exit, a signal, a timeout, no `environment` block, a block that is unclosed or repeated, a line of unknown
     shape in it) gives a `WARNING, not checked` line on stderr and the restart goes on, because Apple does not
     document the `launchctl print` format; a set variable found in a closed block is still a refusal, and
     `rarog doctor` shows afterwards whether the service got one. The rule is `refuseLaunchdDataDirEnv` in
     `server/src/cli/restart.ts`, shared with `rarog service install`;
  2. `rarog serve --check` without secrets (with a wrapper they exist only under it). When it prints
     `iroh key: not checked`, a second, full `rarog serve --check` runs through `service.wrapper`, with the
     secrets; its failure, or a key still missing, is a refusal, because the new server would not start without it;
  3. the entry `…/bin/rarog.mjs` in the plist's `ProgramArguments` belongs to this installation (equal, or the same
     after `realpath`); otherwise the refusal `the service points to another installation (…)` with this
     installation's `service install`. A repo clone next to a service on the npm package gets a refusal naming
     `the rarog package <version> (<dir>)`, with the package restart and the switch to the clone and back
     (`docs/distribution.md`, "Clone next to the package");
  4. the service node exists and is 22.15 or newer (in line 23 at least 23.11); a node other than this command's is
     a refusal in the npm package and a note in a clone;
  5. the directory of the service log (`StandardOutPath`) is this shell's data directory (equal, or the same after
     `realpath`); otherwise a refusal with the `rarog service install` command;
- **no service, no `config.json`** → refusal saying `rarog setup` creates it;
- **no service, `config.json` present** → refusal when `service.wrapper` supplies secrets the environment lacks,
  when Node has no `process.execve`, or when the admin socket `<dataDir>/run/admin.sock` is alive while the
  configured port is silent (a server of these data on another port would stay next to the new one). Otherwise
  `rarog serve --check` and `restart.sh` with the `nohup` start.

Every refusal comes before anything stops; one from `rarog serve --check` (a missing SDK in the npm package
included) ends with `rarog restart: Nothing was stopped.`

Only the front sets the parameters of `restart.sh`, dropping the same names from its parent:
`RAROG_RESTART_LABEL=ai.rarog.server`, `RAROG_RESTART_PORT` (1–65535), `RAROG_RESTART_SERVE=rarog`, `RAROG_LOG`, on
Linux `RAROG_RESTART_UNIT=rarog.service`, and always `RAROG_RESTART_HOOK_REPAIR`. The other values are fixed
choices, not commands. `RAROG_RESTART_HOOK_REPAIR` is a ready sentence, with this installation's commands, that says
how to repair the hook copy (built by `server/src/install/repair.ts`); `restart.sh` only prints it at
`hook: stale`, so the script never assembles a command. A bad or missing value is exit 64 (for the repair
sentence also a control character or over 300 characters). Run by hand (`bash scripts/restart.sh`), the script
refuses with exit 1 and asks for `rarog restart`; given the label of a service that is not loaded, it fails
without a `nohup` start. Both happen before the stop.

`rarog restart` needs Node 22.15 or newer (in line 23 at least 23.11) first in `PATH`; `bin/rarog.mjs` refuses an
older one and suggests `nvm install --lts`. Without the front, with `ai.rarog.server` loaded, launchd alone restarts
the server: `launchctl kickstart -k gui/$UID/ai.rarog.server` (stop and start) and `curl -s localhost:8930/health`,
with no checks and no exits 2 and 3: confirm `herdr: true` and a fresh `uptime` yourself. Tests:
`server/test/rarog-restart.test.ts`.

### `rarog restart` on Linux

The Linux paths of `rarog restart`, `rarog service` and `rarog doctor` are checked on Ubuntu 26.04 with systemd 259,
and the tests run them on fakes shaped like systemd 255 from Ubuntu 24.04. A platform other than macOS and Linux is
a refusal.

Only the unit `rarog.service` from `rarog service install` starts the server. There is no `nohup`: next to a unit
with `Restart=always` it would start a second server, and without lingering logind kills it with the session. The
front checks, each failure a refusal before `restart.sh`:

- the values of `systemctl --user show rarog.service`, not its exit code (a missing unit is exit 0 with
  `LoadState=not-found`): `not-found` → `Install it: rarog service install`; `masked`, `bad-setting` or a bus
  error (e.g. no `XDG_RUNTIME_DIR`) → refusal. `loaded` needs
  `FragmentPath` = `~/.config/systemd/user/rarog.service`, no drop-ins (one could add `Environment=XDG_DATA_HOME`),
  `NeedDaemonReload=no` and empty `Environment`, `EnvironmentFiles`, `PassEnvironment`, `UnsetEnvironment`;
- `RAROG_DATA_DIR` and `XDG_DATA_HOME` empty in the shell and in the user manager's environment (`busctl --user …
  Manager Environment`, which the service gets; fix: `systemctl --user unset-environment <name>`);
- `rarog serve --check` on the manager's environment, as on macOS (a secret set only in the shell does not count);
- the entry and node in `ExecStart` of our unit file by the macOS rule (a shape the `service install` renderer
  does not write asks to install the service again), the node 22.15 or newer (in line 23 at least 23.11), and the
  unit log directory (`StandardOutput=append:`) against the data directory, as on macOS;
- `curl`, `ps` and `pgrep` in `PATH`.

`restart.sh` then gets `RAROG_RESTART_UNIT`. The stop takes listening PIDs from `ss -Hltnp 'sport = :<port>'` and
the candidate's environment from `ps eww` (procps-ng has no `ps -E`). The start is `systemctl --user restart
rarog.service`, which kills the unit's cgroup; a non-zero exit fails the script, and exit 0 does not mean healthy,
so `/health` decides with exits 2 and 3. Without `RAROG_RESTART_UNIT` on Linux the script refuses before the stop;
`RAROG_RESTART_UNIT` with `RAROG_RESTART_LABEL` or `RAROG_RESTART_SERVE`, or on macOS, is exit 64. Tests:
`server/test/rarog-restart-linux.test.ts`.

### `rarog service install|uninstall`

The launchd service `ai.rarog.server` comes from `server/src/cli/templates/launchd.plist`. `ProgramArguments` =
`service.wrapper` from `config.json` + the node that ran the install (`process.execPath`, absolute) +
`<root>/bin/rarog.mjs serve`, where the root is the repo or the npm package directory. It is the entry file, not
the package manager's `rarog` command, because pnpm makes that an sh script that takes `node` from `PATH`. A Homebrew
node goes into the plist as `<prefix>/opt/<formula>/bin/node`, because `brew cleanup` deletes outdated versions
from `Cellar`. `WorkingDirectory` = the root; `<dataDir>/server.log` for both streams; `RunAtLoad`, `KeepAlive`,
`ProcessType=Interactive`; no `EnvironmentVariables`, because `rarog serve` builds the environment.

`install` has two phases because it stops the server the user reaches from the phone. Phase 0 stops nothing, and
each refusal ends with `Nothing was stopped.`. It checks: not an npm package run from the `npx` cache or through
`pnpm dlx` (the service would point to a directory the cache cleanup removes); the lock, the same as
`rarog restart`; the data directory variables as in `rarog restart`; the install node 22.15 or newer (in line 23 at
least 23.11); `rarog serve --check` on an environment like launchd's (`HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`), with `RAROG_IROH=1` also the native iroh module; the admin socket path at most
103 bytes and no server of these data on another port; the first element of `service.wrapper` is an absolute path
to an executable; the plist passes `plutil -lint`; the full `rarog serve --check` through `service.wrapper`, with
the secrets; the service state is not unknown. When `config.json` has a `service.wrapper` with secrets, a person runs
the install in their own terminal, because phase 0 calls that wrapper. A wrapper that supplies no secret (the line
`secrets: not checked`) is a refusal, and so is one that changes the data directory or the port.

A repo clone next to a service that starts the npm package would switch the service to the clone. Without a terminal
(stdin or stdout is not a TTY) `install` refuses right after the lock and prints the command for a terminal. In a
terminal, after phase 0, it lists the changes, what stays (devices, `config.json`, hook copy) and the command back
to the package, then asks `[y/N]`; no and EOF are a refusal. A plist whose target the clone cannot read goes the same
way, with the line `target of the current service unreadable: <reason>` and no command back. A service on another
clone, or on an installation that is gone from disk, switches without a question.

Phase 1: `bootout` of `ai.rarog.server` when loaded; the data directory with mode 0700 when missing; the server log
`<dataDir>/server.log` with mode 0600, created when missing and set to 0600 when present (launchd appends to it and
keeps the mode; a path that is not a regular file, such as a symlink, stays as it is, and an error is a line, not a
failure); the plist written through `rename`; `launchctl bootstrap`; `scripts/restart.sh` with the label, port and
log, called directly because `install` holds the lock; in a repo clone the symlink `~/.local/bin/rarog` → `bin/rarog.mjs` (never over
someone else's file). After each `bootout` the command polls `loadState` every 0.5 s for up to 30 s, because launchd
ends a `KeepAlive` service asynchronously and an early `bootstrap` fails with `Bootstrap failed: 5`; a timeout or
an unknown state on the way is a failure (in `uninstall` a refusal, and the plist stays). A failure from
the first `bootout` on, an exception included, prints the rollback and ends with exit 1 or the exit of
`restart.sh` (in a clone with `cd <repo>` and `node bin/rarog.mjs service uninstall`):

```bash
rarog service uninstall
# Without the CLI (this also breaks the KeepAlive loop of the new service):
launchctl bootout gui/$UID/ai.rarog.server
rm ~/Library/LaunchAgents/ai.rarog.server.plist
```

Every step is idempotent, so resuming after an interruption is the same call. `install` repoints the service even
when the node or entry in the plist is gone (an interrupted update, `nvm uninstall`, `pnpm store prune`).
`uninstall` = `bootout` and removal of the plist; it leaves the data directory and `~/.config/rarog` alone, refuses on
unknown state, in a clone removes `~/.local/bin/rarog` only when it is a symlink to this clone's `bin/rarog.mjs`
(another symlink or a file stays, with a line in the report), and in the npm package then removes Rarog's entries from
`~/.claude/settings.json` after one `[y/N/d]` question (`d` shows the diff) and the hook copy after a list and
`[y/N]`, and prints the rest of the removal
(`docs/distribution.md`, "The `ai.rarog.server` service and its removal"). Tests:
`server/test/rarog-service.test.ts` (plist pattern in `server/test/fixtures/rarog-service/`).

### `rarog service install|uninstall` on Linux

The unit `rarog.service` in `~/.config/systemd/user/` comes from `server/src/cli/templates/rarog.service`:
`StartLimitIntervalSec=0` (the counterpart of `KeepAlive`; the default limit of 5 starts in 10 s would leave the
unit dead), `WorkingDirectory` = the root, `ExecStart` built like `ProgramArguments` on macOS, `Restart=always`,
`RestartSec=2`, `append:<dataDir>/server.log` for both streams, `WantedBy=default.target`, no `Environment=`.
`%` becomes `%%` everywhere and `$` becomes `$$` in arguments; a program, repo directory or data directory with `\`,
`"` or a newline is a refusal.

Phase 0 has the macOS checks with these differences: the data directory variables are checked in the manager's
environment (`busctl`), the manager's `UnitPath` must contain `~/.config/systemd/user` (another `XDG_CONFIG_HOME`
in the manager would hide the unit), the unit has no drop-ins, `curl`, `ps` and `pgrep` are in `PATH`, and the unit
from the template passes `systemd-analyze verify` (no such tool = a `not checked` line). For that check the unit
goes into a temporary file, `~/.config/rarog/rarog-sprawdzany.service` (the name comes from the code), removed
right after the check. The existing unit must be absent or our file (a hand edit is overwritten); masked,
foreign, with a drop-in, failed or unknown is a refusal. Phase 1: atomic write, `systemctl --user daemon-reload`,
`enable`, data directory 0700, the server log 0600 as on macOS, `restart.sh` with `RAROG_RESTART_UNIT`, a lingering
check (`loginctl show-user <user> -p Linger --value`; `no` = a warning with `sudo loginctl enable-linger <user>`,
because without it the service lives only with the login session), and the symlink in a clone. The rollback without
the CLI is `systemctl --user disable --now rarog.service`, `rm` of the unit file and `systemctl --user daemon-reload`.
The clone-and-package question works as on macOS.

`uninstall` = `disable --now`, file removal and `daemon-reload` when the unit comes from our file; no unit = success
with no change; foreign, masked, failed or unknown is a refusal. As on macOS it leaves the data directory and
`~/.config/rarog` alone, removes the symlink only when it points to this clone, and handles the Claude Code settings
and the hook copy the same way. A new install overwrites a hand-edited unit file without keeping a copy.
Tests: `server/test/rarog-service-linux.test.ts` (unit pattern in
`server/test/fixtures/rarog-service/rarog.service`).

### `rarog doctor`

`rarog doctor [--port <port>] [--data-dir <dir>]` (`server/src/cli/doctor.ts`) checks the installation line by line
and only reads (`launchctl print`, `systemctl --user show`); it never writes the hook or `statusLine`: Rarog's
entries in Claude Code settings come only from `rarog setup` and `rarog hooks install`. A line is `ok`, `ERROR` with
a `fix:` line, `warn` with a `fix:` line (works, but with a defect), `info` (no verdict, e.g. a feature turned off) or
`unknown` (no data, e.g. `ps` in the Claude Code sandbox). Exit 0 only when every line is `ok` or `info`, otherwise
1; `result:` counts `ok`, `ERROR`, `unknown` and `warn`. The lines:

1. **installation** (`info`): install mode ("Install modes and the CLI module map" in `docs/distribution.md`),
   directory, version. A directory under the home gets a note: a Claude Code session that writes there can change
   code the service runs outside the sandbox. In the npm package an unwritable parent directory is `warn`: an
   update would fail with `EACCES`, and the fix is a Node version manager (e.g. nvm), not `sudo`;
2. **`/health`** on `127.0.0.1` and the port from `--port`, `RAROG_PORT` in `config.json` or 8930: `ERROR` without
   an answer, at `herdr: false`, `authStore: broken`, `term: false` with `RAROG_TERM=1`, or another version than the
   installed one (fix: `rarog restart`);
3. **service** `ai.rarog.server`: `ERROR` without a loaded service, with a missing service node or one below
   22.15 (in line 23 below 23.11), a log outside the data directory or a target of another installation (fix:
   `rarog service install`); unknown state is `unknown`;
4. **data directory** from the rule or `--data-dir`, with the `serverId` prefix (8 characters) from `devices.json`: a
   conflict, or a shell `RAROG_DATA_DIR`/`XDG_DATA_HOME` pointing elsewhere, is `ERROR`;
5. **Claude SDK** (`docs/distribution.md`, "Claude SDK"): in a clone `SDK: from the workspace`, `ERROR` only at
   `sdk: error` in `/health`; in the npm package `<dataDir>/sdk/<version>/`, a `listSessions` probe and `sdk`
   from `/health`. A missing SDK (also `missing, <other> installed` after an update) or a failed probe is `ERROR`
   with `rarog setup`; a downloaded SDK while `/health` reports another `sdk` than `ok` is `ERROR` with
   `rarog restart`;
6. **live server environment**: `ps -Eww` of the process on the port against `buildServeEnv` on a launchd-like
   environment, secrets by presence only; a non-empty `RAROG_DATA_DIR`/`XDG_DATA_HOME`, a name outside the registry
   or `no config.json` is `ERROR`, values never printed;
7. **iroh listener** (`GET /api/admin/iroh` through the admin socket, never the key): `ok` with the EndpointId (12
   characters), home relay, age of its last event, connections and UDP sockets. Only the first contact with the
   relay shows that the relay accepted the server (`relayContact.firstContactAt`, set when the library's `online()`
   resolves). Before it, the line is `info` "waiting for the first contact" for 120 s after the start, then `warn`
   "has not accepted the connection": check the address in `RAROG_IROH_RELAY`; a relay that admits only registered
   servers lets this one in after a device pairs with it (`rarog pair`). After the contact, no relay address is
   `warn`, and `ok` does not prove the relay is reachable now. `RAROG_IROH=1` without a listener or module, or a
   flag other than `1`/`0`, is `ERROR` (a missing module: `pnpm install` in a clone, a package update in the npm
   package); a growing count of stream closes between runs means a blocked library;
8. **hook**: the check behind the `hook` field of `/health` (the entry in `~/.claude/settings.json` and the copy in
   `~/.claude/hooks/rarog/`), with the fix from `rarog hooks doctor`;
9. **consent channel** (the `consent` field of `/health`, `RAROG_CONSENT_CHANNEL` in "Preferences and feature
   flags"): `ok` at effective `main` or `all` equal to the configured mode; configured `main` or `all` with another
   effective mode is `ERROR` with the fix for the reason; `rarog dialogs off` is `warn` with the `config.json`
   entry; reason `starting` is `unknown`; `off`, `shadow` and a server without the field are `info`;
10. **consent channel settings** (`~/.claude/settings.json`, read only): `sandbox.network.allowAllUnixSockets: true`
    or an `allowUnixSockets` entry that covers `<dataDir>/run/admin.sock` or `consent.sock` is `warn` (a sandboxed
    agent would get the owner's power or could block channel cards), and so is a second `PermissionRequest` hook
    besides Rarog's (it can answer the same dialog). Doctor does not see project settings, so this warns and does
    not protect; a clean file is `info`;
11. **consent without a hook** (`server/src/cli/doctor-no-hook.ts`): the `consent: no hook` lines of the last 7 days
    (`docs/dialogs.md`, "Refusal diagnostics") from the end of `<dataDir>/server.log` (at most 32 MiB; a line
    without the time prefix does not count), one line per cause with the count, Claude Code versions, tools and
    sessions. `hooks-disabled` is `warn` with `disableAllHooks` (or `allowManagedHooksOnly` in managed settings) as
    the fix, `outside-work-area` is `warn` with a root of the work area (`RAROG_HERDR_ROOTS`, then `rarog restart`),
    `not-in-session-hooks` is `warn` with `rarog hooks doctor`, `rarog setup` and a session restart;
    `hook-running`, `unexplained` and a cause doctor does not know are `info`, and so is no line at all. No data
    directory or an unreadable log is `unknown`. Under the service the log is appended to and never rotated; a start
    without the service (`restart.sh` with `nohup`) rewrites it, so the window then begins at that start;
12. **`statusLine`**: a command in `~/.claude/settings.json` plus a `*.json` file in `~/.claude/statusline/` younger
    than an hour; no command is `ERROR` with `rarog setup` (block to paste: `rarog hooks statusline`); a command
    pointing to `~/.claude/hooks/rarog/rarog-statusline.mjs` while that copy is missing or differs from the repo is
    `ERROR` `stale`: review `rarog hooks doctor`, then run `rarog hooks install` (`docs/dialogs.md`, "`statusLine`
    script from the copy");
13. **herdr socket** (`RAROG_HERDR_SOCKET` or `~/.config/herdr/herdr.sock`); a missing socket is `ERROR` with
    `start herdr`, or `launchctl kickstart gui/<uid>/ai.rarog.herdr` when the macOS herdr agent is loaded and not
    running. On macOS with `~/Library/LaunchAgents/ai.rarog.herdr.plist` present, a **herdr agent** line follows
    with the verdict of the setup step ("`rarog setup`"): running is `ok`, herdr running outside it or a start at the
    next login is `info`, a stopped agent, an unloaded one while herdr is not running, a missing program, another
    socket or an unreadable plist is `ERROR` with its command, and an undetermined `launchctl print` is `unknown`;
14. **`rarog` in `PATH`** (in a clone the symlink `~/.local/bin/rarog`, in the package the package manager's bin
    directory: npm `<prefix>/bin`, pnpm `pnpm bin -g`); a symlink to another installation ahead of it is `warn`;
15. **PR status** (`docs/pull-requests.md`, "State on GitHub"; `server/src/cli/doctor-pr-status.ts`): `gh` looked
    for in the server's directory list with `HOME` from the service environment, then
    `gh auth status --active --no-refresh --hostname github.com` with the same closed environment as the server's
    reads: only the active account, the one the reads use, and no token refresh, so the check writes nothing.
    Session cards list PRs only with `gh` and a login, so the lines without them say that cards show no PRs.
    `RAROG_PR_STATUS=0` is `info`; the demo and its review mode (`RAROG_DEMO=1`) are `info` about the fixed state
    source, with no lookup and no process; no `gh` is `warn` (fix: install the GitHub CLI in one of the directories,
    `gh auth login` and a server restart, or set the flag to `0`); not logged in, or a check that did not finish,
    is `warn` (fix: `gh auth login --hostname github.com` as the user the service runs as; the server picks it up
    within 30 min); a `gh` that refuses `--active` or `--no-refresh` is `warn` (fix: update the GitHub CLI);
    logged in is `ok`. Without a usable `config.json` the line is `info` and nothing runs.

On Linux, line 3 reads `systemctl --user show rarog.service` (the checks of "`rarog restart` on Linux", plus
`ActiveState` = `active`, `UnitFileState` = `enabled` and lingering, where `no` is `unknown` with
`sudo loginctl enable-linger <user>`), and line 6 reads `/proc/<pid>/environ` against the manager's environment
from `busctl`. Whether `tsx` adds other variables on Linux than on macOS is unmeasured.

`--port` and `--data-dir` point `rarog doctor` at a trial instance, e.g. one started with
`rarog serve --port <port> --data-dir <dir> --env NAME=value`: `/health`, `lsof` and the expected `RAROG_PORT`
take the flag's port, and the data directory and the expected `RAROG_DATA_DIR` take the flag's directory. The
trial's `--env` variables differ from `config.json`, so the live environment line shows them as `ERROR`; for a
trial that is expected and needs no fix. Tests:
`server/test/rarog-doctor.test.ts`, `server/test/rarog-doctor-linux.test.ts`,
`server/test/doctor-pr-status.test.ts`, `server/test/doctor-no-hook.test.ts`.

### `rarog setup`

`rarog setup [--tailscale] [--tailscale-only] [--iroh-relay https://host[:port]/] [--data-dir <dir>] [--verbose]`
installs the server on a fresh account step by step; the steps as the user sees them are in `distribution.md`,
"`rarog setup`: install on a fresh account". This section says what it writes and what it leaves alone.

What it shows (`server/src/cli/setup-screen.ts`): on a terminal a line per step (mark, title, result, time; the
running step is a live line with a spinner), the questions between them, and a last step line for the closing
check; without a terminal a plain line per step (`[n/N] ok <title>: <result>`) with no escape byte. A step that asked
a question or prompted for a key shows no time on its line (the time went to the answer); the run log keeps it. A
step that ended `ok` and changed nothing (it wrote, downloaded, installed or restarted nothing; the step says so
itself) has no line of its own in either mode. In a run in which no step changed anything, one line right before the
closing check counts them, ` ✓ <n> checks ok, nothing changed` (`[ok] <n> checks ok, nothing changed` without a
terminal); a run with a change, also one behind a `!` or `✗` line (a partial write), has no such line. The check
always has its own line. `N`
counts the steps and the check: 10 on Linux and macOS, where the seventh step is the `herdr.service` unit on Linux and
the herdr agent on macOS, and 9 elsewhere, where that step is not counted and the log says it does not apply.
A step that changed something says what (`created`, `key created`,
`installed`, `updated`, `5 entries … added`, `<version> downloaded`). In the Settings step the entries that wait for
the hook copy are one phrase after what was added: `! Settings  2 entries added, 3 wait for the hook copy` with
`Fix: rarog hooks install, then rarog setup`. `✓` marks only a goal reached; a step that is
not used or waits is `–`: `– Tailscale  not used (iroh only)` after a new `config.json` without Tailscale, or
Tailscale's own state when that is the reason: `logged out`, `stopped` or `not running (iroh only)` (a
`config.json` from before that does not use it is a check without a change), and a step that cannot run because a
step before it did not finish is `– <step>  waits for <step>`, without a command (`– Service  waits for Claude SDK`,
`– Check  waits for Claude SDK`; on Linux a `systemctl --user` that does not answer makes `Service` and `Check`
wait for `Tools`). A step that is missing
something or failed says on its own line what in one sentence (the Tools step names the missing tools; the tool's own
message, the full refusal and the reasons of a settings conflict go to the run log), with one `Fix:` line under it, and
never points at detail lines the screen does not show; a `✗` line also has a `Log:` line. A question the user said no
to is `! <step>  declined` with the command that offers it again in `Fix:`: `! Hook copy  declined` with `Fix: rarog
hooks install`, `! Tailscale  declined` with `Fix: tailscale serve --bg --https=<P> <port>`. A service whose state
`launchctl print` (or `systemctl --user`) does not give is `✗ Service  state undetermined` with `Fix: check launchctl print
gui/<uid>/ai.rarog.server in a regular terminal, then rarog setup`. A service that starts another installation leaves
the hook copy unwritten: `✗ Hook copy  the service starts another installation` with `Fix: rarog service install,
then rarog hooks install` (in a repo clone the service installation's own `hooks install` command). A failed
Claude SDK download is `✗ Claude SDK  download failed (<npm error code>)` with `Fix: check the network, then rarog
setup`; a node with no npm next to it (one from `pnpm env use`) is `✗ Claude SDK  no npm next to node` with
`Fix: install Node with npm (nodejs.org or nvm), then rarog setup`. herdr not running is `! Service  herdr is not running` with
`Fix: start herdr, then rarog setup`; a loaded service that does not answer `/health` is `✗ Service` with its
answer and the restart command of the install mode, or, when the service starts another installation (its target,
or the version its `/health` reports), the command that points it at this one (`rarog service install` under pnpm).
A loaded service of this installation whose `/health` reports `herdr: false` while the herdr socket does not answer
is `✗ Service  herdr: false` with `Fix: run herdr in a terminal, then rarog setup` (on Linux with a `herdr.service`
unit, `systemctl --user start herdr.service, then rarog setup`; on macOS with the herdr agent loaded and not running,
`launchctl kickstart gui/<uid>/ai.rarog.herdr, then rarog setup`): the server reconnects to herdr by itself, and
a restart would not start herdr. When the socket answers, setup reads `/health` once more after the server's 2 s
herdr ping cache (a herdr started moments ago); still `herdr: false` means the server does not reach that herdr, and
the fix is the restart command. When the herdr unit or the herdr agent was written in this run and its line still
has a `Fix:` (the unit not enabled, the agent's `launchctl bootstrap` failed or its herdr does not answer), herdr not
running gives no second fix: the Service step waits for that step (`– Service  waits for herdr unit`), with or
without a loaded service.
In `rarog update --finish` a status line script copy updated by the run is `✓ Settings  status line script
updated`. A step line fits 60 columns where it can: it names the secrets file relative to the config directory
and leaves the herdr socket and the settings backup to the log. A longer result and the sentence of a `Fix:` line
wrap at the screen width (the lines under `Fix:` indented under its sentence), a path breaks after a `/`, and a
command to copy that stands on a line of its own under `Fix:` never wraps.
On a terminal with colour the header is bold with the version dimmed, the `?` of a question is
cyan, `Fix:` and `Next:` are bold, and paths, `Log:` lines and times are dimmed; `NO_COLOR` turns off only the
colour. On a terminal without `--verbose` (with or without `NO_COLOR`) an answered question leaves the screen: the
cursor goes up by the rows of the prompt and the screen is cleared below it, so the step line stands where the
question stood; a sentence written right above a key prompt leaves with it. The question stays when its rows are
not certain: the terminal does not report its columns, the columns changed between the question and the answer, a
prompt line or the last prompt line with the typed answer is as wide as the terminal, or the answer was `d` at a
`[y/N/d]` question (that question, the diff and the repeated question stay). Without a terminal and with
`--verbose` every question stays. EOF (Ctrl-D) at a question starts a new line. Ctrl-C ends the running step as `✗ <step> interrupted` and
prints `Interrupted. Nothing after this step was changed.`, at the plan question (before any step) `Interrupted.
Nothing was changed.`, with the run log path, once the log is open, on a line of its own under it; exit code 130.
A bad argument is one sentence and `Run rarog setup --help.` on stderr, exit 64 (the same for every `rarog`
command). On a terminal the usage text of `--help` of every command and the one-line refusals of `rarog update`
wrap at the screen width; every line of the usage text keeps its own line (an option such as `--verbose:` starts one)
and wraps under its own indent, a command line deeper; without a terminal they stay as written.
The detail lines of the steps (backups, the herdr socket the service step waited for, the output of
`rarog service install` and `restart.sh`, the `/health` fields the check read, the update command of the npm package)
go to the run log `<data directory>/logs/setup-<yyyymmdd-hhmmss>.log` (directory 0700, file 0600, the
ten newest kept), whose step headers `[n/N] <step>` count the closing check like the step lines and which keeps the
plain line of every step, also of the steps without a change. The log file is
written from the first "y" or the first `✗` line on; a run without either, or without a terminal, writes no file. The diff of
`~/.claude/settings.json`, the lines that quote the file and the blocks to paste (a `statusLine` block can carry the
user's own command) never go to the log: it gets one line per settings operation (operation, keys, `added`,
`declined`, `conflict`…). `--verbose` puts the detail lines, the step headers `[n/9] <step>`, the settings diff
before its question, the `Summary:` block and the check (its `/health` line, then `check: <result>` and a `Fix:`
line) on the screen as plain lines (no `\r`, no colour), and ends with the update command; without it the settings
diff is not shown. Blocks to paste stay on the screen in both modes.

The closing check (`server/src/cli/setup-check.ts`) does not run `rarog doctor`; it judges the server in the context
of this run. A service found loaded or installed in this run: setup waits up to 30 s for `/health` with `herdr: true`
and a resolved consent channel, then `✓ Check` names the fields (`hook`, `SDK`, `herdr`, `consent`), and a field
that is not fine is a `!` with `Fix: rarog doctor`. A server on another version than this package (the service still
runs the old code) is `! Check  server runs <version>` with the command after which the service runs this
installation, and its fields are not judged: `rarog restart` for an npm package, `rarog service install` for a pnpm
package (each pnpm version has its own store directory, and `rarog restart` refuses a service that points at another
one) or a layout the registry does not know, `pnpm run restart` in a clone (`afterUpdate` in
`server/src/install/repair.ts`, the one source of this advice). No healthy answer within 30 s is `✗ Check` with
`Fix:` and `Log:` and exit code 1. No running service is `– Check  waits for <step>`, naming the step that carries the
fix (`Service`, or the step the service waited for). When the npm package's commands directory (`<prefix>/bin`) is
outside the `PATH` of this process or under a Node version manager (`~/.config/nvm`, `~/.nvm`, fnm, volta), whose
default version a new terminal may switch, every command the run names, the `Fix:` lines and the pairing command,
is in the absolute form `'<node>' '<package>/bin/rarog.mjs' <command>` (quoted for the shell; it needs no `rarog` and
no node in `PATH`); another layout (pnpm) gets that form when no `rarog` is in `PATH`. The run log notes the
absolute form; the screen has no line of its own for it. A `Fix:` line wider than the screen in that form leaves
`Fix:` and the words around each command on their own lines and puts each command alone on an indented line, so it
copies whole. The run ends with `Done in N s.` and, when it ends with exit code 0 (a green `✓ Check`, no step that
sets the exit code and no `✗` or `!` line) with no active device in the data directory, `Next: rarog pair (QR code
for the app)`; with the absolute command wider than the screen it is `Done in
N s. Next (QR code for the app):` and the command alone on the next line. A run that ends with exit code 0 under `!`
lines says how many steps need a fix instead, without `Next:`: `Done in N s; 1 step above needs a fix.` (`2 steps
above need a fix.`). "n" at the plan question ends the run with `Nothing changed.` and exit code 1, except on a plan
whose only item is the herdr agent or unit: there "n" declines just that item and the run goes on.

The transport of a new `config.json` follows the machine:

- **iroh** when the native iroh module is installed (the package manifests, read without loading native code:
  Apple silicon, Linux x64 and arm64): `RAROG_IROH=1`, `RAROG_IROH_RELAY` with the production relay
  `https://relay.rarog.ai/` or the one from `--iroh-relay` (normalized like the `r` field of the pairing link), and
  a new server key `RAROG_IROH_KEY` in the secrets file. `RAROG_IROH_PORT` stays unset (the system picks the UDP
  port), because a fixed port only matters for a firewall rule.
- **Tailscale** when `tailscale` is in `PATH` and `tailscale serve` can have a port P of the pool 8931–8960 (the
  server port 8930 is outside it): `RAROG_ORIGINS` is the address from `tailscale status --json` with that port
  (`https://<host>:<P>`), then step 4 (`tailscale serve --bg --https=<P> <port>`). Setup reads `tailscale serve
  status --json` once and takes, in this order, a pool port already mapped to the server, port 443 already mapped to
  it (the address then has no port), or the first free pool port. A port is
  mapped to the server when `TCP["<P>"]` has `HTTPS: true` and `Web` has only `<host>:<P>` on that port, with `/` as
  its only handler and a proxy to `http://127.0.0.1:<port>` or `http://localhost:<port>`. Any other key on P in
  `TCP` or `Web`, or in a foreground session (`Foreground.*.TCP`, `Foreground.*.Web`), is another site's mapping, and
  the port is skipped; mappings on other ports do not matter. An unmapped port is free when a TCP connection to it on
  every Tailscale IP of the machine (`Self.TailscaleIPs`) is refused. `tailscale serve` listens on the Tailscale
  address and the port, so a server on loopback alone does not take the port, while one on a Tailscale address or on
  all addresses would lose its tailnet traffic. An address that accepts makes the port in use; no answer within 2 s
  (one deadline for the whole pool, probed at once), or no Tailscale IP, leaves it not checked; both are skipped, with
  no question. A Tailscale IP that answers no probe of the pool while another one answers drops out, also for the
  check right before `tailscale serve`: macOS does not answer a connection to its own Tailscale IPv6 address.
  `lsof` only names the process in the run log line that lists the skipped ports. A `tailscale serve
  status --json` that fails leaves the whole pool not checked.
- Both when both are there and a pool port is available, unless the user chooses Tailscale only ("Tailscale only"
  below). With the iroh module, no port (`no free port in 8931–8960
  for tailscale serve: N mapped, N in use, N not checked`) or a Tailscale that is not up leaves iroh only: no
  `RAROG_ORIGINS`, and step 4 reports `info` with the reason. Tailscale is not up when `BackendState` in `tailscale
  status --json` is `NeedsLogin` or `NeedsMachineAuth` (logged out) or `Stopped` (stopped), whatever `Self.DNSName` says, or
  when the command fails (not running). Without the module (an Intel Mac) the same cases are a refusal, because no
  transport is left, and without `tailscale`, or with Tailscale logged out or stopped in a terminal, Tailscale is a
  missing tool (in a terminal the run stops before the plan screen, below, with `Fix: log in to Tailscale (tailscale
  up)` or `start Tailscale (tailscale up)`); in both no `config.json` is written. `--iroh-relay` without the module is
  ignored with a warning, and with an existing `config.json` it is ignored with a sentence.

An existing `config.json` keeps its transport; only `--tailscale` adds the Tailscale address to one without an
address (below).

#### Tailscale only

A first setup in a terminal, on a machine with the iroh module and `tailscale` in `PATH`, asks one question before
the plan screen, with two explanation lines above it (`server/src/cli/setup-tailscale-only.ts`):

    Standard: encrypted, the app connects from any network.
    y: encrypted too, the app connects only in your tailnet.
    ? Connect the app only through Tailscale? [y/N]

Enter, "n" and EOF keep the transport above. "y", or `--tailscale-only` without the question, leaves iroh out: the
new `config.json` gets `RAROG_IROH=0` with `RAROG_IROH_RELAY` set to the production relay (kept for a switch back),
the Tailscale address with a pool port and no server key, and step 4 maps the address as above. The plan item reads
`config, Tailscale only (chosen)`, and the run log `transport: Tailscale only (chosen)`. The answer writes nothing
and opens no run log: "n" or EOF at `Continue? [Y/n]` afterwards leaves no file, the logs directory included. The
choice covers only the connection between the app and the server. Notifications still go through the push relay on
the internet with encrypted content, as with iroh; `RAROG_PUSH=0` turns them off ("Killswitches").

In a terminal, after "y" or with the flag, the run stops before the plan with nothing written when Tailscale cannot
carry the connection: `Rarog cannot run without tailscale; nothing changed.` with `Fix: install Tailscale, then
rarog setup --tailscale-only` (`then rarog setup` after the question), and `Rarog cannot run without a logged-in
Tailscale` or `a running Tailscale` with `log in to Tailscale (tailscale up)` or `start Tailscale (tailscale up)`.
Tailscale read again after `Continue?`, with HTTPS off in the tailnet or no free pool port, is a refusal that says
`no transport: Tailscale only (chosen)`, and `config.json` is not written. A mapping of this server that Tailscale
Funnel publishes (`AllowFunnel` in `tailscale serve status --json`) is a refusal too, `Tailscale Funnel makes
https://<host> public on the internet` with `Fix: tailscale funnel --https=443 off, then rarog setup`, and setup
leaves the mapping alone. `--iroh-relay` with `--tailscale-only` is ignored with a warning (the production relay is
written), and `--tailscale` with it is `--tailscale-only` alone.
Without a terminal the flag writes nothing, like every first setup there. Without the iroh module or without
`tailscale` in `PATH` the question does not come, and the transport follows the machine.

With an existing `config.json`, `--tailscale-only` writes nothing and exits 1 with `--tailscale-only is for a new
config.json; nothing changed.` and a `Fix:` that points to this section. To switch an installation by hand:

1. In `~/.config/rarog/config.json` set `"RAROG_IROH": "0"` in `env` and keep `RAROG_IROH_RELAY`. The file needs a
   Tailscale address in `RAROG_ORIGINS`; `rarog setup --tailscale` adds one.
2. `rarog restart`.
3. A device paired without the Tailscale address (its pairing link had only iroh) cannot connect: `rarog devices
   revoke --all`, then `rarog pair`, then the other devices from the first one's app (Settings → Pairing → Pair New
   Device). A revoked device loses its unsent messages and drafts.

Back to iroh: `RAROG_IROH` to `1`, `rarog setup` (it asks to create the missing server key), `rarog restart`, and a
new pairing for the devices that should use iroh.

Setup uses the data directory the service will use (`server/src/install/data-dir.ts`): `--data-dir`, otherwise the
directory of the installed service's log, otherwise the rule from "Data directory" on the service environment; a
shell directory that differs makes the SDK step refuse. An npm package run from the `npx` cache or through pnpm
(`pnpm dlx`, `pnpm exec`) refuses at once and gives `npm i -g @rarog/server` or `pnpm add -g @rarog/server`.

Setup writes only what is missing (`lstat` gives `ENOENT`), through a temporary file and `link` (a parallel `setup`
gets `EEXIST`). Before the first step a plan screen, `Rarog will set up on this Mac:` (`on this machine:` on
Linux), lists Rarog's own missing parts (`config.json` with the server key, the hook copy of a clone, the herdr agent
on macOS or the `herdr.service` unit on Linux, the Claude SDK of the npm package, the service), each with where it
goes, at most 7 lines at 60 columns, and asks once, `Continue? [Y/n]` (Enter is yes; there is no `d`, as for the
service). "n" or EOF stops the run before any write and before the run log, with exit 1 and the hint
`rarog setup --help`; on a plan whose only item is the herdr agent or unit it declines just that item, and the run
goes on without it. With nothing missing the screen does not appear. The tools check of step 1 runs once, before
the plan screen, and step 1 reports what it found. In a terminal without a `config.json` a missing tool (any tool of
step 1, the transport included: neither the iroh module nor `tailscale` in `PATH`, or no iroh module and Tailscale
logged out or stopped) stops the run there instead: one
sentence that names the missing tools (`Rarog cannot run without claude and herdr; nothing changed.`), a `Fix:` line
with what to do (`install Claude Code`; `log in with a systemd user session` when `systemctl --user` does not
answer), exit 1, nothing written and no run log. With an existing `config.json` (also one with the
address of your own reverse proxy and neither iroh nor Tailscale) and without a terminal step 1 reports the missing
tools and the run goes on. A foreign file or setting keeps its own
question (`[y/N]`, or `[y/N/d]` for Claude Code's settings), in the form of the plan question: `? `, the sentence
wrapped one column short of the screen width (a line as wide as the terminal would keep the answered question on
the screen), the hint at the end. Without its clauses a question's sentence fits one line at 60 columns, and only
its hint may take a second one; the Settings question with herdr's hook takes two:

- the iroh server key, before `config.json` and under Rarog's lock in `~/.config/rarog/` (`server/src/cli/lock.ts`;
  another `setup` or a `set-key` writing at that moment gets a refusal with the PID): 32 random bytes as 64 hex
  characters in `~/.config/rarog/secret/private.env` (file 0600, directory 0700). A missing file is created; a file
  without the key, or with an empty `RAROG_IROH_KEY=` line (the server reads it as no key), keeps its other bytes
  and gets the line appended or the empty one filled. Both go through the atomic write of `rarog dictation set-key`
  (`server/src/cli/secrets-file.ts`), then setup reads the key back. A key that is there stays, and a key of the
  wrong shape stops the step. The value never shows on screen or in a message. A setup interrupted between the key
  and `config.json` leaves only the key, and the next run takes it;
- the voice keys (`server/src/cli/setup-voice.ts`), only when `config.json` is written in this run and the terminal
  can ask a hidden question: `? Set up dictation with Soniox now? [y/N]`, after "y" the hidden prompt
  `? Soniox EU key (hidden):`, then, only with a Soniox key, `? Set up the voice agent now (OpenAI key, paid)?
  [y/N]`, one cost sentence and `? OpenAI API key (hidden):`. A line above each question says what the feature does
  and where its key comes from. The questions come in step 2 after the transport and before the lock;
  a key the secrets file already has is not asked for (`… key kept`). Under the lock, after a check that
  `config.json` is still missing (another run that wrote it meanwhile wins, and this one writes nothing, keys
  included), the typed keys go into the secrets file as `SONIOX_API_KEY` and `OPENAI_API_KEY` through the same
  atomic write (the secrets directory is created 0700 also without iroh), and `config.json` gets
  `RAROG_COMPANION=1` when the file now has both keys, the flag rule of `rarog voice-agent set-key`. An empty key or
  Ctrl-D at a prompt skips that feature with a `skip` line, a key with a space or a control character is not saved
  (no network check: a wrong key shows at first use), and Ctrl-C at a prompt ends setup with exit 130 and nothing
  written. Screen and log get only `dictation: on (Soniox key saved|kept)` or `off` and `voice agent: on (OpenAI key
  saved|kept)` or `off`, never a value. The `off` line of a feature left off (a plain "n", an empty key, a key not
  saved) ends, after the reason in brackets when there is one, with the command that sets the feature up any time:
  `rarog dictation set-key` (`rarog voice-agent set-key`), on the screen and in the log. The log adds that the
  app's Settings → Dictation (Settings → Voice Agent) shows where to get the key; the app takes no key. Without a
  Soniox key the voice agent question is not asked, and only the log says the voice agent needs dictation first and
  names `rarog voice-agent set-key`, because the screen of a first setup has no line to spare. Where answered
  questions leave the screen, a typed key that was saved shows as the short line `dictation: on`
  (`voice agent: on`); elsewhere the key prompt stays on the screen and that line goes only to the log. The log
  keeps the questions, the answers (never a key) and the full outcome lines. When a service was there before this
  `config.json`, a line says `rarog restart` makes it read the file, because setup restarts nothing;
- `~/.config/rarog/config.json` (file 0600, directory 0700), in the same lock: `RAROG_ORIGINS` (Tailscale),
  `RAROG_HERDR_LAUNCH=1`, `RAROG_TERM=1`, `RAROG_PUSH=1`, `RAROG_PUSH_RELAY_URL` with the production push relay,
  `RAROG_PROJECT_ROOTS` and `RAROG_HERDR_ROOTS` both home (see "The work area of a new `config.json`" below),
  `RAROG_HERDR_BIN` with the `herdr` it found,
  `RAROG_IROH=1` and `RAROG_IROH_RELAY` (iroh), `RAROG_COMPANION=1` (both voice keys); then it reads the file back
  with the validation of `rarog serve`;
- with `--tailscale`, the Tailscale address in an existing `config.json` that has no address (`RAROG_ORIGINS`
  missing, empty, blank or only entries the server skips; code `server/src/cli/setup-tailscale-add.ts`). Before the
  plan screen setup reads `tailscale status --json` and picks a pool port as for a new file, and the plan shows
  `Tailscale address in config.json` with the address. After "y", step 4 reads `tailscale status` and the port again
  (an address other than the plan's changes nothing) and, under Rarog's lock, puts the address in front of
  `RAROG_ORIGINS` (skipped entries stay behind it); every other byte of the file stays. It writes only a file in the
  exact layout setup writes, through a temporary file with the file's mode and `rename`
  (`server/src/cli/config-rewrite.ts`); a file changed since it was read, a file that would grow past 64 KiB or a
  failed write is `✗` with nothing changed, and a file in another layout is `✗` with the line to set by hand. Then
  step 4 maps the
  address (next item). Without `tailscale`, with Tailscale not up, with HTTPS off or with no free pool port the step
  is `✗` with the reason and a `Fix:` that ends in `rarog setup --tailscale`; without a terminal it is `!` with `Fix:
  run rarog setup --tailscale in a terminal`. An address already in the file gets the note `config.json already has
  an address (<address>); --tailscale adds nothing.`, and without a `config.json` the flag adds nothing to the first
  setup. Setup restarts nothing: after the write two notes say that the server reads the address after `rarog
  restart`, and that devices paired before keep connecting over iroh and get the address from a new pairing (`rarog
  devices revoke --all`, then `rarog pair`, then the other devices from the first one's app: Settings → Pairing →
  Pair New Device; a revoked device loses its unsent messages and drafts);
- `tailscale serve --bg --https=<P> <port>`, only when the address with pool port P came from `tailscale status` in
  this run (for a new `config.json` or from `--tailscale`), or `--tailscale` finds this machine's address with a pool
  port in `config.json` (a run cut short after the write), P has no mapping before the question, and right before the
  command P is still free by the check of step 2 (no mapping on P, every Tailscale IP refuses a connection). A
  mapping on P made meanwhile is `✗` with `state changed meanwhile`, and a port in use or not checked now is `✗`
  with the command in the sentence; setup runs nothing. The step looks only at port P of the address: mappings on
  other ports belong to other sites and stay as they are. P mapped to the server is `✓`, P mapped elsewhere is `✗`
  with `foreign mapping`. An address already in `config.json` without its mapping is `!` with
  `Fix: tailscale serve --bg --https=<P> <port>`; an address without a port is judged the same way on port 443 and
  gets `Fix: tailscale serve --bg <port>`. HTTPS off in the tailnet (`tailscale status --json` read after the plan
  question, with `CertDomains` empty or `null`, or a `Self.CapMap` without the `https` key) is
  `✗ Tailscale  HTTPS is off in your tailnet` with `Fix: enable HTTPS in
  the Tailscale admin console, then tailscale serve --bg --https=<P> <port>`, before the question and without
  `serve`, because the client then prints an address to enable it and exits 0 or waits. The address stays in
  `config.json`, so after HTTPS is on that command is the only step left. A client whose output has neither field
  (`CapMap` alone may be left out) goes on as before. After `serve` exits 0
  the step reads `tailscale serve status --json` again and counts only the mapping of P to the server port; without it,
  and when `serve` fails or does not finish in 30 s, the step is `✗` with `Fix: tailscale serve status, then rarog
  setup`, and the client's stdout and stderr go to the run log. A `config.json` with `RAROG_IROH=1` and no
  `RAROG_ORIGINS` skips the step as `info`, with the reason when this run left the address out;
- the hook and `statusLine` script copy in `~/.claude/hooks/rarog/`: into a missing or empty directory (a clone: an
  item of the plan screen; the npm package: after the diff of the package files and its own question), or over a
  copy that differs from its source, after the diff (in a clone, after the `git log` of the hook changes) and a
  question; never over a copy changed after its install (a hash differs from the manifest), and never while the
  service points to another installation (`docs/dialogs.md`, "The copy is written by the installation the service
  starts");
- Rarog's own five entries in `~/.claude/settings.json`, after one `[y/N/d]` question in the Settings step:
  the permission hook and the context hook (only with a hook copy that matches its source), `statusLine` (the script
  copy command, or a custom command chained behind it; only with a matching script copy), and the paths
  `~/.config/rarog/secret` and `<dataDir>/run` in `sandbox.filesystem.denyRead`, and the write block rules
  `Edit(//<dataDir>/**)` and `Edit(//<home>/.config/rarog/**)` in `permissions.deny` for the data directory of the
  installed service (`docs/security-model.md`, "Pairing and device keys"). The question says how many entries
  go into which file (`? Add 5 Rarog entries and herdr's hook to ~/.claude/settings.json? [y/N/d]`), with a clause
  when the user's own `statusLine` command gets chained and a sentence before it when the file gets reformatted; `d`
  shows the names of the entries and the full diff on the screen (never in the run log) and asks again.
  "y" makes one write with one backup; an
  entry in conflict drops out with its own `!` line and `Fix:`, the rest goes in. In an existing file
  it replaces Rarog's own old entries, keeps everything else, saves the original to
  `<dataDir>/claude-settings-backup/` and writes under Rarog's lock (`docs/dialogs.md`, "Writing the hook
  entries");
- the Claude SDK, npm package only: `<dataDir>/sdk/<version>/` from `npm ci` (`docs/distribution.md`, "Claude
  SDK"), an item of the plan screen in two lines: version, size and Anthropic's terms, then the terms link alone;
- the service through `rarog service install`, an item of the plan screen, installed only with the SDK ready, no
  trace of a service, and the herdr socket responding.

Step 3 checks the secrets file `~/.config/rarog/secret/private.env` (0700 directory, 0600 file, registry names)
and names `rarog dictation set-key` while the Soniox dictation key is not set; with `service.wrapper` it skips the
file. Without `RAROG_IROH=1` the file is optional. With `RAROG_IROH=1` in an existing `config.json` and no key in
the file, step 3 asks whether to generate the key and writes it as above; after "n" or without a terminal the key is
missing, and the service step waits for it.
Apart from its entries in `~/.claude/settings.json`, a hook copy that differs from its source (above), a missing iroh
key in the secrets file, the Tailscale address of `--tailscale` (above) and herdr's installer (below), setup changes
nothing that exists, also after a yes: the rest of an existing `config.json` stays as it is (also without iroh), and
a broken `config.json`, a hook copy
changed after its install, a foreign `tailscale serve` mapping, an existing service or a `rarog` symlink to another
checkout give a diagnosis and a fix command. A settings file that is
not strict JSON, a key of the wrong type, or a command that looks like Rarog's but is not one Rarog printed, gives a
refusal or a conflict; after "n" the step names `rarog hooks print`, which prints all five entries for a manual
paste. Tools (Node, Claude Code, herdr,
`curl`, Tailscale when there is no `config.json` and no iroh module; on Linux procps and `lsof` or `ss`) are
checked, never installed; a `claude` only in `~/.local/bin`
gives a warning, because a herdr pane may not find it. With herdr found, setup runs the read-only `herdr integration
status`. For `claude: not installed` or another state than `current` the Settings question also covers
`herdr integration install claude`, which makes herdr, not Rarog, write its own `SessionStart` hook to
`~/.claude/settings.json` (`d` says so under Rarog's diff). After "y" it runs the command after Rarog's write
(arguments without a shell, 30 s limit) and reads the status again; an error is a `!` line with herdr's stderr and
`Fix: herdr integration install claude`, and Rarog's entries stay. After "n" or without a terminal nothing is
written.

**The work area of a new `config.json`.** Setup does not ask about project directories. A new `config.json` gets
home in `RAROG_PROJECT_ROOTS` and `RAROG_HERDR_ROOTS`, which means home without its hidden folders and the folders
macOS protects (`docs/security-model.md`, "Work area: where Rarog starts, lists and reads"). The plan screen says so
in one line with the key that narrows it, `Work area: home (RAROG_PROJECT_ROOTS in config.json).`; a change to the
keys takes effect after `rarog restart`. An existing
`config.json` keeps its roots byte for byte, whatever they are, and no command changes them. A hook copy older than
the install (from before the `exclude` field of `roots.json`) reads only the roots, so with home as a root its hooks
act in `~/.cache` and `~/Desktop` until the copy is updated; the hook copy step of the same run asks for that update.

On Linux, when herdr is not running and no `herdr.service` exists (the manager does not know one and no directory of
its `UnitPath` holds one), the plan screen lists `herdr.service  ~/.config/systemd/user`, and the one `Continue?`
covers it; the step has no question of its own. The plan reads herdr's socket from an existing `config.json`. The
unit: `ExecStart=<herdr> server`, `Environment="PATH=…"`, `Restart=always` (`herdr server stop`
after an update exits 0), `WantedBy=default.target`. A herdr pane inherits the herdr server's `PATH`, and the
`systemd --user` manager does not read `~/.profile`, so the unit's `PATH` lists the directories of `claude`, of
setup's node and of herdr before the manager's `PATH` and
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. After "y" setup creates the directory when it is
missing and refuses one that is a symlink, not a directory or owned by another user; it reads the unit's place
again right before the write and writes the file only while the name is free (a temporary file linked to it, mode
0644), never over a unit that appeared meanwhile. The written unit goes to the run log, and to the screen with
`--verbose`. It does not enable or
start the unit, because a herdr started by hand in the meantime would get a second server on the same socket:
`! herdr unit  written, not enabled` with `Fix: systemctl --user enable --now herdr.service`. "n" on a plan of the
unit alone gives `– herdr unit  not written`, without a `Fix:`. With herdr running outside a unit there is no plan
item and no write
(`– herdr unit  not used (herdr runs without it)`). Without a terminal, when the manager or a unit directory does not
answer, and when the manager's `UnitPath` lacks `~/.config/systemd/user`, setup writes nothing. `rarog service
uninstall` leaves the herdr unit alone.

An existing `herdr.service`, in `~/.config/systemd/user` or in another `UnitPath` directory, is checked instead:
`systemctl --user show herdr.service` must say `loaded`, `active` and `enabled`; any other state gets its
`systemctl --user` command (without `--now` while herdr runs outside the unit). Then setup checks the panes' `PATH`:
the last `Environment=` line with `PATH` in `[Service]` of the unit's file, otherwise the manager's `PATH`. A missing
`claude` or node directory is a `WARNING` with an `Environment="PATH=…"` line to put in `[Service]`. Drop-ins and
`EnvironmentFile=` are not read, and only a new herdr server process gets the new `PATH`.

On macOS the seventh step is the herdr agent, the LaunchAgent `ai.rarog.herdr` in
`~/Library/LaunchAgents/ai.rarog.herdr.plist` (template `server/src/cli/templates/herdr-agent.plist`). launchd starts
`herdr server` once after the user logs in (`RunAtLoad`, no `KeepAlive`, `ProcessType` `Interactive`, the home
folder as the working directory, output appended to `~/Library/Logs/rarog-herdr.log`); `EnvironmentVariables` holds
only `HERDR_SOCKET_PATH`, when `RAROG_HERDR_SOCKET` names another socket than herdr's default. The plist sets no
`PATH`, `SHELL` or `LANG`: herdr panes are login shells and set them. Without the file and with the label not loaded,
herdr found and running or not, the plan screen lists `herdr agent  ~/Library/LaunchAgents`, and the one
`Continue?` covers it; the step has no question of its own. After "y" setup creates the directory when it is
missing, refuses one that is a symlink, not a directory or owned by another user, and writes the file only while the
name is free (mode 0644). The written plist goes to the run log, and to the screen with `--verbose`, with the note
that macOS may ask once to let herdr into folders such as Documents. With herdr not
running it then runs `launchctl bootstrap gui/<uid> <plist>` and waits up to 20 s for herdr to answer its `ping`:
`✓ herdr agent  herdr started`, or `! herdr agent  started, herdr does not answer` with `Fix: check
~/Library/Logs/rarog-herdr.log, then rarog setup`; a failed `bootstrap` keeps the file and is `! herdr agent
written, launchctl bootstrap failed` with the command in `Fix:`. With herdr running it loads nothing, because a second
herdr server on a live socket exits with code 1: `✓ herdr agent  written, starts at next login`. "n" and EOF on a
plan of the agent alone give `– herdr agent  not written`, without a `Fix:`. Without a terminal, when `launchctl
print` does not tell the label's state (exit status 112: no GUI login session, for example over SSH only), or with
the label loaded but the file missing (`!` with `Fix: launchctl bootout gui/<uid>/ai.rarog.herdr, then rarog
setup`), setup writes and loads nothing. Setup never unloads (`launchctl bootout` stops herdr and closes its panes),
restarts or overwrites the agent. An existing agent is checked instead: running is a check without a change;
loaded without a process is `! herdr agent  herdr is not running` with `Fix: launchctl kickstart
gui/<uid>/ai.rarog.herdr`, or `– herdr agent  herdr runs outside the agent` while herdr answers; a file launchd has
not loaded is `– herdr agent  starts at next login`, or, with herdr not running, `!` with `Fix: launchctl bootstrap
gui/<uid> ~/Library/LaunchAgents/ai.rarog.herdr.plist`. A plist whose program is gone, or whose socket is not the
one in `config.json`, is `!` with `Fix: launchctl bootout gui/<uid>/ai.rarog.herdr && rm
~/Library/LaunchAgents/ai.rarog.herdr.plist, then rarog setup` (without `bootout` when it is not loaded): launchd
keeps the loaded definition until `bootout`. A plist `plutil` cannot read is `✗` with `Fix: check
~/Library/LaunchAgents/ai.rarog.herdr.plist, then rarog setup`. `rarog service uninstall` leaves the agent alone and
prints how to remove it (`docs/distribution.md`, "The `ai.rarog.herdr` herdr agent").

Without a terminal setup asks and writes nothing and prints the commands for the missing steps. Exit 0 when every step
is in place, 1 for missing items, problems and a failed closing check, 64 for a bad argument; EOF (Ctrl-D) is a no. The
npm package's update command (its package manager's command, then `rarog restart`) goes to the run log, and to the
screen with `--verbose`. On
a complete installation setup only reports: no questions and no writes. Tests:
`server/test/rarog-setup.test.ts`, `server/test/setup-pytania.test.ts`,
`server/test/setup-tailscale-only.test.ts`; Linux and `tailscale serve` are not checked on a live system.

### `rarog update`

`rarog update [--beta] [--data-dir <dir>] [--verbose]` updates the npm package installed on this machine, in a
terminal, from
that installation (`server/src/cli/update.ts`). It shows the step screen of `rarog setup` (a line per step that
changed something or needs attention, one line for the steps without a change before Check only in a run that changed
nothing, the details in the run log `<data directory>/logs/update-<yyyymmdd-hhmmss>.log`, `--verbose` puts every step
and the details on the screen). The restart is a change, so a finish with nothing to do shows the header,
`✓ Restart`, `✓ Check`, an empty line and `Done`; the three unchanged steps have no line. A finish that ends with exit
code 0 under `!` lines ends with `Done in N s; 1 step above needs a fix.` like setup; a run that stops before its
steps (the release age gate, a refusal before the install) has no `Done` line. Its
first step, **Download** (`server/src/cli/update-registry.ts`), runs the `npm-cli.js` next to this installation's node:

1. The `name` in this installation's `package.json` must be `@rarog/server`, the only package `rarog update` asks
   the registry about. Another name ends the step at `✗ Download` before any npm call. The fix removes that package
   first, because npm refuses to install `@rarog/server` while another package in the prefix owns the `rarog`
   command (`EEXIST`): `Fix: npm uninstall -g --prefix '<prefix>' <name>, then npm i -g --prefix '<prefix>'
   @rarog/server@latest, then rarog service install, then rarog update --finish` (pnpm gets its own commands). The
   commands after the install are the `rarog` of the new package, and `rarog service install` points the service at
   it, because the service still starts the removed one. When the name is not a plain npm package name, the fix has
   only the install and the two `rarog` commands. With `--verbose` the reason and the fix of a stopped step are
   detail lines.
2. `npm prefix -g` must be this installation's prefix (the package lies in
   `<prefix>/lib/node_modules/@rarog/server`); another prefix ends the step at `✗ Download` with `Fix: npm i -g
   --prefix '<prefix>' @rarog/server@latest, then rarog update --finish`. An installation pnpm or another tool put
   there gets the same refusal with that manager's command; `rarog update` installs only with npm. A service on the
   node of this prefix whose npm installs there never gets here: the run switches to that node first (below).
3. `npm view @rarog/server@latest version engines --json`. A failure (offline, no registry) is `✗ Download` with
   `Fix: check the network, then rarog update`. A newest version equal to or lower than this one is a skipped
   Download (`– Download rarog 0.1.0 is the latest`), and this process goes on with the finish below, under the same
   lock, with the hook copy question.
4. A newer version whose `engines.node` this Node does not match (comparators joined by spaces and `||`) is refused
   before any install, with `Fix: nvm install --lts, npm i -g @rarog/server, then rarog setup`; a range in another
   form is noted in the log and the install goes on.
5. `npm pack '@rarog/server@>0.1.0 <=0.2.0' --ignore-scripts --json` (this version, the newest) downloads one
   tarball into a temporary directory of the run (`rarog-update-*` in the system temporary directory, removed when
   the step ends). The range never goes below this version, so npm's release age gate (`min-release-age`, `before`)
   picks the highest version old enough above it or none, as it would for an install. The gate settings and
   `min-release-age-exclude` reach npm from `.npmrc` and
   from `npm_config_*` variables; of the other `npm_*` variables of the caller only the registry, cache, config,
   proxy and certificate ones pass (no `prefix`, `global` or `ignore-scripts`).
   No version old enough (npm `ETARGET` or `ENOVERSIONS`) is `! Download rarog 0.2.0 not installed yet (npm age
   gate)`, exit 0, and nothing else runs; any other npm error is `✗ Download` with `Fix: check the network, then
   rarog update`. A bound that is a pre-release of the newest's own `X.Y.Z` (an installed `1.1.0-beta.1` below
   `1.1.0`) lets npm's range admit the betas of that version, and the age gate can pick one; such a tarball is
   refused before any check: `✗ Download npm gave the pre-release <version>; rarog update without --beta installs
   only releases`, and its fix names `rarog update --beta`.
6. The tarball is checked before anything is installed (`server/src/cli/update-provenance.ts`). Its sha512 must equal
   `dist.integrity` from `npm view @rarog/server@<version> dist --json`. Then `npm audit signatures --json
   --include-attestations` runs in an empty project in the temporary directory that names only this version. npm must
   report no invalid or missing signature, and it hands over the version's one SLSA provenance. The update then checks
   that provenance itself, because a registry can write npm's list of verified attestations: the provenance has one
   signing certificate and no bare key, Sigstore's certificate authority (the intermediate of the public Fulcio,
   pinned in the code) issued the certificate, and the certificate's key signed the statement. The certificate must
   have the one name `https://github.com/useo-pl/rarog/.github/workflows/publish.yml@refs/tags/v<version>`, and the
   signed statement must be a provenance that names this tarball's sha512 and the same repository, workflow and tag.
   For its check npm also reaches `tuf-repo-cdn.sigstore.dev` (npm 11.19 and 11.20). A tarball or provenance that does
   not match is `✗ Download` with what does not match (`@rarog/server 0.1.5 has no verified provenance`, `… was signed
   by <name>, not by <name>`) and `Fix: do not install it by hand; report it at
   https://github.com/useo-pl/rarog/security`. A certificate that the pinned authority did not issue is either a new
   Sigstore certificate or a forged attestation, and the update cannot tell which: `✗ Download the provenance of …
   has a certificate from another authority than the pinned one: Sigstore changed its certificate, or the attestation
   is forged` with `Fix: check https://github.com/useo-pl/rarog/releases for a release with Sigstore's new
   certificate before you install a version by hand; if there is none, report it at
   https://github.com/useo-pl/rarog/security`. The fix gives no install command, because a version installed by hand
   skips this check. An npm before 11.12 does not list
   attestations: `✗ Download this npm does not list attestations (it needs npm 11.12 or newer)` with `Fix: npm i -g
   --prefix <the prefix of the npm next to this node> npm@latest, then rarog update`, or, for an npm outside an npm
   global layout, `Fix: update the npm next to <node> to 11.12 or newer, then rarog update`. npm's own finding of an
   invalid or a missing signature (its exit 1 with the finding in its JSON) is refused the same way, as `npm found an
   invalid signature or attestation of …`. A check npm could not make (the sigstore host offline) is `✗ Download
   signature check failed (npm audit signatures, exit 1)` with `Fix: check the network, then rarog update`. Nothing is
   installed in either case.
7. `npm i -g --ignore-scripts <the checked tarball>`, its output in the run log. Then the installed `package.json`
   is read again: another version than the checked one is `✗ Download after npm, <root> has <version>, not
   <checked version>`, and a checked version below the newest is finished as installed, with a `!` line that names
   both.
   When `npm config get min-release-age before -g` gives a number of days and `before` is not set, the `!` line names
   the earliest published version above the installed one and the day npm installs it (`! Download rarog 0.2.0 is
   3 days old; npm installs it from <YYYY-MM-DD>`, UTC; with both: `! Download rarog 0.1.2 installed, 0.2.0 is …`).
   The times come from `npm view @rarog/server time versions --json`, and only versions the registry still has
   count (an unpublished version keeps its time). Without those values the line stays as above.

**`--beta`.** Without the flag `rarog update` never installs a beta. With it, steps 3 and 5 change, and a fix that
runs the update again names `rarog update --beta`:

- Step 3 is `npm view @rarog/server dist-tags --json`. The target is the higher of the `beta` and `latest` tags,
  because nobody moves `beta` after a release, and a release above the last beta is the newer code. `latest` must be a
  release `X.Y.Z` (otherwise `✗ Download npm gave no version of @rarog/server`), and `beta` counts only as
  `X.Y.Z-beta.N`. No `beta` tag, or one that names no beta, leaves `latest` as the target, and the Download line ends
  with `; npm has no beta tag` (or `; npm's beta tag is not a beta version`) under `!`. A target equal to or lower
  than this version has nothing to install (`– Download rarog 1.1.0-beta.10 is newer than 1.1.0-beta.9 on npm`), and
  the finish runs here as in step 3.
- A higher target is read on its own: `npm view @rarog/server@<target> version engines deprecated --json`. Its
  `engines.node` is checked as in step 4. A deprecated target is `! Download rarog <target> is deprecated on npm, so
  <version> stays`, exit 0, and nothing else runs; the deprecation message is not shown.
- Step 5 is `npm pack @rarog/server@<target>`, exactly that version, and a tarball of another version is `✗ Download
  npm gave <version>, not <target>`. Steps 6 and 7 follow unchanged. npm's age gate holds an exact version back as it
  holds a range (`ETARGET`), and the `!` line names the target's own age and day. The gate is read with
  `npm config get min-release-age before min-release-age-exclude -g`: with `@rarog/server` in
  `min-release-age-exclude` (a name or a glob such as `@rarog/*`, several joined by commas) npm installs the package
  however young, so a gate stop is a dependency's and the line has no date.

`--beta` with `--finish` is a usage error: the finish downloads nothing.

**The service's node.** When the service starts this installation with another node than the one running
`rarog update`, and that node is `<prefix>/bin/node` (the terminal starts Homebrew's node, the service a Node version
manager's), the run does not use its own node: before the update lock and before any npm call of its own node, it
prints `rarog update: the service starts <node>, so this update runs on it.` and replaces itself with
`<node> <root>/bin/rarog.mjs update` with the same arguments (`--beta`, `--data-dir`, `--verbose`) through
`process.execve`: the same process in this terminal, so a signal to it (Ctrl-C, SIGTERM, SIGHUP) reaches the update
itself and no process stays behind. A Node without `process.execve` (`bin/rarog.mjs` lets none in) refuses instead,
with that command. That run takes the update lock itself, its npm installs into this prefix, and
the new version's finish runs on the node the service starts, so the service is not moved to the terminal's node.
This holds also when the npm of the terminal's node installs into this prefix. The service's node counts only when
every source names it (macOS: the definition launchd has loaded and the plist; Linux: the unit file), the file is
executable, and `npm prefix -g` of the npm next to it is this prefix (a user `prefix=` in `.npmrc` moves it).
Otherwise (no service, a node outside the prefix or gone, sources that disagree, another installation) the run goes
on with its own node as above. The run on the service's node gets `RAROG_UPDATE_ON_SERVICE_NODE=1` and never
switches again: when it still sees a service on another node of this prefix, it refuses in one sentence before any
write, with the command on the service's node (`'<prefix>/bin/node' '<root>/bin/rarog.mjs' update …`).

After a new version is installed, the run writes `installed` into the update lock and starts that version's own
`rarog update --finish` (with `--data-dir` and `--verbose` when given) with this node, the lock token in
`RAROG_UPDATE_LOCK_TOKEN` and this terminal, waits for it and exits with its code. The old process loads no module
after the install, so the finish always runs the new code.

`rarog update --finish [--data-dir <dir>] [--verbose]` finishes the version installed on this machine without the
registry. The steps:

1. **Claude SDK**: the version the package pins, probed when present, downloaded without a question when missing.
2. **Service**, only when the update lock's `installed.root` is this installation and the service would not start
   it: the service file starts another installation; on macOS also when the service file or the definition launchd
   has loaded (`launchctl print gui/<uid>/ai.rarog.server`) starts another node, the loaded definition starts another
   installation, or the service file is there and nothing is loaded. launchd reads the file only when it loads it,
   so a restart starts the loaded definition, which stays the old one after an interrupted `rarog service install`.
   A package manager that puts each version in a new directory, such as pnpm, takes this step at every update.
   `rarog service install` points the service at this installation, loads it and restarts it. This step replaces
   Restart. With `--data-dir`, a new service that would use another data directory (it starts `rarog serve` without
   flags) is refused before anything stops.
3. **Hook copy**: setup's step; a copy that differs from this installation is updated after its diff and a question.
   When the update lock names this installation as the one its run has just installed (`installed.root` is this
   root and `installed.version` this version), the diff goes to the run log and the copy is written without the
   question; see `docs/security-model.md`, "Hook copy written by the update". A finish by hand, an inherited lock
   without `installed` and `installed` naming another root keep the question.
4. **Settings**: Rarog's entries in `~/.claude/settings.json`, one `[y/N/d]` question only when an entry
   changes. herdr's integration is not offered. When `statusLine` runs the script copy and only that script differs
   from this installation, the copy is updated first, after its diff and a question (without the question under the
   same lock rule as the Hook copy step), as in the Hook copy step (a copy changed after its install is not offered);
   "n" leaves it, and the step ends with `!` and `Fix:`. An install that fails after writing the script (for example
   at the manifest) ends the step with `✗` and `Fix:`, even when the entries match.
5. **Restart**: `rarog restart` of the loaded service, its output in the run log. With `--data-dir`, its
   `serve --check` (also the one through `service.wrapper` for an iroh key only the wrapper supplies), `RAROG_LOG`
   and data directory check use that directory instead of the shell's, so a service with its log there restarts.
   No service is a skipped step with `rarog service install`.
6. **Check**: setup's closing check, which here also waits up to 30 s for `hook: ok` (the server reads the hook copy
   again within seconds). A hook not `ok` by then is `✗ Check` with `Fix: rarog hooks install`, in the absolute form
   when a new terminal may not find `rarog`. A server that answers with another version than this package runs
   another installation's code after the restart or the move: `✗ Check` with `Fix: rarog service install`, the
   command of this installation (`rarog setup` shows the same server as `!` with the restart command).

Neither command asks about project directories or the work area, and neither writes `config.json`.

**The update lock.** One update runs at a time: `<config directory>/update.lock` (0600) has the shape of the
`rarog restart` lock (the owner's PID on the first line, a dead owner's lock taken over) and `key=value` lines after
it: `token=<32 hex>` and, written only by the run that has just installed the package, `installed.version=<version>`
and `installed.root=<absolute path>`. A second run while the owner lives is refused in one sentence with its PID and
the file. A child process of that run inherits the lock through `RAROG_UPDATE_LOCK_TOKEN`: the token must match the
file's, a wrong token or no readable lock is a refusal, and the child neither takes nor removes the lock.
`rarog update` always takes the lock itself and writes `installed` only after its install (a new file renamed over
the lock, the same PID and token); `rarog update --finish` started by hand takes the lock without `installed`.
`rarog restart` inside a run takes its own lock as always.

**Refusals before any write**, each one sentence on stderr, for both commands: the repo clone (the refusal names the
clone's own commands after `git pull`), no terminal (`run rarog update in a terminal`), a platform other than macOS
and Linux, a package started from the `npx` cache or by `pnpm dlx`, no `config.json` (run `rarog setup` first),
another live update, a wrong token. A service
file that starts another installation (on macOS also a loaded definition, and another node), without
`installed.root` naming this one, ends the run at `✗ Service` with `Fix: rarog service install` (the command of this
installation, in the absolute form when a new terminal may not find `rarog`), before the SDK step. When that
service starts this installation on the node of this prefix whose npm installs there (the service's node above), the
fix is the same command on that node instead (`'<prefix>/bin/node' '<root>/bin/rarog.mjs' update --finish`, with
`--data-dir` as given), because `rarog service install` from this node would move the service to it. On macOS, a
`launchctl print` of the service that says neither loaded nor absent, or a loaded definition without its arguments,
ends the run at `✗ Service` (`state undetermined; nothing was changed`, with `Fix: check launchctl print
gui/<uid>/ai.rarog.server in a regular terminal, then rarog update`) before the SDK step too.

Exit 0 when every step is done, 1 for a refusal, a failed or incomplete step and a failed check, 64 for a bad
argument, 130 after Ctrl-C; `rarog update` exits with the code of the new version's finish, and 0 when npm's age
gate held the new version back. Tests: `server/test/rarog-update.test.ts`, `server/test/rarog-update-finish.test.ts`,
`server/test/update-lock.test.ts`, `server/test/launchd-loaded.test.ts`.

## Data directory

`<dataDir>` is the server's persistent state (file list: `architecture.md`, "Persistent state on disk"). One rule in
`shared/src/data-dir.mjs` computes it; the server, the `rarog` command (`pair`, `devices`, `hooks doctor`) and the
push relay smoke script import it. The permission hook (`scripts/hooks/rarog-pending.mjs`) carries the same rule
without the import, because Claude Code runs its copy from `~/.claude/hooks/rarog/`, where `shared/` does not exist;
the parity test `server/test/data-dir.test.ts` keeps both equal. The rule:

1. `--data-dir` (command line) or a non-empty `RAROG_DATA_DIR` → that path. The demo server without
   `RAROG_DATA_DIR` takes `<tmp>/rarog-demo`.
2. The base = a non-empty `XDG_DATA_HOME`, otherwise `~/.local/share`.
3. `<base>/rarog` is missing, a directory, or a symlink to a directory → `<base>/rarog`.
4. Anything else is a conflict: a file, a dangling symlink or one to a file, a loop, a read error.

On a conflict the server does not start: `loadConfig` throws `Configuration error: Data directory conflict…` (exit 1)
before any write, and launchd (`KeepAlive`) retries every 10 s. The permission hook goes silent and writes nothing,
so permission cards in the app come only from reading the session screen; `rarog pair|devices` and
`rarog hooks doctor` refuse. The message gives the path and the fix, an `mv` of the entry to `<path>.aside`.

The hook computes the directory from the Claude SESSION's environment and the server from its own, so
`RAROG_DATA_DIR` and `XDG_DATA_HOME` must agree in both. `rarog serve` takes them from the process environment, and
`service install` and `rarog restart` refuse when they are non-empty in the shell or the launchd domain. The service
log `<dataDir>/server.log` is fixed at install time, and its directory is the installed service's data directory:
`rarog restart` refuses when it differs from this shell's.

The plain demo (`RAROG_DEMO=1` without `RAROG_DEMO_REVIEW_CODE`) keeps its device keys in
`<dataDir>/devices.demo.json` and `devices.demo.json.bak`, never in `devices.json`. A key paired in the plain demo
therefore opens no server without demo on the same directory, and `POST /api/demo/pairing` revokes no device of
that server. `rarog serve --check` checks the format of the file the server reads in its mode. Review mode and a
server without demo use `devices.json`.

## Config file and `rarog serve`

`rarog serve` is the start path of `ai.rarog.server`. It builds the server environment from the config file, the
secrets and the flags, then turns its process into the server with `process.execve` (in a clone
`<repo>/node_modules/.bin/tsx server/src/index.ts`, two node processes `cli.mjs …` and `loader.mjs …`; in the npm
package its node with `server/src/index.js`, one process; `docs/distribution.md`, "npm package"). The supervisor
sees the same PID, and `cwd` is the installation root, which the stop patterns of `restart.sh` rely on. Needs Node
22.15 or newer, in line 23 at least 23.11, because of `process.execve`; an older one gets one sentence instead of a
stack trace.

`~/.config/rarog/config.json` may be a symlink, e.g. to a machine config in a repo; it holds no secrets.
**Changing a flag means editing this file and running `rarog restart`.**

```json
{"version": 1, "env": {"RAROG_ORIGINS": "https://…", "RAROG_TERM": "1"}, "service": {"wrapper": ["…"]}}
```

- `env` maps `plain` registry variables to string values. A secret, a data directory variable (`RAROG_DATA_DIR`,
  `XDG_DATA_HOME`), a system variable (`HOME`, `PATH`, `TERM`…), a name outside the registry, an unknown key or
  another `version` is a refusal with the key name. Only the `rarog` command reads the file; the server knows only
  its environment.
- `service.wrapper` (optional) prefixes the service command, e.g. a secrets manager wrapper.
- Secrets (`SONIOX_API_KEY`, `OPENAI_API_KEY`, `RAROG_APNS_KEY_PATH`, `RAROG_APNS_KEY_ID`, `RAROG_IROH_KEY`,
  `RAROG_DEMO_REVIEW_CODE`) come from the parent environment (the wrapper) or from
  `~/.config/rarog/secret/private.env`: `NAME=value` lines (`#` comments), only `secret` names, file 0600 in a 0700
  directory, owned by the user, no symlinks. A message about a bad line gives its number, never its content. No
  secret is required. A name present in the parent environment wins even when empty. `rarog dictation set-key`
  writes `SONIOX_API_KEY` there (section "`rarog dictation`: the Soniox key"), `rarog voice-agent set-key` writes
  `OPENAI_API_KEY` (`docs/companion.md`, "`rarog voice-agent`: the OpenAI key and model").

The server environment is ONLY: six passthroughs from the parent (`HOME`, `SHELL` defaulting to `/bin/zsh`, `USER`,
`LOGNAME`, `LANG` defaulting to `en_US.UTF-8`, `TMPDIR`); a computed `PATH` (the node's directory +
`/usr/bin:/bin:/usr/sbin:/sbin` + `/opt/homebrew/bin` on macOS when it exists, the same under launchd and from a
shell); the secrets; `RAROG_DATA_DIR` and `XDG_DATA_HOME` from the process environment, also when empty (the hook
computes the data directory from the session's environment); the file's `env` and the flags. `TERM`, `NODE_OPTIONS`
and every other parent key do not pass; `TERM` is `passthrough` in the registry because the server reads it, but the
live server has none, so `tailnetEnv` uses `dumb`. Precedence, for a name that two sources give: flags > parent
environment > secrets file > `config.json` > `config.ts` defaults. The parent environment gives only the six
passthroughs, the secrets and the two data directory variables, so a `plain` variable such as `RAROG_PORT` set in
the shell or by the wrapper does not reach the server.

```bash
rarog serve                     # start: the process turns into the server
rarog serve --port 8931 --data-dir <dir> --env RAROG_TERM=0
rarog serve --print-env         # the built environment, secrets as <set>/<unset>
rarog serve --check             # check without starting
```

- `--env NAME=value` accepts only `plain` names: a secret in argv shows in `ps`, and the data directory goes through
  `--data-dir`. A bad flag is exit 64. Without `config.json` and flags: the refusal `no configuration … rarog setup
  creates it` (exit 1). A start with `service.wrapper` but without secrets in the environment is a refusal.
- `--check` runs `loadConfig` on the built environment and prints the data directory, the port, the epoch source
  (`epoch: default (1)` or `epoch: from <name>`) and `environment names: …` (no values); `OK` = exit 0. Without
  secrets and with `service.wrapper` it adds `secrets: not checked (supplied by service.wrapper)`; with secrets, the
  warnings `apnsIssue`/`pushRelayIssue` (variable names only). At `RAROG_IROH=1` without the key: the line
  `iroh key: not checked (supplied by service.wrapper)` under a wrapper without secrets, otherwise a refusal (exit 1).
- At `RAROG_IROH=1` `--check` also loads the native iroh module in a short process without secrets
  (`server/src/iroh/module-probe.ts`) and binds no UDP port, so it passes next to a running server: `iroh: native
  module loaded (@number0/iroh <version>, <platform>); UDP port not checked, only the server binds it`, or a refusal
  (exit 1) with `RAROG_IROH=1, but no native iroh module for <platform> (…)`.
- In the npm package `--check` checks the pinned Claude SDK (`docs/distribution.md`, "Claude SDK"): a missing
  `<dataDir>/sdk/<version>/` is the refusal `SDK <version> is not downloaded in <full path>; run rarog setup.`, and
  so are a directory not 0700, foreign-owned or a symlink, and a failed `listSessions` probe (exit 1). The OK lines
  are `SDK: <version> (<dir>)`, `SDK: from the workspace (@anthropic-ai/claude-agent-sdk <version>)` in a clone and
  `SDK: not required (demo)`. `rarog restart` and `rarog service install` run the same check before any stop; a
  plain `rarog serve` without the SDK starts without the session list, and `/health` reports `sdk`.

### `rarog dictation`: the Soniox key

The server's Soniox key (`SONIOX_API_KEY`, from a Soniox project in the EU region) lives only on the server; the app
gets short-lived keys from `POST /api/voice/token`, and the voice agent its speech keys from
`POST /api/companion/speech-token` (`docs/companion.md`, "Temporary Soniox speech key"); the voice agent speaks only
with this voice, so it needs this key too. `rarog dictation set-key` saves it in `private.env`, and
`rarog dictation status` prints the state without the value. Neither restarts the server or calls Soniox; the server
reads the key at start, so a new key needs `rarog restart`.
Without a key, or with `RAROG_VOICE=0` in `env`, the server offers no Soniox route (`voiceEnabled: false`,
`POST /api/voice/token` → 503 `voice_unconfigured`). The app keeps the microphone: its Dictation screen shows the
Soniox option as unavailable and offers System Dictation (Apple speech recognition).

- `set-key` takes no arguments: the key comes from standard input, never from argv. In a terminal it asks without
  echo (Enter saves, Ctrl-D cancels with exit 1, Ctrl-C exits 130) and turns on bracketed paste, so a paste with
  line breaks arrives whole, even in parts, and is refused; otherwise it reads the whole input, e.g. from a
  pipe. Standard input in a terminal with standard output elsewhere is a refusal. The key is at most 4096 bytes,
  trimmed, one line without spaces or control characters.
- With `service.wrapper` in `config.json` it refuses before asking: a name the wrapper exports overrides the file,
  so the key goes into the secrets manager behind the wrapper.
- It creates a missing `secret` directory (0700) and refuses, before asking, on anything `rarog serve` would
  refuse in the directory or the file. After the answer it takes Rarog's lock in `~/.config/rarog/`, the one under
  which `rarog setup` adds the iroh server key, so neither loses the other's line; a lock held by another live
  command (`rarog setup`, another `set-key`, `rarog restart`) is a refusal with its PID, and nothing is saved.
  Under the lock it reads the file again and changes only the `SONIOX_API_KEY` line (or appends one); the other
  lines stay byte for byte. The new content passes the parser and the 64 KiB limit in memory, then goes through
  `.private.env.<16 hex>.tmp` (`wx`, 0600, `fsync`) and `rename`; a failure removes the temporary file and leaves
  `private.env` as it was.
- `status` prints the file (`present` or `missing`) and `SONIOX_API_KEY: set` or `not set`, plus a line for
  `service.wrapper` (the command does not run it), for `RAROG_VOICE=0` in `config.json` (Soniox dictation off even
  with a key) and for `SONIOX_API_KEY` in the shell's environment (`rarog serve` started from that shell uses it
  instead of the file). `set-key` prints the last line too. A broken file or `config.json` is exit 1.

Tests: `server/test/rarog-dictation.test.ts`.

## Server environment: variables and flags

**You change a variable with an entry in `env` in `config.json` and `rarog restart`**, also in the emergency
runbook steps of `docs/security-model.md` (epoch, killswitches). `restart.sh` controls only the life cycle, and the
service plist has no `EnvironmentVariables`.

- **The explicit variable list stays** (the registry allow-list in `rarog serve`): the server must not inherit API
  keys from the shell (`ANTHROPIC_API_KEY` and others would break subscription billing; see
  `docs/security-model.md`). Never pass the environment through wholesale.
- `RAROG_AUTH_EPOCH` is the epoch of device keys: incrementing it and restarting revokes every device at once (a
  record carries the epoch it was issued with; runbook "Lost or stolen phone" in `docs/security-model.md`). Unset or
  empty means `1`. When `devices.json` (or its `.bak`, if the file is unreadable) has active devices with another
  epoch, the server and `rarog serve --check` refuse to start before writing anything; the message gives the epoch
  to put in `env`.
- Variables with a default in the config code (`config.ts`, `server/src/config/`) go into `env` only to change the
  value, among others `RAROG_PORT`, `RAROG_HERDR_SOCKET`, `RAROG_MAX_PANES` (30), `RAROG_VOICE`,
  `RAROG_MIN_CLIENT_BUILD` (the minimum app build announced in `hello`; unset or empty means 5614 in a package
  install and no minimum in a clone or in demo, and without a minimum the `main` and `all` consent channel do not
  run) and the flags below.
- `RAROG_HOST` is not configurable: the server listens only on `127.0.0.1`. Unset or empty is fine; any other value
  stops the start (`The Rarog server listens only on 127.0.0.1 (got: …)`), so a typo cannot expose the server.
- `RAROG_PROJECT_ROOTS` and `RAROG_HERDR_ROOTS` list roots (comma-separated, `~` expanded). The project roots mark
  out where sessions and terminals start and what the directory browser lists; the pane roots, which panes Rarog
  reads in full and where the hooks work. Unset `RAROG_PROJECT_ROOTS` means `~/Projects`, unset `RAROG_HERDR_ROOTS`
  the project roots; `rarog setup` writes both and suggests `~`. Each list counts as a work area: its roots without
  their hidden entries (`~/.cache` under the root `~`) and without the macOS-protected folders of home (`Desktop`,
  `Documents`, `Downloads`, `Library`, `Movies`, `Music`, `Pictures`), unless a root lies in one, so a project in
  `~/Documents/Projects` takes that root. Rules: `docs/security-model.md`, "Work area: where Rarog starts, lists and
  reads". The server writes the pane roots and the excluded folders to `<dataDir>/roots.json` for the hooks at start.
- `RAROG_YOLO_ROOTS` lists the directories (comma-separated, `~` expanded) where `bypassPermissions` is allowed:
  starting a session in that mode, and sending to a pane in bypass mode or in a mode Rarog cannot read. Unset or
  empty means nowhere. Membership is checked on the realpath (rules in `docs/security-model.md`, "Starting
  sessions from the phone").
- `RAROG_CLAUDE_ENV_CLEAR` lists the variables (comma-separated) set to empty in the environment of a pane that
  Rarog creates. Unset or empty means the default list `DEFAULT_CLAUDE_ENV_CLEAR` in `server/src/config.ts`: the
  Claude Code parent-session variables (`CLAUDE_CODE_CHILD_SESSION` turns off transcript saving), the Anthropic API
  keys and `CLAUDE_CODE_OAUTH_TOKEN`. A value replaces the list, it does not extend it. At `RAROG_HERDR_LAUNCH=1` a
  value with no names, or with a name that is not a variable name, fails the herdr integration: the server logs the
  error and starts without it, with an empty session list.
- Secrets (`SONIOX_API_KEY`, the voice agent's `OPENAI_API_KEY`, `RAROG_APNS_KEY_PATH`, `RAROG_APNS_KEY_ID`, the
  iroh key `RAROG_IROH_KEY`, the review code `RAROG_DEMO_REVIEW_CODE`) come from the process ENVIRONMENT or from
  `private.env`. The plist starts `ProgramArguments` with `service.wrapper`, e.g. a secrets manager wrapper that
  exports a closed list of names and runs `exec`; a new secret goes into the registry (kind `secret`) and into that
  list. A value never goes into `config.json`, a script or a log. Rotation: the new value where the installation
  takes it from (in `private.env`: `rarog dictation set-key` for `SONIOX_API_KEY`, `rarog voice-agent set-key` for
  `OPENAI_API_KEY`) → `rarog restart`.
- The only client credential is the device key from pairing. `POST /api/login` answers a constant 410
  `login-retired`, a cookie opens no API, and `RAROG_AUTH_TOKEN` is not in the registry (a refusal in `config.json`
  or `private.env`; dropped from the parent environment).

### Killswitches

There are FIVE killswitches, flags that switch capabilities off. Four take a power over the Mac away from the
server, and `RAROG_PUSH` only mutes the outgoing channel:

- `RAROG_HERDR_LAUNCH=1`: the right to create panes; `0` disables New Session in the app, creating a directory from
  its browser included (`POST /api/fs/mkdir` gives 409 `mkdir-disabled`).
- `RAROG_HERDR_SEND=0`: read-only mode (Rarog sees the sessions and touches nothing; no new directory either).
- `RAROG_TERM=1`: the emergency console, a FULL SHELL in the project. `0` turns it off: `POST /api/term` gives 404,
  the WebSocket upgrade is dropped, and `GET /api/version` reports `termEnabled: false`.
- `RAROG_PUSH=1`: notifications. It removes no power and only mutes the outgoing channel: `0` stops the APNs
  banners and the Live Activity updates. APNs is the only channel; without the full `RAROG_APNS_*` set and without
  `RAROG_PUSH_RELAY_URL` Rarog sends no push, and `POST /api/presence` is a no-op.
- `RAROG_NOTES=1`: project notes for the native app (in the demo they live in memory). `0` gives 404 on
  `/api/notes` and drops the `notesCwds` field from the `sessions-snapshot` frame and the entry points in the app;
  it does NOT delete `<dataDir>/notes/`.

Rarog only reads git (the git line, the session diff); `git switch`/`pull`/`push` from the iPad go through the
terminal (`Cmd+G` in the app = lazygit).

**The emergency console is a herdr PANE**, with no other backend and no flag for one. The process from
`RAROG_HERDR_BIN` (default `~/.local/bin/herdr`) controls the shell, so the console is SUBJECT to
`RAROG_HERDR_LAUNCH` and `RAROG_HERDR_SEND` (without them `POST /api/term` returns 409). It creates a tab
`rarog <slot> · <dir>` visible on the Mac and keeps one state file, `<dataDir>/term-herdr.json` (pane age and
directory, no content). Accepted costs: shells die with a herdr server restart or update (the pane token comes back
from the pane label `<tab label> · rt:<id code>` at start, every 4 h, or on `POST`; a start while herdr is
unreachable retries every 30 s until herdr answers), one controller at a time
(a second device takes over), and the pane size follows the last client (forgetting a pane: the runbook in
`docs/security-model.md`).
`RAROG_TERM_MAX` (default 4) caps the live consoles (over the cap `POST` returns 409); `RAROG_TERM_IDLE_DAYS`
(default 7) is the idle time after which the reaper closes a shell at server start, with any Claude Code started
in it by hand.
`SSH_AUTH_SOCK` does not reach the server (herdr gives the shell the SSH agent socket), and `TERM_ENV_PASSTHROUGH`
in `server/src/config-env.ts` is the closed list of what may pass towards the terminal (`HOME`, `PATH`, `TMPDIR`);
a contract test keeps Rarog's secrets out.

### Preferences and feature flags

None of these is a sixth killswitch: each one only reads, or its only mutation sits under an existing power. Each
changes with an entry in `env` and a restart.

- `RAROG_HERDR_SEEN_FOCUS=1` (default) clears a pane's `done` badge after the user opens the transcript on the
  phone or the voice agent picks up the result (`docs/companion.md`, "Picking up a result"). herdr has no "mark as
  seen" method, only `agent.focus`, which switches the view of EVERY attached herdr client, remote ones over SSH or
  mosh included (guaranteed since herdr 0.9.1), so Rarog calls it ONLY for a pane on `done`. `0` keeps only the
  local marker. `RAROG_HERDR_SEND=0` turns this path off first.
- `RAROG_HERDR_TAB_LABELS=1` (default) names herdr tabs AFTER creating them: a Claude tab's label follows the card
  label (only a single-pane tab with an `rc:` pane; a name set by hand stays), and Claude and terminal tabs
  without an origin label get Rarog labels. The pane label leads with the tab label and follows it the same way
  (`<tab label> · rc:…`, `<tab label> · rt:…`), so herdr's "Go to" window names the pane like its tab; a bare
  origin label gets the tab label in front. `0` keeps the tab and pane labels from creation and renames nothing.
  The rewrite of old-format pane labels (`… · rarog-claude …`, `… · rarog-term …`) into the current format
  does not depend on this flag: it runs whenever herdr answers and only `RAROG_HERDR_SEND=0` stops it.
  `RAROG_HERDR_SEND=0` turns off `tab.rename` and `pane.rename`; runbook "Tab name set by Rarog" in
  `docs/security-model.md`.
- `RAROG_CODEX_STATUS=1` (default) lets `agent === 'codex'` panes into the session list as STATE-ONLY entries: row,
  dot and push, no transcript, no sending (400/409), no screen reads (`inScope: false`). Its only mutation (Show in
  herdr → `agent.focus`) is under `RAROG_HERDR_SEND`. `0` = `codex` panes do not exist for Rarog.
- `RAROG_CLI_WAITING=1` (default) makes the session manager read the Claude Code session registry
  `~/.claude/sessions/<pid>.json` every 1.5 s. `status: waiting` wakes a screen read in the herdr driver, and a
  dialog on screen (or an unreadable screen) gives the waiting state and a card even while herdr reports `working`
  (a form with a preview, `Exit plan mode?`). Digits still come only from the screen. `0` = state and card from
  herdr and the screen only, e.g. after a change of the registry file format; it also turns off the rule that a
  subagent does not survive a restart of the Claude Code process, which takes the process start from that registry.
- `RAROG_GIT_FILE_DETAILS=1` (default) adds `fileDetails` to the `git-status` frame: each dirty file's kind and line
  counts from a third git process (`git diff --relative --numstat -z HEAD -- <≤ 50 paths>`, budget 1.5 s, skipped
  for a clean repo). `0` drops the field and `numstat`, e.g. when the `git: window …` line in `server.log` shows too
  high a cost.
- `RAROG_AGENT_FILES=1` (default) makes the herdr driver read subagent transcripts
  (`<session>/subagents/agent-<id>.jsonl`), so Rarog knows that a subagent in standby resumed on its own and which own
  tasks it waits for. `0` = a subagent stays waiting after standby until it resumes or ends, with no task list. The
  session's pull request list does not depend on it: it reads the main file only (`docs/pull-requests.md`).
- `RAROG_PR_STATUS=1` (default) asks GitHub with the user's `gh` login for `github.com`, only while an app is
  connected, for the author, creation time and title of the PRs linked to the conversations and for the state of
  the PRs the session lists show (`open`, `draft`, `merged`, `closed`; `docs/pull-requests.md`, "State on GitHub").
  The lists show only PRs whose author is that login. It approves and sends nothing to a pane; it is an outbound
  channel, described in `security-model.md`, "PR status: the state of session PRs from GitHub". `0` = no tracker
  and no `gh` call, so session cards show no PRs; any value other than `1` or `0` stops the start. The demo answers
  from a fixed map and never runs `gh`. `rarog doctor` shows the line "PR status".
- `RAROG_INBOX=1` (default) keeps an Inbox card per session (`server/src/inbox/`), sends the card heads to a global
  stream opened with `inbox=1`, serves `GET /api/inbox` and its remove and restore routes, and announces the `inbox`
  capability (`docs/implementation-spec.md`, "Inbox"). It sends nothing to a pane; a removal of a result card
  receives the result like opening the session. `0` = no card tracker, no Inbox event, no capability, every Inbox
  route 503 `inbox-disabled`, and `<dataDir>/inbox.json` stays untouched; any value other than `1` or `0` stops the
  start. The demo obeys it the same way over its own sessions.
- `RAROG_FILES=1` (default) lists a directory of a session (`GET /api/sessions/:id/files?dir=`), sends one file of it
  (`GET /api/sessions/:id/files/raw?path=`), gives the index of its files (`GET /api/sessions/:id/files/index`) and
  announces the `files` and `file-index` capabilities (`docs/implementation-spec.md`, "Session files"). It sends
  nothing to a pane; what a device can read through it: `security-model.md`, "Session files: listing and download".
  `0` = the three routes answer 404 as an unknown route for every method and both capabilities are absent; any value
  other than `1` or `0` stops the start.
- `RAROG_FILES_MAX_MB=50` (default) is the file size limit of the session file download, in whole megabytes from 1 to
  1024: a larger file gets 413 `file-too-large` with its size and the limit, before the first byte. Every listing
  announces the limit in bytes (`maxBytes`), so the app needs no update when it changes (`config.json` and
  `rarog restart`). A fraction, an exponent or a value out of range stops the start (`rarog serve --check` names the
  variable).
- `RAROG_QUEUE_ECHO=1` (default) holds the echo of a prompt the app sent with `queueAware` while the agent works,
  until Claude Code takes it from its queue, so the message lands in the transcript where the agent read it. `0` =
  echo at once, 202 without `queued`, the app back to its 15 s threshold, e.g. when `queue: … flushed` lines show
  in `server.log` during normal work.
- `RAROG_TALL_DIALOG_GUARD=1` (default) writes `tallDialogGuard: true` to `<dataDir>/roots.json` at start. With it
  the permission hook denies the `Bash` permission form in a herdr session when the dialog would not fit the pane
  (geometry from the hook's `COLUMNS`/`LINES`, never looser than the phone) and asks the model for shorter calls
  (`docs/dialogs.md`, "Tall dialog guard"). The start log says `tall dialog guard: on`. The guard only denies, so
  power shrinks. `0` = no field, no guard, e.g. when `<dataDir>/guard.jsonl` shows denials for dialogs that fit.
  The hook reads the file on every call.
- `RAROG_PROMPT_BLOCK=1` (default) recognizes a prompt blocked by a `UserPromptSubmit` hook (`promptSubmitEnding`
  in the transcript): a notice under the bubble, the session leaves working, no `done` push, no retry by the stall
  guard (`docs/dialogs.md`, "Prompt blocked by a hook"), the Restart and Send button, and clearing the field that
  holds the blocked prompt before the restart (an Esc pair on a user gesture, at the button and at the `↑` pill).
  The same flag reads the prompt field after the turn for prompts sent during it: a not-delivered or not-confirmed
  notice under the held message, and an Esc pair before the next send when the field still equals OUR text. Its
  keys go only under a user gesture, within the `escape` power (`security-model.md`, "Session restart adds no
  power"). `0` = no recognition: the stall guard clears and retries, then shows the stalled-prompt message, there is
  no button, a restart after a block refuses on the full field, and the held echo flushes 10 s after the turn. Use
  it when `rarog: prompt blocked by a hook` or `queue: … (field: not-taken)` lines in `server.log` hit prompts that
  arrived.
- `RAROG_CONSENT_CHANNEL=all` (default; the demo always runs `off`) is the configured mode of the consent channel of
  the `PermissionRequest` hook (`docs/dialogs.md`, "Per-call dump and shadow mode", "Server in shadow mode"); `off`,
  `shadow`, `main` or `all`, an empty value means `all`, anything else stops the start with a configuration error.
  The default opens the channel only when the conditions below hold: without the hook, or in a clone without
  `RAROG_MIN_CLIENT_BUILD`, the server runs it as `shadow` with the reason. An explicit entry in `env` keeps another
  mode. The server acts on the EFFECTIVE mode (`server/src/herdr/dialogs/layer1/mode.ts`), which it publishes in
  `<dataDir>/alive.json` (written every 10 s and at once on a change; the hook waits by it), in the `consent` field
  of `/health` (`{configured, effective, reason}`), in the `consent channel` line of `rarog doctor` (which also
  names the minimum app build `rarog serve` takes from `config.json` and its source: `package default` or
  `RAROG_MIN_CLIENT_BUILD in config.json`) and in the log line
  `consent: effective mode <effective> (configured <configured>, reason <reason>)`.
  - Configured `off` or `shadow`: the effective mode is the same from the start, reason `configured`. At `off`
    `alive.json` has `mode: "off"` (the hook does not wait), and the server cleans the shadow directories at start.
    At `shadow` `alive.json` has `mode: "shadow"` and lists the observed sessions, the main thread's hook waits, and
    an allow or deny from the phone first writes a shadow file with proof that the dialog is up, then sends the
    digit or `escape` as at `off`, so the key still decides.
  - Configured `main`: `alive.json` has `mode: "off"` (reason `starting`) until the registration socket
    `<dataDir>/run/consent.sock` and the admin socket have started. The server then computes the mode once. It is
    `main` only when the hook status is `ok` (the `hook` field of `/health`: the settings entry and the copy),
    both sockets are live and a minimum app build is set (the one announced in `hello`: `RAROG_MIN_CLIENT_BUILD`,
    or 5614 in a package install when the variable is unset or empty).
    Otherwise it is `shadow`, with the first failed condition as the reason: `missing`, `mismatch` or `stale` (the
    hook status; an unreadable status counts as `missing`), `consent-socket`, `admin-socket`, `min-client-build`.
    At effective `main` `alive.json` has `mode: "main"` and the main thread's hook registers on `consent.sock`
    before it waits; subagent dialogs stay in the terminal. In any other effective mode the registration socket
    refuses registrations (`channel-closed`); configured `off` and `shadow` do not open it. A change of the hook or
    a socket after that moment keeps the mode until a restart.
  - Configured `all`: the same start, conditions and reasons as `main`; when they hold, the effective mode is
    `all`. The main thread works as at `main`. `alive.json` has `mode: "all"`, so subagent hooks register on
    `consent.sock` too. A subagent's card gets the allow button only with proof that its dialog is up, on top of the
    screen or hidden in the background (`docs/dialogs.md`, "Dialog signals", "Hidden proof"), and the digit stays
    blocked as at `main`. A subagent's `pending` card without proof for 10 s after the registration or after losing
    the button returns to the desk: the server signs a `release` (`releaseCause: "desk-fallback"` in the
    record), the hook exits without a decision and the dialog is answered in the terminal. The 10 s do not run
    while the session registry says `waiting: permission`; a card that the session hook list keeps without the
    button for the life of the session process returns at once (`docs/dialogs.md`, "Channel cycle").
  - `rarog dialogs off` (admin socket, `docs/distribution.md`, "The `rarog` command") is the kill switch: effective
    `off` with reason `killswitch` until the server restarts, from any configured mode; waiting hooks exit within
    250 ms. It does not change `config.json`, so it prints the entry that keeps `off` after a restart.
    `rarog dialogs release <sessionId> [--key <key>]` releases the `pending` and `sent` channel cards of a session
    (the Claude Code `session_id`) to the terminal and lists the released keys; outside the effective `main` and
    `all` it answers `channel-closed` (exit 1).

  The start log also says `shadow: hook consent channel <configured mode>`; a server stop writes `mode: "off"`
  (waiting hooks exit within 250 ms; with a restart grace also the `stop` field, `RAROG_CONSENT_RESTART_GRACE`
  below); every transition goes to `<dataDir>/alive.jsonl`. The registration secret
  never reaches the log, `/health`, the socket replies or `rarog doctor`. Rollback of the channel, in order: (1)
  optionally at once, `rarog dialogs off`; (2) always, `RAROG_CONSENT_CHANNEL` = `off` in `env` in
  `~/.config/rarog/config.json` (the server reads it at every start); (3) `rarog restart`; (4) `git revert` of
  the change or a checkout of the older commit; (5) `rarog restart`; (6) `rarog hooks install` from that
  commit; (7) the older app build, when needed. For step 6, `rarog doctor` shows under the hook line which commit
  (or package version) the installed copy came from (`installed copy from commit …`), taken from `manifest.json` of
  the copy only when every copy file still has the hash written at installation; otherwise it gives the reason
  (`origin unknown`). `rarog hooks doctor` prints the same manifest.
- `RAROG_CONSENT_PROOF=channel` (default) is the rule that gives a consent channel card the allow button
  (`docs/dialogs.md`, "Proof rule"): `channel` or `screen`, an empty value means `channel`, surrounding whitespace is
  ignored, anything else stops the start (`RAROG_CONSENT_PROOF must be one of: channel, screen (got: …)`). At
  `channel` a main-thread request outside MCP gets the button from a live, registered hook, the full card content and
  a registry read `waiting: permission` no older than 5 s, without reading the top of the screen. The version gate
  counts the rule per request kind, main thread and subagents: a Claude Code release in that same registry read
  higher than the measured one (`CONSENT_CHANNEL_MEASURED_CLI`) or on its exclusion list gets `channel` only with a
  `pass` for that kind in `<dataDir>/consent-canary.json`, a `fail` there takes `channel` away also from a measured
  release, and an unknown release (also several live processes of the session) gets `screen`; MCP tools use
  `screen` (`docs/dialogs.md`,
  "Proof rule", for the file and the line `consent: session <id> runs Claude Code <version>: proof rule …` at a
  change of a session's rules). At `screen` every request needs its dialog alone on top of the screen, whatever the
  canary file says. It opens no channel and is
  no kill switch: it acts only at effective `main` or `all` (`RAROG_CONSENT_CHANNEL` above). The server reads it once,
  at start. Rollback: `screen` in `env` in `~/.config/rarog/config.json`, then `rarog restart`.
- `RAROG_CONSENT_ALWAYS=on` (default) gives a consent channel card the "always" option when every update Claude Code
  proposed is on the closed list (`docs/dialogs.md`, "Always option"): `on` or `off`, an empty value means `on`,
  surrounding whitespace is ignored, anything else stops the start
  (`RAROG_CONSENT_ALWAYS must be one of: on, off (got: …)`). At `off` no card has the option and `allow-always` is
  422; `allow` and `deny` stay as they are. It opens no channel (`RAROG_CONSENT_CHANNEL` above). The server reads it
  once, at start. Rollback: `off` in `env` in `~/.config/rarog/config.json`, then `rarog restart`.
- `RAROG_CONSENT_RESTART_GRACE=45` (default) is the restart grace G in whole seconds: how long a `PermissionRequest`
  hook that starts while the server restarts waits for the next server's consent channel, how long a hook already
  waiting in the channel pauses for it, and how long the new server's recovered records wait for their hook's second
  registration (`docs/dialogs.md`, "Restart break" and "Channel cycle"). Whole seconds from `0` to `600`, an empty
  value means `45`, surrounding whitespace is ignored, anything else stops the start
  (`RAROG_CONSENT_RESTART_GRACE takes whole seconds from 0 to 600 (got: …).`). It acts only when
  `RAROG_CONSENT_CHANNEL` is `main` or `all` (configured, also while the effective mode is still `off`): the stop
  write of `alive.json` carries `stop: {ts, graceMs}`, and the writes of a starting server carry `phase: "starting"`
  until the first list with a session after the effective mode is resolved; after `rarog dialogs off` neither field
  until the server ends. `0` = neither field and no wait in recovery, so a hook that starts during a restart exits as
  at `off`, a waiting hook exits at the stop write, and recovery revokes the records of live hooks at once. It opens
  no channel and is no kill switch. The server reads it once, at start; a stop write uses the value of the stopping
  server. Rollback: `0` in `env` in `~/.config/rarog/config.json`, then `rarog restart`.
- `RAROG_DIALOG_LAYER2=0` (default) is the flag of dialog layer 2 (`docs/dialogs.md`, "Block card without
  digits"): `0` or `1`, empty means `0`, surrounding whitespace is ignored, anything else stops the start
  (`RAROG_DIALOG_LAYER2 takes 1 or 0 (got: …)`). At `1` a card without buttons over a screen without numbered
  options (a slash command view, a trust dialog without digits, login) shows the dialog block, capped at 60 lines
  and 4000 characters, refreshes it under the same card (the `/status` tabs), and the `block-card` entry in
  `herdr-audit.log` gets `layer2` and `layer2Why`. A dialog of class `dialog` whose block options layer 2 reads gets
  a card with its choices, and each such episode a `layer2-episode` entry (`docs/dialog-card.md`). The start log says
  `dialogs: layer 2 RAROG_DIALOG_LAYER2=<0|1>`.
  The server reads it once, at start; it and the consent channel do not affect each other.
- `RAROG_SSE_GZIP=1` (default) is the flag of SSE stream compression: `1` or `0`, empty means `1`, surrounding
  whitespace is ignored, anything else stops the start (`RAROG_SSE_GZIP takes 1 or 0 (got: …)`). At `1` the server
  compresses `GET /api/stream` and `GET /api/sessions/:id/stream` with gzip for a client whose `Accept-Encoding`
  names `gzip` with a weight above zero (`*` alone does not count). The response then has `Content-Encoding: gzip`
  and `Vary: Accept-Encoding`, `Cache-Control: no-cache, no-transform` stays, and the compressor is flushed after
  every frame and every ping, so no frame waits for the next one. The compressor closes when the client disconnects
  and when its device is revoked. The log line of a replay sent as a snapshot also gives the compressed size
  (`…, gzip <kB> kB`). A client without `gzip` gets the stream uncompressed. `0` turns compression off for every
  client: no `Content-Encoding` and no `Vary`. The server reads it once, at start.
- `RAROG_FOLDER_GATE` (default `1` on macOS, `0` elsewhere; the demo always runs without it) is the switch of the
  folder gate (`docs/macos-folders.md`): `1` or `0`, empty means the platform default, surrounding whitespace is
  ignored, anything else stops the start, also in the demo (`RAROG_FOLDER_GATE takes 1 or 0 (got: …)`). At `1` a disk
  call of the work area in a guarded folder of home runs in a helper process of that folder, and a folder whose helper
  does not answer within 1 s is refused until it answers. `0` = every such call runs in the server process: no
  helper and no relay thread. The start log says `folder gate: on, …` or `folder gate: off, …`. The server reads it
  once, at start. Rollback: `"env": {"RAROG_FOLDER_GATE": "0"}` in `~/.config/rarog/config.json`, then
  `rarog restart`.
- `RAROG_COMPANION=0` (default; the demo always runs without it) is the flag of the voice agent, and
  `RAROG_COMPANION_MODEL=gpt-realtime-2.1` (default) its OpenAI Realtime model. Values, what `1` turns on and what
  else the voice agent needs (`OPENAI_API_KEY` and the Soniox key): `docs/companion.md`, "Flags". The server reads
  both once, at start.
- `RAROG_COMPANION_SESSIONS=0` (default; the demo always runs without it) is the flag of the voice agent's mode
  across sessions: at `1`, next to `RAROG_COMPANION=1`, `GET /api/sessions/:id/companion/turns` and
  `GET /api/companion/sessions` answer. `0` or `1`; another value stops the start. Values and the gate:
  `docs/companion.md`, "Flags", "Turns route" and "Session catalog". The server reads it once, at start.
- `RAROG_REFUSAL_DUMPS=1` (default) keeps a diagnostic dump of EVERY refusal in
  `<dataDir>/refusals/<ISO-ts>-<reason>.txt`: screen text, hook dump metadata (without `tool_input`), jsonl state,
  Rarog version. The same switch covers the consent channel's dump of a main-thread card whose top shows an unknown
  element (`docs/dialogs.md`, "Refusal diagnostics"). Files `0600`, directory `0700`, retention 48 h, cap 200 files;
  a layer 2 dialog dump without a consent trace (`….dialog.txt`) 14 days, its own cap of 500 files. `0` stops the writes,
  for both kinds; the screen content carries the same risk as `pending/` (`docs/security-model.md`).

### Push notifications

- **APNs channel of the native app**: `RAROG_APNS_KEY_PATH` (the PATH of the key file, not its content) and
  `RAROG_APNS_KEY_ID` as secrets, `RAROG_APNS_TEAM_ID` (the app's signing team, `DEVELOPMENT_TEAM` in
  `project.pbxproj`) and `RAROG_APNS_TOPIC` (the app's bundle ID, `ai.rarog.app`) in `env`. All or nothing: without
  them the start log says `push: APNs off — missing …`; a key file that is not mode 600/400 or not an EC P-256 key
  gives the same, and the server starts anyway. The user creates the key (Apple portal, Sandbox, team-scoped) and
  keeps it outside the repo. `RAROG_APNS_TOPIC` is the SERVER's topic: the app declares its bundle ID in the `topic`
  field of `POST /api/push/apns`, the server accepts only this value (another or none → 400 `topic-mismatch`;
  without a device key 401 `unauthorized`) and stores it in `apns-devices.json`, and sends use the entry's topic.
  An entry without `topic` or `deviceId` is dropped on read (`server/src/notify/apns-devices.ts`).
- **Push relay: `RAROG_PUSH_RELAY_URL`**: the origin of the push relay (a Cloudflare Worker from `relay/`;
  production is `https://push.rarog.ai`, which `rarog setup` writes). The server sends the entries that hold a relay
  pass (`relayPass` in `apns-devices.json`, ordered by `server/src/notify/relay-pass.ts`) through it. The relay is
  one deployment, production, that serves both APNs environments, `development` and `production`
  (`APNS_ENVIRONMENTS`), with the `v2` policy (`relay/wrangler.toml`): only v2 banners (placeholder text,
  content in the ciphertext) and the Live Activity pass. The value is a bare `https` origin; a bad one turns the
  relay off with `push: push relay off — <reason>` and the server starts. The relay alone, without an APNs key, is
  enough; the topic such a server accepts is `RELAY_APP_TOPIC` from `shared/src/relay.ts`. With both, a pass → relay,
  no pass → key, except a `production` entry (a TestFlight build), which goes ONLY through the relay and waits for a
  pass (`pass-missing`, test push `none`): the server key is a Sandbox key, and a try would give 403
  `BadEnvironmentKeyIdInToken` and switch the key's environment off until restart (`server/src/notify/sender.ts`). A
  failed pass order retries with a backoff (`push: relay pass (…) failed (…) — retry in N s`), and `development`
  entries use the key meanwhile. The start line:
  `push: notifications ON (APNs: N, key: yes|no, push relay: <origin>|no, E2E: yes|no (RAROG_PUSH_E2E=0))`.
  **Without the relay:** `"RAROG_PUSH_RELAY_URL": ""` in `env` and a restart = everything through the key, and a
  TestFlight build loses its pushes. A new relay address invalidates the passes, and the server orders new ones.
  The value is not a secret.
- `RAROG_PUSH_E2E=1` (default): end-to-end encrypted banners. An app entry with a topic, `pushFormats` containing 3
  and an active paired device gets a format 3 payload (placeholder text in `aps.alert`, content encrypted with the
  device's push key; `docs/security-model.md`, "Push notifications"; format: `docs/implementation-spec.md`). There is
  no plain banner format: an entry without a ciphertext (no 3, no device key, payload over the cap) is skipped with a
  log line. The send line is `push: APNs <kind> — v3: N` (with `, skipped: N`); the start line shows `E2E: yes` or
  `E2E: no (RAROG_PUSH_E2E=0)`; `GET /api/version` always lists `push-e2e-v2`. `0` or `false` = no banners and no
  badges at all; the Live Activity keeps working (it carries no content). It removes no access. **Turning banners
  off:** add `"RAROG_PUSH_E2E": "0"` to `env` in `~/.config/rarog/config.json`, run `rarog restart`, and check
  that the start line in `server.log` ends with `E2E: no (RAROG_PUSH_E2E=0))` and the send lines say
  `v3: 0, skipped: N`. Back: remove the entry and restart. Tests: `server/test/notify-config.test.ts`,
  `server/test/notify-apns-sink.test.ts`.
- **New version banner** (`version-changed`): one push when the installed Claude Code release or the herdr version
  changes (`docs/architecture.md`, "New version of Claude Code or herdr"). It has no flag of its own: without the
  APNs channel (`RAROG_PUSH=0`, no route) the server still writes `<dataDir>/versions-seen.json` and the line
  `versions: <program> <old> → <new> (push: no-receiver)`; the demo has neither.
- **Consent canary banner** (`version-changed` with `push.canary-*` sentences): one push per new main-thread result
  of a release in `<dataDir>/consent-canary.json` (`docs/architecture.md`, "New version of Claude Code or herdr").
  No flag of its own: without the APNs channel the server still writes `<dataDir>/consent-canary-pushed.json` and the
  line `consent-canary: Claude Code <release> main=<result> (push: no-receiver)`; the demo has neither, and without a
  canary file there is nothing to push.
- **Weekly limit banner** (`weekly-limit`): one push per weekly plan window that reaches 97 % in a fresh status line
  reading (`docs/architecture.md`, "Weekly plan limit"). It has no flag and no threshold setting of its own and exists
  only with the APNs channel: `RAROG_PUSH=0`, the demo or no route means no signal, no
  `<dataDir>/weekly-limit-alerts.json` and no line. The line:
  `weekly-limit: <percent>%, resets <ISO> (push: <outcome>)`.

### Under launchd

Under launchd `PATH` is minimal, so `rarog serve` computes it, and the service node is the absolute path of the
node that ran `rarog service install` (e.g. from nvm), never looked up in `PATH`. After a change to
`scripts/restart.sh`: `bash -n scripts/restart.sh`, ShellCheck, then `rarog restart` and the health check.

## iroh listener

The server's second transport: QUIC connections of the iroh library through a relay or directly over UDP, with no
reverse proxy and no private network (`docs/architecture.md`, "Second transport: iroh"; boundary and limits:
`docs/security-model.md`, "Layer 1b"). It works on Apple silicon and Linux x64/arm64; Intel Macs have no native
module package. Four variables:

- `RAROG_IROH`: `1` turns the listener on; unset or `0` turns it off (the native module never loads); another value,
  or `1` with `RAROG_DEMO=1`, is a configuration error.
- `RAROG_IROH_KEY` (secret): the server key, 64 hex characters. The EndpointId follows from it, so a new key is a new
  address in pairing links. The server never generates it; `rarog setup` writes one for a new installation (above).
  A bad shape is an error that does not show the value.
- `RAROG_IROH_RELAY`: the iroh relay, `https://host[:port]/`, required at `1`, normalized like the `r` field of the
  link. The public n0 relay (e.g. `https://euc1-1.relay.n0.iroh.link./`) is fit only for development.
- `RAROG_IROH_PORT` (optional): a fixed UDP port on `0.0.0.0` and `[::]` (e.g. for a firewall rule); without it the
  system picks one.

At `RAROG_IROH=1`, `RAROG_ORIGINS` is optional. Without it the server still listens on `127.0.0.1:<port>`, but
every mutation over TCP gets 403, and the pairing link from the admin socket and from `rarog pair` (without `--url`)
has only the fields `k` and `r` (`docs/distribution.md`, "`rarog pair`: the first device").

Each entry of `RAROG_ORIGINS` must be an `http` or `https` origin exactly as a browser sends it in `Origin`: lowercase
scheme and host, an optional port other than the default one, no path and no trailing slash
(`https://mac.example.ts.net`, `http://127.0.0.1:8930`). Any other entry (`null`, `*`, `https://a.example/`,
`HTTPS://A.EXAMPLE`, `https://a.example:443`, `file:///x`) is skipped and never reaches the allow-list. The server
still starts, with the remaining entries, and `server.log` gets one line per skipped entry: `RAROG_ORIGINS: skipped
"<entry>", not an http or https origin as a browser sends it (…)`. `rarog serve --check` prints the same line after
`warning`. With every entry skipped the list is empty, as without `RAROG_ORIGINS` at `RAROG_IROH=1`: every mutation
over TCP gets 403. Commas with nothing between them are ignored; a value of only commas is a configuration error.

**Turning it on by hand** (an existing `config.json`; for a new one `rarog setup` does steps 1 and 2):

1. Key: `openssl rand -hex 32`. Put it where the installation keeps secrets: the line `RAROG_IROH_KEY=<key>` in
   `~/.config/rarog/secret/private.env` (0600 in a 0700 directory), or the secrets manager of `service.wrapper` (add
   the name to the list the wrapper exports). Never in `config.json` (refusal) or argv. The key cannot be recovered,
   so keep a copy with the other server secrets.
2. In `env` in `~/.config/rarog/config.json`: `"RAROG_IROH": "1"`, `"RAROG_IROH_RELAY": "https://…/"` and, if
   needed, `"RAROG_IROH_PORT": "<port>"`.
3. `rarog serve --check` (the key shows in `secrets: set … RAROG_IROH_KEY`, never its value; the module
   in `iroh: native module loaded …`), then `rarog restart`.
4. `server.log` shows `iroh: accepting connections (EndpointId <64 hex characters>, relay <address>, UDP
   <sockets>)`, and after contact `iroh: home relay <address>`. The live state:
   `curl -s --unix-socket <dataDir>/run/admin.sock http://rarog/api/admin/iroh` (no key; the home relay with the time
   of its last event, not "connected", and `relayContact` with the start and the first contact with the relay;
   `firstContactAt` is `null` until the relay accepts the server), summarized by the `iroh` line of `rarog doctor`.

**Connection paths in `server.log`.** Each iroh connection, from its first authentication on (unauthenticated
connections log no paths), logs the path it uses at that moment and every switch the library makes:
`iroh: path <client id, 12 characters> direct <ip:port> rtt <n> ms` or `iroh: path <client id> relay rtt <n> ms`.
When it closes, one line sums it up, counting from authentication: `iroh: path <client id> summary <s> s: direct
<s> s, relay <s> s, switches <n>, lost packets <n>`. A switch is a change after the first path. Past 32 path lines
a connection logs only the summary, which then adds `suppressed <n>`. When the library dropped path events, the
summary adds `lagged <n>` (`lagged ?` without a count): its times are then approximate. Long relay time with zero
switches means the connection never found a direct route (`grep 'iroh: path' server.log`).

**Refusals and failures.** No key at `RAROG_IROH=1`: the server does not start (`Configuration error: RAROG_IROH=1
without RAROG_IROH_KEY …`, exit 1), and `serve --check`, `rarog restart` and `rarog service install` refuse before
any stop (under a wrapper at the full check through it). No native module (another platform, the platform package
missing): the same three refuse with the same sentence, and a server started without the check does not start.
Only the server start checks a busy UDP port. Each failure ends the server with a sentence on stderr and exit 1
before the HTTP listener, and `rarog doctor` shows a red `iroh` line. An accept loop that dies at run time ends the
process with exit 1, and the supervisor brings it back. After SIGTERM the listener closes connections and the
endpoint within 3 s, and the process ends within about 5 s.

**Turning it off:** `"RAROG_IROH": "0"` and `rarog restart`. An installation without `RAROG_ORIGINS` does not
come up after that: runbook "Turning off the iroh listener" in `docs/security-model.md`.

## Demo content language

`RAROG_DEMO_LANG` picks the language of the demo content (seeds, mock replies and triggers, notes, project names):
`en` or `pl`. Unset or empty means `en`. Any other value is a configuration error at start, also outside the demo,
where the variable has no other effect. The UI tests start the demo with `pl` (`scripts/ios-demo.sh`), because
XCUITest looks for the Polish seed texts. Sets and triggers: `docs/implementation-spec.md`, "Demo mode".

`RAROG_DEMO_CONTENT` replaces the language set with a named set, in English: the name of a demo content module in
the set directory of the install (`DEMO_SET_DIR` in `server/src/demo/content/named-set.ts`; lowercase letters, digits
and hyphens). A build without that directory carries no named set and refuses any name. Unset or empty means the
set of `RAROG_DEMO_LANG`. Each of these is a configuration error at start, also for `rarog serve --check`: a value of
another shape (also outside the demo), a set without `RAROG_DEMO=1`, with `RAROG_DEMO_REVIEW_CODE` (the review demo
keeps its own set), with `RAROG_DEMO_LANG=pl`, or a name without a module in this build.

## Demo review mode

A demo server for app review. `RAROG_DEMO=1` together with `RAROG_DEMO_REVIEW_CODE` turns it on; the code is a
fixed pairing code for the reviewer.

- `RAROG_DEMO_REVIEW_CODE` (secret): 43 base64url characters, the shape of a pairing code (new code:
  `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`). It comes from `private.env` or `service.wrapper`, never
  from `config.json` or argv. No message shows the value; the router's error log redacts it.
- Each of these is a configuration error at start: the code without `RAROG_DEMO=1`, a code of another shape,
  `RAROG_ORIGINS` other than exactly one bare `https` origin (the public address of the demo; an entry the server
  would skip, such as `null`, counts here and is refused), no explicit
  `RAROG_DATA_DIR` (devices are kept in a persistent `devices.json`), `RAROG_DEMO_LANG=pl` (the review demo is in
  English), and `RAROG_IROH=1`, as in any demo. The `RAROG_AUTH_EPOCH` guard works as outside the demo.
  `RAROG_VOICE` and the Soniox key have no effect, and the other demo rules stay (no push, no terminal).
- `POST /api/pair` with the code, compared in constant time, pairs a device with creator `admin` and the current
  epoch. The code is not used up and does not expire, and pairing revokes no other device. The log line is
  `devices: paired <id> (review code)`; it does not reset the failed-attempt limiter. Any other code takes the normal
  pairing path.
- At 10 active devices the code gets 429 `demo-review-full`, without `Retry-After` and without counting as a failed
  attempt. The log line `devices: review code refused, 10 active devices (limit 10)` comes at most once per 60 s
  window; the next one adds `, N more since the last line`. A slot frees up when a device is revoked, forgets the
  server or expires.
- Rotation: a new value and a restart; devices paired with the old code stay. Revoking all reviewer devices: a new
  `RAROG_AUTH_EPOCH` and a restart, or `rarog devices revoke` through the admin socket.
- At start, before the first request, the server deletes `client.log` and `client.log.1` in the data directory and
  logs `review demo: deleted <files> at start` for the files it found. A missing file is skipped; any other error
  ends the start with exit 1 and `review demo: could not delete <file> (<error code>)`. The plain demo keeps both.
- The server process starts no child process and reads nothing in the home directory apart from its data directory:
  the server name in the pairing response and the default model and effort of a new session are fixed values of the
  English content set, `/health` reports `hook: missing`, `/api/version` reports `tailnet: null` and
  `voiceEnabled: false` (`POST /api/voice/token` → 503), and the UI-test control M1 is not assembled
  (`POST /api/demo/control` → 404). The boundary in full: `docs/security-model.md`, "Review demo server".
