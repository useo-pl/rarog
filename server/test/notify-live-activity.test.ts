/**
 * Live Activity apki natywnej — stan zbiorczy, ładunek APNs i sterownik.
 *
 * Trzy warstwy, każda osobno:
 * - `aggregateState` (czyste): liczniki, sesja wiodąca, faza workflow; ZERO treści — strażnik
 *   prywatności na sesjach z komendą w `waitingFor.text`, `activity.summary` i `lastSummary`;
 * - `apnsLiveActivityRequest` (czyste): nagłówki `liveactivity`, `aps.timestamp`, `stale-date`,
 *   `dismissal-date`, sufit 4 kB z przycinaniem po skalarach Unicode;
 * - sterownik (`createLiveActivity`): diff po TREŚCI (`updatedEpoch` poza porównaniem), throttle
 *   15 s, natychmiast i priorytetem 10 przy WZROŚCIE `waiting`, heartbeat co 10 min, koniec po
 *   30 min ciszy (29:59 nic, 30:00 `end`, praca w 29. minucie zeruje zegar), koniec z trasy
 *   i przy wyrejestrowaniu, rotacja tokenu, spóźnione `410` po rotacji nic nie kasuje; dźwięk
 *   „skończył”: od razu z alertem i krótkim wygaśnięciem, przerwa 20 s, termin 30 s,
 *   bez ponowień, kasowany powrotem do Raroga; `apns-topic` aktualizacji i końca z tematu WPISU
 *   urządzenia; droga wysyłki: kontekst z tematem i przepustką bloku
 *   przechwycony z rekordem (także dla `end` po skasowaniu bloku), `pass-missing` budzony zapisaną przepustką.
 *
 * Zegar i timery są wstrzykiwane (wzorzec `notify-harmonogram.test.ts`), nadajnik to atrapa,
 * rejestr — prawdziwy plik w katalogu tymczasowym.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundTask, SessionSummary } from '@rarog/shared';
import type { ApnsEnvironment, LiveActivityContentState } from '@rarog/shared/rest';
import { LIVE_ACTIVITY_TEXT_MAX, liveActivityContentStateSchema } from '@rarog/shared/rest';
import type { ApnsResult } from '../src/notify/apns.ts';
import { APNS_PAYLOAD_MAX_BYTES, apnsLiveActivityRequest } from '../src/notify/apns-payload.ts';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import {
  LIVE_ACTIVITY_AGE_END_MS, LIVE_ACTIVITY_CHIME_MIN_GAP_MS, LIVE_ACTIVITY_CHIME_TTL_MS, LIVE_ACTIVITY_COALESCE_MS,
  LIVE_ACTIVITY_COUNTS_LOG,
  LIVE_ACTIVITY_HEARTBEAT_MS, LIVE_ACTIVITY_MAX_AGE_MS, LIVE_ACTIVITY_QUIET_END_MS, LIVE_ACTIVITY_RETRY_MS,
  LIVE_ACTIVITY_THROTTLE_MS, createLiveActivity,
} from '../src/notify/live-activity.ts';
import { aggregateState, contentKey, isBusy } from '../src/notify/live-activity-state.ts';
import { createManager } from '../src/sessions/manager.ts';
import { makeSummary } from './fake-manager.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';
import {
  DEVICE, IDLE, NOW, NOW_S, ONE_WAITING, RAROG_TOPIC, TWO_WAITING, UPDATE_1, UPDATE_2, WORKING, aps, iso, owner,
  registered, setup, stateOf, useLiveActivityHarness,
} from './helpers/live-activity-harness.ts';
import type { Harness, Sent } from './helpers/live-activity-harness.ts';

// ---------------------------------------------------------------------------
// Stan zbiorczy
// ---------------------------------------------------------------------------

describe('aggregateState — liczniki i cel tapnięcia', () => {
  it('na seedach demo: 2 czekają, 2 pracują, skończone z `waiting-input`; cel = najdłużej czekająca', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-la-demo-'));
    const manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir, now: () => NOW });
    try {
      await manager.ready;
      const sessions = manager.list();
      const state = aggregateState(sessions, NOW);
      expect(state.waiting).toBe(2);
      expect(state.working).toBe(2);
      expect(state.finished).toBe(sessions.filter((s) => s.state === 'waiting-input' && s.seen !== true).length);
      const waiting = sessions.filter((s) => s.state === 'waiting-permission' || s.state === 'waiting-question');
      const oldest = [...waiting].sort((a, b) => Date.parse(a.stateSince) - Date.parse(b.stateSince))[0];
      // v2: cel tapnięcia bez nazwy, narzędzia i czasu — kafel mówi tylko, ILE czeka.
      expect(state.top).toEqual({ sessionId: oldest?.id });
      expect(state.updatedEpoch).toBe(NOW_S);
      // Wynik jest dokładnie kształtem kontraktu — schemat niczego nie odcina.
      expect(liveActivityContentStateSchema.parse(state)).toEqual(state);
    } finally {
      await manager.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('`finished` = `waiting-input` z wynikiem nieodebranym (lustro `isFinished` PWA): brak i `false` liczą się, `true` nie', () => {
    const state = aggregateState([
      makeSummary({ id: 'a', state: 'waiting-input' }), makeSummary({ id: 'b', state: 'waiting-input', seen: false }),
      makeSummary({ id: 'c', state: 'waiting-input', seen: true }), makeSummary({ id: 'd', state: 'done' }),
      makeSummary({ id: 'e', state: 'resumable' }), makeSummary({ id: 'f', state: 'error' }),
    ], NOW);
    expect(state).toEqual({ waiting: 0, working: 0, finished: 2, updatedEpoch: NOW_S });
  });

  it('„pracuje w tle": sesja po turze z żywym zadaniem w tle liczy się do pracy, nie do „skończyły"', () => {
    const shell: BackgroundTask = { id: 'c', kind: 'command', command: 'pnpm test' };
    const state = aggregateState([
      makeSummary({ id: 'a', state: 'waiting-input', backgroundTasks: [shell] }),
      makeSummary({ id: 'b', state: 'waiting-input', seen: true, backgroundTasks: [shell] }),
      makeSummary({ id: 'c', state: 'done', backgroundTasks: [shell] }),
      makeSummary({ id: 'g', state: 'resumable', backgroundTasks: [shell] }),
      // Rozkład przebiegu jeszcze nieodczytany — „nie wiem" to dalej praca, jak w `isBusy`.
      makeSummary({ id: 'h', state: 'waiting-input', backgroundTasks: [{ id: 'w', kind: 'workflow', runId: 'wf_w' }] }),
      // Przebieg, w którym wszyscy agenci skończyli, już nie mieli — wynik do odebrania zostaje wynikiem.
      makeSummary({
        id: 'd', state: 'waiting-input', backgroundTasks: [workflowTask('w', { agents: [[undefined, true]] })],
      }),
      // Błąd i decyzja zostają sobą, jak na liście.
      makeSummary({ id: 'e', state: 'error', backgroundTasks: [shell] }),
      makeSummary({ id: 'f', state: 'waiting-permission', backgroundTasks: [shell] }),
    ], NOW);
    expect(state).toMatchObject({ waiting: 1, working: 5, finished: 1 });
    expect(state.top).toEqual({ sessionId: 'f' });
    // Sesja „w tle" nie jest celem tapnięcia: jej tura już się skończyła.
    const alone = aggregateState([makeSummary({ id: 'a', state: 'waiting-input', backgroundTasks: [shell] })], NOW);
    expect(alone).toMatchObject({ working: 1, finished: 0 });
    expect(alone.top).toBeUndefined();
  });

  /*
   * Subagent w postoju (`waitingSince`) skończył turę i czeka na własną komendę. Do „pracuje" się
   * nie liczy, więc sesja po turze z samym czekającym wraca do „skończyły" (wynik nieodebrany) albo
   * do niczego (wynik odebrany). Obok czegokolwiek, co pracuje, sesja zostaje przy pracy.
   */
  it('subagent w postoju nie jest pracą: sam → „skończyły"; obok komendy albo pracującego → „pracuje"', () => {
    const waiting: BackgroundTask = {
      id: 'a1', kind: 'agent', description: 'Shared views', waitingSince: '2026-10-07T09:42:00.000Z',
      ownTasks: [{ id: 'b1', command: 'until grep -q TEST log.txt; do sleep 5; done' }],
    };
    const working: BackgroundTask = { id: 'a2', kind: 'agent', description: 'przegląd logu' };
    const shell: BackgroundTask = { id: 'c', kind: 'command', command: 'pnpm test' };
    const state = aggregateState([
      makeSummary({ id: 'a', state: 'waiting-input', backgroundTasks: [waiting] }),
      makeSummary({ id: 'b', state: 'waiting-input', seen: true, backgroundTasks: [waiting] }),
      makeSummary({ id: 'c', state: 'done', backgroundTasks: [waiting] }),
      makeSummary({ id: 'd', state: 'waiting-input', backgroundTasks: [waiting, shell] }),
      makeSummary({ id: 'e', state: 'waiting-input', seen: true, backgroundTasks: [waiting, working] }),
    ], NOW);
    expect(state).toEqual({ waiting: 0, working: 2, finished: 1, updatedEpoch: NOW_S });
    // Sam czekający subagent kafla nie trzyma i go nie stawia (zegar ciszy liczy tylko workflow).
    expect(isBusy([makeSummary({ id: 'a', state: 'waiting-input', backgroundTasks: [waiting] })])).toBe(false);
  });

  it('czekająca wygrywa z pracującą; pytanie też czeka; `starting` liczy się do pracy', () => {
    const state = aggregateState([
      makeSummary({ id: 'run', state: 'running', stateSince: iso(NOW - 600_000) }),
      makeSummary({ id: 'start', state: 'starting', stateSince: iso(NOW - 900_000) }),
      makeSummary({ id: 'ask', state: 'waiting-question', stateSince: iso(NOW - 5_000), label: 'pytanie' }),
    ], NOW);
    expect(state).toMatchObject({ waiting: 1, working: 2, finished: 0 });
    expect(state.top).toEqual({ sessionId: 'ask' });
  });

  it('wpis Codexa niesie `termId` (tap prowadzi do terminala); `termId` spoza kształtu wypada', () => {
    const codex = aggregateState([makeSummary({
      id: 'codex', engine: 'codex', termId: '0123456789abcdef', state: 'waiting-permission',
    })], NOW);
    expect(codex.top).toEqual({ sessionId: 'codex', termId: '0123456789abcdef' });
    const bad = aggregateState([makeSummary({ id: 'x', termId: '../etc', state: 'running' })], NOW);
    expect(bad.top).toEqual({ sessionId: 'x' });
  });

  it('limity i obciążenie Maca z `extras`; puste obiekty nie jadą', () => {
    const state = aggregateState([], NOW, { limits: { fiveHour: 42, weekly: 81 }, mac: { cpu: 35, disk: 60 } });
    expect(state).toEqual({
      waiting: 0, working: 0, finished: 0, limits: { fiveHour: 42, weekly: 81 }, mac: { cpu: 35, disk: 60 },
      updatedEpoch: NOW_S,
    });
    expect(aggregateState([], NOW, { limits: {}, mac: {} })).toEqual({ waiting: 0, working: 0, finished: 0, updatedEpoch: NOW_S });
  });
});

/** Zadanie workflow z rozkładem: `agents` jako [faza, skończył] (faza `undefined` = bez tagu). */
function workflowTask(
  id: string,
  options: { name?: string; runId?: string; ago?: number; phases?: string[]; agents?: [string | undefined, boolean][] },
): BackgroundTask {
  return {
    id, kind: 'workflow', description: options.name ?? 'audyt', runId: options.runId ?? `wf_${id}`,
    ...(options.ago === undefined ? {} : { startedAt: iso(NOW - options.ago) }),
    run: {
      phases: options.phases ?? [],
      agents: (options.agents ?? []).map(([phase, done], i) => ({
        id: `${id}-${String(i)}`, done, ...(phase === undefined ? {} : { phase }),
      })),
    },
  };
}

describe('aggregateState — przebiegi workflow (do dwóch, z paskiem faz)', () => {
  it('przebieg z planem: segment na fazę (done/agents w %), bieżąca faza od 1, tytuł fazy', () => {
    const state = aggregateState([makeSummary({
      id: 's', title: 'rarog', state: 'waiting-input',
      backgroundTasks: [workflowTask('a', {
        name: 'audyt-docs', ago: 60_000, phases: ['A1 Zbieranie', ' A2 Serwer ', 'A3 Synteza'],
        agents: [
          ['A1 Zbieranie', true], ['A1 Zbieranie', true],
          [' A2 Serwer ', true], [' A2 Serwer ', false], [' A2 Serwer ', false],
        ],
      })],
    })], NOW);
    expect(state.workflows).toEqual([{
      sessionId: 's', project: 'rarog', name: 'audyt-docs', agents: 5, done: 3,
      phase: { index: 2, count: 3, title: 'A2 Serwer' }, segments: [100, 33, 0],
      states: ['done', 'running', 'pending'],
    }]);
    expect(liveActivityContentStateSchema.parse(state)).toEqual(state);
  });

  /** Przebieg z planem faz `phases` i agentami `[faza, skończył]` → `states` jedynego przebiegu na kaflu. */
  const statesOf = (phases: string[], agents: [string, boolean][]): unknown => aggregateState([makeSummary({
    id: 's', state: 'running', backgroundTasks: [workflowTask('a', { ago: 60_000, phases, agents })],
  })], NOW).workflows?.[0]?.states;

  it('stan fazy z liczników: {2 z 2} skończona, {0 z 1} w pracy, {0 z 0} niezaczęta', () => {
    expect(statesOf(['A', 'B', 'C'], [['A', true], ['A', true], ['B', false]])).toEqual(['done', 'running', 'pending']);
  });

  it('kilka faz naraz w pracy; skończona faza z nowym agentem wraca do pracy — niezależnie od fazy bieżącej', () => {
    expect(statesOf(['A', 'B', 'C'], [['A', false], ['B', true], ['B', false]])).toEqual(['running', 'running', 'pending']);
    // Faza B była 2/2 (skończona), rusza trzeci agent: znowu w pracy, choć fazą bieżącą jest A.
    expect(statesOf(['A', 'B'], [['A', false], ['B', true], ['B', true]])).toEqual(['running', 'done']);
    expect(statesOf(['A', 'B'], [['A', false], ['B', true], ['B', true], ['B', false]])).toEqual(['running', 'running']);
    // Porażka liczy się jak skończenie: w rozkładzie to `done: true`.
    expect(statesOf(['A', 'B'], [['A', true], ['B', true]])).toEqual(['done', 'done']);
  });

  it('zaokrąglony procent nie rozstrzyga stanu: 199 z 200 to 100 %, a faza dalej w pracy; 0 z 1 to nie „niezaczęta”', () => {
    const many: [string, boolean][] = Array.from({ length: 200 }, (_, i) => ['A', i > 0]);
    const state = aggregateState([makeSummary({
      id: 's', state: 'running',
      backgroundTasks: [workflowTask('a', { ago: 60_000, phases: ['A', 'B', 'C'], agents: [...many, ['B', false]] })],
    })], NOW);
    expect(state.workflows?.[0]).toMatchObject({ segments: [100, 0, 0], states: ['running', 'running', 'pending'] });
  });

  it('sama zmiana stanu fazy (ten sam procent) zmienia klucz treści — kafel dostaje aktualizację', () => {
    const at = (agents: [string, boolean][]): string => contentKey(aggregateState([makeSummary({
      id: 's', state: 'running',
      backgroundTasks: [workflowTask('a', { ago: 60_000, phases: ['A', 'B'], agents })],
    })], NOW));
    // B: {0 z 0} niezaczęta → {0 z 1} w pracy. Agent z fazą spoza planu liczy się do `agents`, ale nie do
    // faz, więc oba stany mają tych samych agentów, fazę bieżącą i segmenty [0, 0] — różni je tylko `states`.
    expect(at([['A', false], ['B', false]])).not.toBe(at([['A', false], ['X', false]]));
  });

  it('bez planu, bez agentów, ponad 12 faz i plan bez tagów: jeden segment całości, bez `phase`', () => {
    const many = Array.from({ length: 13 }, (_, i) => `F${String(i + 1)}`);
    const unplanned = aggregateState([makeSummary({
      id: 's', state: 'running',
      backgroundTasks: [
        workflowTask('tagi', { ago: 50_000, agents: [['X', true], ['Y', false]] }),
        workflowTask('pusty', { ago: 40_000 }),
      ],
    })], NOW);
    expect(unplanned.workflows?.map((w) => [w.segments, w.phase])).toEqual([[[50], undefined], [[0], undefined]]);
    const odd = aggregateState([makeSummary({
      id: 't', state: 'running',
      backgroundTasks: [
        workflowTask('duzy', { ago: 30_000, phases: many, agents: [['F1', true], ['F2', false]] }),
        workflowTask('bez-tagow', { ago: 20_000, phases: ['A', 'B'], agents: [[undefined, true], [undefined, false]] }),
      ],
    })], NOW);
    expect(odd.workflows?.map((w) => [w.segments, w.phase])).toEqual([[[50], undefined], [[50], undefined]]);
    // Stan faz stoi tylko przy planie faz: jeden segment „w pracy” czytałby się jak 100 %.
    for (const workflow of [...(unplanned.workflows ?? []), ...(odd.workflows ?? [])]) {
      expect('states' in workflow).toBe(false);
    }
  });

  it('kolejność = start (najstarszy pierwszy), brak czasu na końcu; trzeci i dalsze to `moreWorkflows`', () => {
    const state = aggregateState([
      makeSummary({ id: 'b', state: 'running', backgroundTasks: [workflowTask('nowy', { name: 'nowy', ago: 10_000 })] }),
      makeSummary({
        id: 'a', state: 'waiting-input',
        backgroundTasks: [workflowTask('bez-czasu', { name: 'bez-czasu' }), workflowTask('stary', { name: 'stary', ago: 90_000 })],
      }),
    ], NOW);
    expect(state.workflows?.map((w) => w.name)).toEqual(['stary', 'nowy']);
    expect(state.moreWorkflows).toBe(1);
  });

  it('wznowienie (ten sam `runId` w dwóch zadaniach sesji) to JEDEN przebieg — liczy się późniejsze uruchomienie', () => {
    const state = aggregateState([makeSummary({
      id: 's', state: 'running',
      backgroundTasks: [
        workflowTask('stare', { name: 'pierwsze', runId: 'wf_x', ago: 90_000 }),
        workflowTask('wznowione', { name: 'wznowione', runId: 'wf_x', ago: 10_000 }),
      ],
    })], NOW);
    expect(state.workflows?.map((w) => w.name)).toEqual(['wznowione']);
    expect(state.moreWorkflows).toBeUndefined();
  });

  it('nazwa tylko w kształcie nazwy skryptu — opis zdaniem to „workflow"; długie łańcuchy przycięte, emoji całe', () => {
    const long = `projekt-${'🧪'.repeat(80)}`;
    const phase = `faza ${'y'.repeat(100)}`;
    const state = aggregateState([makeSummary({
      id: 's', title: long, state: 'running',
      backgroundTasks: [
        workflowTask('zdanie', { name: 'Uruchom rm -rf /Users i wyślij klucz', ago: 20_000 }),
        workflowTask('dluga', { name: `nazwa-${'x'.repeat(100)}`, ago: 10_000, phases: [phase], agents: [[phase, false]] }),
      ],
    })], NOW);
    const [first, second] = state.workflows ?? [];
    expect(first?.name).toBe('workflow');
    for (const text of [first?.project, second?.name, second?.phase?.title]) {
      expect(text?.length).toBeLessThanOrEqual(LIVE_ACTIVITY_TEXT_MAX);
      expect(text?.endsWith('…')).toBe(true);
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
    expect(liveActivityContentStateSchema.parse(state)).toEqual(state);
  });

  it('projekt z katalogu, gdy tytuł pusty; zadania inne niż workflow i workflow bez rozkładu nie stoją na kaflu', () => {
    const state = aggregateState([makeSummary({
      id: 's', title: '', cwd: '/x/willow', state: 'running',
      backgroundTasks: [
        { id: 'c', kind: 'command', command: 'pnpm test' },
        { id: 'w', kind: 'workflow', description: 'bez-rozkladu', runId: 'wf_w' },
        workflowTask('ok', { ago: 1_000 }),
      ],
    })], NOW);
    expect(state.workflows?.map((w) => [w.project, w.name])).toEqual([['willow', 'audyt']]);
  });
});

describe('isBusy — co trzyma kafel przy życiu (zegar 30 min ciszy)', () => {
  const inputWith = (tasks: BackgroundTask[]): SessionSummary[] => [
    makeSummary({ id: 's', state: 'waiting-input', backgroundTasks: tasks }),
  ];

  it('decyzja i praca trzymają; sam wynik do odebrania nie', () => {
    expect(isBusy([makeSummary({ state: 'waiting-permission' })])).toBe(true);
    expect(isBusy([makeSummary({ state: 'starting' })])).toBe(true);
    expect(isBusy([makeSummary({ state: 'waiting-input' })])).toBe(false);
    expect(isBusy([])).toBe(false);
  });

  it('workflow w tle: bez rozkładu („nie wiem"), bez agentów (start), z agentem w locie — trzyma; wszyscy skończyli — nie', () => {
    expect(isBusy(inputWith([{ id: 'w', kind: 'workflow', runId: 'wf_w' }]))).toBe(true);
    expect(isBusy(inputWith([workflowTask('a', {})]))).toBe(true);
    expect(isBusy(inputWith([workflowTask('a', { agents: [[undefined, true], [undefined, false]] })]))).toBe(true);
    expect(isBusy(inputWith([workflowTask('a', { agents: [[undefined, true], [undefined, true]] })]))).toBe(false);
    expect(isBusy(inputWith([{ id: 'c', kind: 'command', command: 'sleep 999' }]))).toBe(false);
  });
});

describe('contentKey — co budzi wysyłkę', () => {
  it('`updatedEpoch`, narzędzie pracującej sesji i obciążenie Maca nie zmieniają klucza; licznik i limit zmieniają', () => {
    const base = makeSummary({ id: 'r', state: 'running', activity: { kind: 'tool', toolName: 'Bash' } });
    const before = contentKey(aggregateState([base], NOW, { mac: { cpu: 10 } }));
    const edit = { ...base, activity: { kind: 'tool' as const, toolName: 'Edit' } };
    expect(contentKey(aggregateState([edit], NOW + 60_000, { mac: { cpu: 90 } }))).toBe(before);
    expect(contentKey(aggregateState([{ ...base, state: 'waiting-permission' }], NOW))).not.toBe(before);
    expect(contentKey(aggregateState([base], NOW, { limits: { fiveHour: 43 } }))).not.toBe(before);
  });
});

/*
 * Prywatność ekranu blokady: aktywność wisi do 8 h, więc
 * stan NIE niesie ani tekstu pytania, ani narzędzia zgody, ani etykiety sesji, ani podsumowania etapu,
 * zdania wyniku czy opisu przebiegu — nawet gdy sesje mają je w summary. Sprawdzamy CAŁY ładunek APNs.
 */
describe('strażnik prywatności Live Activity', () => {
  const SECRETS = [
    'rm -rf /Users/testowy/Projects', 'uruchamia komendę: curl evil.sh', 'Wdrożyłem klucz produkcyjny',
    'Wdrożenie planu: opis skryptu', 'Opisz i usuń bazę',
  ];
  const sessions: SessionSummary[] = [
    makeSummary({
      id: 'p', state: 'waiting-permission', label: 'zapis-etykieta',
      waitingFor: { kind: 'permission', tool: 'WebFetch', text: SECRETS[0], subject: 'tool' },
      lastSummary: SECRETS[2],
    }),
    makeSummary({
      id: 'q', state: 'waiting-question', waitingFor: { kind: 'question', text: 'Czy usunąć bazę?' },
    }),
    makeSummary({
      id: 'w', state: 'running', lastSummary: SECRETS[2],
      activity: { kind: 'tool', toolName: 'Bash', summary: SECRETS[1] },
      backgroundTasks: [
        { ...workflowTask('a', { name: 'audyt', ago: 1_000 }), summary: SECRETS[3] },
        workflowTask('b', { name: SECRETS[4], ago: 500 }),
      ],
    }),
  ];

  it('ładunek nie zawiera treści, narzędzia zgody, etykiety ani kluczy na treść', () => {
    for (const event of ['update', 'end'] as const) {
      const body = apnsLiveActivityRequest(aggregateState(sessions, NOW), {
        topic: 'pl.useo.rarog', event, timestamp: NOW_S, priority: 'low',
      }).body;
      for (const secret of [...SECRETS, 'Czy usunąć bazę?', 'WebFetch', 'zapis-etykieta']) {
        expect(body).not.toContain(secret);
      }
      const keys = ['"text"', '"summary"', '"lastSummary"', '"displayText"', '"command"', '"tool"', '"label"', '"description"'];
      for (const key of keys) expect(body).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Ładunek APNs
// ---------------------------------------------------------------------------

describe('apnsLiveActivityRequest — ramka `liveactivity`', () => {
  const state: LiveActivityContentState = { waiting: 1, working: 0, finished: 0, updatedEpoch: NOW_S };

  it('update: topic z sufiksem, priorytet, `stale-date` = +15 min, czas wygaśnięcia = `stale-date`', () => {
    const request = apnsLiveActivityRequest(state, { topic: 'pl.useo.rarog', event: 'update', timestamp: NOW_S, priority: 'high' });
    expect(request.headers).toEqual({
      'apns-push-type': 'liveactivity',
      'apns-topic': 'pl.useo.rarog.push-type.liveactivity',
      'apns-priority': '10',
      'apns-expiration': String(NOW_S + 900),
    });
    expect(JSON.parse(request.body)).toEqual({
      aps: { timestamp: NOW_S, event: 'update', 'content-state': state, 'stale-date': NOW_S + 900 },
    });
  });

  it('end: `dismissal-date` = teraz (znika od razu), bez `stale-date`, bez `alert`', () => {
    const request = apnsLiveActivityRequest(state, { topic: 'pl.useo.rarog', event: 'end', timestamp: NOW_S, priority: 'low' });
    expect(request.headers['apns-priority']).toBe('5');
    const aps = (JSON.parse(request.body) as { aps: Record<string, unknown> }).aps;
    expect(aps).toEqual({ timestamp: NOW_S, event: 'end', 'content-state': state, 'dismissal-date': NOW_S });
  });

  it('ładunek ≤ 4 kB: przycinanie po skalarach (emoji całe) od drugiego przebiegu, projekt pierwszego ostatni', () => {
    // Producent ma sufit 60 znaków (kontrakt) — ten stan go łamie celowo: obrona na wypadek zmiany sufitu.
    const huge = '🧪'.repeat(500);
    const workflow = (sessionId: string): NonNullable<LiveActivityContentState['workflows']>[number] => ({
      sessionId, project: `projekt-${huge}`, name: huge, agents: 2, done: 1,
      phase: { index: 1, count: 1, title: huge }, segments: [50],
    });
    const long: LiveActivityContentState = {
      waiting: 1, working: 1, finished: 0, workflows: [workflow('a'), workflow('b')], updatedEpoch: NOW_S,
    };
    const body = apnsLiveActivityRequest(long, { topic: 'pl.useo.rarog', event: 'update', timestamp: NOW_S, priority: 'low' }).body;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(APNS_PAYLOAD_MAX_BYTES);
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const parsed = JSON.parse(body) as { aps: { 'content-state': LiveActivityContentState } };
    const [first, second] = parsed.aps['content-state'].workflows ?? [];
    // Kolejność ważności: drugi przebieg w całości (tytuł fazy, nazwa, projekt), dopiero potem pierwszy.
    expect(second).toMatchObject({ phase: { title: '' }, name: '…', project: '…' });
    expect(first?.project).toBe(`projekt-${huge}`);
  });
});

// ---------------------------------------------------------------------------
// Sterownik
// ---------------------------------------------------------------------------

useLiveActivityHarness();

describe('sterownik — rejestracja i pierwsza aktualizacja', () => {
  it('druga uprząż w tym samym teście ma własny rejestr: nie wczytuje kafla pierwszej po jej zapisie', async () => {
    const first = setup();
    await registered(first);
    await first.devices.flush();
    const second = setup();
    second.devices.upsert({ token: DEVICE, environment: 'development', label: 'iPhone·Rarog', alerts: false, ...owner(DEVICE) });
    expect(second.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('started');
  });

  it('nieznane urządzenie → `unknown-device`, nic nie wychodzi', async () => {
    const h = setup();
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('unknown-device');
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS);
    expect(h.sent).toEqual([]);
  });

  it('nowa aktywność dostaje stan serwera od razu: token aktywności, środowisko urządzenia, priorytet 5', async () => {
    const h = setup();
    await registered(h);
    expect(h.sent).toHaveLength(1);
    const first = h.sent[0] as Sent;
    expect(first.token).toBe(UPDATE_1);
    expect(first.environment).toBe('development');
    expect(first.request.headers['apns-priority']).toBe('5');
    expect(aps(first)).toMatchObject({ event: 'update', timestamp: NOW_S, 'stale-date': NOW_S + 900 });
    expect(stateOf(first)).toMatchObject({ waiting: 0, working: 1, finished: 0, top: { sessionId: 'w' } });
  });

  it('ta sama treść przy kolejnych eventach (inna chwila) → zero wysyłek (diff po treści)', async () => {
    const h = setup();
    await registered(h);
    // Eventy rzadziej niż okno throttle — gdyby `updatedEpoch` wchodził do porównania, każdy byłby wysyłką.
    for (let i = 0; i < 5; i += 1) {
      await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
      await h.set([...WORKING]);
    }
    expect(h.sent).toHaveLength(1);
  });
});

describe('sterownik — throttle i priorytety', () => {
  it('zmiana w oknie 15 s czeka do końca okna; kilka zmian = jedna wysyłka z NAJNOWSZĄ treścią', async () => {
    const h = setup();
    await registered(h);
    await h.set([...WORKING, makeSummary({ id: 'w2', state: 'running' })]);
    await h.set([...WORKING, makeSummary({ id: 'w2', state: 'running' }), makeSummary({ id: 'w3', state: 'starting' })]);
    expect(h.sent).toHaveLength(1);
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    expect(h.sent).toHaveLength(2);
    expect((h.sent[1] as Sent).at).toBe(NOW + LIVE_ACTIVITY_THROTTLE_MS);
    expect(stateOf(h.sent[1] as Sent).working).toBe(3);
    expect((h.sent[1] as Sent).request.headers['apns-priority']).toBe('5');
  });

  it('a CHANGE of `waiting` (rise or drop) goes out at once with priority 10, also inside the throttle window', async () => {
    const h = setup();
    await registered(h);
    await h.set(ONE_WAITING);
    expect(h.sent).toHaveLength(2);
    expect((h.sent[1] as Sent).request.headers['apns-priority']).toBe('10');
    await h.set(TWO_WAITING);
    expect(h.sent).toHaveLength(3);
    expect((h.sent[2] as Sent).request.headers['apns-priority']).toBe('10');
    // `aps.timestamp` rośnie ściśle, choć dwie wysyłki wypadły w tej samej sekundzie zegara.
    expect(aps(h.sent[2] as Sent)['timestamp']).toBeGreaterThan(aps(h.sent[1] as Sent)['timestamp'] as number);
    // A drop is urgent too: answered on another device, the phone tile must leave "waiting" at once.
    await h.set(ONE_WAITING);
    await h.set(WORKING);
    expect(h.sent.slice(3).map((s) => [s.request.headers['apns-priority'], stateOf(s).waiting])).toEqual([['10', 1], ['10', 0]]);
  });

  it('heartbeat: treść stoi → ta sama treść co ~10 min priorytetem 5, ze świeżym `stale-date`', async () => {
    const h = setup();
    await registered(h);
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS - 1);
    expect(h.sent).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.sent).toHaveLength(2);
    const beat = h.sent[1] as Sent;
    expect(beat.request.headers['apns-priority']).toBe('5');
    expect(aps(beat)['stale-date']).toBe(NOW_S + LIVE_ACTIVITY_HEARTBEAT_MS / 1000 + 900);
    expect(stateOf(beat).updatedEpoch).toBe(NOW_S + LIVE_ACTIVITY_HEARTBEAT_MS / 1000);
  });

  it('obciążenie Maca: sama zmiana nie wysyła NIC, a heartbeat i następna zmiana niosą ŚWIEŻĄ wartość', async () => {
    const h = setup();
    h.mac = { cpu: 10, ram: 40, disk: 60 };
    await registered(h);
    expect(stateOf(h.sent[0] as Sent).mac).toEqual({ cpu: 10, ram: 40, disk: 60 });
    h.mac = { cpu: 90, ram: 40, disk: 60 };
    await h.set(WORKING);
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS * 4);
    expect(h.sent).toHaveLength(1);
    h.mac = { cpu: 55, ram: 45, disk: 60 };
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS);
    expect(h.sent).toHaveLength(2);
    // Treść zamroziła się przy przeliczeniu z cpu 90 — heartbeat i tak bierze to, co jest teraz.
    expect(stateOf(h.sent[1] as Sent).mac).toEqual({ cpu: 55, ram: 45, disk: 60 });
    h.mac = undefined;
    await h.set(ONE_WAITING);
    expect(stateOf(h.sent.at(-1) as Sent).mac).toBeUndefined();
    // `end` (trasa apki) też bierze obciążenie z chwili wysyłki, nie z ostatniego przeliczenia.
    h.mac = { cpu: 20, ram: 50, disk: 60 };
    expect(h.controller.end(DEVICE, 'akt-1')).toBe(true);
    await h.clock.advance(0);
    const end = h.sent.at(-1) as Sent;
    expect(aps(end)['event']).toBe('end');
    expect(stateOf(end).mac).toEqual({ cpu: 20, ram: 50, disk: 60 });
  });

  it('zmiana limitów planu budzi zwykłą wysyłkę (priorytet 5, w throttlingu); ten sam procent — nic', async () => {
    const h = setup();
    h.limits = { fiveHour: 40, weekly: 80 };
    await registered(h);
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    expect(h.sent).toHaveLength(1);
    await h.set(WORKING);
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    expect(h.sent).toHaveLength(1);
    h.limits = { fiveHour: 41, weekly: 80 };
    await h.set(WORKING);
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    expect(h.sent).toHaveLength(2);
    expect((h.sent[1] as Sent).request.headers['apns-priority']).toBe('5');
    expect(stateOf(h.sent[1] as Sent).limits).toEqual({ fiveHour: 41, weekly: 80 });
  });
});

/*
 * Pomiar opóźnienia kafla (uwaga właściciela „liczniki aktualizują się wolno”): linia przy każdej
 * wysyłce z licznikami innymi niż doręczone — godzina, sekundy od zmiany liczników na serwerze, priorytet,
 * czas odpowiedzi drogi wysyłki. Heartbeat i zmiana samych limitów linii nie dają.
 */
describe('sterownik — linia pomiaru liczników', () => {
  const countLines = (h: Harness): string[] => h.logs.filter((l) => l.startsWith(`${LIVE_ACTIVITY_COUNTS_LOG} `));

  it('pierwsza wysyłka do aktywności, potem zmiana w oknie 15 s: sekundy od zmiany, priorytet 5, odpowiedź', async () => {
    const h = setup();
    h.respond = () => {
      h.clock.now += 400;
      return { kind: 'ok' };
    };
    await registered(h);
    expect(countLines(h)).toHaveLength(1);
    expect(countLines(h)[0]).toMatch(new RegExp(`^${LIVE_ACTIVITY_COUNTS_LOG} waiting 0 · working 1 · finished 0 — `
      + 'sent \\d{2}:\\d{2}:\\d{2}, first send to the activity, priority 5, answer after 0\\.4 s → delivered$'));
    // Zmiana liczników w oknie throttle: wychodzi na końcu okna, linia mówi, ile czekała po stronie serwera.
    await h.set([...WORKING, makeSummary({ id: 'w2', state: 'running' })]);
    const changedAt = h.clock.now;
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    expect(h.sent).toHaveLength(2);
    const waited = ((h.sent[1] as Sent).at - changedAt) / 1000;
    expect(countLines(h)[1]).toContain(`waiting 0 · working 2 · finished 0 — sent `);
    expect(countLines(h)[1]).toContain(`, ${waited.toFixed(1)} s after the change, priority 5, answer after 0.4 s → delivered`);
    expect(waited).toBeGreaterThan(14);
  });

  it('wzrost „czeka” → priorytet 10 bez czekania; heartbeat i same limity — bez linii', async () => {
    const h = setup();
    await registered(h);
    await h.set(ONE_WAITING);
    expect(countLines(h)[1]).toMatch(/waiting 1 · working 0 · finished 0 — sent .*, 0\.0 s after the change, priority 10,/);
    const lines = countLines(h).length;
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS);
    h.limits = { fiveHour: 41, weekly: 80 };
    await h.set(ONE_WAITING);
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    expect(h.sent.length).toBeGreaterThanOrEqual(4);
    expect(countLines(h)).toHaveLength(lines);
    // Bez tokenu urządzenia, tokenu aktywności, `activityId` i etykiety.
    for (const line of countLines(h)) {
      for (const secret of [DEVICE, UPDATE_1, 'akt-1', 'iPhone·Rarog']) expect(line).not.toContain(secret);
    }
  });

  it('porażka → linia „nieudane”, ponowienie z tymi samymi licznikami daje drugą linię', async () => {
    const h = setup();
    h.respond = () => ({ kind: 'failed', status: 500, reason: 'InternalServerError' });
    await registered(h);
    expect(countLines(h)).toHaveLength(1);
    expect(countLines(h)[0]).toMatch(/→ failed$/);
    h.respond = () => ({ kind: 'ok' });
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS);
    expect(countLines(h)).toHaveLength(2);
    expect(countLines(h)[1]).toMatch(/first send to the activity, priority 5, .*→ delivered$/);
  });
});

describe('sterownik — koniec po 30 min ciszy', () => {
  it('„nic nie czeka" to zwykły update; 29:59 nic, 30:00 `end`; blok aktywności skasowany', async () => {
    const h = setup();
    await registered(h);
    await h.set(IDLE);
    const quietFrom = h.clock.now;
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    const updates = h.sent.filter((s) => aps(s)['event'] === 'update');
    expect(stateOf(updates.at(-1) as Sent)).toEqual({
      waiting: 0, working: 0, finished: 1, updatedEpoch: expect.any(Number) as number,
    });
    await h.clock.advance(quietFrom + LIVE_ACTIVITY_QUIET_END_MS - 1 - h.clock.now);
    expect(h.sent.some((s) => aps(s)['event'] === 'end')).toBe(false);
    await h.clock.advance(1);
    const end = h.sent.at(-1) as Sent;
    expect(aps(end)).toMatchObject({ event: 'end', 'dismissal-date': Math.floor(h.clock.now / 1000) });
    expect(end.token).toBe(UPDATE_1);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeUndefined();
    const count = h.sent.length;
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS * 3);
    expect(h.sent).toHaveLength(count);
    expect(h.logs).toContain('live-activity: end (quiet 30 min) → delivered');
  });

  it('praca w 29. minucie zeruje zegar ciszy', async () => {
    const h = setup();
    await registered(h);
    await h.set(IDLE);
    await h.clock.advance(29 * 60_000);
    await h.set(WORKING);
    await h.set(IDLE);
    const quietFrom = h.clock.now;
    await h.clock.advance(LIVE_ACTIVITY_QUIET_END_MS - 2_000);
    expect(h.sent.some((s) => aps(s)['event'] === 'end')).toBe(false);
    await h.clock.advance(quietFrom + LIVE_ACTIVITY_QUIET_END_MS - h.clock.now);
    expect(aps(h.sent.at(-1) as Sent)['event']).toBe('end');
  });

  it('aktywność założona w środku długiej ciszy dostaje własne 30 min od rejestracji', async () => {
    const h = setup(IDLE);
    h.controller.poke();
    await h.clock.advance(2 * LIVE_ACTIVITY_QUIET_END_MS);
    const registeredAt = h.clock.now;
    await registered(h);
    expect(aps(h.sent[0] as Sent)['event']).toBe('update');
    await h.clock.advance(registeredAt + LIVE_ACTIVITY_QUIET_END_MS - 1 - h.clock.now);
    expect(h.sent.some((s) => aps(s)['event'] === 'end')).toBe(false);
    await h.clock.advance(1);
    expect(aps(h.sent.at(-1) as Sent)['event']).toBe('end');
  });
});

describe('sterownik — koniec z trasy i przy wyrejestrowaniu', () => {
  it('`end` z innym `activityId` nic nie robi; zgodny → `end` do aktywności i blok skasowany', async () => {
    const h = setup();
    await registered(h);
    expect(h.controller.end(DEVICE, 'akt-stara')).toBe(false);
    await h.clock.advance(0);
    expect(h.devices.get(DEVICE)?.liveActivity?.activityId).toBe('akt-1');
    expect(h.controller.end(DEVICE.toUpperCase(), 'akt-1')).toBe(true);
    await h.clock.advance(0);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeUndefined();
    const end = h.sent.at(-1) as Sent;
    expect(aps(end)['event']).toBe('end');
    expect(end.token).toBe(UPDATE_1);
    // Ta sama sekunda co pierwsza aktualizacja — `end` i tak ma ściśle nowszy znacznik.
    expect(aps(end)['timestamp']).toBe(NOW_S + 1);
    const count = h.sent.length;
    await h.set(ONE_WAITING);
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS);
    expect(h.sent).toHaveLength(count);
  });

  it('wyrejestrowanie urządzenia (wylogowanie) wysyła `end` do jego aktywności', async () => {
    const h = setup();
    await registered(h);
    h.controller.forgetDevice(DEVICE);
    h.devices.remove(DEVICE);
    await h.clock.advance(0);
    const end = h.sent.at(-1) as Sent;
    expect(aps(end)['event']).toBe('end');
    expect(end.token).toBe(UPDATE_1);
    expect(h.logs).toContain('live-activity: end (unregister) → delivered');
  });
});

describe('sterownik — rotacja tokenu i odpowiedzi APNs', () => {
  it('rotacja: kolejne wysyłki idą na NOWY token tej samej aktywności, bez dodatkowej wysyłki', async () => {
    const h = setup();
    await registered(h);
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_2 })).toBe('rotated');
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(1);
    await h.set(ONE_WAITING);
    expect((h.sent.at(-1) as Sent).token).toBe(UPDATE_2);
  });

  it('`410` na token, który w międzyczasie zrotował, NIE kasuje bloku (odwrócona kolejność)', async () => {
    const h = setup();
    await registered(h);
    let release: (r: ApnsResult) => void = () => {};
    h.respond = () => new Promise<ApnsResult>((resolve) => { release = resolve; });
    await h.set(ONE_WAITING);
    expect((h.sent.at(-1) as Sent).token).toBe(UPDATE_1);
    h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_2 });
    release({ kind: 'gone', status: 410, reason: 'Unregistered' });
    await h.clock.advance(0);
    expect(h.devices.get(DEVICE)?.liveActivity).toMatchObject({ activityId: 'akt-1', updateToken: UPDATE_2 });
  });

  it('`410` na aktualny token kasuje blok i zatrzymuje wysyłki', async () => {
    const h = setup();
    await registered(h);
    h.respond = () => ({ kind: 'gone', status: 410, reason: 'Unregistered' });
    await h.set(ONE_WAITING);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeUndefined();
    const count = h.sent.length;
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS);
    expect(h.sent).toHaveLength(count);
    expect(h.logs.join('\n')).toContain('live-activity: activity token dead (410 Unregistered) — block deleted');
  });

  it('porażka → ponowienie dopiero po minucie, z najnowszą treścią', async () => {
    const h = setup();
    await registered(h);
    h.respond = () => ({ kind: 'failed', status: 429, reason: 'TooManyRequests' });
    await h.set(ONE_WAITING);
    const failedAt = (h.sent.at(-1) as Sent).at;
    h.respond = () => ({ kind: 'ok' });
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS - 2_000);
    expect(h.sent.filter((s) => s.at > failedAt)).toEqual([]);
    await h.clock.advance(failedAt + LIVE_ACTIVITY_RETRY_MS - h.clock.now);
    expect(stateOf(h.sent.at(-1) as Sent).waiting).toBe(1);
  });

  it('log niesie liczby i powody — nigdy tokenu, `activityId` ani etykiety', async () => {
    const h = setup();
    await registered(h, 'akt-tajny-identyfikator');
    h.controller.register(DEVICE, { activityId: 'akt-tajny-identyfikator', updateToken: UPDATE_2 });
    await h.set(ONE_WAITING);
    h.controller.end(DEVICE, 'akt-tajny-identyfikator');
    await h.clock.advance(0);
    const text = h.logs.join('\n');
    expect(text).toContain('live-activity: activity saved (new)');
    for (const secret of [DEVICE, UPDATE_1, UPDATE_2, 'akt-tajny', 'iPhone·Rarog']) {
      expect(text).not.toContain(secret.slice(0, 12));
    }
  });

  it('licznik wysyłek per godzina ląduje w logu', async () => {
    const h = setup();
    await registered(h);
    await h.set(ONE_WAITING);
    await h.clock.advance(60 * 60_000);
    // Jedno urządzenie z jedną pilną: dopisek „pilne na urządzenie” z jedną liczbą.
    expect(h.logs.some((l) => /^live-activity: last hour — sends: \d+ \(urgent: 1, heartbeat: \d+, chimes: 0\), ends: 0, unsuccessful: 0, urgent per device: 1$/.test(l)))
      .toBe(true);
  });
});

/*
 * Trzy wyścigi sterownika, każdy odtworzony tu z zegarem testowym.
 */
describe('sterownik — trzy wyścigi', () => {
  it('nieudany `end` po ciszy NIE kasuje bloku: ponowienie po minucie, blok znika dopiero po dostawie', async () => {
    const h = setup();
    await registered(h);
    await h.set(IDLE);
    const quietFrom = h.clock.now;
    h.respond = (s) => (aps(s)['event'] === 'end'
      ? { kind: 'failed', status: 503, reason: 'ServiceUnavailable' }
      : { kind: 'ok' });
    await h.clock.advance(quietFrom + LIVE_ACTIVITY_QUIET_END_MS - h.clock.now);
    const ends = (): Sent[] => h.sent.filter((s) => aps(s)['event'] === 'end');
    expect(ends()).toHaveLength(1);
    expect(h.devices.get(DEVICE)?.liveActivity?.activityId).toBe('akt-1');
    expect(h.logs).toContain('live-activity: end (quiet 30 min) → failed — retry in 60 s');
    h.respond = () => ({ kind: 'ok' });
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS - 1);
    expect(ends()).toHaveLength(1);
    await h.clock.advance(1);
    expect(ends()).toHaveLength(2);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeUndefined();
  });

  it('nowa praca w ostatnich 250 ms przed końcem (przeliczenie jeszcze czeka) → bez `end`, aktualizacja', async () => {
    const h = setup();
    await registered(h);
    await h.set(IDLE);
    const quietEnd = h.clock.now + LIVE_ACTIVITY_QUIET_END_MS;
    await h.clock.advance(quietEnd - 100 - h.clock.now);
    h.sessions = ONE_WAITING;
    h.controller.poke();
    await h.clock.advance(100);
    expect(h.sent.some((s) => aps(s)['event'] === 'end')).toBe(false);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeDefined();
    await h.clock.advance(LIVE_ACTIVITY_COALESCE_MS);
    expect(stateOf(h.sent.at(-1) as Sent).waiting).toBe(1);
  });

  it('restart po serii pilnych wysyłek w jednej sekundzie: pierwszy znacznik po restarcie jest NOWSZY', async () => {
    const h = setup();
    await registered(h);
    await h.set(ONE_WAITING);
    await h.set(TWO_WAITING);
    const before = Math.max(...h.sent.map((s) => aps(s)['timestamp'] as number));
    expect(before).toBeGreaterThan(Math.floor(h.clock.now / 1000));
    h.controller.close();
    await h.devices.flush();
    // „Restart": nowy rejestr z pliku i nowy sterownik, 750 ms później.
    const clock = h.clock;
    clock.now += 750;
    const devices = createApnsDeviceStore({ dataDir: h.dataDir, now: () => clock.now });
    const sent: Sent[] = [];
    const controller = createLiveActivity({
      devices,
      sender: { send: (environment, token, request) => { sent.push({ environment, token, request, at: clock.now }); return Promise.resolve({ kind: 'ok' }); } },
      sessions: () => TWO_WAITING, now: () => clock.now,
      setTimeout: clock.set, clearTimeout: clock.clear,
    });
    try {
      controller.poke();
      await clock.advance(LIVE_ACTIVITY_COALESCE_MS);
      expect(sent).toHaveLength(1);
      expect(aps(sent[0] as Sent)['timestamp']).toBeGreaterThan(before);
    } finally {
      controller.close();
      await devices.flush();
    }
  });

});

/*
 * Po 8 h system kończy aktywność sam, ale kafel wisi na ekranie blokady do 4 h dłużej z ostatnią treścią
 * (Apple, ActivityKit). Wybór użytkownika: „wolałbym brak niż stary” — serwer zdejmuje kafel tuż przed limitem.
 */
describe('sterownik — koniec przed limitem 8 h', () => {
  const ends = (h: Harness): Sent[] => h.sent.filter((s) => aps(s)['event'] === 'end');

  it('praca trwa: 8 h − 10 min − 1 s nic, równo 8 h − 10 min `end` z `dismissal-date` = teraz, priorytet 10', async () => {
    const h = setup();
    await registered(h);
    const startedAt = h.clock.now;
    await h.clock.advance(startedAt + LIVE_ACTIVITY_AGE_END_MS - 1_000 - h.clock.now);
    expect(ends(h)).toEqual([]);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeDefined();
    // Do tej chwili tor żył jak zwykle: pierwsza aktualizacja i heartbeat co 10 min.
    expect(h.sent.length).toBeGreaterThan(40);
    await h.clock.advance(1_000);
    expect(ends(h)).toHaveLength(1);
    const end = ends(h)[0] as Sent;
    expect(end.at).toBe(startedAt + LIVE_ACTIVITY_AGE_END_MS);
    expect(end.token).toBe(UPDATE_1);
    expect(end.request.headers['apns-priority']).toBe('10');
    expect(aps(end)['dismissal-date']).toBe(aps(end)['timestamp']);
    expect(aps(end)['timestamp']).toBeGreaterThan(aps(h.sent.at(-2) as Sent)['timestamp'] as number);
    expect(stateOf(end)).toMatchObject({ waiting: 0, working: 1 });
    expect(h.devices.get(DEVICE)?.liveActivity).toBeUndefined();
    expect(h.logs).toContain('live-activity: end (8 h limit) → delivered');
    const count = h.sent.length;
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS * 3);
    expect(h.sent).toHaveLength(count);
  });

  it('koniec przed limitem liczy się do `ends` w linii godzinowej', async () => {
    const h = setup();
    await registered(h);
    await h.clock.advance(LIVE_ACTIVITY_AGE_END_MS);
    expect(ends(h)).toHaveLength(1);
    // Linię godzinową pisze dopiero następna wysyłka po upływie okna — tu do nowej aktywności.
    await registered(h, 'akt-2', UPDATE_2);
    await h.clock.advance(60 * 60_000);
    expect(h.logs.some((l) => /^live-activity: last hour — .*, ends: 1, /.test(l))).toBe(true);
  });

  it('nieudany `end` (8 h) ponawia się po minucie; porażka do 8 h → blok wypada bez wysyłki, jak dotąd', async () => {
    const h = setup();
    await registered(h);
    const startedAt = h.clock.now;
    h.respond = (s) => (aps(s)['event'] === 'end'
      ? { kind: 'failed', status: 503, reason: 'ServiceUnavailable' }
      : { kind: 'ok' });
    await h.clock.advance(startedAt + LIVE_ACTIVITY_AGE_END_MS - h.clock.now);
    expect(ends(h)).toHaveLength(1);
    expect(h.devices.get(DEVICE)?.liveActivity?.activityId).toBe('akt-1');
    expect(h.logs).toContain('live-activity: end (8 h limit) → failed — retry in 60 s');
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS - 1);
    expect(ends(h)).toHaveLength(1);
    await h.clock.advance(1);
    expect(ends(h)).toHaveLength(2);
    expect((ends(h)[1] as Sent).request.headers['apns-priority']).toBe('10');
    // Między ponowieniami żadnych zwykłych aktualizacji: po progu tor zna już tylko `end`.
    const sentBefore = h.sent.length;
    await h.clock.advance(startedAt + LIVE_ACTIVITY_MAX_AGE_MS - 1 - h.clock.now);
    expect(h.sent.slice(sentBefore).every((s) => aps(s)['event'] === 'end')).toBe(true);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeDefined();
    const count = h.sent.length;
    await h.clock.advance(1);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeUndefined();
    expect(h.logs).toContain('live-activity: activity older than 8 h — the system ended it, block deleted');
    expect(h.sent).toHaveLength(count);
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS * 2);
    expect(h.sent).toHaveLength(count);
  });

  it('koniec po 30 min ciszy zostaje na priorytecie 5', async () => {
    const h = setup();
    await registered(h);
    await h.set(IDLE);
    await h.clock.advance(LIVE_ACTIVITY_QUIET_END_MS);
    expect(ends(h)).toHaveLength(1);
    expect((ends(h)[0] as Sent).request.headers['apns-priority']).toBe('5');
    expect(h.logs).toContain('live-activity: end (quiet 30 min) → delivered');
  });
});

describe('sterownik — workflow w tle a zegar ciszy (kafel v2)', () => {
  const background = (agents: [string | undefined, boolean][]): SessionSummary[] => [makeSummary({
    id: 's', state: 'waiting-input', seen: true,
    backgroundTasks: [workflowTask('a', { name: 'audyt', ago: 60_000, agents })],
  })];

  it('przebieg z agentem w locie trzyma kafel po zakończeniu tury; gdy wszyscy skończą — 30 min i `end`', async () => {
    const h = setup();
    await registered(h);
    await h.set(background([[undefined, true], [undefined, false]]));
    await h.clock.advance(LIVE_ACTIVITY_QUIET_END_MS + LIVE_ACTIVITY_HEARTBEAT_MS);
    expect(h.sent.some((s) => aps(s)['event'] === 'end')).toBe(false);
    expect(stateOf(h.sent.at(-1) as Sent).workflows?.[0]).toMatchObject({ name: 'audyt', agents: 2, done: 1 });
    await h.set(background([[undefined, true], [undefined, true]]));
    const quietFrom = h.clock.now;
    await h.clock.advance(quietFrom + LIVE_ACTIVITY_QUIET_END_MS - 1 - h.clock.now);
    expect(h.sent.some((s) => aps(s)['event'] === 'end')).toBe(false);
    await h.clock.advance(1);
    expect(aps(h.sent.at(-1) as Sent)['event']).toBe('end');
  });
});

// ---------------------------------------------------------------------------
// Dźwięk „skończył”
// ---------------------------------------------------------------------------

const DEVICE_2 = 'e5f6a7b8'.repeat(8);
const UPDATE_3 = '1a2b3c4d'.repeat(10);
const CHIME_ALERT = { title: 'Agent skończył', body: 'Wynik czeka w Rarogu', sound: 'skonczyl.caf' };

/** Urządzenie ZE zgodą na powiadomienia (`alerts: true`) i żywym kaflem — tylko takie dostaje dźwięk. */
async function registeredWithAlerts(
  h: Harness, token = DEVICE, activityId = 'akt-1', updateToken = UPDATE_1,
): Promise<void> {
  h.devices.upsert({ token, environment: 'development', label: 'iPhone·Rarog', alerts: true, ...owner(token) });
  expect(h.controller.register(token, { activityId, updateToken })).toBe('started');
  await h.clock.advance(0);
}

const hasAlert = (s: Sent): boolean => 'alert' in aps(s);
const chimesOf = (h: Harness): Sent[] => h.sent.filter(hasAlert);

/** Odpowiedź atrapy, którą test zwalnia ręcznie (wysyłka „w locie”). */
function holdNext(h: Harness): (result: ApnsResult) => void {
  let release: (result: ApnsResult) => void = () => {};
  h.respond = () => new Promise<ApnsResult>((resolve) => { release = resolve; });
  return (result) => {
    h.respond = () => ({ kind: 'ok' });
    release(result);
  };
}

describe('sterownik — dźwięk „skończył”', () => {
  it('od razu: alert ze stałą, priorytet 10, wygaśnięcie = teraz + 30 s — także przy tej samej treści i w oknie throttle', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    await h.clock.advance(1_000);
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);

    expect(h.sent).toHaveLength(2);
    const chime = h.sent[1] as Sent;
    expect(chime.at).toBe(NOW + 1_000);
    expect(chime.token).toBe(UPDATE_1);
    expect(chime.request.headers['apns-priority']).toBe('10');
    expect(chime.request.headers['apns-expiration']).toBe(String(NOW_S + 1 + LIVE_ACTIVITY_CHIME_TTL_MS / 1000));
    expect(aps(chime)).toMatchObject({ event: 'update', alert: CHIME_ALERT });
    expect(stateOf(chime)).toEqual({ ...stateOf(h.sent[0] as Sent), updatedEpoch: NOW_S + 1 });
    expect(h.logs).toContain('live-activity: done chime → delivered');
    // Dźwięk doręczył też treść: ta sama treść nie wychodzi drugi raz.
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS * 2);
    expect(h.sent).toHaveLength(2);
  });

  it('jedzie ze ŚWIEŻĄ treścią: koniec tury, którego event czeka jeszcze w oknie składania, jest już na kaflu', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    h.sessions = IDLE;
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    expect(stateOf(chimesOf(h)[0] as Sent)).toMatchObject({ waiting: 0, working: 0, finished: 1 });
  });

  it('najwyżej jeden dźwięk na 20 s: 19,999 s po doręczonym — zero zleceń; równo 20 s — dźwięk', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    const firstAt = (chimesOf(h)[0] as Sent).at;
    await h.clock.advance(LIVE_ACTIVITY_CHIME_MIN_GAP_MS - 1);
    expect(h.controller.chime()).toBe(0);
    await h.clock.advance(0);
    expect(chimesOf(h)).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    expect(chimesOf(h).map((s) => s.at)).toEqual([firstAt, firstAt + LIVE_ACTIVITY_CHIME_MIN_GAP_MS]);
  });

  it('urządzenie bez zgody na powiadomienia (`alerts: false`) zlecenia nie dostaje', async () => {
    const h = setup();
    await registered(h);
    expect(h.controller.chime()).toBe(0);
    await h.clock.advance(LIVE_ACTIVITY_CHIME_TTL_MS);
    expect(chimesOf(h)).toEqual([]);
  });

  it('bez kafla i po `close()` — zero zleceń, nic nie wychodzi', async () => {
    const h = setup();
    expect(h.controller.chime()).toBe(0);
    // Urządzenie ze zgodą, ale bez aktywności: kafla nie ma, więc dźwięku też nie.
    h.devices.upsert({ token: DEVICE, environment: 'development', label: 'iPhone·Rarog', alerts: true, ...owner(DEVICE) });
    expect(h.controller.chime()).toBe(0);
    expect(h.sent).toEqual([]);
    await registeredWithAlerts(h);
    h.controller.close();
    expect(h.controller.chime()).toBe(0);
    await h.clock.advance(LIVE_ACTIVITY_CHIME_TTL_MS);
    expect(chimesOf(h)).toEqual([]);
  });

  it('tor w ponowieniu: zlecenie przepada równo po 30 s (log na czas), następna aktualizacja bez alertu', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    h.respond = () => ({ kind: 'failed', status: 429, reason: 'TooManyRequests' });
    await h.set(ONE_WAITING);
    const failedAt = (h.sent.at(-1) as Sent).at;
    h.respond = () => ({ kind: 'ok' });
    const orderedAt = h.clock.now;
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    expect(chimesOf(h)).toEqual([]);
    const EXPIRED = 'live-activity: done chime timed out — not sent within 30 s';
    await h.clock.advance(orderedAt + LIVE_ACTIVITY_CHIME_TTL_MS - 1 - h.clock.now);
    expect(h.logs).not.toContain(EXPIRED);
    // Jedyny powód pobudki w tej chwili to termin zlecenia — ponowienie jest dopiero po minucie.
    await h.clock.advance(1);
    expect(h.logs).toContain(EXPIRED);
    await h.clock.advance(failedAt + LIVE_ACTIVITY_RETRY_MS - h.clock.now);
    const retry = h.sent.at(-1) as Sent;
    expect(retry.at).toBe(failedAt + LIVE_ACTIVITY_RETRY_MS);
    expect(stateOf(retry).waiting).toBe(1);
    expect(chimesOf(h)).toEqual([]);
  });

  it('porażka dźwięku: przepada bez ponowienia z alertem, a treść ponawia się po minucie jak zwykle', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    h.respond = (s) => (hasAlert(s) ? { kind: 'failed', status: 503, reason: 'ServiceUnavailable' } : { kind: 'ok' });
    h.sessions = IDLE;
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    const failedAt = (chimesOf(h)[0] as Sent).at;
    expect(h.logs).toContain('live-activity: done chime → failed');
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS);
    const retry = h.sent.at(-1) as Sent;
    expect(retry.at).toBe(failedAt + LIVE_ACTIVITY_RETRY_MS);
    expect(hasAlert(retry)).toBe(false);
    expect(stateOf(retry).finished).toBe(1);
    expect(chimesOf(h)).toHaveLength(1);
  });

  it('tor z wysyłką w locie: dźwięk czeka i wychodzi zaraz po odpowiedzi', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    const release = holdNext(h);
    await h.set(ONE_WAITING);
    expect(h.sent).toHaveLength(2);
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(1_000);
    expect(h.sent).toHaveLength(2);
    release({ kind: 'ok' });
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(3);
    expect(hasAlert(h.sent[2] as Sent)).toBe(true);
    expect((h.sent[2] as Sent).request.headers['apns-expiration'])
      .toBe(String(Math.floor((NOW + LIVE_ACTIVITY_COALESCE_MS + LIVE_ACTIVITY_CHIME_TTL_MS) / 1000)));
  });

  it('zgoda cofnięta, gdy zlecenie czekało na wysyłkę w locie: dźwięk nie wychodzi', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    const release = holdNext(h);
    await h.set(ONE_WAITING);
    expect(h.controller.chime()).toBe(1);
    // Apka zgłasza brak zgody; `upsert` zostawia blok aktywności, więc tor i zlecenie żyją dalej.
    h.devices.upsert({ token: DEVICE, environment: 'development', label: 'iPhone·Rarog', alerts: false, ...owner(DEVICE) });
    release({ kind: 'ok' });
    await h.clock.advance(0);
    expect(h.logs).toContain('live-activity: done chime cancelled — the device has no notification permission');
    await h.clock.advance(LIVE_ACTIVITY_CHIME_TTL_MS);
    expect(chimesOf(h)).toEqual([]);
  });

  it('odpowiedź starszej wysyłki z dźwiękiem nie kasuje nowszego zlecenia — a przerwa i tak daje jeden dźwięk', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    const release = holdNext(h);
    expect(h.controller.chime()).toBe(1);
    // Drugie „skończył” w trakcie wysyłki pierwszego: przerwa liczy się od DORĘCZONEGO, więc zlecenie powstaje.
    expect(h.controller.chime()).toBe(1);
    release({ kind: 'ok' });
    await h.clock.advance(0);
    expect(chimesOf(h)).toHaveLength(1);
    // Nowsze zlecenie przeżyło odpowiedź i dopiero przerwa je zdjęła (gdyby zginęło, tej linii by nie było).
    expect(h.logs).toContain('live-activity: done chime skipped — the previous one played a moment ago');
    await h.clock.advance(LIVE_ACTIVITY_CHIME_TTL_MS);
    expect(chimesOf(h)).toHaveLength(1);
  });

  it('odpowiedź starszej wysyłki z dźwiękiem (nieudana) nie kasuje nowszego zlecenia — przepada ono w ponowieniu', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    const release = holdNext(h);
    expect(h.controller.chime()).toBe(1);
    expect(h.controller.chime()).toBe(1);
    release({ kind: 'failed', status: 503, reason: 'ServiceUnavailable' });
    await h.clock.advance(0);
    await h.clock.advance(LIVE_ACTIVITY_CHIME_TTL_MS);
    expect(h.logs).toContain('live-activity: done chime timed out — not sent within 30 s');
    expect(chimesOf(h)).toHaveLength(1);
  });

  it('powrót do Raroga przed odpowiedzią wysyłki w locie: zlecenie nie odżywa; ramki już wysłanej nie liczy', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    const release = holdNext(h);
    await h.set(ONE_WAITING);
    expect(h.controller.chime()).toBe(1);
    expect(h.controller.cancelChimes()).toBe(1);
    expect(h.logs).toContain('live-activity: back in Rarog — cancelled chimes: 1');
    release({ kind: 'ok' });
    await h.clock.advance(LIVE_ACTIVITY_CHIME_TTL_MS);
    expect(chimesOf(h)).toEqual([]);

    // Dźwięk już w drodze do APNs: powrót go nie cofnie i nie udaje, że cofnął.
    const releaseChime = holdNext(h);
    expect(h.controller.chime()).toBe(1);
    expect(chimesOf(h)).toHaveLength(1);
    expect(h.controller.cancelChimes()).toBe(0);
    releaseChime({ kind: 'ok' });
    await h.clock.advance(0);
    expect(h.logs).toContain('live-activity: done chime → delivered');
  });

  it('dwa urządzenia niezależnie: każde własne zlecenie, własna przerwa i własny wynik', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(5_000);
    await registeredWithAlerts(h, DEVICE_2, 'akt-2', UPDATE_3);
    h.respond = (s) => (s.token === UPDATE_3 && hasAlert(s)
      ? { kind: 'failed', status: 503, reason: 'ServiceUnavailable' } : { kind: 'ok' });
    // Pierwsze w przerwie, drugie nie.
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    expect(chimesOf(h).map((s) => s.token)).toEqual([UPDATE_1, UPDATE_3]);
    expect(h.logs).toContain('live-activity: done chime → failed');
    // Porażka drugiego nie rusza pierwszego; po minucie (ponowienie drugiego) oba grają znowu.
    h.respond = () => ({ kind: 'ok' });
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS);
    expect(h.controller.chime()).toBe(2);
    await h.clock.advance(0);
    expect(chimesOf(h).map((s) => s.token)).toEqual([UPDATE_1, UPDATE_3, UPDATE_1, UPDATE_3]);
  });

  it('`locKeys`: dzwonek kluczami dla wpisu z deklaracją, literałem dla reszty; rejestracja bez pola wraca do literału', async () => {
    const CHIME_KEYS = {
      title: { 'loc-key': 'push.chime.title' }, body: { 'loc-key': 'push.chime.body' }, sound: 'skonczyl.caf',
    };
    const h = setup();
    const declare = (token: string, locKeys?: boolean): void => {
      h.devices.upsert({
        token, environment: 'development', label: 'iPhone·Rarog', alerts: true, ...owner(token),
        ...(locKeys === undefined ? {} : { locKeys }),
      });
    };
    declare(DEVICE, true);
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('started');
    declare(DEVICE_2);
    expect(h.controller.register(DEVICE_2, { activityId: 'akt-2', updateToken: UPDATE_3 })).toBe('started');
    await h.clock.advance(0);
    expect(h.sent.some(hasAlert)).toBe(false);
    expect(h.controller.chime()).toBe(2);
    await h.clock.advance(0);
    const byToken = (token: string): Sent[] => chimesOf(h).filter((s) => s.token === token);
    expect(aps(byToken(UPDATE_1)[0] as Sent)['alert']).toEqual(CHIME_KEYS);
    expect(aps(byToken(UPDATE_3)[0] as Sent)['alert']).toEqual(CHIME_ALERT);
    // Kontekst `locKeys` czytany z wpisu w chwili wysyłki: ponowna rejestracja bez pola zdejmuje klucze.
    declare(DEVICE);
    await h.clock.advance(LIVE_ACTIVITY_CHIME_MIN_GAP_MS);
    expect(h.controller.chime()).toBe(2);
    await h.clock.advance(0);
    expect(aps(byToken(UPDATE_1)[1] as Sent)['alert']).toEqual(CHIME_ALERT);
    expect(aps(byToken(UPDATE_3)[1] as Sent)['alert']).toEqual(CHIME_ALERT);
  });

  it('nowa aktywność (inne `activityId`) gubi zlecenie starej', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    const release = holdNext(h);
    await h.set(ONE_WAITING);
    expect(h.controller.chime()).toBe(1);
    expect(h.controller.register(DEVICE, { activityId: 'akt-2', updateToken: UPDATE_2 })).toBe('started');
    release({ kind: 'ok' });
    await h.clock.advance(LIVE_ACTIVITY_CHIME_TTL_MS);
    expect((h.sent.at(-1) as Sent).token).toBe(UPDATE_2);
    expect(chimesOf(h)).toEqual([]);
  });

  it('tylko zlecenie niesie alert: zwykła zmiana, heartbeat, koniec po ciszy i koniec z trasy — nigdy', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    await h.set(ONE_WAITING);
    await h.set(WORKING); // then IDLE: same `waiting` (0), other counters — the ordinary priority-5 change
    await h.set(IDLE);
    await h.clock.advance(LIVE_ACTIVITY_QUIET_END_MS + LIVE_ACTIVITY_THROTTLE_MS);
    expect(aps(h.sent.at(-1) as Sent)['event']).toBe('end');
    // Przebieg miał każdy rodzaj wysyłki: pilne zmiany (rise and drop of `waiting`) i heartbeaty (priorytet 5).
    const updates = h.sent.filter((s) => aps(s)['event'] === 'update' && !hasAlert(s));
    expect(updates.filter((s) => s.request.headers['apns-priority'] === '10')).toHaveLength(2);
    expect(updates.filter((s) => s.request.headers['apns-priority'] === '5').length).toBeGreaterThanOrEqual(4);
    expect(chimesOf(h)).toHaveLength(1);

    const route = setup();
    await registeredWithAlerts(route);
    expect(route.controller.chime()).toBe(1);
    await route.clock.advance(0);
    expect(route.controller.end(DEVICE, 'akt-1')).toBe(true);
    await route.clock.advance(0);
    const end = route.sent.at(-1) as Sent;
    expect(aps(end)['event']).toBe('end');
    expect(hasAlert(end)).toBe(false);
  });

  it('`aps.timestamp` ściśle rośnie także przez dźwięk w tej samej sekundzie', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    await h.set(ONE_WAITING);
    const stamps = h.sent.map((s) => aps(s)['timestamp'] as number);
    expect(stamps).toHaveLength(3);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('licznik godzinowy liczy dźwięki (część wysyłek, jak pilne i heartbeat)', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    await h.clock.advance(60 * 60_000);
    // Dźwięk to pilna wysyłka (priorytet 10), więc liczy się też w dopisku na urządzenie.
    expect(h.logs.some((l) => /^live-activity: last hour — sends: \d+ \(urgent: 1, heartbeat: \d+, chimes: 1\), ends: 0, unsuccessful: 0, urgent per device: 1$/.test(l)))
      .toBe(true);
  });
});

/*
 * Pilne na urządzenie w linii godzinowej: budżet priorytetu 10 pilnuje system każdego
 * urządzenia osobno, więc suma urządzeń nie wystarcza. Liczą się tylko DORĘCZONE pilne, malejąco, bez tokenów.
 */
describe('sterownik — pilne na urządzenie w linii godzinowej', () => {
  const hourLines = (h: Harness): string[] => h.logs.filter((l) => l.startsWith('live-activity: last hour — '));

  it('dwa urządzenia: liczby malejąco (nie w kolejności pierwszej pilnej), nieudane pilne się nie liczą', async () => {
    const h = setup();
    await registered(h);
    // DEVICE: pierwsza pilna — trafia do licznika jako pierwsze urządzenie.
    await h.set(ONE_WAITING);
    await registeredWithAlerts(h, DEVICE_2, 'akt-2', UPDATE_3);
    // Od teraz każda wysyłka do DEVICE pada (także pilne ponowienia), DEVICE_2 dostaje trzy pilne (2 → 1 is urgent too).
    h.respond = (s) => (s.token === UPDATE_1
      ? { kind: 'failed', status: 503, reason: 'ServiceUnavailable' } : { kind: 'ok' });
    await h.set(TWO_WAITING);
    await h.set(ONE_WAITING);
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    await h.set(TWO_WAITING);
    const urgentTo = (token: string): Sent[] =>
      h.sent.filter((s) => s.token === token && s.request.headers['apns-priority'] === '10');
    expect(urgentTo(UPDATE_3)).toHaveLength(3);
    await h.clock.advance(60 * 60_000);
    // DEVICE próbował pilnie co minutę (ponowienie wzrostu „czeka”), ale doręczona była tylko pierwsza.
    expect(urgentTo(UPDATE_1).length).toBeGreaterThan(2);
    const [line] = hourLines(h);
    expect(line).toMatch(/^live-activity: last hour — sends: \d+ \(urgent: 4, heartbeat: \d+, chimes: 0\), ends: 0, unsuccessful: [1-9]\d*, urgent per device: 3 \/ 1$/);
    for (const secret of [DEVICE, DEVICE_2, UPDATE_1, UPDATE_3, 'akt-1', 'akt-2', 'iPhone·Rarog']) {
      expect(line).not.toContain(secret);
    }
    // Następna godzina bez doręczonej pilnej: licznik wyzerowany razem z resztą, linia bez dopisku.
    await h.clock.advance(60 * 60_000);
    expect(hourLines(h)).toHaveLength(2);
    expect(hourLines(h)[1]).toMatch(/\(urgent: 0, .*, unsuccessful: [1-9]\d*$/);
  });

  it('same nieudane pilne i zwykłe wysyłki: `pilne: 0` i linia bez dopisku', async () => {
    const h = setup();
    await registered(h);
    h.respond = (s) => (s.request.headers['apns-priority'] === '10'
      ? { kind: 'failed', status: 429, reason: 'TooManyRequests' } : { kind: 'ok' });
    await h.set(ONE_WAITING);
    await h.clock.advance(60 * 60_000);
    expect(h.sent.some((s) => s.request.headers['apns-priority'] === '10')).toBe(true);
    const [line] = hourLines(h);
    expect(line).toMatch(/^live-activity: last hour — sends: \d+ \(urgent: 0, heartbeat: \d+, chimes: 0\), ends: 0, unsuccessful: [1-9]\d*$/);
  });
});

describe('sterownik — temat APNs z wpisu urządzenia', () => {
  const NEW_DEVICE = 'b2c3d4e5'.repeat(8);
  const NEW_TOPIC = 'ai.example.app';
  const SUFFIX = '.push-type.liveactivity';
  const topicOf = (sent: Sent): string | undefined => sent.request.headers['apns-topic'];

  /** Dwie apki z różnymi tematami (Rarog i inny bundle id), każda ze swoją aktywnością. */
  async function twoApps(h: Harness): Promise<void> {
    await registered(h);
    h.devices.upsert({
      token: NEW_DEVICE, environment: 'development', label: 'iPhone·Rarog', alerts: false, deviceId: NEW_DEVICE.slice(0, 32),
      topic: NEW_TOPIC,
    });
    expect(h.controller.register(NEW_DEVICE, { activityId: 'akt-2', updateToken: UPDATE_2 })).toBe('started');
    await h.clock.advance(0);
  }

  it('aktualizacja: każdy wpis pod swoim tematem; ten sam przebieg, różne tematy', async () => {
    const h = setup();
    await twoApps(h);
    const byToken = new Map(h.sent.map((s) => [s.token, topicOf(s)]));
    expect(byToken.get(UPDATE_1)).toBe(`${RAROG_TOPIC}${SUFFIX}`);
    expect(byToken.get(UPDATE_2)).toBe(`${NEW_TOPIC}${SUFFIX}`);
    // Zmiana treści idzie do obu aktywności w jednym przebiegu — każda pod swoim tematem.
    const before = h.sent.length;
    await h.set(ONE_WAITING);
    const round = h.sent.slice(before);
    expect(round.map((s) => [s.token, topicOf(s)]).sort()).toEqual([
      [UPDATE_1, `${RAROG_TOPIC}${SUFFIX}`], [UPDATE_2, `${NEW_TOPIC}${SUFFIX}`],
    ]);
  });

  it('koniec z trasy i przy wyrejestrowaniu: `end` pod tematem wpisu', async () => {
    const h = setup();
    await twoApps(h);
    const endOf = (token: string): Sent | undefined =>
      h.sent.find((s) => s.token === token && aps(s)['event'] === 'end');
    expect(h.controller.end(NEW_DEVICE, 'akt-2')).toBe(true);
    await h.clock.advance(0);
    expect(topicOf(endOf(UPDATE_2) as Sent)).toBe(`${NEW_TOPIC}${SUFFIX}`);
    h.controller.forgetDevice(DEVICE);
    await h.clock.advance(0);
    expect(topicOf(endOf(UPDATE_1) as Sent)).toBe(`${RAROG_TOPIC}${SUFFIX}`);
  });

  it('dźwięk „skończył” do dwóch aktywności w jednym wywołaniu: każda ramka pod tematem swojego wpisu', async () => {
    const h = setup();
    await registeredWithAlerts(h);
    h.devices.upsert({
      token: NEW_DEVICE, environment: 'development', label: 'iPhone·Rarog', alerts: true, deviceId: NEW_DEVICE.slice(0, 32),
      topic: NEW_TOPIC,
    });
    expect(h.controller.register(NEW_DEVICE, { activityId: 'akt-2', updateToken: UPDATE_2 })).toBe('started');
    await h.clock.advance(0);
    expect(h.controller.chime()).toBe(2);
    await h.clock.advance(0);
    expect(chimesOf(h).map((s) => [s.token, topicOf(s)]).sort()).toEqual([
      [UPDATE_1, `${RAROG_TOPIC}${SUFFIX}`], [UPDATE_2, `${NEW_TOPIC}${SUFFIX}`],
    ]);
  });

  it('koniec po 30 min ciszy: każda aktywność pod tematem swojego wpisu', async () => {
    const h = setup(IDLE);
    await twoApps(h);
    const before = h.sent.length;
    await h.clock.advance(LIVE_ACTIVITY_QUIET_END_MS);
    const ends = h.sent.slice(before).filter((s) => aps(s)['event'] === 'end');
    expect(ends.map((s) => [s.token, topicOf(s)]).sort()).toEqual([
      [UPDATE_1, `${RAROG_TOPIC}${SUFFIX}`], [UPDATE_2, `${NEW_TOPIC}${SUFFIX}`],
    ]);
  });
});

describe('sterownik — droga wysyłki przez przekaźnik', () => {
  const RAROG = 'ai.rarog.app';
  const laPass = {
    pass: 'v1.k1.development.liveactivity.x.1.sig', expiresAt: '2027-01-31T10:00:00.000Z',
    origin: 'https://push.rarog.ai', environment: 'development' as const, topic: RAROG, token: UPDATE_1,
  };

  /** Wpis apki Rarog z aktywnością i przepustką aktywności w bloku. */
  async function rarog(h: Harness): Promise<void> {
    h.devices.upsert({ token: DEVICE, environment: 'development', label: 'iPhone·Rarog', alerts: true, ...owner(DEVICE) });
    h.devices.setLiveActivity(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 });
    expect(h.devices.setActivityRelayPass(DEVICE, 'akt-1', laPass)).toBe(true);
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('unchanged');
    h.controller.poke();
    await h.clock.advance(LIVE_ACTIVITY_COALESCE_MS);
  }

  const context = { topic: RAROG, pass: laPass, activity: { deviceToken: DEVICE, activityId: 'akt-1' } };

  it('aktualizacja niesie temat wpisu, przepustkę bloku i adres aktywności', async () => {
    const h = setup();
    await rarog(h);
    expect(h.sent.at(-1)?.context).toEqual(context);
  });

  it('aktywność bez przepustki w bloku: kontekst z tematem wpisu, bez przepustki', async () => {
    const h = setup();
    await registered(h);
    expect(h.sent.at(-1)?.context).toEqual({ topic: RAROG, activity: { deviceToken: DEVICE, activityId: 'akt-1' } });
  });

  it('koniec z trasy i przy wyrejestrowaniu: blok skasowany PRZED wysyłką, a `end` i tak niesie przepustkę', async () => {
    const h = setup();
    await rarog(h);
    expect(h.controller.end(DEVICE, 'akt-1')).toBe(true);
    expect(h.devices.get(DEVICE)?.liveActivity).toBeUndefined();
    await h.clock.advance(0);
    const end = h.sent.at(-1) as Sent;
    expect(aps(end)['event']).toBe('end');
    expect(end.context).toEqual(context);

    const g = setup();
    await rarog(g);
    g.controller.forgetDevice(DEVICE);
    g.devices.remove(DEVICE);
    await g.clock.advance(0);
    expect(aps(g.sent.at(-1) as Sent)['event']).toBe('end');
    expect(g.sent.at(-1)?.context).toEqual(context);
  });

  it('`pass-missing`: tor czeka jak po porażce, zapisana przepustka budzi go od razu; bez czekania — nic', async () => {
    const h = setup();
    h.respond = () => ({ kind: 'failed', status: null, reason: 'pass-missing' });
    await registered(h);
    expect(h.sent).toHaveLength(1);
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS - 1);
    expect(h.sent).toHaveLength(1);
    h.respond = () => ({ kind: 'ok' });
    h.controller.passReady(DEVICE.toUpperCase());
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(2);
    // Tor nie czeka na przepustkę — sygnał nic nie zmienia (throttle i heartbeat bez zmian).
    h.controller.passReady(DEVICE);
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(2);
  });

  it('zwykła porażka (429) nie jest czekaniem na przepustkę: sygnał nie skraca ponowienia', async () => {
    const h = setup();
    h.respond = () => ({ kind: 'failed', status: 429, reason: 'TooManyRequests' });
    await registered(h);
    h.controller.passReady(DEVICE);
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(1);
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS);
    expect(h.sent).toHaveLength(2);
  });
});

describe('sterownik — rotacja tokenu urządzenia przy żywym kaflu', () => {
  const RAROG = 'ai.rarog.app';
  const OWNER = 'a'.repeat(32);
  const laPass = {
    pass: 'v1.k1.development.liveactivity.x.1.sig', expiresAt: '2027-01-31T10:00:00.000Z',
    origin: 'https://push.rarog.ai', environment: 'development' as const, topic: RAROG, token: UPDATE_1,
  };
  const entry = (token: string, environment: ApnsEnvironment = 'development') => ({
    token, environment, label: 'iPhone·Rarog', alerts: true, topic: RAROG, deviceId: OWNER,
  });

  it('nowy token tego samego urządzenia i tematu: kafel dalej dostaje aktualizacje z przepustką bloku', async () => {
    const h = setup();
    h.devices.upsert(entry(DEVICE));
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('started');
    expect(h.devices.setActivityRelayPass(DEVICE, 'akt-1', laPass)).toBe(true);
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(1);
    // Rotacja: apka rejestruje NOWY token urządzenia; aktywności poprzedniego procesu od nowa nie zgłasza.
    h.devices.upsert(entry(DEVICE_2));
    expect(h.devices.get(DEVICE)).toBeUndefined();
    await h.set(ONE_WAITING);
    const update = h.sent.at(-1) as Sent;
    expect(h.sent).toHaveLength(2);
    expect(update.token).toBe(UPDATE_1);
    expect(stateOf(update)).toMatchObject({ waiting: 1 });
    expect(update.context).toEqual({ topic: RAROG, pass: laPass, activity: { deviceToken: DEVICE_2, activityId: 'akt-1' } });
    // Koniec z trasy przychodzi już z nowym tokenem urządzenia.
    expect(h.controller.end(DEVICE_2, 'akt-1')).toBe(true);
    await h.clock.advance(0);
    expect(aps(h.sent.at(-1) as Sent)['event']).toBe('end');
  });

  it('zmiana środowiska (instalacja z TestFlight): kafel starej instalacji znika, nic do niego nie wychodzi', async () => {
    const h = setup();
    h.devices.upsert(entry(DEVICE));
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('started');
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(1);
    h.devices.upsert(entry(DEVICE_2, 'production'));
    await h.set(ONE_WAITING);
    await h.clock.advance(LIVE_ACTIVITY_HEARTBEAT_MS);
    expect(h.sent).toHaveLength(1);
  });

  // `aps.timestamp` ściśle rośnie per aktywność, także gdy tor zmienia token urządzenia: znacznik równy ostatniemu
  // ActivityKit może odrzucić jako nieświeży. Blok w rejestrze go nie niesie (zegar nie został wyprzedzony).
  it('rotacja w tej samej sekundzie: aktualizacja pod nowym tokenem ma znacznik ściśle większy', async () => {
    const h = setup();
    h.devices.upsert(entry(DEVICE));
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('started');
    await h.clock.advance(0);
    expect(aps(h.sent[0] as Sent)['timestamp']).toBe(NOW_S);
    expect(h.devices.get(DEVICE)?.liveActivity?.lastTimestamp).toBeUndefined();
    h.devices.upsert(entry(DEVICE_2));
    await h.set(ONE_WAITING);
    expect(Math.floor(h.clock.now / 1000), 'ta sama sekunda zegara').toBe(NOW_S);
    const update = h.sent.at(-1) as Sent;
    expect(h.sent).toHaveLength(2);
    expect(update.context?.activity).toEqual({ deviceToken: DEVICE_2, activityId: 'akt-1' });
    expect(aps(update)['timestamp']).toBe(NOW_S + 1);
  });

  it('rotacja przy wysyłce w locie: aktualizacja pod nowym tokenem ma znacznik ściśle większy niż ta w locie', async () => {
    const h = setup();
    let release: (() => void) | undefined;
    h.respond = () => (release === undefined
      ? new Promise<ApnsResult>((resolve) => { release = () => { resolve({ kind: 'ok' }); }; })
      : { kind: 'ok' });
    h.devices.upsert(entry(DEVICE));
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('started');
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(1);
    expect(release, 'pierwsza wysyłka czeka na odpowiedź').toBeDefined();
    h.devices.upsert(entry(DEVICE_2));
    await h.set(ONE_WAITING);
    expect(h.sent).toHaveLength(2);
    const [inFlight, update] = h.sent as [Sent, Sent];
    expect(update.context?.activity).toEqual({ deviceToken: DEVICE_2, activityId: 'akt-1' });
    expect(aps(update)['timestamp']).toBeGreaterThan(aps(inFlight)['timestamp'] as number);
    // Spóźniona odpowiedź starego toru nie rusza nowego: następna aktualizacja idzie dalej pod nowym tokenem.
    release?.();
    await h.clock.advance(0);
    await h.clock.advance(LIVE_ACTIVITY_THROTTLE_MS);
    await h.set(WORKING);
    const next = h.sent.at(-1) as Sent;
    expect(h.sent).toHaveLength(3);
    expect(next.context?.activity).toEqual({ deviceToken: DEVICE_2, activityId: 'akt-1' });
    expect(aps(next)['timestamp']).toBeGreaterThan(aps(update)['timestamp'] as number);
  });
});
