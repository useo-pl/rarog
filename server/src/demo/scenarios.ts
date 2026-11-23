/** Sterowane panele scenariuszy demo. Zdarzenia przechodzą przez zwykły pump managera. */
import { randomUUID } from 'node:crypto';
import type { AgentOwnTask, BackgroundTask, WorkflowAgent, WorkflowRun } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import { MAX_DIRTY, demoGitStatus } from '../drivers/mock-driver.ts';
import { AsyncEventQueue } from '../drivers/runtime.ts';
import { APPLIED, STALE } from '../drivers/types.ts';
import type { DecisionOutcome, DriverEvent, SessionDriver } from '../drivers/types.ts';
import { echoKey } from '../herdr/jsonl-follow.ts';
import { demoArtifacts, demoBlocks, demoPullRequests, demoScheduledTasks, demoStandbyNotice } from './seeds.ts';

export type ScenarioName = 'idle' | 'stress500' | 'question' | 'cannot-allow' | 'permission' | 'workflow' | 'standby'
  | 'artifacts' | 'pull-requests' | 'scheduled-tasks' | 'prompt-blocked';
export type ScenarioEmission = 'delta' | 'message' | 'system' | 'clear-question' | 'detach' | 'git-status'
  | 'workflow-agent' | 'workflow-done' | 'workflow-phase' | 'workflow-end' | 'agent-wake' | 'title';

/** Katalog paneli scenariuszy — w tabeli ahead/behind demo (`rarog`: ↓1). */
export const SCENARIO_CWD = '/Users/demo/Projects/rarog';

/**
 * Komenda zgody scenariusza `permission`: zwykła karta z „Zatwierdź” we własnej sesji odbioru. Test UI decyduje o niej
 * zamiast o zgodzie seeda, którą kolejne klasy XCUITest zastają na wspólnym demo bramki (`demo-perm-willow`).
 */
export const SCENARIO_PERMISSION_COMMAND = 'npm test -- --run src/notes.test.ts';

/** Przebieg workflow w tle scenariusza `workflow` (panel „w tle” apki). */
export const SCENARIO_WORKFLOW_TASK_ID = 'm1-workflow';
export const SCENARIO_WORKFLOW_PHASES = ['Implementacja', 'Review', 'Poprawki'] as const;
const WORKFLOW_PREFIX: Record<string, string> = { Implementacja: 'impl', Review: 'review', Poprawki: 'fix' };

/**
 * Scenario `prompt-blocked`: a `UserPromptSubmit` hook blocks every prompt sent from Rarog. The prompt that
 * `create` sends itself (as the app does) and the hook's reason, a synthetic text (`docs/dialogs.md`).
 */
export const SCENARIO_BLOCKED_PROMPT = 'Dopisz testy do modułu notatek i puść je.';
export const SCENARIO_BLOCKED_REASON = 'this session must be restarted before it accepts new prompts. '
  + 'Quit with /exit, start it again with `claude --continue`, and send the prompt once more.';

/** Subagent w postoju scenariusza `standby` (sekcja „w tle” apki: trzy stany subagenta). */
export const SCENARIO_STANDBY_TASK_ID = 'm1-standby';
export const SCENARIO_STANDBY_NAME = 'Przegląd pokrycia testami';

/** Stan scenariusza `standby`: subagent, od kiedy stoi, i jego otwarte własne komendy. */
interface StandbyAgent {
  startedAt: string;
  waitingSince: string;
  /** `false` po `agent-wake`: agent ruszył sam i jedzie w górę bez `waitingSince`. */
  waiting: boolean;
  commands: AgentOwnTask[];
}

/**
 * Rozkład startowy: 12 skończonych agentów implementacji, 44 skończonych i jeden żywy (od 4 min)
 * w Review, Poprawki bez agentów. Review ma 45 agentów: rozwinięta lista jej skończonych przewija panel na
 * iPhonie i iPadzie (test UI kotwicy czytania, gdy rozkład rośnie NAD czytanym wierszem), a żywy agent ma
 * stać na wierzchu fazy, nad 44 skończonymi.
 */
function workflowStart(now: number): WorkflowAgent[] {
  const agents: WorkflowAgent[] = [];
  const add = (phase: string, n: number, done: boolean, startedAt: number): void => {
    const label = `${WORKFLOW_PREFIX[phase] ?? 'agent'}:${String(n).padStart(2, '0')}`;
    agents.push({ id: `m1-wf-${label}`, phase, label, done, startedAt: new Date(startedAt).toISOString() });
  };
  for (let n = 1; n <= 12; n += 1) add('Implementacja', n, true, now - 30 * 60_000 + n * 60_000);
  for (let n = 1; n <= 44; n += 1) add('Review', n, true, now - 20 * 60_000 + n * 20_000);
  add('Review', 45, false, now - 4 * 60_000);
  return agents;
}

export class ScenarioDriver implements SessionDriver {
  readonly ownsProcess = false;
  readonly events = new AsyncEventQueue<DriverEvent>();
  sends = 0;
  decisions = 0;
  answers: string[][][] = [];

  constructor(scenario: ScenarioName, label: string) {
    this.#blocksPrompts = scenario === 'prompt-blocked';
    this.events.push({ type: 'init', engineSessionId: randomUUID(), model: 'claude-fable-5-1' });
    this.events.push({ type: 'title', title: label });
    if (scenario === 'stress500') {
      this.events.push({ type: 'history', messages: Array.from({ length: 500 }, (_, index) => ({
        role: 'assistant',
        at: new Date(Date.UTC(2026, 9, 4, 12, 0, index)).toISOString(),
        blocks: [{ type: 'text', text: foreign(`M1 wiadomość ${String(index + 1).padStart(3, '0')}\n\n`
          + '| Zadanie | Stan |\n| --- | --- |\n| Odbiór M1 | Gotowe |\n\n**Tekst** i `kod`.') }],
      })) });
    }
    if (scenario === 'standby') {
      // Historia przed `idle`, jak w `stress500`: prompt, start subagenta i notka o jego postoju. Notka ma
      // wynik `waiting`, więc apka mówi „Subagent czeka na własne zadanie w tle" i nie liczy jej do
      // „Skończone ostatnio".
      const now = Date.now();
      const at = (agoMs: number): string => new Date(now - agoMs).toISOString();
      const notice = demoStandbyNotice(18 * 60_000, SCENARIO_STANDBY_NAME);
      this.events.push({ type: 'history', messages: [
        { role: 'user', at: at(26 * 60_000),
          blocks: [{ type: 'text', text: foreign('Policz pokrycie testami modułu transkryptu.') }] },
        { role: 'assistant', at: at(25 * 60_000), blocks: [{ type: 'text', text: foreign('Puszczam subagenta w tle.') }] },
        { role: 'user', at: at(notice.agoMs), blocks: demoBlocks(notice.blocks), notice: notice.notice },
        { role: 'assistant', at: at(notice.agoMs - 2000),
          blocks: [{
            type: 'text', text: foreign('Subagent puścił testy w tle i czeka na ich wynik. Wrócę, gdy skończy.'),
          }] },
      ] });
      // Stoi od 18 min i czeka na dwie własne komendy; druga bez treści (serwer bywa, że jej nie zna).
      this.#standby = {
        startedAt: at(25 * 60_000), waitingSince: at(18 * 60_000), waiting: true,
        commands: [
          { id: `${SCENARIO_STANDBY_TASK_ID}-cmd-1`, command: 'pnpm test -- --coverage', startedAt: at(21 * 60_000) },
          { id: `${SCENARIO_STANDBY_TASK_ID}-cmd-2`, startedAt: at(19 * 60_000) },
        ],
      };
    }
    if (scenario === 'artifacts') this.#pushArtifacts();
    if (scenario === 'pull-requests') this.#pushPullRequests();
    if (scenario === 'scheduled-tasks') this.#pushScheduledTasks();
    this.events.push({ type: 'agent-state', state: 'idle', mode: 'auto', seen: true });
    if (scenario === 'standby') this.#pushStandby();
    if (scenario === 'question') {
      this.events.push({ type: 'question-request', reqId: 'm1-question', channel: 'hook', questions: [{
        question: 'Jak odebrać M1?', header: 'Odbiór M1', multiSelect: false,
        options: [
          { label: 'Sprawdź aplikację', description: 'Zwykła odpowiedź' },
          { label: 'Always allow all tools', terminalOnly: true, description: 'Tylko w terminalu' },
        ],
      }] });
    }
    if (scenario === 'cannot-allow') {
      this.events.push({ type: 'permission-request', reqId: 'm1-permission', toolName: 'Bash',
        input: null, displayText: 'M1: nierozpoznana zgoda' });
    }
    if (scenario === 'permission') {
      this.events.push({ type: 'permission-request', reqId: 'm1-permission', toolName: 'Bash',
        input: { command: SCENARIO_PERMISSION_COMMAND }, displayText: SCENARIO_PERMISSION_COMMAND });
    }
    if (scenario === 'workflow') {
      const now = Date.now();
      this.#workflow = { phases: [...SCENARIO_WORKFLOW_PHASES], agents: workflowStart(now) };
      this.#workflowStartedAt = new Date(now - 25 * 60_000).toISOString();
      this.#pushWorkflow();
    }
  }

  #workflow: WorkflowRun | null = null;
  #workflowStartedAt = '';
  /** Scenariusz `prompt-blocked`: hook blokuje każdy prompt (zdarzenie jak z followera po wpisie blokady CLI). */
  readonly #blocksPrompts: boolean;
  #standby: StandbyAgent | null = null;

  /**
   * Scenariusz `artifacts` (sekcja ARTEFAKTY prawego panelu): historia z publikacjami i notką o końcu
   * obserwacji usuniętego szkicu (rodzaj `artifact-watch`: w transkrypcie cicha linia, w „Skończone ostatnio”
   * nic), potem lista dwóch artefaktów zwykłym zdarzeniem drivera `artifacts`. Dane i ich rozpoznanie:
   * `demoArtifacts` w `seeds.ts`.
   */
  #pushArtifacts(): void {
    const now = Date.now();
    const at = (agoMs: number): string => new Date(now - agoMs).toISOString();
    const demo = demoArtifacts(now);
    const hour = 60 * 60_000;
    const say = (role: 'user' | 'assistant', agoMs: number, text: string) => ({
      role, at: at(agoMs), blocks: [{ type: 'text' as const, text: foreign(text) }],
    });
    this.events.push({ type: 'history', messages: [
      say('user', 26 * hour + 60_000, 'Przygotuj szkic prezentacji na claude.ai.'),
      say('assistant', 26 * hour - 5000, 'Szkic prezentacji opublikowany.'),
      say('user', 3 * hour + 60_000, 'Zrób raport tygodniowy, potem go popraw.'),
      say('assistant', 2 * hour - 5000, 'Raport opublikowany i poprawiony.'),
      { role: 'user', at: at(demo.watch.agoMs), blocks: demoBlocks(demo.watch.blocks), notice: demo.watch.notice },
      say('assistant', demo.watch.agoMs - 5000, 'Szkic prezentacji usunięto na claude.ai — już go nie obserwuję.'),
    ] });
    this.events.push({ type: 'artifacts', artifacts: demo.artifacts });
  }

  /**
   * Scenariusz `pull-requests` (sekcja PULL REQUESTY prawego panelu): krótka historia, potem lista trzech PR-ów
   * zwykłym zdarzeniem drivera `pull-requests`. Dane i ich rozpoznanie: `demoPullRequests` w `seeds.ts`.
   */
  #pushPullRequests(): void {
    const now = Date.now();
    const at = (agoMs: number): string => new Date(now - agoMs).toISOString();
    const hour = 60 * 60_000;
    const say = (role: 'user' | 'assistant', agoMs: number, text: string) => ({
      role, at: at(agoMs), blocks: [{ type: 'text' as const, text: foreign(text) }],
    });
    this.events.push({ type: 'history', messages: [
      say('user', 26 * hour + 60_000, 'Opisz eksport w dokumentacji i otwórz PR.'),
      say('assistant', 26 * hour - 5000, 'PR z dokumentacją otwarty.'),
      say('user', 2 * hour + 60_000, 'Dodaj eksport notatek do CSV i otwórz PR.'),
      say('assistant', 2 * hour - 5000, 'PR z eksportem otwarty.'),
    ] });
    this.events.push({ type: 'pull-requests', pullRequests: demoPullRequests(now) });
  }

  /**
   * Scenario `scheduled-tasks` (the inspector's scheduled tasks section): a short history, then a one-shot and a
   * recurring task as a plain driver event `scheduled-tasks`. Data and recognition: `demoScheduledTasks` in `seeds.ts`.
   */
  #pushScheduledTasks(): void {
    const now = Date.now();
    const say = (role: 'user' | 'assistant', agoMs: number, text: string) => ({
      role, at: new Date(now - agoMs).toISOString(), blocks: [{ type: 'text' as const, text: foreign(text) }],
    });
    this.events.push({ type: 'history', messages: [
      say('user', 121 * 60_000, 'Run the flaky export tests every 30 minutes.'),
      say('assistant', 120 * 60_000, 'Scheduled every 30 minutes.'),
      say('user', 21 * 60_000, 'Check the nightly import in 40 minutes.'),
      say('assistant', 20 * 60_000, 'Scheduled once, in 40 minutes.'),
    ] });
    this.events.push({ type: 'scheduled-tasks', scheduledTasks: demoScheduledTasks(now) });
  }

  /** Lista zadań scenariusza `standby`: jeden subagent, w postoju albo (po `agent-wake`) pracujący. */
  #pushStandby(): void {
    const agent = this.#standby;
    if (agent === null) return;
    this.events.push({ type: 'background-tasks', tasks: [{
      id: SCENARIO_STANDBY_TASK_ID, kind: 'agent', description: SCENARIO_STANDBY_NAME, agentType: 'general-purpose',
      model: 'claude-opus-5-5', startedAt: agent.startedAt,
      ...(agent.waiting ? { waitingSince: agent.waitingSince } : {}),
      ...(agent.commands.length > 0 ? { ownTasks: agent.commands.map((command) => ({ ...command })) } : {}),
    }] });
  }

  /**
   * `agent-wake`: pierwsza własna komenda agenta się skończyła, więc agent ruszył sam. Jedzie w górę bez
   * `waitingSince` i bez tej komendy, jak po odczycie pliku subagenta na produkcji (`merge.ts`). `false` =
   * scenariusz bez subagenta w postoju.
   */
  #wakeAgent(): boolean {
    const agent = this.#standby;
    if (agent === null) return false;
    agent.waiting = false;
    agent.commands = agent.commands.slice(1);
    this.#pushStandby();
    return true;
  }

  /** Każda ramka niesie NOWE obiekty: manager trzyma referencję listy zadań w podsumowaniu sesji. */
  #pushWorkflow(): void {
    const run = this.#workflow;
    const tasks: BackgroundTask[] = run === null ? [] : [{
      id: SCENARIO_WORKFLOW_TASK_ID, kind: 'workflow', description: 'przegląd M1', startedAt: this.#workflowStartedAt,
      runId: 'wf_m1', run: { phases: [...run.phases], agents: run.agents.map((agent) => ({ ...agent })) },
    }];
    this.events.push({ type: 'background-tasks', tasks });
  }

  /** Faza, w której ktoś teraz pracuje (ostatni żywy agent), inaczej ostatnia ruszona. */
  #livePhase(run: WorkflowRun): string {
    const live = run.agents.filter((agent) => !agent.done).at(-1)?.phase;
    return live ?? run.agents.at(-1)?.phase ?? run.phases[0] ?? 'Review';
  }

  /**
   * Etykieta jak tag fazy workflow (`przedrostek:NN` w fazie), tożsamość unikalna w CAŁYM przebiegu: wiersze
   * panelu apki są nią kluczowane, a dwie fazy spoza planu mogą dać ten sam przedrostek.
   */
  #startAgent(run: WorkflowRun, phase: string): void {
    const n = run.agents.filter((agent) => agent.phase === phase).length + 1;
    const prefix = WORKFLOW_PREFIX[phase] ?? (phase.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || 'agent');
    const label = `${prefix}:${String(n).padStart(2, '0')}`;
    let id = `m1-wf-${label}`;
    for (let k = 2; run.agents.some((agent) => agent.id === id); k += 1) id = `m1-wf-${label}-${String(k)}`;
    run.agents.push({ id, phase, label, done: false, startedAt: new Date().toISOString() });
  }

  /**
   * Kolejny rozkład przebiegu: `workflow-agent` dopisuje żywego agenta na końcu fazy (`text` = tytuł,
   * domyślnie faza żywego agenta), `workflow-done` kończy żywych, `workflow-phase` kończy żywych
   * i startuje agenta w fazie z `text` (domyślnie pierwsza faza planu bez agentów), `workflow-end`
   * zamyka zadanie. `false` = scenariusz bez przebiegu.
   */
  #emitWorkflow(event: ScenarioEmission, text: string | undefined): boolean {
    const run = this.#workflow;
    if (run === null) return false;
    if (event === 'workflow-end') {
      this.#workflow = null;
      this.#pushWorkflow();
      return true;
    }
    if (event === 'workflow-done' || event === 'workflow-phase') {
      for (const agent of run.agents) agent.done = true;
    }
    if (event === 'workflow-agent') this.#startAgent(run, text ?? this.#livePhase(run));
    if (event === 'workflow-phase') {
      const next = text ?? run.phases.find((phase) => !run.agents.some((agent) => agent.phase === phase));
      if (next !== undefined) this.#startAgent(run, next);
    }
    this.#pushWorkflow();
    return true;
  }

  /**
   * Wysyłka z Raroga. W scenariuszu `prompt-blocked` hook ją blokuje: zdarzenie `prompt-blocked` z kluczem echa tego
   * tekstu i rozstrzygnięciem wysyłki (`echoed`, `decided` — tak jak driver herdr po trafieniu w echo), potem herdr
   * pokazuje panel bezczynny. Manager dopisuje notkę i przycisk z własnego pierścienia wysyłek, jak na produkcji.
   */
  send(text = ''): void {
    this.sends += 1;
    if (this.#blocksPrompts) {
      this.events.push({
        type: 'prompt-blocked', reason: SCENARIO_BLOCKED_REASON, promptKept: false, echoed: true, decided: true,
        key: echoKey(text),
      });
    }
    this.events.push({ type: 'agent-state', state: 'idle', mode: 'auto', seen: true });
  }

  respondPermission(reqId: string): Promise<DecisionOutcome> {
    if (reqId !== 'm1-permission') return Promise.resolve(STALE);
    this.decisions += 1;
    return Promise.resolve(APPLIED);
  }

  answerQuestion(reqId: string, answers: string[][]): Promise<DecisionOutcome> {
    if (reqId !== 'm1-question') return Promise.resolve(STALE);
    this.answers.push(answers.map((row) => [...row]));
    return Promise.resolve(APPLIED);
  }

  interrupt(): Promise<boolean> { return Promise.resolve(true); }
  dispose(): void { this.events.close(); }

  /** `false` = zdarzenie nie pasuje do scenariusza (przebieg workflow tylko w `workflow`, `agent-wake` w `standby`). */
  emit(event: ScenarioEmission, text?: string): boolean {
    if (event.startsWith('workflow-')) return this.#emitWorkflow(event, text);
    if (event === 'agent-wake') return this.#wakeAgent();
    this.#emitStream(event, text ?? 'M1 strumień');
    return true;
  }

  #emitStream(event: ScenarioEmission, text: string): void {
    if (event === 'delta') {
      this.events.push({ type: 'agent-state', state: 'working', mode: 'auto' });
      this.events.push({ type: 'delta', text });
    }
    if (event === 'message' || event === 'system') {
      // Notka `system` udaje notkę Raroga, wiadomość — wypowiedź agenta; obie niosą tekst podany przez test,
      // czyli treść demo (`foreign`).
      this.events.push({ type: 'message', role: event === 'system' ? 'system' : 'assistant',
        blocks: [{ type: 'text', text: foreign(text) }] });
      if (event === 'message') this.events.push({ type: 'agent-state', state: 'idle', mode: 'auto', seen: true });
    }
    if (event === 'clear-question') {
      this.events.push({ type: 'permission-cleared' });
      this.events.push({ type: 'agent-state', state: 'idle', mode: 'auto', seen: true });
    }
    if (event === 'detach') this.events.push({ type: 'detached' });
    // Pełny `git-status` demo (trzy pliki z `demoDiff`, rodzaje i liczniki) — wiersz gita i lista
    // zmian w katalogu bez prawdziwego repo; „Pokaż diff" oddaje ten sam `demoDiff`.
    if (event === 'git-status') this.events.push(demoGitStatus(SCENARIO_CWD, MAX_DIRTY));
    // The name Claude Code writes to its transcript after `/rename`: the card label the app waits for.
    if (event === 'title') this.events.push({ type: 'title', title: text, source: 'custom-title' });
  }
}

export interface ScenarioPanels {
  create(scenario: ScenarioName, label: string, cwd?: string): { sessionId: string; driver: ScenarioDriver };
}
