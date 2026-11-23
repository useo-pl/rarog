// Stan treści Live Activity (`content-state`) — lustro
// `liveActivityContentStateSchema` z `shared/src/rest.ts`. ActivityKit dekoduje ten typ SAM z ładunku APNs
// (jego `Codable`), więc czasy są całkowitymi sekundami epoki, nie `Date`: domyślna strategia
// `JSONDecoder` czyta `Date` jako sekundy od 2001 i cicho przesunęłaby zegar o 31 lat. Próbki tutaj to
// kształt ze schematu (także granice zakresów); pełne ramki APNs wyprodukowane przez serwer przechodzi
// `ApnsFramesTests`.
import Foundation
import RarogContract
import Testing

@Suite("kontrakt: stan treści Live Activity")
struct LiveActivityContractTests {
  static let epoch = 1_791_331_200

  static let full = #"""
    {"waiting":2,"working":3,"finished":4,
     "top":{"sessionId":"demo-willow","termId":"0123456789abcdef"},
     "workflows":[
       {"sessionId":"demo-rarog","project":"rarog","name":"audyt-ux","agents":7,"done":3,
        "phase":{"index":2,"count":4,"title":"Weryfikacja"},"segments":[100,60,0,0]},
       {"sessionId":"demo-atlas","project":"atlas-web","name":"review-changes","agents":3,"done":1,"segments":[33]}],
     "moreWorkflows":1,
     "limits":{"fiveHour":42,"weekly":81},
     "mac":{"cpu":35,"ram":70,"disk":60},
     "updatedEpoch":1791331200}
    """#

  private func decode(_ json: String) throws -> LiveActivityContentState {
    try JSONDecoder().decode(LiveActivityContentState.self, from: Data(json.utf8))
  }

  @Test("pełny stan: liczniki, cel tapnięcia, dwa przebiegi (z planem faz i bez), „+N”, limity, Mac")
  func full() throws {
    let state = try decode(Self.full)
    #expect(state.waiting == 2 && state.working == 3 && state.finished == 4 && state.updatedEpoch == Self.epoch)
    #expect(state.top == .init(sessionId: "demo-willow", termId: "0123456789abcdef"))
    let workflows = try #require(state.workflows)
    #expect(workflows == [
      .init(
        sessionId: "demo-rarog", project: "rarog", name: "audyt-ux", agents: 7, done: 3,
        phase: .init(index: 2, count: 4, title: "Weryfikacja"), segments: [100, 60, 0, 0]),
      .init(sessionId: "demo-atlas", project: "atlas-web", name: "review-changes", agents: 3, done: 1, segments: [33]),
    ])
    #expect(state.moreWorkflows == 1)
    #expect(state.limits == .init(fiveHour: 42, weekly: 81) && state.mac == .init(cpu: 35, ram: 70, disk: 60))
  }

  @Test("minimum: same liczniki i chwila — bez celu, przebiegów, limitów i Maca")
  func minimal() throws {
    let state = try decode(#"{"waiting":0,"working":0,"finished":0,"updatedEpoch":1791331200}"#)
    #expect(state == LiveActivityContentState(waiting: 0, working: 0, finished: 0, updatedEpoch: Self.epoch))
    // Okna limitów i metryki Maca są osobno opcjonalne: brak odczytu = brak pola, nie zero.
    let partial = try decode(#"{"waiting":0,"working":0,"finished":0,"limits":{},"mac":{"disk":5},"updatedEpoch":1}"#)
    #expect(partial.limits == .init() && partial.mac == .init(disk: 5))
  }

  @Test("granice: procent 0 i 100, faza = liczba faz, 12 segmentów, łańcuch 60 jednostek UTF-16")
  func bounds() throws {
    let edge = try decode(#"""
      {"waiting":0,"working":0,"finished":0,"limits":{"fiveHour":0,"weekly":100},
       "workflows":[{"sessionId":"s","project":"\#(String(repeating: "p", count: 60))","name":"n","agents":0,"done":0,
         "phase":{"index":12,"count":12,"title":""},"segments":[0,0,0,0,0,0,0,0,0,0,0,100]}],"updatedEpoch":1}
      """#)
    #expect(edge.workflows?.first?.phase == .init(index: 12, count: 12, title: ""))
    #expect(edge.limits == .init(fiveHour: 0, weekly: 100))
    // Emoji to DWIE jednostki UTF-16 (tak liczy zod): 30 emoji = 60 — jeszcze w suficie.
    let emoji = String(repeating: "🚀", count: 30)
    let unicode = try decode(#"""
      {"waiting":0,"working":0,"finished":0,"workflows":[{"sessionId":"s","project":"\#(emoji)","name":"n",
       "agents":1,"done":1,"segments":[100]}],"updatedEpoch":1}
      """#)
    #expect(unicode.workflows?.first?.project == emoji)
  }

  @Test("round-trip: kodowanie pomija pola `nil` — ActivityKit odczyta stan z powrotem bez strat")
  func roundTrip() throws {
    let state = try decode(Self.full)
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let again = try JSONDecoder().decode(LiveActivityContentState.self, from: encoder.encode(state))
    #expect(again == state && again.hashValue == state.hashValue)
    let idle = LiveActivityContentState(waiting: 0, working: 3, finished: 1, updatedEpoch: Self.epoch)
    // Pola bez wartości nie lecą wcale (kontrakt zna brak pola, nie `null`).
    #expect(String(decoding: try encoder.encode(idle), as: UTF8.self)
      == #"{"finished":1,"updatedEpoch":1791331200,"waiting":0,"working":3}"#)
    let bare = LiveActivityContentState(
      waiting: 0, working: 0, finished: 0, top: .init(sessionId: "s"), limits: .init(weekly: 7), updatedEpoch: 1)
    #expect(String(decoding: try encoder.encode(bare), as: UTF8.self)
      == #"{"finished":0,"limits":{"weekly":7},"top":{"sessionId":"s"},"updatedEpoch":1,"waiting":0,"working":0}"#)
  }

  @Test("nieznane pola (np. pola v1 albo przyszłe) są ignorowane")
  func unknownFields() throws {
    let state = try decode(#"""
      {"waiting":1,"working":0,"finished":0,"top":{"sessionId":"s","kind":"permission","project":"p"},
       "workflow":{"name":"w"},"przyszle":true,"mac":{"gpu":40},"updatedEpoch":1}
      """#)
    #expect(state.top == .init(sessionId: "s") && state.workflows == nil && state.mac == .init())
  }

  @Test(
    "odrzucenia: zakresy schematu, `null` w polu opcjonalnym, zły `termId`, brak `finished`",
    arguments: [
      #"{"waiting":0,"working":0,"finished":0,"updatedEpoch":"2026-10-07T10:00:00Z"}"#,
      #"{"waiting":0,"working":0,"finished":0,"updatedEpoch":1791331200.5}"#,
      #"{"waiting":-1,"working":0,"finished":0,"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":-1,"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"top":null,"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"top":{"sessionId":""},"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"top":{"sessionId":"s","termId":"../x"},"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"workflows":[],"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"moreWorkflows":0,"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"limits":{"fiveHour":101},"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"limits":{"weekly":-1},"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"limits":{"weekly":null},"updatedEpoch":1}"#,
      #"{"waiting":0,"working":0,"finished":0,"mac":{"cpu":100.5},"updatedEpoch":1}"#,
    ] + LiveActivityContractTests.workflowRejections
  )
  func rejections(_ json: String) {
    #expect(throws: (any Error).self, "\(json)") { _ = try decode(json) }
  }

  /// Przebieg spoza schematu: każdy wariant łamie dokładnie jedną bramkę `liveActivityWorkflowSchema`.
  static let workflowRejections: [String] = {
    let ok = #"{"sessionId":"s","project":"p","name":"n","agents":4,"done":3,"phase":{"index":2,"count":3,"title":"T"},"segments":[100,50,0]}"#
    let broken = [
      ok.replacing(#""done":3"#, with: #""done":5"#),
      ok.replacing(#""agents":4"#, with: #""agents":-1"#),
      ok.replacing(#""index":2"#, with: #""index":0"#),
      ok.replacing(#""index":2"#, with: #""index":4"#),
      ok.replacing(#""count":3"#, with: #""count":13"#),
      ok.replacing(#""segments":[100,50,0]"#, with: #""segments":[100,50]"#),
      ok.replacing(#""segments":[100,50,0]"#, with: #""segments":[100,50,101]"#),
      ok.replacing(#","phase":{"index":2,"count":3,"title":"T"},"segments":[100,50,0]"#, with: #","segments":[]"#),
      ok.replacing(#","phase":{"index":2,"count":3,"title":"T"},"segments":[100,50,0]"#,
                   with: #","segments":[\#(Array(repeating: "0", count: 13).joined(separator: ","))]"#),
      ok.replacing(#""project":"p""#, with: #""project":"""#),
      ok.replacing(#""name":"n""#, with: #""name":"\#(String(repeating: "n", count: 61))""#),
      ok.replacing(#""title":"T""#, with: #""title":"\#(String(repeating: "🚀", count: 31))""#),
      ok.replacing(#""title":"T""#, with: #""title":null"#),
      ok.replacing(#""sessionId":"s","#, with: ""),
    ]
    let three = [ok, ok, ok].joined(separator: ",")
    return broken.map { #"{"waiting":0,"working":0,"finished":0,"workflows":[\#($0)],"updatedEpoch":1}"# }
      + [#"{"waiting":0,"working":0,"finished":0,"workflows":[\#(three)],"updatedEpoch":1}"#]
  }()

  /// Przebieg z planem trzech faz; `states` wstawia test (`nil` = bez pola).
  static func planned(states: String?, phase: Bool = true) -> String {
    let phaseField = phase ? #","phase":{"index":2,"count":3,"title":"T"}"# : ""
    let segments = phase ? "[100,50,0]" : "[50]"
    let statesField = states.map { #","states":\#($0)"# } ?? ""
    return #"""
      {"waiting":0,"working":1,"finished":0,"workflows":[{"sessionId":"s","project":"p","name":"n","agents":4,
       "done":3\#(phaseField),"segments":\#(segments)\#(statesField)}],"updatedEpoch":1}
      """#
  }

  @Test("`states`: brak pola → `nil`; trzy znane stany po kolei faz")
  func phaseStates() throws {
    #expect(try decode(Self.planned(states: nil)).workflows?.first?.states == nil)
    let workflow = try #require(try decode(Self.planned(states: #"["done","running","pending"]"#)).workflows?.first)
    #expect(workflow.states == [.done, .running, .pending])
    #expect(workflow.segments == [100, 50, 0] && workflow.phase?.index == 2)
  }

  @Test(
    "`states` spoza kontraktu znika w całości, reszta stanu zdekodowana (stary kafel zamiast błędu)",
    arguments: [
      (#"null"#, true), (#""done""#, true), (#"[null]"#, true), (#"[1]"#, true),
      (#"["done","failed","pending"]"#, true), (#"["done",null,"pending"]"#, true), (#"["done","running"]"#, true),
      (#"["done","running","pending","pending"]"#, true), (#"{"0":"done"}"#, true), (#"["running"]"#, false),
    ]
  )
  func phaseStatesTolerant(_ states: String, _ phase: Bool) throws {
    let state = try decode(Self.planned(states: states, phase: phase))
    let workflow = try #require(state.workflows?.first, "\(states)")
    #expect(workflow.states == nil, "\(states)")
    #expect(state.working == 1 && workflow.agents == 4 && workflow.done == 3, "\(states)")
    #expect(workflow.segments == (phase ? [100, 50, 0] : [50]) && (workflow.phase != nil) == phase, "\(states)")
  }

  @Test("`states`: zapis pisze pole tylko przy wartości, zapis i odczyt dają ten sam stan")
  func phaseStatesRoundTrip() throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let with = try decode(Self.planned(states: #"["done","running","pending"]"#))
    let again = try JSONDecoder().decode(LiveActivityContentState.self, from: encoder.encode(with))
    #expect(again == with && again.workflows?.first?.states == [.done, .running, .pending])
    let encoded = String(decoding: try encoder.encode(with), as: UTF8.self)
    #expect(encoded.contains(#""states":["done","running","pending"]"#))
    let without = try decode(Self.planned(states: nil))
    #expect(!String(decoding: try encoder.encode(without), as: UTF8.self).contains("states"))
  }

  static let payload = #"""
    {"aps":{"timestamp":1791331200,"event":"update",
      "content-state":{"waiting":1,"working":0,"finished":0,"updatedEpoch":1791331200},"stale-date":1791332100}}
    """#

  @Test("pełny ładunek APNs: zdarzenie, znacznik, daty zgodne ze zdarzeniem; reszta ramki odrzucona")
  func payload() throws {
    let update = try JSONDecoder().decode(LiveActivityPayload.self, from: Data(Self.payload.utf8)).aps
    #expect(update.event == .update && update.timestamp == Self.epoch && update.staleDate == Self.epoch + 900)
    #expect(update.dismissalDate == nil && update.contentState.waiting == 1)
    let end = #"{"aps":{"timestamp":1791331200,"event":"end","content-state":{"waiting":0,"working":0,"finished":0,"updatedEpoch":1791331200},"dismissal-date":1791331200}}"#
    #expect(try JSONDecoder().decode(LiveActivityPayload.self, from: Data(end.utf8)).aps.dismissalDate == Self.epoch)
    for json in [
      // Zdarzenie `start` (push-to-start) apka czyta jak nieznane: odrzuca ramkę.
      Self.payload.replacing(#""event":"update""#, with: #""event":"start""#),
      Self.payload.replacing(#""timestamp":1791331200"#, with: #""timestamp":"2026-10-07T10:00:00Z""#),
      Self.payload.replacing(#","stale-date":1791332100"#, with: ""),
      Self.payload.replacing(#""stale-date":1791332100"#, with: #""stale-date":null"#),
      Self.payload.replacing(#""stale-date":1791332100"#, with: #""stale-date":1791332100,"dismissal-date":1791332100"#),
      end.replacing(#","dismissal-date":1791331200"#, with: ""),
      #"{"aps":null}"#,
    ] {
      #expect(throws: (any Error).self, "\(json)") {
        _ = try JSONDecoder().decode(LiveActivityPayload.self, from: Data(json.utf8))
      }
    }
  }

  @Test("prywatność ekranu blokady: typ nie ma pola na treść, narzędzie zgody, etykietę ani czas pracy")
  func privacy() throws {
    let state = try decode(Self.full)
    var labels: Set<String> = []
    func collect(_ value: Any) {
      for child in Mirror(reflecting: value).children {
        if let label = child.label { labels.insert(label) }
        collect(child.value)
      }
    }
    collect(state)
    #expect(labels.isSuperset(of: ["sessionId", "termId", "updatedEpoch", "project", "name", "title", "segments"]))
    #expect(labels.isDisjoint(with: [
      "text", "summary", "lastSummary", "displayText", "command", "question", "tool", "label", "kind", "sinceEpoch",
      "description",
    ]))
  }
}
