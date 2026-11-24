import Foundation
import RarogContract

// The whole file tree of a session directory: the one expansion rule shared by the store (which directories to list)
// and the rows in RarogUI (which directories show their children), and the value a screen builds the tree from.
// Owner: session files (native app).

public enum FileTreeRules {
  /// Every directory with a change somewhere under it, the session directory (`""`) left out. A path ending in `/`
  /// (an untracked directory from a `git-status` frame) is a leaf: its own name is not a directory of the tree.
  public static func changedDirectories(_ paths: some Sequence<String>) -> Set<String> {
    var out: Set<String> = []
    for path in paths {
      var parts = path.split(separator: "/", omittingEmptySubsequences: true)
      guard !parts.isEmpty else { continue }
      parts.removeLast()
      var prefix = ""
      for part in parts {
        prefix = prefix.isEmpty ? String(part) : "\(prefix)/\(part)"
        out.insert(prefix)
      }
    }
    return out
  }

  /// A directory is open when a person opened it; without their choice, when a change lies under it.
  public static func isExpanded(_ dir: String, toggles: [String: Bool], changed: Set<String>) -> Bool {
    toggles[dir] ?? changed.contains(dir)
  }

  /// The path of `name` inside `dir` (`""` = the session directory).
  public static func join(_ dir: String, _ name: String) -> String {
    dir.isEmpty ? name : "\(dir)/\(name)"
  }

  /// The directory that holds `path` (`""` = the session directory).
  public static func parent(of path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "" }
    return String(path[..<slash])
  }

  /// `path` lies inside `dir` (`""` holds everything), `dir` itself not included.
  public static func isInside(_ path: String, _ dir: String) -> Bool {
    dir.isEmpty ? !path.isEmpty : path.hasPrefix(dir + "/")
  }
}

/// Where the tree of a session comes from.
public enum FileTreeSource: Sendable, Equatable {
  /// Directory listings from the server and the change markers of its change list.
  case files
  /// Only the changed paths of the session's `git-status` frame: a server without `files`, a Codex entry, a
  /// session out of scope, or a listing refused for one of the last two. No listing and no preview.
  case fallback
}

/// What a screen builds the file tree of one session from (`FileTree` in RarogUI).
public struct FileTreeSnapshot: Sendable, Equatable {
  public var source: FileTreeSource
  /// Loaded listings by directory (`""` = the session directory); a directory that vanished has none.
  public var listings: [String: FileListing]
  /// The latest change list; `nil` = none came yet (or the fallback source, which reads the `git-status` frame).
  public var diff: DiffFileList?
  /// Directories opened or closed by hand in this session, by path.
  public var toggles: [String: Bool]
  /// Directories whose listing answered 404: their entry leaves the parent's rows until the parent is listed again.
  public var gone: Set<String>

  public init(
    source: FileTreeSource, listings: [String: FileListing] = [:], diff: DiffFileList? = nil,
    toggles: [String: Bool] = [:], gone: Set<String> = []
  ) {
    self.source = source
    self.listings = listings
    self.diff = diff
    self.toggles = toggles
    self.gone = gone
  }
}
