import Foundation
import RarogContract
import RarogTransport

// Parowanie z serwerem i klucz urządzenia w magazynie. Właściciel: parowanie.
//
// - Punkt końcowy (`ServerEndpoint`) wybiera apka przy starcie z Keychaina: klucz → serwer z klucza; brak klucza →
//   brak serwera (sam ekran parowania). Logowania tokenem apka nie ma.
// - Parowanie: link z QR, wklejenia albo adresu otwartego przez system → arkusz „Sparować z <host>?” → `POST /api/pair`
//   osobnym transportem pod adres z linku (bez poświadczeń, poza bramką zgodności) → zapis w Keychainie →
//   przełączenie transportu BEZ restartu procesu: wszystko, co należało do poprzedniego poświadczenia, zamyka
//   `retire`, nowy transport się loguje (`enterLoggedIn`).
// - Dane apki leżą w przestrzeni serwera (`RarogStore+Spaces`, `ServerSpaces`): parowanie z tym samym adresem
//   zostaje w niej, z INNYM serwerem i „Zapomnij serwer” — nowa przestrzeń, poprzednia do kosza.
// - One server per app: a link to another server (another full iroh key, or another origin for a link
//   without `k`) replaces the pairing only after "Replace" in the sheet, and the new key starts in an empty space.
// - 401 klucza: `device-revoked` kasuje klucz (tylko TEGO urządzenia — spóźnione 401 starego klucza nie rusza
//   nowego parowania) i zostawia trwały ekran odpięcia z datą i przyczyną; inne 401 klucz zostawiają.
// - Kod dla nowego urządzenia (`POST /api/pairings`, closing it: `DELETE /api/pairings`, one operation at a time),
//   lista urządzeń po każdym `hello` i notki o nowych.
// - Start z kluczem odtwarza wpis współdzielony klucza push dla rozszerzenia powiadomień (`restoreSharedPushKey`).

/// Księgowość obszaru (pole magazynu `serverRuntime`).
struct ServerRuntime {
  var connector: ServerConnector?
  var endpoint: ServerEndpoint = .none
  /// Keychain był nieczytelny przy starcie (telefon przed pierwszym odblokowaniem): start czeka.
  var awaitingKeychain = false
  /// Numer próby parowania — spóźniony wynik odwołanej próby nic nie zmienia.
  var pairingAttempt = 0
  var issue: Task<Void, Never>?
  /// The last pairing code operation (issue or cancel); the next one waits for it, so they run one after another.
  var codeOperations: Task<Void, Never>?
  /// Number of the code the screen waits for: a POST answer with an older number (screen closed meanwhile) is dropped.
  var codeTicket = 0
  var devicesRead: Task<Void, Never>?
  /// Odpięcie, znacznik preferencji przestrzeni, znane urządzenia i notki (`UserDefaults` w apce, w testach w pamięci).
  var preferences: (any PreferenceStore)?
  /// Przestrzenie danych per serwer (`nil` = magazyn z katalogami z `init`, testy obszarów).
  var spaces: ServerSpaces?
  /// Kopia wskaźnika z dysku (`ServerSpaces.pointerFile`): czytana raz (`prepareSpaces`), zmieniana po zapisie na dysk.
  var pointer: ServerSpace?
  /// Wskaźnik przeczytany: do tej chwili (Keychain i pliki przed pierwszym odblokowaniem, dysk nie oddał pliku)
  /// magazyn nie wybiera przestrzeni i nic nie idzie do kosza.
  var spacesReady = false
  /// Przestrzeń, z której magazyn czyta teraz (`RarogStore+Spaces`).
  var space: ServerSpace?
  /// Czyje dane trzyma pamięć (nazwa przestrzeni albo serwer klucza sesji bez przestrzeni; `nil` = niczyje).
  var holder: String?
  /// Ile razy magazyn wszedł w inną przestrzeń — wpis kolejki zapisany w trakcie zmiany nie wraca do stanu.
  var spaceChanges = 0
  /// Urządzenie, które właśnie „zapomina” serwer. Serwer odpina je PRZED odpowiedzią 204 i zamyka jego strumienie,
  /// więc `device-revoked` w tym czasie to skutek własnej operacji, nie odpięcie z Maca.
  var forgettingDevice: String?
  /// `device-revoked` własnego „Zapomnij” przyszło przed odpowiedzią — klucz i transport już sprzątnięte.
  var forgetRevoked = false
  /// How long Forget Server waits for the server's answer before the local cleanup (`RarogStore+Forget`): one tunnel
  /// attempt, so an iroh tunnel still connecting after a return from the background gets through.
  var forgetLimit: Duration = TunnelMachine.attemptBudget
  /// The sleep of ``forgetLimit`` (tests: a virtual clock).
  var forgetSleep: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
  /// Relay registry steps of pairing over iroh and "Remove me from the registry" (`RarogStore+RelayAccess`).
  var relay = RelayPairingRuntime()
}

extension RarogStore {
  /// Odpięcie z ostatniego 401 `device-revoked` (JSON `DeviceRevocation`) — trwały ekran do następnego parowania.
  public nonisolated static let revokedKey = "rarog.server.revoked"

  static func knownDevicesKey(_ serverId: String) -> String { "rarog.devices.known.\(serverId)" }
  static func deviceNoticesKey(_ serverId: String) -> String { "rarog.devices.notices.\(serverId)" }

  /// Magazyn z prawdziwym Keychainem i fabrykami transportu: punkt końcowy z Keychaina (klucz → jego serwer),
  /// inaczej brak serwera; dane w przestrzeni serwera (`spaces`). Bramka (`MutationRules`) jedna na całe życie magazynu.
  public static func live(
    connector: ServerConnector, preferences: any PreferenceStore, spaces: ServerSpaces
  ) -> RarogStore {
    let rules = MutationRules()
    let read = connector.keychain.load()
    let endpoint: ServerEndpoint
    switch read {
    case let .found(credential, _): endpoint = .device(credential)
    case .locked, .none, .failed: endpoint = .none
    }
    // Kolejka i pamięć podręczna dostają katalogi przestrzeni w `attachServer`; do tej chwili nic nie czyta dysku.
    let store = RarogStore(
      transport: connector.transport(endpoint, rules), rules: rules, outboxDirectory: spaces.scratch(),
      clientBuild: connector.build)
    store.attachServer(
      connector, endpoint: endpoint, preferences: preferences, spaces: spaces, keychainLocked: read == .locked)
    if case let .failed(status) = read {
      store.reportUnhandled("keychain: odczyt klucza urządzenia nieudany (OSStatus \(status))")
    }
    store.restoreSharedPushKey(after: read)
    store.reportIgnoredIroh(after: read)
    return store
  }

  /// Wpina Keychain, fabryki transportu, preferencje i przestrzenie danych. `endpoint` = punkt końcowy transportu
  /// podanego w `init`. Apka woła RAZ, przed `start()` (``live(connector:preferences:spaces:)`` robi to sam).
  public func attachServer(
    _ connector: ServerConnector, endpoint: ServerEndpoint, preferences: any PreferenceStore,
    spaces: ServerSpaces? = nil, keychainLocked: Bool = false
  ) {
    serverRuntime.connector = connector
    serverRuntime.endpoint = endpoint
    serverRuntime.awaitingKeychain = keychainLocked
    serverRuntime.spaces = spaces
    serverPreferences = preferences
    // Telefon przed pierwszym odblokowaniem nie oddaje plików ani preferencji: przestrzenie po odblokowaniu
    // (`retryKeychainIfAwaiting`).
    if !keychainLocked { selectSpace(for: endpoint) }
    dispatch(.pairing(.bound(Self.binding(endpoint))))
    if endpoint.credential == nil, let revoked = readRevocation() { dispatch(.pairing(.revoked(revoked))) }
    if let serverId = endpoint.credential?.serverId { dispatch(.pairing(.newDevices(readNotices(serverId)))) }
  }

  /// Bieżący punkt końcowy (ekran „Serwer”, testy).
  public var serverEndpoint: ServerEndpoint { serverRuntime.endpoint }

  /// System oddał dane chronione (`protectedDataDidBecomeAvailable`) — Keychain mógł ożyć.
  public func protectedDataBecameAvailable() {
    retryKeychainIfAwaiting()
  }

  // MARK: - Parowanie

  /// Link z adresu otwartego przez system, skanu QR albo wklejenia → arkusz „Sparować z <host>?”. Nic nie wychodzi bez
  /// potwierdzenia: link podsunięty przez dowolną stronę nie podmieni serwera po cichu.
  public func offerPairing(_ link: PairingLink) {
    // W trakcie „Zapomnij serwer” nowe parowanie nie zaczyna się: kasowanie po odpowiedzi skasowałoby jego klucz.
    guard serverRuntime.connector != nil, !state.pairing.forgetting else { return }
    dispatch(.pairing(.offered(link)))
  }

  /// Wklejony albo zeskanowany tekst. Zły tekst = odmowa od razu (zdanie składa RarogUI), arkusz się nie zmienia.
  @discardableResult
  public func offerPairing(text: String) -> PairingLinkError? {
    switch PairingLink.parse(text) {
    case let .success(link):
      offerPairing(link)
      return nil
    case let .failure(error):
      return error
    }
  }

  /// Adres parowania spoza zasad (inna wersja, ucięty kod): arkusz z odmową zamiast cichego „nic”.
  public func rejectPairingLink(_ error: PairingLinkError) {
    guard serverRuntime.connector != nil else { return }
    dispatch(.pairing(.linkRejected(error)))
  }

  /// "Cancel" in the sheet (also after a refusal). A request in flight is not cancelled — its result comes anyway;
  /// while waiting for the relay, also during the first request, "Cancel" ends the pairing and that result is dropped
  /// (`RarogStore+RelayAccess`).
  public func cancelPairing() {
    stopWaitingForRelay()
    dispatch(.pairing(.cancelled))
  }

  /// "Pair" in the sheet, or "Replace" (`replacing: true`) for a link to another server than the paired one
  /// (``PairingState/replacedServer``, one server per app): `POST /api/pair` to the link's target, the key in the
  /// Keychain, the transport switched. A link to another server without `replacing` sends nothing and keeps the sheet
  /// (`.ignored`); after "Replace" the new key starts with an empty data space. `shown` is the link the sheet showed
  /// when the button was tapped: the button runs in a task, and a link offered before the task starts replaces the
  /// sheet's, so a confirmation of another link than the one in the sheet is dropped (`.ignored`).
  @discardableResult
  public func confirmPairing(replacing: Bool = false, shown: PairingLink? = nil) async -> PairingOutcome {
    guard let connector = serverRuntime.connector, case let .confirming(link) = state.pairing.flow,
      !state.pairing.forgetting, shown == nil || shown == link
    else {
      return .ignored
    }
    let replaces = serverRuntime.endpoint.credential.map { link.leadsToAnotherServer($0.serverURL, $0.iroh) } ?? false
    guard replacing || !replaces else { return .ignored }
    serverRuntime.pairingAttempt += 1
    let attempt = serverRuntime.pairingAttempt
    dispatch(.pairing(.started(link)))
    // Wskaźnik nieczytelny (dysk nie oddaje pliku): nie wiadomo, czyją przestrzeń dostałby nowy klucz, więc parowanie
    // nie wysyła żądania. Stan przejściowy: ponowne „Sparuj” czyta wskaźnik znowu.
    guard readPointerBeforePairing() else {
      let failure = PairingFailure.failed(nil)
      reportUnhandled("pairing: refused before the pairing request — the space pointer is unreadable")
      dispatch(.pairing(.failed(link, failure)))
      return .failed(failure)
    }
    // Pairing over iroh: the relay registry first (ceiling and readiness window: `RarogStore+RelayAccess`).
    let relay = await prepareRelay(for: link.target, connector: connector)
    let preparedAt = areaNow
    let body = PairBody(code: link.code, label: connector.label, build: connector.build)
    let response: PairResponse
    switch await pairAdmittedByRelay(
      body, link: link, relay: relay, preparedAt: preparedAt, attempt: attempt, connector: connector)
    {
    case let .success(reply):
      response = reply
    case let .failure(error):
      guard attempt == serverRuntime.pairingAttempt else { return .ignored }
      let failure = Self.pairingFailure(error)
      dispatch(.pairing(.failed(link, failure)))
      return .failed(failure)
    }
    guard attempt == serverRuntime.pairingAttempt else { return .ignored }
    let credential = DeviceCredential(
      pair: response, serverURL: link.serverURL, iroh: pairedIroh(response, target: link.target), label: connector.label,
      pairedAt: areaNow)
    let previous = serverRuntime.endpoint
    // Wskaźnik uzgodniony z bieżącym kluczem jak przy wyborze przestrzeni, a bez klucza w sesji z Keychainem (pusty
    // skreśla następcę). Następca, którego dysk nie dał skreślić ani zamienić, zostaje we wskaźniku, dopóki Keychain
    // może trzymać jego klucz, więc parowanie, które by go zastąpiło, kończy się odmową, zanim cokolwiek trafi na dysk
    // i do Keychaina (rekord na serwerze wygaśnie sam, jak przy odmowie Keychaina).
    if let successor = settlePointer(for: previous),
      let refusal = refusalWhileSuccessorStays(successor, previous: previous, credential, target: link.target)
    {
      let failure = PairingFailure.failed(nil)
      reportUnhandled("pairing: \(refusal) refused — the space pointer still names a successor")
      dispatch(.pairing(.failed(link, failure)))
      return .failed(failure)
    }
    // Przejście z dowodem klucza: zapowiedź następcy we wskaźniku przed kluczem, więc proces zabity między zapisami nie
    // gubi przestrzeni.
    let pointerBefore = serverRuntime.pointer
    var pointerMoved = false
    if let successor = provenSuccessor(previous: previous, credential, target: link.target) {
      pointerMoved = announceSuccessor(successor)
    }
    // One server per app: after "Replace" the new key never opens the replaced pairing's space, so a fresh space goes
    // on disk before the key, as the successor above does. A server key proven by the pointer keeps its space.
    if replaces, !provesPointerKey(previous: previous, credential, target: link.target) {
      switch emptySpaceForReplacement(credential) {
      case .untouched:
        break
      case .emptied:
        pointerMoved = true
      case .refused:
        let failure = PairingFailure.failed(nil)
        dispatch(.pairing(.failed(link, failure)))
        return .failed(failure)
      }
    }
    do {
      let shared = try connector.keychain.save(credential, pushKey: response.pushKey)
      if !shared { reportUnhandled("keychain: klucz push bez grupy współdzielonej (kopia we wpisie apki)") }
    } catch {
      // The key did not go through: the pointer returns to its state from before this pairing (successor announced,
      // or the fresh space of a replacement), so the paired key keeps its space and data.
      if pointerMoved, let pointerBefore { restorePointer(pointerBefore) }
      // Serwer zapisał już rekord: bez żadnego żądania wygaśnie sam po 10 min (sierota).
      let failure = PairingFailure.keychain(error.status)
      reportUnhandled("keychain: zapis klucza urządzenia nieudany (OSStatus \(error.status))")
      dispatch(.pairing(.failed(link, failure)))
      return .failed(failure)
    }
    let previousSpace = serverRuntime.space
    clearRevocation()
    dispatch(.pairing(.paired))
    switchEndpoint(to: .device(credential))
    // Ta sama przestrzeń (np. parowanie po odpięciu z Maca, dane czekały): lista z pamięci jak przy starcie z kluczem,
    // nieświeża do pierwszego stanu ze strumienia (reduktor przyjmie ją tylko przed nim).
    if let previousSpace, serverRuntime.space?.name == previousSpace.name { applyRestoredList(await readListCache()) }
    // Poprzedni klucz (ponowne parowanie, inny serwer) odpina się sam — best-effort, w tle.
    if let old = previous.credential, old.deviceId != credential.deviceId {
      forgetOnServer(connector.forgetTransport(previous, rules))
    }
    trace("parowanie: sparowano z \(link.host) jako \(credential.deviceId)")
    return .paired
  }

  // MARK: - Odpięcie i ponowienie

  /// Powód wylogowania po 401 — bez skutków ubocznych (te robi ``deviceRejected(_:)`` po zamknięciu połączenia).
  func logoutReason(after rejection: CredentialRejection?) -> LogoutReason {
    // Bez klucza w punkcie końcowym (magazyn bez złącza serwera — atrapy testów obszarów): „nie rozpoznał”.
    guard let credential = serverRuntime.endpoint.credential else { return .deviceUnknown }
    if case let .revoked(deviceId, _, _) = rejection, deviceId == credential.deviceId {
      // Własne „Zapomnij serwer”: ekran startowy, nie „To urządzenie odpięto”.
      return serverRuntime.forgettingDevice == deviceId ? .notLoggedIn : .deviceRevoked
    }
    return .deviceUnknown
  }

  /// Skutki 401 klucza po `retire`: `device-revoked` TEGO urządzenia kasuje klucz z Keychaina, zapisuje odpięcie
  /// (data, przyczyna, serwer) i przełącza transport na drogę bez klucza. Inne 401 klucz zostawiają.
  func deviceRejected(_ rejection: CredentialRejection?) {
    guard let connector = serverRuntime.connector, let credential = serverRuntime.endpoint.credential,
      case let .revoked(deviceId, revokedAt, revokedBy) = rejection, deviceId == credential.deviceId
    else { return }
    connector.keychain.delete(deviceId: deviceId)
    if serverRuntime.forgettingDevice == deviceId {
      // Odpięcie przez własne „Zapomnij serwer” (odpowiedź jeszcze w drodze): bez trwałego ekranu odpięcia, resztę
      // sprzątania kończy `forgetServer`.
      serverRuntime.forgetRevoked = true
      install(.none)
      return
    }
    // System do ekranu odpięcia („na Macu: rarog devices”): po `install(.none)` stan go już nie ma.
    let server = credential.serverURL?.host(percentEncoded: false) ?? credential.iroh?.shortName ?? ""
    let revocation = DeviceRevocation(
      deviceId: deviceId, server: server, revokedAt: revokedAt, revokedBy: revokedBy, serverSystem: state.serverSystem)
    saveRevocation(revocation)
    dispatch(.pairing(.revoked(revocation)))
    install(.none)
    trace("parowanie: urządzenie \(deviceId) odpięte (\(revokedBy))")
  }

  /// „Spróbuj ponownie” na ekranie „Serwer nie rozpoznał tego urządzenia”: ten sam klucz, świeży transport. Nie
  /// w trakcie „Zapomnij serwer” — zalogowanie kluczem, który właśnie znika, skasowałoby sprzątanie.
  public func retryDeviceKey() {
    guard let connector = serverRuntime.connector, case .device = serverRuntime.endpoint,
      state.auth == .loggedOut(.deviceUnknown), !state.pairing.forgetting
    else { return }
    transport = connector.transport(serverRuntime.endpoint, rules)
    enterLoggedIn()
  }

  // MARK: - System maszyny serwera

  /// Po sondzie wersji: system serwera inny niż zapamiętany w poświadczeniu trafia do Keychaina (ten sam wpis, ta
  /// sama kopia klucza push), żeby zimny start i brak sieci mówiły ostatnim znanym słowem maszyny. Sonda bez pola
  /// niczego nie zmienia (``AppState/serverSystem`` zostaje). Keychain zablokowany albo zapis odrzucony: poświadczenie
  /// w pamięci i tak niesie nowy system, a następny zimny start spróbuje znowu (zapis ma stary).
  func rememberServerSystem() {
    guard let connector = serverRuntime.connector, var credential = serverRuntime.endpoint.credential,
      let system = state.serverSystem, credential.serverSystem != system
    else { return }
    credential.serverSystem = system
    // Transport zostaje: klucz ten sam, zmienia się tylko zapamiętane słowo. Związania też nie ruszamy (`.bound`
    // kasuje kod i listę urządzeń).
    serverRuntime.endpoint = .device(credential)
    guard case let .found(stored, pushKey) = connector.keychain.load(), stored.deviceId == credential.deviceId else {
      return
    }
    do {
      // `false`: wpis prywatny już zapisany, klucz push tylko w jego kopii (bez wycofania, jak przy parowaniu).
      if try !connector.keychain.save(credential, pushKey: pushKey) {
        reportUnhandled("keychain: klucz push bez grupy współdzielonej przy zapisie systemu serwera (kopia we wpisie apki)")
      }
    } catch {
      reportUnhandled("keychain: zapis systemu serwera nieudany (OSStatus \(error.status))")
    }
  }

  // MARK: - Kod dla nowego urządzenia

  /// „Sparuj nowe urządzenie”: `POST /api/pairings` → link z trasami tego serwera (`u` z adresu, `k` i `r` z pary
  /// iroh poświadczenia) i kodem, termin z serwera.
  ///
  /// Code operations (this issue and ``clearPairingCode()``) run one after another: a cancel still on its way goes
  /// out first, so its late `DELETE` cannot revoke the code issued here.
  public func issuePairingCode() {
    guard let credential = serverRuntime.endpoint.credential,
      let target = PairingTarget(serverURL: credential.serverURL, iroh: credential.iroh),
      state.auth == .loggedIn, state.pairing.issue != .issuing
    else { return }
    dispatch(.pairing(.issuing))
    let login = currentLogin
    let transport = transport
    let now = areaNow
    serverRuntime.codeTicket += 1
    let ticket = serverRuntime.codeTicket
    let previous = serverRuntime.codeOperations
    let operation = Task { [weak self] in
      await previous?.value
      let result: Result<PairingIssued, TransportError>
      do throws(TransportError) {
        result = .success(try await transport.issuePairingCode())
      } catch {
        result = .failure(error)
      }
      guard let self, self.isCurrentLogin(login), !Task.isCancelled, self.serverRuntime.codeTicket == ticket else {
        return
      }
      self.serverRuntime.issue = nil
      switch result {
      case let .success(issued):
        // Termin nieczytelny = 5 min od teraz (kontrakt mówi ISO; lepiej krótszy niż żaden).
        let expires = Self.isoDate(issued.expiresAt) ?? now.addingTimeInterval(300)
        let link = PairingLink(target: target, code: issued.code)
        self.dispatch(.pairing(.issued(IssuedPairingCode(link: link, expiresAt: expires))))
      case .failure(.unauthorized):
        self.handleUnauthorized(since: login)
      case let .failure(error):
        self.dispatch(.pairing(.issueFailed(Self.pairingFailure(error))))
      }
    }
    serverRuntime.issue = operation
    serverRuntime.codeOperations = operation
  }

  /// Closing the code: the screen clears at once, then one `DELETE /api/pairings` revokes the code on the server.
  /// A POST still on its way is not cancelled: the `DELETE` waits for its answer, because the server may already hold
  /// the code it issues, and the answer itself no longer reaches the screen.
  public func clearPairingCode() {
    serverRuntime.codeTicket += 1
    serverRuntime.issue = nil
    dispatch(.pairing(.issueCleared))
    guard serverRuntime.endpoint.credential != nil else { return }
    let transport = transport
    let previous = serverRuntime.codeOperations
    serverRuntime.codeOperations = Task {
      await previous?.value
      // Every error stays silent (405 from a server without the route, no network, iroh without a session): the code
      // then expires on the server by itself within 5 minutes.
      try? await transport.cancelPairingCode()
    }
  }

  // MARK: - Lista urządzeń i notki

  /// Reads the device list on demand (Settings opening, a `device-paired` push).
  public func refreshDevices() {
    readDevices()
  }

  /// Po każdym `hello` strumienia listy (`RarogStore.handle`): trwały ślad nowego urządzenia.
  func readDevicesAfterHello() {
    readDevices()
  }

  /// Zamyka notkę „Nowe urządzenie: …”.
  public func dismissDeviceNotice(_ id: String) {
    guard let serverId = serverRuntime.endpoint.credential?.serverId else { return }
    let remaining = state.pairing.newDevices.filter { $0.id != id }
    saveNotices(remaining, serverId: serverId)
    dispatch(.pairing(.newDevices(remaining)))
  }

  /// A tap on a `device-paired` or `version-changed` push (also one that launched the app): the Settings screen
  /// without waiting for the session list, and a fresh device list for it.
  public func openSettingsScreen(_ screen: SettingsScreen) {
    dispatch(.pairing(.settingsScreen(screen)))
    readDevices()
  }

  /// The interface opened the requested Settings screen.
  public func consumeSettingsScreenRequest() {
    dispatch(.pairing(.settingsScreen(nil)))
  }

  // MARK: - Wnętrze

  /// Preferencje obszaru (odpięcie, znacznik preferencji przestrzeni, znane urządzenia, notki).
  var serverPreferences: (any PreferenceStore)? {
    get { serverRuntime.preferences }
    set { serverRuntime.preferences = newValue }
  }

  /// Wylogowanie i przełączenie (`retire`): odczyty w drodze anulowane.
  func forgetPairingRequests() {
    serverRuntime.issue?.cancel()
    serverRuntime.issue = nil
    // `codeOperations` stays: after a logout the same key may log in again (``retryDeviceKey()``), and a cancel
    // still on its way would revoke a code issued before it lands. A new key waits for that cancel too.
    serverRuntime.devicesRead?.cancel()
    serverRuntime.devicesRead = nil
  }

  /// Start czekał na Keychain (telefon przed pierwszym odblokowaniem): drugi odczyt, potem zwykły start.
  func retryKeychainIfAwaiting() {
    guard serverRuntime.awaitingKeychain, let connector = serverRuntime.connector else { return }
    let read = connector.keychain.load()
    guard read != .locked else { return }
    serverRuntime.awaitingKeychain = false
    restoreSharedPushKey(after: read)
    reportIgnoredIroh(after: read)
    let endpoint: ServerEndpoint
    if case let .found(credential, _) = read { endpoint = .device(credential) } else { endpoint = .none }
    let changed = install(endpoint)
    // Inna przestrzeń niż sprzed odblokowania: interfejs czytał szkice z poprzedniej (albo z żadnej).
    if changed { interfaceEpoch += 1 }
    Task { await start() }
  }

  /// Start z kluczem (`live`, Keychain ożył po odblokowaniu): wpis współdzielony klucza push dla rozszerzenia
  /// powiadomień (NSE) odtworzony z kopii we wpisie prywatnym — idempotentnie, bez parowania. Porażka (grupa
  /// odmawia zapisu) = jedna linia `client.log`; apka i tak czyta kopię, NSE zostawia tekst zastępczy.
  func restoreSharedPushKey(after read: KeychainRead) {
    guard let connector = serverRuntime.connector, case let .found(credential, pushKey) = read else { return }
    if !connector.keychain.restoreSharedPushKey(kid: credential.kid, pushKey: pushKey) {
      reportUnhandled("keychain: klucz push bez grupy współdzielonej (kopia we wpisie apki)")
    }
  }

  /// Odczyt klucza z pominiętą parą iroh (zły EndpointId albo relay w zapisie): klucz urządzenia i push działają
  /// przez adres HTTPS, a `client.log` dostaje jedną linię z powodem, bez wartości pola.
  func reportIgnoredIroh(after read: KeychainRead) {
    guard case let .found(credential, _) = read, let reason = credential.ignoredIroh else { return }
    reportUnhandled("keychain: pole iroh pominięte w poświadczeniu (\(reason))")
  }

  /// Nowy punkt końcowy bez logowania (start, odpięcie, „Zapomnij serwer”): transport, przestrzeń danych i stan
  /// ekranu. Zwraca, czy przestrzeń się zmieniła (`selectSpace`).
  @discardableResult
  func install(_ endpoint: ServerEndpoint) -> Bool {
    guard let connector = serverRuntime.connector else { return false }
    serverRuntime.endpoint = endpoint
    transport = connector.transport(endpoint, rules)
    let changed = selectSpace(for: endpoint)
    dispatch(.pairing(.bound(Self.binding(endpoint))))
    if let serverId = endpoint.credential?.serverId { dispatch(.pairing(.newDevices(readNotices(serverId)))) }
    return changed
  }

  /// Przełączenie na świeżo sparowany klucz bez restartu procesu: stare połączenie zamknięte (`retire`, token APNs
  /// zostaje w systemie), nowy transport, przestrzeń danych (inny adres = nowa) i zalogowanie. Interfejs buduje się od
  /// nowa (`interfaceEpoch`): widoki trzymały obiekty starego transportu i szkice poprzedniej przestrzeni — ekran
  /// terminala z sesją zatrzymaną przez `retire` zostałby martwy. Po `retire` złącze kończy tożsamość poprzedniego
  /// punktu końcowego (`ServerConnector.release`), raz na przełączenie. Przestrzeń przejścia z dowodem klucza niesie
  /// wskaźnik z następcą (``announceSuccessor(_:)``).
  private func switchEndpoint(to endpoint: ServerEndpoint) {
    let previous = serverRuntime.endpoint
    retire(.switchingServer, unregisterPush: false)
    serverRuntime.connector?.release(previous)
    install(endpoint)
    interfaceEpoch += 1
    enterLoggedIn()
  }

  /// Para iroh nowego poświadczenia: z odpowiedzi po walidacji, a gdy jej nie ma albo jest zła, przy
  /// parowaniu przez iroh — z linku (ta para odpowiedziała na połączenie parowania).
  private func pairedIroh(_ response: PairResponse, target: PairingTarget) -> ServerIrohConfig? {
    if let reported = response.server.iroh {
      if let iroh = ServerIrohConfig(validating: reported.endpointId, relay: reported.relay) { return iroh }
      reportUnhandled("pairing: iroh pair in the pairing reply ignored (\(Self.irohProblem(reported)))")
    }
    return target.iroh
  }

  /// Dowód klucza serwera ze wskaźnika przy ponownym parowaniu: wskaźnik `.iroh(k)`, parowanie przez iroh do
  /// tego samego `k` (połączenie dowodzi klucza serwera) i to samo `serverId` co poprzedni klucz. Link z samym `u`
  /// klucza nie dowodzi (`serverId` przychodzi z odpowiedzi).
  private func provesPointerKey(
    previous: ServerEndpoint, _ credential: DeviceCredential, target: PairingTarget
  ) -> Bool {
    guard case let .iroh(endpointId)? = serverRuntime.pointer?.identity, target.iroh?.endpointId == endpointId,
      let old = previous.credential
    else { return false }
    return old.serverId == credential.serverId
  }

  /// Parowanie przy następcy, którego uzgodnienie nie skreśliło (``settlePointer(for:)``): przechodzi tylko z dowodem
  /// klucza serwera (``provesPointerKey(previous:_:target:)``) i z nowym kluczem, który wskaźnik już dopuszcza
  /// (tożsamość `identity` albo `successor`), więc zapowiedź nigdy nie zamienia następcy na innego. Wynik: powód
  /// odmowy do `client.log`; `nil` = parowanie idzie dalej.
  private func refusalWhileSuccessorStays(
    _ successor: ServerIdentity, previous: ServerEndpoint, _ credential: DeviceCredential, target: PairingTarget
  ) -> String? {
    guard provesPointerKey(previous: previous, credential, target: target) else {
      return "pairing without proof of the server key"
    }
    let identity = ServerIdentity(credential)
    guard identity == serverRuntime.pointer?.identity || identity == successor else {
      return "pairing under another server identity"
    }
    return nil
  }

  /// Ponowne parowanie urządzenia tylko przez iroh z tym samym serwerem, z dowodem klucza serwera
  /// (``provesPointerKey(previous:_:target:)``): nowy klucz kontynuuje przestrzeń wskaźnika pod swoją tożsamością
  /// (wynik; `nil`, gdy dowodu nie ma albo tożsamość się nie zmienia).
  private func provenSuccessor(
    previous: ServerEndpoint, _ credential: DeviceCredential, target: PairingTarget
  ) -> ServerIdentity? {
    guard provesPointerKey(previous: previous, credential, target: target), let identity = ServerIdentity(credential),
      identity != serverRuntime.pointer?.identity
    else { return nil }
    return identity
  }

  /// Powód odrzucenia pary iroh z odpowiedzi serwera — do `client.log`, bez wartości pola.
  nonisolated static func irohProblem(_ reported: ServerIroh) -> String {
    PairingLinkWire.isEndpointId(reported.endpointId) ? "bad relay" : "bad EndpointId"
  }

  private func readDevices() {
    guard let serverId = serverRuntime.endpoint.credential?.serverId, state.auth == .loggedIn,
      serverRuntime.devicesRead == nil
    else { return }
    let login = currentLogin
    let transport = transport
    serverRuntime.devicesRead = Task { [weak self] in
      let result: Result<DeviceList, TransportError>
      do throws(TransportError) {
        result = .success(try await transport.devices())
      } catch {
        result = .failure(error)
      }
      guard let self, self.isCurrentLogin(login), !Task.isCancelled else { return }
      self.serverRuntime.devicesRead = nil
      switch result {
      case let .success(list):
        self.applyDevices(list.devices, serverId: serverId)
      case .failure(.unauthorized):
        self.handleUnauthorized(since: login)
      case .failure:
        break
      }
    }
  }

  /// Lista z serwera → stan i trwały ślad: urządzenie, którego apka nie widziała (poza sobą), daje notkę. Pierwszy
  /// odczyt dla serwera tylko zapamiętuje listę — notki są o zmianach od chwili, gdy apka zna ten serwer.
  private func applyDevices(_ devices: [DeviceInfo], serverId: String) {
    dispatch(.pairing(.devices(devices)))
    let known = readKnown(serverId)
    var labels = known ?? [:]
    for device in devices { labels[device.id] = device.label }
    saveKnown(labels, serverId: serverId)
    guard let known else { return }
    let fresh = devices.filter { !$0.current && known[$0.id] == nil }
    guard !fresh.isEmpty else { return }
    var notices = state.pairing.newDevices
    for device in fresh where !notices.contains(where: { $0.id == device.id }) {
      let admin = device.creator == "admin"
      let creator = admin ? device.creator : labels[device.creator] ?? String(device.creator.prefix(8))
      notices.append(NewDeviceNotice(
        id: device.id, label: device.label, createdAt: device.createdAt, creator: creator, creatorIsAdmin: admin))
    }
    saveNotices(notices, serverId: serverId)
    dispatch(.pairing(.newDevices(notices)))
  }

  private func readKnown(_ serverId: String) -> [String: String]? {
    serverPreferences?.data(forKey: Self.knownDevicesKey(serverId))
      .flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }
  }

  private func saveKnown(_ labels: [String: String], serverId: String) {
    // Sufit: identyfikatory odpiętych urządzeń nie rosną bez końca (kolejność nie ma znaczenia).
    let capped = labels.count > 64 ? Dictionary(uniqueKeysWithValues: labels.prefix(64).map { ($0.key, $0.value) }) : labels
    serverPreferences?.set(try? JSONEncoder().encode(capped), forKey: Self.knownDevicesKey(serverId))
  }

  private func readNotices(_ serverId: String) -> [NewDeviceNotice] {
    serverPreferences?.data(forKey: Self.deviceNoticesKey(serverId))
      .flatMap { try? JSONDecoder().decode([NewDeviceNotice].self, from: $0) } ?? []
  }

  private func saveNotices(_ notices: [NewDeviceNotice], serverId: String) {
    serverPreferences?.set(try? JSONEncoder().encode(notices), forKey: Self.deviceNoticesKey(serverId))
  }

  private func readRevocation() -> DeviceRevocation? {
    serverPreferences?.data(forKey: Self.revokedKey).flatMap { try? JSONDecoder().decode(DeviceRevocation.self, from: $0) }
  }

  private func saveRevocation(_ revocation: DeviceRevocation) {
    serverPreferences?.set(try? JSONEncoder().encode(revocation), forKey: Self.revokedKey)
  }

  func clearRevocation() {
    serverPreferences?.set(nil, forKey: Self.revokedKey)
  }

  nonisolated static func binding(_ endpoint: ServerEndpoint) -> ServerBinding {
    switch endpoint {
    case .none: .none
    case let .device(credential): .device(PairedServer(credential))
    }
  }

  /// Błąd transportu → odmowa parowania (zdania składa RarogUI).
  nonisolated static func pairingFailure(_ error: TransportError) -> PairingFailure {
    switch error {
    case let .http(failure):
      switch (failure.status, failure.code) {
      case (404, "pair-unknown"): .codeRejected
      case (400, "pair-version"): .versionMismatch
      case (404, _), (405, _): .serverTooOld
      default: .failed(failure.message)
      }
    case let .forbidden(failure): .forbidden(failure.message)
    case let .rateLimited(failure): .rateLimited(retryAfter: failure.retryAfter)
    case .offline: .offline
    case .timedOut: .timedOut
    case let .unauthorized(failure): .failed(failure.message)
    case .refused, .cancelled, .invalidResponse: .failed(nil)
    }
  }

  /// ISO z serwera (`toISOString()`: z milisekundami) → data.
  nonisolated static func isoDate(_ text: String) -> Date? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: text) { return date }
    return ISO8601DateFormatter().date(from: text)
  }
}

extension PairingState {
  /// The paired server that the link in the sheet would replace (one server per app): the sheet warns with it, "Cancel"
  /// is the default, and "Replace" is ``RarogStore/confirmPairing(replacing:shown:)`` with `true`. `nil` = no link in
  /// the sheet, no paired server (first pairing) or the same server.
  public var replacedServer: PairedServer? {
    guard let link = flow.link, let paired, link.leadsToAnotherServer(paired.url, paired.iroh) else { return nil }
    return paired
  }
}

extension PairingLink {
  /// The one rule of "another server" (one server per app) against the paired server's routes. A link
  /// with `k` compares the full EndpointId with the paired iroh key; a paired server without one cannot be compared,
  /// so it is another server. A link without `k` compares origins (`ServerOrigin`). The short fingerprint on the sheet
  /// only informs; this comparison is the check.
  func leadsToAnotherServer(_ serverURL: URL?, _ iroh: ServerIrohConfig?) -> Bool {
    if let key = self.iroh?.endpointId { return key != iroh?.endpointId }
    return self.serverURL.flatMap(ServerOrigin.init) != serverURL.flatMap(ServerOrigin.init)
  }
}

/// Droga i para iroh poświadczenia w chwili wysłania sondy wersji: para z odpowiedzi liczy się tylko przy tych samych.
/// Droga to ``RarogTransporting/routeStamp`` (numer generacji przełącznika, rośnie z każdą).
struct VersionProbeStamp: Sendable, Equatable {
  let route: UInt64
  let deviceId: String?
  let iroh: ServerIrohConfig?
}

extension RarogStore {
  /// Pieczątka sondy wysyłanej teraz.
  func versionProbeStamp() -> VersionProbeStamp {
    let credential = serverRuntime.endpoint.credential
    return VersionProbeStamp(route: transport.routeStamp, deviceId: credential?.deviceId, iroh: credential?.iroh)
  }

  /// Para iroh z `GET /api/version` w tym samym wpisie Keychaina, tą samą drogą co
  /// ``rememberServerSystem()``: to samo konto i ten sam klucz push, nowe trasy dla złącza (`credentialChanged`)
  /// i widoczny serwer zmieniony bez ``PairingEvent/bound(_:)``. Nowa para tylko po walidacji; `null` usuwa parę
  /// wyłącznie przy adresie HTTPS. Serwer tylko przez iroh zmienia w miejscu sam relay: inny EndpointId to inny
  /// serwer (nowe parowanie). Wynik spoza drogi i pary z chwili wysłania przepada, a następna sonda idzie po
  /// ponowieniu. Każda porażka zapisu zostawia starą parę w Keychainie, w pamięci i w trasach.
  func adoptServerIroh(_ reported: ServerIroh?, sent: VersionProbeStamp) {
    guard let connector = serverRuntime.connector, let credential = serverRuntime.endpoint.credential,
      credential.deviceId == sent.deviceId
    else { return }
    var next: ServerIrohConfig?
    if let reported {
      guard let iroh = ServerIrohConfig(validating: reported.endpointId, relay: reported.relay) else {
        reportUnhandled("version probe: iroh pair ignored (\(Self.irohProblem(reported)))")
        return
      }
      next = iroh
    }
    guard next != credential.iroh else { return }
    if credential.serverURL == nil {
      guard let next, next.endpointId == credential.iroh?.endpointId else { return }
    }
    guard sent.route == transport.routeStamp, sent.iroh == credential.iroh else {
      // Odpowiedź starej drogi albo sprzed innej zmiany pary: następna sonda po ponowieniu, nie po pełnym odstępie.
      usagePolling.versionRecheck = true
      return
    }
    var updated = credential
    updated.iroh = next
    guard updated.account == credential.account, case let .found(stored, pushKey) = connector.keychain.load(),
      stored.deviceId == credential.deviceId
    else { return }
    do {
      if try !connector.keychain.save(updated, pushKey: pushKey) {
        reportUnhandled("keychain: push key without the shared group when saving the iroh pair (copy in the app entry)")
      }
    } catch {
      reportUnhandled("keychain: saving the server iroh pair failed (OSStatus \(error.status))")
      return
    }
    serverRuntime.endpoint = .device(updated)
    dispatch(.pairing(.routesUpdated(PairedServer(updated))))
    connector.credentialChanged(.device(updated))
  }
}
