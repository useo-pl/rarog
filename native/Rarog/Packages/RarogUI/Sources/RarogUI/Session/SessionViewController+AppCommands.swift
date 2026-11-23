#if os(iOS)
import RarogCore
import UIKit

// Komendy apki: „Wyślij” — przycisk i Return z klawiatury sprzętowej, obie drogi przez `+Send` —
// najpierw pyta, czy CAŁY tekst pola jest komendą apki (`AppCommand`). Jeśli tak, apka obsługuje ją sama: bez kolejki
// wysyłki, echa, okna „Wyślij” i żądania do serwera; załączniki zostają w pasku. Lista komend apki i reguła
// rozpoznania: `Session/AppCommands`. Właściciel: pole.
extension SessionViewController {
  /// `true` = tekst pola był komendą apki i ekran ją obsłużył; wysyłka się nie zaczyna.
  func runAppCommand() -> Bool {
    guard let command = AppCommand.recognize(composer.text) else { return false }
    switch command.action {
    case .modelSheet: openModelSheet()
    case .usageSheet: openUsageSheet()
    }
    return true
  }

  /// `/usage`, `/cost`, `/stats`: arkusz „Limity”. Bez warunków sesji — limity są kontem Claude na Macu, nie
  /// stanem tej sesji. Arkusz, który wstał, czyści pole jak wysyłka; nad stojącym oknem (dymek modelu, sam arkusz)
  /// drugi nie wstaje, a tekst zostaje do ponownego „Wyślij”, jak przy zablokowanym dymku modelu.
  private func openUsageSheet() {
    guard presentUsageSheet() else {
      _ = composer.dismissCommandSuggestions()
      return
    }
    composer.text = ""
    transientHint = false
    renderComposer(store.state)
  }

  /// `/model`, `/effort`: dymek pigułki modelu. Dymek z wyborem czyści pole; zablokowany dymek (powód i „Zamknij”)
  /// i brak pigułki zostawiają tekst, a lista podpowiedzi zamyka się dla niego jak po wysyłce.
  private func openModelSheet() {
    switch AppCommand.modelSheetRoute(store.state, sessionId: sessionId) {
    case let .open(clearsField):
      if clearsField {
        composer.text = ""
        transientHint = false
        renderComposer(store.state)
      } else {
        _ = composer.dismissCommandSuggestions()
      }
      modelSheetRequests.open()
    case let .explain(reason):
      _ = composer.dismissCommandSuggestions()
      transientHint = true
      composer.setHint(reason)
      if canAnnounce(in: announcementScope) { announcer.say(reason) }
    }
  }
}
#endif
