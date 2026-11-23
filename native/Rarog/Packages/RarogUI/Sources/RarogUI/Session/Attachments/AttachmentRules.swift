import Foundation
import RarogCore
import UniformTypeIdentifiers

// Załączniki wiadomości: limity, nazwy, typy i model paska nad polem.
// Właściciel: wysyłka. Kompiluje się na macOS (testy).

/// Limity — lustro `shared/src/protocol.ts`. Telefon pilnuje ich PRZED wysyłką: odbicie 413 po
/// przejechaniu megabajtów przez tailnet to najgorszy moment na „za duże".
public enum AttachmentLimits {
  /// `MAX_IMAGES_PER_MESSAGE`.
  public static let maxImages = 5
  /// `MAX_FILES_PER_MESSAGE`.
  public static let maxFiles = 4
  /// `MAX_IMAGE_DATA_URL_BYTES`: długość data URL-a zdjęcia PO base64 (1,5 MB).
  public static let maxImageDataURL = 1_572_864
  /// Limit pliku widziany przez człowieka (surowe bajty, jak w Plikach); 20 MB po base64 mieści
  /// się pod `MAX_FILE_DATA_URL_BYTES` z zapasem.
  public static let maxFileBytes = 20 * 1024 * 1024
  /// `MAX_FILE_DATA_URL_BYTES`: długość data URL-a pliku po base64 (27 MB).
  public static let maxFileDataURL = 27 * 1024 * 1024
  /// `MAX_FILE_NAME_CHARS` — liczone jak `length` w JS (jednostki UTF-16).
  public static let maxFileNameUnits = 120

  /// Długość base64 dla `bytes` surowych bajtów: 3 bajty → 4 znaki.
  public static func base64Length(_ bytes: Int) -> Int { (bytes + 2) / 3 * 4 }

  /// Długość data URL-a `data:<mime>;base64,<treść>` — miara serwera (base64 to ASCII).
  public static func dataURLLength(mime: String, bytes: Int) -> Int {
    "data:".utf8.count + mime.utf8.count + ";base64,".utf8.count + base64Length(bytes)
  }
}

/// Nazwy i typy plików po stronie klienta.
public enum AttachmentNames {
  /// Nazwa przycięta do tego, co przyjmuje kontrakt (`isSafeFileName`): bez separatorów ścieżki
  /// i znaków sterujących (nazwa jedzie do promptu w cudzym terminalu), najwyżej 120 jednostek
  /// z ZACHOWANIEM rozszerzenia — po nim człowiek poznaje plik. Pusta → „plik".
  public static func sanitize(_ name: String) -> String {
    var scalars = String.UnicodeScalarView()
    for scalar in name.unicodeScalars {
      if scalar == "/" || scalar == "\\" {
        scalars.append("-")
      } else if scalar.value >= 0x20, scalar.value != 0x7F {
        scalars.append(scalar)
      }
    }
    let flat = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
    if flat.isEmpty { return "plik" }
    let limit = AttachmentLimits.maxFileNameUnits
    if flat.utf16.count <= limit { return flat }
    var ext = ""
    if let dot = flat.lastIndex(of: "."), dot > flat.startIndex, flat[dot...].utf16.count <= 12 {
      ext = String(flat[dot...])
    }
    var head = ""
    var used = 0
    for character in flat {
      let units = String(character).utf16.count
      if used + units > limit - ext.utf16.count { break }
      head.append(character)
      used += units
    }
    return head + ext
  }

  /// Nazwa z dostawcy (schowek, przeciąganie) z rozszerzeniem typu, gdy go brakuje.
  public static func named(_ suggested: String?, type: UTType?) -> String {
    let base = (suggested ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let ext = type?.preferredFilenameExtension
    if base.isEmpty { return ext.map { "plik.\($0)" } ?? "plik" }
    guard let ext, (base as NSString).pathExtension.isEmpty else { return base }
    return "\(base).\(ext)"
  }

  /// Typ MIME w kształcie, który przyjmuje `FILE_DATA_URL_PATTERN`; reszta → `application/octet-stream`.
  public static func mime(forName name: String, type: UTType? = nil) -> String {
    let resolved = type ?? UTType(filenameExtension: (name as NSString).pathExtension)
    if let candidate = resolved?.preferredMIMEType?.lowercased(),
      candidate.wholeMatch(of: /[a-z0-9.+\-]+\/[a-z0-9.+\-]+/) != nil
    {
      return candidate
    }
    return "application/octet-stream"
  }
}

/// Załącznik w pasku nad polem: treść już przygotowana i zapisana w katalogu roboczym.
public struct ComposerAttachment: Sendable, Equatable, Identifiable {
  public typealias Kind = OutboxEntry.Attachment.Kind

  public let id: UUID
  public let kind: Kind
  /// Plik: nazwa po sanityzacji (ta, która pójdzie). Zdjęcie: nazwa źródła — tylko do opisu.
  public let name: String
  public let mime: String
  /// Rozmiar przygotowanej treści w bajtach (zdjęcie: JPEG po zmniejszeniu).
  public let bytes: Int
  public let file: URL

  public init(id: UUID = UUID(), kind: Kind, name: String, mime: String, bytes: Int, file: URL) {
    self.id = id
    self.kind = kind
    self.name = name
    self.mime = mime
    self.bytes = bytes
    self.file = file
  }

  /// To, co dostaje „Wyślij" (magazyn kopiuje plik do kolejki).
  public var outgoing: OutgoingAttachment {
    OutgoingAttachment(kind: kind, name: name, mime: mime, bytes: bytes, file: file)
  }
}

/// Dlaczego załącznik odpadł — jedno zdanie na powód składa `UICopy.attachmentRejections`.
public struct AttachmentRejection: Error, Sendable, Equatable {
  public enum Reason: Sendable, Equatable {
    /// Limit sztuk w wiadomości (5 zdjęć, 4 pliki).
    case tooMany
    /// Za duży; `bytes` = waga po ostatniej próbie (zdjęcie) albo pliku, gdy znana.
    case tooLarge(bytes: Int?)
    /// Nie da się wczytać (dostawca odmówił, pusty plik, zepsuty obraz).
    case unreadable
  }

  public let kind: ComposerAttachment.Kind
  public let name: String
  public let reason: Reason

  public init(kind: ComposerAttachment.Kind, name: String, reason: Reason) {
    self.kind = kind
    self.name = name
    self.reason = reason
  }
}

/// Liczby w pasku i limity wiadomości.
public enum AttachmentCounts {
  public static func images(_ attachments: [ComposerAttachment]) -> Int { attachments.filter { $0.kind == .image }.count }
  public static func files(_ attachments: [ComposerAttachment]) -> Int { attachments.filter { $0.kind == .file }.count }

  /// Czy wiadomość mieści się w limitach (po przywróceniu nieudanej wysyłki pasek bywa pełniejszy).
  public static func withinLimits(_ attachments: [ComposerAttachment]) -> Bool {
    images(attachments) <= AttachmentLimits.maxImages && files(attachments) <= AttachmentLimits.maxFiles
  }

  /// Zdjęcia przed plikami (tak stoją w pasku, w ciele i w echu), w kolejności dodania.
  public static func ordered(_ attachments: [ComposerAttachment]) -> [ComposerAttachment] {
    attachments.filter { $0.kind == .image } + attachments.filter { $0.kind == .file }
  }
}
