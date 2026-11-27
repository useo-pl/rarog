import Foundation
import RarogContract

// Co jest PRACĄ w tle — jedno miejsce reguł apki. Lustro `server/src/herdr/background/work.ts`.
//
// Rdzeń i widoki pytają listę `SessionSummary.backgroundTasks`, czy coś jeszcze pracuje, i każde miejsce
// pyta o co innego: lista (`Selectors.swift`, pustość listy), kafel
// Live Activity (`Selectors+LiveActivity.swift`, `hasLiveBackgroundWork` i `openWorkflow`) i modele
// `RarogUI` (pustość listy przy słowie stanu, linii etapu i pigułce). Reguły RÓŻNIĄ się między sobą i tak
// ma zostać: tu różnica ma nazwę, a zmiana którejkolwiek jest zmianą w tym pliku. Wywołujący tylko pytają.
//
// O LIŚCIE:
// - ranga, ton i znak pracy   → `tasksKeepRowWorking`: każde zadanie poza czekającym subagentem
//                                     i monitorem;
// - licznik „pracuje" kafla         → `hasBackgroundWork`:   zadanie „żywe" (`liveTask`);
// - zegar ciszy kafla (`isBusy`)    → `hasOpenWorkflow`:     tylko otwarty przebieg workflow;
// - linia workflow wiersza listy    → `openWorkflows`:       te same otwarte przebiegi, wypisane;
// - pigułka i sekcja „w tle"        → `hasTasks`:            cokolwiek na liście, także czekające i monitor;
// - zdanie linii etapu              → `onlyWaitingAgents`:   na liście stoją sami czekający subagenci;
// - Live Activity counter "waiting" → `stuckWait`:           a session after a turn with a wait at `stuck`;
// - row tone `.waiting`, rank 0, word → `stuckWait`:          the same session (`Selectors.swift`, `RowStatus`);
// - wait stage of the session       → `strongestOwnCommandWait`: the strongest stage on the list;
// - row tone `.backgroundWaitLong`  → `strongestOwnCommandWait` at `long` (`Selectors.swift`, `statusTone`);
// - warning mark of the background pill → `strongestOwnCommandWait` (`BackgroundBadge` in `RarogUI`).
//
// O JEDNYM ZADANIU:
// - wiersz zadania w sekcji „w tle" → `waitingAgent`: subagent w postoju;
// - opis subagenta w linii etapu    → `workingAgent`: subagent, który pracuje;
// - wait stage of one subagent      → `ownCommandWait(of:in:)`: the server's stage, none for a phantom agent
//                                     (the warning line of its row and the pill's sentence);
// - key of one wait                 → `waitKey`: the agent and its `waitingSince`.
//
// WAITING ON ITS OWN COMMAND. The stage of a subagent's wait (`short`, `long`, `stuck`) comes from the server in
// `BackgroundTask.ownCommandWait`; the app has no thresholds and never reads `ownTasks` to decide anything. A session
// that ended (`done`) or waits for a resume (`resumable`) has a phantom agent: no rule sees its wait.
//
// CZEKAJĄCY SUBAGENT NIE JEST PRACĄ. Subagent z `waitingSince` skończył turę
// i stoi, bo czeka na własną komendę w tle; bywa tak godzinami. Jedna definicja „czeka" stoi
// w `waitingAgent` i korzystają z niej reguły wiersza i licznika. Zegara ciszy nie dotyczy: ten
// liczy wyłącznie przebiegi workflow. Na liście zostaje i widać go w sekcji „w tle" (`hasTasks`), ale
// bez znaku pracy.
//
// MONITOR NIE JEST PRACĄ. Monitor nie wykonuje pracy, tylko patrzy, a trwały nie ma terminu.
// Nie trzyma wiersza przy pracy i nie liczy się do „pracuje" kafla; pigułka i sekcja
// „w tle" dalej go pokazują. Definicja stoi w `watcher`; reguła dotyczy też monitorów ze starszych plików.
//
// Nazwy są te same co w `work.ts` wszędzie tam, gdzie reguła jest ta sama; odpowiednik stoi przy każdej
// funkcji. Trzech reguł serwera apka nie liczy, bo nie ma kto o nie pytać: `tasksHoldingDonePush` (push
// „gotowe" wysyła serwer), `tasksBlockRestart` (restartu odmawia serwer; monitor go nie blokuje, więc
// kształtem nie jest to już `hasTasks`) oraz `workflowsWithRun` (listę przebiegów na kaflu dosyła serwer;
// apka składa tylko liczniki stanu startowego).
//
// Strażnik źródeł (`BackgroundTaskRulesGuardTests`): poza tym plikiem żaden plik `RarogCore/Sources` ani
// `RarogUI/Sources` nie rozstrzyga sam, czy lista albo zadanie jest pracą. Opis obu stron, serwera
// i apki: `docs/background-tasks.md`.
//
// NAZWA. To nie jest protokół `BackgroundWork` z `PushSystem.swift`. Tamten to praca APKI w tle
// systemu (`beginBackgroundTask`); ten plik mówi o zadaniach w tle SESJI Claude Code.

/// Reguły „czy lista zadań w tle sesji jest pracą". Czyste funkcje nad listą z kontraktu.
///
/// Każda bierze listę tak, jak stoi w `SessionSummary.backgroundTasks`: brak pola (`nil`) znaczy
/// „nic nie leci", dokładnie jak pusta lista.
public enum BackgroundTaskRules {
  /// Lista sesji: czy zadania w tle trzymają wiersz przy pracy.
  ///
  /// Kto pyta w rdzeniu: `SessionSummary.listRank` (sesja z odebranym wynikiem i sesja `done` dostają rangę
  /// pracy) i `SessionSummary.statusTone` (ton „nieodebrane" i „cisza" zmienia się w ton pracy). Kto pyta
  /// w `RarogUI` o ZNAK PRACY, czyli zieloną kropkę: słowo stanu „pracuje w tle" (`RowStatus`), linia etapu
  /// wiersza (`SessionRowModel.stageLine`) i plakietka „N w tle" (`BackgroundBadge`). Jedna reguła dla
  /// tonu, rangi i kropki, więc wiersz nie pokaże kropki pracy przy spokojnym tonie.
  ///
  /// Liczy każde zadanie z listy POZA czekającym subagentem (``waitingAgent(_:)``) i monitorem (`watcher`),
  /// bez pytania o rozkład: wiersz „pracuje w tle", dopóki na liście stoi coś, co nie jest subagentem
  /// w postoju ani monitorem. Sesja, której całe tło czeka albo patrzy, dostaje ton i rangę jak sesja bez
  /// tła. Od ``hasBackgroundWork(_:)``
  /// różni się jednym: przebieg workflow, w którym wszyscy agenci skończyli, lista dalej liczy jako
  /// pracę, a kafel już nie.
  ///
  /// Odpowiednik w `work.ts`: brak. Serwer nie liczy rangi ani tonu wiersza. Ten sam kształt reguły
  /// („każde zadanie poza czekającym subagentem i monitorem") ma tam `tasksHoldingDonePush`.
  public static func tasksKeepRowWorking(_ tasks: [BackgroundTask]?) -> Bool {
    (tasks ?? []).contains { !waitingAgent($0) && !watcher($0) }
  }

  /// Kafel Live Activity, licznik „pracuje": na liście jest zadanie, które jeszcze mieli.
  ///
  /// Kto pyta: `LiveActivityInput.aggregate` (sesja po turze doliczana do „pracuje")
  /// i `LiveActivityInput.matches` (taka sesja nie liczy się do „skończyły"; cel tapnięcia liczby).
  ///
  /// Ostrzej niż ``tasksKeepRowWorking(_:)``: zamknięty przebieg workflow nie jest pracą. Łagodniej
  /// niż ``hasOpenWorkflow(_:)``: komenda i pracujący subagent są pracą, dopóki stoją na liście. Sesja
  /// po turze, której wszystkie zadania to czekający subagenci i monitory, do „pracuje" się nie liczy;
  /// z nieodebranym wynikiem liczy się do „skończyły". Exception: a session after a turn with a wait at `stuck`
  /// (``stuckWait(_:_:)``) counts as waiting, neither as working nor as finished.
  ///
  /// Odpowiednik w `work.ts`: `hasBackgroundWork`.
  public static func hasBackgroundWork(_ tasks: [BackgroundTask]?) -> Bool {
    (tasks ?? []).contains(where: liveTask)
  }

  /// Kafel Live Activity, zegar ciszy: na liście jest OTWARTY przebieg workflow.
  ///
  /// Kto pyta: `LiveActivityInput.isBusy` (start aktywności i zegar ciszy, który ją kończy).
  ///
  /// Ostrzej niż ``hasBackgroundWork(_:)``, i celowo: serwer deweloperski albo monitor puszczony
  /// w tle mieli bez końca, a kafel ma zejść po ciszy bez decyzji, tury i workflow.
  ///
  /// Odpowiednik w `work.ts`: `hasOpenWorkflow`.
  public static func hasOpenWorkflow(_ tasks: [BackgroundTask]?) -> Bool {
    (tasks ?? []).contains(where: openWorkflow)
  }

  /// Linia workflow wiersza listy: otwarte przebiegi workflow z listy, w jej kolejności.
  ///
  /// Kto pyta: `SessionRowModel.stageLine`. Otwarty przebieg stoi w linii etapu przed aktywnością tury
  /// i przed zdaniem o liście, a który z kilku, wybiera `ActivityText.liveWorkflow`.
  /// Ta sama definicja otwartości co ``hasOpenWorkflow(_:)``: niepusty wynik wtedy i tylko wtedy.
  ///
  /// Odpowiednik w `work.ts`: brak. Serwer linii etapu nie składa; otwartość mierzy tam ta sama `openWorkflow`.
  public static func openWorkflows(_ tasks: [BackgroundTask]?) -> [BackgroundTask] {
    (tasks ?? []).filter(openWorkflow)
  }

  /// Pigułka i sekcja „w tle": na liście stoi cokolwiek, pracujące, czekające albo monitor.
  ///
  /// Kto pyta: `StatusPills.background` (czy linia statusu ma pigułkę „N w tle") i `BackgroundBadge`
  /// (plakietka z liczbą). To NIE jest pytanie o pracę: subagent w postoju stoi na liście i ma być
  /// widoczny razem z tym, na co czeka, a monitor razem z tym, na co patrzy, więc pigułka liczy wszystkie
  /// zadania. Czy ma znak pracy, mówi ``tasksKeepRowWorking(_:)``.
  ///
  /// Odpowiednik w `work.ts`: brak.
  public static func hasTasks(_ tasks: [BackgroundTask]?) -> Bool {
    !(tasks ?? []).isEmpty
  }

  /// Live Activity counter "waiting": a session after a turn (`waitingInput`) whose list has a wait at `stuck`.
  ///
  /// Who asks: the list row, which gets the tone `.waiting`, rank 0 and its own word (`SessionSummary.statusTone`,
  /// `SessionSummary.listRank`, `AppState.listOrderRank`, `RowStatus`), and `LiveActivityInput.matches` (such a
  /// session counts as waiting, neither as working nor as finished, and is the target of the waiting number) and
  /// `LiveActivityInput.aggregate` through it. Other states keep their own
  /// counter: a decision already waits, a turn works, and `done` or `resumable` has a phantom agent. The stage comes
  /// from the field only (`BackgroundTask.ownCommandWait`, computed by the server); the app has no thresholds.
  ///
  /// Counterpart in `work.ts`: `stuckWait`.
  public static func stuckWait(_ state: SessionState, _ tasks: [BackgroundTask]?) -> Bool {
    state == .waitingInput && strongestOwnCommandWait(state, tasks) == .stuck
  }

  /// The wait stage of one subagent as the session rules see it: the server's field, and none in a session that ended
  /// (`done`) or waits for a resume (`resumable`), whose agent is a phantom.
  ///
  /// Who asks: ``strongestOwnCommandWait(_:_:)``, and in `RarogUI` `BackgroundPanel.lines` (the warning line of the
  /// subagent's row in the background section) and `BackgroundTaskRow.spoken(_:in:)` (the background pill's sentence).
  ///
  /// Counterpart in `work.ts`: none by this name; the server sets the field with `ownCommandWaitOf` and its session
  /// rules skip the phantom states in the same way.
  public static func ownCommandWait(of task: BackgroundTask, in state: SessionState) -> OwnCommandWait? {
    phantom(state) ? nil : task.ownCommandWait
  }

  /// The strongest wait stage on the list (`stuck` over `long` over `short`), as ``ownCommandWait(of:in:)`` sees each
  /// task; `nil` = no subagent waits on a known own command.
  ///
  /// Who asks: ``stuckWait(_:_:)``, which is this at `stuck` after a turn, and `SessionSummary.statusTone`, which gives
  /// a received result with a wait at `long` the warning tone `.backgroundWaitLong`, and `BackgroundBadge` in `RarogUI`
  /// (the warning mark of the background pill).
  ///
  /// Counterpart in `work.ts`: none; the server has no session tone.
  public static func strongestOwnCommandWait(_ state: SessionState, _ tasks: [BackgroundTask]?) -> OwnCommandWait? {
    (tasks ?? []).compactMap { ownCommandWait(of: $0, in: state) }.max { strength($0) < strength($1) }
  }

  /// The key of one wait: the agent and its `waitingSince`, so it stays while the stage grows and changes after a
  /// wake and a new standby. `nil` for a task without a stage or not in standby. Opaque: callers compare keys and
  /// never read the parts.
  ///
  /// Counterpart in `work.ts`: `waitKey` (the same parts; the two keys are never compared with each other).
  public static func waitKey(_ task: BackgroundTask) -> String? {
    guard task.ownCommandWait != nil, waitingAgent(task), let since = task.waitingSince else { return nil }
    return "\(task.id)\u{0}\(since)"
  }

  /// Na liście stoją SAMI subagenci w postoju (i jest co najmniej jeden).
  ///
  /// Kto pyta: `ActivityText.backgroundText` (linia etapu wiersza listy). „w tle: subagent" byłoby wtedy
  /// nieprawdą, bo nic nie pracuje: linia mówi „czeka: subagent". Zawiera się w ``hasTasks(_:)`` bez
  /// ``tasksKeepRowWorking(_:)``, ale nie jest tym samym: lista z monitorem też nie ma znaku pracy, a samych
  /// czekających subagentów na niej nie ma.
  ///
  /// Odpowiednik w `work.ts`: `onlyWaitingAgents` (tam wybiera zdanie odmowy restartu).
  public static func onlyWaitingAgents(_ tasks: [BackgroundTask]?) -> Bool {
    let list = tasks ?? []
    return !list.isEmpty && list.allSatisfy(waitingAgent)
  }

  /// Subagent w POSTOJU: rodzaj `agent` z polem `waitingSince`. Skończył turę i czeka na własne
  /// zadanie w tle: nie pracuje i nie skończył. Pole przy zadaniu innego rodzaju nic nie znaczy
  /// (kontrakt nadaje je tylko agentom) i takiego zadania czekającym nie robi.
  ///
  /// Kto pyta spoza tego pliku: `BackgroundTaskRow` (wiersz zadania w sekcji „w tle": stan „czeka na
  /// własne zadanie" i licznik od początku postoju) i zdanie plakietki dla czytnika ekranu.
  ///
  /// Odpowiednik w `work.ts`: `waitingAgent`.
  public static func waitingAgent(_ task: BackgroundTask) -> Bool {
    task.kind == .agent && task.waitingSince != nil
  }

  /// Subagent, który PRACUJE: rodzaj `agent` bez postoju.
  ///
  /// Kto pyta: linia etapu wiersza listy, gdy aktywność mówi „subagent pracuje", a opisu nie niesie
  /// (`ActivityText.cardText` i linia z pamięci tury). Opis bierze wtedy z zadania na liście, i ma to być
  /// agent, który pracuje, nie ten, który stoi.
  ///
  /// Odpowiednik w `work.ts`: brak. Serwer linii etapu nie składa.
  public static func workingAgent(_ task: BackgroundTask) -> Bool {
    task.kind == .agent && !waitingAgent(task)
  }

  /// The order of wait stages for ``strongestOwnCommandWait(_:_:)``; the raw values do not sort that way.
  private static func strength(_ wait: OwnCommandWait) -> Int {
    switch wait {
    case .short: 0
    case .long: 1
    case .stuck: 2
    }
  }

  /// A session that ended or waits for a resume: an agent still on its list is a phantom for the rules.
  ///
  /// Counterpart in `work.ts`: `phantomState`.
  private static func phantom(_ state: SessionState) -> Bool {
    state == .done || state == .resumable
  }

  /// Monitor: zadanie, które patrzy, a nie pracuje. Rodzaj wystarcza, bez względu na kształt startu.
  ///
  /// Odpowiednik w `work.ts`: `watcher`.
  private static func watcher(_ task: BackgroundTask) -> Bool {
    task.kind == .monitor
  }

  /// Zadanie, które jeszcze MIELI. Zadanie spoza workflow (komenda, subagent, rodzaj nieznany tej wersji
  /// apki) mieli, dopóki stoi na liście, z dwoma wyjątkami: subagent w postoju (``waitingAgent(_:)``) nie
  /// mieli, tylko czeka, a monitor (`watcher`) tylko patrzy. Przebieg workflow tylko, gdy jest otwarty
  /// (``openWorkflow(_:)``): zadanie bez wpisu zamknięcia (zabite CLI) wisiałoby inaczej jako praca.
  ///
  /// Odpowiednik w `work.ts`: `liveTask`.
  private static func liveTask(_ task: BackgroundTask) -> Bool {
    if waitingAgent(task) || watcher(task) { return false }
    return task.kind != .workflow || openWorkflow(task)
  }

  /// Otwarte zadanie workflow: bez rozkładu („nie wiem"), bez agentów (start) albo z agentem w locie.
  ///
  /// „Nie wiem" (rozkład `run` jeszcze nieodczytany) traktujemy jako otwarte: brak odczytu nie może
  /// zakończyć aktywności. Gdy wszyscy agenci skończyli, przebieg otwarty już nie jest: zadanie
  /// bez wpisu zamknięcia w jsonl (zabite CLI) trzymałoby kafel do systemowych 8 h.
  ///
  /// Odpowiednik w `work.ts`: `openWorkflow`.
  private static func openWorkflow(_ task: BackgroundTask) -> Bool {
    guard task.kind == .workflow else { return false }
    guard let run = task.run else { return true }
    return run.agents.isEmpty || run.agents.contains { !$0.done }
  }
}
