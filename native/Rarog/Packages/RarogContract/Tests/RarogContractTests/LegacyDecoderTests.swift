// Old app × server with sentence codes: the frozen decoders of the old app (`Legacy/`) on the server golden files.
// The old app does not know the fields `*Ref`, `placeholder` and `truncation`, so it must skip them without rejecting
// the frame and show the server text as it came (English). The corpus is every golden file of the types that sentence
// codes change:
// - REST: każda odpowiedź ze statusem ≥ 400 jako `APIErrorBody` (tak czyta ją stary klient, `APIErrorTolerance`)
//   oraz `session` z `interruptResponse` i `resumeResponse` jako `SessionSummary`;
// - SSE: ramki `ok` i `degraded` z `sessions-snapshot`, `session-changed`, `transcript-snapshot`, `message`
//   (ramki `ignored` odrzuca już serwer, więc stara apka ich nie dostaje);
// - terminal: ramki serwera `shared/fixtures/term/`;
// - push: teksty jawne wszystkich wektorów `shared/fixtures/push-crypto/*.json`.
// Każda próbka idzie trzy razy: jak w pliku, z dopisanymi w pamięci poprawnymi polami kodów zdań i z uszkodzonymi.
// Gdy złote pliki niosą już prawdziwe `*Ref`, test chodzi po nich bez zmian.
import Foundation
@testable import RarogContract
import RarogContractFixtures
import Testing

/// Jedna próbka korpusu: dokument JSON typu, który kody zdań zmieniają, i miejsce, skąd pochodzi.
struct LegacySample: Sendable, CustomTestStringConvertible {
  enum Kind: String, Sendable, CaseIterable {
    case errorBody, session, message, push, terminal
  }

  let source: String
  let kind: Kind
  let document: JSONValue

  var testDescription: String { "\(kind.rawValue) \(source)" }
}

/// Odrzucenie w dekoderze, który zamiast wyjątku oddaje `nil` (terminal).
struct LegacyRejection: Error {
  let reason: String
}

@Suite("stara apka × serwer z kodami zdań: zamrożone dekodery czytają złote pliki z polami `*Ref`")
struct LegacyDecoderTests {
  // MARK: - Korpus

  static let corpus: [LegacySample] = {
    do {
      return try rest() + sse() + terminal() + push()
    } catch {
      fatalError("dekodery starej apki: nie da się zebrać korpusu złotych plików — \(error)")
    }
  }()

  static func fixtures(_ directory: String) throws -> URL {
    try GoldenFrames.repoRoot().appending(path: "shared/fixtures/\(directory)", directoryHint: .isDirectory)
  }

  static func rest() throws -> [LegacySample] {
    struct Entry: Decodable { let status: Int; let schema: String }
    let directory = try fixtures("rest")
    let manifest = try JSONDecoder().decode(
      [String: Entry].self, from: Data(contentsOf: directory.appending(path: "manifest.json")))
    var out: [LegacySample] = []
    for (name, entry) in manifest.sorted(by: { $0.key < $1.key }) {
      let document = try JSONValue.parse(Data(contentsOf: directory.appending(path: name)))
      if entry.status >= 400 {
        out.append(LegacySample(source: "rest/\(name)", kind: .errorBody, document: document))
      }
      if ["interruptResponse", "resumeResponse"].contains(entry.schema), let session = document[member: "session"] {
        out.append(LegacySample(source: "rest/\(name)/session", kind: .session, document: session))
      }
    }
    return out
  }

  static func sse() throws -> [LegacySample] {
    let frames = GoldenFrames.shared
    var out: [LegacySample] = []
    for name in frames.names {
      guard let entry = frames.entries[name], entry.expect != .ignored, entry.raw != true else { continue }
      let document = try frames.document(name)
      let source = "sse/\(name)"
      switch document[member: "type"]?.asString {
      case "sessions-snapshot":
        for (index, session) in (document[member: "sessions"]?.asArray ?? []).enumerated() {
          out.append(LegacySample(source: "\(source)/sessions/\(index)", kind: .session, document: session))
        }
      case "session-changed":
        if let session = document[member: "session"] {
          out.append(LegacySample(source: "\(source)/session", kind: .session, document: session))
        }
      case "transcript-snapshot":
        for (index, message) in (document[member: "messages"]?.asArray ?? []).enumerated() {
          out.append(LegacySample(source: "\(source)/messages/\(index)", kind: .message, document: message))
        }
      case "message":
        if let message = document[member: "message"] {
          out.append(LegacySample(source: "\(source)/message", kind: .message, document: message))
        }
      default:
        continue
      }
    }
    return out
  }

  static func terminal() throws -> [LegacySample] {
    struct Entry: Decodable { let kind: String }
    let directory = try fixtures("term")
    let manifest = try JSONDecoder().decode(
      [String: Entry].self, from: Data(contentsOf: directory.appending(path: "manifest.json")))
    return try manifest.keys.sorted().filter { manifest[$0]?.kind == "server" }.map { name in
      LegacySample(
        source: "term/\(name)", kind: .terminal,
        document: try JSONValue.parse(Data(contentsOf: directory.appending(path: name))))
    }
  }

  static func push() throws -> [LegacySample] {
    let directory = try fixtures("push-crypto")
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
      .filter { $0.hasSuffix(".json") }
      .sorted()
    var out: [LegacySample] = []
    for file in files {
      let document = try JSONValue.parse(Data(contentsOf: directory.appending(path: file)))
      for vector in document[member: "vectors"]?.asArray ?? [] {
        guard let plaintext = vector[member: "plaintext"]?.asString else { continue }
        let name = vector[member: "name"]?.asString ?? "?"
        out.append(LegacySample(
          source: "push-crypto/\(file)/\(name)", kind: .push,
          document: try JSONValue.parse(Data(plaintext.utf8))))
      }
    }
    return out
  }

  // MARK: - Teksty: z dekodera starej apki i z pliku, po tych samych ścieżkach

  /// Teksty, które stara apka pokazuje, po zdekodowaniu dokumentu jej typem. Odrzucenie = wyjątek.
  static func decodedTexts(_ kind: LegacySample.Kind, _ document: JSONValue) throws -> [String: String] {
    let data = document.data
    var out: [String: String] = [:]
    switch kind {
    case .errorBody:
      let body = try JSONDecoder().decode(OldApp.APIErrorBody.self, from: data)
      out["/error"] = body.error
      out["/message"] = body.message
      out["/reason"] = body.reason
    case .session:
      let session = try JSONDecoder().decode(OldApp.SessionSummary.self, from: data)
      out["/title"] = session.title
      out["/label"] = session.label
      out["/stateDetail"] = session.stateDetail
    case .message:
      let message = try JSONDecoder().decode(OldApp.TranscriptMessage.self, from: data)
      for (index, block) in message.blocks.enumerated() {
        switch block {
        case let .text(text):
          out["/blocks/\(index)/text"] = text
        case let .toolCall(call):
          out["/blocks/\(index)/summary"] = call.summary
          out["/blocks/\(index)/detail"] = call.detail
        case let .image(image):
          out["/blocks/\(index)/alt"] = image.alt
        case .unsupported:
          break
        }
      }
    case .push:
      let plaintext = try JSONDecoder().decode(OldApp.PushPlaintext.self, from: data)
      out["/title"] = plaintext.title
      out["/body"] = plaintext.body
    case .terminal:
      switch OldApp.TerminalServerFrame.decode(document.compact) {
      case let .error(message)?: out["/msg"] = message
      case let .hello(backend)?: out["/backend"] = backend
      case .exit?: break
      case nil: throw LegacyRejection(reason: "ramka terminala odrzucona przez dekoder starej apki")
      }
    }
    return out
  }

  /// Te same teksty wprost z pliku (łańcuchy pod ścieżkami, które czyta dekoder starej apki).
  static func fileTexts(_ kind: LegacySample.Kind, _ document: JSONValue) -> [String: String] {
    var out: [String: String] = [:]
    func take(_ key: String, from object: JSONValue, as path: String) {
      if let text = object[member: key]?.asString { out[path] = text }
    }
    switch kind {
    case .errorBody:
      for key in ["error", "message", "reason"] { take(key, from: document, as: "/\(key)") }
    case .session:
      for key in ["title", "label", "stateDetail"] { take(key, from: document, as: "/\(key)") }
    case .message:
      for (index, block) in (document[member: "blocks"]?.asArray ?? []).enumerated() {
        let keys: [String] = switch block[member: "type"]?.asString {
        case "text": ["text"]
        case "tool-call": ["summary", "detail"]
        case "image": ["alt"]
        default: []
        }
        for key in keys { take(key, from: block, as: "/blocks/\(index)/\(key)") }
      }
    case .push:
      for key in ["title", "body"] { take(key, from: document, as: "/\(key)") }
    case .terminal:
      switch document[member: "t"]?.asString {
      case "err": take("msg", from: document, as: "/msg")
      case "hello": out["/backend"] = document[member: "backend"]?.asString ?? ""
      default: break
      }
    }
    return out
  }

  // MARK: - Pola kodów zdań dopisywane w pamięci

  enum Slot: Sendable, CaseIterable { case ref, placeholder, truncation }

  /// Miejsca pól kodów zdań w dokumencie danego typu (`*Ref` obok tekstu, `placeholder` obrazka, `truncation`
  /// narzędzia).
  static func slots(_ kind: LegacySample.Kind, _ document: JSONValue) -> [(path: String, slot: Slot)] {
    switch kind {
    case .errorBody: return [("/messageRef", .ref)]
    case .session: return [("/stateDetailRef", .ref), ("/labelRef", .ref)]
    case .push: return [("/titleRef", .ref), ("/bodyRef", .ref)]
    case .terminal: return document[member: "t"]?.asString == "err" ? [("/msgRef", .ref)] : []
    case .message:
      return (document[member: "blocks"]?.asArray ?? []).enumerated().compactMap { index, block in
        switch block[member: "type"]?.asString {
        case "text": ("/blocks/\(index)/ref", .ref)
        case "image": ("/blocks/\(index)/placeholder", .placeholder)
        case "tool-call": ("/blocks/\(index)/truncation", .truncation)
        default: nil
        }
      }
    }
  }

  static func ref(_ code: JSONValue, args: [JSONValue]? = nil) -> JSONValue {
    var fields: [String: JSONValue] = ["code": code]
    if let args { fields["args"] = .array(args) }
    return .object(fields)
  }

  /// Wartości poprawne według kontraktu (`sentenceRefSchema`, `placeholder: true`, `truncation`).
  static func valid(_ slot: Slot) -> [JSONValue] {
    switch slot {
    case .ref:
      [ref(.string("rest.session-not-found")), ref(.string("session.fallback-label"), args: [.string("2")])]
    case .placeholder: [.bool(true)]
    case .truncation: [.object(["cut": .number(1200), "footer": .number(30)])]
    }
  }

  /// Wartości, które serwer odrzuca (`null`, 9 argumentów, pusty kod, argument liczbą, zły typ); stara apka
  /// pola nie zna, więc i tak ma je pominąć.
  static func broken(_ slot: Slot) -> [JSONValue] {
    switch slot {
    case .ref:
      [
        .null,
        ref(.string("rest.bad-request"), args: (1...9).map { .string(String($0)) }),
        ref(.string("")),
        ref(.string("session.fallback-label"), args: [.number(2)]),
        .string("rest.bad-request"),
        .object([:]),
      ]
    case .placeholder: [.null, .bool(false), .string("true")]
    case .truncation:
      [
        .null,
        .object(["cut": .number(-1), "footer": .number(0)]),
        .object(["cut": .number(10), "footer": .number(1_000_000)]),
      ]
    }
  }

  /// Warianty dokumentu z dopisanymi polami kodów zdań: `i`-ta wartość każdego rodzaju w każdym miejscu naraz. Wartość,
  /// którą złoty plik już niesie w danym miejscu, wypada z opcji tego miejsca: wariant ma się różnić od dokumentu,
  /// inaczej sprawdzałby to samo co `goldenFile`.
  static func variants(_ sample: LegacySample, _ values: (Slot) -> [JSONValue]) throws -> [JSONValue] {
    let points = slots(sample.kind, sample.document)
    guard !points.isEmpty else { return [] }
    let options = points.map { point in
      let all = values(point.slot)
      let fresh = all.filter { $0 != sample.document.value(at: point.path) }
      return fresh.isEmpty ? all : fresh
    }
    let rounds = options.map(\.count).max() ?? 0
    return try (0..<rounds).map { round in
      let ops = zip(points, options).map { point, choices in
        JSONPatchOp(path: point.path, value: choices[round % choices.count], remove: false)
      }
      return try sample.document.applying(ops)
    }
  }

  // MARK: - Testy na korpusie

  @Test("korpus obejmuje każdy zamrożony typ i każdy rodzaj pola kodów zdań")
  func corpusCoversEveryKind() {
    let kinds = Set(Self.corpus.map(\.kind))
    #expect(kinds == Set(LegacySample.Kind.allCases), "typy bez złotego pliku")
    for kind in LegacySample.Kind.allCases {
      let withRef = Self.corpus.contains { sample in
        sample.kind == kind && Self.slots(sample.kind, sample.document).contains { $0.slot == .ref }
      }
      #expect(withRef, "\(kind.rawValue): żadna próbka nie dostaje pola `*Ref`")
    }
    let slots = Set(Self.corpus.flatMap { Self.slots($0.kind, $0.document).map(\.slot) })
    #expect(slots == Set(Slot.allCases), "rodzaje pól kodów zdań bez próbki")
    // Próbki z tekstem, którego tłumaczenie dotyczy: zdanie odmowy REST, stan sesji, blok tekstu, baner, `err`.
    #expect(Self.corpus.contains { $0.kind == .errorBody && Self.fileTexts($0.kind, $0.document)["/message"] != nil })
    #expect(Self.corpus.contains { $0.kind == .session && Self.fileTexts($0.kind, $0.document)["/stateDetail"] != nil })
    #expect(Self.corpus.contains { $0.kind == .terminal && Self.fileTexts($0.kind, $0.document)["/msg"] != nil })
  }

  @Test("złoty plik dekoduje się zamrożonym typem, tekst = tekst pliku", arguments: LegacyDecoderTests.corpus)
  func goldenFile(_ sample: LegacySample) throws {
    let decoded = try Self.decodedTexts(sample.kind, sample.document)
    #expect(decoded == Self.fileTexts(sample.kind, sample.document))
  }

  @Test("z poprawnymi polami kodów zdań dopisanymi w pamięci: zamrożony typ dekoduje, tekst bez zmian",
        arguments: LegacyDecoderTests.corpus)
  func withValidSentenceRefFields(_ sample: LegacySample) throws {
    let expected = Self.fileTexts(sample.kind, sample.document)
    for variant in try Self.variants(sample, Self.valid) {
      #expect(variant != sample.document, "pole kodu zdania nie zostało dopisane")
      #expect(try Self.decodedTexts(sample.kind, variant) == expected, "\(variant.compact)")
    }
  }

  @Test("z uszkodzonymi polami kodów zdań (null, 9 argumentów, pusty kod, zły typ): typ dalej dekoduje, tekst bez zmian",
        arguments: LegacyDecoderTests.corpus)
  func withBrokenSentenceRefFields(_ sample: LegacySample) throws {
    let expected = Self.fileTexts(sample.kind, sample.document)
    for variant in try Self.variants(sample, Self.broken) {
      #expect(try Self.decodedTexts(sample.kind, variant) == expected, "\(variant.compact)")
    }
  }

  // MARK: - Kopie są dekoderami starej apki, nie przepustką

  static func json(_ text: String) -> Data { Data(text.utf8) }

  @Test("kopie trzymają reguły starej apki: null i zły typ w znanym polu dalej odrzucają")
  func copiesStayStrict() throws {
    let session = #""id":"s","cwd":"/x","title":"t","state":"idle","stateSince":"a","createdAt":"a","#
      + #""lastActivityAt":"a""#
    _ = try JSONDecoder().decode(OldApp.SessionSummary.self, from: Self.json("{\(session)}"))
    for bad in [#""stateDetail":null"#, #""label":5"#] {
      #expect(throws: (any Error).self, "\(bad)") {
        _ = try JSONDecoder().decode(OldApp.SessionSummary.self, from: Self.json("{\(session),\(bad)}"))
      }
    }
    #expect(throws: (any Error).self) {
      _ = try JSONDecoder().decode(OldApp.Block.self, from: Self.json(#"{"type":"text","text":9}"#))
    }
    #expect(try JSONDecoder().decode(OldApp.Block.self, from: Self.json(#"{"type":"nowy"}"#)) == .unsupported)
    #expect(throws: (any Error).self) {
      _ = try JSONDecoder().decode(OldApp.APIErrorBody.self, from: Self.json(#"{"message":"x"}"#))
    }
    let push = #""kind":"done","exp":1"#
    _ = try JSONDecoder().decode(OldApp.PushPlaintext.self, from: Self.json("{\(push)}"))
    #expect(throws: (any Error).self) {
      _ = try JSONDecoder().decode(OldApp.PushPlaintext.self, from: Self.json(#"{\#(push),"title":null}"#))
    }
    #expect(OldApp.TerminalServerFrame.decode(#"{"t":"err","msg":""}"#) == nil)
  }

  @Test("przypadki z kontraktu kodów zdań w kształcie starej apki: `.text(String)` i `.error(message:)` bez `ref`")
  func sentenceRefCasesInOldAppShape() throws {
    let block = try JSONDecoder().decode(
      OldApp.Block.self, from: Self.json(#"{"type":"text","text":"a","ref":{"code":"transcript.repoint-clear"}}"#))
    #expect(block == .text("a"))
    #expect(OldApp.TerminalServerFrame.decode(#"{"t":"err","msg":"x","msgRef":{"code":"term.taken-over"}}"#)
      == .error(message: "x"))
    #expect(OldApp.TerminalServerFrame.decode(#"{"t":"err","msg":"x","msgRef":null}"#) == .error(message: "x"))
    let body = try JSONDecoder().decode(
      OldApp.APIErrorBody.self,
      from: Self.json(
        #"{"error":"not-found","message":"That session doesn't exist.","#
          + #""messageRef":{"code":"rest.session-not-found"}}"#))
    #expect(body.error == "not-found" && body.message == "That session doesn't exist." && body.reason == nil)
  }
}

extension JSONValue {
  fileprivate subscript(member key: String) -> JSONValue? {
    guard case let .object(fields) = self else { return nil }
    return fields[key]
  }

  fileprivate var asString: String? {
    guard case let .string(value) = self else { return nil }
    return value
  }

  fileprivate var asArray: [JSONValue]? {
    guard case let .array(items) = self else { return nil }
    return items
  }

  /// Wartość pod ścieżką `/a/0/b` (klucze obiektów i indeksy tablic); brak = `nil`.
  fileprivate func value(at path: String) -> JSONValue? {
    var current: JSONValue? = self
    for segment in path.split(separator: "/") {
      switch current {
      case let .object(fields)?: current = fields[String(segment)]
      case let .array(items)?: current = Int(segment).flatMap { items.indices.contains($0) ? items[$0] : nil }
      default: return nil
      }
    }
    return current
  }
}
