# Contributing

Issues and pull requests are welcome, in English or Polish. Development happens in a private repository: an accepted
pull request is applied there, ships in the next release, and the pull request is then closed with a link to that
release. Security reports go through [SECURITY.md](SECURITY.md), not public issues. Everyone who takes part follows
the [Code of Conduct](CODE_OF_CONDUCT.md).

- **License of contributions.** Rarog is licensed under the MIT License ([LICENSE](LICENSE)), and so is your
  contribution: by opening a pull request you agree that your change is licensed under the same terms. There is no
  contributor license agreement to sign.
- **Credit.** The public repository receives each release as one commit, so your commit does not appear in its
  history. The release notes of the release that ships your change name you and link your pull request.
- **What to expect.** Rarog is maintained on a best-effort basis. A maintainer reads every issue and pull request,
  but there is no deadline for a reply, a review or a release, and a change can be declined when it does not fit the
  project.

- **Language.** Public documentation, CLI messages and the app interface are in English, and so are most
  identifiers. Many code comments, most test titles and some names of test files, scripts and script options are in
  Polish, the working language of the team that builds Rarog. The app also has a Polish interface: it follows the
  device language and falls back to English ([docs/localization.md](docs/localization.md)).
- **Checks.** Run `pnpm install` and `pnpm run check` before you open a pull request. The check runs the typecheck,
  the tests, the Swift contract tests (these need full Xcode), `git diff --check`, `bash -n` and ShellCheck on
  `scripts/*.sh` and `relay-vps/*.sh`, the TOML syntax of `relay-vps/*.toml` (Python 3.11+), the zizmor audit of
  the GitHub Actions workflows, and has no side effects on a running server. Server tests open local ports; an agent
  working in the Claude Code sandbox must run them outside the sandbox. Before any test starts, `vitest.config.ts`
  removes the git variables that point to a repository (`GIT_DIR`, `GIT_INDEX_FILE` and the rest of the list in
  `server/test/helpers/git-repo-env.ts`), so the repositories that tests create with `git -C <dir>` stay in their own
  directories even when the tests run from a git hook or from `git rebase --exec`. It also points `TMPDIR` at
  a directory of the run (`vt` and two random characters, in the caller's temporary directory) and removes it after
  the run, so temporary files of tests do not pile up; the next run removes the directory of a run that was killed
  (`server/test/helpers/run-tmpdir.ts`). CI runs the same checks on Ubuntu and macOS, except zizmor
  ([docs/publishing.md](docs/publishing.md), section "CI").
- **Demo server.** `RAROG_PORT=18931 RAROG_ORIGINS=http://127.0.0.1:18931 pnpm run demo:server` runs every scenario
  on fakes, without herdr and without `claude` processes. A Debug build of the app reaches it with the launch
  variable `RAROG_UI_TEST_BASE_URL=http://127.0.0.1:18931` and pairs with a code from `POST /api/demo/pairing`, a
  route that exists only in the demo ([native/Rarog/docs/tests.md](native/Rarog/docs/tests.md), section „Tests”). The demo
  content is English; `RAROG_DEMO_LANG=pl` switches to the Polish set that the UI tests use.
- **Docs with the code.** The docs describe the system as it works today. A change in behavior must update the
  matching document in the same commit.
- **Facts about Claude Code.** Anthropic's terms prohibit reverse engineering Claude Code. Take facts about the CLI
  only from its documentation and documented interfaces (such as hook payloads) or from observing the running CLI,
  and note the CLI version you observed; never from reading Claude Code's code. The test
  `server/test/cli-bez-binarki-guard.test.ts` flags wording about program code, and
  `server/test/cli-fakty-zapadka.test.ts` fails on a sentence about CLI behavior without a source
  ([docs/distribution.md](docs/distribution.md), section "What the repo knows about Claude Code").
- **Parallel work.** Each parallel stream of work, for example each agent session, gets its own git worktree, not a
  shared checkout. In a new worktree, `bash scripts/worktree-init.sh` installs the dependencies offline from the
  main checkout's pnpm store and links that store into the worktree. You can run `pnpm run check` in any worktree;
  do not run `pnpm run restart` from one, because it restarts the one shared installation.
- **Review.** Keep a pull request to one logical change and say what it changes and how you tested it. The
  maintainers review every pull request before applying it.
- **Comments.** A code comment says what the code does and why it must be so today. Comments, test titles and docs
  carry no history, change dates or labels of the maintainers' unpublished registers of decisions and requirements.
