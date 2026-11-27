import Foundation
import RarogCore
import RarogTransport
import RarogUI
import UIKit

/// Konfiguracja apki: serwer wyłącznie z klucza urządzenia (Keychain; bez klucza — ekran parowania, logowania
/// tokenem apka nie ma), build z `CFBundleVersion` (UA `RarogApp/<build>`, porównanie
/// z `hello.minClientBuild`) i etykieta urządzenia z parowania, widoczna przy rozstrzygnięciu decyzji i na liście
/// urządzeń serwera.
enum AppEnvironment {
  /// Grupy Keychaina z Info.plist (`$(AppIdentifierPrefix)` rozwija build): prywatna apki i wspólna z NSE.
  nonisolated static let keychainGroupKey = "RarogKeychainGroup"
  nonisolated static let keychainSharedGroupKey = "RarogKeychainSharedGroup"
  /// Tryb testów UI (tylko build Debug): adres serwera demo na loopbacku. Apka łączy się z nim wyłącznie przez link
  /// parowania z testu (`DemoServer.pair`); zmienna sama zaznacza proces testu (motyw).
  static let testBaseURLKey = "RAROG_UI_TEST_BASE_URL"
  /// Tryb testów UI: start bez klucza urządzenia i bez kolejki z poprzedniego przebiegu.
  static let testResetKey = "RAROG_UI_TEST_RESET"
  /// Tryb testów UI: kanał APNs udawany po stronie apki (demo go nie ma) — baner „Włącz" i push próbny.
  static let testPushKey = "RAROG_UI_TEST_PUSH"
  /// UI test mode, with the reset: the app's text size step stored at launch.
  static let testTextSizeKey = "RAROG_UI_TEST_TEXT_SIZE"
  /// Flaga builda `RAROG_VOICE_SONIOX` w Info.plist (`$(RAROG_VOICE_SONIOX)`): `YES` = trasa Soniox przez serwer
  /// użytkownika jest w apce; `NO` = tylko dyktowanie systemowe (wyjście awaryjne, gałąź powrotu).
  static let voiceSonioxKey = "RarogVoiceSoniox"

  static func build(bundle: Bundle = .main) -> Int {
    Int(bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
  }

  /// Etykieta urządzenia (`POST /api/pair`, rejestracja push): nazwa produktu po kropce. To identyfikator
  /// rekordu na liście urządzeń, nie copy.
  static var clientLabel: String {
    UIDevice.current.userInterfaceIdiom == .pad ? "iPad·Rarog" : "iPhone·Rarog"
  }

  /// Keychain z grupami z Info.plist. Nierozwinięta zmienna (`$(…)`) = grupa domyślna procesu. `nonisolated`: delegat
  /// powiadomień czyta nim klucz push poza głównym aktorem (`PushRouting.inspect`); sam odczyt Info.plist.
  nonisolated static func keychain(bundle: Bundle = .main) -> SystemKeychain {
    func group(_ key: String) -> String? {
      guard let value = bundle.object(forInfoDictionaryKey: key) as? String, !value.isEmpty, !value.contains("$(")
      else { return nil }
      return value
    }
    return SystemKeychain(appGroup: group(keychainGroupKey), sharedGroup: group(keychainSharedGroupKey))
  }

  /// Wpis tożsamości iroh urządzenia: grupa prywatna apki, jak klucz urządzenia.
  nonisolated static func irohIdentityKeychain(bundle: Bundle = .main) -> SystemIrohIdentityKeychain {
    SystemIrohIdentityKeychain(group: keychain(bundle: bundle).appGroup)
  }

  /// Wejście rdzenia do Keychaina i fabryk transportu: transport sparowanego serwera, transport parowania
  /// i jednorazowy transport odpięcia składa koordynator tunelu (jeden na proces).
  @MainActor
  static func connector(coordinator: TunnelCoordinator, bundle: Bundle = .main) -> ServerConnector {
    ServerConnector(
      keychain: keychain(bundle: bundle), label: clientLabel, build: build(bundle: bundle),
      transport: { endpoint, rules in coordinator.transport(endpoint, rules) },
      pairing: { target in coordinator.pairing(target) },
      forgetTransport: { endpoint, rules in coordinator.forgetTransport(endpoint, rules) },
      release: { endpoint in coordinator.release(endpoint) },
      credentialChanged: { endpoint in coordinator.credentialChanged(endpoint) },
      wipeAppData: {
        // Niewysłane załączniki z półki (pamięć procesu) należą do serwera, z którym apka już nie rozmawia;
        // szkice na dysku leżą w jego przestrzeni (`ServerSpaces`), której nikt już nie czyta.
        AttachmentShelf.shared.removeAll()
      })
  }

  /// Przestrzenie danych per serwer: `Application Support/servers/<przestrzeń>/` i kosz
  /// `Application Support/servers-trash/`.
  static func spaces() -> ServerSpaces {
    let base = ApplicationSupport.url
    return ServerSpaces(
      root: base.appending(path: "servers", directoryHint: .isDirectory),
      trash: base.appending(path: "servers-trash", directoryHint: .isDirectory))
  }

  /// Wybór dyktowania i flaga builda dla magazynu (`RarogStore.attachDictation`). Wybór należy do urządzenia:
  /// `UserDefaults` apki, nie przestrzeń serwera. Build Debug w trybie testów UI (`RAROG_UI_TEST_DICTATION`,
  /// `RAROG_UI_TEST_VOICE`) trzyma wybór w pamięci, nigdy w prawdziwych `UserDefaults` (`DictationTestMode`).
  static func dictation(
    bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment,
    defaults: UserDefaults = .standard
  ) -> DictationServices {
    let allowed = DictationServices.sonioxAllowed(info: bundle.object(forInfoDictionaryKey: voiceSonioxKey))
    #if DEBUG
    if let services = DictationTestMode.services(environment: environment, sonioxAllowed: allowed) { return services }
    #endif
    return .live(sonioxAllowed: allowed, defaults: defaults)
  }

  /// Testy UI startują z czystym stanem: bez klucza urządzenia, bez przestrzeni danych (kolejka, szkice pól i notatek,
  /// lista z pamięci) i bez stanu listy i prawego panelu z poprzedniego przebiegu (zwinięte projekty, otwarty panel
  /// i zwinięta lista).
  static func resetForUITestsIfAsked(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    irohIdentity: any IrohIdentityKeychain = irohIdentityKeychain(),
    relayAccess: () -> Void = { _ = SystemRelayAccessStore(group: keychain().appGroup, log: { _ in }).deleteAll() }
  ) {
    #if DEBUG
    guard environment[testResetKey] == "1" else { return }
    let spaces = spaces()
    // Przestrzenie: szkic notatki z poprzedniego testu nie zmienia ikony następnemu.
    for url in [spaces.root, spaces.trash] { try? FileManager.default.removeItem(at: url) }
    // Klucz urządzenia i jego ślady: test zaczyna niesparowany i paruje z demo (`DemoServer.pair`). Keychain
    // przeżywa reinstalację apki, więc bez tego klucz z poprzedniego przebiegu wracałby do następnej klasy testów.
    keychain().delete(deviceId: nil)
    // Tożsamość iroh też przeżywa reinstalację: test zaczyna z nowym kluczem endpointu, jak nowe urządzenie.
    irohIdentity.delete()
    // The relay registry client's items go with the identity: an opt-out left by a previous run would send
    // `forget` for the new key to that run's registry.
    relayAccess()
    for key in [RarogStore.revokedKey, RarogStore.preferencesSpaceKey] + NavigationPreferences.serverScoped {
      UserDefaults.standard.removeObject(forKey: key)
    }
    UserDefaults.standard.removeObject(forKey: NavigationPreferences.collapsedProjects)
    // Prawy panel: test pamięci po ponownym uruchomieniu startuje BEZ resetu.
    UserDefaults.standard.removeObject(forKey: NavigationPreferences.inspectorOpen)
    // Zwinięte drzewo zmian: test, który je zwinął i padł, nie zostawia następnym panelu bez plików.
    UserDefaults.standard.removeObject(forKey: NavigationPreferences.inspectorChangesCollapsed)
    // A panel widened by a previous run would not start at the default width.
    UserDefaults.standard.removeObject(forKey: NavigationPreferences.inspectorWidth)
    // The Files section starts on Files with `.*` off: a test that switched them and failed leaves the next one the tree.
    UserDefaults.standard.removeObject(forKey: InspectorFilesPreferences.mode)
    UserDefaults.standard.removeObject(forKey: InspectorFilesPreferences.regex)
    // Zwinięcie listy (Cmd+B, przycisk, system w pionie): test, który zwinął listę i padł przed jej rozwinięciem,
    // zostawiałby ją zwiniętą następnym klasom (`testListToggleKeepsPlace` po panelu).
    UserDefaults.standard.removeObject(forKey: NavigationPreferences.listCollapsed)
    // Wybór dyktowania: następne stuknięcie mikrofonu otwiera ekran „Dyktowanie”, jak na nowym urządzeniu.
    DictationTestMode.reset(defaults: .standard)
    // Agent głosowy: bez zgody i z domyślnym głosem.
    for key in VoiceAgentPreferences.keys { UserDefaults.standard.removeObject(forKey: key) }
    // Shortcuts changed in Settings: every test starts with ⌥⌘M and ⌥⌘V.
    for key in AppShortcutSettings.keys { UserDefaults.standard.removeObject(forKey: key) }
    // The app's text size (⌘+, ⌘-): every test starts with the system's size, or with the step it asks for
    // (`RAROG_UI_TEST_TEXT_SIZE`, the raw value of a standard `TextSizeCategory`).
    UserDefaults.standard.removeObject(forKey: TextScale.key)
    if let size = environment[testTextSizeKey] { UserDefaults.standard.set(size, forKey: TextScale.key) }
    // Transcript width chosen in Settings: every test starts with the readable width.
    UserDefaults.standard.removeObject(forKey: TranscriptWidth.key)
    // Transcript spacing chosen in Settings: every test starts with the standard spacing.
    UserDefaults.standard.removeObject(forKey: TranscriptDensity.key)
    #endif
  }

  /// Ustawienia agenta głosowego dla magazynu (`RarogStore.attachVoiceAgent`): zgoda i głos w `UserDefaults` apki.
  /// The device class of the background rule comes from here: an iPad and the app on a Mac show no Live Activity
  /// tiles, so there the screen lock, not the tile, ends a recording in the background. Not from
  /// `areActivitiesEnabled`: an iPhone with Live Activities off ends a recording in the background as at a refused
  /// tile.
  @MainActor
  static func voiceAgent(defaults: UserDefaults = .standard) -> VoiceAgentSettings {
    let noTiles = UIDevice.current.userInterfaceIdiom == .pad || ProcessInfo.processInfo.isiOSAppOnMac
    return .live(defaults: defaults, noTiles: noTiles)
  }
}

/// `Application Support` kontenera apki (bez zakładania — `ServerSpaces.prepare` zakłada swoje katalogi).
enum ApplicationSupport {
  static var url: URL {
    (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? FileManager.default.temporaryDirectory
  }
}
