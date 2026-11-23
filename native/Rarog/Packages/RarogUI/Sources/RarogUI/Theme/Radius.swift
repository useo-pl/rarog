import CoreGraphics
#if os(iOS)
import SwiftUI
import UIKit
#endif

/// Skala promieni rogów: jeden promień bloków, jeden dla elementów w środku.
/// Użytkownik widział obok siebie 6, 8, 10, 12, 14 i 17 pt jako niespójność („zaokrąglenia rogów zupełnie nie są
/// takie jak innych elementów w aplikacji”). PWA ma dwa promienie bloków (`--radius` 12 i `--radius-lg` 14),
/// apka świadomie jeden. Kapsuły (pigułki, przyciski, pasek „Przewiń na dół”) i kropki zostają kapsułami.
/// Wyjątek: kafel „zawsze” na karcie zgody (dwa wiersze) ma `inner`
/// (`FootButtonShape`). Krzywa zawsze ciągła. Promień liczbą stoi tylko tutaj (`CornerRadiusSourceTests`).
enum Radius {
  /// Samodzielny blok: dymek, wiersz narzędzia, miniatura zdjęcia i chip pliku w transkrypcie, karty decyzji,
  /// pytań i stanu, banery, notka pod paskiem zakładek, pasek promptu, pole wiadomości, karta PROJEKTY,
  /// zaznaczenie wiersza listy, arkusze i panele własne.
  static let block: CGFloat = 12
  /// Element wewnątrz bloku albo w ciągłym tekście: blok kodu, pola formularzy (także linku parowania), blok komendy
  /// na karcie, kafel „zawsze” w stopce karty zgody, miniatury i chipy załączników w polu wiadomości, zaznaczenie
  /// projektu w karcie PROJEKTY, płytka bieżącej zakładki w pasku nagłówka.
  static let inner: CGFloat = 8
  /// Pierścień fokusu karty: stoi 3 pt na zewnątrz jej krawędzi, więc promień o 3 pt większy (współśrodkowy).
  static let focusRing: CGFloat = block + 3
  /// Szkielety ładowania (paski tekstu, etykieta limitu przed liczbą) i kafelek z cyfrą skrótu Cmd na zakładce paska.
  static let ghost: CGFloat = 4
  /// Kwadracik stanu 10 pt na zakładce bez cyfry skrótu (`TabTokens`): ćwierć boku.
  /// To znak wielkości glifu, nie blok — dlatego spoza skali bloków.
  static let tabSquare: CGFloat = 2.5
  /// Promień rogu arkusza iPada, który rysuje SYSTEM (`.page`, `.form` i własna szerokość; `effectiveRadius(corner:)`
  /// zmierzony na iOS 26.2 i 27.0). Apka nim nie rysuje: liczy z niego odstęp treści okna od łuku rogu
  /// (`WindowLayout`), a test na symulatorze porównuje go z API systemu.
  static let systemSheet: CGFloat = 32
}

#if os(iOS)
extension Shape where Self == RoundedRectangle {
  /// Samodzielny blok (`Radius.block`).
  static var block: RoundedRectangle { RoundedRectangle(cornerRadius: Radius.block, style: .continuous) }
  /// Element w środku bloku (`Radius.inner`).
  static var inner: RoundedRectangle { RoundedRectangle(cornerRadius: Radius.inner, style: .continuous) }
  /// Szkielet ładowania (`Radius.ghost`).
  static var ghost: RoundedRectangle { RoundedRectangle(cornerRadius: Radius.ghost, style: .continuous) }
}

extension Shape where Self == UnevenRoundedRectangle {
  /// Blok (`Radius.block`) zaokrąglony tylko u góry, tylko u dołu, z obu stron albo wcale — wiersz karty sąsiednich
  /// narzędzi: rogi zewnętrzne okrągłe, styki między wierszami proste.
  static func block(top: Bool, bottom: Bool) -> UnevenRoundedRectangle {
    let upper = top ? Radius.block : 0
    let lower = bottom ? Radius.block : 0
    return UnevenRoundedRectangle(
      topLeadingRadius: upper, bottomLeadingRadius: lower, bottomTrailingRadius: lower, topTrailingRadius: upper,
      style: .continuous)
  }
}

extension CALayer {
  /// Promień ze skali razem z krzywą ciągłą: Core Animation domyślnie rysuje róg kołowo.
  func roundCorners(_ radius: CGFloat) {
    cornerRadius = radius
    cornerCurve = .continuous
  }
}

extension UIBackgroundConfiguration {
  /// Promień ze skali dla tła przycisku z `UIButton.Configuration` (UIKit rysuje je krzywą ciągłą — sprawdza
  /// `TerminalScreenTests`); bez tego `cornerStyle` dobiera promień sam, spoza skali.
  mutating func roundCorners(_ radius: CGFloat) {
    cornerRadius = radius
  }
}

extension UIPasteControl.Configuration {
  /// Promień ze skali dla `UIPasteControl` — `.medium` i reszta stylów dobierają go same, spoza skali.
  func roundCorners(_ radius: CGFloat) {
    cornerStyle = .fixed
    cornerRadius = radius
  }
}
#endif
