import ActivityKit
import Foundation
import RarogActivity
import RarogContract
import RarogCore

/// Zbiorcza Live Activity przez ActivityKit — adapter `ActivityRequesting` dla rdzenia.
///
/// Reguły (kiedy start, kiedy koniec, rejestracja tokenu, zegar ciszy, kiedy i co zapisać z apki) mieszkają
/// w rdzeniu (`RarogStore+LiveActivity`, testy na macOS z atrapą); tu jest wyłącznie tłumaczenie na
/// `Activity<RarogActivityAttributes>`: start z `pushType: .token`, zapis treści ze znacznikiem
/// (`update(_:alertConfiguration:timestamp:)` — system sam odrzuca zapis starszy niż ostatni push), obserwacja
/// tokenu aktualizacji (pierwszy i każdy po rotacji), treści (`contentUpdates`) i stanu (`ended`/`dismissed`
/// z zewnątrz) oraz koniec natychmiastowy. Wartości tokenu nie wychodzą stąd nigdzie poza rdzeń (ten loguje
/// tylko fakt przyjęcia).
final class LiveActivityController: ActivityRequesting {
  /// `ActivityKit.Activity` jawnie: `RarogContract` ma własny typ `Activity` (aktywność sesji z drutu).
  private typealias Handle = ActivityKit.Activity<RarogActivityAttributes>

  private var sink: (@MainActor (ActivitySystemEvent) -> Void)?
  /// Obserwacje tokenu, treści i stanu per aktywność; koniec aktywności je zamyka.
  private var watchers: [String: [Task<Void, Never>]] = [:]

  var activitiesEnabled: Bool {
    ActivityAuthorizationInfo().areActivitiesEnabled
  }

  var frequentPushesEnabled: Bool {
    ActivityAuthorizationInfo().frequentPushesEnabled
  }

  func displayedContent(_ id: String) -> LiveActivityContent? {
    guard let content = Handle.activities.first(where: { $0.id == id })?.content else { return nil }
    return LiveActivityContent(state: content.state, staleDate: content.staleDate)
  }

  func update(_ id: String, state: LiveActivityContentState, staleDate: Date?, timestamp: Date) async {
    await Self.update(id, state: state, staleDate: staleDate, timestamp: timestamp)
  }

  func observe(_ sink: @escaping @MainActor (ActivitySystemEvent) -> Void) {
    self.sink = sink
  }

  /// Aktywności apki, które system może jeszcze pokazywać — także z poprzedniego uruchomienia procesu
  /// (osierocone: proces zabity, kafel został). Zakończone (`ended`) się liczą: system zostawia je na ekranie
  /// blokady do 4 h z zamrożoną treścią, a `end(nil, dismissalPolicy: .immediate)` je zdejmuje. Zdjęte
  /// (`dismissed`) już nie.
  func shownActivityIds() -> [String] {
    Handle.activities
      .filter { [.active, .stale, .pending, .ended].contains($0.activityState) }
      .map(\.id)
  }

  func request(_ content: LiveActivityContent, serverSystem: ServerSystem?) throws -> String {
    let activity = try Handle.request(
      attributes: RarogActivityAttributes(serverSystem: serverSystem),
      content: ActivityContent(state: content.state, staleDate: content.staleDate),
      pushType: .token)
    watch(activity)
    return activity.id
  }

  func end(_ id: String) async {
    watchers.removeValue(forKey: id)?.forEach { $0.cancel() }
    await Self.end(id)
  }

  // `Activity` nie jest `Sendable`, a jego `end` i `update` biegną poza głównym aktorem — uchwyt wyszukany po id
  // w tym samym kontekście nie przekracza granicy izolacji.
  private nonisolated static func end(_ id: String) async {
    guard let activity = Handle.activities.first(where: { $0.id == id }) else { return }
    await activity.end(nil, dismissalPolicy: .immediate)
  }

  private nonisolated static func update(
    _ id: String, state: LiveActivityContentState, staleDate: Date?, timestamp: Date
  ) async {
    guard let activity = Handle.activities.first(where: { $0.id == id }) else { return }
    await activity.update(
      ActivityContent(state: state, staleDate: staleDate), alertConfiguration: nil, timestamp: timestamp)
  }

  private func watch(_ activity: Handle) {
    let id = activity.id
    let tokens = Task { [weak self] in
      for await token in activity.pushTokenUpdates {
        self?.sink?(.token(activityId: id, token))
      }
    }
    let contents = Task { [weak self] in
      for await content in activity.contentUpdates {
        self?.sink?(.content(activityId: id, LiveActivityContent(state: content.state, staleDate: content.staleDate)))
      }
    }
    let states = Task { [weak self] in
      for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
        self?.sink?(.ended(activityId: id))
        self?.watchers.removeValue(forKey: id)?.forEach { $0.cancel() }
        return
      }
    }
    watchers[id] = [tokens, contents, states]
  }
}
