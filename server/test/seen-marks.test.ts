/**
 * Seen marks (`server/src/sessions/seen-marks.ts`) through the manager, on supervisor and driver fakes.
 *
 * The tests moved here from `manager-herdr.test.ts` together with the module; the fakes are shared in
 * `helpers/manager-herdr-atrapy.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, TranscriptNotice } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { HerdrUnavailableError } from '../src/herdr/socket.ts';
import type { NoteInput, NotifierLike } from '../src/notify/index.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import type { DriverEvent, InternalBlock } from '../src/drivers/types.ts';
import {
  ENGINE_SESSION, FakeSupervisor, PROJECT, flush, makeAgent, makeDeps,
} from './helpers/manager-herdr-atrapy.ts';
import type { FakeDeps } from './helpers/manager-herdr-atrapy.ts';

describe('manager — znaczniki obejrzenia sesji herdr', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-herdr-'));
  });

  afterEach(async () => {
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
    supervisor: FakeSupervisor, deps: HerdrManagerDeps, overrides: Partial<ManagerConfig> = {},
  ): Promise<Manager> {
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      maxPanes: 6,
      herdrSupervisor: supervisor,
      herdrDeps: deps,
      herdrRoots: [PROJECT],
      herdrSend: true,
      ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    return manager;
  }

  function record(manager: Manager): { scope: string; seq: number | null; event: ServerEvent }[] {
    const out: { scope: string; seq: number | null; event: ServerEvent }[] = [];
    manager.onEvent((scope, seq, event) => { out.push({ scope, seq, event }); });
    return out;
  }

  /** Manager + jedna widoczna sesja herdr gotowa do dalszych kroków. */
  async function withOneAgent(agent: HerdrAgent = makeAgent(), deps = makeDeps()): Promise<{
    manager: Manager; supervisor: FakeSupervisor; deps: FakeDeps; id: string;
  }> {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, deps);
    supervisor.appear(agent);
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    return { manager, supervisor, deps, id };
  }

  // -------------------------------------------------------------------------
  // „Widziane" po wejściu w sesję z telefonu
  // -------------------------------------------------------------------------

  /**
   * Panel z wynikiem, którego NIKT nie widział (`done`), i bez auto-meldunku z atrapy drivera:
   * `seen` ma tu być prawdą o karcie, a nie artefaktem uproszczenia w teście.
   */
  async function withDoneAgent(
    deps: FakeDeps, stateChangeSeq = 12, overrides: Partial<ManagerConfig> = {},
  ): Promise<{
    manager: Manager; supervisor: FakeSupervisor; id: string;
  }> {
    const supervisor = makeSupervisor();
    supervisor.autoSettle = false;
    const manager = await build(supervisor, deps, overrides);
    supervisor.appear(makeAgent({ status: 'done', stateChangeSeq }));
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    return { manager, supervisor, id };
  }

  it('markSeen zdejmuje kartę z sekcji uwagi i gasi `done` w herdr', async () => {
    const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
    const deps = makeDeps(seen);
    const { manager, supervisor, id } = await withDoneAgent(deps);
    expect(manager.get(id)?.seen).toBe(false);

    const events = record(manager);
    manager.markSeen(id);
    await flush();

    expect(manager.get(id)?.seen).toBe(true);
    // Do panelu nie idzie ANI JEDEN znak — jedyną metodą tej ścieżki jest `agent.focus`.
    expect(supervisor.log.calls).toEqual([]);
    // …a ten leci, bo herdr innej dźwigni na „obejrzane" nie ma (`herdr --skill`: „CLI reads
    // do not mark it seen").
    expect(supervisor.focusCalls).toEqual(['w9:p72']);
    expect(events.some((e) => e.event.type === 'session-changed')).toBe(true);
    expect(seen.get('w9:p72')).toEqual({
      agentSessionId: ENGINE_SESSION, stateChangeSeq: 12,
    });

    // Idempotentne: druga wizyta w tej samej karcie nie generuje ani ramki, ani DRUGIEGO
    // przestawienia widoku herdr na Macu.
    const before = events.length;
    manager.markSeen(id);
    await flush();
    expect(events).toHaveLength(before);
    expect(supervisor.focusCalls).toEqual(['w9:p72']);
  });

  it('markSeen NIE rusza herdr dla panelu, który na `done` nie stoi', async () => {
    // `idle` = wynik już widziany w terminalu (`seen: true`), więc `markSeen` wychodzi od razu.
    // Karta `working` jest tu ciekawsza: `seen` jest `undefined`, czyli Rarog NIE WIE
    // o żadnym stojącym `done` — fokus przestawiłby widok na Macu za darmo.
    const supervisor = makeSupervisor();
    supervisor.autoSettle = false;
    const manager = await build(supervisor, makeDeps());
    supervisor.appear(makeAgent({ status: 'working' }));
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    expect(manager.get(id)?.seen).toBeUndefined();

    manager.markSeen(id);
    await flush();

    expect(supervisor.focusCalls).toEqual([]);
  });

  it('`RAROG_HERDR_SEEN_FOCUS=0` zostawia sam znacznik lokalny', async () => {
    const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
    const { manager, supervisor, id } = await withDoneAgent(
      makeDeps(seen), 12, { herdrSeenFocus: false },
    );

    manager.markSeen(id);
    await flush();

    expect(supervisor.focusCalls).toEqual([]);
    // Wyłącznik dotyczy WYŁĄCZNIE herdr — karta i tak schodzi z sekcji uwagi.
    expect(manager.get(id)?.seen).toBe(true);
    expect(seen.get('w9:p72')?.stateChangeSeq).toBe(12);
  });

  it('`RAROG_HERDR_SEND=0` gasi fokus, a karta i tak schodzi (to metoda MUTUJĄCA)', async () => {
    const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
    const { manager, supervisor, id } = await withDoneAgent(
      makeDeps(seen), 12, { herdrSend: false },
    );

    manager.markSeen(id);
    await flush();

    expect(supervisor.focusCalls).toEqual([]);
    expect(manager.get(id)?.seen).toBe(true);
  });

  it('niedostępne gniazdo herdr nie przewraca markSeen (karta i tak schodzi)', async () => {
    const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
    const { manager, supervisor, id } = await withDoneAgent(makeDeps(seen));
    supervisor.setStatus({ available: false });

    expect(() => { manager.markSeen(id); }).not.toThrow();
    await flush();

    expect(supervisor.focusCalls).toEqual([]);
    // Znacznik lokalny jest prawdą o CZŁOWIEKU, nie o gnieździe: zostaje mimo ciszy w herdr.
    expect(manager.get(id)?.seen).toBe(true);
    expect(seen.get('w9:p72')?.stateChangeSeq).toBe(12);
  });

  it('odrzucony `agent.focus` kończy się LINIĄ W LOGU, a nie wyjątkiem z markSeen', async () => {
    const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
    const lines: string[] = [];
    const { manager, supervisor, id } = await withDoneAgent(
      makeDeps(seen), 12, { logger: (line) => { lines.push(line); } },
    );
    // Gniazdo padło PO pre-checku statusu — jedyna droga do bloku `catch`. Bez logu awaria
    // kanału „obejrzane" byłaby nie do zauważenia: badge w herdr wygląda wtedy jak brak wizyty.
    supervisor.focusFails = new HerdrUnavailableError(foreign('gniazdo padło w locie'));

    expect(() => { manager.markSeen(id); }).not.toThrow();
    await flush();

    expect(manager.get(id)?.seen).toBe(true);
    expect(lines.some((l) => l.includes('agent.focus') && l.includes('gniazdo padło w locie')))
      .toBe(true);
  });

  it('znacznik „widziane" przeżywa restart Raroga (karta nie wraca do sekcji uwagi)', async () => {
    const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
    const { manager, id } = await withDoneAgent(makeDeps(seen));
    manager.markSeen(id);
    await manager.dispose();

    // Deploy Raroga: nowy proces, ta sama trwała pamięć — karta ma zostać „widziana".
    const supervisor2 = makeSupervisor();
    supervisor2.autoSettle = false;
    const manager2 = await build(supervisor2, makeDeps(seen));
    supervisor2.appear(makeAgent({ status: 'done', stateChangeSeq: 12 }));
    await flush();

    const card = manager2.list().find((s) => s.paneId !== undefined);
    expect(card?.seen).toBe(true);

    // …ale wynik z NOWSZEJ tury (wyższy numer stanu) już nie jest tym obejrzanym.
    const supervisor3 = makeSupervisor();
    supervisor3.autoSettle = false;
    const manager3 = await build(supervisor3, makeDeps(seen));
    supervisor3.appear(makeAgent({ status: 'done', stateChangeSeq: 13 }));
    await flush();
    expect(manager3.list().find((s) => s.paneId !== undefined)?.seen).toBe(false);
  });

  it('NOWSZY wynik (nowa tura) przebija znacznik i wraca do sekcji uwagi', async () => {
    const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
    const deps = makeDeps(seen);
    const { manager, supervisor, id } = await withDoneAgent(deps);
    manager.markSeen(id);
    expect(manager.get(id)?.seen).toBe(true);

    // Ten sam `done` po resyncu (ten sam numer stanu) NIE wraca do sekcji uwagi…
    supervisor.driver('w9:p72').queue.push({
      type: 'agent-state', state: 'idle', seen: false, stateChangeSeq: 12,
    });
    await flush();
    expect(manager.get(id)?.seen).toBe(true);

    /*
     * …a nowa tura, która skończyła się wynikiem, wraca. Dowodem nowej tury jest ZDARZENIE
     * startu, a nie sam skok numeru: tapnięcie karty wyprzedza dziś
     * `done` z herdr, więc numery po odbiorze rosną także w obrębie tej samej tury.
     */
    supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    expect(manager.get(id)?.seen).toBeUndefined();
    supervisor.driver('w9:p72').queue.push({
      type: 'agent-state', state: 'idle', seen: false, stateChangeSeq: 13,
    });
    await flush();
    expect(manager.get(id)?.seen).toBe(false);
  });

  it('numer NIŻSZY (restart serwera herdr zeruje licznik) unieważnia znacznik', async () => {
    const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
    const { manager, supervisor, id } = await withDoneAgent(makeDeps(seen), 57);
    manager.markSeen(id);
    expect(manager.get(id)?.seen).toBe(true);

    /*
     * `herdr update --handoff` restartuje serwer, a ten startuje `state_change_seq` od zera
     * (zmierzone). Zapamiętany numer 57 nie opisuje już niczego — i lepiej pokazać
     * badge zbędnie, niż schować wynik, którego nikt nie widział. Cofnięty licznik unieważnia
     * też pamięć odbioru z RAM (`seenByHuman`): przez przerwę w kontakcie tura
     * mogła się w tym panelu zacząć i skończyć bez ani jednego zdarzenia.
     */
    supervisor.driver('w9:p72').queue.push({
      type: 'agent-state', state: 'idle', seen: false, stateChangeSeq: 2,
    });
    await flush();
    expect(manager.get(id)?.seen).toBe(false);
  });

  // -------------------------------------------------------------------------
  // `seen` = wynik BIEŻĄCEJ tury, a nie lustro statusu herdr
  // -------------------------------------------------------------------------

  /**
   * Zgłoszenie: „jak agent skończył, to często pojawia się na sidebarze bardzo z opóźnieniem
   * albo wcale". Przypadek „wcale" to panel SFOKUSOWANY w herdr na Macu — po turze dostaje
   * `idle`, nie `done`, więc przy `seen` jako lustrze statusu karta natychmiast dostawałaby
   * `seen: true` i wpadała do zwiniętego ogona „bezczynni" — a resync powtarzałby to co 30 s.
   *
   * Dziś `seen` odpowiada na jedno pytanie: czy wynik TEJ tury odebrał człowiek.
   */
  describe('`seen` = wynik bieżącej tury', () => {
    /** Panel `idle` (herdr: „wynik odebrany") i driver, który nie melduje nic sam z siebie. */
    async function withIdleAgent(
      deps = makeDeps(), overrides: Partial<ManagerConfig> = {},
    ): Promise<{ manager: Manager; supervisor: FakeSupervisor; id: string }> {
      const supervisor = makeSupervisor();
      supervisor.autoSettle = false;
      const manager = await build(supervisor, deps, overrides);
      supervisor.appear(makeAgent({ status: 'idle', stateChangeSeq: 12 }));
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      expect(id).not.toBe('');
      expect(manager.get(id)?.seen).toBe(true);
      return { manager, supervisor, id };
    }

    it('start tury zeruje znacznik, a wynik z jsonl zostawia go pustym', async () => {
      const { manager, supervisor, id } = await withIdleAgent();
      const driver = supervisor.driver('w9:p72');

      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(manager.get(id)?.state).toBe('running');
      expect(manager.get(id)?.seen).toBeUndefined();

      // Koniec tury Rarog widzi NAJPIERW z jsonl — herdr jeszcze o niczym nie wie.
      driver.queue.push({ type: 'result', subtype: 'success' });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-input');
      // `undefined`, a nie `true`: karta ma stanąć w GŁOWIE listy z błękitnym „gotowe".
      expect(manager.get(id)?.seen).toBeUndefined();
    });

    it('herdrowe `idle` PO turze (i jego powtórki z resyncu) nie odbiera wyniku', async () => {
      const { manager, supervisor, id } = await withIdleAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'result', subtype: 'success' });
      await flush();

      // Panel stał na wierzchu w chwili końca tury: herdr nie postawił `done`, tylko `idle`.
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
      await flush();
      expect(manager.get(id)?.seen).toBeUndefined();

      // Resync co 30 s powtarza to samo — i to jest dokładnie ten przypadek, w którym karta
      // nie wychodziła z ogona NIGDY.
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
      await flush();
      expect(manager.get(id)?.seen).toBeUndefined();
    });

    it('`done` → `idle` (ktoś sfokusował panel po turze) JEST odbiorem', async () => {
      const { manager, supervisor, id } = await withIdleAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();

      // herdr postawił badge `done` — jest co odebrać (i jest co zgasić `agent.focus`em).
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: false });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-input');
      expect(manager.get(id)?.seen).toBe(false);

      // …a badge gaśnie w herdr WYŁĄCZNIE przez fokus panelu, czyli przez człowieka u biurka.
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
      await flush();
      expect(manager.get(id)?.seen).toBe(true);
    });

    it('zeruje LISTA ZDARZEŃ, nie kształt przejścia: `permission-resolved` znacznika nie rusza',
      async () => {
        // a) `turn-start` z telefonu zeruje.
        const { manager, supervisor, id } = await withIdleAgent();
        await manager.sendMessage(id, 'zrób coś');
        await flush();
        expect(manager.get(id)?.state).toBe('running');
        expect(manager.get(id)?.seen).toBeUndefined();

        // b) …a powrót do tury, która TRWA, nie: zgoda odebrana z telefonu nowej tury nie
        //    zaczyna, więc odbiór zapisany przy stojącym dialogu ma przeżyć `permission-resolved`.
        const driver = supervisor.driver('w9:p72');
        driver.queue.push({
          type: 'permission-request',
          reqId: 'tool-1', toolName: 'Bash', input: { command: 'ls' }, displayText: 'ls',
        });
        await flush();
        expect(manager.get(id)?.state).toBe('waiting-permission');
        manager.markSeen(id);
        expect(manager.get(id)?.seen).toBe(true);

        await expect(manager.resolvePermission(id, 'tool-1', 'allow', 'iPhone'))
          .resolves.toEqual({ outcome: 'ok' });
        await flush();
        expect(manager.get(id)?.state).toBe('running');
        expect(manager.get(id)?.seen).toBe(true);
      });

    it('dialog w terminalu (`agent-blocked`) TEŻ zaczyna turę i zeruje znacznik', async () => {
      /*
       * Tura zaczęta przy biurku od stojącego dialogu (`AGENT_BLOCKED_FROM` zawiera
       * `waiting-input`: „dialog stoi = ktoś przy biurku wznowił turę"). Bez zerowania
       * właśnie tutaj wynik takiej tury — gdy skończy się herdrowym `idle` bez ani jednego
       * `working` po drodze — wpadałby prosto w zwinięty ogon „bezczynni", a push „Skończył"
       * gasiłby `resultSeen`.
       */
      const { manager, supervisor, id } = await withIdleAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: false });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-input');
      manager.markSeen(id);
      expect(manager.get(id)?.seen).toBe(true);

      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-permission');
      expect(manager.get(id)?.seen).toBeUndefined();
    });

    it('markSeen W TRAKCIE tury gasi tylko powiadomienie — wyniku jeszcze nie ma', async () => {
      const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
      const seenCalls: string[] = [];
      const notifier: NotifierLike = {
        note: () => undefined,
        seen: (id) => { seenCalls.push(id); },
        forget: () => undefined, quiet: () => undefined,
      };
      const { manager, supervisor, id } = await withIdleAgent(makeDeps(seen), { notifier });
      supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(manager.get(id)?.state).toBe('running');

      manager.markSeen(id);
      await flush();

      // Zerknięcie w transkrypt pracującej sesji nie odbiera wyniku, którego jeszcze nie ma…
      expect(manager.get(id)?.seen).toBeUndefined();
      // …a znacznik trwały zapisany „na zapas" chowałby wynik także po restarcie Raroga.
      expect(seen.size).toBe(0);
      expect(supervisor.focusCalls).toEqual([]);
      // Powiadomienie gaśnie mimo to: człowiek właśnie patrzy na tę sesję.
      expect(seenCalls).toEqual([id]);
    });

    it('tapnięcie karty ZARAZ po wyniku przeżywa spóźniony `done` z herdr', async () => {
      /*
       * Przepływ, który ta reguła chroni: `result` z jsonl → karta w głowie
       * listy → tapnięcie na telefonie → dopiero potem `done` z herdr (karencja po wysyłce
       * połyka pusha, ratuje resync do 30 s). Numer stanu w znaczniku trwałym jest wtedy
       * numerem zdarzenia `working`, więc gdyby ten `done` liczył się od zera, karta wracałaby
       * do głowy listy kilkanaście sekund po przeczytaniu — i już by tam została, bo drugiego
       * `POST …/seen` front nie wyśle (dedup po `id|stateSince`).
       */
      const seen = new Map<string, { agentSessionId: string; stateChangeSeq: number }>();
      const { manager, supervisor, id } = await withIdleAgent(makeDeps(seen));
      const driver = supervisor.driver('w9:p72');

      driver.queue.push({ type: 'agent-state', state: 'working', stateChangeSeq: 13 });
      await flush();
      driver.queue.push({ type: 'result', subtype: 'success' });
      await flush();
      expect(manager.get(id)?.seen).toBeUndefined();

      manager.markSeen(id);
      await flush();
      expect(manager.get(id)?.seen).toBe(true);
      expect(seen.get('w9:p72')?.stateChangeSeq).toBe(13);

      driver.queue.push({
        type: 'agent-state', state: 'idle', seen: false, stateChangeSeq: 14,
      });
      await flush();
      expect(manager.get(id)?.seen).toBe(true);
      // …a znacznik trwały przeszedł na numer `done`, więc odbiór przeżyje też restart Raroga.
      expect(seen.get('w9:p72')?.stateChangeSeq).toBe(14);
    });

    it('badge `done` sprzed tury nie robi z poturniowego `idle` fałszywego odbioru', async () => {
      /*
       * Panel zastany na `done` (albo `done` z poprzedniej tury) zostawiał w Rarogu
       * `herdrSeen === false`. Ta pamięć przeżywała całą turę, bo `working` pola `seen`
       * nie niesie — i poturniowe `idle` (panel na wierzchu) wyglądało jak przejście
       * `done → idle`, czyli jak odbiór. Start tury gasi badge po stronie herdr, więc gasi
       * też tę pamięć.
       */
      const { manager, supervisor, id } = await withDoneAgent(makeDeps());
      expect(manager.get(id)?.seen).toBe(false);
      const driver = supervisor.driver('w9:p72');

      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'result', subtype: 'success' });
      await flush();

      driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-input');
      expect(manager.get(id)?.seen).toBeUndefined();
    });

    it('„Pokaż w herdr" W TRAKCIE tury nie odbiera wyniku, którego jeszcze nie ma', async () => {
      // Ta sama bramka co w `markSeen`: fokus leci (człowiek prosił o przestawienie widoku),
      // ale znacznik zostaje pusty — inaczej wynik tury lądowałby od razu w ogonie „bezczynni".
      const { manager, supervisor, id } = await withIdleAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(manager.get(id)?.state).toBe('running');

      await manager.focus(id);
      await flush();
      expect(supervisor.focusCalls).toEqual(['w9:p72']);
      expect(manager.get(id)?.seen).toBeUndefined();

      driver.queue.push({ type: 'result', subtype: 'success' });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-input');
      expect(manager.get(id)?.seen).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Ręczne „nieprzeczytane" z listy
  // -------------------------------------------------------------------------

  describe('markUnseen — „oznacz jako nieprzeczytane"', () => {
    type Marks = Map<string, { agentSessionId: string; stateChangeSeq: number; unseen?: true }>;

    /** Odebrany wynik: panel `idle` przy numerze stanu 12 (adopcja daje `seen: true`). */
    async function withReadResult(
      marks: Marks = new Map(), overrides: Partial<ManagerConfig> = {},
    ): Promise<{ manager: Manager; supervisor: FakeSupervisor; id: string }> {
      const supervisor = makeSupervisor();
      supervisor.autoSettle = false;
      const manager = await build(supervisor, makeDeps(marks), overrides);
      supervisor.appear(makeAgent({ status: 'idle', stateChangeSeq: 12 }));
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      expect(id).not.toBe('');
      expect(manager.get(id)?.seen).toBe(true);
      return { manager, supervisor, id };
    }

    it('cofa odbiór: `seen` → `undefined`, ramka, znacznik trwały; bez herdr i bez powiadomień', async () => {
      const marks: Marks = new Map();
      const notes: NoteInput[] = [];
      const notifier: NotifierLike = {
        note: (input) => { notes.push(input); },
        seen: () => undefined,
        forget: () => undefined, quiet: () => undefined,
      };
      const { manager, supervisor, id } = await withReadResult(marks, { notifier });
      const events = record(manager);

      manager.markUnseen(id);
      await flush();

      // `undefined`, nie `false`: `false` znaczy „w herdr stoi `done`" i uprawniałoby `agent.focus`.
      expect(manager.get(id)?.seen).toBeUndefined();
      expect(events.some((e) => e.event.type === 'session-changed')).toBe(true);
      expect(marks.get('w9:p72')).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 12, unseen: true });
      expect(supervisor.log.calls).toEqual([]);
      expect(supervisor.focusCalls).toEqual([]);
      expect(notes).toEqual([]);

      // Idempotentne: drugi gest nie daje drugiej ramki.
      const before = events.length;
      manager.markUnseen(id);
      await flush();
      expect(events).toHaveLength(before);
    });

    it('w trakcie tury nic nie robi — wyniku jeszcze nie ma', async () => {
      const marks: Marks = new Map();
      const { manager, supervisor, id } = await withReadResult(marks);
      supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(manager.get(id)?.state).toBe('running');

      manager.markUnseen(id);
      await flush();
      expect(marks.size).toBe(0);
      expect(manager.get(id)?.state).toBe('running');
    });

    it('resync `idle` z herdr nie odbiera ręcznego „nieprzeczytane"', async () => {
      const { manager, supervisor, id } = await withReadResult();
      manager.markUnseen(id);
      supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle', seen: true, stateChangeSeq: 12 });
      await flush();
      expect(manager.get(id)?.seen).toBeUndefined();
    });

    it('spóźnione `idle` po odbiorze z fokusem nie cofa „nieprzeczytane"', async () => {
      // `markSeen` na `done` gasi badge fokusem, a `idle` z herdr dochodzi później. W tym oknie człowiek
      // cofa odbiór — spóźnione `idle` nie może tego przebić regułą `done → idle`.
      const marks: Marks = new Map();
      const { manager, supervisor, id } = await withDoneAgent(makeDeps(marks));
      manager.markSeen(id);
      expect(supervisor.focusCalls).toEqual(['w9:p72']);
      manager.markUnseen(id);
      supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle', seen: true, stateChangeSeq: 13 });
      await flush();
      expect(manager.get(id)?.seen).toBeUndefined();
      // To samo `idle` podniosło numer stanu bez nowej tury — wpis trwały idzie za nim,
      // inaczej adopcja po restarcie Raroga nie poznałaby go i karta wróciłaby jako odebrana.
      expect(marks.get('w9:p72')).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 13, unseen: true });
      await manager.dispose();

      const supervisor2 = makeSupervisor();
      supervisor2.autoSettle = false;
      const manager2 = await build(supervisor2, makeDeps(marks));
      supervisor2.appear(makeAgent({ status: 'idle', stateChangeSeq: 13 }));
      await flush();
      expect(manager2.list().find((s) => s.paneId !== undefined)?.seen).toBeUndefined();
    });

    it('nowa tura kończy „nieprzeczytane" — wpis trwały nie idzie już za numerem stanu', async () => {
      const marks: Marks = new Map();
      const { manager, supervisor, id } = await withReadResult(marks);
      manager.markUnseen(id);
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'agent-state', state: 'working', stateChangeSeq: 13 });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: true, stateChangeSeq: 14 });
      await flush();
      expect(marks.get('w9:p72')).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 12, unseen: true });
    });

    it('stojący `done` (fokus wyłączony) zostaje nieodebrany, a fokus na Macu dalej odbiera', async () => {
      const { manager, supervisor, id } = await withDoneAgent(makeDeps(), 12, { herdrSeenFocus: false });
      manager.markSeen(id);
      manager.markUnseen(id);
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: false, stateChangeSeq: 12 });
      await flush();
      expect(manager.get(id)?.seen).toBe(false);
      // Ktoś przy biurku sfokusował panel: `done → idle` to odbiór.
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: true, stateChangeSeq: 13 });
      await flush();
      expect(manager.get(id)?.seen).toBe(true);
    });

    it('odbiór po „nieprzeczytane" nie przestawia widoku herdr — badge\'a nie ma', async () => {
      const marks: Marks = new Map();
      const { manager, supervisor, id } = await withReadResult(marks);
      manager.markUnseen(id);
      manager.markSeen(id);
      await flush();
      expect(manager.get(id)?.seen).toBe(true);
      expect(supervisor.focusCalls).toEqual([]);
      expect(marks.get('w9:p72')).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 12 });
    });

    it('przeżywa restart Raroga; wpis przy innym numerze stanu nie działa', async () => {
      const marks: Marks = new Map();
      const { manager, id } = await withReadResult(marks);
      manager.markUnseen(id);
      await manager.dispose();

      const supervisor2 = makeSupervisor();
      supervisor2.autoSettle = false;
      const manager2 = await build(supervisor2, makeDeps(marks));
      supervisor2.appear(makeAgent({ status: 'idle', stateChangeSeq: 12 }));
      await flush();
      expect(manager2.list().find((s) => s.paneId !== undefined)?.seen).toBeUndefined();

      const supervisor3 = makeSupervisor();
      supervisor3.autoSettle = false;
      const manager3 = await build(supervisor3, makeDeps(marks));
      supervisor3.appear(makeAgent({ status: 'idle', stateChangeSeq: 13 }));
      await flush();
      expect(manager3.list().find((s) => s.paneId !== undefined)?.seen).toBe(true);
    });

    describe('`markedUnseen` on the card: the result was marked unread by hand', () => {
      it('is sent after markUnseen and gone after markSeen', async () => {
        const { manager, id } = await withReadResult();
        expect(manager.get(id)?.markedUnseen).toBeUndefined();
        const events = record(manager);

        manager.markUnseen(id);
        await flush();
        expect(manager.get(id)?.markedUnseen).toBe(true);
        const changed = events.filter((e) => e.event.type === 'session-changed').at(-1)?.event;
        expect(changed?.type === 'session-changed' ? changed.session.markedUnseen : undefined).toBe(true);

        manager.markSeen(id);
        await flush();
        expect(manager.get(id)?.seen).toBe(true);
        expect(manager.get(id)?.markedUnseen).toBeUndefined();
      });

      it('a new turn after markUnseen drops it', async () => {
        const { manager, supervisor, id } = await withReadResult();
        manager.markUnseen(id);
        const driver = supervisor.driver('w9:p72');
        driver.queue.push({ type: 'agent-state', state: 'working', stateChangeSeq: 13 });
        await flush();
        expect(manager.get(id)?.markedUnseen).toBeUndefined();
        driver.queue.push({ type: 'agent-state', state: 'idle', seen: true, stateChangeSeq: 14 });
        await flush();
        expect(manager.get(id)?.state).toBe('waiting-input');
        expect(manager.get(id)?.markedUnseen).toBeUndefined();
      });

      it('survives a Rarog restart: the adopted idle pane with a durable unread entry carries it', async () => {
        const marks: Marks = new Map();
        const { manager, id } = await withReadResult(marks);
        manager.markUnseen(id);
        await manager.dispose();

        const supervisor2 = makeSupervisor();
        supervisor2.autoSettle = false;
        const manager2 = await build(supervisor2, makeDeps(marks));
        supervisor2.appear(makeAgent({ status: 'idle', stateChangeSeq: 12 }));
        await flush();
        const card = manager2.list().find((s) => s.paneId !== undefined);
        expect(card?.seen).toBeUndefined();
        expect(card?.markedUnseen).toBe(true);
        // A late `idle` with a higher number moves the entry and keeps the mark (`applyHerdrSeen`).
        supervisor2.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle', seen: true, stateChangeSeq: 13 });
        await flush();
        expect(marks.get('w9:p72')).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 13, unseen: true });
        expect(manager2.get(card?.id ?? '')?.markedUnseen).toBe(true);
      });

      it('survives a Rarog restart while herdr still shows `done` (seen without focus)', async () => {
        const marks: Marks = new Map();
        const { manager, id } = await withDoneAgent(makeDeps(marks), 12, { herdrSeenFocus: false });
        manager.markSeen(id);
        manager.markUnseen(id);
        await flush();
        expect(manager.get(id)?.markedUnseen).toBe(true);
        await manager.dispose();

        const supervisor2 = makeSupervisor();
        supervisor2.autoSettle = false;
        const manager2 = await build(supervisor2, makeDeps(marks), { herdrSeenFocus: false });
        supervisor2.appear(makeAgent({ status: 'done', stateChangeSeq: 12 }));
        await flush();
        const card = manager2.list().find((s) => s.paneId !== undefined);
        // `false` stays: the `done` badge still stands in herdr.
        expect(card?.seen).toBe(false);
        expect(card?.markedUnseen).toBe(true);
      });

      it('an ordinary unread result (done in herdr, nobody marked it) does not carry it', async () => {
        const { manager, id } = await withDoneAgent(makeDeps());
        expect(manager.get(id)?.seen).toBe(false);
        expect(manager.get(id)?.markedUnseen).toBeUndefined();
      });
    });

    it('„Pokaż w herdr" po „nieprzeczytane" zapisuje odbiór — restart nie wraca do niebieskiego', async () => {
      const marks: Marks = new Map();
      const { manager, id } = await withReadResult(marks);
      manager.markUnseen(id);
      await manager.focus(id);
      expect(manager.get(id)?.seen).toBe(true);
      await manager.dispose();

      const supervisor2 = makeSupervisor();
      supervisor2.autoSettle = false;
      const manager2 = await build(supervisor2, makeDeps(marks));
      supervisor2.appear(makeAgent({ status: 'idle', stateChangeSeq: 12 }));
      await flush();
      expect(manager2.list().find((s) => s.paneId !== undefined)?.seen).toBe(true);
    });
  });

  it('`seen` rozróżnia herdrowe idle (widziane) od done (wynik nieodebrany)', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle', seen: true });
    await flush();
    expect(manager.get(id)?.seen).toBe(true);

    supervisor.driver('w9:p72').queue.push({
      type: 'agent-state', state: 'idle', seen: false,
    });
    await flush();
    expect(manager.get(id)?.seen).toBe(false);
    expect(manager.get(id)?.state).toBe('waiting-input');
  });

  /*
   * A turn without a result (`noResultTurn`: started by a subagent standby notice alone, or by an artifact
   * notification alone with no tool call) does not light the card as a new result when the previous result was
   * already received.
   */
  describe('a turn without a result keeps the received result', () => {
    type Marks = Map<string, { agentSessionId: string; stateChangeSeq: number; unseen?: true }>;
    const STANDBY: TranscriptNotice = { kind: 'agent', outcome: 'waiting', name: 'E5 shared views' };
    const ARTIFACT: TranscriptNotice = { kind: 'artifact-watch', name: 'Report' };
    const text = (value: string): InternalBlock[] => [{ type: 'text', text: foreign(value) }];
    const notice = (value: TranscriptNotice): DriverEvent => ({
      type: 'message', role: 'user', blocks: text('<task-notification>…</task-notification>'), notice: value,
    });
    const typed = (value: string): DriverEvent => ({ type: 'message', role: 'user', blocks: text(value) });
    const toolCall: DriverEvent = {
      type: 'message', role: 'assistant', blocks: [{ type: 'tool-call', toolName: 'Artifact', summary: 'publish' }],
    };
    const working = (stateChangeSeq: number): DriverEvent => ({ type: 'agent-state', state: 'working', stateChangeSeq });
    const idle = (stateChangeSeq: number, seen?: boolean): DriverEvent => ({
      type: 'agent-state', state: 'idle', stateChangeSeq, ...(seen === undefined ? {} : { seen }),
    });

    /**
     * A herdr session after one ordinary turn (the turn tally is complete only after a seen turn end), its result
     * lying unreceived at state number 11.
     */
    async function rig(marks: Marks = new Map()): Promise<{
      manager: Manager; id: string; events: ReturnType<typeof record>; feed: (...e: DriverEvent[]) => Promise<void>;
    }> {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(marks));
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      expect(manager.get(id)?.state).toBe('waiting-input');
      const feed = async (...list: DriverEvent[]): Promise<void> => {
        for (const event of list) {
          supervisor.driver('w9:p72').queue.push(event);
          await flush();
        }
      };
      await feed(typed('do it'), working(10), idle(11));
      expect(manager.get(id)?.seen).toBeUndefined();
      return { manager, id, events: record(manager), feed };
    }

    /** `seen` in the last session frame sent to the clients. */
    function frameSeen(events: ReturnType<typeof record>): boolean | undefined {
      const changed = events.filter((e) => e.event.type === 'session-changed').at(-1)?.event;
      return changed?.type === 'session-changed' ? changed.session.seen : undefined;
    }

    it('received result, then a standby-only turn: the card stays received, also after a later herdr `done`',
      async () => {
        const marks: Marks = new Map();
        const r = await rig(marks);
        r.manager.markSeen(r.id);
        expect(r.manager.get(r.id)?.seen).toBe(true);

        await r.feed(notice(STANDBY), working(12), idle(13));
        expect(r.manager.get(r.id)?.state).toBe('waiting-input');
        expect(r.manager.get(r.id)?.seen).toBe(true);
        expect(frameSeen(r.events)).toBe(true);
        expect(marks.get('w9:p72')?.stateChangeSeq).toBe(13);

        // The `done` badge from herdr comes later, with a higher number.
        await r.feed(idle(14, false));
        expect(r.manager.get(r.id)?.seen).toBe(true);
        expect(marks.get('w9:p72')?.stateChangeSeq).toBe(14);
      });

    it('result not received, then a standby-only turn: the card stays a new result', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY), working(12), idle(13));
      expect(r.manager.get(r.id)?.state).toBe('waiting-input');
      expect(r.manager.get(r.id)?.seen).not.toBe(true);
    });

    it('received result, then a human prompt: the turn has a result', async () => {
      const r = await rig();
      r.manager.markSeen(r.id);
      await r.feed(typed('and now this'), working(12), idle(13));
      expect(r.manager.get(r.id)?.seen).not.toBe(true);
      expect(frameSeen(r.events)).not.toBe(true);
    });

    it('received result, then an artifact notification without tools: received; a late tool call undoes it',
      async () => {
        const r = await rig();
        r.manager.markSeen(r.id);
        await r.feed(notice(ARTIFACT), working(12), idle(13));
        expect(r.manager.get(r.id)?.seen).toBe(true);

        // The tool call entry reached the manager from the file after the turn end (`LATE_TOOL_CALL_MS`).
        await r.feed(toolCall);
        expect(r.manager.get(r.id)?.seen).not.toBe(true);
        expect(frameSeen(r.events)).not.toBe(true);
      });

    it('result marked unread by hand, then a standby-only turn: the card stays a new result', async () => {
      const r = await rig();
      r.manager.markSeen(r.id);
      r.manager.markUnseen(r.id);
      await r.feed(notice(STANDBY), working(12), idle(13));
      expect(r.manager.get(r.id)?.seen).not.toBe(true);
    });

    /*
     * A late tool call takes the carried receipt back also in the durable store: the turn had a result, so neither
     * the next resync of the same `done` nor the adoption after a Rarog restart may treat it as received.
     */
    describe('a late tool call takes the carried receipt back for good', () => {
      async function undone(marks: Marks): Promise<Awaited<ReturnType<typeof rig>>> {
        const r = await rig(marks);
        r.manager.markSeen(r.id);
        await r.feed(notice(ARTIFACT), working(12), idle(13));
        expect(r.manager.get(r.id)?.seen).toBe(true);
        await r.feed(toolCall);
        expect(r.manager.get(r.id)?.seen).not.toBe(true);
        return r;
      }

      it('the resync repeating the same `done` does not bring the receipt back', async () => {
        const r = await undone(new Map());
        await r.feed(idle(13, false));
        expect(r.manager.get(r.id)?.seen).not.toBe(true);
      });

      it('the pane adopted after a Rarog restart is not received', async () => {
        const marks: Marks = new Map();
        const r = await undone(marks);
        await r.manager.dispose();

        const supervisor2 = makeSupervisor();
        supervisor2.autoSettle = false;
        const manager2 = await build(supervisor2, makeDeps(marks));
        supervisor2.appear(makeAgent({ status: 'done', stateChangeSeq: 13 }));
        await flush();
        expect(manager2.list().find((s) => s.paneId !== undefined)?.seen).not.toBe(true);
      });
    });

    /* A real receipt between the carried one and a late tool call stays: the human did read this result. */
    describe('a real receipt after the carried one survives a late tool call', () => {
      async function restored(): Promise<Awaited<ReturnType<typeof rig>>> {
        const r = await rig();
        r.manager.markSeen(r.id);
        // The turn ends with the `done` badge in herdr.
        await r.feed(notice(ARTIFACT), working(12), idle(13, false));
        expect(r.manager.get(r.id)?.seen).toBe(true);
        return r;
      }

      it('focus of the pane on the Mac (`done → idle` from herdr)', async () => {
        const r = await restored();
        await r.feed(idle(14, true));
        await r.feed(toolCall);
        expect(r.manager.get(r.id)?.seen).toBe(true);
      });

      it('the session opened in Rarog (`markSeen`)', async () => {
        const r = await restored();
        r.manager.markSeen(r.id);
        await r.feed(toolCall);
        expect(r.manager.get(r.id)?.seen).toBe(true);
      });

      it('"Show in herdr" (`focus`)', async () => {
        const r = await restored();
        await r.manager.focus(r.id);
        await r.feed(toolCall);
        expect(r.manager.get(r.id)?.seen).toBe(true);
      });
    });
  });
});
