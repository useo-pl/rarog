import Foundation
import Observation
import RarogContract
import RarogCore

// The file search of the Files section as it runs: a query waits for a pause in typing, the search set and the match
// run off the main actor, one run at a time, and the newest query or data wins. The result tree is built by the screen
// from the stored outcome, so folding a directory of the result never runs the match again.
// Owner: session files (native app).

/// What one search reads: the query and the data its search set is built from. A change of any of them (a new index,
/// a new change list, the mode) with the same text runs the search again.
public struct FileSearchInput: Sendable, Equatable {
  public let query: FileSearchQuery
  public let snapshot: FileTreeSnapshot
  public let git: GitStatusEvent?
  public let mode: FileTreeMode
  public let index: FileSearchIndexState

  public init(
    query: FileSearchQuery, snapshot: FileTreeSnapshot, git: GitStatusEvent?, mode: FileTreeMode,
    index: FileSearchIndexState
  ) {
    self.query = query
    self.snapshot = snapshot
    self.git = git
    self.mode = mode
    self.index = index
  }

  /// The paths the search set is built from compare by bytes, as ``FileSearchIndex`` does: `String ==` holds for two
  /// Unicode forms of one name, which the server tells apart, so a listing that changed only the form would keep the
  /// old outcome and its row would point at a name the new listing no longer has.
  public static func == (lhs: FileSearchInput, rhs: FileSearchInput) -> Bool {
    lhs.query == rhs.query && lhs.mode == rhs.mode && lhs.index == rhs.index && lhs.snapshot == rhs.snapshot
      && lhs.git == rhs.git && sameBytes(lhs.snapshot, rhs.snapshot) && sameBytes(lhs.git, rhs.git)
  }

  /// Called after `==` held, so the counts already match and only the bytes of the strings are left.
  private static func sameBytes(_ lhs: FileTreeSnapshot, _ rhs: FileTreeSnapshot) -> Bool {
    guard Set(lhs.listings.keys.map { FilePathKey($0) }) == Set(rhs.listings.keys.map { FilePathKey($0) }),
      Set(lhs.gone.map { FilePathKey($0) }) == Set(rhs.gone.map { FilePathKey($0) }),
      same(lhs.diff?.files.map(\.path) ?? [], rhs.diff?.files.map(\.path) ?? [])
    else { return false }
    return lhs.listings.allSatisfy { dir, listing in
      guard let other = rhs.listings[dir] else { return false }
      return same([listing.dir], [other.dir]) && same(listing.entries.map(\.name), other.entries.map(\.name))
    }
  }

  private static func sameBytes(_ lhs: GitStatusEvent?, _ rhs: GitStatusEvent?) -> Bool {
    guard let lhs, let rhs else { return true }
    return same(lhs.files, rhs.files)
      && same(lhs.fileDetails?.map(\.path) ?? [], rhs.fileDetails?.map(\.path) ?? [])
  }

  private static func same(_ lhs: [String], _ rhs: [String]) -> Bool {
    lhs.elementsEqual(rhs) { $0.utf8.elementsEqual($1.utf8) }
  }
}

/// A finished search: its input, the set it searched and what it found.
public struct FileSearchRun: Sendable, Equatable {
  public let input: FileSearchInput
  public let scope: FileSearchScope
  public let outcome: FileSearchOutcome
}

@MainActor
@Observable
public final class FileSearchRunner {
  /// Pause in typing before a query runs.
  public static let debounce: Duration = .milliseconds(150)

  public typealias Search = @Sendable (FileSearchInput) async -> (FileSearchScope, FileSearchOutcome)

  /// The newest finished search. It may answer an older input while a newer one waits or runs: the screen keeps
  /// showing it instead of flashing the tree. `nil` = no active query, or none finished yet.
  public private(set) var latest: FileSearchRun?

  @ObservationIgnored private var wanted: FileSearchInput?
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private let wait: Duration
  @ObservationIgnored private let search: Search

  /// - Parameter search: the search itself; tests replace it to watch the runs.
  public init(debounce: Duration = FileSearchRunner.debounce, search: @escaping Search = FileSearchRunner.search) {
    wait = debounce
    self.search = search
  }

  /// The input the screen shows now. An inactive query (empty, blank, `nil`) stops the run in flight and drops the
  /// outcome at once; the same input again changes nothing; any other input runs after the pause, once the run before
  /// it has ended. A stopped run keeps its handle until then, so the next run waits for it even after a cleared field
  /// or a return to the input already shown.
  public func submit(_ input: FileSearchInput?) {
    guard let input, input.query.isActive else {
      wanted = nil
      task?.cancel()
      if latest != nil { latest = nil }
      return
    }
    guard input != wanted else { return }
    wanted = input
    let previous = task
    previous?.cancel()
    if latest?.input == input { return }
    let wait = self.wait
    let search = self.search
    task = Task { [weak self] in
      // One run at a time: the match of a stopped run checks its cancellation often, but its search set is built
      // to the end.
      await previous?.value
      try? await Task.sleep(for: wait)
      guard !Task.isCancelled else { return }
      let (scope, outcome) = await search(input)
      guard !Task.isCancelled, outcome != .cancelled, let self, self.wanted == input else { return }
      self.latest = FileSearchRun(input: input, scope: scope, outcome: outcome)
      self.task = nil
    }
  }

  /// The search set and the match, off the main actor: a regular expression may run up to the budget, and a full index
  /// holds 20 000 paths. Cancellation of the calling task stops the match.
  @concurrent
  public nonisolated static func search(_ input: FileSearchInput) async -> (FileSearchScope, FileSearchOutcome) {
    let scope = FileSearch.scope(input.snapshot, git: input.git, mode: input.mode, index: input.index)
    return (scope, FileSearch.match(input.query, in: scope.candidates))
  }
}
