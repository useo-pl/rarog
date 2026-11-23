import Foundation
import RarogCore

// Linie śladów diagnostycznych — same fakty (stan pola, klawiatura, wynik, czas), bez treści rozmowy.
// Właściciel: łączność. Wysyła `RarogStore.trace(_:)`, budżet 20/h.

/// Skąd przyszło przerwanie: przycisk Stop albo Esc z klawiatury sprzętowej.
public enum InterruptTrigger: Sendable, Equatable {
  case stop
  case escape
}

public enum DiagnosticsTrace {
  /// Kto trzyma klawiaturę po powrocie do apki (klawisze mają trafić do pola bez dotyku).
  public enum Responder: Sendable, Equatable {
    /// Pole wiadomości ma kursor.
    case field
    /// Pole przyjmuje tekst, ale kursora nie ma.
    case fieldUnfocused
    /// Pole wygaszone (decyzja, karta stanu), klawiaturę trzyma ekran sesji.
    case screen
    /// Pole wygaszone, a klawiatury nikt nie trzyma.
    case nobody
  }

  /// „powrót do apki po 42 s: klawiatura=pole, sprzętowa=tak".
  public static func resume(awaySeconds: Int, responder: Responder, hardwareKeyboard: Bool) -> String {
    let who =
      switch responder {
      case .field: "pole"
      case .fieldUnfocused: "pole bez kursora"
      case .screen: "ekran sesji"
      case .nobody: "nikt"
      }
    return "powrót do apki po \(max(0, awaySeconds)) s: klawiatura=\(who), sprzętowa=\(hardwareKeyboard ? "tak" : "nie")"
  }

  /// Układ ekranu sesji w chwili śladu paska skrótów, w punktach od dolnej krawędzi okna.
  public struct ShortcutBarLayout: Sendable, Hashable {
    /// Ile ekran sesji kończy się nad krawędzią okna (0 = sięga krawędzi).
    public let screenShort: Int
    /// Dolna wstawka safe area ekranu sesji.
    public let safeBottom: Int
    /// Dolna krawędź karty pola nad krawędzią okna.
    public let fieldGap: Int

    public init(screenShort: Int, safeBottom: Int, fieldGap: Int) {
      self.screenShort = screenShort
      self.safeBottom = safeBottom
      self.fieldGap = fieldGap
    }
  }

  /// „pasek skrótów 71×1408 pt: nakładka nad polem; ekran 0 pt nad krawędzią okna, wstawka 25 pt, pole 12 pt nad
  /// krawędzią" — niska prowadnica klawiatury (pigułka przy klawiaturze sprzętowej) i to, czy układ został na
  /// miejscu: ekran sięga krawędzi, wstawka i odstęp pola jak bez pigułki.
  public static func shortcutBar(height: Int, width: Int, layout: ShortcutBarLayout) -> String {
    "pasek skrótów \(height)×\(width) pt: nakładka nad polem; ekran \(layout.screenShort) pt nad krawędzią okna, "
      + "wstawka \(layout.safeBottom) pt, pole \(layout.fieldGap) pt nad krawędzią"
  }

  /// „przerwanie (Esc): klawisz doszedł po 312 ms" — czas od gestu do rozstrzygnięcia.
  public static func interrupt(trigger: InterruptTrigger, outcome: InterruptOutcome, milliseconds: Int) -> String {
    let source = trigger == .escape ? "Esc" : "Stop"
    let result =
      switch outcome {
      case .delivered: "klawisz doszedł"
      case .notDelivered: "panel nie przyjął"
      case .unsure: "nie wiem"
      case .refused: "odmowa Raroga"
      case .inFlight: "poprzednie w drodze"
      case .notAllowed: "nie było czego przerywać"
      case .loggedOut: "wylogowanie"
      }
    return "przerwanie (\(source)): \(result) po \(max(0, milliseconds)) ms"
  }

  /// „wejście do sesji …-w1-p1 (szkielet): ramka po 412 ms, 183 kB; widok stoi po 230 ms; renders 3, settles 3,
  /// bottomScrolls 4" — okno wejścia (``SessionEntryWindow``). Rozmiar ramki to wiadomości pełnego stanu
  /// zakodowane ponownie w apce (JSON), nie bajty z łącza. Sesja tylko skrótem identyfikatora.
  public static func sessionEntry(sessionId: String, result: SessionEntryWindow.Result, kilobytes: Int) -> String {
    let origin = result.origin == .memory ? "z pamięci" : "szkielet"
    let settled = result.settled.map { "widok stoi po \($0) ms" }
      ?? "widok bez ciszy po \(SessionEntryWindow.milliseconds(SessionEntryWindow.ceiling)) ms"
    let counts = result.counts
    return "wejście do sesji \(shortSessionId(sessionId)) (\(origin)): ramka po \(result.firstFrame) ms, "
      + "\(max(0, kilobytes)) kB; \(settled); renders \(counts.renders), settles \(counts.settles), "
      + "bottomScrolls \(counts.bottomScrolls)"
  }
}
