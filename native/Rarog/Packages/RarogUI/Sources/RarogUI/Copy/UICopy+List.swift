import Foundation
import RarogContract
import RarogCore

// Lista sesji. Właściciel: lista.
extension UICopy {
  // MARK: Przeczytane / nieprzeczytane

  /// Krótka etykieta przesunięcia wiersza w prawo — jak w Mailu.
  public static func readToggleSwipe(_ toggle: ReadToggle) -> String {
    toggle == .markRead ? L("list.readToggleSwipe.markRead") : L("list.readToggleSwipe.markUnread")
  }

  /// Pełna etykieta w menu kontekstowym wiersza.
  public static func readToggleMenu(_ toggle: ReadToggle) -> String {
    toggle == .markRead ? L("list.readToggleMenu.markRead") : L("list.readToggleMenu.markUnread")
  }

  // MARK: Lista

  public static var listTitle: String { L("list.title") }
  public static var listEmpty: String { L("list.empty") }
  public static var detailPlaceholder: String { L("list.detailPlaceholder") }
  /// Etykieta nad zdaniem pustej prawej kolumny (kapitaliki robi styl `Eyebrow`).
  public static var detailEyebrow: String { L("list.detailEyebrow") }
  public static var connecting: String { L("list.connecting") }
  public static var codexTag: String { L("list.codexTag") }
  public static var codexSpoken: String { L("list.codexSpoken") }
  public static var unknownSession: String { L("list.unknownSession") }
  public static var backToList: String { L("list.backToList") }
  public static var idleSeen: String { L("list.idleSeen") }
  /// The state word of a received result the voice agent picked up (`SessionSummary.seenBy`).
  public static var discussedByVoice: String { L("list.discussedByVoice") }
  public static var backgroundWork: String { L("list.backgroundWork") }

  /// Słowo stanu — po ludzku, nigdy nazwą z protokołu (`STATE_LABELS`).
  public static func stateLabel(_ state: SessionState) -> String {
    switch state {
    case .starting: L("list.stateLabel.starting")
    case .running: L("list.stateLabel.running")
    case .waitingInput: L("list.stateLabel.waitingInput")
    case .waitingPermission: L("list.stateLabel.waitingPermission")
    case .waitingQuestion: L("list.stateLabel.waitingQuestion")
    case .limitReached: L("list.stateLabel.limitReached")
    case .error: L("list.stateLabel.error")
    case .interrupted: L("list.stateLabel.interrupted")
    case .done: L("list.stateLabel.done")
    case .resumable: L("list.stateLabel.resumable")
    case .unsupported: L("list.stateLabel.unsupported")
    }
  }

  /// Zegar decyzji dla czytnika: „czeka od 4 minut”; ekran pokazuje sam czas obok stanu („czeka na zgodę · 4 min”).
  public static func cardWaitClock(_ value: String) -> String { L("list.cardWaitClock", value) }
  /// Numer kolejnej sesji w tym samym projekcie dla czytnika („numer 2”; na ekranie `#2`).
  public static func ordinalSpoken(_ ordinal: Int) -> String { L("list.ordinalSpoken", ordinal) }

  /// Słowo tonu dla czytnika (kolor nigdy nie stoi sam).
  public static func toneSpoken(_ tone: StatusTone) -> String {
    switch tone {
    case .working: L("list.toneSpoken.working")
    case .waiting: L("list.toneSpoken.waiting")
    case .failed: L("list.toneSpoken.failed")
    case .unread: L("list.toneSpoken.unread")
    case .quiet: L("list.toneSpoken.quiet")
    case .backgroundWait: L("list.toneSpoken.backgroundWait")
    }
  }

  /// Linia karty listy „na co czeka". Pusty napis = czeka, ale jeszcze nie wiadomo na co.
  public static func waitingLine(_ session: SessionSummary) -> String {
    if let waiting = session.waitingFor {
      let text = waiting.text.map(PathText.shortenPaths) ?? ""
      switch waiting.kind {
      case .question:
        let lead = questionEyebrow(index: 1, total: waiting.count ?? 1)
        return text.isEmpty ? lead : L("list.waitingLine.withText", lead, text)
      case .permission:
        if waiting.subject == .plan { return waitingPlan }
        let tool = waiting.tool ?? ""
        let lead = tool.isEmpty ? waitingPermission : L("list.waitingLine.permissionTool", tool)
        return text.isEmpty ? lead : list([lead, text], .dot)
      }
    }
    if let dialog = session.herdrDialog { return L("list.waitingLine.knownDialog", knownDialog(dialog)) }
    // Klasa z rejestru CLI bije powód: linia mówi, NA CO czeka; powód stoi na karcie.
    if let phrase = cliDialogPhrase(session.cliDialog) { return dialogChipDetail(phrase) }
    if let reason = session.herdrDialogReason { return dialogChipDetail(refuseEyebrow(reason)) }
    return ""
  }
}

// Nagłówek listy, linia etapu i limity planu w stopce. Właściciel: lista.
extension UICopy {
  // MARK: Nagłówek listy

  /// Karta nieświeża w zdaniu czytnika — wygaszenie wiersza znaczy dokładnie to.
  public static var staleSpoken: String { L("list.staleSpoken") }

  /// „Agenci (N)".
  public static func listTitle(count: Int) -> String { L("list.titleCount", count) }

  /// „TS · nazwa": dwa znaki mówią, czego dotyczy goła nazwa w rogu nagłówka.
  public static func tailnetLabel(_ name: String) -> String {
    L("list.tailnetLabel", name)
  }

  // MARK: Limity planu

  public static var usageLoadingSpoken: String { L("list.usageLoadingSpoken") }
  public static var usageAccountLabel: String { L("list.usageAccountLabel") }

  /// Etykiety okna w trzech oddechach: pasek („5h", „7d"; skrót okna per model zostaje w modelu, ale pasek tego
  /// okna nie pokazuje), panel, czytnik.
  public static func usageWindowNames(_ window: UsageWindowKind) -> (short: String, full: String, spoken: String) {
    switch window {
    case .fiveHour: (L("list.usageWindowNames.fiveHour.short"), L("list.usageWindowNames.fiveHour.full"), L("list.usageWindowNames.fiveHour.spoken"))
    // „7d", nie „tydzień" („tydzień" się nie mieści); panel i czytnik dostają słowo.
    case .weekly: (L("list.usageWindowNames.weekly.short"), L("list.usageWindowNames.weekly.full"), L("list.usageWindowNames.weekly.spoken"))
    case let .model(name):
      name.isEmpty
        ? (L("list.usageWindowNames.model.short"), L("list.usageWindowNames.model.full"), L("list.usageWindowNames.model.spoken"))
        : (String(name.prefix(3)), L("list.usageWindowNames.namedModel.full", name), L("list.usageWindowNames.namedModel.spoken", name))
    }
  }

  /// „Limity planu — okno 5 godzin: 27 procent, reset o 13:20; tydzień: 64 procent".
  public static func usageLineSpoken(_ parts: [String]) -> String {
    L("list.usageLineSpoken", list(parts, .semicolon))
  }

  /// Wiersz panelu limitów dla czytnika: „Tydzień: 64 procent, reset 17:20 · za 2 h 44”.
  public static func usageRowSpoken(_ window: String, percent: Int, reset: String?) -> String {
    reset.map { L("list.usageRowSpoken.reset", window, percent, $0) } ?? L("list.usageRowSpoken", window, percent)
  }

  public static func usageSegmentSpoken(_ spoken: String, percent: Int, resetClock: String?) -> String {
    resetClock.map { L("list.usageSegmentSpoken.reset", spoken, percent, $0) } ?? L("list.usageSegmentSpoken", spoken, percent)
  }

  /// „reset 17:20 · za 2 h 44" — godzina mówi KIEDY, dystans mówi ILE.
  public static func usageReset(at clock: String, countdown: String) -> String {
    L("list.usageReset", clock, countdown)
  }

  /// Dystans do resetu tym samym słownikiem co czas względny; miniony moment to „lada chwila"
  /// (serwer trzyma limity minutę, więc tuż po resecie widać jeszcze stary znacznik).
  public static func usageCountdown(seconds: Int) -> String {
    if seconds <= 0 { return L("list.usageCountdown.now") }
    if seconds < 60 { return L("list.usageCountdown.seconds", seconds) }
    let minutes = seconds / 60
    if minutes < 60 { return L("list.usageCountdown.minutes", minutes) }
    let hours = minutes / 60
    if hours < 24 { return L("list.usageCountdown.hours", hours, String(format: "%02d", minutes % 60)) }
    return L("list.usageCountdown.days", hours / 24)
  }

  /// A window the server didn't report, in place of the percent on the card (the field stays, the window doesn't move).
  public static let usageSlotMissingMark = "—"

  /// Reset line of the card's field without the window: "brak odczytu".
  public static var usageNoReading: String { L("list.usageNoReading") }

  /// First line of the footer card on the right: "Mac · example.ts.net".
  public static func footerMachine(_ machine: String, tailnet: String) -> String {
    L("list.footerMachine", machine, tailnet)
  }

  /// Reset more than a day away on the card: "za 2 d · 14.11".
  public static func footerResetDays(_ countdown: String, day: String) -> String {
    L("list.footerResetDays", countdown, day)
  }

  /// Czytnik, okno bez odczytu: „okno 5 godzin: brak odczytu".
  public static func usageSlotMissingSpoken(_ spoken: String) -> String {
    L("list.usageSlotMissingSpoken", spoken)
  }

  // MARK: Wiersz aktualizacji serwera nad limitami

  /// Server older than the app's release; its popover with the command: ``serverUpdateSheetIntro(_:_:)``.
  public static var serverUpdate: String { L("list.serverUpdate") }

  // MARK: Arkusz „Limity” komendy apki `/usage`

  public static var usageSheetTitle: String { L("list.usageSheetTitle") }
  /// Serwer sprzed trasy `GET /api/usage/details` (404, 405).
  public static var usageDetailsUnsupported: String { L("list.usageDetailsUnsupported") }
  public static var usageDetailsFailed: String { L("list.usageDetailsFailed") }
  /// Szczegóły bez okna per model: brak odczytu Claude Code, inne konto, plan bez takiego limitu, okno po resecie.
  public static func usageNoModelWindow(_ machine: ServerMachine) -> String {
    machine == .mac ? L("list.usageNoModelWindow") : L("list.usageNoModelWindow.vps")
  }

  /// „Stan z 01:12.” — godzina, z której są liczby wszystkich wierszy arkusza.
  public static func usageSheetStamp(at clock: String) -> String {
    L("list.usageSheetStamp", clock)
  }

  /// „Stan z 01:12, tydzień Fable z 21:18.” — okno per model ma własny, zwykle starszy odczyt Claude Code.
  public static func usageSheetStamp(at clock: String, model spoken: String, modelAt modelClock: String) -> String {
    L("list.usageSheetStamp.withModel", clock, spoken, modelClock)
  }

  /// Notka pod wierszami panelu: liczby nie są z tej chwili — z kiedy i dlaczego.
  public static func usageStaleNote(at clock: String, source: UsageStaleSource) -> String {
    switch source {
    case .serverCli: L("list.usageStaleNote.serverCli", clock)
    case .serverApi: L("list.usageStaleNote.serverApi", clock)
    case .refreshFailed: L("list.usageStaleNote.refreshFailed", clock)
    }
  }
}

// Obciążenie Maca w stopce listy i sekcja „Mac" panelu. Właściciel: lista.
extension UICopy {
  /// Etykiety metryki w czterech oddechach: pasek (≤ 3 znaki), panel, dopisek panelu, czytnik.
  public static func macMetricNames(_ metric: MacMetric) -> (short: String, full: String, detail: String, spoken: String) {
    switch metric {
    case .cpu: (L("list.macMetricNames.cpu.short"), L("list.macMetricNames.cpu.full"), L("list.macMetricNames.cpu.detail"), L("list.macMetricNames.cpu.spoken"))
    case .ram: (L("list.macMetricNames.ram.short"), L("list.macMetricNames.ram.full"), L("list.macMetricNames.ram.detail"), L("list.macMetricNames.ram.spoken"))
    // „DSK", nie „dysk": pole etykiety w pasku ma trzy znaki.
    case .disk: (L("list.macMetricNames.disk.short"), L("list.macMetricNames.disk.full"), L("list.macMetricNames.disk.detail"), L("list.macMetricNames.disk.spoken"))
    }
  }

  /// Nagłówek sekcji panelu (obok nazwy tailnetu).
  public static func macSectionTitle(_ machine: ServerMachine) -> String {
    machine == .mac ? L("list.macSectionTitle") : L("list.macSectionTitle.vps")
  }
  public static var macNoReading: String { L("list.macNoReading") }
  public static func macLoadingNote(_ machine: ServerMachine) -> String {
    machine == .mac ? L("list.macLoadingNote") : L("list.macLoadingNote.vps")
  }
  public static func macUnavailableNote(_ machine: ServerMachine) -> String {
    machine == .mac ? L("list.macUnavailableNote") : L("list.macUnavailableNote.vps")
  }
  public static var macUnsupportedNote: String { L("list.macUnsupportedNote") }
  public static func macLoadingSpoken(_ machine: ServerMachine) -> String {
    machine == .mac ? L("list.macLoadingSpoken") : L("list.macLoadingSpoken.vps")
  }
  public static func macUnavailableSpoken(_ machine: ServerMachine) -> String {
    machine == .mac ? L("list.macUnavailableSpoken") : L("list.macUnavailableSpoken.vps")
  }
  /// Panel, gdy limitów nie ma (panel otwiera się także bez nich, bo niesie Maca).
  public static var usagePanelLoading: String { L("list.usagePanelLoading") }
  public static var usagePanelUnavailable: String { L("list.usagePanelUnavailable") }
  /// Nazwa tailnetu w nagłówku sekcji „Mac” albo „VPS” („TS · nazwa").
  public static func macTailnetSpoken(_ name: String, _ machine: ServerMachine) -> String {
    machine == .mac ? L("list.macTailnetSpoken", name) : L("list.macTailnetSpoken.vps", name)
  }

  /// Poziom metryki słowem — czytnik słyszy próg, który oko widzi kolorem i wagą.
  public static func macLevelWord(_ level: MacLoadLevel) -> String? {
    switch level {
    case .normal: nil
    case .warning: L("list.macLevelWord.warning")
    case .critical: L("list.macLevelWord.critical")
    }
  }

  /// „pamięć 80 procent, wysokie"; bez nazwy — sam procent z poziomem.
  public static func macMetricSpoken(_ spoken: String?, percent: Int, level: MacLoadLevel) -> String {
    let value = macLevelWord(level).map { L("list.macMetricSpoken.level", percent, $0) } ?? L("list.macMetricSpoken", percent)
    return spoken.map { L("list.macMetricSpoken.named", $0, value) } ?? value
  }

  /// Wiersz panelu „Mac” dla czytnika: „Procesor, średnia z minuty: 35 procent”.
  public static func macRowSpoken(full: String, detail: String, value: String) -> String {
    L("list.macRowSpoken", full, detail, value)
  }

  /// „Mac — procesor 35 procent; pamięć 80 procent, wysokie; dysk 95 procent, krytyczne" (na VPS-ie „VPS — …”).
  public static func macLineSpoken(_ parts: [String], _ machine: ServerMachine) -> String {
    switch (parts.isEmpty, machine) {
    case (true, .mac): L("list.macLineSpoken.empty")
    case (true, .vps): L("list.macLineSpoken.empty.vps")
    case (false, .mac): L("list.macLineSpoken", list(parts, .semicolon))
    case (false, .vps): L("list.macLineSpoken.vps", list(parts, .semicolon))
    }
  }

  // MARK: Filter segments

  /// The segment's label in the filter row over the list.
  public static func listFilterLabel(_ filter: ListFilter) -> String {
    switch filter {
    case .all: L("list.filter.all")
    case .needsYou: L("list.filter.needsYou")
    case .working: L("list.filter.working")
    case .unread: L("list.filter.unread")
    }
  }

  /// VoiceOver label of the filter row.
  public static var listFilterGroup: String { L("list.filter.group") }

  /// The first row of a segment no session belongs to; All has none (an empty list says `listEmpty`).
  public static func listFilterEmpty(_ filter: ListFilter) -> String? {
    switch filter {
    case .all: nil
    case .needsYou: L("list.filter.empty.needsYou")
    case .working: L("list.filter.empty.working")
    case .unread: L("list.filter.empty.unread")
    }
  }
}
