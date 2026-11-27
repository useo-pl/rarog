/**
 * Granice katalogu zadań w tle (`server/src/herdr/background/`) — strażnicy „jednego miejsca".
 *
 * Katalog ma sens tylko wtedy, gdy wiedza o zadaniach w tle naprawdę w nim ZOSTAJE. Dobra wola
 * tego nie utrzyma: drugi parser meldunku albo trzecia kopia reguły „co jest pracą" powstają jako
 * jedna wygodna linia w cudzym pliku. Dlatego testy są GREPOWE, jak `drivers-herdr-boundary.test.ts`
 * i `sdk-boundary.test.ts`: łamiąca zmiana ma się pokazać jako czerwony test, a nie w review.
 *
 * Opis katalogu i reguł: `docs/background-tasks.md`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLI_SHAPES, UNKNOWN } from '../src/herdr/background/cli-shapes.ts';
import type { CliShape } from '../src/herdr/background/cli-shapes.ts';
import { relativeImports, scan, tsFiles, unbalanced } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'server/src');
const DIR = join(SRC, 'herdr/background');
const DOC = 'docs/background-tasks.md';

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(file, 'utf8');

/** Moduły katalogu jako ścieżki względem korzenia repo (tak stoją w dokumencie). */
const MODULES = tsFiles(DIR).map(repoPath);

/** Każdy plik `server/src/**` po skanerze, pod ścieżką względem korzenia repo. */
const SCANNED = new Map(tsFiles(SRC).map((file) => [repoPath(file), scan(read(file))]));
/** Sam kod (bez komentarzy) — na nim pracują strażnicy. */
const CODE = new Map([...SCANNED].map(([file, scanned]) => [file, scanned.code]));

describe('skaner komentarzy (na nim stoją strażnicy kodu)', () => {
  it('zdejmuje komentarze, zostawia napisy, szablony i wzorce', () => {
    const sample = [
      "const url = 'https://x/y'; // 'komentarz-liniowy'",
      '/* "komentarz-blokowy" */ const re = /a\\/\\/b[/*]"c"/g;',
      'const t = `x ${a /* w-interpolacji */ + `y ${b}`} // w-szablonie`;',
      'function f() { return /"([^"]+)"/.exec(s); } /** `jsdoc` */',
      'const half = total / 2; // dzielenie',
    ].join('\n');
    const { code, skeleton } = scan(sample);
    for (const gone of ['komentarz-liniowy', 'komentarz-blokowy', 'w-interpolacji', 'jsdoc', 'dzielenie']) {
      expect(code, `komentarz „${gone}" został w kodzie`).not.toContain(gone);
    }
    for (const kept of [
      "'https://x/y'", '/a\\/\\/b[/*]"c"/g', '// w-szablonie`', '/"([^"]+)"/.exec(s)', 'total / 2',
    ]) {
      expect(code, `kod „${kept}" zniknął`).toContain(kept);
    }
    expect(skeleton, 'szkielet niesie treść napisu albo wzorca').not.toMatch(/https|w-szablonie|\[\^/);
    expect(unbalanced(skeleton)).toBeNull();
  });

  it('wzorzec po warunku `if (…)` nie zjada reszty pliku', () => {
    /*
     * Po `)` ukośnik jest zwykle dzieleniem, ale po zamknięciu WARUNKU stoi instrukcja. Wzorzec
     * z `/*` w klasie znaków wzięty tam za dzielenie otwierał „komentarz" do końca pliku i chował
     * przed strażnikami wszystko, co stało niżej — także wewnątrz tej samej funkcji.
     */
    const source = [
      'function f(text: string, entry: Record<string, unknown>, session: S): unknown {',
      '  if (text) /[/*]/.test(text);',
      "  return entry['toolUseResult'] ?? session.backgroundTasks.length;",
      '}',
      'while (more()) /\\/\\//.test(next()); const tail = ratio(a) / 2;',
    ].join('\n');
    const { code, skeleton } = scan(source);
    for (const kept of ["entry['toolUseResult']", 'session.backgroundTasks.length', 'const tail = ratio(a) / 2']) {
      expect(code, `kod „${kept}" zniknął`).toContain(kept);
    }
    expect(unbalanced(skeleton)).toBeNull();
  });

  it('równowaga nawiasów szkieletu wykrywa zjedzony kod', () => {
    expect(unbalanced('f(a[0]) { g(); }')).toBeNull();
    expect(unbalanced('function f() { if (x) ')).not.toBeNull();
    expect(unbalanced('g(); }')).not.toBeNull();
    expect(unbalanced('f(a[0)]')).not.toBeNull();
    // Komentarz z deklaracją od kolumny zero znika i niczego nie psuje.
    expect(unbalanced(scan('/*\nconst przyklad = { a: (1 };\n*/\nexport const n = [1];').skeleton)).toBeNull();
  });

  it('widzi kod serwera (inaczej strażnicy niżej byliby puści)', () => {
    expect(CODE.size).toBeGreaterThan(50);
    expect(CODE.get('server/src/herdr/background/reducer.ts')).toContain('createBackgroundTasksTracker');
  });

  it('nie połyka kodu: w każdym pliku `server/src/**` nawiasy szkieletu się domykają', () => {
    const broken = [...SCANNED].flatMap(([file, { skeleton }]) => {
      const problem = unbalanced(skeleton);
      return problem === null ? [] : [`${file}: ${problem}`];
    });
    expect(broken, 'skaner źle czyta ten plik — strażnicy mogą w nim nie widzieć kodu').toEqual([]);
  });
});

describe('katalog zadań w tle: istnieje i ma wejście', () => {
  it('ma moduły (bez nich żaden strażnik niżej niczego nie broni)', () => {
    expect(MODULES.length).toBeGreaterThan(0);
    expect(MODULES).toContain('server/src/herdr/background/index.ts');
  });
});

describe('katalog zadań w tle: kierunek zależności', () => {
  /*
   * Fasada drivera, manager i nadzorca WOŁAJĄ katalog. Import w drugą stronę zamknąłby cykl
   * i wpuścił do czystych modułów stan, którego nie da się podać w teście.
   */
  const FORBIDDEN = [
    'server/src/drivers/herdr-driver.ts',
    'server/src/sessions/manager.ts',
    'server/src/herdr/supervisor.ts',
  ];

  /** Importowane ścieżki względne (`relativeImports`), rozwiązane do ścieżek repo. */
  function importsOf(file: string): string[] {
    return relativeImports(read(join(REPO, file))).map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));
  }

  it('wzorzec importów widzi importy (inaczej zakaz byłby pusty)', () => {
    expect(MODULES.flatMap(importsOf).length).toBeGreaterThan(0);
  });

  it.each(MODULES)('%s nie importuje fasady drivera, managera ani nadzorcy', (file) => {
    for (const imported of importsOf(file)) {
      expect(FORBIDDEN, `${file} importuje ${imported}`).not.toContain(imported);
    }
  });
});

describe('katalog zadań w tle: moduły czyste nie sięgają po dysk', () => {
  /*
   * Reduktor, parser meldunku, notka, reguły pracy, rejestr, strażniki id i cięcie bajtów na linie
   * mają dać się wołać w teście bez plików i zegara. Import `node:*` albo modułu z dyskiem
   * (`satellite.ts`, `workflow-run.ts`, `agent-file.ts`, `main-scan.ts`) po cichu by to zmienił.
   */
  const PURE = [
    'artifacts.ts', 'cli-shapes.ts', 'ids.ts', 'jsonl-lines.ts', 'notification.ts', 'notice.ts', 'pull-requests.ts',
    'queued-prompt.ts', 'reducer.ts', 'scheduled-tasks.ts', 'work.ts',
  ]
    .map((name) => `server/src/herdr/background/${name}`);
  const DISK = [
    'agent-file.ts', 'incremental-read.ts', 'main-scan.ts', 'satellite.ts', 'workflow-run.ts',
  ]
    .map((name) => `server/src/herdr/background/${name}`);

  it('lista czystych i lista dyskowych wskazują istniejące pliki', () => {
    for (const file of [...PURE, ...DISK]) expect(MODULES, `brak ${file}`).toContain(file);
  });

  it('moduły dyskowe naprawdę importują `node:fs` (inaczej zakaz niżej byłby pusty)', () => {
    for (const file of DISK) expect(read(join(REPO, file))).toMatch(/\bfrom\s+['"]node:fs/);
  });

  it.each(PURE)('%s nie importuje `node:*` ani modułu z dyskiem', (file) => {
    const source = read(join(REPO, file));
    expect(source, `${file} importuje moduł node:*`).not.toMatch(/\bfrom\s+['"]node:/);
    for (const spec of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const imported = repoPath(resolve(dirname(join(REPO, file)), spec[1] ?? ''));
      expect(DISK, `${file} importuje ${imported}`).not.toContain(imported);
    }
  });
});

describe('katalog zadań w tle: mapa modułów w dokumencie', () => {
  const doc = read(join(REPO, DOC));

  /** Sekcja „Module map" — od nagłówka do następnego `## `. */
  function moduleMap(): string {
    const start = doc.indexOf('\n## Module map');
    expect(start, `${DOC} stracił sekcję „Module map"`).toBeGreaterThan(-1);
    const rest = doc.slice(start + 1);
    const end = rest.indexOf('\n## ');
    return rest.slice(0, end === -1 ? undefined : end);
  }

  it.each(MODULES)('%s stoi w mapie modułów dokumentu', (file) => {
    expect(moduleMap(), `${DOC}: brak \`${file}\` w sekcji „Module map"`).toContain(`\`${file}\``);
  });

  it('mapa nie wymienia pliku katalogu, którego już nie ma', () => {
    const listed = [...moduleMap().matchAll(/`(server\/src\/herdr\/background\/[^`]+\.ts)`/g)]
      .map((hit) => hit[1] ?? '');
    expect(listed.length, 'mapa nie wymienia ani jednego pliku katalogu').toBeGreaterThan(0);
    for (const file of listed) expect(MODULES, `${DOC} wymienia nieistniejący ${file}`).toContain(file);
  });

  it('mapa w `index.ts` wymienia te same pliki co katalog', () => {
    const header = read(join(DIR, 'index.ts'));
    for (const file of tsFiles(DIR)) {
      const name = relative(DIR, file);
      expect(header, `index.ts: brak \`${name}\` w mapie modułów`).toContain(`\`${name}\``);
    }
  });
});

describe('rejestr kształtów CLI: literał stoi w JEDNYM pliku', () => {
  const REGISTRY = 'server/src/herdr/background/cli-shapes.ts';

  /**
   * Pliki, którym wolno nosić literały rejestru — lista ZAMKNIĘTA.
   *
   * `demo/seeds.ts` składa przykładowe meldunki CLI jako WEJŚCIE parsera (dane trybu demo, jak
   * fixture testu) i podaje je temu samemu `noticeFromText` co produkcja. To nie jest drugi parser.
   */
  const SAMPLE_DATA = ['server/src/demo/seeds.ts'];

  /**
   * Literały, których strażnik ŚWIADOMIE nie pilnuje (`common` w rejestrze) — lista ZAMKNIĘTA.
   * Nowy wpis `common` wymaga dopisania tutaj, żeby „pospolity" nie stał się wytrychem.
   */
  const COMMON = [
    'agentResume.success',
    'artifactPublish.title', 'artifactPublish.url',
    'artifactWatch.ended',
    'foregroundEnd.background', 'foregroundEnd.status',
    'monitorTool.timeout', 'monitorTool.tool',
    'notificationCarriers.attachmentField', 'notificationCarriers.attachmentType',
    'notificationCarriers.queueText', 'notificationCarriers.queuedText',
    'queuedPrompt.human', 'queuedPrompt.kind', 'queuedPrompt.origin', 'queuedPrompt.prompt',
    'scheduledTasks.createdAt', 'scheduledTasks.ended', 'scheduledTasks.id', 'scheduledTasks.loop',
    'scheduledTasks.prompt', 'scheduledTasks.tasks',
    'skillFork.args', 'skillFork.skill', 'skillFork.tool',
    'summaryKinds.agent', 'summaryKinds.monitorEnd',
    'taskDescription.command', 'taskDescription.description',
    'taskOutput.status', 'taskOutput.task',
    'taskStart.agentId',
    'taskStop.message',
    'taskTools.agent', 'taskTools.bash', 'taskTools.task', 'taskTools.workflow',
    'taskWho.summary', 'taskWho.until',
    'terminalStatuses.completed', 'terminalStatuses.failed', 'terminalStatuses.killed',
    'terminalStatuses.stopped',
  ];

  const SHAPES = Object.entries(CLI_SHAPES) as [string, CliShape][];

  /** Wszystkie literały rejestru jako (nazwa `kształt.klucz`, tekst). */
  const LITERALS = SHAPES.flatMap(([shape, entry]) =>
    Object.entries(entry.literals).flatMap(([key, value]) =>
      (typeof value === 'string' ? [value] : [...value]).map((text) => ({ name: `${shape}.${key}`, text }))));

  /**
   * Postacie literału, których szukamy w kodzie. Nazwa pola (sam identyfikator) znaczy coś dopiero
   * JAKO NAPIS — `result['taskType']`; goły identyfikator stoi w typach i zmiennych całego
   * serwera. Tekst ze spacją, myślnikiem albo nawiasem jest charakterystyczny sam w sobie.
   * Granica strażnika: dostępu przez kropkę (`result.taskType`) nie widzi.
   */
  function needles(text: string): string[] {
    return /^[A-Za-z_$][\w$]*$/.test(text) ? [`'${text}'`, `"${text}"`, `\`${text}\``] : [text];
  }

  it('ma wpisy, a każdy ma opis, literały i wersję pomiaru', () => {
    expect(SHAPES.length).toBeGreaterThan(10);
    for (const [shape, entry] of SHAPES) {
      expect(entry.what.trim(), `${shape}: pusty opis`).not.toBe('');
      expect(Object.keys(entry.literals).length, `${shape}: brak literałów`).toBeGreaterThan(0);
      expect(entry.cli === UNKNOWN || /^\d+\.\d+\.\d+$/.test(entry.cli), `${shape}: wersja „${entry.cli}"`).toBe(true);
    }
    for (const { name, text } of LITERALS) expect(text, `${name}: pusty literał`).not.toBe('');
  });

  it('lista literałów niepilnowanych jest zamknięta i każdy ma powód', () => {
    const declared = SHAPES.flatMap(([shape, entry]) =>
      Object.entries(entry.common ?? {}).map(([key, why]) => {
        expect(Object.keys(entry.literals), `${shape}.common wskazuje nieistniejący literał „${key}"`).toContain(key);
        expect(why.trim(), `${shape}.${key}: pusty powód`).not.toBe('');
        return `${shape}.${key}`;
      }));
    expect(declared.sort()).toEqual([...COMMON].sort());
  });

  it('wzorzec łapie literały tam, gdzie stać MAJĄ (inaczej zakaz byłby pusty)', () => {
    const registry = CODE.get(REGISTRY) ?? '';
    for (const { name, text } of LITERALS) {
      expect(needles(text).some((needle) => registry.includes(needle)), `${name} nie stoi w rejestrze jako kod`)
        .toBe(true);
    }
    // Dane demo niosą literały naprawdę — gdyby przestały, wyjątek jest do zdjęcia.
    for (const file of SAMPLE_DATA) {
      expect(CODE.get(file) ?? '', `${file} nie potrzebuje już wyjątku`).toContain(CLI_SHAPES.notification.literals.open);
    }
  });

  it('żaden plik `server/src/**` poza rejestrem nie powtarza pilnowanego literału w kodzie', () => {
    const guarded = LITERALS.filter(({ name }) => !COMMON.includes(name));
    expect(guarded.length).toBeGreaterThan(20);
    const repeated: string[] = [];
    for (const [file, code] of CODE) {
      if (file === REGISTRY || SAMPLE_DATA.includes(file)) continue;
      for (const { name, text } of guarded) {
        if (needles(text).some((needle) => code.includes(needle))) repeated.push(`${file}: ${name} („${text}")`);
      }
    }
    expect(repeated, 'literał CLI poza rejestrem — weź go z `CLI_SHAPES`').toEqual([]);
  });
});

describe('co jest pracą: listę zadań liczy tylko `work.ts`', () => {
  /*
   * Manager (push „gotowe", restart sesji) i powiadomienia (ponowna kontrola pusha, kafel Live
   * Activity) PYTAJĄ, czy coś pracuje; odpowiedź liczy `herdr/background/work.ts`. Kopia reguły
   * w wywołującym rozjeżdża się przy pierwszej zmianie definicji pracy. Taka zmiana już była:
   * subagent w postoju przestał być pracą i wystarczyło zmienić `work.ts`.
   */
  const MANAGER = 'server/src/sessions/manager.ts';
  const LIVE_ACTIVITY = 'server/src/notify/live-activity-state.ts';
  // Restart sesji (druga kontrola listy zadań przed `/exit`) mieszka w module managera `session-restart.ts`.
  const RESTART = 'server/src/sessions/session-restart.ts';
  // The task list swap (asks `holdsOwedDone` before and after) lives in the manager module `conversation-lists.ts`.
  const LISTS = 'server/src/sessions/conversation-lists.ts';
  const SCOPE = [...CODE.keys()].filter(
    (file) => file === MANAGER || file === RESTART || file === LISTS || file.startsWith('server/src/notify/'),
  );

  /** Sposoby liczenia zadań na własną rękę. Nazwa mówi, co wzorzec łapie. */
  const COUNTING: readonly { what: string; pattern: RegExp }[] = [
    {
      what: 'długość, przeszukanie albo filtr listy zadań',
      pattern: new RegExp(
        'backgroundTasks\\b\\s*(?:\\?\\?\\s*\\[\\s*\\]\\s*)?\\)*\\s*(?:\\?\\.|!\\.|\\.)\\s*'
        + '(?:length|some|every|filter|find|findIndex|findLast|map|flatMap|reduce|forEach|at|entries|values)\\b',
      ),
    },
    { what: 'pętla po liście zadań', pattern: /\bof\s+(?:\(\s*)?[\w$.?!]*\bbackgroundTasks\b/ },
    { what: 'kopia listy zadań', pattern: /\.\.\.\s*[\w$.?!]*\bbackgroundTasks\b/ },
    { what: 'indeks listy zadań', pattern: /backgroundTasks\b\s*(?:\?\.)?\[/ },
    {
      what: 'rozstrzyganie po rodzaju zadania',
      pattern: /\.kind\s*[!=]==?\s*['"`](?:command|agent|workflow|monitor)['"`]/,
    },
    // Czy subagent stoi w postoju, mówi `waitingAgent` w `work.ts`. Wywołujący pola nie czytają.
    { what: 'rozstrzyganie po postoju subagenta', pattern: /\bwaitingSince\b/ },
    // Czy agent w postoju czeka na własną komendę, mówi
    // `waitingOnOwnCommand` w `work.ts`. Listy komend agenta wywołujący nie czytają.
    { what: 'odczyt własnych komend subagenta', pattern: /\bownTasks\b/ },
    // How long a subagent has waited on its own command, and what follows from it, answers `work.ts`; callers do not
    // read the wait stage field.
    { what: 'reading the wait stage of a subagent', pattern: /\bownCommandWait\b/ },
  ];

  const hits = (code: string): string[] =>
    COUNTING.filter(({ pattern }) => pattern.test(code)).map(({ what }) => what);

  it('zakres obejmuje managera i powiadomienia', () => {
    expect(SCOPE).toContain(MANAGER);
    expect(SCOPE).toContain(LISTS);
    expect(SCOPE).toContain(LIVE_ACTIVITY);
    expect(SCOPE).toContain('server/src/notify/policy.ts');
  });

  it('wzorce łapią dawne zdania z `main` (inaczej zakaz byłby pusty)', () => {
    const OLD = [
      'if ((session.backgroundTasks?.length ?? 0) > 0) throw new BadStateError(RESTART_TASKS_MESSAGE);',
      'backgroundTasks: session.backgroundTasks?.length ?? 0,',
      'return (session.backgroundTasks ?? []).some(liveTask);',
      '|| (session.backgroundTasks ?? []).some(openWorkflow));',
      'for (const task of session.backgroundTasks ?? []) {',
      "return task.kind !== 'workflow' || openWorkflow(task);",
      'const copy = [...session.backgroundTasks];',
      'const first = session.backgroundTasks?.[0];',
      'const waiting = tasks.every((task) => task.waitingSince !== undefined);',
      'const own = (agent.ownTasks?.length ?? 0) > 0;',
      "...(tasks.some((t) => t.ownTasks) ? { waitingOnOwnCommand: true } : {}),",
      "if (task.ownCommandWait === 'stuck') this.#config.notifier?.stalled(session.id);",
      'const { ownCommandWait } = agent;',
    ];
    for (const line of OLD) expect(hits(line), `wzorce nie łapią: ${line}`).not.toEqual([]);
  });

  it('wzorce przepuszczają pytanie do `work.ts` i przekazanie listy dalej', () => {
    const FINE = [
      'if (tasksBlockRestart(session.backgroundTasks)) {',
      'onlyWaitingAgents(session.backgroundTasks) ? RESTART_WAITING_AGENT_MESSAGE : RESTART_TASKS_MESSAGE,',
      'backgroundTasks: tasksHoldingDonePush(session.backgroundTasks),',
      'backgroundTasks: tasksHoldingDonePush(summary.backgroundTasks),',
      'backgroundTasks: look.backgroundTasks,',
      "return (state === 'waiting-input' || state === 'done') && backgroundTasks === 0;",
      'const background = sessions.filter((s) => QUIET.includes(s.state) && hasBackgroundWork(s.backgroundTasks));',
      'for (const { task, run } of workflowsWithRun(session.backgroundTasks)) {',
      'session.backgroundTasks = event.tasks.length > 0 ? event.tasks : undefined;',
      'readonly backgroundTasks: number;',
      "return input.backgroundTasks > 0 ? null : 'done';",
      "if (content.kind === 'done') return true;",
      '...(waitingOnOwnCommand(session.backgroundTasks) ? { waitingOnOwnCommand: true } : {}),',
      'waitingOnOwnCommand: waitingOnOwnCommand(summary.backgroundTasks),',
      ': entry.owedRelease && look.waitingOnOwnCommand',
      'const held = holdsOwedDone(session.backgroundTasks);',
      'if (held && !holdsOwedDone(tasks)) this.#config.notifier?.quiet(session.id);',
      'const stage = ownCommandWaitOf(task, deps.scheduler.now());',
      'const key = waitKey(task);',
      'const waits = stuckWaits(session.state, session.backgroundTasks, tasks);',
      'port.stuckWaits(session, waits);',
      'stuckWaits: (session, waits) => { this.#config.stalledWait?.stuckWaits(session, waits); },',
    ];
    for (const line of FINE) expect(hits(line), `fałszywy alarm: ${line}`).toEqual([]);
  });

  it.each(SCOPE)('%s nie liczy zadań w tle sam', (file) => {
    expect(hits(CODE.get(file) ?? ''), `${file}: zapytaj funkcję z herdr/background/work.ts`).toEqual([]);
  });

  it('manager, harmonogram i kafel Live Activity biorą odpowiedź z `work.ts`', () => {
    for (const file of [MANAGER, LIVE_ACTIVITY, 'server/src/notify/index.ts']) {
      expect(CODE.get(file) ?? '', `${file} nie importuje work.ts`).toMatch(/from '[^']*herdr\/background\/work\.ts'/);
    }
  });
});
