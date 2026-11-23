import Foundation
import RarogContract

// Powiadomienia APNs w stanie widoku: zgoda systemowa, odłożenie banera „Włącz", degradacja
// tokenu, komunikaty do dymka i cel tapnięcia. Właściciel: push. Gałąź reduktora wołana
// z głównego `switch` w `Reducer.swift`; akcje i czas w `RarogStore+Push`.

/// Komunikat apki o powiadomieniach do dymka. `serial` odróżnia powtórzenie tego samego zdania.
public struct PushNotice: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// Push próbny DOTARŁ (odebrany na wierzchu) — jedyne źródło „Powiadomienia działają".
    case working
    /// Po zgodzie push próbny nie dotarł w czasie.
    case testMissing
    /// Człowiek odmówił zgody w systemowym pytaniu.
    case denied
    /// Rejestracja się nie udała (system nie dał tokenu, serwer odmówił, sieć).
    case failed
  }

  public let kind: Kind
  public let serial: Int
}

/// Zdarzenie powiadomień w rdzeniu.
public enum PushEvent: Sendable, Equatable {
  case authorization(PushAuthorization)
  /// „×" na banerze „Włącz" (`nil` = odczyt bez odłożenia przy starcie).
  case snoozed(until: Date?)
  /// Status tokenu z `POST /api/push/apns/status`: `enabled` = serwer ma kanał APNs, `degradedSince`
  /// = od kiedy dostawy do tego tokenu nie dochodzą (`nil` = zdrowe), `reason` = przyczyna, gdy serwer
  /// ją zna (`nil` = ogólna).
  case status(enabled: Bool, degradedSince: String?, reason: ApnsDegradedReason? = nil)
  case enabling(Bool)
  case notice(PushNotice.Kind)
  /// Tap w powiadomienie albo adres `rarog://session/<id>`.
  case target(PushTarget)
  /// Nawigacja weszła w cel — zdjęty, chyba że w międzyczasie przyszedł inny.
  case targetConsumed(PushTarget)
  /// Tap w liczbę albo tło kafla Live Activity (`rarog://jump/…`, `rarog://list`).
  case link(PendingLink)
  /// Nawigacja weszła w link — zdjęty, chyba że w międzyczasie przyszedł inny.
  case linkConsumed(PendingLink)
  /// Testy UI: serwer demo nie ma kanału APNs (``RarogStore/simulateApnsChannelForUITests()``).
  case simulatedChannel
}

/// Link z kafla Live Activity czekający na świeżą listę: sesję wybiera się dopiero z niej (``AppState/firstSession(_:)``).
public enum PendingLink: Sendable, Equatable {
  case jump(SessionJump)
  case list
}

/// Stan powiadomień tego urządzenia.
public struct PushState: Sendable, Equatable {
  /// Zgoda systemowa; `nil` = jeszcze nieodczytana.
  public internal(set) var authorization: PushAuthorization?
  /// Baner „Włącz" odłożony „×" do tej chwili (na tydzień).
  public internal(set) var snoozedUntil: Date?
  /// Status tokenu tego urządzenia przeczytany przy kanale APNs (`enabled: true`); bez niego o degradacji
  /// nic nie wiadomo i baneru nie ma.
  public internal(set) var apnsStatusKnown = false
  /// Od kiedy dostawy APNs do TEGO urządzenia nie dochodzą (ISO z serwera); `nil` = zdrowe albo nie wiadomo.
  public internal(set) var apnsDegradedSince: String?
  /// Przyczyna tej degradacji, gdy serwer ją nazwał; bez `apnsDegradedSince` zawsze `nil`.
  public internal(set) var apnsDegradedReason: ApnsDegradedReason?
  /// Pełny stan listy przyszedł strumieniem w BIEŻĄCYM połączeniu. Lista sprzed zejścia w tło jest jeszcze
  /// w pamięci (i nie jest „z pamięci podręcznej"), ale nie zna sesji założonych w międzyczasie.
  public internal(set) var listConfirmed = false
  /// Systemowe pytanie o zgodę w toku (przycisk „Włącz" zajęty).
  public internal(set) var enabling = false
  /// Ostatni komunikat do dymka.
  public internal(set) var notice: PushNotice?
  /// Cel tapnięcia czekający na zalogowanie i świeżą listę. Przeżywa wylogowanie: zimny
  /// start przed zalogowaniem prowadzi przez logowanie do tego celu.
  public internal(set) var pendingTarget: PushTarget?
  /// Link z kafla Live Activity czekający na zalogowanie i świeżą listę; przeżywa wylogowanie jak `pendingTarget`.
  public internal(set) var pendingLink: PendingLink?
  /// Testy UI przeciw demo: kanał APNs udawany po stronie apki (serwer demo go nie ma).
  public internal(set) var simulatedChannel = false

  public init() {}
}

extension AppState {
  mutating func applyPush(_ event: PushEvent) {
    switch event {
    case let .authorization(value):
      push.authorization = value
    case let .snoozed(until):
      push.snoozedUntil = until
    case let .status(enabled, since, reason):
      push.apnsStatusKnown = enabled
      push.apnsDegradedSince = enabled ? since : nil
      // Przyczyna bez chwili degradacji nic nie znaczy — serwer wysyła ją tylko razem z `degradedSince`.
      push.apnsDegradedReason = push.apnsDegradedSince == nil ? nil : reason
    case let .enabling(value):
      push.enabling = value
    case let .notice(kind):
      push.notice = PushNotice(kind: kind, serial: (push.notice?.serial ?? 0) + 1)
    case let .target(target):
      // Ostatnie tapnięcie wygrywa: cel z powiadomienia zdejmuje czekający link z kafla i odwrotnie.
      push.pendingTarget = target
      push.pendingLink = nil
    case let .targetConsumed(target):
      if push.pendingTarget == target { push.pendingTarget = nil }
    case let .link(link):
      push.pendingLink = link
      push.pendingTarget = nil
    case let .linkConsumed(link):
      if push.pendingLink == link { push.pendingLink = nil }
    case .simulatedChannel:
      push.simulatedChannel = true
    }
  }

  /// Logowanie i wylogowanie (`resetView`): wiedza o serwerze znika, fakty urządzenia zostają — zgoda,
  /// odłożenie banera, cel tapnięcia (zimny start przed zalogowaniem) i udawany kanał testów UI.
  mutating func resetPushView() {
    push.apnsStatusKnown = false
    push.apnsDegradedSince = nil
    push.apnsDegradedReason = nil
    push.listConfirmed = false
    push.enabling = false
    push.notice = nil
  }

  /// Serwer ma kanał APNs (sonda `/api/version`) albo testy UI go udają.
  public var apnsChannel: Bool { capabilities?.apns == true || push.simulatedChannel }

  /// Baner „Włącz powiadomienia na tym urządzeniu": zalogowany, serwer ma kanał, system
  /// jeszcze nie pytał i człowiek nie odłożył banera. Po odmowie banera nie ma — naprawić może tylko
  /// Ustawienia systemu (dymek mówi to raz).
  public func pushPromptVisible(now: Date) -> Bool {
    guard auth == .loggedIn, apnsChannel, push.authorization == .notDetermined else { return false }
    guard let until = push.snoozedUntil else { return true }
    return until <= now
  }

  /// Lista ze strumienia bieżącego połączenia, nie z pamięci podręcznej ani sprzed zejścia w tło.
  public var listLive: Bool { push.listConfirmed && !listStale }

  /// Cel tapnięcia gotowy do wejścia: zalogowany i lista bieżącego połączenia — przed nią karta byłaby
  /// nieświeża i bez akcji, a sesja założona w tle mignęłaby jako „nie znam takiej sesji".
  public var readyPushTarget: PushTarget? {
    guard auth == .loggedIn, listLive else { return nil }
    return push.pendingTarget
  }

  /// Link z kafla gotowy do wejścia — ta sama bramka co ``readyPushTarget``: sesję „pierwszą czekającą” wybiera
  /// się ze świeżej listy, nie z tej sprzed zejścia w tło.
  public var readyLink: PendingLink? {
    guard auth == .loggedIn, listLive else { return nil }
    return push.pendingLink
  }


  /// Degradacja powiadomień do banera: wyłącznie status tokenu APNs TEGO urządzenia — jedyny
  /// kanał powiadomień. Status nieprzeczytany albo serwer bez kanału = bez banera.
  public var notificationsDegradedSince: String? {
    push.apnsDegradedSince
  }

  /// Plakietka: sesje stojące na decyzji — ta sama definicja co bursztyn na liście
  /// i `aps.badge` z serwera. Skończone się nie liczą: nikogo nie blokują.
  public var badgeCount: Int {
    sessions.values.reduce(0) { $0 + ($1.isWaitingForDecision ? 1 : 0) }
  }
}
