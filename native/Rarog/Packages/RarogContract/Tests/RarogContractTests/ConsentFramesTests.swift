// Karta kanału zgód na złotych ramkach: `channel`, `state`, `unavailable`, `fields`, `notes`,
// `dialogVisible`, `siblingsDenied`, `always` i zdarzenie `permission-settled` (zmiana w miejscu). Stara ramka bez
// tych pól daje kartę jak dotąd (nowa apka × stary serwer).
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("kontrakt: karta kanału zgód")
struct ConsentFramesTests {
  let frames = GoldenFrames.shared

  private func decoded(_ name: String) throws -> DecodedEvent {
    try EventDecoder.decode(frames.dataField(name)).get()
  }

  private func request(_ name: String) throws -> PermissionRequest {
    guard case let .permissionPending(event) = try decoded(name).event else {
      Issue.record("\(name): to nie `permission-pending`")
      throw CancellationError()
    }
    return event.request
  }

  @Test("`permission-pending.hook.json` → kanał, stan i `permId` równy kluczowi hooka")
  func hookCard() throws {
    let card = try request("permission-pending.hook.json")
    #expect(card.channel?.rawValue == "hook")
    #expect(card.isHookChannel)
    #expect(card.state == .pending)
    #expect(card.permId == "rarog-k-7f3a91")
    #expect(card.canAllow == true)
    #expect(card.dialogVisible == true)
    #expect(card.fields?.map(\.name) == ["description", "timeout"])
    #expect(card.notes == nil)
    #expect(card.isHookAwaitingDecision)
    #expect(!card.isUnsupportedHookCard)
  }

  @Test("ta sama komenda z wyłączonym sandboksem: uwaga `sandbox-disabled` tylko na drugiej karcie")
  func sandboxNote() throws {
    let plain = try request("permission-pending.hook.json")
    let unsandboxed = try request("permission-pending.hook-sandbox.json")
    #expect(plain.displayText == unsandboxed.displayText)
    #expect(plain.notes == nil)
    #expect(unsandboxed.notes == [.sandboxDisabled])
    #expect(unsandboxed.fields?.last == ConsentInputField(name: "dangerouslyDisableSandbox", value: "true"))
  }

  @Test("`permission-pending.hook-always.json` → opcja „zawsze” z dosłowną regułą i celem zapisu")
  func alwaysOption() throws {
    let card = try request("permission-pending.hook-always.json")
    #expect(card.canAllow == true)
    #expect(card.always == [ConsentAlwaysEntry(kind: .rule, value: "Bash(pnpm test:*)", destination: .localSettings)])
    #expect(try request("permission-pending.hook.json").always == nil)
  }

  @Test("nieznany rodzaj albo cel wpisu „zawsze” → ramka odrzucona, jak w `zod` serwera", arguments: [
    ("kind", "permissions"), ("destination", "userSettings"),
  ])
  func alwaysStrict(field: String, value: String) throws {
    var json = try #require(
      try JSONSerialization.jsonObject(with: frames.dataField("permission-pending.hook-always.json")) as? [String: Any]
    )
    var request = try #require(json["request"] as? [String: Any])
    var entry = try #require((request["always"] as? [[String: Any]])?.first)
    entry[field] = value
    request["always"] = [entry]
    json["request"] = request
    let data = try JSONSerialization.data(withJSONObject: json)
    #expect(throws: (any Error).self) { try EventDecoder.decode(data).get() }
  }

  @Test("nieznany stan, powód albo uwaga → degradacja i karta bez przycisków", arguments: [
    "permission-pending.unknown-state.json", "permission-pending.unknown-unavailable.json",
    "permission-pending.unknown-note.json",
  ])
  func unknownDegrades(_ name: String) throws {
    let event = try decoded(name)
    #expect(event.degradations.count == 1)
    guard case let .permissionPending(pending) = event.event else { throw CancellationError() }
    #expect(pending.request.isUnsupportedHookCard)
    #expect(!pending.request.isHookAwaitingDecision)
  }

  @Test("`siblingsDenied: 2` i `dialogVisible: false` → oba pola")
  func siblings() throws {
    let card = try request("permission-pending.hook-siblings.json")
    #expect(card.siblingsDenied == 2)
    #expect(card.dialogVisible == false)
    #expect(card.unavailable == .terminalOnly)
  }

  @Test("karta bez prezentacji: zdanie z kodem, bez zgody")
  func truncatedCard() throws {
    let card = try request("permission-pending.hook-truncated.json")
    #expect(card.displayTextRef?.code == "dialogs.consent.not-shown")
    #expect(card.canAllow == false)
    #expect(card.unavailable == .truncated)
  }

  @Test("stara ramka bez pól kanału → karta jak dotąd")
  func legacyCard() throws {
    let card = try request("permission-pending.max.json")
    #expect(card.channel == nil)
    #expect(!card.isHookChannel)
    #expect(card.state == nil && card.unavailable == nil && card.fields == nil && card.notes == nil)
    #expect(card.dialogVisible == nil && card.siblingsDenied == nil)
    #expect(!card.isUnsupportedHookCard)
  }

  @Test("`permission-settled` zmienia stan, przyciski i powód karty w miejscu")
  func settledInPlace() throws {
    var card = try request("permission-pending.hook.json")
    guard case let .permissionSettled(settled) = try decoded("permission-settled.max.json").event else {
      Issue.record("to nie `permission-settled`")
      return
    }
    #expect(settled.permId == card.permId)
    card.settle(settled)
    #expect(card.state == settled.state)
    #expect(card.canAllow == false)
    #expect(card.unavailable == .noProof)
    #expect(card.permId == "rarog-k-7f3a91")
  }

  @Test("`permission-settled` z nieznanym stanem → wartownik i degradacja")
  func settledUnknownState() throws {
    let event = try decoded("permission-settled.unknown-state.json")
    guard case let .permissionSettled(settled) = event.event else { throw CancellationError() }
    #expect(settled.state == .unsupported)
    #expect(event.degradations == [Degradation(path: "/state", value: "deciding")])
  }

  @Test("`release` w ciele decyzji")
  func releaseBody() throws {
    let data = try JSONEncoder().encode(PermissionDecisionBody(decision: .release))
    #expect(String(decoding: data, as: UTF8.self) == #"{"decision":"release"}"#)
  }
}
