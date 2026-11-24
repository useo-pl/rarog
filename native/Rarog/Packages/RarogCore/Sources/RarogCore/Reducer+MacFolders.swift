import Foundation
import RarogContract

// The macOS folders the server keeps closed. Branches of the reducer called from the main `switch` in `Reducer.swift`;
// the sessions they touch: `Selectors.swift`. Owner: macOS folders (native app).

extension AppState {
  /// `folder-access` carries the full list, also empty, so it replaces what the app knew.
  mutating func applyFolderAccess(_ event: FolderAccessEvent) {
    macFolders = event.blocked
  }

  /// A new connection of the global stream, logout or another server: the old list says nothing about the server the
  /// app talks to now. A server with the gate sends the list again right after `sessions-snapshot`; an older server
  /// never does, so its app shows no folder banner.
  mutating func clearMacFolders() {
    macFolders = []
  }
}
