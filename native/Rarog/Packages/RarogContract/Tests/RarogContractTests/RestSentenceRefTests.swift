// Pola `*Ref` w odpowiedziach REST i w podsumowaniu sesji: odczyt, kodowanie i tłumaczenie na ręcznym JSON
// w kształcie z `shared/src/rest.ts` i `shared/src/protocol.ts`. Pole `*Ref` czyta `ContractContainer.optional`:
// brak = `nil`, `null` i uszkodzony `ref` odrzucają odpowiedź jak zod. `translate` podmienia tekst parą
// `(tekst, ref)`, a samo `ref` zostaje bez zmian.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("kontrakt REST: pola `*Ref` zdań serwera — odczyt, round-trip, tłumaczenie")
struct RestSentenceRefTests {
  /// Renderer testowy z karty: znany `ref` → `PL:<kod>`, brak `ref` → tekst z drutu.
  static let renderer: SentenceRenderer = { text, ref in ref.map { "PL:" + $0.code } ?? text }

  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  /// `encode(decode(json)) == json` w porównaniu kanonicznym (klucze bez kolejności).
  private func expectRoundTrip<T: Codable>(_ type: T.Type, _ json: String, sourceLocation: SourceLocation = #_sourceLocation) throws {
    let value = try decode(type, json)
    let expected = try JSONValue.parse(Data(json.utf8))
    let actual = try JSONValue.parse(JSONEncoder().encode(value))
    #expect(JSONValue.differences(expected: expected, actual: actual) == [], sourceLocation: sourceLocation)
  }

  /// Uszkodzone `ref` w polu `field` (wstawiane na miejsce `@REF@`) odrzucają cały obiekt.
  static let brokenRefs = [
    "null", #""x""#, #"{"code":""}"#, #"{}"#, #"{"code":"a.b","args":["1",2]}"#,
    #"{"code":"a.b","args":["1","2","3","4","5","6","7","8","9"]}"#, #"{"code":"a.b","args":null}"#,
  ]

  private func expectBrokenRefsReject<T: Decodable>(
    _ type: T.Type, _ template: String, sourceLocation: SourceLocation = #_sourceLocation
  ) {
    for broken in Self.brokenRefs {
      let json = template.replacingOccurrences(of: "@REF@", with: broken)
      #expect(throws: DecodingError.self, "\(broken)", sourceLocation: sourceLocation) { _ = try decode(type, json) }
    }
  }

  // MARK: - ciało błędu

  @Test("ciało błędu: `messageRef` czytane, `null` i uszkodzony `ref` odrzucają, brak = nil")
  func errorBodyDecodes() throws {
    let body = try decode(APIErrorBody.self, #"{"error":"x","message":"m","messageRef":{"code":"rest.internal"}}"#)
    #expect(body.messageRef?.code == "rest.internal")
    #expect(body.messageRef?.args == [])
    #expect(try decode(APIErrorBody.self, #"{"error":"x","message":"m"}"#).messageRef == nil)
    expectBrokenRefsReject(APIErrorBody.self, #"{"error":"x","message":"m","messageRef":@REF@}"#)
  }

  @Test("ciało błędu: `translate` tłumaczy `message`, `messageRef` zostaje; bez `messageRef` bez zmian")
  func errorBodyTranslates() throws {
    var body = try decode(APIErrorBody.self, #"{"error":"x","message":"m","messageRef":{"code":"rest.internal"}}"#)
    body.translate(Self.renderer)
    #expect(body.message == "PL:rest.internal")
    #expect(body.messageRef == SentenceRef(code: "rest.internal"))
    #expect(body.error == "x")

    var plain = try decode(APIErrorBody.self, #"{"error":"x","message":"m"}"#)
    plain.translate(Self.renderer)
    #expect(plain.message == "m")
  }

  @Test("422 odmowy decyzji: `reason` i `messageRef` w tym samym typie, tłumaczenie zdania odmowy")
  func decisionRefusedBody() throws {
    let json = #"""
      {"error":"refused","reason":"multi-select","message":"Multi-select.",
       "messageRef":{"code":"dialogs.refuse.multi-select"}}
      """#
    var body = try decode(APIErrorBody.self, json)
    #expect(body.reason == "multi-select")
    body.translate(Self.renderer)
    #expect(body.message == "PL:dialogs.refuse.multi-select")
    #expect(body.reason == "multi-select")
    try expectRoundTrip(APIErrorBody.self, json)
  }

  @Test("ciało błędu: round-trip dosłowny z `messageRef` z argumentami i bez pola")
  func errorBodyRoundTrip() throws {
    try expectRoundTrip(APIErrorBody.self, #"{"error":"x","message":"m","messageRef":{"code":"a.b","args":["1","y"]}}"#)
    try expectRoundTrip(APIErrorBody.self, #"{"error":"x","message":"m","messageRef":{"code":"rest.internal"}}"#)
    try expectRoundTrip(APIErrorBody.self, #"{"error":"x","message":"m"}"#)
  }

  // MARK: - notatki i urządzenia

  @Test("409 notatek: `messageRef` czytane, tłumaczone, round-trip; uszkodzony `ref` odrzuca")
  func notesConflict() throws {
    let json = #"""
      {"error":"conflict","message":"Notes changed.","messageRef":{"code":"rest.notes-conflict"},
       "current":{"text":"a","updatedAt":12}}
      """#
    var body = try decode(NotesConflictBody.self, json)
    #expect(body.messageRef?.code == "rest.notes-conflict")
    try expectRoundTrip(NotesConflictBody.self, json)
    body.translate(Self.renderer)
    #expect(body.message == "PL:rest.notes-conflict")
    #expect(body.current == NotesDoc(text: "a", updatedAt: 12))

    var plain = try decode(NotesConflictBody.self, #"{"error":"conflict","message":"m","current":{"text":"","updatedAt":0}}"#)
    #expect(plain.messageRef == nil)
    plain.translate(Self.renderer)
    #expect(plain.message == "m")
    expectBrokenRefsReject(
      NotesConflictBody.self, #"{"error":"conflict","message":"m","messageRef":@REF@,"current":{"text":"","updatedAt":0}}"#)
  }

  @Test("401 odpiętego urządzenia: `messageRef` czytane, tłumaczone, round-trip; uszkodzony `ref` odrzuca")
  func deviceRevoked() throws {
    let json = #"""
      {"error":"device-revoked","message":"Unpaired.","messageRef":{"code":"rest.device-revoked"},
       "revokedAt":"2026-10-04T10:03:00.000Z","revokedBy":"admin"}
      """#
    var body = try decode(DeviceRevokedBody.self, json)
    #expect(body.messageRef?.code == "rest.device-revoked")
    try expectRoundTrip(DeviceRevokedBody.self, json)
    body.translate(Self.renderer)
    #expect(body.message == "PL:rest.device-revoked")
    #expect(body.revokedBy == "admin")

    let base = #""error":"device-revoked","message":"m","revokedAt":"t","revokedBy":"admin""#
    var plain = try decode(DeviceRevokedBody.self, "{\(base)}")
    plain.translate(Self.renderer)
    #expect(plain.message == "m")
    expectBrokenRefsReject(DeviceRevokedBody.self, #"{\#(base),"messageRef":@REF@}"#)
  }

  // MARK: - modele

  static let modelsJSON = #"""
    {"models":[
      {"value":"","label":"Account default model","labelRef":{"code":"model.account-default.label"},
       "description":"No --model flag.","descriptionRef":{"code":"model.account-default.description"},
       "effortLevels":[]},
      {"value":"fable","label":"Fable","effortLevels":["low","high"],"ultracode":true},
      {"value":"haiku","label":"Haiku","description":"Fast.","effortLevels":[]}
    ]}
    """#

  @Test("lista modeli: `labelRef` i `descriptionRef` czytane; uszkodzony `ref` w każdym polu odrzuca listę")
  func modelListDecodes() throws {
    let list = try decode(ModelList.self, Self.modelsJSON)
    #expect(list.models[0].labelRef?.code == "model.account-default.label")
    #expect(list.models[0].descriptionRef?.code == "model.account-default.description")
    #expect(list.models[1].labelRef == nil && list.models[1].descriptionRef == nil)
    for field in ["labelRef", "descriptionRef"] {
      expectBrokenRefsReject(
        ModelList.self, #"{"models":[{"value":"x","label":"X","description":"d","effortLevels":[],"\#(field)":@REF@}]}"#)
    }
  }

  @Test("lista modeli: `translate` tłumaczy `label` i `description` każdego wyboru; wybór bez `labelRef` bez zmian")
  func modelListTranslates() throws {
    var list = try decode(ModelList.self, Self.modelsJSON)
    list.translate(Self.renderer)
    #expect(list.models.map(\.label) == ["PL:model.account-default.label", "Fable", "Haiku"])
    #expect(list.models.map(\.description) == ["PL:model.account-default.description", nil, "Fast."])
    #expect(list.models[0].labelRef?.code == "model.account-default.label")

    var choice = ModelChoice(
      value: "x", label: "X", effortLevels: [], labelRef: SentenceRef(code: "model.x"))
    choice.translate(Self.renderer)
    #expect(choice.label == "PL:model.x")
    #expect(choice.description == nil)
  }

  @Test("lista modeli: round-trip dosłowny (`ultracode` tylko jako true, pola `*Ref` tylko obecne)")
  func modelListRoundTrip() throws {
    try expectRoundTrip(ModelList.self, Self.modelsJSON)
  }

  @Test("202 zmiany modelu: `warningRef` czytane, tłumaczone, round-trip z `ok: true`; uszkodzony `ref` odrzuca")
  func sessionModelAccepted() throws {
    let json = #"{"ok":true,"warning":"Model change.","warningRef":{"code":"model.change-warning"}}"#
    var accepted = try decode(SessionModelAccepted.self, json)
    #expect(accepted.warningRef?.code == "model.change-warning")
    try expectRoundTrip(SessionModelAccepted.self, json)
    try expectRoundTrip(SessionModelAccepted.self, #"{"ok":true,"warning":"Model change."}"#)
    accepted.translate(Self.renderer)
    #expect(accepted.warning == "PL:model.change-warning")

    var plain = try decode(SessionModelAccepted.self, #"{"ok":true,"warning":"w"}"#)
    plain.translate(Self.renderer)
    #expect(plain.warning == "w")
    expectBrokenRefsReject(SessionModelAccepted.self, #"{"ok":true,"warning":"w","warningRef":@REF@}"#)
  }

  // MARK: - podsumowanie sesji, herdr, przerwanie

  static let sessionBase = #"""
    "id":"s1","cwd":"/p","title":"p","state":"running","stateSince":"t","createdAt":"t","lastActivityAt":"t"
    """#

  static let sessionJSON = #"""
    {\#(sessionBase),"label":"session 2","labelRef":{"code":"session.fallback-label","args":["2"]},
     "stateDetail":"Unknown herdr state.","stateDetailRef":{"code":"state.herdr-unknown"}}
    """#

  @Test("podsumowanie sesji: `stateDetailRef` i `labelRef` czytane i tłumaczone; uszkodzony `ref` odrzuca")
  func sessionSummary() throws {
    var session = try decode(SessionSummary.self, Self.sessionJSON)
    #expect(session.labelRef == SentenceRef(code: "session.fallback-label", args: ["2"]))
    #expect(session.stateDetailRef == SentenceRef(code: "state.herdr-unknown"))
    session.translate(Self.renderer)
    #expect(session.label == "PL:session.fallback-label")
    #expect(session.stateDetail == "PL:state.herdr-unknown")
    #expect(session.title == "p")
    #expect(session.labelRef?.args == ["2"])

    var plain = try decode(
      SessionSummary.self, #"{\#(Self.sessionBase),"label":"prompt","stateDetail":"agent text"}"#)
    plain.translate(Self.renderer)
    #expect(plain.label == "prompt" && plain.stateDetail == "agent text")
    for field in ["stateDetailRef", "labelRef"] {
      expectBrokenRefsReject(SessionSummary.self, #"{\#(Self.sessionBase),"\#(field)":@REF@}"#)
    }
  }

  @Test("podsumowanie sesji: round-trip dosłowny z obu polami `*Ref` i bez nich")
  func sessionSummaryRoundTrip() throws {
    try expectRoundTrip(SessionSummary.self, Self.sessionJSON)
    try expectRoundTrip(SessionSummary.self, "{\(Self.sessionBase)}")
  }

  @Test("stan herdr: `detailRef` czytane, tłumaczone, round-trip; uszkodzony `ref` odrzuca")
  func herdrStatus() throws {
    let base = #""available":true,"agentCount":3,"readOnly":false,"canLaunch":false,"detail":"Pane cap.""#
    let json = #"{\#(base),"detailRef":{"code":"herdr.pane-cap"}}"#
    var status = try decode(HerdrStatus.self, json)
    #expect(status.detailRef?.code == "herdr.pane-cap")
    try expectRoundTrip(HerdrStatus.self, json)
    status.translate(Self.renderer)
    #expect(status.detail == "PL:herdr.pane-cap")

    var plain = try decode(HerdrStatus.self, "{\(base)}")
    plain.translate(Self.renderer)
    #expect(plain.detail == "Pane cap.")
    #expect(HerdrStatus(available: true, agentCount: 0, readOnly: false, canLaunch: true).detailRef == nil)
    expectBrokenRefsReject(HerdrStatus.self, #"{\#(base),"detailRef":@REF@}"#)
  }

  @Test("odpowiedź przerwania tłumaczy `session`; round-trip z `ok: true` i `delivered`; bez sesji bez zmian")
  func interruptResponse() throws {
    let json = #"{"ok":true,"session":\#(Self.sessionJSON),"delivered":"yes"}"#
    var response = try decode(InterruptResponse.self, json)
    try expectRoundTrip(InterruptResponse.self, json)
    response.translate(Self.renderer)
    #expect(response.session?.stateDetail == "PL:state.herdr-unknown")
    #expect(response.session?.label == "PL:session.fallback-label")
    #expect(response.delivered == .yes)

    var bare = try decode(InterruptResponse.self, #"{"ok":true}"#)
    try expectRoundTrip(InterruptResponse.self, #"{"ok":true}"#)
    bare.translate(Self.renderer)
    #expect(bare.session == nil && bare.delivered == nil)
  }
}
