import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// The file tree of the open panel: which directories are listed, the fallback source, a vanished directory, the hand
// toggles per session, the cap of requests in flight and the answers dropped after a session change. Owner: session
// files (native app).

@MainActor
@Suite("file tree store: listings, change list and refresh queue")
struct FileTreeStoreTests {
  private func version(_ capabilities: [String]) throws -> VersionInfo {
    let list = capabilities.map { #""\#($0)""# }.joined(separator: ",")
    let json = #"{"version":"1.0.0","protocolVersion":3,"serverStartId":"s","capabilities":[\#(list)]}"#
    return try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
  }

  /// A logged-in store with two known sessions (`extra` goes into the summary of `s1`) and, by default, `files`.
  private func store(files: Bool = true, extra: String = "") async throws -> (RarogStore, FakeTransport) {
    let transport = FakeTransport()
    let rules = MutationRules(timing: fastTiming)
    transport.gate = MutationGate(policy: rules)
    let store = RarogStore(
      transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
    await store.start()
    await until("logged in") { store.state.auth == .loggedIn }
    store.dispatch(.frame(
      try Frames.snapshot([Frames.summary("s1", extra: extra), Frames.summary("s2", title: "other")]),
      source: .global, cursor: nil))
    if files { store.dispatch(.versionProbed(try version(["files"]))) }
    return (store, transport)
  }

  private func dir(_ name: String) -> FileEntry { FileEntry(name: name, kind: .dir) }
  private func file(_ name: String) -> FileEntry { FileEntry(name: name, kind: .file, size: 10) }

  private func listing(_ dir: String, _ entries: [FileEntry], maxBytes: Int = 1_048_576)
    -> Result<FileListing, TransportError>
  {
    .success(FileListing(dir: dir, entries: entries, truncated: false, maxBytes: maxBytes))
  }

  private func changes(_ paths: [String]) -> Result<DiffFileList, TransportError> {
    .success(DiffFileList(files: paths.map { DiffListEntry(path: $0, status: .modified) }, truncated: false))
  }

  private func listed(_ transport: FakeTransport) -> [String] {
    transport.files.read(\.listings).map(\.dir)
  }

  private func settle(_ store: RarogStore) async {
    await until("tree idle") { store.fileTree.idle }
  }

  // MARK: - Rule

  @Test("a directory with a change under it starts open, the rest closed; a hand toggle wins either way")
  func expansionRule() {
    let changed = FileTreeRules.changedDirectories(["src/app/main.ts", "README.md", "docs/", ".github/ci.yml"])
    #expect(changed == ["src", "src/app", ".github"])
    #expect(FileTreeRules.isExpanded("src", toggles: [:], changed: changed))
    #expect(!FileTreeRules.isExpanded("lib", toggles: [:], changed: changed))
    #expect(!FileTreeRules.isExpanded("src", toggles: ["src": false], changed: changed))
    #expect(FileTreeRules.isExpanded("lib", toggles: ["lib": true], changed: changed))
  }

  // MARK: - What is listed

  @Test("open directories are listed top-down; a closed one, a hidden one and one known only from changes are not")
  func listsOpenDirectories() async throws {
    let (store, transport) = try await store()
    transport.files.set {
      $0.listingByDir[""] = listing("", [dir("lib"), dir("src"), file("README.md")], maxBytes: 4096)
      $0.listingByDir["src"] = listing("src", [dir("app"), file("index.ts")])
      $0.listingByDir["src/app"] = listing("src/app", [file("main.ts")], maxBytes: 8192)
      $0.diffResult = changes(["src/app/main.ts", ".github/workflows/ci.yml", "gone/old.txt"])
    }
    store.fileTree.panelOpened("s1")
    await until("open directories listed") { Set(self.listed(transport)) == ["", "src", "src/app"] }
    await settle(store)
    #expect(Set(listed(transport)) == ["", "src", "src/app"], "no lib, .github or gone")
    #expect(listed(transport).count == 3)
    let snapshot = store.fileTree.snapshot("s1")
    #expect(snapshot.source == .files)
    #expect(Set(snapshot.listings.keys) == ["", "src", "src/app"])
    #expect(snapshot.diff?.files.count == 3)
    #expect(store.fileTree.maxBytes("s1") == 8192, "the limit of the latest listing")
  }

  @Test("no files capability, a Codex entry or a session out of scope: the fallback source, no request")
  func fallbackSources() async throws {
    for (files, extra) in [(false, ""), (true, #","engine":"codex""#), (true, #","outOfScope":true"#)] {
      let (store, transport) = try await store(files: files, extra: extra)
      store.fileTree.panelOpened("s1")
      store.fileTree.setExpanded("src", true, in: "s1")
      try await Task.sleep(for: .milliseconds(50))
      #expect(store.fileTree.snapshot("s1").source == .fallback)
      #expect(transport.files.read(\.listings).isEmpty && transport.files.read(\.diffCalls).isEmpty)
    }
  }

  @Test("a listing refused for a Codex entry or out of scope turns the session to the fallback source")
  func refusalTurnsToFallback() async throws {
    for code in ["codex", "out-of-scope"] {
      let (store, transport) = try await store()
      transport.files.set {
        $0.listingResult = .failure(.http(APIFailure(status: 400, code: code)))
        $0.diffResult = changes([])
      }
      store.fileTree.panelOpened("s1")
      await until("refused") { store.fileTree.source("s1") == .fallback }
      #expect(store.fileTree.snapshot("s1") == FileTreeSnapshot(source: .fallback))
      #expect(store.fileTree.source("s2") == .files)
    }
  }

  @Test("a 404 listing drops that directory and the listings under it; the rest of the tree stays")
  func vanishedDirectory() async throws {
    let (store, transport) = try await store()
    transport.files.set {
      $0.listingByDir[""] = listing("", [dir("docs"), dir("src")])
      $0.listingByDir["src"] = listing("src", [dir("app"), file("a.ts")])
      $0.listingByDir["src/app"] = listing("src/app", [file("b.ts")])
      $0.listingByDir["docs"] = listing("docs", [file("guide.md")])
      $0.diffResult = changes(["src/app/b.ts", "docs/guide.md"])
    }
    store.fileTree.panelOpened("s1")
    await until("four listings") { store.fileTree.snapshot("s1").listings.count == 4 }
    await settle(store)

    transport.files.set { $0.listingByDir["src"] = .failure(.http(APIFailure(status: 404, code: "not-found"))) }
    store.fileTree.setExpanded("src", true, in: "s1")
    await until("src gone") { store.fileTree.snapshot("s1").gone.contains("src") }
    await settle(store)
    let snapshot = store.fileTree.snapshot("s1")
    #expect(Set(snapshot.listings.keys) == ["", "docs"])

    // A fresh listing of the parent is the truth again.
    transport.files.set { $0.listingByDir["src"] = listing("src", [file("a.ts")]) }
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)
    store.fileTree.requestRefresh()
    await until("src back") { store.fileTree.snapshot("s1").listings["src"] != nil }
    #expect(store.fileTree.snapshot("s1").gone.isEmpty)
  }

  // MARK: - Hand toggles

  @Test("a hand toggle stays with its session across a switch, and opening a closed directory lists it")
  func togglesPerSession() async throws {
    let (store, transport) = try await store()
    transport.files.set {
      $0.listingByDir[""] = listing("", [dir("lib"), dir("src")])
      $0.diffResult = changes(["src/a.ts"])
    }
    store.fileTree.panelOpened("s1")
    await until("src listed") { self.listed(transport).contains("src") }
    await settle(store)
    store.fileTree.setExpanded("src", false, in: "s1")
    store.fileTree.setExpanded("lib", true, in: "s1")
    await until("lib listed") { self.listed(transport).contains("lib") }
    await settle(store)

    store.fileTree.panelOpened("s2")
    await settle(store)
    #expect(store.fileTree.snapshot("s2").toggles.isEmpty)
    store.fileTree.panelOpened("s1")
    await settle(store)
    #expect(store.fileTree.snapshot("s1").toggles == ["src": false, "lib": true])
    let s1Calls = transport.files.read(\.listings).filter { $0.sessionId == "s1" }.map(\.dir)
    #expect(s1Calls.filter { $0 == "src" }.count == 1, "a closed directory is not refreshed")
  }

  // MARK: - Queue

  @Test("five refresh triggers at once are one pass with at most four requests in flight")
  func fiveTriggersOnePass() async throws {
    let (store, transport) = try await store()
    let names = ["a", "b", "c", "d", "e"]
    transport.files.set {
      $0.listingByDir[""] = listing("", (names + ["f"]).map(dir))
      $0.diffResult = changes(names.map { "\($0)/x.ts" })
    }
    store.fileTree.panelOpened("s1")
    await until("first load") { self.listed(transport).count == 6 }
    await settle(store)
    #expect(transport.files.read(\.peakReading) <= FileTreeStore.maxInFlight)
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)

    let valve = Valve()
    transport.files.set {
      $0.listings = []
      $0.diffCalls = []
      $0.peakReading = 0
      $0.onListing = { await valve.wait() }
      $0.onDiff = { await valve.wait() }
    }
    store.fileTree.panelOpened("s1")
    store.fileTree.setExpanded("f", true, in: "s1")
    store.setScenePhase(.background)
    store.setScenePhase(.active)
    store.dispatch(.frame(
      try Frames.decode(#"{"type":"git-status","sessionId":"s1","branch":"main","dirtyCount":1,"files":["a/x.ts"]}"#),
      source: .session("s1"), cursor: nil))
    store.dispatch(.frame(
      try Frames.state("s1", "waiting-input", since: "2026-10-03T08:01:00.000Z"), source: .global, cursor: nil))
    await until("cap reached") { transport.files.read(\.reading) == FileTreeStore.maxInFlight }
    try await Task.sleep(for: .milliseconds(50))
    #expect(transport.files.read(\.reading) == FileTreeStore.maxInFlight)
    await valve.release()
    await settle(store)
    #expect(transport.files.read(\.peakReading) == FileTreeStore.maxInFlight)
    #expect(transport.files.read(\.diffCalls).count == 1)
    #expect(listed(transport).sorted() == ["", "a", "b", "c", "d", "e", "f"], "each directory once")
  }

  @Test("the store refreshes on a changed git-status frame and on the end of a turn, not on a usage frame")
  func selfWiredTriggers() async throws {
    let (store, transport) = try await store()
    transport.files.set { $0.diffResult = changes([]) }
    store.fileTree.panelOpened("s1")
    await until("first load") { transport.files.read(\.diffCalls).count == 1 }
    await settle(store)
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)

    store.dispatch(.frame(
      try Frames.decode(#"{"type":"usage","sessionId":"s1","contextTokens":10,"contextLimit":100}"#),
      source: .session("s1"), cursor: nil))
    try await Task.sleep(for: .milliseconds(30))
    #expect(transport.files.read(\.diffCalls).count == 1, "a usage frame is no trigger")

    store.dispatch(.frame(
      try Frames.decode(#"{"type":"git-status","sessionId":"s1","branch":"main","dirtyCount":1,"files":["a.ts"]}"#),
      source: .session("s1"), cursor: nil))
    await until("git-status refresh") { transport.files.read(\.diffCalls).count == 2 }
    await settle(store)
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)

    store.dispatch(.frame(
      try Frames.state("s1", "waiting-input", since: "2026-10-03T08:01:00.000Z"), source: .global, cursor: nil))
    await until("turn end refresh") { transport.files.read(\.diffCalls).count == 3 }
    await settle(store)

    store.fileTree.panelClosed()
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)
    store.dispatch(.frame(
      try Frames.decode(#"{"type":"git-status","sessionId":"s1","branch":"main","dirtyCount":2,"files":["a.ts","b"]}"#),
      source: .session("s1"), cursor: nil))
    try await Task.sleep(for: .milliseconds(30))
    #expect(transport.files.read(\.diffCalls).count == 3, "a closed panel asks nothing")
  }

  @Test("an answer that comes after the panel switched to another session is dropped")
  func answerAfterSessionSwitch() async throws {
    let (store, transport) = try await store()
    let valve = Valve()
    transport.files.set {
      $0.listingByDir[""] = listing("", [file("old.txt")])
      $0.diffResult = changes(["old.txt"])
      $0.onListing = { await valve.wait() }
      $0.onDiff = { await valve.wait() }
    }
    store.fileTree.panelOpened("s1")
    await until("s1 in flight") { transport.files.read(\.reading) == 2 }
    store.fileTree.panelOpened("s2")
    transport.files.set {
      $0.onListing = nil
      $0.onDiff = nil
    }
    await valve.release()
    await until("held answers landed") { transport.files.read(\.reading) == 0 }
    await settle(store)
    #expect(store.fileTree.snapshot("s1").listings.isEmpty)
    #expect(store.fileTree.snapshot("s1").diff == nil)
    #expect(store.fileTree.snapshot("s2").listings[""] != nil)
  }

  @Test("logout drops the tree, and an answer held across it never lands")
  func logoutDropsTree() async throws {
    let (store, transport) = try await store()
    transport.files.set { $0.diffResult = changes([]) }
    store.fileTree.panelOpened("s1")
    await until("loaded") { store.fileTree.snapshot("s1").listings[""] != nil }
    await settle(store)
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)

    let valve = Valve()
    transport.files.set {
      $0.listingByDir[""] = listing("", [file("late.txt")])
      $0.onListing = { await valve.wait() }
    }
    store.fileTree.setExpanded("", true, in: "s1")
    await until("refresh in flight") { transport.files.read(\.reading) == 1 }
    store.handleUnauthorized()
    await until("logged out") { store.state.auth != .loggedIn }
    #expect(store.fileTree.openSessionId == nil && !store.fileTree.panelOpen)
    #expect(store.fileTree.maxBytes("s1") == nil)
    await valve.release()
    await until("held answer landed") { transport.files.read(\.reading) == 0 }
    try await Task.sleep(for: .milliseconds(20))
    #expect(store.fileTree.snapshot("s1").listings.isEmpty)
  }

  @Test("a listing that failed is asked again when a person opens the directory")
  func retryAfterFailure() async throws {
    let (store, transport) = try await store()
    transport.files.set {
      $0.listingByDir[""] = listing("", [dir("lib")])
      $0.listingByDir["lib"] = .failure(.offline(.networkConnectionLost))
      $0.diffResult = changes([])
    }
    store.fileTree.panelOpened("s1")
    store.fileTree.setExpanded("lib", true, in: "s1")
    await until("lib failed") { self.listed(transport).contains("lib") }
    await settle(store)
    transport.files.set { $0.listingByDir["lib"] = listing("lib", [file("a.go")]) }
    store.fileTree.setExpanded("lib", false, in: "s1")
    store.fileTree.setExpanded("lib", true, in: "s1")
    await until("lib listed") { store.fileTree.snapshot("s1").listings["lib"] != nil }
  }

  @Test("a directory a new change list opens again is listed afresh, not left with its old listing")
  func reopenedByChangesIsRefreshed() async throws {
    let (store, transport) = try await store()
    transport.files.set {
      $0.listingByDir[""] = listing("", [dir("src")])
      $0.listingByDir["src"] = listing("src", [file("a.ts")])
      $0.diffResult = changes(["src/a.ts"])
    }
    store.fileTree.panelOpened("s1")
    await until("src listed") { store.fileTree.snapshot("s1").listings["src"] != nil }
    await settle(store)

    transport.files.set { $0.diffResult = changes([]) }
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)
    store.fileTree.requestRefresh()
    await until("clean change list") { store.fileTree.snapshot("s1").diff?.files.isEmpty == true }
    await settle(store)

    transport.files.set {
      $0.listingByDir["src"] = listing("src", [file("a.ts"), file("b.ts")])
      $0.diffResult = changes(["src/b.ts"])
    }
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)
    store.fileTree.requestRefresh()
    await until("src listed afresh", timeout: .seconds(2)) {
      store.fileTree.snapshot("s1").listings["src"]?.entries.count == 2
    }
  }

  @Test("several triggers during one request ask it exactly once more after its answer", arguments: [false, true])
  func oneRepeatAfterAnswer(failing: Bool) async throws {
    let (store, transport) = try await store()
    transport.files.set {
      $0.listingByDir[""] = listing("", [file("a.txt")])
      $0.diffResult = changes([])
    }
    store.fileTree.panelOpened("s1")
    await until("loaded") { store.fileTree.snapshot("s1").listings[""] != nil }
    await settle(store)
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap)

    let valve = Valve()
    transport.files.set { $0.onListing = { await valve.wait() } }
    store.fileTree.requestRefresh()
    await until("held") { self.listed(transport).count == 2 }
    for _ in 0..<3 {
      store.fileTree.requestRefresh()
      try await Task.sleep(for: fastTiming.fileTreeRefreshGap * 1.5)
    }
    transport.files.set {
      $0.onListing = nil
      if failing { $0.listingByDir[""] = .failure(.offline(.networkConnectionLost)) }
    }
    await valve.release()
    await until("repeat") { self.listed(transport).count == 3 }
    await settle(store)
    try await Task.sleep(for: fastTiming.fileTreeRefreshGap * 2)
    #expect(listed(transport) == ["", "", ""])
  }

  @Test("listings stay for the last few sessions only, a session gone from the list loses all, hand toggles stay")
  func retention() async throws {
    let (store, transport) = try await store()
    let ids = ["s1", "s2", "s3", "s4", "s5"]
    store.dispatch(.frame(try Frames.snapshot(ids.map { Frames.summary($0) }), source: .global, cursor: nil))
    transport.files.set {
      $0.listingByDir[""] = listing("", [file("a.txt")])
      $0.diffResult = changes([])
    }
    let visited = Array(ids.prefix(FileTreeStore.retainedSessions + 1))
    for id in visited {
      store.fileTree.panelOpened(id)
      store.fileTree.setExpanded("lib", true, in: id)
      await until("\(id) loaded") { store.fileTree.snapshot(id).listings[""] != nil }
      await settle(store)
    }
    let evicted = visited[0]
    #expect(store.fileTree.snapshot(evicted).listings.isEmpty && store.fileTree.snapshot(evicted).diff == nil)
    #expect(store.fileTree.maxBytes(evicted) == nil)
    #expect(store.fileTree.snapshot(evicted).toggles == ["lib": true], "dropping listings keeps the hand toggles")
    for id in visited.dropFirst() { #expect(store.fileTree.snapshot(id).listings[""] != nil, "\(id) kept") }

    let removed = visited[2]
    store.dispatch(.frame(
      try Frames.snapshot(ids.filter { $0 != removed }.map { Frames.summary($0) }), source: .global, cursor: nil))
    #expect(store.fileTree.snapshot(removed).listings.isEmpty)
    #expect(store.fileTree.snapshot(removed).toggles.isEmpty, "a session gone from the list loses its toggles")
    #expect(store.fileTree.snapshot(evicted).toggles == ["lib": true])
    #expect(store.fileTree.snapshot(visited[3]).listings[""] != nil)
  }
}
