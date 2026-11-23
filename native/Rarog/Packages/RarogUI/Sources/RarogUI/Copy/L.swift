import Foundation
import RarogContract

// Katalog copy pakietu `RarogUI` (`Copy/Localizable.xcstrings`, `docs/localization.md`).
// Każdy tekst rejestru (`UICopy`, `ToolActivity`) stoi w katalogu, a rejestr woła `L` z kluczem-literałem.

/// Tekst z katalogu `RarogUI` w języku procesu (`CopyLanguage.current`); parametry jak w `String(format:)`.
func L(_ key: String, _ arguments: any CVarArg...) -> String {
  CopyLookup.string(key, bundle: .module, language: .current, arguments: arguments)
}

/// Tekst z katalogu `RarogUI` w JAWNYM języku — testy innego języka niż język procesu (globalnego przełącznika nie ma).
func L(_ key: String, language: CopyLanguage, _ arguments: any CVarArg...) -> String {
  CopyLookup.string(key, bundle: .module, language: language, arguments: arguments)
}

/// To samo z argumentami w tablicy — dla testów, które podają próbne argumenty do każdego klucza (`CopyCatalogTests`).
func L(_ key: String, language: CopyLanguage, arguments: [CVarArg]) -> String {
  CopyLookup.string(key, bundle: .module, language: language, arguments: arguments)
}
