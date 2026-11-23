/**
 * `SessionSummary.waitingFor` — NA CO czeka sesja stojąca na decyzji.
 *
 * Powód istnienia pola: pełne `pendingPermissions`/`pendingQuestions` jadą wyłącznie
 * strumieniem OGLĄDANEJ sesji, więc karta w sidebarze nie miała z czego powiedzieć, na co
 * agent czeka — mówiła tylko, że czeka. Ten plik pilnuje trzech rzeczy, które da się złamać
 * jedną linijką, a których ceną jest linia kłamiąca na liście albo cisza tam, gdzie ma być
 * napis:
 * - pole JEST liczone z kolejki i jedzie kanałem globalnym (`list()` i `session-changed`),
 * - pole NIE jedzie poza stanami decyzji (bramka `DECISION_STATES`) ani po zdjęciu karty,
 * - ramka `session-changed` leci TAKŻE przy przejściu-tożsamości — inaczej pole powstaje
 *   w managerze, ale nigdy nie dojeżdża do listy w chwili, w której karta się pojawia.
 *
 * Atrapy nadzorcy i drivera są tu WŁASNE i minimalne (zero gniazda, zero procesów): ten plik
 * bada kształt summary, a nie cykl życia paneli — ten ma własny zestaw w `manager-herdr`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WAITING_TEXT_MAX } from '@rarog/shared';
import type {
  HerdrStatus, Question, ServerEvent, SessionSummary,
} from '@rarog/shared';
import { createManager } from '../src/sessions/manager.ts';
// Opis inputu bierzemy z TEJ SAMEJ funkcji, co driver — napis wpisany ręcznie nie złapałby
// tego, że dla narzędzi bez pola `command` pierwszą linią jest sama klamra JSON-a.
import { describeToolInput } from '../src/drivers/tool-summary.ts';
import { degradedCard, screenPermissionCard } from '../src/herdr/dialogs/cards/build.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import type { NoteInput, NotifierLike } from '../src/notify/index.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const PROJECT = '/Users/u/Projects/atlas';
const ENGINE_SESSION = '11111111-1111-4111-8111-111111111111';
const KEY = 'w9:p72';

// ---------------------------------------------------------------------------
// Atrapy
// ---------------------------------------------------------------------------

class FakeSupervisor extends AtrapaNadzorcy {
  readonly live = new Map<string, HerdrAgent>();

  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: true };
  }

  protected nowyDriver(key: string): AtrapaDrivera {
    const driver = new AtrapaDrivera(key);
    // Realny driver melduje stan od razu — manager zwalnia na tym slot podpięcia.
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }

  agentFor(key: string): HerdrAgent | undefined {
    return this.live.get(key);
  }

  appear(agent: HerdrAgent): void {
    this.live.set(agent.key, agent);
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function makeDeps(): HerdrManagerDeps {
  const aliases = new Map<string, string>();
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: (engine) => aliases.get(engine),
    rememberAlias: (engine, id) => { aliases.set(engine, id); },
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

function makeAgent(): HerdrAgent {
  return {
    key: KEY,
    paneId: KEY,
    agentSessionId: ENGINE_SESSION,
    engine: 'claude',
    termId: null,
    cwd: PROJECT,
    status: 'idle',
    title: 's3-back',
    stateChangeSeq: 1,
    mode: 'auto',
    modeReadAt: 0,
    inScope: true,
    tabId: 'w9:t3',
    launchedByRarog: false,
    interactiveReady: true,
  };
}

/** Oddaje sterowanie pętli zdarzeń, żeby pompy managera przetrawiły kolejki. */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

function question(text: string): Question {
  return { question: text, header: 'Wybór', multiSelect: false, options: [{ label: 'Tak' }] };
}

// ---------------------------------------------------------------------------

describe('waitingFor — skrót stojącej decyzji na karcie listy', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-waitingfor-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function build(overrides: Partial<ManagerConfig> = {}): Promise<{
    manager: Manager; supervisor: FakeSupervisor; driver: AtrapaDrivera; id: string;
  }> {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      maxPanes: 6,
      herdrSupervisor: supervisor,
      herdrDeps: makeDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
      ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    return { manager, supervisor, driver: supervisor.driver(KEY), id };
  }

  function record(manager: Manager): { scope: string; event: ServerEvent }[] {
    const out: { scope: string; event: ServerEvent }[] = [];
    manager.onEvent((scope, _seq, event) => { out.push({ scope, event }); });
    return out;
  }

  /** Ostatnia karta sesji z kanału GLOBALNEGO — dokładnie to, co dostaje lista. */
  function lastGlobalSummary(
    events: { scope: string; event: ServerEvent }[],
  ): SessionSummary | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const entry = events[i];
      if (entry !== undefined && entry.scope === 'global' && entry.event.type === 'session-changed') {
        return entry.event.session;
      }
    }
    return undefined;
  }

  /** Panel staje na dialogu (`agent-blocked`), potem driver melduje TREŚĆ zgody. */
  async function blockOnPermission(
    driver: AtrapaDrivera, displayText: string, toolName = 'Bash',
  ): Promise<void> {
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-1',
      toolName,
      input: { command: displayText },
      displayText,
    });
    await flush();
  }

  /** Zgoda z REALNYM `displayText` — tak, jak składa go driver z inputu narzędzia. */
  async function blockOnTool(
    driver: AtrapaDrivera, toolName: string, input: Record<string, unknown>,
  ): Promise<void> {
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-1',
      toolName,
      input,
      displayText: describeToolInput(toolName, input).text,
    });
    await flush();
  }

  // -------------------------------------------------------------------------
  // Co jedzie na drut
  // -------------------------------------------------------------------------

  it('zgoda niesie rodzaj, narzędzie i pierwszą linię treści — w list() i w ramce', async () => {
    const { manager, driver, id } = await build();
    const events = record(manager);
    await blockOnPermission(driver, 'pnpm test');

    expect(manager.list().find((s) => s.id === id)?.waitingFor)
      .toEqual({ kind: 'permission', tool: 'Bash', text: 'pnpm test', subject: 'tool' });
    // Kanał GLOBALNY, bo tylko jego słucha lista — strumień sesji ma pełne karty.
    expect(lastGlobalSummary(events)?.waitingFor)
      .toEqual({ kind: 'permission', tool: 'Bash', text: 'pnpm test', subject: 'tool' });
  });

  it('karta planu niesie samo narzędzie — treścią jest CAŁY plan, nie jedna linia', async () => {
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, '# Plan\n\nKrok 1', 'ExitPlanMode');

    const waiting = manager.list().find((s) => s.id === id)?.waitingFor;
    expect(waiting?.tool).toBe('ExitPlanMode');
    /*
     * `text` NIE jedzie: widok rysuje dla planu samo słowo „plan" (`cardWaitingText`), więc
     * nagłówek planu byłby danymi, których nikt nie pokazuje. Asercja pilnuje kontraktu
     * `WaitingFor.text` („nieobecna = nie ma jednej linii, która by decyzję opisała").
     */
    expect(waiting?.text).toBeUndefined();
    // Lista mówi „plan" z tego pola — klient nie zna nazwy `ExitPlanMode`.
    expect(waiting?.subject).toBe('plan');
  });

  it('narzędzie bez pola `command` daje ŚCIEŻKĘ, nie klamrę JSON-a', async () => {
    /*
     * `displayText` dla `Edit` to pretty-printowany JSON, więc pierwszą jego linią jest samo `{`:
     * pierwsza linia dałaby kartę „zgoda: Edit · {".
     */
    const { manager, driver, id } = await build();
    await blockOnTool(driver, 'Edit', {
      file_path: '/Users/u/Projects/atlas/web/src/views/composer.ts',
      old_string: 'a',
      new_string: 'b',
    });

    expect(manager.list().find((s) => s.id === id)?.waitingFor)
      .toEqual({
        kind: 'permission',
        tool: 'Edit',
        text: '/Users/u/Projects/atlas/web/src/views/composer.ts',
        subject: 'tool',
      });
  });

  it('narzędzie bez pola, po którym da się poznać cel, zostaje przy samej nazwie', async () => {
    const { manager, driver, id } = await build();
    await blockOnTool(driver, 'Task', { description: 'Research', prompt: 'Zbadaj X' });

    expect(manager.list().find((s) => s.id === id)?.waitingFor)
      .toEqual({ kind: 'permission', tool: 'Task', subject: 'tool' });
  });

  it('karta ZDEGRADOWANA nie wozi zdania o Rarogu — to nie treść decyzji', async () => {
    /*
     * `degradedCard` wstawia w `displayText` zdanie „Rarog nie potwierdził, czego dotyczy ten
     * dialog…" (umowa `input: null` → `canAllow: false`). To komunikat O RAROGU, nie o zgodzie;
     * powód degradacji niesie karta sesji, a nie wiersz listy.
     */
    const { manager, driver, id } = await build();
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-1',
      toolName: 'Bash',
      input: null,
      displayText: 'Rarog nie potwierdził, czego dotyczy ten dialog.',
    });
    await flush();

    expect(manager.list().find((s) => s.id === id)?.waitingFor)
      .toEqual({ kind: 'permission', tool: 'Bash', subject: 'tool' });
  });

  it('pytanie niesie treść, a liczbę pytań DOPIERO od dwóch', async () => {
    const { manager, driver, id } = await build();
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    driver.queue.push({
      type: 'question-request',
      reqId: 'q-1',
      questions: [question('Który plik?'), question('Który tryb?'), question('Który model?')],
    });
    await flush();

    expect(manager.list().find((s) => s.id === id)?.waitingFor)
      .toEqual({ kind: 'question', text: 'Który plik?', count: 3 });
  });

  it('jedno pytanie nie niesie licznika — „1" nie jest informacją', async () => {
    const { manager, driver, id } = await build();
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    driver.queue.push({
      type: 'question-request', reqId: 'q-1', questions: [question('Który plik?')],
    });
    await flush();

    expect(manager.list().find((s) => s.id === id)?.waitingFor)
      .toEqual({ kind: 'question', text: 'Który plik?' });
  });

  // -------------------------------------------------------------------------
  // Limit treści
  // -------------------------------------------------------------------------

  it('heredoc i wieloliniowa komenda skracają się do PIERWSZEJ linii', async () => {
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, "cat <<'EOF' > .env\nSECRET=abc\nEOF");

    expect(manager.list().find((s) => s.id === id)?.waitingFor?.text)
      .toBe("cat <<'EOF' > .env");
  });

  it('jedna długa linia dostaje sufit i wielokropek', async () => {
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, 'x'.repeat(300));

    const text = manager.list().find((s) => s.id === id)?.waitingFor?.text ?? '';
    expect(text.length).toBe(WAITING_TEXT_MAX + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('cięcie nie rozcina pary surogatów — ostatni znak jest PEŁNY', async () => {
    /*
     * `slice(0, 120)` liczy jednostki UTF-16: przy emoji na 120. znaku zabierało jego pierwszą
     * połówkę, a `trimEnd()` samotnego surogata nie usuwa (to nie biały znak) — na karcie
     * stawało „�…". Cięcie idzie po PUNKTACH KODOWYCH.
     */
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, `${'x'.repeat(WAITING_TEXT_MAX - 1)}🚀ogon`);

    const text = manager.list().find((s) => s.id === id)?.waitingFor?.text ?? '';
    expect(text.endsWith('🚀…')).toBe(true);
    expect([...text]).toHaveLength(WAITING_TEXT_MAX + 1);
  });

  it('ścieżka z emoji na granicy skrótu etykiety też zostaje PEŁNA', async () => {
    /*
     * Druga droga do tej samej usterki: dla `Edit` tekst bierze się
     * z `summarizeToolInput` → `shorten`, które cięło po `length` — samotny surogat trafiał
     * do `waitingText` już gotowy i jej cięcie po punktach nic nie mogło naprawić.
     */
    const { manager, driver, id } = await build();
    await blockOnTool(driver, 'Edit', {
      file_path: `/${'a'.repeat(WAITING_TEXT_MAX - 3)}🚀/file.ts`,
      old_string: 'a',
      new_string: 'b',
    });

    const text = manager.list().find((s) => s.id === id)?.waitingFor?.text ?? '';
    // Bez samotnego surogata na końcu — TS lib repo nie zna jeszcze `isWellFormed()`.
    expect(text).not.toMatch(/[\uD800-\uDBFF]…$/u);
    expect(text.endsWith('🚀…')).toBe(true);
  });

  it('linia mieszcząca się w sufit NIE dostaje wielokropka', async () => {
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, 'x'.repeat(WAITING_TEXT_MAX));

    expect(manager.list().find((s) => s.id === id)?.waitingFor?.text)
      .toBe('x'.repeat(WAITING_TEXT_MAX));
  });

  // -------------------------------------------------------------------------
  // Bramka stanu: pole żyje WYŁĄCZNIE pod decyzją
  // -------------------------------------------------------------------------

  it('agent ruszył dalej (running) — pole znika, choć wpis w kolejce został', async () => {
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, 'pnpm test');
    expect(manager.list().find((s) => s.id === id)?.waitingFor).not.toBeUndefined();

    driver.queue.push({ type: 'agent-state', state: 'working' });
    await flush();

    expect(manager.get(id)?.state).toBe('running');
    expect(manager.get(id)?.waitingFor).toBeUndefined();
  });

  it('agent skończył (waiting-input) — pole znika', async () => {
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, 'pnpm test');

    driver.queue.push({ type: 'agent-state', state: 'idle' });
    await flush();

    expect(manager.get(id)?.state).toBe('waiting-input');
    expect(manager.get(id)?.waitingFor).toBeUndefined();
  });

  it('limit tur (interrupted) — pole znika', async () => {
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, 'pnpm test');

    driver.queue.push({ type: 'result', subtype: 'error_max_turns' });
    await flush();

    expect(manager.get(id)?.state).toBe('interrupted');
    expect(manager.get(id)?.waitingFor).toBeUndefined();
  });

  it('koniec drivera (done) wygasza kolejkę — pola nie ma w ostatniej ramce', async () => {
    const { manager, driver, id } = await build();
    const events = record(manager);
    await blockOnPermission(driver, 'pnpm test');
    expect(lastGlobalSummary(events)?.waitingFor).not.toBeUndefined();

    driver.queue.push({ type: 'exit', ok: true });
    await flush();

    expect(manager.get(id)?.state).toBe('done');
    expect(lastGlobalSummary(events)?.waitingFor).toBeUndefined();
  });

  it('dialog odklikany w terminalu (permission-cleared) zdejmuje pole z kolejnej ramki', async () => {
    const { manager, driver, id } = await build();
    const events = record(manager);
    await blockOnPermission(driver, 'pnpm test');
    expect(lastGlobalSummary(events)?.waitingFor).not.toBeUndefined();

    driver.queue.push({ type: 'permission-cleared', reqId: 'tool-1' });
    await flush();

    expect(lastGlobalSummary(events)?.waitingFor).toBeUndefined();
    expect(manager.get(id)?.waitingFor).toBeUndefined();
  });

  it('przerwanie z telefonu zdejmuje pole razem z kolejką', async () => {
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, 'pnpm test');

    await manager.interrupt(id);
    await flush();

    expect(manager.get(id)?.waitingFor).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Regresja: ramka przy przejściu-tożsamości
  // -------------------------------------------------------------------------

  it('zgoda nad STOJĄCYM dialogiem rozgłasza `session-changed` mimo braku zmiany stanu', async () => {
    /*
     * Sesja herdr jest w `waiting-permission` już od `agent-blocked`, więc
     * `transition('waiting-permission', 'permission-requested')` to TOŻSAMOŚĆ, a
     * `#applyTransition` wychodzi wtedy przed rozgłoszeniem. Bez jawnej ramki pole
     * `waitingFor` powstawałoby w managerze i nie dojeżdżało do listy aż do następnego
     * zdarzenia — czyli ficzer nie działałby na żywym herdr, a testy na samym kształcie
     * summary by tego nie złapały.
     */
    const { manager, driver } = await build();
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();

    const events = record(manager);
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      displayText: 'pnpm test',
    });
    await flush();

    const frames = events.filter(
      (e) => e.scope === 'global' && e.event.type === 'session-changed',
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(lastGlobalSummary(events)?.waitingFor?.text).toBe('pnpm test');
  });

  it('pytanie nad stojącym dialogiem też rozgłasza ramkę', async () => {
    const { manager, driver } = await build();
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();

    const events = record(manager);
    driver.queue.push({
      type: 'question-request', reqId: 'q-1', questions: [question('Który plik?')],
    });
    await flush();

    expect(lastGlobalSummary(events)?.waitingFor).toEqual({
      kind: 'question', text: 'Który plik?',
    });
  });

  it('odpowiedź z telefonu zdejmuje pole z kolejnej ramki, choć stan się nie zmienia', async () => {
    /*
     * Sesja herdr stoi w `waiting-permission` od `agent-blocked`, a `question-resolved`
     * prowadzi WYŁĄCZNIE z `waiting-question` — przejście jest więc TOŻSAMOŚCIĄ i
     * `#applyTransition` wychodzi przed rozgłoszeniem. Bez jawnej ramki karta w sidebarze
     * zostawała z „pytanie: Który plik?" po zdjęciu wpisu z kolejki.
     */
    const { manager, driver, id } = await build();
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    driver.queue.push({
      type: 'question-request', reqId: 'q-1', questions: [question('Który plik?')],
    });
    await flush();

    const events = record(manager);
    const result = await manager.answerQuestion(id, 'q-1', [['Tak']]);
    await flush();

    expect(result.outcome).toBe('ok');
    expect(manager.get(id)?.state).toBe('waiting-permission');
    const frame = lastGlobalSummary(events);
    expect(frame).not.toBeUndefined();
    expect(frame?.waitingFor).toBeUndefined();
  });

  it('rozstrzygnięcie PIERWSZEJ z dwóch zgód pokazuje na karcie DRUGĄ', async () => {
    /*
     * Przy niepustej kolejce przejścia w ogóle nie próbujemy (sesja nadal czeka), więc bez
     * jawnej ramki karta listy mówiłaby o komendzie, o której decyzja już zapadła.
     */
    const { manager, driver, id } = await build();
    await blockOnPermission(driver, 'pnpm test');
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-2',
      toolName: 'Bash',
      input: { command: 'git push' },
      displayText: 'git push',
    });
    await flush();

    const events = record(manager);
    await manager.resolvePermission(id, 'tool-1', 'deny', 'human');
    await flush();

    expect(lastGlobalSummary(events)?.waitingFor?.text).toBe('git push');
  });

  // -------------------------------------------------------------------------
  // Granica władzy: push zostaje przy samej nazwie narzędzia
  // -------------------------------------------------------------------------

  it('baner powiadomienia dalej dostaje SAMĄ nazwę narzędzia, nigdy komendy', async () => {
    /*
     * `waitingFor.text` jedzie uwierzytelnionym kanałem SSE, a push ląduje na ekranie blokady
     * (`docs/security-model.md`, „Push notifications”) — to dwie różne granice i ta zmiana rusza wyłącznie
     * pierwszą. Asercja stoi tutaj, żeby rozjazd było widać przy tej funkcji, a nie dopiero
     * na cudzym telefonie.
     */
    const notes: NoteInput[] = [];
    const notifier: NotifierLike = {
      note: (input) => { notes.push(input); },
      seen: () => undefined,
      forget: () => undefined, quiet: () => undefined,
    };
    const { driver } = await build({ notifier });
    await blockOnPermission(driver, 'git push --force');

    const note = notes.find((n) => n.event.type === 'permission-requested');
    expect(note?.detail?.text).toBe('Bash');
    expect(JSON.stringify(notes)).not.toContain('git push --force');
  });

  // -------------------------------------------------------------------------
  // Pola semantyczne: manager nadaje je ZAWSZE, klient rysuje z nich
  // -------------------------------------------------------------------------

  function pending<T extends ServerEvent['type']>(
    events: { event: ServerEvent }[], type: T,
  ): Extract<ServerEvent, { type: T }> | undefined {
    return events.map((entry) => entry.event)
      .filter((event): event is Extract<ServerEvent, { type: T }> => event.type === type)
      .at(-1);
  }

  it('zgoda niesie `subject` — `tool` dla narzędzia, `plan` dla ExitPlanMode', async () => {
    const tool = await build();
    const toolEvents = record(tool.manager);
    await blockOnPermission(tool.driver, 'pnpm test');
    expect(pending(toolEvents, 'permission-pending')?.request.subject).toBe('tool');
    expect(tool.manager.transcript(tool.id).pendingPermissions[0]?.subject).toBe('tool');

    const plan = await build();
    const planEvents = record(plan.manager);
    await blockOnPermission(plan.driver, '# Plan\n\nKrok 1', 'ExitPlanMode');
    expect(pending(planEvents, 'permission-pending')?.request.subject).toBe('plan');
    expect(lastGlobalSummary(planEvents)?.waitingFor?.subject).toBe('plan');
  });

  it('zgoda z dosłowną komendą powłoki niesie `inputKind: shell`; karta z ekranu i zdegradowana — nie', async () => {
    const shell = await build();
    const shellEvents = record(shell.manager);
    await blockOnPermission(shell.driver, 'pnpm test');
    expect(pending(shellEvents, 'permission-pending')?.request.inputKind).toBe('shell');
    expect(shell.manager.transcript(shell.id).pendingPermissions[0]?.inputKind).toBe('shell');

    // Karta z EKRANU tej samej komendy (tytuł „Bash command” daje nazwę narzędzia): tekst to linie dialogu.
    const screen = screenPermissionCard({
      header: 'Bash command', question: 'pnpm test\nDo you want to proceed?', toolName: 'Bash',
      options: [{ digit: '1', label: 'Yes' }, { digit: '2', label: 'No' }],
      dialogIdentity: { kind: 'tool', identity: { kind: 'title', tool: 'Bash' } },
    }, 1);
    const degraded = degradedCard('toolu_9', null, 'mismatch', 'Bash command\n  pnpm test', 'Bash');
    for (const card of [screen, degraded]) {
      const { manager, driver } = await build();
      const events = record(manager);
      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      driver.queue.push(card.event);
      await flush();
      const request = pending(events, 'permission-pending')?.request;
      expect(request?.toolName).toBe('Bash');
      expect(request).not.toHaveProperty('inputKind');
    }
  });

  it('`customAnswer` = kanał hooka; opcje bez roli dostają `answer`, rola drivera zostaje', async () => {
    const options = [{ label: 'Tak' }, { label: 'Chat about this', role: 'exit' as const }];
    const cases: [DriverEvent & { type: 'question-request' }, boolean][] = [
      [{ type: 'question-request', reqId: 'q-hook', channel: 'hook', questions: [] }, true],
      [{ type: 'question-request', reqId: 'q-keys', channel: 'keys', questions: [] }, false],
      [{ type: 'question-request', reqId: 'q-brak', questions: [] }, false],
    ];
    for (const [event, expected] of cases) {
      const { manager, driver } = await build();
      const events = record(manager);
      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      driver.queue.push({
        ...event,
        questions: [{ question: 'Który?', header: 'Wybór', multiSelect: false, options }],
      });
      await flush();
      const request = pending(events, 'question-pending')?.request;
      expect(request?.customAnswer, event.reqId).toBe(expected);
      expect(request?.questions[0]?.options).toEqual([
        { label: 'Tak', role: 'answer' },
        { label: 'Chat about this', role: 'exit' },
      ]);
    }
  });
});
