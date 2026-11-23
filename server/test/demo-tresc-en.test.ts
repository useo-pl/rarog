/**
 * Zestaw treści demo EN: ten sam kształt co zestaw polski, sama angielszczyzna i fikcyjne
 * projekty, a wyzwalacze atrapy dają te same zdarzenia co ich pary polskie.
 *
 * - Kształt: te same identyfikatory sesji, stany, scenariusze, liczba wiadomości i bloków (z typami), role projektów,
 *   liczba wpisów „Wznów”, odpowiedzi i pytań atrapy; patch diffu zgadza się z `DEMO_DIFF_FILES` w obu językach.
 * - Sprawdzarka EN (`helpers/demo-en.ts`): żaden napis widoczny zestawu nie ma polskiej litery ani słowa `rarog`;
 *   mutacje kopii zestawu pokazują, że sprawdzarka to łapie.
 * - Nazwy klientów i projektów właściciela: skan prywatnych literałów (`describePrivate`); bez pliku literałów
 *   pominięty, z `RAROG_REQUIRE_PRIVATE_LITERALS=1` czerwony.
 * - Wyzwalacze: atrapa silnika na ręcznym zegarze (jak `mock-driver.test.ts`), te same typy zdarzeń dla pary PL i EN.
 */
import { EFFORT_LEVELS } from '@rarog/shared';
import { describe, expect, it } from 'vitest';
import { findPrivateHits } from '../../scripts/lib/private-literals.mjs';
import { demoContent } from '../src/demo/content/index.ts';
import { demoContentEn } from '../src/demo/content/en.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';
import type { DemoContent, DemoProjectKey, DemoSeedKit, DemoTriggers } from '../src/demo/content/types.ts';
import {
  DEMO_PROJECT_KEYS, DEMO_PROJECTS_ROOT, demoDiffFile, demoProjectCwd, demoProjects, demoResumable, demoSeeds,
} from '../src/demo/seeds.ts';
import type { DemoSeed } from '../src/demo/seeds.ts';
import { DEMO_AHEAD_BEHIND, DEMO_DIFF_FILES, MockDriver, RED_COMMAND } from '../src/drivers/mock-driver.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { demoContentTexts, nonEnglishTexts, textLeaves } from './helpers/demo-en.ts';
import { describePrivate, privateContext } from './private-guard.ts';

const NOW = Date.parse('2026-11-07T09:00:00.000Z');

/** Rola projektu seeda (z katalogu), żeby porównać kształt bez nazw. */
function roleOf(content: DemoContent, cwd: string): DemoProjectKey | undefined {
  return DEMO_PROJECT_KEYS.find((key) => demoProjectCwd(content, key) === cwd);
}

/** Kształt seeda bez tekstu: wszystko, co musi być takie samo w każdym języku. */
function shape(content: DemoContent, seed: DemoSeed): unknown {
  return {
    id: seed.id, role: roleOf(content, seed.cwd), titleIsProject: seed.title === content.projects[roleOf(content, seed.cwd) ?? 'main'],
    state: seed.state, stateDetail: typeof seed.stateDetail, label: typeof seed.label,
    stateSinceAgoMs: seed.stateSinceAgoMs, createdAtAgoMs: seed.createdAtAgoMs, lastActivityAgoMs: seed.lastActivityAgoMs,
    dirtyCount: seed.dirtyCount, ahead: seed.ahead, behind: seed.behind, lastSummary: typeof seed.lastSummary,
    model: seed.model, effort: seed.effort, ultracode: seed.ultracode, engineSessionId: seed.engineSessionId !== undefined,
    live: seed.live, permission: seed.permission === undefined ? null : {
      permId: seed.permission.permId, toolName: seed.permission.toolName, agoMs: seed.permission.agoMs,
    },
    messages: seed.messages.map((message) => ({
      role: message.role, agoMs: message.agoMs, notice: message.notice?.kind ?? null,
      blocks: message.blocks.map((block) => block.type === 'tool-call' ? `tool-call:${block.toolName}` : block.type),
      attachments: message.attachments?.map((attachment) => `${attachment.kind}:${attachment.mime}`) ?? null,
    })),
  };
}

describe('zestaw EN: kształt jak zestaw PL', () => {
  const pl = demoSeeds(demoContentPl, NOW);
  const en = demoSeeds(demoContentEn, NOW);

  it('`demoContent` wybiera zestaw po języku', async () => {
    expect(await demoContent('en')).toBe(demoContentEn);
    expect(await demoContent('pl')).toBe(demoContentPl);
  });

  it('te same identyfikatory sesji, stany, scenariusze, role projektów i liczba wiadomości i bloków', () => {
    expect(en.map((seed) => seed.id)).toEqual([
      'demo-willow', 'demo-willow-parser', 'demo-rarog', 'demo-fleet-ops', 'demo-data-loader', 'demo-pipe-link',
      'demo-map-view', 'demo-rarog-stop',
    ]);
    expect(en.map((seed) => shape(demoContentEn, seed))).toEqual(pl.map((seed) => shape(demoContentPl, seed)));
    for (const seed of en) expect(roleOf(demoContentEn, seed.cwd), seed.id).toBeTypeOf('string');
  });

  it('projekty: sześć różnych nazw w tej samej kolejności ról, katalogi pod korzeniem demo, ahead/behind po roli', () => {
    for (const content of [demoContentPl, demoContentEn]) {
      const projects = demoProjects(content);
      expect(projects.map((project) => project.name)).toEqual(DEMO_PROJECT_KEYS.map((key) => content.projects[key]));
      expect(new Set(projects.map((project) => project.name)).size).toBe(6);
      for (const project of projects) {
        expect(project.name).toMatch(/^[a-z][a-z-]*$/);
        expect(project.path).toBe(`${DEMO_PROJECTS_ROOT}/${project.name}`);
      }
      const willow = demoSeeds(content, NOW).find((seed) => seed.id === 'demo-willow');
      expect({ ahead: willow?.ahead, behind: willow?.behind }).toEqual(DEMO_AHEAD_BEHIND.main);
    }
    expect(Object.values(demoContentEn.projects).filter((name) => Object.values(demoContentPl.projects).includes(name)))
      .toEqual([]);
  });

  it('żywa karta `demo-willow` to wpis `-0` listy „Wznów” jej projektu w obu językach', () => {
    for (const content of [demoContentPl, demoContentEn]) {
      const willow = demoSeeds(content, NOW).find((seed) => seed.id === 'demo-willow');
      const [first] = demoResumable(content, demoProjectCwd(content, 'main'), NOW);
      expect(willow?.engineSessionId).toBe(first?.engineSessionId);
    }
  });

  it('„Wznów”, odpowiedzi, fragmenty strumienia i pytania atrapy: ta sama liczba i struktura', () => {
    const struct = (content: DemoContent): unknown => ({
      resumable: content.resumable.map((entry) => entry.agoMs),
      replies: content.driver.replies.length,
      fragments: content.driver.streamFragments.length,
      lastFragmentClosesParagraph: content.driver.streamFragments.at(-1)?.endsWith('\n\n'),
      questions: content.driver.questions.map((question) => ({
        multiSelect: question.multiSelect, options: question.options.length,
      })),
      triggers: Object.fromEntries(Object.entries(content.driver.triggers).map(([kind, words]) => [kind, words.length > 0])),
    });
    expect(struct(demoContentEn)).toEqual(struct(demoContentPl));
  });

  it('patch diffu w obu językach: każdy plik `DEMO_DIFF_FILES` z liczbą dodanych i usuniętych linii z tabeli', () => {
    for (const content of [demoContentPl, demoContentEn]) {
      for (const file of DEMO_DIFF_FILES) {
        const lines = (demoDiffFile(content, file.path)?.patch ?? '').split('\n');
        const body = lines.filter((line) => !line.startsWith('+++') && !line.startsWith('---'));
        expect(body.filter((line) => line.startsWith('+')).length, file.path).toBe(file.linesAdded);
        expect(body.filter((line) => line.startsWith('-')).length, file.path).toBe(file.linesDeleted);
      }
    }
  });

  it('stałe trybu recenzji: nazwa serwera, model i effort z kontraktu', () => {
    for (const content of [demoContentPl, demoContentEn]) {
      expect(content.review.serverName).not.toBe('');
      expect(content.review.model).toMatch(/^claude-/);
      expect(EFFORT_LEVELS).toContain(content.review.effort);
    }
  });
});

describe('sprawdzarka EN: bez polskich liter i bez słowa `rarog` w napisach widocznych', () => {
  it('zestaw EN przechodzi', () => {
    expect(nonEnglishTexts(demoContentTexts(demoContentEn))).toEqual([]);
  });

  it('sprawdzarka czyta wszystkie części zestawu (projekty, seedy, „Wznów”, diff, commit, notatka, atrapa)', () => {
    const paths = new Set(textLeaves(demoContentTexts(demoContentEn)).map((leaf) => /^\$\.(\w+)/.exec(leaf.path)?.[1]));
    expect([...paths].sort()).toEqual([
      'diff', 'driver', 'lastCommit', 'note', 'projects', 'resumable', 'review', 'seeds', 'uploads',
    ]);
  });

  it('zestaw PL nie przechodzi (polskie litery i projekt `rarog`)', () => {
    const problems = nonEnglishTexts(demoContentTexts(demoContentPl));
    expect(problems.some((problem) => problem.includes('polska litera'))).toBe(true);
    expect(problems.some((problem) => problem.includes('nazwa produktu'))).toBe(true);
  });

  it.each([
    ['słowo Rarog w notatce', { ...demoContentEn, noteText: `${demoContentEn.noteText}\nAsk Rarog.` }, '$.note.text'],
    ['projekt rarog-app', { ...demoContentEn, projects: { ...demoContentEn.projects, panel: 'rarog-app' } }, '$.projects'],
    ['polska litera w odpowiedzi atrapy', {
      ...demoContentEn, driver: { ...demoContentEn.driver, turnSummary: 'Testy są zielone.' },
    }, '$.driver.turnSummary'],
    ['RAROG w tytule seeda', {
      ...demoContentEn,
      seeds: (kit: DemoSeedKit) => demoContentEn.seeds(kit).map((seed, index) => index === 3 ? { ...seed, label: 'RAROG' } : seed),
    }, '$.seeds[3].label'],
    ['polska litera w stałej pokazu recenzji', {
      ...demoContentEn, review: { ...demoContentEn.review, serverName: 'Mac pokazowy żółty' },
    }, '$.review.serverName'],
  ] as const)('mutacja kopii zestawu EN: %s → czerwono z miejscem', (_name, mutated: DemoContent, where) => {
    const problems = nonEnglishTexts(demoContentTexts(mutated));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => problem.startsWith(where))).toBe(true);
  });

  it('identyfikatory struktury (`demo-rarog`) i dane obrazków nie są treścią', () => {
    expect(nonEnglishTexts({ id: 'demo-rarog', sessionId: 'demo-rarog-stop', dataUrl: 'ż', title: 'ok' })).toEqual([]);
    expect(nonEnglishTexts({ title: 'demo-rarog' })).toEqual(['$.title: nazwa produktu (demo-rarog)']);
  });
});

describePrivate('treść demo EN: nazwy klientów i projektów właściciela', privateContext(), (literals) => {
  it('zero trafień prywatnych literałów w napisach widocznych zestawu EN', () => {
    const text = textLeaves(demoContentTexts(demoContentEn)).map((leaf) => leaf.text).join('\n');
    expect(findPrivateHits(text, literals)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wyzwalacze atrapy: para PL i EN, te same zdarzenia
// ---------------------------------------------------------------------------

/** Zegar sterowany z testu, jak w `mock-driver.test.ts`. */
class ReczyZegar implements Scheduler {
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

/** Zdarzenia atrapy na jedno wejście: typy i pola, które rozstrzygają o stanie sesji. */
async function zdarzenia(content: DemoContent, wejscie: string): Promise<unknown[]> {
  const zegar = new ReczyZegar();
  const driver = new MockDriver({
    content, cwd: demoProjectCwd(content, 'main'), scenario: { kind: 'idle' }, scheduler: zegar,
  });
  const zebrane: DriverEvent[] = [];
  void (async () => { for await (const event of driver.events) zebrane.push(event); })();
  const oddaj = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
  zegar.tick(0);
  await oddaj();
  zebrane.length = 0;
  driver.send(wejscie);
  zegar.tick(20_000);
  await oddaj();
  driver.dispose();
  return zebrane.map((event) => {
    if (event.type === 'question-request') return { type: event.type, questions: event.questions.length };
    if (event.type === 'permission-request') return { type: event.type, displayText: event.displayText };
    if (event.type === 'exit') return { type: event.type, ok: event.ok };
    return event.type;
  });
}

describe('wyzwalacze EN: te same zdarzenia co pary PL', () => {
  const kinds = ['question', 'red', 'limit', 'error'] as const satisfies readonly (keyof DemoTriggers)[];

  it('słowa EN: question, dangerous, limit, crash', () => {
    expect(demoContentEn.driver.triggers).toEqual({
      question: ['question'], red: ['dangerous'], limit: ['limit'], error: ['crash'],
    });
  });

  it.each(kinds)('wyzwalacz %s: każde słowo EN daje to samo co pierwsze słowo PL, wielkość liter bez znaczenia', async (kind) => {
    const [slowoPl] = demoContentPl.driver.triggers[kind];
    const wzorzec = await zdarzenia(demoContentPl, `Please, ${slowoPl ?? ''} now.`);
    expect(wzorzec.length).toBeGreaterThan(0);
    for (const slowo of demoContentEn.driver.triggers[kind]) {
      expect(await zdarzenia(demoContentEn, `Please, ${slowo.toUpperCase()} now.`), slowo).toEqual(wzorzec);
    }
  });

  it('skutki wyzwalaczy EN: pytania, czerwona komenda, limit, błąd; zwykłe zdanie daje zwykłą turę', async () => {
    expect(await zdarzenia(demoContentEn, 'I have a question.')).toEqual([{ type: 'question-request', questions: 2 }]);
    expect(await zdarzenia(demoContentEn, 'Run the dangerous one.'))
      .toEqual([{ type: 'permission-request', displayText: RED_COMMAND }]);
    expect(await zdarzenia(demoContentEn, 'Hit the limit.')).toEqual(['limit-reached']);
    expect(await zdarzenia(demoContentEn, 'Make it crash.')).toEqual([{ type: 'exit', ok: false }]);
    // Liczba delt zależy od długości odpowiedzi (słowa), więc porównanie zwija serie tego samego zdarzenia.
    const zwin = (events: unknown[]): unknown[] => events.filter((event, index) => index === 0
      || JSON.stringify(event) !== JSON.stringify(events[index - 1]));
    const zwykla = zwin(await zdarzenia(demoContentEn, 'Review the module.'));
    expect(zwykla).toEqual(zwin(await zdarzenia(demoContentPl, 'Zrób przegląd modułu.')));
    expect(zwykla).toContain('delta');
  });
});
