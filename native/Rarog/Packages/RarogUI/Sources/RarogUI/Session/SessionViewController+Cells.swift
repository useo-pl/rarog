#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Fabryka komórek transkryptu. Rodzaj wiersza wybiera komórkę (tekst w UIKit albo SwiftUI
// w `UIHostingConfiguration`), a treść daje funkcja obszaru, do którego wiersz należy:
// wiadomości tutaj, karty narzędzi, serie i znaczniki w `+Reading`, wpisy kolejki w `+Send`,
// karty i ślady w `+Decisions`, notki harnessu i zdjęcia w `Rows/NoticeRowView`
// i `Rows/AttachmentThumbnails+Session`. Pod stojącą decyzją każda komórka poza kartami
// przygasa (`dimAlpha`). Właściciel: transkrypt.
extension SessionViewController {
  func makeDataSource(_ collectionView: UICollectionView) -> UICollectionViewDiffableDataSource<Int, String> {
    let textCell = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
      guard let self, let row = self.rows[id] else { return }
      cell.backgroundConfiguration = .clear()
      var base = self.textConfiguration(row)
      // Pod stojącą decyzją kolory składni wracają do atramentu linii (przygaszony tekst ≥ 7:1).
      base.plainSyntax = self.ui.reading.decisionShown
      cell.contentConfiguration = DimmedContentConfiguration(base: base, alpha: self.dimAlpha(row))
    }
    let hostedCell = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
      guard let self, let row = self.rows[id] else { return }
      cell.backgroundConfiguration = .clear()
      // Widok liczony tu, nie w domknięciu konfiguracji: komórka nie trzyma kontrolera (cykl).
      let content = self.hostedView(row)
      let alpha = self.dimAlpha(row)
      let spacing = self.transcriptSpacing
      let hosting = UIHostingConfiguration {
        content.opacity(alpha).textScaleHost().environment(\.transcriptSpacing, spacing)
      }
      .margins(.horizontal, TranscriptSpacing.cellSide)
      .margins(.vertical, 0)
      // Wysokość wiersza = treść, bez systemowej minimalnej wysokości wiersza listy (w symulatorze iOS 27: 52 pt).
      // Niższy wiersz stał w niej wyśrodkowany: między wierszami jednej karty narzędzi zostawała szczelina tła,
      // a znacznik godziny, „NOWE” czy notka stały dalej od sąsiadów, niż mówią odstępy tury.
      // Cel dotyku ≥ 44 pt pilnuje każdy wiersz sam, nie minimum listy.
      cell.contentConfiguration = hosting.minSize(height: 0)
      // Widoczny fokus klawiatury na kartach decyzji (karty, `+KeysCards`).
      self.decorateCardCell(cell, row: row)
    }
    return UICollectionViewDiffableDataSource(collectionView: collectionView) { [weak self] view, index, id in
      if self?.rows[id]?.isTextual == true {
        return view.dequeueConfiguredReusableCell(using: textCell, for: index, item: id)
      }
      return view.dequeueConfiguredReusableCell(using: hostedCell, for: index, item: id)
    }
  }

  /// Wiersze z tekstem do zaznaczania (`UITextView` na TextKit 2).
  func textConfiguration(_ row: TranscriptRow) -> MessageContentConfiguration {
    switch row {
    case let .text(id, role, voice, source, turn):
      messageConfiguration(id: id, role: role, voice: voice, source: source, turn: turn)
    case let .open(voice, source, turn):
      openMessageConfiguration(voice: voice, source: source, turn: turn)
    case let .pending(entry, voice, text, inFlight, queued, replays, takingBack, turn):
      pendingConfiguration(
        entry: entry, voice: voice, text: text, inFlight: inFlight, queued: queued, replaysTakeBack: replays,
        takingBack: takingBack, turn: turn)
    default:
      MessageContentConfiguration(
        voice: nil, text: NSAttributedString(), plate: false, dimmed: false, accessibilityIdentifier: "", accessibilityPrefix: nil)
    }
  }

  /// Wiersze SwiftUI: linie narzędzi, ślady, statusy kolejki, karty.
  @ViewBuilder func hostedView(_ row: TranscriptRow) -> some View {
    switch row {
    case .loading:
      TranscriptSkeletonView()
    case let .empty(text, sub):
      EmptyTranscriptView(text: text, sub: sub)
    case let .tool(model):
      toolCardView(model)
    case let .toolRun(model):
      toolRunView(model)
    case let .timeGap(_, mark, turn):
      TimeGapView(mark: mark, gap: turn.gap)
    case let .newMarker(turn):
      NewMarkerView(gap: turn.gap)
    case let .attachments(model):
      pendingMediaView(model)
    case let .unsupported(_, voice, turn):
      QuietLineView(
        voice: voice, text: UICopy.unsupportedBlock, gap: turn.gap, header: turn.promptHead, clock: turn.clock)
    case let .pendingStatus(entry, status, retrying):
      pendingStatusView(entry: entry, status: status, retrying: retrying)
    case let .permission(card):
      permissionCardView(card)
    case let .question(card):
      questionCardView(card)
    case let .notice(_, text):
      noticeView(text)
    case let .herdrDialog(card):
      herdrDialogView(card)
    case .decisionPending:
      DecisionPendingView()
    case let .harnessNotice(model):
      NoticeRowView(model: model)
    case let .media(model):
      mediaRowView(model)
    case let .promptBlocked(model):
      promptBlockedView(model)
    case let .decisionTrace(model):
      DecisionTraceRowView(model: model)
    case .text, .open, .pending:
      EmptyView()
    }
  }

  private func messageConfiguration(
    id: String, role: MessageRole, voice: VoiceLabel?, source: String, turn: TurnMark
  ) -> MessageContentConfiguration {
    // Odpowiedź agenta: proza o ton ciemniejsza, pogrubienie i nagłówki jaśniejsze; dymek człowieka: `text`.
    let color = switch role {
    case .system: Palette.muted
    case .assistant: Palette.prose
    case .user: Palette.text
    }
    let base = role == .system ? MarkdownRenderer.noticeStyle : MarkdownRenderer.transcriptStyle
    // Pytanie „Do Ciebie:” tylko w odpowiedzi agenta — ten sam styl co wiadomość płynąca. The prompt bubble has its
    // own cap, so the width mode reaches only text outside it; the echo keeps the render of its in-flight entry.
    var style = MarkdownRenderer.Style(
      textColor: color, strongColor: role == .assistant ? Palette.strong : nil, base: base, traits: traitCollection,
      questions: role == .assistant)
    style.fullWidth = role != .user && transcriptWidth.full
    style.spacing = transcriptSpacing
    let text = markdown.text(source, style: style)
    var config = MessageContentConfiguration(
      voice: voice.map(UICopy.roleLabel), text: text,
      plate: role == .user, dimmed: false, accessibilityIdentifier: "message.\(id)",
      accessibilityPrefix: UICopy.rolePrefix(role), gap: turn.gap)
    config.spacing = transcriptSpacing
    placePromptClock(&config, turn: turn)
    placePromptFold(&config, rowId: id, turn: turn)
    return config
  }

  /// Długi prompt zwinięty do 6 linii: zwinięcie z modelu wiersza, przycisk przestawia je kluczem wiersza.
  func placePromptFold(_ config: inout MessageContentConfiguration, rowId: String, turn: TurnMark) {
    config.fold = turn.fold
    guard turn.fold != nil else { return }
    config.toggleFold = { [weak self] in self?.togglePromptFold(rowId) }
  }

  /// Cecha nagłówka i godzina promptu: obok dymku, gdy mieści się po prawej przy bieżącej szerokości listy,
  /// inaczej pod nim. Zmiana szerokości listy przekonfigurowuje wiersze z godziną (`refreshPromptClocks`). Znacznika
  /// szerokości (`clockWidth`) konfiguracja nie rusza: komórka skonfigurowana przy nowej szerokości przed
  /// `refreshPromptClocks` odebrałaby przeliczenie pozostałym.
  func placePromptClock(_ config: inout MessageContentConfiguration, turn: TurnMark) {
    config.header = turn.promptHead
    config.clock = turn.clock
    // An agent reply's time always stands under its last line (`MessageContentConfiguration.clockUnder`).
    guard let clock = turn.clock, config.plate else { return }
    let rowWidth = collectionView.bounds.width - 2 * transcriptSide()
    config.clockBelow = !MessageContentView.clockFitsBeside(
      text: config.text, clock: clock, rowWidth: rowWidth, traits: traitCollection, spacing: transcriptSpacing,
      fold: turn.fold)
  }

  /// Szerokość listy się zmieniła (obrót, okno, lista sesji): godzina przy dymku mogła przejść obok ↔ pod.
  func refreshPromptClocks() {
    let width = collectionView.bounds.width
    guard width > 0, width != readingChrome.clockWidth else { return }
    readingChrome.clockWidth = width
    var snapshot = dataSource.snapshot()
    let clocked = snapshot.itemIdentifiers.filter { rows[$0]?.isTextual == true && rows[$0]?.turn.clock != nil }
    guard !clocked.isEmpty else { return }
    snapshot.reconfigureItems(clocked)
    dataSource.apply(snapshot, animatingDifferences: false)
  }

  private func openMessageConfiguration(voice: VoiceLabel?, source: String, turn: TurnMark) -> MessageContentConfiguration {
    let style = MarkdownRenderer.Style(
      textColor: Palette.prose, strongColor: Palette.strong, base: MarkdownRenderer.transcriptStyle, traits: traitCollection,
      questions: true, fullWidth: transcriptWidth.full, spacing: transcriptSpacing)
    var config = MessageContentConfiguration(
      voice: voice.map(UICopy.roleLabel), text: markdown.live(source, style: style),
      plate: false, dimmed: false, accessibilityIdentifier: "message.open", accessibilityPrefix: UICopy.rolePrefix(.assistant),
      gap: turn.gap)
    config.spacing = transcriptSpacing
    return config
  }
}
#endif
