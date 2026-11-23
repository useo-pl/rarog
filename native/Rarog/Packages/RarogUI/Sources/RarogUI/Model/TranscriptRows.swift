import Foundation
import RarogContract
import RarogCore

/// Etykieta głosu („ty", „agent", „system") — stoi tylko przy ZMIANIE głosu.
public typealias VoiceLabel = MessageRole

/// Stan karty zgody z punktu widzenia tego urządzenia.
public enum CardPhase: Sendable, Equatable {
  /// Można decydować.
  case idle
  /// Żądanie w drodze.
  case sending(PermissionDecision)
  /// Serwer przyjął — karta zniknie, gdy przyjdzie rozstrzygnięcie.
  case sent(PermissionDecision)
}

/// Karta zgody w transkrypcie.
public struct PermissionCardModel: Sendable, Equatable {
  public let permId: String
  public let sessionId: String
  public let eyebrow: String
  public let toolName: String
  public let risky: Bool
  public let plan: Bool
  public let cwd: String
  public let command: String
  /// Kolory składni bloku komendy, zakresy w UTF-16 ``command``. Niepuste wyłącznie dla komendy powłoki
  /// (`inputKind: shell` od serwera) na karcie, która nie jest planem; reszta karty zostaje bez koloru.
  public let commandSyntax: [SyntaxToken]
  public let createdAt: Date?
  /// `false` = przycisk „Zatwierdź" NIE ISTNIEJE (fail-closed).
  public let canAllow: Bool
  /// Wycinek ekranu terminala przy karcie bez zatwierdzania.
  public let screen: String?
  /// Klasa dialogu z rejestru CLI przy karcie bez zatwierdzania; `nil` przy karcie z decyzją.
  public let cliDialog: CliDialogClass?
  public let phase: CardPhase
  /// Zdanie po nieudanej decyzji (karta zostaje: 422, błąd sieci, bramka).
  public let error: String?
  /// Powód, dla którego karta jest bez decyzji (sesja nieobsługiwana, herdr niedostępny/tylko odczyt).
  public let lockedReason: String?
  /// DOSŁOWNA etykieta opcji eskalującej od serwera; `nil` = przycisku nie ma.
  /// Na karcie planu to przejście w tryb auto.
  public let alwaysLabel: String?
  /// Zdanie informacyjne pod kartą (karta kanału po decyzji z innego urządzenia).
  public let note: String?
  /// Karta kanału zgód: odpowiedź plikiem dla hooka, stan i przyciski od serwera.
  public var hookChannel = false
  /// Pola wejścia poza komendą (karta kanału), pod blokiem komendy.
  public var consentFields: [ConsentInputField] = []
  /// Ostrzeżenie o wyłączonym sandboksie — tylko przy karcie z uwagą `sandbox-disabled`.
  public var sandboxWarning: String?
  /// Zdanie stanu karty kanału („Biegnie, czekam na wynik.”); `nil` = karta czeka na decyzję.
  public var consentStatus: String?
  /// Karta kanału czeka na decyzję (hook słucha): wolno ją odrzucić.
  public var awaitingDecision = false
  /// Why the card cannot be allowed: a channel card, or a screen card without the approve button whose server sent
  /// the reason.
  public var consentUnavailable: ConsentUnavailableReason?
  /// The whole input when the block shows a preview (``ConsentInputPreview``); `nil` = the card shows everything.
  public var fullInput: ConsentFullInput?
  /// The window with the whole input appeared for this card on this screen (``TranscriptUIState/fullInputRead``).
  public var fullInputRead = false

  /// Plan wraca do auto wyłącznie opcją, którą serwer dołączył do semantycznej karty planu.
  /// Zwykła zgoda zostaje jednorazowa; bez opcji auto planu nie zatwierdzamy ręcznie. Karta planu kanału zgód nie
  /// ma opcji auto: jedna zgoda hooka, po której sesja wraca do trybu sprzed planu.
  public var primaryDecision: PermissionDecision? {
    guard canAllow else { return nil }
    if hookChannel { return .allow }
    return plan ? (alwaysLabel == nil ? nil : .allowAlways) : .allow
  }

  /// Tytuł przycisku zgody: karta planu kanału „Zatwierdź plan”, karta planu z ekranu „Zatwierdź i wróć do auto”.
  public var allowTitle: String {
    guard plan else { return UICopy.allow }
    return hookChannel ? UICopy.consentAllowPlan : UICopy.allowPlanAuto
  }

  /// A consent waits for the whole input on screen: the block shows a preview and the
  /// window with the whole input has not appeared for this card. "Allow", "always" and the plan approval stay greyed.
  public var consentAwaitsFullInput: Bool { fullInput != nil && !fullInputRead }

  /// Whether `decision` may leave the card now: deny always, a consent only after the window with the whole input.
  public func permits(_ decision: PermissionDecision) -> Bool { decision == .deny || !consentAwaitsFullInput }

  /// The line by the greyed consent buttons: open the whole request first; `nil` = no greyed button on the card.
  public var fullInputHint: String? {
    guard consentAwaitsFullInput, primaryDecision != nil, phase == .idle, lockedReason == nil else { return nil }
    return plan ? UICopy.consentOpenFullToApprove : UICopy.consentOpenFullToAllow
  }

  /// Zdanie pod planem kanału, który da się zatwierdzić: po zgodzie sesja wraca do trybu sprzed planu.
  public var planNote: String? { hookChannel && plan && primaryDecision != nil ? UICopy.consentPlanReturns : nil }

  /// „Odrzuć” na karcie: karta kanału ma je tylko, gdy czeka na decyzję (potem hook już nie słucha).
  public var canDeny: Bool { !hookChannel || awaitingDecision }

  public var approvalUnavailable: String? {
    // Karta kanału: powód od serwera; poza oczekiwaniem na decyzję mówi zdanie stanu.
    if hookChannel { return canAllow || !awaitingDecision ? nil : UICopy.consentUnavailable(consentUnavailable) }
    // A screen card with the server's reason says that reason; without it, the CLI class sentence
    // before "deny only": what is waiting, then why only Deny.
    if !canAllow, let consentUnavailable { return UICopy.consentUnavailable(consentUnavailable) }
    if !canAllow { return UICopy.cliDialogText(cliDialog, then: UICopy.denyOnly) }
    return plan && alwaysLabel == nil ? UICopy.planAutoUnavailable : nil
  }

  /// Nagłówek karty dla czytnika: rodzaj, narzędzie, katalog.
  public var spokenHeader: String {
    var parts: [String] = []
    parts.append(plan ? UICopy.permissionPlanSpoken : UICopy.permissionToolSpoken(toolName))
    if risky { parts.append(UICopy.permissionRiskySpoken) }
    parts.append(UICopy.permissionDirectorySpoken(cwd))
    return UICopy.list(parts, .comma)
  }
}

/// The status of an outbox entry under its text. Owner: send.
public enum PendingStatus: Sendable, Equatable {
  case unconfirmed
  case refused(String)
  /// A refusal that "Retry" will not fix (the content file is gone, an identifier conflict): "Discard" alone.
  case refusedFinal(String)
  /// Stopped in the progress ring before the request: "Sending stopped." with "Retry" and "Discard".
  case stopped
  /// A queued entry while the session's queue is being taken back into the field: "Taking back…", no buttons,
  /// until the server answers.
  case takingBack
}

/// Odstęp nad wierszem wynikający z granicy tury. Granice liczy się na poziomie
/// WIADOMOŚCI, a niesie je pierwszy widoczny wiersz bloku wiadomości (także znacznik nad nią, rozwijak serii, zdjęcie).
public enum TurnGap: Sendable, Equatable {
  /// Reguła wiersza: przy zmianie głosu 12 pt, w ciągu jednego głosu odstęp pierwszego bloku tekstu albo 2 pt.
  case flow
  /// Pierwszy widoczny wiersz wiadomości człowieka (w locie i z samym zdjęciem też) — nowa tura.
  case turn
  /// Pierwszy widoczny wiersz po wiadomości człowieka — odpowiedź trzyma się promptu.
  case afterPrompt
  /// Zdjęcia promptu pod jego dymkiem: 6 pt pod dymkiem — 4 pt nad wierszem i 2 pt dolnego marginesu dymku.
  case underPlate

  /// Points above the row at the transcript's density; `nil` = the row rule (``flow``).
  public func points(_ spacing: TranscriptSpacing) -> Double? {
    switch self {
    case .flow: nil
    case .turn: spacing.turn
    case .afterPrompt: spacing.afterPrompt
    case .underPlate: spacing.underPlate
    }
  }
}

/// Miejsce wiersza w turze rozmowy i ozdoby wiersza promptu (nagłówek, godzina, zwinięcie). Wiersz bez granicy tury
/// ma wartość domyślną.
public struct TurnMark: Sendable, Equatable {
  public var gap: TurnGap
  /// Pierwszy wiersz wiadomości człowieka: VoiceOver dostaje cechę nagłówka RAZ na prompt i skacze po promptach.
  public var promptHead: Bool
  /// The message time ("14:05"). A prompt has it by its bubble, on the LAST row of the human message (text or
  /// photos); a closed agent reply has it under its last agent text row.
  public var clock: String?
  /// Długi tekst wiadomości człowieka zwinięty do 6 linii, na wierszu tekstu echa i wpisu w locie; `nil` = krótki.
  public var fold: PromptFold?

  public init(gap: TurnGap = .flow, promptHead: Bool = false, clock: String? = nil, fold: PromptFold? = nil) {
    self.gap = gap
    self.promptHead = promptHead
    self.clock = clock
    self.fold = fold
  }
}

/// Separator czasu nad wiadomością: godzina po przerwie ≥ 10 min (nie nad promptem —
/// tam godzina stoi przy dymku) albo data przy zmianie dnia kalendarzowego (także nad promptem).
public struct TimeMark: Sendable, Equatable {
  /// Zmiana dnia: „pt. 9 paź”; `nil` = sama przerwa.
  public let day: String?
  /// Zmiana dnia dla czytnika, forma na początek zdania (stoi pierwsza w `UICopy.timeGapSpoken`): „Piątek,
  /// 9 października”. Wielką literę daje formatter daty (`TimeGap.spokenDay`), nie przeróbka tekstu.
  public let spokenDay: String?
  /// „14:05”; `nil` przy dacie nad promptem (godzinę niesie dymek).
  public let clock: String?

  public init(day: String? = nil, spokenDay: String? = nil, clock: String?) {
    self.day = day
    self.spokenDay = spokenDay
    self.clock = clock
  }
}

/// Jeden wiersz transkryptu. `id` jest stabilny między renderami (diffable data source).
public enum TranscriptRow: Sendable, Equatable, Identifiable {
  /// Przed pierwszym stanem: szkielet, nie fałszywe zaproszenie.
  case loading
  case empty(text: String, sub: String?)
  case text(id: String, role: MessageRole, voice: VoiceLabel?, markdown: String, turn: TurnMark = TurnMark())
  /// Karta narzędzia: linia „Narzędzie: cel", rozwinięcie, mini-diff.
  case tool(ToolRowModel)
  /// Załączniki wpisu kolejki: miniatury z pliku na urządzeniu w układzie przyszłego echa i pierścień
  /// postępu na nich. Właściciel: wysyłka.
  case attachments(PendingMediaModel)
  case unsupported(id: String, voice: VoiceLabel?, turn: TurnMark = TurnMark())
  /// Otwarta (płynąca) wiadomość agenta.
  case open(voice: VoiceLabel?, markdown: String, turn: TurnMark = TurnMark())
  /// Wpis kolejki — przygaszony, w układzie wiadomości człowieka.
  /// Wpis kolejki; `inFlight` = jeszcze czeka na podjęcie albo echo (poświata dymka). „Nie potwierdzono” i odmowa
  /// zostają przygaszone, ale bez poświaty — zmiana stanu zmienia wiersz, więc komórka się przebudowuje.
  /// `queued` = serwer przyjął, prompt czeka w kolejce CLI (bywa minutami): dymek przygaszony z poświatą
  /// jak każdy wpis w locie, czytnik słyszy „w kolejce”.
  /// `replaysTakeBack` = Not confirmed while the session keeps a queue take-back without an answer: like a queued
  /// bubble, its tap and VoiceOver action replay the take-back. The flag stands in the row, so the cell is
  /// reconfigured when the id goes.
  /// `takingBack` = a queued entry while the session's queue take-back waits for the server's answer: the bubble
  /// dims further and VoiceOver hears it; the status row under it says the same.
  case pending(
    entry: UUID, voice: VoiceLabel?, text: String, inFlight: Bool = true, queued: Bool = false,
    replaysTakeBack: Bool = false, takingBack: Bool = false, turn: TurnMark = TurnMark())
  /// `retrying` = „Ponów" w toku: przycisk zablokowany do końca operacji (każdy wynik go odblokowuje).
  case pendingStatus(entry: UUID, status: PendingStatus, retrying: Bool)
  case permission(PermissionCardModel)
  case question(QuestionCardModel)
  case notice(id: String, text: String)
  /// Separator czasu: `— HH:MM —` po przerwie ≥ 10 min albo data przy zmianie dnia.
  /// Właściciel: transkrypt.
  case timeGap(id: String, mark: TimeMark, turn: TurnMark = TurnMark())
  /// Linia „NOWE" przed pierwszą wiadomością nowszą niż ostatnia wizyta.
  case newMarker(turn: TurnMark = TurnMark())
  /// Rozwijak zwiniętej serii narzędzi nad najnowszym krokiem.
  case toolRun(ToolRunModel)
  /// Karta „dialog w terminalu" — sesja czeka, a karty z treścią nie ma. Właściciel: karty.
  case herdrDialog(HerdrDialogCardModel)
  /// Zastępnik karty decyzji w okresie łaski (``DecisionGraceTiming``): sesja czeka, karty z treścią jeszcze nie ma,
  /// a karta zapasowa „dialog w terminalu” stanęłaby za wcześnie. Bez przycisków i bez ogłoszenia. Właściciel: karty.
  case decisionPending
  /// Notka harnessu: jedno zdanie systemowe zamiast surowego wpisu. Właściciel: notki i miniatury.
  case harnessNotice(HarnessNoticeModel)
  /// Zdjęcia (miniatury) i chipy plików wiadomości albo galeria obrazków z treści. Właściciel: notki i miniatury.
  case media(MediaRowModel)
  /// Notka o prompcie zablokowanym przez hook, z przyciskiem „Uruchom ponownie i wyślij” pod notką, którą wskazuje
  /// karta. Właściciel: transkrypt.
  case promptBlocked(PromptBlockedRowModel)
  /// Ślad własnej decyzji: cichy wiersz na miejscu decyzji, „Zatwierdzono: Bash · npm test”.
  /// Właściciel: karty.
  case decisionTrace(DecisionTraceRowModel)

  public var id: String {
    switch self {
    case .loading: "loading"
    case .empty: "empty"
    case let .text(id, _, _, _, _), let .unsupported(id, _, _), let .notice(id, _), let .timeGap(id, _, _):
      id
    case let .attachments(model): model.id
    case let .harnessNotice(model): model.id
    case let .media(model): model.id
    case let .promptBlocked(model): model.id
    case let .decisionTrace(model): model.id
    case let .tool(model): model.id
    case .newMarker: "new"
    case let .toolRun(model): model.rowId
    case .open: "open"
    case let .pending(entry, _, _, _, _, _, _, _): "o\(entry.uuidString)"
    case let .pendingStatus(entry, _, _): "s\(entry.uuidString)"
    case let .permission(card): "p\(card.permId)"
    case let .question(card): "q\(card.qId)"
    case .herdrDialog: "dialog"
    case .decisionPending: "decisionPending"
    }
  }

  /// Wiersze, które niosą tekst do zaznaczania (UIKit `UITextView`), a nie kartę SwiftUI.
  public var isTextual: Bool {
    switch self {
    case .text, .open, .pending: true
    default: false
    }
  }

  /// Miejsce w turze; wiersze kart, statusów i szkieletów go nie mają (wartość domyślna).
  public var turn: TurnMark {
    switch self {
    case let .text(_, _, _, _, turn), let .unsupported(_, _, turn), let .open(_, _, turn), let .pending(_, _, _, _, _, _, _, turn),
      let .timeGap(_, _, turn), let .newMarker(turn):
      turn
    case let .tool(model): model.turn
    case let .toolRun(model): model.turn
    case let .media(model): model.turn
    case let .attachments(model): model.turn
    case let .harnessNotice(model): model.turn
    case let .promptBlocked(model): model.turn
    case let .decisionTrace(model): model.turn
    case .loading, .empty, .pendingStatus, .permission, .question, .notice, .herdrDialog, .decisionPending: TurnMark()
    }
  }

  /// Ustawia miejsce w turze wierszom, które je niosą; reszta bez zmian.
  mutating func setTurn(_ turn: TurnMark) {
    switch self {
    case let .text(id, role, voice, markdown, _): self = .text(id: id, role: role, voice: voice, markdown: markdown, turn: turn)
    case let .unsupported(id, voice, _): self = .unsupported(id: id, voice: voice, turn: turn)
    case let .open(voice, markdown, _): self = .open(voice: voice, markdown: markdown, turn: turn)
    case let .pending(entry, voice, text, inFlight, queued, replays, takingBack, _):
      self = .pending(
        entry: entry, voice: voice, text: text, inFlight: inFlight, queued: queued, replaysTakeBack: replays,
        takingBack: takingBack, turn: turn)
    case let .timeGap(id, mark, _): self = .timeGap(id: id, mark: mark, turn: turn)
    case .newMarker: self = .newMarker(turn: turn)
    case var .tool(model):
      model.turn = turn
      self = .tool(model)
    case var .toolRun(model):
      model.turn = turn
      self = .toolRun(model)
    case var .media(model):
      model.turn = turn
      self = .media(model)
    case var .attachments(model):
      model.turn = turn
      self = .attachments(model)
    case var .harnessNotice(model):
      model.turn = turn
      self = .harnessNotice(model)
    case var .promptBlocked(model):
      model.turn = turn
      self = .promptBlocked(model)
    case var .decisionTrace(model):
      model.turn = turn
      self = .decisionTrace(model)
    case .loading, .empty, .pendingStatus, .permission, .question, .notice, .herdrDialog, .decisionPending: break
    }
  }

  /// Wiersz zdjęć (z serwera albo wpisu w locie) — pod dymkiem promptu stoi 6 pt niżej.
  var isMedia: Bool {
    switch self {
    case .media, .attachments: true
    default: false
    }
  }
}

extension [TranscriptRow] {
  /// Wiersze jednej wiadomości człowieka: pierwszy niesie cechę nagłówka (raz na prompt), ostatni — godzinę przy
  /// dymku, a zdjęcia pod tekstem stoją tuż pod dymkiem. Długi tekst zwija się do 6 linii, rozwinięty kluczem
  /// wiersza z `expanded` — ta sama reguła dla echa i wpisu w locie, więc dymek nie skacze przy echu.
  mutating func markPrompt(clock: String?, expanded: Set<String> = []) {
    guard !isEmpty else { return }
    for index in indices {
      var turn = self[index].turn
      turn.promptHead = index == startIndex
      turn.clock = index == endIndex - 1 ? clock : nil
      if index > startIndex, self[index].isMedia { turn.gap = .underPlate }
      let row = self[index]
      turn.fold = row.promptText.flatMap { PromptFolds.fold($0, expanded: expanded.contains(row.id)) }
      self[index].setTurn(turn)
    }
  }
}

extension TranscriptRow {
  /// Tekst wiersza, który może zwinąć się jako długi prompt: blok tekstu wiadomości albo tekst wpisu w locie.
  var promptText: String? {
    switch self {
    case let .text(_, _, _, markdown, _): markdown
    case let .pending(_, _, text, _, _, _, _, _): text
    default: nil
    }
  }

  /// A text row of an agent reply: the only row that carries the reply's time.
  var isAgentText: Bool {
    switch self {
    case let .text(_, role, _, _, _): role == .assistant
    default: false
    }
  }
}

/// Granice tur w ciągu bloków wiadomości. Blok to wiersze jednej wiadomości razem
/// ze znacznikami nad nią; granicę niesie jego PIERWSZY widoczny wiersz. Pierwszy blok listy granicy nie dostaje —
/// nad nim nic nie stoi.
struct TurnBoundaries {
  private enum Last { case none, prompt, other }
  private var last = Last.none

  /// Oznacza pierwszy wiersz bloku i zapamiętuje, czy blok był wiadomością człowieka.
  mutating func mark(_ block: inout [TranscriptRow], prompt: Bool) {
    guard !block.isEmpty else { return }
    let gap: TurnGap = switch last {
    case .none: .flow
    case _ where prompt: .turn
    case .prompt: .afterPrompt
    case .other: .flow
    }
    var turn = block[0].turn
    turn.gap = gap
    block[0].setTurn(turn)
    last = prompt ? .prompt : .other
  }

  /// Bloki wpisów kolejki stoją pod treścią: przed nimi ZAWSZE coś jest (treść, szkielet albo pusty transkrypt).
  mutating func continueAfterContent() {
    if case .none = last { last = .other }
  }
}

/// Lokalny stan ekranu sesji na tym urządzeniu (czego rdzeń nie trzyma, bo to tylko widok).
public struct TranscriptUIState: Sendable, Equatable {
  /// Zdanie pod kartą po nieudanej decyzji.
  public var errors: [String: String] = [:]
  /// Wpisy kolejki, których „Ponów" właśnie trwa.
  public var retrying: Set<UUID> = []
  /// Rozwinięcia kart i serii, zbocze decyzji, linia „NOWE". Właściciel: transkrypt.
  public var reading = TranscriptReading()
  /// Karty pytań: szkice, odpowiedzi w drodze, potwierdzenia w oknie, zdania pod kartą
  /// (`Model/QuestionCardState`). Właściciel: karty pytań.
  public var questions = QuestionCardsUI()
  /// Karta dialogu w panelu: decyzja w locie, zdanie wyniku, uzbrojenie. Właściciel: karty.
  public var dialog: DialogCardUI?
  /// Zdanie informacyjne pod kartą zgody, po `permId`. Właściciel: karty.
  public var notes: [String: String] = [:]
  /// Cards whose window with the whole input appeared on this screen, by `permId`, and the windows this screen opened
  /// for them. Owner: cards.
  public var fullInputRead = FullInputMarks()
  /// „Uruchom ponownie i wyślij” pod notką blokady: przyjęcie albo odmowa ostatniej próby, po `id` blokady.
  public var promptBlocked: PromptBlockedAttempt?

  public init() {}
}

/// Składanie wierszy jest rozcięte per obszar: wiadomości w `TranscriptRows+Messages`, kolejka,
/// karty i ślady pod treścią w `TranscriptRows+Tail`. Enum ``TranscriptRow`` zostaje w tym pliku
/// (Swift nie rozszerza enumów) — nowy przypadek dopisuje się na końcu listy.
public enum TranscriptRows {
  /// Kalendarz godzin i dat transkryptu: gregoriański w strefie urządzenia (testy wstrzykują własny).
  public static var deviceCalendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    return calendar
  }

  /// Składa wiersze ekranu sesji z czystego stanu rdzenia. `calendar` daje strefę godzin przy dymku i dni separatorów,
  /// `now` — chwilę, wobec której liczy się okres łaski przed kartą „dialog w terminalu” (``DecisionGraceTiming``).
  /// `docked`: karta, która stoi w doku w miejscu pola (`DecisionDock`) — nie jest wierszem transkryptu.
  /// `dockedPending`: w doku stoi zastępnik okresu łaski (`DecisionDock.Placement.pending`), więc nie ma go w ogonie.
  public static func build(
    state: AppState, sessionId: String, ui: TranscriptUIState = TranscriptUIState(), docked: DecisionCard? = nil,
    dockedPending: Bool = false, calendar: Calendar = deviceCalendar, now: Date = Date()
  ) -> [TranscriptRow] {
    let session = state.sessions[sessionId]
    switch state.transcriptPhase(for: sessionId) {
    case .loading, .unknownSession:
      return [.loading]
        + tail(
          state: state, sessionId: sessionId, session: session, ui: ui, docked: docked, dockedPending: dockedPending,
          previous: nil, calendar: calendar, now: now)
    case let .empty(sessionState):
      let copy = UICopy.emptyTranscript(sessionState)
      // Decyzja przy pustym transkrypcie: ślad pod zdaniem pustego transkryptu.
      var traces = TraceQueue(state.transcripts[sessionId] ?? TranscriptState())
      return [.empty(text: copy.text, sub: copy.sub)] + traces.rest()
        + tail(
          state: state, sessionId: sessionId, session: session, ui: ui, docked: docked, dockedPending: dockedPending,
          previous: nil, calendar: calendar, now: now)
    case .content:
      break
    }
    guard let view = state.transcripts[sessionId] else { return [.loading] }
    let blocked = PromptBlockedNote.action(state: state, sessionId: sessionId, attempt: ui.promptBlocked)
    let content = messageRows(
      view, reading: ui.reading, calendar: calendar, promptBlocked: blocked,
      turnEnded: turnEnded(session: session, view: view))
    return content.rows
      + tail(
        state: state, sessionId: sessionId, session: session, ui: ui, docked: docked, dockedPending: dockedPending,
        previous: content.previous, calendar: calendar, now: now)
  }
}
