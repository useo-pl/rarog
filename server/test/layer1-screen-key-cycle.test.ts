/**
 * The consent cycle (layer 1) and a hook that registers after the emergency approve button sent its digit: the key
 * already answered the dialog, so the request is settled at its first observation as when its dialog is gone
 * (`revoked`, `dialog-gone`), for the main thread and for a subagent at `all` alike, and its hook gets a signed
 * `release` at once. The record never waits in `pending`, so its card never has the approve button and no `allow`
 * is ever signed for it; one `screen fallback late hook` line per such request.
 *
 * Sentences this file guards:
 *
 * - the tie happens at the first observation of the key's dump, also when that observation already sees the dialog
 *   gone; a record that exists before the key is noted is never tied (the driver notes the key before it can be seen);
 * - the release that could not be written is retried at the next observation with the key's dump, and the record
 *   stays settled meanwhile, also under a later `standing` observation;
 * - the match takes the hook start and the input digest from the registration on the socket when there is one;
 * - two identical hooks that both started before the key are both tied (neither gets a card with the button);
 * - a hook that started after the key and the same request without a key get today's card.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import { CONSENT_DIRNAME, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentCycleIo } from '../src/herdr/dialogs/layer1/cycle.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentScreenKey } from '../src/herdr/dialogs/layer1/screen-key.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { writeAtomic } from '../src/herdr/dialogs/shadow/atomic.ts';
import { standingWithRead } from './helpers/dowod-z-odczytem.ts';

const SESSION = '00000000-0000-4000-9000-000000000001';
const BOOT = 'boot-screen-key';
const BASH = { command: 'npm test' };
type Mode = 'main' | 'all';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let clock = Date.parse('2026-11-09T10:00:00.000Z');
const now = (): number => clock;

/** A per-call dump whose hook started 1 s ago (key from `seed`); `agentId` = a subagent's request. */
function dumpOf(seed: string, over: Partial<HookCallDump> = {}): HookCallDump {
  const promptId = '00000000-0000-4000-9000-0000000000aa';
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return {
    key: `${promptId}-${nonce}`, sessionId: SESSION, promptId, pid: process.pid, startedAt: clock - 1_000,
    toolName: 'Bash', toolInput: BASH, cwd: '/tmp/project', at: clock - 900, inputSha256: canonicalSha256(BASH),
    permissionMode: 'default', ...over,
  };
}

/** An accepted registration of the dump's hook; `over` changes the registration body only. */
function register(reg: ConsentRegistry, dump: HookCallDump, over: Record<string, unknown> = {}): void {
  const body = {
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256,
    cardSha256: consentCardSha256({
      sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
      agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
    }),
    pid: dump.pid, startedAt: dump.startedAt, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
    ...over,
  };
  expect(reg.register(body).status).toBe(200);
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly events: ConsentCardView[];
  readonly logs: string[];
}

function harness(mode: Mode, io?: Partial<ConsentCycleIo>): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-screen-key-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope(mode);
  const events: ConsentCardView[] = [];
  const logs: string[] = [];
  const cycle = standingWithRead(createConsentCycle({
    dataDir: dir, bootId: BOOT, registry: reg, now, mode: () => mode,
    log: (line) => { logs.push(line); }, onCard: (view) => { events.push(view); },
    ...(io === undefined ? {} : { io }),
  }), now);
  return { dir, reg, cycle, events, logs };
}

/** The emergency key for `Bash` `npm test` now, in an episode that began 3 s ago. */
const keyNow = (): ConsentScreenKey => ({
  toolName: 'Bash', inputSha256: canonicalSha256(BASH), at: clock, since: clock - 3_000,
});

const answerPath = (dir: string, key: string, suffix = '.json'): string =>
  join(dir, CONSENT_DIRNAME, SESSION, `${key}${suffix}`);

/** Every answer file written for the session, parsed (`.json`, `.claimed`, `.revoked`). */
function answers(dir: string): { readonly decision: unknown; readonly key: unknown }[] {
  const at = join(dir, CONSENT_DIRNAME, SESSION);
  if (!existsSync(at)) return [];
  return readdirSync(at).filter((name) => !name.endsWith('.tmp'))
    .map((name) => JSON.parse(readFileSync(join(at, name), 'utf8')) as { decision: unknown; key: unknown });
}

const lateLine = (key: string, thread: 'main' | 'subagent'): string =>
  `consent: screen fallback late hook — session ${SESSION}, key ${key}, thread ${thread}, release dialog-gone`;

describe.each([
  ['main thread', 'main', undefined],
  ['subagent at `all`', 'all', 'agent-1'],
] as const)('%s: a hook that registers after the emergency key', (_name, mode, agentId) => {
  const thread = agentId === undefined ? 'main' : 'subagent';
  const over = agentId === undefined ? {} : { agentId };

  it.each(['unknown', 'gone', 'standing'] as const)(
    'first observation `%s` → settled `dialog-gone` at once, a signed `release`, no card with the button, one line',
    async (signal) => {
      const h = harness(mode);
      const dump = dumpOf(`late-${signal}`, over);
      register(h.reg, dump);
      h.cycle.screenKey(SESSION, keyNow());
      await h.cycle.observe(SESSION, dump.key, signal, dump);

      expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
      expect(readConsentRecords(h.dir).find((r) => r.key === dump.key))
        .toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
      expect(answers(h.dir)).toEqual([expect.objectContaining({ key: dump.key, decision: 'release' })]);
      expect(h.events.map((view) => [view.state, view.canAllow])).toEqual([['revoked', false]]);
      expect(h.logs.filter((line) => line.includes('late hook'))).toEqual([lateLine(dump.key, thread)]);
      expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false, error: 'decided' });

      // The hook takes the release and exits; later observations of its dump change nothing.
      await h.cycle.observe(SESSION, dump.key, 'standing', dump);
      expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked' });
      expect(h.events.every((view) => !view.canAllow)).toBe(true);
      expect(h.logs.filter((line) => line.includes('late hook'))).toHaveLength(1);
    },
  );

  it('the release write fails → the record stays settled under a `standing` observation, no `allow`, the next'
    + ' observation with the dump writes the release', async () => {
    let failures = 1;
    const writes: string[] = [];
    const io: Partial<ConsentCycleIo> = {
      writeFile: (dir, name, body, options) => {
        writes.push(name);
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        writeAtomic(dir, name, body, options);
      },
    };
    const h = harness(mode, io);
    const dump = dumpOf('late-write-failed', over);
    register(h.reg, dump);
    h.cycle.screenKey(SESSION, keyNow());
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect(existsSync(answerPath(h.dir, dump.key))).toBe(false);

    clock += 500;
    const view = await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect(view).toMatchObject({ state: 'revoked', canAllow: false });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false });
    expect(writes).toEqual([`${dump.key}.json`, `${dump.key}.json`]);
    expect(answers(h.dir)).toEqual([expect.objectContaining({ key: dump.key, decision: 'release' })]);
    expect(h.events.every((one) => !one.canAllow)).toBe(true);
  });

  it('two identical hooks that both started before the key → both settled and released, no card with the button',
    async () => {
      const h = harness(mode);
      const first = dumpOf('twin-1', { ...over, startedAt: clock - 1_200 });
      const second = dumpOf('twin-2', { ...over, startedAt: clock - 800 });
      register(h.reg, first);
      register(h.reg, second);
      h.cycle.screenKey(SESSION, keyNow());
      await h.cycle.observe(SESSION, second.key, 'standing', second);
      await h.cycle.observe(SESSION, first.key, 'standing', first);
      for (const dump of [first, second]) {
        expect(h.cycle.record(SESSION, dump.key), dump.key).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
      }
      expect(answers(h.dir).map((one) => one.decision)).toEqual(['release', 'release']);
      expect(h.events.every((view) => !view.canAllow)).toBe(true);
    });

  it('a hook that started after the key asks about another dialog → today\'s card with the approve button',
    async () => {
      const h = harness(mode);
      const key = keyNow();
      h.cycle.screenKey(SESSION, key);
      const dump = dumpOf('after-key', { ...over, startedAt: key.at + 1 });
      register(h.reg, dump);
      expect(await h.cycle.observe(SESSION, dump.key, 'standing', dump))
        .toMatchObject({ state: 'pending', canAllow: true });
      expect(answers(h.dir)).toEqual([]);
      expect(h.logs.some((line) => line.includes('late hook'))).toBe(false);
    });

  it('a record that exists before the key is noted is not tied', async () => {
    const h = harness(mode);
    const dump = dumpOf('before-note', over);
    register(h.reg, dump);
    expect(await h.cycle.observe(SESSION, dump.key, 'standing', dump)).toMatchObject({ state: 'pending' });
    h.cycle.screenKey(SESSION, keyNow());
    expect(await h.cycle.observe(SESSION, dump.key, 'unknown', dump)).toMatchObject({ state: 'pending' });
    expect(h.logs.some((line) => line.includes('late hook'))).toBe(false);
  });

  it('the hook start comes from the registration: a dump that claims a later start is still tied, a dump that'
    + ' claims an earlier one is not', async () => {
    const h = harness(mode);
    const key = keyNow();
    h.cycle.screenKey(SESSION, key);
    const early = dumpOf('registered-early', { ...over, startedAt: key.at - 500 });
    register(h.reg, early);
    await h.cycle.observe(SESSION, early.key, 'standing', { ...early, startedAt: key.at + 500 });
    expect(h.cycle.record(SESSION, early.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });

    const late = dumpOf('registered-late', { ...over, startedAt: key.at + 500 });
    register(h.reg, late);
    expect(await h.cycle.observe(SESSION, late.key, 'standing', { ...late, startedAt: key.at - 500 }))
      .toMatchObject({ state: 'pending' });
  });
});

describe('without an emergency key', () => {
  it('a main thread request whose first observation sees the dialog gone gets no record, as before', async () => {
    const h = harness('main');
    const dump = dumpOf('gone-no-key');
    register(h.reg, dump);
    expect(await h.cycle.observe(SESSION, dump.key, 'gone', dump)).toBeNull();
    expect(h.cycle.record(SESSION, dump.key)).toBeNull();
    expect(answers(h.dir)).toEqual([]);
  });

  it('a key of another input ties nothing: the subagent card waits in `pending` as before', async () => {
    const h = harness('all');
    h.cycle.screenKey(SESSION, { ...keyNow(), inputSha256: canonicalSha256({ command: 'npm run build' }) });
    const dump = dumpOf('other-input', { agentId: 'agent-1' });
    register(h.reg, dump);
    expect(await h.cycle.observe(SESSION, dump.key, 'unknown', dump)).toMatchObject({ state: 'pending' });
    expect(answers(h.dir)).toEqual([]);
  });
});
