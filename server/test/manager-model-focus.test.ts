/**
 * Manager: zmiana modelu, „Pokaż w herdr" i dialog spoza jsonl.
 *
 * Te trzy władze Raroga mają jedną wspólną cechę: każda kończy się
 * w CUDZYM terminalu. Dlatego testy pilnują nie tego, że działają, tylko tego, KIEDY NIE
 * działają — bo to jest ta połowa, którą łatwo zepsuć jedną linijką:
 *
 * - `/model` nie ma prawa pójść w środku tury, poza zasięgiem, przy zamkniętym kanale zapisu
 *   ani z modelem spoza allow-listy — i za każdym razem musi to być odmowa ze ZDANIEM,
 * - `agent.focus` jest jedyną METODĄ kasującą `done` (drugim wołającym jest `markSeen`
 *   — testy tamtej ścieżki stoją w `manager-herdr.test.ts`), więc leci wyłącznie z gestu,
 * - dialog spoza jsonl dostaje „Zatwierdź" WYŁĄCZNIE po rozpoznaniu sygnatury.
 *
 * Zero gniazda, zero `~/.claude`: nadzorca i driver są atrapami, a wszystko, co wyszłoby
 * do panelu, ląduje w liście `commands` / `keys`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_CHANGE_WARNING, ULTRACODE_CHANGE_NOTE } from '@rarog/shared';
import type { HerdrMode, HerdrStatus, ModeCycleTarget } from '@rarog/shared';
import {
  BadRequestError, BadStateError, TooManyRequestsError,
  createManager, modelCommands,
} from '../src/sessions/manager.ts';
import {
  HERDR_ALLOW_MESSAGE, ULTRACODE_CLI_UNKNOWN_MESSAGE, ultracodeCliTooOldMessage,
} from '../src/sessions/state-sentences.ts';
import type { CliVersionSnapshot } from '../src/cli-version.ts';
import { ULTRACODE_COMMANDS } from '../src/herdr/commands/registry.ts';
import { ULTRACODE_MIN_CLI } from '../src/herdr/ultracode.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import type { DecisionOutcome } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import type { PermissionDecision } from '../src/permissions.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const PROJECT = '/Users/u/Projects/atlas';
const ENGINE_SESSION = '11111111-1111-4111-8111-111111111111';
const KEY = 'w9:p72';

// ---------------------------------------------------------------------------
// Atrapy
// ---------------------------------------------------------------------------

/** Driver przypięty do cudzego panelu — notuje WSZYSTKO, co poszłoby do herdr. */
class FakeDriver extends AtrapaDrivera {
  /** Komendy sterujące (`sendCommands`). */
  readonly commands: string[] = [];
  /** Cele zmiany trybu (`setMode`) */
  readonly modes: ModeCycleTarget[] = [];

  /**
   * Czy przed oddaniem odmowy driver zgasi kartę (`#clearActive` → `permission-cleared`).
   *
   * Tak robi produkcja dla `screen-changed`, `no-digit`, `multi-select` i `terminal-only`:
   * zdarzenie idzie do kolejki managera ZANIM wynik wróci do `#decideHerdrDialog`.
   */
  clearBeforeRefusal = false;

  /** Decyzje o dialogach: `allow` / `deny` razem z `reqId`, którym je zaadresowano. */
  get decisions(): { reqId: string; decision: string }[] {
    return this.calls.flatMap((call) => (
      call.method === 'respondPermission' ? [{ reqId: call.reqId, decision: call.decision }] : []
    ));
  }

  override respondPermission(reqId: string, decision: PermissionDecision): Promise<DecisionOutcome> {
    const outcome = super.respondPermission(reqId, decision);
    if (this.clearBeforeRefusal) {
      this.queue.push({ type: 'permission-cleared', reason: 'ekran zmienił się przed wysłaniem' });
    }
    return outcome;
  }

  sendCommands(commands: readonly string[]): void {
    this.commands.push(...commands);
  }

  setMode(target: ModeCycleTarget): void {
    this.modes.push(target);
  }
}

class FakeSupervisor extends AtrapaNadzorcy<FakeDriver> {
  /** Klucze, dla których zawołano `agent.focus`. */
  readonly focused: string[] = [];
  freshMode: HerdrMode = 'auto';
  #status: HerdrStatus = { available: true, agentCount: 1, readOnly: false, canLaunch: true };

  override status(): HerdrStatus {
    return this.#status;
  }

  setStatus(patch: Partial<HerdrStatus>): void {
    this.#status = { ...this.#status, ...patch };
  }

  protected nowyDriver(key: string): FakeDriver {
    const driver = new FakeDriver(key);
    // Panel „czeka na człowieka" — jedyny stan, w którym wolno wysłać `/model`.
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }

  override async ensureFreshMode(): Promise<HerdrMode> {
    return this.freshMode;
  }

  override async focus(key: string): Promise<void> {
    this.focused.push(key);
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }

  override driver(key = KEY): FakeDriver {
    return super.driver(key);
  }
}

/** Wywołania guardu — sprawdzamy, że komenda sterująca jedzie ŚCIEŻKĄ WEWNĘTRZNĄ. */
interface GuardCall { text: string; internalCommand: boolean }

interface FakeDeps extends HerdrManagerDeps {
  readonly guardCalls: GuardCall[];
  /** `false` = throttle odmawia (429). */
  slots: boolean;
}

function makeDeps(): FakeDeps {
  const guardCalls: GuardCall[] = [];
  const deps: FakeDeps = {
    guardCalls,
    slots: true,
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: () => undefined,
    rememberAlias: () => {},
    assertSendable: (text, opts) => {
      guardCalls.push({ text, internalCommand: opts.internalCommand === true });
      return { text: text.trim(), slash: null };
    },
    takeSendSlot: () => deps.slots,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => {},
  };
  return deps;
}

function makeAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    key: KEY,
    paneId: KEY,
    agentSessionId: ENGINE_SESSION,
    engine: 'claude',
    termId: null,
    cwd: PROJECT,
    status: 'idle',
    title: 'atlas',
    stateChangeSeq: 1,
    mode: 'auto',
    modeReadAt: 0,
    inScope: true,
    tabId: 'w9:t3',
    launchedByRarog: false,
    interactiveReady: true,
    ...overrides,
  };
}

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

// ---------------------------------------------------------------------------

describe('manager — model, focus, dialog spoza jsonl', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-fb-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function withAgent(
    agent: HerdrAgent = makeAgent(), overrides: Partial<ManagerConfig> = {},
  ): Promise<{ manager: Manager; supervisor: FakeSupervisor; deps: FakeDeps; id: string }> {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const deps = makeDeps();
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      herdrSupervisor: supervisor,
      herdrDeps: deps,
      herdrRoots: [PROJECT],
      herdrSend: true,
      ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    supervisor.appear(agent);
    await flush();
    const id = manager.list()[0]?.id ?? '';
    return { manager, supervisor, deps, id };
  }

  // -------------------------------------------------------------------------
  // `POST /api/sessions/:id/model`
  // -------------------------------------------------------------------------

  it('zmiana modelu składa komendę, oddaje OSTRZEŻENIE i idzie ścieżką wewnętrzną', async () => {
    const { manager, supervisor, deps, id } = await withAgent();

    const result = await manager.setModel(id, { model: 'opus[1m]' });

    expect(result).toEqual({ ok: true, warning: MODEL_CHANGE_WARNING.text, warningRef: MODEL_CHANGE_WARNING.ref });
    expect(supervisor.driver().commands).toEqual(['/model opus[1m]']);
    /*
     * Flaga `internalCommand` jest tu całą różnicą między „Rarog wysyła `/model`" a „`/model`
     * przechodzi z composera": guard bez niej odrzuca tę komendę (deny-lista), a arkusz
     * z ostrzeżeniem dałoby się wtedy ominąć jednym zdaniem wpisanym w pole wiadomości.
     */
    expect(deps.guardCalls).toEqual([{ text: '/model opus[1m]', internalCommand: true }]);
  });

  it('model i effort naraz dają DWIE komendy, `/model` pierwszy', async () => {
    // Kolejność nie jest kosmetyczna: `/model` otwiera dialog potwierdzenia, więc `/effort`
    // wysłany przed nim trafiłby w otwarty dialog zamiast w pole wejściowe.
    const { manager, supervisor, id } = await withAgent();
    await manager.setModel(id, { model: 'sonnet', effort: 'high' });
    expect(supervisor.driver().commands).toEqual(['/model sonnet', '/effort high']);
  });

  it('„model domyślny konta" (pusty) bez effortu to 400 — nie ma czego wysłać', async () => {
    // `/model` bez argumentu otwiera w CLI interaktywny wybór, czyli dialog, którego Rarog
    // nie umie obsłużyć. Lepsza jawna odmowa niż panel zawieszony na cudzym menu.
    const { manager, supervisor, id } = await withAgent();
    await expect(manager.setModel(id, { model: '' })).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.driver().commands).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Ultracode w żywej sesji
  // -------------------------------------------------------------------------

  /** Czytnik wersji: proces sesji na `running` (rejestr), zainstalowane `installed`. */
  const versions = (running: string | null, installed: string | null = '2.1.317'): Partial<ManagerConfig> => ({
    cliVersionReader: (): Promise<CliVersionSnapshot> => Promise.resolve({
      installed,
      registry: new Map(running === null ? [] : [
        [ENGINE_SESSION, [{ pid: 7, version: running, status: 'idle' as const }]],
      ]),
    }),
  });

  it('ultracode idzie NA KOŃCU paczki, po `/model` i `/effort`, ścieżką wewnętrzną', async () => {
    const { manager, supervisor, deps, id } = await withAgent(makeAgent(), versions('2.1.317'));
    const result = await manager.setModel(id, { model: 'sonnet', effort: 'high', ultracode: true });
    expect(supervisor.driver().commands).toEqual(['/model sonnet', '/effort high', ULTRACODE_COMMANDS.on]);
    expect(deps.guardCalls.map((call) => call.internalCommand)).toEqual([true, true, true]);
    // Paczka z modelem albo effortem dalej ostrzega o ustawieniach konta.
    expect(result.warning).toBe(MODEL_CHANGE_WARNING.text);
  });

  it('sam ultracode: jedna komenda i zdanie o koszcie zamiast ostrzeżenia o koncie', async () => {
    const { manager, supervisor, id } = await withAgent(makeAgent(), versions('2.1.317'));
    expect(await manager.setModel(id, { ultracode: true })).toEqual({ ok: true, warning: ULTRACODE_CHANGE_NOTE.text, warningRef: ULTRACODE_CHANGE_NOTE.ref });
    expect(await manager.setModel(id, { ultracode: false })).toEqual({ ok: true, warning: ULTRACODE_CHANGE_NOTE.text, warningRef: ULTRACODE_CHANGE_NOTE.ref });
    expect(supervisor.driver().commands).toEqual([ULTRACODE_COMMANDS.on, ULTRACODE_COMMANDS.off]);
    // Effort `null` nie jest komendą: paczka to dalej sam ultracode.
    expect(await manager.setModel(id, { effort: null, ultracode: true }))
      .toEqual({ ok: true, warning: ULTRACODE_CHANGE_NOTE.text, warningRef: ULTRACODE_CHANGE_NOTE.ref });
  });

  it('bramka wersji RUNNING: proces starszy niż wymagany to 400 ze zdaniem, komenda nie wychodzi', async () => {
    // Zainstalowane nowe nie wystarcza: proces sesji dalej chodzi na starym wydaniu.
    const { manager, supervisor, id } = await withAgent(makeAgent(), versions('2.1.283', '2.1.317'));
    await expect(manager.setModel(id, { ultracode: true }))
      .rejects.toThrow(ultracodeCliTooOldMessage('2.1.283').text);
    expect(supervisor.driver().commands).toEqual([]);
    // Model i effort bez ultracode bramki wersji nie mają.
    await manager.setModel(id, { effort: 'high' });
    expect(supervisor.driver().commands).toEqual(['/effort high']);
  });

  it('bramka wersji RUNNING: wersja minimalna przechodzi', async () => {
    const { manager, supervisor, id } = await withAgent(makeAgent(), versions(ULTRACODE_MIN_CLI, null));
    await manager.setModel(id, { ultracode: false });
    expect(supervisor.driver().commands).toEqual([ULTRACODE_COMMANDS.off]);
  });

  it('bramka wersji RUNNING: proces bez wpisu w rejestrze, panel nie od Raroga, to 400 „nie znam wersji”', async () => {
    // Zainstalowana wersja nie zastępuje wersji procesu: panel mógł wstać przed aktualizacją.
    const { manager, supervisor, id } = await withAgent(makeAgent(), versions(null));
    const refusal = manager.setModel(id, { ultracode: true });
    await expect(refusal).rejects.toBeInstanceOf(BadRequestError);
    await expect(refusal).rejects.toThrow(ULTRACODE_CLI_UNKNOWN_MESSAGE.text);
    expect(supervisor.driver().commands).toEqual([]);
  });

  it('bramka wersji RUNNING: bez czytnika wersji też 400 „nie znam wersji”', async () => {
    const { manager, supervisor, id } = await withAgent();
    await expect(manager.setModel(id, { ultracode: false })).rejects.toThrow(ULTRACODE_CLI_UNKNOWN_MESSAGE.text);
    expect(supervisor.driver().commands).toEqual([]);
  });

  it('model spoza allow-listy odpada w managerze, nie tylko w routerze', async () => {
    const { manager, supervisor, id } = await withAgent();
    await expect(manager.setModel(id, { model: 'gpt-9' })).rejects.toThrow(/isn't in the list of available models/);
    expect(supervisor.driver().commands).toEqual([]);
  });

  it('panel poza RAROG_HERDR_ROOTS nie dostaje komendy', async () => {
    const { manager, supervisor, id } = await withAgent(
      makeAgent({ inScope: false, cwd: '/Users/u/Prywatne/birch' }),
    );
    await expect(manager.setModel(id, { model: 'opus[1m]' })).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.driver().commands).toEqual([]);
  });

  it('RAROG_HERDR_SEND=0 odcina też zmianę modelu', async () => {
    // Killswitch ma obejmować KAŻDĄ wysyłkę do panelu — `/model` nie jest wyjątkiem tylko
    // dlatego, że ma własny endpoint.
    const { manager, supervisor, id } = await withAgent(makeAgent(), { herdrSend: false });
    await expect(manager.setModel(id, { model: 'opus[1m]' })).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.driver().commands).toEqual([]);
  });

  it('throttle odmawia 429, a komenda nie wychodzi', async () => {
    const { manager, supervisor, deps, id } = await withAgent();
    deps.slots = false;
    await expect(manager.setModel(id, { model: 'opus[1m]' }))
      .rejects.toBeInstanceOf(TooManyRequestsError);
    expect(supervisor.driver().commands).toEqual([]);
  });

  it('nieznany tryb panelu wstrzymuje komendę (reguła 11.7)', async () => {
    const { manager, supervisor, id } = await withAgent();
    supervisor.freshMode = 'unknown';
    await expect(manager.setModel(id, { model: 'opus[1m]' })).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.driver().commands).toEqual([]);
  });

  it('sesja w turze to 409 z radą, a nie cicha wysyłka', async () => {
    const { manager, supervisor, id } = await withAgent();
    supervisor.driver().queue.push({ type: 'agent-state', state: 'working' });
    await flush();

    await expect(manager.setModel(id, { model: 'opus[1m]' })).rejects.toThrow(/when it finishes its turn/);
    expect(supervisor.driver().commands).toEqual([]);
  });

  it('sesja z otwartym dialogiem też jest zajęta', async () => {
    const { manager, supervisor, id } = await withAgent();
    supervisor.driver().queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
    await flush();

    await expect(manager.setModel(id, { model: 'opus[1m]' })).rejects.toBeInstanceOf(BadStateError);
    expect(supervisor.driver().commands).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // `POST /api/sessions/:id/mode`
  // -------------------------------------------------------------------------

  it('zmiana trybu oddaje 202 i cel do drivera — pętla klawiszy biegnie w tle', async () => {
    const { manager, supervisor, id } = await withAgent();
    expect(await manager.setMode(id, { mode: 'plan' })).toEqual({ ok: true });
    expect(supervisor.driver().modes).toEqual(['plan']);
  });

  it('panel w `bypass` to 409 — Rarog nie odkręca decyzji z biurka', async () => {
    const { manager, supervisor, id } = await withAgent();
    supervisor.freshMode = 'bypass';
    await expect(manager.setMode(id, { mode: 'auto' })).rejects.toBeInstanceOf(BadStateError);
    expect(supervisor.driver().modes).toEqual([]);
  });

  it('nieznany tryb startowy wstrzymuje klawisz — pętla porównuje odczyty, nie liczy', async () => {
    const { manager, supervisor, id } = await withAgent();
    supervisor.freshMode = 'unknown';
    await expect(manager.setMode(id, { mode: 'plan' })).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.driver().modes).toEqual([]);
  });

  it('RAROG_HERDR_SEND=0 odcina też zmianę trybu', async () => {
    const { manager, supervisor, id } = await withAgent(makeAgent(), { herdrSend: false });
    await expect(manager.setMode(id, { mode: 'plan' })).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.driver().modes).toEqual([]);
  });

  it('panel poza RAROG_HERDR_ROOTS nie dostaje klawisza trybu', async () => {
    const { manager, supervisor, id } = await withAgent(
      makeAgent({ inScope: false, cwd: '/Users/u/Prywatne/birch' }),
    );
    await expect(manager.setMode(id, { mode: 'plan' })).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.driver().modes).toEqual([]);
  });

  it('sesja w turze to 409 z radą, klawisz nie wychodzi', async () => {
    const { manager, supervisor, id } = await withAgent();
    supervisor.driver().queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    await expect(manager.setMode(id, { mode: 'plan' })).rejects.toThrow(/when it finishes its turn/);
    expect(supervisor.driver().modes).toEqual([]);
  });

  it('throttle odmawia 429 także zmianie trybu', async () => {
    const { manager, supervisor, deps, id } = await withAgent();
    deps.slots = false;
    await expect(manager.setMode(id, { mode: 'plan' })).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(supervisor.driver().modes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // `POST /api/sessions/:id/focus`
  // -------------------------------------------------------------------------

  it('focus woła `agent.focus` i od razu zdejmuje znacznik nieodebranego wyniku', async () => {
    const { manager, supervisor, id } = await withAgent();
    // `done` w herdr = „wynik, którego nikt nie widział": karta stoi w sekcji uwagi.
    supervisor.driver().queue.push({ type: 'agent-state', state: 'idle', seen: false });
    await flush();
    expect(manager.get(id)?.seen).toBe(false);
    const changed: unknown[] = [];
    manager.onEvent((scope, _seq, event) => {
      if (scope === 'global' && event.type === 'session-changed') changed.push(event.session);
    });

    await manager.focus(id);

    expect(supervisor.focused).toEqual([KEY]);
    // The phone sees only the event: without it the card stays in the attention section until the next resync.
    expect(changed).toContainEqual(expect.objectContaining({ id, seen: true }));
    /*
     * `agent.focus` kasuje znacznik `done` PO STRONIE HERDR, więc karta musi przestać stać
     * w sekcji uwagi w tej samej chwili — czekanie na resync (do 30 s) pokazywałoby „nowy
     * wynik" przy panelu, który użytkownik właśnie ma przed oczami.
     */
    expect(manager.get(id)?.seen).toBe(true);
  });

  it('focus działa dla panelu POZA zasięgiem — to jedyne wyjście z takiej karty', async () => {
    // Panel spoza `RAROG_HERDR_ROOTS` nie przyjmuje wysyłki i nie oddaje transkryptu.
    // „Pokaż w herdr" niczego do niego nie pisze, a jest jedyną sensowną akcją, jaka zostaje.
    const { manager, supervisor, id } = await withAgent(
      makeAgent({ inScope: false, cwd: '/Users/u/Prywatne/birch' }),
    );
    await manager.focus(id);
    expect(supervisor.focused).toEqual([KEY]);
  });

  it('RAROG_HERDR_SEND=0 blokuje focus (to mutacja w cudzym terminalu)', async () => {
    const { manager, supervisor, id } = await withAgent(makeAgent(), { herdrSend: false });
    await expect(manager.focus(id)).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.focused).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Dialog spoza jsonl
  // -------------------------------------------------------------------------

  it('rozpoznany dialog daje `herdrDialog` na karcie i pozwala zatwierdzić', async () => {
    const { manager, supervisor, id } = await withAgent();
    supervisor.driver().queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
    await flush();

    expect(manager.get(id)?.state).toBe('waiting-permission');
    expect(manager.get(id)?.herdrDialog).toBe('trust');
    // Karty zgody NIE MA: taki dialog nie ma `permId`, bo nie ma wpisu w transkrypcie.
    expect(manager.transcript(id).pendingPermissions).toEqual([]);

    await expect(manager.resolvePermission(id, id, 'allow', 'iPhone'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(supervisor.driver().decisions).toEqual([{ reqId: id, decision: 'allow' }]);
    /*
     * Rozpoznanie gaśnie natychmiast po wysłaniu decyzji: drugie tapnięcie (dwa urządzenia,
     * powtórzony tap) wysłałoby DRUGĄ cyfrę do panelu, który zdążył już ruszyć dalej.
     */
    expect(manager.get(id)?.herdrDialog).toBeUndefined();
    await expect(manager.resolvePermission(id, id, 'allow', 'iPad'))
      .rejects.toThrow(HERDR_ALLOW_MESSAGE.text);
  });

  it('`send-failed` oddaje 422 i PRZYWRACA rozpoznanie dialogu', async () => {
    /*
     * Ta karta nie ma wpisu w `#pending`, więc nie chroni jej blokada równoległych prób
     * stamtąd: rozpoznanie gaśnie PRZED wysłaniem cyfry, żeby drugie tapnięcie w oknie
     * odczytu ekranu nie wysłało drugiej cyfry. `send-failed` jest jedyną odmową, przy której
     * z Raroga nie wyszedł ani jeden bajt i driver karty nie wycofał — dialog stoi dalej,
     * a karta bez przycisku kłamałaby o tym, co da się z telefonu zrobić.
     */
    const { manager, supervisor, id } = await withAgent();
    supervisor.driver().queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
    await flush();

    supervisor.driver().decisionOutcome = { kind: 'refused', reason: 'send-failed' };
    await expect(manager.resolvePermission(id, id, 'allow', 'iPhone'))
      .resolves.toEqual({ outcome: 'refused', reason: 'send-failed' });
    expect(manager.get(id)?.herdrDialog).toBe('trust');

    // …i druga próba przechodzi normalnie: pierwsza niczego nie „zużyła".
    supervisor.driver().decisionOutcome = { kind: 'applied' };
    await expect(manager.resolvePermission(id, id, 'allow', 'iPad'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(manager.get(id)?.herdrDialog).toBeUndefined();
  });

  it('odmowa, przy której driver zgasił kartę, NIE wskrzesza rozpoznania', async () => {
    /*
     * Wyścig: `screen-changed` (i każda inna odmowa idąca przez `#clearActive`) emituje `permission-cleared`, po którym
     * manager zeruje `herdrDialog`, a wznowione `#decideHerdrDialog` nie może wpisać tam z powrotem migawki sprzed
     * `await`: telefon dostałby „Zatwierdź" dla dialogu, którego driver się przed chwilą wyparł, a tapnięcie
     * skończyłoby się 410/422. Zerowanie ze strumienia zdarzeń jest prawdą NOWSZĄ i ma wygrać; odbudową karty zajmuje
     * się `#scheduleEvaluate()` w driverze.
     */
    const { manager, supervisor, id } = await withAgent();
    const driver = supervisor.driver();
    driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
    await flush();
    expect(manager.get(id)?.herdrDialog).toBe('trust');

    driver.clearBeforeRefusal = true;
    driver.decisionOutcome = { kind: 'refused', reason: 'screen-changed' };
    await expect(manager.resolvePermission(id, id, 'allow', 'iPhone'))
      .resolves.toEqual({ outcome: 'refused', reason: 'screen-changed' });
    await flush();

    expect(manager.get(id)?.herdrDialog).toBeUndefined();
    // …a skoro rozpoznania nie ma, „Zatwierdź" jest zamknięte na klucz (fail-closed).
    await expect(manager.resolvePermission(id, id, 'allow', 'iPad'))
      .rejects.toThrow(HERDR_ALLOW_MESSAGE.text);
  });

  it('dialog NIEROZPOZNANY przyjmuje tylko „Odrzuć" (TEST OBOWIĄZKOWY)', async () => {
    const { manager, supervisor, id } = await withAgent();
    supervisor.driver().queue.push({ type: 'screen-dialog' });
    await flush();

    expect(manager.get(id)?.state).toBe('waiting-permission');
    expect(manager.get(id)?.herdrDialog).toBeUndefined();
    await expect(manager.resolvePermission(id, id, 'allow', 'iPhone'))
      .rejects.toThrow(HERDR_ALLOW_MESSAGE.text);
    expect(supervisor.driver().decisions).toEqual([]);

    await expect(manager.resolvePermission(id, id, 'deny', 'iPhone'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(supervisor.driver().decisions).toEqual([{ reqId: id, decision: 'deny' }]);
  });

  it('zgaszona karta i wyjście z blokady kasują rozpoznanie', async () => {
    const { manager, supervisor, id } = await withAgent();
    const driver = supervisor.driver();

    driver.queue.push({ type: 'screen-dialog', knownDialog: 'model' });
    await flush();
    expect(manager.get(id)?.herdrDialog).toBe('model');

    // Człowiek odpowiedział W TERMINALU: driver gasi kartę, więc przycisk ma zniknąć.
    driver.queue.push({ type: 'permission-cleared', reason: 'agent nie czeka na decyzję' });
    await flush();
    expect(manager.get(id)?.herdrDialog).toBeUndefined();

    driver.queue.push({ type: 'screen-dialog', knownDialog: 'model' });
    await flush();
    expect(manager.get(id)?.herdrDialog).toBe('model');

    // To samo bez `permission-cleared`: sam powrót panelu do pracy wystarczy.
    driver.queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    expect(manager.get(id)?.herdrDialog).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Czysta funkcja: budowa komend
// ---------------------------------------------------------------------------

describe('modelCommands', () => {
  it('składa `/model` i `/effort` w tej kolejności', () => {
    expect(modelCommands({ model: 'opus[1m]', effort: 'high' }))
      .toEqual(['/model opus[1m]', '/effort high']);
  });

  it('sam effort daje jedną komendę', () => {
    expect(modelCommands({ effort: 'low' })).toEqual(['/effort low']);
  });

  it('pusty model i `effort: null` NIE są komendami', () => {
    // Obie wartości znaczą „wróć do domyślnej", a CLI nie zna slasha bez argumentu:
    // `/model` bez wartości otwiera interaktywny wybór, czyli dialog spoza naszej listy.
    expect(modelCommands({ model: '', effort: null })).toEqual([]);
    expect(modelCommands({})).toEqual([]);
  });

  it('ultracode: forma z rejestru, zawsze ostatnia', () => {
    expect(modelCommands({ ultracode: true })).toEqual([ULTRACODE_COMMANDS.on]);
    expect(modelCommands({ ultracode: false })).toEqual([ULTRACODE_COMMANDS.off]);
    expect(modelCommands({ ultracode: false, effort: 'low', model: 'fable' }))
      .toEqual(['/model fable', '/effort low', ULTRACODE_COMMANDS.off]);
    expect(modelCommands({ ultracode: true, effort: null, model: '' })).toEqual([ULTRACODE_COMMANDS.on]);
  });
});
