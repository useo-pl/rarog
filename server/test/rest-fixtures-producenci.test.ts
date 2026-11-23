/**
 * Złote odpowiedzi REST, strona PRODUCENTÓW: router → pliki `shared/fixtures/rest/`.
 *
 * Odpowiedzi buduje KOD, nie ręka: prawdziwy router na porcie efemerycznym nad managerem demo
 * (seedy, `now` wstrzyknięte), prawdziwy dostawca limitów (`createUsageProvider`) nad zrzutem
 * paska statusu i plikiem `~/.claude.json` w katalogu tymczasowym (zero sieci, zero
 * poświadczeń). Ciało wraca `JSON.parse` z odpowiedzi HTTP — dokładnie to, co dostaje
 * klient — i przechodzi ścisły schemat z `@rarog/shared/rest` (router nie waliduje wyjścia).
 *
 * Druga strona (pliki → schemat) mieszka w `shared/test/rest-fixtures.test.ts` i nie importuje
 * niczego z serwera; trzecia to `RestFixturesTests` w `native/Rarog/Packages/RarogContract`.
 * Domyślnie test PORÓWNUJE odpowiedzi z plikami; `RAROG_FIXTURES_WRITE=1` je nadpisuje.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  PROTOCOL_VERSION, commandListSchema, diffFileListSchema, diffFilePatchSchema, dirEntrySchema, dirListingSchema,
  decisionRefusedBodySchema, interruptResponseSchema, modelListSchema, notesConflictBodySchema, notesGetResponseSchema,
  notesPutResponseSchema, resumableListSchema, sessionModelResponseSchema,
} from '@rarog/shared';
import {
  DEVICE_REQUIRED_ERROR, apnsStatusResponseSchema, companionAskSchema, companionTokenSchema, deviceListSchema, deviceMeSchema, deviceRevokedBodySchema,
  companionSessionsSchema, companionSpeechTokenSchema, companionTurnsSchema, errorBodySchema,
  liveActivityMacSchema, messageAcceptedSchema, okAckSchema, pairResponseSchema, pairingIssuedSchema,
  planUsageSchema, queueTakeBackResponseSchema, restartResponseSchema, resumeResponseSchema, termHistoryResponseSchema,
  termListResponseSchema, termOpenResponseSchema, versionResponseSchema,
} from '@rarog/shared/rest';
import type { PlanUsageResponse } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import {
  createDeviceStore, createPairing, deviceAuthorization, hashSecret, pushKeyId,
} from '../src/auth/index.ts';
import { createCompanionFeature } from '../src/companion/ask.ts';
import type { AskOutcome, CompanionCli } from '../src/companion/cli.ts';
import { conversationTokens } from '../src/companion/conversation.ts';
import { createCompanionTurns } from '../src/companion/turns.ts';
import { createCompanionTokenMinter } from '../src/companion/openai-token.ts';
import type { CompanionTokenFetch } from '../src/companion/openai-token.ts';
import { DEMO_REVIEW_MAX_DEVICES, VOICE_TOKEN_HOURLY_CAP, VOICE_TOKEN_MIN_INTERVAL_MS, loadConfig } from '../src/config.ts';
import { COMPANION_SPEECH_KEY, createVoiceMinter } from '../src/voice/soniox.ts';
import type { FetchLike } from '../src/voice/soniox.ts';
import { collectDiffFile, collectDiffList } from '../src/git-diff.ts';
import { buildCatalog, commandListOf, reservedNames } from '../src/herdr/commands/catalog.ts';
import { discoverCommands } from '../src/herdr/commands/discover.ts';
import type { GitArgsRunner } from '../src/git-status.ts';
import { type Logger, type RouterDeps, createRouter } from '../src/router.ts';
import { BadStateError } from '../src/sessions/errors.ts';
import { UltracodeRefusedError, createManager } from '../src/sessions/manager.ts';
import { ULTRACODE_CLI_UNKNOWN_MESSAGE } from '../src/sessions/state-sentences.ts';
import { takeBackRefusal } from '../src/sessions/session-take-back.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { createUsageProvider } from '../src/usage.ts';
import { DEMO_NOTE_CWD, createDemoNotes } from '../src/demo/notes.ts';
import { readNotes, writeNotes } from '../src/notes/store.ts';
import type { NotesBackend } from '../src/notes/store.ts';
import { CPU_SAMPLE_MS, DISK_SAMPLE_MS, RAM_SAMPLE_MS, createMacStats } from '../src/mac-stats.ts';
import { createApnsChannel } from '../src/notify/apns-channel.ts';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import { createLiveActivity } from '../src/notify/live-activity.ts';
import type { PlanUsage } from '../src/usage.ts';
import { TermRegistry } from '../src/term/registry.ts';
import { type TermFeature, createTermBackend } from '../src/term/index.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { FakeController, FakeHerdr } from './fake-term-herdr.ts';
import { blockedLine, noticeLine, turnLines } from './helpers/plik-rozmowy.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures/rest',
);
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';

/** Kontrakt typów: `PlanUsage` producenta i schemat w `shared` to ten sam kształt (w obie strony). */
const _usageToContract = (usage: PlanUsage): PlanUsageResponse => usage;
const _contractToUsage = (usage: PlanUsageResponse): PlanUsage => usage;
void _usageToContract;
void _contractToUsage;

interface ManifestEntry {
  route: string;
  status: number;
  schema: string;
}

const manifest = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as
  Record<string, ManifestEntry>;

/**
 * Złote pliki, których kod już nie produkuje, a które czyta apka (`RestFixturesTests` w `native/`): zostają bez
 * zmian, dopóki apka ich nie zdejmie. Dziś takich nie ma; schemat i status każdego pliku sprawdza też
 * `shared/test/rest-fixtures.test.ts`.
 */
const FROZEN: ReadonlySet<string> = new Set<string>();
const producedNames = Object.keys(manifest).filter((name) => !FROZEN.has(name)).sort();

/** Nazwa schematu z manifestu → schemat (ta sama mapa co w lustrze `shared/test`). */
const SCHEMAS: Record<string, ZodType> = {
  versionResponse: versionResponseSchema,
  resumableList: resumableListSchema,
  planUsage: planUsageSchema,
  macLoad: liveActivityMacSchema,
  errorBody: errorBodySchema,
  okAck: okAckSchema,
  messageAccepted: messageAcceptedSchema,
  queueTakeBackResponse: queueTakeBackResponseSchema,
  restartResponse: restartResponseSchema,
  resumeResponse: resumeResponseSchema,
  interruptResponse: interruptResponseSchema,
  dirListing: dirListingSchema,
  apnsStatusResponse: apnsStatusResponseSchema,
  termOpenResponse: termOpenResponseSchema,
  termListResponse: termListResponseSchema,
  termHistoryResponse: termHistoryResponseSchema,
  diffFileList: diffFileListSchema,
  diffFilePatch: diffFilePatchSchema,
  notesDoc: notesGetResponseSchema,
  notesSaved: notesPutResponseSchema,
  notesConflict: notesConflictBodySchema,
  commandList: commandListSchema,
  modelList: modelListSchema,
  pairResponse: pairResponseSchema,
  pairingIssued: pairingIssuedSchema,
  deviceList: deviceListSchema,
  deviceMe: deviceMeSchema,
  deviceRevokedBody: deviceRevokedBodySchema,
  decisionRefusedBody: decisionRefusedBodySchema,
  sessionModelResponse: sessionModelResponseSchema,
  companionAsk: companionAskSchema,
  companionToken: companionTokenSchema,
  companionSpeechToken: companionSpeechTokenSchema,
  companionTurns: companionTurnsSchema,
  companionSessions: companionSessionsSchema,
  dirEntry: dirEntrySchema,
};

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------
// Atrapy zewnętrznego świata
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const ORIGIN = 'http://localhost:8930';
const CLIENT_MESSAGE_ID = '2c6a8e14-9b3f-4d71-a5e0-c48f1b7d93a2';
/** Wysyłka z echem odroczonym — osobny identyfikator, żeby rejestr identyfikatorów wysyłek nie mieszał przypadków. */
const QUEUED_MESSAGE_ID = '7e1d3c5b-2a4f-4c8e-9b6d-0f1e2d3c4b5a';
/** The operation of a queue take-back: a UUID from the app, the same on every retry. */
const TAKE_BACK_OPERATION_ID = '4a9c2e7f-1b3d-4f6a-8c5e-9d0b1a2c3e4f';
const silent: Logger = { info: () => {}, error: () => {} };
/** Para serwera iroh w złotych plikach: stała, bez modułu natywnego (EndpointId to 64 znaki hex). */
const FIXTURE_IROH = { endpointId: '5e'.repeat(32), relay: 'https://relay.example.net/' } as const;

/** Agent głosowy: bieżąca rozmowa silnika sesji, identyfikator pytania i syntetyczny klucz do maski. */
const COMPANION_CONVERSATION = '22222222-2222-4222-8222-222222222222';
const COMPANION_REQUEST_ID = '5b0f3c2e-8d4a-4e6f-9a1b-2c3d4e5f6a7b';
const COMPANION_SECRET = `sk-proj-${'A1b2C3d4'.repeat(4)}`;
/** Short-lived OpenAI key in the golden response: a synthetic value, as OpenAI would shape it. */
const COMPANION_EPHEMERAL = `ek_fixture_${'5e6f'.repeat(6)}`;
/** The server's Soniox key and the temporary speech key in the golden response: synthetic values. */
const SONIOX_SECRET = `soniox-fixture-${'7a8b'.repeat(6)}`;
const SPEECH_TEMPORARY = `snx_temp_fixture_${'ab'.repeat(12)}`;

/** Zrzut paska statusu Claude Code z limitami (`rate_limits`, resety w sekundach epoki). */
const statuslineDump = (fiveHour: number, weekly: number): string => JSON.stringify({
  session_id: 'sesja-fixtures',
  rate_limits: {
    five_hour: { used_percentage: fiveHour, resets_at: Date.parse('2026-10-04T13:20:00Z') / 1000 },
    seven_day: { used_percentage: weekly, resets_at: Date.parse('2026-10-09T15:00:00Z') / 1000 },
  },
});

/** Ile po chwili zrzutu odczyt ma już `stale` (próg `CLI_USAGE_STALE_MS` = 15 min). */
const STALE_LATER_MS = 20 * 60_000;

/** Syntetyczne konto `~/.claude.json` dla szczegółów limitów i konto obce. */
const FIXTURE_ACCOUNT = '00000000-0000-4000-8000-0000000000aa';
const FOREIGN_ACCOUNT = '00000000-0000-4000-8000-0000000000bb';

/**
 * `~/.claude.json` z odczytem limitów, który zapisuje Claude Code (`cachedUsageUtilization`, kształt
 * zmierzony), z SAMYMI polami czytanymi przez Raroga; odczyt sprzed 3 h, konto `cacheAccount`.
 */
const claudeJsonWithCache = (cacheAccount: string): string => JSON.stringify({
  oauthAccount: { emailAddress: 'demo@example.com', accountUuid: FIXTURE_ACCOUNT },
  cachedUsageUtilization: {
    fetchedAtMs: NOW - 3 * 60 * 60_000,
    accountUuid: cacheAccount,
    utilization: {
      limits: [
        { kind: 'session', percent: 22, resets_at: '2026-10-04T13:20:00.403026+00:00', scope: null },
        { kind: 'weekly_all', percent: 57, resets_at: '2026-10-09T15:00:00.403044+00:00', scope: null },
        {
          kind: 'weekly_scoped', percent: 34, resets_at: '2026-10-09T15:00:00.403187+00:00',
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    },
  },
});

/*
 * Atrapa gita dla tras diffa per plik: wyjścia w formatach `-z` zmierzonych na git 2.54.
 * Katalog sesji demo nie istnieje na dysku, więc prawdziwy git nie ma czego czytać — a odpowiedź
 * i tak składają PRAWDZIWE kolektory (`git-diff.ts`) za prawdziwym routerem.
 */
const GIT_TRACKED = ['M', 'src/notes.ts', 'R096', 'src/old-name.ts', 'src/new-name.ts', 'M', 'assets/logo.png',
  'M', 'pnpm-lock.yaml', 'D', 'src/notes-legacy.ts'];
const GIT_UNTRACKED = ['docs/nowy plik.md', 'src/notes.test.ts'];
const GIT_NUMSTAT = ['2\t2\tsrc/notes.ts', '1\t0\t', 'src/old-name.ts', 'src/new-name.ts', '-\t-\tassets/logo.png',
  '120\t80\tpnpm-lock.yaml', '0\t4\tsrc/notes-legacy.ts'];
const GIT_PATCHES: Record<string, string> = {
  'assets/logo.png': 'diff --git a/assets/logo.png b/assets/logo.png\nindex e899662..9de10b8 100644\n'
    + 'Binary files a/assets/logo.png and b/assets/logo.png differ\n',
  'pnpm-lock.yaml': 'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\nindex 3ab97e5..7c1e4b8 100644\n'
    + '--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1,3 +1,43 @@\n lockfileVersion: \'9.0\'\n'
    + Array.from({ length: 40 }, (_, i) => `+  /paczka-${String(i + 1).padStart(2, '0')}@1.0.0: {}\n`).join(''),
};
const zRecords = (fields: readonly string[]): string => fields.map((field) => `${field}\0`).join('');

/**
 * Dysk dla listy komend: skille i komenda użytkownika, skill projektu i plugin w typowych kształtach
 * (opis jednoliniowy, blok `>`, cudzysłów, opis ponad sufit, brak frontmattera, skill ukryty).
 */
async function writeCommandsDisk(home: string, cwd: string): Promise<void> {
  const put = async (file: string, text: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  const skills = path.join(home, '.claude', 'skills');
  await put(path.join(skills, 'handoff', 'SKILL.md'), [
    '---', 'name: handoff',
    'description: Write a short summary of the session for the next one.',
    'argument-hint: "What should the summary focus on?"', '---', '',
  ].join('\n'));
  await put(path.join(skills, 'roundtable', 'SKILL.md'), [
    '---', 'name: roundtable', 'description: >', '  Use when the user asks several models to compare',
    '  their answers to one question.', 'allowed-tools:', '  - Read', '---', '',
  ].join('\n'));
  await put(path.join(skills, 'cloudflare', 'SKILL.md'), [
    '---', `description: Comprehensive Cloudflare platform skill. ${'Workers, Pages, KV, D1, R2. '.repeat(8)}`, '---', '',
  ].join('\n'));
  await put(path.join(skills, 'tylko-model', 'SKILL.md'), ['---', 'user-invocable: false', 'description: x', '---', ''].join('\n'));
  await put(path.join(home, '.claude', 'commands', 'notatka.md'), '# Notatka bez frontmattera\n');
  await mkdir(path.join(cwd, '.git'), { recursive: true });
  await put(path.join(cwd, '.claude', 'skills', 'wydanie', 'SKILL.md'),
    ['---', 'description: Wydanie projektu demo', 'argument-hint: "[wersja]"', '---', ''].join('\n'));
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'rynek', 'narzedzia', '1.0.0');
  await put(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'narzedzia' }));
  await put(path.join(installPath, 'commands', 'review-pr.md'), [
    '---', 'description: "Review the branch diff before a merge"', 'argument-hint: "[review-aspects]"',
    '---', '',
  ].join('\n'));
  await put(path.join(installPath, 'skills', 'szkic', 'SKILL.md'), ['---', 'description: Szkic planu', '---', ''].join('\n'));
  await put(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'narzedzia@rynek': [{ scope: 'user', installPath, version: '1.0.0' }] },
  }));
}

interface Captured {
  status: number;
  body: unknown;
}

describe('złote odpowiedzi REST: producenci → pliki', () => {
  const produced = new Map<string, Captured>();
  let dataDir = '';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'rarog-rest-fixtures-'));
    let clock = NOW;
    /*
     * Limity planu: prawdziwy dostawca nad zrzutem paska statusu i `~/.claude.json` w katalogu
     * tymczasowym. Własny zegar, bo wiek zrzutu decyduje o `stale`, a reszta tras ma stać na `clock`.
     */
    let usageClock = NOW;
    const statusline = path.join(dataDir, 'statusline');
    await mkdir(statusline, { recursive: true });
    const usageDump = path.join(statusline, 'sesja.json');
    await writeFile(usageDump, statuslineDump(27, 60));
    const claudeJsonPath = path.join(dataDir, 'claude.json');
    await writeFile(claudeJsonPath, JSON.stringify({ oauthAccount: { emailAddress: 'demo@example.com' } }));
    const usage = createUsageProvider({ statuslineRoot: statusline, claudeJsonPath, now: () => usageClock });

    /*
     * Obciążenie Maca: PRAWDZIWY próbnik z atrapą źródeł i timerów sterowanych z testu — ciała
     * odpowiedzi to dokładnie to, co `createMacStats` oddaje w trzech chwilach: tuż po starcie, gdy nic
     * się jeszcze nie udało (pusty obiekt), przy części odczytów (CPU w spoczynku = 0 i dysk, `sysctl`
     * padł) i w komplecie (średnia CPU z dwóch taktów).
     */
    let cpuTimes = { busy: 0, total: 0 };
    let memoryLevel: string | null = null;
    let diskBlocks: { blocks: number; bfree: number; bavail: number } | null = null;
    const macTimers: { cb: () => void; ms: number }[] = [];
    const macSampler = createMacStats({
      sources: {
        cpuTimes: () => cpuTimes,
        memoryLevel: () => Promise.resolve(memoryLevel),
        disk: () => Promise.resolve(diskBlocks),
      },
      setInterval: (cb, ms) => { macTimers.push({ cb, ms }); return macTimers.length; },
      clearInterval: () => {},
    });
    const macTick = async (...periods: number[]): Promise<void> => {
      for (const timer of macTimers) if (periods.includes(timer.ms)) timer.cb();
      await new Promise((resolve) => { setImmediate(resolve); });
    };

    const manager: Manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir, now: () => NOW });
    await manager.ready;
    const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dataDir });
    const hub = new SseHub({ manager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
    hub.start();
    // Notatki demo w pamięci, z zegarem testu: wersje w plikach nie zależą od chwili uruchomienia.
    const notes = createDemoNotes(demoContentPl, () => clock);
    const device = createTestDevice(dataDir, { epoch: config.epoch, now: () => NOW });
    const routerDeps: RouterDeps = {
      config, manager, hub, serverStartId: 'start-fixtures', startedAtMs: NOW, logger: silent,
      tailnet: () => Promise.resolve('demo.ts.net'), usage,
      mac: () => macSampler.current(), notes, devices: device.identity,
      // System maszyny STAŁY: CI jedzie na Linuksie, a złota odpowiedź nie może zależeć od maszyny testu.
      system: 'macos',
    };
    const server = http.createServer(createRouter(routerDeps));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const call = async (name: string, method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown):
      Promise<void> => {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: {
          ...device.headers,
          ...(method === 'GET' ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      produced.set(name, { status: res.status, body: await res.json() as unknown });
    };

    try {
      await call('version.json', 'GET', '/api/version');
      /*
       * Serwer z nasłuchem iroh: ten sam router ze stałą parą `iroh` w zależnościach, bez modułu natywnego
       * (para przychodzi do routera z `index.ts`, tu wprost). Plik różni się od `version.json` wyłącznie polem `iroh`.
       */
      const irohServer = http.createServer(createRouter({ ...routerDeps, iroh: FIXTURE_IROH }));
      await new Promise<void>((resolve) => { irohServer.listen(0, '127.0.0.1', resolve); });
      try {
        const res = await fetch(`http://127.0.0.1:${String((irohServer.address() as AddressInfo).port)}/api/version`, {
          headers: device.headers,
        });
        produced.set('version.iroh.json', { status: res.status, body: await res.json() as unknown });
      } finally {
        await new Promise<void>((resolve) => { irohServer.close(() => { resolve(); }); });
      }
      const cwd = manager.projects().find((p) => p.path.endsWith('/willow'))?.path ?? '';
      await call('resumable.json', 'GET', `/api/resumable?cwd=${encodeURIComponent(cwd)}`);
      // Zrzut sprzed 2 min: świeże liczby z chwilą zrzutu i e-mailem konta, bez `stale`.
      const freshAt = new Date(NOW - 2 * 60_000);
      await utimes(usageDump, freshAt, freshAt);
      await call('usage.json', 'GET', '/api/usage');
      // Zrzut z nowym zapytaniem do API (te same liczby, inny `cost.total_api_duration_ms`, więc inny odcisk
      // heurystyki świeżości), odczytany 20 min po zapisie: liczby z `stale` i godziną zrzutu w `fetchedAt`.
      await writeFile(usageDump, JSON.stringify({
        ...(JSON.parse(statuslineDump(27, 60)) as object), cost: { total_api_duration_ms: 1000 },
      }));
      await utimes(usageDump, new Date(NOW), new Date(NOW));
      usageClock = NOW + STALE_LATER_MS;
      await call('usage.stale.json', 'GET', '/api/usage');
      // Szczegóły: odczyt limitów Claude Code tego konta — trzy okna z jego własną, starą chwilą;
      // potem odczyt innego konta niż `oauthAccount`, czyli `{}`.
      usageClock = NOW;
      await writeFile(claudeJsonPath, claudeJsonWithCache(FIXTURE_ACCOUNT));
      await call('usage.details.json', 'GET', '/api/usage/details');
      await writeFile(claudeJsonPath, claudeJsonWithCache(FOREIGN_ACCOUNT));
      await call('usage.details.empty.json', 'GET', '/api/usage/details');

      // Obciążenie Maca: nic jeszcze nie wiadomo → część odczytów → komplet.
      await macTick();
      await call('mac.empty.json', 'GET', '/api/mac');
      cpuTimes = { busy: 0, total: 10_000 };
      diskBlocks = { blocks: 1_000, bfree: 550, bavail: 550 };
      await macTick(CPU_SAMPLE_MS, DISK_SAMPLE_MS);
      await call('mac.partial.json', 'GET', '/api/mac');
      cpuTimes = { busy: 7_000, total: 20_000 };
      memoryLevel = '40';
      await macTick(CPU_SAMPLE_MS, RAM_SAMPLE_MS);
      await call('mac.json', 'GET', '/api/mac');
      macSampler.close();

      const messages = '/api/sessions/demo-rarog/messages';
      await call('messages.accepted.json', 'POST', messages, {
        text: 'Sprawdź kontrakt REST.', clientMessageId: CLIENT_MESSAGE_ID,
      });
      await call('messages.replayed.json', 'POST', messages, {
        text: 'Sprawdź kontrakt REST.', clientMessageId: CLIENT_MESSAGE_ID,
      });
      await call('error.client-id-conflict.json', 'POST', messages, {
        text: 'Inna treść z tym samym identyfikatorem.', clientMessageId: CLIENT_MESSAGE_ID,
      });
      await call('messages.plain.json', 'POST', messages, { text: 'Wysyłka bez identyfikatora.' });
      /*
       * Echo odroczone: demo jedzie na mocku bez pliku rozmowy, więc niczego nie wstrzymuje —
       * wynik managera podajemy wprost, a odpowiedź z `queued` składa prawdziwy router.
       */
      const realSend = manager.sendMessage.bind(manager);
      manager.sendMessage = () => Promise.resolve({ replayed: false, queued: true });
      await call('messages.queued.json', 'POST', messages, {
        text: 'A note while the agent works.', clientMessageId: QUEUED_MESSAGE_ID, queueAware: true,
      });
      manager.sendMessage = () => Promise.resolve({ replayed: true, queued: true });
      await call('messages.replayed-queued.json', 'POST', messages, {
        text: 'A note while the agent works.', clientMessageId: QUEUED_MESSAGE_ID, queueAware: true,
      });
      manager.sendMessage = realSend;
      /*
       * Queue take-back: the demo driver has no queue, so the manager's result is given here and the real router builds
       * the body. A message from the app with a held echo, a prompt typed at the Mac, then the same with part of the
       * CLI queue left, and a driver refusal (409 with its sentence).
       */
      const takeBack = '/api/sessions/demo-rarog/queue/take-back';
      const realTakeBack = manager.takeBackQueue.bind(manager);
      manager.takeBackQueue = () => Promise.resolve({
        items: [{ text: 'A note while the agent works.', clientMessageId: QUEUED_MESSAGE_ID }, { text: 'Typed at the Mac.' }],
      });
      await call('queue.take-back.json', 'POST', takeBack, { operationId: TAKE_BACK_OPERATION_ID });
      manager.takeBackQueue = () => Promise.resolve({ items: [{ text: 'Typed at the Mac.' }], incomplete: true });
      await call('queue.take-back.incomplete.json', 'POST', takeBack, { operationId: TAKE_BACK_OPERATION_ID });
      manager.takeBackQueue = () => Promise.reject(takeBackRefusal('dialog'));
      await call('error.take-back-refused.json', 'POST', takeBack, { operationId: TAKE_BACK_OPERATION_ID });
      manager.takeBackQueue = realTakeBack;
      await call('error.not-found.json', 'POST', '/api/sessions/nie-ma-takiej/messages', { text: 'x' });
      await call('ack.json', 'POST', '/api/sessions/demo-willow/seen', {});
      // Ręczne „nieprzeczytane” z listy apki — to samo potwierdzenie co `…/seen`.
      await call('ack.unseen.json', 'POST', '/api/sessions/demo-willow/unseen', {});

      /*
       * Diff per plik. Lista zmian i patch pliku to prawdziwe odpowiedzi managera demo (trzy
       * pliki mocka), tak samo trzy odmowy: zła ścieżka (400), plik spoza listy zmian (404)
       * i nieznana sesja (404 z własnym kodem, innym niż `not-found` nieznanej trasy).
       */
      const diff = '/api/sessions/demo-willow/diff';
      const diffFile = (file: string): string => `${diff}/file?path=${encodeURIComponent(file)}`;
      await call('diff.files.json', 'GET', `${diff}/files`);
      await call('diff.file.json', 'GET', diffFile('src/notes.ts'));
      await call('error.diff-bad-path.json', 'GET', diffFile('../poza/katalogiem.ts'));
      await call('error.diff-file-not-found.json', 'GET', diffFile('src/nie-ma.ts'));
      await call('error.diff-session-not-found.json', 'GET', '/api/sessions/nie-ma-takiej/diff/files');
      /*
       * Przypadki, których mock demo nie ma (plik binarny, ucięcia, awaria gita), daje ten sam
       * router nad PRAWDZIWYMI kolektorami z atrapą gita: lista z licznikami, plikiem binarnym,
       * rename'em i nieśledzonym bez liczników, ucięta na suficie (tu 6 wpisów zamiast 500), patch
       * pliku binarnego, patch ucięty na granicy linii (tu 512 B zamiast 512 kB) i 503, gdy git
       * nie odpowiada. Sufity to parametry kolektorów, więc kształt odpowiedzi jest produkcyjny.
       */
      let gitDown = false;
      const fakeGit: GitArgsRunner = ({ sub, rest }) => Promise.resolve(gitDown
        ? { ok: false, stdout: '', timedOut: true }
        : {
          ok: true,
          exitCode: 0,
          stdout: sub === 'ls-files' ? zRecords(GIT_UNTRACKED)
            : rest.includes('--name-status') ? zRecords(GIT_TRACKED)
              : rest.includes('--numstat') ? zRecords(GIT_NUMSTAT) : GIT_PATCHES[rest.at(-1) ?? ''] ?? '',
        });
      const listed: Manager['diffFiles'] = () => collectDiffList(cwd, {
        run: fakeGit, runNumstat: fakeGit, maxFiles: 6,
      });
      const patched: Manager['diffFile'] = (_id, file) => collectDiffFile(cwd, file, {
        run: fakeGit, maxPatchBytes: 512,
      });
      manager.diffFiles = listed;
      manager.diffFile = patched;
      await call('diff.files.truncated.json', 'GET', `${diff}/files`);
      await call('diff.file.binary.json', 'GET', diffFile('assets/logo.png'));
      await call('diff.file.truncated.json', 'GET', diffFile('pnpm-lock.yaml'));
      gitDown = true;
      await call('error.diff-git-failed.json', 'GET', `${diff}/files`);

      /*
       * Slash-komendy sesji. Demo nie ma fabryki katalogu, więc prawdziwy manager demo
       * oddaje migawkę z SAMEGO rejestru — lista stała, bez dysku. Skille i pluginy z opisem i podpowiedzią
       * argumentu daje ten sam router nad PRAWDZIWYM skanem dysku (`discover.ts`) w katalogu tymczasowym
       * i tą samą funkcją listy (`commandListOf`), której używa manager; ścieżek w odpowiedzi nie ma.
       */
      await call('commands.json', 'GET', '/api/sessions/demo-willow/commands');
      // Lista modeli (`GET /api/models`): wbudowana, ta sama w demo i w trybie realnym.
      await call('models.json', 'GET', '/api/models');
      const commandsHome = path.join(dataDir, 'komendy', 'home');
      const commandsCwd = path.join(dataDir, 'komendy', 'Projects', 'atlas');
      await writeCommandsDisk(commandsHome, commandsCwd);
      const diskCommands: Manager['commands'] = () => commandListOf(buildCatalog(commandsCwd, discoverCommands({
        home: commandsHome, cwd: commandsCwd, roots: [path.dirname(commandsCwd)], reserved: reservedNames(),
      })));
      manager.commands = diskCommands;
      await call('commands.disk.json', 'GET', '/api/sessions/demo-willow/commands');

      /*
       * Notatki projektu: magazyn demo w pamięci za prawdziwym routerem. Odczyt zasiewu (projekt `rarog`)
       * i pustego projektu, zapis z wersją z odczytu, ten sam zapis jeszcze raz (409 z aktualnym dokumentem)
       * i katalog spoza listy projektów demo (400).
       */
      const notesRoute = (dir: string): string => `/api/notes?cwd=${encodeURIComponent(dir)}`;
      await call('notes.json', 'GET', notesRoute(DEMO_NOTE_CWD));
      await call('notes.empty.json', 'GET', notesRoute(cwd));
      const seeded = notesGetResponseSchema.parse(produced.get('notes.json')?.body);
      clock += 1_000;
      const appended = `${seeded.text}\n- dopisek z telefonu`;
      await call('notes.saved.json', 'PUT', '/api/notes', {
        cwd: DEMO_NOTE_CWD, text: appended, updatedAt: seeded.updatedAt,
      });
      /*
       * 409 notatek z PRAWDZIWEGO magazynu (`notes/store.ts`, katalog tymczasowy): magazyn demo mówi zdaniem bez kodu,
       * a złoty plik ma nieść `messageRef` (`SENTENCE_RESPONSES`). Na dysku stoi ten sam dokument, który właśnie zapisało
       * demo (`notes.saved.json`), więc `current` w obu plikach jest tą samą wersją.
       */
      const saved = notesPutResponseSchema.parse(produced.get('notes.saved.json')?.body);
      // Magazyn przypina notatki do ISTNIEJĄCEGO katalogu (`realpath`), a katalog projektu demo nie istnieje na dysku:
      // ścieżka demo trafia do katalogu tymczasowego, którego ciało 409 nie pokazuje.
      const storeDir = path.join(dataDir, 'notes-store');
      const storeProject = path.join(dataDir, 'data-loader');
      await mkdir(storeProject, { recursive: true });
      writeNotes(storeDir, storeProject, appended, 0, () => saved.updatedAt);
      const storeNotes: NotesBackend = {
        read: () => readNotes(storeDir, storeProject),
        write: (_dir, text, expected) => writeNotes(storeDir, storeProject, text, expected, () => clock),
      };
      const notesServer = http.createServer(createRouter({ ...routerDeps, notes: storeNotes }));
      await new Promise<void>((resolve) => { notesServer.listen(0, '127.0.0.1', resolve); });
      try {
        const res = await fetch(`http://127.0.0.1:${String((notesServer.address() as AddressInfo).port)}/api/notes`, {
          method: 'PUT',
          headers: { ...device.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: DEMO_NOTE_CWD, text: `${seeded.text}\n- dopisek z iPada`, updatedAt: seeded.updatedAt }),
        });
        produced.set('notes.conflict.json', { status: res.status, body: await res.json() as unknown });
      } finally {
        await new Promise<void>((resolve) => { notesServer.close(() => { resolve(); }); });
      }
      await call('error.notes-cwd-not-allowed.json', 'GET', notesRoute('/Users/demo/Projects/nie-ma-takiego'));

      /*
       * Restart na nowym Claude Code. Odmowa 409 to prawdziwa odpowiedź managera demo: jego
       * panele nie umieją `/exit` (driver demo bez `restartProbe`), a odmowa przychodzi PRZED
       * jakąkolwiek mutacją. 202 daje ten sam router nad restartem z atrapy — ciało to wynik
       * `manager.restart`, którego kształt trzyma typ `Manager['restart']` (prawdziwy manager
       * oddaje dokładnie `{ sessionId }` po wysłaniu `/exit`).
       */
      const restart = '/api/sessions/demo-willow/restart';
      await call('error.restart-refused.json', 'POST', restart, {});
      const restarted: Manager['restart'] = (id) => Promise.resolve({ sessionId: id });
      manager.restart = restarted;
      await call('restart.json', 'POST', restart, {});

      /*
       * Przerwanie tury (2F apki natywnej): 202 ze ŚWIEŻĄ kartą sesji i losem klawisza —
       * sesja z żywym driverem demo (stoi na zgodzie, więc bez timerów scenariusza). Karta `done`
       * nie ma czym przerwać: 409 ze zdaniem serwera. „Pokaż w herdr" (`agent.focus` na atrapie
       * herdr demo) oddaje 202 `{ok: true}`.
       */
      /*
       * Karta w odpowiedzi niesie zdanie z kodem (`SENTENCE_RESPONSES`): sesja demo założona bez promptu ma etykietę
       * zapasową `session N` z `labelRef`; przerwanie oddaje ją świeżą.
       */
      const launched = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { ...device.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/Users/demo/Projects/willow' }),
      });
      const freshId = (await launched.json() as { sessionId: string }).sessionId;
      // Model przychodzi z `init` drivera demo osobno od założenia: pod obciążeniem całego zestawu czekamy na niego,
      // żeby karta w `interrupt.json` nie zależała od kolejności zdarzeń.
      for (let round = 0; round < 500 && manager.get(freshId)?.model === undefined; round += 1) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      }
      await call('interrupt.json', 'POST', `/api/sessions/${freshId}/interrupt`, {});
      await call('error.interrupt-refused.json', 'POST', '/api/sessions/demo-willow-parser/interrupt', {});
      // Zmiana modelu w bezczynnej sesji po przerwaniu: 202 z ostrzeżeniem i jego kodem (`warningRef`).
      await call('model-accepted.json', 'POST', `/api/sessions/${freshId}/model`, { model: 'sonnet' });
      /*
       * 422 odmowy decyzji (`sendDecision`): ciało składa router z powodu, który oddał manager. Demo nie ma karty
       * z odmową, więc powód podaje atrapa managera pod tym samym routerem.
       */
      const refusing = new FakeManager();
      refusing.answerOutcomes.push({ outcome: 'refused', reason: 'multi-select' });
      const refusingHub = new SseHub({
        manager: refusing, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      });
      const refusingServer = http.createServer(createRouter({ ...routerDeps, manager: refusing, hub: refusingHub }));
      await new Promise<void>((resolve) => { refusingServer.listen(0, '127.0.0.1', resolve); });
      try {
        const port = String((refusingServer.address() as AddressInfo).port);
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/sess-1/answers/q-1`, {
          method: 'POST',
          headers: { ...device.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: [['A', 'B']] }),
        });
        produced.set('error.decision-refused.json', { status: res.status, body: await res.json() as unknown });
      } finally {
        await new Promise<void>((resolve) => { refusingServer.close(() => { resolve(); }); });
      }
      await call('focus.json', 'POST', '/api/sessions/demo-willow/focus', {});

      // Formularz nowej sesji: korzenie, katalog projektu, ostatnie rozmowy do wznowienia.
      await call('fs.roots.json', 'GET', '/api/fs');
      await call('fs.dir.json', 'GET', `/api/fs?path=${encodeURIComponent(cwd)}`);
      // The demo creates no directories: the same refusal as with a herdr killswitch off.
      await call('error.mkdir-disabled.json', 'POST', '/api/fs/mkdir', { parent: cwd, name: 'notatki' });
      await call('resumable.recent.json', 'GET', `/api/resumable/recent?cwd=${encodeURIComponent(cwd)}`);
      /*
       * Odmowa bramki startu z ultracode. Demo nie ma czytnika wersji i bramkę pomija, więc odmowę daje ten sam
       * router nad startem z atrapy: wyjątek i zdanie to te, które manager rzuca przy nieznanej wersji Claude Code.
       */
      const realCreate = manager.create.bind(manager);
      const refusedCreate: Manager['create'] = () => Promise.reject(
        new UltracodeRefusedError(ULTRACODE_CLI_UNKNOWN_MESSAGE));
      manager.create = refusedCreate;
      await call('error.ultracode-refused.json', 'POST', '/api/sessions', { cwd, ultracode: true });
      manager.create = realCreate;

      /*
       * „Wznów" sesji bez panelu (karty 2E2). Odmowa to prawdziwa odpowiedź managera:
       * sesja z żywym panelem (driver demo) dostaje 409 PRZED czymkolwiek. 200 daje ten sam router
       * nad wznowieniem z atrapy — ciało to `{sessionId, session}` z wyniku `manager.resume`, a sesja
       * to karta seeda `resumable` w stanie, w jakim zostawia ją nowy panel (`starting`).
       */
      const resume = '/api/sessions/demo-willow/resume';
      await call('error.resume-refused.json', 'POST', resume, {});
      const bridge = manager.get('demo-pipe-link');
      if (bridge === undefined) throw new Error('seed demo-pipe-link zniknął');
      // Powód przerwania nie przeżywa wznowienia: nowy panel startuje bez `stateDetail`.
      const { stateDetail: _reason, stateDetailRef: _reasonRef, ...fresh } = bridge;
      const resumed: Manager['resume'] = () => Promise.resolve({ ...fresh, state: 'starting' });
      manager.resume = resumed;
      await call('resume.json', 'POST', '/api/sessions/demo-pipe-link/resume', {});

      /*
       * Status tokenu APNs apki natywnej: serwer bez nadajnika APNs odpowiada „kanału nie
       * ma", nigdy 404. Token to syntetyczny hex.
       */
      await call('push.apns.status.json', 'POST', '/api/push/apns/status', { token: 'a1b2c3d4'.repeat(8) });
    } finally {
      hub.closeAll();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await manager.dispose();
    }

    /*
     * Kanał APNs — ten sam router nad tym samym kontraktem, tylko Z kanałem: prawdziwy
     * rejestr urządzeń w katalogu tymczasowym (zegar stały), sink i nadajnik-atrapy (zero sieci,
     * zero klucza). Osobny serwer, bo `version.json` wyżej opisuje serwer BEZ kanału APNs.
     */
    const apnsDir = path.join(dataDir, 'apns');
    const devices = createApnsDeviceStore({ dataDir: apnsDir, now: () => NOW });
    /**
     * Sparowane urządzenia: rejestracja APNs idzie kluczem urządzenia, a jedno urządzenie ma jeden wpis
     * na temat — dwa tokeny przy przekaźniku to dwa urządzenia. Zwraca magazyn i nagłówki `Authorization`.
     */
    const pairedDevices = (dir: string, epoch: string, count: number): {
      store: ReturnType<typeof createDeviceStore>; auth: string[];
    } => {
      const store = createDeviceStore({ dataDir: dir, epoch, now: () => NOW });
      const auth = Array.from({ length: count }, (_, i) => {
        const id = (i + 1).toString(16).padStart(2, '0').repeat(16);
        const secret = Buffer.alloc(32, 9 + i).toString('base64url');
        const pushKey = Buffer.alloc(32, 5 + i).toString('base64url');
        store.add({
          id, secretHash: hashSecret(secret), pushKey, kid: pushKeyId(pushKey), label: 'iPad·Rarog', build: null,
          createdAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString(), epoch, creator: 'admin',
        });
        return deviceAuthorization(id, secret);
      });
      return { store, auth };
    };
    const apnsManager: Manager = await createManager({
      demo: true, demoContent: demoContentPl, dataDir: apnsDir, now: () => NOW,
    });
    await apnsManager.ready;
    const apnsConfig = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: apnsDir });
    const apnsPaired = pairedDevices(apnsDir, apnsConfig.epoch, 1);
    const apnsHub = new SseHub({
      manager: apnsManager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    });
    apnsHub.start();
    // Sterownik Live Activity z nadajnikiem-atrapą: tu produkuje wyłącznie odmowę dla nieznanego urządzenia.
    const liveActivity = createLiveActivity({
      devices, sender: { send: () => Promise.resolve({ kind: 'ok' }) },
      sessions: () => apnsManager.list(), now: () => NOW,
    });
    const apnsServer = http.createServer(createRouter({
      config: apnsConfig, manager: apnsManager, hub: apnsHub, serverStartId: 'start-fixtures', startedAtMs: NOW,
      logger: silent,
      apns: {
        devices, sink: { sendTo: () => Promise.resolve('delivered') },
        // Droga klucza bez wyłączonego środowiska: degradacja wyłącznie z licznika porażek tokenu.
        sender: {
          statusOf: (record) => ({ degradedSince: record.degradedSince }), awaitRoute: () => Promise.resolve('direct'),
          awaitPending: () => Promise.resolve(),
        },
        now: () => NOW, liveActivity, topic: 'ai.rarog.app',
      },
      devices: {
        store: apnsPaired.store, pairing: createPairing({ store: apnsPaired.store, epoch: apnsConfig.epoch }),
        serverName: 'mac-fixtures', now: () => NOW,
      },
    }));
    await new Promise<void>((resolve, reject) => {
      apnsServer.once('error', reject);
      apnsServer.listen(0, '127.0.0.1', () => { apnsServer.removeListener('error', reject); resolve(); });
    });
    const apnsBase = `http://127.0.0.1:${String((apnsServer.address() as AddressInfo).port)}`;
    /** POST kluczem urządzenia do routera z kanałem APNs; ciało odpowiedzi tylko wtedy, gdy jest (204 go nie ma). */
    const apnsPost = async (route: string, body: unknown): Promise<Captured> => {
      const res = await fetch(`${apnsBase}${route}`, {
        method: 'POST',
        headers: { Authorization: apnsPaired.auth[0] ?? '', Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    };
    const apnsToken = 'a1b2c3d4'.repeat(8);
    const registration = {
      token: apnsToken, environment: 'development', label: 'iPad·Rarog', alerts: true, topic: 'ai.rarog.app',
    };
    try {
      // Token aktywności PRZED rejestracją urządzenia: 409 — apka rejestruje urządzenie i ponawia.
      produced.set('error.live-activity-unknown-device.json', await apnsPost('/api/push/live-activity', {
        deviceToken: apnsToken, activityId: 'B7E2C1D4-5A6F-4E3B-9C8D-0F1A2B3C4D5E', updateToken: '0f1e2d3c'.repeat(10),
      }));
      // Zapis i push próbny (204, bez ciała), potem status zarejestrowanego urządzenia.
      if ((await apnsPost('/api/push/apns', { ...registration, test: true })).status !== 204) {
        throw new Error('rejestracja APNs nie oddała 204');
      }
      produced.set('push.apns.status.registered.json', await apnsPost('/api/push/apns/status', { token: apnsToken }));
      // Drugi push próbny w tej samej minucie: 429, a zapis i tak się stał.
      produced.set('error.apns-test-throttled.json', await apnsPost('/api/push/apns', { ...registration, test: true }));
      // Trzy porażki prób z rzędu do tego tokenu → degradacja per token (baner degradacji w apce).
      for (let i = 0; i < 3; i += 1) devices.noteFailed(apnsToken);
      produced.set('push.apns.status.degraded.json', await apnsPost('/api/push/apns/status', { token: apnsToken }));
    } finally {
      liveActivity.close();
      apnsHub.closeAll();
      await new Promise<void>((resolve) => { apnsServer.close(() => { resolve(); }); });
      await apnsManager.dispose();
      await devices.flush();
      await apnsPaired.store.flush();
    }

    /*
     * Przekaźnik push bez klucza: PRAWDZIWY kanał (rejestr, nadajnik złożony, przepustki) z atrapą
     * przekaźnika zamiast sieci i stałym zegarem. Dwa wpisy apki Rarog: zamówienie przepustki pierwszego pada
     * (502 `apns-unreachable`) — wpis nie ma czym wysłać (`pass-missing`); drugiego przekaźnik odmawia (422
     * `BadDeviceToken` dla tokenu bez żadnego 200) — `env-mismatch`.
     */
    const relayDir = path.join(dataDir, 'przekaznik');
    const missingToken = 'b1c2d3e4'.repeat(8);
    const mismatchToken = 'c1d2e3f4'.repeat(8);
    const relayChannel = createApnsChannel(
      { pushEnabled: true, pushE2e: true, pushRelay: { origin: 'https://push.rarog.ai' }, dataDir: relayDir },
      {
        sessions: () => [], log: () => {}, mac: () => ({}), now: () => NOW, pairedDevices: { active: () => [] },
        limitsPoller: () => ({ current: () => ({}), weeklyWindows: () => [], close: () => {} }),
        relayFetch: (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { token: string };
          const reply = body.token === mismatchToken
            ? { status: 422, body: { v: 1, error: 'token-rejected', apnsStatus: 400, reason: 'BadDeviceToken' } }
            : { status: 502, body: { v: 1, error: 'apns-unreachable' } };
          return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
        },
      },
    );
    if (relayChannel?.passes === undefined) throw new Error('kanał z samym przekaźnikiem nie powstał');
    const relayPasses = relayChannel.passes;
    const relayManager: Manager = await createManager({
      demo: true, demoContent: demoContentPl, dataDir: relayDir, now: () => NOW,
    });
    await relayManager.ready;
    const relayConfig = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: relayDir });
    const relayPaired = pairedDevices(relayDir, relayConfig.epoch, 2);
    const relayHub = new SseHub({
      manager: relayManager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    });
    relayHub.start();
    const relayServer = http.createServer(createRouter({
      config: relayConfig, manager: relayManager, hub: relayHub, serverStartId: 'start-fixtures', startedAtMs: NOW,
      logger: silent, apns: relayChannel,
      devices: {
        store: relayPaired.store, pairing: createPairing({ store: relayPaired.store, epoch: relayConfig.epoch }),
        serverName: 'mac-fixtures', now: () => NOW,
      },
    }));
    await new Promise<void>((resolve, reject) => {
      relayServer.once('error', reject);
      relayServer.listen(0, '127.0.0.1', () => { relayServer.removeListener('error', reject); resolve(); });
    });
    const relayBase = `http://127.0.0.1:${String((relayServer.address() as AddressInfo).port)}`;
    /** POST kluczem `auth`-tego urządzenia z parowania. */
    const relayPost = async (route: string, body: unknown, auth = relayPaired.auth[0]): Promise<Captured> => {
      const res = await fetch(`${relayBase}${route}`, {
        method: 'POST',
        headers: { Authorization: auth ?? '', Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    };
    /** Zamówienie przepustki po odpowiedzi trasy — status czytamy dopiero, gdy się rozstrzygnie. */
    const settled = async (token: string): Promise<void> => {
      for (let i = 0; i < 200 && relayPasses.pending(token); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    try {
      // Najpierw odmowa: porażka całego przekaźnika (502) wstrzymuje kolejkę zamówień wspólnym odczekaniem.
      for (const [i, token] of [mismatchToken, missingToken].entries()) {
        const registered = await relayPost('/api/push/apns', {
          token, environment: 'development', label: 'iPhone·Rarog', alerts: true, topic: 'ai.rarog.app',
        }, relayPaired.auth[i]);
        if (registered.status !== 204) throw new Error('rejestracja przy przekaźniku nie oddała 204');
        await settled(token);
      }
      produced.set('push.apns.status.pass-missing.json', await relayPost('/api/push/apns/status', { token: missingToken }));
      produced.set('push.apns.status.env-mismatch.json', await relayPost('/api/push/apns/status', { token: mismatchToken }));
    } finally {
      relayPasses.close();
      relayChannel.liveActivity.close();
      relayChannel.sender.close();
      relayHub.closeAll();
      await new Promise<void>((resolve) => { relayServer.close(() => { resolve(); }); });
      await relayManager.dispose();
      await relayChannel.devices.flush();
      await relayPaired.store.flush();
    }

    /*
     * Klucze urządzeń i parowanie: prawdziwy magazyn `devices.json` w katalogu tymczasowym,
     * prawdziwe parowanie i prawdziwy router; zegar stały, a losowość deterministyczna (bajty kolejnych
     * wywołań wypełnione numerem wywołania), więc identyfikatory, sekrety i klucze push w plikach są
     * stałe. Kod `admin` wydaje się wprost (gniazdo administracyjne to nie ten kontrakt). Przebieg:
     * pierwsze urządzenie z kodu z Maca, drugie z kodu wydanego na pierwszym, lista, `me`, odmowy.
     */
    let deviceClock = NOW;
    const seeded = (): ((bytes: number) => Buffer) => {
      let call = 0;
      return (bytes) => { call += 1; return Buffer.alloc(bytes, call); };
    };
    const deviceDir = path.join(dataDir, 'urzadzenia');
    const deviceConfig = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: deviceDir });
    const deviceStore = createDeviceStore({
      dataDir: deviceDir, epoch: deviceConfig.epoch, now: () => deviceClock, random: seeded(),
    });
    const pairing = createPairing({
      store: deviceStore, epoch: deviceConfig.epoch, now: () => deviceClock, random: seeded(),
    });
    const deviceManager = new FakeManager([]);
    const deviceHub = new SseHub({
      manager: deviceManager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    });
    const deviceServer = http.createServer(createRouter({
      config: deviceConfig, manager: deviceManager, hub: deviceHub, serverStartId: 'start-fixtures',
      startedAtMs: NOW, logger: silent,
      devices: { store: deviceStore, pairing, serverName: 'mac-demo', now: () => deviceClock },
    }));
    await new Promise<void>((resolve, reject) => {
      deviceServer.once('error', reject);
      deviceServer.listen(0, '127.0.0.1', () => { deviceServer.removeListener('error', reject); resolve(); });
    });
    const deviceBase = `http://127.0.0.1:${String((deviceServer.address() as AddressInfo).port)}`;
    /** Żądanie z podanym poświadczeniem (nagłówek `Authorization` albo żaden); `Origin` przy mutacjach. */
    const deviceCall = async (
      method: 'GET' | 'POST', route: string, credential: Record<string, string>, body?: unknown,
    ): Promise<Captured> => {
      const res = await fetch(`${deviceBase}${route}`, {
        method,
        headers: { ...credential, ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json() as unknown };
    };
    try {
      const fromMac = pairing.issue('admin', deviceClock);
      const first = await deviceCall('POST', '/api/pair', {}, {
        v: 1, code: fromMac.code, label: 'iPhone·Rarog', build: '1700', pushFormats: [1, 2],
      });
      produced.set('pair.json', first);
      // Ten sam kod drugi raz: zużyty = jedno 404 dla złego, zużytego i przeterminowanego.
      produced.set('error.pair-unknown.json', await deviceCall('POST', '/api/pair', {}, {
        v: 1, code: fromMac.code, label: 'iPhone·Rarog',
      }));
      const firstBody = pairResponseSchema.parse(first.body);
      const asFirst = { Authorization: deviceAuthorization(firstBody.deviceId, firstBody.secret) };
      deviceClock += 60_000;
      const issued = await deviceCall('POST', '/api/pairings', asFirst, {});
      produced.set('pairings.json', issued);
      const second = pairResponseSchema.parse((await deviceCall('POST', '/api/pair', {}, {
        v: 1, code: pairingIssuedSchema.parse(issued.body).code, label: 'iPad·Rarog', build: '1700',
      })).body);
      const asSecond = { Authorization: deviceAuthorization(second.deviceId, second.secret) };
      deviceClock += 60_000;
      // Lista z pierwszego: on sam (`current`), drugi jeszcze bez żadnego żądania (`lastSeenAt: null`).
      produced.set('devices.json', await deviceCall('GET', '/api/devices', asFirst));
      produced.set('devices.me.json', await deviceCall('GET', '/api/devices/me', asSecond));
      produced.set('error.device-unknown.json', await deviceCall('GET', '/api/devices', {
        Authorization: deviceAuthorization('f'.repeat(32), 'Z'.repeat(43)),
      }));
      deviceClock += 60_000;
      deviceStore.revoke(second.deviceId, 'admin', deviceClock);
      produced.set('error.device-revoked.json', await deviceCall('GET', '/api/devices', asSecond));
      /*
       * 403 `device-required` (trasy `/api/pairings`, `/api/devices*` i rejestracja tokenu APNs bez klucza
       * urządzenia): bramka poświadczeń przepuszcza wyłącznie urządzenia, więc żadne żądanie HTTP tej odmowy nie
       * wywoła i zostaje ona zabezpieczeniem typu. Ciało składa to samo zdanie, które wysyłają trasy
       * (`say('rest.device-required')`, pilnuje tego `sentences-rest.test.ts`), w kształcie ciała błędu routera:
       * test niżej porównuje klucze z `error.device-unknown.json`, które produkuje prawdziwa trasa.
       */
      const required = say('rest.device-required');
      const requiredBody = { error: DEVICE_REQUIRED_ERROR, message: required.text, messageRef: required.ref };
      produced.set('error.device-required.json', { status: 403, body: JSON.parse(JSON.stringify(requiredBody)) as unknown });
    } finally {
      deviceHub.closeAll();
      await new Promise<void>((resolve) => { deviceServer.close(() => { resolve(); }); });
      await deviceStore.flush();
    }

    /*
     * Tryb recenzji demo: prawdziwy router z kodem recenzenta (losowanym w biegu, poza plikami)
     * i magazynem w katalogu tymczasowym. Dziesięć urządzeń z kodu recenzenta wypełnia sufit, jedenaste parowanie
     * daje 429 `demo-review-full`. 403 `demo-review` wysyła bramka klas tras trybu recenzji na `POST /api/pairings`
     * z kluczem pierwszego urządzenia.
     */
    const reviewOrigin = 'https://demo.rarog.example';
    const reviewCode = randomBytes(32).toString('base64url');
    const reviewDir = path.join(dataDir, 'urzadzenia-recenzja');
    const reviewConfig = loadConfig({
      RAROG_DEMO: '1', RAROG_DEMO_REVIEW_CODE: reviewCode, RAROG_DATA_DIR: reviewDir, RAROG_ORIGINS: reviewOrigin,
    });
    const reviewStore = createDeviceStore({ dataDir: reviewDir, epoch: reviewConfig.epoch, now: () => NOW });
    const reviewPairing = createPairing({ store: reviewStore, epoch: reviewConfig.epoch, now: () => NOW });
    const reviewHub = new SseHub({
      manager: deviceManager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    });
    const reviewServer = http.createServer(createRouter({
      config: reviewConfig, manager: deviceManager, hub: reviewHub, serverStartId: 'start-fixtures',
      startedAtMs: NOW, logger: silent,
      devices: { store: reviewStore, pairing: reviewPairing, serverName: 'demo', now: () => NOW },
    }));
    await new Promise<void>((resolve) => { reviewServer.listen(0, '127.0.0.1', resolve); });
    const reviewPair = async (label: string): Promise<Captured> => {
      const res = await fetch(`http://127.0.0.1:${String((reviewServer.address() as AddressInfo).port)}/api/pair`, {
        method: 'POST',
        headers: { Origin: reviewOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, code: reviewCode, label, build: '1700' }),
      });
      return { status: res.status, body: await res.json() as unknown };
    };
    try {
      const paired: Captured[] = [];
      for (let i = 0; i < DEMO_REVIEW_MAX_DEVICES; i += 1) {
        paired.push(await reviewPair(`iPhone·${String(i)}`));
        if (paired.at(-1)?.status !== 200) throw new Error('kod recenzenta nie sparował');
      }
      produced.set('error.demo-review-full.json', await reviewPair('iPhone·Rarog'));
      const first = paired[0]?.body as { deviceId: string; secret: string };
      const refused = await fetch(`http://127.0.0.1:${String((reviewServer.address() as AddressInfo).port)}/api/pairings`, {
        method: 'POST',
        headers: {
          Origin: reviewOrigin, 'Content-Type': 'application/json',
          Authorization: deviceAuthorization(first.deviceId, first.secret),
        },
        body: '{}',
      });
      produced.set('error.demo-review.json', { status: refused.status, body: await refused.json() as unknown });
    } finally {
      reviewHub.closeAll();
      await new Promise<void>((resolve) => { reviewServer.close(() => { resolve(); }); });
      await reviewStore.flush();
    }

    /*
     * Parowanie z serwerem z nasłuchem iroh: osobny magazyn i parowanie z tą samą losowością i zegarem
     * co `pair.json` wyżej, więc identyfikatory i sekrety wychodzą te same, a `server.iroh` niesie stałą parę.
     */
    const irohDeviceDir = path.join(dataDir, 'urzadzenia-iroh');
    const irohDeviceStore = createDeviceStore({
      dataDir: irohDeviceDir, epoch: deviceConfig.epoch, now: () => NOW, random: seeded(),
    });
    const irohPairing = createPairing({ store: irohDeviceStore, epoch: deviceConfig.epoch, now: () => NOW, random: seeded() });
    const irohDeviceHub = new SseHub({
      manager: deviceManager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    });
    const irohDeviceServer = http.createServer(createRouter({
      config: deviceConfig, manager: deviceManager, hub: irohDeviceHub, serverStartId: 'start-fixtures',
      startedAtMs: NOW, logger: silent, iroh: FIXTURE_IROH,
      devices: { store: irohDeviceStore, pairing: irohPairing, serverName: 'mac-demo', now: () => NOW },
    }));
    await new Promise<void>((resolve) => { irohDeviceServer.listen(0, '127.0.0.1', resolve); });
    try {
      const res = await fetch(`http://127.0.0.1:${String((irohDeviceServer.address() as AddressInfo).port)}/api/pair`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          v: 1, code: irohPairing.issue('admin', NOW).code, label: 'iPhone·Rarog', build: '1700', pushFormats: [1, 2],
        }),
      });
      produced.set('pair.iroh.json', { status: res.status, body: await res.json() as unknown });
    } finally {
      irohDeviceHub.closeAll();
      await new Promise<void>((resolve) => { irohDeviceServer.close(() => { resolve(); }); });
      await irohDeviceStore.flush();
    }

    /*
     * Terminal: prawdziwy rejestr z backendem panelowym nad atrapą gniazda
     * herdr (`fake-term-herdr.ts`), za prawdziwym routerem — odmowy, sloty i listę produkuje kod
     * serwera. Jedyny szew to `realPath` rejestru (ten sam, którym wstrzykują go testy rejestru):
     * katalog tymczasowy projektu widzi rejestr jako `/Users/demo/Projects/rarog`, więc `cwd`
     * i id (`sha256` realpath) są w plikach stałe, a router dalej sprawdza PRAWDZIWY katalog
     * bramką `RAROG_PROJECT_ROOTS`. Trzy rejestry różnią się wyłącznie killswitchami herdr.
     */
    const termRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rarog-rest-term-')));
    const termProject = path.join(termRoot, 'rarog');
    await mkdir(termProject);
    const demoProjects = '/Users/demo/Projects';
    const termRealPath = (candidate: string): string => realpathSync(candidate).replace(termRoot, demoProjects);
    const termConfig = (launch: '0' | '1', send: '0' | '1'): ReturnType<typeof loadConfig> => loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: termRoot, RAROG_TERM: '1',
      RAROG_HERDR_LAUNCH: launch, RAROG_HERDR_SEND: send, RAROG_HERDR_BIN: '/usr/bin/true',
      RAROG_DATA_DIR: path.join(termRoot, '.dane'), HOME: termRoot, PATH: '/usr/bin:/bin', TMPDIR: termRoot,
    });
    const herdr = new FakeHerdr({ text: '$ ls\nREADME.md  docs  native\n', truncated: true });
    const termRegistry = (launch: '0' | '1', send: '0' | '1'): TermRegistry => {
      const config = termConfig(launch, send);
      const backend = createTermBackend(config, {
        logger: silent, herdrLaunchClient: () => herdr, herdrSpawn: () => new FakeController(),
      });
      return new TermRegistry({ config, logger: silent, backend, realPath: termRealPath });
    };
    const registries = { live: termRegistry('1', '1'), launchOff: termRegistry('0', '1'), sendOff: termRegistry('1', '0') };
    let registry = registries.live;
    // Fasada ficzeru nad wybranym rejestrem: router jest jeden, killswitch przełącza test.
    const term: TermFeature = {
      enabled: true,
      ready: Promise.resolve(),
      open: (cwd, slot, role) => registry.open(cwd, slot, role),
      list: () => registry.list(),
      close: (id) => registry.close(id),
      history: async (id, lines) => await registry.history(id, lines),
      handleUpgrade: () => { /* WS ma własnego producenta: `term-fixtures-producenci.test.ts` */ },
      closeOwner: () => 0,
      dispose: () => { for (const each of Object.values(registries)) each.dispose(); },
    };
    const termManager = new FakeManager([]);
    const termHub = new SseHub({
      manager: termManager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    });
    const termRouterConfig = termConfig('1', '1');
    const termDevice = createTestDevice(termRouterConfig.dataDir, { epoch: termRouterConfig.epoch, now: () => NOW });
    const termServer = http.createServer(createRouter({
      config: termRouterConfig,
      manager: termManager, hub: termHub, serverStartId: 'start-fixtures', startedAtMs: NOW, logger: silent, term,
      devices: termDevice.identity,
    }));
    await new Promise<void>((resolve, reject) => {
      termServer.once('error', reject);
      termServer.listen(0, '127.0.0.1', () => { termServer.removeListener('error', reject); resolve(); });
    });
    const termBase = `http://127.0.0.1:${String((termServer.address() as AddressInfo).port)}`;
    const termCall = async (method: 'GET' | 'POST', route: string, body?: unknown): Promise<Captured> => {
      const res = await fetch(`${termBase}${route}`, {
        method,
        headers: {
          ...termDevice.headers,
          ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json() as unknown };
    };
    try {
      // Pierwszy terminal projektu: samo `{cwd}` = slot 1 powłoki (zgodność wstecz).
      const opened = await termCall('POST', '/api/term', { cwd: termProject });
      produced.set('term.open.json', opened);
      // Popup lazygita (Cmd+G) i drugi tab „Nowy terminal" (`next`): lista z rolą i slotem 0 popupu.
      await termCall('POST', '/api/term', { cwd: termProject, role: 'lazygit' });
      await termCall('POST', '/api/term', { cwd: termProject, slot: 'next' });
      /*
       * `proc` czyta backend W TLE, po odpowiedzi (`GET /api/term` nie czeka na herdr): pierwsza
       * lista niesie `''`. Kolejne odczyty, aż każdy wpis zna nazwę procesu z atrapy.
       */
      let list = await termCall('GET', '/api/term');
      for (let round = 0; round < 50; round += 1) {
        const entries = (list.body as { terminals: { proc: string }[] }).terminals;
        if (entries.every((entry) => entry.proc !== '')) break;
        await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
        list = await termCall('GET', '/api/term');
      }
      produced.set('term.list.json', list);
      const id = (opened.body as { id: string }).id;
      produced.set('term.history.json', await termCall('GET', `/api/term/${id}/history?lines=2`));
      // Dwa kolejne `next` zajmują sloty 3 i 4; piąty to 409 `term-limit` ze zdaniem rejestru.
      await termCall('POST', '/api/term', { cwd: termProject, slot: 'next' });
      await termCall('POST', '/api/term', { cwd: termProject, slot: 'next' });
      produced.set('error.term-limit.json', await termCall('POST', '/api/term', { cwd: termProject, slot: 'next' }));
      // Killswitche herdr (środowisko serwera): odmowa backendu PRZED czymkolwiek, 409 z kodem.
      registry = registries.launchOff;
      produced.set('error.term-herdr-launch-off.json', await termCall('POST', '/api/term', { cwd: termProject }));
      registry = registries.sendOff;
      produced.set('error.term-herdr-send-off.json', await termCall('POST', '/api/term', { cwd: termProject }));
    } finally {
      term.dispose();
      termHub.closeAll();
      await new Promise<void>((resolve) => { termServer.close(() => { resolve(); }); });
      await rm(termRoot, { recursive: true, force: true });
    }

    /*
     * Creating a directory: a router without the demo (the demo creates nothing) over a project in a temporary root,
     * with the real child process of `fs-mkdir.ts`. The temporary root reads `/Users/demo/Projects` in the stored
     * bodies, so the paths are the same on every run. The listing comes first, so it does not list the new directory;
     * the second request for the same name is the 409.
     */
    const mkdirRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rarog-rest-mkdir-')));
    const mkdirProject = path.join(mkdirRoot, 'rarog');
    await mkdir(path.join(mkdirProject, '.git'), { recursive: true });
    await mkdir(path.join(mkdirProject, 'docs'));
    const mkdirConfig = loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: mkdirRoot, RAROG_HERDR_LAUNCH: '1', RAROG_HERDR_SEND: '1',
      RAROG_HERDR_BIN: '/usr/bin/true', RAROG_DATA_DIR: path.join(mkdirRoot, '.dane'), HOME: mkdirRoot,
      PATH: '/usr/bin:/bin', TMPDIR: mkdirRoot,
    });
    const mkdirManager = new FakeManager([]);
    const mkdirHub = new SseHub({
      manager: mkdirManager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    });
    const mkdirDevice = createTestDevice(mkdirConfig.dataDir, { epoch: mkdirConfig.epoch, now: () => NOW });
    const mkdirServer = http.createServer(createRouter({
      config: mkdirConfig, manager: mkdirManager, hub: mkdirHub, serverStartId: 'start-fixtures', startedAtMs: NOW,
      logger: silent, devices: mkdirDevice.identity,
    }));
    await new Promise<void>((resolve, reject) => {
      mkdirServer.once('error', reject);
      mkdirServer.listen(0, '127.0.0.1', () => { mkdirServer.removeListener('error', reject); resolve(); });
    });
    const mkdirBase = `http://127.0.0.1:${String((mkdirServer.address() as AddressInfo).port)}`;
    const mkdirCall = async (route: string, body?: unknown): Promise<Captured> => {
      const res = await fetch(`${mkdirBase}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...mkdirDevice.headers,
          ...(body === undefined ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: JSON.parse((await res.text()).split(mkdirRoot).join(demoProjects)) as unknown };
    };
    try {
      produced.set('fs.dir.can-create.json', await mkdirCall(`/api/fs?path=${encodeURIComponent(mkdirProject)}`));
      produced.set('fs.mkdir.json', await mkdirCall('/api/fs/mkdir', { parent: mkdirProject, name: 'notatki' }));
      produced.set('error.dir-exists.json', await mkdirCall('/api/fs/mkdir', { parent: mkdirProject, name: 'notatki' }));
    } finally {
      mkdirHub.closeAll();
      await new Promise<void>((resolve) => { mkdirServer.close(() => { resolve(); }); });
      await rm(mkdirRoot, { recursive: true, force: true });
    }

    /*
     * Agent głosowy: prawdziwy router i prawdziwy moduł pytań (`createCompanionFeature`: parser odpowiedzi,
     * maska sekretów, mapowanie wyników na statusy) nad atrapą wywołania `claude -p` (bez procesu i sieci)
     * i managerem-atrapą z bieżącą rozmową silnika. Demo trasy nie ma, więc osobny serwer z flagą `1`,
     * a odpowiedź serwera z flagą `0` daje drugi router na tym samym managerze.
     */
    const companionRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'rarog-rest-companion-')));
    const companionConfig = (flag: '0' | '1', sessions = false): ReturnType<typeof loadConfig> => loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: companionRoot, RAROG_DATA_DIR: path.join(companionRoot, '.dane'),
      // The voice agent speaks only with the Soniox voice: the short-lived key route needs the Soniox key too.
      RAROG_COMPANION: flag, OPENAI_API_KEY: COMPANION_SECRET, SONIOX_API_KEY: SONIOX_SECRET,
      ...(sessions ? { RAROG_COMPANION_SESSIONS: '1' } : {}),
    });
    const companionManager = new FakeManager([makeSummary({ id: 's1', cwd: path.join(companionRoot, 'rarog') })]);
    companionManager.conversations.set('s1', COMPANION_CONVERSATION);
    const noLimit = { utilization: 0.4, exhausted: false } as const;
    let companionOutcome: AskOutcome = { ok: true, text: '', limit: noLimit, ms: 1 };
    const companionCli: CompanionCli = { running: 0, ask: () => Promise.resolve(companionOutcome) };
    const companion = createCompanionFeature({ cli: companionCli, locate: () => Promise.resolve(null), log: () => {} });
    const companionHub = new SseHub({
      manager: companionManager, serverStartId: 'start-fixtures', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    });
    const companionDevice = createTestDevice(companionConfig('1').dataDir, {
      epoch: companionConfig('1').epoch, now: () => NOW,
    });
    const companionServers = (['1', '0'] as const).map((flag) => http.createServer(createRouter({
      config: companionConfig(flag), manager: companionManager, hub: companionHub, serverStartId: 'start-fixtures',
      startedAtMs: NOW, logger: silent, devices: companionDevice.identity, companion,
    })));
    /*
     * Voice agent across sessions: the real route and turns reader over a synthetic conversation file (a turn, a task
     * notification, a blocked prompt, a turn), the token under a fixed key and a fixed clock, so every run writes the
     * same file. The session catalog takes the same token function, so its row of `s1` carries the turns file's token.
     * `system` is fixed for the version file, as the demo gives it.
     */
    const turnsFile = path.join(companionRoot, `${COMPANION_CONVERSATION}.jsonl`);
    writeFileSync(turnsFile, turnLines(1) + noticeLine('Background command finished', 2) + blockedLine('drop the cache', 3)
      + turnLines(4));
    const fixedToken = conversationTokens(new Uint8Array(32).fill(7));
    const sessionsServer = http.createServer(createRouter({
      config: companionConfig('1', true), manager: companionManager, hub: companionHub, serverStartId: 'start-fixtures',
      startedAtMs: NOW, logger: silent, devices: companionDevice.identity, companion, system: 'macos',
      companionTurns: createCompanionTurns({
        locate: () => Promise.resolve(turnsFile), promptBlock: true, token: fixedToken,
        now: () => new Date(NOW).toISOString(),
      }),
      conversationToken: fixedToken,
    }));
    for (const server of [...companionServers, sessionsServer]) {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    }
    const companionGet = async (server: http.Server, route: string): Promise<Captured> => {
      const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}${route}`, {
        headers: companionDevice.headers,
      });
      return { status: res.status, body: await res.json() as unknown };
    };
    const companionAsk = async (server: http.Server): Promise<Captured> => {
      const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
        + '/api/sessions/s1/companion/ask', {
        method: 'POST',
        headers: { ...companionDevice.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Why did the test fail?', clientRequestId: COMPANION_REQUEST_ID }),
      });
      return { status: res.status, body: await res.json() as unknown };
    };
    try {
      const [enabled, disabled] = companionServers;
      if (enabled === undefined || disabled === undefined) throw new Error('companion servers missing');
      // Sesja zna odpowiedź: bez `prompt`.
      companionOutcome = {
        ok: true, limit: noLimit, ms: 1,
        text: '<answer>The test failed because a fixture was missing.</answer><found>yes</found><prompt></prompt>',
      };
      produced.set('companion.ask.json', await companionAsk(enabled));
      // Sesja jej nie zna: gotowy prompt dla agenta, a klucz w odpowiedzi przechodzi przez maskę.
      companionOutcome = {
        ok: true, limit: noLimit, ms: 1,
        text: '<answer>The session does not say which key the deploy uses.</answer><found>no</found>'
          + `<prompt>Check the deploy key, the old one was ${COMPANION_SECRET}.</prompt>`,
      };
      produced.set('companion.ask.prompt.json', await companionAsk(enabled));
      companionOutcome = {
        ok: false, code: 'companion-limit', reason: 'rate-limit', limit: { utilization: 1, exhausted: true }, ms: 1,
      };
      produced.set('error.companion-limit.json', await companionAsk(enabled));
      produced.set('error.companion-disabled.json', await companionAsk(disabled));
      const turns = '/api/sessions/s1/companion/turns?count=2';
      produced.set('companion.turns.json', await companionGet(sessionsServer, turns));
      produced.set('error.companion-sessions-disabled.json', await companionGet(enabled, turns));
      produced.set('version.companion-sessions.json', await companionGet(sessionsServer, '/api/version'));
      /*
       * The session catalog: `s1` waits for input after an answer that asks the owner, a second Claude Code session in
       * its turn has no `asksOwner`, and a Codex session gets no row. Added after the turns files, which they leave
       * as they are.
       */
      const s1 = companionManager.sessions.get('s1');
      if (s1 === undefined) throw new Error('companion session s1 missing');
      companionManager.sessions.set('s1', { ...s1, state: 'waiting-input', stateSince: new Date(NOW - 60_000).toISOString() });
      companionManager.lastMessages.set('s1', {
        seq: 4, role: 'assistant', at: new Date(NOW - 60_000).toISOString(),
        blocks: [{ type: 'text', text: 'Done.\n\n**To you:** merge the branch now or wait for the review?' }],
      });
      companionManager.sessions.set('s2', makeSummary({
        id: 's2', cwd: path.join(companionRoot, 'site'), state: 'running', stateSince: new Date(NOW - 5_000).toISOString(),
      }));
      companionManager.conversations.set('s2', '33333333-3333-4333-8333-333333333333');
      companionManager.sessions.set('cx', makeSummary({ id: 'cx', cwd: path.join(companionRoot, 'rarog'), engine: 'codex' }));
      produced.set('companion.sessions.json', await companionGet(sessionsServer, '/api/companion/sessions'));
      /*
       * A send from the voice agent whose session moved to another conversation after the agent read it: the
       * manager's own refusal (the check right before the driver gets the text) behind the real gate of the mode,
       * answered by the real router.
       */
      const realCompanionSend = companionManager.sendMessage.bind(companionManager);
      companionManager.sendMessage = () => Promise.reject(new BadStateError(say('session.conversation-changed')));
      const sent = await fetch(`http://127.0.0.1:${String((sessionsServer.address() as AddressInfo).port)}`
        + '/api/sessions/s1/messages', {
        method: 'POST',
        headers: { ...companionDevice.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Run the tests again.', source: 'voice-agent', expectedConversation: fixedToken(COMPANION_CONVERSATION),
        }),
      });
      produced.set('error.conversation-changed.json', { status: sent.status, body: await sent.json() as unknown });
      companionManager.sendMessage = realCompanionSend;
      // The voice agent's pick-up of a result it did not read: the manager's refusal behind the real gate of the mode.
      const realMarkSeen = companionManager.markSeen.bind(companionManager);
      companionManager.markSeen = () => { throw new BadStateError(say('session.seen-result-changed')); };
      const picked = await fetch(`http://127.0.0.1:${String((sessionsServer.address() as AddressInfo).port)}`
        + '/api/sessions/s1/seen', {
        method: 'POST',
        headers: { ...companionDevice.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          by: 'voice-agent', stateSince: new Date(NOW - 120_000).toISOString(),
          conversation: fixedToken(COMPANION_CONVERSATION),
        }),
      });
      produced.set('error.seen-result-changed.json', { status: picked.status, body: await picked.json() as unknown });
      companionManager.markSeen = realMarkSeen;

      /*
       * Short-lived OpenAI key: the real minter over a `fetch` stand-in (no network),
       * a fresh minter per case, so the throttle of one case does not answer the next.
       */
      const tokenFrom = async (reply: Awaited<ReturnType<CompanionTokenFetch>>, twice = false): Promise<Captured> => {
        const companionToken = createCompanionTokenMinter({
          config: companionConfig('1'), now: () => NOW, log: () => {},
          fetchImpl: () => Promise.resolve(reply),
        });
        const server = http.createServer(createRouter({
          config: companionConfig('1'), manager: companionManager, hub: companionHub, serverStartId: 'start-fixtures',
          startedAtMs: NOW, logger: silent, devices: companionDevice.identity, companion, companionToken,
        }));
        await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
        try {
          const post = (): Promise<Response> => fetch(
            `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/companion/token`, {
              method: 'POST', body: '{}',
              headers: { ...companionDevice.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
            },
          );
          if (twice) await (await post()).arrayBuffer();
          const res = await post();
          return { status: res.status, body: await res.json() as unknown };
        } finally {
          await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
        }
      };
      const openai = (status: number, body: unknown = {}): Awaited<ReturnType<CompanionTokenFetch>> => ({
        status, json: () => Promise.resolve(body),
      });
      const minted = openai(200, { value: COMPANION_EPHEMERAL, expires_at: NOW / 1000 + 60 });
      produced.set('companion.token.json', await tokenFrom(minted));
      produced.set('error.companion-throttled.json', await tokenFrom(minted, true));
      produced.set('error.companion-openai-key.json', await tokenFrom(openai(401)));
      produced.set('error.companion-openai-limit.json', await tokenFrom(openai(429)));
      produced.set('error.companion-openai.json', await tokenFrom(openai(500)));

      /*
       * Temporary Soniox speech key: the real minter kind over a `fetch` stand-in, a fresh minter per case, as
       * for the OpenAI key.
       */
      const speechFrom = async (reply: Awaited<ReturnType<FetchLike>>, twice = false): Promise<Captured> => {
        const companionSpeechToken = createVoiceMinter({
          apiKey: SONIOX_SECRET, minIntervalMs: VOICE_TOKEN_MIN_INTERVAL_MS, hourlyCap: VOICE_TOKEN_HOURLY_CAP,
          now: () => NOW, randomId: () => 'fixture', fetchImpl: () => Promise.resolve(reply),
        }, COMPANION_SPEECH_KEY);
        const server = http.createServer(createRouter({
          config: companionConfig('1'), manager: companionManager, hub: companionHub, serverStartId: 'start-fixtures',
          startedAtMs: NOW, logger: silent, devices: companionDevice.identity, companion, companionSpeechToken,
        }));
        await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
        try {
          const post = (): Promise<Response> => fetch(
            `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/companion/speech-token`, {
              method: 'POST', body: '{}',
              headers: { ...companionDevice.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
            },
          );
          if (twice) await (await post()).arrayBuffer();
          const res = await post();
          return { status: res.status, body: await res.json() as unknown };
        } finally {
          await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
        }
      };
      const soniox = (status: number, body: unknown = {}): Awaited<ReturnType<FetchLike>> => ({
        status, json: () => Promise.resolve(body),
      });
      const speechKey = soniox(201, { api_key: SPEECH_TEMPORARY, expires_at: new Date(NOW + 600_000).toISOString() });
      produced.set('companion.speech-token.json', await speechFrom(speechKey));
      produced.set('error.companion-speech-throttled.json', await speechFrom(speechKey, true));
      produced.set('error.companion-speech-unconfigured.json', await speechFrom(soniox(401)));
      produced.set('error.companion-speech-upstream.json', await speechFrom(soniox(500)));
    } finally {
      for (const server of [...companionServers, sessionsServer]) {
        await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      }
      companionHub.closeAll();
      await rm(companionRoot, { recursive: true, force: true });
    }

    // Mac bez e-maila w `~/.claude.json` i ze starym zrzutem: liczby z `stale`, bez pola `account`.
    const noAccountRoot = path.join(dataDir, 'statusline-bez-konta');
    await mkdir(noAccountRoot, { recursive: true });
    const noAccountDump = path.join(noAccountRoot, 'sesja.json');
    await writeFile(noAccountDump, statuslineDump(41, 63));
    const dumpAt = new Date('2026-10-04T09:58:00.000Z');
    await utimes(noAccountDump, dumpAt, dumpAt);
    const cli = createUsageProvider({
      statuslineRoot: noAccountRoot, claudeJsonPath: path.join(dataDir, 'brak-claude.json'),
      now: () => dumpAt.getTime() + STALE_LATER_MS,
    });
    produced.set('usage.cli.json', { status: 200, body: await cli.get() });

    if (!WRITE) return;
    for (const [name, captured] of produced) {
      writeFileSync(path.join(FIXTURES_DIR, name), serialize(captured.body));
    }
  }, 60_000);

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serwer z nasłuchem iroh: `version.iroh.json` i `pair.iroh.json` różnią się od bazowych tylko polem `iroh`', () => {
    const version = produced.get('version.iroh.json')?.body as Record<string, unknown>;
    expect(version['iroh']).toEqual(FIXTURE_IROH);
    expect({ ...version, iroh: null }).toEqual(produced.get('version.json')?.body);
    const pair = produced.get('pair.iroh.json')?.body as { server: Record<string, unknown> };
    expect(pair.server['iroh']).toEqual(FIXTURE_IROH);
    expect({ ...pair, server: { ...pair.server, iroh: null } }).toEqual(produced.get('pair.json')?.body);
  });

  it('403 `device-required`: zdanie rejestru z `messageRef`, klucze jak ciało błędu z prawdziwej trasy', () => {
    const required = produced.get('error.device-required.json')?.body as Record<string, unknown>;
    expect(required).toEqual({
      error: 'device-required', message: say('rest.device-required').text, messageRef: { code: 'rest.device-required' },
    });
    const unknown = produced.get('error.device-unknown.json')?.body as Record<string, unknown>;
    expect(Object.keys(required)).toEqual(Object.keys(unknown));
  });

  it('kod produkuje dokładnie te odpowiedzi, które zna manifest (bez plików zamrożonych)', () => {
    expect([...produced.keys()].sort()).toEqual(producedNames);
    for (const name of FROZEN) expect(manifest[name], name).toBeDefined();
  });

  it.each(producedNames)('%s: status z manifestu i ścisły schemat bez strat', (name) => {
    const entry = manifest[name];
    const captured = produced.get(name);
    expect(entry, name).toBeDefined();
    expect(captured, `${name}: kod przestał produkować tę odpowiedź`).toBeDefined();
    if (entry === undefined || captured === undefined) return;
    expect(captured.status).toBe(entry.status);
    const schema = SCHEMAS[entry.schema];
    expect(schema, `${name}: nieznany schemat ${entry.schema}`).toBeDefined();
    expect(schema?.parse(captured.body)).toEqual(captured.body);
  });

  it.each(producedNames)('%s = to, co dziś produkuje kod (odśwież: RAROG_FIXTURES_WRITE=1)', (name) => {
    const stored = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as unknown;
    expect(produced.get(name)?.body).toEqual(stored);
  });
});
