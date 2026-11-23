/**
 * Wiersz Codexa: manager i API.
 *
 * Filtr wejściowy i nadzorca mają własne pliki (`herdr-client`, `herdr-supervisor`). Tutaj
 * zaczyna się to, czego tamte nie widzą: wpis `engine: 'codex'` staje się KARTĄ, a karta ma
 * dawać dokładnie jedną rzecz — STAN. Każdy test w tym pliku pilnuje jednej granicy, którą da
 * się złamać jedną linijką, a której ceną jest albo cudzy proces, albo cicha awaria listy:
 *
 * - uuid Codexa NIE jest tożsamością wznowienia (indeks pisarzy jsonl zostaje pusty, także
 *   po `/new` w panelu) — inaczej wpis Codexa zablokowałby wznowienie sesji Claude o tym uuid;
 * - wysyłka, model, wznowienie, odpowiedź na pytanie i `tab.close` odmawiają NA SERWERZE,
 *   a nie w copy PWA — stara, otwarta od wczoraj zakładka wysyła to, co umiała wczoraj;
 * - znacznik „obejrzane" przeżywa restart Raroga, choć adresuje go pole INNE niż dla Claude;
 * - `done`/`blocked` Codexa jadą tą samą polityką powiadomień co reszta;
 * - `termId` jedzie na drut wyłącznie przy włączonym terminalu (nigdy martwy przycisk);
 * - zniknięcie panelu Codexa ZDEJMUJE kartę (nie ma czego wznawiać).
 *
 * Atrapy nadzorcy i drivera są własne i minimalne (zero gniazda, zero procesów, zero `~/.claude`).
 * Router dostaje PRAWDZIWEGO managera — kody 400/409/202 są tu kontraktem z telefonem, a on
 * powstaje dopiero ze złożenia bramki managera z mapowaniem błędów routera.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION, sessionSummarySchema } from '@rarog/shared';
import type {
  HerdrStatus, ResumableSession, ServerEvent, SessionSummary,
} from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { createManager } from '../src/sessions/manager.ts';
import {
  HERDR_CODEX_CLOSE_MESSAGE, HERDR_CODEX_GIT_MESSAGE, HERDR_GONE_DETAIL, HERDR_OUT_OF_SCOPE_MESSAGE,
  HERDR_RESUME_MESSAGE,
} from '../src/sessions/state-sentences.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { parseAgentList } from '../src/herdr/client.ts';
import { classify, kindOf } from '../src/notify/policy.ts';
import { buildContent } from '../src/notify/content.ts';
import { apnsAlertRequestE2e } from '../src/notify/apns-payload.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import type { NoteInput, NotifierLike } from '../src/notify/index.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const PROJECT = '/Users/u/Projects/atlas';
const KEY = 'w9:p72';
/** Uuid rollouta Codexa z pomiaru (UUID v7 z `agent_session.value`). */
const CODEX_SESSION = '0198f0c4-1f2a-7c31-9a44-6f2b5d0e7a10';
/** Ten sam panel po `/new` w Codexie — NOWY rollout, ta sama karta. */
const CODEX_SESSION_2 = '0198f0c4-9b71-7f02-8c19-4d7e3a115c88';
const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';
/** Wartość tokenu `rarog-term` — 16 znaków hex, czyli kształt z `TERM_ID_RE`. */
const TERM_ID = '0123456789abcdef';

const ORIGIN = 'http://localhost:8930';

// ---------------------------------------------------------------------------
// Atrapy
// ---------------------------------------------------------------------------

/**
 * Driver przypięty do cudzego panelu.
 *
 * `sendCommands` istnieje CELOWO, choć dla Codexa nigdy nie zadziała: bez niej `setModel`
 * odmawiałby wcześniejszą bramką („Model ustawiasz przy zakładaniu sesji") i test dostawałby
 * właściwy kod z niewłaściwego powodu — czyli przechodziłby także po usunięciu bramki, która trzyma wpis Codexa jako
 * sam stan.
 */
class FakeDriver extends AtrapaDrivera {
  readonly commands: string[][] = [];

  override send(): void {
    throw new Error('do panelu Codexa nic nie ma prawa pójść');
  }

  sendCommands(commands: readonly string[]): void {
    this.commands.push([...commands]);
  }
}

class FakeSupervisor extends AtrapaNadzorcy<FakeDriver> {
  readonly live = new Map<string, HerdrAgent>();
  readonly focusCalls: string[] = [];
  readonly closeTabCalls: string[] = [];

  override status(): HerdrStatus {
    return { available: true, agentCount: this.live.size, readOnly: false, canLaunch: true };
  }

  protected nowyDriver(key: string): FakeDriver {
    return new FakeDriver(key);
  }

  override async focus(key: string): Promise<void> {
    this.focusCalls.push(key);
  }

  override async closeTab(key: string): Promise<void> {
    this.closeTabCalls.push(key);
  }

  // --- sterowanie z testu ---

  appear(agent: HerdrAgent): void {
    this.live.set(agent.key, agent);
    this.lifecycle.push({ type: 'appeared', agent });
  }

  reattach(agent: HerdrAgent): void {
    this.live.set(agent.key, agent);
    this.lifecycle.push({ type: 're-attached', agent });
  }

  gone(key: string): void {
    this.live.delete(key);
    this.lifecycle.push({ type: 'gone', key });
  }

  termChanged(agent: HerdrAgent): void {
    this.live.set(agent.key, agent);
    this.lifecycle.push({ type: 'term-changed', agent });
  }
}

/** Znaczniki „widziane z telefonu" — w produkcji plik, tutaj mapa PRZEŻYWAJĄCA restart managera. */
type SeenMarks = Map<string, { agentSessionId: string; stateChangeSeq: number; unseen?: true }>;

function makeDeps(seenMarks: SeenMarks = new Map()): HerdrManagerDeps {
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    seen: {
      seq: (key, engine) => {
        const mark = seenMarks.get(key);
        return mark?.agentSessionId === engine && mark.unseen !== true ? mark.stateChangeSeq : undefined;
      },
      mark: (key, engine, stateChangeSeq) => {
        seenMarks.set(key, { agentSessionId: engine, stateChangeSeq });
      },
      // The voice agent does not pick up a Codex session.
      seenBy: () => undefined,
      // Ręczne „nieprzeczytane": ten sam wpis z flagą, jak w `herdr-hidden.json`.
      unseenSeq: (key, engine) => {
        const mark = seenMarks.get(key);
        return mark?.agentSessionId === engine && mark.unseen === true ? mark.stateChangeSeq : undefined;
      },
      markUnseen: (key, engine, stateChangeSeq) => {
        seenMarks.set(key, { agentSessionId: engine, stateChangeSeq, unseen: true });
      },
    },
    aliasFor: () => undefined,
    rememberAlias: () => {},
    assertSendable: (text: string) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => {},
  };
}

/** Wpis Codexa po filtrze wejściowym — kształt z `normalizeAgentInfo` + pola nadzorcy. */
function codexAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    key: KEY,
    paneId: KEY,
    tabId: 'w9:t1H',
    agentSessionId: CODEX_SESSION,
    engine: 'codex',
    termId: null,
    cwd: PROJECT,
    status: 'idle',
    // Tytuł jest tu już znormalizowany (bez spinnera i bez sufiksu katalogu) — robi to klient.
    title: 'Przeprojektuj aplikację',
    stateChangeSeq: 7,
    mode: 'auto',
    modeReadAt: 0,
    // `scopeOf` w nadzorcy trzyma `false` dla Codexa niezależnie od korzeni.
    inScope: false,
    launchedByRarog: false,
    interactiveReady: false,
    ...overrides,
  };
}

function claudeAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    key: 'w9:p80',
    paneId: 'w9:p80',
    tabId: 'w9:t2',
    agentSessionId: CLAUDE_SESSION,
    engine: 'claude',
    termId: null,
    cwd: PROJECT,
    status: 'idle',
    title: 'refaktor',
    stateChangeSeq: 3,
    mode: 'auto',
    modeReadAt: 0,
    inScope: true,
    launchedByRarog: false,
    interactiveReady: true,
    ...overrides,
  };
}

/** Wpis listy wznawialnych o zadanym uuid — `liveInHerdr` i tak przelicza manager. */
function resumableEntry(engineSessionId: string): ResumableSession {
  return {
    engineSessionId,
    cwd: PROJECT,
    mtime: '2026-09-14T10:00:00.000Z',
    firstPrompt: 'zrób coś',
    liveInHerdr: false,
  };
}

/** Oddaje sterowanie pętli zdarzeń, żeby pompy managera przetrawiły kolejki. */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

// ---------------------------------------------------------------------------

describe('wpis Codexa w managerze', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];
  const servers: http.Server[] = [];
  const hubs: SseHub[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-codex-'));
  });

  afterEach(async () => {
    for (const hub of hubs.splice(0)) hub.closeAll();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeSupervisor(): FakeSupervisor {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    return supervisor;
  }

  async function build(
    supervisor: FakeSupervisor, deps: HerdrManagerDeps = makeDeps(),
    overrides: Partial<ManagerConfig> = {},
  ): Promise<Manager> {
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      gitWatcher: null,
      herdrSupervisor: supervisor,
      herdrDeps: deps,
      herdrRoots: [PROJECT],
      herdrSend: true,
      // Terminal jest w tych testach WŁĄCZONY, bo to stan produkcyjny; punkt (f) buduje
      // managera bez tej wartości i sprawdza drugą stronę.
      termEnabled: true,
      ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    return manager;
  }

  /** Manager z jedną kartą Codexa gotową do dalszych kroków. */
  async function withCodex(
    agent: HerdrAgent = codexAgent(), deps = makeDeps(),
    overrides: Partial<ManagerConfig> = {},
  ): Promise<{ manager: Manager; supervisor: FakeSupervisor; id: string }> {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, deps, overrides);
    supervisor.appear(agent);
    await flush();
    const id = manager.list()[0]?.id ?? '';
    expect(id, 'karta Codexa nie powstała').not.toBe('');
    return { manager, supervisor, id };
  }

  function record(manager: Manager): ServerEvent[] {
    const out: ServerEvent[] = [];
    manager.onEvent((_scope, _seq, event) => { out.push(event); });
    return out;
  }

  // -------------------------------------------------------------------------
  // (a) tożsamość: uuid Codexa NIE jest tożsamością wznowienia
  // -------------------------------------------------------------------------

  it('karta Codexa ma `engine`, `outOfScope` i NIE zajmuje uuidu w indeksie pisarzy', async () => {
    /*
     * `liveInHerdr` liczy się z indeksu `engineSessionId → sessionId` i jest jedynym oknem
     * na ten indeks od zewnątrz. `true` przy wpisie Codexa znaczyłoby, że uuid rollouta
     * zajął miejsce w rejestrze pisarzy plików jsonl — czyli że sesja Claude o tym samym
     * uuid straciłaby prawo do wznowienia przez wpis, który żadnego pliku nie dotyka.
     */
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      resumableReader: async () => [resumableEntry(CODEX_SESSION), resumableEntry(CLAUDE_SESSION)],
    });
    supervisor.appear(codexAgent());
    supervisor.appear(claudeAgent());
    await flush();

    const codex = manager.list().find((s) => s.engine === 'codex');
    expect(codex).toBeDefined();
    expect(codex?.outOfScope).toBe(true);
    // Etykieta z tytułu panelu jedzie tą samą regułą co dla Claude — tytuł przyszedł czysty.
    expect(codex?.label).toBe('Przeprojektuj aplikację');

    const resumable = await manager.resumable(PROJECT);
    const byUuid = new Map(resumable.map((entry) => [entry.engineSessionId, entry.liveInHerdr]));
    expect(byUuid.get(CODEX_SESSION), 'uuid Codexa wszedł do indeksu pisarzy').toBe(false);
    // Kontrola: dla Claude ten sam mechanizm ma działać jak dotąd, inaczej test nie mierzy nic.
    expect(byUuid.get(CLAUDE_SESSION)).toBe(true);
  });

  it('`/new` w Codexie aktualizuje uuid znacznika, ale nie zakłada karty ani wpisu w indeksie', async () => {
    const seenMarks: SeenMarks = new Map();
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(seenMarks), {
      resumableReader: async () => [resumableEntry(CODEX_SESSION_2)],
    });
    supervisor.appear(codexAgent({ status: 'done' }));
    await flush();
    const id = manager.list()[0]?.id ?? '';

    // `/new` w panelu: driver melduje NOWY uuid rollouta pod tym samym kluczem panelu.
    supervisor.driver(KEY).queue.push({
      type: 'init', engineSessionId: CODEX_SESSION_2, model: '',
    });
    await flush();

    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.id).toBe(id);
    const resumable = await manager.resumable(PROJECT);
    expect(resumable[0]?.liveInHerdr, 'nowy uuid Codexa wszedł do indeksu').toBe(false);

    // Znacznik „obejrzane" idzie po NOWYM uuidzie — inaczej po `/new` wskazywałby rollout,
    // którego panel już nie prowadzi, i wynik wracałby do sekcji uwagi.
    manager.markSeen(id);
    expect(seenMarks.get(KEY)).toEqual({
      agentSessionId: CODEX_SESSION_2, stateChangeSeq: 7,
    });
  });

  // -------------------------------------------------------------------------
  // (c) powiadomienia
  // -------------------------------------------------------------------------

  it('`done` i `blocked` panelu Codexa jadą tą samą polityką powiadomień co Claude', async () => {
    const notes: NoteInput[] = [];
    const notifier: NotifierLike = {
      note: (input) => { notes.push(input); },
      seen: () => {},
      forget: () => {}, quiet: () => undefined,
    };
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), { notifier });
    // Panel zaczyna od `working`: pierwsze zobaczenie panelu STOJĄCEGO na `done` to stan
    // początkowy, a nie przejście — i tak samo jak dla Claude nie pusha.
    supervisor.appear(codexAgent({ status: 'working' }));
    await flush();
    expect(notes).toHaveLength(0);
    expect(manager.list()[0]?.state).toBe('running');

    // `done` z herdr jedzie do managera jako `idle` z `seen: false` — patrz driver herdr.
    supervisor.driver(KEY).queue.push({ type: 'agent-state', state: 'idle', seen: false });
    await flush();
    supervisor.driver(KEY).queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();

    expect(notes.map((n) => n.event.type)).toEqual(['agent-idle', 'agent-blocked']);
    // Klasę i rodzaj liczymy PRAWDZIWĄ polityką, a nie napisem w teście: to ona decyduje,
    // czy baner w ogóle wyjdzie i co człowiek w nim przeczyta.
    expect(notes.map((n) => classify({ event: n.event, backgroundTasks: 0 })))
      .toEqual(['done', 'blocking']);
    expect(notes.map((n) => kindOf(n.event))).toEqual(['done', 'blocked']);
    // Projekt w banerze bierze się z `cwd` karty — Codex nie jest tu wyjątkiem.
    expect(notes[0]?.project).toBe('atlas');
    expect(manager.list()[0]?.state).toBe('waiting-permission');
  });

  /**
   * TEST OBOWIĄZKOWY. Baner musi prowadzić TAM, gdzie prowadzi wiersz
   * listy — a ten dla Codexa w terminalu Raroga prowadzi do terminala. Cel tapnięcia niesie klucz
   * `rarog.termId` ładunku APNs, więc pole ma dojść do harmonogramu; bez niego tap otwierałby
   * ekran sesji zamiast terminala.
   */
  it('`termId` karty jedzie do harmonogramu — cel tapnięcia w banerze wskazuje terminal', async () => {
    const notes: NoteInput[] = [];
    const notifier: NotifierLike = {
      note: (input) => { notes.push(input); },
      seen: () => {},
      forget: () => {}, quiet: () => undefined,
    };
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), { notifier });
    supervisor.appear(codexAgent({ status: 'working', termId: TERM_ID }));
    await flush();
    supervisor.driver(KEY).queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();

    expect(notes).toHaveLength(1);
    expect(notes[0]?.termId).toBe(TERM_ID);
    // …i to naprawdę trafia do ładunku APNs (tekst jawny banera v2), a nie tylko podróżuje obok niego.
    const termId = notes[0]?.termId;
    const content = buildContent({
      cls: 'blocking', kind: 'blocked', project: 'atlas', sessionId: 'ignorowane',
      ...(termId === undefined ? {} : { termId }),
    });
    let plaintext = '{}';
    apnsAlertRequestE2e(content, {
      topic: 'ai.rarog.app', nowMs: 0, key: { pushKey: '', kid: '00000000' },
      sealer: { seal: (_key, text) => { plaintext = text; return { kid: '00000000', n: '', c: '' }; } },
    });
    expect((JSON.parse(plaintext) as { termId?: string }).termId).toBe(TERM_ID);
  });

  /** Panel Codexa BEZ terminala Raroga nie ma czego przekazać — baner zostaje na sesji. */
  it('bez `termId` harmonogram dostaje pole nieobecne, a nie puste', async () => {
    const notes: NoteInput[] = [];
    const notifier: NotifierLike = {
      note: (input) => { notes.push(input); },
      seen: () => {},
      forget: () => {}, quiet: () => undefined,
    };
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), { notifier });
    supervisor.appear(codexAgent({ status: 'working' }));
    await flush();
    supervisor.driver(KEY).queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();

    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toHaveProperty('termId');
  });

  // -------------------------------------------------------------------------
  // (d) znacznik „obejrzane" przeżywa restart Raroga
  // -------------------------------------------------------------------------

  it('`seen` zapisane po `observedSessionId` przeżywa restart managera', async () => {
    const seenMarks: SeenMarks = new Map();
    const first = makeSupervisor();
    const manager = await build(first, makeDeps(seenMarks));
    first.appear(codexAgent({ status: 'done' }));
    await flush();
    const id = manager.list()[0]?.id ?? '';
    expect(manager.list()[0]?.seen, 'panel na `done` startuje jako nieobejrzany').toBe(false);

    manager.markSeen(id);
    expect(manager.list()[0]?.seen).toBe(true);
    expect(seenMarks.get(KEY)).toEqual({ agentSessionId: CODEX_SESSION, stateChangeSeq: 7 });
    await manager.dispose();

    // Restart Raroga: nowy manager, ten sam magazyn znaczników, ten sam panel.
    const second = makeSupervisor();
    const revived = await build(second, makeDeps(seenMarks));
    second.appear(codexAgent({ status: 'done' }));
    await flush();
    expect(revived.list()[0]?.seen, 'karta Codexa wróciła do sekcji uwagi po restarcie').toBe(true);

    // Druga strona tej samej reguły: NOWY wynik (wyższy numer stanu) przebija znacznik.
    second.gone(KEY);
    await flush();
    second.appear(codexAgent({ status: 'done', stateChangeSeq: 8 }));
    await flush();
    expect(revived.list()[0]?.seen).toBe(false);
  });

  it('ręczne „nieprzeczytane" idzie po `observedSessionId` i przeżywa restart managera', async () => {
    const seenMarks: SeenMarks = new Map();
    const first = makeSupervisor();
    const manager = await build(first, makeDeps(seenMarks));
    first.appear(codexAgent({ status: 'idle' }));
    await flush();
    const id = manager.list()[0]?.id ?? '';
    expect(manager.list()[0]?.seen).toBe(true);

    manager.markUnseen(id);
    expect(manager.list()[0]?.seen).toBeUndefined();
    // Ten sam adres co znacznik „obejrzane" — uuid rolloutu, nie `engineSessionId`, którego Codex nie ma.
    expect(seenMarks.get(KEY)).toEqual({ agentSessionId: CODEX_SESSION, stateChangeSeq: 7, unseen: true });
    await manager.dispose();

    const second = makeSupervisor();
    const revived = await build(second, makeDeps(seenMarks));
    second.appear(codexAgent({ status: 'idle' }));
    await flush();
    expect(revived.list()[0]?.seen, 'panel `idle` z wpisem „nieprzeczytane" wraca nieodebrany').toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // (e) flaga funkcji
  // -------------------------------------------------------------------------

  it('`RAROG_CODEX_STATUS=0` (i demo) zdejmuje Codexa z listy agentów jeszcze przed managerem', () => {
    /*
     * Test DWÓCH KOŃCÓW przewodu: wartość z `loadConfig` naprawdę steruje filtrem wejściowym.
     * Sama flaga ma testy w `config.test.ts`, sam filtr — w `herdr-client.test.ts`; rozjechać
     * się mogą dopiero razem, przy przepisaniu nazwy pola.
     *
     * Czego ten test NIE mierzy: przewodu POŚRODKU (`index.ts` → nadzorca → `createHerdrClient`).
     * Nadzorcy nie ma tu wcale — `parseAgentList` wołamy wprost. Te dwie linie pilnuje test
     * niżej, skanem źródła, i tam stoi powód, dla którego nie da się ich zmierzyć zachowaniem.
     */
    const fixture = JSON.parse(readFileSync(
      join(import.meta.dirname, 'fixtures', 'herdr', 'agent-list.json'), 'utf8',
    ) as string) as { result: { agents: Record<string, unknown>[] } };
    const claudeRaw = fixture.result.agents[0] as Record<string, unknown>;
    const codexRaw = {
      ...claudeRaw,
      agent: 'codex',
      agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: CODEX_SESSION },
      pane_id: KEY,
    };
    const result = { ...fixture.result, agents: [claudeRaw, codexRaw] };
    const env = { RAROG_ORIGINS: 'https://rarog.example' };

    const off = loadConfig({ ...env, RAROG_CODEX_STATUS: '0' });
    expect(parseAgentList(result, { codexStatus: off.codexStatusEnabled })
      .map((info) => info.engine)).toEqual(['claude']);

    const demo = loadConfig({ ...env, RAROG_DEMO: '1', RAROG_CODEX_STATUS: '1' });
    expect(parseAgentList(result, { codexStatus: demo.codexStatusEnabled })
      .map((info) => info.engine)).toEqual(['claude']);

    const on = loadConfig(env);
    expect(parseAgentList(result, { codexStatus: on.codexStatusEnabled })
      .map((info) => info.engine)).toEqual(['claude', 'codex']);
  });

  /*
   * PRZEWÓD FLAGI — dwie linie, których nie mierzy nic innego.
   *
   * Produkcyjna gałąź to `deps.client ?? createHerdrClient(…, { codexStatus })` w nadzorcy:
   * wykona się WYŁĄCZNIE wtedy, gdy wołający nie poda gotowego klienta. Wszystkie trzy miejsca,
   * w których testy budują nadzorcę, podają `deps.client` — i muszą, bo `HerdrTransport` nie ma
   * metody `request()`, więc klienta nie da się zbudować z atrapy transportu; bez `deps.client`
   * nadzorca otwiera PRAWDZIWE gniazdo. Tak samo `index.ts`: `loadHerdr` nie ma pokrycia
   * żadnym testem. Skasowanie którejkolwiek z tych dwóch linii zostawiało więc całą funkcję
   * martwą (Codex nigdy nie wchodzi) przy zielonym `pnpm test`.
   *
   * Stąd skan źródła — ta sama metoda, którą `scripts-launchd.test.ts` pilnuje linii w
   * `restart.sh`, a `docs-zgodnosc.test.ts` zgodności dokumentów z kodem. Dopasowania są
   * odporne na przeformatowanie (okno wokół wywołania, nie dokładna linia).
   */
  it('flaga z konfiguracji jest PRZEWIEDZIONA do klienta herdr (skan źródła)', () => {
    const src = (rel: string): string =>
      readFileSync(join(import.meta.dirname, '..', 'src', rel), 'utf8');

    // 1. proces → nadzorca
    expect(src('index.ts'), '`index.ts` przestał podawać flagę nadzorcy')
      .toMatch(/codexStatusEnabled:\s*config\.codexStatusEnabled/);

    // 2. nadzorca → klient (gałąź `??`, czyli dokładnie ta, którą wykonuje produkcja)
    const supervisor = src('herdr/supervisor.ts');
    const at = supervisor.indexOf('createHerdrClient(');
    expect(at, 'nadzorca nie buduje już klienta herdr').toBeGreaterThan(-1);
    expect(supervisor.slice(at, at + 200), 'klient herdr powstaje BEZ flagi Codexa')
      .toMatch(/codexStatus:\s*config\.codexStatusEnabled/);

    // 3. klient → filtr. Zachowanie ma własny test wyżej; tu chodzi o ciągłość nazwy pola.
    expect(src('herdr/client.ts'), 'filtr wejściowy przestał czytać `opts.codexStatus`')
      .toMatch(/opts\.codexStatus === true/);
  });

  // -------------------------------------------------------------------------
  // (f) + (h) `termId` i kontrakt summary
  // -------------------------------------------------------------------------

  it('`termId` jedzie na drut tylko przy włączonym terminalu', async () => {
    const agent = codexAgent({ termId: TERM_ID });
    const withTerm = await withCodex(agent);
    expect(withTerm.manager.list()[0]?.termId).toBe(TERM_ID);

    // `RAROG_TERM=0`: trasa `#/terminal/<id>` nie ma czego pokazać, więc linku nie ma.
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), { termEnabled: false });
    supervisor.appear(agent);
    await flush();
    expect(manager.list()[0]?.termId).toBeUndefined();
    // Sama karta ma powstać tak czy inaczej — wyłączony terminal nie wycisza wiersza Codexa.
    expect(manager.list()[0]?.engine).toBe('codex');
  });

  it('wygaśnięcie tokenu `rarog-term` zdejmuje `termId` przy ponownym podpięciu panelu', async () => {
    const { manager, supervisor } = await withCodex(codexAgent({ termId: TERM_ID }));
    expect(manager.list()[0]?.termId).toBe(TERM_ID);
    // Token `rarog-term` ma TTL: po jego wygaśnięciu link prowadziłby w martwy terminal.
    supervisor.reattach(codexAgent({ termId: null }));
    await flush();
    expect(manager.list()[0]?.termId).toBeUndefined();
    expect(manager.list()[0]?.outOfScope, 'reattach nie ma prawa wpuścić Codexa w zasięg')
      .toBe(true);
  });

  it('`engine` i `termId` niesie i `list()`, i ramka `session-changed` — po schemacie kontraktu', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor);
    const events = record(manager);
    supervisor.appear(codexAgent({ termId: TERM_ID }));
    await flush();

    const listed = manager.list()[0] as SessionSummary;
    // Przez SCHEMAT, bo `z.object` odcina nieznane klucze: gdyby pól zabrakło w kontrakcie,
    // serwer wysyłałby je w próżnię, a PWA nigdy by ich nie zobaczyła.
    const parsed = sessionSummarySchema.parse(listed);
    expect(parsed.engine).toBe('codex');
    expect(parsed.termId).toBe(TERM_ID);

    const changed = events.filter(
      (event): event is Extract<ServerEvent, { type: 'session-changed' }> =>
        event.type === 'session-changed',
    );
    expect(changed.length).toBeGreaterThan(0);
    const fromFrame = sessionSummarySchema.parse(changed[changed.length - 1]?.session);
    expect(fromFrame.engine).toBe('codex');
    expect(fromFrame.termId).toBe(TERM_ID);
    // `observedSessionId` zostaje na SERWERZE — uuid rollouta nie ma odbiorcy na telefonie.
    expect(Object.keys(listed)).not.toContain('observedSessionId');
  });

  // -------------------------------------------------------------------------
  // (g) zniknięcie panelu
  // -------------------------------------------------------------------------

  it('`gone` panelu Codexa domyka kartę ramką `closed` i ZDEJMUJE ją z listy', async () => {
    const { manager, supervisor, id } = await withCodex();
    const events = record(manager);

    supervisor.gone(KEY);
    await flush();

    const closed = events.filter(
      (event): event is Extract<ServerEvent, { type: 'session-changed' }> =>
        event.type === 'session-changed' && event.session.id === id,
    );
    expect(closed.at(-1)?.session.state).toBe('done');
    // Detail mówi PRAWDĘ o powodzie: panel zniknął, a nie `HERDR_HIDDEN_DETAIL.text` (ukryta, panel żyje).
    expect(closed.at(-1)?.session.stateDetail).toBe(HERDR_GONE_DETAIL.text);
    // Karta Claude w tym miejscu ZOSTAJE (ma `engineSessionId`, więc `resume` ją otworzy);
    // karta Codexa nie ma czego wznawiać, więc wiersz, którego nie da się zdjąć, byłby śmieciem.
    expect(manager.list()).toHaveLength(0);
    expect(events.some((event) => event.type === 'sessions-snapshot')).toBe(true);
  });

  it('panel Claude spoza terminala Raroga po `gone` zostaje na liście', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor);
    supervisor.appear(claudeAgent());
    await flush();
    supervisor.gone('w9:p80');
    await flush();
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.state).toBe('done');
  });

  it('szara karta Claude nie zamyka panelu, w którym stoi już Codex', async () => {
    /*
     * Scenariusz: sesja Claude z ALIASEM (własne `id`, więc karta
     * NIE zostaje nadpisana przez następcę), człowiek wychodzi z `claude` i odpala w tym samym
     * panelu `codex`. Karta Claude przeżywa `gone` z nietkniętym `herdrKey`, a nowy wpis
     * dostaje ten sam klucz — „×" na szarej karcie zamykał wtedy tab z ŻYWYM Codexem.
     */
    const supervisor = makeSupervisor();
    const deps: HerdrManagerDeps = {
      ...makeDeps(),
      aliasFor: (engineSessionId) => (
        engineSessionId === CLAUDE_SESSION ? 'sesja-z-aliasu' : undefined
      ),
    };
    const manager = await build(supervisor, deps);
    supervisor.appear(claudeAgent({ key: KEY, paneId: KEY, launchedByRarog: true }));
    await flush();
    const stareId = manager.list()[0]?.id ?? '';
    expect(stareId).toBe('sesja-z-aliasu');

    supervisor.gone(KEY);
    await flush();
    supervisor.appear(codexAgent());
    await flush();
    const codexId = manager.list().find((s) => s.engine === 'codex')?.id ?? '';
    expect(codexId, 'karta Codexa nie powstała').not.toBe('');
    expect(codexId).not.toBe(stareId);

    await manager.close(stareId, { closePanel: true });

    // Ani jednego `tab.close`: klucz należy do następcy, a nie do karty, która go pamięta.
    expect(supervisor.closeTabCalls).toEqual([]);
    // Zamiar „ta karta ma zniknąć" jest jednak spełniony — szara karta nie może być wieczna.
    expect(manager.list().some((s) => s.id === stareId)).toBe(false);
    expect(manager.list().some((s) => s.id === codexId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (i) Claude uruchomiony ręcznie w terminalu Raroga
  // -------------------------------------------------------------------------

  describe('Claude w terminalu Raroga', () => {
    const CLAUDE_KEY = 'w9:p80';

    it('karta niesie `termId`, a reszta zostaje pełną sesją Claude', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor);
      supervisor.appear(claudeAgent({ termId: TERM_ID }));
      await flush();

      const listed = sessionSummarySchema.parse(manager.list()[0]);
      expect(listed.termId).toBe(TERM_ID);
      // Nie jest wpisem samego stanu: silnik to Claude, a panel jest w zasięgu (transkrypt, ekran).
      expect(listed.engine).toBeUndefined();
      expect(listed.outOfScope).not.toBe(true);
    });

    it('przy wyłączonym terminalu (`RAROG_TERM=0`) pola nie ma', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { termEnabled: false });
      supervisor.appear(claudeAgent({ termId: TERM_ID }));
      await flush();
      expect(manager.list()[0]?.termId).toBeUndefined();
    });

    it('baner prowadzi do terminala: `termId` jedzie do harmonogramu', async () => {
      const notes: NoteInput[] = [];
      const notifier: NotifierLike = {
        note: (input) => { notes.push(input); },
        seen: () => {},
        forget: () => {}, quiet: () => undefined,
      };
      const supervisor = makeSupervisor();
      await build(supervisor, makeDeps(), { notifier });
      supervisor.appear(claudeAgent({ status: 'working', termId: TERM_ID }));
      await flush();
      supervisor.driver(CLAUDE_KEY).queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();

      expect(notes.length).toBeGreaterThan(0);
      expect(notes.at(-1)?.termId).toBe(TERM_ID);
    });

    it('`gone` ZDEJMUJE kartę z listy: wiersz bez ekranu sesji prowadziłby do gołej powłoki', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor);
      supervisor.appear(claudeAgent({ termId: TERM_ID }));
      await flush();
      const id = manager.list()[0]?.id ?? '';
      const events = record(manager);

      supervisor.gone(CLAUDE_KEY);
      await flush();

      const closed = events.filter(
        (event): event is Extract<ServerEvent, { type: 'session-changed' }> =>
          event.type === 'session-changed' && event.session.id === id,
      );
      expect(closed.at(-1)?.session.state).toBe('done');
      expect(closed.at(-1)?.session.stateDetail).toBe(HERDR_GONE_DETAIL.text);
      expect(manager.list()).toHaveLength(0);
      expect(events.some((event) => event.type === 'sessions-snapshot')).toBe(true);
    });

    it('ten sam uuid uruchomiony od nowa w terminalu wraca jako nowa karta', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor);
      supervisor.appear(claudeAgent({ termId: TERM_ID }));
      await flush();
      supervisor.gone(CLAUDE_KEY);
      await flush();
      expect(manager.list()).toHaveLength(0);

      // `claude --resume` w tej samej powłoce: indeks pisarzy nie może pamiętać zdjętej karty.
      supervisor.appear(claudeAgent({ termId: TERM_ID }));
      await flush();
      expect(manager.list()).toHaveLength(1);
      expect(manager.list()[0]?.termId).toBe(TERM_ID);
    });

    it('token odzyskany po restarcie herdr (`term-changed`) dopisuje `termId` do żywej karty', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor);
      // herdr odtworzył Claude w panelu terminala, zanim terminal odzyskał token z etykiety.
      supervisor.appear(claudeAgent({ termId: null }));
      await flush();
      expect(manager.list()[0]?.termId).toBeUndefined();
      const events = record(manager);
      const driver = supervisor.driver(CLAUDE_KEY);

      supervisor.termChanged(claudeAgent({ termId: TERM_ID }));
      await flush();

      expect(manager.list()[0]?.termId).toBe(TERM_ID);
      const changed = (): ServerEvent[] => events.filter((event) => event.type === 'session-changed');
      const afterFirst = changed().length;
      expect(afterFirst).toBeGreaterThan(0);
      expect(sessionSummarySchema.parse(
        (changed().at(-1) as Extract<ServerEvent, { type: 'session-changed' }>).session,
      ).termId).toBe(TERM_ID);
      // Driver zostaje ten sam: zmiana adresu karty nie przebudowuje podpięcia panelu.
      expect(supervisor.driver(CLAUDE_KEY)).toBe(driver);

      // Powtórka tej samej wartości nie rozgłasza niczego drugi raz.
      supervisor.termChanged(claudeAgent({ termId: TERM_ID }));
      await flush();
      expect(changed()).toHaveLength(afterFirst);
    });

    it('utrata tokenu (`term-changed` na `null`) zdejmuje `termId` — karta wraca do ekranu sesji', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor);
      supervisor.appear(claudeAgent({ termId: TERM_ID }));
      await flush();
      supervisor.termChanged(claudeAgent({ termId: null }));
      await flush();
      expect(manager.list()[0]?.termId).toBeUndefined();
      // Bez `termId` to znów zwykła karta Claude: po `gone` zostaje i czeka na „Wznów”.
      supervisor.gone(CLAUDE_KEY);
      await flush();
      expect(manager.list()).toHaveLength(1);
    });

    it('`term-changed` panelu, którego manager nie zna, nie robi nic', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor);
      supervisor.termChanged(claudeAgent({ termId: TERM_ID }));
      await flush();
      expect(manager.list()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // (b) API: granice władzy stoją na SERWERZE
  // -------------------------------------------------------------------------

  describe('HTTP (router + prawdziwy manager)', () => {
    interface Harness {
      base: string;
      auth: string;
      manager: Manager;
      supervisor: FakeSupervisor;
      id: string;
    }

    async function startHarness(agent: HerdrAgent = codexAgent()): Promise<Harness> {
      const { manager, supervisor, id } = await withCodex(agent);
      const config = loadConfig({ RAROG_DEMO: '1' });
      const device = createTestDevice(config.dataDir, { epoch: config.epoch });
      const hub = new SseHub({
        manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      });
      hub.start();
      hubs.push(hub);
      const silent: Logger = { info: () => {}, error: () => {} };
      const server = http.createServer(createRouter({
        config, manager, hub, serverStartId: 'start-1',
        startedAtMs: Date.now() - 5_000, logger: silent, devices: device.identity,
      }));
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const { port } = server.address() as AddressInfo;
      return {
        base: `http://127.0.0.1:${String(port)}`,
        auth: device.authorization,
        manager, supervisor, id,
      };
    }

    function post(h: Harness, path: string, body: unknown): Promise<Response> {
      return fetch(`${h.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: h.auth },
        body: JSON.stringify(body),
      });
    }

    it('wysyłka, model i odpowiedź na pytanie odbijają się o 400 z powodem „poza zasięgiem"', async () => {
      const h = await startHarness();
      for (const [path, body] of [
        [`/api/sessions/${h.id}/messages`, { text: 'zrób coś' }],
        [`/api/sessions/${h.id}/model`, { effort: 'high' }],
        [`/api/sessions/${h.id}/answers/q1`, { answers: [['tak']] }],
      ] as const) {
        const res = await post(h, path, body);
        expect(res.status, path).toBe(400);
        expect(await res.json(), path).toMatchObject({ message: HERDR_OUT_OF_SCOPE_MESSAGE.text });
      }
      // Ani jednego bajtu do panelu: `sendCommands` atrapy jest pusty.
      expect(h.supervisor.driver(KEY).commands).toEqual([]);
    });

    it('`resume` oddaje 409 — panel Codexa żyje, a Rarog nie ma czego wznawiać', async () => {
      const h = await startHarness();
      const res = await post(h, `/api/sessions/${h.id}/resume`, {});
      expect(res.status).toBe(409);
      // Trasa `resume` oddaje ogólne zdanie 409 (`runManagerAction`), więc POWÓD pinujemy
      // o poziom niżej — inaczej test przeszedłby także dla 409 z zupełnie innej bramki.
      await expect(h.manager.resume(h.id)).rejects.toThrow(HERDR_RESUME_MESSAGE.text);
    });

    it('`close` z `closePanel: true` oddaje 409 i NIE woła `tab.close`', async () => {
      const h = await startHarness();
      const res = await post(h, `/api/sessions/${h.id}/close`, { closePanel: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ message: HERDR_CODEX_CLOSE_MESSAGE.text });
      // To jest cały sens tej bramki: stara PWA (albo `curl`) nie ubija cudzego panelu.
      expect(h.supervisor.closeTabCalls).toEqual([]);
      expect(h.manager.list()).toHaveLength(1);
    });

    /*
     * DIFF Z KARTY. `diff` jest jedyną metodą karty bez bramki
     * `engine`/`outOfScope` — powstał dla karty z transkryptem. Dla wpisu Codexa to byłaby
     * WŁADZA: treść repozytorium panelu (katalog bywa spoza `RAROG_HERDR_ROOTS`, bo dla Codexa
     * `scopeOf` i tak trzyma `false`) wydana z karty, która obiecuje sam stan.
     */
    it('diff roboczy z karty Codexa odbija się o 400', async () => {
      const h = await startHarness();
      const diff = await fetch(`${h.base}/api/sessions/${h.id}/diff`, {
        headers: { Origin: ORIGIN, Authorization: h.auth },
      });
      expect(diff.status).toBe(400);
      /*
       * Trasa oddaje ogólne zdanie 400 (`runManagerAction` z polityką `generic`), więc
       * POWÓD pinujemy o poziom niżej — tak samo jak przy `resume`. Inaczej test przeszedłby
       * dla dowolnego 400.
       */
      await expect(h.manager.diff(h.id)).rejects.toThrow(HERDR_CODEX_GIT_MESSAGE.text);
    });

    /*
     * Trasy diffa per plik stoją za tą samą bramką — i mówią to zdaniem managera: nowa
     * apka pokazuje je wprost, więc ogólne „Żądanie odrzucone." nie wystarczy.
     */
    it('lista zmian i patch pliku z karty Codexa: 400 ze zdaniem o Codexie', async () => {
      const h = await startHarness();
      for (const route of ['diff/files', 'diff/file?path=src%2Fa.ts', 'diff/file?path=..%2Fx']) {
        const res = await fetch(`${h.base}/api/sessions/${h.id}/${route}`, {
          headers: { Origin: ORIGIN, Authorization: h.auth },
        });
        expect(res.status, route).toBe(400);
        expect(await res.json(), route).toEqual({
          error: 'bad-request', message: HERDR_CODEX_GIT_MESSAGE.text, messageRef: { code: 'session.codex-git' },
        });
      }
    });

    it('„Pokaż w herdr" przechodzi (202) — jedyne wejście, jakie wpis Codexa daje', async () => {
      const h = await startHarness();
      const res = await post(h, `/api/sessions/${h.id}/focus`, {});
      expect(res.status).toBe(202);
      expect(h.supervisor.focusCalls).toEqual([KEY]);
    });
  });
});
