import Foundation
import RarogContract

// Jeden `rs` na ustalony układ. Każde `rs` to SIGWINCH w panelu herdr, a seria
// rozmiarów rysowała „schodki" promptu p10k: obrót daje 2–3 zmiany siatki w ~70 ms, a powierzchnia
// SwiftTerm przelicza siatkę przy każdym `layoutSubviews`. Ustalacz bierze OSTATNI rozmiar po 250 ms ciszy
// i przepuszcza go tylko wtedy, gdy siatka mieści się w 1…1000 i scena jest aktywna — zejście w tło daje
// widok o zerze wierszy, a `rs` z `r=0` serwer zamyka kodem 1002. Ponowny `rs` z `force` po fokusie
// idzie tą samą ciszą: stuknięcie w terminal wysuwa klawiaturę, a `rs` ze starą siatką wysłany od razu dawał
// odrysowanie starego ekranu w mniejszej siatce (skok ekranu na iPhonie). Czysta logika bez zegara:
// ekran odmierza ciszę i oddaje numer zmiany (`TerminalScreenViewController`), testy liczą na macOS
// (`ResizeSettlerTests`). Właściciel: terminal.

/// Ustalacz rozmiaru siatki terminala.
public struct ResizeSettler: Sendable, Equatable {
  /// Cisza po ostatniej zmianie układu, po której rozmiar uznajemy za ustalony.
  public static let quiet: Duration = .milliseconds(250)

  /// Ostatni rozmiar z układu (surowy — może być spoza 1…1000).
  public private(set) var cols = 0
  public private(set) var rows = 0
  /// Numer ostatniej zmiany; ustalona jest wyłącznie ta, której numer nadal jest ostatni.
  public private(set) var change = 0
  /// Następny ustalony `rs` idzie z `force` (fokus wrócił do terminala, ``reassert()``).
  public private(set) var forced = false

  /// Wynik ciszy: siatka do `rs` i to, czy sesja ma ją wysłać także wtedy, gdy już ją wysłała.
  public struct Settled: Sendable, Equatable {
    public let grid: TerminalGrid
    public let force: Bool

    public init(grid: TerminalGrid, force: Bool) {
      self.grid = grid
      self.force = force
    }
  }

  public init() {}

  /// Nowy rozmiar z układu. Zwraca numer zmiany — ekran oddaje go do ``settled(_:sceneActive:)`` po ciszy.
  public mutating func propose(cols: Int, rows: Int) -> Int {
    self.cols = cols
    self.rows = rows
    change += 1
    return change
  }

  /// Fokus wrócił do terminala: następny ustalony `rs` idzie z `force`, a cisza zaczyna się od nowa. Zmiana układu
  /// w tej ciszy (klawiatura ekranowa wysuwa się zaraz po stuknięciu) przesuwa ją dalej, więc wychodzi JEDEN `rs`,
  /// z siatką po zmianie. Zwraca numer zmiany jak ``propose(cols:rows:)``.
  public mutating func reassert() -> Int {
    forced = true
    change += 1
    return change
  }

  /// Koniec ciszy po zmianie `change`: siatka do `rs` (z `force` po ``reassert()``) albo `nil` (przyszła nowsza
  /// zmiana, siatka spoza 1…1000, scena nieaktywna). Koniec ciszy ostatniej zmiany na aktywnej scenie zdejmuje
  /// `force` także wtedy, gdy nic nie wychodzi; na nieaktywnej `force` czeka, a ekran po aktywacji sceny zaczyna
  /// ciszę od nowa (``reassert()``): scena nieaktywna bez tła (Centrum sterowania) nie usypia gniazda, więc nic
  /// innego nie przypomni rozmiaru. Powtórzony rozmiar bez `force` przepuszcza — to, czy `rs` w ogóle wyjdzie,
  /// rozstrzyga sesja (``TerminalSession/resize(_:force:)`` pomija rozmiar już wysłany na tym gnieździe).
  public mutating func settled(_ change: Int, sceneActive: Bool) -> Settled? {
    guard change == self.change, sceneActive else { return nil }
    let force = forced
    forced = false
    return current(sceneActive: sceneActive).map { Settled(grid: $0, force: force) }
  }

  /// Bieżący rozmiar (siatka w 1…1000 na aktywnej scenie). Z `force` po fokusie: po odejściu drugiego klienta
  /// panel zostaje w JEGO rozmiarze, a serwer o tym nie mówi — apka przypomina swój.
  public func current(sceneActive: Bool) -> TerminalGrid? {
    guard sceneActive else { return nil }
    return TerminalGrid(cols: cols, rows: rows)
  }
}
