// Złote ramki przepuszczone przez parser w formacie serwera (`formatSseEvent` w
// `server/src/sse.ts`: `id: <serverStartId>:<seq>\n` tylko dla ramek z `seq`, potem
// `data: <JSON.stringify>\n\n`; heartbeat `: ping\nevent: ping\ndata: {}\n\n`; na starcie
// `retry: 3000\n\n`). Każda ramka po parserze dekoduje się tak samo jak prosto z pliku.
import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Testing

@Suite("parser SSE na złotych ramkach")
struct GoldenStreamTests {
  struct Frame: Sendable {
    let name: String
    let data: String
    let id: String?
  }

  static let serverStartId = "0f7c2a9e-5b1d-4c3a-9e2f-6a8b1c4d7e90"

  static func frames() throws -> [Frame] {
    let golden = GoldenFrames.shared
    return try golden.names.enumerated().map { index, name in
      let data = String(decoding: try golden.dataField(name), as: UTF8.self)
      // Co druga ramka z `id:` (domknięte), reszta bez (ulotne `delta`/`activity`).
      return Frame(name: name, data: data, id: index.isMultiple(of: 2) ? "\(serverStartId):\(index)" : nil)
    }
  }

  static func stream(_ frames: [Frame], eol: String) -> [UInt8] {
    var text = "retry: 3000" + eol + eol
    for (index, frame) in frames.enumerated() {
      if let id = frame.id { text += "id: \(id)" + eol }
      text += "data: \(frame.data)" + eol + eol
      if index % 5 == 4 { text += ": ping" + eol + "event: ping" + eol + "data: {}" + eol + eol }
    }
    return Array(text.utf8)
  }

  @Test("dane ramek nie mają CR/LF, a ramka unicode niesie surowe U+2028")
  func framesAreSingleLine() throws {
    let frames = try Self.frames()
    #expect(frames.count == GoldenFrames.shared.names.count)
    for frame in frames {
      #expect(!frame.data.contains("\n") && !frame.data.contains("\r"), "\(frame.name)")
    }
    let unicode = try #require(frames.first { $0.name == "message.unicode.json" })
    #expect(unicode.data.unicodeScalars.contains("\u{2028}"))
  }

  @Test("każda ramka przechodzi parser bez zmian", arguments: ["\n", "\r\n", "\r"], [1, 3, 7, 64, 4096])
  func roundTrip(eol: String, chunk: Int) throws {
    let frames = try Self.frames()
    let bytes = Self.stream(frames, eol: eol)
    var parser = SSEParser()
    var outputs: [SSEParser.Output] = []
    var index = 0
    while index < bytes.count {
      let end = min(bytes.count, index + chunk)
      outputs += parser.feed(bytes[index..<end])
      index = end
    }

    #expect(outputs.first == .retry(3000))
    let events = outputs.compactMap { if case let .event(event) = $0 { event } else { nil } }
    let messages = events.filter { $0.type == "message" }
    #expect(events.filter { $0.type == "ping" }.count == frames.count / 5)
    try #require(messages.count == frames.count)

    var cursor = ""
    for (frame, event) in zip(frames, messages) {
      if let id = frame.id { cursor = id }
      #expect(event.data == frame.data, "\(frame.name): dane")
      #expect(event.id == frame.id, "\(frame.name): id bloku")
      #expect(event.lastEventId == cursor, "\(frame.name): kursor")
      let viaStream = EventDecoder.decodeEvent(Data(event.data.utf8))
      let direct = EventDecoder.decodeEvent(try GoldenFrames.shared.dataField(frame.name))
      #expect(viaStream == direct, "\(frame.name): dekodowanie po parserze")
    }
  }
}
