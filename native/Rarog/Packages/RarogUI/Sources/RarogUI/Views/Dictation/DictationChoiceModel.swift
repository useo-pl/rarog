import Foundation
import Observation
import RarogContract
import RarogCore

// Model ekranu „Dyktowanie”, bez UIKit: kompiluje się na macOS, więc `swift test` sprawdza go bez symulatora
// (`DictationChoiceModelTests`, `DictationCopyTests`). Wybór i flaga przychodzą z `DictationServices` magazynu, stan
// Soniox na serwerze z `AppState.sonioxOnServer` (RarogCore); model niczego z nich nie liczy sam, tylko składa teksty
// według `DictationPolicy.sonioxOption`. Widoki: `DictationChoiceView.swift`, `DictationSheet.swift`;
// the Settings page and the list's row: `Views/Settings/SettingsSheet.swift`.
//
// Reguły zgody: apka nigdy sama nie przełącza dostawcy; Soniox wybiera się tylko wtedy, gdy serwer go daje; wybór
// niczego nie nagrywa (mikrofon otwiera dopiero następne stuknięcie).
// The app never takes a key: with Soniox unavailable it only shows steps for the person who runs the server.

/// Gdzie stoi ekran: arkusz z mikrofonu pola wiadomości, strona w notatce albo strona w Ustawieniach.
enum DictationPresentation: Sendable, Equatable {
  case sheet
  case notePage
  case settingsPage

  /// Identyfikator dostępności formularza dla testów UI.
  var identifier: String {
    switch self {
    case .sheet: "dictation.sheet"
    case .notePage: "dictation.page"
    case .settingsPage: SettingsPage.dictation.identifier
    }
  }

  /// The lead line (choose, then tap the microphone again): not on the Settings page.
  var showsLead: Bool { self != .settingsPage }

  /// The keyboard shortcut section: only on the Settings page, not on the first-mic sheet or the note page.
  var showsShortcut: Bool { self == .settingsPage }
}

/// One option on the screen: the name, the description with the consent, and the choose button.
struct DictationOptionContent: Equatable, Sendable, Identifiable {
  let choice: DictationChoice
  let title: String
  /// Description and consent in one: the provider, the region and what leaves the device.
  let summary: String
  /// Stan opcji Soniox (sprawdzam, niedostępny); przy dostępnym i przy opcji systemowej `nil`.
  let state: String?
  /// Steps for the person who runs the server, with the Soniox console link: only while Soniox is unavailable.
  let setup: ServerSetupSteps?
  /// „Wybierz …” albo „Wybrane”.
  let button: String
  /// Przycisk przyjmuje stuknięcie: opcja jeszcze niewybrana i do wybrania.
  let enabled: Bool
  let selected: Bool

  var id: DictationChoice { choice }
}

/// Treść ekranu w jednym języku.
struct DictationScreen: Equatable, Sendable {
  let title: String
  let lead: String
  /// Systemowe zawsze; Soniox, gdy build go ma (flaga `RAROG_VOICE_SONIOX`).
  let options: [DictationOptionContent]
  let privacyLabel: String
  let privacyURL: URL

  /// Każdy tekst ekranu: przy fladze `NO` żaden nie mówi „Soniox”.
  var texts: [String] {
    [title, lead, privacyLabel] + options.flatMap { option in
      [option.title, option.summary, option.state, option.button].compactMap { $0 } + (option.setup?.texts ?? [])
    }
  }
}

/// Settings: the choice on this device (the Dictation row's subtitle). The Soniox state on the server stands on the
/// Soniox option itself (`DictationOptionContent.state`), so the page has no separate server row.
struct DictationSettingsSummary: Equatable, Sendable {
  /// Nazwa wybranej opcji albo „nie wybrano”.
  let value: String

  var texts: [String] { [value] }
}

/// Model ekranu „Dyktowanie”. Wybór (`DictationChoiceStore`) nie publikuje zmian, więc model trzyma jego odczyt
/// i odświeża go po każdym zapisie; stan serwera czyta przy każdym składaniu treści, więc widok, który ją rysuje,
/// śledzi `RarogStore.state` i sonda wersji przy otwartym ekranie zmienia opcję Soniox na żywo.
@MainActor
@Observable
final class DictationChoiceModel {
  @ObservationIgnored let services: DictationServices
  @ObservationIgnored private let server: @MainActor () -> SonioxServerState
  /// Wybór na tym urządzeniu, odczytany przy otwarciu i po każdym zapisie.
  private(set) var choice: DictationChoice?

  init(services: DictationServices, server: @escaping @MainActor () -> SonioxServerState) {
    self.services = services
    self.server = server
    choice = services.choices.choice
  }

  /// Apka: wybór i flaga z magazynu, stan Soniox z jego stanu.
  convenience init(store: RarogStore) {
    self.init(services: store.dictation, server: { store.state.sonioxOnServer })
  }

  var sonioxOption: SonioxOption {
    DictationPolicy.sonioxOption(server: server(), sonioxAllowed: services.sonioxAllowed)
  }

  /// Systemowe zawsze; Soniox tylko wtedy, gdy serwer go daje.
  func canChoose(_ choice: DictationChoice) -> Bool {
    switch choice {
    case .system: true
    case .soniox: sonioxOption == .available
    }
  }

  /// Zapisuje wybór, jeśli wolno; potem czyta go z magazynu. `false` = nic się nie zapisało.
  @discardableResult
  func choose(_ choice: DictationChoice) -> Bool {
    guard canChoose(choice) else { return false }
    services.choices.save(choice)
    self.choice = services.choices.choice
    return true
  }

  func screen(language: CopyLanguage = .current) -> DictationScreen {
    let soniox = sonioxOption
    var options = [system(language)]
    if soniox != .hidden { options.append(sonioxContent(soniox, language)) }
    return DictationScreen(
      title: UICopy.dictationTitle(language: language), lead: UICopy.dictationLead(language: language),
      options: options, privacyLabel: UICopy.dictationPrivacy(language: language),
      privacyURL: ProductLinks.privacyDictation)
  }

  func settings(language: CopyLanguage = .current) -> DictationSettingsSummary {
    let hidden = !services.sonioxAllowed
    let value: String =
      switch choice {
      case .system: UICopy.dictationSystemTitle(language: language)
      case .soniox where !hidden: UICopy.dictationSonioxTitle(language: language)
      // Soniox zapisany w buildzie bez Soniox: trasa i tak pyta, a nazwy dostawcy tu nie ma.
      case .soniox, nil: UICopy.dictationSettingsNone(language: language)
      }
    return DictationSettingsSummary(value: value)
  }

  // MARK: Opcje

  private func system(_ language: CopyLanguage) -> DictationOptionContent {
    let selected = choice == .system
    return DictationOptionContent(
      choice: .system, title: UICopy.dictationSystemTitle(language: language),
      summary: UICopy.dictationSystemSummary(language: language), state: nil, setup: nil,
      button: selected ? UICopy.dictationSelected(language: language) : UICopy.dictationSystemChoose(language: language),
      enabled: !selected, selected: selected)
  }

  private func sonioxContent(_ option: SonioxOption, _ language: CopyLanguage) -> DictationOptionContent {
    let selected = choice == .soniox
    let state: String? =
      switch option {
      case .checking: UICopy.dictationSonioxChecking(language: language)
      case .unavailable: UICopy.dictationSonioxUnavailable(language: language)
      case .available, .hidden: nil
      }
    return DictationOptionContent(
      choice: .soniox, title: UICopy.dictationSonioxTitle(language: language),
      summary: UICopy.dictationSonioxSummary(language: language), state: state,
      setup: option == .unavailable ? sonioxSetup(language) : nil,
      button: selected ? UICopy.dictationSelected(language: language) : UICopy.dictationSonioxChoose(language: language),
      enabled: !selected && option == .available, selected: selected)
  }

  /// Soniox unavailable: where the key comes from and the commands that save it on the server. The state line above
  /// stays neutral (no key, voice off, review mode, a rejected key), so the steps say only how to add one.
  private func sonioxSetup(_ language: CopyLanguage) -> ServerSetupSteps {
    ServerSetupSteps(
      steps: [
        ServerSetupStep(text: UICopy.dictationSonioxSetupKey(language: language)),
        ServerSetupStep(
          text: UICopy.dictationSonioxSetupRun(language: language),
          commands: [ServerCommand.dictationSetKey, ServerCommand.restart]),
      ],
      linkLabel: UICopy.dictationSonioxSetupLink(language: language), linkURL: ProviderLinks.sonioxConsole)
  }
}
