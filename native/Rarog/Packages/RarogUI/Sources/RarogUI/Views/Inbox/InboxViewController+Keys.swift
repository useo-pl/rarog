#if os(iOS)
import UIKit

// The Inbox with a hardware keyboard: the cards take the keyboard focus (Tab and the arrows move it) and show it with
// the decision cards' ring, because the cell's background is clear and the system focus effect would not be seen.
// ⌫ or forward delete removes the focused card the way "×" does (`InboxCardActions.remove`: the card goes at once,
// the toast offers Undo); a field that is typing and a sheet over the screen keep the key
// (`InboxCardModel.keyRemovalTarget`). Owner: Inbox.
extension InboxViewController {
  func collectionView(_ collectionView: UICollectionView, canFocusItemAt indexPath: IndexPath) -> Bool {
    dataSource.itemIdentifier(for: indexPath).flatMap { cards[$0] } != nil
  }

  func collectionView(
    _ collectionView: UICollectionView, didUpdateFocusIn context: UICollectionViewFocusUpdateContext,
    with coordinator: UIFocusAnimationCoordinator
  ) {
    focusedCardId = context.nextFocusedIndexPath.flatMap { dataSource.itemIdentifier(for: $0) }
  }

  /// ⌫ and the forward delete key. Not repeatable: a held key removes one card, not the whole Inbox.
  static let removalKeyCommands: [UIKeyCommand] = ["\u{8}", UIKeyCommand.inputDelete].map { input in
    let command = UIKeyCommand(input: input, modifierFlags: [], action: #selector(removeFocusedCard))
    command.repeatBehavior = .nonRepeatable
    return command
  }

  /// The card the removal keys take now, or `nil` when they are not the Inbox's.
  var keyRemovalTarget: InboxCardModel? {
    InboxCardModel.keyRemovalTarget(
      focused: focusedCardId, cards: Array(cards.values), typing: FirstResponder.current() is UITextInput,
      sheetAbove: PresentedSheet.top(over: view) != nil)
  }

  @objc func removeFocusedCard() {
    guard let card = keyRemovalTarget else { return }
    actions.remove(card)
  }

  /// The focus ring of a card cell: the card stands in the cell's margins (`side` across, half the gap down), the ring
  /// 3 pt outside its edge.
  func decorateFocus(_ cell: UICollectionViewListCell, side: CGFloat) {
    cell.focusEffect = nil
    cell.configurationUpdateHandler = { cell, state in
      let ring = CardFocusRing.ring(in: cell)
      if state.isFocused {
        let bounds = cell.bounds
        let fits = bounds.width > side * 2 && bounds.height > Self.gap
        ring.frame = fits ? bounds.insetBy(dx: side - 3, dy: Self.gap / 2 - 3) : bounds
      }
      ring.isHidden = !state.isFocused
    }
  }
}
#endif
