import Foundation
import Synchronization

/// Wybór dyktowania na urządzeniu: odczyt, zapis i usunięcie pod kluczem ``key``. Wybór należy do urządzenia,
/// nie do serwera: nowy serwer, wylogowanie i „Zapomnij serwer” (`RarogStore.retire`) go nie czyszczą.
/// Nieznana wartość pod kluczem = brak wyboru.
public final class DictationChoiceStore: Sendable {
  public static let key = "rarog.dictation.choice"

  /// `nil` = wybór w pamięci (testy, tryb testów UI), nigdy w prawdziwych `UserDefaults`. `nonisolated(unsafe)`:
  /// SDK nie oznacza `UserDefaults` jako `Sendable`, a według dokumentacji Apple jest bezpieczny wątkowo; pole jest
  /// stałe, a magazyn woła tylko `object`, `set` i `removeObject`.
  nonisolated(unsafe) private let defaults: UserDefaults?
  private let memory: Mutex<String?>

  public init(defaults: UserDefaults) {
    self.defaults = defaults
    memory = Mutex(nil)
  }

  private init(memory choice: DictationChoice?) {
    defaults = nil
    memory = Mutex(choice?.rawValue)
  }

  public static func memory(_ choice: DictationChoice?) -> DictationChoiceStore {
    DictationChoiceStore(memory: choice)
  }

  public var choice: DictationChoice? {
    let raw = defaults.map { $0.object(forKey: Self.key) as? String } ?? memory.withLock { $0 }
    return raw.flatMap(DictationChoice.init(rawValue:))
  }

  public func save(_ choice: DictationChoice) {
    if let defaults {
      defaults.set(choice.rawValue, forKey: Self.key)
    } else {
      memory.withLock { $0 = choice.rawValue }
    }
  }

  /// Usuwa klucz (nie zapisuje pustej wartości): następne stuknięcie otwiera ekran wyboru.
  public func clear() {
    if let defaults {
      defaults.removeObject(forKey: Self.key)
    } else {
      memory.withLock { $0 = nil }
    }
  }
}
