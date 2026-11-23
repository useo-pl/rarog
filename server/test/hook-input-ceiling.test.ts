/**
 * Input ceiling of the `PermissionRequest` hook: `tool_input` up to 1 MiB of serialized UTF-8 goes whole into
 * the dumps, the hook registers and waits, and the channel card shows the whole input with the approve button
 * (`CONSENT_DISPLAY_MAX` covers the hook ceiling plus the card's formatting). The full path runs hook stdin →
 * per-call dump → cycle → `permission-pending` SSE frame → contract parser and compares the input whole. Over the
 * hook ceiling the dumps carry the truncation marker with a preview of at most 64 KiB, the hook does not wait and the
 * card is `truncated` without text.
 *
 * `scripts/hooks/rarog-pending.mjs` runs as a child process against the real registry, cycle and socket
 * (`helpers/hook-kanal.ts`).
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { parseServerEvent } from '@rarog/shared';
import { HOOK_PENDING_DIRNAME, HOOK_TOOL_INPUT_MAX_BYTES } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import { CONSENT_DISPLAY_MAX } from '../src/herdr/dialogs/layer1/contract.ts';
import { consentPermissionRequest } from '../src/herdr/dialogs/layer1/frames.ts';
import { scanCallDumps } from '../src/herdr/dialogs/shadow/files.ts';
import { formatSseEvent } from '../src/sse.ts';
import {
  HOOK_PROMPT, HOOK_SESSION, hookExit, hookScene, readHookLog, removeHookDirs, startHook, stopHookRuns, until,
} from './helpers/hook-kanal.ts';

const TIMEOUT = 20_000;
/** The preview of the truncation marker (`TRUNCATED_PREVIEW_MAX_BYTES` in the hook). */
const PREVIEW_MAX = 64 * 1024;

afterEach(stopHookRuns);
afterAll(removeHookDirs);

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** A `Write` input whose compact JSON has exactly `size` bytes. */
function writeInput(project: string, size: number): { file_path: string; content: string } {
  const base = { file_path: join(project, 'big.txt'), content: '' };
  return { ...base, content: 'y'.repeat(size - bytes(base)) };
}

const sessionDump = (dir: string): unknown => JSON.parse(
  readFileSync(join(dir, HOOK_PENDING_DIRNAME, `${HOOK_SESSION}.json`), 'utf8'),
) as unknown;

/** The card as the devices get it: the `permission-pending` SSE frame read back through the contract parser. */
function overSse(view: ConsentCardView, cwd: string): Record<string, unknown> {
  const frame = formatSseEvent({
    type: 'permission-pending',
    request: consentPermissionRequest(view, { cwd, risk: 'normal' }),
  }, 7, 'boot');
  const data = /^data: (.*)$/m.exec(frame)?.[1];
  const event = parseServerEvent(data ?? '');
  if (event?.type !== 'permission-pending') throw new Error('no `permission-pending` frame');
  return event.request as unknown as Record<string, unknown>;
}

describe('hook input ceiling: 1 MiB into the dumps and whole on the card', () => {
  it('the ceilings: the card shows everything the hook carries whole', () => {
    expect(HOOK_TOOL_INPUT_MAX_BYTES).toBe(1024 * 1024);
    expect(CONSENT_DISPLAY_MAX).toBeGreaterThan(HOOK_TOOL_INPUT_MAX_BYTES);
  });

  it.each([200 * 1024, 1000 * 1024, HOOK_TOOL_INPUT_MAX_BYTES])('`Write` of %i B: the whole input in the per-call'
    + ' dump and the hook waits; the SSE card carries the whole input with the approve button, `allow` reaches the'
    + ' hook', async (size) => {
    const s = await hookScene();
    const toolInput = writeInput(s.project, size);
    const run = startHook(s.dir, s.project, { toolName: 'Write', toolInput });
    await until(() => readHookLog(s.dir).find((line) => line.ev === 'czekam'), 'the hook waiting', 10_000);
    const scan = scanCallDumps(s.dir, HOOK_SESSION);
    expect(scan.complete).toBe(true);
    const dump = scan.dumps[0];
    if (dump === undefined) throw new Error('no per-call dump');
    expect(dump.toolInput).toEqual(toolInput);

    const view = await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump);
    expect(view).toMatchObject({ unavailable: null, canAllow: true, canDeny: true });
    if (view === null) throw new Error('no card');
    const card = overSse(view, s.project);
    expect(card).toMatchObject({ channel: 'hook', canAllow: true, inputKind: 'json', state: 'pending' });
    expect(card).not.toHaveProperty('unavailable');
    expect(card).not.toHaveProperty('displayTextRef');
    // Completeness: the text on the wire is the whole input, every byte of `content` included.
    const shown = JSON.parse(String(card['displayText'])) as typeof toolInput;
    expect(shown).toEqual(toolInput);
    expect(Object.keys(shown)).toEqual(['file_path', 'content']);

    expect(await s.cycle.decide(HOOK_SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    const outcome = await run.done;
    expect(JSON.parse(outcome.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    expect(hookExit(s.dir)).toMatchObject({ powod: 'odbior' });
  }, TIMEOUT);

  it('`Write` of 200 KiB: `deny` from the phone reaches the hook', async () => {
    const s = await hookScene();
    const toolInput = writeInput(s.project, 200 * 1024);
    const run = startHook(s.dir, s.project, { toolName: 'Write', toolInput });
    await until(() => readHookLog(s.dir).find((line) => line.ev === 'czekam'), 'the hook waiting', 10_000);
    const dump = scanCallDumps(s.dir, HOOK_SESSION).dumps[0];
    if (dump === undefined) throw new Error('no per-call dump');
    expect(await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump)).toMatchObject({ canAllow: true });
    expect(await s.cycle.decide(HOOK_SESSION, dump.key, 'deny')).toEqual({ ok: true, state: 'sent' });
    const outcome = await run.done;
    expect(JSON.parse(outcome.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    expect(hookExit(s.dir)).toMatchObject({ powod: 'odbior' });
  }, TIMEOUT);

  it('`Write` near 1 MiB with a hidden character only at the very end: no approve button, `deny` still works',
    async () => {
      const s = await hookScene();
      const plain = writeInput(s.project, 1000 * 1024);
      // U+202E (right-to-left override) as the last character, far past any preview on the phone.
      const toolInput = { ...plain, content: `${plain.content.slice(0, -1)}‮` };
      const run = startHook(s.dir, s.project, { toolName: 'Write', toolInput });
      await until(() => readHookLog(s.dir).find((line) => line.ev === 'czekam'), 'the hook waiting', 10_000);
      const dump = scanCallDumps(s.dir, HOOK_SESSION).dumps[0];
      if (dump === undefined) throw new Error('no per-call dump');
      expect(await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump))
        .toMatchObject({ canAllow: false, unavailable: 'hidden-chars', canDeny: true });
      expect(await s.cycle.decide(HOOK_SESSION, dump.key, 'allow')).toMatchObject({ ok: false });
      expect(await s.cycle.decide(HOOK_SESSION, dump.key, 'deny')).toEqual({ ok: true, state: 'sent' });
      const outcome = await run.done;
      expect(JSON.parse(outcome.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    }, TIMEOUT);

  it('the ceiling is in bytes: exactly 1 MiB stays whole, one byte more is the marker', async () => {
    const s = await hookScene();
    const whole = writeInput(s.project, HOOK_TOOL_INPUT_MAX_BYTES);
    const first = startHook(s.dir, s.project, { toolName: 'Write', toolInput: whole });
    await until(() => readHookLog(s.dir).find((line) => line.ev === 'czekam'), 'the hook waiting', 10_000);
    expect((sessionDump(s.dir) as { toolInput: unknown }).toolInput).toEqual(whole);
    first.child.kill('SIGKILL');
    await first.done;

    const over = writeInput(s.project, HOOK_TOOL_INPUT_MAX_BYTES + 1);
    const outcome = await startHook(s.dir, s.project, { toolName: 'Write', toolInput: over }).done;
    expect(outcome).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((sessionDump(s.dir) as { toolInput: unknown }).toolInput)
      .toMatchObject({ rarogTruncated: true, preview: expect.any(String) as unknown });
  }, TIMEOUT);

  it('`Write` over 1 MiB: the marker with a preview of at most 64 KiB, the hook does not wait and prints nothing;'
    + ' the card from that dump is `truncated` without text', async () => {
    const s = await hookScene();
    const toolInput = writeInput(s.project, HOOK_TOOL_INPUT_MAX_BYTES + 64 * 1024);
    const outcome = await startHook(s.dir, s.project, { toolName: 'Write', toolInput }).done;
    expect(outcome).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(hookExit(s.dir)).toMatchObject({ powod: 'obciety' });
    expect(readHookLog(s.dir).some((line) => line.ev === 'czekam')).toBe(false);

    const pending = readPendingHook(s.dir, HOOK_SESSION, () => Date.now());
    const marker = pending?.toolInput as { rarogTruncated?: unknown; preview?: unknown };
    expect(marker.rarogTruncated).toBe(true);
    expect(Buffer.byteLength(String(marker.preview), 'utf8')).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(statSync(join(s.dir, HOOK_PENDING_DIRNAME, `${HOOK_SESSION}.json`)).size).toBeLessThan(2 * PREVIEW_MAX);

    // The registration came before the dump; the card from the same marker is what the server saw while it lived.
    const entry = s.registry.entries()[0];
    if (entry === undefined) throw new Error('no registration');
    const dump: HookCallDump = {
      key: entry.key, sessionId: HOOK_SESSION, promptId: HOOK_PROMPT, pid: entry.pid, startedAt: entry.startedAt,
      permissionMode: 'default', toolName: 'Write', toolInput: pending?.toolInput, cwd: s.project, at: Date.now(),
      inputSha256: entry.inputSha256,
    };
    expect(await s.cycle.observe(HOOK_SESSION, dump.key, 'standing', dump))
      .toMatchObject({ unavailable: 'truncated', canAllow: false, presentation: null });
  }, TIMEOUT);
});
