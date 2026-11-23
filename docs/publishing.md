# Publishing: what the public repository must not carry and who guards it

The repository is public under the MIT license. It carries the protection mechanism: a loader for the private
literals file, a scanner, guards with a ratchet, structural patterns and `.gitignore` rules. The names it must not
carry (clients, the owner's projects and infrastructure, the account) live only in the private literals file,
outside the repository.

The public repository receives the **export view** of the source repository: the files a classification marks
public, copied as they are. The classification (`publish.config.json`) and the rest of the private layer (agent
instructions, decision log, plans, owner procedures, release tools) stay out. Guards keep hits from growing (the
ratchet). Zero is enforced by the **publish gate**, a release tool that stays in the private layer: before a release
it exports `HEAD` with `git archive` (the clean export) and runs the same scans on it, then `check.sh --strict` with
the literals file on one copy and the tests without it, as public CI runs them, on another.

## Private literals file

Path: `RAROG_PRIVATE_LITERALS` when non-empty, otherwise `~/.config/rarog/private-literals.json`; it may be
a symlink. Repository code only reads it (`scripts/lib/private-literals.mjs`, plain ESM that runs before
`pnpm install`) and holds no copy of it. Schema `version: 2`; every field except `version` and `forbidden` is optional:

```json
{
  "$comment": "free text for a human",
  "version": 2,
  "forbidden": ["name", { "literal": "name", "category": "client" }],
  "patterns": [{ "name": "login-in-path", "regex": "…" }],
  "pseudonyms": { "name": "alfa" },
  "allow": [{ "path": "file/in/repo", "literal": "name", "reason": "…" }]
}
```

- **`forbidden`**: literals of 3 characters or more, each with a category (default `uncategorized`), with no
  duplicates and no literal contained in another (a hit would count twice). Matching is a substring after NFKC and
  lowercasing, so it catches inflected forms, capitals and full-width characters.
- **`patterns`**: regular expressions with context for a name whose bare literal would hit ordinary words, such as
  a login only inside a path (`/Users/<login>`).
- **`pseudonyms`**: the anonymizer map, private name → neutral placeholder (`alfa`, `beta`…).
- **`allow`**: lifts one literal in one repository file, with a required reason.

An error in the file names the field (`forbidden[3]`), never its value, because the message reaches terminals and
test logs. A broken file never looks like a missing one: `node scripts/lib/private-literals.mjs` exits 0 with entry
counts, 3 for a missing file and 2 for a broken one.

## Fixture anonymizer

`scripts/anonymize-fixture.ts` is the final pass for every fixture taken from a live Claude Code session in a herdr
pane (herdr is the terminal multiplexer Rarog runs sessions in), whether a measurement script or a manual pane
capture wrote it. Rules and CLI: `server/test/fixtures/herdr/README.md`, "Writing a fixture". It fails closed: with
a missing or broken literals file it refuses to write (exit 2), and output that
carries a `forbidden` literal or a structural pattern after the pass never reaches disk. The manifest
`server/test/fixtures/herdr/provenance.json` records each file's origin and `ANONYMIZER_VERSION`; a placeholder
change bumps the version and adds a rewrite to `PLACEHOLDER_MIGRATIONS`, so a fixture written under a lower
version matches a fresh write. Test: `server/test/anonymize-fixture.test.ts`.

## What protects whom

| Guard | Watches | Without the literals file |
| --- | --- | --- |
| `herdr-fixtures.test.ts` | literals in `fixtures/` and `Fixtures/` directories | skipped |
| `distribution-guard.test.ts`, private part | literals in the rest of the repo, `*.md` included | skipped |
| `distribution-guard.test.ts`, public part | Apple Team ID and app key prefix: only files in `ALLOWED` | runs |
| `private-patterns-guard.test.ts` | structural patterns, list below | runs |
| `teksty-cli-guard.test.ts` | decision labels, dates, measurement script paths in `rarog` and terminal strings | runs |
| `scripts/lib/private-scan.mjs` | the same as the name guards, in one pass | exit 2 |
| `scripts/anonymize-fixture.ts` | fixture writes | refuses, exit 2 |

A name guard (one that needs the literals file) skips without the file, with `SKIP_REASON` from
`scripts/lib/private-literals.mjs` in its title, so public CI passes. `RAROG_REQUIRE_PRIVATE_LITERALS=1` turns the
skip into a failure; `check.sh --strict` sets it. A broken file always fails.

Structural patterns (`scripts/lib/private-patterns.mjs`) catch a class of data, not a name, so they live in the
repository: email addresses outside example domains, `claude.ai` and the product domain, Tailscale MagicDNS host
names (`*.ts.net`) whose tailnet name is not `example` or `demo`, home directories with a non-synthetic login, the
macOS temp directory, API identifiers of real length, the Claude account plan name from the CLI welcome banner, the
five-hour usage counter from the status bar (`5h:` and a percentage), tracker ticket numbers outside public
prefixes, bare commit hashes in `*.md` prose and `git show <hash>`.

An entry in `STRUCTURAL_EXCEPTIONS` (same module: file, pattern, line fragment, reason) lifts that pattern's hits in
the lines of that file that contain the fragment as a substring, one hit per occurrence. Only data shaped like
private data by nature gets one (a dependency pin commit, a temp path in a test). The publish gate applies the same
exceptions, and an exception without a hit fails the guard.

## Ratchet versus gate

Ratchet: the hit count per file must not grow against the baseline in the test (`FIXTURES_BASELINE`,
`PRIVATE_BASELINE`, `BASELINE`). A baseline above the count fails too, so every cleanup lowers it. The failure lists
the change per file and the whole current baseline to paste. A path that carries a literal appears masked
(`‹forbidden[i]›`). Fix a new hit with a synthetic value; do not raise the baseline.

Ratchets count only export view files (`inExportView` in `server/test/private-guard.ts`). The source repository
carries `publish.config.json`, so there the guard skips the files it classifies as private. The export does not
carry that file, so there the guard counts every file. So the baseline is the same in both.

Gate: `RAROG_PUBLISH_GATE=1` ignores the baseline and requires zero in every ratchet.

Name guard counts depend on the literals file's contents. After the file changes, recount: run the name guards with
it and paste the baseline from the failure message into the test (`FIXTURES_BASELINE` in `herdr-fixtures.test.ts`,
`PRIVATE_BASELINE` in `distribution-guard.test.ts`).

## The `private-scan.mjs` scanner

```bash
node scripts/lib/private-scan.mjs [--literals <file>] [<root>]                  # report
node scripts/lib/private-scan.mjs --gate [--literals <file>] [<root>]           # gate: zero
node scripts/lib/private-scan.mjs --gate --config <file> <root>                 # gate with `binaries` from a file
node scripts/lib/private-scan.mjs --baseline [--baseline-file <file>] [<root>]  # ratchet outside the repo
node scripts/lib/private-scan.mjs --update-baseline [--baseline-file <file>] [<root>]
```

It scans the repo file list (below): file contents, file and directory names, symlink targets (not followed) and
printable strings in binary files. A binary file must be on the `binaries` list (`[{ path, reason }]`) of the root
`publish.config.json` or, for a tree without that file such as the export, of the file passed with `--config` (the
publish gate passes the source checkout's). With neither, the list is not checked and `--gate` exits 2. Output is
`path:place: forbidden[i] (category)` plus a summary per category; it never prints a literal. The `--baseline` file
defaults to `private-literals.baseline.json` next to the literals file, outside the repository. Exit codes: 0 clean
or a baseline written, 1 hits, growth or an unlisted binary file, 2 a setup error (missing or bad literals
file, bad `binaries` list or baseline, `--gate` without a `binaries` list, unreadable repository file, bad
argument).

## Repo file list

Guards, the scanner and the gate share one file list: `scripts/lib/repo-files.mjs` (`repoFiles`). With `.git` at the
root it runs `git ls-files --cached --others --exclude-standard`. Without it (a `git archive` export) it walks the
tree with the `.gitignore` rules per gitignore(5). A file name that is not UTF-8 throws instead of dropping out.
`server/test/repo-files.test.ts` compares the walk with git on a synthetic repository and on an export of this one.

## `check.sh --strict`

```bash
pnpm run check                 # conditional steps may skip
bash scripts/check.sh --strict # or RAROG_CHECK_STRICT=1 pnpm run check
```

Conditional steps need something the machine may lack: the private literals file, full Xcode (`swift-contract`),
`relay/node_modules` (relay; relay-auth also needs `relay-auth/node_modules`), `.git` (`git diff --check`),
ShellCheck (`scripts/*.sh`, `relay-vps/*.sh`), Python 3.11+ with `tomllib` (TOML in `relay-vps/`) and zizmor
(`uv tool install zizmor`).
zizmor audits the `.github` workflows offline (`zizmor --offline --strict-collection .github`): template injection,
token permissions, cache, action pinning. Any finding, or a workflow it cannot parse, fails the gate.

Without `--strict` a skipped step prints `skipped`, the last line lists the skips, and a green run exits 0. With
`--strict` a skip exits 3 with the step name; a missing literals file exits 3 at once, before the tests, and the
tests get `RAROG_REQUIRE_PRIVATE_LITERALS=1`. A broken literals file or an unknown argument exits 2 in both modes.
`RAROG_CHECK_TEST_REPORT=<file>` adds a vitest JSON report, from which the publish gate (top of this document) reads
test counts per file.
Tests: `server/test/scripts-check.test.ts` and `relay-vps/test/bramka.test.ts`.

## `.gitignore`

Besides build output, the repository ignores local files that must not reach the public repository: photos from the
app (`.rarog-uploads/`), agent worktrees (`**/.claude/worktrees/`), local Claude Code settings and notes
(`.claude/settings.local.json`, `CLAUDE.local.md`), `.env` files, PEM keys and the App Store Connect API key.
`relay/.gitignore` and `relay-auth/.gitignore` add the `wrangler dev` secrets (`.dev.vars`, `.dev.vars.*`).
`*.example` templates stay. `server/test/repo-files.test.ts` checks the patterns on synthetic paths and that no
tracked file matches them.

## Publishing the npm package

The packer (`scripts/package.mjs`, see `docs/distribution.md`, "npm package") knows no file classification and
packs the tree it runs in. Built in the public repository, the package carries only the files the server reads at
run time and dependency copies with their licenses (`THIRD-PARTY-NOTICES`), never the Anthropic SDK;
`server/test/package-build.test.ts` checks the contents.

`.github/workflows/publish.yml` publishes the package. It runs only by hand (`workflow_dispatch`) with `version`
(X.Y.Z), `name` (only `@rarog/server`; the `build` job refuses any other value) and `dry-run` (on by default).
A dry run runs every job except `publish`, from a branch too (command at the end). It has no secrets: npm issues the
registry token from GitHub's OIDC token (trusted publishing). Workflow-level permissions are empty; inputs reach
scripts only through `env`; only `build` checks out, without persisted credentials; actions are pinned to release
SHAs; the package manager cache is off.

1. **build** (`contents: read`) checks the inputs against `package.json` and, outside a dry run, that the run stands
   on tag `v<version>` and `repository.url` names the run's repository (npm rejects provenance from another one).
   It runs the typecheck and the tests, builds the tarball with `node scripts/package.mjs` and audits it with
   `scripts/package-audit.mjs` (below).
2. **sbom** (no permissions, Ubuntu and macOS) installs the tarball without scripts and stores a CycloneDX SBOM per
   platform, because the package of iroh (the QUIC library behind the server's iroh listener) ships its native module
   as one package per platform. It fails when the SBOM lacks the package or lists the
   Claude SDK. It needs npm 11: npm 10 installs the iroh packages of every OS.
3. **publish** (outside a dry run; environment `npm`, whose tag and approval rules live in the repository settings;
   only `id-token: write`) checks the tarball's sha256 and sends it with `npm stage publish` and an empty npm config.
   The version lands staged: nobody can install it until the package owner approves it with `npm stage approve` and
   2FA. The workflow approves nothing; npm adds provenance on an OIDC publish.

The tarball audit (`node scripts/package-audit.mjs [--files-only] [--name] [--version] <tarball> <manifest>`)
compares the tarball with the packer's build manifest: sha256, the `npm pack --dry-run --json` list, and each entry
read without unpacking (only regular files under `package/`, no links, no data after the first zero block). The
tarball's `package.json` must match the manifest's name and version, and no path or dependency may name the Claude
SDK. `--files-only` compares content only, for a registry package against a local build. Exit 0 is a match, 1
differences on stderr, 64 a bad call. Test: `server/test/package-audit.test.ts`.

## macOS-only tests

Some tests check code that takes another branch elsewhere (launchd instead of systemd) or call macOS tools such as
`plutil`, `stat -f` and `launchctl`. Off macOS they skip explicitly: `skipIf(!IS_MAC)` with a title from
`macOnly(…)` in `server/test/platform.ts`. Files with such tests in `server/test/`:

- `git-konfiguracja-repo.test.ts`: git reads under the `sandbox-exec` profile (its other cases run everywhere);
- `live-activity-plist-guard.test.ts`: Live Activity keys in `Info.plist`;
- `privacy-manifest-guard.test.ts`: the privacy manifest;
- `rarog-doctor.test.ts`: `rarog doctor` on launchd fakes;
- `rarog-restart.test.ts`: `rarog restart` and `restart.sh` under launchd;
- `rarog-service.test.ts`: `rarog service install` and `uninstall` under launchd;
- `rarog-setup.test.ts`: `rarog setup` on the macOS path;
- `rarog-update-finish.test.ts`: `rarog update --finish` on launchd fakes (its Linux case runs everywhere);
- `rarog-update.test.ts`: the finish part of `rarog update` on launchd fakes (its registry cases run everywhere);
- `scripts-ios-check-demo.test.ts`: the iOS gate;
- `scripts-ios-lib.test.ts`: the App Store Connect key;
- `scripts-launchd.test.ts`: `restart.sh` with a `launchctl` fake;
- `secret-input.test.ts`: the secret question of `bin/rarog.mjs` between two questions, in a pseudo-terminal
  (`script`);
- `setup-check.test.ts`: the closing check of `rarog setup`;
- `setup-config.test.ts`: the `config.json` step of `rarog setup`;
- `setup-herdr-agent.test.ts`: the herdr agent step of `rarog setup` and its doctor line, on `launchctl` fakes;
- `setup-pytania.test.ts`: the questions of `rarog setup` (the plan screen and the Settings question);
- `setup-roots.test.ts`: the project directories of a new and an existing `config.json` in `rarog setup`;
- `setup-screen.test.ts`: the step screen and the run log of `rarog setup`;
- `setup-secrets.test.ts`: the secrets file step of `rarog setup`;
- `setup-tailscale-only.test.ts`: the Tailscale only question and `--tailscale-only` of `rarog setup`;
- `setup-transport.test.ts`: the transport (iroh, the server address) and `tailscale serve` in `rarog setup`;
- `setup-voice.test.ts`: the dictation and voice agent questions of `rarog setup`, also in a pseudo-terminal
  (`script`).

Other skips also give the reason in the title: a missing tool (git, lsof, ShellCheck, `tomllib`, the iroh platform
package), a present iroh platform package, a case-sensitive temporary directory, or an opt-in variable
(`RAROG_TEST_HERDR=1`, `RAROG_TEST_IROH=1`, `RAROG_TEST_NETWORK=1`). The hook copy tests in
`rarog-setup.test.ts` and the setup runs in `setup-transport.test.ts`, `setup-screen.test.ts` and
`setup-pytania.test.ts` need a git checkout, because the copy takes only committed state.
The skip inventory in `server/test/scripts-check.test.ts` lists every skip site per file; a new or vanished skip
fails it, and so does a mismatch with the list above. The same test requires the reason in the title on the same
line as `skipIf`, `runIf`, `.skip` or `.todo`.

## CI

`.github/workflows/check.yml` has five jobs, all without secrets and with a read-only token. Each job that sets up
Node sets the version explicitly, because `engines.node` has no upper bound; `server/test/install-mode.test.ts`
checks this.

The workflow runs on a push to `main`, a `v*` tag, a pull request and a manual run (`workflow_dispatch`). A push to
another branch starts nothing: a branch with a pull request is checked through the `pull_request` event. A newer run
of the same event on the same ref cancels the run in progress, except on tags. What runs depends on the event and on
`github.event.repository.private` (`server/test/ci-check-workflow.test.ts` checks the table):

- **Public repository, any event:** every job: `checks`, the server tests in parts (`tests`), the server tests on
  macOS (`macos-tests`), `swift-contract`, and `package` on Ubuntu and macOS.
- **Private repository, manual run:** every job, as in a public repository.
- **Private repository, `v*` tag:** the same without `macos-tests`, so a tag in a private repository leaves the
  macOS-only tests (section "macOS-only tests" above) to a manual run or to a local run.
- **Private repository, push to `main` or pull request:** `checks` and `package` on Ubuntu with Node 22, 24 and
  26; no `pnpm test` and no macOS.

The jobs:

- **checks** (Ubuntu, Node 22, the lowest line of `engines.node`): install at the root, in `relay/` and
  in `relay-auth/`, typecheck, the app copy catalogs (`scripts/l10n-check.mjs`), typecheck and tests of the push
  relay and the iroh relay registry, ShellCheck and TOML.
- **tests** (Ubuntu, Node 22): `pnpm test` split into parts with `vitest --shard`, one job per part, because the
  whole suite takes longer than one job may run on a hosted runner. The part list and the time limit of one part
  stand once, in the job's matrix; the job name and the skip summary show the part (`3/6`).
- **macos-tests** (image `xcode-27`, the Xcode line that builds the app; Node 22): `pnpm test`.
- **swift-contract** (image `xcode-27`): the tests of the `RarogContract` package (the Swift decoder on the golden
  SSE frames). The package reads committed fixtures, so the job installs neither Node nor pnpm. As its own job it
  runs also when the server tests are red.
- **package** (Node 22, 24 and 26; Ubuntu, and macOS under the `swift-contract` job's conditions): builds the
  tarball and runs `scripts/package-smoke.sh` with `npm i -g` and `pnpm add -g`. Each install goes to its own
  prefix with a temporary `HOME` and checks the package count, `rarog --help`, the Claude SDK download
  (`server/test/sdk-install-live.test.ts`), `rarog serve --check`, a demo server with `/health` and its stop.
  Locally: `bash scripts/package-smoke.sh npm <tarball>` (demo port `RAROG_SMOKE_PORT`, default 18939).

The steps mirror `check.sh`, but a missing tool fails the step instead of skipping, and the steps after typecheck
and after the tests run even when a step before them fails, so one run shows every failure. In each job that runs
`pnpm test` (each part of `tests`, and `macos-tests`), `scripts/lib/ci-summary.mjs` adds test counts and skips by reason to
the job summary. A skip reason stands in parentheses in the test or `describe` title and
starts with one of the `REASON_MARKERS`: `macOS only`, `only with`, `requires`, `skipped` or the `SKIP_REASON`.
A skip without one fails the job. The exception is a file where a vitest hook (`beforeAll` of the file or of one
`describe`) or the import failed: vitest marks the tests behind it as skipped, and the summary counts them in the row
`file failed before its tests` (the test step is red anyway). The same summary locally:

```bash
pnpm test --reporter=default --reporter=json --outputFile.json=report.json
node scripts/lib/ci-summary.mjs report.json local
```

What CI does not check:

- **Name guards.** CI has no private literals file, so green CI is not the publish gate.
- **Tests that need a live herdr** (`RAROG_TEST_HERDR=1`) or a tool missing on the runner. The skip table shows
  them.
- **The iOS gate.** CI does not build the app or run UIKit and XCUITest tests (`scripts/ios-check.sh`).
- **`git diff --check`.** CI gets a clean checkout.
- **An npm other than the one that ships with Node.** A new npm major needs the steps in `docs/distribution.md`,
  "After an npm or pnpm update".
- **Workflow audit.** The runner has neither zizmor nor actionlint. zizmor runs as a `check.sh` step; run
  actionlint by hand at the repository root (`.github/actionlint.yaml` declares the `xcode-27` runner label it does
  not know).

## Commands

```bash
node scripts/lib/private-literals.mjs                                      # is the literals file there
RAROG_REQUIRE_PRIVATE_LITERALS=1 pnpm test                                 # name guards without skips
RAROG_PUBLISH_GATE=1 pnpm test server/test/private-patterns-guard.test.ts  # zero structural pattern hits
node scripts/lib/private-scan.mjs                                          # full hit report
bash scripts/check.sh --strict                                             # gate without skips
actionlint                                                                 # workflow syntax and types
gh workflow run publish.yml --ref main -f version=<version from package.json> -f name=@rarog/server -f dry-run=true  # dry run
```
