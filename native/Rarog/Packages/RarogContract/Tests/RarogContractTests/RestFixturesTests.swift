// Złote odpowiedzi REST, strona klienta Swift — lustro `shared/test/rest-fixtures.test.ts`
// na tych samych plikach (`shared/fixtures/rest/`, produkuje je kod serwera). Nazwa schematu
// z manifestu wskazuje typ Swift; pole, którego typ nie zna, jest odcinane (forward-compat),
// a `null` w polu opcjonalnym i zły typ odrzucają odpowiedź — jak w ramkach SSE.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("złote odpowiedzi REST: manifest → typy Swift")
struct RestFixturesTests {
  struct Entry: Sendable, Decodable {
    let route: String
    let status: Int
    let schema: String
  }

  static let directory: URL = {
    do {
      return try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest", directoryHint: .isDirectory)
    } catch {
      fatalError("złote odpowiedzi REST: brak katalogu repo — \(error)")
    }
  }()

  static let manifest: [String: Entry] = {
    do {
      let data = try Data(contentsOf: directory.appending(path: "manifest.json"))
      return try JSONDecoder().decode([String: Entry].self, from: data)
    } catch {
      fatalError("złote odpowiedzi REST: nie da się wczytać manifestu — \(error)")
    }
  }()

  /// Schemat z manifestu → dekodowanie do typu Swift (wynik tylko do asercji `is`).
  static let decoders: [String: @Sendable (Data) throws -> any Sendable] = [
    "versionResponse": { try JSONDecoder().decode(VersionInfo.self, from: $0) },
    "resumableList": { try JSONDecoder().decode(ResumableList.self, from: $0) },
    "planUsage": { try JSONDecoder().decode(PlanUsage.self, from: $0) },
    // `GET /api/mac`: ten sam typ co `mac` w stanie Live Activity.
    "macLoad": { try JSONDecoder().decode(MacLoad.self, from: $0) },
    "errorBody": { try JSONDecoder().decode(APIErrorBody.self, from: $0) },
    // 422 odmowy decyzji: ten sam typ co ciało błędu, z polem `reason` (osobnego typu Swift nie ma).
    "decisionRefusedBody": { try JSONDecoder().decode(APIErrorBody.self, from: $0) },
    // 202 zmiany modelu (`POST /api/sessions/:id/model`): ostrzeżenie o skutku zmiany.
    "sessionModelResponse": { try JSONDecoder().decode(SessionModelAccepted.self, from: $0) },
    "okAck": { try JSONDecoder().decode(OkAck.self, from: $0) },
    "messageAccepted": { try JSONDecoder().decode(MessageAccepted.self, from: $0) },
    // Queue take-back: the queued prompts back to the app, whole or with part of the CLI queue left.
    "queueTakeBackResponse": { try JSONDecoder().decode(QueueTakeBackResponse.self, from: $0) },
    "restartResponse": { try JSONDecoder().decode(RestartResponse.self, from: $0) },
    "resumeResponse": { try JSONDecoder().decode(ResumeResponse.self, from: $0) },
    "interruptResponse": { try JSONDecoder().decode(InterruptResponse.self, from: $0) },
    "dirListing": { try JSONDecoder().decode(DirListing.self, from: $0) },
    // `POST /api/fs/mkdir`: the row of the new directory.
    "dirEntry": { try JSONDecoder().decode(DirEntry.self, from: $0) },
    // Kontrakt tras apki natywnej: status tokenu APNs i trzy odpowiedzi REST terminala (złote pliki
    // `term.*`).
    "apnsStatusResponse": { try JSONDecoder().decode(ApnsStatus.self, from: $0) },
    "termOpenResponse": { try JSONDecoder().decode(TerminalOpenResponse.self, from: $0) },
    "termListResponse": { try JSONDecoder().decode(TerminalList.self, from: $0) },
    "termHistoryResponse": { try JSONDecoder().decode(TerminalHistory.self, from: $0) },
    // Diff sesji per plik: lista zmian i patch jednego pliku.
    "diffFileList": { try JSONDecoder().decode(DiffFileList.self, from: $0) },
    "diffFilePatch": { try JSONDecoder().decode(DiffFilePatch.self, from: $0) },
    // Notatki projektu: dokument, nowa wersja po zapisie i 409 z aktualnym dokumentem.
    "notesDoc": { try JSONDecoder().decode(NotesDoc.self, from: $0) },
    "notesSaved": { try JSONDecoder().decode(NotesSaved.self, from: $0) },
    "notesConflict": { try JSONDecoder().decode(NotesConflictBody.self, from: $0) },
    // Slash-komendy sesji: lista podpowiedzi = migawka strażnika wysyłki.
    "commandList": { try JSONDecoder().decode(CommandList.self, from: $0) },
    // Lista modeli formularza i dymka „Model i effort” (`ModelChoice.ultracode`).
    "modelList": { try JSONDecoder().decode(ModelList.self, from: $0) },
    // Klucze urządzeń i parowanie kodem: odpowiedź parowania, kod z urządzenia, lista, `me`, 401 z datą.
    "pairResponse": { try JSONDecoder().decode(PairResponse.self, from: $0) },
    "pairingIssued": { try JSONDecoder().decode(PairingIssued.self, from: $0) },
    "deviceList": { try JSONDecoder().decode(DeviceList.self, from: $0) },
    "deviceMe": { try JSONDecoder().decode(DeviceMe.self, from: $0) },
    "deviceRevokedBody": { try JSONDecoder().decode(DeviceRevokedBody.self, from: $0) },
    // Agent głosowy: odpowiedź o sesji, z propozycją promptu albo bez.
    "companionAsk": { try JSONDecoder().decode(CompanionAnswer.self, from: $0) },
    // Klucz krótki OpenAI agenta głosowego: wartość syntetyczna, opis bez niej.
    "companionToken": { try JSONDecoder().decode(CompanionToken.self, from: $0) },
    // Soniox speech key of the voice agent (Soniox voice): synthetic value, description without it.
    "companionSpeechToken": { try JSONDecoder().decode(CompanionSpeechToken.self, from: $0) },
    // The last turns of a session for the voice agent across sessions.
    "companionTurns": { try JSONDecoder().decode(CompanionTurns.self, from: $0) },
    // The voice agent's session catalog.
    "companionSessions": { try JSONDecoder().decode(CompanionSessions.self, from: $0) },
    // Inbox: every visible card with its text, one card (or none), and the answer of remove and restore.
    "inboxList": { try JSONDecoder().decode(InboxList.self, from: $0) },
    "inboxCardResponse": { try JSONDecoder().decode(InboxCardResponse.self, from: $0) },
    "inboxActionResponse": { try JSONDecoder().decode(InboxActionResponse.self, from: $0) },
    // Session files: the listing of one directory, the index and the 413 of a file over the server's limit.
    "fileListing": { try JSONDecoder().decode(FileListing.self, from: $0) },
    "fileIndex": { try JSONDecoder().decode(FileIndex.self, from: $0) },
    "fileTooLargeBody": { try JSONDecoder().decode(FileTooLargeBody.self, from: $0) },
  ]

  static func body(_ name: String) throws -> Data {
    try Data(contentsOf: directory.appending(path: name))
  }

  static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try JSONDecoder().decode(type, from: body(name))
  }

  @Test("manifest ↔ katalog w obie strony")
  func manifestMatchesDirectory() throws {
    let files = try FileManager.default.contentsOfDirectory(atPath: Self.directory.path)
      .filter { $0 != "manifest.json" }
      .sorted()
    #expect(files == Self.manifest.keys.sorted())
  }

  @Test("każdy schemat z manifestu ma typ Swift")
  func everySchemaHasSwiftType() {
    let missing = Set(Self.manifest.values.map(\.schema)).subtracting(Self.decoders.keys)
    #expect(missing.sorted() == [])
  }

  @Test("odpowiedź dekoduje się do swojego typu", arguments: RestFixturesTests.manifest.keys.sorted())
  func response(_ name: String) throws {
    let entry = try #require(Self.manifest[name])
    let decode = try #require(Self.decoders[entry.schema])
    _ = try decode(Self.body(name))
  }

  @Test("wersja: `capabilities` — brak = pusta lista (serwer sprzed pola), lista czytana, null i zły typ odrzucają")
  func versionCapabilities() throws {
    let base = #""version":"1","protocolVersion":3,"serverStartId":"s""#
    #expect(try Self.version("{\(base)}").capabilities == [])
    #expect(try Self.version(#"{\#(base),"capabilities":[]}"#).capabilities == [])
    #expect(try Self.version(#"{\#(base),"capabilities":["nowa-rzecz","inna"]}"#).capabilities == ["nowa-rzecz", "inna"])
    for bad in [#""capabilities":null"#, #""capabilities":"jedna""#, #""capabilities":[1]"#] {
      #expect(throws: (any Error).self, "\(bad)") { _ = try Self.version("{\(base),\(bad)}") }
    }
  }

  static func version(_ json: String) throws -> VersionInfo {
    try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
  }

  @Test("wersja: `system` — złote pliki `macos`, brak = `nil`, znane wartości czytane, przyszła = wartownik, null odrzuca")
  func versionSystem() throws {
    // Lustro `SERVER_SYSTEMS` z `shared/src/rest.ts` i wartownik klienta na końcu.
    #expect(ServerSystem.allCases.map(\.rawValue) == ["macos", "linux", "other", "unsupported"])
    #expect(try Self.decode(VersionInfo.self, "version.json").system == .macos)
    #expect(try Self.decode(VersionInfo.self, "version.iroh.json").system == .macos)
    let base = #""version":"1","protocolVersion":3,"serverStartId":"s""#
    #expect(try Self.version("{\(base)}").system == nil, "serwer sprzed pola")
    for known in [ServerSystem.macos, .linux, .other] {
      #expect(try Self.version(#"{\#(base),"system":"\#(known.rawValue)"}"#).system == known)
    }
    // Nowszy serwer z systemem spoza listy: samo pole na wartowniku, reszta sondy wersji czytana.
    let future = try Self.version(#"{\#(base),"system":"freebsd","capabilities":["pair"]}"#)
    #expect(future.system == .unsupported && future.capabilities == ["pair"])
    // Wartownik klienta od serwera to też wartość nieznana, nie „znana”.
    #expect(try Self.version(#"{\#(base),"system":"unsupported"}"#).system == .unsupported)
    for bad in [#""system":null"#, #""system":1"#, #""system":["macos"]"#] {
      #expect(throws: (any Error).self, "\(bad)") { _ = try Self.version("{\(base),\(bad)}") }
    }
  }

  @Test("agent głosowy: `companionEnabled` brak = `nil`, odpowiedź z promptem i bez, pusty prompt i null odrzucają")
  func companion() throws {
    #expect(try Self.decode(VersionInfo.self, "version.json").companionEnabled == false)
    let base = #""version":"1","protocolVersion":3,"serverStartId":"s""#
    #expect(try Self.version("{\(base)}").companionEnabled == nil, "serwer sprzed pola")
    #expect(try Self.version(#"{\#(base),"companionEnabled":true}"#).companionEnabled == true)
    #expect(throws: (any Error).self) { _ = try Self.version(#"{\#(base),"companionEnabled":null}"#) }
    let found = try Self.decode(CompanionAnswer.self, "companion.ask.json")
    #expect(found.found && found.prompt == nil && !found.answer.isEmpty)
    let proposal = try Self.decode(CompanionAnswer.self, "companion.ask.prompt.json")
    #expect(!proposal.found && proposal.prompt?.contains("[secret]") == true)
    for bad in [
      #"{"answer":"a","found":false,"prompt":""}"#, #"{"answer":"a","found":false,"prompt":null}"#,
      #"{"answer":"a"}"#, #"{"answer":null,"found":true}"#,
    ] {
      #expect(throws: (any Error).self, "\(bad)") {
        _ = try JSONDecoder().decode(CompanionAnswer.self, from: Data(bad.utf8))
      }
    }
    let limit = try Self.decode(APIErrorBody.self, "error.companion-limit.json")
    #expect(limit.error == "companion-limit" && limit.messageRef?.code == "rest.companion-limit")
  }

  @Test("klucz krótki agenta głosowego: wartość, model i ważność; odmowy z kodami zdań; opis bez klucza")
  func companionToken() throws {
    let token = try Self.decode(CompanionToken.self, "companion.token.json")
    #expect(!token.value.isEmpty && token.model.hasPrefix("gpt-realtime") && !token.expiresAt.isEmpty)
    #expect(!String(describing: token).contains(token.value))
    for (file, code) in [
      ("error.companion-throttled.json", "companion-throttled"),
      ("error.companion-openai-key.json", "companion-openai-key"),
      ("error.companion-openai-limit.json", "companion-openai-limit"),
      ("error.companion-openai.json", "companion-openai"),
    ] {
      let body = try Self.decode(APIErrorBody.self, file)
      #expect(body.error == code && body.messageRef?.code == "rest.\(code)", "\(file)")
    }
  }

  @Test("`companionSpeech`: golden file `false`; missing = `nil` (older server); `true` read; `null` rejects")
  func companionSpeechFlag() throws {
    #expect(try Self.decode(VersionInfo.self, "version.json").companionSpeech == false)
    let base = #""version":"1","protocolVersion":3,"serverStartId":"s""#
    #expect(try Self.version("{\(base)}").companionSpeech == nil, "server before the field")
    #expect(try Self.version(#"{\#(base),"companionSpeech":true}"#).companionSpeech == true)
    #expect(throws: (any Error).self) { _ = try Self.version(#"{\#(base),"companionSpeech":null}"#) }
  }

  @Test("Across sessions: `companionSessions` golden `true`, missing = `nil`, `null` rejects; turns with their token")
  func companionSessions() throws {
    #expect(try Self.decode(VersionInfo.self, "version.companion-sessions.json").companionSessions == true)
    #expect(try Self.decode(VersionInfo.self, "version.json").companionSessions == nil, "mode off")
    let base = #""version":"1","protocolVersion":3,"serverStartId":"s""#
    #expect(throws: (any Error).self) { _ = try Self.version(#"{\#(base),"companionSessions":null}"#) }
    let turns = try Self.decode(CompanionTurns.self, "companion.turns.json")
    #expect(turns.complete && !turns.conversation.isEmpty && !turns.readMark.isEmpty)
    #expect(turns.messages.contains { $0.notice != nil } && turns.messages.contains { $0.promptBlocked != nil })
    for body in [
      #"{"messages":[],"conversation":"","stateSince":"s","readMark":"m.0","complete":true}"#,
      #"{"messages":[],"conversation":"c","stateSince":"s","readMark":"","complete":true}"#,
      #"{"messages":[],"conversation":"c","stateSince":"s","complete":true}"#,
    ] {
      #expect(throws: (any Error).self, "\(body)") {
        _ = try JSONDecoder().decode(CompanionTurns.self, from: Data(body.utf8))
      }
    }
    let refusal = try Self.decode(APIErrorBody.self, "error.companion-sessions-disabled.json")
    #expect(refusal.error == "companion-sessions-disabled")
    #expect(refusal.messageRef?.code == "rest.companion-sessions-disabled")
    // A send from the voice agent to a session that moved to another conversation after the agent read it.
    let moved = try Self.decode(APIErrorBody.self, "error.conversation-changed.json")
    #expect(moved.error == "bad-state")
    #expect(moved.messageRef?.code == "session.conversation-changed")
    // A pick-up by the voice agent of a result it did not read: the session's memory holds a newer message.
    let changed = try Self.decode(APIErrorBody.self, "error.seen-result-changed.json")
    #expect(changed.error == "bad-state")
    #expect(changed.messageRef?.code == "session.seen-result-changed")
  }

  @Test("Session catalog: a row with `asksOwner` and one without; the turns token; `false`, `null` and an empty id reject")
  func companionSessionCatalog() throws {
    let catalog = try Self.decode(CompanionSessions.self, "companion.sessions.json")
    #expect(catalog.sessions.contains { $0.asksOwner } && catalog.sessions.contains { !$0.asksOwner })
    let turns = try Self.decode(CompanionTurns.self, "companion.turns.json")
    #expect(catalog.sessions.first { $0.id == "s1" }?.conversation == turns.conversation)
    for row in [
      #"{"id":"s1","asksOwner":false,"conversation":"c","stateSince":"s"}"#,
      #"{"id":"s1","asksOwner":null,"conversation":"c","stateSince":"s"}"#,
      #"{"id":"","conversation":"c","stateSince":"s"}"#,
      #"{"id":"s1","conversation":"","stateSince":"s"}"#,
    ] {
      let body = Data(#"{"sessions":[\#(row)]}"#.utf8)
      #expect(throws: (any Error).self, "\(row)") { _ = try JSONDecoder().decode(CompanionSessions.self, from: body) }
    }
  }

  @Test("Soniox speech key: EU address, model, voice, rate; refusals with sentence codes; no key in description")
  func companionSpeechToken() throws {
    let token = try Self.decode(CompanionSpeechToken.self, "companion.speech-token.json")
    #expect(token.webSocketUri.hasPrefix("wss://tts-rt.eu.") && token.model == "tts-rt-v2" && token.sampleRate == 24000)
    #expect(!String(describing: token).contains(token.apiKey))
    #expect(!String(reflecting: token).contains(token.apiKey))
    var dumped = ""
    dump(token, to: &dumped)
    #expect(!dumped.contains(token.apiKey))
    for file in [
      "error.companion-speech-throttled.json", "error.companion-speech-unconfigured.json",
      "error.companion-speech-upstream.json",
    ] {
      let body = try Self.decode(APIErrorBody.self, file)
      #expect(body.error.hasPrefix("companion-speech-") && body.messageRef?.code.hasPrefix("rest.") == true, "\(file)")
    }
    #expect(throws: (any Error).self) {
      _ = try JSONDecoder().decode(CompanionSpeechToken.self, from: Data(#"{"apiKey":"","expiresAt":"x"}"#.utf8))
    }
  }

  @Test("`iroh` w wersji i parowaniu: złote pliki `null`; brak = `nil`, obiekt czytany, zły kształt odrzuca")
  func iroh() throws {
    #expect(try Self.decode(VersionInfo.self, "version.json").iroh == nil)
    #expect(try Self.decode(PairResponse.self, "pair.json").server.iroh == nil)
    let base = #""version":"1","protocolVersion":3,"serverStartId":"s""#
    let object = #"{"endpointId":"\#(String(repeating: "a", count: 64))","relay":"https://relay.example.com/"}"#
    #expect(try Self.version("{\(base)}").iroh == nil, "serwer sprzed pola")
    #expect(try Self.version(#"{\#(base),"iroh":null}"#).iroh == nil)
    #expect(try Self.version(#"{\#(base),"iroh":\#(object)}"#).iroh
      == ServerIroh(endpointId: String(repeating: "a", count: 64), relay: "https://relay.example.com/"))
    let server = #""id":"s","name":"mac","version":"1","capabilities":[]"#
    let pair = try JSONDecoder().decode(PairServer.self, from: Data(#"{\#(server),"iroh":\#(object)}"#.utf8))
    #expect(pair.iroh?.relay == "https://relay.example.com/")
    #expect(try JSONDecoder().decode(PairServer.self, from: Data("{\(server)}".utf8)).iroh == nil)
    for bad in [#""iroh":"x""#, #""iroh":{}"#, #""iroh":{"endpointId":"","relay":"r"}"#, #""iroh":{"endpointId":"e"}"#] {
      #expect(throws: (any Error).self, "\(bad)") { _ = try Self.version("{\(base),\(bad)}") }
    }
  }

  @Test("wartości: wersja, limity, wysyłka idempotentna, restart, wznowienie i błąd z kodem")
  func values() throws {
    let version = try Self.decode(VersionInfo.self, "version.json")
    #expect(version.protocolVersion == 3)
    #expect(version.tailnet != nil)
    // Serwer bez nadajnika APNs: kanału nie ma.
    #expect(version.apnsEnabled == false)
    // Capabilities: the decoder keeps the golden file's list as it is. Which names the server lists is the server's
    // contract (`SERVER_CAPABILITIES`), and the app reads no name from `VersionInfo.capabilities`.
    let golden = try JSONSerialization.jsonObject(with: Self.body("version.json")) as? [String: Any]
    let capabilities = try #require(golden?["capabilities"] as? [String])
    #expect(!capabilities.isEmpty)
    #expect(version.capabilities == capabilities)
    let apns = try Self.decode(ApnsStatus.self, "push.apns.status.json")
    #expect(!apns.enabled && !apns.registered && !apns.alerts && apns.degradedSince == nil)
    #expect(apns.degradedReason == nil)
    // Przyczyna degradacji stoi zawsze razem z `degradedSince`; dokładnej chwili nie sprawdzamy.
    for (name, reason) in [
      ("push.apns.status.pass-missing.json", ApnsDegradedReason.passMissing),
      ("push.apns.status.env-mismatch.json", .envMismatch),
    ] {
      let degraded = try Self.decode(ApnsStatus.self, name)
      #expect(degraded.enabled && degraded.registered, "\(name)")
      #expect(degraded.degradedReason == reason && degraded.degradedSince != nil, "\(name)")
    }
    #expect(try Self.decode(ApnsStatus.self, "push.apns.status.registered.json").degradedReason == nil)
    // Degradacja bez nazwanej przyczyny (zwykłe porażki dostaw): ogólny baner.
    let general = try Self.decode(ApnsStatus.self, "push.apns.status.degraded.json")
    #expect(general.degradedSince != nil && general.degradedReason == nil)
    // Live Activity: token aktywności przed rejestracją urządzenia → 409; apka rejestruje
    // urządzenie (`POST /api/push/apns`) i ponawia token aktywności.
    let unknownDevice = try Self.decode(APIErrorBody.self, "error.live-activity-unknown-device.json")
    #expect(unknownDevice.error == "apns-device-unknown" && unknownDevice.message?.isEmpty == false)

    // Limity z paska statusu Claude Code: zawsze `source: "cli"`, bez okna per model.
    let fresh = try Self.decode(PlanUsage.self, "usage.json")
    #expect(fresh.stale == nil && fresh.source == "cli" && fresh.fetchedAt != nil && fresh.account != nil)
    #expect(fresh.weeklyModel == nil)
    let stale = try Self.decode(PlanUsage.self, "usage.stale.json")
    #expect(stale.stale == true && stale.source == "cli" && stale.fetchedAt != nil)
    let cli = try Self.decode(PlanUsage.self, "usage.cli.json")
    #expect(cli.source == "cli" && cli.account == nil && cli.weeklyModel == nil)

    let accepted = try Self.decode(MessageAccepted.self, "messages.accepted.json")
    let replayed = try Self.decode(MessageAccepted.self, "messages.replayed.json")
    let plain = try Self.decode(MessageAccepted.self, "messages.plain.json")
    #expect(accepted.clientMessageId != nil && !accepted.replayed)
    #expect(replayed.clientMessageId == accepted.clientMessageId && replayed.replayed)
    #expect(plain.clientMessageId == nil && !plain.replayed)
    #expect(!accepted.queued && !replayed.queued && !plain.queued)
    // Echo odroczone: pierwsze przyjęcie i powtórka, gdy wiadomość wciąż czeka u serwera.
    let queued = try Self.decode(MessageAccepted.self, "messages.queued.json")
    let replayedQueued = try Self.decode(MessageAccepted.self, "messages.replayed-queued.json")
    #expect(queued.clientMessageId != nil && queued.queued && !queued.replayed)
    #expect(replayedQueued.clientMessageId == queued.clientMessageId && replayedQueued.queued && replayedQueued.replayed)

    let conflict = try Self.decode(APIErrorBody.self, "error.client-id-conflict.json")
    #expect(conflict.error == "client-id-conflict" && conflict.message?.isEmpty == false)
    #expect(try Self.decode(ResumableList.self, "resumable.json").sessions.isEmpty == false)

    // Restart: 202 niesie identyfikator karty, odmowa — zdanie serwera do pokazania wprost.
    #expect(try Self.decode(RestartResponse.self, "restart.json").sessionId.isEmpty == false)
    let refused = try Self.decode(APIErrorBody.self, "error.restart-refused.json")
    #expect(refused.error == "bad-state" && refused.message?.isEmpty == false)

    // „Wznów”: 200 niesie identyfikator i kartę nowego panelu; sesja z żywym
    // panelem dostaje odmowę ze zdaniem serwera.
    let resumed = try Self.decode(ResumeResponse.self, "resume.json")
    #expect(resumed.sessionId == resumed.session.id && resumed.session.state == .starting)
    let resumeRefused = try Self.decode(APIErrorBody.self, "error.resume-refused.json")
    #expect(resumeRefused.error == "bad-state" && resumeRefused.message?.isEmpty == false)

    // Przerwanie: świeża karta sesji i los klawisza; odmowa — zdanie serwera.
    let interrupt = try Self.decode(InterruptResponse.self, "interrupt.json")
    #expect(interrupt.delivered == .yes && interrupt.session?.state == .waitingInput)
    #expect(interrupt.returnedPrompt == nil)
    // The prompt Claude Code handed back to its field after Esc, as the server knows it.
    let handed = try Self.decode(InterruptResponse.self, "interrupt.returned-prompt.json")
    #expect(handed.delivered == .yes && handed.returnedPrompt == "Refactor the parser and keep the tests green")
    #expect(try Self.decode(APIErrorBody.self, "error.interrupt-refused.json").message?.isEmpty == false)
    // Formularz nowej sesji: korzenie bez ścieżki, katalog projektu, ostatnie rozmowy.
    let roots = try Self.decode(DirListing.self, "fs.roots.json")
    #expect(roots.path == nil && roots.parent == nil && roots.entries.isEmpty == false)
    // The roots level has no directory of its own, so no git or history facts.
    #expect(roots.git == nil && roots.history == nil)
    let dir = try Self.decode(DirListing.self, "fs.dir.json")
    #expect(dir.path?.hasSuffix("/willow") == true)
    // A project directory: the listing says whether it is a git repo and has conversations.
    #expect(dir.git == true && dir.history == true)
    // Creating a directory: the demo says no, a server with the herdr switches on says yes, the roots level nothing.
    #expect(dir.canCreate == false && roots.canCreate == nil)
    let creatable = try Self.decode(DirListing.self, "fs.dir.can-create.json")
    #expect(creatable.canCreate == true && creatable.path != nil)
    let created = try Self.decode(DirEntry.self, "fs.mkdir.json")
    #expect(created.path == "\(creatable.path ?? "")/\(created.name)" && !created.git)
    #expect(try Self.decode(APIErrorBody.self, "error.dir-exists.json").error == "dir-exists")
    #expect(try Self.decode(APIErrorBody.self, "error.mkdir-disabled.json").error == "mkdir-disabled")
    #expect(try Self.decode(ResumableList.self, "resumable.recent.json").sessions.allSatisfy { !$0.liveInHerdr })
    // Start z ultracode: odmowa bramki ma własny kod, inny niż `bad-request` odmowy katalogu.
    let ultracode = try Self.decode(APIErrorBody.self, "error.ultracode-refused.json")
    #expect(ultracode.error == "ultracode-refused" && ultracode.message?.isEmpty == false)
    // Rozmowa żywa niesie kartę, do której apka przechodzi; zamknięte jej nie mają.
    let resumable = try Self.decode(ResumableList.self, "resumable.json").sessions
    #expect(resumable.first { $0.liveInHerdr }?.sessionId == "demo-willow")
    #expect(resumable.filter { !$0.liveInHerdr }.allSatisfy { $0.sessionId == nil })
  }

  @Test("parowanie: sekret raz, kod z urządzenia z terminem, lista bez sekretów, `null` jako wartość, 401 z datą")
  func devices() throws {
    let pair = try Self.decode(PairResponse.self, "pair.json")
    #expect(pair.server.capabilities.contains("pair-from-device") && pair.secret != pair.pushKey)
    #expect(pair.kid.count == 8)
    let issued = try Self.decode(PairingIssued.self, "pairings.json")
    #expect(!issued.code.isEmpty && !issued.expiresAt.isEmpty)
    let list = try Self.decode(DeviceList.self, "devices.json").devices
    #expect(list.map(\.creator) == ["admin", pair.deviceId])
    #expect(list.filter(\.current).count == 1 && list[1].lastSeenAt == nil && list[0].lastSeenAt != nil)
    let me = try Self.decode(DeviceMe.self, "devices.me.json")
    #expect(me.device.current && me.serverId == pair.server.id)
    let revoked = try Self.decode(DeviceRevokedBody.self, "error.device-revoked.json")
    #expect(revoked.revokedBy == "admin" && !revoked.revokedAt.isEmpty)
    #expect(try Self.decode(APIErrorBody.self, "error.pair-unknown.json").error == "pair-unknown")
    #expect(try Self.decode(APIErrorBody.self, "error.device-unknown.json").error == "device-unknown")
    #expect(try Self.decode(APIErrorBody.self, "error.device-required.json").error == "device-required")
    // `lastSeenAt` i `build` są wymagane (`null` to wartość): brak pola odrzuca wiersz.
    let row = #"{"id":"a","label":"l","createdAt":"t","creator":"admin","build":null,"current":false}"#
    #expect(throws: (any Error).self) { _ = try JSONDecoder().decode(DeviceInfo.self, from: Data(row.utf8)) }
    // Inny kod niż `device-revoked` to nie ta odmowa.
    let other = #"{"error":"device-unknown","message":"m","revokedAt":"t","revokedBy":"admin"}"#
    #expect(throws: (any Error).self) { _ = try JSONDecoder().decode(DeviceRevokedBody.self, from: Data(other.utf8)) }
  }

  @Test("obciążenie Maca: pusty obiekt = brak odczytu, część pól, zero to wartość")
  func macLoad() throws {
    let empty = try Self.decode(MacLoad.self, "mac.empty.json")
    #expect(empty.isEmpty)
    let partial = try Self.decode(MacLoad.self, "mac.partial.json")
    #expect(partial == MacLoad(cpu: 0, disk: 45) && !partial.isEmpty)
    #expect(partial.value(.cpu) == 0 && partial.value(.ram) == nil)
    #expect(try Self.decode(MacLoad.self, "mac.json") == MacLoad(cpu: 35, ram: 60, disk: 45))
    for json in [#"{"cpu":null}"#, #"{"ram":"60"}"#, #"{"disk":101}"#, #"{"cpu":12.5}"#, #"{"cpu":-5}"#] {
      #expect(throws: (any Error).self, "\(json)") { _ = try JSONDecoder().decode(MacLoad.self, from: Data(json.utf8)) }
    }
  }

  @Test("terminal: pierwszy tab = slot 1 powłoki, popup poza slotami, odmowy 409 z kodem serwera")
  func terminal() throws {
    let opened = try Self.decode(TerminalOpenResponse.self, "term.open.json")
    #expect(opened.slot == 1 && opened.role == .shell)
    let list = try Self.decode(TerminalList.self, "term.list.json")
    #expect(list.terminals.contains { $0.id == opened.id && $0.slot == 1 })
    #expect(list.terminals.filter(\.role.isPopup).allSatisfy { $0.slot == 0 })
    #expect(list.terminals.filter { $0.role == .shell }.map(\.slot) == [1, 2])
    #expect(list.terminals.allSatisfy { !$0.cwd.isEmpty && !$0.proc.isEmpty })
    #expect(try Self.decode(TerminalHistory.self, "term.history.json").truncated)
    for (name, code) in [
      ("error.term-limit.json", "term-limit"),
      ("error.term-herdr-launch-off.json", "herdr-launch-off"),
      ("error.term-herdr-send-off.json", "herdr-send-off"),
    ] {
      #expect(Self.manifest[name]?.status == 409, "\(name)")
      let body = try Self.decode(APIErrorBody.self, name)
      #expect(body.error == code && body.message?.isEmpty == false, "\(name)")
    }
  }

  @Test("diff per plik: liczniki opcjonalne, plik binarny, ucięcia i cztery kody odmów")
  func diffPerFile() throws {
    let demo = try Self.decode(DiffFileList.self, "diff.files.json")
    #expect(!demo.truncated && demo.files.map(\.status) == [.modified, .added, .deleted])
    #expect(demo.files.allSatisfy { $0.linesAdded != nil && $0.linesDeleted != nil && !$0.binary })

    // Trzy postacie wpisu: z licznikami, binarny bez liczników, nieśledzony bez niczego.
    let cut = try Self.decode(DiffFileList.self, "diff.files.truncated.json")
    #expect(cut.truncated)
    #expect(cut.files.contains { $0.linesAdded != nil && !$0.binary })
    #expect(cut.files.contains { $0.binary && $0.linesAdded == nil && $0.linesDeleted == nil })
    #expect(cut.files.contains { !$0.binary && $0.linesAdded == nil && $0.status == .added })

    let file = try Self.decode(DiffFilePatch.self, "diff.file.json")
    #expect(demo.files.contains { $0.path == file.path } && !file.truncated)
    #expect(file.patch.hasPrefix("diff --git a/\(file.path) b/\(file.path)\n"))
    #expect(try Self.decode(DiffFilePatch.self, "diff.file.binary.json").patch.contains("Binary files "))
    let clipped = try Self.decode(DiffFilePatch.self, "diff.file.truncated.json")
    #expect(clipped.truncated && clipped.patch.hasSuffix("\n"))

    // Kod rozstrzyga, co apka robi z odmową: 404 pliku = odśwież listę, 404 sesji = nie ma sesji,
    // 503 = „Spróbuj ponownie”. Status stoi w manifeście, kod i zdanie w ciele.
    for (name, status, code) in [
      ("error.diff-bad-path.json", 400, "bad-path"),
      ("error.diff-file-not-found.json", 404, "diff-file-not-found"),
      ("error.diff-session-not-found.json", 404, "session-not-found"),
      ("error.diff-git-failed.json", 503, "git-failed"),
    ] {
      #expect(Self.manifest[name]?.status == status, "\(name)")
      let body = try Self.decode(APIErrorBody.self, name)
      #expect(body.error == code && body.message?.isEmpty == false, "\(name)")
    }
  }

  @Test("komendy: demo = sam rejestr bez opisów, dysk = skille i pluginy z opisem i podpowiedzią")
  func commands() throws {
    let demo = try Self.decode(CommandList.self, "commands.json")
    #expect(!demo.revision.isEmpty && !demo.commands.isEmpty)
    #expect(demo.commands.allSatisfy { $0.source == .builtin && $0.description == nil && $0.argumentHint == nil })
    #expect(demo.commands.first { $0.name == "compact" }?.kind == .local)
    #expect(demo.commands.first { $0.name == "code-review" }?.kind == .prompt)
    #expect(!demo.commands.contains { $0.name == "new" }, "aliasy nie przechodzą przez strażnika")

    let disk = try Self.decode(CommandList.self, "commands.disk.json")
    #expect(disk.revision != demo.revision)
    #expect(Set(disk.commands.map(\.source)) == [.builtin, .skill, .plugin])
    let handoff = try #require(disk.commands.first { $0.name == "handoff" })
    #expect(handoff.kind == .prompt && handoff.source == .skill)
    #expect(handoff.description?.isEmpty == false && handoff.argumentHint?.isEmpty == false)
    #expect(disk.commands.contains { $0.source == .plugin && $0.name.contains(":") && $0.argumentHint != nil })
    #expect(disk.commands.contains { $0.source == .skill && $0.description == nil })
  }

  @Test("komendy: nieznany kind albo source zdejmuje sam wpis, null i brak revision odrzucają odpowiedź")
  func commandsTolerance() throws {
    let json = #"""
      {"revision":"r1","przyszlePole":1,"commands":[
        {"name":"compact","kind":"local","source":"builtin"},
        {"name":"usage","kind":"panel","source":"builtin"},
        {"name":"mcp__a__b","kind":"prompt","source":"mcp"},
        {"name":"handoff","kind":"prompt","source":"skill","description":"Opis","argumentHint":"[cel]","nowe":true}
      ]}
      """#
    let list = try JSONDecoder().decode(CommandList.self, from: Data(json.utf8))
    #expect(list.revision == "r1")
    #expect(list.commands == [
      CommandChoice(name: "compact", kind: .local, source: .builtin),
      CommandChoice(name: "handoff", kind: .prompt, source: .skill, description: "Opis", argumentHint: "[cel]"),
    ])
    #expect(CommandList.unavailable.commands.isEmpty && CommandList.unavailable.revision.isEmpty)
    for bad in [
      #"{"commands":[]}"#,
      #"{"revision":"","commands":[]}"#,
      #"{"revision":"r","commands":null}"#,
      #"{"revision":"r","commands":[{"name":"x","kind":"local","source":"builtin","description":null}]}"#,
      #"{"revision":"r","commands":[{"name":"","kind":"local","source":"builtin"}]}"#,
      #"{"revision":"r","commands":[{"name":"x","kind":null,"source":"builtin"}]}"#,
      #"{"revision":"r","commands":[{"name":"x","source":"builtin"}]}"#,
    ] {
      #expect(throws: (any Error).self, "\(bad)") { _ = try JSONDecoder().decode(CommandList.self, from: Data(bad.utf8)) }
    }
  }

  @Test("granica tolerancji: null w polu opcjonalnym, false w literale i zły typ odrzucają")
  func rejections() {
    let rejected: [(String, any Decodable.Type)] = [
      (#"{"ok":true,"clientMessageId":null}"#, MessageAccepted.self),
      (#"{"ok":true,"replayed":false}"#, MessageAccepted.self),
      (#"{"ok":true,"queued":false}"#, MessageAccepted.self),
      (#"{"ok":false}"#, OkAck.self),
      (#"{"fiveHour":{"percent":"dużo"}}"#, PlanUsage.self),
      (#"{"stale":null}"#, PlanUsage.self),
      (#"{"sessions":[{"engineSessionId":"a","cwd":"/x","mtime":"t","firstPrompt":"p"}]}"#, ResumableList.self),
      (#"{"ok":true,"delivered":"może"}"#, InterruptResponse.self),
      (#"{"ok":true,"session":null}"#, InterruptResponse.self),
      (#"{"ok":true,"returnedPrompt":null}"#, InterruptResponse.self),
      (#"{"ok":true,"returnedPrompt":7}"#, InterruptResponse.self),
      (#"{"parent":null,"entries":[],"truncated":false}"#, DirListing.self),
      // `degradedSince` jest wartością (`null` = zdrowy), nie brakiem pola.
      (#"{"enabled":false,"registered":false,"alerts":false}"#, ApnsStatus.self),
    ]
    for (json, type) in rejected {
      #expect(throws: (any Error).self, "\(json)") { _ = try JSONDecoder().decode(type, from: Data(json.utf8)) }
    }
    // Nieznany klucz to forward-compat, nie błąd.
    #expect(throws: Never.self) {
      _ = try JSONDecoder().decode(OkAck.self, from: Data(#"{"ok":true,"przyszlePole":1}"#.utf8))
    }
  }

  @Test("notatki: treść, pustka, nowa wersja wyższa od odczytanej, 409 niesie aktualny dokument")
  func notes() throws {
    let doc = try Self.decode(NotesDoc.self, "notes.json")
    #expect(!NotesRules.isEmpty(doc.text))
    #expect(try Self.decode(NotesDoc.self, "notes.empty.json") == .empty)
    let saved = try Self.decode(NotesSaved.self, "notes.saved.json")
    #expect(saved.updatedAt > doc.updatedAt)
    let conflict = try Self.decode(NotesConflictBody.self, "notes.conflict.json")
    #expect(conflict.error == "conflict")
    #expect(conflict.current.updatedAt == saved.updatedAt)
    #expect(conflict.current.text.hasPrefix(doc.text))
    #expect(try Self.decode(APIErrorBody.self, "error.notes-cwd-not-allowed.json").error == "cwd-not-allowed")
  }

  @Test("notatki: wersja z częścią ułamkową (stary plik po migracji) przechodzi bez zaokrąglenia, null odpada")
  func notesVersionKeepsFraction() throws {
    let doc = try JSONDecoder().decode(NotesDoc.self, from: Data(#"{"text":"a","updatedAt":1.5}"#.utf8))
    #expect(doc.updatedAt == 1.5)
    let body = try JSONEncoder().encode(NotesPutBody(cwd: "/p", text: "a", updatedAt: doc.updatedAt))
    let sent = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(sent["updatedAt"] as? Double == 1.5)
    #expect(throws: (any Error).self) {
      try JSONDecoder().decode(NotesDoc.self, from: Data(#"{"text":null,"updatedAt":1}"#.utf8))
    }
    // 409 z innym kodem niż `conflict` nie jest konfliktem wersji (literał w kontrakcie).
    #expect(throws: (any Error).self) {
      try JSONDecoder().decode(
        NotesConflictBody.self,
        from: Data(#"{"error":"other","message":"x","current":{"text":"a","updatedAt":1}}"#.utf8))
    }
  }

  @Test("notatki: pustka liczona jak JS trim — U+FEFF to pustka, U+0085 to treść")
  func notesEmptinessMatchesJavaScriptTrim() {
    #expect(NotesRules.isEmpty(""))
    #expect(NotesRules.isEmpty(" \n\t\u{00A0}\u{2003}\u{3000}\u{FEFF}\u{2028}"))
    #expect(!NotesRules.isEmpty("\u{0085}"))
    #expect(!NotesRules.isEmpty("  x  "))
    #expect(NotesRules.units("zażółć 👍") == "zażółć 👍".utf16.count)
    #expect(NotesRules.maxUnits == 49_152)
  }
}
