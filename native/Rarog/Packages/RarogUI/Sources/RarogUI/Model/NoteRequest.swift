import Foundation

/// Prośba o formularz notatki projektu: katalog i to, od czego formularz zaczyna. Każde otwarcie to nowa
/// prezentacja (nowy identyfikator) — po nim dokument liczy zakończenie raz, choć woła je kilka dróg (przycisk,
/// Esc, ⌘W, ⌘J, gest w dół, zastąpienie arkusza, wylogowanie). Właściciel: notatki (apka natywna).
public struct NoteRequest: Identifiable, Equatable, Sendable {
  public enum Start: Sendable, Equatable {
    /// Klawiatura od razu, kursor na końcu.
    case edit
    /// Nagranie od razu (mikrofon w dymku): nowa linia na końcu, klawiatura nie wstaje.
    case dictate
  }

  public let id: UUID
  public let cwd: String
  public let start: Start

  public init(id: UUID = UUID(), cwd: String, start: Start = .edit) {
    self.id = id
    self.cwd = cwd
    self.start = start
  }
}
