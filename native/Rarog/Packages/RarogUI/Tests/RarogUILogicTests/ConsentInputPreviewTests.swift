import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Long input of a channel card (up to the hook's 1 MiB): the card block shows a preview cut at a
// line end, and the whole input waits for the window ("Show Full Request"). Approve stays on the card.

@Suite("karta kanału zgód: długie wejście, podgląd na karcie i całość w oknie")
struct ConsentInputPreviewTests {
  private func hook(_ permId: String, text: String, extra: String = "") -> PermissionRequest {
    let channel = #""channel":"\#(PermissionChannel.hook.rawValue)","state":"pending""#
    var request = Sample.permission(permId: permId, extra: channel + (extra.isEmpty ? "" : "," + extra))
    request.displayText = text
    return request
  }

  private func card(_ request: PermissionRequest, ui: TranscriptUIState = TranscriptUIState()) -> PermissionCardModel {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [request]
    let cards = TranscriptRows.build(state: state, sessionId: "s1", ui: ui).compactMap { row in
      if case let .permission(card) = row { card } else { nil }
    }
    return cards[0]
  }

  /// About `bytes` of text in lines of 64 bytes.
  private func lines(bytes: Int) -> String {
    (0..<(bytes / 64)).map { "linia \(String(format: "%05d", $0)) " + String(repeating: "x", count: 51) }
      .joined(separator: "\n")
  }

  /// `Write` as the server shows it: JSON with `file_path` and `content`, so `content` is one escaped line.
  private func writeJSON(bytes: Int) -> String {
    let data = try? JSONSerialization.data(
      withJSONObject: ["file_path": "/tmp/projekt/a.txt", "content": lines(bytes: bytes)],
      options: [.prettyPrinted, .sortedKeys])
    return data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
  }

  @Test("krótkie wejście: karta bez zmian, bez okna")
  func shortInput() {
    let model = card(hook("k1", text: "npm test", extra: #""fields":[{"name":"description","value":"testy"}]"#))
    #expect(model.command == "npm test")
    #expect(model.consentFields == [ConsentInputField(name: "description", value: "testy")])
    #expect(model.fullInput == nil)
  }

  @Test("`Write` 200 KiB: podgląd do sufitu (jedna długa linia `content`); całość w oknie; zgoda zostaje na karcie")
  func longWrite() {
    let text = writeJSON(bytes: 200 * 1024)
    #expect(text.utf8.count > 200 * 1024)
    let model = card(hook("k1", text: text, extra: #""inputKind":"json""#))
    #expect(model.command.utf8.count <= ConsentInputPreview.maxBytes)
    #expect(model.command.utf8.count > ConsentInputPreview.maxBytes - 8)
    #expect(text.hasPrefix(model.command))
    #expect(model.fullInput?.text == text)
    #expect(model.fullInput?.lines == text.split(separator: "\n", omittingEmptySubsequences: false).count)
    #expect(model.primaryDecision == .allow)
  }

  @Test("skrypt powłoki 200 KiB w liniach: podgląd ucięty na końcu linii")
  func longScript() {
    let text = lines(bytes: 200 * 1024)
    let model = card(hook("k1", text: text, extra: #""inputKind":"shell""#))
    #expect(model.command.utf8.count <= ConsentInputPreview.maxBytes)
    #expect(model.command.utf8.count > ConsentInputPreview.maxBytes - 64)
    #expect(text.hasPrefix(model.command))
    // The cut falls on a line end: the next character of the whole text is the newline.
    #expect(text[text.index(text.startIndex, offsetBy: model.command.count)] == "\n")
    #expect(model.fullInput?.lines == 200 * 1024 / 64)
  }

  @Test("jedna długa linia z literami wielobajtowymi: cięcie na granicy znaku, poprawny tekst")
  func longSingleLine() {
    let text = String(repeating: "żółw ", count: 20_000)
    let model = card(hook("k1", text: text))
    #expect(model.command.utf8.count <= ConsentInputPreview.maxBytes)
    #expect(model.command.utf8.count > ConsentInputPreview.maxBytes - 8)
    #expect(text.hasPrefix(model.command))
    #expect(model.fullInput?.text == text)
    #expect(model.fullInput?.lines == 1)
  }

  @Test("okno całej prośby to okno: ustępuje formularzowi i zastępuje inne okno")
  @MainActor
  func windowYieldsToForm() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let request = ConsentInputRequest(toolName: "Write", text: writeJSON(bytes: 64 * 1024))
    let form = AppSheet.newSession(NewSessionRequest(cwd: nil))
    navigation.openSheet(form)
    navigation.openSheet(.consentInput(request))
    #expect(navigation.sheet == form, "formularz trzyma")
    navigation.sheet = nil
    navigation.openSheet(.diff(DiffRequest(sessionId: "s1", path: nil)))
    navigation.openSheet(.consentInput(request))
    #expect(navigation.sheet == .consentInput(request))
    #expect(navigation.sheet?.isWindow == true && navigation.sheet?.id == request.id)
  }

  /// A card for each consent with an input preview: a channel tool card with "always" (approve and "always"), a
  /// channel plan
  /// (approve plan) and a screen plan (approve plan through `allowAlways`).
  enum Consent: String, CaseIterable {
    case tool, hookPlan, screenPlan

    func request(text: String) -> PermissionRequest {
      let channel = #""channel":"\#(PermissionChannel.hook.rawValue)","state":"pending""#
      let extra = switch self {
      case .tool: channel + #","always":[{"kind":"rule","value":"Bash(npm test)","destination":"localSettings"}]"#
      case .hookPlan: channel + #","subject":"plan""#
      case .screenPlan: #""subject":"plan","alwaysLabel":"Yes, and use auto mode""#
      }
      var request = Sample.permission(permId: "k1", extra: extra)
      request.displayText = text
      return request
    }

    /// The decisions the card offers besides deny.
    var consents: [PermissionDecision] {
      switch self {
      case .tool: [.allow, .allowAlways]
      case .hookPlan: [.allow]
      case .screenPlan: [.allowAlways]
      }
    }

    var hint: String { self == .tool ? UICopy.consentOpenFullToAllow : UICopy.consentOpenFullToApprove }
  }

  @Test("wejście do 32 KiB → zgoda aktywna, bez dopisku", arguments: Consent.allCases)
  func shortInputConsents(_ kind: Consent) {
    let model = card(kind.request(text: lines(bytes: ConsentInputPreview.maxBytes)))
    #expect(model.fullInput == nil)
    #expect(model.primaryDecision != nil)
    #expect(!model.consentAwaitsFullInput && model.fullInputHint == nil)
    #expect((kind.consents + [.deny]).allSatisfy { model.permits($0) })
  }

  @Test("wejście ponad 32 KiB, okno nieotwarte → zgoda nieaktywna z dopiskiem, „Odrzuć” aktywne",
    arguments: Consent.allCases)
  func longInputWaitsForWindow(_ kind: Consent) {
    let model = card(kind.request(text: lines(bytes: 40 * 1024)))
    #expect(model.fullInput != nil)
    // The buttons stay on the card, greyed: the decision they would send does not change.
    #expect(model.primaryDecision == kind.consents.first)
    #expect(model.consentAwaitsFullInput)
    #expect(model.fullInputHint == kind.hint)
    for consent in kind.consents { #expect(!model.permits(consent), "\(consent)") }
    #expect(model.permits(.deny))
  }

  /// The mark comes from the window's content appearing: a window of this card that the
  /// screen opened, but whose content did not appear (closed or replaced first), unlocks nothing; neither does the
  /// window of another card, nor a presentation this screen did not open.
  @Test("po pojawieniu się okna tej karty → zgoda aktywna; okno bez treści, innej karty i obce bez wpływu",
    arguments: Consent.allCases)
  func windowOfThisCardUnlocks(_ kind: Consent) {
    let request = kind.request(text: lines(bytes: 40 * 1024))
    var ui = TranscriptUIState()
    let other = UUID()
    ui.fullInputRead.open(other, permId: "k2")
    let otherUnlocked = ui.fullInputRead.appeared(other)
    #expect(otherUnlocked)
    // This card's window stood in the navigation state and went away before its content appeared.
    ui.fullInputRead.open(UUID(), permId: "k1")
    let strangerUnlocked = ui.fullInputRead.appeared(UUID())
    #expect(!strangerUnlocked, "prezentacja, której ten ekran nie otworzył")
    let locked = card(request, ui: ui)
    #expect(locked.consentAwaitsFullInput && locked.fullInputHint == kind.hint)
    for consent in kind.consents { #expect(!locked.permits(consent), "\(consent)") }

    let shown = UUID()
    ui.fullInputRead.open(shown, permId: "k1")
    let unlocked = ui.fullInputRead.appeared(shown)
    #expect(unlocked)
    let model = card(request, ui: ui)
    #expect(model.fullInputRead && !model.consentAwaitsFullInput && model.fullInputHint == nil)
    #expect((kind.consents + [.deny]).allSatisfy { model.permits($0) })
  }

  @Test("`Bash` z długim polem: pole przycięte na karcie, okno ma komendę i wszystkie pola w całości")
  func longField() {
    let long = String(repeating: "opis\n", count: 10_000)
    let fields = [
      ["name": "description", "value": long], ["name": "timeout", "value": "1000"],
    ]
    let json = (try? JSONSerialization.data(withJSONObject: fields)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    let model = card(hook("k1", text: "make all", extra: #""inputKind":"shell","fields":"# + json))
    #expect(model.command == "make all")
    #expect(model.consentFields.count == 2)
    #expect(model.consentFields[0].value.utf8.count <= ConsentInputPreview.maxBytes)
    #expect(long.hasPrefix(model.consentFields[0].value))
    #expect(model.consentFields[1] == ConsentInputField(name: "timeout", value: "1000"))
    #expect(model.fullInput?.text == [
      "make all", UICopy.consentField(name: "description", value: long), UICopy.consentField(name: "timeout", value: "1000"),
    ].joined(separator: "\n"))
  }
}
