import Foundation

/// Wybór dyktowania i flaga builda: jedno wejście dla UI. Magazyn dostaje je przez
/// ``RarogStore/attachDictation(_:)``; bez podpięcia ma ``memory(sonioxAllowed:choice:)`` z flagą `true`
/// (jak domyślny build) i bez wyboru.
public struct DictationServices: Sendable {
  public let choices: DictationChoiceStore
  /// `RAROG_VOICE_SONIOX` z Info.plist: `false` chowa opcję Soniox i zamyka trasę Soniox.
  public let sonioxAllowed: Bool

  init(choices: DictationChoiceStore, sonioxAllowed: Bool) {
    self.choices = choices
    self.sonioxAllowed = sonioxAllowed
  }

  /// Apka: wybór w podanych `UserDefaults`.
  public static func live(sonioxAllowed: Bool, defaults: UserDefaults) -> DictationServices {
    DictationServices(choices: DictationChoiceStore(defaults: defaults), sonioxAllowed: sonioxAllowed)
  }

  /// Testy i tryb testów UI: wybór w pamięci, nigdy w prawdziwych `UserDefaults`.
  public static func memory(sonioxAllowed: Bool, choice: DictationChoice?) -> DictationServices {
    DictationServices(choices: .memory(choice), sonioxAllowed: sonioxAllowed)
  }

  /// Wartość klucza Info.plist `RarogVoiceSoniox` (`$(RAROG_VOICE_SONIOX)`). Tylko napis `YES` włącza Soniox;
  /// `NO`, brak klucza i niepodstawiona zmienna builda (`$(…)`) — nie.
  public static func sonioxAllowed(info value: Any?) -> Bool {
    (value as? String) == "YES"
  }
}
