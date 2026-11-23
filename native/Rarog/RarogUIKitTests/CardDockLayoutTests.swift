import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Układ zwarty karty decyzji pod sufitem doku (`decisionDockCeiling`, dok decyzji
/// w miejscu pola): wysoka karta nie zjada ekranu iPhone'a,
/// nagłówek i przyciski stoją w ramce karty, a treść między nimi przewija się wewnątrz. Karta niższa od sufitu ma
/// swoją naturalną wysokość. Render prawdziwych `PermissionCardView` i `HerdrDialogCardView` w ciemnym motywie na
/// szerokości iPhone'a (393 pt) z marginesem komórki (16 pt); przyciski czytane z pikseli w kolorach tokenów. Przy
/// `RAROG_CARD_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_CARD_SNAPSHOT_DIR` przy `xcodebuild`) zapisuje PNG. Właściciel: karty.
@MainActor
final class CardDockLayoutTests: XCTestCase {
  static let width: CGFloat = 393
  static let margin: CGFloat = 16

  /// Plan kanału zgód z 20 liniami pod sufitem 300 pt: karta nie wyższa niż sufit, eyebrow nad przyciskami,
  /// „Zatwierdź plan” (zieleń pracy) i „Odrzuć” (obrys czerwieni) w ramce.
  func testPlanOfTwentyLinesStaysUnderCeiling() async throws {
    let card = Self.permission(plan: true, command: Self.planText(lines: 20))
    let free = try await Self.render(Self.permissionView(card), ceiling: nil, name: nil)
    XCTAssertGreaterThan(free.size.height, 300, "bez sufitu plan 20 linii jest wyższy niż 300 pt (test ma sens)")
    let bitmap = try await Self.render(Self.permissionView(card), ceiling: 300, name: "karta-dok-plan-20-linii-ciemny")
    XCTAssertLessThanOrEqual(bitmap.size.height, 300.5, "karta pod sufitem")
    try Self.assertHeaderAndPair(bitmap, name: "plan")
  }

  /// Karta kanału z długimi polami (opis 600 znaków, 6 pól) i ostrzeżeniem o sandboksie przy piśmie
  /// `accessibilityExtraLarge`, sufit 320 pt. Nagłówek ze stopką przerastają tu sufit, więc treść trzyma swoje minimum
  /// (`DecisionDock.compactHeights`), a stopka przewija się w swoim przydziale: nagłówek i „Zatwierdź” w ramce,
  /// „Odrzuć” odsłania przewinięcie stopki. Treść (ostrzeżenie, pola) ma swoje okno w ramce, nie 0 pt.
  func testConsentCardWithLongFieldsStaysUnderCeiling() async throws {
    var card = Self.permission(plan: false, command: "npm test")
    let description = ConsentInputField(
      name: "description", value: String(repeating: "Opis zmiany w kodzie. ", count: 28))
    card.consentFields = [description] + (1...5).map {
      ConsentInputField(name: "pole\($0)", value: "wartość pola \($0) " + String(repeating: "x", count: 80))
    }
    XCTAssertGreaterThanOrEqual(card.consentFields[0].value.count, 600)
    card.sandboxWarning = UICopy.consentSandboxDisabled
    let view = Self.permissionView(card).environment(\.dynamicTypeSize, .accessibility3)
    let bitmap = try await Self.render(view, ceiling: 320, large: true, name: "karta-dok-kanalu-ciemny")
    XCTAssertLessThanOrEqual(bitmap.size.height, 320.5, "karta pod sufitem")
    let header = try XCTUnwrap(bitmap.box(of: PaletteTokens.wait.dark), "eyebrow w ramce")
    let allow = try XCTUnwrap(bitmap.box(of: PaletteTokens.run.dark), "„Zatwierdź” w ramce")
    XCTAssertLessThan(header.minY, 40, "eyebrow u góry karty")
    XCTAssertLessThan(header.maxY, allow.minY, "eyebrow nad przyciskami")
    // Ostrzeżenie o sandboksie (czerwień) stoi w oknie treści między nagłówkiem a „Zatwierdź”.
    let middle = CGRect(x: 0, y: header.maxY, width: bitmap.size.width, height: allow.minY - header.maxY)
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.err.dark, in: middle), "treść karty w ramce, nie 0 pt")

    var footer = CGRect.null
    let scrolled = try await Self.render(view, ceiling: 320, large: true, name: "karta-dok-kanalu-stopka-ciemny") {
      footer = Self.scrollLastToEnd($0)
    }
    XCTAssertFalse(footer.isNull, "stopka przewijana")
    let deny = try XCTUnwrap(scrolled.box(of: PaletteTokens.err.dark, in: footer), "„Odrzuć” po przewinięciu stopki")
    XCTAssertLessThan(deny.maxY, scrolled.size.height - 8, "„Odrzuć” nad dolnym marginesem")
  }

  /// Karta „dialog w terminalu” z długim zrzutem ekranu, sufit 260 pt: odmowa i zatwierdzenie w ramce.
  func testDialogCardWithLongScreenKeepsButtons() async throws {
    // Tożsamość i sygnatura z karty `ScreenBlockAnchorTests`; treść i przyciski rozpoznanego dialogu zaufania.
    let base = ScreenBlockAnchorTests.card(reason: .noJsonl, cliDialog: .dialog, screen: "")
    let copy = UICopy.herdrDialog(.trust, reason: nil)
    let card = HerdrDialogCardModel(
      sessionId: base.sessionId, identity: base.identity, signature: base.signature,
      eyebrow: copy.eyebrow, text: copy.text, screen: ScreenBlockAnchorTests.pausedScreen, since: nil,
      allowLabel: copy.allowLabel, allowArmed: false, denyLabel: copy.denyLabel, channelDead: false,
      phase: .idle, status: nil, statusIsError: false, lockedReason: nil)
    let view = HerdrDialogCardView(card: card, decide: { _ in })
    let free = try await Self.render(view, ceiling: nil, name: nil)
    XCTAssertGreaterThan(free.size.height, 260, "bez sufitu karta jest wyższa niż 260 pt (test ma sens)")
    let bitmap = try await Self.render(view, ceiling: 260, name: "karta-dok-dialog-ciemny")
    XCTAssertLessThanOrEqual(bitmap.size.height, 260.5, "karta pod sufitem")
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.wait.dark), "eyebrow w ramce")
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.err.dark), "odmowa w ramce")
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.run.dark), "zatwierdzenie w ramce")
  }

  /// Krótka karta (`npm test`) pod sufitem 400 pt ma tę samą wysokość co bez sufitu: bez rozciągania.
  func testShortCardKeepsNaturalHeight() async throws {
    let card = Self.permission(plan: false, command: "npm test", hookChannel: false)
    let free = try await Self.render(Self.permissionView(card), ceiling: nil, name: nil)
    let docked = try await Self.render(Self.permissionView(card), ceiling: 400, name: nil)
    XCTAssertEqual(docked.size.height, free.size.height, accuracy: 0.5, "wysokość naturalna pod wysokim sufitem")
    XCTAssertLessThan(free.size.height, 400)
  }

  /// Ostatnia linia obrony: karta zgody z długą etykietą „zawsze” i długim zdaniem błędu przy piśmie
  /// `accessibilityExtraLarge` pod niskim sufitem 200 pt. Przypięte części razem wyższe od sufitu dzielą go: karta
  /// nie wychodzi ponad sufit, „Zatwierdź” zostaje w ramce.
  func testLongAlwaysLabelAndErrorStayUnderLowCeiling() async throws {
    let always = "Yes, and don't ask again for: " + (1...8).map { "npm run test:unit -- --shard=\($0)/8" }
      .joined(separator: ", ")
    let card = PermissionCardModel(
      permId: "d1", sessionId: "s1",
      eyebrow: UICopy.permissionEyebrow(toolName: "Write", risky: false, plan: false),
      toolName: "Write", risky: false, plan: false, cwd: "~/Projects/ACME/rarog",
      command: "npm test", commandSyntax: [], createdAt: nil, canAllow: true, screen: nil, cliDialog: nil,
      phase: .idle, error: String(repeating: "Serwer nie przyjął decyzji, spróbuj jeszcze raz. ", count: 8),
      lockedReason: nil, alwaysLabel: always, note: nil)
    let view = Self.permissionView(card).environment(\.dynamicTypeSize, .accessibility3)
    let free = try await Self.render(view, ceiling: nil, large: true, name: nil)
    XCTAssertGreaterThan(free.size.height, 400, "bez sufitu karta wysoka — inaczej test nic nie mówi")
    let bitmap = try await Self.render(view, ceiling: 200, large: true, name: "karta-dok-zawsze-blad-niski-sufit")
    XCTAssertLessThanOrEqual(bitmap.size.height, 200.5, "karta pod niskim sufitem")
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.run.dark), "„Zatwierdź” w ramce")
  }

  // MARK: - Pomocnicze

  /// Eyebrow (bursztyn oczekiwania) u góry, „Zatwierdź” na zieleni pracy pod nim, czerwień odmowy na wysokości
  /// zgody albo niżej (ostrzeżenie o sandboksie, też czerwone, stoi nad parą), wszystko nad dolnym marginesem karty.
  static func assertHeaderAndPair(_ bitmap: PendingMediaRowTests.Bitmap, name: String) throws {
    let size = bitmap.size
    let header = try XCTUnwrap(bitmap.box(of: PaletteTokens.wait.dark), "\(name): eyebrow w ramce")
    let allow = try XCTUnwrap(bitmap.box(of: PaletteTokens.run.dark), "\(name): „Zatwierdź” w ramce")
    XCTAssertLessThan(header.maxY, allow.minY, "\(name): eyebrow nad przyciskami")
    XCTAssertLessThan(header.minY, 40, "\(name): eyebrow u góry karty")
    XCTAssertLessThan(allow.maxY, size.height - 8, "\(name): „Zatwierdź” nad dolnym marginesem")
    let pairRow = CGRect(x: 0, y: allow.minY, width: size.width, height: size.height - allow.minY)
    let deny = try XCTUnwrap(bitmap.box(of: PaletteTokens.err.dark, in: pairRow), "\(name): „Odrzuć” w ramce")
    XCTAssertLessThan(deny.maxY, size.height - 8, "\(name): „Odrzuć” nad dolnym marginesem")
  }

  static func permissionView(_ card: PermissionCardModel) -> PermissionCardView {
    PermissionCardView(card: card, decide: { _ in })
  }

  static func planText(lines: Int) -> String {
    (1...lines).map { "\($0). Krok planu \($0): dopisać test, poprawić widok i sprawdzić zrzut." }
      .joined(separator: "\n")
  }

  /// Karta kanału zgód czekająca na decyzję (albo ekranowa, `hookChannel: false`), bez zegara (render bez upływu
  /// czasu). Nazwa narzędzia spoza listy strażnika źródeł (`SourceGuardTests`).
  static func permission(plan: Bool, command: String, hookChannel: Bool = true) -> PermissionCardModel {
    var model = PermissionCardModel(
      permId: "d1", sessionId: "s1",
      eyebrow: UICopy.permissionEyebrow(toolName: "Write", risky: false, plan: plan),
      toolName: "Write", risky: false, plan: plan, cwd: "~/Projects/ACME/rarog",
      command: command, commandSyntax: [], createdAt: nil, canAllow: true, screen: nil, cliDialog: nil,
      phase: .idle, error: nil, lockedReason: nil, alwaysLabel: nil, note: nil)
    model.hookChannel = hookChannel
    model.awaitingDecision = hookChannel
    return model
  }

  /// Karta w oknie sceny apki o szerokości iPhone'a, bez safe area, w ciemnym motywie — jak
  /// `PermissionCardTileTests.render`, z sufitem doku w środowisku i opcjonalnie pismem `accessibilityExtraLarge`.
  /// Przewija najniżej stojący przewijany widok (stopkę karty) do końca; zwraca jego ramkę w oknie.
  static func scrollLastToEnd(_ root: UIView) -> CGRect {
    guard let scroll = QuestionDockLayoutTests.views(of: UIScrollView.self, in: root)
      .filter({ $0.bounds.height > 1 })
      .max(by: { $0.convert($0.bounds, to: nil).minY < $1.convert($1.bounds, to: nil).minY })
    else { return .null }
    let end = scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height
    scroll.setContentOffset(CGPoint(x: 0, y: max(-scroll.adjustedContentInset.top, end)), animated: false)
    return scroll.convert(scroll.bounds, to: nil)
  }

  static func render(
    _ view: some View, ceiling: CGFloat?, large: Bool = false, name: String?,
    prepare: ((UIView) -> Void)? = nil
  ) async throws -> PendingMediaRowTests.Bitmap {
    let host = UIHostingController(
      rootView: AnyView(view.environment(\.decisionDockCeiling, ceiling).padding(.horizontal, margin)))
    host.safeAreaRegions = []
    host.view.backgroundColor = Palette.background
    host.overrideUserInterfaceStyle = .dark
    if large { host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraLarge }
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: width, height: 2000)
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    // Bloki treści dostają wysokość w drugim przebiegu (`onGeometryChange`); wysokość karty mierzy się po nim.
    try await Task.sleep(for: .milliseconds(150))
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(100))
    let fitted = host.sizeThatFits(in: CGSize(width: width, height: 2000))
    window.frame = CGRect(x: 0, y: 0, width: width, height: ceil(fitted.height))
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(100))
    host.view.layoutIfNeeded()
    if let prepare {
      prepare(host.view)
      host.view.layoutIfNeeded()
      try await Task.sleep(for: .milliseconds(50))
      host.view.layoutIfNeeded()
    }
    let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
    var image = renderer.image { context in host.view.layer.render(in: context.cgContext) }
    if let drawn = PendingMediaRowTests.Bitmap(image), drawn.alpha(atX: 1, y: 1) == 0 {
      image = renderer.image { _ in _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
    }
    if let name, let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty {
      try XCTUnwrap(image.pngData()).write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
    return try XCTUnwrap(PendingMediaRowTests.Bitmap(image), "bitmapa")
  }
}
