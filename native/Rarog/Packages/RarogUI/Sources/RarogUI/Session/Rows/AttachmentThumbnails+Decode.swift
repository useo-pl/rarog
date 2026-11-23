import CoreGraphics
import Foundation
import ImageIO

// Miniatury zdjęć w transkrypcie: geometria kafla i dekodowanie poza głównym aktorem.
// Bez UIKit — testowane na macOS (`RarogUILogicTests`). Właściciel: notki i miniatury.

/// Zmniejszony obraz do kafla. `CGImage` jest niezmienny, więc przenosi się między wątkami.
struct DecodedThumbnail: @unchecked Sendable {
  let image: CGImage
}

public enum ThumbnailGeometry {
  /// Najwyższy kafel (pt) i wysokość szkieletu przy wczytywaniu (`THUMB_TILE.height` w PWA).
  public static let tileHeight: Double = 96
  /// Najniższy kafel (pt): szeroki zrzut nie staje się kreską i da się go trafić palcem.
  public static let minTileHeight: Double = 48
  /// Sufit szerokości (pt): szeroki zrzut nie rozlewa się na całą wiadomość (`THUMB_TILE.maxWidth`).
  public static let maxTileWidth: Double = 256
  /// Najwęższy kafel (pt): pionowy pasek nadal da się trafić palcem.
  public static let minTileWidth: Double = 48
  /// Dłuższy bok miniatury w pikselach: najszerszy kafel na ekranie @3x.
  public static let maxPixels = Int(maxTileWidth * 3)

  /// Kafel w proporcji obrazka (szeroki zrzut nie stoi między dwoma pustymi pasami).
  /// Pełna wysokość, a szerokość za proporcją; szerszy niż sufit — sufit szerokości
  /// i niższy kafel. Poza granicami (szerszy niż 16:3, węższy niż 1:2) obraz wypełnia kafel przycięty,
  /// nigdy z pustymi pasami.
  public static func tileSize(pixelWidth: Int, pixelHeight: Int) -> CGSize {
    guard pixelWidth > 0, pixelHeight > 0 else { return CGSize(width: tileHeight, height: tileHeight) }
    let aspect = Double(pixelWidth) / Double(pixelHeight)
    var width = tileHeight * aspect
    var height = tileHeight
    if width > maxTileWidth {
      width = maxTileWidth
      height = max(minTileHeight, maxTileWidth / aspect)
    }
    return CGSize(width: max(width, minTileWidth), height: height)
  }

  /// Dłuższy bok miniatury w pikselach dla obrazka `pixelWidth`×`pixelHeight` (po obrocie EXIF): zwykle
  /// `maxPixels`, ale obraz przycięty do kafla (szerszy niż 16:3, węższy niż 1:2) potrzebuje więcej, żeby
  /// KRÓTSZY bok pokrył kafel @3x. Bez powiększania i najwyżej 2048 px.
  public static func decodePixels(pixelWidth: Int, pixelHeight: Int) -> Int {
    let longest = max(pixelWidth, pixelHeight)
    guard pixelWidth > 0, pixelHeight > 0 else { return min(maxPixels, longest) }
    let tile = tileSize(pixelWidth: pixelWidth, pixelHeight: pixelHeight)
    let cover = max(tile.width * 3 / Double(pixelWidth), tile.height * 3 / Double(pixelHeight))
    let needed = Int((Double(longest) * cover).rounded(.up))
    return min(longest, 2048, max(maxPixels, needed))
  }
}

enum ThumbnailDecoder {
  /// Bajty data URL-a png/jpeg; inny kształt = `nil` (dekoder kontraktu już go odrzucił).
  static func bytes(ofDataURL dataUrl: String) -> Data? {
    for prefix in ["data:image/png;base64,", "data:image/jpeg;base64,"] where dataUrl.hasPrefix(prefix) {
      return Data(base64Encoded: String(dataUrl.dropFirst(prefix.count)))
    }
    return nil
  }

  /// Rozszerzenie pliku podglądu z sygnatury treści (`nil` = ani PNG, ani JPEG).
  static func fileExtension(of data: Data) -> String? {
    if data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "png" }
    if data.starts(with: [0xFF, 0xD8, 0xFF]) { return "jpg" }
    return nil
  }

  /// Miniatura z bajtów obrazka: dłuższy bok `ThumbnailGeometry.decodePixels`, obrót według EXIF, bez
  /// powiększania.
  /// `@concurrent`: dekodowanie zdjęcia nie ma prawa blokować przewijania transkryptu.
  @concurrent
  static func thumbnail(_ data: Data) async -> DecodedThumbnail? {
    CGImageSourceCreateWithData(data as CFData, noCache).flatMap(thumbnail(from:))
  }

  /// Ta sama miniatura z pliku na urządzeniu (zdjęcie wpisu kolejki): ImageIO czyta z pliku tylko
  /// to, czego potrzebuje miniatura — pełne zdjęcie nie wchodzi do pamięci. Te same bajty co na serwerze
  /// dają kafel tego samego rozmiaru co echo.
  @concurrent
  static func thumbnail(contentsOf url: URL) async -> DecodedThumbnail? {
    CGImageSourceCreateWithURL(url as CFURL, noCache).flatMap(thumbnail(from:))
  }

  private static var noCache: CFDictionary { [kCGImageSourceShouldCache: false] as CFDictionary }

  private static func thumbnail(from source: CGImageSource) -> DecodedThumbnail? {
    guard CGImageSourceGetCount(source) > 0,
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0
    else { return nil }
    // Orientacje EXIF 5…8 obracają obraz o 90°: kafel liczy się z wymiarów po obrocie.
    let turned = (5...8).contains(properties[kCGImagePropertyOrientation] as? Int ?? 1)
    let pixels = ThumbnailGeometry.decodePixels(pixelWidth: turned ? height : width, pixelHeight: turned ? width : height)
    let options = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: pixels,
      kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options).map(DecodedThumbnail.init)
  }
}
