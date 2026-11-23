import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Blok „Co widać w terminalu” startuje od DOŁU wycinka: serwer wysyła
/// OSTATNIE linie ekranu (`snippet` w `server/src/herdr/screen.ts`), a dialog z opcjami stoi na dole panelu. Blok od
/// góry pokazałby prompty nad dialogiem, a opcje pauzy „Session paused” zostałyby pod krawędzią bloku.
///
/// Render dwóch prawdziwych kart bez zatwierdzania (`HerdrDialogCardView`) na szerokości iPhone'a, 390 pt z marginesem
/// komórki transkryptu (16 pt), w ciemnym motywie: pauza spoza jsonl z klasą CLI `dialog` i zgoda `Bash` subagenta
/// z ramką uciętą u góry (`mismatch`). Ekrany to fixture'y serwera `server/test/fixtures/herdr/`
/// `dialog-session-paused-2.1.309.txt` i `dialog-bash-subagent-uciety-62x29-2.1.309.txt` (oba dłuższe niż sufit
/// 8 linii). Przy `RAROG_CARD_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_CARD_SNAPSHOT_DIR` przy `xcodebuild`) zapisuje PNG.
@MainActor
final class ScreenBlockAnchorTests: XCTestCase {
  static let margin: CGFloat = 16

  func testScreenBlockOpensAtTheEndOfTheSnippet() async throws {
    let paused = Self.card(reason: .noJsonl, cliDialog: .dialog, screen: Self.pausedScreen)
    let mismatch = Self.card(reason: .mismatch, cliDialog: .permission, screen: Self.cutBashScreen)
    XCTAssertEqual(paused.eyebrow, "dialog w terminalu · dialog CLI")
    XCTAssertEqual(mismatch.eyebrow, "dialog w terminalu · brak zgodności")

    let (host, window) = try await Self.render(
      VStack(spacing: 0) {
        HerdrDialogCardView(card: paused, decide: { _ in })
        HerdrDialogCardView(card: mismatch, decide: { _ in })
      }
      .padding(.horizontal, Self.margin),
      name: "karta-bez-przyciskow-wycinek-od-dolu-ciemny")
    defer { window.isHidden = true }

    // Bloki wycinka to jedyne przewijane widoki kart; oba ucina sufit 8 linii.
    let blocks = Self.scrollViews(in: host.view).filter { $0.contentSize.height > $0.bounds.height + 1 }
    XCTAssertEqual(blocks.count, 2, "oba bloki „Co widać w terminalu” ucięte sufitem")
    for (index, block) in blocks.enumerated() {
      let bottom = block.contentSize.height + block.adjustedContentInset.bottom - block.bounds.height
      XCTAssertGreaterThan(bottom, 1, "blok \(index): treść wyższa niż blok")
      XCTAssertEqual(block.contentOffset.y, bottom, accuracy: 1, "blok \(index): pierwsze pokazanie = koniec wycinka")
      XCTAssertEqual(
        block.contentOffset.x, -block.adjustedContentInset.left, accuracy: 1, "blok \(index): od lewej krawędzi")
    }
  }

  static func card(reason: RefuseReason, cliDialog: CliDialogClass, screen: String) -> HerdrDialogCardModel {
    let json = """
      {"id":"s1","cwd":"/Users/demo/Projects/willow","title":"willow","state":"waiting-permission",
       "stateSince":"2026-10-23T10:17:07.000Z","createdAt":"2026-10-23T09:00:00.000Z",
       "lastActivityAt":"2026-10-23T10:17:07.000Z","herdrDialogReason":"\(reason.rawValue)",
       "cliDialog":"\(cliDialog.rawValue)"}
      """
    let session = try! JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
    let copy = UICopy.herdrDialog(nil, reason: reason, cliDialog: cliDialog)
    // Bez zegara (`since: nil`): render bez upływu czasu.
    return HerdrDialogCardModel(
      sessionId: session.id, identity: HerdrDialogCards.identity(session), signature: HerdrDialogSignature(session),
      eyebrow: copy.eyebrow, text: copy.text, screen: screen, since: nil, allowLabel: nil, allowArmed: false,
      denyLabel: copy.denyLabel, channelDead: false, phase: .idle, status: nil,
      statusIsError: false, lockedReason: nil)
  }

  /// Karty w oknie sceny apki o szerokości iPhone'a, bez safe area, w ciemnym motywie — jak
  /// `PermissionCardTileTests.render`, ale okno zostaje (test czyta potem przewijanie bloków).
  static func render(_ view: some View, name: String) async throws -> (UIHostingController<AnyView>, UIWindow) {
    let width: CGFloat = 390
    let host = UIHostingController(rootView: AnyView(view))
    host.safeAreaRegions = []
    host.view.backgroundColor = Palette.background
    host.overrideUserInterfaceStyle = .dark
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: width, height: 2000)
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = host
    window.isHidden = false
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    // Blok dostaje wysokość w drugim przebiegu (`onGeometryChange`); do tego czasu przewijanie bierze całe okno.
    try await Task.sleep(for: .milliseconds(150))
    let fitted = host.sizeThatFits(in: CGSize(width: width, height: 2000))
    window.frame = CGRect(x: 0, y: 0, width: width, height: ceil(fitted.height))
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(150))
    host.view.layoutIfNeeded()
    if let dir = ProcessInfo.processInfo.environment["RAROG_CARD_SNAPSHOT_DIR"], !dir.isEmpty {
      let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
      var image = renderer.image { context in host.view.layer.render(in: context.cgContext) }
      if let drawn = PendingMediaRowTests.Bitmap(image), drawn.alpha(atX: 1, y: 1) == 0 {
        image = renderer.image { _ in _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
      }
      try XCTUnwrap(image.pngData()).write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
    return (host, window)
  }

  static func scrollViews(in view: UIView) -> [UIScrollView] {
    let own = (view as? UIScrollView).map { [$0] } ?? []
    return own + view.subviews.flatMap(scrollViews(in:))
  }

  /// `dialog-session-paused-2.1.309.txt` (22 linie po przycięciu pustych, cały ekran przechodzi przez `snippet`).
  static let pausedScreen = #"""
    ❯ Sprawdź testy

    ⏺ Bash(pnpm test server/test/herdr-screen.test.ts)
      ⎿   Test Files  1 passed (1)
               Tests  214 passed (214)

    ⏺ Testy przechodzą: 214 z 214 w herdr-screen.test.ts.

    ❯ Dopisz test na pusty ekran

    ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
     Session paused

      Opus 5.5 (1M context)'s safeguards flagged this session. You may be seeing this for the first time: Opus 5.5 (1M context) is
      more capable and has stronger safeguards as a result, which can sometimes flag non-cybersecurity work. We're improving
      these safeguards to reduce the amount of incorrectly flagged messages. Edit and retry, or continue with Opus 4.8. Send
      feedback with /feedback or learn more: https://support.claude.com/en/articles/8106465

      Details: `[cyber]`

      ❯ 1. Switch to Opus 4.8
        2. Edit prompt and retry with Opus 5.5 (1M context)
    """#

  /// `dialog-bash-subagent-uciety-62x29-2.1.309.txt` (28 linii; nagłówek „Bash command” nad krawędzią panelu).
  static let cutBashScreen = #"""
     │ og-tozsamosc && python3 -I - <<'EOF'
     │ p='scripts/ios-publish.sh'
     │ s=open(p,encoding='utf-8').read()
     │ old='''# LINKIEM, bez kabla (app). Podpis kluczem API App
     │ Store Connect (`ios_asc_auth` w ios-lib.sh), eksport
     │ „debugging" (podpis deweloperski: urządzenia
     │ # zarejestrowane w koncie, profil na rok) z manifestem
     │ `itms-services`. Pliki lądują w katalogu,'''
     │ new='''# LINKIEM, bez kabla (app). Podpis kluczem API App
     │ Store Connect (`ios_asc_auth` w ios-lib.sh), eksport
     │ # „debugging" (podpis deweloperski: urządzenia
     │ zarejestrowane w koncie, profil na rok) z manifestem
     │ # `itms-services`. Pliki lądują w katalogu,'''
     │ assert s.count(old)==1
     │ open(p,'w',encoding='utf-8').write(s.replace(old,new))
     │ EOF
     │ sed -n 1,8p scripts/ios-publish.sh; bash -n
     │ scripts/ios-publish.sh && echo ok
    ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
     │ Ask rule Bash(*bash *scripts/ios-publish.sh*) overrides
     │ auto mode for this command.
     /permissions to let auto mode decide

     Do you want to proceed?
     ❯ 1. Yes
       2. No

     Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop b…
    """#
}
