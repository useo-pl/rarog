import Foundation
import RarogContract
import RarogCore

// The rows of the whole file tree of a session directory: listings merged with the change markers, virtual rows for
// changed paths the listings lack, and the fallback tree from the `git-status` frame. The tree of explicit paths
// (Changed only, a search result) is `FileTree+Paths.swift`. Pure functions, tests on macOS.
// Owner: session files (native app).

/// A directory of the file tree.
public struct FileTreeDirectoryRow: Sendable, Equatable {
  /// The path relative to the session directory: the key of its listing and of the hand toggle.
  public let path: String
  public let name: String
  public let depth: Int
  public let expanded: Bool
  /// Changed files anywhere under it.
  public let changes: Int
  /// Line counts of those changes; `nil` = none of them has its own ("don't know", not zero).
  public let added: Int?
  public let deleted: Int?
  /// Not on a loaded listing: known only from the changes (deleted from disk, hidden, past the listing ceiling, a
  /// listing not here yet, or the fallback source). It has nothing to preview.
  public let virtual: Bool
  public let ignored: Bool
  /// Open and listable, but its listing has not come yet.
  public let loading: Bool

  /// A change lies under it: the dot and the brighter name, open or closed.
  public var changed: Bool { changes > 0 }

  /// "+10 −10" beside a CLOSED directory: what the closing hides. `nil` = open, or nothing to say.
  public var sum: String? { expanded ? nil : UICopy.inspectorDirectorySum(added: added, deleted: deleted) }
}

/// A file of the file tree.
public struct FileTreeFileRow: Sendable, Equatable {
  /// The server's name of the file: relative to the session directory, as the change list or the frame gives it
  /// (git quoting stays in the fallback source, so the diff window finds the file).
  public let path: String
  /// The last part of the path, unquoted; an untracked directory of the frame keeps its trailing `/`.
  public let name: String
  public let depth: Int
  /// `nil` = unchanged, or a letter this app does not know.
  public let status: DiffFileStatus?
  /// The change list carries this file.
  public let changed: Bool
  /// `nil` = "don't know", not zero.
  public let added: Int?
  public let deleted: Int?
  public let binary: Bool
  public let ignored: Bool
  /// Not on a loaded listing (see ``FileTreeDirectoryRow/virtual``).
  public let virtual: Bool
  /// Bytes, from the listing.
  public let size: Int?

  /// Unchanged files are dimmed.
  public var dimmed: Bool { !changed }

  /// Deleted: struck through in the error colour; a tap opens the diff.
  public var removed: Bool { status == .deleted }
}

public enum FileTreeRow: Sendable, Equatable, Identifiable {
  case directory(FileTreeDirectoryRow)
  case file(FileTreeFileRow)

  public var id: String {
    switch self {
    case let .directory(row): "dir:\(row.path)"
    case let .file(row): "file:\(row.path)"
    }
  }

  public var depth: Int {
    switch self {
    case let .directory(row): row.depth
    case let .file(row): row.depth
    }
  }
}

/// The tree on screen and the two notes under it.
public struct FileTreeContent: Sendable, Equatable {
  public let rows: [FileTreeRow]
  public let source: FileTreeSource
  /// A listing on screen stopped at the server's ceiling.
  public let listTruncated: Bool
  /// The change list (or the frame) does not carry every change.
  public let diffTruncated: Bool
}

/// What the Files section draws: the whole tree, or only the changes. A device preference (`RarogInspector`).
public enum FileTreeMode: String, Sendable, Equatable, CaseIterable {
  /// Files: the listings with the change markers.
  case all = "files"
  /// Changed only: the tree of the change-list paths, every directory open.
  case changed
}

public enum FileTree {
  /// The rows from the top: in each directory its subdirectories, then its files, in the listing order; a virtual
  /// entry takes its place by the same order. Only open directories show their children.
  ///
  /// `mode` `.changed` draws only the changed paths (`FileTree+Paths.swift`): every directory open except `folds`, the
  /// hand toggles unused. The fallback tree has only changes anyway, so it ignores the mode. `index` confirms files:
  /// a changed file the listings lack but the index has keeps its preview.
  public static func content(
    _ snapshot: FileTreeSnapshot, git: GitStatusEvent?, mode: FileTreeMode = .all, index: FileSearchIndex? = nil,
    folds: Set<FilePathKey> = []
  ) -> FileTreeContent {
    let changes = Changes(snapshot, git: git)
    if mode == .changed, snapshot.source == .files {
      return FileTreeContent(
        rows: pathsRows(
          snapshot, markers: changes.markers, leaves: changes.markers.map(\.plain), index: index, folds: folds),
        source: snapshot.source, listTruncated: false, diffTruncated: changes.diffTruncated)
    }
    var builder = Builder(snapshot: snapshot, markers: changes.markers, index: index)
    let rootListed = snapshot.source == .files && !snapshot.gone.contains("")
    builder.walk("", depth: 0, listed: rootListed)
    return FileTreeContent(
      rows: builder.rows, source: snapshot.source, listTruncated: builder.listTruncated,
      diffTruncated: changes.diffTruncated)
  }

  /// The changed paths of the tree's source: the change list (`files`) or the `git-status` frame (fallback).
  struct Changes {
    let markers: [Marker]
    let diffTruncated: Bool

    init(_ snapshot: FileTreeSnapshot, git: GitStatusEvent?) {
      switch snapshot.source {
      case .files:
        markers = (snapshot.diff?.files ?? []).map(Marker.init(change:))
        diffTruncated = snapshot.diff?.truncated ?? false
      case .fallback:
        let rows = git.map(InspectorChanges.rows) ?? []
        markers = rows.map(Marker.init(row:))
        diffTruncated = git.map { $0.dirtyCount > rows.count } ?? false
      }
    }
  }

  /// The origin of a file row: it stands on a loaded listing as a file, or the index has it, so the server can send
  /// it (a preview). Known only from the changes, it is virtual (a diff). The fallback source confirms nothing.
  static func confirmed(_ plain: String, onListing: Bool, source: FileTreeSource, index: FileSearchIndex?) -> Bool {
    source == .files && (onListing || index?.contains(plain) == true)
  }

  /// Changes under a directory and the sums of their line counts.
  typealias Total = (changes: Int, added: Int?, deleted: Int?)

  static func totals(_ markers: [Marker]) -> [FilePathKey: Total] {
    var totals: [FilePathKey: Total] = [:]
    for marker in markers {
      var dir = ""
      for part in marker.parents {
        dir = FileTreeRules.join(dir, part)
        let key = FilePathKey(dir)
        let total = totals[key] ?? (0, nil, nil)
        totals[key] = (total.changes + 1, sum(total.added, marker.added), sum(total.deleted, marker.deleted))
      }
    }
    return totals
  }

  /// The sum of known counts; only "don't know" gives "don't know".
  private static func sum(_ a: Int?, _ b: Int?) -> Int? {
    switch (a, b) {
    case let (a?, b?): a + b
    case let (a?, nil): a
    case let (nil, b?): b
    case (nil, nil): nil
    }
  }

  /// One changed path: where it stands in the tree and what its row shows.
  struct Marker {
    let path: String
    /// The path without git quoting: where the change stands in the tree.
    let plain: String
    /// The parent directories, unquoted.
    let parents: [String]
    let name: String
    let status: DiffFileStatus?
    let added: Int?
    let deleted: Int?
    let binary: Bool

    init(change: DiffListEntry) {
      let parts = change.path.split(separator: "/").map(String.init)
      path = change.path
      plain = change.path
      parents = Array(parts.dropLast())
      name = parts.last ?? change.path
      status = change.status
      added = change.binary ? nil : change.linesAdded
      deleted = change.binary ? nil : change.linesDeleted
      binary = change.binary
    }

    init(row: InspectorFileRow) {
      path = row.path
      plain = row.plain
      parents = Array(row.plain.split(separator: "/").map(String.init).dropLast())
      name = row.name
      status = row.status
      added = row.added
      deleted = row.deleted
      binary = row.binary
    }
  }

  /// A child of a directory before sorting.
  private struct Entry {
    let name: String
    let kind: FileEntryKind
    let size: Int?
    let ignored: Bool
    let virtual: Bool
  }

  private struct Builder {
    let snapshot: FileTreeSnapshot
    let index: FileSearchIndex?
    /// Changed files directly in each directory, by name.
    var files: [String: [String: Marker]] = [:]
    /// Directories each directory holds according to the changes.
    var dirs: [String: Set<String>] = [:]
    let totals: [FilePathKey: Total]
    let changed: Set<String>
    var rows: [FileTreeRow] = []
    var listTruncated = false

    init(snapshot: FileTreeSnapshot, markers: [Marker], index: FileSearchIndex?) {
      self.snapshot = snapshot
      self.index = index
      changed = FileTreeRules.changedDirectories(markers.map(\.plain))
      totals = FileTree.totals(markers)
      for marker in markers {
        var dir = ""
        for part in marker.parents {
          dirs[dir, default: []].insert(part)
          dir = FileTreeRules.join(dir, part)
        }
        files[dir, default: [:]][marker.name] = marker
      }
    }

    /// `listed` = the directory's own listing may be used: it is on a listing itself and the source is `files`.
    mutating func walk(_ dir: String, depth: Int, listed: Bool) {
      var entries: [Entry] = []
      // A name stands once per kind: a file replaced by a directory (or the reverse) is a listed entry of one kind
      // and a changed path of the other, and both rows stay.
      var listedDirs: Set<String> = []
      var listedFiles: Set<String> = []
      if listed, let listing = snapshot.listings[dir] {
        listTruncated = listTruncated || listing.truncated
        for entry in listing.entries {
          if entry.kind == .dir, snapshot.gone.contains(FileTreeRules.join(dir, entry.name)) { continue }
          entries.append(Entry(name: entry.name, kind: entry.kind, size: entry.size, ignored: entry.ignored, virtual: false))
          if entry.kind == .dir { listedDirs.insert(entry.name) } else { listedFiles.insert(entry.name) }
        }
      }
      for name in dirs[dir] ?? [] where !listedDirs.contains(name) {
        entries.append(Entry(name: name, kind: .dir, size: nil, ignored: false, virtual: true))
      }
      for name in (files[dir] ?? [:]).keys where !listedFiles.contains(name) {
        entries.append(Entry(name: name, kind: .file, size: nil, ignored: false, virtual: true))
      }
      entries.sort {
        FileEntry.listingOrder(FileEntry(name: $0.name, kind: $0.kind), FileEntry(name: $1.name, kind: $1.kind))
      }
      for entry in entries {
        let path = FileTreeRules.join(dir, entry.name)
        switch entry.kind {
        case .dir:
          let expanded = FileTreeRules.isExpanded(path, toggles: snapshot.toggles, changed: changed)
          let onListing = !entry.virtual && listed
          let total = totals[FilePathKey(path)] ?? (0, nil, nil)
          rows.append(.directory(FileTreeDirectoryRow(
            path: path, name: entry.name, depth: depth, expanded: expanded, changes: total.changes,
            added: total.added, deleted: total.deleted, virtual: !onListing, ignored: entry.ignored,
            loading: onListing && expanded && snapshot.listings[path] == nil)))
          if expanded { walk(path, depth: depth + 1, listed: onListing) }
        case .file:
          let marker = files[dir]?[entry.name]
          let onListing = !entry.virtual && listed && snapshot.listings[dir] != nil
          let confirmed = FileTree.confirmed(
            marker?.plain ?? path, onListing: onListing, source: snapshot.source, index: index)
          rows.append(.file(FileTreeFileRow(
            path: marker?.path ?? path, name: entry.name, depth: depth, status: marker?.status,
            changed: marker != nil, added: marker?.added, deleted: marker?.deleted, binary: marker?.binary ?? false,
            ignored: entry.ignored, virtual: !confirmed, size: entry.size)))
        }
      }
    }
  }
}
