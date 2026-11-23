import Foundation
import RarogContract
import RarogCore

// Załączniki wpisu kolejki: miniatury z pliku treści na urządzeniu w układzie przyszłego
// echa i pierścień postępu wysyłki na nich zamiast paska. Bez UIKit — testowane na macOS
// (`RarogUILogicTests`). Widok: `Session/Rows/PendingMediaRowView`. Właściciel: wysyłka.

/// What stands on a thumbnail of an outbox entry: the progress ring, the warning icon or nothing.
public enum PendingIndicator: Sendable, Equatable {
  /// Composing the body, or an upload of unknown size: the indeterminate ring (it spins).
  case indeterminate
  /// Upload: the fraction of bytes sent, 0…1.
  case progress(Double)
  /// The whole body went out: the ring full, after a moment indeterminate until the server answers.
  case awaitingResponse
  /// "Not confirmed": the warning icon instead of the ring.
  case unconfirmed
  /// A refusal (the gate or the server): the warning icon instead of the ring.
  case refused
  /// Stopped in the ring before the request: nothing went out; the warning icon in the attention color, not red.
  case stopped
  /// The server took it (202), the entry waits for the echo: no dimming and no ring.
  case none

  /// The entry state and the send stage → the thumbnail overlay. The stage lives only in `queued` (the reducer
  /// drops it).
  public static func make(state: OutboxEntry.State, progress: SendProgress?) -> PendingIndicator {
    switch state {
    case .sent: return .none
    case .unconfirmed: return .unconfirmed
    case .refused(OutboxEntry.RefusalCode.cancelled?, _): return .stopped
    case .refused: return .refused
    case .queued: break
    }
    switch progress {
    case nil, .encoding?: return .indeterminate
    case let .uploading(sent, total)? where total > 0:
      return .progress(min(1, max(0, Double(sent) / Double(total))))
    case .uploading?: return .indeterminate
    case .awaitingResponse?: return .awaitingResponse
    }
  }

  /// The warning icon instead of the ring.
  public var warns: Bool { self == .unconfirmed || self == .refused || self == .stopped }
  /// The stop in the center of the ring: only while the send is in flight, not after 202.
  public var stoppable: Bool {
    switch self {
    case .indeterminate, .progress, .awaitingResponse: true
    case .unconfirmed, .refused, .stopped, .none: false
    }
  }
  /// Dimming of the thumbnail: everything but taken by the server.
  public var dims: Bool { self != .none }
}

/// Jedna miniatura wpisu kolejki: zdjęcie z pliku treści albo kafel pliku z ikoną dokumentu.
public struct PendingTile: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    case photo
    case file
  }

  /// Tożsamość kafla w wierszu i klucz pamięci miniatur: `o:<wpis>.<indeks>`.
  public let key: String
  public let kind: Kind
  /// „Zdjęcie 1" (jak kafel echa) albo nazwa pliku.
  public let label: String
  /// Nazwa pliku treści w katalogu wpisu (`OutboxEntry.Attachment.file`); `nil` = jeszcze nie zapisany.
  public let file: String?
  /// Waga treści (0 = nieznana).
  public let bytes: Int

  /// Klucz pamięci miniatur — ten sam kształt co ``MediaThumbnail/cacheKey(sessionId:)``.
  public func cacheKey(sessionId: String) -> String {
    MediaThumbnail.cacheKey(sessionId: sessionId, key: key)
  }

  /// Chip pliku w kształcie chipu echa (`attachmentMedia`): ta sama nazwa i waga, więc ten sam rozmiar.
  public var chip: MediaChip {
    MediaChip(name: label, bytes: bytes, image: kind == .photo)
  }
}

/// Załącznik wpisu z pozycją w kolejności wysyłki (identyfikator dostępności, tożsamość w wierszu).
public struct PendingAttachment: Sendable, Equatable {
  public let index: Int
  public let tile: PendingTile
}

/// Wiersz załączników wpisu kolejki (`a<wpis>`) w układzie wiersza zdjęć echa: miniatury zdjęć w pasku, pod
/// nimi chipy plików (plik nie przeskakuje przy potwierdzeniu z kafla w chip). Załączniki
/// w kolejności wysyłki (zdjęcia, potem pliki) i jedna nakładka dla wszystkich — wpis idzie jednym żądaniem.
public struct PendingMediaModel: Sendable, Equatable {
  public let id: String
  public let entry: UUID
  public let voice: VoiceLabel?
  public let tiles: [PendingTile]
  public let indicator: PendingIndicator
  /// Wpis bez tekstu po 202 czeka na echo: pierścień i przyciemnienie już zgasły, a dymka z poświatą nie ma, więc
  /// poświatę niesie kafel albo chip (bez wiersza „w kolejce”).
  public var awaitingEcho = false
  public var turn = TurnMark()

  /// Zdjęcia — miniatury w pasku (jak `MediaRowModel.thumbnails`).
  public var photos: [PendingAttachment] { attachments(.photo) }
  /// Pliki — chipy pod paskiem (jak `MediaRowModel.chips`).
  public var files: [PendingAttachment] { attachments(.file) }

  private func attachments(_ kind: PendingTile.Kind) -> [PendingAttachment] {
    tiles.enumerated().filter { $0.element.kind == kind }.map { PendingAttachment(index: $0.offset, tile: $0.element) }
  }

  /// `nil` = wpis bez załączników (sam tekst nie ma wiersza mediów).
  static func make(entry: OutboxEntry, voice: VoiceLabel?, progress: SendProgress?) -> PendingMediaModel? {
    guard !entry.attachments.isEmpty else { return nil }
    var photo = 0
    let tiles = entry.attachments.enumerated().map { index, attachment in
      let key = "o:\(entry.id.uuidString).\(index)"
      switch attachment.kind {
      case .image:
        photo += 1
        return PendingTile(
          key: key, kind: .photo, label: UICopy.photoLabel(photo), file: attachment.file, bytes: attachment.bytes)
      case .file:
        let name = attachment.name.isEmpty ? UICopy.fileFallbackName : attachment.name
        return PendingTile(key: key, kind: .file, label: name, file: attachment.file, bytes: attachment.bytes)
      }
    }
    var sent = false
    if case .sent = entry.state { sent = true }
    return PendingMediaModel(
      id: "a\(entry.id.uuidString)", entry: entry.id, voice: voice, tiles: tiles,
      indicator: .make(state: entry.state, progress: progress), awaitingEcho: sent && entry.text.isEmpty)
  }
}

/// Miniatury wpisu przechodzą na echo (miniaturę daje lokalna kopia urządzenia, które wysłało
/// zdjęcie): kafel echa bierze obraz już zdekodowany z pliku na urządzeniu, zamiast szkieletu do czasu
/// odczytu z serwera — potwierdzenie nie mruga. Plik treści znika razem z wpisem, więc przekazuje
/// się obraz z pamięci miniatur, nie plik.
public enum EchoThumbnailHandoff {
  /// Klucze pamięci miniatur: kafel wpisu → kafel echa. `settling` = wpis miał jeszcze nakładkę (echo
  /// przyszło przed 202 albo po „Nie potwierdzono") — kafel echa ją wygasza, zamiast zgubić w jednej klatce.
  public struct Pair: Sendable, Equatable {
    public let from: String
    public let to: String
    public let settling: Bool
  }

  /// Pary dla wpisów z `previous` (wiersze poprzedniego renderu), które zgasły echem (`echoed`). Zdjęcia
  /// paruje numer zdjęcia w wiadomości; zdjęcie echa bez `file` (starszy serwer) zostaje chipem, bez pary.
  public static func pairs(previous: some Sequence<TranscriptRow>, state: AppState, sessionId: String) -> [Pair] {
    var pairs: [Pair] = []
    for case let .attachments(model) in previous where !state.outbox.contains(where: { $0.id == model.entry }) {
      guard let seq = state.echoed[model.entry],
        let message = state.transcripts[sessionId]?.messages.last(where: { $0.seq == seq }),
        isEcho(message, of: model)
      else { continue }
      let photos = model.tiles.filter { $0.kind == .photo }
      let echoed = (message.attachments ?? []).filter { $0.kind == .image }
      for (tile, attachment) in zip(photos, echoed) {
        guard let file = attachment.file else { continue }
        pairs.append(Pair(
          from: tile.cacheKey(sessionId: sessionId),
          to: MediaThumbnail.cacheKey(sessionId: sessionId, key: MediaThumbnail.uploadKey(file: file)),
          settling: model.indicator.dims))
      }
    }
    return pairs
  }

  /// Czy wiadomość pod numerem z `echoed` to wciąż echo TEGO wpisu. Restart serwera numeruje wiadomości od
  /// nowa, a pełny stan może podmienić wiadomość pod tym numerem przed renderem, który przekazuje obraz
  /// — miniatura wpisu stanęłaby wtedy pod plikiem cudzego zdjęcia. Echo z identyfikatorem
  /// rozstrzyga identyfikator; bez niego — rodzaje i wagi załączników w kolejności wysyłki, jak podpis echa.
  static func isEcho(_ message: TranscriptMessage, of model: PendingMediaModel) -> Bool {
    guard message.role == .user else { return false }
    if let raw = message.clientMessageId { return UUID(uuidString: raw) == model.entry }
    let attachments = message.attachments ?? []
    return attachments.map(\.bytes) == model.tiles.map(\.bytes)
      && attachments.map { $0.kind == .image } == model.tiles.map { $0.kind == .photo }
  }
}
