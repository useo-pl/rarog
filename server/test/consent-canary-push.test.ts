/**
 * Consent canary push (`server/src/notify/consent-canary-push.ts`): one push with the release and its main-thread
 * result when the canary file (`<dataDir>/consent-canary.json`, written by the canary command on the owner's Mac)
 * gets a new entry or a changed `main`, and never twice for the same result, also after a restart (the pushed
 * results live in `<dataDir>/consent-canary-pushed.json`). The file is read through the real reader of the proof
 * rule's version gate (`layer1/version-gate.ts`), so its mode and shape rules hold here too. The send is a fake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConsentProofRule } from '../src/herdr/dialogs/layer1/contract.ts';
import { CONSENT_CHANNEL_MEASURED_CLI } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_CANARY_FILENAME, createConsentCanaryFile,
} from '../src/herdr/dialogs/layer1/version-gate.ts';
import type { ConsentCanaryResult } from '../src/herdr/dialogs/layer1/version-gate.ts';
import { buildConsentCanaryContent } from '../src/notify/content.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import {
  CONSENT_CANARY_PUSHED_FILENAME, createConsentCanaryPush,
} from '../src/notify/consent-canary-push.ts';

let dataDir = '';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-canary-push-'));
});

afterEach(async () => {
  await chmod(dataDir, 0o700).catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
});

type Entries = Record<string, { main: ConsentCanaryResult; subagents?: ConsentCanaryResult; at?: string }>;

/** Writes the canary file as the canary command does: format 1, mode 0600. */
async function writeCanary(entries: Entries, mode = 0o600): Promise<void> {
  const versions = Object.fromEntries(Object.entries(entries).map(([release, entry]) => [release, {
    at: entry.at ?? '2026-11-15T08:00:00Z', main: entry.main, subagents: entry.subagents ?? 'unmeasured', cases: 11,
  }]));
  const file = join(dataDir, CONSENT_CANARY_FILENAME);
  await writeFile(file, `${JSON.stringify({ format: 1, versions })}\n`, { mode });
  await chmod(file, mode);
}

interface Rig {
  readonly sent: PushContent[];
  readonly lines: string[];
  /** One full CLI read: `check` and wait for its chain. */
  check(): Promise<void>;
}

type Send = (content: PushContent) => Promise<SendOutcome>;

/**
 * One server process: its own reader of the canary file and its own push module over the shared data dir. `reply`
 * is the send outcome or the whole send; `consentProof` the configured proof rule (`RAROG_CONSENT_PROOF`).
 */
function server(reply: SendOutcome | Send = 'delivered', consentProof: ConsentProofRule = 'channel'): Rig & {
  /** `check` without waiting for its chain. */
  start(): void;
  idle(): Promise<void>;
} {
  const sent: PushContent[] = [];
  const lines: string[] = [];
  const canary = createConsentCanaryFile(dataDir);
  const push = createConsentCanaryPush({
    dataDir,
    readCanary: () => canary.read(),
    consentProof,
    send: (content) => {
      sent.push(content);
      return typeof reply === 'function' ? reply(content) : Promise.resolve(reply);
    },
    log: (line) => { lines.push(line); },
  });
  return {
    sent, lines,
    check: async () => {
      push.check();
      await push.idle();
    },
    start: () => { push.check(); },
    idle: () => push.idle(),
  };
}

/** The release the package measured, and the next one above it (not covered by the package). */
const PACKAGE = CONSENT_CHANNEL_MEASURED_CLI.cli;
const ABOVE = PACKAGE.replace(/\d+$/u, (patch) => String(Number(patch) + 1));

const pushedFile = (): string => join(dataDir, CONSENT_CANARY_PUSHED_FILENAME);

describe('consent canary push: the release and its result, once', () => {
  it('a new `pass` entry gives one push "passed" with the release only', async () => {
    const s = server();
    await s.check();
    await writeCanary({ '2.1.326': { main: 'pass' } });
    await s.check();
    await s.check();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({
      kind: 'version-changed',
      title: '🐤 Consent canary', titleRef: { code: 'push.canary-title' },
      body: 'Claude Code 2.1.326: passed.', bodyRef: { code: 'push.canary-body.pass', args: ['2.1.326'] },
      urgency: 'high', ttl: 24 * 60 * 60,
    });
    expect(s.lines).toEqual(['consent-canary: Claude Code 2.1.326 main=pass (push: delivered)']);
  });

  // The body says which rule the version gate gives the main thread of that release after the push
  // (`consentProofRuleOf`), not that nothing changed: `fail` takes `channel` away also from a release that passed
  // before or that the package measured, and `unmeasured` keeps `channel` only on a release the package covers.
  it.each([
    { release: ABOVE, main: 'fail', proof: 'channel', code: 'push.canary-body.fail' },
    { release: PACKAGE, main: 'fail', proof: 'channel', code: 'push.canary-body.fail' },
    { release: ABOVE, main: 'unmeasured', proof: 'channel', code: 'push.canary-body.unmeasured' },
    { release: PACKAGE, main: 'unmeasured', proof: 'channel', code: 'push.canary-body.unmeasured-package' },
    { release: PACKAGE, main: 'unmeasured', proof: 'screen', code: 'push.canary-body.unmeasured' },
    { release: PACKAGE, main: 'pass', proof: 'screen', code: 'push.canary-body.pass' },
  ] as const)('$main on $release with the rule $proof configured gives $code', async ({ release, main, proof, code }) => {
    const s = server('delivered', proof);
    await s.check();
    await writeCanary({ [release]: { main } });
    await s.check();
    expect(s.sent.map((c) => c.bodyRef)).toEqual([{ code, args: [release] }]);
  });

  it('a `fail` after a pushed `pass` of the same release gives one push with the `fail` body', async () => {
    const s = server();
    await s.check();
    await writeCanary({ [ABOVE]: { main: 'pass' } });
    await s.check();
    await writeCanary({ [ABOVE]: { main: 'fail', at: '2026-11-15T09:00:00Z' } });
    await s.check();
    expect(s.sent.map((c) => c.bodyRef?.code)).toEqual(['push.canary-body.pass', 'push.canary-body.fail']);
  });

  it('a server restart does not repeat the push; an entry written while it was down is pushed once', async () => {
    const first = server();
    await first.check();
    await writeCanary({ '2.1.326': { main: 'pass' } });
    await first.check();
    expect(first.sent).toHaveLength(1);

    const second = server();
    await second.check();
    expect(second.sent).toEqual([]);

    await writeCanary({ '2.1.326': { main: 'pass' }, '2.1.327': { main: 'fail' } });
    const third = server();
    await third.check();
    await third.check();
    expect(third.sent.map((c) => c.bodyRef)).toEqual([{ code: 'push.canary-body.fail', args: ['2.1.327'] }]);
  });

  it('the same result from a new run sends nothing; a changed `main` sends again', async () => {
    const s = server();
    await s.check();
    await writeCanary({ '2.1.326': { main: 'unmeasured' } });
    await s.check();
    await writeCanary({ '2.1.326': { main: 'unmeasured', at: '2026-11-15T09:00:00Z', subagents: 'pass' } });
    await s.check();
    await writeCanary({ '2.1.326': { main: 'pass', at: '2026-11-15T10:00:00Z' } });
    await s.check();
    expect(s.sent.map((c) => c.bodyRef?.code)).toEqual(['push.canary-body.unmeasured', 'push.canary-body.pass']);
  });

  it('the first start takes the entries already in the file as pushed, without a push', async () => {
    await writeCanary({ '2.1.325': { main: 'pass' } });
    const s = server();
    await s.check();
    expect(s.sent).toEqual([]);
    expect(s.lines).toEqual([]);
    expect(JSON.parse(await readFile(pushedFile(), 'utf8'))).toEqual({ format: 1, pushed: { '2.1.325': 'pass' } });
    expect((await stat(pushedFile())).mode & 0o777).toBe(0o600);
  });

  it('a canary file the gate ignores changes nothing until it is readable again', async () => {
    const s = server();
    await s.check();
    await writeCanary({ '2.1.326': { main: 'pass' } }, 0o644);
    await s.check();
    expect(s.sent).toEqual([]);
    await chmod(join(dataDir, CONSENT_CANARY_FILENAME), 0o600);
    await s.check();
    expect(s.sent.map((c) => c.bodyRef?.code)).toEqual(['push.canary-body.pass']);
  });

  it('an entry removed by hand and measured again is pushed again', async () => {
    const s = server();
    await s.check();
    await writeCanary({ '2.1.326': { main: 'fail' } });
    await s.check();
    await writeCanary({});
    await s.check();
    await writeCanary({ '2.1.326': { main: 'fail' } });
    await s.check();
    expect(s.sent.map((c) => c.bodyRef?.code)).toEqual(['push.canary-body.fail', 'push.canary-body.fail']);
  });

  it('a failed write sends nothing, and the next read writes and sends once', async () => {
    const s = server();
    await s.check();
    await writeCanary({ '2.1.326': { main: 'pass' } });
    await chmod(dataDir, 0o500);
    await s.check();
    expect(s.sent).toEqual([]);
    expect(s.lines).toEqual([`consent-canary: ${CONSENT_CANARY_PUSHED_FILENAME} not written (EACCES)`]);
    await chmod(dataDir, 0o700);
    await s.check();
    await s.check();
    expect(s.sent.map((c) => c.bodyRef?.code)).toEqual(['push.canary-body.pass']);
  });

  it('a pushed file of another shape starts over from the current entries, without a push', async () => {
    await writeFile(pushedFile(), '{"format": 2}\n', { mode: 0o600 });
    await writeCanary({ '2.1.326': { main: 'pass' } });
    const s = server();
    await s.check();
    expect(s.sent).toEqual([]);
    expect(s.lines).toEqual([`consent-canary: ${CONSENT_CANARY_PUSHED_FILENAME} unreadable — starting over without a push`]);
    expect(JSON.parse(await readFile(pushedFile(), 'utf8'))).toEqual({ format: 1, pushed: { '2.1.326': 'pass' } });
  });

  it('no receiver still records the result: the push is not repeated', async () => {
    const s = server('no-receiver');
    await s.check();
    await writeCanary({ '2.1.326': { main: 'pass' } });
    await s.check();
    await s.check();
    expect(s.sent).toHaveLength(1);
    expect(s.lines).toEqual(['consent-canary: Claude Code 2.1.326 main=pass (push: no-receiver)']);
  });

  it.each([
    { how: 'answers `failed`', send: (): Promise<SendOutcome> => Promise.resolve('failed') },
    { how: 'throws', send: (): Promise<SendOutcome> => Promise.reject(new Error('apns down')) },
  ])('a send that $how is not repeated, also after a restart', async ({ send }) => {
    const first = server(send);
    await first.check();
    await writeCanary({ '2.1.326': { main: 'fail' } });
    await first.check();
    await first.check();
    expect(first.sent).toHaveLength(1);
    expect(first.lines).toEqual(['consent-canary: Claude Code 2.1.326 main=fail (push: failed)']);

    const second = server();
    await second.check();
    await second.check();
    expect(second.sent).toEqual([]);
  });

  it('checks that overlap a send in flight give no second push; the next change gives one', async () => {
    let finish: () => void = () => undefined;
    let called: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => { called = resolve; });
    let held = false;
    // The first send stays in flight until `finish`; later sends answer at once.
    const s = server((): Promise<SendOutcome> => {
      if (held) return Promise.resolve('delivered');
      held = true;
      called();
      return new Promise((resolve) => { finish = () => { resolve('delivered'); }; });
    });
    await s.check();
    await writeCanary({ [ABOVE]: { main: 'unmeasured' } });
    s.start();
    await inFlight;
    s.start();
    s.start();
    finish();
    await s.idle();
    expect(s.sent.map((c) => c.bodyRef?.code)).toEqual(['push.canary-body.unmeasured']);

    await writeCanary({ [ABOVE]: { main: 'pass', at: '2026-11-15T09:00:00Z' } });
    s.start();
    s.start();
    await s.idle();
    expect(s.sent.map((c) => c.bodyRef?.code)).toEqual(['push.canary-body.unmeasured', 'push.canary-body.pass']);
  });
});

describe('consent canary push: content', () => {
  it('collapses per release, so a newer result of the same release takes the banner of the older one', () => {
    const pass = buildConsentCanaryContent('2.1.326', 'pass', 'channel');
    expect(buildConsentCanaryContent('2.1.326', 'unmeasured', 'screen').topic).toBe(pass.topic);
    expect(buildConsentCanaryContent('2.1.327', 'pass', 'channel').topic).not.toBe(pass.topic);
    expect(pass).not.toHaveProperty('badge');
    expect(pass).not.toHaveProperty('sessionId');
  });
});
