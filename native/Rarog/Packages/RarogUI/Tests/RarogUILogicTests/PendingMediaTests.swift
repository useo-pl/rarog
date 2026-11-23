import CoreGraphics
import Foundation
import ImageIO
import RarogContract
import RarogCore
@testable import RarogUI
import Testing
import UniformTypeIdentifiers

// Miniatury wpisu kolejki z pierścieniem postępu: nakładka ze stanu wpisu i etapu
// wysyłki, wiersze kolejki, przekazanie obrazu kaflom echa, miniatura z pliku na urządzeniu.
// Właściciel: wysyłka.

@Suite("miniatury wpisu kolejki: pierścień postępu, układ echa, przekazanie obrazu")
struct PendingMediaTests {
  @Test("nakładka: przygotowanie i przesył bez wielkości kręcą się, przesył wypełnia, 202 gasi, błąd ostrzega")
  func indicator() {
    #expect(PendingIndicator.make(state: .queued, progress: nil) == .indeterminate)
    #expect(PendingIndicator.make(state: .queued, progress: .encoding) == .indeterminate)
    #expect(PendingIndicator.make(state: .queued, progress: .uploading(sent: 250, total: 1000)) == .progress(0.25))
    #expect(PendingIndicator.make(state: .queued, progress: .uploading(sent: 1200, total: 1000)) == .progress(1))
    #expect(PendingIndicator.make(state: .queued, progress: .uploading(sent: -5, total: 1000)) == .progress(0))
    #expect(PendingIndicator.make(state: .queued, progress: .uploading(sent: 700, total: 0)) == .indeterminate)
    #expect(PendingIndicator.make(state: .queued, progress: .awaitingResponse) == .awaitingResponse)
    #expect(PendingIndicator.make(state: .sent(acceptedAt: Sample.now), progress: nil) == .none)
    #expect(PendingIndicator.make(state: .unconfirmed, progress: nil) == .unconfirmed)
    #expect(PendingIndicator.make(state: .refused(code: nil, message: "Nie."), progress: nil) == .refused)
    #expect(PendingIndicator.none.dims == false && PendingIndicator.awaitingResponse.dims)
    #expect(PendingIndicator.unconfirmed.warns && PendingIndicator.refused.warns)
    #expect(!PendingIndicator.indeterminate.warns && !PendingIndicator.progress(0.5).warns)
  }

  @Test("wiersze wpisu przez cały cykl: miniatury zamiast „Załączniki:”, podpis bez paska, 202 gasi pierścień")
  func lifecycleRows() throws {
    var state = Sample.state(session: Sample.session())
    let entry = OutboxEntry(
      sessionId: "s1", text: "zobacz",
      attachments: [
        .init(name: "", bytes: 3_400_000, kind: .image, mime: "image/jpeg", file: "0.jpg"),
        .init(name: "", bytes: 10, kind: .image, mime: "image/jpeg", file: "1.jpg"),
        .init(name: "", bytes: 7, kind: .file, mime: "application/pdf", file: "2.pdf"),
      ],
      createdAt: Sample.now)
    state.apply(.outboxEnqueued(entry), now: Sample.now)
    func media() -> PendingMediaModel? {
      TranscriptRows.build(state: state, sessionId: "s1").lazy.compactMap { row -> PendingMediaModel? in
        if case let .attachments(model) = row { return model }
        return nil
      }.first
    }
    let model = try #require(media())
    #expect(model.id == "a\(entry.id.uuidString)" && model.voice == nil, "etykieta głosu przy tekście")
    #expect(model.tiles.map(\.label) == ["Zdjęcie 1", "Zdjęcie 2", UICopy.fileFallbackName], "numeracja jak w echu")
    #expect(model.tiles.map(\.kind) == [.photo, .photo, .file])
    #expect(model.tiles.map(\.file) == ["0.jpg", "1.jpg", "2.pdf"])
    #expect(model.tiles.map(\.key) == (0..<3).map { "o:\(entry.id.uuidString).\($0)" })
    #expect(model.indicator == .indeterminate)

    state.apply(.outboxProgress(entry.id, .encoding), now: Sample.now)
    #expect(media()?.indicator == .indeterminate)
    #expect(!TranscriptRows.build(state: state, sessionId: "s1").contains { $0.id == "s\(entry.id.uuidString)" },
            "w trakcie wysyłki bez wiersza statusu — postęp niesie pierścień")
    state.apply(.outboxProgress(entry.id, .uploading(sent: 1_700_000, total: 3_400_000)), now: Sample.now)
    #expect(media()?.indicator == .progress(0.5))
    state.apply(.outboxProgress(entry.id, .awaitingResponse), now: Sample.now)
    #expect(media()?.indicator == .awaitingResponse)
    // Kolejność wiersza jak w echu: tekst i miniatury; podpisu etapu pod nimi nie ma.
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    #expect(rows.suffix(2).map(\.id) == ["o\(entry.id.uuidString)", "a\(entry.id.uuidString)"])

    state.apply(.outboxAccepted(entry.id, at: Sample.now), now: Sample.now)
    #expect(media()?.indicator == PendingIndicator.none, "202: przyciemnienie i pierścień gasną")
    state.apply(.outboxUnconfirmedIfStillSent(entry.id), now: Sample.now.addingTimeInterval(15))
    #expect(media()?.indicator == .unconfirmed)
    state.apply(.outboxRefused(entry.id, code: nil, message: "Za szybko."), now: Sample.now)
    #expect(media()?.indicator == .refused)
  }

  @Test("the stop in the ring: only while the send is in flight; a stop before the request warns, not in red")
  func stop() {
    let cancelled = OutboxEntry.State.refused(code: OutboxEntry.RefusalCode.cancelled, message: nil)
    #expect(PendingIndicator.make(state: cancelled, progress: nil) == .stopped)
    #expect(PendingIndicator.stopped.warns && PendingIndicator.stopped.dims)
    let inFlight: [PendingIndicator] = [.indeterminate, .progress(0.4), .awaitingResponse]
    let settled: [PendingIndicator] = [.none, .unconfirmed, .refused, .stopped]
    #expect(inFlight.map(\.stoppable) == [true, true, true])
    #expect(settled.map(\.stoppable) == [false, false, false, false])
    // Nothing went out: VoiceOver says "not sent", as for a refusal.
    #expect(UICopy.pendingTile(.stopped) == UICopy.pendingTile(.refused))
    #expect(UICopy.cancelSend == "Anuluj wysyłkę")
  }

  @Test("an entry stopped before the request: \"Sending stopped\" with Retry and Discard, not the refusal row")
  func stoppedRow() throws {
    var state = Sample.state(session: Sample.session())
    var entry = OutboxEntry(
      sessionId: "s1", text: "zobacz",
      attachments: [.init(name: "", bytes: 10, kind: .image, mime: "image/jpeg", file: "0.jpg")], createdAt: Sample.now)
    entry.state = .refused(code: OutboxEntry.RefusalCode.cancelled, message: nil)
    state.outbox = [entry]
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    #expect(rows.contains { row in
      if case .pendingStatus(entry.id, .stopped, false) = row { return true }
      return false
    }, "\(rows)")
    #expect(UICopy.sendStopped == "Wysyłka przerwana.")
    #expect(UICopy.refusal(code: OutboxEntry.RefusalCode.cancelled, message: nil) == UICopy.sendStopped)
  }

  @Test("układ echa: zdjęcia w pasku, pliki chipami echa (ta sama nazwa i waga), pozycje w kolejności wysyłki")
  func echoLayout() throws {
    let entry = OutboxEntry(
      sessionId: "s1", text: "",
      attachments: [
        .init(name: "", bytes: 48211, kind: .image, mime: "image/jpeg", file: "0.jpg"),
        .init(name: "raport.pdf", bytes: 182431, kind: .file, mime: "application/pdf", file: "1.pdf"),
        .init(name: "", bytes: 9, kind: .file, mime: "text/plain", file: "2.bin"),
      ],
      createdAt: Sample.now)
    let model = try #require(PendingMediaModel.make(entry: entry, voice: nil, progress: nil))
    #expect(model.photos.map(\.index) == [0] && model.files.map(\.index) == [1, 2])
    // Echo tych samych załączników (wizytówki z serwera) daje te same chipy — plik nie zmienia wymiarów.
    let echo = TranscriptRows.attachmentMedia([
      #"{"kind":"image","name":"","bytes":48211,"mime":"image/jpeg","file":"1790000000000-00000000000000aa.jpg"}"#,
      #"{"kind":"file","name":"raport.pdf","bytes":182431,"mime":"application/pdf"}"#,
      #"{"kind":"file","name":"","bytes":9,"mime":"text/plain"}"#,
    ].map { Sample.decode(MessageAttachment.self, $0) })
    #expect(model.files.map(\.tile.chip) == echo.chips)
    #expect(model.photos.map(\.tile.label) == echo.thumbnails.map(\.label))
  }

  @Test("sam załącznik bez tekstu: etykieta głosu na wierszu miniatur, wpis bez załączników — bez wiersza")
  func voiceAndTextOnly() {
    var state = Sample.state(session: Sample.session())
    let photo = OutboxEntry(
      sessionId: "s1", text: "", attachments: [.init(name: "", bytes: 1, kind: .image, file: "0.jpg")], createdAt: Sample.now)
    let text = OutboxEntry(sessionId: "s1", text: "sam tekst", createdAt: Sample.now)
    state.outbox = [photo, text]
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    guard case let .attachments(model) = rows.first(where: { $0.id == "a\(photo.id.uuidString)" }) else {
      Issue.record("brak wiersza miniatur: \(rows)")
      return
    }
    #expect(model.voice == .user)
    #expect(!rows.contains { $0.id == "a\(text.id.uuidString)" })
  }

  @Test("echo przejmuje zdekodowane miniatury wpisu: pary po numerze zdjęcia, z wygaszeniem tylko po nakładce")
  func handoff() throws {
    var state = Sample.state(session: Sample.session())
    let entry = OutboxEntry(
      sessionId: "s1", text: "trzy",
      attachments: [
        .init(name: "", bytes: 11, kind: .image, mime: "image/png", file: "0.png"),
        .init(name: "", bytes: 12, kind: .image, mime: "image/png", file: "1.png"),
        .init(name: "", bytes: 13, kind: .image, mime: "image/png", file: "2.png"),
        .init(name: "a.pdf", bytes: 5, kind: .file, mime: "application/pdf", file: "3.pdf"),
      ],
      createdAt: Sample.now)
    state.apply(.outboxEnqueued(entry), now: Sample.now)
    state.apply(.outboxProgress(entry.id, .awaitingResponse), now: Sample.now)
    let before = TranscriptRows.build(state: state, sessionId: "s1")
    #expect(EchoThumbnailHandoff.pairs(previous: before, state: state, sessionId: "s1").isEmpty, "wpis jeszcze stoi")

    // Echo z serwera: drugie zdjęcie bez `file` (starszy serwer) zostaje chipem i nie dostaje pary.
    let echo = #"""
      {"type":"message","sessionId":"s1","message":{"seq":9,"role":"user","at":"\#(Sample.iso(0))",
       "blocks":[{"type":"text","text":"trzy"}],"clientMessageId":"\#(entry.clientMessageId)",
       "attachments":[{"kind":"image","name":"","bytes":11,"mime":"image/png","file":"1790000000000-00000000000000aa.png"},
                      {"kind":"image","name":"","bytes":12,"mime":"image/png"},
                      {"kind":"image","name":"","bytes":13,"mime":"image/png","file":"1790000000000-00000000000000cc.png"},
                      {"kind":"file","name":"a.pdf","bytes":5,"mime":"application/pdf"}]}}
      """#
    state.apply(.frame(Sample.decode(ServerEvent.self, echo), source: .session("s1"), cursor: nil), now: Sample.now)
    #expect(state.outbox.isEmpty && state.echoed[entry.id] == 9, "echo zgasiło wpis")
    let pairs = EchoThumbnailHandoff.pairs(previous: before, state: state, sessionId: "s1")
    #expect(pairs == [
      .init(from: "s1\no:\(entry.id.uuidString).0", to: "s1\nu:1790000000000-00000000000000aa.png", settling: true),
      .init(from: "s1\no:\(entry.id.uuidString).2", to: "s1\nu:1790000000000-00000000000000cc.png", settling: true),
    ])
    // Klucz kafla echa jest tym samym kluczem, którego szuka kafel wiersza zdjęć.
    let rows = TranscriptRows.build(state: state, sessionId: "s1")
    guard case let .media(media) = rows.last else {
      Issue.record("brak wiersza zdjęć echa: \(rows)")
      return
    }
    #expect(media.thumbnails.map { $0.cacheKey(sessionId: "s1") } == pairs.map(\.to))
    // Kolejny render nie paruje drugi raz (wpisu nie ma już w wierszach).
    #expect(EchoThumbnailHandoff.pairs(previous: rows, state: state, sessionId: "s1").isEmpty)
  }

  @Test("numer echa wskazuje już inną wiadomość (restart serwera przed renderem): bez przekazania obrazu")
  func handoffSeqReused() {
    var state = Sample.state(session: Sample.session())
    let entry = OutboxEntry(
      sessionId: "s1", text: "", attachments: [.init(name: "", bytes: 11, kind: .image, file: "0.png")],
      createdAt: Sample.now, state: .sent(acceptedAt: Sample.now))
    state.outbox = [entry]
    let before = TranscriptRows.build(state: state, sessionId: "s1")
    let mine = "1790000000000-00000000000000aa.png"
    let echo = #"""
      {"type":"message","sessionId":"s1","message":{"seq":9,"role":"user","at":"\#(Sample.iso(0))","blocks":[],
       "clientMessageId":"\#(entry.clientMessageId)",
       "attachments":[{"kind":"image","name":"","bytes":11,"mime":"image/png","file":"\#(mine)"}]}}
      """#
    state.apply(.frame(Sample.decode(ServerEvent.self, echo), source: .session("s1"), cursor: nil), now: Sample.now)
    #expect(state.echoed[entry.id] == 9)
    // Pełny stan po restarcie serwera, zanim ekran się przerysował: pod 9 cudze zdjęcie (inny identyfikator,
    // potem bez identyfikatora i z inną wagą) — obraz wpisu nie może stanąć pod jego plikiem.
    let foreign = [
      #""clientMessageId":"\#(UUID().uuidString.lowercased())","attachments":[{"kind":"image","name":"","bytes":11,"#,
      #""attachments":[{"kind":"image","name":"","bytes":12,"#,
    ]
    for head in foreign {
      state.transcripts["s1"]?.messages = [Sample.decode(TranscriptMessage.self, #"""
        {"seq":9,"role":"user","at":"\#(Sample.iso(0))","blocks":[],\#(head)
         "mime":"image/png","file":"1790000000000-00000000000000bb.png"}]}
        """#)]
      #expect(EchoThumbnailHandoff.pairs(previous: before, state: state, sessionId: "s1").isEmpty, "\(head)")
    }
    // Echo odtworzone z pliku rozmowy (bez identyfikatora) z tymi samymi wagami to wciąż ta wiadomość.
    state.transcripts["s1"]?.messages = [Sample.decode(TranscriptMessage.self, #"""
      {"seq":9,"role":"user","at":"\#(Sample.iso(0))","blocks":[],
       "attachments":[{"kind":"image","name":"","bytes":11,"mime":"image/png","file":"\#(mine)"}]}
      """#)]
    #expect(EchoThumbnailHandoff.pairs(previous: before, state: state, sessionId: "s1").map(\.to) == ["s1\nu:\(mine)"])
  }

  @Test("echo po 202: obraz przechodzi bez wygaszania; „Odrzuć” bez echa nie przekazuje niczego")
  func handoffAfterAccepted() {
    var state = Sample.state(session: Sample.session())
    let accepted = OutboxEntry(
      sessionId: "s1", text: "", attachments: [.init(name: "", bytes: 11, kind: .image, file: "0.png")],
      createdAt: Sample.now, state: .sent(acceptedAt: Sample.now))
    let dropped = OutboxEntry(
      sessionId: "s1", text: "", attachments: [.init(name: "", bytes: 12, kind: .image, file: "0.png")],
      createdAt: Sample.now, state: .unconfirmed)
    state.outbox = [accepted, dropped]
    let before = TranscriptRows.build(state: state, sessionId: "s1")
    state.apply(.outboxDiscarded(dropped.id), now: Sample.now)
    let echo = #"""
      {"type":"message","sessionId":"s1","message":{"seq":3,"role":"user","at":"\#(Sample.iso(0))","blocks":[],
       "clientMessageId":"\#(accepted.clientMessageId)",
       "attachments":[{"kind":"image","name":"","bytes":11,"mime":"image/png","file":"1790000000000-00000000000000ff.png"}]}}
      """#
    state.apply(.frame(Sample.decode(ServerEvent.self, echo), source: .session("s1"), cursor: nil), now: Sample.now)
    #expect(EchoThumbnailHandoff.pairs(previous: before, state: state, sessionId: "s1") == [
      .init(from: "s1\no:\(accepted.id.uuidString).0", to: "s1\nu:1790000000000-00000000000000ff.png", settling: false),
    ])
  }

  @Test("miniatura z pliku na urządzeniu = miniatura z tych samych bajtów: ten sam kafel co echo")
  func decodeFromFile() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "rarog-pending-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let data = try Self.png(width: 1600, height: 900)
    let url = directory.appending(path: "0.png")
    try data.write(to: url)
    let fromFile = try #require(await ThumbnailDecoder.thumbnail(contentsOf: url))
    let fromBytes = try #require(await ThumbnailDecoder.thumbnail(data))
    #expect(fromFile.image.width == fromBytes.image.width && fromFile.image.height == fromBytes.image.height)
    #expect(max(fromFile.image.width, fromFile.image.height) <= ThumbnailGeometry.maxPixels, "bez pełnego zdjęcia")
    #expect(await ThumbnailDecoder.thumbnail(contentsOf: directory.appending(path: "brak.png")) == nil)
  }

  private static func png(width: Int, height: Int) throws -> Data {
    let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
    let context = try #require(CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let data = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return data as Data
  }
}
