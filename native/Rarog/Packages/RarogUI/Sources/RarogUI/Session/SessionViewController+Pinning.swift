#if os(iOS)
import RarogCore
import UIKit

// Przypięcie do dna: zmienia je wyłącznie gest (≤ 40 pt od dna = przypięty); rosnąca
// treść pod spodem go nie rusza. Miejsce czytania między wizytami: odpięty transkrypt
// wraca na zapamiętany wiersz, przypięty na dno; zmiana rozmiaru okna nie zmienia przypięcia
// w żadną stronę. Właściciel: transkrypt.
extension SessionViewController {
  static let pinThreshold: CGFloat = 40
  /// Pusty pas pod ostatnią wiadomością, nad wierszem aktywności (the breath in `FootRest.transcriptInset`).
  static let transcriptBottomInset = CGFloat(FootRest.transcriptBreath)

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    // Przypięcie zmienia wyłącznie gest; treść rosnąca pod spodem go nie rusza.
    if collectionView.isUserScrolling { pinned = distanceFromBottom() <= Self.pinThreshold }
    // Pigułkę „N nowych" gasi tylko linia, którą na ekran wprowadził gest (`+Reading`): ruch w cyklu
    // przeciągnięcia i wytracania, nie samo `isTracking` — palec oparty bez ruchu niczego nie przewija.
    if readingChrome.gesture { readingChrome.movedByGesture = true }
    updateJumpBar()
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    readingChrome.gesture = false
    pinned = distanceFromBottom() <= Self.pinThreshold
    rememberPosition()
  }

  /// Gest przejmuje listę: animowany skok „na dół" albo do linii „NOWE" (jeśli trwał) już nie dojdzie sam.
  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    readingChrome.gesture = true
    readingChrome.jumpAnimating = false
    readingChrome.jumpDeadline?.cancel()
    readingChrome.jumpDeadline = nil
    cancelLineJump()
  }

  /// Koniec animowanego skoku „na dół" albo do linii „NOWE" (`+Reading`, `finishJump`, `finishLineJump`).
  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    finishJump()
    finishLineJump()
  }

  /// Automatyczne zejście na dno nie rusza listy pod palcem ani w trakcie animowanego skoku „na dół".
  var autoScrollBlocked: Bool { collectionView.isUserScrolling || readingChrome.jumpAnimating }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    guard !decelerate else { return }
    readingChrome.gesture = false
    pinned = distanceFromBottom() <= Self.pinThreshold
    rememberPosition()
  }

  func distanceFromBottom() -> CGFloat {
    let inset = collectionView.adjustedContentInset
    return collectionView.contentSize.height + inset.bottom - collectionView.bounds.height - collectionView.contentOffset.y
  }

  func scrollToBottom() {
    let inset = collectionView.adjustedContentInset
    let bottom = max(-inset.top, collectionView.contentSize.height + inset.bottom - collectionView.bounds.height)
    if abs(collectionView.contentOffset.y - bottom) > 0.5 {
      readingChrome.counters.bottomScrolls += 1
      collectionView.setContentOffset(CGPoint(x: collectionView.contentOffset.x, y: bottom), animated: false)
    }
  }

  /// Najwięcej obrotów układu w jednym dojściu do dna.
  static let settleTurns = 5

  /// Przypięty transkrypt staje na dnie W JEDNEJ KLATCE, także przy przełączeniu i po powrocie, a nie
  /// w kilku klatkach. Komórki mają szacowane wysokości, więc dno z nieułożonej
  /// listy jest zgadywane: tu lista układa się od razu, schodzi na dno, układa komórki, które dopiero weszły na
  /// ekran, i tak do stałej wysokości treści — najwyżej `settleTurns` obrotów, bez animacji, z blokadą
  /// ponownego wejścia. Woła ją koniec renderu (po nałożeniu migawki, poza obserwacją magazynu) i układ ekranu.
  /// Wewnątrz cudzej animacji (klawiatura) zostaje jedno zejście na dno, które jedzie z tą animacją — obroty
  /// układu w bloku animacji animowałyby ramki komórek, a dno bez animacji skakałoby obok wjeżdżającej
  /// klawiatury. `contentSize didSet` (środek układu listy) zostaje przy samym `scrollToBottom`.
  func settleAtBottom() {
    guard !readingChrome.settling, !readingChrome.jumpAnimating, collectionView.window != nil,
      collectionView.bounds.height > 0
    else { return }
    guard UIView.inheritedAnimationDuration == 0 else {
      scrollToBottom()
      return
    }
    readingChrome.settling = true
    defer { readingChrome.settling = false }
    readingChrome.counters.settles += 1
    UIView.performWithoutAnimation {
      var last = CGSize(width: -1, height: -1)
      for turn in 1...Self.settleTurns {
        readingChrome.counters.maxSettleTurns = max(readingChrome.counters.maxSettleTurns, turn)
        collectionView.layoutIfNeeded()
        scrollToBottom()
        collectionView.layoutIfNeeded()
        let size = collectionView.contentSize
        if size == last, distanceFromBottom() <= 0.5 { break }
        last = size
      }
    }
  }

  /// `viewDidLayoutSubviews`: przypięty schodzi na dno, odpięty po zmianie wymiarów (obrót,
  /// klawiatura, Cmd+Tab) wraca na wiersz z ostatniego PRAWDZIWEGO gestu — nie liczy przypięcia
  /// z geometrii, która właśnie się zmieniła.
  func holdPositionOnLayout() {
    let size = collectionView.bounds.size
    let resized = readingChrome.layoutSize != .zero && readingChrome.layoutSize != size
    readingChrome.layoutSize = size
    if pinned {
      if !autoScrollBlocked { settleAtBottom() }
    } else if readingChrome.restore != nil {
      restorePosition()
    } else if resized, !collectionView.isUserScrolling, let anchor = TranscriptMemory.positions.recall(sessionId) {
      scroll(to: anchor)
    }
  }

  // MARK: - Miejsce czytania

  /// Zapis po geście i przy wyjściu: przypięty kasuje wpis, odpięty zapisuje pierwszy widoczny wiersz.
  /// Szkielet, lista bez wymiarów i niedokończony powrót niczego nie opisują, więc nie piszą.
  func rememberPosition() {
    guard readingChrome.restore == nil, collectionView.bounds.height > 0,
      store.state.transcriptPhase(for: sessionId) == .content
    else { return }
    TranscriptMemory.positions.remember(sessionId, pinned ? nil : currentAnchor())
  }

  /// Kotwica bieżącego ekranu z ramek widocznych wierszy (`TranscriptAnchor.capture`).
  private func currentAnchor() -> TranscriptAnchor? {
    let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
    let rows = collectionView.indexPathsForVisibleItems.sorted().compactMap { index -> (id: String, minY: Double, maxY: Double)? in
      guard let id = dataSource.itemIdentifier(for: index),
        let frame = collectionView.layoutAttributesForItem(at: index)?.frame
      else { return nil }
      return (id, Double(frame.minY), Double(frame.maxY))
    }
    return TranscriptAnchor.capture(rows, top: Double(top))
  }

  /// Po renderze, w którym ręka przestawiła treść (rozwinięcie serii przesuwa ekran, karta zmienia
  /// wysokość): stara kotwica opisuje ekran sprzed przestawienia, a obrót bez gestu wróciłby na
  /// nią i cofnął czytającego. Zapis od nowa, z ułożonej listy.
  func rememberMovedPosition() {
    collectionView.layoutIfNeeded()
    rememberPosition()
  }

  /// Powrót do odpiętej sesji: na zapamiętany wiersz przy pierwszej treści i niezerowych wymiarach.
  /// Wysłanie (przypięcie) w międzyczasie wygrywa.
  func restorePosition() {
    guard let anchor = readingChrome.restore else { return }
    guard !pinned else {
      readingChrome.restore = nil
      return
    }
    guard collectionView.bounds.height > 0, store.state.transcriptPhase(for: sessionId) == .content else { return }
    readingChrome.restore = nil
    scroll(to: anchor)
    // Miejsce wypadło na dnie (treść się skróciła albo mieści na ekranie): to jest przypięcie,
    // inaczej nowa treść przestałaby schodzić w dół bez żadnego paska, który by to mówił.
    if distanceFromBottom() <= Self.pinThreshold {
      pinned = true
      TranscriptMemory.positions.remember(sessionId, nil)
    }
  }

  /// Wiersz zapamiętany, a gdy go nie ma — pierwszy późniejszy; bez żadnego: dno i przypięcie.
  private func scroll(to anchor: TranscriptAnchor) {
    let ids = dataSource.snapshot().itemIdentifiers
    let exact = ids.contains(anchor.rowId)
    guard let rowId = exact ? anchor.rowId : anchor.fallback(in: ids), let index = dataSource.indexPath(for: rowId) else {
      pinned = true
      scrollToBottom()
      return
    }
    collectionView.layoutIfNeeded()
    collectionView.scrollToItem(at: index, at: .top, animated: false)
    collectionView.layoutIfNeeded()
    guard let frame = collectionView.layoutAttributesForItem(at: index)?.frame else { return }
    let depth = exact ? anchor.offset(inRowOfHeight: Double(frame.height)) : 0
    setClampedOffset(frame.minY + CGFloat(depth) - collectionView.adjustedContentInset.top)
    updateJumpBar()
  }

  func setClampedOffset(_ y: CGFloat) {
    let inset = collectionView.adjustedContentInset
    let maxY = max(-inset.top, collectionView.contentSize.height + inset.bottom - collectionView.bounds.height)
    let target = min(max(y, -inset.top), maxY)
    if abs(collectionView.contentOffset.y - target) > 0.5 {
      collectionView.setContentOffset(CGPoint(x: collectionView.contentOffset.x, y: target), animated: false)
    }
  }
}

/// Lista transkryptu zgłaszająca zmianę wysokości treści (komórki samowymiarujące).
final class PinnedCollectionView: UICollectionView {
  var onContentSizeChange: (() -> Void)?

  override var contentSize: CGSize {
    didSet {
      if oldValue.height != contentSize.height { onContentSizeChange?() }
    }
  }

  var isUserScrolling: Bool { isTracking || isDragging || isDecelerating }
}
#endif
