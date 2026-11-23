import { defineConfig } from 'vitest/config';
import { stripGitRepoEnv } from './server/test/helpers/git-repo-env.ts';
import { removeRunTmpdirAtExit, startRunTmpdir } from './server/test/helpers/run-tmpdir.ts';

// The git variables that point to a repository (`GIT_DIR` from `git rebase --exec` or from a hook) go away here, in
// the main process, before vitest starts its pools: vitest builds the environment of every worker (forks and
// threads) from `process.env` of the main process, and test subprocesses inherit it further. The list and why:
// `server/test/helpers/git-repo-env.ts`; proof: `server/test/git-repo-env.test.ts`.
stripGitRepoEnv(process.env);

// The run gets a temporary directory of its own: `TMPDIR` of the main process (and so of every worker and test
// subprocess) points at it, and the global teardown removes it after the run; the exit hook does the same for
// a process that loads this config and never runs tests. Directories of killed runs go at the next start. Why and
// how: `server/test/helpers/run-tmpdir.ts`; proof: `server/test/run-tmpdir.test.ts`.
startRunTmpdir(process.env);
removeRunTmpdirAtExit(process.env);

// One root config for the whole workspace: tests live next to the code, in <package>/test/.
export default defineConfig({
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'relay-vps/test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['server/test/helpers/run-tmpdir-teardown.ts'],
    clearMocks: true,
    // 30 s instead of the default 5 s (test) and 10 s (hook): on a loaded machine slow but correct tests failed on the
    // limit; a test that really hangs fails after 30 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
