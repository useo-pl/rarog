/**
 * Trasa agenta głosowego `POST /api/sessions/:id/companion/ask` i flaga `RAROG_COMPANION`: bramka (flaga, demo, sesja
 * Claude Code w zasięgu), pytanie o rozmowę silnika bieżącą w chwili
 * przyjęcia żądania, mapowanie wyników `claude -p` na statusy, zabicie procesu przy `/clear`, odpięciu urządzenia
 * i zamkniętym żądaniu, maska sekretów w odpowiedzi oraz pole `companionEnabled` w `GET /api/version`.
 *
 * Żaden test nie uruchamia prawdziwego CLI ani żadnego API: program to atrapa (skrypt Node w katalogu tymczasowym,
 * jak w `companion-cli.test.ts`), która dopisuje swój pid do `pids.log`, więc test sprawdza, że proces nie żyje.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { companionAskSchema, versionResponseSchema } from '@rarog/shared/rest';
import { createCompanionCli } from '../src/companion/cli.ts';
import { type CompanionFeature, assembleCompanion, createCompanionFeature } from '../src/companion/ask.ts';
import { COMPANION_ENV_PASSTHROUGH } from '../src/config-env.ts';
import { ConfigError, loadConfig, parseCompanionEnabled } from '../src/config.ts';
import { attachDeactivation } from '../src/device-effects.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const CONV_A = '22222222-2222-4222-8222-222222222222';
const CONV_B = '33333333-3333-4333-8333-333333333333';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Scenario {
  lines?: unknown[];
  hang?: boolean;
  exitCode?: number;
}

const FAKE = `
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
fs.appendFileSync(path.join(dir, 'pids.log'), String(process.pid) + '\\n');
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const fd3 = fs.readFileSync(3, 'utf8');
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ fd3, stdin }));
for (const line of scenario.lines ?? []) {
  process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\\n');
}
if (scenario.hang) setInterval(() => {}, 1000);
else process.exitCode = scenario.exitCode ?? 0;
`;

const INIT = { type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-sonnet-5-5' };
const result = (text: string, isError = false): Record<string, unknown> => ({
  type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: text,
});
const answerOf = (answer: string, found: 'yes' | 'no', prompt = ''): string =>
  `<answer>${answer}</answer><found>${found}</found><prompt>${prompt}</prompt>`;

/** Rozmowa sesji `s1` w formacie pliku rozmowy Claude Code (syntetyczna). */
const TRANSCRIPT = [
  JSON.stringify({
    type: 'user', timestamp: '2026-11-10T10:00:00.000Z', message: { role: 'user', content: 'Sprawdź, czemu test pada.' },
  }),
  JSON.stringify({
    type: 'assistant', timestamp: '2026-11-10T10:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Test pada, bo brakuje fixture\'u.' }] },
  }),
].join('\n');

interface Harness {
  base: string;
  auth: string;
  dir: string;
  manager: FakeManager;
  device: TestDevice;
  feature: CompanionFeature | undefined;
  logs: string[];
  scenario(next: Scenario): void;
  pids(): number[];
  record(): { fd3: string; stdin: string };
  close(): Promise<void>;
}

interface HarnessOptions {
  /** Wartość `RAROG_COMPANION`; brak = zmiennej nie ma. */
  flag?: string;
  demo?: boolean;
  /** Bez modułu w zależnościach routera (złożenie się nie udało). */
  noFeature?: boolean;
  timeoutMs?: number;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rarog-companion-trasa-')));
  const project = join(dir, 'projekt');
  const dataDir = join(dir, 'dane');
  const transcript = join(dir, `${CONV_A}.jsonl`);
  writeFileSync(transcript, TRANSCRIPT);
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!${process.execPath}\n${FAKE}`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ lines: [INIT, result(answerOf('Tak.', 'yes'))] }));

  // Synthetic OpenAI and Soniox keys: `companionEnabled` needs both next to the flag (the key routes and the voice).
  const flag = opts.flag === undefined ? {} : {
    RAROG_COMPANION: opts.flag, OPENAI_API_KEY: 'sk-test-companion-trasa', SONIOX_API_KEY: 'snx-test-companion-trasa',
  };
  const config = opts.demo === true
    ? loadConfig({ RAROG_DEMO: '1', RAROG_ORIGINS: ORIGIN, ...flag })
    : loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: dir, RAROG_DATA_DIR: dataDir, ...flag });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = new FakeManager([
    makeSummary({ id: 's1', cwd: project }),
    makeSummary({ id: 's2', cwd: project }),
    makeSummary({ id: 's3', cwd: project }),
    makeSummary({ id: 'cx', cwd: project, engine: 'codex' }),
    makeSummary({ id: 'poza', cwd: '/Users/u/Prywatne/birch', outOfScope: true }),
  ]);
  for (const id of ['s1', 's2', 's3']) manager.conversations.set(id, CONV_A);
  const hub = new SseHub({ manager, serverStartId: 'start', protocolVersion: 1, heartbeatMs: 0 });
  const logs: string[] = [];
  const logger: Logger = {
    info: (line: string) => { logs.push(line); },
    error: (line: string) => { logs.push(line); },
  };
  const feature = opts.noFeature === true ? undefined : createCompanionFeature({
    cli: createCompanionCli({
      bin, cwdRoot: join(config.dataDir, 'companion-cwd'), env: config.companionEnvBase,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    }),
    locate: (_cwd, agentSessionId) => Promise.resolve(agentSessionId === CONV_A ? transcript : null),
    log: (line) => { logs.push(line); },
  });
  if (feature !== undefined) {
    manager.onConversationChange((sessionId, agentSessionId) => {
      feature.conversationChanged(sessionId, agentSessionId);
    });
  }
  attachDeactivation(device.store, {
    pairing: device.identity.pairing, hub, companion: feature, log: (line) => { logs.push(line); },
  });
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start', startedAtMs: Date.now(), logger, devices: device.identity,
    ...(feature === undefined ? {} : { companion: feature }),
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  const h: Harness = {
    base: `http://127.0.0.1:${String(port)}`,
    auth: device.authorization,
    dir,
    manager,
    device,
    feature,
    logs,
    scenario: (next) => { writeFileSync(join(dir, 'scenario.json'), JSON.stringify(next)); },
    pids: () => {
      const file = join(dir, 'pids.log');
      return existsSync(file)
        ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map(Number)
        : [];
    },
    record: () => JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as { fd3: string; stdin: string },
    close: async () => {
      // Atrapa, która przeżyła test (błąd w kodzie), nie zostaje w systemie.
      for (const pid of h.pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await rm(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(h);
  return h;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for: ${what}`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
}

/** Czeka, aż atrapa wystartuje N-ty raz, i oddaje jej pid. */
async function started(h: Harness, count = 1): Promise<number> {
  await waitFor(`process #${String(count)}`, () => h.pids().length >= count);
  return h.pids()[count - 1] ?? 0;
}

const bodyOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  question: 'Czemu test padał?', clientRequestId: randomUUID(), ...overrides,
});

function ask(h: Harness, id: string, body: unknown = bodyOf(), signal?: AbortSignal): Promise<Response> {
  return fetch(`${h.base}/api/sessions/${id}/companion/ask`, {
    method: 'POST',
    headers: { Origin: ORIGIN, Authorization: h.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function errorOf(res: Response): Promise<{ error: string; code: string | undefined }> {
  const body = await res.json() as { error: string; messageRef?: { code: string } };
  return { error: body.error, code: body.messageRef?.code };
}

async function version(h: Harness): Promise<{ companionEnabled: boolean; capabilities: string[] }> {
  const res = await fetch(`${h.base}/api/version`, { headers: { Authorization: h.auth } });
  expect(res.status).toBe(200);
  return versionResponseSchema.parse(await res.json());
}

describe('companion: flaga `RAROG_COMPANION`', () => {
  it('`1` włącza; brak, puste i `0` wyłączają; spacje się nie liczą; inna wartość zatrzymuje start', () => {
    expect(parseCompanionEnabled('1')).toBe(true);
    expect(parseCompanionEnabled(' 1 ')).toBe(true);
    expect(parseCompanionEnabled(undefined)).toBe(false);
    expect(parseCompanionEnabled('')).toBe(false);
    expect(parseCompanionEnabled('0')).toBe(false);
    expect(() => parseCompanionEnabled('true')).toThrow(ConfigError);
    expect(() => parseCompanionEnabled('yes')).toThrow(/RAROG_COMPANION takes 1 or 0/u);
  });

  it('domyślnie wyłączona; w demo wyłączona także przy `1`', () => {
    expect(loadConfig({ RAROG_DEMO: '1' }).companionEnabled).toBe(false);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_COMPANION: '1' }).companionEnabled).toBe(false);
    expect(loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: tmpdir() }).companionEnabled).toBe(false);
    expect(loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: tmpdir(), RAROG_COMPANION: '1' })
      .companionEnabled).toBe(true);
  });

  it('środowisko procesu to wycinek env startu serwera z zamkniętej listy, bez pustych wartości', () => {
    const config = loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: tmpdir(), HOME: '/Users/demo', USER: 'demo', PATH: '/usr/bin',
      LANG: '', TMPDIR: '/tmp/demo/', SONIOX_API_KEY: 'syntetyczny', ANTHROPIC_API_KEY: 'syntetyczny',
      CLAUDECODE: '1', HERDR_PANE_ID: 'p1',
    });
    expect(config.companionEnvBase).toEqual({ HOME: '/Users/demo', USER: 'demo', PATH: '/usr/bin', TMPDIR: '/tmp/demo/' });
    for (const name of Object.keys(config.companionEnvBase)) expect(COMPANION_ENV_PASSTHROUGH).toContain(name);
  });
});

describe('companion: złożenie w procesie serwera (`assembleCompanion`)', () => {
  it('flaga wyłączona → brak modułu i słuchacza; włączona → moduł podpięty pod zmiany rozmowy silnika', () => {
    const listeners: ((sessionId: string, agentSessionId: string) => void)[] = [];
    const manager = {
      onConversationChange: (cb: (sessionId: string, agentSessionId: string) => void) => {
        listeners.push(cb);
        return () => {};
      },
    };
    const base = { dataDir: tmpdir(), companionEnvBase: {} };
    expect(assembleCompanion({ config: { ...base, companionEnabled: false }, manager, log: () => {} })).toBeUndefined();
    expect(listeners).toHaveLength(0);
    const feature = assembleCompanion({ config: { ...base, companionEnabled: true }, manager, log: () => {} });
    expect(feature?.running).toBe(0);
    expect(listeners).toHaveLength(1);
    expect(() => { listeners[0]?.('s1', CONV_B); }).not.toThrow();
  });
});

describe('companion: `GET /api/version`', () => {
  it('flaga `1` i złożony moduł → `companionEnabled: true`; nazwa `companion` w możliwościach', async () => {
    const h = await startHarness({ flag: '1' });
    const body = await version(h);
    expect(body.companionEnabled).toBe(true);
    expect(body.capabilities).toContain('companion');
  });

  it('flaga `0` → `companionEnabled: false`, możliwość kodu zostaje', async () => {
    const h = await startHarness({ flag: '0' });
    const body = await version(h);
    expect(body.companionEnabled).toBe(false);
    expect(body.capabilities).toContain('companion');
  });

  it('flaga `1` bez modułu w zależnościach → `false`', async () => {
    const h = await startHarness({ flag: '1', noFeature: true });
    expect((await version(h)).companionEnabled).toBe(false);
  });

  it('tryb demo → `false` także przy `1` i złożonym module', async () => {
    const h = await startHarness({ flag: '1', demo: true });
    expect((await version(h)).companionEnabled).toBe(false);
  });
});

describe('companion: bramka trasy', () => {
  it('flaga `0` → 503 `companion-disabled`, proces nie startuje', async () => {
    const h = await startHarness({ flag: '0' });
    const res = await ask(h, 's1');
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toEqual({ error: 'companion-disabled', code: 'rest.companion-disabled' });
    expect(h.pids()).toEqual([]);
  });

  it('flaga `1` bez modułu → 503 `companion-disabled`', async () => {
    const h = await startHarness({ flag: '1', noFeature: true });
    const res = await ask(h, 's1');
    expect(res.status).toBe(503);
    expect((await errorOf(res)).error).toBe('companion-disabled');
  });

  it('tryb demo → 404 jak nieznana trasa, proces nie startuje', async () => {
    const h = await startHarness({ flag: '1', demo: true });
    const res = await ask(h, 's1');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ error: 'not-found', code: 'rest.endpoint-not-found' });
    expect(h.pids()).toEqual([]);
  });

  it('sesja Codexa i panel poza zasięgiem → 404 ze zdaniem „tylko Claude Code”', async () => {
    const h = await startHarness({ flag: '1' });
    for (const id of ['cx', 'poza']) {
      const res = await ask(h, id);
      expect(res.status, id).toBe(404);
      expect(await errorOf(res), id).toEqual({ error: 'not-found', code: 'rest.companion-claude-only' });
    }
    expect(h.pids()).toEqual([]);
  });

  it('nieznana sesja → 404 `not-found`', async () => {
    const h = await startHarness({ flag: '1' });
    const res = await ask(h, 'nie-ma');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ error: 'not-found', code: 'rest.session-not-found' });
  });

  it('ciało poza kontraktem (puste pytanie, ponad 2000 znaków, zły identyfikator) → 400', async () => {
    const h = await startHarness({ flag: '1' });
    for (const body of [
      bodyOf({ question: '   ' }), bodyOf({ question: 'x'.repeat(2001) }), bodyOf({ clientRequestId: 'nie-uuid' }),
      { question: 'Czemu?' },
    ]) {
      const res = await ask(h, 's1', body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).error).toBe('bad-request');
    }
    expect(h.pids()).toEqual([]);
  });

  it('ciało `{question, clientRequestId}` bez `agentSessionId` → 200, wsad z pliku bieżącej rozmowy sesji', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT, result(answerOf('Tak.', 'yes'))] });
    const res = await ask(h, 's1', { question: 'Czemu test padał?', clientRequestId: randomUUID() });
    expect(res.status).toBe(200);
    expect(h.record().fd3).toContain('Test pada, bo brakuje fixture\'u.');
  });

  it('dodatkowe pole `agentSessionId` (stara rozmowa, `../x`) → pominięte jak w każdym schemacie REST, 200', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT, result(answerOf('Tak.', 'yes'))] });
    for (const extra of [CONV_B, '../x']) {
      const res = await ask(h, 's1', bodyOf({ agentSessionId: extra }));
      expect(res.status, extra).toBe(200);
      expect(h.record().fd3, extra).toContain('Test pada, bo brakuje fixture\'u.');
    }
  });

  it('sesja bez rozmowy silnika → 200, wsad bez tur', async () => {
    const h = await startHarness({ flag: '1' });
    h.manager.conversations.delete('s1');
    h.scenario({ lines: [INIT, result(answerOf('Sesja jeszcze nic nie zrobiła.', 'no'))] });
    const res = await ask(h, 's1');
    expect(res.status).toBe(200);
    expect(h.record().fd3).not.toContain('brakuje fixture');
  });

  it('GET → 405', async () => {
    const h = await startHarness({ flag: '1' });
    const res = await fetch(`${h.base}/api/sessions/s1/companion/ask`, { headers: { Authorization: h.auth } });
    expect(res.status).toBe(405);
  });
});

describe('companion: odpowiedź', () => {
  it('the model knows the answer → 200 `{answer, found: true}` without `prompt`; the input has transcript and question', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT, result(answerOf('Test padał, bo brakowało fixture\'u.', 'yes'))] });
    const res = await ask(h, 's1');
    expect(res.status).toBe(200);
    const body = companionAskSchema.parse(await res.json());
    expect(body).toEqual({ answer: 'Test padał, bo brakowało fixture\'u.', found: true });
    const record = h.record();
    expect(record.fd3).toContain('Test pada, bo brakuje fixture\'u.');
    expect(record.stdin).toContain('Czemu test padał?');
  });

  it('the model does not know the answer → `found: false` and a ready prompt for the agent', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT, result(answerOf('Tego nie widać w sesji.', 'no', 'Sprawdź konfigurację CI.'))] });
    const res = await ask(h, 's1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 'Tego nie widać w sesji.', found: false, prompt: 'Sprawdź konfigurację CI.' });
  });

  it('po `/clear` przed pytaniem → pytanie o nową rozmowę; bez jej pliku wsad bez tur, odpowiedź przechodzi', async () => {
    const h = await startHarness({ flag: '1' });
    h.manager.changeConversation('s1', CONV_B);
    const res = await ask(h, 's1');
    expect(res.status).toBe(200);
    expect(h.record().fd3).not.toContain('brakuje fixture');
  });

  const shapes = JSON.parse(readFileSync(join(REPO, 'shared/fixtures/companion/secret-shapes.json'), 'utf8')) as {
    cases: { rule: string; example: string; expected: string }[];
  };

  it.each(shapes.cases.map((one) => [one.rule, one] as const))(
    'a secret from the table in the model\'s answer and prompt (%s) → masked',
    async (_rule, one) => {
      const h = await startHarness({ flag: '1' });
      h.scenario({ lines: [INIT, result(answerOf(one.example, 'no', one.example))] });
      const res = await ask(h, 's1');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ answer: one.expected, found: false, prompt: one.expected });
    },
  );

  it('limit planu `rejected` → 429 `companion-limit`', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({
      lines: [INIT, {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, status: 'rejected' } },
        },
      }, result('limit reached (synthetic)', true)],
      exitCode: 1,
    });
    const res = await ask(h, 's1');
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toEqual({ error: 'companion-limit', code: 'rest.companion-limit' });
  });

  it('CLI bez logowania (błąd, kod 1) → 503 `companion-cli`', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT, result('Not logged in (synthetic)', true)], exitCode: 1 });
    const res = await ask(h, 's1');
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toEqual({ error: 'companion-cli', code: 'rest.companion-cli' });
  });

  it('limit czasu → 504 `companion-timeout`, proces zabity', async () => {
    const h = await startHarness({ flag: '1', timeoutMs: 1_000 });
    h.scenario({ lines: [INIT], hang: true });
    const res = await ask(h, 's1');
    expect(res.status).toBe(504);
    expect(await errorOf(res)).toEqual({ error: 'companion-timeout', code: 'rest.companion-timeout' });
    const [pid = 0] = h.pids();
    await waitFor('process killed', () => !alive(pid));
  });

  it('log mówi o wyniku bez treści pytania i odpowiedzi', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT, result(answerOf('Odpowiedź-TREŚĆ', 'yes'))] });
    expect((await ask(h, 's1', bodyOf({ question: 'Pytanie-TREŚĆ' }))).status).toBe(200);
    const lines = h.logs.filter((line) => line.startsWith('companion:'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/TREŚĆ/u);
  });
});

describe('companion: pytania w locie i zabicie procesu', () => {
  it('drugie pytanie w tej samej sesji w locie → 429 `companion-busy`', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT], hang: true });
    const controller = new AbortController();
    const first = ask(h, 's1', bodyOf(), controller.signal).catch(() => null);
    const pid = await started(h);
    const second = await ask(h, 's1');
    expect(second.status).toBe(429);
    expect(await errorOf(second)).toEqual({ error: 'companion-busy', code: 'rest.companion-busy' });
    expect(h.pids()).toHaveLength(1);
    controller.abort();
    await first;
    await waitFor('process killed', () => !alive(pid));
  });

  it('trzecie pytanie na serwerze przy dwóch w locie → 429 `companion-busy`', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT], hang: true });
    const controller = new AbortController();
    const first = ask(h, 's1', bodyOf(), controller.signal).catch(() => null);
    const second = ask(h, 's2', bodyOf(), controller.signal).catch(() => null);
    await started(h, 2);
    const third = await ask(h, 's3');
    expect(third.status).toBe(429);
    expect((await errorOf(third)).error).toBe('companion-busy');
    controller.abort();
    await Promise.all([first, second]);
    for (const pid of h.pids()) await waitFor('process killed', () => !alive(pid));
  });

  it('`/clear` w trakcie pytania → proces zabity, odpowiedź zamknięta bez treści', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT], hang: true });
    const pending = ask(h, 's1').then((res) => res.text());
    const pid = await started(h);
    h.manager.changeConversation('s1', CONV_B);
    await expect(pending).rejects.toThrow();
    await waitFor('process killed', () => !alive(pid));
    await waitFor('log line', () => h.logs.some((line) => line.startsWith('companion:') && line.includes('conversation')));
  });

  it('zmiana rozmowy INNEJ sesji nie rusza pytania', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT], hang: true });
    const controller = new AbortController();
    const pending = ask(h, 's1', bodyOf(), controller.signal).catch(() => null);
    const pid = await started(h);
    h.manager.changeConversation('s2', CONV_B);
    await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
    expect(alive(pid)).toBe(true);
    controller.abort();
    await pending;
    await waitFor('process killed', () => !alive(pid));
  });

  it('odpięcie urządzenia w trakcie → proces zabity, odpowiedź zamknięta bez treści', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT], hang: true });
    const pending = ask(h, 's1').then((res) => res.text());
    const pid = await started(h);
    h.device.store.revoke(h.device.id, 'admin');
    await expect(pending).rejects.toThrow();
    await waitFor('process killed', () => !alive(pid));
    expect(h.logs.some((line) => line.includes(`${h.device.id} revoked (admin)`) && line.includes('voice agent: 1')))
      .toBe(true);
  });

  it('zamknięcie serwera (`closeAll`) w trakcie pytania → proces zabity, katalog roboczy usunięty, zanim obietnica się skończy', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT], hang: true });
    const pending = ask(h, 's1').then((res) => res.text()).catch(() => null);
    const pid = await started(h);
    const cwdRoot = join(h.dir, 'dane', 'companion-cwd');
    expect(readdirSync(cwdRoot)).toHaveLength(1);
    await h.feature?.closeAll();
    expect(alive(pid)).toBe(false);
    expect(readdirSync(cwdRoot)).toHaveLength(0);
    expect(h.feature?.running).toBe(0);
    await pending;
  });

  it('zamknięte żądanie → proces zabity', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT], hang: true });
    const controller = new AbortController();
    const pending = ask(h, 's1', bodyOf(), controller.signal);
    const pid = await started(h);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await waitFor('process killed', () => !alive(pid));
    await waitFor('log line', () => h.logs.some((line) => line.startsWith('companion:') && line.includes('closed')));
  });

  it('po zabiciu miejsce wraca: następne pytanie w tej sesji przechodzi', async () => {
    const h = await startHarness({ flag: '1' });
    h.scenario({ lines: [INIT], hang: true });
    const controller = new AbortController();
    const pending = ask(h, 's1', bodyOf(), controller.signal).catch(() => null);
    const pid = await started(h);
    controller.abort();
    await pending;
    await waitFor('process killed', () => !alive(pid));
    await waitFor('slot free', () => h.feature?.running === 0);
    h.scenario({ lines: [INIT, result(answerOf('Tak.', 'yes'))] });
    expect((await ask(h, 's1')).status).toBe(200);
  });
});
