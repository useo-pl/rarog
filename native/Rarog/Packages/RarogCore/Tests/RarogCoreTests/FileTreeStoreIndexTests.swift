import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// The file index of the search in the tree store: when it is asked for, what invalidates it, how often an
// invalidation asks again, and which answers are dropped. Owner: session files (native app).

@MainActor
@Suite("file tree store: the file index of the search")
struct FileTreeStoreIndexTests {
  private func version(_ capabilities: [String]) throws -> VersionInfo {
    let list = capabilities.map { #""\#($0)""# }.joined(separator: ",")
    let json = #"{"version":"1.0.0","protocolVersion":3,"serverStartId":"s","capabilities":[\#(list)]}"#
    return try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
  }

  /// A logged-in store with two known sessions (`extra` goes into the summary of `s1`) and the given capabilities.
  private func store(
    capabilities: [String] = ["files", "file-index"], extra: String = "", timing: CoreTiming = fastTiming
  ) async throws -> (RarogStore, FakeTransport) {
    let (store, transport) = makeStore(timing: timing)
    await store.start()
    await until("logged in") { store.state.auth == .loggedIn }
    store.dispatch(.frame(
      try Frames.snapshot([Frames.summary("s1", extra: extra), Frames.summary("s2", title: "other")]),
      source: .global, cursor: nil))
    if !capabilities.isEmpty { store.dispatch(.versionProbed(try version(capabilities))) }
    transport.files.set { $0.diffResult = .success(DiffFileList(files: [], truncated: false)) }
    return (store, transport)
  }

  /// The fast clock with an index gap no test waits for: an index stays fresh for the whole test.
  private var slowIndexTiming: CoreTiming {
    var timing = fastTiming
    timing.fileIndexRefreshGap = .seconds(30)
    return timing
  }

  private func index(_ paths: [String], maxBytes: Int = 4096) -> Result<FileIndex, TransportError> {
    .success(FileIndex(paths: paths, truncated: false, maxBytes: maxBytes))
  }

  private func indexCalls(_ transport: FakeTransport) -> [String] {
    transport.files.read(\.indexCalls)
  }

  private func settle(_ store: RarogStore) async {
    await until("tree idle") { store.fileTree.idle }
  }

  private func turn(_ store: RarogStore, _ state: String) throws {
    store.dispatch(.frame(try Frames.state("s1", state, since: "2026-10-03T08:01:00.000Z"), source: .global, cursor: nil))
  }

  // MARK: - When it is asked for

  @Test("a query asks for the index once; the answer is the ready state and gives the preview limit")
  func queryAsksOnce() async throws {
    let (store, transport) = try await store()
    let valve = Valve()
    transport.files.set {
      $0.indexResult = index(["src/main.ts", "deep/x/y.ts"], maxBytes: 8192)
      $0.onIndex = { await valve.wait() }
      // The listing is held too: the index lands before the first listing.
      $0.onListing = { await valve.wait() }
    }
    store.fileTree.panelOpened("s1")
    #expect(store.fileTree.fileIndex("s1") == .notLoaded)
    store.fileTree.setSearchActive(true, in: "s1")
    store.fileTree.setSearchActive(true, in: "s1")
    #expect(store.fileTree.fileIndex("s1") == .loading(previous: nil))
    await until("index asked") { self.indexCalls(transport) == ["s1"] }
    transport.files.set { $0.onListing = nil }
    transport.files.set { $0.onIndex = nil }
    await valve.release()
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    #expect(store.fileTree.fileIndex("s1") == .ready(try index(["src/main.ts", "deep/x/y.ts"], maxBytes: 8192).get()))
    #expect(indexCalls(transport) == ["s1"], "a second report of the same query asks nothing")
    #expect(transport.files.read(\.peakIndexing) == 1)
  }

  @Test("the index gives the preview limit before the first listing; the listing's limit wins once it comes")
  func indexLimitBeforeListing() async throws {
    let (store, transport) = try await store()
    let valve = Valve()
    transport.files.set {
      $0.indexResult = index(["a.txt"], maxBytes: 8192)
      $0.listingResult = .success(FileListing(dir: "", entries: [], truncated: false, maxBytes: 2048))
      $0.onListing = { await valve.wait() }
    }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    #expect(store.fileTree.maxBytes("s1") == 8192)
    transport.files.set { $0.onListing = nil }
    await valve.release()
    await until("listing landed") { store.fileTree.snapshot("s1").listings[""] != nil }
    #expect(store.fileTree.maxBytes("s1") == 2048)
  }

  @Test("ten turn ends in a row while a slow index request runs ask for it at most twice")
  func turnEndsFoldIntoOneRepeat() async throws {
    let (store, transport) = try await store()
    let valve = Valve()
    transport.files.set {
      $0.indexResult = index(["a.txt"])
      $0.onIndex = { await valve.wait() }
    }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("slow request held") { transport.files.read(\.indexing) == 1 }
    for _ in 0..<10 {
      try turn(store, "running")
      try turn(store, "waiting-input")
    }
    transport.files.set { $0.onIndex = nil }
    await valve.release()
    await until("repeat after the gap", timeout: .seconds(3)) { self.indexCalls(transport).count == 2 }
    await settle(store)
    try await Task.sleep(for: fastTiming.fileIndexRefreshGap * 2)
    #expect(indexCalls(transport).count == 2)
    #expect(transport.files.read(\.peakIndexing) == 1, "one request at a time")
  }

  @Test("an invalidation while a query stands asks again no sooner than the gap after the last request")
  func invalidationKeepsTheGap() async throws {
    let (store, transport) = try await store()
    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.panelOpened("s1")
    let started = ContinuousClock.now
    store.fileTree.setSearchActive(true, in: "s1")
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    store.setScenePhase(.background)
    store.setScenePhase(.active)
    try await Task.sleep(for: .milliseconds(50))
    #expect(indexCalls(transport).count == 1, "inside the gap the invalidation waits")
    await until("asked after the gap", timeout: .seconds(3)) { self.indexCalls(transport).count == 2 }
    #expect(ContinuousClock.now - started >= fastTiming.fileIndexRefreshGap)
    await settle(store)
    #expect(indexCalls(transport).count == 2)
  }

  @Test("index, cleared field, turn end, new query: a new request at once")
  func invalidatedWithEmptyField() async throws {
    let (store, transport) = try await store()
    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    store.fileTree.setSearchActive(false, in: "s1")
    try turn(store, "running")
    try turn(store, "waiting-input")
    try await Task.sleep(for: .milliseconds(30))
    #expect(indexCalls(transport).count == 1, "an empty field asks nothing")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("new request") { self.indexCalls(transport).count == 2 }
    #expect(store.fileTree.fileIndex("s1") != .notLoaded)
  }

  @Test("the panel opening invalidates the index also with an empty field")
  func panelOpenInvalidates() async throws {
    let (store, transport) = try await store(timing: slowIndexTiming)
    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    store.fileTree.setSearchActive(false, in: "s1")
    store.fileTree.setSearchActive(true, in: "s1")
    try await Task.sleep(for: .milliseconds(30))
    #expect(indexCalls(transport).count == 1, "a fresh index is not asked again")
    store.fileTree.setSearchActive(false, in: "s1")
    store.fileTree.panelClosed()
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("new request") { self.indexCalls(transport).count == 2 }
  }

  @Test("a changed git-status frame leaves the index alone")
  func gitStatusLeavesIndex() async throws {
    let (store, transport) = try await store(timing: slowIndexTiming)
    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    store.dispatch(.frame(
      try Frames.decode(#"{"type":"git-status","sessionId":"s1","branch":"main","dirtyCount":1,"files":["a.ts"]}"#),
      source: .session("s1"), cursor: nil))
    store.fileTree.setSearchActive(false, in: "s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("change list refreshed") { transport.files.read(\.diffCalls).count == 2 }
    await settle(store)
    #expect(indexCalls(transport).count == 1)
  }

  // MARK: - Failures and sources without an index

  @Test("an index error ends loading with the failed state; Retry and a new query ask again")
  func indexError() async throws {
    let (store, transport) = try await store()
    transport.files.set { $0.indexResult = .failure(.offline(.networkConnectionLost)) }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("failed") { store.fileTree.fileIndex("s1") == .failed(previous: nil) }
    await settle(store)
    #expect(indexCalls(transport).count == 1, "no retry on its own")
    #expect(store.fileTree.source("s1") == .files, "the tree keeps its source")

    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.reloadFileIndex("s1")
    await until("retry landed") { store.fileTree.fileIndex("s1").isReady }
    #expect(indexCalls(transport).count == 2)

    transport.files.set { $0.indexResult = .failure(.http(APIFailure(status: 404, code: "not-found"))) }
    store.fileTree.reloadFileIndex("s1")
    let ready = try index(["a.txt"]).get()
    await until("failed with the older index") { store.fileTree.fileIndex("s1") == .failed(previous: ready) }
    store.fileTree.setSearchActive(false, in: "s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("a new query asks again") { self.indexCalls(transport).count == 4 }
  }

  @Test("an index refused for a Codex entry or out of scope turns the session to the fallback source")
  func indexRefusalTurnsToFallback() async throws {
    for code in ["codex", "out-of-scope"] {
      let (store, transport) = try await store()
      transport.files.set { $0.indexResult = .failure(.http(APIFailure(status: 400, code: code))) }
      store.fileTree.panelOpened("s1")
      store.fileTree.setSearchActive(true, in: "s1")
      await until("refused") { store.fileTree.source("s1") == .fallback }
      #expect(store.fileTree.fileIndex("s1") == .unsupported)
    }
  }

  @Test("a server with files but without file-index: no index request, the unsupported state")
  func oldServer() async throws {
    let (store, transport) = try await store(capabilities: ["files"])
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await settle(store)
    try await Task.sleep(for: .milliseconds(30))
    #expect(indexCalls(transport).isEmpty)
    #expect(store.fileTree.fileIndex("s1") == .unsupported)
    #expect(transport.files.read(\.listings).isEmpty == false, "the tree itself still loads")
  }

  @Test("the server starting to announce file-index asks for the index of a standing query")
  func capabilityAppears() async throws {
    let (store, transport) = try await store(capabilities: ["files"])
    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await settle(store)
    store.dispatch(.versionProbed(try version(["files", "file-index"])))
    await until("asked") { self.indexCalls(transport) == ["s1"] }
  }

  @Test("the fallback source (no files, Codex, out of scope): no index request, the unsupported state")
  func fallbackSources() async throws {
    let cases: [([String], String)] = [
      ([], ""), (["files", "file-index"], #","engine":"codex""#), (["files", "file-index"], #","outOfScope":true"#),
    ]
    for (capabilities, extra) in cases {
      let (store, transport) = try await store(capabilities: capabilities, extra: extra)
      store.fileTree.panelOpened("s1")
      store.fileTree.setSearchActive(true, in: "s1")
      store.setScenePhase(.background)
      store.setScenePhase(.active)
      try await Task.sleep(for: .milliseconds(50))
      #expect(indexCalls(transport).isEmpty)
      #expect(store.fileTree.fileIndex("s1") == .unsupported)
    }
  }

  // MARK: - Dropped answers

  @Test("an index answer after the panel switched session is dropped; back on the session a new request goes out")
  func answerAfterSessionSwitch() async throws {
    let (store, transport) = try await store()
    let valve = Valve()
    transport.files.set {
      $0.indexResult = index(["old.txt"])
      $0.onIndex = { await valve.wait() }
    }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("s1 in flight") { transport.files.read(\.indexing) == 1 }
    store.fileTree.panelOpened("s2")
    #expect(store.fileTree.fileIndex("s1") == .notLoaded, "the dropped request is not loading")
    transport.files.set { $0.onIndex = nil }
    await valve.release()
    await until("held answer landed") { transport.files.read(\.indexing) == 0 }
    await settle(store)
    #expect(store.fileTree.fileIndex("s1") == .notLoaded)

    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("new request") { self.indexCalls(transport).count == 2 }
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
  }

  @Test("the session the panel leaves forgets its query: back on it, the panel and turn ends ask nothing")
  func leftSessionForgetsItsQuery() async throws {
    let (store, transport) = try await store()
    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    await settle(store)
    // On s2 the mode turns to Changed only, so s1's screen comes back without a query that searches the index and
    // has nothing to report.
    store.fileTree.panelOpened("s2")
    store.fileTree.panelOpened("s1")
    try turn(store, "running")
    try turn(store, "waiting-input")
    await settle(store)
    try await Task.sleep(for: fastTiming.fileIndexRefreshGap * 1.5)
    #expect(indexCalls(transport) == ["s1"], "no request from the query left behind")
  }

  @Test("a query standing on the session the panel comes back to asks again, whichever reports first")
  func queryBackOnSessionAsksAgain() async throws {
    for screenFirst in [false, true] {
      let (store, transport) = try await store()
      transport.files.set { $0.indexResult = index(["a.txt"]) }
      store.fileTree.panelOpened("s1")
      store.fileTree.setSearchActive(true, in: "s1")
      await until("index landed") { store.fileTree.fileIndex("s1").isReady }
      await settle(store)
      store.fileTree.panelOpened("s2")
      if screenFirst {
        store.fileTree.setSearchActive(true, in: "s1")
        store.fileTree.panelOpened("s1")
      } else {
        store.fileTree.panelOpened("s1")
        store.fileTree.setSearchActive(true, in: "s1")
      }
      await until("asked again", timeout: .seconds(3)) { self.indexCalls(transport).count == 2 }
      await settle(store)
      #expect(indexCalls(transport) == ["s1", "s1"], "screen first: \(screenFirst)")
    }
  }

  @Test("a session gone from the list and back, or a new login, forgets the query: the panel alone asks nothing")
  func queryForgottenWithSession() async throws {
    let (store, transport) = try await store()
    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    store.dispatch(.frame(try Frames.snapshot([Frames.summary("s2", title: "other")]), source: .global, cursor: nil))
    store.dispatch(.frame(
      try Frames.snapshot([Frames.summary("s1"), Frames.summary("s2", title: "other")]), source: .global, cursor: nil))
    store.fileTree.panelOpened("s1")
    await settle(store)
    try await Task.sleep(for: fastTiming.fileIndexRefreshGap * 1.5)
    #expect(indexCalls(transport).count == 1, "the screen reports its query again on appearing")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("the new report asks") { self.indexCalls(transport).count == 2 }
  }

  @Test("logout drops the index, and an answer held across it never lands")
  func logoutDropsIndex() async throws {
    let (store, transport) = try await store()
    transport.files.set { $0.indexResult = index(["a.txt"]) }
    store.fileTree.panelOpened("s1")
    store.fileTree.setSearchActive(true, in: "s1")
    await until("index landed") { store.fileTree.fileIndex("s1").isReady }
    await settle(store)

    let valve = Valve()
    transport.files.set { $0.onIndex = { await valve.wait() } }
    store.fileTree.reloadFileIndex("s1")
    await until("reload in flight") { transport.files.read(\.indexing) == 1 }
    store.handleUnauthorized()
    await until("logged out") { store.state.auth != .loggedIn }
    #expect(store.fileTree.maxBytes("s1") == nil)
    await valve.release()
    await until("held answer landed") { transport.files.read(\.indexing) == 0 }
    try await Task.sleep(for: .milliseconds(20))
    #expect(store.fileTree.fileIndex("s1").isReady == false)
    #expect(store.fileTree.maxBytes("s1") == nil)
  }
}

extension FileIndexState {
  fileprivate var isReady: Bool {
    if case .ready = self { return true }
    return false
  }
}
