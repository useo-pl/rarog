import Foundation
import Observation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Ekran „Dyktowanie”: model widoku na `DictationServices.memory` i atrapie stanu serwera,
// wiersz Ustawień i arkusz w nawigacji. Stan Soniox na serwerze przychodzi z `AppState.sonioxOnServer` (RarogCore),
// tak jak w apce z `RarogStore.state`; atrapa trzyma `AppState` w obiekcie obserwowanym jak magazyn.

/// Atrapa magazynu: `AppState` w obiekcie `@Observable`, tak jak `RarogStore.state`.
@MainActor
@Observable
private final class ServerProbe {
  var state = AppState(clientBuild: 1)

  /// Sonda wersji: `voiceEnabled` z serwera (`nil` = pole brak, starszy serwer = Soniox dostępny).
  func probe(voiceEnabled: Bool?) throws {
    let field = voiceEnabled.map { #","voiceEnabled":\#($0)"# } ?? ""
    let version = try JSONDecoder().decode(
      VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s"\#(field)}"#.utf8))
    state.capabilities = Capabilities(version)
  }
}

/// Znacznik zmiany z `onChange` obserwacji (zamknięcie `@Sendable`).
private final class Changed: @unchecked Sendable {
  var value = false
}

@MainActor
@Suite("ekran „Dyktowanie”: wybór, opcja Soniox, wiersz Ustawień i arkusz")
struct DictationChoiceModelTests {
  private func make(
    allowed: Bool = true, choice: DictationChoice? = nil
  ) -> (model: DictationChoiceModel, services: DictationServices, server: ServerProbe) {
    let services = DictationServices.memory(sonioxAllowed: allowed, choice: choice)
    let server = ServerProbe()
    let model = DictationChoiceModel(services: services, server: { server.state.sonioxOnServer })
    return (model, services, server)
  }

  private func option(_ screen: DictationScreen, _ choice: DictationChoice) -> DictationOptionContent? {
    screen.options.first { $0.choice == choice }
  }

  @Test("opcja Soniox: flaga NO → brak opcji; unknown → sprawdzam; unavailable → niedostępna; available → dostępna")
  func sonioxOption() throws {
    let hidden = make(allowed: false)
    try hidden.server.probe(voiceEnabled: true)
    #expect(hidden.model.sonioxOption == .hidden)
    #expect(hidden.model.screen().options.map(\.choice) == [.system], "flaga NO: na ekranie tylko systemowe")

    let (model, _, server) = make()
    #expect(model.sonioxOption == .checking, "sonda wersji jeszcze nie odpowiedziała")
    let checking = try #require(option(model.screen(), .soniox))
    #expect(checking.state == UICopy.dictationSonioxChecking() && checking.setup == nil && !checking.enabled)
    try server.probe(voiceEnabled: false)
    #expect(model.sonioxOption == .unavailable)
    let unavailable = try #require(option(model.screen(), .soniox))
    #expect(unavailable.state == UICopy.dictationSonioxUnavailable() && !unavailable.enabled)
    #expect(unavailable.setup != nil, "unavailable: setup steps for the person who runs the server")
    try server.probe(voiceEnabled: true)
    #expect(model.sonioxOption == .available)
    let available = try #require(option(model.screen(), .soniox))
    #expect(available.state == nil && available.setup == nil && available.enabled)
    try server.probe(voiceEnabled: nil)
    #expect(model.sonioxOption == .available, "starszy serwer bez pola: Soniox dostępny")
    #expect(model.screen().options.map(\.choice) == [.system, .soniox], "kolejność: systemowe, potem Soniox")
  }

  @Test("„Wybieram systemowe” → wybór `system` w magazynie i w modelu (odczyt po zapisie), przy każdym stanie")
  func chooseSystem() throws {
    for (allowed, voice) in [(true, nil), (true, false), (false, true)] as [(Bool, Bool?)] {
      let (model, services, server) = make(allowed: allowed)
      if let voice { try server.probe(voiceEnabled: voice) }
      #expect(model.choice == nil && model.canChoose(.system))
      #expect(model.choose(.system))
      #expect(services.choices.choice == .system && model.choice == .system)
      let system = try #require(option(model.screen(), .system))
      #expect(system.selected && !system.enabled && system.button == UICopy.dictationSelected())
    }
  }

  @Test("„Wybieram Soniox”: przy available zapis; przy checking, unavailable i hidden przycisk nieaktywny, bez zapisu")
  func chooseSoniox() throws {
    let (model, services, server) = make()
    #expect(!model.canChoose(.soniox) && !model.choose(.soniox), "checking")
    #expect(services.choices.choice == nil && model.choice == nil)
    try server.probe(voiceEnabled: false)
    #expect(!model.canChoose(.soniox) && !model.choose(.soniox), "unavailable")
    #expect(services.choices.choice == nil)
    try server.probe(voiceEnabled: true)
    let ready = try #require(option(model.screen(), .soniox))
    #expect(ready.enabled && ready.button == UICopy.dictationSonioxChoose())
    #expect(model.choose(.soniox))
    #expect(services.choices.choice == .soniox && model.choice == .soniox)
    let chosen = try #require(option(model.screen(), .soniox))
    #expect(chosen.selected && !chosen.enabled && chosen.button == UICopy.dictationSelected())
    #expect(option(model.screen(), .system)?.selected == false)

    let hidden = make(allowed: false, choice: .system)
    try hidden.server.probe(voiceEnabled: true)
    #expect(!hidden.model.canChoose(.soniox) && !hidden.model.choose(.soniox), "hidden")
    #expect(hidden.services.choices.choice == .system, "wybór nietknięty")
  }

  @Test("sonda przy otwartym ekranie zmienia opcję na żywo, a obserwacja ekranu widzi zmianę stanu serwera")
  func liveProbe() throws {
    let (model, _, server) = make(choice: .soniox)
    #expect(option(model.screen(), .soniox)?.state == UICopy.dictationSonioxChecking())
    let changed = Changed()
    withObservationTracking { _ = model.screen() } onChange: { changed.value = true }
    try server.probe(voiceEnabled: true)
    #expect(changed.value, "ekran czyta stan serwera przy każdym rysowaniu, nie z kopii")
    #expect(option(model.screen(), .soniox)?.enabled == false, "wybrany już Soniox: przycisk „Wybrane”")
    #expect(option(model.screen(), .soniox)?.state == nil)
    changed.value = false
    withObservationTracking { _ = model.screen() } onChange: { changed.value = true }
    try server.probe(voiceEnabled: false)
    #expect(changed.value)
    #expect(option(model.screen(), .soniox)?.state == UICopy.dictationSonioxUnavailable())
    #expect(option(model.screen(), .soniox)?.selected == true, "wybór zostaje, stan mówi, że Soniox niedostępny")
  }

  @Test("zmiana wyboru w Ustawieniach działa od następnego stuknięcia: ten sam magazyn co trasa magazynu")
  func nextTapTakesNewChoice() throws {
    let (model, services, server) = make()
    try server.probe(voiceEnabled: true)
    func route() -> DictationRoute {
      // Ta sama reguła co `RarogStore.dictationRoute` (RarogCore): wybór z magazynu wyboru, czytany przy stuknięciu.
      DictationPolicy.route(
        choice: services.choices.choice, server: server.state.sonioxOnServer, sonioxAllowed: services.sonioxAllowed)
    }
    #expect(route() == .ask(.noChoice))
    model.choose(.soniox)
    #expect(route() == .soniox)
    model.choose(.system)
    #expect(route() == .system)
    let other = DictationChoiceModel(services: services, server: { server.state.sonioxOnServer })
    #expect(other.choice == .system, "nowa prezentacja czyta wybór z magazynu")
  }

  @Test("Settings row: the choice on this device; after a save the row shows the new choice")
  func settingsRow() throws {
    let (model, _, server) = make()
    #expect(model.settings().value == UICopy.dictationSettingsNone())
    try server.probe(voiceEnabled: true)
    model.choose(.soniox)
    #expect(model.settings().value == UICopy.dictationSonioxTitle())
    model.choose(.system)
    #expect(model.settings().value == UICopy.dictationSystemTitle())
  }

  @Test("Settings row with the flag NO: a saved Soniox reads as not chosen, as the route asks anyway")
  func settingsRowHidden() throws {
    let hidden = make(allowed: false, choice: .soniox)
    try hidden.server.probe(voiceEnabled: true)
    let row = hidden.model.settings()
    #expect(row.value == UICopy.dictationSettingsNone())
    #expect(hidden.services.choices.choice == .soniox, "odczyt wiersza nie zmienia wyboru")
  }

  @Test("screen: title, lead, two options with their description, the dictation privacy policy link")
  func screenContent() throws {
    let (model, _, server) = make()
    try server.probe(voiceEnabled: true)
    let screen = model.screen()
    #expect(screen.title == UICopy.dictationTitle() && screen.lead == UICopy.dictationLead())
    #expect(screen.privacyLabel == UICopy.dictationPrivacy() && screen.privacyURL == ProductLinks.privacyDictation)
    let system = try #require(option(screen, .system))
    #expect(system.title == UICopy.dictationSystemTitle() && system.summary == UICopy.dictationSystemSummary())
    #expect(system.button == UICopy.dictationSystemChoose())
    #expect(system.enabled && !system.selected && system.state == nil && system.setup == nil)
    let soniox = try #require(option(screen, .soniox))
    #expect(soniox.title == UICopy.dictationSonioxTitle() && soniox.summary == UICopy.dictationSonioxSummary())
    #expect(screen.texts.allSatisfy { !$0.isEmpty }, "każdy tekst ekranu ma wartość z katalogu")
  }

  @Test("prezentacje: arkusz i strona notatki mają zdanie wstępne, strona Ustawień nie; identyfikatory dla testów UI")
  func presentations() {
    #expect(DictationPresentation.sheet.identifier == "dictation.sheet")
    #expect(DictationPresentation.notePage.identifier == "dictation.page")
    #expect(DictationPresentation.settingsPage.identifier == SettingsPage.dictation.identifier)
    #expect(DictationPresentation.sheet.showsLead && DictationPresentation.notePage.showsLead)
    #expect(!DictationPresentation.settingsPage.showsLead)
  }

  @Test("the Settings page shows the shortcut section; the sheet and the note page do not")
  func settingsPageRows() {
    #expect(DictationPresentation.settingsPage.showsShortcut)
    for presentation in [DictationPresentation.sheet, .notePage] {
      #expect(!presentation.showsShortcut, "\(presentation)")
    }
  }

  @Test("setup steps and the Soniox console link only while Soniox is unavailable; the server commands stay literal")
  func unavailableSetup() throws {
    for language in [CopyLanguage.en, .pl] {
      for state in [SonioxServerState.unknown, .available] {
        let screen = DictationChoiceModel(services: .memory(sonioxAllowed: true, choice: nil), server: { state })
          .screen(language: language)
        #expect(option(screen, .soniox)?.setup == nil, "\(state) \(language)")
      }
      let screen = DictationChoiceModel(services: .memory(sonioxAllowed: true, choice: nil), server: { .unavailable })
        .screen(language: language)
      let setup = try #require(option(screen, .soniox)?.setup, "\(language)")
      #expect(setup.steps.map(\.commands) == [[], ["rarog dictation set-key", "rarog restart"]], "\(language)")
      #expect(setup.steps.first?.text.contains("console.soniox.com") == true, "\(language)")
      #expect(setup.linkURL == ProviderLinks.sonioxConsole)
      #expect(setup.texts.allSatisfy { screen.texts.contains($0) }, "\(language): the steps are screen texts")
      #expect(option(screen, .system)?.setup == nil)
    }
  }

  @Test("arkusz „Dyktowanie” to formularz: zastępuje okno, okno nie wchodzi w jego miejsce, drugie otwarcie go nie buduje")
  func sheet() throws {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.openDiff(sessionId: "s1", path: nil)
    navigation.openDictation()
    let request = try #require(navigation.dictationSheet)
    let sheet = try #require(navigation.sheet)
    #expect(sheet.isForm && !sheet.isWindow && sheet.id == request.id, "formularz zastępuje okno diffa")
    navigation.openDiff(sessionId: "s1", path: nil)
    #expect(navigation.dictationSheet == request, "okno nie wchodzi w miejsce arkusza wyboru")
    navigation.openDictation()
    #expect(navigation.dictationSheet == request, "drugie stuknięcie przy otwartym arkuszu nie buduje go od nowa")
    navigation.closeSheet(id: request.id)
    #expect(navigation.sheet == nil && navigation.dictationSheet == nil)
  }
}
