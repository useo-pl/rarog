import MetricKit
import RarogActivity
import RarogCore
import RarogIroh
import RarogTerminal
import RarogTransport
import RarogUI
import SwiftUI

/// Apka tylko skleja: serwer z klucza w Keychainie, koordynator tunelu (transport serwera przez
/// iroh albo HTTPS), klient rejestru relaya iroh (`RelayAccessWiring`), katalog kolejki, magazyn rdzenia, faza sceny,
/// zmiana sieci, raport awarii, powiadomienia (delegat apki, adres `rarog://`), praca w tle zbiorcza Live Activity
/// (ActivityKit przez `LiveActivityController`) i renderer terminala (SwiftTerm z `RarogTerminal`). Ekrany mieszkają
/// w `RarogUI`, stan i reguły w `RarogCore`. Scena i zmiana sieci idą najpierw do koordynatora, potem do magazynu.
/// The scene then goes to the locked-phone monitor (`LockedPhoneMonitor`). The voice Live Activity
/// (`VoiceActivityController`) follows the app's microphone under the locked-phone trial.
@main
struct RarogApp: App {
  /// Token APNs i powiadomienia: `AppDelegate` → `PushInbox` → magazyn.
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var store: RarogStore
  /// Jeden na proces: dzierżawa endpointu iroh i runtime tunelu bieżącej tożsamości serwera.
  @State private var tunnel: TunnelCoordinator
  /// The locked-phone monitor: the server connection held for what records, and its `client.log` lines.
  @State private var lockedPhone: LockedPhoneMonitor
  /// The voice Live Activity of the locked-phone trial and the handler of its End button.
  @State private var voiceActivity: VoiceActivityController
  @State private var network = NetworkMonitor()
  @State private var diagnostics: CrashDiagnostics
  /// The MetricKit subscriber and the network monitor are on: the root's first `.task` ran.
  @State private var launched = false
  /// Zaparkowane ekrany terminala: zejście z taba albo zamknięte okno Cmd+F/Cmd+G czeka do 2 min.
  @State private var terminalParking: TerminalScreenParking
  @Environment(\.scenePhase) private var scenePhase

  init() {
    AppEnvironment.resetForUITestsIfAsked()
    // Klucz urządzenia z Keychaina wybiera serwer; bez klucza — ekran parowania. Dane apki leżą w przestrzeni
    // serwera (`ServerSpaces`). Zmiana serwera po parowaniu nie przebudowuje magazynu: podmienia transport
    // i przestrzeń.
    let logs = TunnelLogRelay()
    // One iroh identity store for the endpoint and the relay registry client: the same key, written once.
    let identities = IrohIdentityStore(keychain: AppEnvironment.irohIdentityKeychain())
    let relayAccess = RelayAccessWiring.live(
      identities: identities, makeSigner: { secretKey in try IrohSigner(secretKey: secretKey) }, log: logs.send)
    let tunnel = TunnelCoordinator(
      label: AppEnvironment.clientLabel, build: AppEnvironment.build(), transport: IrohTunnelTransport(),
      identities: identities, relayAccess: relayAccess, log: logs.send)
    let store = RarogStore.live(
      connector: RelayAccessWiring.connect(AppEnvironment.connector(coordinator: tunnel), to: relayAccess),
      preferences: UserDefaults.standard, spaces: AppEnvironment.spaces())
    logs.attach { line in Task { @MainActor in store.trace(line, budget: .connectivity) } }
    // The registry client's statuses for the Server screen, then T-start; the store's first server list went to the
    // client while the store was built (`TunnelCoordinator.transport`).
    RelayAccessWiring.start(relayAccess) { status in store.relayAccessChanged(status) }
    // Prace w tle z `needsServer` trzymają generację tunelu (koordynator), pozostałe tylko czas systemu. Tym samym
    // adapterem koordynator trzyma czas systemu na łaskę tunelu po zejściu w tło.
    let background = UIKitBackgroundWork(observer: tunnel)
    tunnel.attach(background)
    store.attachSystem(push: UIKitPushSystem(), background: background, preferences: UserDefaults.standard)
    // Live Activity: reguły w rdzeniu, ActivityKit w adapterze.
    store.attachActivities(LiveActivityController())
    // Dyktowanie: wybór na tym urządzeniu i flaga builda `RAROG_VOICE_SONIOX`; trasę liczy rdzeń.
    store.attachDictation(AppEnvironment.dictation())
    // Agent głosowy: zgoda i głos na tym urządzeniu; klucz OpenAI i model ma serwer.
    store.attachVoiceAgent(AppEnvironment.voiceAgent())
    // After the voice agent settings: the monitor reads the trial switch from them.
    let lockedPhone = LockedPhoneMonitor.live(store: store) { [tunnel] on in tunnel.holdForVoice(on) }
    // Also after the voice agent settings (the trial switch); ends the voice activities left from an earlier process.
    let voiceActivity = VoiceActivityController.live(store: store)
    voiceActivity.start()
    EndVoiceActivityIntent.handler = { [voiceActivity] in await voiceActivity.endFromLiveActivity() }
    #if DEBUG
    // Testy UI przeciw demo: serwer demo nie ma kanału APNs, a baner „Włącz" i push próbny trzeba przeklikać.
    if ProcessInfo.processInfo.environment[AppEnvironment.testPushKey] == "1" { store.simulateApnsChannelForUITests() }
    // Sonda testów UI: pierwszy respondent, Esc łańcuchem respondentów, promień rogu prezentacji (`UITestProbe`).
    UITestProbe.installIfAsked()
    #endif
    PushInbox.shared.attach(store)
    // The app's text size (⌘+, ⌘-, ⌘0) goes on the scene as it connects, before the first frame.
    TextScaleScenes.start()
    _store = State(initialValue: store)
    _tunnel = State(initialValue: tunnel)
    _lockedPhone = State(initialValue: lockedPhone)
    _voiceActivity = State(initialValue: voiceActivity)
    _diagnostics = State(initialValue: CrashDiagnostics(store: store))
    _terminalParking = State(initialValue: TerminalScreenParking(store: store))
  }

  var body: some Scene {
    WindowGroup {
      RarogRootView(store: store)
        // Inny serwer albo „Zapomnij serwer”: dane poprzedniego serwera zniknęły z dysku, a interfejs trzymał
        // je w pamięci (szkice, nawigacja, notatki) — buduje się od nowa.
        .id(store.interfaceEpoch)
        // Renderer terminala: `RarogUI` zna tylko protokół `TerminalSurface`, SwiftTerm wnosi
        // pakiet `RarogTerminal`. Bez fabryki ekran terminala mówi „Terminal jest teraz niedostępny.".
        .environment(\.terminalSurfaceFactory, SwiftTermSurface.factory)
        // Parking ekranów terminala przy magazynie: bez niego każde zejście z terminala zamyka gniazdo.
        .environment(\.terminalScreenParking, terminalParking)
        .preferredColorScheme(testColorScheme)
        // Runs again whenever the root comes back (a full-screen cover over it closes, a new `interfaceEpoch`): the
        // process-wide parts start in the first run only, and `store.start()` takes effect once.
        .task {
          if !launched {
            launched = true
            MXMetricManager.shared.add(diagnostics)
            network.start(log: { [store] line in store.trace(line, budget: .connectivity) }) { [tunnel, store] in
              tunnel.networkChanged()
              store.reconnectNow()
            }
          }
          await store.start()
        }
        // `rarog://session/<id>`, `rarog://terminal/<termId>?session=<id>` (UI tests: the notification path),
        // `rarog://jump/<kind>` and `rarog://list` (the Live Activity tally and background), `rarog://pair#…` and the
        // universal link `https://rarog.ai/pair#…` (the `applinks:` entitlement): a pairing link from `rarog pair` or
        // from a paired device — always the confirmation sheet.
        .onOpenURL { url in
          if let link = PushRouting.link(url: url) { store.openLink(link) }
        }
        // Keychain czytelny dopiero po pierwszym odblokowaniu telefonu: start czekający na klucz rusza teraz.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
          tunnel.protectedDataBecameAvailable()
          store.protectedDataBecameAvailable()
        }
    }
    .onChange(of: scenePhase) { _, phase in
      let next = RarogCore.ScenePhase(phase)
      tunnel.scene(next)
      store.setScenePhase(next)
      lockedPhone.scene(next)
    }
    .commands { RarogCommands(store: store) }
  }

  /// Jawny motyw wyłącznie w Debug i tylko w procesie uruchomionym przeciw demo.
  /// iOS ignoruje macOS-owy launch argument AppleInterfaceStyle.
  private var testColorScheme: ColorScheme? {
    #if DEBUG
    let environment = ProcessInfo.processInfo.environment
    guard environment[AppEnvironment.testBaseURLKey] != nil else { return nil }
    switch environment["RAROG_UI_TEST_THEME"] {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
    #else
    return nil
    #endif
  }
}
