#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// Załączniki wpisu kolejki: miniatury zdjęć z pliku treści na urządzeniu w tym samym
// kaflu co echo (`MediaRowView`) i chipy plików jak w echu, z pierścieniem postępu jak w iOS. Pod spodem
// zostaje podpis etapu (`PendingStatusView`) — czytnik dostaje postęp tekstem. Model i reguły nakładki:
// `Model/PendingMedia`. Właściciel: wysyłka — wyjątek w `Rows/`, bo to stan kolejki.

/// Skąd kafel wpisu bierze obraz: plik treści wpisu w kolejce na dysku (ImageIO poza głównym aktorem) do tej
/// samej pamięci miniatur, z której kafel echa przejmie go po potwierdzeniu (`EchoThumbnailHandoff`).
@MainActor
struct PendingThumbnailLoader {
  let store: RarogStore
  let sessionId: String
  let entry: UUID

  /// Miniatura już zdekodowana — kafel pokazuje ją od pierwszej klatki (render po każdym procencie postępu).
  func cached(_ tile: PendingTile) -> LoadedThumbnail? {
    ThumbnailImageCache.shared.thumbnail(for: tile.cacheKey(sessionId: sessionId), login: store.uploadLogin)
  }

  /// `nil` = wynik nie należy już do tej prezentacji (wylogowanie, zamknięty widok).
  func load(_ tile: PendingTile) async -> ThumbnailPhase? {
    guard let file = tile.file, let url = store.outboxPayloadURL(entry: entry, file: file) else { return .gone }
    let login = store.uploadLogin
    let decoded = await ThumbnailDecoder.thumbnail(contentsOf: url)
    guard !Task.isCancelled, login == store.uploadLogin else { return nil }
    guard let image = decoded?.image else { return .gone }
    let size = ThumbnailGeometry.tileSize(pixelWidth: image.width, pixelHeight: image.height)
    let loaded = LoadedThumbnail(image: UIImage(cgImage: image), size: size)
    ThumbnailImageCache.shared.store(loaded, for: tile.cacheKey(sessionId: sessionId), login: login)
    return .loaded(loaded)
  }
}

/// Wiersz wpisu w układzie wiersza zdjęć echa (`MediaRowView`): pasek miniatur zdjęć (wysokość najwyższego
/// kafla), pod nim chipy plików — ten sam chip co w echu, z pierścieniem w miejscu ikony (plik nie
/// przeskakuje z kafla w chip przy potwierdzeniu).
struct PendingMediaRowView: View {
  let model: PendingMediaModel
  let loader: PendingThumbnailLoader
  /// The stop in the center of the ring; `nil` = no stop on this row.
  var stop: (() -> Void)? = nil

  var body: some View {
    RowFrame(voice: model.voice, gap: model.turn.gap) {
      VStack(alignment: .leading, spacing: 8) {
        if !model.photos.isEmpty {
          ScrollView(.horizontal) {
            HStack(spacing: 8) {
              ForEach(model.photos, id: \.tile.key) { photo in
                PendingTileView(
                  tile: photo.tile, indicator: model.indicator, awaitingEcho: model.awaitingEcho,
                  identifier: identifier(photo.index), loader: loader, stop: stop)
                  .accessibilityAddTraits(model.turn.promptHead && photo.index == 0 ? .isHeader : [])
              }
            }
          }
          .scrollIndicators(.hidden)
          .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
          .fixedSize(horizontal: false, vertical: true)
        }
        if !model.files.isEmpty {
          ChipFlowLayout(spacing: 6) {
            ForEach(model.files, id: \.tile.key) { file in
              MediaChipView(chip: file.tile.chip, indicator: model.indicator, stop: stop)
                .modifier(EchoWaitShimmer(active: model.awaitingEcho))
                .animation(PendingOverlay.fade, value: model.indicator.dims)
                .accessibilityValue(UICopy.pendingTile(model.indicator, awaitingEcho: model.awaitingEcho) ?? "")
                .pendingStopAction(model.indicator, stop)
                .accessibilityIdentifier(identifier(file.index))
                .accessibilityAddTraits(model.turn.promptHead && file.index == 0 ? .isHeader : [])
            }
          }
        }
        if let clock = model.turn.clock { PromptClockView(clock: clock) }
      }
    }
  }

  /// Identyfikator po pozycji załącznika we wpisie (kolejność wysyłki: zdjęcia, potem pliki).
  private func identifier(_ index: Int) -> String {
    "pending.tile.\(model.entry.uuidString).\(index)"
  }
}

/// The photo tile of an entry: the photo (as the echo tile) with dimming and the ring; before decoding the echo
/// skeleton with the ring, without a file the echo "Photo" tile with the ring in place of the icon. The only touch
/// target is the stop in the center of the ring while the send is in flight; the preview opens from the echo.
private struct PendingTileView: View {
  let tile: PendingTile
  let indicator: PendingIndicator
  let awaitingEcho: Bool
  let identifier: String
  let loader: PendingThumbnailLoader
  let stop: (() -> Void)?
  @State private var phase: ThumbnailPhase
  /// Pierścień w miejscu ikony kafla „Zdjęcie": wysokość ikony w skali `.large`, rośnie z Dynamic Type.
  @AppScaledMetric(relativeTo: .body) private var iconMark: CGFloat = 26

  init(
    tile: PendingTile, indicator: PendingIndicator, awaitingEcho: Bool, identifier: String, loader: PendingThumbnailLoader,
    stop: (() -> Void)?
  ) {
    self.tile = tile
    self.indicator = indicator
    self.awaitingEcho = awaitingEcho
    self.identifier = identifier
    self.loader = loader
    self.stop = stop
    _phase = State(initialValue: loader.cached(tile).map(ThumbnailPhase.loaded) ?? .loading)
  }

  private static let shape: RoundedRectangle = .block
  private static let side = ThumbnailGeometry.tileHeight

  var body: some View {
    content
      .modifier(EchoWaitShimmer(active: awaitingEcho))
      .animation(PendingOverlay.fade, value: indicator.dims)
      .task {
        guard case .loading = phase else { return }
        guard let next = await loader.load(tile), !Task.isCancelled else { return }
        phase = next
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(tile.label)
      .accessibilityValue(UICopy.pendingTile(indicator, awaitingEcho: awaitingEcho) ?? "")
      .pendingStopAction(indicator, stop)
      .accessibilityIdentifier(identifier)
  }

  @ViewBuilder private var content: some View {
    switch phase {
    case let .loaded(loaded):
      // Kafel echa bez wskaźnika (`ThumbnailTile`): ta sama proporcja, przycięcie i obwódka — po echu
      // zmienia się tylko nakładka.
      Image(uiImage: loaded.image)
        .resizable()
        .scaledToFill()
        .frame(width: loaded.size.width, height: loaded.size.height)
        .clipShape(Self.shape)
        .overlay(Self.shape.strokeBorder(Color(uiColor: Palette.border)))
        .overlay {
          if indicator.dims {
            PendingOverlay(indicator: indicator, stop: stop).transition(.opacity)
          }
        }
    case .loading:
      // The echo skeleton (96 pt) with the ring, before the file is decoded.
      Self.shape
        .fill(Color(uiColor: Palette.surface2))
        .frame(width: Self.side, height: Self.side)
        .overlay { PendingMark(indicator: indicator, diameter: PendingRing.aroundIcon, stop: stop) }
    case .gone:
      // Kafel „Zdjęcie" echa (`ThumbnailTile`) w tym samym układzie; pierścień i ostrzeżenie stoją w miejscu
      // ikony, nakładką, jak w chipie pliku — nie przesuwają podpisu i nie wchodzą na niego.
      VStack(spacing: 4) {
        Image(systemName: "photo")
          .imageScale(.large)
          .foregroundStyle(Color(uiColor: Palette.muted2))
          .opacity(indicator.dims ? 0 : 1)
          .overlay { PendingMark(indicator: indicator, diameter: iconMark, warningFont: .title3, stop: stop) }
        Text(verbatim: UICopy.imagePlaceholder)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.text))
        if tile.bytes > 0 {
          Text(verbatim: UICopy.bytes(tile.bytes))
            .appFont(.caption)
            .foregroundStyle(Color(uiColor: Palette.muted))
        }
      }
      .lineLimit(1)
      .frame(width: Self.side, height: Self.side)
      .background(Self.shape.fill(Color(uiColor: Palette.surface)))
    }
  }
}

/// The mark in place of the icon (a tile without an image, a file chip): the ring in the text color in flight, with
/// the stop in its center when one is wired, the warning on a failure, nothing after confirmation. It stands as an
/// overlay: the layout of the tile and the chip is the same as in the echo in every state.
struct PendingMark: View {
  let indicator: PendingIndicator
  let diameter: CGFloat
  var lineWidth: CGFloat = PendingRing.lineWidth
  var warningFont: AppFont = .title2
  var stop: (() -> Void)? = nil

  var body: some View {
    ZStack {
      if indicator.warns {
        PendingWarning(indicator: indicator, font: warningFont)
      } else if indicator.dims {
        PendingRing(
          indicator: indicator, tint: Color(uiColor: Palette.text), diameter: diameter, lineWidth: lineWidth,
          showsStop: stop != nil)
          .transition(.opacity)
      }
    }
    .fixedSize()
    .pendingStop(indicator, stop)
    .accessibilityHidden(true)
  }
}

/// The dimming of a photo in flight with the ring or the warning in the center. White on black in both themes: the
/// overlay belongs to the image, not to the theme (as in iOS Photos and Messages). The echo tile that took the image
/// over from an entry with the overlay puts it up too, and fades it out (`ThumbnailTile`).
struct PendingOverlay: View {
  let indicator: PendingIndicator
  /// The stop in the center of the ring; `nil` = none (the echo tile).
  var stop: (() -> Void)? = nil

  /// The fade of the dimming and the ring after confirmation.
  static let fade: Animation = .easeOut(duration: 0.3)
  /// A "gentle" dimming: the image stays readable, the white ring stands out against a bright photo.
  static let scrim = 0.4

  var body: some View {
    ZStack {
      Color.black.opacity(Self.scrim)
      if indicator.warns {
        PendingWarning(indicator: indicator, font: .title2)
      } else {
        PendingRing(indicator: indicator, tint: .white, showsStop: stop != nil)
          .shadow(color: .black.opacity(0.35), radius: 2)
      }
    }
    .clipShape(RoundedRectangle.block)
    // The dimming is dark in both themes, so the warning takes the colors of the dark theme: the light amber and
    // red stand out against it, the brown of the light theme got lost.
    .environment(\.colorScheme, .dark)
    // The dimming does not take touches; the stop target over the ring does, and only where it stands. The target
    // goes on after `allowsHitTesting(false)`, which would switch it off too.
    .allowsHitTesting(false)
    .pendingStop(indicator, stop)
    .accessibilityHidden(true)
  }
}

/// The warning instead of the ring: "Not confirmed" and a stop before the request in the attention color, a refusal
/// in the error color (red only for an error). "Retry" and the sentence stand in the status row under the
/// thumbnails.
private struct PendingWarning: View {
  let indicator: PendingIndicator
  let font: AppFont

  var body: some View {
    Image(systemName: "exclamationmark.triangle.fill")
      .symbolRenderingMode(.palette)
      .foregroundStyle(
        Color(uiColor: Palette.onState), Color(uiColor: indicator == .refused ? Palette.err : Palette.wait))
      .appFont(font)
  }
}

/// Cienki pierścień postępu jak w iOS: tor i łuk. Nieokreślony = łuk, który się kręci; przy ograniczeniu
/// ruchu stoi w miejscu (stały wycinek). Pełny po wysłaniu ostatniego bajtu, po chwili znowu nieokreślony.
struct PendingRing: View {
  let indicator: PendingIndicator
  let tint: Color
  var diameter: CGFloat = 30
  var lineWidth: CGFloat = PendingRing.lineWidth
  /// The stop square in the center (as the App Store download) while the send is in flight; the touch target is
  /// `PendingStopTarget` over it.
  var showsStop = false

  /// The side of the stop square as a fraction of the diameter.
  static let stopRatio: CGFloat = 0.32
  /// Pierścień na szkielecie kafla, zanim zdjęcie się zdekoduje.
  static let aroundIcon: CGFloat = 40
  /// Grubość pierścienia na zdjęciu i kaflu; chip pliku ma cieńszy, w skali swojej ikony.
  static let lineWidth: CGFloat = 3
  /// Ile pełny pierścień stoi po ostatnim bajcie, zanim zacznie się kręcić (czekamy na serwer).
  static let fullHold: Duration = .milliseconds(800)
  /// Długość łuku nieokreślonego (ułamek obwodu) i czas obrotu.
  static let spinnerArc = 0.28
  static let spinPeriod: TimeInterval = 1

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var heldFull = false

  var body: some View {
    ZStack {
      Circle().stroke(tint.opacity(0.3), lineWidth: lineWidth)
      if spins {
        TimelineView(.animation(paused: reduceMotion)) { context in
          arc(Self.spinnerArc)
            .rotationEffect(.degrees(reduceMotion ? 0 : Self.angle(at: context.date)))
        }
      } else {
        arc(fill).animation(reduceMotion ? nil : .linear(duration: 0.25), value: fill)
      }
      if showsStop && indicator.stoppable {
        let side = diameter * Self.stopRatio
        RoundedRectangle(cornerRadius: side * 0.2).fill(tint).frame(width: side, height: side)
      }
    }
    .frame(width: diameter, height: diameter)
    .task(id: indicator) {
      heldFull = false
      guard indicator == .awaitingResponse else { return }
      try? await Task.sleep(for: Self.fullHold)
      guard !Task.isCancelled else { return }
      heldFull = true
    }
  }

  /// The arc spins: the indeterminate stage, and after the last byte went out once the full ring has stood. With
  /// reduced motion the full ring stays full (a fixed slice after it would look like going back).
  private var spins: Bool {
    switch indicator {
    case .indeterminate: true
    case .awaitingResponse: heldFull && !reduceMotion
    case .progress, .unconfirmed, .refused, .stopped, .none: false
    }
  }

  private var fill: Double {
    switch indicator {
    case let .progress(fraction): fraction
    case .awaitingResponse, .none: 1
    case .indeterminate, .unconfirmed, .refused, .stopped: 0
    }
  }

  private func arc(_ length: Double) -> some View {
    Circle()
      .trim(from: 0, to: length)
      .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
      .rotationEffect(.degrees(-90))
  }

  /// Kąt łuku nieokreślonego w chwili `date` — z zegara, nie z animacji: komórka ponownie użyta albo
  /// przekonfigurowana po procencie postępu nie gubi ani nie podwaja obrotu.
  static func angle(at date: Date) -> Double {
    date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: spinPeriod) / spinPeriod * 360
  }
}
#endif
