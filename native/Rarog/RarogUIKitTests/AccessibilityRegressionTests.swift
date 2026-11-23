import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Testy rzeczywistych widoków i kontrolera UIKit. Bez hosta apki, sieci, cookie i Keychaina.
@MainActor
final class AccessibilityRegressionTests: XCTestCase {
  func testFrozenComposerAnnouncesDisabledAndKeepsDraftSelectable() {
    let composer = ComposerView(frame: .zero)
    composer.text = "szkic"
    composer.isEditable = false
    XCTAssertFalse(composer.textView.isEditable)
    XCTAssertTrue(composer.textView.isSelectable)
    XCTAssertTrue(composer.textView.accessibilityTraits.contains(.notEnabled))
    composer.isEditable = true
    XCTAssertTrue(composer.textView.isEditable)
    XCTAssertTrue(composer.textView.isSelectable)
    XCTAssertFalse(composer.textView.accessibilityTraits.contains(.notEnabled))
    XCTAssertEqual(composer.text, "szkic")
  }

  /// Puste pole w największym piśmie: podpowiedź łamie się na linie i mieści w polu, pismo się nie
  /// zmniejsza (audyt zgłaszał „Text clipped" przy `adjustsFontSizeToFitWidth`).
  func testEmptyComposerHoldsWholePlaceholderAtLargestText() throws {
    let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 300, height: 600))
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 300, height: 600))
    window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
    window.addSubview(composer)
    window.isHidden = false
    composer.setNeedsLayout()
    composer.layoutIfNeeded()
    composer.layoutIfNeeded()
    let placeholder = try XCTUnwrap(Self.labels(in: composer).first { $0.text == UICopy.composerPlaceholder })
    XCTAssertEqual(placeholder.numberOfLines, 0)
    XCTAssertFalse(placeholder.adjustsFontSizeToFitWidth, "pismo podpowiedzi się nie zmniejsza")
    XCTAssertGreaterThan(placeholder.frame.height, placeholder.font.lineHeight * 1.5, "podpowiedź łamie się na linie")
    let field = composer.textView.convert(composer.textView.bounds, to: composer)
    let text = placeholder.convert(placeholder.bounds, to: composer)
    XCTAssertGreaterThanOrEqual(field.maxY + 0.5, text.maxY, "mieści się w polu")
  }

  private static func labels(in view: UIView) -> [UILabel] {
    view.subviews.flatMap { ($0 as? UILabel).map { [$0] } ?? [] + labels(in: $0) }
  }

  // MARK: List footer card

  /// Card models of the footer in every state: numbers with the machine, the skeleton, a missing window, unavailable,
  /// a server without the machine feature (404) and the widest numbers ("100%", "za 23 h 59", "100").
  private static func footerCards() -> [(name: String, model: ListFooterCardModel)] {
    let now = Date()
    func window(_ id: String, _ percent: Int, resetIn seconds: TimeInterval?) -> UsageSegment {
      UsageSegment(
        id: id, short: id, full: id, spoken: id, percent: percent, tone: UsageTone(percent: percent),
        resetsAt: seconds.map { now.addingTimeInterval($0) })
    }
    func usage(_ phase: PlanUsageState.Phase, _ segments: [UsageSegment]) -> PlanUsageModel {
      PlanUsageModel(
        phase: phase, segments: segments, account: phase == .loading ? nil : "someone.with.a.long.name@example.com",
        staleNote: nil)
    }
    func mac(_ phase: MacLoadState.Phase, cpu: Int? = 100, ram: Int? = 80, disk: Int? = 95) -> MacLoadModel {
      let metrics = [(MacMetric.cpu, "CPU", cpu), (.ram, "RAM", ram), (.disk, "DSK", disk)].map { metric, short, value in
        MacMetricRow(
          metric: metric, short: short, full: short, detail: "", spoken: short, percent: value,
          level: value == nil ? .normal : .critical)
      }
      return MacLoadModel(phase: phase, metrics: metrics, tailnet: "example.ts.net", staleNote: nil, machine: .mac)
    }
    let widest = [window("5h", 100, resetIn: 23 * 3600 + 59 * 60), window("7d", 100, resetIn: 6 * 86_400 + 5 * 3600)]
    let narrow = [window("5h", 5, resetIn: 30), window("7d", 7, resetIn: nil)]
    let cases: [(String, PlanUsageModel, MacLoadModel)] = [
      ("numbers", usage(.ready, widest), mac(.ready)),
      ("short numbers", usage(.ready, narrow), mac(.ready, cpu: 5, ram: 0, disk: 9)),
      ("skeleton", usage(.loading, []), mac(.loading, cpu: nil, ram: nil, disk: nil)),
      ("no 5 h", usage(.ready, [widest[1]]), mac(.ready, ram: nil)),
      ("unavailable", usage(.unavailable, []), mac(.unavailable, cpu: nil, ram: nil, disk: nil)),
      ("404 numbers", usage(.ready, widest), mac(.unsupported)),
      ("404 skeleton", usage(.loading, []), mac(.unsupported)),
    ]
    return cases.map { name, usage, mac in (name, ListFooterCardModel.make(usage: usage, mac: mac, now: now)) }
  }

  /// The card's lines laid out at the width of the card's content in a list column, with the probe: drawn stage,
  /// frames and fitted size.
  private static func layoutFooterCard(
    _ model: ListFooterCardModel, width: CGFloat, size: DynamicTypeSize
  ) -> (stages: Set<FooterCardLines.Stage>, frames: [String: CGRect], fitted: CGSize) {
    let probe = FooterCardProbe()
    let host = UIHostingController(
      rootView: FooterCardLines(model: model).environment(\.footerCardProbe, probe).environment(\.dynamicTypeSize, size))
    let fitted = host.sizeThatFits(in: CGSize(width: width, height: 10_000))
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: max(200, fitted.height + 40)))
    window.rootViewController = host
    window.isHidden = false
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    let deadline = Date().addingTimeInterval(2)
    while probe.stages.isEmpty, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    window.isHidden = true
    return (probe.stages, probe.frames, fitted)
  }

  /// Content width of the card in a list column: column − 2 × card side − 2 × card padding.
  private static func footerContentWidth(column: CGFloat) -> CGFloat {
    column - 2 * ListFooterMetrics.cardSide - 2 * ListFooterMetrics.cardPaddingSide
  }

  /// The card fits the narrowest list column (300 pt), the usual iPad column (320 pt) and the iPhone list (393 pt)
  /// at every text size and in every state, and one stage is drawn: with the machine columns at the default size
  /// in a 320 pt column, never with them at accessibility sizes (limits under each other, machine numbers in the
  /// sheet) or without the machine feature (404). The stage table goes to the result's attachment.
  func testFooterCardFitsListColumnsAtEveryTextSize() {
    var table: [String] = []
    for column in [CGFloat(300), 320, 393] {
      let width = Self.footerContentWidth(column: column)
      for (name, model) in Self.footerCards() {
        var row: [String] = []
        for size in DynamicTypeSize.allCases {
          let label = "\(name), column \(column) pt, \(size)"
          let measured = Self.layoutFooterCard(model, width: width, size: size)
          XCTAssertEqual(measured.stages.count, 1, "\(label): one stage drawn: \(measured.stages)")
          XCTAssertLessThanOrEqual(measured.fitted.width, width + 0.5, "\(label): \(measured.fitted)")
          guard let stage = measured.stages.first else { continue }
          row.append("\(size): \(stage.rawValue)")
          if size.isAccessibilitySize { XCTAssertEqual(stage, .stack, "\(label): limits under each other") }
          if model.machine == nil { XCTAssertNotEqual(stage, .full, "\(label): no machine columns without the feature") }
          if size == .large, column >= 320, model.machine != nil {
            XCTAssertEqual(stage, .full, "\(label): the whole card at the default size")
          }
          // Every part stays inside the card's content.
          for (key, frame) in measured.frames where key.hasPrefix("card.") {
            XCTAssertLessThanOrEqual(frame.maxX, width + 0.5, "\(label): \(key) sticks out: \(frame)")
          }
        }
        table.append("\(name), \(column) pt — " + row.joined(separator: ", "))
      }
    }
    let attachment = XCTAttachment(string: table.joined(separator: "\n"))
    attachment.name = "Footer-card-stages"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// The card doesn't change its height between the skeleton and the numbers (nor with shorter numbers, a missing
  /// window or an unavailable reading), at a fixed width and text size, with and without the machine feature.
  func testFooterCardHeightIsTheSameForSkeletonAndNumbers() {
    let cards = Dictionary(uniqueKeysWithValues: Self.footerCards().map { ($0.name, $0.model) })
    let groups = [["skeleton", "numbers", "short numbers", "no 5 h", "unavailable"], ["404 skeleton", "404 numbers"]]
    for column in [CGFloat(300), 320] {
      let width = Self.footerContentWidth(column: column)
      for size in DynamicTypeSize.allCases {
        for group in groups {
          let heights = group.map { name in
            (name, Self.layoutFooterCard(cards[name]!, width: width, size: size).fitted.height)
          }
          for (name, height) in heights.dropFirst() {
            XCTAssertEqual(
              height, heights[0].1, accuracy: 0.5,
              "\(column) pt, \(size): \(name) \(height) pt, \(heights[0].0) \(heights[0].1) pt")
          }
        }
      }
    }
  }

  /// Threshold colors of the card: calm fields stay quiet (label `muted`, number and bar `text2`, missing `muted2`);
  /// above the threshold the label, the number and the bar of that field take amber or red.
  func testFooterInkMarksOnlyTheWindowAboveTheThreshold() {
    XCTAssertEqual(FooterInk.label(.calm), Palette.muted)
    XCTAssertEqual(FooterInk.label(nil), Palette.muted)
    XCTAssertEqual(FooterInk.value(.calm), Palette.text2)
    XCTAssertEqual(FooterInk.value(nil), Palette.muted2)
    XCTAssertEqual(FooterInk.bar(.calm), Palette.text2)
    for (tone, ink) in [(UsageTone.warn, Palette.wait), (.hot, Palette.err)] {
      XCTAssertEqual(FooterInk.label(tone), ink)
      XCTAssertEqual(FooterInk.value(tone), ink)
      XCTAssertEqual(FooterInk.bar(tone), ink)
    }
  }

  /// The machine line stands under the e-mail and the machine columns span the whole left column (e-mail, machine
  /// line, limits) beside it: numbers level with the e-mail, labels level with the reset
  /// lines, and the bars take the extra height.
  func testFooterMachineColumnsSpanTheLeftColumn() throws {
    let cards = Dictionary(uniqueKeysWithValues: Self.footerCards().map { ($0.name, $0.model) })
    let model = try XCTUnwrap(cards["numbers"])
    let measured = Self.layoutFooterCard(model, width: Self.footerContentWidth(column: 320), size: .large)
    XCTAssertEqual(measured.stages, [.full])
    let account = try XCTUnwrap(measured.frames["card.account"], "account lines")
    let limit = try XCTUnwrap(measured.frames["card.5h"], "5 h field")
    for id in try XCTUnwrap(model.machine).map(\.id) {
      let column = try XCTUnwrap(measured.frames["card.\(id)"], id)
      let bar = try XCTUnwrap(measured.frames["card.\(id).bar"], "\(id) bar")
      XCTAssertGreaterThan(column.minX, account.maxX, "\(id): beside the left column")
      XCTAssertEqual(column.minY, account.minY, accuracy: 0.5, "\(id): top level with the e-mail")
      XCTAssertEqual(column.maxY, limit.maxY, accuracy: 0.5, "\(id): bottom level with the limits")
      XCTAssertGreaterThan(bar.height, ListFooterMetrics.machineBarHeight * 2, "\(id): the bar takes the height: \(bar)")
    }
    // Two lines, one under the other: the account lines are taller than one line of the e-mail.
    XCTAssertGreaterThan(account.height, 28, "e-mail and the machine line under each other: \(account)")
  }

  func testMacPanelRowFitsNarrowestListColumnAtEveryTextSize() {
    let width: CGFloat = 300 - 2 * 16
    let rows = [
      MacMetricRow(metric: .cpu, short: "CPU", full: "Procesor", detail: "średnia z minuty", spoken: "procesor",
        percent: 100, level: .critical),
      MacMetricRow(metric: .disk, short: "DSK", full: "Dysk", detail: "zajęte", spoken: "dysk", percent: nil,
        level: .normal),
    ]
    for row in rows {
      for size in DynamicTypeSize.allCases {
        let host = UIHostingController(rootView: MacPanelRow(metric: row).environment(\.dynamicTypeSize, size))
        let fitted = host.sizeThatFits(in: CGSize(width: width, height: 10_000))
        XCTAssertLessThanOrEqual(fitted.width, width + 0.5, "\(row.full) \(size): \(fitted)")
      }
    }
  }

  /// The card's text follows Dynamic Type all the way: a limit field grows with every accessibility size and is
  /// smaller below the default (the audit reported "partially unsupported" for text standing still below Large).
  func testFooterLimitFieldScalesThroughEveryTextSize() {
    let field = FooterLimitField(
      id: "5h", label: "5H", percent: "91%", fraction: 0.91, tone: .hot, reset: "za 2 h 44")
    var previous: CGFloat?
    var heights: [DynamicTypeSize: CGFloat] = [:]
    for size in DynamicTypeSize.allCases {
      let host = UIHostingController(rootView: FooterLimitView(field: field).environment(\.dynamicTypeSize, size))
      let height = host.sizeThatFits(in: CGSize(width: 1000, height: 1000)).height
      heights[size] = height
      if let previous {
        XCTAssertGreaterThanOrEqual(height, previous, "\(size)")
        if size.isAccessibilitySize { XCTAssertGreaterThan(height, previous, "\(size) grows the field") }
      }
      previous = height
    }
    XCTAssertLessThan(heights[.xSmall] ?? 0, heights[.large] ?? 0, "smaller below the default")
    XCTAssertGreaterThan(heights[.accessibility5] ?? 0, 2 * (heights[.large] ?? 0))
  }

  /// Pasek promptu stoi na pełnym tle dymku, więc zmniejszona przezroczystość
  /// ma go już z definicji: bez szkła, kryjące tło przed dotykiem, pod palcem i po nim.
  func testPromptBarStaysOpaqueThroughTouch() throws {
    let bar = PromptBarView(frame: .zero)
    XCTAssertTrue(bar.subviews.compactMap { $0 as? UIVisualEffectView }.isEmpty, "bez szkła")
    for (pressed, expected) in [(false, Palette.userPlate), (true, Palette.userPlatePressed), (false, Palette.userPlate)] {
      bar.isHighlighted = pressed
      XCTAssertEqual(bar.backgroundColor, expected)
      for style in [UIUserInterfaceStyle.dark, .light] {
        var alpha: CGFloat = 0
        try XCTUnwrap(bar.backgroundColor).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
          .getRed(nil, green: nil, blue: nil, alpha: &alpha)
        XCTAssertEqual(alpha, 1, "wciśnięty \(pressed), motyw \(style.rawValue): tło kryjące")
      }
    }
  }

  func testLatePermissionResultDoesNotSpeakAfterChangingSession() async throws {
    let fixture = try makeFixture()
    fixture.controller.decide(fixture.card, .allow)
    let started = await waitUntil { await fixture.hold.started }
    XCTAssertTrue(started, "żądanie jest w drodze")
    fixture.controller.viewWillDisappear(false)
    fixture.store.dispatch(.viewSession("s2"))
    await fixture.hold.release()
    let handled = await acceptedAndSettled(fixture)
    XCTAssertTrue(handled, "kontroler odebrał opóźniony wynik")
    XCTAssertTrue(fixture.results.isEmpty, "wynik starej sesji nie jest ogłoszeniem na nowym ekranie")
  }

  func testCurrentPermissionResultSpeaksOnce() async throws {
    let fixture = try makeFixture()
    fixture.controller.decide(fixture.card, .allow)
    let started = await waitUntil { await fixture.hold.started }
    XCTAssertTrue(started)
    await fixture.hold.release()
    let handled = await acceptedAndSettled(fixture)
    XCTAssertTrue(handled)
    XCTAssertNotNil(fixture.controller.view.window)
    XCTAssertEqual(fixture.results.map(\.text), [UICopy.allowedSpoken])
  }

  /// Test rdzenia, nie ogłoszeń: 401 wylogowuje, a wynik `.loggedOut` nie ma zdania (`UICopy.decisionResult`
  /// daje `nil`), więc cisza zachodzi i bez strażnika `canAnnounce` — tego pilnuje test niżej.
  func testUnauthorizedPermissionLogsOutWithoutSentence() async throws {
    let fixture = try makeFixture(failure: .unauthorized(APIFailure(status: 401)))
    fixture.controller.decide(fixture.card, .allow)
    let started = await waitUntil { await fixture.hold.started }
    XCTAssertTrue(started)
    await fixture.hold.release()
    let loggedOut = await waitUntil { fixture.store.state.auth == .loggedOut(.deviceUnknown) }
    XCTAssertTrue(loggedOut, "rzeczywisty wynik 401 wylogował RarogStore")
    for _ in 0..<20 { await Task.yield() }
    XCTAssertTrue(fixture.results.isEmpty)
  }

  /// Strażnik `auth == .loggedIn` w `canAnnounce`: wynik MA zdanie, ekran jest w oknie, zakres ogłoszeń
  /// i oglądana sesja się zgadzają — barierą jest wyłącznie wylogowanie. Wynik żądania sieciowego tej
  /// drogi nie sprawdzi: `cardRequest` po wylogowaniu oddaje `nil` (`.loggedOut`, bez zdania), więc
  /// zdanie z wynikiem po wylogowaniu niesie tylko synchroniczna odmowa karty planu bez opcji auto.
  func testNothingSpeaksAfterLogoutEvenWhenTheResultHasASentence() throws {
    let fixture = try makeFixture(subject: "plan")
    fixture.store.dispatch(.loggedOut(.deviceUnknown))
    XCTAssertEqual(fixture.store.state.viewedSessionId, "s1", "wylogowanie nie zmienia oglądanej sesji")
    XCTAssertNotNil(fixture.controller.view.window)
    fixture.controller.decide(fixture.card, .allow)
    XCTAssertNotNil(fixture.controller.ui.errors["p1"], "odmowa ma zdanie do powiedzenia")
    XCTAssertTrue(fixture.results.isEmpty, "po wylogowaniu ekran sesji nic nie mówi")
  }

  func testLeavingAndReturningDoesNotReviveOldResultAnnouncement() async throws {
    let fixture = try makeFixture()
    fixture.controller.decide(fixture.card, .allow)
    let started = await waitUntil { await fixture.hold.started }
    XCTAssertTrue(started)
    fixture.controller.viewWillDisappear(false)
    fixture.controller.viewDidAppear(false)
    await fixture.hold.release()
    let handled = await acceptedAndSettled(fixture)
    XCTAssertTrue(handled)
    XCTAssertTrue(fixture.results.isEmpty, "ponowna prezentacja nie odzyskuje zdania starego żądania")
  }

  func testPlanApprovalUsesAutoOptionFromSemanticCard() async throws {
    let fixture = try makeFixture(subject: "plan", alwaysLabel: "Yes, and use auto mode")
    fixture.controller.decide(fixture.card, .allow)
    let started = await waitUntil { await fixture.hold.started }
    XCTAssertTrue(started)
    let choices = await fixture.hold.choices
    XCTAssertEqual(choices, [.allowAlways])
    await fixture.hold.release()
    let handled = await acceptedAndSettled(fixture)
    XCTAssertTrue(handled)
  }

  func testPlanWithoutServerAutoOptionDoesNotSendApproval() async throws {
    let fixture = try makeFixture(subject: "plan")
    fixture.controller.decide(fixture.card, .allow)
    // Daj zadaniu starej implementacji dojść do transportu; nowa ścieżka odmawia synchronicznie.
    for _ in 0..<20 { await Task.yield() }
    let choices = await fixture.hold.choices
    await fixture.hold.release()
    XCTAssertTrue(choices.isEmpty, "bez opcji auto nie wybieramy milcząco ręcznego zatwierdzania")
    XCTAssertNotNil(fixture.controller.ui.errors["p1"])
  }

  func testOrdinaryApprovalStaysSingleUseEvenWhenServerOffersEscalation() async throws {
    let fixture = try makeFixture(subject: "tool", alwaysLabel: "Yes, always")
    fixture.controller.decide(fixture.card, .allow)
    let started = await waitUntil { await fixture.hold.started }
    XCTAssertTrue(started)
    let choices = await fixture.hold.choices
    XCTAssertEqual(choices, [.allow])
    await fixture.hold.release()
    let handled = await acceptedAndSettled(fixture)
    XCTAssertTrue(handled)
  }

  private struct Fixture {
    let controller: SessionViewController
    let store: RarogStore
    /// The decision request held in the transport (`decidePermission`).
    let hold: DecisionHold
    let card: PermissionCardModel
    let speech: SpeechRecorder
    // Okno utrzymuje prawdziwą prezentację; pozytywny test nie może przejść przez stale false guard.
    let window: UIWindow

    /// Zdania wyników akcji: bez zdania o karcie zastanej w doku przy wejściu (ogłoszona raz — pilnuje tego
    /// `DecisionDockTests`). Te testy sprawdzają wyłącznie, czy i gdzie mówi wynik decyzji.
    @MainActor var results: [Announcer.Announcement] {
      let entry = UICopy.newDecisionSpoken(card.spokenHeader)
      XCTAssertLessThanOrEqual(speech.said.filter { $0.text == entry }.count, 1, "karta zastana ogłoszona najwyżej raz")
      return speech.said.filter { $0.text != entry }
    }
  }

  private func makeFixture(
    subject: String = "tool", alwaysLabel: String? = nil, failure: TransportError? = nil
  ) throws -> Fixture {
    // A real RarogStore with the HTTP request held; the other calls do not go to the network.
    let hold = DecisionHold()
    let transport = UIKitTransport(onDecidePermission: { body throws(TransportError) in
      await hold.pause(body.decision)
      if let failure { throw failure }
    })
    let store = RarogStore(
      transport: transport, rules: MutationRules(),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    try frame(store, #"{"type":"hello","protocolVersion":3,"serverStartId":"test"}"#, source: .global)
    let session = #"""
      {"id":"s1","cwd":"/Users/demo/project","title":"project","state":"waiting-permission",
       "stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T10:00:00.000Z",
       "lastActivityAt":"2026-10-06T10:00:00.000Z"}
      """#
    try frame(store, #"{"type":"sessions-snapshot","sessions":[\#(session)]}"#, source: .global)
    store.dispatch(.viewSession("s1"))
    store.dispatch(.streamOpened(.session(id: "s1"), resumedWithCursor: false))
    let label = try alwaysLabel.map {
      #","alwaysLabel":\#(String(decoding: try JSONEncoder().encode($0), as: UTF8.self))"#
    } ?? ""
    let permission = #"""
      {"permId":"p1","sessionId":"s1","subject":"\#(subject)","toolName":"Shell",
       "displayText":"npm test","risk":"normal","cwd":"/Users/demo/project",
       "createdAt":"2026-10-06T10:00:00.000Z"\#(label)}
      """#
    try frame(store, #"""
      {"type":"transcript-snapshot","sessionId":"s1","messages":[],
       "pendingPermissions":[\#(permission)],"pendingQuestions":[]}
      """#, source: .session("s1"))
    let speech = SpeechRecorder()
    let controller = SessionViewController(
      store: store, sessionId: "s1", drafts: ComposerDrafts(), announcer: speech.announcer)
    controller.loadViewIfNeeded()
    let window = UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: 1024, height: 768)
    window.rootViewController = controller
    window.isHidden = false
    let card = try XCTUnwrap(TranscriptRows.build(state: store.state, sessionId: "s1").compactMap {
      if case let .permission(card) = $0 { card } else { nil }
    }.first)
    return Fixture(controller: controller, store: store, hold: hold, card: card, speech: speech, window: window)
  }

  private func frame(_ store: RarogStore, _ json: String, source: FrameSource) throws {
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    store.dispatch(.frame(event, source: source, cursor: nil))
  }

  /// Serwer przyjął decyzję (200): wpis decyzji w store niesie `accepted` (stan ekranu go nie trzyma). Kontroler
  /// odbiera wynik w swoim zadaniu tuż po store, więc po przyjęciu dajemy mu dojść do ogłoszenia.
  private func acceptedAndSettled(_ fixture: Fixture) async -> Bool {
    let accepted = await waitUntil { fixture.store.state.transcripts["s1"]?.decisions["p1"]?.accepted == true }
    for _ in 0..<20 { await Task.yield() }
    return accepted
  }

  private func waitUntil(_ condition: @MainActor () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(3)
    while !(await condition()) {
      if ContinuousClock.now > deadline { return false }
      try? await Task.sleep(for: .milliseconds(5))
    }
    return true
  }
}

@MainActor
private final class SpeechRecorder {
  var said: [Announcer.Announcement] = []
  lazy var announcer = Announcer(sink: { [unowned self] in self.said.append($0) }, now: Date.init)
}

private actor DecisionHold {
  var started = false
  var choices: [PermissionDecision] = []
  private var continuation: CheckedContinuation<Void, Never>?

  func pause(_ decision: PermissionDecision) async {
    choices.append(decision)
    await withCheckedContinuation { continuation in
      self.continuation = continuation
      started = true
    }
  }

  func release() {
    continuation?.resume()
    continuation = nil
  }
}
