import Foundation
import RarogContract

// Texts of the macOS folder banners: the list banner over the session list and the session banner over a transcript.
// Where they stand: `Model/BannerSlots`. Owner: macOS folders (native app).

extension UICopy {
  /// The list banner: the state that needs the human's click leads (waiting, then denied, then unchecked) and gives the
  /// title, its folders and what to do; folders in another state follow with one sentence each. `sessions` are the
  /// sessions in closed folders (``AppState/macFolderSessions``), `folderOf` finds the folder of each.
  static func macFolderListCard(
    blocked: [MacFolderBlock], sessions: [SessionSummary], folderOf: (SessionSummary) -> MacFolderBlock?,
    timeZone: TimeZone
  ) -> MacFolderCard? {
    let groups = MacFolderState.allCases.map { state in blocked.filter { $0.state == state } }.filter { !$0.isEmpty }
    guard let lead = groups.first, let state = lead.first?.state else { return nil }
    let names = macFolderGenitives(lead)
    var parts: [String] = []
    let title: String
    let action: String
    switch state {
    case .waiting:
      title = L("macFolders.list.waitingTitle")
      // Since when the first of these folders gives no answer.
      let since = lead.compactMap { ServerTime.parse($0.since) }.min()
      parts.append(since.map { L("macFolders.list.waitingAt", names, ServerTime.clock($0, timeZone: timeZone)) }
        ?? L("macFolders.list.waiting", names))
      action = L("macFolders.action.allow")
    case .denied:
      title = L("macFolders.list.deniedTitle", names)
      action = L("macFolders.action.settings")
    case .unchecked:
      title = L("macFolders.list.uncheckedTitle", names)
      action = L("macFolders.action.log")
    }
    parts.append(macFolderReach(blocked: blocked, sessions: sessions, folderOf: folderOf))
    parts.append(action)
    for group in groups.dropFirst() {
      let others = macFolderGenitives(group)
      switch group.first?.state {
      case .denied: parts.append(sentence(L("macFolders.list.deniedTitle", others)))
      case .unchecked: parts.append(sentence(L("macFolders.list.uncheckedTitle", others)))
      case .waiting, nil: break
      }
    }
    return MacFolderCard(title: title, detail: list(parts, .sentence))
  }

  /// The session banner of a session whose directory lies in `block`: what does not work and why.
  static func macFolderSessionCard(_ block: MacFolderBlock) -> MacFolderCard {
    let name = macFolderGenitive(block.name)
    let detail =
      switch block.state {
      case .waiting: L("macFolders.session.waiting", name)
      case .denied: L("macFolders.session.denied", name)
      case .unchecked: L("macFolders.session.unchecked", name)
      }
    return MacFolderCard(title: L("macFolders.session.title"), detail: detail)
  }

  /// Which sessions the closed folders touch: one by its list name, several by count with their folders, none with
  /// the folders that a new session cannot open now.
  private static func macFolderReach(
    blocked: [MacFolderBlock], sessions: [SessionSummary], folderOf: (SessionSummary) -> MacFolderBlock?
  ) -> String {
    switch sessions.count {
    case 0:
      return L("macFolders.scope.none", macFolderGenitives(blocked))
    case 1:
      return L("macFolders.scope.one", SessionRowModel(sessions[0], ordinal: nil).title)
    default:
      let paths = Set(sessions.compactMap { folderOf($0)?.path })
      let holding = blocked.filter { paths.contains($0.path) }.map { macFolderLocative($0.name) }
      return L("macFolders.scope.many", sessions.count, list(holding, .comma))
    }
  }

  private static func macFolderGenitives(_ blocks: [MacFolderBlock]) -> String {
    list(blocks.map { macFolderGenitive($0.name) }, .comma)
  }

  /// The folder after "for", "to", "into": the three folders by their Finder name in the app language, any other
  /// name as the server gives it.
  static func macFolderGenitive(_ name: String) -> String {
    switch name {
    case "Desktop": L("macFolders.folder.desktop.genitive")
    case "Documents": L("macFolders.folder.documents.genitive")
    case "Downloads": L("macFolders.folder.downloads.genitive")
    default: name
    }
  }

  /// The folder after "in", by the same rule as ``macFolderGenitive(_:)``.
  static func macFolderLocative(_ name: String) -> String {
    switch name {
    case "Desktop": L("macFolders.folder.desktop.locative")
    case "Documents": L("macFolders.folder.documents.locative")
    case "Downloads": L("macFolders.folder.downloads.locative")
    default: name
    }
  }
}
