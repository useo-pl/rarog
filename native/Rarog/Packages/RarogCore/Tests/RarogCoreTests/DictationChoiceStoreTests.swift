import Foundation
@testable import RarogCore
import Testing

// Wybór dyktowania na urządzeniu: odczyt, zapis i usunięcie pod kluczem
// `rarog.dictation.choice` we wstrzykniętym `UserDefaults`; nieznana wartość = brak wyboru.

/// Własna domena `UserDefaults` testu, usunięta po teście (nie dotyka domeny apki ani innych testów).
final class ScratchDefaults {
  let name = "rarog-test-dictation-\(UUID().uuidString)"
  let defaults: UserDefaults

  init() {
    // swiftlint:disable:next force_unwrapping
    defaults = UserDefaults(suiteName: name)!
  }

  deinit {
    defaults.removePersistentDomain(forName: name)
  }
}

@Suite("dyktowanie: wybór na urządzeniu")
struct DictationChoiceStoreTests {
  @Test("klucz i wartości: rarog.dictation.choice, system i soniox")
  func keyAndValues() {
    #expect(DictationChoiceStore.key == "rarog.dictation.choice")
    #expect(DictationChoice.allCases.map(\.rawValue) == ["system", "soniox"])
  }

  @Test("UserDefaults: brak wartości = brak wyboru; zapis, odczyt, zmiana; clear() usuwa klucz")
  func defaults() {
    let scratch = ScratchDefaults()
    let store = DictationChoiceStore(defaults: scratch.defaults)
    #expect(store.choice == nil)
    store.save(.soniox)
    #expect(store.choice == .soniox)
    #expect(scratch.defaults.string(forKey: DictationChoiceStore.key) == "soniox")
    store.save(.system)
    #expect(store.choice == .system)
    store.clear()
    #expect(store.choice == nil)
    #expect(scratch.defaults.object(forKey: DictationChoiceStore.key) == nil, "clear() usuwa klucz, nie zapisuje pustej wartości")
  }

  @Test("nieznana wartość pod kluczem = brak wyboru")
  func unknownValue() {
    let scratch = ScratchDefaults()
    let store = DictationChoiceStore(defaults: scratch.defaults)
    for value: Any in ["whisper", "", "Soniox", 1, true] {
      scratch.defaults.set(value, forKey: DictationChoiceStore.key)
      #expect(store.choice == nil, "\(value)")
    }
  }

  @Test("wybór należy do urządzenia: drugi magazyn na tych samych UserDefaults widzi zapis")
  func persisted() {
    let scratch = ScratchDefaults()
    DictationChoiceStore(defaults: scratch.defaults).save(.system)
    #expect(DictationChoiceStore(defaults: scratch.defaults).choice == .system)
  }

  @Test("pamięć (testy, tryb UI): wartość startowa, zapis, clear(); kopia magazynu widzi ten sam wybór")
  func memory() {
    #expect(DictationChoiceStore.memory(nil).choice == nil)
    let store = DictationChoiceStore.memory(.system)
    #expect(store.choice == .system)
    let same = store
    store.save(.soniox)
    #expect(same.choice == .soniox)
    store.clear()
    #expect(same.choice == nil)
  }
}
