/**
 * The refusal dump of the driver facade on its way to disk (`server/src/herdr/dialogs/refusals.ts`): the longer
 * retention of a layer 2 dialog dump (`….dialog.txt`, 14 days) follows from the dump itself, never from the registry
 * class alone. The class can flip to `dialog` without a fresh screen read, so a refusal of a standing consent card
 * would pair the class `dialog` with the consent screen and the tool name of that card. Such a dump keeps 48 h.
 */
import { appendFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliWaitingSignal } from '../src/cli-version.ts';
import {
  REFUSAL_DUMP_DIALOG_SUFFIX, REFUSAL_DUMP_DIRNAME, createRefusalDumper,
} from '../src/herdr/dialogs/refusals.ts';
import {
  DIALOG_PERMISSION, FIXTURES, base, makeDriver, permissions, toolUseLine, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const WAITING_PERMISSION: CliWaitingSignal = { kind: 'waiting', dialog: 'permission' };
const WAITING_DIALOG: CliWaitingSignal = { kind: 'waiting', dialog: 'dialog' };

/** A model confirmation of the control set: a layer 2 dialog of class `dialog` (CLI 2.1.319). */
const MODEL_CONFIRM = readFileSync(join(FIXTURES, 'kontrolny', 'potwierdzenie-model-2.1.319.txt'), 'utf8');

const BASH_INPUT = {
  command: 'pnpm exec vitest run server/test/state-machine.test.ts',
  description: 'Uruchamia testy maszyny stanów po zmianie w /Users/u/Projects/atlas/.env.local',
};

describe('the registry class flips to `dialog` under a standing consent card', () => {
  it('a `stale-card` refusal of the consent card keeps 48 h: plain `.txt`, not `.dialog.txt`', async () => {
    const dataDir = join(base, 'data');
    const fx = await makeDriver({
      transcript: userLine('run the tests'),
      deps: { dumpRefusal: createRefusalDumper({ dataDir, version: 'test', enabled: true }) },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');

    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    fx.client.screenText = DIALOG_PERMISSION;
    await appendFile(fx.transcript, toolUseLine('t-1', 'Bash', BASH_INPUT));
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'consent card');

    // The pane shows a layer 2 dialog and the registry says `dialog`; the driver has not read the screen again.
    fx.client.screenText = MODEL_CONFIRM;
    fx.driver.noteCliWaiting?.(WAITING_DIALOG);
    await expect(fx.driver.respondPermission('old-card-id', 'allow'))
      .resolves.toEqual({ kind: 'refused', reason: 'stale-card' });

    const names = readdirSync(join(dataDir, REFUSAL_DUMP_DIRNAME)).filter((name) => name.endsWith('.txt'));
    const stale = names.filter((name) => name.includes('-stale-card'));
    expect(stale).toHaveLength(1);
    const body = readFileSync(join(dataDir, REFUSAL_DUMP_DIRNAME, stale[0] ?? ''), 'utf8');
    // The dump pairs the class `dialog` with the consent screen and the card's tool: the exact case to keep short.
    expect(body).toContain('cliDialog: dialog');
    expect(body).toContain('toolName: Bash');
    expect(body.slice(body.indexOf('--- ekran ---'))).toContain('Do you want to proceed?');
    expect(names.filter((name) => name.endsWith(REFUSAL_DUMP_DIALOG_SUFFIX))).toEqual([]);
  });
});
