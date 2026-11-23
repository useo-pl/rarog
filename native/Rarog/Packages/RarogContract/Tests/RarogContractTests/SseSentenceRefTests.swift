// Pola `*Ref` w ramkach SSE, blokach transkryptu, kartach decyzji, ramce `err` terminala i tekście jawnym
// pusha (`sentenceRefSchema` z `shared/src/sentences/`). Test chodzi na ręcznym JSON:
// dekodowanie (brak = `nil`, `null` i uszkodzony `ref` odrzucają), `translate` przez renderer testowy i round-trip
// dosłowny (pole `nil` nie wychodzi).
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

/// Renderer testowy: zdanie z `ref` → `PL:<kod>`, bez `ref` → tekst bez zmian.
private let testRenderer: SentenceRenderer = { text, ref in ref.map { "PL:" + $0.code } ?? text }

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
  try JSONDecoder().decode(type, from: Data(json.utf8))
}

/// Round-trip: `encode(decode(json))` równe `json` po parsowaniu (kolejność kluczy bez znaczenia).
private func roundTrip<T: Codable>(_ type: T.Type, _ json: String) throws -> Bool {
  let value = try decode(type, json)
  return try JSONValue.parse(JSONEncoder().encode(value)) == JSONValue.parse(Data(json.utf8))
}

private let imageURL = "data:image/png;base64,iVBORw0KGgo="

@Suite("kontrakt kodów zdań: pola `*Ref` w SSE, transkrypcie, kartach, terminalu i pushu")
struct SseSentenceRefTests {}

extension SseSentenceRefTests {
  @Suite("kontrakt kodów zdań: `*Ref` w zdarzeniach stanu i herdr")
  struct StateEvents {
    private let state = #"{"sessionId":"s1","state":"limit-reached","detail":"resetAt=2026-11-12T10:00:00Z","since":"2026-11-06T10:00:00Z"}"#
    private let ref = #","detailRef":{"code":"state.limit-reached","args":["2026-11-12T10:00:00Z"]}}"#

    private func withRef(_ base: String, _ suffix: String) -> String { String(base.dropLast()) + suffix }

    @Test("`state.detailRef` → tłumaczony `detail`, `ref` bez zmian; bez `detailRef` bez zmian")
    func stateDetailRef() throws {
      var event = try decode(StateEvent.self, withRef(state, ref))
      #expect(event.detailRef == SentenceRef(code: "state.limit-reached", args: ["2026-11-12T10:00:00Z"]))
      event.translate(testRenderer)
      #expect(event.detail == "PL:state.limit-reached")
      #expect(event.detailRef?.code == "state.limit-reached")

      var plain = try decode(StateEvent.self, state)
      #expect(plain.detailRef == nil)
      plain.translate(testRenderer)
      #expect(plain.detail == "resetAt=2026-11-12T10:00:00Z")
    }

    @Test(
      "uszkodzony `state.detailRef` odrzuca ramkę",
      arguments: [#","detailRef":null}"#, #","detailRef":{"code":""}}"#, #","detailRef":"x"}"#])
    func stateBrokenRef(suffix: String) {
      #expect(throws: DecodingError.self) { try decode(StateEvent.self, withRef(state, suffix)) }
    }

    @Test("round-trip `state` z `detailRef` i bez niego")
    func stateRoundTrip() throws {
      #expect(try roundTrip(StateEvent.self, withRef(state, ref)))
      #expect(try roundTrip(StateEvent.self, state))
    }

    private let herdr = #"{"available":false,"agentCount":0,"readOnly":true,"detail":"Rarog pane limit reached."}"#

    @Test("`herdr-status.detailRef` → tłumaczony `detail`; round-trip dosłowny; `null` odrzuca")
    func herdrDetailRef() throws {
      let json = withRef(herdr, #","detailRef":{"code":"herdr.pane-cap"}}"#)
      var event = try decode(HerdrStatusEvent.self, json)
      event.translate(testRenderer)
      #expect(event.detail == "PL:herdr.pane-cap")
      #expect(try roundTrip(HerdrStatusEvent.self, json))
      #expect(try roundTrip(HerdrStatusEvent.self, herdr))
      #expect(throws: DecodingError.self) { try decode(HerdrStatusEvent.self, withRef(herdr, #","detailRef":null}"#)) }
    }
  }
}

extension SseSentenceRefTests {
  @Suite("kontrakt kodów zdań: blok `text` z `ref`, obraz z `placeholder`, transkrypt tłumaczy bloki")
  struct TranscriptBlocks {
    @Test("blok `text` z `ref` → `.text(_, ref:)`, round-trip dosłowny")
    func textBlockWithRef() throws {
      let json = #"{"type":"text","text":"a","ref":{"code":"transcript.repoint-clear"}}"#
      let block = try decode(Block.self, json)
      #expect(block == .text("a", ref: SentenceRef(code: "transcript.repoint-clear")))
      #expect(try roundTrip(Block.self, json))
    }

    @Test("blok `text` bez `ref` → `ref: nil`, kodowanie bez pola `ref`")
    func textBlockWithoutRef() throws {
      let json = #"{"type":"text","text":"a"}"#
      #expect(try decode(Block.self, json) == .text("a", ref: nil))
      #expect(try decode(Block.self, json) == .text("a"))
      let encoded = try JSONValue.parse(JSONEncoder().encode(Block.text("a")))
      #expect(encoded == (try JSONValue.parse(Data(json.utf8))))
    }

    @Test(
      "uszkodzony `ref` bloku odrzuca blok",
      arguments: [
        #"{"type":"text","text":"a","ref":null}"#,
        #"{"type":"text","text":"a","ref":{"code":""}}"#,
        #"{"type":"text","text":"a","ref":{"code":"a.b","args":["1","2","3","4","5","6","7","8","9"]}}"#,
        #"{"type":"text","text":"a","ref":{"code":"a.b","args":[1]}}"#,
      ])
    func textBlockBrokenRef(json: String) {
      #expect(throws: DecodingError.self) { try decode(Block.self, json) }
    }

    @Test("obraz: brak `placeholder` = `false`, `true` = zastępnik; inna wartość odrzuca blok")
    func imagePlaceholder() throws {
      let bare = #"{"dataUrl":"\#(imageURL)","alt":"[image]"}"#
      #expect(try decode(ImageBlock.self, bare).placeholder == false)
      let marked = #"{"dataUrl":"\#(imageURL)","alt":"[image]","placeholder":true}"#
      #expect(try decode(ImageBlock.self, marked).placeholder == true)
      for value in ["false", "null", #""true""#, "1"] {
        let json = #"{"dataUrl":"\#(imageURL)","placeholder":\#(value)}"#
        #expect(throws: DecodingError.self, "\(value)") { try decode(ImageBlock.self, json) }
      }
    }

    @Test("obraz: round-trip — `placeholder: true` wraca, `false` nie wychodzi")
    func imageRoundTrip() throws {
      #expect(try roundTrip(Block.self, #"{"type":"image","dataUrl":"\#(imageURL)","alt":"x","placeholder":true}"#))
      #expect(try roundTrip(Block.self, #"{"type":"image","dataUrl":"\#(imageURL)"}"#))
    }

    @Test("narzędzie: round-trip z `truncation` i bez niego")
    func toolCallRoundTrip() throws {
      #expect(try roundTrip(
        Block.self, #"{"type":"tool-call","toolName":"Read","summary":"ls","detail":"abc","truncation":{"cut":3,"footer":1}}"#))
      #expect(try roundTrip(Block.self, #"{"type":"tool-call","toolName":"Read","summary":"ls"}"#))
    }

    @Test("`TranscriptMessage.translate`: blok z `ref` tłumaczony, tekst agenta, obraz i narzędzie bez zmian")
    func messageTranslates() throws {
      let json = #"""
        {"seq":3,"role":"system","at":"2026-11-06T10:00:00Z","blocks":[
          {"type":"text","text":"Session cleared.","ref":{"code":"transcript.repoint-clear"}},
          {"type":"text","text":"tekst agenta"},
          {"type":"image","dataUrl":"\#(imageURL)","alt":"[image]","placeholder":true},
          {"type":"tool-call","toolName":"Read","summary":"ls","detail":"a\n… (1 character cut off)","truncation":{"cut":1,"footer":24}}
        ]}
        """#
      let original = try decode(TranscriptMessage.self, json)
      var message = original
      message.translate(testRenderer)
      #expect(message.blocks[0] == .text("PL:transcript.repoint-clear", ref: SentenceRef(code: "transcript.repoint-clear")))
      #expect(message.blocks[1] == .text("tekst agenta", ref: nil))
      #expect(message.blocks[2] == original.blocks[2])
      #expect(message.blocks[3] == original.blocks[3])
      #expect(try roundTrip(TranscriptMessage.self, json))
    }
  }
}

extension SseSentenceRefTests {
  @Suite("kontrakt kodów zdań: `*Ref` w kartach zgody i pytania")
  struct DecisionCards {
    private let permission = #"""
      {"permId":"p1","sessionId":"s1","toolName":"Read","displayText":"Card unreadable.","risk":"normal",
      "cwd":"/tmp","createdAt":"2026-11-06T10:00:00Z","displayTextRef":{"code":"dialogs.degraded-unreadable"}}
      """#

    @Test("`PermissionRequest.displayTextRef` → tłumaczony `displayText`; round-trip dosłowny")
    func permissionDisplayTextRef() throws {
      var card = try decode(PermissionRequest.self, permission)
      #expect(card.displayTextRef == SentenceRef(code: "dialogs.degraded-unreadable"))
      card.translate(testRenderer)
      #expect(card.displayText == "PL:dialogs.degraded-unreadable")
      #expect(card.displayTextRef?.code == "dialogs.degraded-unreadable")
      #expect(try roundTrip(PermissionRequest.self, permission))
    }

    @Test("`PermissionRequest` bez `displayTextRef` bez zmian; `null` odrzuca kartę")
    func permissionWithoutRef() throws {
      let bare = permission.replacing(#","displayTextRef":{"code":"dialogs.degraded-unreadable"}"#, with: "")
      var card = try decode(PermissionRequest.self, bare)
      card.translate(testRenderer)
      #expect(card.displayText == "Card unreadable.")
      #expect(try roundTrip(PermissionRequest.self, bare))
      let broken = permission.replacing(#"{"code":"dialogs.degraded-unreadable"}"#, with: "null")
      #expect(throws: DecodingError.self) { try decode(PermissionRequest.self, broken) }
    }

    private let question = #"""
      {"qId":"q1","sessionId":"s1","createdAt":"2026-11-06T10:00:00Z","questions":[
        {"question":"Allow this tool?","header":"Tool","multiSelect":false,"options":[{"label":"Yes"}],
         "questionRef":{"code":"dialogs.fallback-question.tool"}},
        {"question":"Pytanie autora","header":"Wybór","multiSelect":false,"options":[{"label":"A"}]}
      ]}
      """#

    @Test("`QuestionRequest`: pytanie z `questionRef` tłumaczone, pozostałe nie; round-trip dosłowny")
    func questionRef() throws {
      var request = try decode(QuestionRequest.self, question)
      #expect(request.questions[0].questionRef == SentenceRef(code: "dialogs.fallback-question.tool"))
      #expect(request.questions[1].questionRef == nil)
      request.translate(testRenderer)
      #expect(request.questions[0].question == "PL:dialogs.fallback-question.tool")
      #expect(request.questions[0].header == "Tool")
      #expect(request.questions[1].question == "Pytanie autora")
      #expect(try roundTrip(QuestionRequest.self, question))
    }

    @Test("`questionRef: null` odrzuca kartę pytania")
    func questionNullRef() {
      let broken = question.replacing(#"{"code":"dialogs.fallback-question.tool"}"#, with: "null")
      #expect(throws: DecodingError.self) { try decode(QuestionRequest.self, broken) }
    }
  }
}

extension SseSentenceRefTests {
  @Suite("kontrakt kodów zdań: `msgRef` w ramce `err` terminala")
  struct TerminalError {
    @Test("`err` z `msgRef` → `.error(message:ref:)`")
    func errorWithRef() {
      #expect(TerminalServerFrame.decode(#"{"t":"err","msg":"x","msgRef":{"code":"term.taken-over"}}"#)
        == .error(message: "x", ref: SentenceRef(code: "term.taken-over")))
    }

    @Test("`err` bez `msgRef` → `ref: nil`")
    func errorWithoutRef() {
      #expect(TerminalServerFrame.decode(#"{"t":"err","msg":"x"}"#) == .error(message: "x", ref: nil))
    }

    @Test(
      "uszkodzony `msgRef` → brak ramki (jak zły `msg`)",
      arguments: [
        #"{"t":"err","msg":"x","msgRef":null}"#,
        #"{"t":"err","msg":"x","msgRef":"term.taken-over"}"#,
        #"{"t":"err","msg":"x","msgRef":{"code":""}}"#,
        #"{"t":"err","msg":"x","msgRef":{"code":"a.b","args":["1","2","3","4","5","6","7","8","9"]}}"#,
        #"{"t":"err","msg":"x","msgRef":{"code":"a.b","args":[2]}}"#,
        #"{"t":"err","msg":"x","msgRef":{"code":"a.b","args":null}}"#,
      ])
    func brokenRef(text: String) {
      #expect(TerminalServerFrame.decode(text) == nil)
    }

    @Test("`translate`: zdanie `err` przez renderer, `ref` zostaje; `hello` i `exit` bez zmian")
    func translates() {
      var frame = TerminalServerFrame.error(message: "x", ref: SentenceRef(code: "term.taken-over"))
      frame.translate(testRenderer)
      #expect(frame == .error(message: "PL:term.taken-over", ref: SentenceRef(code: "term.taken-over")))
      var plain = TerminalServerFrame.error(message: "Limit")
      plain.translate(testRenderer)
      #expect(plain == .error(message: "Limit", ref: nil))
      var hello = TerminalServerFrame.hello(backend: "herdr")
      hello.translate(testRenderer)
      #expect(hello == .hello(backend: "herdr"))
    }
  }
}

extension SseSentenceRefTests {
  @Suite("kontrakt kodów zdań: `titleRef`/`bodyRef` w tekście jawnym pusha")
  struct PushPlaintextRefs {
    private let plaintext = #"""
      {"kind":"done","title":"Agent finished","body":"Check the session.","exp":1800000000,
      "titleRef":{"code":"push.chime.title"},"bodyRef":{"code":"push.chime.body"}}
      """#

    @Test("`titleRef`/`bodyRef` → tłumaczone `title`/`body`")
    func translates() throws {
      var value = try decode(PushPlaintext.self, plaintext)
      #expect(value.titleRef == SentenceRef(code: "push.chime.title"))
      value.translate(testRenderer)
      #expect(value.title == "PL:push.chime.title")
      #expect(value.body == "PL:push.chime.body")
      #expect(value.bodyRef?.code == "push.chime.body")
    }

    @Test("tekst jawny bez `*Ref` bez zmian")
    func withoutRefs() throws {
      var value = try decode(PushPlaintext.self, #"{"kind":"done","title":"T","body":"B","exp":1}"#)
      value.translate(testRenderer)
      #expect(value.title == "T" && value.body == "B")
      #expect(value.titleRef == nil && value.bodyRef == nil)
    }

    @Test(
      "`titleRef: null` i uszkodzony `bodyRef` odrzucają tekst jawny",
      arguments: [
        #"{"kind":"done","title":"T","exp":1,"titleRef":null}"#,
        #"{"kind":"done","body":"B","exp":1,"bodyRef":{"code":""}}"#,
        #"{"kind":"done","body":"B","exp":1,"bodyRef":{"code":"a.b","args":[1]}}"#,
      ])
    func brokenRefs(json: String) {
      #expect(throws: DecodingError.self) { try decode(PushPlaintext.self, json) }
    }
  }
}
