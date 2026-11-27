import Foundation
@testable import RarogActivity
import Testing

// The voice Live Activity stands on the Lock Screen for anyone who holds the phone, so its state carries what
// records, what it does, since when (and until when, after a send from the tile), and of text only the session's
// project and name, each cut to a ceiling (`docs/security-model.md`, "Push notifications").
@Suite("voice Live Activity state: kind, phase, scope, the session's project and name, start and stop time")
struct VoiceActivityAttributesTests {
  typealias State = VoiceActivityAttributes.ContentState

  /// Catches a field added to the state or the attributes that could carry a prompt, dictated text, a question or
  /// an end sentence, and names kept for all sessions: the encoded JSON has exactly these keys, and the attributes
  /// have none.
  @Test("the encoded state has only kind, phase, scope, startedAt, stoppedAt and the session's project and name")
  func encodedKeys() throws {
    for kind in State.Kind.allCases {
      for phase in State.Phase.allCases {
        for scope in State.Scope.allCases {
          let state = State(
            kind: kind, phase: phase, scope: scope, project: "atlas", name: "demo",
            startedAt: Date(timeIntervalSince1970: 0), stoppedAt: Date(timeIntervalSince1970: 42))
          let object = try #require(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
          let names: Set<String> = scope == .session ? ["project", "name"] : []
          let keys = Set(["kind", "phase", "scope", "startedAt", "stoppedAt"]).union(names)
          #expect(Set(object.keys) == keys, "\(kind) \(phase)")
        }
      }
    }
    let attributes = try JSONSerialization.jsonObject(with: JSONEncoder().encode(VoiceActivityAttributes()))
    #expect((attributes as? [String: Any])?.isEmpty == true)
  }

  /// Catches a project or a session name that reaches the state whole however long it is: up to the ceiling it
  /// stays as it is, one character more is cut to the ceiling.
  @Test("a project and a name keep the ceiling's length and lose what goes past it")
  func nameCeiling() {
    let ceiling = State.nameCeiling
    let fits = String(repeating: "a", count: ceiling)
    let long = String(repeating: "d", count: ceiling) + "e"
    let state = State(
      kind: .conversation, phase: .listening, scope: .session, project: fits, name: long,
      startedAt: Date(timeIntervalSince1970: 0))
    #expect(state.project == fits)
    #expect(state.name == String(repeating: "d", count: ceiling))
    let empty = State(
      kind: .dictation, phase: .dictating, scope: .session, project: "", name: "",
      startedAt: Date(timeIntervalSince1970: 0))
    #expect(empty.project == nil && empty.name == nil, "an empty name counts as none")
  }
}
