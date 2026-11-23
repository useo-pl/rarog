import Foundation
import RarogContract

// Live Activity systemu widziana z rdzenia. Rdzeń jest bez UIKit i bez ActivityKit, więc apka
// wstrzykuje adapter (`Rarog/LiveActivityController.swift`: `Activity<RarogActivityAttributes>`) przez
// `RarogStore.attachActivities`, a testy rdzenia podają atrapę. Reguły cyklu życia: `RarogStore+LiveActivity`.
// Właściciel: Live Activity.

/// Treść kafla tak, jak ją widzi system (`ActivityContent`): stan i chwila, po której kafel pokaże dane jako
/// nieświeże, jeśli nic nowego nie przyjdzie (`nil` = bez takiej chwili). Start niesie ją zawsze; treść, którą
/// system trzyma, ma ją z ostatniego pusha albo zapisu.
public struct LiveActivityContent: Sendable, Equatable {
  public let state: LiveActivityContentState
  public let staleDate: Date?

  public init(state: LiveActivityContentState, staleDate: Date?) {
    self.state = state
    self.staleDate = staleDate
  }
}

/// Wejście systemu o aktywności.
public enum ActivitySystemEvent: Sendable, Equatable {
  /// Token aktualizacji z `pushTokenUpdates` — pierwszy i każdy po rotacji.
  case token(activityId: String, Data)
  /// Aktywność zakończona z zewnątrz (`ended` albo `dismissed`): koniec z serwera, 8 h systemu, człowiek.
  case ended(activityId: String)
  /// Nowa treść aktywności z `contentUpdates`, stan i `staleDate` (push serwera; czy także zapis samej apki, nie
  /// wiadomo). Rdzeń liczy z niej zapisy cofnięte do `client.log` i pamięta push, który przyszedł w trakcie zapisu
  /// z apki (zapis naprawczy w `RarogStore+LiveActivity`) — zapisu liczników nie budzi.
  case content(activityId: String, LiveActivityContent)
}

/// Live Activity urządzenia (ActivityKit bez ActivityKit).
@MainActor
public protocol ActivityRequesting: AnyObject {
  /// Ustawienia → Rarog → Aktywności na żywo (i systemowy wyłącznik). Czytane tuż przed startem.
  var activitiesEnabled: Bool { get }
  /// Częste aktualizacje włączone (`NSSupportsLiveActivitiesFrequentUpdates` w `Info.plist`: wyższy budżet pilnych
  /// aktualizacji z serwera; człowiek może je wyłączyć w Ustawieniach). Tylko do `client.log`.
  var frequentPushesEnabled: Bool { get }
  /// Treść, którą system trzyma dla żywej aktywności o tym id; `nil` = takiej aktywności nie ma. Czyta ją zapis
  /// z apki (liczniki i znany znacznik kafla przed zapisem, nakładka, potem sprawdzenie, czy system zapis przyjął)
  /// i detektor zatrzymanego kafla w `client.log` (wiek `updatedEpoch` serwera).
  func displayedContent(_ id: String) -> LiveActivityContent?
  /// Id aktywności tej apki, które system może jeszcze pokazywać na ekranie blokady: żywe (`active`, `stale`,
  /// `pending`) i zakończone, a jeszcze widoczne (`ended`); zdjęte (`dismissed`) już nie. Także z poprzedniego
  /// uruchomienia procesu (osierocone). Rdzeń kończy je przed startem nowej i przy wylogowaniu albo braku kanału.
  func shownActivityIds() -> [String]
  /// Start aktywności z tokenem aktualizacji (`pushType: .token`); wymaga apki na wierzchu. Zwraca id.
  /// `serverSystem` jedzie w atrybutach aktywności (`RarogActivityAttributes`, stałych przez całe jej życie): z niego
  /// kafel bierze słowo maszyny serwera (``ServerMachine``). Token, koniec i nowa treść przychodzą przez
  /// ``observe(_:)``.
  func request(_ content: LiveActivityContent, serverSystem: ServerSystem?) throws -> String
  /// Zapis treści z apki (`Activity.update(_:alertConfiguration:timestamp:)`, bez alertu). `timestamp` (pełna
  /// sekunda zegara serwera, ``AppState/liveActivityAsOf``) stawia zapis w jednym porządku z pushami serwera (ich
  /// `aps.timestamp`): system pomija zapis starszy niż ostatni push
  /// albo zapis, a także zapis do zakończonej aktywności. Wraca, gdy system zapis obsłużył; czy go przyjął, mówi
  /// ``displayedContent(_:)``.
  func update(_ id: String, state: LiveActivityContentState, staleDate: Date?, timestamp: Date) async
  /// Koniec od razu, bez zostawiania kafla na ekranie blokady — także aktywności już zakończonej, a jeszcze
  /// widocznej (zdejmuje ją z ekranu). Wraca, gdy system aktywność zakończył (start nowej czeka na koniec
  /// osieroconych — system liczy żywe aktywności apki).
  func end(_ id: String) async
  /// Jedno ujście wejść systemu; rdzeń wpina je w ``RarogStore/attachActivities(_:)``.
  func observe(_ sink: @escaping @MainActor (ActivitySystemEvent) -> Void)
}
