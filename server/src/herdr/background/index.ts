/**
 * Zadania w tle sesji Claude Code (komendy, subagenci, workflow, monitory) — JEDNO miejsce.
 * Także lista artefaktów sesji (`artifacts.ts`): ten sam nośnik meldunku i rejestr.
 *
 * Wszystko, co Rarog wie o `backgroundTasks`, ma mieszkać w tym katalogu: skąd wpis się bierze,
 * kiedy znika, jak dostaje rozkład przebiegu i co z tego liczy się jako praca. Opis całości
 * (źródła, cykl życia, diagnostyka, znane luki): `docs/background-tasks.md`. Wzór układu:
 * `server/src/herdr/dialogs/` i `docs/dialogs.md`.
 *
 * ── Mapa modułów (strażnik: `server/test/herdr-background-boundary.test.ts`)
 *
 * - `index.ts`   — ta mapa i publiczne API katalogu.
 * - `cli-shapes.ts` — rejestr kształtów CLI: każdy literał, po którym poznajemy zadanie w tle
 *                  albo meldunek o nim, z wersją CLI i datą pomiaru. Jedyne miejsce tych słów.
 * - `notification.ts` — CZYSTY, JEDYNY parser tekstu meldunku `<task-notification>` (id, status,
 *                  streszczenie, nazwa z cudzysłowu, kod wyjścia, dopisek o postoju agenta)
 *                  i odcisk meldunku, po którym reduktor poznaje kopie.
 * - `reducer.ts` — CZYSTA maszyna stanów: wpis transkryptu → lista otwartych zadań (start,
 *                  postój i wznowienie subagenta, koniec, kopie meldunków). Bez I/O, zegara i logów.
 *                  Czyta plik główny, a z opcją `sidechain` plik subagenta (jego własne komendy).
 *                  Ma regułę restartu procesu CLI: chwilę startu dostaje z zewnątrz.
 * - `notice.ts`  — CZYSTE: meldunek o końcu zadania → notka transkryptu (`TranscriptMessage.notice`).
 * - `artifacts.ts` — CZYSTE: artefakty sesji. Wynik publikacji narzędziem `Artifact` i meldunek
 *                  o usunięciu (notka harnessu, ten sam parser co meldunek zadania) → lista adresów
 *                  z tytułem i czasem. Nie zadanie w tle: stoi tu, bo meldunek jedzie tym samym
 *                  nośnikiem, a jego słowa trzyma ten sam rejestr. Opis: `docs/artifacts.md`.
 * - `pull-requests.ts` — CZYSTE: pull requesty sesji. Wywołanie `Bash` z poleceniem `gh pr create`
 *                  i linia wyniku z adresem PR → lista adresów z repo, numerem, czasem i tytułem. Nie
 *                  zadanie w tle: stoi tu obok artefaktów, bo czyta te same pliki rozmowy i jedzie tą samą
 *                  drogą do apki. Opis: `docs/pull-requests.md`.
 * - `scheduled-tasks.ts` — PURE: the session's scheduled tasks (crons). `CronCreate`, `CronDelete` and `CronList`
 *                  results, the run line and the carry attachment → the list of armed tasks; also the prefilter for
 *                  raw lines. Not a background task: it lives here because the registry holds its CLI words.
 * - `pull-request-files.ts` — czytnik plików rozmowy pod kątem PR-ów: plik główny, pliki
 *                  subagentów i agentów workflow, wszystkie, przyrostowo, z prefiltrem i budżetem bajtów.
 * - `scheduled-task-file.ts` — the reader of the main conversation file for the scheduled tasks:
 *                  incrementally, with the tracker's prefilter, the list rebuilt from zero on truncation.
 * - `incremental-read.ts` — one incremental read of one conversation file: offset, chunks, byte
 *                  budget, read from the start on truncation or another inode, read errors reported. Used by
 *                  `pull-request-files.ts` and `scheduled-task-file.ts`.
 * - `queued-prompt.ts` — CZYSTE: prompt człowieka wchłonięty w trwającą turę. Nie zadanie w tle;
 *                  stoi tu, bo jedzie tym samym załącznikiem kolejki co meldunek, a słowa tego
 *                  nośnika trzyma rejestr. Parser transkryptu robi z niego wiadomość `user`.
 * - `ids.ts`     — CZYSTE strażniki kształtu identyfikatorów (`wf_<id>`, id agenta) przed
 *                  złożeniem ścieżki na dysku.
 * - `satellite.ts` — katalog sesji obok transkryptu: szukanie adresu i relokacja. Korzysta
 *                  z niego także puls tury.
 * - `workflow-run.ts` — czytnik rozkładu przebiegu workflow: fazy ze skryptu, agenci
 *                  z journala.
 * - `agent-file.ts` — czytnik pliku rozmowy subagenta: przyrostowo, porcjami, oddaje czas
 *                  ostatniego wpisu i otwarte własne komendy agenta.
 * - `main-scan.ts` — przegląd pliku GŁÓWNEGO sprzed okna ogona: przy podpięciu followera
 *                  podaje reduktorowi linie o zadaniach z części pliku, której okno nie objęło,
 *                  a drugim ujściem liście artefaktów (ta po skróceniu pliku i przeskoku też).
 *                  Strumieniowo, z prefiltrem przed `JSON.parse`. Dysk czytają tylko ten moduł,
 *                  `agent-file.ts`, `workflow-run.ts`, `pull-request-files.ts`, `incremental-read.ts`,
 *                  `scheduled-task-file.ts` i `satellite.ts`.
 * - `jsonl-lines.ts` — CZYSTE: porcje bajtów pliku jsonl → kompletne linie (bufor niedokończonej
 *                  linii, sufit długości). Wspólne dla `agent-file.ts`, `main-scan.ts` i `incremental-read.ts`.
 * - `merge.ts`   — sklejanie listy followera z rozkładami przebiegów i faktami z plików
 *                  subagentów (wybudzenie agenta w postoju, jego `ownTasks`) oraz zegar odczytów;
 *                  funkcje nad jawnym stanem (`TasksState`), który trzyma fasada drivera.
 * - `work.ts`    — CZYSTE, JEDNO miejsce reguł „co jest pracą": push „gotowe", restart sesji,
 *                  licznik i zegar ciszy kafla Live Activity. Tu stoi też jedyna definicja
 *                  subagenta w postoju, który pracą nie jest. Wywołujący tylko pytają.
 *
 * ── Jak importować
 *
 * Moduły z własnym cyklem życia (fasada drivera, follower, puls tury) biorą API stąd. Moduły
 * czyste wolno importować wprost z pliku, i tak robią ci, którzy sami są czyści albo stoją nisko
 * w grafie importów: `transcript-import.ts` bierze `notice.ts` i `queued-prompt.ts`, dane demo
 * `notice.ts`, a manager i kafel Live Activity `work.ts`. Przez `index.ts` parser historii ciągnąłby czytnik przebiegów i zamknął cykl
 * `transcript-import → … → transcript-path → transcript-import`.
 *
 * ── Kierunek zależności
 *
 * Katalog nie zna fasady drivera (`drivers/herdr-driver.ts`), managera (`sessions/manager.ts`)
 * ani nadzorcy (`herdr/supervisor.ts`) — to one wołają katalog, nigdy odwrotnie.
 */
export { createBackgroundTasksTracker } from './reducer.ts';
export type { BackgroundTasksTracker } from './reducer.ts';
export { isTaskNotificationOrigin, noticeFromText } from './notice.ts';
export { isRunId } from './ids.ts';
export { locateSatelliteDir } from './satellite.ts';
export { createWorkflowRunReader, phaseCounts } from './workflow-run.ts';
export type { WorkflowRunReader } from './workflow-run.ts';
export { createAgentFileReader } from './agent-file.ts';
export type { AgentFileReader } from './agent-file.ts';
export { scanMainFileBefore } from './main-scan.ts';
export type { MainScanOptions, MainScanResult } from './main-scan.ts';
export { artifactsSignature, createArtifactsTracker } from './artifacts.ts';
export type { ArtifactFact, ArtifactsTracker } from './artifacts.ts';
export { pullRequestsSignature } from './pull-requests.ts';
export { createScheduledTasksTracker } from './scheduled-tasks.ts';
export type { ScheduledTasksTracker } from './scheduled-tasks.ts';
export {
  PULL_REQUESTS_BACKLOG_MS, PULL_REQUESTS_POLL_MS, createPullRequestFilesReader,
} from './pull-request-files.ts';
export type { PullRequestFilesReader, PullRequestFilesReaderOptions } from './pull-request-files.ts';
export {
  SCHEDULED_TASKS_BACKLOG_MS, SCHEDULED_TASKS_POLL_MS, createScheduledTaskFileReader,
} from './scheduled-task-file.ts';
export type {
  ScheduledTaskFileReader, ScheduledTaskFileReaderOptions, ScheduledTasksRead,
} from './scheduled-task-file.ts';
export {
  TASKS_POLL_MS, createTasksState, forgetSession, noteTasks, runName, stopTasks,
} from './merge.ts';
export type { TasksDeps, TasksState } from './merge.ts';
export {
  hasBackgroundWork, hasOpenWorkflow, onlyWaitingAgents, tasksBlockRestart, tasksHoldingDonePush,
  workflowsWithRun,
} from './work.ts';
