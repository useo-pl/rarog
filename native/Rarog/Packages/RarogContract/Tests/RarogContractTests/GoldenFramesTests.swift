// Złote ramki SSE, strona klienta Swift — lustro `shared/test/sse-fixtures.test.ts` na tych
// samych plikach. `pnpm run check` odpala ten test krokiem `swift-contract`, więc zmiana
// kontraktu w TS bez zmiany typów Swift przewraca bramkę repo, a nie dopiero build apki.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("złote ramki SSE: manifest → dekoder Swift")
struct GoldenFramesTests {
  let frames = GoldenFrames.shared

  @Test("manifest ↔ katalog w obie strony")
  func manifestMatchesDirectory() throws {
    #expect(try frames.frameFiles() == frames.names)
  }

  @Test("każdy z 20 typów ramki ma `<type>.max.json` oczekiwany jako ok i dekoduje się do swojego przypadku")
  func everyWireTypeHasMaxFrame() throws {
    #expect(ServerEvent.WireType.allCases.count == 20)
    for type in ServerEvent.WireType.allCases {
      let name = "\(type.rawValue).max.json"
      #expect(frames.entries[name]?.expect == .ok, "brak \(name)")
      let decoded = EventDecoder.decodeEvent(try frames.dataField(name))
      #expect(decoded?.event.wireType == type, "\(name)")
    }
  }

  @Test("ramka", arguments: GoldenFrames.shared.names)
  func frame(_ name: String) throws {
    let entry = try #require(frames.entries[name])
    let stored = try frames.document(name)
    if let base = entry.base {
      // Strażnik dryfu: pochodna musi być DOKŁADNIE bazą z nałożonym `patch`.
      let expected = try frames.document(base).applying(entry.patch ?? [])
      #expect(JSONValue.differences(expected: expected, actual: stored) == [], "\(name) ≠ \(base) + patch")
    }

    let outcome = EventDecoder.decode(try frames.dataField(name))
    switch entry.expect {
    case .ignored:
      #expect(throws: EventRejection.self, "\(name): ramka miała wypaść") { try outcome.get() }

    case .ok:
      let decoded = try outcome.get()
      #expect(decoded.degradations == [], "\(name): degradacje w ramce ok")
      // Round-trip: pole, którego typy Swift nie znają, znika przy kodowaniu — test podaje jego ścieżkę.
      let strip = (entry.strip ?? []).map { JSONPatchOp(path: $0, value: nil, remove: true) }
      let expected = try stored.applying(strip)
      let actual = try encode(decoded.event)
      #expect(JSONValue.differences(expected: expected, actual: actual) == [], "\(name): round-trip")

    case .degraded:
      let decoded = try outcome.get()
      let patch = try (entry.patch ?? []).map { op in
        guard case let .string(value)? = op.value else {
          throw FixtureError("\(name): degradacja niesie nieznany ŁAŃCUCH (\(op.path))")
        }
        return Degradation(path: op.path, value: value)
      }
      #expect(Set(decoded.degradations) == Set(patch), "\(name): lista degradacji")
      #expect(decoded.degradations.count == patch.count, "\(name): zdublowana degradacja")
      let expected = try stored.applying(entry.result ?? [])
      let actual = try encode(decoded.event)
      #expect(JSONValue.differences(expected: expected, actual: actual) == [], "\(name): wynik po degradacji")
    }
  }

  @Test("`markedUnseen`: the card marked unread by hand carries it, an ordinary card does not")
  func markedUnseen() throws {
    let marked = try EventDecoder.decode(try frames.dataField("session-changed.marked-unseen.json")).get()
    guard case let .sessionChanged(changed) = marked.event else { throw FixtureError("not session-changed") }
    #expect(changed.session.markedUnseen == true)
    let plain = try EventDecoder.decode(try frames.dataField("session-changed.idle.json")).get()
    guard case let .sessionChanged(idle) = plain.event else { throw FixtureError("not session-changed") }
    #expect(idle.session.markedUnseen == nil)
  }

  @Test("`seenBy`: a result the voice agent picked up carries it in both frame types, a human's result does not")
  func seenBy() throws {
    let picked = try EventDecoder.decode(try frames.dataField("session-changed.seen-by-voice-agent.json")).get()
    guard case let .sessionChanged(changed) = picked.event else { throw FixtureError("not session-changed") }
    #expect(changed.session.seen == true && changed.session.seenBy == .voiceAgent)
    let snapshot = try EventDecoder.decode(try frames.dataField("sessions-snapshot.seen-by-voice-agent.json")).get()
    guard case let .sessionsSnapshot(list) = snapshot.event else { throw FixtureError("not sessions-snapshot") }
    #expect(Set(list.sessions.map(\.seenBy)) == [nil, .voiceAgent])
    let plain = try EventDecoder.decode(try frames.dataField("session-changed.idle.json")).get()
    guard case let .sessionChanged(idle) = plain.event else { throw FixtureError("not session-changed") }
    #expect(idle.session.seenBy == nil)
  }

  @Test("`inbox-heads`: two unreadable heads drop, a broken head still rejects the frame next to an unknown value")
  func inboxHeadsLossy() throws {
    let base = try frames.document("inbox-heads.max.json")
    func decode(_ ops: [(String, JSONValue?)]) throws -> Result<DecodedEvent, EventRejection> {
      let patched = try base.applying(ops.map { JSONPatchOp(path: $0.0, value: $0.1, remove: $0.1 == nil) })
      return EventDecoder.decode(try JSONEncoder().encode(patched))
    }
    let two = try decode([("/heads/0/kind", .string("summary")), ("/heads/2/state", .string("paused"))]).get()
    guard case let .inboxHeads(heads) = two.event else { throw FixtureError("not inbox-heads") }
    #expect(heads.heads.map(\.sessionId) == ["herdr-w1-p1"])
    #expect(Set(two.degradations) == [
      Degradation(path: "/heads/0/kind", value: "summary"), Degradation(path: "/heads/2/state", value: "paused"),
    ])
    for ops in [
      [("/heads/1/kind", JSONValue.string("summary")), ("/heads/1/version", .string(""))],
      [("/heads/1/kind", .null)],
      [("/heads/1/at", nil)],
    ] as [[(String, JSONValue?)]] {
      #expect(throws: EventRejection.self, "\(ops.map(\.0))") { try decode(ops).get() }
    }
  }

  private func encode(_ event: ServerEvent) throws -> JSONValue {
    try JSONValue.parse(JSONEncoder().encode(event))
  }
}

struct FixtureError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}
