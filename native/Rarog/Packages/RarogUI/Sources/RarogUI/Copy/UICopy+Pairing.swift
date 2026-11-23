import Foundation
import RarogContract
import RarogCore

// Copy parowania i ekranu „Serwer”. Właściciel: parowanie. Stan i reguły: `RarogCore/Pairing.swift`,
// `RarogStore+Pairing`. Ścieżka „Ustawienia → Parowanie → Sparuj nowe urządzenie” jest ta sama co w odmowie
// `rarog pair` na Macu (`server/src/auth/admin.ts`), więc nazwy przycisków i sekcji się z nią zgadzają.

extension UICopy {
  // MARK: Ekran startowy

  public static var pairTitle: String { L("pairing.title") }
  public static var pairLead: String { L("pairing.lead") }
  /// Komenda CLI, którą akapit parowania pokazuje pismem kodu.
  static let pairCommand = "rarog pair"

  /// Akapit z komendą `rarog pair` jako kod (`inlinePresentationIntent = .code`: `Text` rysuje ją pismem stałej
  /// szerokości, jak kod w markdownie). Tekst zostaje znak w znak, więc VoiceOver i zaznaczanie widzą to samo.
  static func pairCommandCode(_ text: String) -> AttributedString {
    var out = AttributedString(text)
    var rest = out.startIndex..<out.endIndex
    while let range = out[rest].range(of: pairCommand) {
      out[range].inlinePresentationIntent = .code
      rest = range.upperBound..<out.endIndex
    }
    return out
  }
  public static var pairScan: String { L("pairing.scan") }
  public static var pairHaveLink: String { L("pairing.haveLink") }
  public static var pairLinkField: String { L("pairing.linkField") }
  /// Tekst zastępczy pola — początek linku z `rarog pair`.
  public static var pairLinkPrompt: String { L("pairing.linkPrompt") }
  public static var pairLinkNext: String { L("pairing.linkNext") }

  // MARK: Arkusz potwierdzenia

  public static func pairConfirmTitle(_ host: String) -> String { L("pairing.confirmTitle", host) }

  /// „Sparować z <host>?” według celu linku: host adresu z `u=`, a link tylko przez iroh (`k`+`r`) — skrót
  /// `iroh · <8 znaków EndpointId>`.
  public static func pairConfirmTitle(_ link: PairingLink) -> String {
    if link.serverURL == nil, let iroh = link.iroh { return L("pairing.confirmTitle.iroh", irohShort(iroh.endpointId)) }
    return pairConfirmTitle(link.host)
  }

  /// Linia pod tytułem karty: adres z `u=`, a dla linku tylko przez iroh pełny EndpointId (do porównania z wydrukiem
  /// `rarog pair`). Identyfikator, nie tekst katalogu.
  public static func pairConfirmSubtitle(_ link: PairingLink) -> String {
    link.serverURL?.absoluteString ?? link.iroh?.endpointId ?? ""
  }

  /// Pierwsze 8 znaków EndpointId — ten sam skrót co `ServerIrohConfig.shortName` w rdzeniu.
  static func irohShort(_ endpointId: String) -> String { String(endpointId.prefix(8)) }

  /// "Server key fingerprint: 1a2b 3c4d 5e6f 7a8b" for a link with `k` (``ServerIrohConfig/fingerprint``); `nil` for a
  /// link without a server key.
  public static func pairFingerprint(_ link: PairingLink) -> String? {
    link.iroh.map { L("pairing.fingerprint", $0.fingerprint) }
  }

  /// The warning of the sheet for a link to another server than the paired one, with the paired
  /// server's name: the name from pairing (the host of the server's machine), else its address or iroh short name.
  public static func pairReplaceWarning(_ paired: PairedServer) -> String {
    let name =
      if !paired.serverName.isEmpty { paired.serverName }
      else if let url = paired.url { url.host(percentEncoded: false) ?? url.absoluteString }
      else { paired.iroh.map { serverIroh($0.endpointId) } ?? "" }
    return L("pairing.replaceWarning", name)
  }

  /// "Replace" beside the warning: pairs with the other server and ends the current pairing.
  public static var pairReplace: String { L("pairing.replace") }
  public static var pairConfirmBody: String { L("pairing.confirmBody") }
  public static var pairConfirm: String { L("pairing.confirm") }
  public static var pairCancel: String { L("pairing.cancel") }
  public static var pairBusy: String { L("pairing.busy") }
  public static var pairRejectedTitle: String { L("pairing.rejectedTitle") }

  /// Odmowa parowania pod przyciskiem.
  public static func pairFailure(_ failure: PairingFailure) -> String {
    switch failure {
    case .codeRejected: L("pairing.failure.codeRejected")
    case .serverTooOld: L("pairing.failure.serverTooOld")
    case .versionMismatch: L("pairing.failure.versionMismatch")
    case let .forbidden(message): message.map { L("pairing.failure.forbidden", $0) } ?? forbiddenBody
    case let .rateLimited(retryAfter): pairRateLimited(retryAfter: retryAfter)
    case .offline: L("pairing.failure.offline")
    case .timedOut: timedOut
    case let .keychain(status): L("pairing.failure.keychain", Int(status))
    case let .failed(message): message ?? L("pairing.failure.failed")
    }
  }

  static func pairRateLimited(retryAfter: Int?) -> String {
    guard let seconds = retryAfter, seconds > 0 else { return L("pairing.rateLimited") }
    let wait = RelativeTime.short(since: Date(timeIntervalSince1970: 0), now: Date(timeIntervalSince1970: Double(seconds)))
    return L("pairing.rateLimited.retryAfter", wait)
  }

  /// Tekst, który nie jest linkiem parowania (wklejenie, skan, adres `rarog://`).
  public static func pairLinkError(_ error: PairingLinkError) -> String {
    switch error {
    case .notALink: L("pairing.linkError.notALink")
    case .unsupportedVersion: L("pairing.linkError.unsupportedVersion")
    case .badAddress: L("pairing.linkError.badAddress")
    case .badCode: L("pairing.linkError.badCode")
    }
  }

  // MARK: Odpięte i nieznane urządzenie

  public static var revokedTitle: String { L("pairing.revokedTitle") }

  /// „Serwer rarog.example odpiął to urządzenie 4 paź o 10:03 (na Macu). Sparuj je ponownie.”
  public static func revokedBody(
    _ revocation: DeviceRevocation, _ machine: ServerMachine, timeZone: TimeZone = .current
  ) -> String {
    let when = ServerTime.parse(revocation.revokedAt).map {
      L("pairing.revokedBody.when", ServerTime.day($0, timeZone: timeZone), ServerTime.clock($0, timeZone: timeZone))
    }
    let server = revocation.server.isEmpty ? L("pairing.revokedBody.server") : L("pairing.revokedBody.namedServer", revocation.server)
    let reason = revokedBy(revocation.revokedBy, machine)
    return when.map { L("pairing.revokedBody.at", server, $0, reason) } ?? L("pairing.revokedBody", server, reason)
  }

  /// Przyczyna odpięcia z `revokedBy`.
  public static func revokedBy(_ by: String, _ machine: ServerMachine) -> String {
    switch by {
    case "admin": machine == .mac ? L("pairing.revokedBy.admin") : L("pairing.revokedBy.admin.vps")
    case "forget": L("pairing.revokedBy.forget")
    case "expired": L("pairing.revokedBy.expired")
    default: L("pairing.revokedBy.otherDevice")
    }
  }

  public static var unknownTitle: String { L("pairing.unknownTitle") }
  public static var unknownBody: String { L("pairing.unknownBody") }
  public static var unknownRetry: String { L("pairing.unknownRetry") }

  // MARK: Ustawienia → Serwer

  public static var settingsTitle: String { L("pairing.settingsTitle") }
  public static var settingsClose: String { L("pairing.settingsClose") }
  public static var serverSection: String { L("pairing.serverSection") }
  public static var serverAddress: String { L("pairing.serverAddress") }
  /// The short name of a server reached over iroh, `iroh · 1a2b3c4d`: the Settings server row without a machine name
  /// and the warning for a link to another server.
  public static func serverIroh(_ endpointId: String) -> String { L("pairing.serverIroh", irohShort(endpointId)) }
  public static func serverName(_ machine: ServerMachine) -> String {
    machine == .mac ? L("pairing.serverName") : L("pairing.serverName.vps")
  }
  public static var serverAuth: String { L("pairing.serverAuth") }
  public static var serverAuthKey: String { L("pairing.serverAuthKey") }
  public static var serverNone: String { L("pairing.serverNone") }
  public static var serverThisDevice: String { L("pairing.serverThisDevice") }
  public static var serverDeviceId: String { L("pairing.serverDeviceId") }
  public static var serverPairedAt: String { L("pairing.serverPairedAt") }

  // MARK: Ustawienia → Serwer → wiersz języka apki

  // Jawny język z domyślnym językiem procesu: wiersz nazywa język procesu, a test sprawdza teksty obu języków bez
  // globalnego przełącznika. Składa je `AppLanguageRow`.
  static func languageLabel(_ language: CopyLanguage = .current) -> String {
    L("pairing.languageLabel", language: language)
  }
  /// Nazwa języka w nim samym („English”, „Polski”), nie tłumaczenie słowa „angielski”.
  static func languageName(_ language: CopyLanguage = .current) -> String {
    L("pairing.languageValue", language: language)
  }
  static func languageHint(_ language: CopyLanguage = .current) -> String {
    L("pairing.languageHint", language: language)
  }

  // MARK: Ustawienia → Parowanie

  /// Nagłówek sekcji kodu dla nowego urządzenia: inny niż przycisk „Sparuj nowe urządzenie” w niej.
  public static var pairIssueSection: String { L("pairing.issueSection") }
  public static var pairNewDevice: String { L("pairing.newDevice") }
  public static var pairNewLead: String { L("pairing.newLead") }
  public static var pairCodeIssuing: String { L("pairing.codeIssuing") }
  public static var pairCodeShare: String { L("pairing.codeShare") }
  public static var pairCodeAgain: String { L("pairing.codeAgain") }
  public static var pairCodeHide: String { L("pairing.codeHide") }
  public static var pairCodeExpired: String { L("pairing.codeExpired") }
  public static var pairCodeImage: String { L("pairing.codeImage") }

  /// „Ważny jeszcze 4:59”.
  public static func pairCodeRemaining(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded(.up)))
    return L("pairing.codeRemaining", total / 60, String(format: "%02d", total % 60))
  }

  public static func pairCodeFailure(_ failure: PairingFailure) -> String {
    switch failure {
    case .serverTooOld: L("pairing.codeFailure")
    default: pairFailure(failure)
    }
  }

  // MARK: Ustawienia → Urządzenia i „Zapomnij serwer”

  public static var devicesSection: String { L("pairing.devicesSection") }
  public static var devicesLoading: String { L("pairing.devicesLoading") }
  public static var deviceCurrent: String { L("pairing.deviceCurrent") }
  public static var deviceNeverSeen: String { L("pairing.deviceNeverSeen") }

  /// Podpis wiersza urządzenia: „sparowane 4 paź · kod z Maca · ostatnio 10:02”.
  public static func deviceDetail(
    _ device: DeviceInfo, labels: [String: String], _ machine: ServerMachine, timeZone: TimeZone = .current
  ) -> String {
    var parts: [String] = []
    if let created = ServerTime.parse(device.createdAt) { parts.append(L("pairing.deviceDetail.paired", ServerTime.day(created, timeZone: timeZone))) }
    parts.append(deviceCreator(device.creator, labels: labels, machine))
    if let seen = device.lastSeenAt.flatMap(ServerTime.parse) {
      parts.append(L("pairing.deviceDetail.lastSeen", ServerTime.dayClock(seen, timeZone: timeZone)))
    } else {
      parts.append(deviceNeverSeen)
    }
    return list(parts, .dot)
  }

  /// Twórca kodu: maszyna serwera (`admin`, słowem „Mac” albo „VPS”) albo etykieta urządzenia, które go wydało (gdy
  /// jest na liście).
  public static func deviceCreator(_ creator: String, labels: [String: String], _ machine: ServerMachine) -> String {
    if creator == "admin" { return machine == .mac ? L("pairing.deviceCreator.mac") : L("pairing.deviceCreator.mac.vps") }
    return L("pairing.deviceCreator.device", labels[creator] ?? String(creator.prefix(8)))
  }

  public static var forgetServer: String { L("pairing.forgetServer") }
  public static var forgetBusy: String { L("pairing.forgetBusy") }
  public static var forgetConfirmTitle: String { L("pairing.forgetConfirmTitle") }
  public static var forgetConfirmBody: String { L("pairing.forgetConfirmBody") }
  /// „Zapomnij serwer” przerwane: dysk nie dał skasować danych serwera, więc klucz i dane zostały.
  public static var forgetFailed: String { L("pairing.forgetFailed") }
  /// Ekran bez zalogowania w trakcie „Zapomnij serwer” (najwyżej kilka sekund): bez parowania i ponowienia.
  public static var forgettingTitle: String { L("pairing.forgettingTitle") }
  public static var forgettingBody: String { L("pairing.forgettingBody") }

  // MARK: Notka i push o nowym urządzeniu

  /// „Nowe urządzenie: iPad·Rarog, 4 paź 10:01, kod z iPhone·Rarog” (trwały ślad).
  public static func newDeviceNotice(
    _ notice: NewDeviceNotice, _ machine: ServerMachine, timeZone: TimeZone = .current
  ) -> String {
    let when = ServerTime.parse(notice.createdAt).map { ServerTime.dayClock($0, timeZone: timeZone) }
    let creator =
      switch (notice.creatorIsAdmin, machine) {
      case (true, .mac): L("pairing.newDeviceNotice.fromMac")
      case (true, .vps): L("pairing.newDeviceNotice.fromMac.vps")
      case (false, _): L("pairing.newDeviceNotice.fromDevice", notice.creator)
      }
    switch (when, machine) {
    case let (when?, .mac): return L("pairing.newDeviceNotice.at", notice.label, when, creator)
    case let (when?, .vps): return L("pairing.newDeviceNotice.at.vps", notice.label, when, creator)
    case (nil, .mac): return L("pairing.newDeviceNotice", notice.label, creator)
    case (nil, .vps): return L("pairing.newDeviceNotice.vps", notice.label, creator)
    }
  }

  public static var newDeviceDismiss: String { L("pairing.newDeviceDismiss") }

  // MARK: Skaner

  public static var scannerTitle: String { L("pairing.scannerTitle") }
  public static var scannerClose: String { L("pairing.scannerClose") }
  public static var scannerHint: String { L("pairing.scannerHint") }
  public static var scannerUnavailable: String { L("pairing.scannerUnavailable") }
}
