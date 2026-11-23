#if os(iOS)
import SwiftUI
import UIKit

// Fokus klawiatury i wskaźnik na komórce listy SwiftUI. Właściciel: lista.

/// Most do komórki `UICollectionView`, w której SwiftUI hostuje wiersz `List`: zdejmuje systemowe halo
/// fokusu i mówi wierszowi, czy jego komórka ma fokus klawiatury (iPad z klawiaturą sprzętową).
///
/// SwiftUI daje komórkom listy w stylu `.sidebar` `UIFocusHaloEffect` w odcieniu akcentu (zmierzone na iOS 27:
/// `allowsFocus`, `selectionFollowsFocus`, halo wspólne dla komórek, odcień `systemBlue`).
/// `.focusEffectDisabled()` na wierszu ani na liście go nie zdejmuje, a halo rysuje niebieską obwódkę
/// o małym promieniu wokół klikniętego agenta. Wskaźnik fokusu rysuje wiersz
/// sam (`ListRowHighlight.showsFocusRing`), achromatycznie i w skali promieni.
///
/// Ten sam most zdejmuje kolekcji `selectionFollowsFocus`: po kliknięciu wiersza
/// gładzikiem fokus klawiatury zostawał na nim, a po Cmd+L aktualizacja fokusu lądowała na starym wierszu
/// i zaznaczenie za fokusem otwierało starą sesję z powrotem („przerzuca na chwilę i wraca", hipoteza
/// niezmierzona — symulator nie ma systemu fokusu). Strzałki ruszają odtąd sam pierścień, Return i Spacja
/// otwierają wiersz; użytkownik strzałkami po liście nie chodzi.
///
/// Wskaźnik (hover): most mówi wierszowi, czy wskaźnik stoi nad JEGO KOMÓRKĄ —
/// całą, z wcięciami, na których leży plama tła (`onHover` na treści wiersza gaśnie w 11 pt między wierszami). Systemowy
/// efekt wskaźnika kolekcji (`UIPointerInteraction` listy) jest zdjęty: tło pod wskaźnikiem rysuje wiersz sam
/// (`ListRowBackground`), zaznaczenie i fokus zostają nietknięte.
///
/// Kotwica drzewa: w wierszu drzewa most zgłasza kotwicy listy (`TreeListAnchor`) kolekcję,
/// w której stoi jego komórka — przy wejściu do okna, przy każdym układzie i przy aktualizacji wiersza. Inne wiersze
/// (szkielet, pusta lista, testy) kotwicy nie mają, więc kotwica bierze wyłącznie kolekcję drzewa.
///
/// Finger (stacked list): with `onPressChange` the bridge tells the row whether its cell is highlighted. The state
/// is the cell's own `isHighlighted`, observed by key-value observation, so it follows the collection's touch
/// handling: it waits for the touch delay and goes out when the list starts to scroll or a swipe begins. Without
/// `onPressChange` (beside the detail, headers, skeleton) nothing observes the cell.
struct ListCellFocusBridge: UIViewRepresentable {
  let onFocusChange: (Bool) -> Void
  var onHoverChange: (Bool) -> Void = { _ in }
  var onPressChange: ((Bool) -> Void)?
  var anchor: TreeListAnchor?

  func makeUIView(context: Context) -> ListCellFocusView {
    ListCellFocusView()
  }

  func updateUIView(_ view: ListCellFocusView, context: Context) {
    view.onFocusChange = onFocusChange
    view.onHoverChange = onHoverChange
    view.onPressChange = onPressChange
    view.treeAnchor = anchor
    view.reportList()
    view.quietCell()
    view.attachPress()
    // Nowe wywołanie (komórka z puli pod innym wierszem) dostaje bieżący stan, poza trwającą aktualizacją widoku.
    view.syncFocus(redeliver: true)
    view.syncHover(redeliver: true)
  }
}

/// Niewidoczny widok w treści wiersza: szuka swojej komórki w górę drzewa widoków.
final class ListCellFocusView: UIView, UIGestureRecognizerDelegate {
  var onFocusChange: ((Bool) -> Void)?
  var onHoverChange: ((Bool) -> Void)?
  /// Wskaźnik nad komórką zgłoszony wierszowi ostatnio.
  private(set) var reportedHover = false
  /// Gest wskaźnika wpięty w komórkę (nie w ten widok: plama tła obejmuje wcięcia wiersza).
  private(set) var hoverRecognizer: UIHoverGestureRecognizer?
  /// The row wants the finger state of its cell; `nil` — the cell is not observed.
  var onPressChange: ((Bool) -> Void)?
  /// Finger state reported to the row last.
  private(set) var reportedPress = false
  /// Observation of the cell's `isHighlighted` and the cell it watches.
  private var pressObservation: NSKeyValueObservation?
  private(set) weak var pressedCell: UICollectionViewCell?
  /// Czy komórka ma fokus klawiatury. Testy podmieniają odczyt: symulator nie włącza systemu fokusu.
  var readFocus: @MainActor (ListCellFocusView) -> Bool = { $0.cell?.isFocused ?? false }
  /// Stan zgłoszony wierszowi ostatnio.
  private(set) var reportedFocus = false
  private var observer: NSObjectProtocol?
  /// Kotwica drzewa listy (`TreeListAnchor`); tylko w wierszach drzewa.
  weak var treeAnchor: TreeListAnchor?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = .clear
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  /// Komórka listy, w której stoi wiersz (`nil` przed wpięciem w okno).
  var cell: UICollectionViewCell? {
    var view = superview
    while let current = view {
      if let cell = current as? UICollectionViewCell { return cell }
      view = current.superview
    }
    return nil
  }

  /// Poza oknem widok nie słyszy powiadomień systemu fokusu: odpięty zgłasza „bez fokusu”, a po powrocie czyta
  /// stan komórki od nowa — inaczej pierścień zostawał na wierszu, który fokus stracił w czasie odpięcia.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      quietCell()
      attachHover()
      attachPress()
      reportList()
      if observer == nil {
        observer = NotificationCenter.default.addObserver(
          forName: UIFocusSystem.didUpdateNotification, object: nil, queue: .main
        ) { [weak self] _ in
          MainActor.assumeIsolated {
            self?.quietCell()
            self?.syncFocus(redeliver: false)
          }
        }
      }
    } else {
      if let observer {
        NotificationCenter.default.removeObserver(observer)
        self.observer = nil
      }
      detachHover()
      detachPress()
    }
    syncFocus(redeliver: false)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // Komórka z puli dostaje konfigurację od nowa: halo zdejmujemy przy każdym układzie, nie raz.
    quietCell()
    attachHover()
    attachPress()
    reportList()
  }

  /// Kolekcja tej komórki dla kotwicy drzewa (gdy wiersz ją ma).
  func reportList() {
    guard let treeAnchor, let list else { return }
    treeAnchor.adopt(list)
  }

  /// Kolekcja listy nad komórką (`nil` przed wpięciem w okno).
  var list: UICollectionView? {
    var view = cell?.superview
    while let current = view {
      if let list = current as? UICollectionView { return list }
      view = current.superview
    }
    return nil
  }

  /// Bez systemowego halo: wskaźnik rysuje wiersz. Kolekcja bez zaznaczenia za fokusem i bez
  /// systemowego efektu wskaźnika (kolekcja listy `.sidebar` ma własną `UIPointerInteraction`; tło pod wskaźnikiem
  /// rysuje wiersz) — przy KAŻDYM układzie, bo SwiftUI konfiguruje listę od nowa tak samo jak komórki.
  func quietCell() {
    if let cell, cell.focusEffect != nil { cell.focusEffect = nil }
    if let list {
      if list.selectionFollowsFocus { list.selectionFollowsFocus = false }
      for case let pointer as UIPointerInteraction in list.interactions where pointer.isEnabled {
        pointer.isEnabled = false
      }
    }
  }

  /// Gest wskaźnika w komórce, w której stoi wiersz — raz na komórkę; przy przeniesieniu do innej zdjęty ze starej.
  func attachHover() {
    guard let cell else { return }
    if let hoverRecognizer, hoverRecognizer.view === cell { return }
    detachHover()
    let recognizer = UIHoverGestureRecognizer(target: self, action: #selector(hoverMoved(_:)))
    recognizer.delegate = self
    cell.addGestureRecognizer(recognizer)
    hoverRecognizer = recognizer
  }

  /// Wiersz odpięty: gest zdjęty z komórki, wiersz bez wskaźnika (komórka wraca do puli pod innym wierszem).
  func detachHover() {
    if let hoverRecognizer { hoverRecognizer.view?.removeGestureRecognizer(hoverRecognizer) }
    hoverRecognizer = nil
    reportHover(false)
  }

  @objc private func hoverMoved(_ recognizer: UIHoverGestureRecognizer) {
    reportHover(recognizer.state == .began || recognizer.state == .changed)
  }

  /// Zgłasza wierszowi zmianę wskaźnika w następnym obiegu pętli (jak fokus: bez zmiany stanu SwiftUI w trakcie
  /// aktualizacji widoków).
  func reportHover(_ now: Bool) {
    guard now != reportedHover else { return }
    reportedHover = now
    deliverHover(now)
  }

  /// Nowe wywołanie (komórka z puli) dostaje bieżący stan wskaźnika, gdy stoi nad nią.
  func syncHover(redeliver: Bool) {
    if redeliver, reportedHover { deliverHover(true) }
  }

  private func deliverHover(_ now: Bool) {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.reportedHover == now else { return }
      self.onHoverChange?(now)
    }
  }

  /// Observes the highlight of the cell the row stands in — once per cell; moved to another cell, the old one is
  /// released. A row without `onPressChange` observes nothing.
  func attachPress() {
    guard onPressChange != nil, let cell else {
      if onPressChange == nil { detachPress() }
      return
    }
    if pressObservation != nil, pressedCell === cell { return }
    detachPress()
    pressedCell = cell
    pressObservation = cell.observe(\.isHighlighted, options: [.new]) { [weak self] _, change in
      let now = change.newValue ?? false
      MainActor.assumeIsolated { self?.reportPress(now) }
    }
    // A fresh observation tells the callback the current state even when it equals the last report: the previous
    // callback may have been removed mid-press, and its "finger up" went nowhere.
    reportedPress = cell.isHighlighted
    deliverPress(reportedPress)
  }

  /// The row leaves the cell (or stops wanting the state): the observation ends and the row goes out.
  func detachPress() {
    pressObservation?.invalidate()
    pressObservation = nil
    pressedCell = nil
    reportPress(false)
  }

  /// Reports a finger change to the row on the next loop pass, like the pointer. A tap that highlights and
  /// unhighlights within one pass reports nothing: the selection takes the plate at once.
  func reportPress(_ now: Bool) {
    guard now != reportedPress else { return }
    reportedPress = now
    deliverPress(now)
  }

  private func deliverPress(_ now: Bool) {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.reportedPress == now else { return }
      self.onPressChange?(now)
    }
  }

  /// Gest wskaźnika nie odbiera nikomu zdarzeń: lista i treść wiersza słyszą wskaźnik dalej.
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool {
    true
  }

  /// Zgłasza wierszowi bieżący fokus komórki (poza oknem — brak fokusu), gdy się zmienił, a z `redeliver` także
  /// niezmieniony fokus (nowe wywołanie mogło go nie znać). Zgłoszenie idzie w następnym obiegu pętli: zmiana stanu
  /// SwiftUI w trakcie aktualizacji albo układu widoków jest niedozwolona.
  func syncFocus(redeliver: Bool) {
    let now = window != nil && readFocus(self)
    guard now != reportedFocus || (redeliver && now) else { return }
    reportedFocus = now
    DispatchQueue.main.async { [weak self] in
      guard let self, self.reportedFocus == now else { return }
      self.onFocusChange?(now)
    }
  }
}
#endif
