#if os(iOS)
import Observation
import RarogCore
import SwiftUI
import UIKit

// Dymek o innej sesji i komunikat apki NAD PROMPTEM ekranu sesji.
// Dymek przykrywa ostatnie linie transkryptu, nigdy
// pola ani klawiatury: stoi 8 pt nad dolną krawędzią transkryptu, a przy widocznym pasku „Przewiń na dół" —
// 8 pt nad nim (pasek zostaje najbliżej transkryptu). Treść to ta sama `ToastCard` co w nakładce kolumny,
// w `UIHostingController` (wzór `installComposerPills`); cykl życia (6 s, czytnik) prowadzi `ToastCenter`.
// Pojawienie i zniknięcie to krycie (i 8 pt wjazdu, bez niego przy „Ogranicz ruch"); stuknięcie gasi dymek
// OD RAZU, bez animacji, a informacją zwrotną jest nowy ekran — w następnej klatce, po wyświetleniu ekranu bez
// dymka (`ToastHandoff`). Środek dymka = środek kolumny w safe area, czyli oś karty pola i tekstu transkryptu.
// Właściciel: łączność.

/// Treść hosta: dymek albo nic.
struct SessionToastCard: View {
  let toast: Toast?
  let action: (Toast) -> Void
  /// Segment akcji dymka komunikatu.
  var perform: (Toast) -> Void = { _ in }

  var body: some View {
    // The host's root view: the app's text size on the flat path (`textScaleHost`).
    Group {
      if let toast {
        ToastCard(toast: toast, action: { action(toast) }, perform: { perform(toast) })
      }
    }
    .textScaleHost()
  }
}

/// UIKit-owy stan dymka jednego ekranu sesji (rozszerzenia nie mają pól).
@MainActor
final class ToastChrome {
  /// Centrum dymków i nawigacja (wejście do sesji z dymka) — podaje host ekranu przed `viewDidLoad`.
  var center: ToastCenter?
  weak var navigation: RarogNavigation?
  var host: UIHostingController<SessionToastCard>?
  var aboveTranscript: NSLayoutConstraint?
  var aboveBar: NSLayoutConstraint?
  /// Dymek nad listą podpowiedzi komend, gdy ta stoi (`+CommandSuggestions`).
  var aboveSuggestions: NSLayoutConstraint?
  var width: NSLayoutConstraint?
  var height: NSLayoutConstraint?
  /// Dymek na ekranie (po zakończonym albo trwającym pojawieniu); `nil` = schowany albo gaśnie.
  var shown: Toast?
  /// Górna krawędź dymka sprzed przestawienia nad pasek „na dół" (albo z powrotem) — przejazd po układzie.
  var slideFrom: CGFloat?
  /// „Ogranicz ruch" — testy podają własne.
  var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }
}

extension SessionViewController {
  /// Odstęp dymka od transkryptu albo od paska „na dół" pod nim.
  static let toastGap: CGFloat = 8
  /// Boczny margines dymka (jak karta pola i tekst transkryptu).
  static let toastMargin: CGFloat = 16

  /// Woła host ekranu przy tworzeniu kontrolera (SwiftUI osadzone w UIKit nie dziedziczy środowiska). Bez
  /// centrum (ekran hostowany w testach) dymka nie ma.
  func installToast(center: ToastCenter?, navigation: RarogNavigation) {
    guard let center else { return }
    toastChrome.center = center
    toastChrome.navigation = navigation
    if isViewLoaded { buildToast() }
  }

  /// `viewDidLoad`, po pasku „na dół" (`buildReading`): host dymka nad transkryptem i obserwacja centrum.
  func buildToast() {
    guard toastChrome.center != nil, toastChrome.host == nil else { return }
    let host = UIHostingController(rootView: SessionToastCard(toast: nil, action: { _ in }))
    // Rozmiar liczy ekran (`sizeToast`): dymek ma najwyżej szerokość kolumny bez marginesów, a jego
    // wysokość zależy od tej szerokości (komunikat apki łamie się na linie).
    host.sizingOptions = []
    host.safeAreaRegions = []
    host.view.backgroundColor = .clear
    host.view.translatesAutoresizingMaskIntoConstraints = false
    host.view.isHidden = true
    host.view.alpha = 0
    addChild(host)
    view.addSubview(host.view)
    let width = host.view.widthAnchor.constraint(equalToConstant: 0)
    let height = host.view.heightAnchor.constraint(equalToConstant: 0)
    // Over the top of the foot: the transcript runs under it (`+UnderFoot`).
    let aboveTranscript = host.view.bottomAnchor.constraint(equalTo: footTopAnchor, constant: -Self.toastGap)
    // Lista podpowiedzi komend nad polem przesuwa dymek nad siebie (`aboveSuggestions`); pasek „na dół” stoi wtedy
    // też nad nią, więc `aboveBar` z listą nie koliduje. Priorytet niżej od wysokości listy (999), żeby to dymek
    // ustąpił, a nie lista się skróciła.
    aboveTranscript.priority = .defaultHigh - 1
    let aboveBar = host.view.bottomAnchor.constraint(
      equalTo: readingChrome.jumpBar.topAnchor, constant: -Self.toastGap)
    let aboveSuggestions = host.view.bottomAnchor.constraint(
      lessThanOrEqualTo: composer.suggestionsView.topAnchor, constant: -Self.toastGap)
    // Nad listą, o ile jest miejsce: w niskim oknie dymek zostaje na swoim miejscu, nad listą w kolejności warstw,
    // zamiast wyjechać poza ekran.
    aboveSuggestions.priority = Self.aboveSuggestionsPriority
    toastChrome.aboveSuggestions = aboveSuggestions
    NSLayoutConstraint.activate([
      // Oś kolumny w safe area — tej samej, w której stoją karta pola i tekst transkryptu. Lista transkryptu sięga
      // krawędzi widoku, więc przy niesymetrycznej safe area jej środek nie byłby środkiem treści.
      host.view.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor), width, height,
      aboveTranscript,
    ])
    host.didMove(toParent: self)
    toastChrome.host = host
    toastChrome.width = width
    toastChrome.height = height
    toastChrome.aboveTranscript = aboveTranscript
    toastChrome.aboveBar = aboveBar
    toastChrome.aboveSuggestions?.isActive = composer.commandSuggestionsOpen
    trackToast()
  }

  /// Obserwacja `ToastCenter.current`: każda zmiana pokazuje, podmienia albo gasi dymek.
  private func trackToast() {
    guard let center = toastChrome.center else { return }
    let toast = withObservationTracking {
      center.current
    } onChange: { [weak self] in
      Task { @MainActor in self?.trackToast() }
    }
    showToast(toast)
  }

  /// Nowy dymek wjeżdża krycie(+8 pt), zastępujący podmienia treść w miejscu, brak dymka gaśnie kryciem.
  func showToast(_ toast: Toast?) {
    guard let host = toastChrome.host, toast?.id != toastChrome.shown?.id else { return }
    let wasShown = toastChrome.shown != nil
    toastChrome.shown = toast
    guard let toast else {
      UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
        host.view.alpha = 0
      } completion: { [weak self] _ in
        if self?.toastChrome.shown == nil { host.view.isHidden = true }
      }
      return
    }
    host.rootView = SessionToastCard(
      toast: toast, action: { [weak self] in self?.openToast($0) }, perform: { [weak self] in self?.performToast($0) })
    sizeToast()
    guard !wasShown || host.view.isHidden else { return }
    host.view.isHidden = false
    let slide = !toastChrome.reduceMotion()
    host.view.transform = slide ? CGAffineTransform(translationX: 0, y: Self.toastGap) : .identity
    UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
      host.view.alpha = 1
      host.view.transform = .identity
    }
  }

  /// Stuknięcie: dymek gaśnie od razu (bez animacji — na wątku, który zaraz zbuduje nowy ekran, rwałaby), także
  /// w trakcie pojawiania; dymek o sesji prowadzi do niej w następnej klatce, gdy ekran bez dymka już stoi
  /// (`ToastHandoff`); komunikat apki tylko się zamyka.
  func openToast(_ toast: Toast) {
    hideToastNow()
    toastChrome.center?.dismiss(toast.id)
    guard let sessionId = toast.sessionId, let navigation = toastChrome.navigation else { return }
    ToastHandoff.open(sessionId, navigation: navigation)
  }

  /// Segment akcji dymka komunikatu: dymek gaśnie od razu, akcję wykonuje centrum (tylko dla dymka na ekranie).
  func performToast(_ toast: Toast) {
    hideToastNow()
    toastChrome.center?.performAction(toast.id)
  }

  private func hideToastNow() {
    if let host = toastChrome.host {
      host.view.layer.removeAllAnimations()
      host.view.transform = .identity
      host.view.alpha = 0
      host.view.isHidden = true
    }
    toastChrome.shown = nil
    toastChrome.slideFrom = nil
  }

  /// Rozmiar dymka z treści: szerokość najwyżej kolumny (safe area) bez marginesów, wysokość dla tej szerokości.
  func sizeToast() {
    guard let host = toastChrome.host, toastChrome.shown != nil, let width = toastChrome.width,
      let height = toastChrome.height
    else { return }
    let limit = max(0, view.safeAreaLayoutGuide.layoutFrame.width - 2 * Self.toastMargin)
    guard limit > 0 else { return }
    let size = host.sizeThatFits(in: CGSize(width: limit, height: .greatestFiniteMagnitude))
    let fitted = CGSize(width: ceil(min(size.width, limit)), height: ceil(size.height))
    if abs(width.constant - fitted.width) > 0.5 { width.constant = fitted.width }
    if abs(height.constant - fitted.height) > 0.5 { height.constant = fitted.height }
  }

  /// Dymek nad paskiem „Przewiń na dół", gdy pasek stoi; inaczej tuż nad transkryptem. Woła `updateJumpBar`
  /// (także z `scrollViewDidScroll` i ze zmiany wysokości treści, w środku układu listy) — tu tylko więzy,
  /// a przejazd liczy następny układ ekranu (`settleToast`).
  func placeToast() {
    guard let host = toastChrome.host, let aboveBar = toastChrome.aboveBar,
      let aboveTranscript = toastChrome.aboveTranscript
    else { return }
    let overBar = readingChrome.jumpBar.isShown
    guard aboveBar.isActive != overBar else { return }
    if toastChrome.shown != nil, !host.view.isHidden, toastChrome.slideFrom == nil {
      toastChrome.slideFrom = host.view.frame.minY
    }
    if overBar {
      aboveTranscript.isActive = false
      aboveBar.isActive = true
    } else {
      aboveBar.isActive = false
      aboveTranscript.isActive = true
    }
    view.setNeedsLayout()
  }

  /// `viewDidLayoutSubviews`: rozmiar z bieżącej szerokości i przejazd po przestawieniu nad pasek (bez niego
  /// przy „Ogranicz ruch" — dymek staje od razu na nowym miejscu).
  func settleToast() {
    sizeToast()
    guard let host = toastChrome.host, let from = toastChrome.slideFrom else { return }
    toastChrome.slideFrom = nil
    let delta = from - host.view.frame.minY
    guard !host.view.isHidden, abs(delta) > 0.5, !toastChrome.reduceMotion() else { return }
    host.view.transform = CGAffineTransform(translationX: 0, y: delta)
    UIView.animate(withDuration: 0.15, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
      host.view.transform = .identity
    }
  }
}
#endif
