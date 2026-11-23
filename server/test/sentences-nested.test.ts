/**
 * Zagnieżdżone zdania własne: gdy wyjątek niesie zdanie własne Raroga (`say()`), a serwer wstawia go jako
 * powód do innego zdania, apka dostaje kod tego zdania, nie sam angielski tekst w argumencie `text`.
 *
 * Reguła (jedno miejsce: `reasonOfError` w `herdr/types.ts`):
 * - zdanie własne BEZ argumentów → zdanie zewnętrzne z argumentem rodzaju `code` (podkod tłumaczy apka);
 * - zdanie własne Z argumentami i błąd obcy (Node, herdr, wartość) → zdanie zewnętrzne z argumentem `text`: rama
 *   mówi, co się nie udało (wysyłka, start, restart), środek zostaje po angielsku.
 *
 * Drogi drivera jadą przez prawdziwy driver na atrapie klienta herdr; szczegóły stanu managera przez funkcje,
 * które manager wstawia do `stateDetail`, i serializację `wireStateDetail` (ta sama, która pisze `stateDetailRef`).
 * Droga przez managera do `stateDetailRef` karty: `manager-herdr.test.ts`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SENTENCES, isServerSentence, say } from '@rarog/shared/sentences';
import type { AnyText, SentenceRef } from '@rarog/shared/sentences';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent, InternalBlock, SessionDriver } from '../src/drivers/types.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { HerdrCommandRefusedError, HerdrPromptRejectedError } from '../src/herdr/commands/guard.ts';
import { HerdrError, HerdrGoneError, HerdrLaunchTimeoutError } from '../src/herdr/types.ts';
import { UploadError } from '../src/herdr/uploads.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import type { PulseSample, SessionPulse } from '../src/herdr/session-pulse.ts';
import { herdrLaunchFailedDetail, restartFailedDetail } from '../src/sessions/state-sentences.ts';
import { wireStateDetail } from '../src/sessions/session.ts';
import { projectSlug } from '../src/cli-store.ts';

vi.setConfig({ testTimeout: 20_000 });

/** Angielski szablon kodu z rejestru (bez `say()`, żeby test nie porównywał `say()` z samym sobą). */
const en = (code: string): string => {
  const def = (SENTENCES as Readonly<Record<string, { en: unknown }>>)[code]?.en;
  if (typeof def !== 'string') throw new Error(`${code}: brak kodu w rejestrze albo szablon z liczbą mnogą`);
  return def;
};

const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };
const PANE = 'w9-3';

let base = '';
const closers: (() => void)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-sentences-nested-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await rm(base, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/** Bloki `text` wiadomości systemowych drivera. */
const systemBlocks = (events: readonly DriverEvent[]): AnyText[] => events.flatMap((e) =>
  e.type === 'message' && e.role === 'system'
    ? e.blocks.flatMap((b: InternalBlock) => (b.type === 'text' ? [b.text] : []))
    : []);

/** Zdanie z kodem: marka `say()`, `ref` i angielski tekst. */
function expectSentence(value: AnyText | undefined, ref: SentenceRef, text: string): void {
  expect(isServerSentence(value), `${ref.code}: ma być zdaniem z say()`).toBe(true);
  if (value === undefined || !isServerSentence(value)) return;
  expect(value.ref).toEqual(ref);
  expect(value.text).toBe(text);
}

class StubClient implements HerdrClient {
  promptError: unknown = null;
  prompts = 0;
  sendFormSubmit = (): Promise<void> => Promise.resolve();
  sendModeCycle = (): Promise<void> => Promise.resolve();
  pasteText = (): Promise<void> => Promise.resolve();
  sendPromptSubmit = (): Promise<void> => Promise.resolve();
  sendTrustStep = (): Promise<void> => Promise.resolve();
  sendDialogKey = (): Promise<void> => Promise.resolve();
  sendTakeBackKey = (): Promise<void> => Promise.resolve();
  getAgent = (): Promise<HerdrAgentInfo> => Promise.reject(new Error('agent.get poza testem'));
  listAgents(): Promise<never> { return Promise.reject(new Error('agent.list poza testem')); }
  readPaneHistory(): Promise<HerdrPaneHistory> { return Promise.resolve({ text: '', truncated: false }); }
  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: '' }); }
  prompt(): Promise<void> {
    this.prompts += 1;
    const error = this.promptError;
    this.promptError = null;
    return error === null ? Promise.resolve() : Promise.reject(error as Error);
  }
  sendKeys = (): Promise<void> => Promise.resolve();
  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> { return Promise.resolve({ version: '0.8.2', protocol: 20 }); }
}

const stubPulse = (): SessionPulse => ({
  start: () => {}, stop: () => {}, repoint: () => {}, relocated: () => {}, close: () => {},
});

async function makeDriver(deps: Partial<HerdrDriverDeps> = {}): Promise<{
  driver: SessionDriver; client: StubClient; events: DriverEvent[];
}> {
  const root = join(base, 'store');
  const cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, projectSlug(cwd)), { recursive: true });
  await writeFile(join(root, projectSlug(cwd), `${SESSION}.jsonl`), '');
  const agent: HerdrAgent = {
    key: PANE, paneId: PANE, agentSessionId: SESSION, engine: 'claude', termId: null, cwd, status: 'idle',
    title: 'refaktor', stateChangeSeq: 7, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
  const handle: HerdrAgentHandle = { agent, subscribe: () => () => {} };
  const client = new StubClient();
  const driver = createHerdrDriver(handle, {
    pulse: (_o: { onPulse: (sample: PulseSample) => void }) => stubPulse(),
    client,
    audit: { log: () => {} },
    yoloRoots: [],
    now: () => Date.UTC(2026, 7, 22, 12, 0, 0),
    follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
    pendingDebounceMs: 10,
    pendingRetryMs: 4,
    escSettleMs: 5,
    ...deps,
  });
  closers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => { for await (const event of driver.events) events.push(event); })();
  return { driver, client, events };
}

/** Strażnik drivera, który odrzuca każdy tekst podanym wyjątkiem. */
const refusingGuard = (error: Error): NonNullable<HerdrDriverDeps['guard']> => () => { throw error; };

async function firstSystemBlock(deps: Partial<HerdrDriverDeps>, prompt = 'zrób X'): Promise<AnyText | undefined> {
  const fx = await makeDriver(deps);
  fx.driver.send(prompt);
  await waitFor(() => systemBlocks(fx.events).length > 0, 'komunikat systemowy');
  return systemBlocks(fx.events)[0];
}

describe('zdania: odmowa wysyłki w driverze (`commands.send-failed`)', () => {
  it('odmowa slash-komendy ze zdaniem bez argumentów → `commands.send-refused` z podkodem', async () => {
    const block = await firstSystemBlock(
      { guard: refusingGuard(new HerdrCommandRefusedError(say('commands.bare-slash'), '/')) }, '/');
    expectSentence(block, { code: 'commands.send-refused', args: ['commands.bare-slash'] },
      en('commands.send-refused').replace('{reason}', en('commands.bare-slash')));
  });

  it('odmowa slash-komendy ze zdaniem z argumentami → `commands.send-failed` z tekstem zdania', async () => {
    const refusal = say('commands.unknown', { token: '/zażółć' });
    const block = await firstSystemBlock(
      { guard: refusingGuard(new HerdrCommandRefusedError(refusal, '/zażółć')) }, '/zażółć');
    expectSentence(block, { code: 'commands.send-failed', args: [refusal.text] },
      en('commands.send-failed').replace('{reason}', refusal.text));
  });

  it('błąd zapisu załącznika (zdanie z argumentami) → rama „nie wysłano”, prompt nie idzie do panelu', async () => {
    const failure = say('uploads.write-failed', { path: 'zdjecie.png', reason: 'ENOSPC' });
    const fx = await makeDriver({ guard: refusingGuard(new UploadError(failure)) });
    fx.driver.send('zrób X');
    await waitFor(() => systemBlocks(fx.events).length > 0, 'komunikat systemowy');
    expectSentence(systemBlocks(fx.events)[0], { code: 'commands.send-failed', args: [failure.text] },
      en('commands.send-failed').replace('{reason}', failure.text));
    expect(fx.client.prompts).toBe(0);
  });

  it('odmowa strażnika bez slash-komendy (zdanie bez argumentów) → podkod', async () => {
    const block = await firstSystemBlock(
      { guard: refusingGuard(new HerdrPromptRejectedError(say('commands.empty'))) });
    expectSentence(block, { code: 'commands.send-refused', args: ['commands.empty'] },
      en('commands.send-refused').replace('{reason}', en('commands.empty')));
  });

  it('błąd obcy → `commands.send-failed` z argumentem `text` bez zmian', async () => {
    const block = await firstSystemBlock({ guard: refusingGuard(new Error('spawn ENOENT')) });
    expectSentence(block, { code: 'commands.send-failed', args: ['spawn ENOENT'] },
      en('commands.send-failed').replace('{reason}', 'spawn ENOENT'));
  });
});

describe('zdania: nieudana wysyłka do panelu (`commands.panel-send-failed`)', () => {
  async function promptFails(error: Error): Promise<AnyText | undefined> {
    const fx = await makeDriver();
    fx.client.promptError = error;
    fx.driver.send('zrób X');
    await waitFor(() => systemBlocks(fx.events).length > 0, 'komunikat o wysyłce');
    return systemBlocks(fx.events)[0];
  }

  it('błąd herdr ze zdaniem własnym bez argumentów → `commands.panel-send-failed.code` z podkodem', async () => {
    const block = await promptFails(new HerdrError(say('herdr.connect-timeout')));
    expectSentence(block, { code: 'commands.panel-send-failed.code', args: ['herdr.connect-timeout'] },
      en('commands.panel-send-failed.code').replace('{reason}', en('herdr.connect-timeout')));
  });

  it('błąd herdr ze zdaniem własnym z argumentami → `commands.panel-send-failed` z tekstem zdania', async () => {
    const sentence = say('herdr.response-timeout', { method: 'agent.prompt' });
    const block = await promptFails(new HerdrError(sentence));
    expectSentence(block, { code: 'commands.panel-send-failed', args: [sentence.text] },
      en('commands.panel-send-failed').replace('{reason}', sentence.text));
  });

  it('błąd obcy → `commands.panel-send-failed` z argumentem `text` bez zmian', async () => {
    const block = await promptFails(new Error('socket closed'));
    expectSentence(block, { code: 'commands.panel-send-failed', args: ['socket closed'] },
      en('commands.panel-send-failed').replace('{reason}', 'socket closed'));
  });
});

describe('zdania: szczegół stanu po nieudanym starcie panelu', () => {
  it('`HerdrError` ze zdaniem własnym bez argumentów → `stateDetailRef` z podkodem', () => {
    const wire = wireStateDetail(herdrLaunchFailedDetail(new HerdrLaunchTimeoutError(say('herdr.session-id-mismatch'))));
    expect(wire.stateDetailRef).toEqual({ code: 'state.herdr-launch-failed.code', args: ['herdr.session-id-mismatch'] });
    expect(wire.stateDetail).toBe(
      en('state.herdr-launch-failed.code').replace('{reason}', en('herdr.session-id-mismatch')));
  });

  it('`HerdrError` ze zdaniem własnym z argumentami → `state.herdr-launch-failed.reason` z tekstem zdania', () => {
    const sentence = say('herdr.launch-timeout', { seconds: 60 });
    const wire = wireStateDetail(herdrLaunchFailedDetail(new HerdrLaunchTimeoutError(sentence)));
    expect(wire.stateDetailRef).toEqual({ code: 'state.herdr-launch-failed.reason', args: [sentence.text] });
    expect(wire.stateDetail).toBe(en('state.herdr-launch-failed.reason').replace('{reason}', sentence.text));
  });

  it("`Error('spawn ENOENT')` → `state.herdr-launch-failed.reason` z argumentem `text` bez zmian", () => {
    const wire = wireStateDetail(herdrLaunchFailedDetail(new Error('spawn ENOENT')));
    expect(wire.stateDetailRef).toEqual({ code: 'state.herdr-launch-failed.reason', args: ['spawn ENOENT'] });
    expect(wire.stateDetail).toBe(en('state.herdr-launch-failed.reason').replace('{reason}', 'spawn ENOENT'));
  });

  it('błąd bez treści → `state.herdr-launch-failed` bez argumentów, jak dotąd', () => {
    expect(wireStateDetail(herdrLaunchFailedDetail(new Error(''))).stateDetailRef)
      .toEqual({ code: 'state.herdr-launch-failed' });
  });
});

describe('zdania: szczegół stanu po nieudanym restarcie', () => {
  it('błąd ze zdaniem własnym bez argumentów → `restart.failed.code` z podkodem', () => {
    const wire = wireStateDetail(restartFailedDetail(new HerdrGoneError(say('herdr.agent-vanished'))));
    expect(wire.stateDetailRef).toEqual({ code: 'restart.failed.code', args: ['herdr.agent-vanished'] });
    expect(wire.stateDetail).toBe(en('restart.failed.code').replace('{reason}', en('herdr.agent-vanished')));
  });

  it('błąd ze zdaniem własnym z argumentami → `restart.failed.reason` z tekstem zdania', () => {
    const sentence = say('herdr.agent-vanished.screen', { screen: 'zsh: command not found' });
    const wire = wireStateDetail(restartFailedDetail(new HerdrGoneError(sentence)));
    expect(wire.stateDetailRef).toEqual({ code: 'restart.failed.reason', args: [sentence.text] });
    expect(wire.stateDetail).toBe(en('restart.failed.reason').replace('{reason}', sentence.text));
  });

  it('błąd obcy → `restart.failed.reason` z argumentem `text` bez zmian', () => {
    const wire = wireStateDetail(restartFailedDetail(new Error('spawn ENOENT')));
    expect(wire.stateDetailRef).toEqual({ code: 'restart.failed.reason', args: ['spawn ENOENT'] });
    expect(wire.stateDetail).toBe(en('restart.failed.reason').replace('{reason}', 'spawn ENOENT'));
  });
});
