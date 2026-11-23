import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Miniatury wpisu kolejki z pierścieniem postępu, jak w iOS. Zdjęcie wpisu stoi w tym
/// samym kaflu co echo, a plik tym samym chipem: po potwierdzeniu wiersz echa jest piksel w piksel wierszem wpisu
/// bez nakładki, a obraz przechodzi na kafel echa w renderze ekranu sesji (bez szkieletu i bez odczytu
/// z serwera). Zrzuty każdego stanu w obu motywach zapisuje do katalogu z `RAROG_PENDING_SNAPSHOT_DIR`
/// (`TEST_RUNNER_RAROG_PENDING_SNAPSHOT_DIR` przy `xcodebuild`), bez niego tylko sprawdza.
/// Właściciel: wysyłka.
@MainActor
final class PendingMediaRowTests: XCTestCase {
  /// Po 202 (nakładka zgasła) wiersz wpisu jest wierszem echa: ten sam rozmiar i te same piksele. Nakładka
  /// w drodze przyciemnia kafel i nie zmienia jego rozmiaru w żadnym stanie.
  func testConfirmedPendingRowIsPixelIdenticalToEchoRow() async throws {
    let fixture = try await Fixture.make(photos: [(1200, 900)])
    let echoFile = Self.uploadName()
    let pending = try XCTUnwrap(fixture.model.tiles.first)
    ThumbnailImageCache.shared.handOff(
      .init(from: pending.cacheKey(sessionId: "s1"), to: MediaThumbnail.cacheKey(sessionId: "s1", key: "u:\(echoFile)"),
            settling: false),
      login: fixture.store.uploadLogin)
    let echo = MediaRowView(
      model: MediaRowModel(
        id: "m9.a", voice: nil,
        thumbnails: [MediaThumbnail(key: "u:\(echoFile)", source: .upload(file: echoFile), label: "Zdjęcie 1", bytes: 10)],
        chips: []),
      loader: ThumbnailLoader(store: fixture.store, sessionId: "s1"), open: { _ in })
    for style in [UIUserInterfaceStyle.dark, .light] {
      let name = style == .dark ? "ciemny" : "jasny"
      let confirmed = try await Self.render(fixture.row(.none), style: style, name: "foto-potwierdzone-\(name)")
      let echoed = try await Self.render(echo, style: style, name: "echo-\(name)")
      XCTAssertEqual(confirmed.size, echoed.size, "\(name): ten sam wiersz po echu")
      XCTAssertLessThan(confirmed.differingPixels(echoed), 8, "\(name): wiersz echa = wiersz wpisu bez nakładki")
      let tile = CGRect(x: 16, y: 2, width: 128, height: 96)
      let flyingStates: [(PendingIndicator, String)] = [(.progress(0.35), "35"), (.awaitingResponse, "czeka"), (.unconfirmed, "blad")]
      for (indicator, label) in flyingStates {
        let flying = try await Self.render(fixture.row(indicator), style: style, name: "foto-\(label)-\(name)")
        XCTAssertEqual(flying.size, confirmed.size, "\(name) \(label): nakładka nie zmienia wysokości wiersza")
        XCTAssertLessThan(
          flying.brightness(in: tile), confirmed.brightness(in: tile) - 0.05, "\(name) \(label): przyciemnione")
        if indicator == .unconfirmed {
          // Na przyciemnieniu ostrzeżenie w bursztynie ciemnego motywu, także w jasnym (brąz ginął).
          XCTAssertGreaterThan(flying.count(of: PaletteTokens.wait.dark, in: tile), 20, "\(name): jasny bursztyn")
        }
      }
    }
  }

  /// Plik wpisu stoi chipem echa (bez przeskoku kafel → chip przy potwierdzeniu):
  /// po 202 chip wpisu jest piksel w piksel chipem echa — sam i pod zdjęciem — a pierścień i ostrzeżenie stoją
  /// w miejscu ikony: nazwa i waga nie drgną w żadnym stanie.
  func testConfirmedPendingFileChipIsPixelIdenticalToEchoChip() async throws {
    let file = try await Fixture.make(photos: [], files: ["raport-kwartalny.pdf"])
    let mixed = try await Fixture.make(photos: [(1200, 900)], files: ["notatki.txt"])
    let echoFile = Self.uploadName()
    let photo = try XCTUnwrap(mixed.model.photos.first?.tile)
    ThumbnailImageCache.shared.handOff(
      .init(from: photo.cacheKey(sessionId: "s1"), to: MediaThumbnail.cacheKey(sessionId: "s1", key: "u:\(echoFile)"),
            settling: false),
      login: mixed.store.uploadLogin)
    let loader = ThumbnailLoader(store: file.store, sessionId: "s1")
    let fileEcho = MediaRowView(
      model: MediaRowModel(id: "m9.a", voice: nil, thumbnails: [], chips: file.model.files.map(\.tile.chip)),
      loader: loader, open: { _ in })
    let mixedEcho = MediaRowView(
      model: MediaRowModel(
        id: "m10.a", voice: nil,
        thumbnails: [MediaThumbnail(key: "u:\(echoFile)", source: .upload(file: echoFile), label: "Zdjęcie 1", bytes: 10)],
        chips: mixed.model.files.map(\.tile.chip)),
      loader: ThumbnailLoader(store: mixed.store, sessionId: "s1"), open: { _ in })
    for style in [UIUserInterfaceStyle.dark, .light] {
      let name = style == .dark ? "ciemny" : "jasny"
      let confirmed = try await Self.render(file.row(.none), style: style, name: "plik-potwierdzone-\(name)")
      let echoed = try await Self.render(fileEcho, style: style, name: "echo-plik-\(name)")
      XCTAssertEqual(confirmed.size, echoed.size, "\(name): ten sam wiersz po echu")
      XCTAssertEqual(confirmed.size.height, 2 + 32 + 2, accuracy: 0.5, "\(name): chip, nie kafel 96 pt")
      XCTAssertLessThan(confirmed.differingPixels(echoed), 8, "\(name): chip echa = chip wpisu po 202")
      let mixedConfirmed = try await Self.render(
        mixed.row(.none), style: style, name: "zdjecie-i-plik-potwierdzone-\(name)")
      let mixedEchoed = try await Self.render(mixedEcho, style: style, name: "echo-zdjecie-i-plik-\(name)")
      XCTAssertEqual(mixedConfirmed.size, mixedEchoed.size, "\(name): zdjęcie i plik — ten sam wiersz po echu")
      XCTAssertLessThan(mixedConfirmed.differingPixels(mixedEchoed), 8, "\(name): zdjęcie i plik = echo")
      // Za ikoną (16 pt marginesu komórki + 10 pt wcięcia chipu + ikona) nazwa i waga stoją w każdym stanie
      // w tym samym miejscu: pierścień i ostrzeżenie nie poszerzają chipu.
      let text = CGRect(x: 16 + 10 + 22, y: 0, width: 390 - 48, height: confirmed.size.height)
      let states: [(PendingIndicator, String)] = [
        (.indeterminate, "przygotowanie"), (.progress(0.35), "wysylanie-35"), (.awaitingResponse, "pelny"),
        (.unconfirmed, "niepotwierdzone"), (.refused, "odmowa"),
      ]
      for (indicator, label) in states {
        let flying = try await Self.render(file.row(indicator), style: style, name: "plik-\(label)-\(name)")
        XCTAssertEqual(flying.size, confirmed.size, "\(name) \(label): chip tej samej wysokości")
        XCTAssertEqual(flying.differingPixels(confirmed, in: text), 0, "\(name) \(label): nazwa i waga w miejscu")
        XCTAssertGreaterThan(flying.differingPixels(confirmed), 10, "\(name) \(label): znak w miejscu ikony")
      }
    }
  }

  /// Wszystkie stany w obu motywach do oceny wzrokowej: przygotowanie (łuk), przesył 35 %, pełny pierścień po
  /// ostatnim bajcie i łuk po chwili czekania, „Nie potwierdzono" (bursztyn), odmowa (czerwień), potwierdzone;
  /// zdjęcie bez pliku (kafel „Zdjęcie" echa z pierścieniem); dwa zdjęcia i plik (chip) w jednym wierszu. Chipy
  /// pliku w każdym stanie zapisuje `testConfirmedPendingFileChipIsPixelIdenticalToEchoChip`.
  func testSnapshotsOfEveryState() async throws {
    let fixture = try await Fixture.make(photos: [(1200, 900), (900, 1200)], files: ["raport-kwartalny.pdf"])
    let single = try await Fixture.make(photos: [(1200, 900)])
    let missing = try await Fixture.make(photos: [(1200, 900)], writeFiles: false)
    var heights: Set<CGFloat> = []
    for style in [UIUserInterfaceStyle.dark, .light] {
      let name = style == .dark ? "ciemny" : "jasny"
      let states: [(PendingIndicator, String)] = [
        (.indeterminate, "przygotowanie"), (.progress(0.35), "wysylanie-35"), (.awaitingResponse, "pelny"),
        (.unconfirmed, "niepotwierdzone"), (.refused, "odmowa"), (.none, "potwierdzone"),
      ]
      for (indicator, label) in states {
        let photo = try await Self.render(single.row(indicator), style: style, name: "foto-\(label)-\(name)")
        heights.insert(photo.size.height)
      }
      let held = PendingRing.fullHold + .milliseconds(500)
      _ = try await Self.render(single.row(.awaitingResponse), style: style, name: "foto-czeka-dluzej-\(name)", settle: held)
      _ = try await Self.render(missing.row(.progress(0.6)), style: style, name: "foto-bez-pliku-\(name)", settle: held)
      let mixed = try await Self.render(fixture.row(.progress(0.5)), style: style, name: "dwa-zdjecia-i-plik-\(name)")
      XCTAssertEqual(
        mixed.size.height, 2 + 96 + 8 + 32 + 2, accuracy: 0.5, "\(name): pasek najwyższego kafla, pod nim chip")
    }
    XCTAssertEqual(heights.count, 1, "każdy stan tej samej wysokości: \(heights)")
  }

  /// Ekran sesji: wpis ze zdjęciem dekoduje miniaturę z pliku w kolejce, echo przejmuje ją w tym samym renderze
  /// (adres serwera w teście jest martwy — bez przekazania kafel echa zostałby „Zdjęciem"), a kafel echa wygasza
  /// nakładkę wpisu, który w chwili echa był jeszcze w drodze.
  func testEchoTakesOverDecodedThumbnailInSessionScreen() async throws {
    let store = try SessionToastTests.makeStore(messages: 1)
    let entry = try Fixture.entry(store: store, photos: [(1200, 900)], files: [], text: "zrzut")
    store.dispatch(.outboxEnqueued(entry))
    store.dispatch(.outboxProgress(entry.id, .awaitingResponse))
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 420, height: 912))
    window.rootViewController = controller
    window.isHidden = false
    defer { window.isHidden = true }
    let pendingKey = MediaThumbnail.cacheKey(sessionId: "s1", key: "o:\(entry.id.uuidString).0")
    let decoded = await Self.until { ThumbnailImageCache.shared.thumbnail(for: pendingKey, login: store.uploadLogin) != nil }
    XCTAssertTrue(decoded, "miniatura wpisu z pliku w kolejce")
    let row = try XCTUnwrap(controller.rows["a\(entry.id.uuidString)"])
    guard case let .attachments(model) = row else { return XCTFail("wiersz miniatur wpisu: \(row)") }
    XCTAssertEqual(model.indicator, .awaitingResponse)

    let echoFile = Self.uploadName()
    let echo = #"""
      {"type":"message","sessionId":"s1","message":{"seq":2,"role":"user","at":"2026-10-06T10:01:00.000Z",
       "blocks":[{"type":"text","text":"zrzut"}],"clientMessageId":"\#(entry.clientMessageId)",
       "attachments":[{"kind":"image","name":"","bytes":\#(entry.attachments[0].bytes),"mime":"image/jpeg",
                       "file":"\#(echoFile)"}]}}
      """#
    let event = try EventDecoder.decode(Data(echo.utf8)).get().event
    store.dispatch(.frame(event, source: .session("s1"), cursor: nil))
    let echoKey = MediaThumbnail.cacheKey(sessionId: "s1", key: "u:\(echoFile)")
    let handedOver = await Self.until { controller.rows["m2.a"] != nil }
    XCTAssertTrue(handedOver, "wiersz zdjęć echa")
    XCTAssertTrue(store.state.outbox.isEmpty, "echo zgasiło wpis")
    XCTAssertNil(controller.rows["a\(entry.id.uuidString)"], "wiersza wpisu już nie ma")
    let thumbnail = ThumbnailImageCache.shared.thumbnail(for: echoKey, login: store.uploadLogin)
    XCTAssertNotNil(thumbnail, "kafel echa ma obraz od wpisu, bez odczytu z serwera")
    XCTAssertTrue(ThumbnailImageCache.shared.settles(echoKey), "echo przed 202: kafel echa wygasza nakładkę wpisu")
    XCTAssertEqual(thumbnail?.size, CGSize(width: 128, height: 96), "kafel echa w rozmiarze kafla wpisu")
  }

  // MARK: - Pomocnicze

  enum FixtureError: Error {
    case notDecoded(String)
  }

  /// Magazyn z sesją `s1` i wpis kolejki z plikami treści w katalogu kolejki magazynu.
  @MainActor
  private struct Fixture {
    let store: RarogStore
    let entry: OutboxEntry
    let model: PendingMediaModel

    func row(_ indicator: PendingIndicator) -> some View {
      PendingMediaRowView(
        model: PendingMediaModel(id: model.id, entry: model.entry, voice: nil, tiles: model.tiles, indicator: indicator),
        loader: PendingThumbnailLoader(store: store, sessionId: "s1", entry: entry.id))
    }

    /// Wpis i dekodowanie miniatur do pamięci przed renderem (kafel czyta pamięć w chwili powstania).
    static func make(photos: [(Int, Int)], files: [String] = [], writeFiles: Bool = true) async throws -> Fixture {
      let store = try SessionToastTests.makeStore(messages: 1)
      let entry = try Fixture.entry(store: store, photos: photos, files: files, text: "", write: writeFiles)
      let model = try XCTUnwrap(PendingMediaModel.make(entry: entry, voice: nil, progress: nil))
      let loader = PendingThumbnailLoader(store: store, sessionId: "s1", entry: entry.id)
      for tile in model.tiles where tile.kind == .photo && writeFiles {
        guard case .loaded? = await loader.load(tile) else { throw FixtureError.notDecoded(tile.label) }
      }
      return Fixture(store: store, entry: entry, model: model)
    }

    static func entry(
      store: RarogStore, photos: [(Int, Int)], files: [String], text: String, write: Bool = true
    ) throws -> OutboxEntry {
      var attachments: [OutboxEntry.Attachment] = []
      var payloads: [Data] = []
      for (index, size) in photos.enumerated() {
        let data = try PendingMediaRowTests.photo(width: size.0, height: size.1)
        attachments.append(.init(name: "", bytes: data.count, kind: .image, mime: "image/jpeg", file: "\(index).jpg"))
        payloads.append(data)
      }
      for (index, name) in files.enumerated() {
        let data = Data("treść \(name)".utf8)
        attachments.append(
          .init(name: name, bytes: data.count, kind: .file, mime: "text/plain", file: "\(photos.count + index).bin"))
        payloads.append(data)
      }
      let entry = OutboxEntry(sessionId: "s1", text: text, attachments: attachments, createdAt: Date())
      if write {
        for (attachment, data) in zip(attachments, payloads) {
          let url = try XCTUnwrap(store.outboxPayloadURL(entry: entry.id, file: try XCTUnwrap(attachment.file)))
          try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
          try data.write(to: url)
        }
      }
      return entry
    }
  }

  /// Zdjęcie z gradientem nieba, słońcem i pasem ziemi (jasne i ciemne partie pod nakładką), JPEG.
  static func photo(width: Int, height: Int) throws -> Data {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
      let cg = context.cgContext
      let colors = [
        UIColor(red: 0.45, green: 0.7, blue: 0.95, alpha: 1).cgColor, UIColor(red: 0.95, green: 0.85, blue: 0.7, alpha: 1).cgColor,
      ]
      let space = CGColorSpace(name: CGColorSpace.sRGB)
      if let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: [0, 1]) {
        cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: height), options: [])
      }
      UIColor(red: 1, green: 0.95, blue: 0.6, alpha: 1).setFill()
      cg.fillEllipse(in: CGRect(x: width / 6, y: height / 6, width: width / 4, height: width / 4))
      UIColor(red: 0.2, green: 0.45, blue: 0.25, alpha: 1).setFill()
      cg.fill(CGRect(x: 0, y: height * 2 / 3, width: width, height: height / 3))
    }
    return try XCTUnwrap(image.jpegData(compressionQuality: 0.85))
  }

  /// Nazwa zdjęcia jak z `.rarog-uploads/` — inna w każdym przebiegu (pamięć miniatur jest wspólna dla procesu).
  static func uploadName() -> String {
    let hex = UUID().uuidString.lowercased().filter { $0 != "-" }.prefix(16)
    return "1790000000000-\(hex).jpg"
  }

  static func until(_ condition: @escaping @MainActor () -> Bool) async -> Bool {
    for _ in 0..<150 {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
  }

  /// Wiersz w oknie sceny apki (okno bez sceny nie rysuje się na ekranie) o szerokości iPhone'a, bez safe area,
  /// z marginesem komórki transkryptu (16 pt), w motywie `style`. Rysuje warstwa; gdy wyjdzie pusta (przezroczysty
  /// róg zamiast tła), rysuje hierarchia widoków po aktualizacji ekranu.
  static func render(
    _ view: some View, style: UIUserInterfaceStyle, name: String, settle: Duration = .milliseconds(150)
  ) async throws -> Bitmap {
    let width: CGFloat = 390
    let host = UIHostingController(rootView: AnyView(view.padding(.horizontal, 16)))
    host.safeAreaRegions = []
    host.view.backgroundColor = Palette.background
    host.overrideUserInterfaceStyle = style
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: width, height: 300)
    window.overrideUserInterfaceStyle = style
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    let fitted = host.sizeThatFits(in: CGSize(width: width, height: 1000))
    window.frame = CGRect(x: 0, y: 0, width: width, height: ceil(fitted.height))
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    // Czekanie z oddaniem głównego aktora: `.task` kafla (odczyt pliku, pełny pierścień → łuk) biegnie na nim,
    // a zagnieżdżona pętla zdarzeń w teście asynchronicznym go nie obsługuje.
    try await Task.sleep(for: settle)
    host.view.layoutIfNeeded()
    let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
    var image = renderer.image { context in host.view.layer.render(in: context.cgContext) }
    if let drawn = Bitmap(image), drawn.alpha(atX: 1, y: 1) == 0 {
      image = renderer.image { _ in _ = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
    }
    if let dir = ProcessInfo.processInfo.environment["RAROG_PENDING_SNAPSHOT_DIR"], !dir.isEmpty {
      try XCTUnwrap(image.pngData()).write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
    let bitmap = try XCTUnwrap(Bitmap(image), "\(name): bitmapa")
    XCTAssertGreaterThan(bitmap.alpha(atX: 1, y: 1), 0, "\(name): render z tłem, nie pusty")
    return bitmap
  }

  struct Bitmap {
    let size: CGSize
    let width: Int
    let height: Int
    let bytes: [UInt8]

    init?(_ image: UIImage) {
      guard let cg = image.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
      var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
      let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(
          data: buffer.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4,
          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return false }
        context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        return true
      }
      guard drawn else { return nil }
      size = image.size
      width = cg.width
      height = cg.height
      self.bytes = bytes
    }

    /// Piksele różniące się o więcej niż 6 na którymś kanale, w kadrze w punktach albo całe (inny rozmiar =
    /// wszystkie).
    func differingPixels(_ other: Bitmap, in frame: CGRect? = nil) -> Int {
      guard width == other.width, height == other.height else { return width * height }
      let scale = Double(width) / size.width
      let area = frame ?? CGRect(origin: .zero, size: size)
      var count = 0
      for y in max(0, Int(area.minY * scale))..<min(height, Int(area.maxY * scale)) {
        for x in max(0, Int(area.minX * scale))..<min(width, Int(area.maxX * scale)) {
          let index = (y * width + x) * 4
          if (0..<3).contains(where: { abs(Int(bytes[index + $0]) - Int(other.bytes[index + $0])) > 6 }) { count += 1 }
        }
      }
      return count
    }

    /// Krycie piksela (piksele bitmapy).
    func alpha(atX x: Int, y: Int) -> UInt8 {
      bytes[(y * width + x) * 4 + 3]
    }

    /// Piksele kadru (w punktach) w kolorze `hex` (±12 na kanał — krawędzie mieszają się z tłem).
    func count(of hex: UInt32, in frame: CGRect) -> Int {
      let target = [Int((hex >> 16) & 0xFF), Int((hex >> 8) & 0xFF), Int(hex & 0xFF)]
      let scale = Double(width) / size.width
      var hits = 0
      for y in max(0, Int(frame.minY * scale))..<min(height, Int(frame.maxY * scale)) {
        for x in max(0, Int(frame.minX * scale))..<min(width, Int(frame.maxX * scale)) {
          let index = (y * width + x) * 4
          if (0..<3).allSatisfy({ abs(Int(bytes[index + $0]) - target[$0]) <= 12 }) { hits += 1 }
        }
      }
      return hits
    }

    /// Średnia jasność (0…1) kadru w punktach.
    func brightness(in frame: CGRect) -> Double {
      let scale = Double(width) / size.width
      let x0 = max(0, Int(frame.minX * scale)), x1 = min(width, Int(frame.maxX * scale))
      let y0 = max(0, Int(frame.minY * scale)), y1 = min(height, Int(frame.maxY * scale))
      guard x1 > x0, y1 > y0 else { return 0 }
      var sum = 0
      for y in y0..<y1 {
        for x in x0..<x1 {
          let index = (y * width + x) * 4
          sum += Int(bytes[index]) + Int(bytes[index + 1]) + Int(bytes[index + 2])
        }
      }
      return Double(sum) / Double((x1 - x0) * (y1 - y0) * 3 * 255)
    }
  }
}
