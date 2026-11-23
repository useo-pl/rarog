import Foundation
import RarogCore

// Ślad czasu otwarcia terminala w `client.log`: ile minęło od pokazania
// ekranu do narysowania pierwszego ekranu i z czego się to składa — `POST`, gniazdo, pierwsze bajty, okno pierwszego
// ekranu (`TerminalScreenViewController.firstScreenWindow`). Czasy połączenia daje sesja (`TerminalConnectTiming`),
// chwilę pojawienia się i narysowania ekran. W linii same liczby i słowa stałe, zero treści terminala.
// Logika bez UIKit testuje się na macOS. Właściciel: terminal.

public enum TerminalOpenTrace {
  /// Skąd się wziął pierwszy ekran — słowo w nawiasie śladu. Ekran z parkingu nie łączy się od nowa i ma
  /// własną linię (``parked(after:live:)``).
  public enum Origin: Sendable, Equatable {
    /// Nowy ekran: od `viewIsAppearing`, które wystartowało sesję, do narysowania.
    case newScreen(appeared: ContinuousClock.Instant)
    /// Powrót apki z tła: od wznowienia sesji (nowe gniazdo) do narysowania.
    case returnFromBackground
  }

  /// „terminal: pierwszy ekran 412 ms (nowy ekran; POST 118 ms, gniazdo 205 ms, bajty 9 ms, okno 80 ms)".
  /// Gniazdo liczy się od końca `POST` (pominięty: od startu próby) do otwarcia, bajty od otwarcia do pierwszych
  /// bajtów, okno od pierwszych bajtów do narysowania. `POST` po odmowie liczy się od startu próby, razem z odrzuconym
  /// gniazdem.
  public static func line(_ origin: Origin, timing: TerminalConnectTiming, drawn: ContinuousClock.Instant) -> String {
    let (from, kind) = switch origin {
    case let .newScreen(appeared): (appeared, "nowy ekran")
    case .returnFromBackground: (timing.started, "powrót z tła")
    }
    let post = switch timing.open {
    case let .answered(at): "POST \(milliseconds(at - timing.started)) ms"
    case .skipped: "POST pominięty"
    case let .answeredAfterRefusal(at): "POST po odmowie \(milliseconds(at - timing.started)) ms"
    }
    let socket = milliseconds(timing.socketOpened - timing.openEnded)
    let bytes = milliseconds(timing.firstBytes - timing.socketOpened)
    let window = milliseconds(drawn - timing.firstBytes)
    return "terminal: pierwszy ekran \(milliseconds(drawn - from)) ms (\(kind); \(post), gniazdo \(socket) ms, "
      + "bajty \(bytes) ms, okno \(window) ms)"
  }

  /// „terminal: ekran z parkingu po 34 s (gniazdo żywe)": ekran wziął z parkingu tab albo okno, więc nie było
  /// `POST`, nowego gniazda ani okna pierwszego ekranu. `live == false` = sesja w trakcie ponowienia (gniazdo
  /// zerwane w parkingu): „łączy się". Sekundy pełne, w dół.
  public static func parked(after duration: Duration, live: Bool) -> String {
    let seconds = max(0, Int((duration / .seconds(1)).rounded(.down)))
    return "terminal: ekran z parkingu po \(seconds) s (\(live ? "gniazdo żywe" : "łączy się"))"
  }

  /// Pełne milisekundy, nigdy ujemne.
  static func milliseconds(_ duration: Duration) -> Int {
    max(0, Int((duration / .milliseconds(1)).rounded()))
  }
}

/// Podbudżet śladów otwarcia: najwyżej ``cap`` linii na ``window``. Budżet śladów apki (`ContractReporter.traceCap`,
/// 20 na godzinę) jest wspólny, a terminal otwiera się często — bez podbudżetu zjadłby miejsce innym śladom.
public struct TerminalOpenTraceBudget: Sendable, Equatable {
  public static let cap = 6
  public static let window: Duration = .seconds(3600)
  private var windowStart: ContinuousClock.Instant?
  private var admitted = 0

  public init() {}

  /// `true` = zapisać ślad (i odliczyć go z budżetu). Okno liczy się od pierwszego śladu po poprzednim oknie.
  public mutating func admit(now: ContinuousClock.Instant) -> Bool {
    if let start = windowStart, now - start < Self.window {
      guard admitted < Self.cap else { return false }
    } else {
      windowStart = now
      admitted = 0
    }
    admitted += 1
    return true
  }
}
