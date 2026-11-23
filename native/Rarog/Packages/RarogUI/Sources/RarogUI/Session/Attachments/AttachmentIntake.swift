import Foundation
import RarogCore
import UniformTypeIdentifiers

// Przyjęcie paczki załączników z dowolnego źródła (spinacz, schowek, przeciąganie): limity sztuk
// liczone na WIADOMOŚĆ, przygotowanie, odrzucenia z powodem. Właściciel: wysyłka.
// Nigdy nie rzuca — każdy nieudany element wraca jako `AttachmentRejection`.

/// Katalog roboczy paska nad polem (`tmp/rarog-attachments`). Pasek żyje w pamięci procesu, więc
/// przy pierwszym użyciu w procesie wszystko, co tu leży, to sieroty po poprzednim — kasujemy.
public enum AttachmentStaging {
  public static let directory: URL = {
    let dir = FileManager.default.temporaryDirectory.appending(path: "rarog-attachments", directoryHint: .isDirectory)
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  public static func newURL(ext: String) -> URL {
    directory.appending(path: "\(UUID().uuidString).\(ext.isEmpty ? "bin" : ext)")
  }

  /// Kopia pliku źródła do katalogu roboczego (plik dostawcy znika po wywołaniu zwrotnym).
  public static func copy(_ source: URL, ext: String? = nil) throws -> URL {
    let target = newURL(ext: ext ?? source.pathExtension)
    try FileManager.default.copyItem(at: source, to: target)
    return target
  }

  /// Kasuje pliki robocze załączników, których pasek już nie trzyma.
  public static func discard(_ attachments: [ComposerAttachment]) {
    for attachment in attachments { try? FileManager.default.removeItem(at: attachment.file) }
  }
}

/// Element paczki: rodzaj z typu dostawcy (przed wczytaniem — limit sztuk bez czytania treści)
/// i wczytanie do pliku w katalogu roboczym, który od tej chwili należy do przyjęcia.
public struct AttachmentCandidate: Sendable {
  public var kind: ComposerAttachment.Kind
  /// Nazwa z rozszerzeniem (dla zdjęcia tylko do zdania o odrzuceniu).
  public var name: String
  public var type: UTType?
  public var load: @Sendable () async throws -> URL

  public init(kind: ComposerAttachment.Kind, name: String, type: UTType?, load: @escaping @Sendable () async throws -> URL) {
    self.kind = kind
    self.name = name
    self.type = type
    self.load = load
  }

  /// Rodzaj elementu po typach dostawcy; `nil` = to tekst albo adres (wkleja się do pola).
  ///
  /// - obraz, który ImageIO zdekoduje → zdjęcie (zmniejszenie do JPEG);
  /// - element z PLIKU (adres pliku `public.file-url` obok treści albo `fileBacked`: reprezentacja
  ///   „otwórz w miejscu" z Plików) → plik z typem TREŚCI, nie adresu; także tekstowy (`.txt`,
  ///   `.md`, `.json`). Treść spoza tekstu ma pierwszeństwo przed tekstem obok niej;
  /// - poza plikiem tekst albo adres w którejkolwiek postaci → nie załącznik (tekst skopiowany
  ///   z Notatek niesie też RTFD, a nie jest plikiem);
  /// - reszta z treścią → plik bajt w bajt.
  public static func classify(_ identifiers: [String], fileBacked: Bool = false) -> (kind: ComposerAttachment.Kind, type: UTType)? {
    let types = identifiers.compactMap { UTType($0) }
    if let image = types.first(where: ImagePreparer.canDecode) { return (.image, image) }
    let content = types.filter { !$0.conforms(to: .url) && ($0.conforms(to: .data) || $0.conforms(to: .package)) }
    if fileBacked || types.contains(where: { $0.conforms(to: .fileURL) }) {
      guard let type = content.first(where: { !$0.conforms(to: .text) }) ?? content.first else { return nil }
      return (.file, type)
    }
    if types.contains(where: { $0.conforms(to: .text) || $0.conforms(to: .url) }) { return nil }
    if let file = content.first { return (.file, file) }
    return nil
  }

  /// Rodzaj elementu dostawcy: typy w jego kolejności i metadane „otwórz w miejscu" (element z Plików).
  public static func classify(_ provider: NSItemProvider) -> (kind: ComposerAttachment.Kind, type: UTType)? {
    classify(provider.registeredTypeIdentifiers, fileBacked: !provider.registeredContentTypesForOpenInPlace.isEmpty)
  }

  /// Element z pliku, który już należy do apki (kopia z przeglądarki dokumentów).
  public static func file(at url: URL) -> AttachmentCandidate {
    let type = UTType(filenameExtension: url.pathExtension)
    let kind: ComposerAttachment.Kind = type.map(ImagePreparer.canDecode) == true ? .image : .file
    return AttachmentCandidate(kind: kind, name: url.lastPathComponent, type: type) {
      try AttachmentStaging.copy(url)
    }
  }

  /// Element z dostawcy (schowek, przeciąganie, wybór zdjęć); `nil` = tekst/adres.
  public static func from(_ provider: NSItemProvider) -> AttachmentCandidate? {
    guard let (kind, type) = classify(provider) else { return nil }
    let name = AttachmentNames.named(provider.suggestedName, type: type)
    let box = ProviderBox(provider)
    return AttachmentCandidate(kind: kind, name: name, type: type) {
      try await box.loadFile(type)
    }
  }
}

/// `NSItemProvider` nie jest `Sendable`; dostawca żyje do końca wczytania i nie jest dzielony.
private final class ProviderBox: @unchecked Sendable {
  private let provider: NSItemProvider

  init(_ provider: NSItemProvider) {
    self.provider = provider
  }

  /// Plik dostawcy znika po wywołaniu zwrotnym — kopia do katalogu roboczego w jego trakcie.
  func loadFile(_ type: UTType) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
        guard let url else {
          continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
          return
        }
        do {
          continuation.resume(returning: try AttachmentStaging.copy(url, ext: url.pathExtension.isEmpty
            ? type.preferredFilenameExtension : nil))
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }
}

public enum AttachmentIntake {
  public struct Result: Sendable, Equatable {
    public var added: [ComposerAttachment] = []
    public var rejections: [AttachmentRejection] = []
  }

  /// Przyjmuje paczkę w kolejności wyboru. Slot zajmuje wyłącznie element, który się UDAŁ.
  public static func process(_ candidates: [AttachmentCandidate], existing: [ComposerAttachment]) async -> Result {
    var result = Result()
    var images = AttachmentCounts.images(existing)
    var files = AttachmentCounts.files(existing)
    for candidate in candidates {
      switch candidate.kind {
      case .image where images >= AttachmentLimits.maxImages:
        result.rejections.append(.init(kind: .image, name: candidate.name, reason: .tooMany))
        continue
      case .file where files >= AttachmentLimits.maxFiles:
        result.rejections.append(.init(kind: .file, name: AttachmentNames.sanitize(candidate.name), reason: .tooMany))
        continue
      default:
        break
      }
      let raw: URL
      do {
        raw = try await candidate.load()
      } catch {
        result.rejections.append(.init(kind: candidate.kind, name: candidate.name, reason: .unreadable))
        continue
      }
      switch candidate.kind == .image ? prepareImage(raw, name: candidate.name) : prepareFile(raw, candidate: candidate) {
      case let .success(attachment):
        result.added.append(attachment)
        if attachment.kind == .image { images += 1 } else { files += 1 }
      case let .failure(rejection):
        result.rejections.append(rejection)
      }
    }
    return result
  }

  /// Zdjęcie: JPEG do katalogu roboczego, surowy plik źródła kasowany.
  static func prepareImage(_ raw: URL, name: String) -> Swift.Result<ComposerAttachment, AttachmentRejection> {
    defer { try? FileManager.default.removeItem(at: raw) }
    do {
      let prepared = try ImagePreparer.prepare(raw)
      let target = AttachmentStaging.newURL(ext: "jpg")
      try prepared.jpeg.write(to: target)
      return .success(ComposerAttachment(kind: .image, name: name, mime: ImagePreparer.mime, bytes: prepared.jpeg.count, file: target))
    } catch let rejection as ImageRejection {
      switch rejection {
      case .unreadable: return .failure(.init(kind: .image, name: name, reason: .unreadable))
      case let .tooLarge(bytes): return .failure(.init(kind: .image, name: name, reason: .tooLarge(bytes: bytes)))
      }
    } catch {
      return .failure(.init(kind: .image, name: name, reason: .unreadable))
    }
  }

  /// Plik: bajt w bajt, limit surowych bajtów i długości data URL-a; pusty = nie ma czego wysłać.
  static func prepareFile(_ raw: URL, candidate: AttachmentCandidate) -> Swift.Result<ComposerAttachment, AttachmentRejection> {
    let name = AttachmentNames.sanitize(candidate.name)
    let size = (try? raw.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    let mime = AttachmentNames.mime(forName: name, type: candidate.type)
    let failure: AttachmentRejection.Reason? =
      if size <= 0 {
        .unreadable
      } else if size > AttachmentLimits.maxFileBytes
        || AttachmentLimits.dataURLLength(mime: mime, bytes: size) > AttachmentLimits.maxFileDataURL
      {
        .tooLarge(bytes: size)
      } else {
        nil
      }
    if let failure {
      try? FileManager.default.removeItem(at: raw)
      return .failure(.init(kind: .file, name: name, reason: failure))
    }
    return .success(ComposerAttachment(kind: .file, name: name, mime: mime, bytes: size, file: raw))
  }
}
