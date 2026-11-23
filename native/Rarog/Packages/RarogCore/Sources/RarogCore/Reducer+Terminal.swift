import Foundation
import RarogContract

// Lista terminali: stan z `GET /api/term` i jego gałęzie reduktora. Odświeża ją `RarogStore+Terminal`
// (co ≤ 5 s na ekranie projektu, od razu po założeniu i zamknięciu terminala). Treści terminala tu nie ma:
// id, katalog, slot, rola, nazwa procesu i to, czy strumień żyje.

/// Terminale serwera — ostatnia znana lista.
public struct TerminalListState: Sendable, Equatable {
  /// Kolejność serwera.
  public internal(set) var entries: [TerminalListEntry] = []
  /// Kiedy przyszła ostatnia lista; `nil` = jeszcze żadna.
  public internal(set) var loadedAt: Date?
  /// Ostatnie odświeżenie padło (sieć, 5xx) — lista zostaje ostatnia znana.
  public internal(set) var refreshFailed = false

  public init() {}

  /// Taby powłoki projektu po slotach (lustro `termsForProject` w PWA: równość ścieżek, bez popupów).
  public func shells(in cwd: String) -> [TerminalListEntry] {
    entries.filter { $0.cwd == cwd && !$0.role.isPopup }.sorted { $0.slot < $1.slot }
  }

  /// Panel popupu tej roli w tym katalogu, gdy już stoi (`popupTermFor` w PWA).
  public func popup(in cwd: String, role: TerminalRole) -> TerminalListEntry? {
    entries.first { $0.cwd == cwd && $0.role == role }
  }

  public func entry(id: String) -> TerminalListEntry? {
    entries.first { $0.id == id }
  }
}

/// Zdarzenie listy terminali — jedna pozycja `CoreEvent.terminals`.
public enum TerminalListEvent: Sendable, Equatable {
  case loaded([TerminalListEntry], at: Date)
  case refreshFailed
  /// Terminal zamknięty z tej apki (`DELETE` przeszedł albo serwer już go nie znał) — znika od razu,
  /// zanim przyjdzie następna lista.
  case closed(id: String)
}

extension AppState {
  mutating func applyTerminals(_ event: TerminalListEvent) {
    switch event {
    case let .loaded(entries, at):
      terminals.entries = entries
      terminals.loadedAt = at
      terminals.refreshFailed = false
    case .refreshFailed:
      terminals.refreshFailed = true
    case let .closed(id):
      terminals.entries.removeAll { $0.id == id }
    }
  }
}
