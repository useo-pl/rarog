import Foundation
import RarogContract

// Gałęzie reduktora katalogu projektów. Wołane z głównego `switch` w `Reducer.swift`.
extension AppState {
  mutating func applyCatalog(_ event: CatalogEvent) -> [CoreEffect] {
    switch event {
    case let .recentProjectsLoaded(projects, at):
      catalog.recent = projects
      catalog.recentAt = at
    case let .recentProjectsRequested(at):
      // Lista zostaje ostatnia znana: ścieżki projektów nie stają się fałszywe od zerwania sieci.
      catalog.recentAt = at
    }
    return []
  }
}
