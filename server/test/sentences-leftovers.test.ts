/**
 * Leftovers: three paths on which Rarog's own sentence could get lost or travel as plain text.
 *
 * - Nieudane przerwanie tury (`commands.interrupt-failed.mac`/`.vps`): powód z wyjątku przez `reasonOfError`, jak
 *   w pozostałych ramach. Zdanie bez argumentów → wariant `.code` z podkodem; z argumentami i obcy → tekst.
 * - Brak modułu załączników w driverze: zdanie z rejestru (`uploads.module-missing`) w `UploadError`, więc do apki
 *   dochodzi podkod ramy `commands.send-refused`, a prompt nie idzie do panelu.
 * - Odmowa mutacji w backendzie terminala (`assertMayMutate`): wyjątek niesie zdanie (`TermBackendRetryError`), więc
 *   rejestr terminali wysyła ramkę `err` z `msgRef`, zamiast liczyć odmowę jako pad.
 *
 * Driver jedzie na atrapie klienta herdr jak w `sentences-nested.test.ts`, terminal na prawdziwym rejestrze
 * i prawdziwym backendzie panelowym z atrapą gniazda (`fake-term-herdr.ts`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSystem } from '@rarog/shared/rest';
import { SENTENCES, isServerSentence, say } from '@rarog/shared/sentences';
import type { AnyText, SentenceRef } from '@rarog/shared/sentences';
import { loadConfig } from '../src/config.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent, InternalBlock, SessionDriver } from '../src/drivers/types.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { HerdrError } from '../src/herdr/types.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrLaunchClient, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import type { PulseSample, SessionPulse } from '../src/herdr/session-pulse.ts';
import { projectSlug } from '../src/cli-store.ts';
import type { Logger } from '../src/router.ts';
import type { TermBackend, TermEventFrame } from '../src/term/backend.ts';
import { createHerdrBackend } from '../src/term/herdr-backend.ts';
import { TermRegistry } from '../src/term/registry.ts';
import type { TermClient } from '../src/term/registry.ts';
import { FakeController, FakeHerdr } from './fake-term-herdr.ts';

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
  base = await mkdtemp(join(tmpdir(), 'rarog-sentences-leftovers-'));
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
  keysError: unknown = null;
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
    return Promise.resolve();
  }
  sendKeys(): Promise<void> {
    const error = this.keysError;
    this.keysError = null;
    return error === null ? Promise.resolve() : Promise.reject(error as Error);
  }
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
    interruptProbeDelaysMs: [],
    ...deps,
  });
  closers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => { for await (const event of driver.events) events.push(event); })();
  return { driver, client, events };
}

describe('resztki: nieudane przerwanie tury (`commands.interrupt-failed`)', () => {
  async function interruptFails(error: unknown, system?: ServerSystem): Promise<AnyText | undefined> {
    const fx = await makeDriver(system === undefined ? {} : { system });
    fx.client.keysError = error;
    expect(await fx.driver.interrupt()).toBe(false);
    await waitFor(() => systemBlocks(fx.events).length > 0, 'komunikat o przerwaniu');
    return systemBlocks(fx.events)[0];
  }

  for (const [system, code] of [
    ['macos', 'commands.interrupt-failed.mac.code'], ['linux', 'commands.interrupt-failed.vps.code'],
  ] as const) {
    it(`zdanie własne bez argumentów → \`${code}\` z podkodem (system ${system})`, async () => {
      const block = await interruptFails(new HerdrError(say('herdr.connect-timeout')), system);
      expectSentence(block, { code, args: ['herdr.connect-timeout'] },
        en(code).replace('{reason}', en('herdr.connect-timeout')));
      // Kropka podzdania kończy całe zdanie: bez „..” w środku.
      expect(block?.text).not.toContain('..');
    });
  }

  it('zdanie własne z argumentami → `commands.interrupt-failed.mac` z tekstem bez końcowej kropki', async () => {
    const sentence = say('herdr.response-timeout', { method: 'send_keys' });
    const reason = sentence.text.replace(/[.\s]+$/u, '');
    const block = await interruptFails(new HerdrError(sentence), 'macos');
    expectSentence(block, { code: 'commands.interrupt-failed.mac', args: [reason] },
      en('commands.interrupt-failed.mac').replace('{reason}', reason));
  });

  // Obcy wyjątek (`Error`) na Macu i na VPS: `sentences-dialogs.test.ts`, `commands.interrupt-failed.*`.
});

describe('resztki: brak modułu załączników w driverze', () => {
  it('→ `commands.send-refused` z podkodem `uploads.module-missing`, prompt nie idzie do panelu', async () => {
    const fx = await makeDriver({ uploads: undefined });
    fx.driver.send('przejrzyj', undefined, [{ name: 'a.txt', dataUrl: 'data:text/plain;base64,YQ==' }]);
    await waitFor(() => systemBlocks(fx.events).length > 0, 'komunikat o braku wysyłki');
    expectSentence(systemBlocks(fx.events)[0], { code: 'commands.send-refused', args: ['uploads.module-missing'] },
      en('commands.send-refused').replace('{reason}', en('uploads.module-missing')));
    expect(fx.client.prompts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Terminal: odmowa mutacji w backendzie panelowym dochodzi do rejestru ze zdaniem
// ---------------------------------------------------------------------------

const silent: Logger = { info: () => {}, error: () => {} };
const CWD = '/Users/testowy/Projects/rarog';

class FakeTermClient implements TermClient {
  readonly events: TermEventFrame[] = [];
  sendData(): void {}
  sendEvent(frame: TermEventFrame): void { this.events.push(frame); }
  bufferedAmount(): number { return 0; }
  terminate(): void {}
}

describe('resztki: odmowa mutacji backendu terminala (`assertMayMutate`)', () => {
  it('rejestr dostaje zdanie z `ref`: ramka `err` z `msgRef` `term.needs-launch`, bez liczenia padu', async () => {
    const dataDir = join(base, 'data');
    await mkdir(dataDir, { recursive: true });
    const env = {
      RAROG_ORIGINS: 'https://rarog.example', RAROG_TERM: '1', RAROG_HERDR_BIN: '/usr/bin/true',
      RAROG_HERDR_LAUNCH: '0', RAROG_HERDR_SEND: '1', RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
      RAROG_DATA_DIR: dataDir, HOME: '/Users/testowy', PATH: '/usr/bin:/bin', TMPDIR: dataDir,
    };
    const herdr = new FakeHerdr();
    const real = createHerdrBackend({
      config: loadConfig(env), logger: silent, launchClient: (): HerdrLaunchClient => herdr,
      spawn: () => new FakeController(), setTimer: () => ({ unref: () => {} }) as unknown as NodeJS.Timeout,
    });
    closers.push(() => { real.dispose(); });
    /*
     * Bramka rejestru (`refusal()` przy `POST`) przepuszcza, a bramka mutacji backendu odmawia: to droga
     * `assertMayMutate`, którą rejestr widzi wyłącznie przez odrzucony uchwyt `ensureSession`.
     */
    const backend: TermBackend = { ...real, refusal: () => null };
    const registry = new TermRegistry({
      config: loadConfig({ ...env, RAROG_HERDR_LAUNCH: '1' }), logger: silent, backend, realPath: (p) => p,
      setTimer: () => ({ unref: () => {} }) as unknown as NodeJS.Timeout, clearTimer: () => {},
    });
    closers.push(() => { registry.dispose(); });
    const opened = registry.open(CWD);
    if (!opened.ok) throw new Error('open nieudany');
    const client = new FakeTermClient();
    expect(registry.attach(opened.id, client)).toBe('ok');
    await waitFor(() => client.events.length > 0, 'ramka err');
    const sentence = say('term.needs-launch');
    expect(client.events).toEqual([{ t: 'err', msg: sentence.text, msgRef: sentence.ref }]);
    expect(herdr.stamps).toEqual([]);
  });
});
