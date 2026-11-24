import CoreGraphics
import Foundation
import ImageIO
import RarogContract
import RarogCore
@testable import RarogUI
import Testing
import UniformTypeIdentifiers

// Wysyłka załączników w RarogUI: reguły załączników, przygotowanie zdjęć, przyjęcie paczki,
// wiersze kolejki z miejscem i postępem, zdania.

private func scratch() throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "rarog-ui-tests/\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

/// Obraz testowy: `noise` = szum (nie kompresuje się), inaczej gradient; `alpha` = przezroczyste tło.
private func image(width: Int, height: Int, noise: Bool = false, alpha: Bool = false, type: UTType = .png, in dir: URL) throws -> URL {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  if !alpha {
    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  }
  if noise, let data = context.data {
    let pixels = data.bindMemory(to: UInt32.self, capacity: width * height)
    var value: UInt32 = 12345
    for index in 0..<(width * height) {
      value = value &* 1_103_515_245 &+ 12345
      pixels[index] = value | 0xFF00_0000
    }
  }
  // Czerwony kwadrat w rogu — po zmniejszeniu reszta tła przezroczystego ma być biała.
  context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: width / 4, height: height / 4))
  let url = dir.appending(path: "\(UUID().uuidString).\(type.preferredFilenameExtension ?? "img")")
  let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
  CGImageDestinationAddImage(destination, try #require(context.makeImage()), nil)
  #expect(CGImageDestinationFinalize(destination))
  return url
}

private func decoded(_ data: Data) throws -> CGImage {
  let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
  return try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
}

/// Kolor piksela (R, G, B) z obrazu narysowanego do bufora sRGB.
private func pixel(_ image: CGImage, x: Int, y: Int) -> (Int, Int, Int) {
  var buffer = [UInt8](repeating: 0, count: 4)
  let context = CGContext(
    data: &buffer, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  context.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
  return (Int(buffer[0]), Int(buffer[1]), Int(buffer[2]))
}

@Suite("załączniki: nazwy, typy, limity")
struct AttachmentRulesTests {
  @Test("nazwa pliku: separatory na „-”, bez znaków sterujących, pusta → „plik”, 120 jednostek z rozszerzeniem")
  func sanitize() {
    #expect(AttachmentNames.sanitize("../../.ssh/id\\x") == "..-..-.ssh-id-x")
    #expect(AttachmentNames.sanitize("ra\u{1B}[31mport\u{7F}.pdf") == "ra[31mport.pdf")
    #expect(AttachmentNames.sanitize("  \n ") == "plik")
    let long = String(repeating: "a", count: 200) + ".pdf"
    let cut = AttachmentNames.sanitize(long)
    #expect(cut.utf16.count == 120 && cut.hasSuffix(".pdf"))
    // Emoji to dwie jednostki UTF-16 (`length` w JS): limit liczony tak jak na serwerze, bez połówek znaku.
    let emoji = AttachmentNames.sanitize(String(repeating: "😀", count: 70) + ".txt")
    #expect(emoji.utf16.count <= 120 && emoji.hasSuffix(".txt") && emoji.unicodeScalars.allSatisfy { $0.value != 0xFFFD })
    // Rozszerzenie dłuższe niż 12 znaków to nie rozszerzenie.
    #expect(AttachmentNames.sanitize(String(repeating: "b", count: 130) + ".bardzodlugierozszerzenie").utf16.count == 120)
  }

  @Test("typ MIME z rozszerzenia, w kształcie kontraktu; nieznany → application/octet-stream")
  func mime() {
    #expect(AttachmentNames.mime(forName: "raport.pdf") == "application/pdf")
    #expect(AttachmentNames.mime(forName: "notatki.txt") == "text/plain")
    #expect(AttachmentNames.mime(forName: "bez-rozszerzenia") == "application/octet-stream")
    #expect(AttachmentNames.mime(forName: "x.zzzqqq") == "application/octet-stream")
    #expect(AttachmentNames.named(nil, type: .png) == "plik.png")
    #expect(AttachmentNames.named("Zrzut", type: .png) == "Zrzut.png")
    #expect(AttachmentNames.named("log.txt", type: .plainText) == "log.txt")
  }

  @Test("limit liczony PO base64 (długość data URL-a, jak serwer)")
  func dataURL() {
    #expect(AttachmentLimits.base64Length(3) == 4)
    #expect(AttachmentLimits.base64Length(4) == 8)
    #expect(AttachmentLimits.dataURLLength(mime: "image/jpeg", bytes: 3) == "data:image/jpeg;base64,AAAA".count)
    // 20 MB pliku mieści się pod 27 MB data URL-a (nierówność z PWA).
    #expect(AttachmentLimits.dataURLLength(mime: "application/pdf", bytes: AttachmentLimits.maxFileBytes) <= AttachmentLimits.maxFileDataURL)
  }

  @Test("rodzaj elementu schowka: obraz → zdjęcie, PDF → plik, tekst/adres/RTFD z tekstem → wklejenie tekstu")
  func classify() {
    #expect(AttachmentCandidate.classify(["public.jpeg"])?.kind == .image)
    #expect(AttachmentCandidate.classify(["public.heic", "public.jpeg"])?.kind == .image)
    #expect(AttachmentCandidate.classify(["public.png", "public.url"])?.kind == .image)
    #expect(AttachmentCandidate.classify(["com.adobe.pdf"])?.kind == .file)
    #expect(AttachmentCandidate.classify(["public.zip-archive"])?.kind == .file)
    #expect(AttachmentCandidate.classify(["public.utf8-plain-text", "public.url"]) == nil)
    #expect(AttachmentCandidate.classify(["com.apple.flat-rtfd", "public.utf8-plain-text"]) == nil)
    #expect(AttachmentCandidate.classify(["public.url"]) == nil)
  }

  @Test("element z PLIKU (adres pliku obok treści): PDF i plik tekstowy to pliki z typem treści, nie adresu")
  func classifyFileBacked() {
    let pdf = AttachmentCandidate.classify(["com.adobe.pdf", "public.file-url"])
    #expect(pdf?.kind == .file && pdf?.type == .pdf)
    let text = AttachmentCandidate.classify(["public.plain-text", "public.file-url"])
    #expect(text?.kind == .file && text?.type == .plainText)
    // Treść pliku ważniejsza niż tekst obok niej (np. nazwa pliku jako tekst).
    let both = AttachmentCandidate.classify(["public.utf8-plain-text", "public.file-url", "com.adobe.pdf"])
    #expect(both?.type == .pdf)
    // Sam adres pliku bez treści nie ma czego wczytać: wkleja się jako tekst.
    #expect(AttachmentCandidate.classify(["public.file-url"]) == nil)
    // Zwykły adres (Safari) obok tekstu dalej wkleja tekst.
    #expect(AttachmentCandidate.classify(["public.url", "public.utf8-plain-text"]) == nil)
  }

  @Test("dostawca z Plików („otwórz w miejscu”) z plikiem tekstowym → plik; tekst z Notatek → wklejenie tekstu")
  func providerFileOrText() async throws {
    let dir = try scratch()
    let source = dir.appending(path: "notatki.md")
    try Data("# lista\n- a".utf8).write(to: source)
    let file = NSItemProvider()
    file.suggestedName = "notatki.md"
    file.registerFileRepresentation(forTypeIdentifier: UTType.plainText.identifier, fileOptions: [.openInPlace], visibility: .all) {
      completion in
      completion(source, true, nil)
      return nil
    }
    let candidate = try #require(AttachmentCandidate.from(file), "plik tekstowy z Plików to załącznik")
    #expect(candidate.kind == .file && candidate.name == "notatki.md")
    #expect(try Data(contentsOf: try await candidate.load()) == Data("# lista\n- a".utf8))

    // Tekst skopiowany z Notatek: te same typy treści, ale bez pliku — wkleja się do pola.
    let note = NSItemProvider()
    for type in [UTType.flatRTFD, .utf8PlainText] {
      note.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { completion in
        completion(Data("tekst".utf8), nil)
        return nil
      }
    }
    #expect(AttachmentCandidate.from(note) == nil)
  }
}

@Suite("zdjęcie do wysłania: JPEG, ≤ 2048 px, ≤ 1,5 MB po base64")
struct ImagePreparerTests {
  @Test("duży PNG z przezroczystością → JPEG 2048 px, białe tło zamiast czarnej plamy")
  func pngWithAlpha() throws {
    let source = try image(width: 4000, height: 2000, alpha: true, in: try scratch())
    let prepared = try ImagePreparer.prepare(source)
    #expect(prepared.width == 2048 && prepared.height == 1024)
    let jpeg = try decoded(prepared.jpeg)
    #expect(CGImageSourceGetType(CGImageSourceCreateWithData(prepared.jpeg as CFData, nil)!) as String? == UTType.jpeg.identifier)
    let (r, g, b) = pixel(jpeg, x: 1800, y: 100)
    #expect(r > 240 && g > 240 && b > 240, "przezroczystość = białe tło, jest (\(r), \(g), \(b))")
    #expect(AttachmentLimits.dataURLLength(mime: "image/jpeg", bytes: prepared.jpeg.count) <= AttachmentLimits.maxImageDataURL)
  }

  @Test("małe zdjęcie nie jest powiększane")
  func noUpscale() throws {
    let prepared = try ImagePreparer.prepare(try image(width: 300, height: 120, in: try scratch()))
    #expect(prepared.width == 300 && prepared.height == 120)
  }

  @Test("szum (nie kompresuje się) schodzi drabinką do limitu albo daje jasną odmowę z wagą")
  func ladder() throws {
    let source = try image(width: 3000, height: 3000, noise: true, in: try scratch())
    do {
      let prepared = try ImagePreparer.prepare(source)
      #expect(AttachmentLimits.dataURLLength(mime: "image/jpeg", bytes: prepared.jpeg.count) <= AttachmentLimits.maxImageDataURL)
      #expect(max(prepared.width, prepared.height) <= 2048)
    } catch {
      guard case let .tooLarge(bytes) = error else {
        Issue.record("oczekiwano tooLarge, jest \(error)")
        return
      }
      #expect(bytes > AttachmentLimits.maxImageDataURL)
    }
  }

  @Test("HEIC → JPEG (gdy system ma koder HEIC)")
  func heic() throws {
    let dir = try scratch()
    let types = (CGImageDestinationCopyTypeIdentifiers() as? [String]) ?? []
    guard types.contains(UTType.heic.identifier) else { return }
    let prepared = try ImagePreparer.prepare(try image(width: 2500, height: 1200, type: .heic, in: dir))
    #expect(prepared.width == 2048)
    #expect(CGImageSourceGetType(CGImageSourceCreateWithData(prepared.jpeg as CFData, nil)!) as String? == UTType.jpeg.identifier)
  }

  /// Kafel paska wypełnia kwadrat (`scaleAspectFill`), więc ostrość daje KRÓTSZY bok. Liczony z dłuższego
  /// (`tile × 3`) szeroki zrzut dostawał 42 px na kafel 168 px i był rozmazany.
  @Test("miniatura kafla: krótszy bok ≥ boku kafla, bez powiększania, dłuższy pod sufitem")
  func tileThumbnail() throws {
    let dir = try scratch()
    let wide = try #require(ImagePreparer.tileThumbnail(of: try image(width: 4000, height: 1000, in: dir), side: 168))
    #expect(min(wide.width, wide.height) >= 168, "szeroki: \(wide.width)×\(wide.height)")
    #expect(max(wide.width, wide.height) <= 4 * 168 + 1, "bez nadmiaru: \(wide.width)×\(wide.height)")
    let tall = try #require(ImagePreparer.tileThumbnail(of: try image(width: 945, height: 2048, in: dir), side: 168))
    #expect(min(tall.width, tall.height) >= 168, "zrzut z telefonu: \(tall.width)×\(tall.height)")
    let small = try #require(ImagePreparer.tileThumbnail(of: try image(width: 100, height: 80, in: dir), side: 168))
    #expect(small.width == 100 && small.height == 80, "małego nie powiększa")
    let strip = try #require(ImagePreparer.tileThumbnail(of: try image(width: 8000, height: 200, in: dir), side: 168))
    #expect(max(strip.width, strip.height) <= ImagePreparer.tileThumbnailCeiling, "panorama pod sufitem pamięci")
  }

  @Test("śmieć zamiast obrazu → unreadable")
  func garbage() throws {
    let url = try scratch().appending(path: "zly.png")
    try Data("to nie jest png".utf8).write(to: url)
    #expect(throws: ImageRejection.unreadable) { try ImagePreparer.prepare(url) }
  }
}

@Suite("przyjęcie paczki: limity na wiadomość, odrzucenia z powodem")
struct AttachmentIntakeTests {
  private func candidate(_ url: URL, kind: ComposerAttachment.Kind, name: String? = nil) -> AttachmentCandidate {
    AttachmentCandidate(kind: kind, name: name ?? url.lastPathComponent, type: UTType(filenameExtension: url.pathExtension)) {
      try AttachmentStaging.copy(url)
    }
  }

  @Test("6 zdjęć przy 1 w pasku: 4 dodane, 2 „za dużo”; slot zajmuje tylko udane")
  func imageLimit() async throws {
    let dir = try scratch()
    var candidates = [candidate(dir.appending(path: "zepsute.png"), kind: .image)]
    try Data("x".utf8).write(to: dir.appending(path: "zepsute.png"))
    for _ in 0..<6 { candidates.append(candidate(try image(width: 64, height: 64, in: dir), kind: .image)) }
    let existing = [ComposerAttachment(kind: .image, name: "", mime: "image/jpeg", bytes: 10, file: dir.appending(path: "a"))]
    let result = await AttachmentIntake.process(candidates, existing: existing)
    #expect(result.added.count == 4)
    #expect(result.added.allSatisfy { $0.kind == .image && $0.mime == "image/jpeg" && $0.file.pathExtension == "jpg" })
    #expect(result.rejections.map(\.reason) == [.unreadable, .tooMany, .tooMany])
  }

  @Test("plik: pusty → nie do wczytania, > 20 MB → za duży, dobry → bajt w bajt z nazwą po sanityzacji")
  func files() async throws {
    let dir = try scratch()
    let empty = dir.appending(path: "pusty.txt")
    try Data().write(to: empty)
    let big = dir.appending(path: "duzy.bin")
    FileManager.default.createFile(atPath: big.path, contents: nil)
    let handle = try FileHandle(forWritingTo: big)
    try handle.truncate(atOffset: UInt64(AttachmentLimits.maxFileBytes + 1))
    try handle.close()
    let good = dir.appending(path: "raport.pdf")
    try Data("%PDF-1.7 treść".utf8).write(to: good)
    let result = await AttachmentIntake.process([
      candidate(empty, kind: .file), candidate(big, kind: .file), candidate(good, kind: .file, name: "a/b\u{7}.pdf"),
    ], existing: [])
    #expect(result.rejections.map(\.reason) == [.unreadable, .tooLarge(bytes: AttachmentLimits.maxFileBytes + 1)])
    let added = try #require(result.added.first)
    #expect(added.name == "a-b.pdf" && added.mime == "application/pdf" && added.bytes == Data("%PDF-1.7 treść".utf8).count)
    #expect(try Data(contentsOf: added.file) == Data("%PDF-1.7 treść".utf8))
  }

  @Test("piąty plik przy czterech w pasku: „za dużo”, bez wczytywania")
  func fileLimit() async throws {
    let existing = (0..<4).map { index in
      ComposerAttachment(kind: .file, name: "\(index).txt", mime: "text/plain", bytes: 1, file: URL(filePath: "/dev/null"))
    }
    let loaded = LoadCounter()
    let result = await AttachmentIntake.process([
      AttachmentCandidate(kind: .file, name: "piaty.txt", type: .plainText) {
        loaded.hit()
        throw CocoaError(.fileReadUnknown)
      },
    ], existing: existing)
    #expect(result.rejections == [AttachmentRejection(kind: .file, name: "piaty.txt", reason: .tooMany)])
    #expect(loaded.count == 0)
  }
}

@Suite("zdania wysyłki z załącznikami i postępu")
struct SendCopyTests {
  @Test("start agenta: pole przyjmuje tekst bez zdania pod sobą, wysyłka czeka; zgoda zaufania mówi o decyzji")
  func startingComposer() {
    let starting = Sample.state(session: Sample.session(state: "starting"), messages: [])
    #expect(ComposerModel.make(state: starting, sessionId: "s1") == ComposerModel(
      editable: true, reason: nil, sendable: false))
    let refused = UICopy.sendResult(.blocked(.starting), session: starting.sessions["s1"])
    #expect(refused.text == "Uruchamiam agenta… Wyślesz, gdy będzie gotowy." && !refused.isError && refused.restore)
    let trust = Sample.state(session: Sample.session(state: "waiting-permission"), messages: [])
    let decision = ComposerModel.make(state: trust, sessionId: "s1")
    #expect(!decision.editable && !decision.sendable && decision.reason != UICopy.sendBlock(.starting, session: nil))
    let failed = Sample.state(session: Sample.session(state: "error"), messages: [])
    #expect(!ComposerModel.make(state: failed, sessionId: "s1").sendable)
    for state in ["running", "waiting-input"] {
      let ready = Sample.state(session: Sample.session(state: state), messages: [])
      let model = ComposerModel.make(state: ready, sessionId: "s1")
      #expect(model == ComposerModel(editable: true, reason: nil) && model.sendable, "\(state)")
    }
  }

  @Test("stan miniatury dla czytnika (bez podpisu etapu pod miniaturami)")
  func progress() {
    #expect(UICopy.pendingTile(.progress(0.3529)) == "w drodze, 35\u{00A0}%")
    #expect(UICopy.pendingTile(.indeterminate) == "w drodze")
    #expect(UICopy.pendingTile(.awaitingResponse) == "wysłane, czekam na serwer")
    #expect(UICopy.pendingTile(.unconfirmed) == "nie potwierdzono")
    #expect(UICopy.pendingTile(.refused) == "nie wysłano")
    #expect(UICopy.pendingTile(.none) == nil)
  }

  @Test("bajty jak w PWA: „840 kB”, „2,1 MB”, „20 MB”")
  func bytes() {
    #expect(UICopy.bytes(860_000) == "840\u{00A0}kB")
    #expect(UICopy.bytes(2_202_009) == "2,1\u{00A0}MB")
    #expect(UICopy.bytes(AttachmentLimits.maxFileBytes) == "20\u{00A0}MB")
    #expect(UICopy.bytes(AttachmentLimits.maxImageDataURL) == "1,5\u{00A0}MB")
  }

  @Test("odrzucenia: jedno zdanie na powód, zdjęcia przed plikami")
  func rejections() {
    let lines = UICopy.attachmentRejections([
      .init(kind: .file, name: "duzy.zip", reason: .tooLarge(bytes: 25 * 1024 * 1024)),
      .init(kind: .image, name: "", reason: .tooMany),
      .init(kind: .image, name: "", reason: .tooMany),
      .init(kind: .image, name: "IMG_1.HEIC", reason: .unreadable),
    ])
    #expect(lines == [
      "Najwyżej 5\u{00A0}zdjęć w wiadomości — pominięto 2\u{00A0}zdjęcia.",
      "Nie udało się wczytać: „IMG_1.HEIC”.",
      "„duzy.zip” waży 25\u{00A0}MB — limit to 20\u{00A0}MB na plik.",
    ])
  }

  @Test("odmowy ostateczne mają własne zdania; konflikt identyfikatora klienta wraca do pola z jasnym zdaniem")
  func refusals() {
    #expect(UICopy.refusal(code: OutboxEntry.RefusalCode.attachmentMissing, message: nil) == UICopy.attachmentMissing)
    #expect(UICopy.refusal(code: "client-id-conflict", message: "Ten identyfikator ma inną treść.") == UICopy.clientIdConflict)
    #expect(UICopy.refusal(code: "rate-limited", message: "Za szybko.") == "Za szybko.")
    let result = UICopy.sendResult(.refused(UUID(), code: "client-id-conflict", message: "x"), session: nil)
    #expect(result.text == "\(UICopy.clientIdConflict) Wiadomość wróciła do pola." && result.restore)
  }
}

@Suite("wiersze kolejki: załączniki, postęp, odmowa bez „Ponów”")
struct PendingRowsTests {
  @Test("wpis z załącznikami: tekst, miniatury (zdjęcie → „Zdjęcie 1”, plik → nazwa), bez wiersza statusu")
  func withAttachments() {
    var state = Sample.state(session: Sample.session())
    let first = OutboxEntry(
      sessionId: "s1", text: "zobacz",
      attachments: [.init(name: "", bytes: 10, kind: .image), .init(name: "log.txt", bytes: 3)], createdAt: Sample.now)
    let second = OutboxEntry(sessionId: "s1", text: "", attachments: [.init(name: "a.pdf", bytes: 3)], createdAt: Sample.now)
    state.outbox = [first, second]
    // Tekst wpisu niesie granicę tury i cechę nagłówka, miniatury pod nim — godzinę (ostatni wiersz wiadomości).
    let clock = Sample.pendingPrompt().clock
    #expect(TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar) == [
      .empty(text: "Agent pracuje — jeszcze nic nie napisał.", sub: "Przy większym zadaniu potrafi myśleć pół minuty."),
      .pending(entry: first.id, voice: .user, text: "zobacz", turn: TurnMark(gap: .turn, promptHead: true)),
      .attachments(PendingMediaModel(
        id: "a\(first.id.uuidString)", entry: first.id, voice: nil,
        tiles: [
          PendingTile(key: "o:\(first.id.uuidString).0", kind: .photo, label: "Zdjęcie 1", file: nil, bytes: 10),
          PendingTile(key: "o:\(first.id.uuidString).1", kind: .file, label: "log.txt", file: nil, bytes: 3),
        ],
        indicator: .indeterminate, turn: TurnMark(gap: .underPlate, clock: clock))),
      // Sam załącznik bez tekstu: bez pustej plamy tekstu, etykieta głosu na wierszu załączników.
      .attachments(PendingMediaModel(
        id: "a\(second.id.uuidString)", entry: second.id, voice: nil,
        tiles: [PendingTile(key: "o:\(second.id.uuidString).0", kind: .file, label: "a.pdf", file: nil, bytes: 3)],
        indicator: .indeterminate, turn: Sample.pendingPrompt())),
    ])
  }

  @Test("wpis w locie bez wiersza statusu, przed 202 i po nim; brak pliku treści → odmowa bez „Ponów”")
  func progressAndFinal() {
    var state = Sample.state(session: Sample.session())
    let sending = OutboxEntry(sessionId: "s1", text: "duże", attachments: [.init(name: "a.pdf", bytes: 3)], createdAt: Sample.now)
    let broken = OutboxEntry(
      sessionId: "s1", text: "zepsute", attachments: [.init(name: "b.pdf", bytes: 3)], createdAt: Sample.now,
      state: .refused(code: OutboxEntry.RefusalCode.attachmentMissing, message: nil))
    state.apply(.outboxEnqueued(sending), now: Sample.now)
    state.apply(.outboxEnqueued(broken), now: Sample.now)
    state.apply(.outboxProgress(sending.id, .uploading(sent: 500, total: 1000)), now: Sample.now)
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    #expect(!rows.contains { $0.id == "s\(sending.id.uuidString)" }, "w trakcie wysyłki bez wiersza statusu")
    #expect(rows.last == .pendingStatus(entry: broken.id, status: .refusedFinal(UICopy.attachmentMissing), retrying: false))
    state.apply(.outboxAccepted(sending.id, at: Sample.now), now: Sample.now)
    #expect(state.sendProgress.isEmpty, "po 202 podpis etapu znika")
    #expect(!TranscriptRows.build(state: state, sessionId: "s1").contains { $0.id == "s\(sending.id.uuidString)" },
            "po 202 też bez wiersza: w locie mówi poświata dymka")
  }

  @Test("sam załącznik po 202: kafel niesie poświatę i „w drodze” zamiast wiersza „w kolejce”")
  func attachmentOnlyAwaitsEcho() {
    var state = Sample.state(session: Sample.session())
    let photoOnly = OutboxEntry(
      sessionId: "s1", text: "", attachments: [.init(name: "", bytes: 10, kind: .image)], createdAt: Sample.now)
    let withText = OutboxEntry(sessionId: "s1", text: "opis", attachments: [.init(name: "a.pdf", bytes: 3)], createdAt: Sample.now)
    // The session screen's stream is open: without it the entry's deadline waits (`AppState.waitsForOpenStream`).
    state.viewedSessionId = "s1"
    state.sessionStream = .online
    for entry in [photoOnly, withText] { state.apply(.outboxEnqueued(entry), now: Sample.now) }
    func media(_ id: UUID) -> PendingMediaModel? {
      for row in TranscriptRows.build(state: state, sessionId: "s1") {
        if case let .attachments(model) = row, model.entry == id { return model }
      }
      return nil
    }
    #expect(media(photoOnly.id)?.awaitingEcho == false, "przed 202 stan niesie pierścień")
    for entry in [photoOnly, withText] { state.apply(.outboxAccepted(entry.id, at: Sample.now), now: Sample.now) }
    #expect(media(photoOnly.id)?.awaitingEcho == true)
    #expect(media(withText.id)?.awaitingEcho == false, "z tekstem poświatę niesie dymek")
    #expect(UICopy.pendingTile(.none, awaitingEcho: true) == "w drodze")
    #expect(UICopy.pendingTile(.none) == nil)
    state.apply(.outboxUnconfirmedIfStillSent(photoOnly.id), now: Sample.now.addingTimeInterval(15))
    #expect(media(photoOnly.id)?.awaitingEcho == false, "„Nie potwierdzono”: ostrzeżenie zamiast poświaty")
  }

  @Test("pasek nad polem: zdjęcia przed plikami, limity wiadomości po przywróceniu")
  func counts() {
    let url = URL(filePath: "/dev/null")
    let file = ComposerAttachment(kind: .file, name: "a.txt", mime: "text/plain", bytes: 1, file: url)
    let photo = ComposerAttachment(kind: .image, name: "", mime: "image/jpeg", bytes: 1, file: url)
    #expect(AttachmentCounts.ordered([file, photo]).map(\.kind) == [.image, .file])
    #expect(AttachmentCounts.withinLimits(Array(repeating: photo, count: 5) + Array(repeating: file, count: 4)))
    #expect(!AttachmentCounts.withinLimits(Array(repeating: photo, count: 6)))
  }

  @MainActor
  @Test("półka sesji: niewysłane załączniki przeżywają nawigację; nieudane wracają na początek")
  func shelf() {
    let shelf = AttachmentShelf()
    let url = URL(filePath: "/dev/null")
    let kept = ComposerAttachment(kind: .file, name: "zostaje.txt", mime: "text/plain", bytes: 1, file: url)
    let failed = ComposerAttachment(kind: .file, name: "nieudany.txt", mime: "text/plain", bytes: 1, file: url)
    shelf.restore([kept], for: "s1")
    #expect(shelf.attachments(for: "s2").isEmpty)
    shelf.restore([failed], for: "s1")
    #expect(shelf.attachments(for: "s1").map(\.name) == ["nieudany.txt", "zostaje.txt"])
    shelf.remove([failed.id, kept.id], for: "s1")
    #expect(shelf.attachments(for: "s1").isEmpty)
  }

  /// Regresja: s1 → s2 → s1 w trakcie wysyłki. Nowy pasek przeczytał pustą półkę,
  /// przywrócenie z zamkniętego ekranu go nie budziło, a jego następna zmiana nadpisywała półkę.
  @MainActor
  @Test("przywrócenie z zamkniętego ekranu dociera do paska otwartego w międzyczasie; jego zmiany go nie kasują")
  func restoreReachesReopenedStrip() {
    let shelf = AttachmentShelf()
    let url = URL(filePath: "/dev/null")
    let sent = ComposerAttachment(kind: .image, name: "", mime: "image/jpeg", bytes: 1, file: url)
    let added = ComposerAttachment(kind: .file, name: "nowy.txt", mime: "text/plain", bytes: 1, file: url)
    // Pierwszy ekran wysyła: załącznik schodzi z półki.
    shelf.restore([sent], for: "s1")
    shelf.remove([sent.id], for: "s1")
    // Drugi ekran tej sesji rysuje półkę (pustą) i słucha jej zmian.
    var strip: [String] = shelf.attachments(for: "s1").map(\.name)
    var redraws = 0
    shelf.watch("s1") {
      redraws += 1
      strip = shelf.attachments(for: "s1").map { $0.kind == .image ? "zdjęcie" : $0.name }
    }
    // Wysyłka z pierwszego ekranu wraca odmową już po jego zamknięciu.
    shelf.restore([sent], for: "s1")
    #expect(redraws == 1 && strip == ["zdjęcie"], "otwarty pasek pokazuje przywrócone od razu")
    // Człowiek dokłada plik i wysyła tylko to, co sam dołożył: przywrócone zostaje.
    shelf.restore([added], for: "s1")
    shelf.remove([added.id], for: "s1")
    #expect(shelf.attachments(for: "s1").map(\.id) == [sent.id])
    #expect(strip == ["zdjęcie"])
  }

  @MainActor
  @Test("wczytanie należy do półki: ekran zamknięty w trakcie → po powrocie wynik na półce, plik żyje")
  func loadOutlivesScreen() async throws {
    let shelf = AttachmentShelf()
    let (slow, gate) = try slowFile("raport.pdf")
    var closing: LoadProbe? = LoadProbe()
    shelf.observe("s1") { [weak closing] result in closing?.results.append(result) }
    #expect(shelf.ingest([slow], for: "s1"))
    #expect(shelf.isLoading("s1"))
    #expect(!shelf.ingest([slow], for: "s1"), "druga paczka w trakcie: „Chwila…”")
    // Ekran sesji znika w trakcie wczytywania (inna sesja), wczytanie kończy się bez niego.
    closing = nil
    await gate.release()
    await shelf.loaded("s1")
    #expect(!shelf.isLoading("s1"))
    // Powrót do sesji: nowy pasek czyta półkę.
    let back = shelf.attachments(for: "s1")
    #expect(back.map(\.name) == ["raport.pdf"])
    #expect(FileManager.default.fileExists(atPath: try #require(back.first).file.path), "plik roboczy nie skasowany")
  }

  /// „Zapomnij serwer” i parowanie z innym serwerem: półka procesu przeżyłaby przebudowę interfejsu.
  @MainActor
  @Test("removeAll: półka pusta, otwarty pasek dostaje zmianę, spóźnione wczytanie nie ląduje na półce")
  func removeAllForgetsShelf() async throws {
    let shelf = AttachmentShelf()
    let source = try scratch().appending(path: "stary.txt")
    try Data("stary".utf8).write(to: source)
    let old = ComposerAttachment(kind: .file, name: "stary.txt", mime: "text/plain", bytes: 5, file: try AttachmentStaging.copy(source))
    shelf.restore([old], for: "s1")
    var redraws = 0
    shelf.watch("s1") { redraws += 1 }
    let (slow, gate) = try slowFile("w-trakcie.txt")
    #expect(shelf.ingest([slow], for: "s2"))
    shelf.removeAll()
    #expect(shelf.attachments(for: "s1").isEmpty && redraws == 1)
    #expect(!FileManager.default.fileExists(atPath: old.file.path), "the staged file of a shelf item leaves the disk")
    #expect(!shelf.isLoading("s2"), "wczytywanie odwołane")
    await gate.release()
    try await Task.sleep(for: .milliseconds(50))
    #expect(shelf.attachments(for: "s2").isEmpty, "wynik sprzed removeAll przepada")
  }

  /// A load cancelled by `removeAll` still finishes: its staged file belongs to nobody and must not stay on disk.
  @MainActor
  @Test("removeAll during a load: the late file leaves the disk, the files of the next load stay")
  func removeAllDeletesLateFile() async throws {
    let shelf = AttachmentShelf()
    let late = StagedFiles()
    let (slow, gate) = try slowFile("late.txt", staged: late)
    #expect(shelf.ingest([slow], for: "s1"))
    shelf.removeAll()
    let (fresh, freshGate) = try slowFile("fresh.txt")
    #expect(shelf.ingest([fresh], for: "s1"), "the next load starts at once")
    await freshGate.release()
    await shelf.loaded("s1")
    let kept = try #require(shelf.attachments(for: "s1").first)
    await gate.release()
    let gone = { !late.urls.isEmpty && late.urls.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) } }
    for _ in 0..<300 where !gone() { try await Task.sleep(for: .milliseconds(5)) }
    let lateFile = try #require(late.urls.first, "the late load produced its file")
    #expect(!FileManager.default.fileExists(atPath: lateFile.path), "the late file leaves the disk")
    #expect(shelf.attachments(for: "s1").map(\.name) == ["fresh.txt"], "the late result does not land on the shelf")
    #expect(FileManager.default.fileExists(atPath: kept.file.path), "the file of the next load stays")
  }

  @MainActor
  @Test("powrót w trakcie wczytywania: nowy pasek widzi „wczytuję” i dostaje wynik; zdjęte w trakcie nie wraca")
  func reopenedScreenGetsResult() async throws {
    let shelf = AttachmentShelf()
    let url = URL(filePath: "/dev/null")
    let removed = ComposerAttachment(kind: .file, name: "zdjety.txt", mime: "text/plain", bytes: 1, file: url)
    shelf.restore([removed], for: "s1")
    let (slow, gate) = try slowFile("log.txt")
    let first = LoadProbe()
    shelf.observe("s1") { [weak first] result in first?.results.append(result) }
    #expect(shelf.ingest([slow], for: "s1"))
    // Nowy ekran tej sesji rejestruje się w trakcie; człowiek zdejmuje stary załącznik.
    let reopened = LoadProbe()
    shelf.observe("s1") { [weak reopened] result in reopened?.results.append(result) }
    #expect(shelf.isLoading("s1"))
    shelf.remove([removed.id], for: "s1")
    await gate.release()
    await shelf.loaded("s1")
    #expect(shelf.attachments(for: "s1").map(\.name) == ["log.txt"])
    #expect(reopened.results.map { $0.added.map(\.name) } == [["log.txt"]])
    #expect(first.results.isEmpty, "wynik idzie do otwartego paska, nie do zamkniętego")
  }

  /// Plik, którego wczytanie stoi, dopóki test nie otworzy zaworu.
  private func slowFile(_ name: String, staged: StagedFiles? = nil) throws -> (AttachmentCandidate, LoadGate) {
    let source = try scratch().appending(path: name)
    try Data("treść \(name)".utf8).write(to: source)
    let gate = LoadGate()
    let candidate = AttachmentCandidate(kind: .file, name: name, type: UTType(filenameExtension: source.pathExtension)) {
      await gate.wait()
      let file = try AttachmentStaging.copy(source)
      staged?.append(file)
      return file
    }
    return (candidate, gate)
  }
}

/// Pasek otwartego ekranu sesji w testach półki: zbiera wyniki wczytania.
@MainActor
private final class LoadProbe {
  var results: [AttachmentIntake.Result] = []
}

/// Zawór wczytania: `wait` stoi do `release`.
private actor LoadGate {
  private var open = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if open { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func release() {
    open = true
    for waiter in waiters { waiter.resume() }
    waiters.removeAll()
  }
}

private final class LoadCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var hits = 0
  func hit() { lock.withLock { hits += 1 } }
  var count: Int { lock.withLock { hits } }
}

/// Staged files a slow load produced, for a test that checks they left the disk.
private final class StagedFiles: @unchecked Sendable {
  private let lock = NSLock()
  private var files: [URL] = []
  func append(_ url: URL) { lock.withLock { files.append(url) } }
  var urls: [URL] { lock.withLock { files } }
}
