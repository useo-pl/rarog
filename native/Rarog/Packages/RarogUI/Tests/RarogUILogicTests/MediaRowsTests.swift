import CoreGraphics
import Foundation
import ImageIO
import RarogContract
import RarogCore
@testable import RarogUI
import Testing
import UniformTypeIdentifiers

// Zdjęcia w wiadomościach: wiersze miniatur i chipów, geometria kafla, dekodowanie.
// Właściciel: notki i miniatury.

/// PNG w pamięci (szerokość × wysokość) jako bajty.
private func png(width: Int, height: Int) throws -> Data {
  let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
  let context = try #require(CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
  context.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  let image = try #require(context.makeImage())
  let data = NSMutableData()
  let destination = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
  CGImageDestinationAddImage(destination, image, nil)
  #expect(CGImageDestinationFinalize(destination))
  return data as Data
}

@Suite("wiersze: zdjęcia i załączniki")
struct MediaRowsTests {
  private let photo = "1790000000000-0123456789abcdef.png"
  private let older = "1790000000001-0123456789abcdef.png"

  @Test("załączniki: zdjęcia z plikiem → miniatury, plik → chip z wagą, zdjęcie bez pliku → chip „Zdjęcie”")
  func attachments() throws {
    let attachments = #"""
      [{"kind":"image","name":"","bytes":48211,"mime":"image/png","file":"\#(photo)"},
       {"kind":"file","name":"raport.pdf","bytes":182431,"mime":"application/pdf"},
       {"kind":"image","name":"IMG_1.HEIC","bytes":0,"mime":"image/jpeg"},
       {"kind":"image","name":"","bytes":0,"mime":"image/png","file":"\#(older)"}]
      """#
    let message = Sample.message(seq: 5, role: "user", blocks: Sample.text("Zrzuty"), attachments: attachments)
    let rows = TranscriptRows.build(state: Sample.state(session: Sample.session(), messages: [message]), sessionId: "s1")
    #expect(rows.count == 2)
    guard case let .media(model) = rows.last else {
      Issue.record("brak wiersza zdjęć: \(rows)")
      return
    }
    #expect(model.id == "m5.a" && model.voice == nil, "etykieta głosu przy tekście, nie przy zdjęciach")
    #expect(model.thumbnails == [
      MediaThumbnail(key: "u:\(photo)", source: .upload(file: photo), label: "Zdjęcie 1", bytes: 48211),
      MediaThumbnail(key: "u:\(older)", source: .upload(file: older), label: "Zdjęcie 3", bytes: 0),
    ])
    #expect(model.chips == [
      MediaChip(name: "raport.pdf", bytes: 182431, image: false),
      MediaChip(name: "Zdjęcie", bytes: 0, image: true),
    ])
    #expect(model.chips.map(\.size) == ["178\u{00A0}kB", nil])
  }

  @Test("zdjęcie z historii (bez nazwy i wagi) bez tekstu: miniatura z głosem, żadnej pustej linii „Załączniki”")
  func historyPhotoOnly() {
    let attachments = #"[{"kind":"image","name":"","bytes":0,"mime":"image/png","file":"\#(photo)"}]"#
    let message = Sample.message(seq: 9, role: "user", blocks: "[]", attachments: attachments)
    let rows = TranscriptRows.build(
      state: Sample.state(session: Sample.session(), messages: [message]), sessionId: "s1", calendar: Sample.calendar)
    // Prompt z samym zdjęciem: wiersz zdjęć niesie cechę nagłówka i godzinę.
    #expect(rows == [.media(MediaRowModel(
      id: "m9.a", voice: .user,
      thumbnails: [MediaThumbnail(key: "u:\(photo)", source: .upload(file: photo), label: "Zdjęcie 1", bytes: 0)],
      chips: [], turn: Sample.prompt(message.at)))])
  }

  @Test("pusta lista załączników nie daje wiersza")
  func noAttachments() {
    let message = Sample.message(seq: 2, role: "user", blocks: Sample.text("a"), attachments: "[]")
    let rows = TranscriptRows.build(
      state: Sample.state(session: Sample.session(), messages: [message]), sessionId: "s1", calendar: Sample.calendar)
    #expect(rows == [.text(id: "m2.0", role: .user, voice: .user, markdown: "a", turn: Sample.prompt(message.at))])
  }

  @Test("obrazki z treści: kolejne stoją jedną galerią, tekst między nimi dzieli; klucz niesie podpis treści")
  func inlineGallery() throws {
    let first = "data:image/png;base64,\(try png(width: 4, height: 2).base64EncodedString())"
    let second = "data:image/png;base64,\(try png(width: 2, height: 4).base64EncodedString())"
    let blocks = #"""
      [{"type":"text","text":"Przed:"},{"type":"image","dataUrl":"\#(first)","alt":"Wykres"},
       {"type":"image","dataUrl":"\#(second)","alt":"  "},{"type":"text","text":"Po:"},
       {"type":"image","dataUrl":"\#(first)"}]
      """#
    let rows = TranscriptRows.build(
      state: Sample.state(session: Sample.session(), messages: [Sample.message(seq: 3, role: "assistant", blocks: blocks)]),
      sessionId: "s1")
    #expect(rows.map(\.id) == ["m3.0", "m3.1", "m3.3", "m3.4"])
    guard case let .media(gallery) = rows[1], case let .media(single) = rows[3] else {
      Issue.record("brak galerii: \(rows)")
      return
    }
    #expect(gallery.voice == nil && gallery.chips.isEmpty)
    #expect(gallery.thumbnails.map(\.label) == ["Wykres", "Obrazek w wiadomości"])
    #expect(gallery.thumbnails.map(\.source) == [.inline(dataUrl: first), .inline(dataUrl: second)])
    #expect(Set([gallery.thumbnails[0].key, gallery.thumbnails[1].key, single.thumbnails[0].key]).count == 3)
    #expect(gallery.thumbnails[0].key == "i:m3.1.0:\(MediaThumbnail.contentDigest(first))")
  }

  @Test("obraz zastępczy serwera (`placeholder: true`): podpis z katalogu apki w jej języku; bez pola podpis serwera")
  func placeholderAlt() throws {
    let image = "data:image/png;base64,\(try png(width: 2, height: 2).base64EncodedString())"
    let serverAlt = "Earlier image. The full preview is available only in the pane on the computer."
    let blocks = #"""
      [{"type":"image","dataUrl":"\#(image)","alt":"\#(serverAlt)","placeholder":true},{"type":"text","text":"–"},
       {"type":"image","dataUrl":"\#(image)","alt":"\#(serverAlt)"}]
      """#
    let rows = TranscriptRows.build(
      state: Sample.state(session: Sample.session(), messages: [Sample.message(seq: 4, role: "assistant", blocks: blocks)]),
      sessionId: "s1")
    let labels = rows.compactMap { row in if case let .media(model) = row { model.thumbnails.first?.label } else { nil } }
    #expect(labels == ["Starszy obrazek — pełny podgląd tylko w panelu na komputerze.", serverAlt])
    #expect(UICopy.snapshotImageAlt(language: .en) == serverAlt)
    #expect(UICopy.snapshotImageAlt(language: .pl) == "Starszy obrazek — pełny podgląd tylko w panelu na komputerze.")
  }

  @Test("obrazek podmieniony pod tą samą pozycją dostaje nowy klucz, choć ma tę samą długość i ten sam ogon base64")
  func inlineKeyFollowsContent() {
    // PNG 1×1, czerwony i zielony, z jednakowym końcowym blokiem tEXt „Software”: stary
    // podpis (długość + 24 ostatnie znaki) był dla obu taki sam, więc kafel zostawał przy starym obrazie.
    let head = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42m"
    let tail = "AAAAFXRFWHRTb2Z0d2FyZQBwaWxvdC1yZXZpZXfjh8yIAAAAAElFTkSuQmCC"
    let red = head + "P4z8AAAAMBAQD3A0FD" + tail
    let green = head + "Ng+M8AAAICAQBF9FLU" + tail
    #expect(red.utf8.count == green.utf8.count && red.suffix(24) == green.suffix(24) && red != green)
    func key(_ dataUrl: String) -> String? {
      let blocks = #"[{"type":"text","text":"Wykres:"},{"type":"image","dataUrl":"\#(dataUrl)"}]"#
      let rows = TranscriptRows.build(
        state: Sample.state(session: Sample.session(), messages: [Sample.message(seq: 3, role: "assistant", blocks: blocks)]),
        sessionId: "s1")
      guard case let .media(model) = rows.last(where: { if case .media = $0 { true } else { false } }) else { return nil }
      return model.thumbnails.first?.key
    }
    let before = key(red)
    let after = key(green)
    #expect(before != nil && after != nil)
    #expect(before != after, "ta sama pozycja m3.1, inna treść = inny klucz (pamięć i tożsamość kafla)")
    #expect(key(red) == before, "ta sama treść = ten sam klucz między renderami")
  }

  @Test("pamięć miniatur jest jedna na proces: ten sam klucz kafla w dwóch sesjach to dwa różne wpisy")
  func cacheKeySeparatesSessions() {
    let upload = MediaThumbnail(key: "u:\(photo)", source: .upload(file: photo), label: "Zdjęcie 1", bytes: 0)
    let inline = MediaThumbnail(key: "i:m3.1.0:ab", source: .inline(dataUrl: "data:,"), label: "Obrazek", bytes: 0)
    for thumbnail in [upload, inline] {
      #expect(thumbnail.cacheKey(sessionId: "s1") != thumbnail.cacheKey(sessionId: "s2"))
      #expect(thumbnail.cacheKey(sessionId: "s1") == thumbnail.cacheKey(sessionId: "s1"))
    }
  }
}

@Suite("miniatury: geometria kafla i dekodowanie")
struct ThumbnailDecodingTests {
  @Test("kafel w proporcji zdjęcia: szerokość 48…256 pt, wysokość 48…96 pt, bez pustych pasów")
  func geometry() {
    // W granicach: dokładna proporcja (pełna wysokość albo sufit szerokości i niższy kafel).
    #expect(ThumbnailGeometry.tileSize(pixelWidth: 400, pixelHeight: 200) == CGSize(width: 192, height: 96))
    #expect(ThumbnailGeometry.tileSize(pixelWidth: 300, pixelHeight: 300) == CGSize(width: 96, height: 96))
    #expect(ThumbnailGeometry.tileSize(pixelWidth: 240, pixelHeight: 360) == CGSize(width: 64, height: 96))
    #expect(ThumbnailGeometry.tileSize(pixelWidth: 1000, pixelHeight: 250) == CGSize(width: 256, height: 64))
    // Szeroki zrzut wiersza listy z odbioru (≈ 5,4:1) i pasek 20:1 — najniższy kafel, obraz przycięty.
    #expect(ThumbnailGeometry.tileSize(pixelWidth: 1200, pixelHeight: 220) == CGSize(width: 256, height: 48))
    #expect(ThumbnailGeometry.tileSize(pixelWidth: 4000, pixelHeight: 200) == CGSize(width: 256, height: 48))
    // Wąski pasek: najwęższy kafel na pełną wysokość, obraz przycięty.
    #expect(ThumbnailGeometry.tileSize(pixelWidth: 100, pixelHeight: 1000) == CGSize(width: 48, height: 96))
    #expect(ThumbnailGeometry.tileSize(pixelWidth: 0, pixelHeight: 0) == CGSize(width: 96, height: 96))
  }

  @Test("piksele miniatury: krótszy bok przyciętego obrazu pokrywa kafel @3x, bez powiększania, ≤ 2048")
  func decodePixels() {
    #expect(ThumbnailGeometry.decodePixels(pixelWidth: 2000, pixelHeight: 500) == ThumbnailGeometry.maxPixels)
    #expect(ThumbnailGeometry.decodePixels(pixelWidth: 30, pixelHeight: 20) == 30)
    // 6000×300 w kaflu 256×48: wysokość 144 px potrzebuje 2880 px szerokości — sufit 2048.
    #expect(ThumbnailGeometry.decodePixels(pixelWidth: 6000, pixelHeight: 300) == 2048)
    // 100×1000 w kaflu 48×96: szerokość 144 px = obraz bez zmniejszania (1000 px).
    #expect(ThumbnailGeometry.decodePixels(pixelWidth: 100, pixelHeight: 1000) == 1000)
    #expect(ThumbnailGeometry.decodePixels(pixelWidth: 300, pixelHeight: 3000) == 1440)
  }

  @Test("data URL → bajty; sygnatura daje rozszerzenie podglądu; zły kształt → nil")
  func bytesAndExtension() throws {
    let data = try png(width: 3, height: 3)
    #expect(ThumbnailDecoder.bytes(ofDataURL: "data:image/png;base64,\(data.base64EncodedString())") == data)
    #expect(ThumbnailDecoder.bytes(ofDataURL: "data:text/plain;base64,AAAA") == nil)
    #expect(ThumbnailDecoder.fileExtension(of: data) == "png")
    #expect(ThumbnailDecoder.fileExtension(of: Data([0xFF, 0xD8, 0xFF, 0xE1])) == "jpg")
    #expect(ThumbnailDecoder.fileExtension(of: Data("<html>".utf8)) == nil)
  }

  @Test("miniatura: dłuższy bok przycięty do sufitu pikseli, proporcja zachowana; śmieci → nil")
  func decode() async throws {
    let wide = try png(width: 2000, height: 500)
    let thumbnail = try #require(await ThumbnailDecoder.thumbnail(wide))
    #expect(thumbnail.image.width == ThumbnailGeometry.maxPixels)
    #expect(thumbnail.image.height == ThumbnailGeometry.maxPixels / 4)
    let small = try #require(await ThumbnailDecoder.thumbnail(try png(width: 30, height: 20)))
    #expect(small.image.width == 30 && small.image.height == 20, "bez powiększania")
    #expect(await ThumbnailDecoder.thumbnail(Data("nie obraz".utf8)) == nil)
  }
}
