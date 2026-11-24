/**
 * A hook that registers after the emergency approve button sent its digit, end to end: `scripts/hooks/rarog-pending.mjs`
 * as a child process against the real registry, cycle and registration socket. The key already answered the dialog,
 * so the hook must not give a second answer. The cycle learns of the key before it sees the hook's dump, settles the
 * record as when its dialog is gone and sends the hook a signed `release`: the hook exits without printing a decision,
 * for the main thread and for a subagent at `all` alike.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { CONSENT_DIRNAME } from '../src/herdr/dialogs/layer1/contract.ts';
import { readCallDumps } from '../src/herdr/dialogs/shadow/files.ts';
import {
  HOOK_SESSION, hookExit, hookScene, readHookLog, removeHookDirs, startHook, stopHookRuns, until,
} from './helpers/hook-kanal.ts';

const INPUT = { command: 'npm test', description: 'Run the tests' };
const TIMEOUT = 15_000;

afterEach(stopHookRuns);
afterAll(removeHookDirs);

describe.each([
  ['main thread', 'main', undefined],
  ['subagent at `all`', 'all', 'a1b2c3'],
] as const)('%s: registration accepted after the emergency key', (_name, mode, agentId) => {
  const thread = agentId === undefined ? 'main' : 'subagent';

  it('the hook takes a signed `release` and prints nothing, the record is settled `dialog-gone`, one late hook line',
    async () => {
      const logs: string[] = [];
      const s = await hookScene({ mode, log: (line) => { logs.push(line); } });
      const since = Date.now() - 3_000;
      const run = startHook(s.dir, s.project, {
        toolName: 'Bash', toolInput: INPUT, extra: agentId === undefined ? {} : { agent_id: agentId },
      });
      await until(() => readHookLog(s.dir).find((line) => line.ev === 'czekam'), 'the hook waiting');
      const dump = await until(() => readCallDumps(s.dir, HOOK_SESSION)[0], 'the per-call dump');
      expect(dump.agentId).toBe(agentId);
      // The key went out while the registration was still being read: the driver notes it before the cycle can see
      // the hook's dump.
      s.cycle.screenKey(HOOK_SESSION, { toolName: 'Bash', inputSha256: canonicalSha256(INPUT), at: Date.now(), since });
      expect(await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump))
        .toMatchObject({ state: 'revoked', canAllow: false });

      const outcome = await run.done;
      expect(outcome).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(hookExit(s.dir)).toMatchObject({ powod: 'release' });
      const taken = join(s.dir, CONSENT_DIRNAME, HOOK_SESSION, `${dump.key}.claimed`);
      expect(JSON.parse(readFileSync(taken, 'utf8'))).toMatchObject({ decision: 'release', key: dump.key });
      expect(existsSync(join(s.dir, CONSENT_DIRNAME, HOOK_SESSION, `${dump.key}.json`))).toBe(false);
      expect(s.cycle.record(HOOK_SESSION, dump.key))
        .toMatchObject({ state: 'revoked', cause: 'dialog-gone', decision: null });
      expect(logs.filter((line) => line.includes('late hook'))).toEqual([
        `consent: screen fallback late hook — session ${HOOK_SESSION}, key ${dump.key}, thread ${thread},`
          + ' release dialog-gone',
      ]);
    }, TIMEOUT);
});
