import Foundation
import RarogContract
import RarogTransport

// What the app reads from a notification, an app address (`rarog://`, the universal pairing link `https://`) and the
// signing profile. Pure functions without UIKit: the app passes `userInfo`, the address and the bytes of
// `embedded.mobileprovision`, the core returns facts.
// Właściciel: push.

/// Cel tapnięcia w powiadomienie albo adresu `rarog://session/<id>`.
public struct PushTarget: Sendable, Equatable {
  public let sessionId: String
  /// Terminal wpisu Codexa: nawigacja otwiera ekran tego terminala (`RarogNavigation.openPushTarget`).
  public let termId: String?

  public init(sessionId: String, termId: String? = nil) {
    self.sessionId = sessionId
    self.termId = termId
  }
}

/// Rodzaj sesji z liczby na kaflu Live Activity (`rarog://jump/<rodzaj>`). Te same definicje co
/// liczniki kafla (`server/src/notify/live-activity-state.ts`) i kropka listy: ``AppState/firstSession(_:)``.
public enum SessionJump: String, Sendable, Equatable, CaseIterable {
  /// Zgoda albo pytanie.
  case waiting
  /// Praca, także zadanie w tle po turze.
  case working
  /// Nieodebrany wynik bez pracy w tle.
  case finished
}

/// Dokąd prowadzi adres `rarog://`.
public enum AppLink: Sendable, Equatable {
  /// `rarog://session/<id>`, `rarog://terminal/<termId>?session=<id>` — ta sama droga co tap w powiadomienie.
  case session(PushTarget)
  /// Liczba na kaflu Live Activity: pierwsza sesja tego rodzaju w kolejności listy, rozstrzygana przy otwarciu.
  case jump(SessionJump)
  /// Tło kafla i zwinięta wyspa: lista agentów.
  case list
  /// `rarog://pair#v=1&u=…&c=…` or the universal link `https://<PairingLinkWire.host>/pair#v=1&…`: the
  /// pairing link — the "Pair with <host>?" sheet, never a silent swap.
  case pair(PairingLink)
  /// A pairing address (`rarog://pair…`, `https://<PairingLinkWire.host>/pair…`) this app does not understand (another
  /// version, a cut code): the sheet says what is wrong.
  case badPair(PairingLinkError)
}

/// Skąd apka wzięła rodzaj i cel powiadomienia — trafia do `client.log`, bez treści.
public enum PushNoteSource: String, Sendable, Equatable {
  /// `rarogOpen` dopisany przez rozszerzenie powiadomień po odszyfrowaniu banera v3.
  case serviceExtension = "NSE"
  /// Blok `rarog` v3 odszyfrowany w apce kluczem z Keychaina (NSE nie zdążył, nie miał klucza, apka na wierzchu).
  case app = "apka"
  /// Jawny blok `rarog` v1 (serwer go nie wysyła; pushe testów UI przez `simctl push`).
  case v1
}

/// Powiadomienie odczytane z `userInfo`.
public struct PushNote: Sendable, Equatable {
  /// `nil` = rodzaj nieznany tej wersji apki.
  public let kind: ApnsPushKind?
  /// `nil` = push bez sesji (próbny, `device-paired`, `version-changed`, `weekly-limit`) albo cudzy.
  public let target: PushTarget?
  /// Źródło rodzaju i celu.
  public let source: PushNoteSource

  public init(kind: ApnsPushKind?, target: PushTarget?, source: PushNoteSource = .v1) {
    self.kind = kind
    self.target = target
    self.source = source
  }

  /// The Settings screen a tap opens instead of a session, independent of the session list: Pairing for a new device
  /// (`device-paired`), Server for a new Claude Code or herdr version (`version-changed`); `nil` for other kinds.
  public var opensSettings: SettingsScreen? {
    switch kind {
    case .devicePaired: .pairing
    case .versionChanged: .server
    default: nil
    }
  }

  /// A tap opens the session list (`AppLink.list`, the same path as the Live Activity background): the weekly limit
  /// push (`weekly-limit`), because the list footer shows the week with its reset time.
  public var opensList: Bool { kind == .weeklyLimit }

  /// The system shows a banner in the foreground for the sessionless pushes about the server or the account: a new
  /// device (`device-paired`), a new Claude Code or herdr version (`version-changed`) and the weekly limit
  /// (`weekly-limit`). Other kinds stay silent there: presence mutes them, and the in-app toast speaks about
  /// another session.
  public var showsBannerInForeground: Bool {
    kind == .devicePaired || kind == .versionChanged || kind == .weeklyLimit
  }
}

/// Co apka wyczytała z `userInfo` powiadomienia. Delegat oddaje to magazynowi, żeby `client.log` odróżnił
/// „push dotarł, ale apka go nie otworzy” od „delegat nic nie dostał”.
public enum PushInspection: Sendable, Equatable {
  /// Rodzaj, cel i źródło.
  case note(PushNote)
  /// Blok `rarog` v3, którego apka nie otworzy (brak klucza dla `kid`, Keychain, AEAD, zła koperta) — tap otwiera
  /// samą apkę, a magazyn pisze linię z powodem. Powód nigdy nie niesie treści (``PushRefusal``).
  case unreadableV3(PushRefusal)
  /// Nie nasz kształt: brak bloku `rarog`, blok spoza kontraktu, wersja, której ta apka nie zna.
  case foreign
}

public enum PushRouting {
  /// Schemat adresów apki (`CFBundleURLTypes`): `rarog://session/<id>`.
  public static let scheme = "rarog"

  /// `userInfo` powiadomienia → rodzaj, cel i źródło. Po kolei: `rarogOpen` z rozszerzenia powiadomień
  /// (nieczytelny — dalej, nie koniec), blok `rarog` v3 odszyfrowany kluczem apki (bez sprawdzania `exp`: stare
  /// powiadomienie z Centrum powiadomień dalej otwiera sesję), jawny blok `rarog` v1. v3, którego apka nie otworzy,
  /// nie spada do v1: oddaje powód (``PushInspection/unreadableV3(_:)``).
  public static func inspect(userInfo: [AnyHashable: Any], keys: any PushKeyReader) -> PushInspection {
    if let open = PushOpen(userInfoValue: userInfo[PushOpen.userInfoKey]) {
      return .note(PushNote(kind: open.kind, target: target(open.sessionId, open.termId), source: .serviceExtension))
    }
    switch PushOpening.open(userInfo: userInfo, keys: keys) {
    case let .success(plaintext):
      return .note(PushNote(kind: plaintext.kind, target: target(plaintext.sessionId, plaintext.termId), source: .app))
    case .failure(.notV3):
      break
    case let .failure(refusal):
      return .unreadableV3(refusal)
    }
    return v1(userInfo: userInfo).map(PushInspection.note) ?? .foreign
  }

  /// ``inspect(userInfo:keys:)`` bez powodu odmowy: `nil` = nie nasz kształt albo v3, którego apka nie otworzy
  /// (tap otwiera wtedy samą apkę).
  public static func note(userInfo: [AnyHashable: Any], keys: any PushKeyReader) -> PushNote? {
    guard case let .note(note) = inspect(userInfo: userInfo, keys: keys) else { return nil }
    return note
  }

  /// Jawny blok `rarog` v1.
  private static func v1(userInfo: [AnyHashable: Any]) -> PushNote? {
    var object: [String: Any] = [:]
    for (key, value) in userInfo {
      if let key = key as? String { object[key] = value }
    }
    guard JSONSerialization.isValidJSONObject(object),
      let data = try? JSONSerialization.data(withJSONObject: object),
      let rarog = (try? JSONDecoder().decode(ApnsAlertEnvelope.self, from: data))?.rarog,
      rarog.version == ApnsRarogPayload.supportedVersion
    else { return nil }
    return PushNote(kind: rarog.kind, target: target(rarog.sessionId, rarog.termId), source: .v1)
  }

  private static func target(_ sessionId: String?, _ termId: String?) -> PushTarget? {
    sessionId.map { PushTarget(sessionId: $0, termId: termId) }
  }

  /// Path of the universal pairing link `https://<PairingLinkWire.host>/pair#…`; the site's association file hands
  /// the app only this path.
  private static let universalPairPath = "/pair"

  /// An app address → its target: `rarog://pair#…`, `list`, `jump/<kind>` (the Live Activity tile) or a session as in
  /// ``target(url:)``. The universal link `https://<PairingLinkWire.host>/pair#…` (the `applinks:` entitlement) goes
  /// to the same pairing route as `rarog://pair#…`; any other `https` address and an unknown address → `nil`, the app
  /// just opens.
  public static func link(url: URL) -> AppLink? {
    switch url.scheme?.lowercased() {
    case scheme:
      break
    case "https":
      guard url.host()?.lowercased() == PairingLinkWire.host, url.path() == universalPairPath else { return nil }
      return pair(url)
    default:
      return nil
    }
    let segments = url.pathComponents.filter { $0 != "/" }
    switch url.host() {
    case "pair":
      return pair(url)
    case "list":
      return segments.isEmpty ? .list : nil
    case "jump":
      guard segments.count == 1, let kind = SessionJump(rawValue: segments[0]) else { return nil }
      return .jump(kind)
    default:
      return target(url: url).map(AppLink.session)
    }
  }

  /// A pairing address (either prefix) → the confirmation sheet, or the sheet saying what is wrong with the link.
  private static func pair(_ url: URL) -> AppLink {
    switch PairingLink.parse(url: url) {
    case let .success(link): return .pair(link)
    case let .failure(error): return .badPair(error)
    }
  }

  /// `rarog://session/<id>` → cel; `rarog://terminal/<termId>?session=<id>` (kafel Live Activity
  /// wpisu Codexa) → cel z terminalem; inny adres (sam `rarog://`, nieznana ścieżka, terminal bez
  /// sesji albo spoza `TERM_ID_RE`) → `nil`, czyli sama apka.
  public static func target(url: URL) -> PushTarget? {
    guard url.scheme?.lowercased() == scheme else { return nil }
    let segments = url.pathComponents.filter { $0 != "/" }
    guard segments.count == 1, let id = segments.first, !id.isEmpty else { return nil }
    switch url.host() {
    case "session":
      return PushTarget(sessionId: id)
    case "terminal":
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      guard LiveActivityContentState.Top.acceptsTermId(id),
        let session = query.first(where: { $0.name == "session" })?.value, !session.isEmpty
      else { return nil }
      return PushTarget(sessionId: session, termId: id)
    default:
      return nil
    }
  }

  /// Adres sesji (dymek, Live Activity, testy UI).
  public static func url(sessionId: String) -> URL? {
    var components = URLComponents()
    components.scheme = scheme
    components.host = "session"
    components.path = "/" + sessionId
    return components.url
  }

  /// Token urządzenia z systemu → hex małymi literami (`APNS_TOKEN_RE` przyjmuje obie wielkości).
  public static func hex(_ token: Data) -> String {
    token.map { String(format: "%02x", $0) }.joined()
  }
}

/// `aps-environment` z `embedded.mobileprovision` apki: CMS z plistą XML w środku. Typ konfiguracji
/// builda o środowisku nie mówi (publikacja to Release z eksportem `debugging` = sandbox), więc
/// prawdą jest profil podpisu, a gdy profilu nie ma — reguła ``pushEnvironment(profile:isSimulator:)``.
public enum ProvisioningProfile {
  public static func apsEnvironment(profile: Data) -> ApnsEnvironment? {
    guard let start = profile.range(of: Data("<?xml".utf8)),
      let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex)
    else { return nil }
    let plist = profile.subdata(in: start.lowerBound..<end.upperBound)
    guard let root = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
      let entitlements = root["Entitlements"] as? [String: Any],
      let raw = entitlements["aps-environment"] as? String
    else { return nil }
    return ApnsEnvironment(rawValue: raw)
  }

  /// Środowisko push apki z profilu podpisu. Profil z `aps-environment` → ta wartość; profil bez
  /// niej → `development`; BRAK profilu na urządzeniu → `production` (App Store i TestFlight nie mają
  /// `embedded.mobileprovision`, TN3125); brak profilu na symulatorze → `development`.
  /// `profile` = bajty pliku profilu albo `nil`, gdy apka go nie ma.
  public static func pushEnvironment(profile: Data?, isSimulator: Bool) -> PushEnvironmentReading {
    guard let profile else {
      return PushEnvironmentReading(environment: isSimulator ? .development : .production, profile: .missing)
    }
    guard let environment = apsEnvironment(profile: profile) else {
      return PushEnvironmentReading(environment: .development, profile: .withoutEnvironment)
    }
    return PushEnvironmentReading(environment: environment, profile: .withEnvironment)
  }
}

/// Profil podpisu, z którego wyszło środowisko push — do śladu w `client.log` (bez treści profilu).
public enum PushProfile: String, Sendable, Equatable {
  case withEnvironment = "z aps-environment"
  case withoutEnvironment = "bez aps-environment"
  case missing = "brak"
}

/// Środowisko push i profil, z którego wyszło (``ProvisioningProfile/pushEnvironment(profile:isSimulator:)``).
public struct PushEnvironmentReading: Sendable, Equatable {
  public let environment: ApnsEnvironment
  public let profile: PushProfile

  public init(environment: ApnsEnvironment, profile: PushProfile) {
    self.environment = environment
    self.profile = profile
  }
}
