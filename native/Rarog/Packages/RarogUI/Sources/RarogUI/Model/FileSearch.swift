import Foundation
import RarogContract
import RarogCore

// File search in the Files section of the right panel: the set of paths searched (per source, mode and the state of
// the server's file index), the match of a query (plain text or a regular expression, stopped by a newer query or the
// time budget) and the result tree with its notes. The server only sends the index; a regular expression never leaves
// the app. Pure functions, safe off the main thread; tests on macOS. Owner: session files (native app).

/// The file index of a session: every file under the session directory the server lists, relative paths with `/`,
/// files git ignores left out. `truncated` = a ceiling of the server cut it; `maxBytes` = the largest file the server
/// sends (the preview of a hit needs no listing).
public struct FileSearchIndex: Sendable, Equatable {
  public let paths: [String]
  public let truncated: Bool
  public let maxBytes: Int
  /// The same paths as a set by bytes (``FilePathKey``): the origin of a row asks it per file.
  private let members: Set<FilePathKey>

  public init(paths: [String], truncated: Bool, maxBytes: Int) {
    self.paths = paths
    self.truncated = truncated
    self.maxBytes = maxBytes
    members = Set(paths.map { FilePathKey($0) })
  }

  /// The index holds this exact path, byte for byte.
  public func contains(_ path: String) -> Bool { members.contains(FilePathKey(path)) }

  /// Paths compared by bytes, in order: a new index that only changes a Unicode form is a new index.
  public static func == (lhs: FileSearchIndex, rhs: FileSearchIndex) -> Bool {
    lhs.truncated == rhs.truncated && lhs.maxBytes == rhs.maxBytes
      && lhs.paths.elementsEqual(rhs.paths) { $0.utf8.elementsEqual($1.utf8) }
  }
}

/// What the app has of the session's file index.
public enum FileSearchIndexState: Sendable, Equatable {
  /// The server has no index route: the search covers what the app has loaded.
  case unsupported
  /// A request is on its way; `previous` = the index it replaces, searched meanwhile.
  case loading(previous: FileSearchIndex?)
  case ready(FileSearchIndex)
  /// The last request failed; `previous` = an older index, still searched.
  case failed(previous: FileSearchIndex?)

  /// The index searched now, if any.
  public var index: FileSearchIndex? {
    switch self {
    case .unsupported: nil
    case let .loading(previous), let .failed(previous): previous
    case let .ready(index): index
    }
  }
}

/// One path searched.
public struct FileSearchCandidate: Sendable, Equatable {
  /// The server's name of the file (git quoting kept in the fallback source, so the diff window finds it).
  public let path: String
  /// The path as a person reads it: what the query matches.
  public let plain: String

  public init(path: String, plain: String? = nil) {
    self.path = path
    self.plain = plain ?? path
  }
}

/// Why the search covers less than the whole session directory.
public enum FileSearchScopeNote: Sendable, Equatable {
  /// The server has no index: only the loaded listings and the changes.
  case openDirectoriesOnly
  /// The first index is on its way: the loaded listings and the changes meanwhile.
  case loadingIndex
  /// The index request failed: the previous index or the loaded listings; the note offers a retry.
  case indexFailed
}

/// The paths a query is matched against, in the order of the result.
public struct FileSearchScope: Sendable, Equatable {
  public let candidates: [FileSearchCandidate]
  public let note: FileSearchScopeNote?
  /// The index searched was cut by a server ceiling.
  public let indexTruncated: Bool
}

/// The text of the search field and the `.*` button.
public struct FileSearchQuery: Sendable, Equatable {
  public let text: String
  public let regex: Bool

  public init(text: String, regex: Bool) {
    self.text = text
    self.regex = regex
  }

  /// The text without spaces at either end: what is matched.
  public var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

  /// A query with something to match; an inactive one shows the tree.
  public var isActive: Bool { !trimmed.isEmpty }
}

/// The hits of a query: the first ones in the order of the search set, and how many there are in all.
public struct FileSearchMatches: Sendable, Equatable {
  public let first: [FileSearchCandidate]
  public let total: Int

  public init(first: [FileSearchCandidate], total: Int) {
    self.first = first
    self.total = total
  }
}

public enum FileSearchOutcome: Sendable, Equatable {
  case matches(FileSearchMatches)
  /// The regular expression does not compile: no hit.
  case invalidPattern
  /// The regular expression ran past the time budget: stopped, no hit.
  case tooSlow
  /// A newer query or newer data stopped it: the outcome is dropped.
  case cancelled
}

/// A note under the search field or the result.
public enum FileSearchNote: Sendable, Equatable, Hashable, Identifiable {
  case invalidPattern
  case tooSlow
  /// No file matches the query (the trimmed text); not the clean sentence of the tree.
  case noMatch(query: String)
  /// More hits than rows: `shown` of `total`.
  case shown(Int, of: Int)
  /// The index was cut: the search covers `files` paths.
  case indexTruncated(files: Int)
  case openDirectoriesOnly
  case loadingIndex
  /// The index request failed; the note offers a retry.
  case indexFailed

  public var id: Self { self }
}

/// What the Files section shows for an active query.
public struct FileSearchResult: Sendable, Equatable {
  /// The tree of the hits; `source` as the tree's.
  public let content: FileTreeContent
  /// Notes of the outcome first, then of the search set.
  public let notes: [FileSearchNote]
}

public enum FileSearch {
  /// Hits shown as rows; the rest is counted.
  public static let resultLimit = 500
  /// Longest run of a regular expression over the whole search set.
  public static let regexBudget: Duration = .milliseconds(250)

  /// The search set. Changed only: the change-list paths. The fallback source: the paths of the `git-status` frame.
  /// Files: the index, then the changes it lacks (deleted, under a hidden directory); without an index the loaded
  /// listings and the changes, with the note why. Files git ignores are left out of the listings, as the index
  /// leaves them out.
  public static func scope(
    _ snapshot: FileTreeSnapshot, git: GitStatusEvent?, mode: FileTreeMode, index state: FileSearchIndexState
  ) -> FileSearchScope {
    let changes = FileTree.Changes(snapshot, git: git).markers.map {
      FileSearchCandidate(path: $0.path, plain: $0.plain)
    }
    guard snapshot.source == .files, mode == .all else {
      return FileSearchScope(candidates: changes, note: nil, indexTruncated: false)
    }
    var set = UniquePaths()
    let note: FileSearchScopeNote?
    if let index = state.index {
      for path in index.paths { set.add(FileSearchCandidate(path: path)) }
      if case .failed = state { note = .indexFailed } else { note = nil }
    } else {
      for path in listedFiles(snapshot) { set.add(FileSearchCandidate(path: path)) }
      switch state {
      case .unsupported: note = .openDirectoriesOnly
      case .loading: note = .loadingIndex
      case .failed: note = .indexFailed
      case .ready: note = nil
      }
    }
    for change in changes { set.add(change) }
    return FileSearchScope(candidates: set.items, note: note, indexTruncated: state.index?.truncated ?? false)
  }

  /// Files of the loaded listings, ignored ones left out: directories by path, entries in the listing order.
  private static func listedFiles(_ snapshot: FileTreeSnapshot) -> [String] {
    var out: [String] = []
    for dir in snapshot.listings.keys.sorted() where !FileTree.isGone(dir, snapshot.gone) {
      for entry in snapshot.listings[dir]?.entries ?? [] where entry.kind == .file && !entry.ignored {
        out.append(FileTreeRules.join(dir, entry.name))
      }
    }
    return out
  }

  private struct UniquePaths {
    var items: [FileSearchCandidate] = []
    var seen: Set<FilePathKey> = []

    mutating func add(_ candidate: FileSearchCandidate) {
      if seen.insert(FilePathKey(candidate.plain)).inserted { items.append(candidate) }
    }
  }

  /// The hits of `query` in `candidates`: plain text is a part of the path without letter case; a regular expression
  /// is matched without letter case and stops after `budget` (catastrophic backtracking included) as too slow.
  /// `isCancelled` is asked between paths and inside a regex run: true stops with ``FileSearchOutcome/cancelled``.
  /// Every hit is counted, the first `limit` kept.
  public static func match(
    _ query: FileSearchQuery, in candidates: [FileSearchCandidate], limit: Int = resultLimit,
    budget: Duration = regexBudget, isCancelled: () -> Bool = { Task.isCancelled }
  ) -> FileSearchOutcome {
    let needle = query.trimmed
    var first: [FileSearchCandidate] = []
    var total = 0
    func hit(_ candidate: FileSearchCandidate) {
      total += 1
      if first.count < limit { first.append(candidate) }
    }
    guard query.regex else {
      for (offset, candidate) in candidates.enumerated() {
        if offset % 256 == 0, isCancelled() { return .cancelled }
        if candidate.plain.range(of: needle, options: .caseInsensitive) != nil { hit(candidate) }
      }
      return .matches(FileSearchMatches(first: first, total: total))
    }
    guard let expression = try? NSRegularExpression(pattern: needle, options: [.caseInsensitive]) else {
      return .invalidPattern
    }
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: budget)
    var stop: FileSearchOutcome?
    // A progress callback comes at every failed start position too (about a million over a full index), so the stop
    // and the clock are asked at every 64th only.
    var callbacks = 0
    for candidate in candidates {
      if isCancelled() { return .cancelled }
      if clock.now >= deadline { return .tooSlow }
      var found = false
      let text = candidate.plain
      expression.enumerateMatches(
        in: text, options: [.reportProgress], range: NSRange(text.startIndex..., in: text)
      ) { result, flags, halt in
        callbacks += 1
        if result != nil {
          found = true
        } else if flags.contains(.internalError) {
          stop = .tooSlow
        } else if callbacks & 63 == 0 {
          if isCancelled() { stop = .cancelled } else if clock.now >= deadline { stop = .tooSlow }
        }
        if found || stop != nil { halt.pointee = true }
      }
      if let stop { return stop }
      if found { hit(candidate) }
    }
    return .matches(FileSearchMatches(first: first, total: total))
  }

  /// The result of an active query: the tree of the first hits with their ancestors, every directory open except
  /// `folds` (folded in this result only), and its notes. `nil` = nothing to show: an inactive query, or an outcome
  /// stopped by a newer one.
  public static func result(
    _ outcome: FileSearchOutcome, query: FileSearchQuery, scope: FileSearchScope, snapshot: FileTreeSnapshot,
    git: GitStatusEvent?, index: FileSearchIndex?, folds: Set<FilePathKey>
  ) -> FileSearchResult? {
    guard query.isActive else { return nil }
    let changes = FileTree.Changes(snapshot, git: git)
    var rows: [FileTreeRow] = []
    var notes: [FileSearchNote] = []
    switch outcome {
    case .cancelled: return nil
    case .invalidPattern: notes.append(.invalidPattern)
    case .tooSlow: notes.append(.tooSlow)
    case let .matches(matches):
      rows = FileTree.pathsRows(
        snapshot, markers: changes.markers, leaves: matches.first.map(\.plain), index: index, folds: folds)
      if matches.total == 0 { notes.append(.noMatch(query: query.trimmed)) }
      if matches.total > matches.first.count { notes.append(.shown(matches.first.count, of: matches.total)) }
    }
    if scope.indexTruncated { notes.append(.indexTruncated(files: scope.candidates.count)) }
    switch scope.note {
    case .openDirectoriesOnly?: notes.append(.openDirectoriesOnly)
    case .loadingIndex?: notes.append(.loadingIndex)
    case .indexFailed?: notes.append(.indexFailed)
    case nil: break
    }
    return FileSearchResult(
      content: FileTreeContent(
        rows: rows, source: snapshot.source, listTruncated: false, diffTruncated: changes.diffTruncated),
      notes: notes)
  }

  /// A tap on a directory of the result: it folds or unfolds in the result only. The hand toggles of the tree and its
  /// listings stay as they are.
  public static func toggledFolds(
    _ folds: Set<FilePathKey>, directory: FileTreeDirectoryRow
  ) -> Set<FilePathKey> {
    var next = folds
    let key = FilePathKey(directory.path)
    if directory.expanded { next.insert(key) } else { next.remove(key) }
    return next
  }
}
