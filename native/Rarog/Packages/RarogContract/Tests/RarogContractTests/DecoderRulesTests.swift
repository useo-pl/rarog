// Reguły dekodera na małych ramkach — przypadki z macierzy `shared/test/decode.test.ts` z czytelną
// nazwą testu oraz odstępstwa Swift opisane w README. Przypadek, który złota ramka sprawdza tą samą
// asercją, należy do `GoldenFramesTests`, nie do tego pliku.
import Foundation
import RarogContract
import Testing

@Suite("dekoder: reguły tolerancji kontraktu")
struct DecoderRulesTests {
  private func decode(_ json: String) -> Result<DecodedEvent, EventRejection> {
    EventDecoder.decode(Data(json.utf8))
  }

  private let summary = #"""
    {"id":"s1","cwd":"/p","title":"p","state":"running","stateSince":"t","createdAt":"t","lastActivityAt":"t"}
    """#

  @Test("null w opcjonalnym polu wyliczeniowym odrzuca ramkę (null ≠ brak pola)")
  func nullInOptionalEnum() {
    let frame = #"""
      {"type":"question-pending","request":{"qId":"q","sessionId":"s","questions":[],"createdAt":"t","channel":null}}
      """#
    #expect(throws: EventRejection.self) { try decode(frame).get() }
  }

  @Test("null w opcjonalnym polu tekstowym odrzuca ramkę i wskazuje ścieżkę")
  func nullInOptionalString() {
    let frame = #"{"type":"session-changed","session":\#(summary.dropLast()),"label":null}}"#
    guard case let .failure(rejection) = decode(frame) else {
      Issue.record("ramka z null przeszła")
      return
    }
    #expect(rejection.reason == .invalidShape)
    #expect(rejection.path == "/session/label")
  }

  @Test("liczba zamiast łańcucha w polu wyliczeniowym odrzuca ramkę (nie degraduje)")
  func numberInEnum() {
    let frame = #"""
      {"type":"permission-pending","request":{"permId":"p","sessionId":"s","toolName":"Read","displayText":"x",
      "risk":1,"cwd":"/p","createdAt":"t"}}
      """#
    #expect(throws: EventRejection.self) { try decode(frame).get() }
  }

  @Test("wartownik `unsupported` od serwera to też nieznany łańcuch — degradacja")
  func sentinelFromServerDegrades() throws {
    let frame = #"{"type":"state","sessionId":"s","state":"unsupported","since":"t"}"#
    let decoded = try decode(frame).get()
    #expect(decoded.degradations == [Degradation(path: "/state", value: "unsupported")])
    guard case let .state(event) = decoded.event else {
      Issue.record("zły przypadek")
      return
    }
    #expect(event.state == .unsupported)
  }

  @Test("blok `type: unsupported` od serwera → blok zastępczy z degradacją")
  func unsupportedBlockFromServer() throws {
    let frame = #"""
      {"type":"message","sessionId":"s","message":{"seq":1,"role":"assistant","at":"t",
      "blocks":[{"type":"unsupported","x":1}]}}
      """#
    let decoded = try decode(frame).get()
    #expect(decoded.degradations == [Degradation(path: "/message/blocks/0/type", value: "unsupported")])
  }

  @Test("nieznany `type` ramki → odrzucenie forward-compat")
  func unknownType() {
    guard case let .failure(rejection) = decode(#"{"type":"x-future","a":1}"#) else {
      Issue.record("nieznany typ przeszedł")
      return
    }
    #expect(rejection.reason == .unknownType("x-future"))
  }

  @Test("uszkodzony JSON → malformedJSON")
  func malformedJSON() {
    guard case let .failure(rejection) = decode(#"{"type":"hello","protocolVersion":3,"#) else {
      Issue.record("uszkodzony JSON przeszedł")
      return
    }
    #expect(rejection.reason == .malformedJSON)
  }

  @Test("ułamek w polu liczby całkowitej odrzuca ramkę (odstępstwo od z.number(), README)")
  func fractionalInteger() {
    #expect(throws: EventRejection.self) {
      try decode(#"{"type":"usage","sessionId":"s","contextTokens":1.5,"contextLimit":10}"#).get()
    }
    #expect((try? decode(#"{"type":"usage","sessionId":"s","contextTokens":2.0,"contextLimit":10}"#).get()) != nil)
  }

  @Test("serwer z Web Push: ramka `push-degraded` wypada jako nieznany typ, `pushDegradedSince` w snapshocie odcięte")
  func webPushLeftovers() throws {
    guard case let .failure(rejection) = decode(#"{"type":"push-degraded","since":"2026-10-07T08:00:00.000Z"}"#) else {
      Issue.record("ramka Web Push przeszła")
      return
    }
    #expect(rejection.reason == .unknownType("push-degraded"))
    let snapshot = try decode(#"{"type":"sessions-snapshot","sessions":[],"pushDegradedSince":"t"}"#).get()
    #expect(snapshot.degradations == [])
    guard case .sessionsSnapshot = snapshot.event else {
      Issue.record("snapshot zdekodowany do innego przypadku")
      return
    }
  }

  @Test("obrazek spoza png/jpeg base64 odrzuca ramkę (granica bezpieczeństwa)")
  func imageDataURL() {
    let svg = #"""
      {"type":"message","sessionId":"s","message":{"seq":1,"role":"assistant","at":"t",
      "blocks":[{"type":"image","dataUrl":"data:image/svg+xml;base64,PHN2Zz4="}]}}
      """#
    #expect(throws: EventRejection.self) { try decode(svg).get() }
  }

  @Test("pusty `cwd` notatki i puste `id` zadania w tle odrzucają ramkę (min(1))")
  func nonEmptyStrings() {
    #expect(throws: EventRejection.self) { try decode(#"{"type":"notes","cwd":"","empty":true}"#).get() }
    let task = #"{"type":"session-changed","session":\#(summary.dropLast()),"backgroundTasks":[{"id":"","kind":"monitor"}]}}"#
    #expect(throws: EventRejection.self) { try decode(task).get() }
  }

  @Test("postój subagenta: `waitingSince` i `ownTasks` opcjonalne; null, zły typ i komenda bez `id` odrzucają ramkę")
  func agentWaitingFields() throws {
    func frame(_ fields: String) -> String {
      #"{"type":"session-changed","session":\#(summary.dropLast()),"backgroundTasks":[{"id":"a1","kind":"agent"\#(fields)}]}}"#
    }
    func task(_ fields: String) throws -> BackgroundTask {
      let decoded = try decode(frame(fields)).get()
      #expect(decoded.degradations == [], "\(fields)")
      guard case let .sessionChanged(event) = decoded.event else { throw FixtureError("zły przypadek ramki") }
      return try #require(event.session.backgroundTasks?.first)
    }
    let waiting = try task(#"""
      ,"waitingSince":"2026-10-10T08:00:00.000Z",
      "ownTasks":[{"id":"b1","command":"sleep 9","startedAt":"2026-10-10T07:55:00.000Z"},{"id":"b2","pid":7}]
      """#)
    #expect(waiting.waitingSince == "2026-10-10T08:00:00.000Z")
    #expect(waiting.ownTasks?.map(\.id) == ["b1", "b2"])
    #expect(waiting.ownTasks?.first?.command == "sleep 9")
    #expect(waiting.ownTasks?.first?.startedAt == "2026-10-10T07:55:00.000Z")
    #expect(waiting.ownTasks?.last?.command == nil && waiting.ownTasks?.last?.startedAt == nil, "nieznany klucz odcięty")
    // Agent pracujący: pól nie ma i żadne nie jest dopowiadane (brak listy to nie pusta lista).
    let working = try task("")
    #expect(working.waitingSince == nil && working.ownTasks == nil)
    #expect(try task(#","ownTasks":[]"#).ownTasks == [])

    for broken in [
      #","waitingSince":null"#, #","waitingSince":1790000000"#, #","ownTasks":null"#, #","ownTasks":"b1""#,
      #","ownTasks":[{"command":"sleep 9"}]"#, #","ownTasks":[{"id":""}]"#, #","ownTasks":[{"id":"b1","command":null}]"#,
      #","ownTasks":[{"id":"b1","startedAt":9}]"#,
    ] {
      #expect(throws: EventRejection.self, "\(broken)") { try decode(frame(broken)).get() }
    }
  }

  @Test("notka: wynik `waiting` (postój subagenta) to znana wartość, bez degradacji")
  func waitingNoticeOutcome() throws {
    let frame = #"""
      {"type":"message","sessionId":"s","message":{"seq":1,"role":"user","at":"t","blocks":[],
      "notice":{"kind":"agent","outcome":"waiting","name":"przegląd"}}}
      """#
    let decoded = try decode(frame).get()
    #expect(decoded.degradations == [])
    guard case let .message(event) = decoded.event else {
      Issue.record("zły przypadek")
      return
    }
    #expect(event.message.notice?.outcome == .waiting && event.message.notice?.kind == .agent)
  }

  @Test("`cliDialog`: każda klasa przechodzi, brak pola = nil, nieznana klasa znika z degradacją")
  func cliDialog() throws {
    func session(_ extra: String) throws -> (SessionSummary?, [Degradation]) {
      let decoded = try decode(#"{"type":"session-changed","session":\#(summary.dropLast())\#(extra)}}"#).get()
      guard case let .sessionChanged(event) = decoded.event else { return (nil, decoded.degradations) }
      return (event.session, decoded.degradations)
    }
    for raw in ["permission", "input", "sandbox", "worker", "dialog", "goal", "other"] {
      let (known, degradations) = try session(#","cliDialog":"\#(raw)""#)
      #expect(known?.cliDialog?.rawValue == raw)
      #expect(degradations.isEmpty)
    }
    let (absent, none) = try session("")
    #expect(absent != nil && absent?.cliDialog == nil)
    #expect(none.isEmpty)
    let (unknown, degradations) = try session(#","cliDialog":"approval""#)
    #expect(unknown != nil && unknown?.cliDialog == nil)
    #expect(degradations == [Degradation(path: "/session/cliDialog", value: "approval")])
    #expect(throws: EventRejection.self) {
      try decode(#"{"type":"session-changed","session":\#(summary.dropLast()),"cliDialog":null}}"#).get()
    }
  }

  @Test("`ultracode`: bool czytany w obie strony, brak pola = nil, null i zły typ odrzucają ramkę")
  func ultracode() throws {
    func frame(_ extra: String) -> String {
      #"{"type":"session-changed","session":\#(summary.dropLast())\#(extra)}}"#
    }
    func session(_ extra: String) throws -> SessionSummary? {
      let decoded = try decode(frame(extra)).get()
      #expect(decoded.degradations.isEmpty, "\(extra)")
      guard case let .sessionChanged(event) = decoded.event else { return nil }
      return event.session
    }
    #expect(try session(#","ultracode":true"#)?.ultracode == true)
    #expect(try session(#","ultracode":false"#)?.ultracode == false)
    let absent = try session("")
    #expect(absent != nil && absent?.ultracode == nil)
    for broken in [#","ultracode":null"#, #","ultracode":"on""#, #","ultracode":1"#] {
      #expect(throws: EventRejection.self, "\(broken)") { try decode(frame(broken)).get() }
    }
  }

  @Test("`preview`, `notes` i `review`: brak pól = pytanie jak dotąd, null i zły typ odrzucają, obcy klucz odcięty")
  func previewAndReview() throws {
    func question(_ option: String, _ extra: String = "") throws -> Question? {
      let frame = #"""
        {"type":"question-pending","request":{"qId":"q","sessionId":"s","createdAt":"t","questions":[
        {"question":"Układ?","header":"","multiSelect":false,"options":[\#(option)]\#(extra)}]}}
        """#
      guard case let .questionPending(event) = try decode(frame).get().event else { return nil }
      return event.request.questions.first
    }
    // Starszy serwer: pól podglądu, przeglądu i notatek nie ma, karta bez nich.
    let old = try #require(try question(#"{"label":"A"}"#))
    #expect(old.options.first?.preview == nil && old.review == nil && old.notes == nil)
    #expect(try question(#"{"label":"A","preview":"x"}"#, #","notes":true"#)?.notes == true)
    #expect(try question(#"{"label":"A"}"#, #","notes":false"#)?.notes == false)
    // Spacje i złamania linii podglądu przechodzą bez zmian.
    let art = "┌──┐\\n│  │ x\\n└──┘"
    let withPreview = try #require(try question(#"{"label":"A","preview":"\#(art)"}"#))
    #expect(withPreview.options.first?.preview == "┌──┐\n│  │ x\n└──┘")
    let review = try #require(try question(
      #"{"label":"A"}"#, #","review":[{"question":"P1?","answers":["x","y"]},{"question":"P2?","answers":[]}]"#))
    #expect(review.review?.map(\.question) == ["P1?", "P2?"])
    #expect(review.review?.map(\.answers) == [["x", "y"], []])
    // Nowsze pole, którego ta wersja nie zna, nie zrywa ramki — tak stary build przeżywa nowe pola pytania.
    let future = try #require(try question(#"{"label":"A","nowePole":{"a":1}}"#, #","innePole":[1]"#))
    #expect(future.options.map(\.label) == ["A"])

    let base = #"{"type":"question-pending","request":{"qId":"q","sessionId":"s","createdAt":"t","questions":[{"#
      + #""question":"Układ?","header":"","multiSelect":false,"options":["#
    for broken in [
      base + #"{"label":"A","preview":null}]}]}}"#,
      base + #"{"label":"A","preview":7}]}]}}"#,
      base + #"{"label":"A"}],"review":null}]}}"#,
      base + #"{"label":"A"}],"review":[{"question":"P1?","answers":"x, y"}]}]}}"#,
      base + #"{"label":"A"}],"review":[{"answers":["x"]}]}]}}"#,
      base + #"{"label":"A"}],"notes":null}]}}"#,
      base + #"{"label":"A"}],"notes":"tak"}]}}"#,
    ] {
      #expect(throws: EventRejection.self, "\(broken)") { try decode(broken).get() }
    }
  }

  @Test("`fileDetails` w `git-status`: brak pola = nil, nieznany rodzaj → modified z degradacją, null i zły typ odrzucają")
  func gitFileDetails() throws {
    let base = #"{"type":"git-status","sessionId":"s","branch":"main","dirtyCount":1,"files":["a.ts"]"#
    func details(_ extra: String) throws -> ([GitFileDetail]?, [Degradation]) {
      let decoded = try decode(base + extra + "}").get()
      guard case let .gitStatus(event) = decoded.event else { return (nil, decoded.degradations) }
      return (event.fileDetails, decoded.degradations)
    }
    // Serwer bez szczegółów: ramka jak dotąd.
    let (absent, none) = try details("")
    #expect(absent == nil && none.isEmpty)
    for raw in ["added", "modified", "deleted"] {
      let (known, degradations) = try details(#","fileDetails":[{"path":"a.ts","kind":"\#(raw)"}]"#)
      #expect(known?.first?.kind.rawValue == raw)
      #expect(degradations.isEmpty)
    }
    let (full, _) = try details(
      #","fileDetails":[{"path":"a.ts","kind":"modified","linesAdded":4,"linesDeleted":0},{"path":"b.png","kind":"added","binary":true}]"#)
    #expect(full?.map(\.linesAdded) == [4, nil] && full?.map(\.linesDeleted) == [0, nil])
    #expect(full?.map(\.binary) == [nil, true])
    let (unknown, degradations) = try details(#","fileDetails":[{"path":"a.ts","kind":"renamed","linesAdded":1}]"#)
    #expect(unknown?.first?.kind == .modified && unknown?.first?.linesAdded == 1)
    #expect(degradations == [Degradation(path: "/fileDetails/0/kind", value: "renamed")])

    for broken in [
      #","fileDetails":null"#,
      #","fileDetails":[{"path":"a.ts","kind":1}]"#,
      #","fileDetails":[{"path":"a.ts","kind":null}]"#,
      #","fileDetails":[{"kind":"added"}]"#,
      #","fileDetails":[{"path":"a.ts","kind":"added","linesAdded":"4"}]"#,
      #","fileDetails":[{"path":"a.ts","kind":"added","linesDeleted":-1}]"#,
      #","fileDetails":[{"path":"a.ts","kind":"added","linesAdded":1.5}]"#,
      #","fileDetails":[{"path":"a.ts","kind":"added","binary":null}]"#,
    ] {
      #expect(throws: EventRejection.self, "\(broken)") { try decode(base + broken + "}").get() }
    }
  }

  @Test("`inputKind` karty zgody: `shell` przechodzi, brak pola = nil, nieznany rodzaj znika z degradacją, null odrzuca")
  func permissionInputKind() throws {
    let base = #"""
      {"type":"permission-pending","request":{"permId":"p1","sessionId":"s1","toolName":"Shell","displayText":"npm test",
      "risk":"normal","cwd":"/p","createdAt":"t"
      """#
    func request(_ extra: String) throws -> (PermissionRequest?, [Degradation]) {
      let decoded = try decode(base + extra + "}}").get()
      guard case let .permissionPending(event) = decoded.event else { return (nil, decoded.degradations) }
      return (event.request, decoded.degradations)
    }
    for raw in ["shell", "json"] {
      let (known, degradations) = try request(#","inputKind":"\#(raw)""#)
      #expect(known?.inputKind?.rawValue == raw)
      #expect(degradations.isEmpty)
    }
    let (absent, none) = try request("")
    #expect(absent != nil && absent?.inputKind == nil && none.isEmpty)
    let (unknown, degradations) = try request(#","inputKind":"sql""#)
    #expect(unknown != nil && unknown?.inputKind == nil)
    #expect(degradations == [Degradation(path: "/request/inputKind", value: "sql")])
    for broken in [#","inputKind":null"#, #","inputKind":1"#] {
      #expect(throws: EventRejection.self, "\(broken)") { try decode(base + broken + "}}").get() }
    }
  }
}
