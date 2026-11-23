/**
 * Shared fakes of the queue take-back tests (`queue-take-back.test.ts`, `take-back-field.test.ts`): the driver fixture
 * of `herdr-driver-atrapy.ts` with a real follower over the conversation file and a fake Claude pane that answers the
 * take-back keys the way CLI 2.1.328 did (`fixtures/herdr/queue/measured/zabranie-*`): `up` on an empty field moves
 * the CLI queue into the field and writes one popAll entry per prompt, `up` on an empty queue opens a history entry,
 * `down` leaves it, `ctrl+u` deletes the last screen line of the field. A test file calls `useDriverSandbox()` itself.
 */
import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrDriverDeps } from '../../src/drivers/herdr-driver.ts';
import type { QueueTakeBackResult } from '../../src/drivers/types.ts';
import type { HerdrAgentInfo } from '../../src/herdr/types.ts';
import { FIXTURES, PANE, SESSION, makeDriver, waitFor } from './herdr-driver-atrapy.ts';
import type { Fixture } from './herdr-driver-atrapy.ts';

type Signal = Awaited<ReturnType<NonNullable<HerdrDriverDeps['consentRegistryRead']>>>;
export const ACTIVE: Signal = { kind: 'active' };
export const WAITING: Signal = { kind: 'waiting', dialog: 'permission' };

const E = '\x1b';
export const RULE = '─'.repeat(40);
/** The hint as the live `visible` + `ansi` read shows it: dimmed, so it is no field text. */
const HINT = `${E}[2mPress up to edit queued…${E}[22m`;
export const measured = (name: string): string => readFileSync(join(FIXTURES, 'queue', 'measured', name), 'utf8');
export const dimmedHint = (screen: string): string => screen.replace(/Press up to edit queued(?: messages|…)/, HINT);

export const queueLine = (operation: string, content?: string): string => `${JSON.stringify({
  type: 'queue-operation', operation, timestamp: '2026-11-19T10:00:00.000Z',
  ...(content === undefined ? {} : { content }),
})}\n`;

/** The entries of a measured jsonl before its `_pomiar` marker `marker`, without the markers, one line each. */
export function measuredBefore(name: string, marker: string): string[] {
  const lines = measured(name).split('\n').filter((line) => line.trim() !== '');
  const markerOf = (line: string): string | null => (JSON.parse(line) as { _pomiar?: string })._pomiar ?? null;
  const end = lines.findIndex((line) => markerOf(line) === marker);
  return lines.slice(0, end === -1 ? undefined : end).filter((line) => markerOf(line) === null)
    .map((line) => `${line}\n`);
}

/** A Claude pane mid-turn as the take-back sees it; `draw()` puts its screen on both reads of the fake client. */
export interface CliPane {
  /** Prompts of the CLI queue, drawn above the field with the line under them. */
  queue: string[];
  /** Field lines, one screen line each. */
  field: string[];
  /** A history entry drawn instead of the field (`up` on an empty CLI queue). */
  history: string | null;
  /** The text `up` opens on an empty CLI queue; `null` = `up` changes nothing there. */
  historyEntry: string | null;
  /** A dialog or form screen on top. */
  dialog: string | null;
  /** A measured screen shown until the next key. */
  override: string | null;
  /** What `up` writes to the file when it takes the queue; default: one popAll per prompt at once. */
  upWrites: (taken: readonly string[]) => Promise<void>;
  /** Runs after each key's effect, before the repaint. */
  afterKey: (key: string) => void;
  /** Field text at each Enter of a pasted message. */
  submitted: string[];
  draw: () => void;
}

function cliPane(fx: Fixture): CliPane {
  const pane: CliPane = {
    queue: [], field: [], history: null, historyEntry: null, dialog: null, override: null,
    upWrites: (taken) => appendFile(fx.transcript, taken.map((text) => queueLine('popAll', text)).join('')),
    afterKey: () => {},
    submitted: [],
    draw: () => {
      const screen = pane.override ?? pane.dialog ?? screenOf(pane);
      fx.client.screenText = screen;
      fx.client.screenAnsi = screen;
    },
  };
  fx.client.sendTakeBackKey = async (paneId, key) => {
    fx.client.calls.push({ method: 'take_back_key', paneId, keys: [key] });
    pane.override = null;
    if (pane.dialog === null) {
      if (key === 'up' && pane.history === null && pane.field.join('') === '') {
        if (pane.queue.length > 0) {
          const taken = pane.queue.splice(0);
          pane.field = [...taken];
          await pane.upWrites(taken);
        } else if (pane.historyEntry !== null) {
          pane.history = pane.historyEntry;
        }
      } else if (key === 'down' && pane.history !== null) {
        pane.history = null;
      } else if (key === 'ctrl+u') {
        pane.field = pane.field.slice(0, -1);
      }
    }
    pane.afterKey(key);
    pane.draw();
  };
  fx.client.pasteText = (paneId, text) => {
    fx.client.calls.push({ method: 'paste', paneId, text });
    if (pane.dialog === null) pane.field = [pane.field.join('') + text];
    pane.draw();
    return Promise.resolve();
  };
  // Enter mid-turn: the CLI queues the field (`enqueue`, CLI 2.1.328) and empties it.
  fx.client.sendPromptSubmit = async (paneId) => {
    fx.client.calls.push({ method: 'prompt_submit', paneId, keys: ['enter'] });
    if (pane.dialog === null) {
      const text = pane.field.join('\n');
      pane.submitted.push(text);
      pane.field = [];
      pane.queue.push(text);
      await appendFile(fx.transcript, queueLine('enqueue', text));
    }
    pane.draw();
  };
  fx.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.resolve({
    paneId: PANE, agentSessionId: SESSION, engine: 'claude', status: 'working',
  } as HerdrAgentInfo);
  pane.draw();
  return pane;
}

function screenOf(pane: CliPane): string {
  const rows = ['⏺ Running the measurement…', ''];
  for (const text of pane.queue) rows.push(`❯ ${text}`);
  if (pane.queue.length > 0) rows.push('  ctrl+enter to send now');
  rows.push('', '✽ Crunching… (15s)', '');
  if (pane.history !== null) {
    rows.push(`─── History 100/100 ${'─'.repeat(20)}`, `❯ ${pane.history}`, RULE);
  } else {
    const [first = '', ...rest] = pane.field;
    const shown = first === '' && rest.length === 0 && pane.queue.length > 0 ? HINT : first;
    rows.push(RULE, `❯ ${shown}`, ...rest.map((line) => `  ${line}`), RULE);
  }
  return rows.join('\n');
}

export interface Setup {
  fx: Fixture;
  pane: CliPane;
  registry: { now: Signal };
  logs: string[];
}

/** A Claude pane mid-turn whose file holds `transcript` (imported) and whose CLI queue shows `queue`. */
export async function setup(opts: {
  transcript: string; queue?: readonly string[]; deps?: Partial<HerdrDriverDeps>;
}): Promise<Setup> {
  const registry = { now: ACTIVE };
  const logs: string[] = [];
  const fx = await makeDriver({
    transcript: opts.transcript,
    agent: { status: 'working' },
    deps: {
      promptFieldPollMs: 2, promptRetryMs: 10, promptSubmitSettleMs: 20, takeBackPopWaitMs: 150,
      consentRegistryRead: () => Promise.resolve(registry.now), logger: (line) => logs.push(line),
      ...opts.deps,
    },
  });
  await waitFor(() => fx.events.some((event) => event.type === 'history'), 'history import');
  const pane = cliPane(fx);
  pane.queue = [...(opts.queue ?? [])];
  pane.draw();
  return { fx, pane, registry, logs };
}

export const keys = (fx: Fixture): (string | undefined)[] => fx.client.calls
  .filter((call) => call.method === 'take_back_key').map((call) => call.keys?.[0]);
export const keyAudit = (fx: Fixture): unknown[] => fx.audit
  .filter((entry) => entry.method === 'send_keys').map((entry) => entry.keys);
export const takeBack = (fx: Fixture): Promise<QueueTakeBackResult | undefined> => fx.driver.takeBackQueue?.()
  ?? Promise.resolve(undefined);

/** The measured two-prompt take-back: the file up to `up` and the CLI queue on screen. */
export const ZABRANIE = 'zabranie-2.1.328.jsonl';
export const TWO = ['pomiar B: ok', 'pomiar C: ok'];
/** The measured file up to `up`: the turn runs, B and C wait in the CLI queue. */
export const BEFORE_UP = measuredBefore(ZABRANIE, 'up').join('');
