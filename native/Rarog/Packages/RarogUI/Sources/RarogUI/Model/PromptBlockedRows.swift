import Foundation
import RarogContract
import RarogCore

// Notka o prompcie zablokowanym przez hook `UserPromptSubmit` (`docs/dialogs.md`, „Prompt blocked by a hook”) i
// jej przycisk „Uruchom ponownie i wyślij”. Czyste reguły, testowane na macOS (`PromptBlockedRowTests`);
// rysuje `Rows/PromptBlockedRowView`. Właściciel: transkrypt.

/// Notka o prompcie zablokowanym przez hook: trójkąt, stały tytuł, powód od hooka i ewentualny cytat promptu.
public struct PromptBlockedRowModel: Sendable, Equatable {
  /// `m<seq>.b` — z numerem wiadomości, więc znaczniki, pozycja czytania i rozwinięcie działają jak dla treści.
  public let id: String
  /// `seq` wiadomości notki; przycisk stoi tylko pod notką o `seq` z `SessionSummary.promptBlocked`.
  public let seq: Int
  public let voice: VoiceLabel?
  /// Powód od hooka, pod nim cytat promptu (tylko w notce bez dymka promptu) — jeden tekst, zwijany razem.
  public let detail: String
  /// Zwinięcie długiego powodu i cytatu (ponad ``PromptBlockedNote/visibleLines`` linii); `nil` = krótki.
  public let fold: PromptFold?
  /// Przycisk ponownej wysyłki; `nil` = notka bez przycisku (prompt spoza Raroga, starsza blokada, po restarcie
  /// serwera Raroga).
  public let action: PromptBlockedAction?
  public var turn = TurnMark()

  public init(
    id: String, seq: Int, voice: VoiceLabel?, detail: String, fold: PromptFold?, action: PromptBlockedAction?,
    turn: TurnMark = TurnMark()
  ) {
    self.id = id
    self.seq = seq
    self.voice = voice
    self.detail = detail
    self.fold = fold
    self.action = action
    self.turn = turn
  }

  /// Tekst w notce przycięty do ``PromptBlockedNote/visibleLines`` linii układu — tylko zwinięty długi.
  public var clipped: Bool { fold?.expanded == false }
}

/// Przycisk „Uruchom ponownie i wyślij” pod notką: blokada karty, którą odeśle, i stan próby na tym urządzeniu.
public struct PromptBlockedAction: Sendable, Equatable {
  /// `SessionSummary.promptBlocked` karty — całe idzie w ciele restartu (`seq` i `id`).
  public let blocked: SessionPromptBlocked
  /// Restart w toku: żądanie w drodze albo serwer je przyjął, a karta jeszcze niesie tę blokadę.
  public let restarting: Bool
  /// Zdanie odmowy pod przyciskiem (serwer albo sieć); przycisk zostaje.
  public let error: String?

  public init(blocked: SessionPromptBlocked, restarting: Bool, error: String?) {
    self.blocked = blocked
    self.restarting = restarting
    self.error = error
  }
}

/// Próba „Uruchom ponownie i wyślij” na tym urządzeniu, po `id` blokady. Nowa blokada (inne `id`) zaczyna
/// od czystego przycisku.
public struct PromptBlockedAttempt: Sendable, Equatable {
  public let id: String
  /// Serwer przyjął restart (202 po `/exit`): przycisk mówi „Uruchamiam ponownie…”, dopóki karta niesie tę blokadę.
  public var accepted: Bool
  /// Zdanie odmowy pod przyciskiem.
  public var error: String?

  public init(id: String, accepted: Bool = false, error: String? = nil) {
    self.id = id
    self.accepted = accepted
    self.error = error
  }
}

/// Skutek tapnięcia „Uruchom ponownie i wyślij” dla ekranu: nowy stan próby i zdanie dla czytnika.
public struct PromptBlockedResult: Sendable, Equatable {
  public let attempt: PromptBlockedAttempt
  /// Zdanie dla VoiceOver; `nil` = cisza (odmowa blokady, której karta już nie niesie — jej zdania nie widać).
  public let spoken: String?
  /// Odmowa mówi pilnie (jak odmowa decyzji na karcie), przyjęcie zwyczajnie.
  public let urgent: Bool

  public init(attempt: PromptBlockedAttempt, spoken: String?, urgent: Bool) {
    self.attempt = attempt
    self.spoken = spoken
    self.urgent = urgent
  }
}

/// Reguły notki o prompcie zablokowanym przez hook.
public enum PromptBlockedNote {
  /// Wynik żądania → stan próby i ogłoszenie (odmowę stojącą tylko tekstem pod przyciskiem
  /// czytnik musiałby odszukać sam). `nil` = nic nie zmieniać: drugie tapnięcie w trakcie (`.inFlight`) albo
  /// wylogowanie. `current` — blokada, którą karta niesie TERAZ: odmowa starej blokady zostaje cicha, bo jej zdania
  /// na ekranie nie ma; przyjęcie mówi zawsze (karta zdejmuje blokadę już przy `/exit`, przed odpowiedzią 202).
  static func result(
    _ outcome: SessionControlOutcome, blocked: SessionPromptBlocked, current: SessionPromptBlocked?
  ) -> PromptBlockedResult? {
    switch outcome {
    case .accepted:
      return PromptBlockedResult(
        attempt: PromptBlockedAttempt(id: blocked.id, accepted: true), spoken: UICopy.promptBlockedRestarting,
        urgent: false)
    case .inFlight, .loggedOut:
      return nil
    case .notAllowed, .refused, .offline, .timedOut, .failed:
      let message = UICopy.controlMessage(outcome, fallback: UICopy.promptBlockedResendFailed)
        ?? UICopy.promptBlockedResendFailed
      return PromptBlockedResult(
        attempt: PromptBlockedAttempt(id: blocked.id, error: message),
        spoken: current?.id == blocked.id ? message : nil, urgent: true)
    }
  }

  /// Powód z cytatem dłuższy niż tyle linii zwija się do tylu linii.
  public static let visibleLines = 8

  /// Identyfikator wiersza notki o numerze `seq`.
  static func rowId(seq: Int) -> String { "m\(seq).b" }

  /// Powód i cytat jednym tekstem: powód, pod nim „Prompt: …”. Pusty powód i brak cytatu dają pusty tekst.
  static func detail(_ blocked: TranscriptPromptBlocked) -> String {
    var parts: [String] = []
    let reason = blocked.reason.trimmingCharacters(in: .whitespacesAndNewlines)
    if !reason.isEmpty { parts.append(reason) }
    if let prompt = blocked.prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty {
      parts.append(UICopy.promptBlockedQuote(prompt))
    }
    return parts.joined(separator: "\n")
  }

  /// Zwinięcie: linie liczone jak w długim prompcie (``PromptFolds/lines(_:)``, z tekstu, nie z układu), więc
  /// decyzja nie zależy od szerokości, pisma ani obrotu. Krótki tekst stoi cały, bez przycisku.
  static func fold(_ detail: String, expanded: Bool) -> PromptFold? {
    let lines = PromptFolds.lines(detail)
    return lines > visibleLines ? PromptFold(lines: lines, expanded: expanded) : nil
  }

  /// Przycisk karty: blokada z `SessionSummary.promptBlocked` i stan próby. Restart w toku to żądanie w drodze
  /// (`sessionControls.restarting`, wspólne z pigułką „↑”) albo próba przyjęta przez serwer dla TEJ blokady; odmowa
  /// dotyczy tylko tej blokady i znika, gdy restart znów ruszy. `nil` = karta nie ma blokady z przyciskiem.
  static func action(state: AppState, sessionId: String, attempt: PromptBlockedAttempt?) -> PromptBlockedAction? {
    guard let blocked = state.sessions[sessionId]?.promptBlocked else { return nil }
    let mine = attempt?.id == blocked.id ? attempt : nil
    let restarting = state.sessionControls.restarting.contains(sessionId) || mine?.accepted == true
    return PromptBlockedAction(blocked: blocked, restarting: restarting, error: restarting ? nil : mine?.error)
  }

  /// Wiersz notki. Przycisk tylko pod notką, której `seq` wskazuje karta (`SessionSummary.promptBlocked.seq`).
  static func row(
    _ message: TranscriptMessage, _ blocked: TranscriptPromptBlocked, voice: VoiceLabel?, reading: TranscriptReading,
    action: PromptBlockedAction?
  ) -> PromptBlockedRowModel {
    let id = rowId(seq: message.seq)
    let detail = detail(blocked)
    return PromptBlockedRowModel(
      id: id, seq: message.seq, voice: voice, detail: detail,
      fold: fold(detail, expanded: reading.expandedPrompts.contains(id)),
      action: action?.blocked.seq == message.seq ? action : nil)
  }
}
