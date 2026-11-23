import Foundation
import RarogContract

/// Wiersz „Language” w Ustawieniach → Serwer (`docs/localization.md`, „How the app picks its language”):
/// język copy procesu nazwany w nim samym. Apka języka nie przełącza: stuknięcie otwiera jej stronę w Ustawieniach
/// iOS (`UIApplication.openSettingsURLString`), gdzie system zmienia język apki i uruchamia ją od nowa. Wiersz
/// „Language” na tej stronie pokazuje się także przy jednym języku urządzenia dzięki
/// `UIPrefersShowingLanguageSettings` w `Info.plist` apki.
struct AppLanguageRow: Equatable, Sendable {
  let label: String
  /// Nazwa języka w nim samym: „English”, „Polski”.
  let value: String
  /// Podpowiedź czytnika: stuknięcie otwiera Ustawienia systemu.
  let hint: String

  init(language: CopyLanguage = .current) {
    label = UICopy.languageLabel(language)
    value = UICopy.languageName(language)
    hint = UICopy.languageHint(language)
  }
}
