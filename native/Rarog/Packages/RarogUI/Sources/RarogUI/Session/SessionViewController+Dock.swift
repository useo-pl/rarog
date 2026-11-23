#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Dok decyzji: karta zgody, „dialog w terminalu” albo pytanie (także formularz i potwierdzenie odpowiedzi) stoi
// w stopie, w miejscu pola wiadomości; w okresie łaski przed kartą — zastępnik bez
// przycisków. Dok to trzeci element stosu stopy obok pola i karty stanu — schowany nie zajmuje miejsca, a zmiana jego
// wysokości działa jak wzrost pola. Miejsce karty rozstrzyga `DecisionDock.placement` według trybu ekranu
// (`decisionMode`): dok tylko przy `.dock`; przy `.transcript` (domyślnie) karty i zastępnik stoją w transkrypcie,
// a pole jest schowane, przy `.readOnlyComposer` pole stoi pod nimi tylko do odczytu. Właściciel: karty.
extension SessionViewController {
  /// Wstawia hosta karty do doku. Woła go `viewDidLoad` po złożeniu stopy.
  func installDecisionDock() {
    let host = UIHostingController(rootView: AnyView(EmptyView()))
    host.sizingOptions = [.intrinsicContentSize]
    host.safeAreaRegions = []
    host.view.backgroundColor = .clear
    addChild(host)
    decisionSlot.install(host.view)
    host.didMove(toParent: self)
    dockHost = host
    decisionSlot.isHidden = true
    decisionSlot.onFocusChange = { [weak self] focused in
      guard let self else { return }
      if focused { self.focusedCardRow = self.dockModel?.row.id }
    }
  }

  /// Miejsce karty przed złożeniem wierszy: karta w doku (jej wiersz) albo `nil`. Karta, której wiersza nie da się
  /// złożyć (zniknęła między stanem a renderem), zostaje w transkrypcie — nigdy nie znika z obu miejsc. Zastępnik okresu
  /// łaski w doku mówi `dockPlacement.pending` (ogon transkryptu go wtedy nie ma).
  func placeDock(_ state: AppState, foot: FootContent, now: Date) -> DecisionCard? {
    let snapshotLoaded = (state.transcripts[sessionId]?.snapshots ?? 0) > 0
    let loading = state.decisionLoading(for: sessionId, now: now)
    let placement = DecisionDock.placement(
      foot: foot, snapshotLoaded: snapshotLoaded, loading: loading, mode: decisionMode)
    if placement.pending {
      dockPlacement = placement
      dockModel = DecisionDockModel(row: .decisionPending, total: 0)
      return nil
    }
    let row = placement.card.flatMap { TranscriptRows.dockRow(state: state, sessionId: sessionId, ui: ui, card: $0, now: now) }
    // Karty pod adresem już nie ma: zostaje transkrypt i pole, nie pusty dok.
    dockPlacement = placement.card != nil && row == nil ? .none : placement
    dockModel = row.map { DecisionDockModel(row: $0, total: placement.total) }
    return row == nil ? nil : placement.card
  }

  /// Treść doku po renderze: karta, „1 z N”, sufit. Widoczność doku i pola przełącza `renderStateCard`.
  func renderDock() {
    decisionSlot.setPosition(dockModel?.position)
    decisionSlot.hasCard = dockModel.map { CardKeys.focusable($0.row) } ?? false
    let key = DockRenderKey(model: dockModel, ceiling: dockCeiling)
    guard key != renderedDock else { return }
    renderedDock = key
    dockHost?.rootView = dockView()
    dockHost?.view.invalidateIntrinsicContentSize()
  }

  /// Karta w doku: ten sam widok co w transkrypcie, z sufitem układu zwartego (`decisionDockCeiling`). Ramka doku
  /// przycina kartę, która sufitu jeszcze nie respektuje. Tożsamość widoku karty to jej adres (`permId`, `identity`,
  /// `qId`): rendery TEJ SAMEJ karty zachowują stan widoku (fokus i tekst „Własnej odpowiedzi”, przewinięcie), a nowa
  /// karta zaczyna od góry, nie od przewinięcia poprzedniej. Szkic każdej karty żyje w `QuestionDraftBook`.
  private func dockView() -> AnyView {
    guard let model = dockModel else { return AnyView(EmptyView()) }
    let card: AnyView = switch model.row {
    case let .permission(card): AnyView(permissionCardView(card).id(card.permId))
    case let .herdrDialog(card): AnyView(herdrDialogView(card).id(card.identity))
    case let .question(card): AnyView(questionCardView(card).id(card.qId))
    case .decisionPending: AnyView(DecisionPendingView())
    default: AnyView(EmptyView())
    }
    return AnyView(
      card
        .environment(\.decisionDockCeiling, dockCeiling > 0 ? dockCeiling : nil)
        .frame(maxHeight: .infinity, alignment: .top)
        // 10 pt from the column's edges, like the field card it replaces.
        .padding(.horizontal, ListFooterMetrics.cardSide)
        .textScaleHost(Fonts.scale))
  }

  /// Sufit karty z bieżącej geometrii: `min(0,5 × wysokość ekranu sesji, miejsce nad klawiaturą − 120 pt)`. Woła go
  /// każdy układ ekranu (klawiatura, obrót, okno); zmiana przebudowuje dok.
  func placeDockCeiling() {
    let guide = view.keyboardLayoutGuide.layoutFrame
    let bottom = min(view.bounds.maxY, guide.height > 0 ? guide.minY : view.bounds.maxY)
    let above = Double(bottom - view.safeAreaInsets.top)
    let ceiling = CGFloat(DecisionDock.ceiling(screenHeight: Double(view.bounds.height), aboveKeyboard: above))
    guard view.bounds.height > 0, abs(ceiling - dockCeiling) >= 0.5 else { return }
    dockCeiling = ceiling
    decisionSlot.setCeiling(ceiling)
    if dockModel != nil { renderDock() }
  }

  /// Fokus czytnika stał w polu, które właśnie zniknęło przy decyzji: czytnik nie gubi się na schowanym widoku.
  /// Z dokiem przechodzi na nagłówek doku („1 z N”, a bez kolejki nagłówek karty), w trybie
  /// `.transcript` na komórkę karty w transkrypcie. Zastępnik okresu łaski jest dla czytnika niewidoczny:
  /// przeniesienie czeka na kartę, która stanie w jego miejscu.
  func moveVoiceOverToDecision(composerHadFocus: Bool) {
    guard decisionMode == .transcript else { return moveVoiceOverToDock(composerHadFocus: composerHadFocus) }
    guard case .decision = footContent, composer.isHidden else {
      voiceOverAwaitsDockCard = false
      return
    }
    guard composerHadFocus || voiceOverAwaitsDockCard else { return }
    guard firstCardCell() != nil else {
      voiceOverAwaitsDockCard = true
      return
    }
    voiceOverAwaitsDockCard = false
    // Po końcowym ułożeniu listy: przypięty transkrypt wraca na dno (`settleAtBottom` w `trackAndRender`), więc karta
    // przewinięta do widoku tutaj mogłaby zaraz z niego zejść. Fokus idzie na pierwszą WIDOCZNĄ kartę.
    Task { @MainActor [weak self] in
      guard let self, let cell = self.visibleCardCell() ?? self.firstCardCell() else { return }
      self.accessibilityPost(.layoutChanged, cell)
    }
  }

  /// Najwyższa widoczna komórka karty z decyzją — only the part of the list above the foot counts (`+UnderFoot`).
  func visibleCardCell() -> UICollectionViewCell? {
    uncoveredCells()
      .filter { cell in
        let id = collectionView.indexPath(for: cell).flatMap { dataSource.itemIdentifier(for: $0) }
        return id.flatMap { rows[$0] }.map(CardKeys.focusable) ?? false
      }
      .min { $0.frame.minY < $1.frame.minY }
  }

  private func moveVoiceOverToDock(composerHadFocus: Bool) {
    if decisionSlot.isHidden { voiceOverAwaitsDockCard = false }
    guard composerHadFocus || voiceOverAwaitsDockCard, !decisionSlot.isHidden else { return }
    if dockModel?.row == .decisionPending {
      voiceOverAwaitsDockCard = true
      return
    }
    voiceOverAwaitsDockCard = false
    accessibilityPost(.layoutChanged, decisionSlot.voiceOverTarget)
  }

  /// Fokus czytnika w polu wiadomości (w nim albo w jego przyciskach).
  func voiceOverFocusInComposer() -> Bool {
    guard let element = voiceOverFocusedElement() as? UIView else { return false }
    return element.isDescendant(of: composer)
  }
}

/// Co ostatnio trafiło do hosta doku: ten sam model i sufit = bez przebudowy SwiftUI.
struct DockRenderKey: Equatable {
  let model: DecisionDockModel?
  let ceiling: CGFloat
}

/// Miejsce doku w stosie stopy: nagłówek „1 z N” nad kartą, karta przycięta do sufitu, pod nią ten sam spoczynek co
/// pod polem (`ComposerView.bottomInset`), więc dół karty stoi tam, gdzie dół pola. The header stands on a capsule of
/// the cards' glass: the transcript runs under the foot, and no text hangs over it without a surface. Z
/// klawiaturą sprzętową dok przyjmuje fokus (Tab) i ma obwódkę jak komórka karty w transkrypcie.
final class DecisionDockSlot: UIView {
  /// Karta w doku przyjmuje fokus klawiatury (karta z decyzją; zamknięta nie).
  var hasCard = false
  /// Fokus klawiatury wszedł na dok (`true`) albo z niego zszedł.
  var onFocusChange: ((Bool) -> Void)?
  private let position = UILabel()
  /// The header's surface: a capsule of the cards' glass hugging "1 of N".
  private let positionSurface = GlassSurfaceView(radius: 100)
  private let cardFrame = UIView()
  private let ring = UIView()
  private var ceiling: NSLayoutConstraint!
  private var positionShown: NSLayoutConstraint!
  private var positionHidden: NSLayoutConstraint!
  /// Karta ma 8 pt marginesu w pionie (`PermissionCardView`, `HerdrDialogCardView`), więc pod dokiem zostaje reszta
  /// spoczynku pola.
  static let cardVerticalMargin: CGFloat = 8

  override init(frame: CGRect) {
    super.init(frame: frame)
    accessibilityIdentifier = "dock"
    // Nagłówek „1 z N” i karta to jedna grupa dla czytnika (i jeden element „dock” dla XCUITest).
    accessibilityContainerType = .semanticGroup
    position.font = Fonts.text(.footnote)
    position.adjustsFontForContentSizeCategory = true
    position.textColor = Palette.muted
    position.textAlignment = .natural
    position.accessibilityTraits = .header
    position.accessibilityIdentifier = "dock.position"
    position.isHidden = true
    positionSurface.isHidden = true
    positionSurface.accessibilityIdentifier = "dock.position.surface"
    cardFrame.clipsToBounds = true
    cardFrame.accessibilityIdentifier = "dock.card"
    ring.isUserInteractionEnabled = false
    ring.backgroundColor = .clear
    ring.layer.borderWidth = 3
    ring.layer.roundCorners(Radius.focusRing)
    ring.isAccessibilityElement = false
    ring.isHidden = true
    for item in [positionSurface, cardFrame] {
      item.translatesAutoresizingMaskIntoConstraints = false
      addSubview(item)
    }
    position.translatesAutoresizingMaskIntoConstraints = false
    positionSurface.addSubview(position)
    addSubview(ring)
    positionShown = cardFrame.topAnchor.constraint(equalTo: positionSurface.bottomAnchor)
    positionHidden = cardFrame.topAnchor.constraint(equalTo: topAnchor)
    ceiling = cardFrame.heightAnchor.constraint(lessThanOrEqualToConstant: 10_000)
    NSLayoutConstraint.activate([
      positionSurface.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      positionSurface.leadingAnchor.constraint(equalTo: leadingAnchor, constant: ListFooterMetrics.cardSide),
      positionSurface.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -ListFooterMetrics.cardSide),
      position.topAnchor.constraint(equalTo: positionSurface.topAnchor, constant: 4),
      position.bottomAnchor.constraint(equalTo: positionSurface.bottomAnchor, constant: -4),
      position.leadingAnchor.constraint(equalTo: positionSurface.leadingAnchor, constant: 12),
      position.trailingAnchor.constraint(equalTo: positionSurface.trailingAnchor, constant: -12),
      positionHidden, ceiling,
      cardFrame.leadingAnchor.constraint(equalTo: leadingAnchor),
      cardFrame.trailingAnchor.constraint(equalTo: trailingAnchor),
      cardFrame.bottomAnchor.constraint(
        equalTo: bottomAnchor, constant: -(ComposerView.bottomInset - Self.cardVerticalMargin)),
    ])
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: DecisionDockSlot, _: UITraitCollection) in
      self.updateRing()
    }
    updateRing()
    Fonts.follow(self) { [weak self] in self?.position.font = Fonts.text(.footnote) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) nieużywany")
  }

  func install(_ content: UIView) {
    content.translatesAutoresizingMaskIntoConstraints = false
    cardFrame.addSubview(content)
    NSLayoutConstraint.activate([
      content.topAnchor.constraint(equalTo: cardFrame.topAnchor),
      content.leadingAnchor.constraint(equalTo: cardFrame.leadingAnchor),
      content.trailingAnchor.constraint(equalTo: cardFrame.trailingAnchor),
      // Treść wyższa niż sufit: ramka ją przycina od dołu, nagłówek karty zostaje. Równość ustępuje odporności treści
      // na ściskanie (750), więc karta zachowuje swoją wysokość, a ramka staje na suficie.
      content.bottomAnchor.constraint(equalTo: cardFrame.bottomAnchor).withPriority(UILayoutPriority(740)),
      content.bottomAnchor.constraint(greaterThanOrEqualTo: cardFrame.bottomAnchor),
    ])
  }

  /// „1 z N” nad kartą; `nil` = bez nagłówka.
  func setPosition(_ text: String?) {
    position.text = text
    let shown = text != nil
    guard position.isHidden == shown else { return }
    position.isHidden = !shown
    positionSurface.isHidden = !shown
    positionHidden.isActive = !shown
    positionShown.isActive = shown
  }

  /// Sufit wysokości karty (`DecisionDock.ceiling`).
  func setCeiling(_ value: CGFloat) {
    ceiling.constant = value
  }

  /// Element, na który przechodzi czytnik, gdy dok staje w miejscu pola: nagłówek „1 z N”, bez niego karta.
  var voiceOverTarget: Any {
    position.isHidden ? cardFrame.subviews.first ?? cardFrame : position
  }

  // MARK: Fokus klawiatury

  override var canBecomeFocused: Bool { hasCard && !isHidden }

  override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
    super.didUpdateFocus(in: context, with: coordinator)
    let focused = context.nextFocusedItem === self
    ring.isHidden = !focused
    if focused { setNeedsLayout() }
    if focused || context.previouslyFocusedItem === self { onFocusChange?(focused) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // Obwódka 3 pt na zewnątrz karty, jak w komórce transkryptu (`CardFocusRing`).
    let card = cardFrame.frame.insetBy(dx: ListFooterMetrics.cardSide, dy: Self.cardVerticalMargin)
    ring.frame = card.insetBy(dx: -3, dy: -3)
  }

  override func tintColorDidChange() {
    super.tintColorDidChange()
    updateRing()
  }

  private func updateRing() {
    ring.layer.borderColor = tintColor.resolvedColor(with: traitCollection).cgColor
  }
}

extension NSLayoutConstraint {
  fileprivate func withPriority(_ priority: UILayoutPriority) -> NSLayoutConstraint {
    self.priority = priority
    return self
  }
}
#endif
