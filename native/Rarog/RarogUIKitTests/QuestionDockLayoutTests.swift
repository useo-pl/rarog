import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Układ zwarty karty pytania pod sufitem doku (dok decyzji
/// w miejscu pola: wysoka karta nie zjada ekranu iPhone'a). Przy `decisionDockCeiling` cała karta mieści się
/// w suficie, nagłówek i stopka z „Odpowiedz” stoją w ramce, a sekcje pytań przewijają się wewnątrz karty. Karta niższa
/// od sufitu ma naturalną wysokość; `nil` = karta jak w transkrypcie. Render prawdziwego `QuestionCardView` w ciemnym
/// motywie, szerokość iPhone'a 17 z marginesem komórki transkryptu. Przy `RAROG_CARD_SNAPSHOT_DIR`
/// (`TEST_RUNNER_RAROG_CARD_SNAPSHOT_DIR` przy `xcodebuild`) zapisuje PNG. Właściciel: karty pytań.
@MainActor
final class QuestionDockLayoutTests: XCTestCase {
  static let width: CGFloat = 402
  static let margin: CGFloat = 16
  /// Odstęp nad i pod kartą (`.padding(.vertical, 8)` widoku karty).
  static let outer: CGFloat = 8

  /// Formularz: trzy pytania po cztery opcje z opisami i pole „Własna odpowiedź”.
  static let form = #"""
    {"qId":"dock-form","sessionId":"s1","createdAt":"2026-11-10T09:00:00.000Z","customAnswer":true,
     "questions":[
      {"question":"Gdzie trzymamy ramki testowe?","header":"Fixtures","multiSelect":false,"options":[
        {"label":"shared/fixtures/sse","description":"Wspólne dla serwera i apki."},
        {"label":"server/test/fixtures","description":"Tylko serwer."},
        {"label":"native/Rarog/Fixtures","description":"Tylko apka."},
        {"label":"Osobne repo","description":"Pakiet z ramkami."}]},
      {"question":"Które klienty mają je czytać?","header":"Klienci","multiSelect":true,"options":[
        {"label":"PWA","description":"Przeglądarka."},
        {"label":"Swift","description":"Apka natywna."},
        {"label":"CLI","description":"Komenda rarog."},
        {"label":"Przekaźnik","description":"Worker w chmurze."}]},
      {"question":"Kiedy odświeżamy ramki?","header":"Rytm","multiSelect":false,"options":[
        {"label":"Przy każdej zmianie","description":"Strażnik w bramce."},
        {"label":"Raz w tygodniu","description":"Ręcznie."},
        {"label":"Przed wydaniem","description":"Lista kontrolna."},
        {"label":"Nigdy","description":"Ramki zamrożone."}]}]}
    """#

  /// Jedno krótkie pytanie z dwiema opcjami (karta `instant`, bez stopki).
  static let short = #"""
    {"qId":"dock-short","sessionId":"s1","createdAt":"2026-11-10T09:00:00.000Z",
     "questions":[{"question":"Puszczamy testy?","header":"Testy","multiSelect":false,"options":[
       {"label":"Tak"},{"label":"Nie"}]}]}
    """#

  static func card(_ json: String) throws -> QuestionCardModel {
    QuestionCardModel.make(try JSONDecoder().decode(QuestionRequest.self, from: Data(json.utf8)))
  }

  // MARK: - Sufit

  /// Formularz trzech pytań pod sufitem 360 pt: karta ≤ 360 pt, nagłówek u góry i „Odpowiedz” u dołu w ramce.
  func testFormFitsUnderCeilingWithHeaderAndSubmitInFrame() async throws {
    let card = try Self.card(Self.form)
    let natural = try await Self.render(card, ceiling: nil, name: nil)
    XCTAssertGreaterThan(natural.height, 500, "bez sufitu formularz jest wyższy od sufitu — inaczej test nic nie mówi")
    let docked = try await Self.render(card, ceiling: 360, name: "karta-pytania-dok-formularz-ciemny")
    try Self.assertFramed(docked, ceiling: 360, name: "pismo domyślne")
  }

  /// To samo przy piśmie dostępności: sufit trzyma, nagłówek i „Odpowiedz” zostają w ramce.
  func testFormFitsUnderCeilingAtAccessibilityExtraLarge() async throws {
    let card = try Self.card(Self.form)
    let docked = try await Self.render(
      card, ceiling: 360, typeSize: .accessibility3, name: "karta-pytania-dok-formularz-ax-ciemny")
    try Self.assertFramed(docked, ceiling: 360, name: "accessibilityExtraLarge")
  }

  /// Krótka karta pod sufitem 400 pt ma naturalną wysokość: tę samą co bez sufitu.
  func testShortCardKeepsNaturalHeightUnderCeiling() async throws {
    let card = try Self.card(Self.short)
    let natural = try await Self.render(card, ceiling: nil, name: nil)
    let docked = try await Self.render(card, ceiling: 400, name: nil)
    XCTAssertLessThan(natural.height, 400, "karta krótsza od sufitu")
    XCTAssertEqual(docked.height, natural.height, accuracy: 0.5, "naturalna wysokość pod sufitem")
  }

  // MARK: - Długie zdanie stanu (przypięte części nie wychodzą ponad sufit)

  /// Formularz z „Własną odpowiedzią” ze 100 krótkimi liniami: wybór → wysyłka → potwierdzenie pod sufitem 360 pt.
  /// Zdanie stanu („Wysłano „…” → czekam na ekran”) niesie całą odpowiedź; w doku ma najwyżej trzy linie, a karta
  /// w żadnej fazie nie jest wyższa niż sufit. Bez sufitu (transkrypt) zdanie jest całe — karta rośnie.
  func testLongCustomAnswerStaysUnderCeilingInEveryPhase() async throws {
    let base = try Self.card(Self.form)
    let answer = (1...100).map { "linia \($0)" }.joined(separator: "\n")
    let answered = QuestionAnswered(answers: [[answer], ["Swift"], ["Nigdy"]])
    let phases: [(String, QuestionCardModel)] = [
      ("wybór", base),
      ("wysyłka", base.with(phase: .sending(answered), held: false)),
      ("potwierdzenie", base.with(phase: .sent(answered), held: true)),
    ]
    let free = try await Self.render(phases[2].1, ceiling: nil, name: nil)
    XCTAssertGreaterThan(free.height, 1000, "w transkrypcie zdanie stanu całe — inaczej test nic nie mówi")
    for (name, card) in phases {
      let docked = try await Self.render(card, ceiling: 360, name: "karta-pytania-dok-\(name)-dluga-odpowiedz")
      Self.attach("\(name): \(docked.height) pt")
      XCTAssertLessThanOrEqual(docked.height, 360.5, "\(name): karta pod sufitem")
      XCTAssertGreaterThan(docked.height, 200, "\(name): karta nie zapadła się")
      let top = CGRect(x: Self.margin, y: Self.outer, width: Self.width - 2 * Self.margin, height: 24)
      XCTAssertNotNil(docked.bitmap.box(of: PaletteTokens.wait.dark, in: top), "\(name): nagłówek u góry karty")
    }
  }

  /// Ostatnia linia obrony: pismo dostępności, niski sufit (120 pt, telefon w poziomie z klawiaturą) i zdanie błędu pod
  /// kartą — przypięte części razem wyższe od sufitu dzielą go, karta nie wychodzi ponad sufit.
  func testPinnedPartsNeverExceedLowCeiling() async throws {
    let card = QuestionCardModel.make(
      try JSONDecoder().decode(QuestionRequest.self, from: Data(Self.form.utf8)),
      phase: .choose, error: String(repeating: "Serwer odrzucił odpowiedź. ", count: 12), locked: nil)
    let docked = try await Self.render(card, ceiling: 120, typeSize: .accessibility3, name: "karta-pytania-dok-niski-sufit")
    XCTAssertLessThanOrEqual(docked.height, 120.5, "karta pod niskim sufitem")
  }

  /// Pismo dostępności i sufit 120 pt (telefon w poziomie z klawiaturą), formularz z otwartą „Własną odpowiedzią”
  /// i długim zdaniem błędu: KAŻDA część karty jest osiągalna. Nagłówek, środek i zamknięcie to trzy przewijane widoki
  /// w ramce karty; przewinięcie każdego od góry do końca odsłania w ramce nagłówek (bursztyn), pierwszą opcję
  /// (zaznaczona: pas tła zaznaczenia), pole „Własna odpowiedź” (widok tekstu z hierarchii), wypełniony przycisk
  /// „Odpowiedz” i zdanie błędu (czerwień). Karta dalej nie jest wyższa niż sufit. Piksele z renderu warstw.
  func testEveryPartReachableAtLowCeilingAndAccessibilityText() async throws {
    let card = QuestionCardModel.make(
      try JSONDecoder().decode(QuestionRequest.self, from: Data(Self.form.utf8)),
      phase: .choose, error: String(repeating: "Serwer odrzucił odpowiedź. ", count: 12), locked: nil)
    let drafts = QuestionDraftBook()
    drafts.update(card.qId, sections: card.sections.count) {
      $0.toggle("shared/fixtures/sse", in: 0, multiSelect: false)
      $0.openCustom(in: 2)
    }
    let actions = QuestionCardActions(
      pick: { _, _, _ in }, openCustom: { _, _ in }, setCustom: { _, _, _ in }, setNote: { _, _, _ in },
      send: { _, _, _ in }, missing: { _, _ in })
    let host = UIHostingController(
      rootView: QuestionCardView(card: card, drafts: drafts, actions: actions)
        .environment(\.decisionDockCeiling, 120)
        .environment(\.dynamicTypeSize, .accessibility3)
        .padding(.horizontal, Self.margin))
    host.safeAreaRegions = []
    host.view.backgroundColor = Palette.background
    host.overrideUserInterfaceStyle = .dark
    let window = Self.window(height: 2000)
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.frame = window.bounds
    try await Self.settle(host)
    let fitted = host.sizeThatFits(in: CGSize(width: Self.width, height: 2000))
    XCTAssertLessThanOrEqual(fitted.height, 120.5, "karta pod sufitem 120 pt")
    window.frame = CGRect(x: 0, y: 0, width: Self.width, height: ceil(fitted.height))
    host.view.frame = window.bounds
    try await Self.settle(host)
    let frame = CGRect(
      x: Self.margin, y: Self.outer, width: Self.width - 2 * Self.margin, height: fitted.height - 2 * Self.outer)
    if let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty {
      let png = try XCTUnwrap(Self.image(host).pngData())
      try png.write(to: URL(filePath: dir).appending(path: "karta-pytania-dok-sufit-120-ax3.png"))
    }

    let scrolls = Self.views(of: UIScrollView.self, in: host.view).filter { scroll in
      let box = scroll.convert(scroll.bounds, to: nil)
      return box.height > 1 && frame.insetBy(dx: -0.5, dy: -0.5).contains(box)
    }
    XCTAssertGreaterThanOrEqual(
      scrolls.count, 3, "nagłówek, środek i zamknięcie przewijane w ramce karty: \(scrolls.map(\.frame))")
    let seen = try await Self.reachable(in: host, scrolls: scrolls, card: frame)
    Self.attach("osiągalne: \(seen.keys.sorted()) \(seen)")
    let parts: Set = ["nagłówek", "opcja 1", "Własna odpowiedź", "Odpowiedz", "zdanie błędu"]
    XCTAssertTrue(parts.isSubset(of: Set(seen.keys)), "nieosiągalne: \(parts.subtracting(seen.keys).sorted())")
  }

  // MARK: - Własna odpowiedź

  /// Fokus w „Własnej odpowiedzi” ostatniego pytania i wpisany tekst przetrwają dwa kolejne rendery z tym samym
  /// modelem; pole z fokusem stoi w widocznej części przewijanego środka (karta przewija się do niego).
  func testCustomAnswerKeepsFocusAndTextAcrossRendersAndStaysVisible() async throws {
    let card = try Self.card(Self.form)
    let drafts = QuestionDraftBook()
    drafts.update(card.qId, sections: card.sections.count) { $0.openCustom(in: 2) }
    let actions = QuestionCardActions(
      pick: { _, _, _ in }, openCustom: { _, _ in },
      setCustom: { card, section, text in
        drafts.update(card.qId, sections: card.sections.count) { $0.setCustom(text, in: section) }
      },
      setNote: { _, _, _ in }, send: { _, _, _ in }, missing: { _, _ in })
    func view() -> some View {
      QuestionCardView(card: card, drafts: drafts, actions: actions)
        .environment(\.decisionDockCeiling, 360)
        .padding(.horizontal, Self.margin)
    }
    let host = UIHostingController(rootView: view())
    host.safeAreaRegions = []
    host.overrideUserInterfaceStyle = .dark
    let window = Self.window(height: 360)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    host.view.frame = window.bounds
    try await Self.settle(host)

    let field = try XCTUnwrap(Self.views(of: UITextView.self, in: host.view).first, "pole „Własna odpowiedź”")
    XCTAssertTrue(field.becomeFirstResponder(), "fokus w polu")
    field.insertText("abc")
    try await Self.settle(host)
    XCTAssertEqual(drafts.draft(card.qId, sections: card.sections.count).customText(in: 2), "abc", "tekst w szkicu")

    for round in 1...2 {
      host.rootView = view()
      try await Self.settle(host)
      let current = try XCTUnwrap(Self.views(of: UITextView.self, in: host.view).first, "render \(round): pole")
      XCTAssertTrue(current.isFirstResponder, "render \(round): fokus zostaje w polu")
      XCTAssertEqual(current.text, "abc", "render \(round): tekst zostaje")
    }

    // Pole ostatniego pytania leży w treści ~600 pt niżej; karta przewinęła się tak, że stoi w ramce, nad stopką.
    let current = try XCTUnwrap(Self.views(of: UITextView.self, in: host.view).first)
    let frame = current.convert(current.bounds, to: host.view)
    XCTAssertGreaterThanOrEqual(frame.minY, Self.outer, "pole w ramce karty: \(frame)")
    XCTAssertLessThanOrEqual(frame.maxY, host.view.bounds.height - Self.outer - 44, "pole nad stopką: \(frame)")
  }

  // MARK: - Pomocnicze

  /// Karta w ramce sufitu: wysokość ≤ sufit, etykieta nagłówka (kolor `wait`) w górnym pasie karty, wypełniony
  /// przycisk „Odpowiedz” (kolor tekstu) przy dolnej krawędzi karty.
  static func assertFramed(_ rendered: Rendered, ceiling: CGFloat, name: String) throws {
    let bitmap = rendered.bitmap
    let size = bitmap.size
    XCTAssertLessThanOrEqual(rendered.height, ceiling + 0.5, "\(name): karta pod sufitem")
    XCTAssertGreaterThan(rendered.height, ceiling - 40, "\(name): formularz wypełnia sufit")
    let top = CGRect(x: margin, y: outer, width: size.width - 2 * margin, height: 24)
    XCTAssertNotNil(bitmap.box(of: PaletteTokens.wait.dark, in: top), "\(name): nagłówek u góry karty")
    let bottom = CGRect(x: margin, y: size.height - outer - 70, width: size.width - 2 * margin, height: 70)
    let submit = try XCTUnwrap(bitmap.box(of: PaletteTokens.text.dark, in: bottom, tolerance: 2), "\(name): „Odpowiedz”")
    XCTAssertGreaterThanOrEqual(submit.height, 30, "\(name): wypełniony przycisk, nie litery: \(submit)")
    XCTAssertLessThanOrEqual(submit.maxY, size.height - outer, "\(name): przycisk w ramce karty: \(submit)")
  }

  static func attach(_ text: String) {
    let attachment = XCTAttachment(string: text)
    attachment.lifetime = .keepAlways
    XCTContext.runActivity(named: text) { $0.add(attachment) }
  }

  static func window(height: CGFloat) -> UIWindow {
    // Apka-gospodarz testów bywa bez podłączonej sceny: wtedy okno bez sceny (`PermissionCardTileTests.render`).
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: width, height: height)
    window.overrideUserInterfaceStyle = .dark
    return window
  }

  static func settle(_ host: UIViewController) async throws {
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(150))
    host.view.layoutIfNeeded()
  }

  /// Karta o szerokości iPhone'a, wysokość z `sizeThatFits`, render warstwy (gdy pusty — hierarchii widoków).
  static func render(
    _ card: QuestionCardModel, ceiling: CGFloat?, typeSize: DynamicTypeSize = .large, name: String?
  ) async throws -> Rendered {
    let actions = QuestionCardActions(
      pick: { _, _, _ in }, openCustom: { _, _ in }, setCustom: { _, _, _ in }, setNote: { _, _, _ in },
      send: { _, _, _ in }, missing: { _, _ in })
    let host = UIHostingController(
      rootView: QuestionCardView(card: card, drafts: QuestionDraftBook(), actions: actions)
        .environment(\.decisionDockCeiling, ceiling)
        .environment(\.dynamicTypeSize, typeSize)
        .padding(.horizontal, margin))
    host.safeAreaRegions = []
    host.view.backgroundColor = Palette.background
    host.overrideUserInterfaceStyle = .dark
    let window = window(height: 2000)
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.frame = window.bounds
    try await settle(host)
    let fitted = host.sizeThatFits(in: CGSize(width: width, height: 2000))
    window.frame = CGRect(x: 0, y: 0, width: width, height: ceil(fitted.height))
    host.view.frame = window.bounds
    try await settle(host)
    let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
    var image = renderer.image { context in host.view.layer.render(in: context.cgContext) }
    if let drawn = PendingMediaRowTests.Bitmap(image), drawn.alpha(atX: 1, y: 1) == 0 {
      image = renderer.image { _ in _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
    }
    if let name, let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty {
      try XCTUnwrap(image.pngData()).write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
    return Rendered(bitmap: try XCTUnwrap(PendingMediaRowTests.Bitmap(image), "bitmapa"), height: fitted.height)
  }

  /// Render karty i jej wysokość z `sizeThatFits` (bitmapa ma wysokość zaokrągloną w górę).
  struct Rendered {
    let bitmap: PendingMediaRowTests.Bitmap
    let height: CGFloat
  }

  /// Render warstw hosta (gdy pusty — hierarchii widoków), jak `render`.
  static func image(_ host: UIViewController) -> UIImage {
    let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
    var image = renderer.image { context in host.view.layer.render(in: context.cgContext) }
    if let drawn = PendingMediaRowTests.Bitmap(image), drawn.alpha(atX: 1, y: 1) == 0 {
      image = renderer.image { _ in _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
    }
    return image
  }

  /// Części karty, które pokazuje w ramce `card` przewinięcie każdego z widoków `scrolls` od góry do końca (krok pół
  /// okna), z offsetem, przy którym się pokazały. Część to: „nagłówek” (bursztyn etykiety), „opcja 1” (pas tła
  /// zaznaczenia, `text` 10 % na `surface`, na całą szerokość wiersza), „Odpowiedz” (wypełniony prostokąt w kolorze
  /// `text`), „zdanie błędu” (czerwień) i „Własna odpowiedź” (widok tekstu pola w oknie przewijania). Wysokość
  /// części w oknie: cała albo całe okno, gdy okno jest niższe.
  static func reachable(
    in host: UIViewController, scrolls: [UIScrollView], card: CGRect
  ) async throws -> [String: String] {
    let band = blend(PaletteTokens.text.dark, over: PaletteTokens.surface.dark, alpha: 0.10)
    var seen: [String: String] = [:]
    for (index, scroll) in scrolls.enumerated() {
      let window = scroll.convert(scroll.bounds, to: nil).intersection(card)
      // Bez pionowych krawędzi ramki karty (kreska `border` ma prawie kolor pasa zaznaczenia).
      let area = window.insetBy(dx: 4, dy: 0)
      let tall = min(20, window.height - 2)
      let low = -scroll.adjustedContentInset.top
      let high = max(low, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
      var offset = low
      while true {
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: offset), animated: false)
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(30))
        host.view.layoutIfNeeded()
        let bitmap = try XCTUnwrap(PendingMediaRowTests.Bitmap(image(host)), "bitmapa")
        // Piksele bitmapy na punkt kwadratowy.
        let pixels = pow(Double(bitmap.width) / bitmap.size.width, 2)
        let place = "widok \(index) offset \(Int(offset))/\(Int(high))"
        func found(_ name: String) { if seen[name] == nil { seen[name] = place } }
        if bitmap.box(of: PaletteTokens.wait.dark, in: area) != nil { found("nagłówek") }
        if bitmap.box(of: PaletteTokens.err.dark, in: area) != nil { found("zdanie błędu") }
        if let box = bitmap.box(of: band, in: area, tolerance: 2), box.width > area.width * 0.8, box.height >= tall,
          Double(bitmap.count(of: band, in: box)) > 0.3 * box.width * box.height * pixels
        {
          found("opcja 1")
        }
        if let box = bitmap.box(of: PaletteTokens.text.dark, in: area, tolerance: 2), box.width >= 60,
          box.height >= tall,
          Double(bitmap.count(of: PaletteTokens.text.dark, in: box)) > 0.5 * box.width * box.height * pixels
        {
          found("Odpowiedz")
        }
        for field in views(of: UITextView.self, in: host.view) {
          let shown = field.convert(field.bounds, to: nil).intersection(window)
          if !shown.isNull, shown.height >= min(field.bounds.height, window.height) - 1 { found("Własna odpowiedź") }
        }
        guard offset < high else { break }
        offset = min(high, offset + max(4, window.height / 2))
      }
      scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: low), animated: false)
    }
    return seen
  }

  /// Kolor `top` z kryciem `alpha` na `bottom` (kanały sRGB, zaokrąglone).
  static func blend(_ top: UInt32, over bottom: UInt32, alpha: Double) -> UInt32 {
    [16, 8, 0].reduce(0) { result, shift in
      let mixed = alpha * Double((top >> shift) & 0xFF) + (1 - alpha) * Double((bottom >> shift) & 0xFF)
      return result | (UInt32(mixed.rounded()) << shift)
    }
  }

  static func views<T: UIView>(of type: T.Type, in view: UIView) -> [T] {
    view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + views(of: type, in: $0) }
  }
}
