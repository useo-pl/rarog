import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Model karty kanału zgód: pola wejścia pod komendą, ostrzeżenie o sandboksie tylko przy karcie z uwagą,
// zdanie stanu, „Odrzuć” tylko w oczekiwaniu na decyzję, karta w nieznanym stanie bez przycisków.
// Kanał z kontraktu (`PermissionChannel.hook.rawValue`), nie z literału.

@Suite("karta kanału zgód: model karty")
struct ConsentCardTests {
  private func hook(_ permId: String, state: String = "pending", extra: String = "") -> PermissionRequest {
    let channel = #""channel":"\#(PermissionChannel.hook.rawValue)","state":"\#(state)""#
    return Sample.permission(permId: permId, extra: channel + (extra.isEmpty ? "" : "," + extra))
  }

  private func cards(_ requests: [PermissionRequest]) -> [PermissionCardModel] {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = requests
    return TranscriptRows.build(state: state, sessionId: "s1", ui: TranscriptUIState()).compactMap { row in
      if case let .permission(card) = row { card } else { nil }
    }
  }

  @Test("ta sama komenda dwa razy, druga bez sandboksa: ostrzeżenie tylko przy drugiej, pola pod komendą obu")
  func sandboxWarningOnlyOnFlaggedCard() {
    let fields = #""fields":[{"name":"description","value":"testy"}]"#
    let models = cards([
      hook("k1", extra: fields),
      hook("k2", extra: #""fields":[{"name":"description","value":"testy"},"#
        + #"{"name":"dangerouslyDisableSandbox","value":"true"}],"notes":["sandbox-disabled"]"#),
    ])
    #expect(models.map(\.command) == ["npm test", "npm test"])
    #expect(models[0].sandboxWarning == nil)
    #expect(models[1].sandboxWarning == UICopy.consentSandboxDisabled)
    #expect(models[0].consentFields == [ConsentInputField(name: "description", value: "testy")])
    #expect(models[1].consentFields.count == 2)
  }

  @Test("stan: oczekiwanie bez zdania, bieg ze zdaniem i bez przycisków")
  func stateLine() {
    let models = cards([
      hook("k1"),
      hook("k2", state: "running", extra: #""canAllow":false"#),
      hook("k3", extra: #""canAllow":false,"unavailable":"terminal-only""#),
      hook("k4", extra: #""canAllow":false,"unavailable":"hidden-chars""#),
    ])
    #expect(models[0].consentStatus == nil && models[0].awaitingDecision && models[0].primaryDecision == .allow)
    #expect(models[1].consentStatus == UICopy.consentState(.running))
    #expect(!models[1].awaitingDecision && models[1].primaryDecision == nil && models[1].approvalUnavailable == nil)
    #expect(models[2].approvalUnavailable == UICopy.consentUnavailable(.terminalOnly))
    #expect(models[2].awaitingDecision)
    // Znak ukryty w treści: to samo zdanie co przy treści niepokazanej w całości, „Odrzuć” zostaje.
    #expect(models[3].approvalUnavailable == UICopy.consentUnavailable(.truncated))
    #expect(models[3].awaitingDecision)
  }

  @Test("nieznany stan albo uwaga → karta bez przycisków ze zdaniem „ta wersja apki nie zna”")
  func unsupportedCard() {
    let models = cards([hook("k1", state: "deciding"), hook("k2", extra: #""notes":["network-open"]"#)])
    for model in models {
      #expect(model.primaryDecision == nil)
      #expect(!model.awaitingDecision)
      #expect(model.consentStatus == UICopy.consentState(.unsupported))
    }
  }

  @Test("karta planu kanału z `canAllow` bez `alwaysLabel` → zgoda „Zatwierdź plan” ze zdaniem o trybie sprzed planu")
  func hookPlanCard() {
    let model = cards([hook("k1", extra: #""subject":"plan""#)])[0]
    #expect(model.plan && model.alwaysLabel == nil)
    #expect(model.primaryDecision == .allow)
    #expect(model.approvalUnavailable == nil)
    #expect(model.allowTitle == UICopy.consentAllowPlan)
    #expect(model.planNote == UICopy.consentPlanReturns)
    // Bez zgody (np. bieg) — ani przycisku, ani zdania o trybie.
    let running = cards([hook("k2", state: "running", extra: #""subject":"plan","canAllow":false"#)])[0]
    #expect(running.primaryDecision == nil && running.planNote == nil)
  }

  @Test("opcja „zawsze” karty kanału: wiersz na zmianę, dosłownie, z celem zapisu; bez listy albo zgody — brak")
  func hookAlwaysOption() {
    let always = #""always":[{"kind":"rule","value":"Bash(npm test)","destination":"localSettings"},"#
      + #"{"kind":"mode","value":"acceptEdits","destination":"session"},"#
      + #"{"kind":"directory","value":"/Users/demo/other","destination":"session"}]"#
    let models = cards([
      hook("k1", extra: always),
      hook("k2"),
      hook("k3", extra: #""canAllow":false,"unavailable":"terminal-only","# + always),
      hook("k4", extra: #""subject":"plan","# + always),
    ])
    let lines = [
      UICopy.consentAlways([ConsentAlwaysEntry(kind: .rule, value: "Bash(npm test)", destination: .localSettings)]),
      UICopy.consentAlways([ConsentAlwaysEntry(kind: .mode, value: "acceptEdits", destination: .session)]),
      UICopy.consentAlways([ConsentAlwaysEntry(kind: .directory, value: "/Users/demo/other", destination: .session)]),
    ].compactMap(\.self)
    #expect(lines.count == 3)
    #expect(models[0].alwaysLabel == lines.joined(separator: "\n"))
    #expect(lines[0].hasPrefix("Bash(npm test)") && lines[1].contains("acceptEdits"))
    #expect(lines[2].contains("/Users/demo/other") && lines[0] != lines[1])
    #expect(models[0].primaryDecision == .allow)
    #expect(models[1].alwaysLabel == nil)
    #expect(models[2].alwaysLabel == nil && models[2].primaryDecision == nil)
    #expect(models[3].alwaysLabel == nil && models[3].primaryDecision == .allow)
    #expect(UICopy.consentAlways([]) == nil)
  }

  @Test("karta planu z ekranu bez zmian: bez opcji auto bez zgody, z opcją — powrót do auto")
  func screenPlanCard() {
    let models = cards([
      Sample.permission(permId: "p1", extra: #""subject":"plan""#),
      Sample.permission(permId: "p2", extra: #""subject":"plan","alwaysLabel":"Yes, and use auto mode""#),
    ])
    #expect(models[0].primaryDecision == nil && models[0].approvalUnavailable == UICopy.planAutoUnavailable)
    #expect(models[1].primaryDecision == .allowAlways && models[1].allowTitle == UICopy.allowPlanAuto)
    #expect(models.allSatisfy { $0.planNote == nil })
  }

  @Test("„Odrzuć” na karcie kanału tylko przy `awaitingDecision`; karta ekranowa zawsze")
  func denyOnlyWhileAwaitingDecision() {
    let models = cards([
      hook("k1"),
      hook("k2", state: "running", extra: #""canAllow":false"#),
      hook("k3", state: "deciding"),
      Sample.permission(permId: "p1", extra: #""canAllow":false"#),
    ])
    #expect(models.map(\.canDeny) == [true, false, false, true])
    #expect(models[0].allowTitle == UICopy.allow)
  }

  /// Karta w zadanej fazie, złożona wprost: faza zależy od wpisu decyzji w store (`DecisionAttempt.accepted`), nie
  /// od ramki serwera.
  static func phased(
    _ phase: CardPhase, hookChannel: Bool = true, awaitingDecision: Bool = true, note: String? = nil
  ) -> PermissionCardModel {
    var model = PermissionCardModel(
      permId: "k1", sessionId: "s1", eyebrow: "ZGODA", toolName: "Write", risky: false, plan: false,
      cwd: "~/Projects/ACME/rarog", command: "npm test", commandSyntax: [], createdAt: nil, canAllow: true,
      screen: nil, cliDialog: nil, phase: phase, error: nil, lockedReason: nil, alwaysLabel: nil, note: note)
    model.hookChannel = hookChannel
    model.awaitingDecision = awaitingDecision
    return model
  }

  @Test("własna zgoda albo odmowa w drodze i przyjęta: wiersz stanu w stopce; w spoczynku bez wiersza")
  func footerStatusOfOwnDecision() {
    let cases: [(CardPhase, String)] = [
      (.sending(.allow), UICopy.allowing), (.sending(.deny), UICopy.denying),
      (.sent(.allow), UICopy.consentAllowSent), (.sent(.deny), UICopy.consentDenySent),
    ]
    for (phase, status) in cases {
      #expect(Self.phased(phase).footerStatus == status, "\(phase)")
    }
    #expect(Self.phased(.idle).footerStatus == nil)
  }

  @Test("po 200 karta kanału mówi, że decyzja poszła z tego urządzenia; karta ekranowa jak dotąd", arguments: [
    (true, PermissionDecision.allow, UICopy.consentAllowSent, UICopy.consentAllowSent),
    (true, .deny, UICopy.consentDenySent, UICopy.consentDenySent),
    (false, .allow, UICopy.allowedWaiting, UICopy.allowedSpoken),
    (false, .deny, UICopy.deniedWaiting, UICopy.deniedSpoken),
  ] as [(Bool, PermissionDecision, String, String)])
  func acceptedFooterAndSpoken(_ hookChannel: Bool, _ choice: PermissionDecision, _ footer: String, _ spoken: String) {
    let model = Self.phased(.sent(choice), hookChannel: hookChannel, awaitingDecision: false)
    #expect(model.footerStatus == footer)
    #expect(model.acceptedSpoken(choice) == spoken)
  }

  @Test("409 `conflict`: karta kanału zostaje ze zdaniem pod kartą, ekranowa znika bez zdania (ślad w transkrypcie)")
  func conflictNote() {
    #expect(Self.phased(.idle).decisionNote(.alreadyDecided) == UICopy.decidedElsewhere)
    #expect(Self.phased(.idle, hookChannel: false, awaitingDecision: false).decisionNote(.alreadyDecided) == nil)
    #expect(Self.phased(.idle).decisionNote(.expired) == nil)
    #expect(Self.phased(.idle).decisionNote(.failed) == nil)
  }

  /// Stan z jedną kartą `k1` (kanał albo ekran) i decyzją z tego urządzenia; `result` = `nil` → decyzja w drodze.
  private func decided(
    hookChannel: Bool = true, choice: String = "allow", result: DecisionResultKind? = .accepted
  ) -> AppState {
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [hookChannel ? hook("k1") : Sample.permission(permId: "k1")]
    state.apply(.decisionStarted(sessionId: "s1", cardId: "k1", choice: choice), now: Sample.now)
    if let result {
      state.apply(.decisionFinished(sessionId: "s1", cardId: "k1", kind: .permission, result: result), now: Sample.now)
    }
    return state
  }

  private func resolve(
    _ state: inout AppState, _ decision: String = "allow", by: String = PermissionChannel.hook.rawValue
  ) {
    let resolved = Sample.decode(PermissionResolvedEvent.self, #"""
      {"sessionId":"s1","permId":"k1","decision":"\#(decision)","by":"\#(by)"}
      """#)
    state.apply(.frame(.permissionResolved(resolved), source: .session("s1"), cursor: nil), now: Sample.now)
  }

  private func card(_ state: AppState) -> PermissionCardModel? {
    TranscriptRows.build(state: state, sessionId: "s1", ui: TranscriptUIState()).compactMap { row in
      if case let .permission(card) = row { card } else { nil }
    }.first
  }

  private func rowTexts(_ state: AppState) -> [String] {
    TranscriptRows.build(state: state, sessionId: "s1", ui: TranscriptUIState()).compactMap { row in
      switch row {
      case let .decisionTrace(model): model.text
      case let .notice(_, text): text
      default: nil
      }
    }
  }

  @Test("przyjęcie (200) stoi w store: nowy, pusty stan ekranu (zmiana sesji) → „wysłana”; w drodze → „Zatwierdzam…”")
  func acceptedSurvivesNewScreen() {
    let accepted = card(decided())
    #expect(accepted?.phase == .sent(.allow))
    #expect(accepted?.footerStatus == "Zgoda wysłana z tego urządzenia.")
    #expect(card(decided(choice: "deny"))?.footerStatus == "Odmowa wysłana z tego urządzenia.")
    let flying = card(decided(result: nil))
    #expect(flying?.phase == .sending(.allow))
    #expect(flying?.footerStatus == UICopy.allowing)
    // 409 na karcie kanału: karta zostaje w spoczynku (zdanie pod kartą daje kontroler), 410: karty nie ma.
    #expect(card(decided(result: .conflict))?.phase == .idle)
    #expect(card(decided(result: .gone)) == nil)
  }

  @Test("karta kanału zdjęta od hooka po własnej przyjętej decyzji → ślad „wysłana”, w dowolnej kolejności z 200")
  func hookTraceAfterResolved() {
    var after = decided()
    resolve(&after)
    #expect(card(after) == nil)
    #expect(rowTexts(after) == ["Zgoda wysłana: Shell · npm test"])

    var before = decided(result: nil)
    resolve(&before)
    #expect(rowTexts(before).isEmpty, "decyzja jeszcze w drodze")
    before.apply(.decisionFinished(sessionId: "s1", cardId: "k1", kind: .permission, result: .accepted), now: Sample.now)
    #expect(rowTexts(before) == ["Zgoda wysłana: Shell · npm test"])
    #expect(before.transcripts["s1"]?.decisions.isEmpty == true, "wpis decyzji nie wraca")

    var denied = decided(choice: "deny")
    resolve(&denied, "deny")
    #expect(rowTexts(denied) == ["Odmowa wysłana: Shell · npm test"])

    // Hook zdjął kartę bez decyzji w rekordzie (`expired`): po naszej przyjętej zgodzie to nie „wygasła”.
    var expired = decided()
    resolve(&expired, "expired")
    #expect(rowTexts(expired) == ["Zgoda wysłana: Shell · npm test"])
  }

  @Test("karta ekranowa po własnej przyjętej decyzji → ślad „Zatwierdzono” jak dziś")
  func screenTraceUnchanged() {
    var state = decided(hookChannel: false)
    resolve(&state, by: "iPhone")
    #expect(rowTexts(state) == ["Zatwierdzono: Shell · npm test"])
  }

  @Test("karta ekranowa bez pól kanału → model jak dotąd")
  func screenCard() {
    let model = cards([Sample.permission(permId: "p1")])[0]
    #expect(!model.hookChannel && model.consentFields.isEmpty && model.sandboxWarning == nil)
    #expect(model.consentStatus == nil && !model.awaitingDecision)
  }
}
