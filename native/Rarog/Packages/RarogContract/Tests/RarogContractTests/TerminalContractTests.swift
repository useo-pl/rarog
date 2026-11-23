// Kontrakt REST terminala dla apki natywnej. Schematy stoją w
// `shared/src/protocol.ts` (`termOpenBodySchema`, `termOpenResponseSchema`,
// `termListResponseSchema`, `termHistoryResponseSchema`) i są re-eksportowane w
// `@rarog/shared/rest`. Próbki tutaj to kształt
// odpowiedzi routera (`POST /api/term`, `GET /api/term`, `GET /api/term/:id/history`).
import Foundation
import RarogContract
import Testing

@Suite("kontrakt REST: terminal")
struct TerminalContractTests {
  static let id = "0123456789abcdef"

  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  @Test("ciało, którego serwer nie przyjmie, nie powstaje: slot przy popupie, pusty katalog, slot spoza 1…4")
  func openBodyRefused() {
    #expect(TerminalOpenBody(cwd: "/p", slot: .number(1), role: .popup) == nil)
    #expect(TerminalOpenBody(cwd: "/p", slot: .next, role: .lazygit) == nil)
    #expect(TerminalOpenBody(cwd: "") == nil)
    #expect(TerminalOpenBody(cwd: "/p", slot: .number(0)) == nil)
    #expect(TerminalOpenBody(cwd: "/p", slot: .number(5)) == nil)
    #expect(TerminalOpenBody(cwd: "/p", slot: .number(-1)) == nil)
    // Granice `termOpenBodySchema`: 1…TERM_SLOTS_MAX (4).
    #expect(TerminalOpenBody(cwd: "/p", slot: .number(1)) != nil)
    #expect(TerminalOpenBody(cwd: "/p", slot: .number(4)) != nil)
    #expect(TerminalSlot.max == 4)
    #expect(TerminalRole.allCases.filter(\.isPopup) == [.lazygit, .popup])
  }

  @Test("slot w odpowiedziach: 0…4 jak w schematach TS (0 = popup), −1 i 5 odrzucają", arguments: [0, 4])
  func responseSlotAccepted(_ slot: Int) throws {
    let open = try decode(TerminalOpenResponse.self, #"{"id":"\#(Self.id)","slot":\#(slot),"role":"popup"}"#)
    #expect(open.slot == slot)
    let list = try decode(TerminalList.self,
      #"{"terminals":[{"id":"\#(Self.id)","cwd":"/p","live":true,"slot":\#(slot),"proc":"","role":"shell"}]}"#)
    #expect(list.terminals.first?.slot == slot)
  }

  @Test("slot w odpowiedziach spoza 0…4 odrzuca całą odpowiedź", arguments: [-1, 5])
  func responseSlotRejected(_ slot: Int) {
    #expect(throws: (any Error).self) {
      _ = try decode(TerminalOpenResponse.self, #"{"id":"\#(Self.id)","slot":\#(slot),"role":"shell"}"#)
    }
    #expect(throws: (any Error).self) {
      _ = try decode(TerminalList.self,
        #"{"terminals":[{"id":"\#(Self.id)","cwd":"/p","live":true,"slot":\#(slot),"proc":"","role":"shell"}]}"#)
    }
  }

  @Test("odpowiedź `POST /api/term`: id, slot i rola; popup ma slot 0")
  func openResponse() throws {
    let shell = try decode(TerminalOpenResponse.self, #"{"id":"\#(Self.id)","slot":2,"role":"shell"}"#)
    #expect(shell.id == Self.id && shell.slot == 2 && shell.role == .shell)
    let git = try decode(TerminalOpenResponse.self, #"{"id":"\#(Self.id)","slot":0,"role":"lazygit"}"#)
    #expect(git.slot == 0 && git.role.isPopup)
  }

  @Test("odpowiedź `POST /api/term`: id spoza kształtu, nieznana rola i brak roli odrzucają")
  func openResponseRejections() {
    for json in [
      #"{"id":"../../etc","slot":1,"role":"shell"}"#,
      #"{"id":"0123456789ABCDEF","slot":1,"role":"shell"}"#,
      #"{"id":"\#(Self.id)","slot":1,"role":"tmux"}"#,
      #"{"id":"\#(Self.id)","slot":1}"#,
    ] {
      #expect(throws: (any Error).self, "\(json)") { _ = try decode(TerminalOpenResponse.self, json) }
    }
  }

  @Test("lista: wpisy z katalogiem i procesem; wpis o nieznanej roli znika, reszta zostaje")
  func list() throws {
    let list = try decode(TerminalList.self, #"""
      {"terminals":[
        {"id":"\#(Self.id)","cwd":"/p","live":true,"slot":1,"proc":"nvim","role":"shell"},
        {"id":"fedcba9876543210","cwd":"/p","live":false,"slot":0,"proc":"","role":"przyszla"},
        {"id":"00000000000000ff","cwd":"/p","live":false,"slot":0,"proc":"","role":"popup","nowe":1}
      ]}
      """#)
    #expect(list.terminals.map(\.id) == [Self.id, "00000000000000ff"])
    #expect(list.terminals[0].live && list.terminals[0].proc == "nvim" && list.terminals[0].cwd == "/p")
    #expect(try decode(TerminalList.self, #"{"terminals":[]}"#).terminals.isEmpty)
  }

  @Test("lista: zły id, `null` zamiast tablicy i brak pola odrzucają całą odpowiedź")
  func listRejections() {
    for json in [
      #"{"terminals":[{"id":"x","cwd":"/p","live":true,"slot":1,"proc":"","role":"shell"}]}"#,
      #"{"terminals":null}"#,
      #"{"terminals":[{"id":"\#(Self.id)","cwd":"/p","slot":1,"proc":"","role":"shell"}]}"#,
    ] {
      #expect(throws: (any Error).self, "\(json)") { _ = try decode(TerminalList.self, json) }
    }
  }

  @Test("historia: zwykły tekst i znacznik ucięcia")
  func history() throws {
    let history = try decode(TerminalHistory.self, #"{"text":"$ ls\nREADME.md\n","truncated":true}"#)
    #expect(history.text == "$ ls\nREADME.md\n" && history.truncated)
    #expect(throws: (any Error).self) { _ = try decode(TerminalHistory.self, #"{"text":"x"}"#) }
  }
}
