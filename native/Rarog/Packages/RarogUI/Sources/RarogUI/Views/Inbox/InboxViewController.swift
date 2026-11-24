#if os(iOS)
import Observation
import RarogCore
import SwiftUI
import UIKit

// The Inbox cards as a UIKit list: one cell per session (diffable id = session id), the card drawn by SwiftUI in
// `UIHostingConfiguration`. UIKit, because the screen must not move under a finger: when cards come above while it
// is not at its top, the first visible card keeps its place on screen (the offset is corrected after the snapshot),
// and the pill counts them (`InboxNewCards`). On the iPhone a card is removed by a swipe to the left (the list's
// trailing swipe action). Owner: Inbox.

struct InboxCollection: UIViewControllerRepresentable {
  let store: RarogStore
  let screen: InboxScreenState
  let decisions: InboxDecisionHost
  let replies: InboxReplyHost
  let voice: VoiceAgentInboxConversation
  let actions: InboxCardActions
  @Environment(RarogNavigation.self) private var navigation

  func makeUIViewController(context: Context) -> InboxViewController {
    InboxViewController(
      store: store, screen: screen, decisions: decisions, replies: replies, voice: voice, navigation: navigation,
      actions: actions)
  }

  func updateUIViewController(_ controller: InboxViewController, context: Context) {
    controller.actions = actions
  }
}

final class InboxViewController: UIViewController, UICollectionViewDelegate {
  /// Space between the cards and around them: the column's side, the cards' gap.
  static let side: CGFloat = 24
  static let compactSide: CGFloat = 12
  static let gap: CGFloat = 12

  let store: RarogStore
  let screen: InboxScreenState
  let decisions: InboxDecisionHost
  let replies: InboxReplyHost
  let voice: VoiceAgentInboxConversation
  let navigation: RarogNavigation
  var actions: InboxCardActions
  private(set) var collectionView: UICollectionView!
  private(set) var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  /// The models the cells were configured with, by session.
  private(set) var cards: [String: InboxCardModel] = [:]
  private var expanded: Set<String> = []
  /// The card with the keyboard focus (`InboxViewController+Keys.swift`); ⌫ removes it.
  var focusedCardId: String?

  init(
    store: RarogStore, screen: InboxScreenState, decisions: InboxDecisionHost, replies: InboxReplyHost,
    voice: VoiceAgentInboxConversation, navigation: RarogNavigation, actions: InboxCardActions
  ) {
    self.store = store
    self.screen = screen
    self.decisions = decisions
    self.replies = replies
    self.voice = voice
    self.navigation = navigation
    self.actions = actions
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) unused")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    var config = UICollectionLayoutListConfiguration(appearance: .plain)
    config.showsSeparators = false
    config.backgroundColor = .clear
    config.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in
      self?.swipeActions(at: indexPath)
    }
    let layout = UICollectionViewCompositionalLayout.list(using: config)
    collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
    collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collectionView.backgroundColor = .clear
    collectionView.delegate = self
    collectionView.allowsSelection = false
    collectionView.allowsFocus = true
    collectionView.selectionFollowsFocus = false
    collectionView.contentInset.bottom = 24
    collectionView.accessibilityIdentifier = "inbox.list"
    view.addSubview(collectionView)
    dataSource = makeDataSource()
    screen.scrollToTop = { [weak self] in self?.scrollToTop() }
    observe()
  }

  private func makeDataSource() -> UICollectionViewDiffableDataSource<Int, String> {
    let registration = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
      guard let self, let card = self.cards[id] else { return }
      cell.backgroundConfiguration = .clear()
      let side = self.traitCollection.horizontalSizeClass == .compact ? Self.compactSide : Self.side
      self.decorateFocus(cell, side: side)
      let content = InboxCardView(
        store: self.store, card: card, expanded: self.expanded.contains(id), actions: self.actions,
        decisions: self.decisions, replies: self.replies, voice: self.voice)
      let navigation = self.navigation
      cell.contentConfiguration = UIHostingConfiguration {
        content.environment(navigation).textScaleHost()
      }
      .margins(.horizontal, side)
      .margins(.vertical, Self.gap / 2)
      .minSize(height: 0)
    }
    return UICollectionViewDiffableDataSource(collectionView: collectionView) { view, index, id in
      view.dequeueConfiguredReusableCell(using: registration, for: index, item: id)
    }
  }

  // MARK: - Keys

  override var keyCommands: [UIKeyCommand]? { Self.removalKeyCommands }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(removeFocusedCard) { return keyRemovalTarget != nil }
    return super.canPerformAction(action, withSender: sender)
  }

  // MARK: - Render

  private func observe() {
    withObservationTracking {
      render()
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in self?.observe() }
    }
  }

  /// A new snapshot when the cards or their order change, a reconfiguration of the cards whose model or fold changed.
  /// Below the top, the first visible card keeps its place on screen.
  func render() {
    let models = store.state.inboxCardModels
    let folds = screen.expanded
    let ids = models.map(\.id)
    let atTop = isAtTop
    let previous = cards
    let previousFolds = expanded
    cards = Dictionary(models.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    if let focused = focusedCardId, cards[focused] == nil { focusedCardId = nil }
    expanded = folds
    var snapshot = dataSource.snapshot()
    let changed = ids.filter { id in
      previous[id] != nil && (previous[id] != cards[id] || previousFolds.contains(id) != folds.contains(id))
    }
    if snapshot.itemIdentifiers != ids {
      let anchor = atTop ? nil : firstVisibleAnchor()
      snapshot = NSDiffableDataSourceSnapshot<Int, String>()
      snapshot.appendSections([0])
      snapshot.appendItems(ids)
      snapshot.reconfigureItems(changed)
      dataSource.apply(snapshot, animatingDifferences: atTop && view.window != nil && !UIAccessibility.isReduceMotionEnabled)
      if let anchor { restore(anchor) }
    } else if !changed.isEmpty {
      snapshot.reconfigureItems(changed)
      dataSource.apply(snapshot, animatingDifferences: false)
    }
    screen.newCards.update(models, atTop: atTop)
  }

  private struct Anchor {
    let id: String
    let offset: CGFloat
  }

  private func firstVisibleAnchor() -> Anchor? {
    guard collectionView.window != nil else { return nil }
    let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
    let visible = collectionView.indexPathsForVisibleItems.sorted()
    for path in visible {
      guard let id = dataSource.itemIdentifier(for: path),
        let frame = collectionView.layoutAttributesForItem(at: path)?.frame, frame.maxY > top
      else { continue }
      return Anchor(id: id, offset: frame.minY - collectionView.contentOffset.y)
    }
    return nil
  }

  private func restore(_ anchor: Anchor) {
    collectionView.layoutIfNeeded()
    guard let path = dataSource.indexPath(for: anchor.id),
      let frame = collectionView.layoutAttributesForItem(at: path)?.frame
    else { return }
    collectionView.contentOffset.y = frame.minY - anchor.offset
  }

  /// The top of the cards is on screen.
  var isAtTop: Bool {
    guard collectionView != nil else { return true }
    return collectionView.contentOffset.y <= -collectionView.adjustedContentInset.top + 4
  }

  func scrollToTop() {
    collectionView.setContentOffset(
      CGPoint(x: 0, y: -collectionView.adjustedContentInset.top), animated: !UIAccessibility.isReduceMotionEnabled)
    screen.newCards.reachedTop()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if isAtTop, !screen.newCards.ids.isEmpty { screen.newCards.reachedTop() }
  }

  // MARK: - Swipe (iPhone)

  func swipeActions(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
    guard traitCollection.horizontalSizeClass == .compact, let id = dataSource.itemIdentifier(for: indexPath),
      let card = cards[id], card.removable
    else { return nil }
    let remove = UIContextualAction(style: .destructive, title: UICopy.inboxSwipeRemove) { [weak self] _, _, done in
      self?.actions.remove(card)
      done(true)
    }
    remove.image = UIImage(systemName: "trash")
    let config = UISwipeActionsConfiguration(actions: [remove])
    config.performsFirstActionWithFullSwipe = true
    return config
  }
}
#endif
