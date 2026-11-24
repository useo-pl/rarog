import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Session files in the store: the routes go out only while the server announces `files`, a refusal comes back with
// its status and code, and a result from before a logout or a new login never reaches the caller (a fetched copy is
// deleted first). Owner: session files (native app).

@MainActor
@Suite("store: session file routes behind the files capability")
struct StoreSessionFilesTests {
  private func version(_ capabilities: [String]) throws -> VersionInfo {
    let list = capabilities.map { #""\#($0)""# }.joined(separator: ",")
    let json = #"{"version":"1.0.0","protocolVersion":3,"serverStartId":"s","capabilities":[\#(list)]}"#
    return try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
  }

  /// A logged-in store over the base fake.
  private func store() async -> (RarogStore, FakeTransport) {
    let transport = FakeTransport()
    let rules = MutationRules(timing: fastTiming)
    transport.gate = MutationGate(policy: rules)
    let store = RarogStore(
      transport: transport, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
    await store.start()
    await until("logged in") { store.state.auth == .loggedIn }
    return (store, transport)
  }

  @Test("no version probe yet, or a server without files: neither route goes out")
  func withoutCapability() async throws {
    let (store, transport) = await store()
    #expect(!store.state.filesAvailable)
    #expect(await store.sessionFiles("s1", dir: "") == .unavailable)
    #expect(await store.fetchSessionFile("s1", path: "a.txt", maxBytes: 10) == .unavailable)
    store.dispatch(.versionProbed(try version(["inbox"])))
    #expect(!store.state.filesAvailable)
    #expect(await store.sessionFiles("s1", dir: "src") == .unavailable)
    #expect(await store.fetchSessionFile("s1", path: "src/a.txt", maxBytes: 10) == .unavailable)
    #expect(transport.files.read(\.listings).isEmpty && transport.files.read(\.fetches).isEmpty)
  }

  @Test("with files the routes go out with the caller's directory, path and limit; losing files stops them again")
  func withCapability() async throws {
    let (store, transport) = await store()
    store.dispatch(.versionProbed(try version(["files"])))
    #expect(store.state.filesAvailable)
    let copy = URL(filePath: "/private/copy.pdf")
    transport.files.set { $0.fetchResult = .success(.saved(copy)) }
    #expect(await store.sessionFiles("s1", dir: "docs")
      == .loaded(FileListing(dir: "docs", entries: [], truncated: false, maxBytes: 1_048_576)))
    #expect(await store.fetchSessionFile("s1", path: "docs/brief.pdf", maxBytes: 4096) == .loaded(.saved(copy)))
    #expect(transport.files.read(\.listings) == [.init(sessionId: "s1", dir: "docs")])
    #expect(transport.files.read(\.fetches) == [.init(sessionId: "s1", path: "docs/brief.pdf", maxBytes: 4096)])

    store.dispatch(.versionProbed(try version([])))
    #expect(await store.sessionFiles("s1", dir: "docs") == .unavailable)
    #expect(transport.files.read(\.listings).count == 1)
  }

  @Test("a refusal keeps its status and code; offline stays offline")
  func refusals() async throws {
    let (store, transport) = await store()
    store.dispatch(.versionProbed(try version(["files"])))
    transport.files.set {
      $0.listingResult = .failure(.http(APIFailure(status: 404, code: "not-found", message: "gone")))
      $0.fetchResult = .failure(.offline(.networkConnectionLost))
    }
    #expect(await store.sessionFiles("s1", dir: "gone")
      == .refused(DiffRefusal(status: 404, code: "not-found", message: "gone")))
    #expect(await store.fetchSessionFile("s1", path: "a.txt", maxBytes: 10) == .offline)
  }

  /// How the login of a held request ends before its answer comes.
  enum LoginEnd: String, CaseIterable, Sendable {
    case logout
    case newLogin
  }

  private func end(_ login: LoginEnd, of store: RarogStore) async {
    store.handleUnauthorized()
    await until("logged out") { store.state.auth != .loggedIn }
    if login == .newLogin {
      store.enterLoggedIn()
      await until("logged in again") { store.state.auth == .loggedIn }
    }
  }

  @Test("a listing held past the end of its login is dropped", arguments: LoginEnd.allCases)
  func staleListing(_ login: LoginEnd) async throws {
    let (store, transport) = await store()
    store.dispatch(.versionProbed(try version(["files"])))
    let valve = Valve()
    transport.files.set { $0.onListing = { await valve.wait() } }
    let pending = Task { await store.sessionFiles("s1", dir: "docs") }
    await until("listing in flight") { transport.files.read(\.listings).count == 1 }
    await end(login, of: store)
    await valve.release()
    #expect(await pending.value == .loggedOut)
  }

  @Test("a copy fetched past the end of its login is deleted and not handed over", arguments: LoginEnd.allCases)
  func staleFetch(_ login: LoginEnd) async throws {
    let (store, transport) = await store()
    store.dispatch(.versionProbed(try version(["files"])))
    let copy = FileManager.default.temporaryDirectory.appending(path: "rarog-core-files-\(UUID().uuidString).pdf")
    try Data("old login".utf8).write(to: copy)
    defer { try? FileManager.default.removeItem(at: copy) }
    let valve = Valve()
    transport.files.set {
      $0.fetchResult = .success(.saved(copy))
      $0.onFetch = { await valve.wait() }
    }
    let pending = Task { await store.fetchSessionFile("s1", path: "docs/brief.pdf", maxBytes: 4096) }
    await until("fetch in flight") { transport.files.read(\.fetches).count == 1 }
    await end(login, of: store)
    await valve.release()
    #expect(await pending.value == .loggedOut)
    #expect(!FileManager.default.fileExists(atPath: copy.path(percentEncoded: false)))
  }

  @Test("a failure of a request from an ended login is dropped too", arguments: LoginEnd.allCases)
  func staleFailure(_ login: LoginEnd) async throws {
    let (store, transport) = await store()
    store.dispatch(.versionProbed(try version(["files"])))
    let valve = Valve()
    transport.files.set {
      $0.fetchResult = .failure(.http(APIFailure(status: 404, code: "not-found")))
      $0.onFetch = { await valve.wait() }
    }
    let pending = Task { await store.fetchSessionFile("s1", path: "gone.txt", maxBytes: 10) }
    await until("fetch in flight") { transport.files.read(\.fetches).count == 1 }
    await end(login, of: store)
    await valve.release()
    #expect(await pending.value == .loggedOut)
  }
}
