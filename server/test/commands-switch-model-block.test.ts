/**
 * "Switch model?" after `/model <alias>` from the phone, confirmed from its block (`confirmModelSwitch`,
 * `server/src/drivers/herdr/commands.ts`; `docs/dialogs.md`, "Dialog block").
 *
 * Under the session status rule (`▔▔▔ ○ low · /effort ▔`, CLI 2.1.314 to 2.1.319) the dialog parser gives the dialog
 * kind `other`, so today's recognition never confirmed it. The command path now reads the block (`readBlock`,
 * `layer2Verdict`, shape `model-confirm`), checks the model family against the alias the phone sent, and sends the
 * digit only after the send shield of class `dialog`, the hook check and an equal block print on a fresh read. Under a
 * bare rule the dialog keeps today's path. The flag `RAROG_DIALOG_LAYER2` changes nothing here: this is the command's
 * own confirmation, not a layer 2 card.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliWaitingSignal } from '../src/cli-version.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import {
  EMPTY_FIELD, FIXTURES, makeDriver, quiet, systemCodes, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const screen = (name: string): string => readFileSync(join(FIXTURES, 'kontrolny', name), 'utf8');

/** "Switch model?" under the status rule with the effort indicator, one per alias of the measurement (CLI 2.1.316). */
const UNDER_STATUS: Readonly<Record<string, string>> = {
  opus: screen('potwierdzenie-model-2.1.316.txt'),
  'opus[1m]': screen('potwierdzenie-model-opus-1m-2.1.316.txt'),
  fable: screen('potwierdzenie-model-fable-2.1.316.txt'),
  haiku: screen('potwierdzenie-model-haiku-2.1.316.txt'),
  sonnet: screen('potwierdzenie-model-sonnet-2.1.316.txt'),
};
const LABELS: Readonly<Record<string, string>> = {
  opus: 'Yes, switch to Opus 5.5',
  'opus[1m]': 'Yes, switch to Opus 5.5',
  fable: 'Yes, switch to Fable 5.1',
  haiku: 'Yes, switch to Haiku 5.5',
  sonnet: 'Yes, switch to Sonnet 5.5',
};
/** The same dialog under a bare rule, after the indicator went away (CLI 2.1.316). */
const UNDER_BARE = screen('potwierdzenie-model-opus-2.1.316.txt');

const WAITING_DIALOG: CliWaitingSignal = { kind: 'waiting', dialog: 'dialog' };

interface Pane {
  fx: Fixture;
  /** What the registry read returns. */
  registry: CliWaitingSignal;
  /** Whether a hook consent registration of the session waits. */
  hookWaits: boolean;
  registryReads: number;
}

/** A pane at rest with `screen` on the detection read and an empty prompt field on the composer read. */
async function paneWith(text: string, opts: { layer2?: boolean } = {}): Promise<Pane> {
  const pane = { registry: WAITING_DIALOG, hookWaits: false, registryReads: 0 } as unknown as Pane;
  pane.fx = await makeDriver({
    transcript: userLine('start'),
    deps: {
      modelConfirmPollMs: 5,
      dialogLayer2: opts.layer2 === true,
      consentRegistryRead: () => {
        pane.registryReads += 1;
        return Promise.resolve(pane.registry);
      },
      consentRegistrationWaits: () => pane.hookWaits,
    },
  });
  pane.fx.client.screenText = text;
  pane.fx.client.screenAnsi = EMPTY_FIELD;
  return pane;
}

const keys = (fx: Fixture): (readonly string[] | undefined)[] =>
  fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);

const modelSets = (fx: Fixture): Extract<DriverEvent, { type: 'model-set' }>[] => fx.events
  .filter((e): e is Extract<DriverEvent, { type: 'model-set' }> => e.type === 'model-set');

/** Sends `command` and waits for the outcome sentence `code`. */
async function run(pane: Pane, command: string, code: string): Promise<void> {
  pane.fx.driver.sendCommands?.([command]);
  await waitFor(() => systemCodes(pane.fx.events).includes(code), code);
  await quiet();
}

describe('"Switch model?" under the status rule: the digit after the proof', () => {
  it.each([false, true])('`/model opus`, "Yes, switch to Opus 5.5" under 1 → digit `1`, `model_change` (layer 2 '
    + 'flag %s)', async (layer2) => {
    const pane = await paneWith(UNDER_STATUS['opus'] ?? '', { layer2 });
    const { fx } = pane;
    await run(pane, '/model opus', 'model.change-confirmed');

    expect(fx.client.calls.filter((c) => c.method === 'prompt').map((c) => c.text)).toEqual(['/model opus']);
    expect(keys(fx)).toEqual([['1']]);
    expect(fx.audit.map((e) => e.method)).toEqual(['model_change', 'model_change']);
    expect(fx.audit[1]).toMatchObject({
      keys: ['1'], toolName: 'dialog:model', optionLabel: 'Yes, switch to Opus 5.5',
    });
    expect(pane.registryReads).toBe(1);
    expect(modelSets(fx)).toEqual([{ type: 'model-set', model: 'opus' }]);
    expect(systemCodes(fx.events)).not.toContain('model.change-foreign-dialog');
  });

  it.each(Object.keys(UNDER_STATUS).filter((alias) => alias !== 'opus'))(
    'alias `%s` from the measurement: its label under 1 gets the digit',
    async (alias) => {
      const pane = await paneWith(UNDER_STATUS[alias] ?? '');
      await run(pane, `/model ${alias}`, 'model.change-confirmed');
      expect(keys(pane.fx)).toEqual([['1']]);
      expect(pane.fx.audit[1]).toMatchObject({ keys: ['1'], optionLabel: LABELS[alias] });
    },
  );

  it('a consent question quoted in the previous answer does not hide the block: digit `1`', async () => {
    // The scrollback marker gives the old parser kind `tool`, so the screen is not shapeless.
    const quoted = (UNDER_STATUS['opus'] ?? '').replace('⏺ gotowe', '⏺ The terminal asks: Do you want to proceed?');
    expect(quoted).not.toBe(UNDER_STATUS['opus']);
    const pane = await paneWith(quoted);
    await run(pane, '/model opus', 'model.change-confirmed');
    expect(keys(pane.fx)).toEqual([['1']]);
    expect(pane.fx.audit[1]).toMatchObject({ keys: ['1'], optionLabel: 'Yes, switch to Opus 5.5' });
  });

  it('under a bare rule the dialog keeps today\'s path: digit `1` as the known dialog `model`', async () => {
    const pane = await paneWith(UNDER_BARE);
    await run(pane, '/model opus', 'model.change-confirmed');
    expect(keys(pane.fx)).toEqual([['1']]);
    expect(pane.fx.audit[1]).toMatchObject({
      keys: ['1'], toolName: 'dialog:model', optionLabel: 'Yes, switch to Opus 5.5',
    });
    expect(modelSets(pane.fx)).toEqual([{ type: 'model-set', model: 'opus' }]);
  });
});

describe('"Switch model?" under the status rule: no digit without the proof', () => {
  it.each<[string, Partial<Pick<Pane, 'registry' | 'hookWaits'>>]>([
    ['the registry says `permission`', { registry: { kind: 'waiting', dialog: 'permission' } }],
    ['the registry is not `waiting`', { registry: { kind: 'active' } }],
    ['a hook consent request waits', { hookWaits: true }],
  ])('%s → 0 keys, the foreign dialog sentence, no optimistic model', async (_name, state) => {
    const pane = await paneWith(UNDER_STATUS['opus'] ?? '');
    Object.assign(pane, state);
    await run(pane, '/model opus', 'model.change-foreign-dialog');
    expect(keys(pane.fx)).toEqual([]);
    expect(pane.fx.audit.map((e) => e.method)).toEqual(['model_change']);
    expect(modelSets(pane.fx)).toEqual([]);
  });

  it('a hook registration that comes during the fresh read stops the digit', async () => {
    const pane = await paneWith(UNDER_STATUS['opus'] ?? '');
    const { client } = pane.fx;
    const read = client.readScreen.bind(client);
    let detection = 0;
    client.readScreen = (paneId, source, format) => {
      if (source === 'detection' && ++detection === 3) pane.hookWaits = true;
      return read(paneId, source, format);
    };
    await run(pane, '/model opus', 'model.change-foreign-dialog');
    expect(keys(pane.fx)).toEqual([]);
  });

  it('`/clear` during the fresh read (another engine session) stops the digit', async () => {
    const pane = await paneWith(UNDER_STATUS['opus'] ?? '');
    const { client } = pane.fx;
    const read = client.readScreen.bind(client);
    let detection = 0;
    client.readScreen = (paneId, source, format) => {
      if (source === 'detection' && ++detection === 3) {
        pane.fx.emit({ type: 'session-changed', agentSessionId: 'f0f0f0f0-0000-4000-8000-000000000001' });
      }
      return read(paneId, source, format);
    };
    await run(pane, '/model opus', 'model.change-foreign-dialog');
    expect(keys(pane.fx)).toEqual([]);
  });

  it('a label with another model than the alias asks for → 0 keys, and the layer 2 card stands', async () => {
    const pane = await paneWith(UNDER_STATUS['haiku'] ?? '', { layer2: true });
    const { fx } = pane;
    await run(pane, '/model opus', 'model.change-foreign-dialog');
    expect(keys(fx)).toEqual([]);
    expect(modelSets(fx)).toEqual([]);

    // The registry tick of the manager: the dialog is `waiting` with class `dialog`, herdr still `idle`.
    fx.driver.noteCliWaiting?.(WAITING_DIALOG);
    const layer2Card = (): DriverEvent | undefined => fx.events
      .find((e) => e.type === 'question-request' && e.reqId.startsWith('l2:'));
    const deadline = Date.now() + 8000;
    while (layer2Card() === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const card = layer2Card();
    expect(card?.type === 'question-request' ? card.questions[0]?.options.map((o) => o.label) : null)
      .toEqual(['Yes, switch to Haiku 5.5', 'No, go back']);
    expect(keys(fx)).toEqual([]);
  }, 15_000);

  it.each(['opusplan', 'default', 'claude-opus-5-5'])('alias `%s` outside the table → no automatic confirmation',
    async (alias) => {
      const pane = await paneWith(UNDER_STATUS['opus'] ?? '');
      await run(pane, `/model ${alias}`, 'model.change-foreign-dialog');
      expect(keys(pane.fx)).toEqual([]);
    });

  it.each<[string, string, string]>([
    // The same shape, digit and label, but the content wrapped at another word: only the print tells them apart.
    ['another block print', 'model. Switching to', 'model.\n   Switching to'],
    ['another model of the same family under 1', 'Opus 5.5', 'Opus 5.6'],
    ['no "Switch model?" any more', 'Switch model?', 'Switch effort?'],
  ])('the fresh read shows %s → 0 keys', async (_name, from, to) => {
    const pane = await paneWith(UNDER_STATUS['opus'] ?? '');
    const { client } = pane.fx;
    const read = client.readScreen.bind(client);
    let detection = 0;
    client.readScreen = (paneId, source, format) => {
      // Reads: the consent gate, the poll, then the fresh read before the digit.
      if (source === 'detection' && ++detection === 3) client.screenText = client.screenText.replaceAll(from, to);
      return read(paneId, source, format);
    };
    await run(pane, '/model opus', 'model.change-foreign-dialog');
    expect(detection).toBeGreaterThanOrEqual(3);
    expect(keys(pane.fx)).toEqual([]);
  });

  it('`/effort high` with "Switch model?" under the status rule → foreign, 0 keys', async () => {
    const pane = await paneWith(UNDER_STATUS['opus'] ?? '');
    await run(pane, '/effort high', 'model.change-foreign-dialog');
    expect(keys(pane.fx)).toEqual([]);
    expect(modelSets(pane.fx)).toEqual([]);
  });
});
