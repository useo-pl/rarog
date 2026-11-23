#if os(iOS)
import RarogCore
import UIKit

// Podpowiedzi slash-komend nad polem wiadomości: lista sesji z magazynu do pola, prośba
// o odczyt przy pierwszym „/”, pasek „Przewiń na dół” i dymek nad listą, sufit listy pod górą safe area. Model,
// widok i klawisze: `ComposerView`; Esc: `+KeysInterrupt`. Właściciel: pole.
extension SessionViewController {
  /// `viewDidLoad`, po pasku „na dół” (`buildReading`) i dymku (`buildToast`).
  func buildCommandSuggestions() {
    composer.onCommandToken = { [weak self] in
      guard let self else { return }
      let store = self.store
      let sessionId = self.sessionId
      Task { await store.loadCommandsIfNeeded(sessionId) }
    }
    composer.onSuggestionsShown = { [weak self] shown in self?.placeAboveSuggestions(shown) }
    let list = composer.suggestionsView
    // Lista nie wchodzi pod pasek nagłówka: niskie okno (telefon w poziomie z klawiaturą) skraca ją, a reszta
    // przewija się w środku.
    list.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor, constant: 8).isActive = true
    // Pasek „na dół” nad listą — o ile jest na to miejsce. W niskim oknie (telefon w poziomie z klawiaturą) lista
    // dochodzi do sufitu, a pasek zostaje 8 pt pod górą safe area, nad listą w kolejności warstw: widoczny
    // i stukalny (wymagany więz wypychałby go poza ekran). Wysokość listy (999) wygrywa z miejscem paska.
    let above = readingChrome.jumpBar.bottomAnchor.constraint(lessThanOrEqualTo: list.topAnchor, constant: -8)
    above.priority = Self.aboveSuggestionsPriority
    // Więz nad listą (760) jest mocniejszy od domyślnego oporu ściśnięcia przycisku (750): bez tego układ spłaszczał
    // pasek do zera wysokości zamiast przesunąć go pod sufit (test UIKit niskiego okna).
    readingChrome.jumpBar.setContentCompressionResistancePriority(.required, for: .vertical)
    readingChrome.jumpAboveSuggestions = above
    readingChrome.jumpUnderTop = readingChrome.jumpBar.topAnchor.constraint(
      greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor, constant: 8)
  }

  /// Pasek „na dół” i dymek nad listą: mocniej niż ich zwykłe miejsce (749), słabiej niż wysokość listy (999)
  /// i sufit ekranu.
  static let aboveSuggestionsPriority = UILayoutPriority.defaultHigh + 10

  /// Każdy render: komendy oglądanej sesji (zmiana sesji albo wylogowanie czyszczą je w rdzeniu) razem z komendami
  /// apki (`/model`, `/effort` z dopiskiem „w apce”) — tych serwer nie zwraca.
  func renderCommandSuggestions(_ state: AppState) {
    composer.setCommandChoices(AppCommand.merged(with: state.commandChoices(for: sessionId)))
  }

  /// Pasek „na dół” i dymek wchodzą nad listę, gdy ta stoi — lista ich nie zasłania i nie zabiera im stuknięcia.
  /// Bez animacji: lista pojawia się od razu, więc i to, co nad nią, staje od razu. Sufit paska (`jumpUnderTop`)
  /// działa tylko przy liście: bez niej układ paska jest taki jak przed podpowiedziami.
  private func placeAboveSuggestions(_ shown: Bool) {
    readingChrome.jumpAboveSuggestions?.isActive = shown
    readingChrome.jumpUnderTop?.isActive = shown
    toastChrome.aboveSuggestions?.isActive = shown
    view.setNeedsLayout()
  }
}

/// Stopa ekranu sesji (pole albo karta stanu). Lista podpowiedzi komend wystaje z pola NAD stopę, więc stopa
/// przepuszcza do pola dotyk, który pole uznaje za swój (`ComposerView.point(inside:with:)`).
final class SessionFootStack: UIStackView {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    if super.point(inside: point, with: event) { return true }
    return arrangedSubviews.contains { view in
      !view.isHidden && view.point(inside: convert(point, to: view), with: event)
    }
  }
}
#endif
