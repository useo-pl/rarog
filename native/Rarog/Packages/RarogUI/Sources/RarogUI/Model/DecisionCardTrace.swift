import Foundation
import RarogContract
import RarogCore

// Pomiar okresu łaski przed kartą „dialog w terminalu” (``DecisionGraceTiming``): ile czasu od wejścia
// sesji w „czeka” minęło, zanim ekran pokazał PIERWSZĄ kartę, i jaka to karta. Same fakty — rodzaj karty, czas w ms,
// końcówka identyfikatora sesji — bez treści komendy. Linię składa `DiagnosticsTrace.decisionCard`,
// wysyła ekran sesji (`+DecisionGrace`). Właściciel: karty.

/// Przejście „czeka bez karty” → pierwsza karta na ekranie sesji. Linia wychodzi raz na czekanie i tylko wtedy, gdy
/// ten ekran widział czekanie bez karty przy znanym transkrypcie: karta zastana przy wejściu (także razem z pierwszą
/// migawką) nie mierzy niczego.
public struct DecisionCardTrace: Sendable, Equatable {
  /// Rodzaj pierwszej karty.
  public enum Kind: Sendable, Equatable {
    /// Karta kanału zgód (`channel: hook`).
    case permissionHook
    /// Karta zgody z wpisu jsonl.
    case permissionJsonl
    /// Karta zgody z samego ekranu (`permId` `screen:…`, `decideReqId` serwera) — tylko do śladu, nie do decyzji.
    case permissionScreen
    case question
    /// Karta zapasowa „dialog w terminalu” — po okresie łaski albo po ocenie drivera.
    case fallbackDialog
  }

  public struct Arrival: Sendable, Equatable {
    public let kind: Kind
    /// Od wejścia w „czeka” (``DecisionWaitStart/at``); `nil` = czas wejścia niepewny.
    public let milliseconds: Int?
    public let sessionId: String
  }

  /// Czekanie (`HerdrDialogCards.identity`), które ten ekran widział bez karty.
  private var bare: String?
  /// Czekanie, którego pierwszą kartę już zapisano: zniknięcie karty w tym samym czekaniu nie uzbraja pomiaru znowu.
  private var logged: String?

  public init() {}

  /// Po każdym renderze: wynik = linia do śladu (raz na czekanie), `nil` = nic do zapisania.
  public mutating func observe(state: AppState, sessionId: String, rows: [TranscriptRow], now: Date) -> Arrival? {
    guard let session = state.sessions[sessionId], session.isWaitingForDecision else {
      bare = nil
      logged = nil
      return nil
    }
    let identity = HerdrDialogCards.identity(session)
    // Przed pierwszą migawką transkryptu kart nie znamy: to nie jest „czekanie bez karty”.
    if rows.contains(.loading) { return nil }
    guard let kind = rows.lazy.compactMap(Self.kind).first else {
      if logged != identity { bare = identity }
      return nil
    }
    guard bare == identity else { return nil }
    bare = nil
    logged = identity
    let wait = state.cards.decisionWaits[sessionId]
    let start = wait?.stateSince == session.stateSince ? wait?.at : nil
    let milliseconds = start.map { max(0, Int((now.timeIntervalSince($0) * 1000).rounded())) }
    return Arrival(kind: kind, milliseconds: milliseconds, sessionId: sessionId)
  }

  private static func kind(_ row: TranscriptRow) -> Kind? {
    switch row {
    case let .permission(card):
      if card.hookChannel { return .permissionHook }
      return card.permId.hasPrefix("screen:") ? .permissionScreen : .permissionJsonl
    case let .question(card): return card.held ? nil : .question
    case .herdrDialog: return .fallbackDialog
    default: return nil
    }
  }
}
