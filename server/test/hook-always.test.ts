/**
 * The "always" option end to end: the hook (`scripts/hooks/rarog-pending.mjs` with `consent.mjs`) as
 * a child process against the real registry, cycle and registration socket (`helpers/hook-kanal.ts`).
 *
 * On a signed `allow-always` file the hook gives `allow` with `updatedPermissions` equal to the `permission_suggestions`
 * of its own stdin, and only when the signed digest is the digest of that list and the list is on the closed list.
 * A digest of other updates, or its own list outside the closed list, makes the file invalid: the hook sets it aside
 * and goes on waiting, so the dialog stays at the desk. The receipt (`POST /claim`) works as for `allow`.
 *
 * The stdin lists come from the measured hook inputs in `fixtures/consent-dowod/` (CLI 2.1.311 and 2.1.322).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_DIRNAME } from '../src/herdr/dialogs/layer1/contract.ts';
import { signConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import { scanCallDumps } from '../src/herdr/dialogs/shadow/files.ts';
import {
  HOOK_SESSION, hookExit, hookScene, readHookLog, removeHookDirs, startHook, stopHookRuns, until,
} from './helpers/hook-kanal.ts';
import type { HookScene } from './helpers/hook-kanal.ts';

const TIMEOUT = 15_000;
const FIXTURES = join(import.meta.dirname, 'fixtures', 'consent-dowod');

afterEach(stopHookRuns);
afterAll(removeHookDirs);

interface Stdin {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly permission_suggestions: unknown;
}

function measured(name: string): Stdin {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.hook.json`), 'utf8')) as Stdin;
}

function hookOf(s: HookScene, stdin: Stdin, suggestions: unknown = stdin.permission_suggestions): ReturnType<typeof startHook> {
  return startHook(s.dir, s.project, {
    toolName: stdin.tool_name, toolInput: stdin.tool_input, extra: { permission_suggestions: suggestions },
  });
}

/** The hook waits and its card has the approve button; returns the dump. */
async function cardUp(s: HookScene): Promise<HookCallDump> {
  await until(() => readHookLog(s.dir).find((line) => line.ev === 'czekam'), 'the hook waiting');
  const dump = await until(() => scanCallDumps(s.dir, HOOK_SESSION).dumps[0], 'the per-call dump');
  expect(await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump)).toMatchObject({ canAllow: true });
  return dump;
}

/** An `allow-always` file signed with the hook's live secret over the digest of `updates` (not from the cycle). */
function forgeAlways(s: HookScene, key: string, updates: unknown): void {
  const secret = s.registry.secretOf(HOOK_SESSION, key);
  const entry = s.registry.entry(HOOK_SESSION, key);
  if (secret === null || entry === null) throw new Error('no live registration');
  const file = signConsentFile(secret, {
    key, sessionId: HOOK_SESSION, decision: 'allow', reasonId: 'allow-always', inputSha256: entry.inputSha256,
    cardSha256: entry.cardSha256, at: Date.now(), permissionsSha256: canonicalSha256(updates),
  });
  mkdirSync(join(s.dir, CONSENT_DIRNAME, HOOK_SESSION), { recursive: true });
  writeFileSync(join(s.dir, CONSENT_DIRNAME, HOOK_SESSION, `${key}.json`), `${JSON.stringify(file)}\n`);
}

describe('hook: "always" = `allow` with `updatedPermissions` from its own stdin', () => {
  it.each(['read', 'webfetch', 'bash-dlugi', 'edit', 'write', 'bash-cd'])('%s: the phone chooses "always", stdout'
    + ' carries `allow` with the stdin suggestions, the receipt is confirmed', async (name) => {
    const s = await hookScene({ always: true });
    const stdin = measured(name);
    const run = hookOf(s, stdin);
    const dump = await cardUp(s);
    expect(s.cycle.card(HOOK_SESSION, dump.key)).toHaveProperty('always');
    expect(await s.cycle.decide(HOOK_SESSION, dump.key, 'allow-always')).toEqual({ ok: true, state: 'sent' });
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: stdin.permission_suggestions },
      },
    });
    expect(hookExit(s.dir)).toMatchObject({ powod: 'odbior' });
    const record = s.cycle.record(HOOK_SESSION, dump.key);
    expect(record).toMatchObject({ state: 'claimed', reasonId: 'allow-always', receipt: { decisionAt: record?.decisionAt } });
  }, TIMEOUT);

  it('a signed file with updates other than the hook\'s own stdin: set aside, no `allow`, the dialog stays', async () => {
    const s = await hookScene({ always: true });
    const run = hookOf(s, measured('webfetch'));
    const dump = await cardUp(s);
    forgeAlways(s, dump.key, measured('read').permission_suggestions);
    await until(() => readHookLog(s.dir).find((line) => line.ev === 'odrzucony'), 'the file set aside');
    expect(readHookLog(s.dir).find((line) => line.ev === 'odrzucony')).toMatchObject({
      powod: 'karta-inna', szczegol: 'permissions',
    });
    expect(await s.cycle.release(HOOK_SESSION, dump.key)).toMatchObject({ ok: true });
    expect(await run.done).toEqual({ code: 0, stdout: '', stderr: '' });
  }, TIMEOUT);

  it('the hook\'s own list outside the closed list: even a file over its digest is set aside', async () => {
    const s = await hookScene({ always: true });
    const outside = [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }];
    const run = hookOf(s, measured('edit'), outside);
    const dump = await cardUp(s);
    expect(s.cycle.card(HOOK_SESSION, dump.key)).not.toHaveProperty('always');
    forgeAlways(s, dump.key, outside);
    await until(() => readHookLog(s.dir).find((line) => line.ev === 'odrzucony'), 'the file set aside');
    expect(readHookLog(s.dir).find((line) => line.ev === 'odrzucony')).toMatchObject({ szczegol: 'permissions' });
    expect(await s.cycle.release(HOOK_SESSION, dump.key)).toMatchObject({ ok: true });
    expect((await run.done).stdout).toBe('');
  }, TIMEOUT);

  it('plain `allow` on a card with "always": `allow` without `updatedPermissions`', async () => {
    const s = await hookScene({ always: true });
    const run = hookOf(s, measured('bash-dlugi'));
    const dump = await cardUp(s);
    expect(await s.cycle.decide(HOOK_SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(JSON.parse((await run.done).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  }, TIMEOUT);
});
