/**
 * The `ignored` labels of a directory listing: `git check-ignore` through the runner of `git-status.ts`, run in the
 * listed directory, so git applies the rules of the repository that directory belongs to (a nested repository, a
 * submodule, its `info/exclude`). A label only: a read that fails drops every label of the listing, never the
 * listing. The module reads no file and starts git only through the runner.
 */
import type { FileListing } from '@rarog/shared';
import type { GitArgsResult, GitArgsRunner, GitCommand } from '../git-status.ts';

/**
 * Names per `check-ignore` process. The runner gives git no stdin, so the names go as arguments; 200 names of at
 * most 255 bytes each stay far below the argument limit of the system.
 */
export const CHECK_IGNORE_BATCH = 200;

/** What stands before every name: the listed directory itself, so the argument is never pathspec magic. */
const HERE = './';

/**
 * One batch: every name after `--` and after `./`. `check-ignore` refuses `--literal-pathspecs` (git 2.54.0: "pathspec
 * magic not supported by this command: 'literal'"), and a name that starts with `:` would be read as magic (`:!x`
 * kills the batch); `./` keeps it a path in the listed directory, and `--` keeps a name that starts with `-` from
 * being an option. Git prints each reported path as given, `./` included.
 */
export function checkIgnoreCommand(names: readonly string[]): GitCommand {
  return { sub: 'check-ignore', rest: ['--', ...names.map((name) => `${HERE}${name}`)] };
}

/** The escapes of git's C-style quoting (`quote_c_style`) other than the three octal digits of a byte. */
const ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c,
};

/**
 * A path as `check-ignore` prints it: as given, or in C-style quotes when it holds a byte git quotes (a byte over
 * 0x7f under `core.quotePath`, `"`, `\`, a control character). `null` for a line that is not a valid quoted path.
 */
export function unquotedPath(line: string): string | null {
  if (!line.startsWith('"')) return line;
  if (line.length < 2 || !line.endsWith('"')) return null;
  const chars = [...line.slice(1, -1)];
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? '';
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const octal = chars.slice(i + 1, i + 4).join('');
    if (/^[0-3][0-7]{2}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    const escaped = ESCAPES[chars[i + 1] ?? ''];
    if (escaped === undefined) return null;
    bytes.push(escaped);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The names one batch reported, or `null` for a failed read. `-z` would give raw bytes, but git takes it only with
 * `--stdin`, so the output is one path per line. Exit code 0: the paths on stdout; 1: none of the names is ignored;
 * anything else (128 outside a repository or on a broken one, no exit code, a read cut at its cap) is a failure.
 */
function reportedNames(result: GitArgsResult): string[] | null {
  if (result.capped === true || result.timedOut === true) return null;
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) return null;
  const names: string[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line === '') continue;
    const path = unquotedPath(line);
    if (path?.startsWith(HERE) !== true) return null;
    names.push(path.slice(HERE.length));
  }
  return names;
}

/** The names of `names` git ignores in `dir`, or `null` when one batch failed. */
export async function ignoredNames(
  dir: string, names: readonly string[], run: GitArgsRunner,
): Promise<ReadonlySet<string> | null> {
  const wanted = new Set(names);
  // Git on macOS (`core.precomposeunicode`) reports a decomposed name composed: such a name maps back to the entry
  // when exactly one entry composes to it, and gets no label when two do.
  const composed = new Map<string, string | null>();
  for (const name of names) {
    const key = name.normalize('NFC');
    composed.set(key, composed.has(key) ? null : name);
  }
  const ignored = new Set<string>();
  for (let start = 0; start < names.length; start += CHECK_IGNORE_BATCH) {
    let result: GitArgsResult;
    try {
      result = await run(checkIgnoreCommand(names.slice(start, start + CHECK_IGNORE_BATCH)), dir);
    } catch {
      return null;
    }
    const reported = reportedNames(result);
    if (reported === null) return null;
    for (const name of reported) {
      const entry = wanted.has(name) ? name : composed.get(name);
      if (entry) ignored.add(entry);
    }
  }
  return ignored;
}

/**
 * `listing` with `ignored: true` on every entry git ignores in `dir`, the directory on disk the listing read. An
 * empty listing runs no git; a failed read gives the listing without labels.
 */
export async function labelIgnored(listing: FileListing, dir: string, run: GitArgsRunner): Promise<FileListing> {
  if (listing.entries.length === 0) return listing;
  const ignored = await ignoredNames(dir, listing.entries.map((entry) => entry.name), run);
  if (ignored === null || ignored.size === 0) return listing;
  return {
    ...listing,
    entries: listing.entries.map((entry) => (ignored.has(entry.name) ? { ...entry, ignored: true as const } : entry)),
  };
}
