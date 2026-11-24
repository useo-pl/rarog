/**
 * System reads of the consent-without-hook detector (`drivers/herdr/consent-no-hook-io.ts`): the hook child in `ps`
 * (three-valued: a `ps` that cannot run is "unknown", never "no hook") and the freshness of the `statusLine` dump.
 */
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookChildRunning, statuslineFreshness } from '../src/drivers/herdr/consent-no-hook-io.ts';
import { STATUSLINE_FRESH_MS } from '../src/herdr/hook-config.ts';

const SCRIPT = '/home/u/.claude/hooks/rarog/rarog-pending.mjs';
const PS_OUT = [
  '    1 /sbin/launchd',
  ' 4100 node /home/u/.claude/hooks/rarog/rarog-pending.mjs --answer-wait=1',
  ' 4200 /bin/zsh -l',
  '',
].join('\n');

describe('hookChildRunning', () => {
  it.each([
    ['a child of the session process runs the hook', 4100, PS_OUT, true],
    ['the hook runs under another process', 4200, PS_OUT, false],
    ['no hook process at all', 4100, '    1 /sbin/launchd\n 4100 /bin/zsh\n', false],
    ['ps failed (sandbox, timeout)', 4100, null, null],
    ['ps printed no process', 4100, '', null],
  ] as const)('%s', async (_name, pid, out, expected) => {
    const args: (readonly string[])[] = [];
    const running = await hookChildRunning(pid, SCRIPT, async (one) => {
      args.push(one);
      return out;
    });
    expect(running).toBe(expected);
    expect(args).toEqual([['-A', '-ww', '-o', 'ppid=,args=']]);
  });

  // The hook runs as `node <script> --answer-wait=…`: only the script as the first argument of `node` is the hook.
  it.each([
    ['the hook with the interpreter by its path', ` 4100 /opt/node/bin/node ${SCRIPT} --answer-wait=1\n`, true],
    ['the hook without further arguments', ` 4100 node ${SCRIPT}\n`, true],
    ['another program with the script as its argument', ` 4100 /bin/echo ${SCRIPT}\n`, false],
    ['node with another script first', ` 4100 node /home/u/tool.mjs ${SCRIPT}\n`, false],
    ['a longer path that starts with the script path', ` 4100 node ${SCRIPT}.bak --answer-wait=1\n`, false],
    ['a path that ends with the script path', ` 4100 node /x${SCRIPT} --answer-wait=1\n`, false],
    ['an interpreter whose name only ends with node', ` 4100 /bin/xnode ${SCRIPT}\n`, false],
  ] as const)('%s', async (_name, out, expected) => {
    expect(await hookChildRunning(4100, SCRIPT, async () => out)).toBe(expected);
  });

  it('a script path with a space leaves the argument bounds unsettled: unknown, unless no child names it', async () => {
    const spaced = '/home/u v/.claude/hooks/rarog/rarog-pending.mjs';
    const run = (out: string) => hookChildRunning(4100, spaced, async () => out);
    expect(await run(` 4100 node ${spaced} --answer-wait=1\n`)).toBeNull();
    expect(await run(' 4100 /bin/zsh -l\n 4200 node /srv/a.mjs\n')).toBe(false);
  });

  it('ps that throws is unknown', async () => {
    await expect(hookChildRunning(1, SCRIPT, () => Promise.reject(new Error('spawn')))).resolves.toBeNull();
  });
});

describe('statuslineFreshness', () => {
  it('none without a dump, fresh within the window, stale past it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rarog-statusline-'));
    const now = Date.now();
    expect(await statuslineFreshness(root, 's-1', now)).toBe('none');
    await writeFile(join(root, 's-1.json'), '{}');
    expect(await statuslineFreshness(root, 's-1', now)).toBe('fresh');
    const old = (now - STATUSLINE_FRESH_MS - 60_000) / 1000;
    await utimes(join(root, 's-1.json'), old, old);
    expect(await statuslineFreshness(root, 's-1', now)).toBe('stale');
  });
});
