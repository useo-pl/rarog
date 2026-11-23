import CoreText
import Foundation

// Zapasowe pismo z glifami Nerd Font (bez niego prompt p10k na iPadzie rysuje „?" — pismo systemowe nie ma
// znaków z obszaru prywatnego Unicode, na których stoją separatory Powerline i ikony). Symbols Nerd Font Mono
// v3.5.1 (MIT, atrybucja zestawów ikon w `Resources/NerdFontsSymbols/NOTICE.txt`) leży w zasobach pakietu
// i wchodzi do kaskady pisma terminala: CoreText szuka brakującego glifu najpierw w nim, dopiero potem w zapasie
// systemu. Glif ma szerokość 1 em, a komórka terminala ~0,6 em — ikona zachodzi na następną komórkę (p10k
// stawia po niej spację); separator Powerline mieści się w komórce prawie cały. Uzasadnienie i waga (2,6 MB):
// `native/Rarog/README.md`. Część CoreText jest wspólna dla iOS i macOS (testy `swift test`). Właściciel: terminal.

public enum TerminalSymbolsFont {
  public static let postScriptName = "SymbolsNFM"
  public static let family = "Symbols Nerd Font Mono"
  static let resource = "SymbolsNerdFontMono-Regular"
  static let directory = "NerdFontsSymbols"

  /// Plik pisma w zasobach pakietu.
  static var url: URL? {
    Bundle.module.url(forResource: resource, withExtension: "ttf", subdirectory: directory)
  }

  /// Rejestracja raz na proces (zakres `.process`, nic nie zostaje w systemie). `false` = pisma nie ma —
  /// terminal działa dalej, tylko bez glifów Nerd Font.
  public static let isAvailable: Bool = {
    guard let url else { return false }
    var error: Unmanaged<CFError>?
    if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) { return true }
    // Drugi rejestrujący w tym samym procesie (np. testy) dostaje „już zarejestrowane" — pismo jest.
    let code = error.map { CFErrorGetCode($0.takeRetainedValue()) }
    return code == CTFontManagerError.alreadyRegistered.rawValue
  }()

  /// Pismo bazowe terminala w czterech odmianach (zwykła, pogrubiona, kursywa, pogrubiona kursywa). Menlo, nie
  /// monospace systemowy: pismo systemowe (`.AppleSystemUIFontMonospaced`) pomija `kCTFontCascadeListAttribute`
  /// i brakujący glif bierze z LastResort — ikony p10k i eza wychodzą wtedy „?" w ramce (iPhone;
  /// pomiar `CTLine` na macOS 27: pismo systemowe → LastResort, Menlo → SymbolsNFM).
  /// Menlo jest na iOS i na macOS.
  public static let baseNames = (
    regular: "Menlo-Regular", bold: "Menlo-Bold", italic: "Menlo-Italic", boldItalic: "Menlo-BoldItalic"
  )

  /// Pismo terminala: `name` z kaskadą Symbols Nerd Font Mono w rozmiarze `size`.
  public static func font(named name: String, size: CGFloat) -> CTFont {
    let base = CTFontCreateWithName(name as CFString, size, nil)
    return CTFontCreateWithFontDescriptor(cascading(CTFontCopyFontDescriptor(base), size: size), size, nil)
  }

  /// Opis pisma z kaskadą: brakujący glif `base` CoreText bierze z Symbols Nerd Font Mono w tym samym rozmiarze.
  public static func cascading(_ base: CTFontDescriptor, size: CGFloat) -> CTFontDescriptor {
    guard isAvailable else { return base }
    let symbols = CTFontDescriptorCreateWithNameAndSize(postScriptName as CFString, size)
    let attributes = [kCTFontCascadeListAttribute: [symbols]] as CFDictionary
    return CTFontDescriptorCreateCopyWithAttributes(base, attributes)
  }
}
