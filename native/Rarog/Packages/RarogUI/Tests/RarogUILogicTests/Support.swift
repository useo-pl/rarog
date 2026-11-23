import Foundation
import RarogContract
import RarogCore
import RarogUI

// Typy z drutu nie mają publicznych inicjatorów (dekoder kontraktu jest jedyną drogą), więc
// próbki składamy z JSON-u — tak samo, jak przychodzą od serwera.

enum Sample {
  /// 21 Sep 2026, 13:33:20 UTC.
  static let now = Date(timeIntervalSince1970: 1_790_000_000)

  /// Kalendarz godzin i dni transkryptu w testach: gregoriański w UTC (wynik nie zależy od strefy maszyny).
  static let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }()

  /// Miejsce w turze pierwszego i jedynego wiersza promptu: cecha nagłówka i godzina (UTC) przy dymku.
  static func prompt(_ at: String, gap: TurnGap = .flow) -> TurnMark {
    TurnMark(gap: gap, promptHead: true, clock: ServerTime.clock(at, timeZone: calendar.timeZone))
  }

  /// To samo dla wpisu w locie — godzina z `createdAt` (w próbkach `now`).
  static func pendingPrompt(_ createdAt: Date = now, gap: TurnGap = .turn) -> TurnMark {
    TurnMark(gap: gap, promptHead: true, clock: ServerTime.clock(createdAt, timeZone: calendar.timeZone))
  }

  static func iso(_ secondsAgo: TimeInterval) -> String {
    now.addingTimeInterval(-secondsAgo).formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
  }

  static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
    // swiftlint:disable:next force_try
    try! JSONDecoder().decode(type, from: Data(json.utf8))
  }

  static func session(
    id: String = "s1", title: String = "willow", label: String? = "zapis notatek", state: String = "running",
    extra: String = "", createdAgo: TimeInterval = 600, activityAgo: TimeInterval = 60, stateAgo: TimeInterval = 30
  ) -> SessionSummary {
    let labelField = label.map { #""label":"\#($0)","# } ?? ""
    let json = #"""
      {"id":"\#(id)","cwd":"/Users/demo/Projects/\#(title)","title":"\#(title)",\#(labelField)
       "state":"\#(state)","stateSince":"\#(iso(stateAgo))","createdAt":"\#(iso(createdAgo))",
       "lastActivityAt":"\#(iso(activityAgo))"\#(extra.isEmpty ? "" : "," + extra)}
      """#
    return decode(SessionSummary.self, json)
  }

  static func message(seq: Int, role: String, blocks: String, attachments: String? = nil) -> TranscriptMessage {
    let extra = attachments.map { #","attachments":\#($0)"# } ?? ""
    return decode(TranscriptMessage.self, #"{"seq":\#(seq),"role":"\#(role)","blocks":\#(blocks),"at":"\#(iso(100 - Double(seq)))"\#(extra)}"#)
  }

  static func text(_ value: String) -> String {
    let escaped = String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
    return #"[{"type":"text","text":\#(escaped)}]"#
  }

  static func permission(
    sessionId: String = "s1", permId: String = "p1", risk: String = "normal", extra: String = ""
  ) -> PermissionRequest {
    decode(PermissionRequest.self, #"""
      {"permId":"\#(permId)","sessionId":"\#(sessionId)","toolName":"Shell","displayText":"npm test",
       "risk":"\#(risk)","cwd":"/Users/demo/Projects/willow","createdAt":"\#(iso(30))"\#(extra.isEmpty ? "" : "," + extra)}
      """#)
  }

  /// Stan z jedną sesją i transkryptem po pełnym stanie z serwera.
  static func state(session: SessionSummary, messages: [TranscriptMessage] = [], open: String? = nil) -> AppState {
    var state = AppState(clientBuild: 1)
    state.sessions[session.id] = session
    state.sessionsLoaded = true
    state.global = .online
    state.compat = .ok
    var view = TranscriptState()
    view.messages = messages
    view.snapshots = 1
    if let open { view.open = OpenAgentMessage(text: open) }
    state.transcripts[session.id] = view
    return state
  }
}
