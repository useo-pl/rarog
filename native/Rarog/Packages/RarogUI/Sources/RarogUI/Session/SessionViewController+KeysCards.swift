#if os(iOS)
import GameController
import RarogCore
import UIKit

// Klawiatura na kartach decyzji:
// - fokus klawiatury staje wyłącznie na kartach (zgoda, pytanie, dialog w panelu) i jest WIDOCZNY
//   (obwódka); cyfry i Enter karty pytania: `+KeysAnswers`; karta w doku w miejscu pola (`+Dock`) tak samo,
//   a Tab idzie na nią przed kartami w transkrypcie;
// - Tab poza polem edycji: przy stojącej karcie idzie najpierw na kartę, bez karty — do pola wiadomości;
// - Esc z fokusem na karcie zgody albo dialogu = „Odrzuć" i tylko to; zgody nie daje żaden klawisz;
//   Esc na karcie pytania nie jest decyzją i należy do ekranu;
// - gdy karta z fokusem znika, fokus wraca do transkryptu, nie do pola.
// Lista `cardKeyCommands` i `cardKeyVerdict` wchodzą do `keyCommands` i `canPerformAction`
// kontrolera. Właściciel: karty.
extension SessionViewController {
  func collectionView(_ collectionView: UICollectionView, canFocusItemAt indexPath: IndexPath) -> Bool {
    guard let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id] else { return false }
    return CardKeys.focusable(row)
  }

  func collectionView(_ collectionView: UICollectionView, didUpdateFocusIn context: UICollectionViewFocusUpdateContext,
                      with coordinator: UIFocusAnimationCoordinator) {
    let next = context.nextFocusedIndexPath.flatMap { dataSource.itemIdentifier(for: $0) }
    if let next, let row = rows[next], CardKeys.focusable(row) {
      focusedCardRow = next
    } else if context.nextFocusedItem != nil, context.nextFocusedItem !== decisionSlot {
      // Fokus poszedł gdzie indziej z woli człowieka — ratunek nie ma czego ratować.
      focusedCardRow = nil
    }
  }

  var cardKeyCommands: [UIKeyCommand] {
    let escape = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapeOnCard))
    escape.wantsPriorityOverSystemBehavior = true
    // Przytrzymany Esc, który zamknął okno nad ekranem, nie odrzuca karty pod nim.
    escape.repeatBehavior = .nonRepeatable
    // Tab bez modyfikatorów; Shift+Tab zostaje systemowi (nawigacja wstecz).
    let tab = UIKeyCommand(input: "\t", modifierFlags: [], action: #selector(tabFromScreen))
    tab.wantsPriorityOverSystemBehavior = true
    return [escape, tab]
  }

  /// `nil` = akcja nie należy do kart.
  func cardKeyVerdict(_ action: Selector) -> Bool? {
    // Esc: karta z fokusem (odrzuć), potem arkusz nad ekranem (zamknij); inaczej należy do kogoś
    // innego (przerwanie tury).
    if action == #selector(escapeOnCard) {
      // Session switcher window open: Esc is its, the card underneath stays untouched.
      if switcherAbsorbsEscape { return true }
      return (focusedCard().map(CardKeys.escapeDenies) ?? false) || PresentedSheet.top(over: view) != nil
        // Esc tuż po zamknięciu prezentacji Esc-em: ekran go bierze i połyka (nie idzie dalej do przerwania).
        || EscapeGrace.swallows()
    }
    if action == #selector(tabFromScreen) { return tabTarget() != nil }
    return nil
  }

  // MARK: - Esc i Tab

  /// Esc z fokusem w karcie znaczy „Odrzuć" i tylko to — kierunek bezpieczny. Zgody żaden klawisz
  /// nie daje (przyciski zgody nie przyjmują fokusu ani aktywacji klawiszem).
  @objc private func escapeOnCard() {
    if takeEscapeForSwitcher() { return }
    // Arkusz (popover, arkusz, potwierdzenie) stoi nad ekranem: Esc go zamyka, karty pod nim nie rusza.
    if let sheet = PresentedSheet.top(over: view) {
      EscapeGrace.closedByEscape()
      PresentedSheet.dismiss(sheet)
      return
    }
    // Okno łaski: Esc tuż po zamknięciu prezentacji Esc-em karty nie odrzuca.
    guard !EscapeGrace.swallows() else { return }
    switch focusedCard() {
    case let .permission(card)? where card.phase == .idle && card.lockedReason == nil:
      decide(card, .deny)
    case let .herdrDialog(card)? where card.phase == .idle && card.lockedReason == nil && !card.channelDead:
      decideDialog(card, .deny)
    default:
      break
    }
  }

  @objc private func tabFromScreen() {
    switch tabTarget() {
    case .card?:
      // Karta w doku stoi pierwsza: jest pierwszą decyzją kolejki i zawsze na widoku.
      let target: UIFocusEnvironment? = dockedCard() != nil ? decisionSlot : firstCardCell()
      guard let target else { return }
      let focus = UIFocusSystem.focusSystem(for: view)
      focus?.requestFocusUpdate(to: target)
      focus?.updateFocusIfNeeded()
    case .composer?:
      composer.textView.becomeFirstResponder()
    case nil:
      break
    }
  }

  private func tabTarget() -> CardKeys.TabTarget? {
    // Pisanie to KAŻDE pole edycji (pole wiadomości, „Własna odpowiedź" karty pytania): Tab należy do niego.
    CardKeys.tabTarget(
      typing: FirstResponder.current() is UITextInput,
      cardFocused: focusedCard() != nil,
      hasCard: hasFocusableCard,
      composerUsable: !composer.isHidden && composer.isEditable)
  }

  /// Stoi karta, na którą może wejść fokus klawiatury: w transkrypcie albo w doku.
  var hasFocusableCard: Bool {
    dockedCard() != nil || rows.values.contains(where: CardKeys.focusable)
  }

  /// Karta w doku, która przyjmuje fokus (`+Dock`).
  func dockedCard() -> TranscriptRow? {
    guard let row = dockModel?.row, !decisionSlot.isHidden, CardKeys.focusable(row) else { return nil }
    return row
  }

  private func focusedCard() -> TranscriptRow? {
    let focused = UIFocusSystem.focusSystem(for: view)?.focusedItem
    if focused === decisionSlot { return dockedCard() }
    guard let cell = focused as? UICollectionViewCell,
      let indexPath = collectionView.indexPath(for: cell),
      let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id], CardKeys.focusable(row)
    else { return nil }
    return row
  }

  /// Pierwsza widoczna albo istniejąca komórka karty (karty stoją na dnie transkryptu).
  func firstCardCell() -> UICollectionViewCell? {
    let snapshot = dataSource.snapshot()
    guard let id = snapshot.itemIdentifiers.first(where: { rows[$0].map(CardKeys.focusable) ?? false }),
      let indexPath = dataSource.indexPath(for: id)
    else { return nil }
    // Also a cell laid out under the foot: the list runs under it (`+UnderFoot`).
    if collectionView.cellForItem(at: indexPath).map(isUncovered) != true {
      collectionView.scrollToItem(at: indexPath, at: .bottom, animated: false)
      collectionView.layoutIfNeeded()
    }
    return collectionView.cellForItem(at: indexPath)
  }

  // MARK: - Ekran odbiera klawisze przy decyzji

  /// Przy stojącej decyzji pole jest wygaszone i nikt nie jest pierwszym responderem — wtedy Tab
  /// trafiłby w system fokusu, który zaczyna od listy, a cyfry karty pytania
  /// nie miałyby adresata. Ekran bierze klawisze sam, ale nigdy nie zabiera ich polu edycji, które ktoś
  /// właśnie trzyma (arkusz, inne okno), ani elementowi z fokusem klawiatury. Gdy kart już nie ma,
  /// a pole znów przyjmuje tekst, klawiatura wraca do pola (karta pytania: z klawiaturą sprzętową od razu się pisze).
  func claimKeyboardForCards() {
    guard view.window?.isKeyWindow == true, GCKeyboard.coalesced != nil else { return }
    if hasFocusableCard {
      guard !isFirstResponder, FirstResponder.current() == nil,
        UIFocusSystem.focusSystem(for: view)?.focusedItem == nil
      else { return }
      becomeFirstResponder()
    } else if isFirstResponder, composer.isEditable {
      composer.textView.becomeFirstResponder()
    }
  }

  // MARK: - Widoczny fokus i ratunek

  /// Obwódka fokusu karty: komórka listy ma tło wyczyszczone (`.clear()`), więc systemowy efekt
  /// fokusu nie widać — Esc odrzucałby kartę, na której fokusu nikt nie widzi.
  /// Woła ją fabryka komórek dla każdego wiersza SwiftUI (karta dostaje obwódkę, reszta ją traci).
  func decorateCardCell(_ cell: UICollectionViewListCell, row: TranscriptRow) {
    guard CardKeys.focusable(row) else {
      cell.configurationUpdateHandler = nil
      CardFocusRing.existing(in: cell)?.isHidden = true
      return
    }
    cell.focusEffect = nil
    cell.focusGroupPriority = .prioritized
    cell.configurationUpdateHandler = { cell, state in
      let ring = CardFocusRing.ring(in: cell)
      if state.isFocused { ring.frame = CardFocusRing.frame(in: cell) }
      ring.isHidden = !state.isFocused
    }
  }

  /// Fokus VoiceOvera na karcie (albo z niej zszedł) — ten sam wiersz, co przy fokusie klawiatury,
  /// żeby ratunek po zniknięciu karty działał też pod czytnikiem. Rejestracja raz na ekran.
  func trackVoiceOverCardFocus() {
    guard cardFocusObserver == nil else { return }
    cardFocusObserver = NotificationCenter.default.addObserver(
      forName: UIAccessibility.elementFocusedNotification, object: nil, queue: .main
    ) { [weak self] note in
      let element = note.userInfo?[UIAccessibility.focusedElementUserInfoKey]
      let box = SendableBox(element as AnyObject?)
      MainActor.assumeIsolated { self?.voiceOverFocused(box.value) }
    }
  }

  private func voiceOverFocused(_ element: AnyObject?) {
    guard let view = Self.view(holding: element) else {
      // Czytnik poszedł gdzie indziej (nie na kartę): nie ma czego ratować.
      if element != nil { focusedCardRow = nil }
      return
    }
    // Karta w doku nie jest komórką transkryptu: fokus na niej to ten sam wiersz, który ratuje `rescueCardFocus`.
    if view.isDescendant(of: decisionSlot) {
      focusedCardRow = dockedCard()?.id
      return
    }
    guard let cell = Self.cell(of: view), let indexPath = collectionView.indexPath(for: cell),
      let id = dataSource.itemIdentifier(for: indexPath), let row = rows[id], CardKeys.focusable(row)
    else {
      focusedCardRow = nil
      return
    }
    focusedCardRow = id
  }

  /// Komórka transkryptu, w której stoi widok.
  private static func cell(of view: UIView) -> UICollectionViewCell? {
    var walker: UIView? = view
    while let candidate = walker {
      if let cell = candidate as? UICollectionViewCell { return cell }
      walker = candidate.superview
    }
    return nil
  }

  /// Widok, w którym stoi element dostępności (sam widok albo węzeł SwiftUI w kontenerze).
  private static func view(holding element: AnyObject?) -> UIView? {
    var current: AnyObject? = element
    for _ in 0..<64 {
      guard let node = current else { return nil }
      if let view = node as? UIView { return view }
      if let element = node as? UIAccessibilityElement {
        current = element.accessibilityContainer as AnyObject?
      } else if let object = node as? NSObject,
        object.responds(to: #selector(getter: UIAccessibilityElement.accessibilityContainer))
      {
        current = object.value(forKey: "accessibilityContainer") as AnyObject?
      } else {
        return nil
      }
    }
    return nil
  }

  /// Karta z fokusem zniknęła (decyzja zapadła, sesja ruszyła): fokus wraca do transkryptu, nigdy do
  /// pola wiadomości — na dotyku pole podniosłoby klawiaturę, o którą nikt nie prosił.
  func rescueCardFocus() {
    trackVoiceOverCardFocus()
    guard let row = focusedCardRow, rows[row] == nil, dockedCard()?.id != row else { return }
    focusedCardRow = nil
    if UIAccessibility.isVoiceOverRunning {
      UIAccessibility.post(notification: .layoutChanged, argument: focusRescueTarget() ?? collectionView)
    }
    let focus = UIFocusSystem.focusSystem(for: view)
    if focus?.focusedItem == nil || focus?.focusedItem === composer.textView {
      focus?.requestFocusUpdate(to: collectionView)
    }
  }

  /// Where the reader's focus lands after the focused card disappeared: the lowest transcript row above the foot.
  func focusRescueTarget() -> UICollectionViewCell? {
    uncoveredCells().max { $0.frame.maxY < $1.frame.maxY }
  }
}

/// Obwódka fokusu karty — warstwa nad komórką, idzie za jej rozmiarem, nie łapie dotyku.
@MainActor
enum CardFocusRing {
  private static let tag = 0x2E2F

  static func existing(in cell: UICollectionViewCell) -> UIView? {
    cell.viewWithTag(tag)
  }

  /// Karta stoi w marginesach komórki: 16 pt w poziomie (`UIHostingConfiguration`), 8 pt w pionie;
  /// obwódka 3 pt na zewnątrz jej krawędzi.
  static func frame(in cell: UICollectionViewCell) -> CGRect {
    let bounds = cell.bounds
    guard bounds.width > 26, bounds.height > 10 else { return bounds }
    return bounds.insetBy(dx: 13, dy: 5)
  }

  static func ring(in cell: UICollectionViewCell) -> UIView {
    if let ring = existing(in: cell) { return ring }
    let ring = RingView(frame: frame(in: cell))
    ring.tag = tag
    ring.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    ring.isUserInteractionEnabled = false
    ring.backgroundColor = .clear
    ring.layer.borderWidth = 3
    ring.layer.roundCorners(Radius.focusRing)
    ring.isAccessibilityElement = false
    ring.isHidden = true
    cell.addSubview(ring)
    return ring
  }

  /// Obwódka w odcieniu widoku, liczona od nowa przy zmianie odcienia i motywu: `CGColor` warstwy
  /// sam za motywem nie idzie.
  private final class RingView: UIView {
    override init(frame: CGRect) {
      super.init(frame: frame)
      registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: RingView, _: UITraitCollection) in
        self.updateBorder()
      }
      updateBorder()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) nieużywany")
    }

    override func tintColorDidChange() {
      super.tintColorDidChange()
      updateBorder()
    }

    private func updateBorder() {
      layer.borderColor = tintColor.resolvedColor(with: traitCollection).cgColor
    }
  }
}

/// Arkusz nad ekranem sesji i jego zamknięcie Esc-em. Popover i arkusz SwiftUI schodzą
/// tą samą drogą co stuknięcie obok: delegat prezentacji dostaje `…ShouldDismiss`/`…DidDismiss`, więc
/// stan SwiftUI (`isPresented`, `item`) wraca do zera i arkusz da się otworzyć ponownie. Arkusz, który
/// zamknięcia nie przyjmuje (`isModalInPresentation`, delegat mówi „nie"), zostaje.
@MainActor
enum PresentedSheet {
  static func top(over view: UIView) -> UIViewController? {
    guard var top = view.window?.rootViewController?.presentedViewController else { return nil }
    while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
    guard !top.isBeingDismissed, !top.isModalInPresentation, let controller = top.presentationController else { return nil }
    if controller.delegate?.presentationControllerShouldDismiss?(controller) == false { return nil }
    return top
  }

  /// Arkusz stojący NAD widokiem: jak ``top(over:)``, ale bez arkusza, w którym widok sam stoi — terminal w oknie
  /// Cmd+F widzi nad sobą historię, nie własne okno.
  static func top(above view: UIView) -> UIViewController? {
    guard let sheet = top(over: view), covers(sheet, view) else { return nil }
    return sheet
  }

  /// Co stoi nad widokiem, gdy przychodzi Esc.
  enum Above {
    /// Nic — albo tylko arkusz, w którym widok sam stoi.
    case nothing
    /// Arkusz, który Esc zamyka.
    case dismissable(UIViewController)
    /// Arkusz, który zamknięcia nie przyjmuje albo właśnie schodzi: Esc należy do niego i niczego pod nim nie rusza.
    case held
  }

  static func above(_ view: UIView) -> Above {
    guard var top = view.window?.rootViewController?.presentedViewController else { return .nothing }
    while let next = top.presentedViewController { top = next }
    guard covers(top, view) else { return .nothing }
    return self.top(above: view).map(Above.dismissable) ?? .held
  }

  /// Arkusz stoi nad widokiem, gdy widok nie jest jego częścią.
  static func covers(_ sheet: UIViewController, _ view: UIView) -> Bool {
    !view.isDescendant(of: sheet.view)
  }

  static func dismiss(_ sheet: UIViewController) {
    guard let controller = sheet.presentationController else { return }
    controller.delegate?.presentationControllerWillDismiss?(controller)
    sheet.dismiss(animated: true) {
      controller.delegate?.presentationControllerDidDismiss?(controller)
    }
  }
}

/// Pierwszy responder okna (`sendAction` do `nil` trafia w niego). Okno i aplikacja na końcu
/// łańcucha znaczą „nikt nie pisze".
@MainActor
enum FirstResponder {
  fileprivate static weak var found: UIResponder?

  static func current() -> UIResponder? {
    found = nil
    UIApplication.shared.sendAction(#selector(UIResponder.rarogReportFirstResponder(_:)), to: nil, from: nil, for: nil)
    guard let responder = found, !(responder is UIWindow), !(responder is UIApplication) else { return nil }
    return responder
  }
}

extension UIResponder {
  @objc fileprivate func rarogReportFirstResponder(_ sender: Any?) {
    FirstResponder.found = self
  }
}

/// Przenosi element dostępności z powiadomienia na główny aktor (powiadomienie przychodzi na `.main`).
private struct SendableBox: @unchecked Sendable {
  let value: AnyObject?
  init(_ value: AnyObject?) { self.value = value }
}
#endif
