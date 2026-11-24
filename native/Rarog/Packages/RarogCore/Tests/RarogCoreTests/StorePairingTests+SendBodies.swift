import Foundation
@testable import RarogCore
import Testing

// A send with attachments composes its body in a `rarog-send-*.json` file of the temporary directory and removes it
// after the request. A process killed during the send leaves the file behind: the app's store factory removes such
// files at start, and nothing else in that directory.

extension StorePairingTests {
  @Test("the app's store factory removes send bodies left by an earlier process and keeps other files")
  func liveRemovesOrphanSendBodies() throws {
    let directory = temporaryOutbox()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let orphan = directory.appending(path: "rarog-send-x.json")
    let other = directory.appending(path: "notes.json")
    try Data("{}".utf8).write(to: orphan)
    try Data("{}".utf8).write(to: other)
    let server = FakeServer()
    _ = RarogStore.live(
      connector: server.connector, preferences: server.preferences, spaces: server.spaces, temporaryDirectory: directory)
    #expect(!FileManager.default.fileExists(atPath: orphan.path), "the orphaned send body is gone")
    #expect(FileManager.default.fileExists(atPath: other.path))
  }
}
