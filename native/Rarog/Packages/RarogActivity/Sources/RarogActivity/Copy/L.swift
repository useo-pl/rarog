import Foundation
import RarogContract

// Copy catalog of the `RarogActivity` package (`Copy/Localizable.xcstrings`, `docs/localization.md`). Every text of the
// registry (tile copy in `LiveActivityPresentation`) lives in the catalog; the registry calls `L` with a literal key.

/// Tekst z katalogu `RarogActivity` w języku procesu (`CopyLanguage.current`); parametry jak w `String(format:)`.
func L(_ key: String, _ arguments: any CVarArg...) -> String {
  CopyLookup.string(key, bundle: .module, language: .current, arguments: arguments)
}

/// Tekst z katalogu `RarogActivity` w JAWNYM języku — testy innego języka niż język procesu (globalnego przełącznika nie ma).
func L(_ key: String, language: CopyLanguage, _ arguments: any CVarArg...) -> String {
  CopyLookup.string(key, bundle: .module, language: language, arguments: arguments)
}

/// To samo z argumentami w tablicy — dla testów, które podają próbne argumenty do każdego klucza (`CopyCatalogTests`).
func L(_ key: String, language: CopyLanguage, arguments: [CVarArg]) -> String {
  CopyLookup.string(key, bundle: .module, language: language, arguments: arguments)
}
