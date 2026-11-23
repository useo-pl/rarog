import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Zdjęcie do wysłania: dłuższy bok ≤ 2048 px, ZAWSZE JPEG, data URL ≤ 1,5 MB po base64.
// Właściciel: wysyłka. Decyzja „zawsze jpeg": png ze
// zrzutu potrafi ważyć kilkanaście MB, przewidywalny rozmiar ważniejszy od ostatniego procenta
// ostrości. ImageIO dekoduje HEIC i duże zdjęcia bez rozwijania pełnej bitmapy w pamięci,
// obraca według EXIF i nie przenosi metadanych (GPS) do wyniku.

/// Zdjęcie gotowe do wysłania.
public struct PreparedImage: Sendable, Equatable {
  public let jpeg: Data
  public let width: Int
  public let height: Int
}

public enum ImageRejection: Error, Sendable, Equatable {
  /// Nie da się zdekodować (obcy format, zepsuty plik).
  case unreadable
  /// Za duże nawet po ostatnim stopniu; `bytes` = długość data URL-a po ostatniej próbie.
  case tooLarge(bytes: Int)
}

public enum ImagePreparer {
  /// Drabinka prób: najpierw jakość, potem piksele (2048/0,85 → 2048/0,6 → 1280/0,6).
  public static let ladder: [(edge: Int, quality: Double)] = [(2048, 0.85), (2048, 0.6), (1280, 0.6)]
  public static let mime = "image/jpeg"

  /// Czy ImageIO umie zdekodować ten typ (zdjęcie idzie przez zmniejszenie; reszta jako plik).
  public static func canDecode(_ type: UTType) -> Bool {
    guard type.conforms(to: .image) else { return false }
    let supported = (CGImageSourceCopyTypeIdentifiers() as? [String]) ?? []
    return supported.contains { UTType($0).map { type.conforms(to: $0) } ?? false }
  }

  /// Przygotowuje zdjęcie z pliku. Przezroczystość dostaje białe tło (inaczej czarna plama w JPEG).
  public static func prepare(_ url: URL) throws(ImageRejection) -> PreparedImage {
    let options = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithURL(url as CFURL, options), CGImageSourceGetCount(source) > 0 else {
      throw .unreadable
    }
    var drawn: (edge: Int, image: CGImage)?
    var lastLength = 0
    for step in ladder {
      let image: CGImage
      if let drawn, drawn.edge == step.edge {
        image = drawn.image
      } else {
        guard let scaled = thumbnail(source, maxEdge: step.edge), let flat = flatten(scaled) else { throw .unreadable }
        image = flat
        drawn = (step.edge, flat)
      }
      guard let jpeg = encode(image, quality: step.quality) else { throw .unreadable }
      lastLength = AttachmentLimits.dataURLLength(mime: mime, bytes: jpeg.count)
      if lastLength <= AttachmentLimits.maxImageDataURL {
        return PreparedImage(jpeg: jpeg, width: image.width, height: image.height)
      }
    }
    throw .tooLarge(bytes: lastLength)
  }

  /// Sufit dłuższego boku miniatury kafla (px): skrajna panorama nie rozdmuchuje pamięci paska.
  public static let tileThumbnailCeiling = 2048

  /// Miniatura kwadratowego kafla paska nad polem (`side` px, wypełnienie z przycięciem): ostrość daje
  /// KRÓTSZY bok, więc to on dostaje co najmniej `side` px. Liczona z dłuższego boku dałaby szerokiemu zrzutowi
  /// 42 px na kafel 168 px, czyli rozmazanie. Bez powiększania, z sufitem pamięci.
  public static func tileThumbnail(of url: URL, side: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      let (width, height) = pixelSize(source)
    else { return nil }
    let long = max(width, height)
    let needed = Int((Double(side) * Double(long) / Double(min(width, height))).rounded(.up))
    return thumbnail(source, maxEdge: min(needed, tileThumbnailCeiling))
  }

  /// Zmniejszenie bez powiększania małych obrazów, z obrotem według EXIF.
  private static func thumbnail(_ source: CGImageSource, maxEdge: Int) -> CGImage? {
    guard let (width, height) = pixelSize(source) else { return nil }
    let edge = min(maxEdge, max(width, height))
    let options = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: edge,
      kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
  }

  /// Wymiary źródła w pikselach (przed obrotem EXIF — krótszy i dłuższy bok się nie zmieniają).
  private static func pixelSize(_ source: CGImageSource) -> (width: Int, height: Int)? {
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0
    else { return nil }
    return (width, height)
  }

  /// Obraz bez kanału alfa na białym tle, w sRGB.
  private static func flatten(_ image: CGImage) -> CGImage? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(
        data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(rect)
    context.interpolationQuality = .high
    context.draw(image, in: rect)
    return context.makeImage()
  }

  private static func encode(_ image: CGImage, quality: Double) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
      return nil
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
  }
}
