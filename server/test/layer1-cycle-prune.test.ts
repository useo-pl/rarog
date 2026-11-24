/**
 * The consent cycle forgets a session the manager forgot (`ConsentCycle.forgetSession`): its records and the keys the
 * transcript passed leave memory, except a record that still waits for its settlement (a turn the transcript review
 * still reads), and so do the store cards of the dropped records. The two per-session clocks (the reattach boundary
 * and the newest registry read without `waiting`) go only when no record of the session stays, because a kept record
 * still loses its proof by them. Another session keeps everything.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';

const SESSION = '00000000-0000-4000-9000-00000000f0a1';
const OTHER = '00000000-0000-4000-9000-00000000f0a2';
const PROMPT_ENDED = '00000000-0000-4000-9000-0000000000e1';
const PROMPT_OPEN = '00000000-0000-4000-9000-0000000000e2';

const clock = Date.parse('2026-11-20T10:00:00.000Z');
const now = (): number => clock;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dump(seed: string, sessionId: string, promptId: string): HookCallDump {
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const toolInput = { command: `echo ${seed}`, description: 'Prune' };
  return {
    key: `${promptId}-${nonce}`, sessionId, promptId, pid: process.pid, startedAt: clock - 1_000, toolName: 'Bash',
    toolInput, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
  };
}

function cycle(): ConsentCycle {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-prune-'));
  dirs.push(dir);
  const registry = createConsentRegistry({
    bootId: 'boot-prune', send: () => true, sessions: () => [SESSION, OTHER], log: () => {}, now,
  });
  registry.setScope('main');
  return createConsentCycle({ dataDir: dir, bootId: 'boot-prune', registry, now });
}

/** A session with one settled record (its turn ended), one waiting record and an entry in every pruned map. */
async function fill(c: ConsentCycle, sessionId: string): Promise<{ settled: string; waiting: string }> {
  const settled = dump(`settled-${sessionId}`, sessionId, PROMPT_ENDED);
  const waiting = dump(`waiting-${sessionId}`, sessionId, PROMPT_OPEN);
  await c.observe(sessionId, settled.key, 'unknown', settled);
  await c.observe(sessionId, waiting.key, 'unknown', waiting);
  c.notePassed(sessionId, [settled.key, waiting.key, `${PROMPT_ENDED}-no-record`]);
  await c.applyTurn(sessionId, PROMPT_ENDED, {
    promptId: PROMPT_ENDED, ended: true, partial: false, toolUses: [], results: [],
  });
  await c.markReattached(sessionId);
  await c.noteRegistryNotWaiting(sessionId, clock);
  expect(c.record(sessionId, settled.key)).toMatchObject({ state: 'revoked', cause: 'turn-ended' });
  expect(c.record(sessionId, waiting.key)?.state).toBe('pending');
  expect(c.diagnosticSession(sessionId)).toEqual({
    passed: [settled.key, waiting.key, `${PROMPT_ENDED}-no-record`], reattachAt: true, registryNotWaitingAt: true,
  });
  return { settled: settled.key, waiting: waiting.key };
}

describe('consent cycle forgets a session the manager forgot', () => {
  it('records and passed keys go, except a record that waits for its settlement, which keeps the clocks', async () => {
    const c = cycle();
    const { settled, waiting } = await fill(c, SESSION);
    expect(c.evidenceTargets().flatMap((t) => t.keys)).toEqual([waiting]);
    expect(c.cards(SESSION).map((card) => card.permId)).toEqual([settled, waiting]);

    await c.forgetSession(SESSION);

    expect(c.diagnosticMemory(SESSION).records).toEqual([waiting]);
    expect(c.record(SESSION, settled)).toBeNull();
    expect(c.record(SESSION, waiting)?.state).toBe('pending');
    expect(c.diagnosticSession(SESSION)).toEqual({ passed: [waiting], reattachAt: true, registryNotWaitingAt: true });
    expect(c.cards(SESSION).map((card) => card.permId)).toEqual([waiting]);
  });

  it('the session clocks go when no record of the session stays', async () => {
    const c = cycle();
    const settled = dump('settled-only', SESSION, PROMPT_ENDED);
    await c.observe(SESSION, settled.key, 'unknown', settled);
    await c.applyTurn(SESSION, PROMPT_ENDED, {
      promptId: PROMPT_ENDED, ended: true, partial: false, toolUses: [], results: [],
    });
    await c.markReattached(SESSION);
    await c.noteRegistryNotWaiting(SESSION, clock);

    await c.forgetSession(SESSION);

    expect(c.diagnosticMemory(SESSION).records).toEqual([]);
    expect(c.diagnosticSession(SESSION)).toEqual({ passed: [], reattachAt: false, registryNotWaitingAt: false });
  });

  it('a live session keeps all its entries when another session is forgotten', async () => {
    const c = cycle();
    await fill(c, SESSION);
    const live = await fill(c, OTHER);
    const before = { memory: c.diagnosticMemory(OTHER), session: c.diagnosticSession(OTHER) };

    await c.forgetSession(SESSION);

    expect(c.diagnosticMemory(OTHER)).toEqual(before.memory);
    expect(c.diagnosticSession(OTHER)).toEqual(before.session);
    expect([...c.diagnosticMemory(OTHER).records].sort()).toEqual([live.settled, live.waiting].sort());
  });
});
