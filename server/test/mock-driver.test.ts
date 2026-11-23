/**
 * Mock-driver w izolacji: wstrzykiwany zegar, determinizm, sprzątanie timerów.
 *
 * Tu zegar jest RĘCZNY (nie fake timery vitest) — to dowód, że driver nie sięga po globalny
 * `setTimeout` na skróty i da się go przewijać z dowolnego harnessa.
 */
import { EXIT_PLAN_MODE_TOOL } from '@rarog/shared';
import { describe, expect, it } from 'vitest';
import { APPLIED, STALE } from '../src/drivers/types.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import {
  DEFAULT_MOCK_MODEL, DEMO_CONTEXT_LIMIT, DEMO_CONTEXT_STEP, MockDriver, REPLY_DELAY_MS,
  DEMO_DIFF_FILES, chunkText, createMockDriverFactory, demoAheadBehind, demoFileDetails, demoFileKinds,
  demoGitStatus,
} from '../src/drivers/mock-driver.ts';
import type { MockSceneEvent } from '../src/drivers/mock-driver.ts';
import { demoContentEn } from '../src/demo/content/en.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

/** 1×1 px png — treść nieistotna, liczy się poprawny data URL. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

/** Zegar sterowany z testu: `tick(ms)` odpala wszystko, co miało wystrzelić do tego czasu. */
class ManualScheduler implements Scheduler {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  now(): number {
    return this.#now;
  }

  get pending(): number {
    return this.#timers.size;
  }

  tick(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (due.length === 0) break;
      for (const [id, timer] of due) {
        this.#timers.delete(id);
        this.#now = timer.at;
        timer.fn();
      }
    }
    this.#now = target;
  }
}

/** Zbiera eventy z drivera bez blokowania testu. */
function collect(driver: { events: AsyncIterable<DriverEvent> }): DriverEvent[] {
  const out: DriverEvent[] = [];
  void (async () => {
    for await (const event of driver.events) out.push(event);
  })();
  return out;
}

/**
 * Oddaje sterowanie pętli zdarzeń, żeby konsument `for await` zdążył odebrać WSZYSTKO,
 * co driver wrzucił do kolejki (jeden `queueMicrotask` by nie wystarczył — konsument
 * potrzebuje kilku tur mikrozadań na event).
 */
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

describe('chunkText', () => {
  it('dzieli tekst na fragmenty i zachowuje treść', () => {
    const text = 'jeden dwa trzy cztery pięć sześć siedem';
    expect(chunkText(text, 3).join('')).toBe(text);
    expect(chunkText(text, 3)).toHaveLength(3);
  });

  it('pusty tekst daje jeden pusty fragment', () => {
    expect(chunkText('')).toEqual(['']);
  });
});

describe('MockDriver — wstrzykiwany zegar', () => {
  it('nic nie emituje bez tyknięcia zegara', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl, cwd: '/x', scenario: { kind: 'idle' }, scheduler });
    const events = collect(driver);

    await flush();
    expect(events).toHaveLength(0);

    scheduler.tick(0);
    await flush();
    expect(events[0])
      .toEqual({ type: 'init', engineSessionId: 'mock-engine-session', model: DEFAULT_MOCK_MODEL });
    driver.dispose();
  });

  it('tura interaktywna: delty → wiadomość → tool-call → git-status → result', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl,
      cwd: '/x', scenario: { kind: 'interactive', prompt: 'zrób coś' }, scheduler,
    });
    const events = collect(driver);

    scheduler.tick(REPLY_DELAY_MS - 1);
    await flush();
    expect(events.some((e) => e.type === 'delta')).toBe(false);

    scheduler.tick(10_000);
    await flush();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('init');
    expect(types).toContain('delta');
    expect(types).toContain('message');
    expect(types).toContain('git-status');
    // Tura kończy się parą `result` → `usage` (tak samo jak w realnym silniku).
    expect(types.slice(-2)).toEqual(['result', 'usage']);

    const git = events.find((e) => e.type === 'git-status');
    expect(git).toMatchObject({
      branch: 'main', dirtyCount: 1, fileKinds: demoFileKinds(1), fileDetails: demoFileDetails(1),
    });
    driver.dispose();
  });

  /*
   * Demo ma ĆWICZYĆ kanał aktywności — inaczej ścieżka driver → manager →
   * SSE → wiersz nie ma jak się zepsuć głośno. Kolejność jest ta sama co w realnym silniku:
   * myślenie PRZED pierwszym tekstem, nazwa narzędzia PRZED domkniętą wiadomością z tool-callem,
   * `idle` PRZED `result`.
   */
  it('demo emituje aktywność: myślenie przed tekstem, narzędzie przed tool-callem', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl,
      cwd: '/x', scenario: { kind: 'interactive', prompt: 'zrób coś' }, scheduler,
    });
    const events = collect(driver);

    scheduler.tick(10_000);
    await flush();

    const types = events.map((e) => e.type);
    const thinking = events.findIndex((e) => e.type === 'activity' && e.kind === 'thinking');
    const tool = events.findIndex((e) => e.type === 'activity' && e.kind === 'tool');
    expect(thinking).toBeGreaterThanOrEqual(0);
    expect(thinking).toBeLessThan(types.indexOf('delta'));
    expect(tool).toBeGreaterThan(thinking);
    // Wskaźnik gaśnie ZANIM tura zostanie domknięta.
    const idle = events.findIndex((e) => e.type === 'activity' && e.kind === 'idle');
    expect(idle).toBeGreaterThan(tool);
    expect(idle).toBeLessThan(types.indexOf('result'));
    driver.dispose();
  });

  it('usage rośnie po każdej turze i nie przekracza limitu demo', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl,
      cwd: '/x', scenario: { kind: 'interactive', prompt: 'start' }, scheduler,
    });
    const events = collect(driver);

    for (let turn = 0; turn < 3; turn += 1) {
      scheduler.tick(10_000);
      await flush();
      driver.send('dalej');
    }
    scheduler.tick(10_000);
    await flush();

    const usage = events.filter((e) => e.type === 'usage');
    expect(usage.length).toBeGreaterThanOrEqual(3);
    // Demo jest jedynym miejscem, w którym limit okna jest ZNANY: mock sam go wymyślił.
    for (const event of usage) {
      expect(event.context.kind).toBe('known');
      expect(event.context.kind === 'known' && event.context.limit).toBe(DEMO_CONTEXT_LIMIT);
    }

    const tokens = usage.map((e) => e.context.tokens);
    expect(tokens[0]).toBe(DEMO_CONTEXT_STEP);
    for (let i = 1; i < tokens.length; i += 1) {
      expect(tokens[i]!).toBeGreaterThan(tokens[i - 1]!);
      expect(tokens[i]!).toBeLessThanOrEqual(DEMO_CONTEXT_LIMIT);
    }
    driver.dispose();
  });

  it('pusta sesja (start bez promptu): tylko init, żadnej tury', async () => {
    const scheduler = new ManualScheduler();
    const factory = createMockDriverFactory({ content: demoContentPl, scheduler });
    const driver = factory.startScenario({ kind: 'idle' }, { cwd: '/x' });
    const events = collect(driver);

    scheduler.tick(10_000);
    await flush();
    expect(events.map((e) => e.type)).toEqual(['init']);

    // Dopiero pierwsza wiadomość użytkownika uruchamia turę.
    driver.send('teraz zaczynamy');
    scheduler.tick(10_000);
    await flush();
    expect(events.some((e) => e.type === 'result')).toBe(true);
    driver.dispose();
  });

  it('dirtyCount rośnie 1 → 3 i nie idzie wyżej', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl,
      cwd: '/x', scenario: { kind: 'interactive', prompt: 'start' }, scheduler,
    });
    const events = collect(driver);

    for (let turn = 0; turn < 5; turn += 1) {
      scheduler.tick(10_000);
      await flush();
      driver.send('dalej');
    }
    scheduler.tick(10_000);
    await flush();

    const counts = events.filter((e) => e.type === 'git-status').map((e) => e.dirtyCount);
    expect(counts.slice(0, 3)).toEqual([1, 2, 3]);
    expect(Math.max(...counts)).toBe(3);
  });

  it('scenariusz streaming domyka wiadomość co ~15 s', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl, cwd: '/x', scenario: { kind: 'streaming' }, scheduler });
    const events = collect(driver);

    scheduler.tick(16_000);
    await flush();

    expect(events.filter((e) => e.type === 'delta').length).toBeGreaterThan(10);
    expect(events.filter((e) => e.type === 'message')).toHaveLength(1);
    driver.dispose();
  });

  it('jest deterministyczny: dwa drivery z tym samym ziarnem dają ten sam ciąg', async () => {
    const run = async (): Promise<DriverEvent[]> => {
      const scheduler = new ManualScheduler();
      const driver = new MockDriver({ content: demoContentPl,
        cwd: '/x', scenario: { kind: 'streaming' }, scheduler, seed: 42,
      });
      const events = collect(driver);
      scheduler.tick(20_000);
      await flush();
      driver.dispose();
      return events;
    };

    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()));
  });

  it('interrupt kasuje zaplanowane kroki, dispose domyka strumień', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl,
      cwd: '/x', scenario: { kind: 'interactive', prompt: 'zrób coś' }, scheduler,
    });
    const events = collect(driver);

    scheduler.tick(0);
    await flush();
    driver.interrupt();
    expect(scheduler.pending).toBe(0);

    scheduler.tick(10_000);
    await flush();
    expect(events).toHaveLength(1);

    driver.dispose();
    driver.dispose(); // idempotentne
  });

  it('obrazki z send() wracają jako bloki image w wiadomości asystenta', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl, cwd: '/x', scenario: { kind: 'idle' }, scheduler });
    const events = collect(driver);

    scheduler.tick(0);
    await flush();
    driver.send('co tu jest nie tak?', [PNG, PNG]);
    scheduler.tick(10_000);
    await flush();

    const echo = events.find((e) => e.type === 'message'
      && e.blocks.some((b) => b.type === 'image'));
    expect(echo).toBeDefined();
    if (echo?.type !== 'message') throw new Error('brak echa obrazków');
    expect(echo.blocks[0]).toMatchObject({ type: 'text' });
    expect(echo.blocks.slice(1)).toEqual([
      { type: 'image', dataUrl: PNG, alt: 'Załącznik 1' },
      { type: 'image', dataUrl: PNG, alt: 'Załącznik 2' },
    ]);

    // Echo idzie PRZED odpowiedzią — inaczej miniatury wpadałyby w środek strumienia delt.
    const indexEcho = events.indexOf(echo);
    const indexDelta = events.findIndex((e) => e.type === 'delta');
    expect(indexDelta).toBeGreaterThan(indexEcho);
  });

  it('send() bez obrazków nie emituje żadnego bloku image', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl, cwd: '/x', scenario: { kind: 'idle' }, scheduler });
    const events = collect(driver);

    scheduler.tick(0);
    await flush();
    driver.send('bez załączników', []);
    scheduler.tick(10_000);
    await flush();

    expect(events.some((e) => e.type === 'message'
      && e.blocks.some((b) => b.type === 'image'))).toBe(false);
  });

  it('git-status niesie ahead/behind wg tabeli demo (willow 2/0, rarog 0/1)', async () => {
    const gitFor = async (cwd: string): Promise<DriverEvent | undefined> => {
      const scheduler = new ManualScheduler();
      const driver = new MockDriver({ content: demoContentPl,
        cwd, scenario: { kind: 'interactive', prompt: 'zrób coś' }, scheduler,
      });
      const events = collect(driver);
      scheduler.tick(10_000);
      await flush();
      driver.dispose();
      return events.find((e) => e.type === 'git-status');
    };

    expect(await gitFor('/Users/demo/Projects/willow'))
      .toMatchObject({ branch: 'main', ahead: 2, behind: 0 });
    expect(await gitFor('/Users/demo/Projects/rarog'))
      .toMatchObject({ branch: 'main', ahead: 0, behind: 1 });

    // Projekt spoza tabeli = gałąź bez upstreamu: żadnych ahead/behind w evencie.
    const inny = await gitFor('/Users/demo/Projects/pipe-link');
    expect(inny).toBeDefined();
    expect(inny && 'ahead' in inny).toBe(false);
  });

  it('demoAheadBehind ignoruje końcowy ukośnik i nieznane projekty', () => {
    expect(demoAheadBehind('/Users/demo/Projects/willow/', demoContentPl)).toEqual({ ahead: 2, behind: 0 });
    expect(demoAheadBehind('/Users/demo/Projects/nieznany', demoContentPl)).toBeUndefined();
  });

  /*
   * Demo musi trzymać ten sam niezmiennik co parser (suma trójki = dirtyCount), inaczej
   * ekran demo pokazywałby układ segmentów, który w produkcji nie ma prawa powstać.
   */
  it('demoFileKinds sumuje się do liczby brudnych plików i rośnie po segmencie', () => {
    for (const dirty of [0, 1, 2, 3]) {
      const kinds = demoFileKinds(dirty);
      expect(kinds.added + kinds.modified + kinds.deleted).toBe(dirty);
    }
    expect(demoFileKinds(1)).toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(demoFileKinds(3)).toEqual({ added: 1, modified: 1, deleted: 1 });
  });

  /*
   * Panel „zmiany w katalogu" rysuje `fileDetails`, a „Pokaż diff" — `demoDiff`. W demo oba
   * biorą się z JEDNEJ tabeli, więc rodzaj, liczniki i kolejność muszą się zgadzać co do pliku.
   */
  it('git-status demo: pliki, trójka i szczegóły z tej samej tabeli co `demoDiff`', () => {
    const event = demoGitStatus('/Users/demo/Projects/willow', 3);
    expect(event.files).toEqual(DEMO_DIFF_FILES.map((file) => file.path));
    expect(event.fileDetails).toEqual([
      { path: 'src/notes.ts', kind: 'modified', linesAdded: 2, linesDeleted: 2 },
      { path: 'src/notes.test.ts', kind: 'added', linesAdded: 9, linesDeleted: 0 },
      { path: 'src/notes-legacy.ts', kind: 'deleted', linesAdded: 0, linesDeleted: 4 },
    ]);
    expect(event.fileKinds).toEqual(demoFileKinds(3));
    expect(event).toMatchObject({ dirtyCount: 3, ahead: 2, behind: 0 });
    expect(demoGitStatus('/Users/demo/Projects/inny', 1)).not.toHaveProperty('ahead');
    expect(demoFileDetails(2).map((d) => d.path)).toEqual(['src/notes.ts', 'src/notes.test.ts']);
  });

  it('decyzja o nieznanym reqId jest bezpiecznym no-opem', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl, cwd: '/x', scenario: { kind: 'idle' }, scheduler });
    const events = collect(driver);

    driver.respondPermission('nie-ma-takiego', 'allow');
    driver.answerQuestion('nie-ma-takiego', [['A']]);
    scheduler.tick(1_000);
    await flush();

    expect(events).toHaveLength(1); // tylko init
    driver.dispose();
  });
});

describe('createMockDriverFactory', () => {
  it('każdy driver dostaje własny engineSessionId', async () => {
    const scheduler = new ManualScheduler();
    const factory = createMockDriverFactory({ content: demoContentPl, scheduler });
    const first = factory.startScenario({ kind: 'interactive', prompt: 'a' }, { cwd: '/x' });
    const second = factory.startScenario({ kind: 'interactive', prompt: 'b' }, { cwd: '/y' });
    const events = [collect(first), collect(second)];

    scheduler.tick(0);
    await flush();

    expect(events[0]?.[0])
      .toEqual({ type: 'init', engineSessionId: 'mock-engine-1', model: DEFAULT_MOCK_MODEL });
    expect(events[1]?.[0])
      .toEqual({ type: 'init', engineSessionId: 'mock-engine-2', model: DEFAULT_MOCK_MODEL });
    first.dispose();
    second.dispose();
  });

  it('startScenario buduje driver seeda z gotową kartą zgody', async () => {
    const scheduler = new ManualScheduler();
    const factory = createMockDriverFactory({ content: demoContentPl, scheduler });
    const driver = factory.startScenario({ kind: 'awaiting-permission', reqId: 'p1' }, { cwd: '/x' });
    const events = collect(driver);

    // Decyzja jeszcze przed pierwszym tyknięciem zegara — driver musi ją przyjąć.
    driver.respondPermission('p1', 'allow');
    scheduler.tick(10_000);
    await flush();

    expect(events.some((e) => e.type === 'message')).toBe(true);
    expect(events.map((e) => e.type).slice(-2)).toEqual(['result', 'usage']);
    driver.dispose();
  });
});

describe('mock driver: scene events of a scenario', () => {
  it('right after `init`, in order, as copies', async () => {
    const scene: MockSceneEvent[] = [
      { type: 'agent-state', state: 'blocked', mode: 'plan' },
      { type: 'artifacts', artifacts: [{ url: 'https://claude.ai/artifact/Abc1', title: 'A', publishedAt: 'x' }] },
    ];
    const driver = new MockDriver({
      cwd: '/Users/demo/Projects/journal', scenario: { kind: 'idle', scene }, content: demoContentEn,
    });
    const events: DriverEvent[] = [];
    for await (const event of driver.events) {
      events.push(event);
      if (events.length === 3) break;
    }
    driver.dispose();
    expect(events.map((event) => event.type)).toEqual(['init', 'agent-state', 'artifacts']);
    expect(events.slice(1)).toEqual(scene);
    expect(events[2]).not.toBe(scene[1]);
  });

  it('a `permission-request` of the scene is a pending approval of the driver: answered once, then stale', async () => {
    const request: MockSceneEvent = {
      type: 'permission-request', reqId: 'scene-plan', toolName: EXIT_PLAN_MODE_TOOL, input: { plan: 'P' },
      displayText: 'P', alwaysLabel: 'Yes, and use auto mode',
    };
    const driver = new MockDriver({
      cwd: '/Users/demo/Projects/journal', scenario: { kind: 'idle', scene: [request] }, content: demoContentEn,
    });
    const events: DriverEvent[] = [];
    for await (const event of driver.events) {
      events.push(event);
      if (events.length === 2) break;
    }
    expect(events[1]).toEqual(request);
    expect(await driver.respondPermission('scene-plan', 'allow-always')).toEqual(APPLIED);
    expect(await driver.respondPermission('scene-plan', 'allow-always')).toEqual(STALE);
    driver.dispose();
  });
});
