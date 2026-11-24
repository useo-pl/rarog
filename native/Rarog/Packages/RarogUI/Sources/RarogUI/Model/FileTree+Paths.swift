import Foundation
import RarogContract
import RarogCore

// The tree of explicit file paths: Changed only (the change-list paths) and a search result (the hits). Every
// directory is open unless folded in this tree, the hand toggles of the whole tree are not read, and no directory waits
// for a listing: its children are the paths given. Pure functions, tests on macOS. Owner: session files (native app).

/// A path compared and hashed by its UTF-8 bytes. `String ==` and its hash treat canonically equivalent text as one
/// (`é` composed and `e` with a combining accent), while the server tells such names apart byte for byte and a disk
/// may hold both.
public struct FilePathKey: Hashable, Sendable, ExpressibleByStringLiteral {
  public let path: String

  public init(_ path: String) { self.path = path }

  public init(stringLiteral value: String) { path = value }

  public static func == (lhs: FilePathKey, rhs: FilePathKey) -> Bool { lhs.path.utf8.elementsEqual(rhs.path.utf8) }

  public func hash(into hasher: inout Hasher) {
    var path = path
    path.withUTF8 { hasher.combine(bytes: UnsafeRawBufferPointer($0)) }
  }
}

extension FileTree {
  /// The rows of `leaves` (unquoted paths of files) with their ancestors, in the listing order. `markers` are all the
  /// changes of the source: a leaf with a marker gets its letter and counts, and a directory the changes under it. A
  /// file is confirmed by a loaded listing or the index (``FileTree/confirmed(_:onListing:source:index:)``).
  static func pathsRows(
    _ snapshot: FileTreeSnapshot, markers: [Marker], leaves: [String], index: FileSearchIndex?,
    folds: Set<FilePathKey>
  ) -> [FileTreeRow] {
    var builder = PathsBuilder(snapshot: snapshot, markers: markers, index: index, folds: folds)
    for leaf in leaves { builder.add(leaf) }
    builder.walk("", depth: 0)
    return builder.rows
  }

  /// `dir` or a directory above it answered 404: a listing of it left over from before is not used.
  static func isGone(_ dir: String, _ gone: Set<String>) -> Bool {
    gone.contains(dir) || gone.contains { FileTreeRules.isInside(dir, $0) }
  }

  /// Every path and name below is keyed by its bytes (``FilePathKey``), so two names in different Unicode forms stay
  /// two rows, each with its own string.
  private struct PathsBuilder {
    let snapshot: FileTreeSnapshot
    let index: FileSearchIndex?
    let folds: Set<FilePathKey>
    let totals: [FilePathKey: Total]
    /// The change of each unquoted path.
    var byPlain: [FilePathKey: Marker] = [:]
    /// Subdirectories of each directory: name key to name.
    var dirs: [FilePathKey: [FilePathKey: String]] = [:]
    /// Files directly in each directory: name key to the name and the unquoted path.
    var files: [FilePathKey: [FilePathKey: (name: String, plain: String)]] = [:]
    var rows: [FileTreeRow] = []

    init(snapshot: FileTreeSnapshot, markers: [Marker], index: FileSearchIndex?, folds: Set<FilePathKey>) {
      self.snapshot = snapshot
      self.index = index
      self.folds = folds
      totals = FileTree.totals(markers)
      for marker in markers { byPlain[FilePathKey(marker.plain)] = marker }
    }

    mutating func add(_ plain: String) {
      let marker = byPlain[FilePathKey(plain)]
      let parents = marker?.parents ?? plain.split(separator: "/").dropLast().map(String.init)
      let name = marker?.name ?? plain.split(separator: "/").last.map(String.init) ?? plain
      var dir = ""
      for part in parents {
        dirs[FilePathKey(dir), default: [:]][FilePathKey(part)] = part
        dir = FileTreeRules.join(dir, part)
      }
      files[FilePathKey(dir), default: [:]][FilePathKey(name)] = (name, plain)
    }

    /// The entries of `dir`'s loaded listing by name, one map per kind; none for the fallback source or a directory
    /// gone from disk (itself or above it).
    private func listed(_ dir: String) -> (dirs: [FilePathKey: FileEntry], files: [FilePathKey: FileEntry]) {
      guard snapshot.source == .files, !FileTree.isGone(dir, snapshot.gone), let listing = snapshot.listings[dir] else {
        return ([:], [:])
      }
      var dirs: [FilePathKey: FileEntry] = [:]
      var files: [FilePathKey: FileEntry] = [:]
      for entry in listing.entries {
        if entry.kind == .dir { dirs[FilePathKey(entry.name)] = entry } else { files[FilePathKey(entry.name)] = entry }
      }
      return (dirs, files)
    }

    mutating func walk(_ dir: String, depth: Int) {
      let listing = listed(dir)
      let key = FilePathKey(dir)
      var entries = (dirs[key] ?? [:]).values.map { FileEntry(name: $0, kind: .dir) }
      entries += (files[key] ?? [:]).values.map { FileEntry(name: $0.name, kind: .file) }
      entries.sort(by: FileEntry.listingOrder)
      for entry in entries {
        let path = FileTreeRules.join(dir, entry.name)
        let name = FilePathKey(entry.name)
        switch entry.kind {
        case .dir:
          let onListing = listing.dirs[name] != nil && !snapshot.gone.contains(path)
          let expanded = !folds.contains(FilePathKey(path))
          let total = totals[FilePathKey(path)] ?? (0, nil, nil)
          rows.append(.directory(FileTreeDirectoryRow(
            path: path, name: entry.name, depth: depth, expanded: expanded, changes: total.changes,
            added: total.added, deleted: total.deleted, virtual: !onListing,
            ignored: listing.dirs[name]?.ignored ?? false, loading: false)))
          if expanded { walk(path, depth: depth + 1) }
        case .file:
          guard let plain = files[key]?[name]?.plain else { continue }
          let marker = byPlain[FilePathKey(plain)]
          let listed = listing.files[name]
          rows.append(.file(FileTreeFileRow(
            path: marker?.path ?? plain, name: entry.name, depth: depth, status: marker?.status,
            changed: marker != nil, added: marker?.added, deleted: marker?.deleted, binary: marker?.binary ?? false,
            ignored: listed?.ignored ?? false,
            virtual: !FileTree.confirmed(plain, onListing: listed != nil, source: snapshot.source, index: index),
            size: listed?.size)))
        }
      }
    }
  }
}
