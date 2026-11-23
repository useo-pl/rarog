import Foundation
import RarogContract
import RarogContractFixtures
import Testing

/// Ramki do testów: złote z `shared/fixtures/sse/` (bez kopii) i syntetyczne z JSON-u przez ten
/// sam dekoder, którym idzie strumień — typy kontraktu nie mają publicznych inicjalizatorów
/// i tak ma być (wartości z drutu powstają tylko z dekodowania).
enum Frames {
  static func golden(_ name: String) throws -> ServerEvent {
    try EventDecoder.decode(GoldenFrames.shared.dataField(name)).get().event
  }

  static func decode(_ json: String) throws -> ServerEvent {
    try EventDecoder.decode(Data(json.utf8)).get().event
  }

  static func summary(
    _ id: String, state: String = "running", title: String = "projekt", label: String? = nil,
    createdAt: String = "2026-10-03T08:00:00.000Z", lastActivityAt: String = "2026-10-03T08:00:00.000Z",
    stateSince: String = "2026-10-03T08:00:00.000Z", extra: String = ""
  ) -> String {
    let labelField = label.map { #","label":"\#($0)""# } ?? ""
    return #"""
      {"id":"\#(id)","cwd":"/Users/demo/\#(title)","title":"\#(title)"\#(labelField),"state":"\#(state)",
      "stateSince":"\#(stateSince)","createdAt":"\#(createdAt)","lastActivityAt":"\#(lastActivityAt)"\#(extra)}
      """#
  }

  static func snapshot(_ summaries: [String], extra: String = "") throws -> ServerEvent {
    try decode(#"{"type":"sessions-snapshot","sessions":[\#(summaries.joined(separator: ","))]\#(extra)}"#)
  }

  static func sessionChanged(_ summary: String) throws -> ServerEvent {
    try decode(#"{"type":"session-changed","session":\#(summary)}"#)
  }

  static func message(_ sessionId: String, seq: Int, role: String = "assistant", text: String,
                      at: String = "2026-10-03T08:00:00.000Z", attachments: String = "") throws -> ServerEvent {
    let attachmentsField = attachments.isEmpty ? "" : #","attachments":[\#(attachments)]"#
    return try decode(#"""
      {"type":"message","sessionId":"\#(sessionId)","message":{"seq":\#(seq),"role":"\#(role)",
      "blocks":[{"type":"text","text":\#(quoted(text))}],"at":"\#(at)"\#(attachmentsField)}}
      """#)
  }

  static func messageJSON(seq: Int, role: String, text: String, at: String = "2026-10-03T08:00:00.000Z") -> String {
    #"{"seq":\#(seq),"role":"\#(role)","blocks":[{"type":"text","text":\#(quoted(text))}],"at":"\#(at)"}"#
  }

  static func transcript(_ sessionId: String, messages: [String] = [], permissions: [String] = [],
                         questions: [String] = [], activity: String? = nil) throws -> ServerEvent {
    let activityField = activity.map { #","activity":\#($0)"# } ?? ""
    return try decode(#"""
      {"type":"transcript-snapshot","sessionId":"\#(sessionId)","messages":[\#(messages.joined(separator: ","))],
      "pendingPermissions":[\#(permissions.joined(separator: ","))],
      "pendingQuestions":[\#(questions.joined(separator: ","))]\#(activityField)}
      """#)
  }

  static func permission(_ sessionId: String, permId: String, canAllow: Bool? = nil) -> String {
    let allow = canAllow.map { #","canAllow":\#($0)"# } ?? ""
    return #"""
      {"permId":"\#(permId)","sessionId":"\#(sessionId)","toolName":"Read","displayText":"cat plik",
      "risk":"normal","cwd":"/Users/demo/projekt","createdAt":"2026-10-03T08:00:00.000Z"\#(allow)}
      """#
  }

  static func question(_ sessionId: String, qId: String) -> String {
    #"""
      {"qId":"\#(qId)","sessionId":"\#(sessionId)","createdAt":"2026-10-03T08:00:00.000Z",
      "questions":[{"question":"Który?","header":"Wybór","multiSelect":false,"options":[{"label":"A"}]}]}
      """#
  }

  static func delta(_ sessionId: String, _ text: String) throws -> ServerEvent {
    try decode(#"{"type":"delta","sessionId":"\#(sessionId)","text":\#(quoted(text))}"#)
  }

  static func state(_ sessionId: String, _ state: String, since: String) throws -> ServerEvent {
    try decode(#"{"type":"state","sessionId":"\#(sessionId)","state":"\#(state)","since":"\#(since)"}"#)
  }

  static func activity(_ sessionId: String, kind: String) throws -> ServerEvent {
    try decode(#"{"type":"activity","sessionId":"\#(sessionId)","kind":"\#(kind)"}"#)
  }

  static func hello(protocolVersion: Int = 3, minClientBuild: Int? = nil) throws -> ServerEvent {
    let minimum = minClientBuild.map { #","minClientBuild":\#($0)"# } ?? ""
    return try decode(#"{"type":"hello","protocolVersion":\#(protocolVersion),"serverStartId":"s1"\#(minimum)}"#)
  }

  /// Łańcuch jako literał JSON (z ucieczkami).
  static func quoted(_ text: String) -> String {
    JSONValue.string(text).compact
  }
}
