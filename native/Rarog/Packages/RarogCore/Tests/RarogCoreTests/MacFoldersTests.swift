import Foundation
import RarogContract
@testable import RarogCore
import Testing

// The macOS folders the server keeps closed: the `folder-access` frame in the state and the sessions it touches.

private let home = "/Users/demo"

private func block(_ name: String, state: String = "waiting", path: String? = nil) -> String {
  #"{"name":"\#(name)","path":"\#(path ?? "\(home)/\(name)")","state":"\#(state)","since":"2026-10-03T08:14:05.000Z"}"#
}

private func folderAccess(_ blocks: [String]) throws -> ServerEvent {
  try Frames.decode(#"{"type":"folder-access","blocked":[\#(blocks.joined(separator: ","))]}"#)
}

/// A session whose directory is `cwd`.
private func summary(_ id: String, cwd: String) -> String {
  Frames.summary(id).replacingOccurrences(of: #""cwd":"/Users/demo/projekt""#, with: #""cwd":"\#(cwd)""#)
}

struct MacFoldersTests {
  @Test("folder-access replaces the whole list; an empty frame clears it")
  func replaces() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try folderAccess([block("Desktop"), block("Documents", state: "denied")])])
    #expect(state.macFolders.map(\.name) == ["Desktop", "Documents"])
    #expect(state.macFolders.map(\.state) == [.waiting, .denied])
    play(&state, [try folderAccess([block("Documents", state: "denied")])])
    #expect(state.macFolders.map(\.name) == ["Documents"])
    play(&state, [try folderAccess([])])
    #expect(state.macFolders.isEmpty)
  }

  @Test("a new global connection clears the list and the frame after the snapshot brings it back; a live snapshot keeps it")
  func reconnect() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.hello(), try Frames.snapshot([]), try folderAccess([block("Desktop")])])
    #expect(state.macFolders.map(\.name) == ["Desktop"])
    // `sessions-snapshot` also comes live (a return from the background without a new connection).
    play(&state, [try Frames.snapshot([Frames.summary("s1")])])
    #expect(state.macFolders.map(\.name) == ["Desktop"], "a snapshot does not clear the folders")
    // A session stream's hello is not a new connection of the list.
    play(&state, [try Frames.hello()], source: .session("s1"))
    #expect(state.macFolders.map(\.name) == ["Desktop"], "a session stream's hello keeps the folders")
    play(&state, [try Frames.hello()])
    #expect(state.macFolders.isEmpty, "a new global connection starts without folders")
    play(&state, [try Frames.snapshot([Frames.summary("s1")]), try folderAccess([block("Desktop")])])
    #expect(state.macFolders.map(\.name) == ["Desktop"], "the frame after the snapshot brings the banner back")
  }

  @Test("an older server sends no frame: no closed folders")
  func olderServer() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try Frames.hello(), try Frames.snapshot([summary("s1", cwd: "\(home)/Desktop/atlas")])])
    #expect(state.macFolders.isEmpty)
    #expect(state.macFolder(holding: "\(home)/Desktop/atlas") == nil)
    #expect(state.macFolderSessions.isEmpty)
  }

  @Test("logging out or switching servers drops the folders of the old server")
  func reset() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try folderAccess([block("Desktop")])])
    state.apply(.switchingServer, now: Date(timeIntervalSince1970: 1_790_000_000))
    #expect(state.macFolders.isEmpty)
  }

  @Test("a directory lies in a folder when it is the folder or under it; a name that only starts the same does not")
  func holding() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [try folderAccess([block("Desktop"), block("Documents", state: "unchecked", path: "\(home)/Documents/")])])
    #expect(state.macFolder(holding: "\(home)/Desktop")?.name == "Desktop")
    #expect(state.macFolder(holding: "\(home)/Desktop/")?.name == "Desktop")
    #expect(state.macFolder(holding: "\(home)/Desktop/atlas/src")?.name == "Desktop")
    #expect(state.macFolder(holding: "\(home)/Desktop2") == nil)
    #expect(state.macFolder(holding: "\(home)/Desktop2/atlas") == nil)
    #expect(state.macFolder(holding: "\(home)/Projects/atlas") == nil)
    #expect(state.macFolder(holding: "\(home)/Documents/p")?.name == "Documents", "a path with a trailing slash")
  }

  @Test("the sessions in closed folders, in a stable order; sessions elsewhere stay out")
  func sessions() throws {
    var state = AppState(clientBuild: 7)
    play(&state, [
      try Frames.snapshot([
        summary("s3", cwd: "\(home)/Desktop/c"), summary("s1", cwd: "\(home)/Desktop"),
        summary("s2", cwd: "\(home)/Projects/b"), summary("s4", cwd: "\(home)/Desktop2/d"),
      ]),
      try folderAccess([block("Desktop")]),
    ])
    #expect(state.macFolderSessions.map(\.id) == ["s1", "s3"])
    #expect(state.macFolder(forSession: "s3")?.name == "Desktop")
    #expect(state.macFolder(forSession: "s2") == nil)
    #expect(state.macFolder(forSession: "nope") == nil)
  }
}
