import Foundation
import RarogContract
import RarogCore

// The tree store's file index (`FileTreeStore.fileIndex(_:)` of RarogCore) as the file search reads it. Building a
// ``FileSearchIndex`` hashes every path (up to 20 000), so a screen maps through ``FileSearchIndexMemo``, which
// builds it once per index the store holds. Owner: session files (native app).

extension FileSearchIndex {
  public init(_ index: FileIndex) {
    self.init(paths: index.paths, truncated: index.truncated, maxBytes: index.maxBytes)
  }
}

extension FileSearchIndexState {
  /// The store's state; ``FileIndexState/notLoaded`` reads as loading without an index, because the store asks for
  /// the index as soon as a query starts. Builds a new index each call: a screen uses ``FileSearchIndexMemo``.
  public init(_ state: FileIndexState) {
    self.init(state, build: FileSearchIndex.init)
  }

  init(_ state: FileIndexState, build: (FileIndex) -> FileSearchIndex) {
    switch state {
    case .unsupported: self = .unsupported
    case .notLoaded: self = .loading(previous: nil)
    case let .loading(previous): self = .loading(previous: previous.map(build))
    case let .ready(index): self = .ready(build(index))
    case let .failed(previous): self = .failed(previous: previous.map(build))
    }
  }
}

/// The mapping of one session's index state that keeps the built search index while the store's index stays the
/// same, byte for byte: two forms of one Unicode name are two paths to the server, so `String` equality (canonical
/// equivalence) would keep the old bytes. An unchanged index costs nothing to compare: its paths share one buffer.
@MainActor
public final class FileSearchIndexMemo {
  private var source: FileIndex?
  private var built: FileSearchIndex?

  public init() {}

  public func state(_ state: FileIndexState) -> FileSearchIndexState {
    FileSearchIndexState(state) { index in
      if let built, let source, Self.sameBytes(source, index) { return built }
      let fresh = FileSearchIndex(index)
      source = index
      built = fresh
      return fresh
    }
  }

  private static func sameBytes(_ lhs: FileIndex, _ rhs: FileIndex) -> Bool {
    guard lhs.truncated == rhs.truncated, lhs.maxBytes == rhs.maxBytes, lhs.paths.count == rhs.paths.count else {
      return false
    }
    let shared = lhs.paths.withUnsafeBufferPointer { left in
      rhs.paths.withUnsafeBufferPointer { right in left.baseAddress == right.baseAddress }
    }
    return shared || lhs.paths.elementsEqual(rhs.paths) { $0.utf8.elementsEqual($1.utf8) }
  }
}
