import Foundation
import RarogContract
import RarogCore

// Nagłówek sesji: linia statusu (kontekst, git, „w tle"), pigułka nowszego CLI, rozwinięcie gita
// i diff; pigułki modelu i trybu z rzędu pod polem wiadomości i arkusz „Model i effort".
extension UICopy {
  // MARK: Kontekst

  /// „kontekst 12 procent".
  static func contextSpoken(_ percent: Int) -> String {
    L("header.contextSpoken", percent)
  }

  /// Szacunek od założonego okna — czytnik słyszy, że limit nie jest potwierdzony.
  static func contextEstimateSpoken(_ percent: Int, assumedLimit: Int) -> String {
    assumedLimit == 1_000_000
      ? L("header.contextEstimateSpoken.million", percent)
      : L("header.contextEstimateSpoken.thousands", percent, assumedLimit / 1000)
  }

  // MARK: Linia gita

  /// `3 pliki` — sam licznik, gdy serwer nie podał rodzajów plików.
  static func filesCount(_ n: Int) -> String { L("header.filesCount", n) }

  static func branchSpoken(_ branch: String) -> String { L("header.branchSpoken", branch) }

  /// „2 commity do pobrania, 1 commit do wypchnięcia" — kolejność linii (najpierw pobranie).
  static func aheadBehindSpoken(ahead: Int, behind: Int) -> String? {
    let parts = [
      behind > 0 ? L("header.aheadBehindSpoken.behind", behind) : nil, ahead > 0 ? L("header.aheadBehindSpoken.ahead", ahead) : nil,
    ].compactMap { $0 }
    return parts.isEmpty ? nil : list(parts, .comma)
  }

  /// `+3 ~5 −1` spoken; only the first part carries the noun ("3 added files, 5 modified"), so a kind that can
  /// come first has a key with the noun (`.first.*`) and a kind that can follow has one without it (`.next.*`).
  /// Added files always come first, so they have no `.next` key.
  static func fileKindsSpoken(added: Int, modified: Int, deleted: Int) -> String? {
    var parts: [String] = []
    if added > 0 { parts.append(L("header.fileKindsSpoken.first.added", added)) }
    func say(_ n: Int, first: (Int) -> String, next: (Int) -> String) {
      guard n > 0 else { return }
      parts.append(parts.isEmpty ? first(n) : next(n))
    }
    say(modified, first: { L("header.fileKindsSpoken.first.modified", $0) }, next: { L("header.fileKindsSpoken.next.modified", $0) })
    say(deleted, first: { L("header.fileKindsSpoken.first.deleted", $0) }, next: { L("header.fileKindsSpoken.next.deleted", $0) })
    return parts.isEmpty ? nil : list(parts, .comma)
  }

  static func dirtySpoken(_ n: Int) -> String {
    n > 0 ? L("header.dirtySpoken", n) : L("header.dirtySpoken.none")
  }

  static var gitDetailsHint: String { L("header.gitDetailsHint") }

  // MARK: Rozwinięcie gita

  static func changedFilesHeader(_ n: Int) -> String { L("header.changedFilesHeader", n) }

  static func dirtyRefreshing(_ n: Int) -> String { L("header.dirtyRefreshing", n) }

  static var noChangedFiles: String { L("header.noChangedFiles") }
  static var showDiff: String { L("header.showDiff") }
  static var showDiffSpoken: String { L("header.showDiffSpoken") }
  static var diffDisabledSpoken: String { L("header.diffDisabledSpoken") }

  /// Zdanie wiersza ostatniego commita: „ostatni commit: feat: …, 3 paź 14:05".
  static func commitSpoken(subject: String, when: String?) -> String {
    when.map { L("header.commitSpoken.when", subject, $0) } ?? L("header.commitSpoken", subject)
  }

  /// Litera statusu pliku na głos.
  static func diffStatusSpoken(_ status: DiffFileStatus?) -> String {
    switch status {
    case .added?: L("header.diffStatusSpoken.added")
    case .modified?: L("header.diffStatusSpoken.modified")
    case .deleted?: L("header.diffStatusSpoken.deleted")
    case nil: L("header.diffStatusSpoken.unknown")
    }
  }

  /// Wiersz pliku na głos: litera i liczby same w sobie nie znaczą nic.
  static func diffFileSpoken(path: String, status: DiffFileStatus?, added: Int?, deleted: Int?) -> String {
    var parts = [status == nil && added == nil ? path : list([path, diffStatusSpoken(status)], .comma)]
    if let added, added > 0 { parts.append(L("header.diffFileSpoken.added", added)) }
    if let deleted, deleted > 0 { parts.append(L("header.diffFileSpoken.deleted", deleted)) }
    return list(parts, .comma)
  }

  // MARK: Diff sesji

  static var diffTitle: String { L("header.diffTitle") }
  static var diffLoading: String { L("header.diffLoading") }
  static var diffEmpty: String { L("header.diffEmpty") }
  static var diffFailed: String { L("header.diffFailed") }
  static var diffRetry: String { L("header.diffRetry") }
  static var diffClose: String { L("header.diffClose") }

  /// Serwer sprzed tras diffa per plik odpowiada 405: apka weszła na produkcję przed restartem serwera.
  static var diffServerOutdated: String { L("header.diffServerOutdated") }

  /// Odświeżenie listy się nie udało, a na ekranie stoi ostatni znany stan.
  static var diffRefreshFailed: String { L("header.diffRefreshFailed") }

  /// „3 pliki", a przy liście uciętej przez serwer „500+ plików" (plików jest więcej, niż pokazuje okno).
  static func diffFilesCount(_ n: Int, truncated: Bool = false) -> String {
    truncated ? L("header.diffFilesCount.truncated", n) : L("header.diffFilesCount", n)
  }

  /// Tytuł okna: „Zmiany · 3 pliki"; `nil` = lista jeszcze nie przyszła.
  static func diffWindowTitle(files: Int?, truncated: Bool) -> String {
    files.map { L("header.diffWindowTitle", diffFilesCount($0, truncated: truncated)) } ?? diffTitle
  }

  /// Stopka pod listą, którą serwer uciął na suficie. Liczba z kontraktu, nie z literału.
  static func diffListTruncated(maxFiles: Int = DiffFileList.maxFiles) -> String {
    L("header.diffListTruncated", diffFilesCount(maxFiles))
  }

  // Sekcja pliku w oknie diffa: nagłówek rozwija patch, który pobiera się dopiero wtedy.

  static var diffFileExpanded: String { L("header.diffFileExpanded") }
  static var diffFileCollapsed: String { L("header.diffFileCollapsed") }
  static var diffFileLoading: String { L("header.diffFileLoading") }
  static var diffFileFailed: String { L("header.diffFileFailed") }
  /// Odpowiedź bez linii (zmiana zniknęła między listą a patchem albo git nie ma czego pokazać).
  static var diffFileEmpty: String { L("header.diffFileEmpty") }

  /// Stopka pod plikiem, którego patch serwer uciął. Liczba z kontraktu, nie z literału.
  static func diffFileTruncated(maxBytes: Int = DiffFilePatch.maxPatchBytes) -> String {
    L("header.diffFileTruncated", maxBytes / 1024)
  }

  /// Footer of the single-request diff (`GET …/diff`); the diff window does not use it.
  static func diffTruncated(maxBytes: Int = SessionDiff.maxPatchBytes) -> String {
    L("header.diffTruncated", maxBytes / 1024)
  }

  // MARK: Zadania w tle (plakietka i rodzaj: `UICopy+Activity`)

  /// „3 zadania w tle: subagent Research herdr API, komenda pnpm test".
  static func backgroundSpoken(_ items: [String]) -> String {
    let n = items.count
    guard n > 0 else { return L("header.backgroundSpoken.none") }
    return L("header.backgroundSpoken", n, list(items, .comma))
  }

  static var backgroundPanelTitle: String { L("header.backgroundPanelTitle") }

  /// Stan subagenta w postoju: skończył turę i czeka na własną komendę w tle. Te same słowa mówi notka
  /// w transkrypcie („Subagent czeka na własne zadanie w tle").
  static var agentWaitingOwnTask: String { L("header.agentWaitingOwnTask") }

  /// Stan z czasem dla czytnika: „czeka na własne zadanie od 18 minut"; bez znanej chwili sam stan.
  static func agentWaitingSpoken(since: Date?, now: Date) -> String {
    guard let since else { return agentWaitingOwnTask }
    return L("header.agentWaitingSpoken", agentWaitingOwnTask, RelativeTime.spokenSince(since: since, now: now))
  }

  /// „komenda pnpm test pracuje” — zadanie w tle z jego stanem; dla czytnika (oko widzi kropkę pracy), dalej idzie
  /// czas: „komenda pnpm test pracuje, od 6 minut".
  static func backgroundTaskWorking(_ what: String) -> String { L("header.backgroundTaskWorking", what) }

  /// „subagent Research czeka na własne zadanie” — subagent w postoju w zdaniu o zadaniach w tle.
  static func backgroundTaskWaiting(_ what: String) -> String { L("header.backgroundTaskWaiting", what) }

  /// A subagent that waits long on its own command, in the sentence about background tasks: "subagent Research has
  /// been waiting a long time on its own task" at `long`, "subagent Research is stuck on a command" at `stuck`.
  static func backgroundTaskWaitingLong(_ what: String) -> String { L("header.backgroundTaskWaitingLong", what) }
  static func backgroundTaskStuck(_ what: String) -> String { L("header.backgroundTaskStuck", what) }

  /// The warning line in place of the state line: "waiting 47m on: pgrep, sleep"; without a known standby time
  /// "waiting on: pgrep, sleep".
  static func waitWarning(since: String?, tools: String) -> String {
    guard let since else { return L("header.waitWarning.untimed", tools) }
    return L("header.waitWarning", since, tools)
  }

  /// The warning line for the reader: "waiting a long time on: pgrep, sleep, for 47 minutes" at `long`, "stuck on:
  /// pgrep, sleep, for 1 hour" at `stuck`; without a known standby time no time.
  static func waitWarningSpoken(stuck: Bool, tools: String, since: String?) -> String {
    let head = stuck ? L("header.waitWarningSpoken.stuck", tools) : L("header.waitWarningSpoken.long", tools)
    guard let since else { return head }
    return L("header.waitWarningSpoken.since", head, since)
  }

  /// "Check": the button under a subagent that waits long on its own command; it sends the main agent a question.
  static var waitCheck: String { L("header.waitCheck") }
  /// The Check button for the reader: what a tap does.
  static var waitCheckHint: String { L("header.waitCheckHint") }
  /// "Sent · 21:40" in place of Check once the server took the message; "Sent to the main agent at 21:40" for the
  /// reader.
  static func waitCheckSent(_ clock: String) -> String { L("header.waitCheckSent", clock) }
  static func waitCheckSentSpoken(_ clock: String) -> String { L("header.waitCheckSentSpoken", clock) }

  /// „komenda: pnpm test” — narzędzia komendy pod opisem zadania (czytnik).
  static func backgroundTaskTools(_ tools: String) -> String { L("header.backgroundTaskTools", tools) }

  /// Pod licznikiem zadania, które liczy ponad godzinę: „od 20:33".
  static func backgroundSince(_ clock: String) -> String { L("header.backgroundSince", clock) }

  /// Podział w nagłówku „w tle", gdy ktoś stoi w postoju: „2 pracują · 1 czeka", „2 czekają". Zera nie tworzą członu.
  static func backgroundSplit(working: Int, waiting: Int) -> String {
    var parts: [String] = []
    if working > 0 { parts.append(L("header.backgroundSplit.working", working)) }
    if waiting > 0 { parts.append(L("header.backgroundSplit.waiting", waiting)) }
    return list(parts, .dot)
  }

  /// Menu kontekstowe wiersza z komendą (i akcja czytnika): kopiuje komendę tak, jak przyszła z serwera.
  static var copyCommand: String { L("header.copyCommand") }

  /// Nad własnymi komendami subagenta w postoju: to na nie agent czeka.
  static var ownTasksAwaited: String { L("header.ownTasksAwaited") }

  /// Własna komenda subagenta, który pracuje: zdanie czytnika mówi, czyja to komenda (oko widzi wcięcie).
  static var ownTaskOfAgent: String { L("header.ownTaskOfAgent") }

  /// Własna komenda subagenta na głos: „czeka na: pnpm test, od 21 minut" przy agencie w postoju, „komenda
  /// subagenta: pnpm test, od 21 minut" przy agencie, który pracuje. Bez treści komendy zostaje samo słowo
  /// „komenda", bez startu zdanie nie mówi czasu.
  static func ownTaskSpoken(command: String?, awaited: Bool, since: Date?, now: Date) -> String {
    let head: String =
      if awaited {
        L("header.ownTaskSpoken.awaited", command ?? backgroundKind(.command))
      } else {
        command.map { L("header.ownTaskSpoken.ofAgent", $0) } ?? ownTaskOfAgent
      }
    guard let since else { return head }
    return L("header.ownTaskSpoken", head, RelativeTime.spokenSince(since: since, now: now))
  }

  // MARK: Pigułka modelu i arkusz

  static var modelUnknown: String { L("header.modelUnknown") }
  static var modelUnknownSpoken: String { L("header.modelUnknownSpoken") }

  static func modelSpoken(_ label: String) -> String { L("header.modelSpoken", label) }

  static func modelEffortSpoken(_ label: String, effort: String) -> String { L("header.modelEffortSpoken", label, effort) }

  /// Pigułka z `· ultracode`: słowo CLI zostaje w zdaniu bez tłumaczenia, jak poziom effortu.
  static func modelUltracodeSpoken(_ label: String) -> String { L("header.modelUltracodeSpoken", label) }

  static func modelEffortUltracodeSpoken(_ label: String, effort: String) -> String {
    L("header.modelEffortUltracodeSpoken", label, effort)
  }

  /// The pill's spoken label for the target set while the change is on its way.
  static func modelSwitchingSpoken(_ spoken: String) -> String { L("header.modelPillSpoken.switching", spoken) }

  static var modelSheetTitle: String { L("header.modelSheetTitle") }
  static var modelGroup: String { L("header.modelGroup") }
  static var effortGroup: String { L("header.effortGroup") }
  static var modelApply: String { L("header.modelApply") }
  static var modelDismiss: String { L("header.modelDismiss") }
  static var modelsLoading: String { L("header.modelsLoading") }
  static var modelsFailed: String { L("header.modelsFailed") }
  static var modelBusy: String { L("header.modelBusy") }
  static var modelChangeFailed: String { L("header.modelChangeFailed") }
  /// Why the sheet offers no Apply while the previous change is on its way to the session.
  static var modelChanging: String { L("header.modelChanging") }
  /// Skutek globalny `/model` — to samo zdanie co `MODEL_CHANGE_WARNING` serwera. Słyszy
  /// je czytnik przy wyborze i przy „Zatwierdź"; na ekranie nie stoi.
  static var modelChangeWarning: String { L("header.modelChangeWarning") }
  /// The sheet's Ultracode row: the name of the Claude Code setting and its two segments.
  static var ultracodeGroup: String { L("header.ultracodeGroup") }
  static var ultracodeYes: String { L("header.ultracodeYes") }
  static var ultracodeNo: String { L("header.ultracodeNo") }
  /// Stands in place of the Effort chips when the chosen model has no levels.
  static var effortNone: String { L("header.effortNone") }
  /// Ultracode cost — the same sentence as the server's `ULTRACODE_CHANGE_NOTE`. VoiceOver hears it at the Ultracode
  /// row and at Apply with only ultracode; it does not stand on screen, like the `/model` warning.
  static var ultracodeHint: String { L("header.ultracodeHint") }

  /// Dlaczego arkusz modelu nie ma czego zaoferować — zawsze mówi, co zrobić.
  static func modelBlock(_ block: ModelChangeBlock) -> String {
    switch block {
    case .busy: modelBusy
    case .codex: sendBlock(.codex, session: nil)
    case .unsupported: unsupportedSession
    case .outOfScope: sendBlock(.outOfScope, session: nil)
    case .herdrUnavailable: L("header.modelBlock.herdrUnavailable")
    case .herdrReadOnly: L("header.modelBlock.herdrReadOnly")
    }
  }

  // MARK: Pigułka trybu

  static func modeText(_ mode: HerdrMode) -> String {
    switch mode {
    case .bypass: L("header.modeText.bypass")
    case .auto: L("header.modeText.auto")
    case .plan: L("header.modeText.plan")
    case .manual: L("header.modeText.manual")
    case .unknown: L("header.modeText.unknown")
    }
  }

  static func modeSpoken(_ mode: HerdrMode) -> String {
    switch mode {
    case .bypass: L("header.modeSpoken.bypass")
    case .auto: L("header.modeSpoken.auto")
    case .plan: L("header.modeSpoken.plan")
    case .manual: L("header.modeSpoken.manual")
    case .unknown: L("header.modeSpoken.unknown")
    }
  }

  /// Stan ORAZ co zrobi tap.
  static func modePillSpoken(_ mode: HerdrMode, target: ModeCycleTarget?, busy: Bool) -> String {
    if busy { return L("header.modePillSpoken.busy", modeSpoken(mode)) }
    guard let target else { return modeSpoken(mode) }
    return L("header.modePillSpoken.target", modeSpoken(mode), modeText(target == .plan ? .plan : .auto))
  }

  /// Tap w pigułkę bez celu — dlaczego nic się nie stanie.
  static func modeNoTarget(_ mode: HerdrMode) -> String {
    mode == .bypass
      ? L("header.modeNoTarget.bypass")
      : L("header.modeNoTarget.unknown")
  }

  static var modeBusy: String { L("header.modeBusy") }
  static var modeFailed: String { L("header.modeFailed") }

  // MARK: Pigułka nowszego Claude Code

  static func cliUpdatePill(_ installed: String) -> String { "↑\(nbsp)\(installed)" }

  static func cliUpdateSpoken(running: String, installed: String) -> String {
    L("header.cliUpdateSpoken", running, installed)
  }

  static var cliRestartQuestion: String { L("header.cliRestartQuestion") }
  static var cliRestartArmed: String { L("header.cliRestartArmed") }
  static var cliRestartBusy: String { L("header.cliRestartBusy") }
  static var cliRestartFailed: String { L("header.cliRestartFailed") }

  static func cliRestarting(_ installed: String) -> String {
    L("header.cliRestarting", installed)
  }

  // MARK: Wyniki akcji (zdanie pod paskiem)

  /// Zdanie po akcji sterowania; `nil` = bez zdania (sukces mówi sam strumień).
  static func controlMessage(_ outcome: SessionControlOutcome, fallback: String) -> String? {
    switch outcome {
    case .accepted, .notAllowed, .loggedOut: nil
    case .inFlight: nil
    case let .refused(message): message ?? fallback
    case .offline: serverSilent
    case .timedOut: controlTimedOut
    case .failed: fallback
    }
  }

  /// Limit czasu akcji sterowania — bez liczby sekund (restart czeka 20 s, reszta 10 s).
  static var controlTimedOut: String { L("header.controlTimedOut") }
}
