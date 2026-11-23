import Foundation
@testable import RarogCore
import Testing

// Device history of visited sessions: order, ceiling, the read for the
// switcher window and the stored form.

@Suite("session history: visits, ceiling, recent sessions, storage")
struct SessionHistoryTests {
  @Test("a revisit moves the session to the end; repeating the current one records nothing")
  func noteOrder() {
    var history = SessionHistory()
    let changes = ["a", "b", "a"].map { history.note($0) }
    #expect(changes == [true, true, true])
    #expect(history.ids == ["b", "a"])

    var repeated = SessionHistory()
    let first = repeated.note("a")
    let second = repeated.note("a")
    let empty = repeated.note("")
    #expect(first && !second, "the current session again changes nothing")
    #expect(repeated.ids == ["a"])
    #expect(!empty, "an empty id is not a visit")
  }

  @Test("33 distinct sessions: the oldest drops out, the ceiling is 32")
  func ceiling() {
    var history = SessionHistory()
    for index in 0..<33 { history.note("s\(index)") }
    #expect(SessionHistory.capacity == 32)
    #expect(history.ids.count == 32)
    #expect(history.ids.first == "s1", "the first visit dropped out")
    #expect(history.ids.last == "s32")
  }

  @Test("recent: at most `limit`, newest first; a dead session is skipped and the 11th live one takes its place")
  func recent() {
    var history = SessionHistory()
    for index in 0..<12 { history.note("s\(index)") }
    let all = history.recent(limit: 10) { _ in true }
    #expect(all == (2..<12).reversed().map { "s\($0)" })

    let withDead = history.recent(limit: 10) { $0 != "s7" }
    #expect(withDead.count == 10)
    #expect(!withDead.contains("s7"))
    #expect(withDead.first == "s11" && withDead.last == "s1", "the 11th live session fills the gap")
    #expect(history.ids.contains("s7"), "a dead session is skipped, not deleted")
    #expect(history.recent(limit: 0) { _ in true }.isEmpty)
  }

  @Test("storage: a damaged entry is an empty history; a saved one reads back; the key is server-scoped")
  func storage() throws {
    let store = MemoryPreferences()
    store.set(Data("not json".utf8), forKey: NavigationPreferences.sessionHistory)
    #expect(NavigationPreferences.load(SessionHistory.self, key: NavigationPreferences.sessionHistory, from: store) == nil)

    var history = SessionHistory()
    history.note("a")
    history.note("b")
    NavigationPreferences.save(history, key: NavigationPreferences.sessionHistory, to: store)
    #expect(NavigationPreferences.load(SessionHistory.self, key: NavigationPreferences.sessionHistory, from: store) == history)

    let odd = try JSONDecoder().decode(SessionHistory.self, from: Data(#"{"ids":["a","","b","a"]}"#.utf8))
    #expect(odd.ids == ["b", "a"], "empty ids drop out, a duplicate keeps its newest place")
    let wrongShape = try JSONDecoder().decode(SessionHistory.self, from: Data(#"{"ids":"a"}"#.utf8))
    #expect(wrongShape.ids.isEmpty)

    #expect(NavigationPreferences.sessionHistory == "rarog.sessionHistory")
    #expect(NavigationPreferences.serverScoped.contains(NavigationPreferences.sessionHistory))
  }
}
