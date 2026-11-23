import Foundation
import RarogContract
import RarogCore

// Projekty i zakładki. Właściciel: projekty.
extension UICopy {
  // MARK: Sekcja PROJEKTY

  public static var projectOpenSpoken: String { L("projects.openSpoken") }
  public static var projectJumpSpoken: String { L("projects.jumpSpoken") }

  /// „1 agent", „agentów: 3" — forma z dwukropkiem omija rodzaj męskoosobowy przy liczebnikach (wariant liczby mnogiej).
  public static func agentsSpoken(_ count: Int) -> String { L("projects.agentsSpoken", count) }

  /// Zdanie czytnika dla rozjazdu z upstreamem.
  public static func aheadSpoken(_ count: Int) -> String { L("projects.aheadSpoken", count) }
  public static func behindSpoken(_ count: Int) -> String { L("projects.behindSpoken", count) }

  // MARK: Pasek zakładek

  public static var tabsLabel: String { L("projects.tabsLabel") }
  public static var newSessionInProject: String { L("projects.newSessionInProject") }
  public static var newSessionBusy: String { L("projects.newSessionBusy") }
  public static var launchBlockedFallback: String { L("projects.launchBlockedFallback") }
  public static var createFailed: String { L("projects.createFailed") }
  /// Ostrzeżenie po założeniu sesji w katalogu, którego Claude Code jeszcze nie znał.
  /// „Może poprosić", nie „poprosi": przy części ustawień konta dialog nie staje wcale.
  public static var trustPrompt: String { L("projects.trustPrompt") }

  /// Napis zakładki: człon sesji, a bez niego cztery znaki identyfikatora — trzy zakładki „sesja"
  /// obok siebie nie niosłyby informacji.
  public static func tabLabel(_ session: SessionSummary) -> String {
    let label = (session.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return label.isEmpty ? "#\(session.id.prefix(4))" : label
  }

  /// Zdanie czytnika zakładki: bieżąca mówi samą nazwę i stan, siostra — dokąd prowadzi. Słowo stanu przy
  /// czekaniu na zadanie w tle jest takie jak przy ciszy, więc ton dochodzi własnym słowem.
  public static func tabSpoken(_ session: SessionSummary, current: Bool) -> String {
    var parts = [tabLabel(session), RowStatus(session).text]
    if session.statusTone == .backgroundWait { parts.append(toneSpoken(.backgroundWait)) }
    let base = list(parts, .comma)
    return current ? base : L("projects.tabSpoken", base)
  }

  /// Zdanie, dlaczego „+" jest wygaszony: zdanie serwera, a bez niego copy zapasowe.
  public static func launchBlocked(_ detail: String?) -> String {
    let trimmed = (detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? launchBlockedFallback : trimmed
  }

  /// Wynik „+" do pokazania pod paskiem; `nil` = bez zdania (sukces, wylogowanie).
  public static func createMessage(_ outcome: CreateSessionOutcome) -> String? {
    switch outcome {
    case let .created(_, trustPrompt): trustPrompt ? self.trustPrompt : nil
    case let .blocked(detail): launchBlocked(detail)
    case let .refused(message): message ?? createFailed
    case .offline: serverSilent
    case .timedOut: timedOut
    case .failed: createFailed
    case .loggedOut: nil
    }
  }

  // MARK: Nagłówek sesji

  /// Sesja jeszcze nieznana liście: bez nazwy projektu i bez zakładek.
  public static var unknownSessionTitle: String { L("projects.unknownSessionTitle") }
  public static var sessionStarting: String { L("projects.sessionStarting") }
  public static var projectEmpty: String { L("projects.empty") }

  // MARK: Zamknięcie sesji

  public static var closePanel: String { L("projects.closePanel") }
  public static var forgetCard: String { L("projects.forgetCard") }
  public static var confirmQuestion: String { L("projects.confirmQuestion") }
  public static var closeFailed: String { L("projects.closeFailed") }
  public static var cancel: String { L("projects.cancel") }

  /// Etykieta „×": mówi skutek — karta `done` nie ma już panelu, więc „×" tylko ją zdejmuje.
  public static func closeLabel(_ session: SessionSummary) -> String {
    session.closeForgetsCard ? forgetCard : closePanel
  }

  /// Zdanie po pierwszym naciśnięciu (uzbrojenie na 5 s).
  public static func closeArmed(_ session: SessionSummary) -> String {
    session.closeForgetsCard
      ? L("projects.closeArmed.forgetCard")
      : L("projects.closeArmed.closePanel")
  }

  /// Wynik zamknięcia do pokazania; `nil` = bez zdania.
  public static func closeMessage(_ outcome: CloseSessionOutcome) -> String? {
    switch outcome {
    case .closed, .loggedOut: nil
    case .notAllowed: CoreCopy.unsupportedSession
    case let .refused(message): message ?? closeFailed
    case .offline: serverSilent
    case .timedOut: timedOut
    case .failed: closeFailed
    }
  }
}
