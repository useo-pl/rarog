import Foundation
import RarogContract
import RarogTransport

// Powiadomienia APNs apki natywnej: token urządzenia, rejestracja na serwerze ze stanem zgody,
// baner „Włącz" z pushem próbnym, status tokenu (degradacja), plakietka na wierzchu, cel tapnięcia
// i wyrejestrowanie przy wylogowaniu. Właściciel: push. System (UIKit) wchodzi przez
// `PushSystem` i `BackgroundWork` (`PushSystem.swift`); rdzeń zostaje bez UIKit.
//
// Kiedy apka się rejestruje (przy starcie i powrocie z tła, adres urządzenia może się zmienić):
// cykl zakłada zalogowanie z kluczem przy starcie, po parowaniu i powrót z tła; nowy token i zmiana
// zgody dokładają rejestrację. Żądanie wychodzi dopiero przy żywym strumieniu i świeżej liście — wtedy
// bramka mutacji (`MutationRules`) go nie odrzuci, a po uśpieniu sieć już jest.

/// Rytm powiadomień — wstrzykiwany (testy podają milisekundy).
public struct PushTiming: Sendable, Equatable {
  /// Tyle po zgodzie apka czeka na push próbny, zanim powie „Push próbny nie dotarł".
  public var testWait: Duration
  /// „×" na banerze „Włącz" odkłada go na tyle (tydzień).
  public var snooze: TimeInterval

  public init(testWait: Duration = .seconds(15), snooze: TimeInterval = 7 * 24 * 3600) {
    self.testWait = testWait
    self.snooze = snooze
  }
}

/// Księgowość powiadomień (pole magazynu `pushRuntime`).
struct PushRuntime {
  var system: (any PushSystem)?
  var background: (any BackgroundWork)?
  var preferences: (any PreferenceStore)?
  var timing = PushTiming()
  /// Token urządzenia (hex). Otrzymany przed zalogowaniem czeka na nie.
  var token: String?
  /// Token, który serwer PRZYJĄŁ w tym zalogowaniu (204 albo 429 na `POST /api/push/apns`) — dopiero
  /// z nim token Live Activity nie dostanie 409 `apns-device-unknown`.
  var registeredToken: String?
  /// Rejestracja do wysłania przy najbliższej okazji (cykl, nowy token, zmiana zgody).
  var needsRegistration = false
  /// „Włącz" czeka na rejestrację z pushem próbnym.
  var wantsTest = false
  /// Rejestracja padła (sieć, 5xx, bramka): ponowienie przy NASTĘPNYM połączeniu strumienia listy — nie
  /// przy każdej ramce, bo serwer, który odmawia, dostawałby żądanie co ramkę.
  var retryAfterReconnect = false
  var registering: Task<Void, Never>?
  var statusRead: Task<Void, Never>?
  var authorizationRead: Task<Void, Never>?
  var testWatch: Task<Void, Never>?
  /// Ostatnia liczba wysłana na plakietkę (bez powtórzeń przy każdej ramce).
  var lastBadge: Int?
  /// Para (token, środowisko) z ostatniego śladu rejestracji w `client.log`: linia tylko przy zmianie pary
  /// w tym procesie (start, nowy token), nie przy każdym powrocie z tła (budżet śladów 20/h).
  var tracedRegistration: TracedRegistration?
}

/// Para z ostatniego śladu rejestracji APNs (``PushRuntime/tracedRegistration``).
struct TracedRegistration: Equatable {
  let token: String
  let environment: ApnsEnvironment
}

extension RarogStore {
  /// Klucz preferencji: do kiedy baner „Włącz" jest odłożony (sekundy epoki).
  static let pushSnoozeKey = "rarog.push.snoozedUntil"

  /// Rytm powiadomień; testy podmieniają go przed `start()`.
  public var pushTiming: PushTiming {
    get { pushRuntime.timing }
    set { pushRuntime.timing = newValue }
  }

  /// Wpina system powiadomień i pracę w tle. Apka woła RAZ, przed `start()`.
  public func attachSystem(push: any PushSystem, background: any BackgroundWork, preferences: any PreferenceStore) {
    pushRuntime.system = push
    pushRuntime.background = background
    pushRuntime.preferences = preferences
    let raw = preferences.data(forKey: Self.pushSnoozeKey).flatMap { try? JSONDecoder().decode(Double.self, from: $0) }
    if let raw { dispatch(.push(.snoozed(until: Date(timeIntervalSince1970: raw)))) }
  }

  // MARK: - Wejścia z systemu

  /// Token z `didRegisterForRemoteNotificationsWithDeviceToken`. Przed zalogowaniem czeka; nowy token
  /// po zalogowaniu to upsert na serwerze.
  public func deviceTokenReceived(_ token: Data) {
    let hex = PushRouting.hex(token)
    guard !hex.isEmpty else { return }
    if hex != pushRuntime.token {
      pushRuntime.needsRegistration = true
      pushRuntime.registeredToken = nil
    }
    pushRuntime.token = hex
    attemptPushRegistration()
  }

  /// `didFailToRegisterForRemoteNotifications`: jedna linia bez szczegółów; „Włącz" w toku kończy się
  /// zdaniem o porażce zamiast czekać na push próbny, który nie przyjdzie.
  public func deviceTokenFailed() {
    reportUnhandled("push: rejestracja nieudana")
    guard pushRuntime.wantsTest else { return }
    pushRuntime.wantsTest = false
    finishTest(.failed)
  }

  /// Push odebrany NA WIERZCHU (`willPresent`; banera system wtedy nie pokazuje). Próbny = dowód, że
  /// kanał działa: dymek „Powiadomienia działają", jedyne jego źródło. Push próbny v3 dowodzi dostawy
  /// i odszyfrowania (w NSE albo w apce), nie samego NSE — źródło mówi linia `client.log`.
  public func pushReceived(_ note: PushNote) {
    tracePush(note, tapped: false)
    // Nowe urządzenie na serwerze: lista od razu, notka „Nowe urządzenie” bez czekania na `hello`.
    if note.kind == .devicePaired { refreshDevices() }
    guard note.kind == .test else { return }
    finishTest(.working)
  }

  /// A tap on a notification (also the one that launched the app): `device-paired` and `version-changed` open their
  /// Settings screen (``PushNote/opensSettings``) without waiting for the session list, the rest the session target
  /// (``openPushTarget(_:)``); without a target, just the app.
  /// `weekly-limit` opens the session list through the Live Activity background link (``openLink(_:)``,
  /// `.list`): it waits for login and a fresh list.
  public func pushTapped(_ note: PushNote) {
    tracePush(note, tapped: true)
    if let screen = note.opensSettings {
      openSettingsScreen(screen)
    } else if note.opensList {
      openLink(.list)
    } else if let target = note.target {
      openPushTarget(target)
    }
  }

  /// Push v3, którego apka nie otworzy (``PushInspection/unreadableV3(_:)``), na wierzchu albo tapnięty: tylko linia
  /// `client.log` z powodem — bez celu i bez rozstrzygania „Włącz” (dymek dalej czeka na próbny, który apka
  /// przeczyta, albo na upływ czasu). Odróżnia „push dotarł, apka go nie otworzyła” od „delegat nic nie dostał”.
  public func pushUnreadable(_ reason: PushRefusal, tapped: Bool) {
    trace("push: \(tapped ? "tap" : "na wierzchu") — v3 nieczytelne: \(reason)")
  }

  /// Tap w powiadomienie albo adres `rarog://session/<id>`: cel czeka na zalogowanie i świeżą listę
  /// (``AppState/readyPushTarget``), potem wchodzi nawigacja.
  public func openPushTarget(_ target: PushTarget) {
    dispatch(.push(.target(target)))
  }

  /// Nawigacja weszła w cel.
  public func consumePushTarget(_ target: PushTarget) {
    dispatch(.push(.targetConsumed(target)))
  }

  /// Adres `rarog://` (tap w kafel Live Activity, testy UI): sesja idzie drogą powiadomienia, liczba i tło kafla
  /// czekają na świeżą listę (``AppState/readyLink``).
  public func openLink(_ link: AppLink) {
    switch link {
    case let .session(target): openPushTarget(target)
    case let .jump(kind): dispatch(.push(.link(.jump(kind))))
    case .list: dispatch(.push(.link(.list)))
    // Parowanie: arkusz potwierdzenia; zły link — arkusz z odmową zamiast cichego „nic”.
    case let .pair(pairing): offerPairing(pairing)
    case let .badPair(error): rejectPairingLink(error)
    }
  }

  /// Nawigacja weszła w link z kafla.
  public func consumeLink(_ link: PendingLink) {
    dispatch(.push(.linkConsumed(link)))
  }

  /// Testy UI przeciw demo: serwer demo nie ma kanału APNs, a baner „Włącz" i push próbny (krok hosta
  /// `simctl push`) trzeba przeklikać. Apka woła to wyłącznie w buildzie Debug przy `RAROG_UI_TEST_PUSH=1`.
  public func simulateApnsChannelForUITests() {
    dispatch(.push(.simulatedChannel))
  }

  // MARK: - Baner „Włącz powiadomienia"

  /// „Włącz": systemowe pytanie o zgodę, potem rejestracja z pushem próbnym. Dymek sukcesu dopiero
  /// po ODEBRANYM pushu próbnym, nie po 204 (serwer przyjął ≠ urządzenie dostało).
  public func enablePush() async {
    guard state.auth == .loggedIn, let system = pushRuntime.system, !state.push.enabling else { return }
    let login = currentLogin
    dispatch(.push(.enabling(true)))
    let result = await system.requestAuthorization()
    guard isCurrentLogin(login) else { return }
    dispatch(.push(.enabling(false)))
    applyAuthorization(result)
    switch result {
    case .authorized:
      pushRuntime.wantsTest = true
      startTestWatch()
      // Token mógł nie przyjść (pierwsze uruchomienie, błąd systemu) — prośba jest tania i idempotentna.
      if pushRuntime.token == nil { system.registerForRemoteNotifications() }
      attemptPushRegistration()
    case .denied:
      // Token zostaje (Live Activity): rejestracja z `alerts: false`, nie wyrejestrowanie.
      dispatch(.push(.notice(.denied)))
      attemptPushRegistration()
    case .notDetermined:
      break
    }
  }

  /// „×": baner wraca po tygodniu (`PushTiming.snooze`), także po zabiciu apki.
  public func snoozePushPrompt() {
    let until = areaNow.addingTimeInterval(pushRuntime.timing.snooze)
    if let data = try? JSONEncoder().encode(until.timeIntervalSince1970) {
      pushRuntime.preferences?.set(data, forKey: Self.pushSnoozeKey)
    }
    dispatch(.push(.snoozed(until: until)))
  }

  // MARK: - Cykl (woła rdzeń)

  /// Zalogowanie (start z kluczem, parowanie, ponowienie klucza): token z systemu, odczyt zgody, rejestracja.
  func pushLoggedIn() {
    guard let system = pushRuntime.system else { return }
    pushRuntime.needsRegistration = true
    pushRuntime.lastBadge = nil
    system.registerForRemoteNotifications()
    readPushAuthorization()
  }

  /// Powrót z tła: zgoda mogła się zmienić w Ustawieniach, wpis na serwerze mógł zniknąć (410, LRU),
  /// a push w tle przestawił plakietkę (`aps.badge`) — ta sama liczba sesji musi wyjść drugi raz.
  func pushReturnedToForeground() {
    guard state.auth == .loggedIn, pushRuntime.system != nil else { return }
    pushRuntime.needsRegistration = true
    pushRuntime.lastBadge = nil
    readPushAuthorization()
  }

  /// Strumień listy właśnie się otworzył: rejestracja, która padła w poprzednim połączeniu, idzie znowu
  /// (wyjdzie po pełnym stanie listy tego połączenia).
  func pushConnectionOpened() {
    guard pushRuntime.retryAfterReconnect else { return }
    pushRuntime.retryAfterReconnect = false
    pushRuntime.needsRegistration = true
  }

  /// Wylogowanie (`handleUnauthorized`): zadania w drodze anulowane, token oddany systemowi. Trasa
  /// `…/apns/unregister` stoi za kluczem, który właśnie odmówił — serwer dowie się od APNs (410
  /// przy następnej wysyłce kasuje wpis). Do tego czasu urządzenie i tak niczego nie pokaże.
  /// `unregister: false` (przełączenie poświadczenia po parowaniu): token zostaje w systemie i wraca
  /// rejestracją nowego transportu — z kluczem urządzenia, bo tylko taki wpis dostaje push `device-paired`.
  func forgetPush(unregister: Bool = true) {
    pushRuntime.registering?.cancel()
    pushRuntime.statusRead?.cancel()
    pushRuntime.authorizationRead?.cancel()
    pushRuntime.testWatch?.cancel()
    pushRuntime.registering = nil
    pushRuntime.statusRead = nil
    pushRuntime.authorizationRead = nil
    pushRuntime.testWatch = nil
    pushRuntime.needsRegistration = false
    pushRuntime.wantsTest = false
    pushRuntime.retryAfterReconnect = false
    pushRuntime.registeredToken = nil
    guard unregister else { return }
    pushRuntime.token = nil
    guard let system = pushRuntime.system else { return }
    system.unregisterForRemoteNotifications()
    pushRuntime.lastBadge = 0
    system.setBadgeCount(0)
  }

  /// Po każdej ramce globalnej i każdej zmianie, która mogła odblokować rejestrację.
  func attemptPushRegistration() {
    guard pushRuntime.needsRegistration || pushRuntime.wantsTest, pushRuntime.registering == nil,
      let system = pushRuntime.system, let token = pushRuntime.token,
      let authorization = state.push.authorization, pushRequestsReady
    else { return }
    let test = pushRuntime.wantsTest
    pushRuntime.needsRegistration = false
    pushRuntime.wantsTest = false
    let login = currentLogin
    let transport = transport
    let environment = system.environment
    let topic = system.topic
    let alerts = authorization == .authorized
    // Dowód reguły środowiska APNs z urządzenia: środowisko i profil, z którego wyszło — bez tokenu.
    let pair = TracedRegistration(token: token, environment: environment)
    if pushRuntime.tracedRegistration != pair {
      pushRuntime.tracedRegistration = pair
      trace("push: rejestracja APNs — środowisko \(environment.rawValue), profil: \(system.profile.rawValue)")
    }
    pushRuntime.registering = Task { [weak self] in
      let result: Result<Void, TransportError>
      do throws(TransportError) {
        try await transport.registerApns(
          token: token, environment: environment, topic: topic, alerts: alerts, test: test)
        result = .success(())
      } catch {
        result = .failure(error)
      }
      self?.finishPushRegistration(result, token: token, test: test, login: login)
    }
  }

  /// Plakietka na wierzchu po każdej zmianie stanu: tylko z listy bieżącego połączenia, bez
  /// powtórzeń. W tle liczbę niesie `aps.badge` z serwera.
  func syncPushBadge() {
    guard let system = pushRuntime.system, state.auth == .loggedIn, state.listLive, areaPhase != .background
    else { return }
    let count = state.badgeCount
    guard count != pushRuntime.lastBadge else { return }
    pushRuntime.lastBadge = count
    system.setBadgeCount(count)
  }

  /// Praca w tle przez adapter z `attachSystem` — jedyna droga do zadań w tle systemu, także dla RarogUI
  /// (dyktowanie, zapis notatki). `nil` bez adaptera albo przy odmowie systemu.
  public func beginBackgroundWork(_ name: String, needsServer: Bool) -> BackgroundWorkToken? {
    pushRuntime.background?.begin(name, needsServer: needsServer)
  }

  /// Koniec pracy; po wygaśnięciu (zadanie zamknął adapter) bez skutku.
  public func endBackgroundWork(_ token: BackgroundWorkToken?) {
    guard let token else { return }
    pushRuntime.background?.end(token)
  }

  /// Uchwyt pracy w tle wokół `visible: false`.
  func beginPresenceWork() -> BackgroundWorkToken? {
    beginBackgroundWork("rarog.presence", needsServer: true)
  }

  func endPresenceWork(_ token: BackgroundWorkToken?) {
    endBackgroundWork(token)
  }

  // MARK: - Wnętrze

  /// Jedna linia `client.log` o źródle rodzaju i celu: NSE, apka albo v1. Bez treści i bez id sesji.
  /// v3, którego apka nie otworzy: ``pushUnreadable(_:tapped:)``.
  private func tracePush(_ note: PushNote, tapped: Bool) {
    let moment = tapped ? "tap" : "na wierzchu"
    let kind = note.kind?.rawValue ?? "nieznany"
    let target = note.target == nil ? "bez celu" : "z celem"
    trace("push: \(moment) — źródło \(note.source.rawValue), rodzaj \(kind), \(target)")
  }

  /// Żywy strumień i lista tego połączenia: mutacja przejdzie przez bramkę, a sieć po uśpieniu już jest.
  /// `internal`: tę samą bramkę ma rejestracja tokenu Live Activity (`RarogStore+LiveActivity`).
  var pushRequestsReady: Bool {
    state.auth == .loggedIn && state.global == .online && state.compat == .ok && state.listLive
      && areaPhase != .background
  }

  private func finishPushRegistration(_ result: Result<Void, TransportError>, token: String, test: Bool, login: Int) {
    guard isCurrentLogin(login) else { return }
    pushRuntime.registering = nil
    switch result {
    case .success, .failure(.rateLimited):
      // 429 = push próbny był przed chwilą; rejestracja i tak się zapisała, a poprzedni
      // próbny może jeszcze dojść — dymek rozstrzyga odebrany push albo upływ czasu.
      readApnsStatus(token: token, login: login)
      // Token aktywności idzie DOPIERO po przyjętym urządzeniu (inaczej 409) — i to tym samym tokenem.
      if token == pushRuntime.token {
        pushRuntime.registeredToken = token
        liveActivityDeviceRegistered()
      }
    case .failure(.unauthorized):
      handleUnauthorized(since: login)
      return
    case .failure(.cancelled):
      return
    case .failure:
      pushRuntime.retryAfterReconnect = true
      if test { finishTest(.failed) }
    }
    // Nowy token albo zmiana zgody w trakcie żądania: druga rejestracja z aktualnym stanem.
    attemptPushRegistration()
  }

  private func readApnsStatus(token: String, login: Int) {
    pushRuntime.statusRead?.cancel()
    let transport = transport
    pushRuntime.statusRead = Task { [weak self] in
      let result: Result<ApnsStatus, TransportError>
      do throws(TransportError) {
        result = .success(try await transport.apnsStatus(token: token))
      } catch {
        result = .failure(error)
      }
      guard let self, self.isCurrentLogin(login), !Task.isCancelled else { return }
      self.pushRuntime.statusRead = nil
      switch result {
      case let .success(status):
        // Bez kanału (`enabled: false`) status nic nie mówi — baneru degradacji nie ma.
        self.dispatch(.push(.status(
          enabled: status.enabled, degradedSince: status.degradedSince, reason: status.degradedReason)))
      case .failure(.unauthorized):
        self.handleUnauthorized(since: login)
      case .failure:
        break
      }
    }
  }

  private func readPushAuthorization() {
    guard let system = pushRuntime.system else { return }
    pushRuntime.authorizationRead?.cancel()
    let login = currentLogin
    pushRuntime.authorizationRead = Task { [weak self] in
      let value = await system.authorization()
      guard let self, self.isCurrentLogin(login), !Task.isCancelled else { return }
      self.pushRuntime.authorizationRead = nil
      self.applyAuthorization(value)
      self.attemptPushRegistration()
    }
  }

  /// Zmiana zgody to nowy stan `alerts` na serwerze i nowa szansa dla plakietki.
  private func applyAuthorization(_ value: PushAuthorization) {
    let previous = state.push.authorization
    dispatch(.push(.authorization(value)))
    guard previous != value else { return }
    if previous != nil { pushRuntime.needsRegistration = true }
    pushRuntime.lastBadge = nil
    syncPushBadge()
  }

  private func startTestWatch() {
    pushRuntime.testWatch?.cancel()
    let wait = pushRuntime.timing.testWait
    pushRuntime.testWatch = Task { [weak self] in
      try? await Task.sleep(for: wait)
      guard !Task.isCancelled else { return }
      self?.finishTest(.testMissing)
    }
  }

  /// Rozstrzygnięcie „Włącz": odebrany push próbny, porażka albo upływ czasu — jedno zdanie w dymku.
  private func finishTest(_ kind: PushNotice.Kind) {
    pushRuntime.testWatch?.cancel()
    pushRuntime.testWatch = nil
    dispatch(.push(.notice(kind)))
  }
}
