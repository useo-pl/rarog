#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// The prompt quote bar: it quotes the prompt whose result is on screen now; hidden at the bottom and at the very top,
// it slides out from under the header's bottom edge. A tap opens the "Prompts in This Session" popover, a tap on a row
// jumps to the turn and puts the prompt just under the bar. The scroll is followed by observing `contentOffset` (the
// list's delegate belongs to the transcript). Owner: session control.
extension SessionViewController {
  func installPromptBar() {
    let bar = PromptBarView()
    bar.isHidden = true
    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.addAction(UIAction { [weak self] _ in self?.showPrompts() }, for: .touchUpInside)
    view.addSubview(bar)
    // Bubble style: the leading edge in line with the transcript content and the bubble (the transcript's side margin,
    // 16 pt in Standard); as wide as the quote, at most to the same margin from the trailing edge (the bar keeps its
    // own cap, the prompt bubble's).
    let side = transcriptSide()
    let leading = bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: side)
    let trailing = bar.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -side)
    // The top edge on the header's bottom edge: the safe area's top is where the header ends.
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), leading, trailing,
    ])
    turnChrome.promptBar = bar
    turnChrome.promptBarLeading = leading
    turnChrome.promptBarTrailing = trailing
    turnChrome.offsetObservation = collectionView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.renderPromptBar(nil) }
    }
  }

  /// A render (the state) or a scroll (`nil` = the store's state).
  func renderPromptBar(_ state: AppState?) {
    guard let bar = turnChrome.promptBar else { return }
    let state = state ?? store.state
    let entries = PromptBar.entries(state.transcripts[sessionId]?.messages ?? [])
    let quote = PromptBar.current(entries, edgeSeq: edgeSeq())
    let fromTop = Double(collectionView.contentOffset.y + collectionView.adjustedContentInset.top)
    // Dno liczone z geometrii, nie z przypięcia: przypięcie zmienia się dopiero PO ostatnim
    // przesunięciu (koniec wytracania), więc pasek zostałby schowany nad odpiętym transkryptem.
    let atBottom = distanceFromBottom() <= Self.pinThreshold
    let hidden = PromptBar.hidden(pinned: atBottom, offsetFromTop: fromTop, quote: quote)
    if bar.isShown == hidden {
      // The "N new" pill stands under the bar while the bar stands, and the bar covers the top of the list
      // (`+Reading`): both read `isHidden`, which a slide out flips only at its end, so they are asked again then.
      bar.setShown(!hidden, animated: true) { [weak self] in
        self?.placeNewPill()
        self?.scheduleNewPill()
      }
      placeNewPill()
      scheduleNewPill()
    }
    guard let quote, quote != turnChrome.promptQuote else { return }
    turnChrome.promptQuote = quote
    bar.quote = quote.entry.text
  }

  /// Numer wiadomości wiersza tuż pod paskiem; `nil` = wiersz za ostatnią wiadomością.
  private func edgeSeq() -> Int? {
    let edge = collectionView.contentOffset.y + collectionView.adjustedContentInset.top + CGFloat(PromptBar.grab)
    let rows = collectionView.indexPathsForVisibleItems.sorted().compactMap { index -> (id: String, frame: CGRect)? in
      guard let id = dataSource.itemIdentifier(for: index), let frame = collectionView.layoutAttributesForItem(at: index)?.frame
      else { return nil }
      return (id, frame)
    }
    guard let row = rows.last(where: { $0.frame.minY <= edge }) ?? rows.first else { return nil }
    return PromptBar.seq(rowId: row.id)
  }

  private func showPrompts() {
    let entries = PromptBar.entries(store.state.transcripts[sessionId]?.messages ?? [])
    let current = PromptBar.current(entries, edgeSeq: edgeSeq())?.entry.seq
    // Na telefonie system zamienia dymek na arkusz: lista dostaje pasek z tytułem (`popoverSheetChrome`), bez „×";
    // zamyka go uchwyt (przeciągnięcie w dół), tap nad arkuszem i gest „wstecz” czytnika (system).
    let list = PromptListView(
      entries: entries, currentSeq: current,
      select: { [weak self] seq in self?.dismiss(animated: true) { self?.jumpToPrompt(seq) } })
    let host = UIHostingController(rootView: list.textScaleHost(Fonts.scale))
    host.modalPresentationStyle = .popover
    // Pełne tło zamiast szkła popovera, także pod strzałką (`PromptListView.background`).
    host.view.backgroundColor = PromptListView.background
    host.popoverPresentationController?.backgroundColor = PromptListView.background
    host.popoverPresentationController?.sourceView = turnChrome.promptBar
    host.popoverPresentationController?.permittedArrowDirections = [.up]
    // The popover as tall as the list (lazy, so from the number of rows), up to the popovers' shared ceiling. The row
    // (a time line over two lines of the prompt) and the title grow with the text size: at an accessibility size one
    // two-line prompt did not fit the height computed for the default size.
    host.preferredContentSize = CGSize(
      width: PopoverLayout.idealWidth,
      height: PopoverLayout.promptsHeight(
        rows: entries.count,
        rowHeight: Fonts.scaled(PromptListView.rowHeight, relativeTo: .subheadline, traits: traitCollection),
        header: Fonts.scaled(PromptListView.headerHeight, relativeTo: .headline, traits: traitCollection)))
    if let sheet = host.popoverPresentationController?.adaptiveSheetPresentationController {
      sheet.detents = [.medium(), .large()]
      sheet.prefersGrabberVisible = true
    }
    present(host, animated: true)
  }

  /// A jump to a turn: the prompt just under the bar (the same 6 pt gap as the "N new" pill). It unpins the transcript:
  /// the person reads higher up.
  private func jumpToPrompt(_ seq: Int) {
    let prefix = "m\(seq)."
    guard let rowId = dataSource.snapshot().itemIdentifiers.first(where: { $0.hasPrefix(prefix) }),
      let index = dataSource.indexPath(for: rowId)
    else { return }
    pinned = false
    collectionView.layoutIfNeeded()
    collectionView.scrollToItem(at: index, at: .top, animated: false)
    collectionView.layoutIfNeeded()
    guard let frame = collectionView.layoutAttributesForItem(at: index)?.frame else { return }
    let covered = (turnChrome.promptBar?.bounds.height ?? 44) + CGFloat(NewLineJump.gap)
    setClampedOffset(frame.minY - collectionView.adjustedContentInset.top - covered)
    rememberPosition()
    updateJumpBar()
    renderPromptBar(nil)
    UIAccessibility.post(notification: .layoutChanged, argument: collectionView.cellForItem(at: index))
  }
}
#endif
