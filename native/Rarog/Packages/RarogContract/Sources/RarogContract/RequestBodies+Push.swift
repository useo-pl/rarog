// Ciała tras APNs i Live Activity — lustro `apnsRegisterBodySchema`,
// `apnsUnregisterBodySchema`, `apnsStatusBodySchema`, `liveActivityRegisterBodySchema`
// i `liveActivityEndBodySchema` z `shared/src/rest.ts`. Serwer waliduje je ściśle, więc pola bez
// wartości nie lecą wcale (synteza `Encodable` pomija `nil`). Tokeny to hex `Data` z systemu.

/// Środowisko APNs z profilu podpisu apki (`aps-environment`): `development` = sandbox.
public enum ApnsEnvironment: String, Sendable, Equatable, Encodable, CaseIterable {
  case development
  case production
}

/// `POST /api/push/apns` → 204 — upsert tokenu urządzenia (przy starcie i powrocie z tła).
///
/// `alerts` = zgoda systemowa na powiadomienia (`denied`/`notDetermined` → `false`, wpis zostaje
/// dla Live Activity). `test == true` prosi o push próbny po zapisie (dławik per token, 429 nie
/// cofa rejestracji). `label` jak etykieta urządzenia apki (`iPad·Rarog`) — serwer jej nie loguje.
/// `topic` = bundle id apki, czyli temat APNs, pod którym jej token przyjmuje pushe: serwer trzyma go
/// w wpisie i wysyła pod nim; temat inny niż serwera to 400 `topic-mismatch`. `nil` (apka nie zna
/// swojego bundle id) = pole nie leci, a serwer traktuje wpis jak apkę sprzed pola (temat legacy).
/// `pushFormats` = formaty banera, które ta apka czyta: serwer zapisuje deklarację w wpisie TEJ rejestracji
/// i daje mu baner formatu 3 (treść szyfrowana, blok `rarog`), gdy deklaracja ma 3.
/// `locKeys` = katalog apki ma klucze lokalizacji pushy (`push.placeholder.*`, `push.chime.*`): serwer zapisuje
/// deklarację w wpisie TEJ rejestracji i wysyła mu tekst zastępczy banera i dzwonek kafla kluczami zamiast polskich
/// literałów. Ta wersja apki deklaruje zawsze; rejestracja bez pola albo z `false` zdejmuje deklarację.
public struct ApnsRegisterBody: Sendable, Equatable, Encodable {
  /// Formaty banera, które ta wersja apki czyta: wyłącznie koperta formatu 3 (NSE albo apka).
  public static let supportedPushFormats = [PushEnvelope.version]

  public var token: String
  public var environment: ApnsEnvironment
  public var label: String
  public var alerts: Bool
  public var test: Bool?
  public var topic: String?
  public var pushFormats: [Int]
  public var locKeys: Bool

  public init(
    token: String, environment: ApnsEnvironment, label: String, alerts: Bool, test: Bool? = nil, topic: String? = nil,
    pushFormats: [Int] = ApnsRegisterBody.supportedPushFormats, locKeys: Bool = true
  ) {
    self.token = token
    self.environment = environment
    self.label = label
    self.alerts = alerts
    self.test = test
    self.topic = topic
    self.pushFormats = pushFormats
    self.locKeys = locKeys
  }
}

/// Sam token urządzenia: `POST /api/push/apns/unregister` (204, idempotentnie) i
/// `POST /api/push/apns/status` (token w ciele, nie w query — logi Caddy notują zapytanie).
public struct ApnsTokenBody: Sendable, Equatable, Encodable {
  public var token: String

  public init(token: String) {
    self.token = token
  }
}

/// `POST /api/push/live-activity` → 204 — token aktualizacji aktywności przypięty do urządzenia.
/// Nowy `activityId` zastępuje poprzednią aktywność; ten sam id z nowym tokenem to rotacja.
public struct LiveActivityRegisterBody: Sendable, Equatable, Encodable {
  public var deviceToken: String
  public var activityId: String
  public var updateToken: String

  public init(deviceToken: String, activityId: String, updateToken: String) {
    self.deviceToken = deviceToken
    self.activityId = activityId
    self.updateToken = updateToken
  }
}

/// `POST /api/push/live-activity/end` → 204. `activityId` jest wymagany: spóźnione „zakończ"
/// starej aktywności nie może zamknąć nowej (serwer ignoruje id, które nie pasuje).
public struct LiveActivityEndBody: Sendable, Equatable, Encodable {
  public var deviceToken: String
  public var activityId: String

  public init(deviceToken: String, activityId: String) {
    self.deviceToken = deviceToken
    self.activityId = activityId
  }
}
