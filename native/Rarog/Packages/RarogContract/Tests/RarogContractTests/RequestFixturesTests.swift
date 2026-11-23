// Złote CIAŁA ŻĄDAŃ, strona PRODUCENTA: typy Swift → pliki `shared/fixtures/requests/`.
//
// Odwrotny kierunek niż złote odpowiedzi REST: tu kod klienta produkuje ciała, a lustro TS
// (`shared/test/request-fixtures.test.ts`) waliduje każdy plik TYM SAMYM schematem zod, którym
// router czyta żądanie — ściśle i bez strat. Rozjazd w którąkolwiek stronę przewraca bramkę:
// zmiana typu Swift bez odświeżenia plików przewraca ten test, a plik, którego schemat serwera
// nie przyjmie (zły token, slot spoza zakresu, pole spoza kontraktu), przewraca test TS.
// Domyślnie test PORÓWNUJE zakodowane ciała z plikami; `RAROG_FIXTURES_WRITE=1` je nadpisuje.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("złote ciała żądań: typy Swift → pliki")
struct RequestFixturesTests {
  struct Entry: Sendable, Decodable {
    let route: String
    let schema: String
  }

  static let write = ProcessInfo.processInfo.environment["RAROG_FIXTURES_WRITE"] == "1"

  static let directory: URL = {
    do {
      return try GoldenFrames.repoRoot().appending(path: "shared/fixtures/requests", directoryHint: .isDirectory)
    } catch {
      fatalError("złote ciała żądań: brak katalogu repo — \(error)")
    }
  }()

  static let manifest: [String: Entry] = {
    do {
      let data = try Data(contentsOf: directory.appending(path: "manifest.json"))
      return try JSONDecoder().decode([String: Entry].self, from: data)
    } catch {
      fatalError("złote ciała żądań: nie da się wczytać manifestu — \(error)")
    }
  }()

  /// Syntetyczne tokeny APNs: hex jak `Data` z systemu (32 i 40 bajtów).
  static let deviceToken = String(repeating: "a1b2c3d4", count: 8)
  static let updateToken = String(repeating: "0f1e2d3c", count: 10)
  static let activityId = "6F9619FF-8B86-D011-B42D-00C04FC964FF"
  static let cwd = "/Users/x/Projects/p"

  static func term(slot: TerminalSlot? = nil, role: TerminalRole? = nil) -> TerminalOpenBody {
    guard let body = TerminalOpenBody(cwd: cwd, slot: slot, role: role) else {
      fatalError("złote ciała żądań: ciało terminala odrzucone przez własny inicjalizator")
    }
    return body
  }

  /// Przełącznik ultracode w żywej sesji: samo `ultracode`, bez modelu i effortu.
  static func ultracode(_ value: Bool) -> SessionModelBody {
    guard let body = SessionModelBody(model: nil, effort: nil, ultracode: value) else {
      fatalError("złote ciała żądań: ciało zmiany ultracode odrzucone przez własny inicjalizator")
    }
    return body
  }

  /// Blokada promptu z karty sesji. Typ z drutu nie ma publicznego inicjalizatora — składa go dekoder.
  static let promptBlocked: SessionPromptBlocked = {
    do {
      return try JSONDecoder().decode(
        SessionPromptBlocked.self, from: Data(#"{"seq":7,"id":"8d3e9b54-6c1f-4f0e-9a51-1f2b3c4d5e6f"}"#.utf8))
    } catch {
      fatalError("złote ciała żądań: blokada promptu odrzucona przez dekoder — \(error)")
    }
  }()

  /// Plik → ciało, które apka wysyła tą trasą.
  static let bodies: [String: any Encodable & Sendable] = [
    // Restart sesji: pigułka „↑” bez pól, „Uruchom ponownie i wyślij” z całą blokadą karty.
    "restart.json": RestartBody(),
    "restart.resend.json": RestartBody(resend: promptBlocked),
    "answers.json": AnswersBody(answers: [["SQLite"], ["Jednostkowe", "Integracyjne"]]),
    "answers.notes.json": AnswersBody(
      answers: [["SQLite"], ["Jednostkowe", "Integracyjne"]], notes: ["ale bez paska bocznego", nil]),
    // Apka deklaruje swój bundle id jako temat APNs (temat per wpis rejestru serwera).
    "apns.register.json": ApnsRegisterBody(
      token: deviceToken, environment: .development, label: "iPad·Rarog", alerts: true, topic: "ai.rarog.app"),
    "apns.register.test.json": ApnsRegisterBody(
      token: deviceToken, environment: .production, label: "iPhone·Rarog", alerts: false, test: true,
      topic: "ai.rarog.app"),
    "apns.unregister.json": ApnsTokenBody(token: deviceToken),
    "apns.status.json": ApnsTokenBody(token: deviceToken),
    "live-activity.register.json": LiveActivityRegisterBody(
      deviceToken: deviceToken, activityId: activityId, updateToken: updateToken),
    "live-activity.end.json": LiveActivityEndBody(deviceToken: deviceToken, activityId: activityId),
    "term.open.json": term(),
    "term.open.slot.json": term(slot: .number(TerminalSlot.max), role: .shell),
    // Zapis notatki projektu: cały dokument i wersja, na której pisał człowiek.
    "notes.put.json": NotesPutBody(
      cwd: cwd, text: "## Przed deployem\n- restart herdr po `pnpm run restart`", updatedAt: 1_792_006_800_000),
    "term.open.next.json": term(slot: .next),
    "term.open.popup.json": term(role: .lazygit),
    // Parowanie kodem z linku: kod 32 B base64url, etykieta urządzenia i build apki tekstem.
    "pair.json": PairBody(code: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ", label: "iPhone·Rarog", build: 1700),
    // Ultracode: start z przełącznikiem (effort xhigh, jedyny dozwolony obok braku pola) i zmiana w żywej
    // sesji w obie strony; `false` też jest zmianą.
    "sessions.create.ultracode.json": CreateSessionBody(
      cwd: cwd, permissionMode: .auto, model: "opus[1m]", effort: .xhigh, ultracode: true),
    "sessions.model.ultracode-on.json": ultracode(true),
    "sessions.model.ultracode-off.json": ultracode(false),
    // Agent głosowy: pytanie o sesję; rozmowę silnika wybiera serwer w chwili przyjęcia żądania.
    "companion.ask.json": CompanionAskBody(
      question: "Why did the test fail?", clientRequestId: "5B0F3C2E-8D4A-4E6F-9A1B-2C3D4E5F6A7B"),
    // Klucz krótki OpenAI agenta głosowego: puste ciało, model i ważność ustala serwer.
    "companion.token.json": EmptyBody(),
    // Soniox speech key of the voice agent: an empty body; voice, model and lifetimes are the server's.
    "companion.speech-token.json": EmptyBody(),
    // A new directory in the browser of the New Session form: the listed directory and the trimmed name.
    "fs.mkdir.json": MakeDirBody(parent: cwd, name: "notatki"),
    // A message typed in the app: no sender and no conversation token.
    "messages.json": typedMessage,
    // A prompt the voice agent across sessions sends: its sender and the conversation token it read.
    "messages.voice-agent.json": MessageBody(
      text: "Run the tests again.", clientMessageId: "9A1B2C3D-4E5F-4A6B-8C7D-0E1F2A3B4C5D",
      sender: MessageSender(source: .voiceAgent, expectedConversation: "c0nversat10nT0ken-abcd")),
    // A result viewed in the app: the empty body `markSeen` of the client sends.
    "seen.json": EmptyBody(),
    // The voice agent across sessions picks up the result it read: who, and the `stateSince` and the conversation
    // token of that read.
    "seen.voice-agent.json": SeenBody(pickUp: SeenPickUp(
      by: .voiceAgent, stateSince: "2026-10-03T10:00:00.000Z", conversation: "c0nversat10nT0ken-abcd")),
  ]

  @Test("a seen body without a pick-up encodes to the bytes of the app's empty body, with no pick-up field")
  func seenWithoutPickUpBytes() throws {
    guard !Self.write else { return }
    let stored = try Data(contentsOf: Self.directory.appending(path: "seen.json"))
    #expect(try Self.encoded(EmptyBody()) == stored)
    #expect(try Self.encoded(SeenBody()) == stored)
  }

  /// The message body the app sends for a typed message: its golden file is the shape of every body without a sender.
  static let typedMessage = MessageBody(
    text: "Run the tests again.", clientMessageId: "3F2B8C1E-7A4D-4E9B-9C21-5D6E7F8A9B0C", queueAware: true)

  @Test("a message body without a sender encodes to the bytes of its golden file, with no `source` or `expectedConversation`")
  func typedMessageBytes() throws {
    guard !Self.write else { return }
    let data = try Self.encoded(Self.typedMessage)
    #expect(data == (try Data(contentsOf: Self.directory.appending(path: "messages.json"))))
    let text = String(decoding: data, as: UTF8.self)
    #expect(!text.contains("source") && !text.contains("expectedConversation"))
  }

  static func encoded(_ body: any Encodable) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(body) + Data("\n".utf8)
  }

  @Test("kod produkuje dokładnie te ciała, które zna manifest")
  func manifestMatchesBodies() {
    #expect(Self.manifest.keys.sorted() == Self.bodies.keys.sorted())
  }

  @Test("manifest ↔ katalog w obie strony")
  func manifestMatchesDirectory() throws {
    // Przebieg z zapisem dopiero tworzy pliki — katalog sprawdza przebieg porównujący.
    guard !Self.write else { return }
    let files = try FileManager.default.contentsOfDirectory(atPath: Self.directory.path)
      .filter { $0 != "manifest.json" }
      .sorted()
    #expect(files == Self.manifest.keys.sorted())
  }

  @Test("ciało = plik (odśwież: RAROG_FIXTURES_WRITE=1)", arguments: RequestFixturesTests.bodies.keys.sorted())
  func body(_ name: String) throws {
    let body = try #require(Self.bodies[name])
    let data = try Self.encoded(body)
    let url = Self.directory.appending(path: name)
    if Self.write {
      try data.write(to: url)
      return
    }
    let stored = try JSONValue.parse(Data(contentsOf: url))
    let differences = JSONValue.differences(expected: stored, actual: try JSONValue.parse(data))
    #expect(differences == [], "\(name): \(differences)")
  }
}
