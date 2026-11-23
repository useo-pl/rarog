/**
 * The layer 2 step (`server/src/drivers/herdr/layer2-step.ts`, `docs/dialog-card.md`, "Answer") on a fake port: the
 * gates of its second check (the flag, the engine, the driver alive) refuse before the send shield, the fresh read and
 * the key. In the driver these gates are fixed when the occurrence is issued, so only a fake port reaches them; the
 * other checks run through the real driver in `layer2-step-driver.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Layer2Step } from '../src/drivers/herdr/layer2-step.ts';
import type { Layer2Key, Layer2StepConfig, Layer2StepEntry } from '../src/drivers/herdr/layer2-step.ts';
import type { Layer2Occurrence } from '../src/drivers/herdr/layer2-card.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { layer2Verdict } from '../src/herdr/dialogs/layer2/verdict.ts';
import { FIXTURES } from './helpers/herdr-driver-atrapy.ts';

const MARK = '\n--- ekran ---\n';
const RAW = readFileSync(join(FIXTURES, 'kontrolny/potwierdzenie-model-haiku-2.1.319.txt'), 'utf8');
/** "Switch model?" with "1. Yes, switch to Haiku 5.5" and "2. No, go back". */
const MODEL = RAW.includes(MARK) ? RAW.slice(RAW.indexOf(MARK) + MARK.length) : RAW;

function occurrenceOf(screen: string): Layer2Occurrence {
  const verdict = layer2Verdict(readBlock(screen), 'dialog');
  if (verdict.kind !== 'choices') throw new Error('no choices');
  return {
    id: 'l2:0123456789ab', engineSession: 'engine-1', cliEpisode: 1, print: verdict.print, choices: verdict.choices,
    issuedAt: 0,
  };
}

interface Run {
  keys: Layer2Key[];
  audit: Layer2StepEntry[];
  /** Port calls past the second check: the send shield and the fresh read. */
  probes: string[];
}

/** Pane and driver state the port reports; a test flips it between the key and the verify read. */
interface Gates { live: boolean; disposed: boolean; leaveOnKey?: boolean }

function stepWith(
  config: Partial<Layer2StepConfig>, live = true, gates: Gates = { live, disposed: false },
): { step: Layer2Step; run: Run } {
  const occurrence = occurrenceOf(MODEL);
  const run: Run = { keys: [], audit: [], probes: [] };
  const step = new Layer2Step({
    enabled: true, engine: 'claude', key: 'w1:p1', verifyAfterMs: 0,
    cards: {
      occurrence: (id) => (id === occurrence.id ? occurrence : null), keySent: () => undefined, issued: () => 1,
    },
    ...config,
  }, {
    live: () => gates.live,
    disposed: () => gates.disposed,
    keyShield: () => { run.probes.push('shield'); return Promise.resolve(null); },
    keyHookWaits: () => false,
    engineSession: () => 'engine-1',
    readFresh: () => { run.probes.push('read'); return Promise.resolve(MODEL); },
    sendKey: (key) => {
      run.keys.push(key);
      if (gates.leaveOnKey === true) gates.live = false;
      return Promise.resolve(true);
    },
    audit: (entry) => { run.audit.push(entry); },
    system: () => undefined,
    reevaluate: () => undefined,
    sleep: () => Promise.resolve(),
    enqueue: (body) => body(),
    warn: () => undefined,
  });
  return { step, run };
}

describe('layer 2 step on a fake port: the second check', () => {
  it('all gates open: one key `2` (the control case)', async () => {
    const { step, run } = stepWith({});
    expect(await step.answer('l2:0123456789ab', [['No, go back']])).toEqual({ kind: 'applied' });
    expect(run.keys).toEqual([{ via: 'keys', keys: ['2'] }]);
  });

  it.each([
    ['the flag off', { enabled: false }, 'layer2-off'],
    ['an engine other than Claude Code', { engine: 'codex' }, 'engine-not-claude'],
  ] as const)('%s: refused `terminal-only`, no shield, no read, no key', async (_name, config, why) => {
    const { step, run } = stepWith(config);
    for (const tap of [() => step.answer('l2:0123456789ab', [['No, go back']]), () => step.escape('l2:0123456789ab')]) {
      const outcome = await tap();
      expect(outcome.kind).toBe('refused');
    }
    expect(run.keys).toEqual([]);
    expect(run.probes).toEqual([]);
    expect(run.audit.at(0)).toEqual(expect.objectContaining({
      method: 'refuse', reason: 'terminal-only', layer2Why: why, layer2: true,
    }));
  });

  it('the driver no longer blocked or disposed: stale, no shield, no read, no key', async () => {
    const { step, run } = stepWith({}, false);
    expect(await step.answer('l2:0123456789ab', [['No, go back']])).toEqual({ kind: 'stale' });
    expect(run.keys).toEqual([]);
    expect(run.probes).toEqual([]);
    expect(run.audit).toEqual([expect.objectContaining({ method: 'refuse', reason: 'stale-card' })]);
  });
});

describe('layer 2 step on a fake port: the verify read after the key', () => {
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('the pane left the dialog after the key (no longer blocked): the verify line is still written', async () => {
    const gates: Gates = { live: true, disposed: false, leaveOnKey: true };
    const { step, run } = stepWith({}, true, gates);
    expect(await step.answer('l2:0123456789ab', [['No, go back']])).toEqual({ kind: 'applied' });
    expect(gates.live).toBe(false);
    await settle();
    expect(run.audit.filter((entry) => entry.method === 'layer2-verify')).toHaveLength(1);
  });

  it('the driver disposed before the verify read: no verify line', async () => {
    const gates: Gates = { live: true, disposed: false };
    const { step, run } = stepWith({}, true, gates);
    expect(await step.answer('l2:0123456789ab', [['No, go back']])).toEqual({ kind: 'applied' });
    gates.disposed = true;
    gates.live = false;
    await settle();
    expect(run.audit.filter((entry) => entry.method === 'layer2-verify')).toEqual([]);
  });
});
