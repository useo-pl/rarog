#if os(iOS)
import RarogCore
import UIKit

// Kotwica zaznaczonej sesji w drzewie projektów: odczyt i korekta na żywej kolekcji
// UIKit, w której SwiftUI hostuje `List`. Czyste liczby i stany: `Model/TreeListAnchorMath.swift`. Właściciel: lista.

/// Zaznaczona sesja zostaje co do punktu w tym samym miejscu widocznej części listy, gdy nad nią albo pod nią
/// zmienia się drzewo: „Zwiń/Rozwiń wszystkie”, nowa i zamknięta sesja, nowy projekt, zwolnienie trzymanych wierszy,
/// przestawienie projektów po dobie. Ręczne zwinięcie albo rozwinięcie JEDNEGO projektu kotwicy nie uruchamia
/// (`TreeAnchorSkip`): tam stoi nagłówek. Kotwica nic nie robi, gdy zaznaczona sesja nie
/// stoi cała na ekranie, nie ma zaznaczenia, palec jest na liście albo lista dobiega, kolumna jest schowana (Cmd+B)
/// albo kolekcji nie ma w oknie.
///
/// Dlaczego nie `ScrollViewProxy.scrollTo(id, anchor: UnitPoint(y: f))`: w `List` stawia wiersz na środku dla każdego
/// 0 < f < 1 (`ProjectTreeExpandAnchorTests.testListScrollToUnitPointCentersRow`), więc centrowałby
/// zaznaczoną zamiast trzymać ją tam, gdzie stała, a pamięć miejsca z pomiaru `onGeometryChange` wiersza bywa
/// nieświeża po jednym dużym skoku przewinięcia i ściąga listę do sesji spoza ekranu. `ScrollPosition` i
/// `scrollPosition(id:)` na `List` niczego nie trzymają (sprawdzone prototypem). Dlatego odczyt idzie z żywego układu
/// kolekcji, a korekta to `contentOffset` po jej układzie, w tym samym przebiegu, przed narysowaniem klatki.
///
/// Odczyt „przed” robi ciało listy (`body`): SwiftUI liczy je, gdy kolekcja ma jeszcze stare wiersze. Korekta „po”
/// robi widok pomocniczy w kolekcji (`TreeListAnchorView`): jego `layoutSubviews` idzie po `layoutSubviews` kolekcji.
/// Przy animowanej aktualizacji UIKit przywraca przesunięcie według własnej, prywatnej kotwicy i nadpisuje każdą
/// korektę w trakcie animacji (zmierzone: „Zwiń wszystkie” z animacją — w trakcie do 197 pt, rozwinięcie do 940 pt);
/// stan końcowy trzyma korekta po układzie i jej dogrywka (`settleWindow`).
///
/// Klasa w `@State` listy, bez obserwacji: przewijanie i pomiar nie rysują listy od nowa.
@MainActor
final class TreeListAnchor {
  /// Zdarzenia kotwicy — dla testów UIKit (strażnicy kolejności zdarzeń i pętli układu); w apce nikt nie słucha.
  enum Event: Equatable {
    /// Ciało z nowym celem: ile wierszy ma kolekcja, `applied` i `target`.
    case body(collection: Int, applied: Int, target: Int)
    case measured(screenTop: CGFloat)
    /// Ciało chciało mierzyć, ale warunek nie przeszedł (powód).
    case declined(String)
    /// Przebieg układu widoku pomocniczego.
    case layout
    case corrected(from: CGFloat, to: CGFloat)
    /// Odczyt unieważniony bez ruchu (powód).
    case dropped(String)
    /// `onChange` wierszy: ile wierszy ma kolekcja w tej chwili i ile ma cel.
    case applied(collection: Int, target: Int)
  }

  /// Przełącznik dla testów UIKit: ten sam scenariusz z kotwicą i bez niej. Apka go nie zmienia.
  var enabled = true
  var trace: ((Event) -> Void)?
  private(set) var state = TreeListAnchorState()
  private(set) weak var list: UICollectionView?
  private var helper: TreeListAnchorView?
  private var sizeObservation: NSKeyValueObservation?
  /// Korekta w toku: jej własny `layoutIfNeeded` nie wchodzi w kotwicę drugi raz.
  private var correcting = false
  /// Kolumna listy schowana (Cmd+B), z ostatniego ciała.
  private var columnHidden = false
  /// Zaznaczona sesja w tej chwili (nawigacja), nie z ostatniego ciała: zmiana zaznaczenia między odczytem a korektą
  /// unieważnia odczyt, zanim SwiftUI policzy listę od nowa.
  private var selection: @MainActor () -> String? = { nil }
  /// Other users of the tree collection (`TreeReturnScroll`, `ListJumpPillTracker`), one per owner: each hears every
  /// report of it, like the anchor, so the collection has one bridge however many users it has.
  private var recipients: [ObjectIdentifier: @MainActor (UICollectionView) -> Void] = [:]
  /// Numer okna dogrywki: spóźnione zamknięcie starego okna nie kasuje nowego odczytu.
  private var settleToken = 0

  /// Gest zapowiada wiersze po zmianie (`ProjectTreeRows.toggle`); `nil` kasuje zapowiedź.
  func expect(_ ids: [ProjectTreeID]?) {
    state.expect(ids)
  }

  /// Ciało listy: wiersze drzewa, które za chwilę dostanie kolekcja (`ids`, puste przy szkielecie i pustej liście),
  /// zaznaczona sesja (odczyt na żywo z nawigacji) i schowana kolumna. Przy nowym celu odczyt zaznaczonej z kolekcji,
  /// która ma jeszcze stare wiersze.
  func body(ids: [ProjectTreeID], columnHidden: Bool, selection: @escaping @MainActor () -> String?) {
    self.columnHidden = columnHidden
    self.selection = selection
    let selected = selection()
    let before = state.target
    let step = state.body(ids, selected: selected)
    if ids != before, let trace {
      trace(.body(collection: items(list), applied: state.applied?.count ?? -1, target: ids.count))
    }
    guard let selected else { return }
    switch step {
    case .none: return
    case .measure: measure(selected, carried: nil)
    case let .carry(top): measure(selected, carried: top)
    }
  }

  /// `onChange` wierszy: kolekcja ma `ids` (przychodzi po `performBatchUpdates`).
  func didApply(_ ids: [ProjectTreeID]) {
    state.didApply(ids)
    trace?(.applied(collection: items(list), target: state.target.count))
  }

  /// Kolekcja drzewa zgłoszona przez most komórki wiersza drzewa (`ListCellFocusView`). Inna kolekcja niż dotąd:
  /// widok pomocniczy i obserwacja przechodzą do niej, a odczyt ze starej przepada.
  func adopt(_ list: UICollectionView) {
    for recipient in recipients.values { recipient(list) }
    if self.list === list, helper?.superview === list { return }
    if self.list !== list, state.pending != nil { drop("inna kolekcja") }
    helper?.removeFromSuperview()
    sizeObservation?.invalidate()
    self.list = list
    let view = TreeListAnchorView()
    view.anchor = self
    // Najniżej w kolekcji: bez wpływu na komórki i ich kolejność rysowania.
    list.insertSubview(view, at: 0)
    helper = view
    // Zmiana wierszy zmienia (zwykle) rozmiar treści w środku `performBatchUpdates`, a samoczynne wysokości komórek
    // jeszcze nie zmierzonych — w kolejnych przebiegach układu: widok pomocniczy dostaje wtedy układ po kolekcji.
    sizeObservation = list.observe(\.contentSize, options: [.new]) { [weak view] _, _ in
      MainActor.assumeIsolated { view?.setNeedsLayout() }
    }
  }

  /// Registers `owner` as a user of the tree collection, once (the list body calls this on every pass). A collection
  /// already reported goes to the new user at once, so a user that comes late does not wait for the next report.
  func addRecipient(_ owner: AnyObject, _ receive: @escaping @MainActor (UICollectionView) -> Void) {
    let key = ObjectIdentifier(owner)
    guard recipients[key] == nil else { return }
    recipients[key] = receive
    if let list { receive(list) }
  }

  // MARK: - Odczyt „przed”

  /// Odczyt zaznaczonej przed zmianą. `carried` — nowy cel w oknie dogrywki: miejsce na ekranie z ostatniej korekty
  /// (`TreeListAnchorState.Step.carry`), a „cała na ekranie” liczy się od niego, nie od żywej ramki (w trakcie
  /// animacji model kolekcji stoi przesunięty). Warunek niespełniony przy przeniesieniu — odczyt z dogrywki przepada.
  private func measure(_ selected: String, carried: CGFloat?) {
    let reject: (String) -> Void = { [weak self] reason in
      if carried != nil { self?.drop("dogrywka bez przeniesienia: \(reason)") } else { self?.decline(reason) }
    }
    guard enabled else { return reject("wyłączona") }
    guard let list, list.window != nil else { return reject("kolekcja poza oknem") }
    guard !columnHidden else { return reject("kolumna schowana") }
    if let motion = Self.motion(list, animated: true) { return reject("lista w ruchu: \(motion)") }
    let selectedItems = (list.indexPathsForSelectedItems ?? []).filter { $0.section == 0 }.map(\.item)
    guard list.numberOfSections > 0,
      let index = state.measureIndex(
        session: selected, items: list.numberOfItems(inSection: 0), selectedItems: selectedItems)
    else { return reject("kolekcja nie ma applied") }
    let path = IndexPath(item: index, section: 0)
    guard let frame = list.layoutAttributesForItem(at: path)?.frame else { return reject("brak ramki zaznaczonej") }
    let top: CGFloat
    if let carried {
      let insets = list.adjustedContentInset
      guard TreeListAnchorMath.wholeOnScreen(
        minY: carried, maxY: carried + frame.height, offset: 0, boundsHeight: list.bounds.height,
        insetTop: insets.top, insetBottom: insets.bottom)
      else { return reject("zaznaczona niecała na ekranie") }
      top = carried
    } else {
      guard list.indexPathsForVisibleItems.contains(path), Self.whole(frame, in: list) else {
        return reject("zaznaczona niecała na ekranie")
      }
      top = frame.minY - list.contentOffset.y
    }
    state.measured(.init(session: selected, screenTop: top, size: list.bounds.size, owner: ObjectIdentifier(list)))
    // Okno dogrywki poprzedniej zmiany się kończy; nowe zacznie pierwsza korekta tego celu.
    settleToken += 1
    trace?(.measured(screenTop: top))
    helper?.setNeedsLayout()
  }

  private func decline(_ reason: String) {
    trace?(.declined(reason))
  }

  // MARK: - Korekta „po”

  /// Po układzie kolekcji (widok pomocniczy): gdy kolekcja pokazuje cel, zaznaczona wraca na swoje miejsce na
  /// ekranie. Odczyt zostaje do korekty albo unieważnienia, nie do pierwszego układu: przebieg sprzed aktualizacji
  /// kolekcji (stare wiersze) czeka dalej. Po korekcie odczyt zostaje jeszcze przez okno dogrywki (`settleWindow`):
  /// kolejne układy tej samej aktualizacji (komórki mierzone po przesunięciu, koniec animacji aktualizacji ~0,5 s
  /// po geście) zmieniają rozmiar treści i przesuwają zaznaczoną jeszcze raz.
  fileprivate func afterLayout() {
    guard !correcting else { return }
    trace?(.layout)
    guard let pending = state.pending, let list else { return }
    if let reason = invalid(pending, list) { return drop(reason) }
    let selectedItems = (list.indexPathsForSelectedItems ?? []).filter { $0.section == 0 }.map(\.item)
    switch state.confirmation(items: list.numberOfSections > 0 ? list.numberOfItems(inSection: 0) : 0,
                              selectedItems: selectedItems) {
    case .waiting:
      return
    case .lost:
      drop(state.settling ? "koniec dogrywki: drzewo inne niż cel" : "zaznaczenie albo drzewo inne niż cel")
    case let .target(index):
      correct(list, item: index, screenTop: pending.screenTop)
    }
  }

  /// Powód unieważnienia odczytu (`nil` — ważny): reguła 3 przestała być spełniona, zmieniło się zaznaczenie albo
  /// kolekcja. Przewinięcie animowane (`isScrollAnimating`) do pierwszej korekty odczytu NIE unieważnia: kolekcja
  /// zaczyna je sama w środku aktualizacji, która skraca treść poniżej przesunięcia
  /// (`_setContentSize:skipContentOffsetAdjustment:` → `performWhileAnimatingAutomaticContentOffsetAdjustments:` →
  /// `setContentOffset(_:animated: true)`, zmierzone na iOS 27), więc przy „Zwiń wszystkie” kotwica nie
  /// działałaby nigdy; korekta to przewinięcie przerywa. Po pierwszej korekcie (dogrywka) przewinięcie animowane jest
  /// cudze — z kodu albo fokusu klawiatury (most komórki zdejmuje `selectionFollowsFocus`, więc fokus jedzie bez zmiany
  /// zaznaczenia) — i unieważnia odczyt, zamiast dać się przerwać.
  private func invalid(_ pending: TreeListAnchorState.Pending, _ list: UICollectionView) -> String? {
    if !enabled { return "wyłączona" }
    if ObjectIdentifier(list) != pending.owner { return "inna kolekcja" }
    if list.window == nil { return "kolekcja poza oknem" }
    if columnHidden { return "kolumna schowana" }
    if selection() != pending.session { return "zaznaczenie zmienione" }
    if list.bounds.size != pending.size { return "inny rozmiar kolekcji" }
    if let motion = Self.motion(list, animated: state.settling) { return "lista w ruchu: \(motion)" }
    return nil
  }

  /// `contentOffset.y = nowe minY − miejsce na ekranie`, w granicach treści. Kolekcja po przesunięciu mierzy komórki,
  /// które weszły na ekran (wysokości dotąd szacowane), co przesuwa zaznaczoną jeszcze raz — więc korekta powtarza
  /// się, dopóki jest co poprawiać (najwyżej `maxPasses` razy). Bez atrybutów odczyt czeka na następny układ.
  /// `setContentOffset(_:animated: false)`, nie samo `contentOffset`: tylko ono przerywa przewinięcie animowane, które
  /// kolekcja zaczęła sama (setter właściwości zostawia je w biegu — zmierzone na iOS 27), a które inaczej
  /// dociągnęłoby listę z powrotem.
  private func correct(_ list: UICollectionView, item: Int, screenTop: CGFloat) {
    let path = IndexPath(item: item, section: 0)
    let wasSettling = state.settling
    var moved = false
    var settledTop: CGFloat?
    for _ in 0..<Self.maxPasses {
      guard let frame = list.layoutAttributesForItem(at: path)?.frame else { break }
      let insets = list.adjustedContentInset
      let wanted = TreeListAnchorMath.clamp(
        frame.minY - screenTop, contentHeight: list.contentSize.height, boundsHeight: list.bounds.height,
        insetTop: insets.top, insetBottom: insets.bottom)
      // Miejsce zaznaczonej po tym przebiegu (przy przycięciu do treści — inne niż `screenTop`).
      settledTop = frame.minY - wanted
      let from = list.contentOffset.y
      guard abs(from - wanted) > Self.precision || list.isScrollAnimating else { break }
      correcting = true
      list.setContentOffset(CGPoint(x: list.contentOffset.x, y: wanted), animated: false)
      list.layoutIfNeeded()
      correcting = false
      moved = true
      trace?(.corrected(from: from, to: wanted))
    }
    if let settledTop { state.corrected(settledTop: settledTop) }
    // Okno dogrywki liczy się od ostatniej korekty; bez atrybutów (komórka jeszcze nieułożona) odczyt czeka też w nim.
    if moved || !wasSettling { settle() }
  }

  /// Okno dogrywki: odczyt zostaje przez `settleWindow` od ostatniej korekty, potem znika sam.
  private func settle() {
    settleToken += 1
    let token = settleToken
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.settleWindow) { [weak self] in
      guard let self, self.settleToken == token, self.state.pending != nil else { return }
      self.drop(nil)
    }
  }

  /// Odczyt wykorzystany (`reason == nil`, koniec dogrywki) albo unieważniony bez ruchu.
  private func drop(_ reason: String?) {
    state.drop()
    settleToken += 1
    if let reason { trace?(.dropped(reason)) }
  }

  /// Ile razy korekta powtarza się w jednym przebiegu (komórki mierzone po przesunięciu).
  static let maxPasses = 4
  /// Różnica przesunięcia, poniżej której korekty nie ma (ćwierć punktu: poniżej piksela ekranu 3×).
  static let precision: CGFloat = 0.25
  /// Okno dogrywki po korekcie. Aktualizacja z animacją gestu kończy się ~0,5 s po nim (zmierzone: ostatnie układy
  /// 0,50 s po „Zwiń wszystkie”), a dopiero wtedy kolekcja mierzy komórki, które zostały na ekranie.
  static let settleWindow: TimeInterval = 1

  // MARK: - Pomocnicze

  /// Palec na liście albo lista dobiega (gest, wyhamowanie, a z `animated` — także przewinięcie animowane z kodu);
  /// `nil` — lista stoi.
  static func motion(_ list: UICollectionView, animated: Bool) -> String? {
    if list.isTracking { return "isTracking" }
    if list.isDragging { return "isDragging" }
    if list.isDecelerating { return "isDecelerating" }
    if animated, list.isScrollAnimating { return "isScrollAnimating" }
    return nil
  }

  static func whole(_ frame: CGRect, in list: UICollectionView) -> Bool {
    let insets = list.adjustedContentInset
    return TreeListAnchorMath.wholeOnScreen(
      minY: frame.minY, maxY: frame.maxY, offset: list.contentOffset.y, boundsHeight: list.bounds.height,
      insetTop: insets.top, insetBottom: insets.bottom)
  }

  private func items(_ list: UICollectionView?) -> Int {
    guard let list, list.numberOfSections > 0 else { return -1 }
    return list.numberOfItems(inSection: 0)
  }
}

/// Widok pomocniczy w kolekcji drzewa: niewidoczny, bez dotyku i dostępności. Jego `layoutSubviews` idzie po
/// `layoutSubviews` kolekcji (rodzic przed dziećmi), w tym samym przebiegu układu, przed narysowaniem klatki.
final class TreeListAnchorView: UIView {
  weak var anchor: TreeListAnchor?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isHidden = true
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    anchor?.afterLayout()
  }
}
#endif
