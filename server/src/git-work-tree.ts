/**
 * The work tree of a git read: the session directory or its nearest ancestor with a `.git` entry. The runner in
 * `git-status.ts` passes it to git as `--work-tree`, so `core.worktree` from repository config, which the agent
 * writes, cannot move a read outside that directory. The lookup resolves the path and checks names with `lstat` only:
 * it opens no file, reads nothing inside `.git` and starts no git.
 */
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The work tree for a read in `cwd`: walking up from `realpath(cwd)`, the first directory where `lstat` sees a `.git`
 * entry of any kind (a directory, the file of a linked worktree or a submodule, a symlink). `null` when no directory up
 * to the root has one. Rejects with the error of `realpath` when `cwd` cannot be resolved, and with any `lstat` error
 * other than `ENOENT`: a name that cannot be checked is not taken for absent.
 */
export async function gitWorkTree(cwd: string): Promise<string | null> {
  for (let dir = await realpath(cwd); ; dir = dirname(dir)) {
    if (await hasGitEntry(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, '.git'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw error;
  }
}
