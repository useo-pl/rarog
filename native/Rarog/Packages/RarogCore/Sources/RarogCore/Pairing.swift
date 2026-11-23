import Foundation
import RarogContract
import RarogTransport

// Parowanie z serwerem i klucz urządzenia w rdzeniu. Typy obszaru, link
// `https://rarog.ai/pair#v=1&u=<adres>&k=<EndpointId>&r=<relay>&c=<kod>` i stan ekranów; akcje: `RarogStore+Pairing`,
// reduktor: `Reducer+Pairing`.
// Kontrakt tras: `docs/implementation-spec.md`, „Device keys and pairing”.
// The iroh relay registry steps of pairing and the registry status: `RarogStore+RelayAccess`.

/// Z czym apka rozmawia. Zmiana punktu końcowego to nowy transport bez restartu procesu (`RarogStore+Pairing`).
/// Apka zna wyłącznie klucz urządzenia (bez logowania tokenem).
public enum ServerEndpoint: Sendable, Equatable {
  /// Brak klucza — tylko ekran parowania.
  case none
  /// Klucz urządzenia z parowania.
  case device(DeviceCredential)

  public var credential: DeviceCredential? {
    if case let .device(credential) = self { return credential }
    return nil
  }
}

/// Co apka wie o połączeniu z serwerem (ekran „Serwer”, ekran startowy). Bez sekretu.
public enum ServerBinding: Sendable, Equatable {
  case none
  case device(PairedServer)
}

/// Sparowany serwer na ekranie „Serwer”.
public struct PairedServer: Sendable, Equatable {
  /// Adres HTTPS serwera; `nil` = serwer tylko przez iroh.
  public let url: URL?
  /// Serwer iroh poświadczenia (EndpointId i relay); `nil` = serwer bez pary iroh.
  public let iroh: ServerIrohConfig?
  public let serverId: String
  public let serverName: String
  public let deviceId: String
  public let label: String
  public let pairedAt: Date
  /// System z poświadczenia w chwili związania — zalążek ``AppState/serverSystem`` przy zimnym starcie (reduktor
  /// `.bound`). Bieżący system czyta się ze stanu: sonda wersji go zmienia, a związania nie.
  let serverSystem: ServerSystem?

  public init(_ credential: DeviceCredential) {
    url = credential.serverURL
    iroh = credential.iroh
    serverId = credential.serverId
    serverName = credential.serverName
    deviceId = credential.deviceId
    label = credential.label
    pairedAt = credential.pairedAt
    serverSystem = credential.serverSystem
  }
}

/// Link parowania odczytany z kodu QR, wklejonego tekstu albo adresu otwartego przez system. Reguły linku (pola, kody
/// błędów, składanie) ma ``PairingLinkWire`` w RarogContract; tu cel parowania: adres HTTPS z `u=`,
/// serwer iroh z `k=` i `r=` albo oba.
public struct PairingLink: Sendable, Equatable {
  /// Czym apka paruje: `.https` (sam `u`) albo przez iroh (`.iroh` dla `k`+`r`, `.both` dla `u`+`k`+`r`).
  public let target: PairingTarget
  /// Kod jednorazowy (32 B base64url, 5 min).
  public let code: String

  /// Adres bazowy serwera z `u=` (`https://host[:port]`, bez ścieżki) — z niego apka liczy `Origin`; `nil` = link
  /// tylko przez iroh.
  public var serverURL: URL? { target.serverURL }

  /// Serwer iroh z `k=` i `r=` po walidacji; `nil` = link bez pól iroh.
  public var iroh: ServerIrohConfig? { target.iroh }

  /// Adres do pokazania pod tytułem karty: adres z `u=`, a dla linku tylko przez iroh napis `iroh:<EndpointId>` (URL
  /// bez sieci). Żądania idą wyłącznie przez ``target``.
  public var server: URL {
    if let serverURL { return serverURL }
    guard let iroh, let url = URL(string: "iroh:\(iroh.endpointId)") else {
      preconditionFailure("cel parowania ma adres albo parę iroh")
    }
    return url
  }

  /// Host do zdania „Sparować z <host>?”: host adresu, a dla linku tylko przez iroh `iroh · <8 znaków EndpointId>`.
  public var host: String {
    if let serverURL { return serverURL.host(percentEncoded: false) ?? serverURL.absoluteString }
    return iroh?.shortName ?? ""
  }

  /// Wersja linku, którą ta apka rozumie (`v=1`, ta sama co w ciele `POST /api/pair`).
  public static let version = PairingLinkWire.version

  public init(target: PairingTarget, code: String) {
    self.target = target
    self.code = code
  }

  /// Link z samym adresem HTTPS (`u=`).
  public init(server: URL, code: String) {
    self.init(target: .https(server), code: code)
  }

  /// `https://rarog.ai/pair#v=1&u=<adres encodeURIComponent>&k=<EndpointId>&r=<relay>&c=<kod>` — wspólne składanie
  /// (``PairingLinkWire/link``), ten sam kształt co `pairingLink` serwera; pola celu, których nie ma, link pomija.
  public var url: URL {
    let wire = PairingLinkWire(
      server: serverURL.map { Self.base($0).absoluteString },
      iroh: iroh.map { ServerIroh(endpointId: $0.endpointId, relay: $0.relay.absoluteString) }, code: code)
    guard let url = URL(string: wire.link) else {
      preconditionFailure("link parowania z poprawnego adresu i kodu base64url zawsze się składa")
    }
    return url
  }

  /// Tekst (wklejony, z QR) → link. Białe znaki są pomijane WSZĘDZIE, nie tylko z brzegów: link ich nie zawiera,
  /// a skopiowany z terminala (`rarog pair` przez mosh) bywa złamany na końcu linii ekranu.
  public static func parse(_ text: String) -> Result<PairingLink, PairingLinkError> {
    switch PairingLinkWire.parse(text) {
    case let .failure(error):
      return .failure(PairingLinkError(error))
    case let .success(wire):
      let server = wire.server.flatMap { URL(string: $0) }
      if wire.server != nil, server == nil { return .failure(.badAddress) }
      // Para iroh wyłącznie po walidacji poświadczenia (ta sama reguła co przy zapisie i odczycie Keychaina).
      let iroh = wire.iroh.flatMap { ServerIrohConfig(validating: $0.endpointId, relay: $0.relay) }
      if wire.iroh != nil, iroh == nil { return .failure(.badAddress) }
      guard let target = PairingTarget(serverURL: server, iroh: iroh) else { return .failure(.badAddress) }
      return .success(PairingLink(target: target, code: wire.code))
    }
  }

  /// Adres otwarty przez system → link. Dane stoją we FRAGMENCIE (link wklejony w przeglądarkę nie wyniesie kodu).
  public static func parse(url: URL) -> Result<PairingLink, PairingLinkError> {
    parse(url.absoluteString)
  }

  /// `scheme://host[:port]` bez końcowego ukośnika — postać, z której `RarogConfig` liczy `Origin`.
  static func base(_ url: URL) -> URL {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    components.path = ""
    components.query = nil
    components.fragment = nil
    return components.url ?? url
  }
}

/// Dlaczego tekst nie jest linkiem parowania — cztery zdania ekranu (`UICopy.pairLinkError`). Kody kontraktu
/// (``PairingLinkWireError``) mapuje ``init(_:)``.
public enum PairingLinkError: Error, Sendable, Equatable {
  /// To nie jest link parowania (żaden z prefiksów ``PairingLinkWire``).
  case notALink
  /// Link z innej wersji parowania — „zaktualizuj apkę albo serwer”.
  case unsupportedVersion
  /// Adres serwera spoza zasad (nie https, ścieżka, użytkownik w adresie), zła para iroh (`k=`, `r=`) albo link bez
  /// żadnej trasy.
  case badAddress
  /// Kod w złym kształcie (ucięty przy kopiowaniu).
  case badCode

  /// Kod kontraktu → zdanie ekranu. Duplikat pola to link zepsuty („skopiuj cały link”), a błędy pól iroh
  /// (`k=`, `r=`) to adres serwera spoza zasad.
  public init(_ wire: PairingLinkWireError) {
    switch wire {
    case .notALink, .duplicateField: self = .notALink
    case .unsupportedVersion: self = .unsupportedVersion
    case .badAddress, .badEndpointId, .badRelay, .missingRelay, .missingEndpointId: self = .badAddress
    case .badCode: self = .badCode
    }
  }
}

/// Przebieg parowania na ekranie: link czeka na potwierdzenie, leci żądanie, odmowa.
public enum PairingFlow: Sendable, Equatable {
  case idle
  /// „Sparować z <host>?” — każda droga (skan, wklejenie, adres `rarog://`) kończy się tym arkuszem: link
  /// podsunięty przez dowolną stronę nigdy nie podmienia serwera po cichu.
  case confirming(PairingLink)
  case pairing(PairingLink)
  /// Pairing over iroh right after a fresh relay registry sponsorship: the relay may not admit the server yet, so
  /// the pairing request is repeated until `until` (`RarogStore+RelayAccess`). "Cancel" works here, unlike in
  /// ``pairing(_:)``.
  case waitingForRelay(PairingLink, until: Date)
  case failed(PairingLink, PairingFailure)
  /// Adres parowania, którego apka nie rozumie — arkusz mówi dlaczego (bez serwera, nic nie wyszło).
  case rejected(PairingLinkError)

  /// Link w arkuszu (potwierdzenie, żądanie albo odmowa).
  public var link: PairingLink? {
    switch self {
    case .idle, .rejected: nil
    case let .confirming(link), let .pairing(link), let .waitingForRelay(link, _), let .failed(link, _): link
    }
  }

  /// Arkusz stoi (potwierdzenie, żądanie, odmowa).
  public var isActive: Bool { self != .idle }

  /// `POST /api/pair` in flight, also repeated while waiting for the relay: the sheet keeps its link and "Forget
  /// Server" does not start.
  var isRequestInFlight: Bool {
    switch self {
    case .pairing, .waitingForRelay: true
    case .idle, .confirming, .failed, .rejected: false
    }
  }
}

/// Odmowa parowania — zdania składa RarogUI.
public enum PairingFailure: Sendable, Equatable {
  /// 404 `pair-unknown`: zły, zużyty albo przeterminowany kod.
  case codeRejected
  /// 404/405 bez kodu kontraktu — serwer sprzed parowania.
  case serverTooOld
  /// 400 `pair-version` — inna wersja parowania.
  case versionMismatch
  /// 403 — `Origin` spoza allow-listy serwera albo proxy poza tailnetem (zdanie serwera, gdy było).
  case forbidden(String?)
  case rateLimited(retryAfter: Int?)
  case offline
  case timedOut
  /// Keychain odmówił zapisu klucza (`OSStatus`): bez trwałego klucza nie ma po co się przełączać.
  case keychain(Int32)
  /// Inna odmowa serwera (5xx, nieczytelna odpowiedź) ze zdaniem serwera, gdy było.
  case failed(String?)
}

/// Wynik akcji parowania dla ekranu.
public enum PairingOutcome: Sendable, Equatable {
  case paired
  case failed(PairingFailure)
  /// Nic nie wyszło: arkusza nie było albo żądanie już leci.
  case ignored
}

/// Odpięcie urządzenia z 401 `device-revoked` — trwałe do następnego parowania (ekran „To urządzenie odpięto”).
public struct DeviceRevocation: Sendable, Equatable, Codable {
  public let deviceId: String
  /// Host serwera, który odpiął, a dla serwera tylko przez iroh skrót ``ServerIrohConfig/shortName``.
  public let server: String
  /// `revokedAt` z serwera (ISO).
  public let revokedAt: String
  /// `admin` (CLI na maszynie serwera), `forget` („Zapomnij serwer”), `expired` (30 dni bez użycia) albo `deviceId`.
  public let revokedBy: String
  /// Ostatni znany system maszyny serwera (``AppState/serverSystem`` w chwili odpięcia): ekran odpięcia mówi „na
  /// Macu” albo „na VPS-ie” także po restarcie, gdy klucza i poświadczenia już nie ma. `nil` = nie wiadomo.
  public let serverSystem: ServerSystem?

  public init(deviceId: String, server: String, revokedAt: String, revokedBy: String, serverSystem: ServerSystem? = nil) {
    self.deviceId = deviceId
    self.server = server
    self.revokedAt = revokedAt
    self.revokedBy = revokedBy
    self.serverSystem = serverSystem
  }

  enum CodingKeys: String, CodingKey {
    case deviceId, server, revokedAt, revokedBy, serverSystem
  }

  /// Zapis sprzed pola `serverSystem` dekoduje się dalej, a nieznane pole systemu go nie psuje
  /// (``Swift/KeyedDecodingContainer/storedServerSystem(forKey:)``).
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    deviceId = try c.decode(String.self, forKey: .deviceId)
    server = try c.decode(String.self, forKey: .server)
    revokedAt = try c.decode(String.self, forKey: .revokedAt)
    revokedBy = try c.decode(String.self, forKey: .revokedBy)
    serverSystem = c.storedServerSystem(forKey: .serverSystem)
  }
}

/// Kod dla NOWEGO urządzenia wydany na tym (`POST /api/pairings`). Termin z zegara serwera: apka odlicza do
/// niego, więc uśpienie apki nie przedłuża kodu.
public struct IssuedPairingCode: Sendable, Equatable {
  public let link: PairingLink
  public let expiresAt: Date

  public init(link: PairingLink, expiresAt: Date) {
    self.link = link
    self.expiresAt = expiresAt
  }

  /// Ile zostało do terminu (zero po nim). Liczone od zegara TERAZ, więc uśpiona apka po powrocie widzi prawdę.
  public func remaining(now: Date) -> TimeInterval {
    max(0, expiresAt.timeIntervalSince(now))
  }

  public func isExpired(now: Date) -> Bool { remaining(now: now) == 0 }
}

/// The code for a new device on the Settings "Pairing" page.
public enum IssueState: Sendable, Equatable {
  case idle
  case issuing
  case issued(IssuedPairingCode)
  case failed(PairingFailure)
}

/// Urządzenie, którego apka jeszcze nie widziała na liście serwera (trwały ślad) — notka do zamknięcia.
public struct NewDeviceNotice: Sendable, Equatable, Codable, Identifiable {
  public let id: String
  public let label: String
  /// `createdAt` z serwera (ISO).
  public let createdAt: String
  /// `admin` (kod z Maca) albo etykieta urządzenia, które wydało kod (gdy apka ją zna), inaczej jego `deviceId`.
  public let creator: String
  public let creatorIsAdmin: Bool

  public init(id: String, label: String, createdAt: String, creator: String, creatorIsAdmin: Bool) {
    self.id = id
    self.label = label
    self.createdAt = createdAt
    self.creator = creator
    self.creatorIsAdmin = creatorIsAdmin
  }
}

/// A Settings screen the core asks the interface to open (``PushNote/opensSettings``).
public enum SettingsScreen: Sendable, Equatable {
  case server, pairing
}

/// Stan obszaru parowania (pole `AppState.pairing`). Zmienia go wyłącznie `Reducer+Pairing`.
public struct PairingState: Sendable, Equatable {
  public var binding: ServerBinding = .none
  public var flow: PairingFlow = .idle
  /// Odpięcie z 401 `device-revoked`; przeżywa restart apki do następnego parowania.
  public var revoked: DeviceRevocation?
  public var issue: IssueState = .idle
  /// Aktywne urządzenia serwera z ostatniego `GET /api/devices` (`nil` = jeszcze nie czytane).
  public var devices: [DeviceInfo]?
  public var newDevices: [NewDeviceNotice] = []
  public var forgetting = false
  /// Ostatnie „Zapomnij serwer” przerwane: dysk nie dał unieważnić danych serwera (klucz i dane zostały).
  public var forgetFailed = false
  /// A request for a Settings screen (a tap on a `device-paired` or `version-changed` push); the interface consumes
  /// it.
  public var settingsScreenRequested: SettingsScreen?

  public init() {}

  /// Sparowany serwer (klucz urządzenia), jeśli apka go ma.
  public var paired: PairedServer? {
    if case let .device(server) = binding { return server }
    return nil
  }
}

/// Zdarzenia obszaru parowania (`CoreEvent.pairing`).
public enum PairingEvent: Sendable, Equatable {
  case bound(ServerBinding)
  /// Te same klucz i przestrzeń, nowe trasy (para iroh z sondy wersji): widoczny serwer się zmienia, a kod
  /// parowania i lista urządzeń zostają (w odróżnieniu od ``bound(_:)``).
  case routesUpdated(PairedServer)
  case offered(PairingLink)
  case linkRejected(PairingLinkError)
  case cancelled
  case started(PairingLink)
  /// The first pairing request over iroh failed in transport after a fresh sponsorship: retries until `until`.
  case waitingForRelay(PairingLink, until: Date)
  case failed(PairingLink, PairingFailure)
  case paired
  case revoked(DeviceRevocation?)
  case issuing
  case issued(IssuedPairingCode)
  case issueFailed(PairingFailure)
  case issueCleared
  case devices([DeviceInfo]?)
  case newDevices([NewDeviceNotice])
  case forgetting(Bool)
  case forgetFailed
  case dataWiped
  case settingsScreen(SettingsScreen?)
  /// A status of the app's relay registry client (``AppState/relayAccess``).
  case relayAccess(RelayAccessStatus)
}

/// Cel parowania: adres HTTPS z linku, serwer iroh albo oba. Złącze paruje `.https` przez adres, a `.iroh` i `.both`
/// przez iroh (połączenie z EndpointId celu dowodzi klucza serwera).
public enum PairingTarget: Sendable, Equatable {
  case https(URL), iroh(ServerIrohConfig), both(URL, ServerIrohConfig)

  /// Cel z tras: adres, para iroh albo oba; `nil` = żadnej trasy.
  public init?(serverURL: URL?, iroh: ServerIrohConfig?) {
    switch (serverURL, iroh) {
    case let (url?, iroh?): self = .both(url, iroh)
    case let (url?, nil): self = .https(url)
    case let (nil, iroh?): self = .iroh(iroh)
    case (nil, nil): return nil
    }
  }

  /// Adres HTTPS celu (`nil` przy `.iroh`).
  public var serverURL: URL? {
    switch self {
    case let .https(url), let .both(url, _): url
    case .iroh: nil
    }
  }

  /// Serwer iroh celu (`nil` przy `.https`): parowanie idzie przez iroh do tego EndpointId.
  public var iroh: ServerIrohConfig? {
    switch self {
    case .https: nil
    case let .iroh(iroh), let .both(_, iroh): iroh
    }
  }
}

extension ServerIrohConfig {
  /// Skrót serwera iroh do zdań ekranu (karta parowania, ekran odpięcia): `iroh · <8 znaków EndpointId>`.
  public var shortName: String { "iroh · \(endpointId.prefix(8))" }

  /// Fingerprint of the server key on the pairing sheet: the first 16 characters of the EndpointId in
  /// groups of 4 (`1a2b 3c4d 5e6f 7a8b`), so it starts with the 8 characters of ``shortName`` and can be read against
  /// `k=` of the link that `rarog pair` prints. It only informs: the check is the comparison of full keys
  /// (`PairingLink.leadsToAnotherServer`).
  public var fingerprint: String {
    let head = Array(endpointId.prefix(16))
    return stride(from: 0, to: head.count, by: 4).map { String(head[$0..<min($0 + 4, head.count)]) }
      .joined(separator: " ")
  }
}

/// Wejście apki do świata poza rdzeniem: Keychain i fabryki transportu. Apka podaje prawdziwe (`RarogClient`,
/// `SystemKeychain`), testy — atrapy.
public struct ServerConnector: Sendable {
  public var keychain: any DeviceKeychain
  /// Etykieta urządzenia i build do ciała parowania.
  public var label: String
  public var build: Int
  /// Transport dla punktu końcowego z bramką magazynu (`.none` = transport bez serwera, wszystko odmawia).
  public var transport: @MainActor @Sendable (ServerEndpoint, MutationRules) -> any RarogTransporting
  /// Transport parowania pod cel z linku: bez klucza.
  public var pairing: @MainActor @Sendable (PairingTarget) -> any RarogTransporting
  /// Jednorazowy transport do odpięcia poprzedniego klucza na jego serwerze (`POST /api/devices/forget`).
  /// Domyślnie ten sam co ``transport``.
  public var forgetTransport: @MainActor @Sendable (ServerEndpoint, MutationRules) -> any RarogTransporting
  /// Koniec tożsamości poprzedniego punktu końcowego po przełączeniu na nowy klucz (stare połączenia i klienci).
  /// Domyślnie nic.
  public var release: @MainActor @Sendable (ServerEndpoint) -> Void
  /// Te same klucz, konto i transport, nowe trasy po zapisie w miejscu (para iroh z sondy wersji): wybór drogi
  /// następnej generacji. Domyślnie nic.
  public var credentialChanged: @MainActor @Sendable (ServerEndpoint) -> Void
  /// Zapomina dane apki spoza rdzenia trzymane w pamięci procesu (niewysłane załączniki z półki) przy wejściu
  /// w inną przestrzeń danych (inny serwer, „Zapomnij serwer”). Pliki należą do przestrzeni (`ServerSpaces`).
  public var wipeAppData: @MainActor @Sendable () -> Void
  /// Before pairing over iroh (`.iroh` and `.both`): the relay registry client registers the app and sponsors the
  /// link's server. The core waits for it at most ``RelayPairingTiming/prepareCeiling``. Default `.skipped`
  /// (pairing as without a registry).
  public var relayPrepare: @MainActor @Sendable (PairingTarget) async -> RelayPrepareResult
  /// "Remove me from the registry": the registry client forgets this device and returns its status. Default
  /// `.inactive`.
  public var relayForget: @MainActor @Sendable () async -> RelayAccessStatus

  public init(
    keychain: any DeviceKeychain, label: String, build: Int,
    transport: @escaping @MainActor @Sendable (ServerEndpoint, MutationRules) -> any RarogTransporting,
    pairing: @escaping @MainActor @Sendable (PairingTarget) -> any RarogTransporting,
    forgetTransport: (@MainActor @Sendable (ServerEndpoint, MutationRules) -> any RarogTransporting)? = nil,
    release: @escaping @MainActor @Sendable (ServerEndpoint) -> Void = { _ in },
    credentialChanged: @escaping @MainActor @Sendable (ServerEndpoint) -> Void = { _ in },
    wipeAppData: @escaping @MainActor @Sendable () -> Void = {},
    relayPrepare: @escaping @MainActor @Sendable (PairingTarget) async -> RelayPrepareResult = { _ in .skipped },
    relayForget: @escaping @MainActor @Sendable () async -> RelayAccessStatus = { .inactive }
  ) {
    self.keychain = keychain
    self.label = label
    self.build = build
    self.transport = transport
    self.pairing = pairing
    self.forgetTransport = forgetTransport ?? transport
    self.release = release
    self.credentialChanged = credentialChanged
    self.wipeAppData = wipeAppData
    self.relayPrepare = relayPrepare
    self.relayForget = relayForget
  }

}
