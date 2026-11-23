#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Miniatury zdjęć i chipy plików w transkrypcie. Miniatury stoją w poziomym pasku, a kafel
// bierze proporcję zdjęcia w granicach 48…256 × 48…96 pt (`ThumbnailGeometry.tileSize`), bez pustych
// pasów. Szkielet i kafel „Zdjęcie" mają 96 pt, więc wczytanie zmienia wysokość wiersza tylko przy
// zdjęciu szerszym niż 8:3 (niższy kafel), raz na zdjęcie w zalogowaniu — potem pamięć miniatur.
// Właściciel: notki i miniatury.

/// Miniatura gotowa do pokazania: obraz i rozmiar kafla (pt).
struct LoadedThumbnail {
  let image: UIImage
  let size: CGSize
}

/// Stan kafla. `gone` = zdjęcia nie da się pokazać (404 po 48 h, sieć) — kafel „Zdjęcie".
enum ThumbnailPhase {
  case loading
  case loaded(LoadedThumbnail)
  case gone
}

/// Zmniejszone miniatury w pamięci procesu (licznik, NSCache oddaje je pod presją pamięci).
/// Wpisy należą do jednego zalogowania magazynu: nowy numer zalogowania czyści wszystko.
@MainActor
final class ThumbnailImageCache {
  static let shared = ThumbnailImageCache()

  private final class Entry {
    let thumbnail: LoadedThumbnail
    init(_ thumbnail: LoadedThumbnail) { self.thumbnail = thumbnail }
  }

  private let cache: NSCache<NSString, Entry> = {
    let cache = NSCache<NSString, Entry>()
    cache.countLimit = 120
    return cache
  }()
  private var login: Int?
  /// Kafle echa, które przejęły obraz od wpisu z nakładką (`EchoThumbnailHandoff`) → do kiedy kafel
  /// powstały w tym czasie zaczyna z nakładką i ją wygasza.
  private var settling: [String: Date] = [:]
  /// Ile trwa okno wygaszania: echo stawia kafel w tym samym renderze, więc wystarczy krótkie.
  static let settleWindow: TimeInterval = 1

  func thumbnail(for key: String, login: Int) -> LoadedThumbnail? {
    sync(login)
    return cache.object(forKey: key as NSString)?.thumbnail
  }

  func store(_ thumbnail: LoadedThumbnail, for key: String, login: Int) {
    sync(login)
    cache.setObject(Entry(thumbnail), forKey: key as NSString)
  }

  /// Obraz kafla wpisu kolejki przechodzi na kafel echa. Bez obrazu (jeszcze się
  /// nie zdekodował albo pamięć go oddała) kafel echa czyta zdjęcie z serwera jak zawsze.
  func handOff(_ pair: EchoThumbnailHandoff.Pair, login: Int, now: Date = Date()) {
    guard let thumbnail = thumbnail(for: pair.from, login: login) else { return }
    store(thumbnail, for: pair.to, login: login)
    if pair.settling { settling[pair.to] = now.addingTimeInterval(Self.settleWindow) }
  }

  /// Czy kafel echa powstający teraz ma wygasić nakładkę po wpisie (przejęcie sprzed chwili).
  func settles(_ key: String, now: Date = Date()) -> Bool {
    settling = settling.filter { $0.value > now }
    return settling[key] != nil
  }

  private func sync(_ current: Int) {
    guard login != current else { return }
    cache.removeAllObjects()
    settling = [:]
    login = current
  }
}

/// Skąd kafel bierze obraz: obrazek z treści dekoduje lokalnie, zdjęcie z serwera bierze przez
/// magazyn (pamięć, `GET …/uploads`, wylogowanie). Podaje go fabryka komórek ekranu sesji.
@MainActor
struct ThumbnailLoader {
  let store: RarogStore
  let sessionId: String

  /// Miniatura już zdekodowana — kafel pokazuje ją od pierwszej klatki, bez mignięcia.
  func cached(_ thumbnail: MediaThumbnail) -> LoadedThumbnail? {
    ThumbnailImageCache.shared.thumbnail(for: thumbnail.cacheKey(sessionId: sessionId), login: store.uploadLogin)
  }

  /// Kafel echa przejął obraz od wpisu kolejki z nakładką — zaczyna z nią i ją wygasza.
  func settles(_ thumbnail: MediaThumbnail) -> Bool {
    ThumbnailImageCache.shared.settles(thumbnail.cacheKey(sessionId: sessionId))
  }

  /// `nil` = wynik nie należy już do tej prezentacji (wylogowanie, zamknięty widok).
  func load(_ thumbnail: MediaThumbnail) async -> ThumbnailPhase? {
    let login = store.uploadLogin
    let data: Data
    switch await bytes(thumbnail) {
    case let .bytes(loaded): data = loaded
    case .unavailable: return .gone
    case .stale: return nil
    }
    guard let decoded = await ThumbnailDecoder.thumbnail(data) else { return .gone }
    guard !Task.isCancelled, login == store.uploadLogin else { return nil }
    let image = decoded.image
    let loaded = LoadedThumbnail(
      image: UIImage(cgImage: image), size: ThumbnailGeometry.tileSize(pixelWidth: image.width, pixelHeight: image.height))
    ThumbnailImageCache.shared.store(loaded, for: thumbnail.cacheKey(sessionId: sessionId), login: login)
    return .loaded(loaded)
  }

  /// Pełne bajty obrazka — do miniatury i do podglądu.
  func bytes(_ thumbnail: MediaThumbnail) async -> ThumbnailBytes {
    switch thumbnail.source {
    case let .inline(dataUrl):
      return ThumbnailDecoder.bytes(ofDataURL: dataUrl).map(ThumbnailBytes.bytes) ?? .unavailable
    case let .upload(file):
      switch await store.uploadImage(sessionId: sessionId, file: file) {
      case let .loaded(data): return .bytes(data)
      case .missing, .failed: return .unavailable
      case .dropped: return .stale
      }
    }
  }
}

/// Bajty obrazka dla kafla i podglądu.
enum ThumbnailBytes {
  case bytes(Data)
  /// Nie ma czego pokazać (404, sieć, zły data URL) — kafel „Zdjęcie".
  case unavailable
  /// Wynik nie należy już do tej prezentacji (wylogowanie, anulowany widok) — nic nie zmieniać.
  case stale
}

/// Wiersz zdjęć wiadomości: pasek miniatur (wysokość najwyższego kafla), pod nim chipy plików.
struct MediaRowView: View {
  let model: MediaRowModel
  let loader: ThumbnailLoader
  let open: @MainActor (MediaThumbnail) -> Void

  var body: some View {
    RowFrame(voice: model.voice, gap: model.turn.gap) {
      VStack(alignment: .leading, spacing: 8) {
        if !model.thumbnails.isEmpty {
          ScrollView(.horizontal) {
            HStack(spacing: 8) {
              ForEach(model.thumbnails.indices, id: \.self) { index in
                let thumbnail = model.thumbnails[index]
                ThumbnailTile(
                  thumbnail: thumbnail, identifier: "thumbnail.\(model.id).\(index)", loader: loader, open: open)
                  // Inna treść pod tym samym miejscem (restart serwera, ponowne użycie komórki)
                  // = nowy kafel ze świeżym stanem, nie stary obraz do czasu wczytania.
                  .id(thumbnail.key)
                  .accessibilityAddTraits(promptHead(index, chip: false) ? .isHeader : [])
              }
            }
          }
          .scrollIndicators(.hidden)
          .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
          // Pasek tak wysoki jak najwyższy kafel: sam szeroki zrzut nie zostawia pod sobą pustego pasa.
          .fixedSize(horizontal: false, vertical: true)
        }
        if !model.chips.isEmpty {
          ChipFlowLayout(spacing: 6) {
            ForEach(model.chips.indices, id: \.self) { index in
              MediaChipView(chip: model.chips[index])
                .accessibilityIdentifier("chip.\(model.id).\(index)")
                .accessibilityAddTraits(promptHead(index, chip: true) ? .isHeader : [])
            }
          }
        }
        if let clock = model.turn.clock { PromptClockView(clock: clock) }
      }
    }
  }

  /// Prompt z samym zdjęciem: cechę nagłówka dostaje jego pierwszy element (kafel, a bez kafli — chip).
  private func promptHead(_ index: Int, chip: Bool) -> Bool {
    guard model.turn.promptHead, index == 0 else { return false }
    return chip == model.thumbnails.isEmpty
  }
}

/// Kafel jednej miniatury: szkielet przy wczytywaniu, obraz (przycisk podglądu) albo „Zdjęcie".
private struct ThumbnailTile: View {
  let thumbnail: MediaThumbnail
  let identifier: String
  let loader: ThumbnailLoader
  let open: @MainActor (MediaThumbnail) -> Void
  @State private var phase: ThumbnailPhase
  /// Nakładka wpisu kolejki, która gaśnie po przejęciu obrazu przez echo (`EchoThumbnailHandoff`).
  @State private var settling: Bool

  init(thumbnail: MediaThumbnail, identifier: String, loader: ThumbnailLoader, open: @escaping @MainActor (MediaThumbnail) -> Void) {
    self.thumbnail = thumbnail
    self.identifier = identifier
    self.loader = loader
    self.open = open
    let cached = loader.cached(thumbnail)
    _phase = State(initialValue: cached.map(ThumbnailPhase.loaded) ?? .loading)
    _settling = State(initialValue: cached != nil && loader.settles(thumbnail))
  }

  private static let shape: RoundedRectangle = .block

  var body: some View {
    content
      .overlay {
        // Pełny pierścień na przyciemnieniu, gaśnie razem z nim: wysłane.
        if settling, case .loaded = phase {
          PendingOverlay(indicator: .none).transition(.opacity)
        }
      }
      .onAppear {
        guard settling else { return }
        withAnimation(PendingOverlay.fade) { settling = false }
      }
      .task {
        guard case .loading = phase else { return }
        guard let next = await loader.load(thumbnail), !Task.isCancelled else { return }
        phase = next
      }
  }

  @ViewBuilder private var content: some View {
    switch phase {
    case .loading:
      Self.shape
        .fill(Color(uiColor: Palette.surface2))
        .frame(width: ThumbnailGeometry.tileHeight, height: ThumbnailGeometry.tileHeight)
        .accessibilityElement()
        .accessibilityLabel(thumbnail.label)
        .accessibilityValue(UICopy.thumbnailLoading)
        .accessibilityIdentifier(identifier)
    case let .loaded(loaded):
      Button { open(thumbnail) } label: {
        // Wypełnienie, nie wpasowanie: kafel ma proporcję zdjęcia, a poza granicami kafla obraz jest
        // przycięty — pasów tła karty nad i pod szerokim zrzutem już nie ma. Pod wskaźnikiem obwódka w kolorze
        // tekstu, jak `.thumb:hover` w PWA.
        RarogHoverReader { hovered in
          Image(uiImage: loaded.image)
            .resizable()
            .scaledToFill()
            .frame(width: loaded.size.width, height: loaded.size.height)
            .clipShape(Self.shape)
            .overlay(Self.shape.strokeBorder(Color(uiColor: hovered ? Palette.text : Palette.border)))
            .contentShape(Self.shape)
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel(thumbnail.label)
      .accessibilityHint(UICopy.thumbnailHint)
      .accessibilityIdentifier(identifier)
    case .gone:
      VStack(spacing: 4) {
        Image(systemName: "photo")
          .imageScale(.large)
          .foregroundStyle(Color(uiColor: Palette.muted2))
        Text(verbatim: UICopy.imagePlaceholder)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.text))
        if thumbnail.bytes > 0 {
          Text(verbatim: UICopy.bytes(thumbnail.bytes))
            .appFont(.caption)
            .foregroundStyle(Color(uiColor: Palette.muted))
        }
      }
      .lineLimit(1)
      .frame(width: ThumbnailGeometry.tileHeight, height: ThumbnailGeometry.tileHeight)
      .background(Self.shape.fill(Color(uiColor: Palette.surface)))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(UICopy.photoGone(bytes: thumbnail.bytes))
      .accessibilityIdentifier(identifier)
    }
  }
}

/// A file chip (or a photo without a preview): the icon, the name cut in the middle, the size. A file of an outbox
/// entry puts up the same chip (`PendingMediaRowView`): the ring in flight (with the stop when `stop` is wired), the
/// warning on a failure, in place of the icon, as an overlay, so the chip keeps its size in every state and after the
/// echo.
struct MediaChipView: View {
  let chip: MediaChip
  var indicator: PendingIndicator = .none
  var stop: (() -> Void)? = nil
  /// Pierścień w miejscu ikony: wysokość znaku pisma `footnote`, rośnie z Dynamic Type.
  @AppScaledMetric(relativeTo: .footnote) private var markSide: CGFloat = 16

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: chip.image ? "photo" : "doc")
        .foregroundStyle(Color(uiColor: Palette.muted2))
        .opacity(indicator.dims ? 0 : 1)
        .overlay {
          PendingMark(indicator: indicator, diameter: markSide, lineWidth: 2, warningFont: .footnote, stop: stop)
        }
      Text(verbatim: chip.name)
        .foregroundStyle(Color(uiColor: Palette.text))
        .lineLimit(1)
        .truncationMode(.middle)
      if let size = chip.size {
        Text(verbatim: size)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .lineLimit(1)
          .layoutPriority(1)
      }
    }
    .appFont(.footnote)
    .padding(.horizontal, 10)
    .frame(minHeight: 32)
    .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface)))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(UICopy.attachmentChipSpoken(name: chip.name, size: chip.size))
  }
}

/// Chipy w rzędach: kolejny chip schodzi do nowego rzędu, gdy się nie mieści (PWA `.chips`).
struct ChipFlowLayout: Layout {
  let spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
    let width = rows.map { row in row.last.map { $0.x + $0.size.width } ?? 0 }.max() ?? 0
    let height = rows.last.map { row in (row.first?.y ?? 0) + (row.map(\.size.height).max() ?? 0) } ?? 0
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for (index, item) in arrange(width: bounds.width, subviews: subviews).joined().enumerated() {
      subviews[index].place(
        at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + item.y), proposal: ProposedViewSize(item.size))
    }
  }

  private struct Item {
    let x: CGFloat
    let y: CGFloat
    let size: CGSize
  }

  /// Rzędy pozycji (kolejność podwidoków zachowana). Chip szerszy niż wiersz dostaje całą szerokość.
  private func arrange(width: CGFloat, subviews: Subviews) -> [[Item]] {
    var rows: [[Item]] = [[]]
    var x: CGFloat = 0
    var y: CGFloat = 0
    var rowHeight: CGFloat = 0
    for subview in subviews {
      var size = subview.sizeThatFits(.unspecified)
      if size.width > width { size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
      if x > 0, x + size.width > width {
        y += rowHeight + spacing
        x = 0
        rowHeight = 0
        rows.append([])
      }
      rows[rows.count - 1].append(Item(x: x, y: y, size: size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    return rows
  }
}
#endif
