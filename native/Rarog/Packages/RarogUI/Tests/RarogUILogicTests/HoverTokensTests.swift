import Foundation
@testable import RarogUI
import Testing

// Wskaźnik nad tym, co się klika, jak w PWA:
// kolory hover wobec zaznaczenia i tła (`HoverTokens`) oraz strażnik źródeł — żadnego systemowego
// `.hoverEffect` (szkło, uniesienie), reakcją jest nasz kolor. Widok `Views/Common/Hover.swift`. Właściciel: wygląd.

@Suite("wskaźnik: kolory hover i strażnik źródeł")
struct HoverTokensTests {
  private typealias RGB = TranscriptDim.RGB

  private func ratio(_ a: UInt32, _ b: UInt32) -> Double {
    TranscriptDim.contrast(RGB(hex: a), RGB(hex: b))
  }

  /// Wiersz agenta: pod wskaźnikiem plama „przydymiona” — widoczna na tle kolumny, ale wyraźnie słabsza niż
  /// zaznaczenie (kontrast z tłem mierzony w obu motywach; wynik o „krok” niżej niż PWA `--surface`, bo tamten był
  /// prawie zaznaczeniem).
  @Test("wiersz agenta: hover jaśniejszy od tła, ale najwyżej 60 % kroku zaznaczenia; zaznaczenie wygrywa")
  func agentRowWeakerThanSelection() {
    for dark in [true, false] {
      let background = HoverTokens.agentRow(selected: false, hovered: false, dark: dark)
      let hover = HoverTokens.agentRow(selected: false, hovered: true, dark: dark)
      let selection = HoverTokens.agentRow(selected: true, hovered: false, dark: dark)
      #expect(HoverTokens.agentRow(selected: true, hovered: true, dark: dark) == selection, "zaznaczenie wygrywa")
      let hoverStep = ratio(hover, background) - 1
      let selectionStep = ratio(selection, background) - 1
      #expect(hoverStep > 0.01, "dark \(dark): hover widoczny (\(ratio(hover, background)))")
      #expect(hoverStep <= 0.6 * selectionStep, "dark \(dark): hover \(hoverStep) wobec zaznaczenia \(selectionStep)")
    }
    // PWA (`--surface` #171717) dałoby 67 % kroku zaznaczenia — „przydymienia” prawie nie było widać.
    #expect(ratio(0x171717, 0x0A0A0A) - 1 > 0.6 * (ratio(0x1C1C1C, 0x0A0A0A) - 1))
  }

  /// Przycisk wypełniony kolorem stanu: domieszka tekstu podnosi kontrast etykiety w obu motywach (PWA
  /// `.btn--accent:hover`), a tło obrysu 8 % nie zbija etykiety pod 4,5:1 (PWA `.btn--deny:hover`).
  @Test("przyciski: domieszka 14 % i tło obrysu 8 % — etykieta dalej AA, w wypełnionym kontrast rośnie")
  func buttonLabelsKeepContrast() {
    for dark in [true, false] {
      func ink(_ pair: PaletteTokens.Pair) -> UInt32 { dark ? pair.dark : pair.light }
      let fill = ink(PaletteTokens.run)
      let hovered = PaletteTokens.over(ink(PaletteTokens.text), alpha: HoverTokens.filledMix, on: fill)
      #expect(ratio(ink(PaletteTokens.onState), hovered) > ratio(ink(PaletteTokens.onState), fill), "dark \(dark)")
      let card = ink(PaletteTokens.surface)
      let tinted = PaletteTokens.over(ink(PaletteTokens.err), alpha: HoverTokens.outlineTint, on: card)
      #expect(ratio(ink(PaletteTokens.err), tinted) >= 4.5, "dark \(dark): „Odrzuć” pod wskaźnikiem")
      // Akcja główna wypełniona atramentem tekstu (domieszka tekstu w tekście nic nie zmienia).
      let primary = ink(PaletteTokens.text)
      let dimmed = PaletteTokens.over(ink(PaletteTokens.background), alpha: HoverTokens.inkFillMix, on: primary)
      #expect(ratio(primary, dimmed) > 1.1, "dark \(dark): hover akcji głównej widoczny")
      #expect(ratio(ink(PaletteTokens.background), dimmed) >= 7, "dark \(dark): napis akcji głównej dalej ≥ 7:1")
    }
  }

  /// Rząd pod polem wiadomości (wariant A): kreska pod wskaźnikiem wyraźnie mocniejsza niż w spoczynku,
  /// ale ciemniejsza od napisów rzędu, żeby ramka nie była za jasna.
  @Test("kreska pod wskaźnikiem na karcie pola: mocniejsza od `border`, słabsza od `muted2`, w obu motywach")
  func outlineStrokeBetweenBorderAndInk() {
    for dark in [true, false] {
      let card = dark ? PaletteTokens.composerRest.dark : PaletteTokens.composerRest.light
      let ink: UInt32 = dark ? 0xFFFFFF : 0x000000
      let rest = PaletteTokens.over(ink, alpha: dark ? 0.08 : 0.10, on: card)
      let hovered = PaletteTokens.over(ink, alpha: HoverTokens.outlineStroke, on: card)
      let quietest = dark ? PaletteTokens.muted2.dark : PaletteTokens.muted2.light
      #expect(ratio(hovered, card) > ratio(rest, card) + 0.5, "dark \(dark): \(ratio(hovered, card)) wobec \(ratio(rest, card))")
      #expect(ratio(hovered, card) < ratio(quietest, card), "dark \(dark): ciemniej niż najcichszy napis")
    }
  }

  @Test("bez systemowego `.hoverEffect` i `isPointerInteractionEnabled` w RarogUI — reakcją jest nasz kolor")
  func noSystemHoverEffect() throws {
    let root = SessionListSourceTests.sources
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    #expect(files.count > 50)
    var offenders: [String] = []
    for file in files {
      let relative = String(file.path.dropFirst(root.path.count + 1))
      let code = try SessionListSourceTests.code(relative)
      if code.replacingOccurrences(of: ".hoverEffectDisabled", with: "").contains(".hoverEffect") {
        offenders.append("\(relative): .hoverEffect")
      }
      // Bez wyjątku: mikrofon pola wiadomości reaguje jak spinacz (`RingButton`).
      if code.contains("isPointerInteractionEnabled = true") {
        offenders.append("\(relative): isPointerInteractionEnabled")
      }
    }
    #expect(offenders.isEmpty, "\(offenders)")
  }

  @Test("tam, gdzie stoi nasz hover: wspólny modyfikator, dotyk bez reakcji, systemowe efekty zdjęte")
  func ourHoverEverywhere() throws {
    let hover = try SessionListSourceTests.code("Views/Common/Hover.swift")
    #expect(hover.contains(".onHover"), "tylko wskaźnik: onHover nie słyszy dotyku")
    #expect(hover.contains(".hoverEffectDisabled()"), "systemowe efekty w poddrzewie zdjęte")
    #expect(hover.contains("UIHoverGestureRecognizer"), "pomocnik dla UIKit")
    let sites: [(String, String)] = [
      ("Views/Header/HeaderIconButton.swift", ".rarogHover(.ink("),
      // Zakładki, notatka i „+” paska: płytka w połowie krycia przez `RarogHoverReader`.
      ("Views/Projects/ProjectTabBar.swift", "RarogHoverReader"),
      ("Views/List/SessionListView.swift", "onHoverChange"),
      ("Views/Header/SessionPills.swift", "RarogHoverReader"),
      ("Session/Buttons.swift", "ButtonHover"),
      ("Session/Cards/QuestionCard.swift", "RarogHoverReader"),
      ("Session/Copy/CopyButtons.swift", "RarogHoverTracker"),
      ("Session/Rows/TranscriptMarkerViews.swift", ".rarogHover(.ink("),
      ("Session/Rows/AttachmentThumbnails.swift", "RarogHoverReader"),
      ("Switcher/SessionSwitcherOverlay.swift", "RarogHoverReader"),
      // Rząd pod polem wiadomości (wariant A): kółka i „Wyślij” w UIKit, pigułki przez `PillLabel`.
      ("Session/ComposerActionBar.swift", "RarogHoverTracker"),
      ("Session/Voice/VoiceViews.swift", "RingButton"),
      // Okno historii terminala stoi na szkielecie arkusza: jego przyciski paska rysuje system.
    ]
    for (file, marker) in sites {
      #expect(try SessionListSourceTests.code(file).contains(marker), "\(file): \(marker)")
    }
    let focus = try SessionListSourceTests.code("Views/List/ListCellFocus.swift")
    #expect(focus.contains("pointer.isEnabled = false"), "systemowy efekt wskaźnika listy zdjęty")
    #expect(focus.contains("selectionFollowsFocus = false"), "zaznaczenie dalej nie idzie za fokusem")
    // Przycisk zgody: aktywacja dalej wyłącznie gestem (ApprovalGate), hover to sam wygląd.
    for file in ["Session/Cards/QuestionCard.swift", "Views/DetailView.swift"] {
      #expect(try SessionListSourceTests.code(file).contains("hover: .inkFill"), "\(file): akcja główna w atramencie tekstu")
    }
    let buttons = try SessionListSourceTests.code("Session/Buttons.swift")
    #expect(buttons.contains(".onTapGesture { activate(.touchOrPointer) }"))
    #expect(buttons.contains(".focusable(false)"))
  }
}
