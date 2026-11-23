import Foundation
import RarogCore
@testable import RarogUI
import Testing

@Suite("baner transkryptu należy do oglądanej sesji")
struct TranscriptConnectionMemoryTests {
  /// Kolejność jak w `DetailView`: wybór sesji przychodzi ze statusem, który ma magazyn w tej chwili,
  /// a własne statusy strumienia przychodzą potem zmianą `sessionStream`.
  @Test("awaria A pozostaje podczas jej ponowienia, lecz pierwsza próba B nie dziedziczy błędu")
  func changingSession() {
    var memory = TranscriptConnectionMemory()
    memory.observe(.idle, sessionId: "A", now: Sample.now)
    memory.observe(.offline(since: Sample.now), sessionId: "A", now: Sample.now)
    memory.observe(.connecting(since: Sample.now), sessionId: "A", now: Sample.now)
    #expect(memory.connection.showsServerUnreachable, "ponowienie A nie mruga banerem")
    #expect(!memory.connection(for: "B").showsServerUnreachable, "pierwszy render B przed callbackiem")
    memory.observe(.idle, sessionId: "B", now: Sample.now)
    memory.observe(.connecting(since: Sample.now), sessionId: "B", now: Sample.now)
    #expect(!memory.connection.showsServerUnreachable, "B jeszcze nie miała nieudanej próby")
    #expect(memory.connection.showsConnecting(now: Sample.now.addingTimeInterval(2)))
    memory.observe(.offline(since: Sample.now), sessionId: "B", now: Sample.now)
    #expect(memory.connection.showsServerUnreachable, "dopiero rzeczywista awaria B daje baner")
  }

  @Test("status z chwili przełączenia należy do strumienia A: B nie dostaje baneru awarii A")
  func switchCarriesPreviousStatus() {
    var memory = TranscriptConnectionMemory()
    memory.observe(.idle, sessionId: "A", now: Sample.now)
    memory.observe(.offline(since: Sample.now), sessionId: "A", now: Sample.now)
    #expect(memory.connection.showsServerUnreachable)
    // Magazyn startuje strumień B asynchronicznie: wybór B widzi jeszcze `offline` pętli A.
    memory.observe(.offline(since: Sample.now), sessionId: "B", now: Sample.now)
    #expect(!memory.connection.showsServerUnreachable, "awaria A nie przechodzi na B")
    #expect(memory.connection.notOnlineSince == nil)
    memory.observe(.connecting(since: Sample.now), sessionId: "B", now: Sample.now)
    #expect(!memory.connection.showsServerUnreachable, "własne łączenie B to jeszcze nie awaria")
  }

  @Test("wyjście do projektu czyści awarię, a spóźniony status bez oglądanej sesji jej nie odtwarza")
  func leavingSession() {
    var memory = TranscriptConnectionMemory()
    memory.observe(.idle, sessionId: "A", now: Sample.now)
    memory.observe(.offline(since: Sample.now), sessionId: "A", now: Sample.now)
    #expect(memory.connection.showsServerUnreachable)
    memory.observe(.offline(since: Sample.now), sessionId: nil, now: Sample.now)
    #expect(!memory.connection.showsServerUnreachable)
    #expect(memory.connection.notOnlineSince == nil)
  }
}
