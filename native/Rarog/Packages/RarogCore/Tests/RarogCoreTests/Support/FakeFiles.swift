import Foundation
import RarogContract
import RarogCore
import RarogTransport
import Synchronization

/// The session file routes and the change list of the base fake: every call recorded, the listing, the index, the
/// fetch and the change list answer what the test sets, and the peak of listings and change lists in flight at once
/// is kept (the index counts apart: it is not a job of the tree's queue).
/// Owner: session files (native app).
final class FakeFilesBackend: @unchecked Sendable {
  struct ListingCall: Sendable, Equatable {
    let sessionId: String
    let dir: String
  }

  struct FetchCall: Sendable, Equatable {
    let sessionId: String
    let path: String
    let maxBytes: Int
  }

  struct State {
    var listings: [ListingCall] = []
    var fetches: [FetchCall] = []
    /// `nil` = an empty listing of the requested directory with a 1 MiB limit.
    var listingResult: Result<FileListing, TransportError>?
    /// Answers by directory; they win over `listingResult`.
    var listingByDir: [String: Result<FileListing, TransportError>] = [:]
    var diffCalls: [String] = []
    /// `nil` = the change list answers `.invalidResponse`.
    var diffResult: Result<DiffFileList, TransportError>?
    /// Holds a change list after its call is recorded, before its answer.
    var onDiff: (@Sendable () async -> Void)?
    /// Listings and change lists in flight now, and the most there ever were at once.
    var reading = 0
    var peakReading = 0
    /// `nil` = the fetch is refused as `.http` 404.
    var fetchResult: Result<SessionFileFetch, TransportError>?
    /// Holds a listing after its call is recorded, before its answer.
    var onListing: (@Sendable () async -> Void)?
    /// Holds a fetch after its call is recorded, before its answer.
    var onFetch: (@Sendable () async -> Void)?
    /// Session ids of the index calls, in order.
    var indexCalls: [String] = []
    /// `nil` = an empty index with a 1 MiB limit.
    var indexResult: Result<FileIndex, TransportError>?
    /// Holds an index after its call is recorded, before its answer.
    var onIndex: (@Sendable () async -> Void)?
    /// Index requests in flight now, and the most there ever were at once.
    var indexing = 0
    var peakIndexing = 0
  }

  let lock = Mutex(State())

  func set(_ change: (inout State) -> Void) { lock.withLock { change(&$0) } }

  func read<T>(_ value: (State) -> T) -> T { lock.withLock { value($0) } }

  func listing(_ call: ListingCall) async throws(TransportError) -> FileListing {
    let (result, hold) = lock.withLock { state in
      state.listings.append(call)
      state.reading += 1
      state.peakReading = max(state.peakReading, state.reading)
      return (state.listingByDir[call.dir] ?? state.listingResult, state.onListing)
    }
    await hold?()
    lock.withLock { $0.reading -= 1 }
    guard let result else { return FileListing(dir: call.dir, entries: [], truncated: false, maxBytes: 1_048_576) }
    return try result.get()
  }

  func diff(_ sessionId: String) async throws(TransportError) -> DiffFileList {
    let (result, hold) = lock.withLock { state in
      state.diffCalls.append(sessionId)
      state.reading += 1
      state.peakReading = max(state.peakReading, state.reading)
      return (state.diffResult, state.onDiff)
    }
    await hold?()
    lock.withLock { $0.reading -= 1 }
    guard let result else { throw .invalidResponse("no change list in this test") }
    return try result.get()
  }

  func index(_ sessionId: String) async throws(TransportError) -> FileIndex {
    let (result, hold) = lock.withLock { state in
      state.indexCalls.append(sessionId)
      state.indexing += 1
      state.peakIndexing = max(state.peakIndexing, state.indexing)
      return (state.indexResult, state.onIndex)
    }
    await hold?()
    lock.withLock { $0.indexing -= 1 }
    guard let result else { return FileIndex(paths: [], truncated: false, maxBytes: 1_048_576) }
    return try result.get()
  }

  func fetch(_ call: FetchCall) async throws(TransportError) -> SessionFileFetch {
    let (result, hold) = lock.withLock { state in
      state.fetches.append(call)
      return (state.fetchResult, state.onFetch)
    }
    await hold?()
    guard let result else { throw .http(APIFailure(status: 404, code: "not-found")) }
    return try result.get()
  }
}

extension FakeTransport {
  func sessionFiles(sessionId: String, dir: String) async throws(TransportError) -> FileListing {
    try await files.listing(FakeFilesBackend.ListingCall(sessionId: sessionId, dir: dir))
  }

  func fetchSessionFile(sessionId: String, path: String, maxBytes: Int) async throws(TransportError) -> SessionFileFetch {
    try await files.fetch(FakeFilesBackend.FetchCall(sessionId: sessionId, path: path, maxBytes: maxBytes))
  }

  func sessionFileIndex(sessionId: String) async throws(TransportError) -> FileIndex {
    try await files.index(sessionId)
  }
}
