/**
 * Co jest PRACĄ w tle — jedno miejsce reguł.
 *
 * Manager (push „gotowe", restart sesji), ponowna kontrola pusha przed wysyłką i kafel Live
 * Activity pytają listę `backgroundTasks`, czy coś jeszcze pracuje, i każde pyta o co innego. Reguły RÓŻNIĄ
 * się między sobą i tak ma zostać: tu różnica ma nazwę, a zmiana którejkolwiek jest zmianą w tym
 * pliku. Wywołujący tylko pytają.
 *
 * - push „gotowe" po końcu tury → `tasksHoldingDonePush`: każde zadanie poza czekającym subagentem
 *   i monitorem (liczba; pyta o nią uzbrojenie pusha i ponowna kontrola tuż przed wysyłką);
 * - zaległe „gotowe" po turze bez wyniku → `waitingOnOwnCommand`: subagent w postoju z żywą
 *   własną komendą (pyta o nią uzbrojenie i ponowna kontrola);
 * - zaległe „gotowe" przy ciszy bez tury  → `holdsOwedDone`: jedno z dwóch wyżej (manager porównuje
 *   listę przed i po zmianie i przy spadku woła `NotifierLike.quiet`);
 * - restart sesji na nowym CLI   → `tasksBlockRestart`:    każde zadanie poza monitorem, także czekające;
 * - zdanie odmowy restartu       → `onlyWaitingAgents`:    na liście stoją sami czekający subagenci;
 * - licznik „pracuje" kafla      → `hasBackgroundWork`:    zadanie „żywe" (`liveTask`);
 * - zegar ciszy kafla (`isBusy`) → `hasOpenWorkflow`:      tylko otwarty przebieg workflow;
 * - lista przebiegów na kaflu    → `workflowsWithRun`:     workflow z odczytanym rozkładem.
 *
 * CZEKAJĄCY SUBAGENT NIE JEST PRACĄ. Subagent z `waitingSince` skończył turę
 * i stoi, bo czeka na własną komendę w tle; bywa tak godzinami. Jedna definicja „czeka" stoi
 * w {@link waitingAgent} i z niej korzystają wszystkie reguły niżej. Restart jest wyjątkiem
 * świadomym: zabija proces CLI, więc także agenta w postoju i jego komendy.
 *
 * MONITOR NIE JEST PRACĄ. Monitor nie wykonuje pracy, tylko patrzy, a trwały nie ma terminu.
 * Nie wstrzymuje pusha „gotowe", nie liczy się do „pracuje" kafla
 * i nie blokuje restartu: restart traci najwyżej jego przyszłe zdarzenia, a agent może go uzbroić od
 * nowa. Blokada odbierałaby za to restart z apki, także po `cliUpdate`. Na liście zostaje i apka
 * go pokazuje. Definicja stoi w {@link watcher}; reguła dotyczy też monitorów ze starszych plików.
 *
 * Moduł jest CZYSTY. Apka ma własne lustro tych reguł w jednym pliku rdzenia
 * (`RarogCore/BackgroundTaskRules.swift`, te same nazwy funkcji) — opis obu stron:
 * `docs/background-tasks.md`.
 */
import type { BackgroundTask, WorkflowRun } from '@rarog/shared';

/** Lista z sesji: brak pola znaczy „nic nie leci", dokładnie jak pusta lista. */
type Tasks = readonly BackgroundTask[] | undefined;

/**
 * Subagent w POSTOJU: rodzaj `agent` z polem `waitingSince`. Skończył turę i czeka na własne
 * zadanie w tle — nie pracuje i nie skończył.
 *
 * Lista, którą dostają wywołujący, jest już po nakładkach z pliku subagenta (`merge.ts`): agent,
 * który sam ruszył, nie ma tu `waitingSince`. Pole przy zadaniu innego rodzaju nic nie znaczy
 * (kontrakt nadaje je tylko agentom) i takiego zadania czekającym nie robi.
 */
function waitingAgent(task: BackgroundTask): boolean {
  return task.kind === 'agent' && task.waitingSince !== undefined;
}

/** Monitor: zadanie, które patrzy, a nie pracuje. Rodzaj wystarcza, bez względu na kształt startu. */
function watcher(task: BackgroundTask): boolean {
  return task.kind === 'monitor';
}

/**
 * Push „gotowe": ile zadań wstrzymuje powiadomienie o końcu tury.
 *
 * Liczy każde zadanie z listy POZA czekającym subagentem ({@link waitingAgent}) i monitorem
 * ({@link watcher}), bez pytania o rozkład. Liczba większa od zera ucisza klasę „gotowe": `Stop` znaczy „główny agent skończył
 * odpowiadać", a nie „sesja skończyła pracę". Pytają o nią dwa miejsca i oba dostają to samo:
 * uzbrojenie (`doneOrSilence` w `notify/policy.ts`, przy końcu tury) i ponowna kontrola przed
 * wysyłką (`decide` tamże) — subagent, który ruszył między jednym a drugim, kasuje uzbrojony push.
 *
 * Subagent w postoju nie wstrzymuje: czeka na komendę, która potrafi nie skończyć się nigdy,
 * a wtedy sesja nie odezwałaby się wcale. Monitor tym bardziej: trwały stoi do końca procesu CLI.
 */
export function tasksHoldingDonePush(tasks: Tasks): number {
  return (tasks ?? []).reduce((count, task) => (waitingAgent(task) || watcher(task) ? count : count + 1), 0);
}

/**
 * Zaległe „gotowe" po turze bez wyniku (sam postój albo sam meldunek o artefakcie, `noResultTurn`
 * w `notify/policy.ts`): czy na liście stoi subagent w postoju
 * ({@link waitingAgent}), który ma żywą WŁASNĄ komendę (`ownTasks` niepuste).
 *
 * Taki agent nie skończył: czeka na swoją komendę (review, testy) i wstaje, gdy ta się skończy.
 * Meldunek o jego postoju budzi głównego agenta, a tura, która z tego wychodzi, wypuściłaby
 * zaległe „gotowe" o etapie, który dalej trwa. Pytają
 * dwa miejsca: uzbrojenie (`doneOrSilence` w `notify/policy.ts`, przy końcu tury) i ponowna
 * kontrola przed wysyłką (`decide` tamże), bo komenda trafia do `ownTasks` dopiero po odczycie
 * pliku subagenta (co 5 s).
 *
 * Dla pozostałych reguł subagent w postoju dalej nie jest pracą ({@link tasksHoldingDonePush}):
 * ta funkcja wstrzymuje tylko zaległe „gotowe" po turze bez wyniku. Monitor, zagnieżdżony
 * subagent i komenda o losie nieznanym (start sprzed okna pliku głównego albo bez czasu) do
 * `ownTasks` nie trafiają (`ownTasksOf` w `merge.ts`), więc agent, który czeka tylko na nie,
 * niczego tu nie wstrzymuje.
 */
export function waitingOnOwnCommand(tasks: Tasks): boolean {
  return (tasks ?? []).some((task) => waitingAgent(task) && (task.ownTasks?.length ?? 0) > 0);
}

/**
 * Zaległe „gotowe": czy lista je WSTRZYMUJE — coś pracuje ({@link tasksHoldingDonePush}) albo
 * subagent w postoju czeka na własną komendę ({@link waitingOnOwnCommand}).
 *
 * Pyta manager przy każdej nowej liście zadań, przed jej podmianą i po niej: przejście z „wstrzymuje"
 * do „nie wstrzymuje" to cisza w tle bez końca tury, a harmonogram uzbraja wtedy zaległe „gotowe"
 * (`Notifier.quiet` w `notify/index.ts`). Bez tego wynik czekał do następnego końca tury, którego
 * po uśpieniu subagenta potrafiło nie być wcale. Kontrola przed wysyłką pyta o te same
 * dwie rzeczy osobno (`sessionLook`).
 */
export function holdsOwedDone(tasks: Tasks): boolean {
  return tasksHoldingDonePush(tasks) > 0 || waitingOnOwnCommand(tasks);
}

/**
 * Restart sesji na nowym Claude Code: czy lista go blokuje.
 *
 * Każde zadanie na liście poza monitorem ({@link watcher}) blokuje, TAKŻE subagent w postoju
 * (ostrożność Raroga). Zmierzone na CLI
 * 2.1.296 (fixture `tasks/measured/resume-cli-2.1.296.jsonl`): po `/exit` z „Exit and stop tasks”
 * i `claude --resume` komenda subagenta kończy się meldunkiem `killed`, a subagent nie wraca. Docs
 * agent-view („The supervisor process”) mówią, że pod supervisorem komendy i subagenci w tle
 * przechodzą do następnego procesu; restartu panelu herdr bez „stop tasks” nie mierzyliśmy.
 */
export function tasksBlockRestart(tasks: Tasks): boolean {
  return (tasks ?? []).some((task) => !watcher(task));
}

/**
 * Restart sesji: na liście stoją SAMI czekający subagenci (i jest co najmniej jeden).
 *
 * Tylko do wyboru zdania odmowy: „W tle działa zadanie" byłoby wtedy nieprawdą, bo nic nie
 * działa — subagent stoi i czeka. Blokady nie zmienia ({@link tasksBlockRestart}).
 */
export function onlyWaitingAgents(tasks: Tasks): boolean {
  const list = tasks ?? [];
  return list.length > 0 && list.every(waitingAgent);
}

/**
 * Zadanie w tle, które jeszcze MIELI — dla licznika „pracuje" (lustro „pracuje w tle" listy).
 *
 * Zadanie spoza workflow (komenda, subagent) mieli, dopóki stoi na liście — z dwoma wyjątkami:
 * subagent w postoju ({@link waitingAgent}) nie mieli, tylko czeka, a monitor ({@link watcher})
 * tylko patrzy. Przebieg workflow
 * z rozkładem, w którym wszyscy agenci skończyli, też już nie (ta sama reguła co
 * w {@link hasOpenWorkflow}): zadanie bez wpisu zamknięcia w jsonl (zabite CLI) wisiałoby jako
 * „pracuje".
 */
function liveTask(task: BackgroundTask): boolean {
  if (waitingAgent(task) || watcher(task)) return false;
  return task.kind !== 'workflow' || openWorkflow(task);
}

/** Otwarte zadanie workflow: bez rozkładu („nie wiem"), bez agentów (start) albo z agentem w locie. */
function openWorkflow(task: BackgroundTask): boolean {
  if (task.kind !== 'workflow') return false;
  const run = task.run;
  return run === undefined || run.agents.length === 0 || run.agents.some((agent) => !agent.done);
}

/**
 * Kafel Live Activity, licznik „pracuje": na liście jest zadanie, które jeszcze mieli
 * ({@link liveTask}). Sesja po turze, której wszystkie zadania to czekający subagenci, do
 * „pracuje" się nie liczy; z nieodebranym wynikiem liczy się do „skończyły".
 */
export function hasBackgroundWork(tasks: Tasks): boolean {
  return (tasks ?? []).some(liveTask);
}

/**
 * Kafel Live Activity, zegar ciszy: na liście jest OTWARTY przebieg workflow ({@link openWorkflow}).
 *
 * Ostrzej niż {@link hasBackgroundWork}, i celowo: serwer deweloperski albo monitor puszczony
 * w tle mieli bez końca, a kafel ma zejść po ciszy bez decyzji, tury i workflow.
 */
export function hasOpenWorkflow(tasks: Tasks): boolean {
  return (tasks ?? []).some(openWorkflow);
}

/**
 * Kafel Live Activity, lista przebiegów: zadania workflow z ODCZYTANYM rozkładem, w kolejności
 * listy. Przebieg bez rozkładu nie ma czego pokazać (liczy się tylko do zegara ciszy), a przebieg,
 * którego wszyscy agenci skończyli, stoi na kaflu, dopóki zadanie jest na liście.
 */
export function workflowsWithRun(tasks: Tasks): { task: BackgroundTask; run: WorkflowRun }[] {
  return (tasks ?? []).flatMap((task) =>
    (task.kind === 'workflow' && task.run !== undefined ? [{ task, run: task.run }] : []));
}
