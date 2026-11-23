// App × server without sentence codes: such a server sends no `*Ref` fields, so the app translator must show its
// text unchanged. Dwa korpusy:
// - trzy dosłowne kopie starych złotych plików (`shared/fixtures/legacy-contract/`, nigdy nie regenerowane) dekodują się
//   obecnymi typami, każde `*Ref` jest `nil`, a `translate` z tłumaczem polskim i angielskim nie zmienia wartości;
// - każdy bieżący złoty plik typu ze zdaniami serwera (REST, SSE, terminal, push) z usuniętymi polami `*Ref`
//   dekoduje się i po `translate` jest identyczny jak przed nim.
// Test chodzi tak samo po plikach bez `*Ref` i po plikach, które je niosą.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

/// Wartość kontraktu ze zdaniami serwera po zdekodowaniu jednego dokumentu.
enum CompatibilityValue: Equatable {
  case errorBody(APIErrorBody)
  case notesConflict(NotesConflictBody)
  case deviceRevoked(DeviceRevokedBody)
  case modelAccepted(SessionModelAccepted)
  case models(ModelList)
  case interrupt(InterruptResponse)
  case event(ServerEvent)
  case terminal(TerminalServerFrame)
  case push(PushPlaintext)
}

/// Jeden dokument korpusu: skąd pochodzi i czym go dekodować.
struct CompatibilitySample: Sendable, CustomTestStringConvertible {
  enum Kind: String, Sendable {
    case errorBody, notesConflict, deviceRevoked, modelAccepted, models, interrupt, event, terminal, push
  }

  let source: String
  let kind: Kind
  let document: JSONValue

  var testDescription: String { source }
}

/// Renderer, który zapisuje każde wywołanie (tekst i `ref`), a oddaje wynik tłumacza.
final class RecordingRenderer: @unchecked Sendable {
  private(set) var calls: [(text: String, ref: SentenceRef?)] = []
  let language: CopyLanguage

  init(_ language: CopyLanguage) { self.language = language }

  func render(_ text: String, _ ref: SentenceRef?) -> String {
    calls.append((text, ref))
    return ServerText.render(text, ref, language: language)
  }
}

@Suite("apka × serwer bez kodów zdań: bez `*Ref` tłumacz zostawia tekst serwera")
struct ServerTextCompatibilityTests {
  static func fixtures(_ directory: String) throws -> URL {
    try GoldenFrames.repoRoot().appending(path: "shared/fixtures/\(directory)", directoryHint: .isDirectory)
  }

  // MARK: - Dekodowanie i tłumaczenie

  static func decode(_ sample: CompatibilitySample) throws -> CompatibilityValue {
    let data = sample.document.data
    let decoder = JSONDecoder()
    switch sample.kind {
    case .errorBody: return .errorBody(try decoder.decode(APIErrorBody.self, from: data))
    case .notesConflict: return .notesConflict(try decoder.decode(NotesConflictBody.self, from: data))
    case .deviceRevoked: return .deviceRevoked(try decoder.decode(DeviceRevokedBody.self, from: data))
    case .modelAccepted: return .modelAccepted(try decoder.decode(SessionModelAccepted.self, from: data))
    case .models: return .models(try decoder.decode(ModelList.self, from: data))
    case .interrupt: return .interrupt(try decoder.decode(InterruptResponse.self, from: data))
    case .event: return .event(try EventDecoder.decode(data).get().event)
    case .terminal:
      return .terminal(try #require(TerminalServerFrame.decode(sample.document.compact), "\(sample.source): odrzucona"))
    case .push: return .push(try decoder.decode(PushPlaintext.self, from: data))
    }
  }

  /// `translate` na każdej wartości `SentenceBearing`, którą niesie dokument.
  static func translate(_ value: CompatibilityValue, _ render: (String, SentenceRef?) -> String) -> CompatibilityValue {
    func bear<T: SentenceBearing>(_ item: T) -> T {
      var copy = item
      copy.translate(render)
      return copy
    }
    switch value {
    case let .errorBody(body): return .errorBody(bear(body))
    case let .notesConflict(body): return .notesConflict(bear(body))
    case let .deviceRevoked(body): return .deviceRevoked(bear(body))
    case let .modelAccepted(body): return .modelAccepted(bear(body))
    case let .models(body): return .models(bear(body))
    case let .interrupt(body): return .interrupt(bear(body))
    case let .terminal(frame): return .terminal(bear(frame))
    case let .push(plaintext): return .push(bear(plaintext))
    case let .event(event):
      switch event {
      case var .sessionsSnapshot(snapshot):
        snapshot.sessions = snapshot.sessions.map { bear($0) }
        snapshot.herdrStatus = snapshot.herdrStatus.map { bear($0) }
        return .event(.sessionsSnapshot(snapshot))
      case var .sessionChanged(changed):
        changed.session = bear(changed.session)
        return .event(.sessionChanged(changed))
      case var .transcriptSnapshot(snapshot):
        snapshot.messages = snapshot.messages.map { bear($0) }
        snapshot.pendingPermissions = snapshot.pendingPermissions.map { bear($0) }
        snapshot.pendingQuestions = snapshot.pendingQuestions.map { bear($0) }
        return .event(.transcriptSnapshot(snapshot))
      case var .message(message):
        message.message = bear(message.message)
        return .event(.message(message))
      case var .permissionPending(pending):
        pending.request = bear(pending.request)
        return .event(.permissionPending(pending))
      case var .questionPending(pending):
        pending.request = bear(pending.request)
        return .event(.questionPending(pending))
      case let .state(state): return .event(.state(bear(state)))
      case let .herdrStatus(status): return .event(.herdrStatus(bear(status)))
      default: return value
      }
    }
  }

  /// Pole zdania z kodem: `*Ref` obok tekstu albo `ref` bloku `text`.
  static func isRefKey(_ key: String) -> Bool { key == "ref" || key.hasSuffix("Ref") }

  /// Dokument bez pól `*Ref` i `ref` na każdym poziomie (tak wysyła serwer bez kodów zdań).
  static func strippedRefs(_ value: JSONValue) -> JSONValue {
    switch value {
    case let .array(items): .array(items.map(strippedRefs))
    case let .object(fields): .object(fields.filter { !isRefKey($0.key) }.mapValues(strippedRefs))
    default: value
    }
  }

  /// Ścieżki pól `*Ref` i `ref` w dokumencie (pusta lista = dokument jak z serwera bez kodów zdań).
  static func refPaths(_ value: JSONValue, _ path: String = "") -> [String] {
    switch value {
    case let .array(items):
      return items.enumerated().flatMap { refPaths($0.element, "\(path)/\($0.offset)") }
    case let .object(fields):
      return fields.sorted { $0.key < $1.key }.flatMap { key, field in
        (isRefKey(key) ? ["\(path)/\(key)"] : []) + refPaths(field, "\(path)/\(key)")
      }
    default:
      return []
    }
  }

  /// Dekodowanie, potem `translate` po polsku i po angielsku: wartość bez zmian, każde wywołanie z `ref == nil`.
  static func expectUnchanged(_ sample: CompatibilitySample) throws {
    let decoded = try decode(sample)
    for language in [CopyLanguage.pl, .en] {
      let recorder = RecordingRenderer(language)
      let translated = translate(decoded, recorder.render)
      #expect(translated == decoded, "\(sample.source) [\(language)]: tłumacz zmienił tekst serwera bez kodów zdań")
      let withRef = recorder.calls.filter { $0.ref != nil }.map(\.text)
      #expect(withRef == [], "\(sample.source) [\(language)]: `ref` w dokumencie bez `*Ref`")
    }
  }

  // MARK: - Kopie starych złotych plików

  static let legacyFiles: [(file: String, kind: CompatibilitySample.Kind)] = [
    ("legacy-contract/rest/error.not-found.json", .errorBody),
    ("legacy-contract/sse/sessions-snapshot.demo.json", .event),
    ("legacy-contract/term/server.err.json", .terminal),
  ]

  @Test("trzy kopie starych złotych plików: dokument bez pól `*Ref`, dekodowanie obecnymi typami, tłumacz zwraca tekst")
  func legacyCopies() throws {
    let root = try GoldenFrames.repoRoot().appending(path: "shared/fixtures", directoryHint: .isDirectory)
    for (file, kind) in Self.legacyFiles {
      let document = try JSONValue.parse(Data(contentsOf: root.appending(path: file)))
      #expect(Self.refPaths(document) == [], "\(file): stara kopia z polem `*Ref`")
      try Self.expectUnchanged(CompatibilitySample(source: file, kind: kind, document: document))
    }
  }

  @Test("stare kopie: pola `*Ref` po zdekodowaniu są `nil`, a tekst z pliku zostaje po tłumaczeniu")
  func legacyRefsAreNil() throws {
    let root = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/legacy-contract", directoryHint: .isDirectory)
    let pl = ServerText.renderer(language: .pl)

    var body = try JSONDecoder().decode(
      APIErrorBody.self, from: Data(contentsOf: root.appending(path: "rest/error.not-found.json")))
    #expect(body.messageRef == nil)
    let message = body.message
    body.translate(pl)
    #expect(body.message == message && message != nil)

    let snapshot = try EventDecoder.decode(Data(contentsOf: root.appending(path: "sse/sessions-snapshot.demo.json"))).get()
    guard case let .sessionsSnapshot(event) = snapshot.event else {
      Issue.record("sessions-snapshot.demo.json: inny typ ramki")
      return
    }
    #expect(!event.sessions.isEmpty)
    for session in event.sessions {
      #expect(session.labelRef == nil && session.stateDetailRef == nil, "\(session.id)")
      var translated = session
      translated.translate(pl)
      #expect(translated.label == session.label && translated.stateDetail == session.stateDetail, "\(session.id)")
    }

    let text = try String(contentsOf: root.appending(path: "term/server.err.json"), encoding: .utf8)
    var frame = try #require(TerminalServerFrame.decode(text))
    guard case let .error(original, ref) = frame else {
      Issue.record("server.err.json: ramka inna niż err")
      return
    }
    #expect(ref == nil)
    frame.translate(pl)
    #expect(frame == .error(message: original, ref: nil))
  }

  // MARK: - Bieżące złote pliki bez `*Ref`

  /// Schematy REST z ciałem `SentenceBearing` poza błędami (status ≥ 400 idzie jako `APIErrorBody`).
  static let restKinds: [String: CompatibilitySample.Kind] = [
    "notesConflict": .notesConflict, "deviceRevokedBody": .deviceRevoked, "sessionModelResponse": .modelAccepted,
    "modelList": .models, "interruptResponse": .interrupt,
  ]

  static let corpus: [CompatibilitySample] = {
    do {
      return try rest() + sse() + terminal() + push()
    } catch {
      fatalError("zgodność ze starym serwerem: nie da się zebrać korpusu złotych plików — \(error)")
    }
  }()

  static func rest() throws -> [CompatibilitySample] {
    struct Entry: Decodable { let status: Int; let schema: String }
    let directory = try fixtures("rest")
    let manifest = try JSONDecoder().decode(
      [String: Entry].self, from: Data(contentsOf: directory.appending(path: "manifest.json")))
    return try manifest.sorted { $0.key < $1.key }.compactMap { name, entry in
      let kind: CompatibilitySample.Kind? = entry.status >= 400 && entry.schema != "notesConflict"
        && entry.schema != "deviceRevokedBody" ? .errorBody : restKinds[entry.schema]
      guard let kind else { return nil }
      let document = try JSONValue.parse(Data(contentsOf: directory.appending(path: name)))
      return CompatibilitySample(source: "rest/\(name)", kind: kind, document: strippedRefs(document))
    }
  }

  static func sse() throws -> [CompatibilitySample] {
    let frames = GoldenFrames.shared
    return try frames.names.compactMap { name in
      guard let entry = frames.entries[name], entry.expect != .ignored, entry.raw != true else { return nil }
      return CompatibilitySample(source: "sse/\(name)", kind: .event, document: strippedRefs(try frames.document(name)))
    }
  }

  static func terminal() throws -> [CompatibilitySample] {
    struct Entry: Decodable { let kind: String }
    let directory = try fixtures("term")
    let manifest = try JSONDecoder().decode(
      [String: Entry].self, from: Data(contentsOf: directory.appending(path: "manifest.json")))
    return try manifest.keys.sorted().filter { manifest[$0]?.kind == "server" }.map { name in
      let document = try JSONValue.parse(Data(contentsOf: directory.appending(path: name)))
      return CompatibilitySample(source: "term/\(name)", kind: .terminal, document: strippedRefs(document))
    }
  }

  static func push() throws -> [CompatibilitySample] {
    let directory = try fixtures("push-crypto")
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.sorted()
    var out: [CompatibilitySample] = []
    for file in files {
      guard case let .object(root) = try JSONValue.parse(Data(contentsOf: directory.appending(path: file))),
        case let .array(vectors)? = root["vectors"]
      else { continue }
      for case let .object(vector) in vectors {
        guard case let .string(plaintext)? = vector["plaintext"] else { continue }
        let name = if case let .string(name)? = vector["name"] { name } else { "?" }
        out.append(CompatibilitySample(
          source: "push-crypto/\(file)/\(name)", kind: .push,
          document: strippedRefs(try JSONValue.parse(Data(plaintext.utf8)))))
      }
    }
    return out
  }

  @Test("korpus obejmuje każdy kanał")
  func corpusShape() {
    let kinds = Set(Self.corpus.map(\.kind))
    #expect(kinds.isSuperset(of: [.errorBody, .notesConflict, .deviceRevoked, .models, .interrupt, .event, .terminal, .push]),
      "\(kinds)")
  }

  @Test("złoty plik z usuniętymi `*Ref`: dekoduje się, a tłumacz zostawia tekst bez zmian",
    arguments: ServerTextCompatibilityTests.corpus)
  func strippedGolden(_ sample: CompatibilitySample) throws {
    #expect(Self.refPaths(sample.document) == [])
    try Self.expectUnchanged(sample)
  }
}
