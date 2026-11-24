import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import Synchronization
import UIKit
import XCTest

// Trasy dyktowania w gospodarzach: pole wiadomości (`ComposerDictation`) i notatka projektu (`NoteDictation`)
// na prawdziwych częściach — nagrywarka, strumień Soniox, strumień systemowy, magazyn — z atrapami mikrofonu, gniazda,
// rozpoznawania mowy Apple i transportu z licznikiem `voiceToken()`. Każdy przypadek idzie przez oba gospodarze.
// Reguły zgody: mikrofon zawsze w polu, które przyjmuje tekst; trasa, która pyta, otwiera ekran „Dyktowanie” i nie
// otwiera mikrofonu; po wyborze nagrywa dopiero następne stuknięcie; apka nigdy sama nie przełącza dostawcy.
// Właściciel: dyktowanie.

@MainActor
final class DictationRouteTests: XCTestCase {
  // MARK: - Mikrofon zawsze

  /// Mikrofon pola wiadomości stoi przy każdym stanie serwera i fladze; pole bez edycji jak dotąd (widoczny,
  /// wygaszony). Notatka: mikrofon zależy tylko od pola i nagrania, a stuknięcie przy każdym stanie serwera rusza.
  func testMicrophoneShownWhateverTheServerSays() async throws {
    for server in [ServerVoice.unknown, .disabled, .enabled] {
      for allowed in [true, false] {
        let rig = try Rig(choice: .system, sonioxAllowed: allowed, server: server)
        let composer = rig.composer()
        XCTAssertFalse(composer.mic.isHidden, "\(server), flaga \(allowed): mikrofon widoczny")
        XCTAssertTrue(composer.mic.isEnabled)
        XCTAssertTrue(composer.dictation.canToggle, "⌥⌘M też")
        composer.dictation.render(editable: false)
        XCTAssertFalse(composer.mic.isHidden, "pole bez edycji: mikrofon widoczny, wygaszony")
        XCTAssertFalse(composer.mic.isEnabled)
        XCTAssertFalse(composer.dictation.canToggle)

        let note = try await rig.note()
        note.tap()
        let started = await waitUntil { rig.mics.starts["note"] == 1 }
        XCTAssertTrue(started, "\(server), flaga \(allowed): stuknięcie w notatce nagrywa")
        note.tap()
        _ = await waitUntil { !note.recording }
      }
    }
    XCTAssertTrue(NoteDictation.offersMicrophone(editable: true, recording: false))
    XCTAssertTrue(NoteDictation.offersMicrophone(editable: false, recording: true), "nagranie w toku da się skończyć")
    XCTAssertFalse(NoteDictation.offersMicrophone(editable: false, recording: false))
  }

  // MARK: - Zgoda przed mikrofonem

  /// Brak wyboru: stuknięcie = ekran, 0/0/0; zamknięcie ekranu bez wyboru = 0/0/0; wybór Soniox = 0/0/0 aż do
  /// drugiego stuknięcia, które otwiera mikrofon i daje po jednym mincie i połączeniu.
  func testAskThenChoiceThenSecondTapRecordsSoniox() async throws {
    for host in Host.allCases {
      let rig = try Rig(choice: nil)
      let driver = try await rig.driver(host)
      driver.tap()
      XCTAssertEqual(driver.asks, 1, "\(host): ekran „Dyktowanie”")
      await settle()
      XCTAssertEqual(rig.counts(host), Counts(), "\(host): ekran nie otwiera mikrofonu")
      driver.dismissAsk()
      driver.tap()
      XCTAssertEqual(driver.asks, 2, "\(host): zamknięcie bez wyboru — znowu ekran")
      await settle()
      XCTAssertEqual(rig.counts(host), Counts())

      XCTAssertTrue(DictationChoiceModel(store: rig.store).choose(.soniox), "\(host): wybór na ekranie")
      driver.dismissAsk()
      await settle()
      XCTAssertEqual(rig.counts(host), Counts(), "\(host): wybór niczego nie nagrywa")

      driver.tap()
      XCTAssertEqual(driver.asks, 2, "\(host): po wyborze bez ekranu")
      let live = await waitUntil { rig.sockets.count == 1 }
      XCTAssertTrue(live, "\(host): gniazdo Soniox")
      XCTAssertEqual(rig.counts(host), Counts(mic: 1, mint: 1, connect: 1))
      XCTAssertTrue(driver.recording, "\(host): wskaźnik nagrywania")
      try await rig.finish(driver)
      XCTAssertEqual(rig.violations, [], "mikrofon otwarty bez wskaźnika nagrywania")
    }
  }

  /// To samo z wyborem systemowym: drugie stuknięcie otwiera mikrofon bez mintu i bez gniazda.
  func testAskThenSystemChoiceRecordsWithoutServer() async throws {
    for host in Host.allCases {
      let rig = try Rig(choice: nil)
      let driver = try await rig.driver(host)
      driver.tap()
      XCTAssertEqual(driver.asks, 1)
      XCTAssertTrue(DictationChoiceModel(store: rig.store).choose(.system))
      driver.dismissAsk()
      await settle()
      XCTAssertEqual(rig.counts(host), Counts(), "\(host): wybór niczego nie nagrywa")
      driver.tap()
      let task = await waitUntil { rig.speech.task != nil }
      XCTAssertTrue(task, "\(host): zadanie rozpoznawania Apple")
      XCTAssertEqual(rig.counts(host), Counts(mic: 1), "\(host): bez mintu i bez gniazda")
      XCTAssertTrue(driver.recording)
      try await rig.finish(driver)
      XCTAssertEqual(rig.violations, [])
    }
  }

  // MARK: - Trasa systemowa

  /// Zero `voiceToken()` i zero połączeń; tekst w polu, także sprzed pauzy w zadaniu; linia śladu na starcie (API,
  /// droga, locale) i na końcu (fragmenty, zadania), bez tekstu.
  func testSystemRouteNeverTouchesServerOrSonioxAndTracesThePath() async throws {
    for host in Host.allCases {
      for onDevice in [true, false] {
        let rig = try Rig(choice: .system)
        rig.speech.facts = SpeechRecognizerFacts(locale: "pl-PL", isAvailable: true, supportsOnDeviceRecognition: onDevice)
        let driver = try await rig.driver(host)
        driver.tap()
        let task = try await rig.speechTask()
        XCTAssertEqual(task.request.requiresOnDeviceRecognition, onDevice, "\(host): droga z modelu na urządzeniu")
        task.partial("Dyktuję z")
        let shown = await waitUntil { driver.text.hasSuffix("Dyktuję z") }
        XCTAssertTrue(shown, "\(host): hipoteza w polu: \(driver.text)")
        let path = onDevice ? "on-device" : "apple-servers"
        XCTAssertEqual(
          rig.store.reporter.pending.filter { $0.hasPrefix("dyktowanie") },
          ["dyktowanie systemowe: api=SFSpeechRecognizer path=\(path) locale=pl-PL"], "\(host): jedna linia śladu")
        XCTAssertFalse(rig.store.reporter.pending.contains { $0.contains("Dyktuję") }, "ślad bez tekstu dyktowania")
        task.segmentEnd("Dyktuję z iPada.")
        task.partial("I dalej")
        let kept = await waitUntil { driver.text.hasSuffix("Dyktuję z iPada. I dalej") }
        XCTAssertTrue(kept, "\(host): tekst sprzed pauzy zostaje w polu: \(driver.text)")
        try await rig.finish(driver)
        XCTAssertTrue(driver.text.hasSuffix("Dyktuję z iPada. I dalej"), "\(host): tekst zostaje: \(driver.text)")
        XCTAssertEqual(
          rig.store.reporter.pending.filter { $0.hasPrefix("dyktowanie") },
          [
            "dyktowanie systemowe: api=SFSpeechRecognizer path=\(path) locale=pl-PL",
            "dyktowanie systemowe: koniec fragmenty=1 powtórki=0 zadania=1",
          ], "\(host): linia końca nagrania")
        XCTAssertFalse(
          rig.store.reporter.pending.contains { $0.contains("Dyktuję") || $0.contains("dalej") }, "ślad bez tekstu")
        XCTAssertEqual(rig.counts(host), Counts(mic: 1), "\(host): bez mintu i bez gniazda")
        XCTAssertEqual(rig.tokens.mints, 0)
      }
    }
  }

  // MARK: - Trasa Soniox

  /// 429 serwera: koniec ze zdaniem „za szybko”; sieć i 5xx: trzy ponowienia, potem „nie udało się pobrać klucza”
  /// (bez tekstu) albo „połączenie padło” (z tekstem, który zostaje).
  func testSonioxMintFailuresEndWithTheirSentences() async throws {
    for host in Host.allCases {
      let limited = try Rig(choice: .soniox)
      limited.tokens.script([.failure(.rateLimited(APIFailure(status: 429, message: "Za szybko.")))])
      let first = try await limited.driver(host)
      first.tap()
      let rate = await waitUntil { first.status == UICopy.voiceRateLimited }
      XCTAssertTrue(rate, "\(host): 429 → zdanie apki: \(first.status ?? "nil")")
      XCTAssertEqual(limited.tokens.mints, 1, "\(host): bez ponowienia")
      XCTAssertFalse(first.recording)

      for error in [TransportError.offline(.notConnectedToInternet), .http(APIFailure(status: 502))] {
        let rig = try Rig(choice: .soniox)
        rig.tokens.script([], otherwise: .failure(error))
        let driver = try await rig.driver(host)
        driver.tap()
        let failed = await waitUntil { driver.status == UICopy.voiceMintFailed }
        XCTAssertTrue(failed, "\(host), \(error): \(driver.status ?? "nil")")
        XCTAssertEqual(rig.tokens.mints, 4, "\(host): pierwsza próba i trzy ponowienia")
        XCTAssertEqual(rig.sockets.count, 0)
        XCTAssertFalse(driver.recording)
      }

      let dropped = try Rig(choice: .soniox)
      dropped.tokens.script([.success(token)], otherwise: .failure(.offline(.notConnectedToInternet)))
      let driver = try await dropped.driver(host)
      driver.tap()
      let socket = try await dropped.socket()
      socket.message(#"{"tokens":[{"text":"Dyktuję","is_final":true}]}"#)
      _ = await waitUntil { driver.text.hasSuffix("Dyktuję") }
      socket.drop()
      let streamFailed = await waitUntil { driver.status == UICopy.voiceNotice(.streamFailed) }
      XCTAssertTrue(streamFailed, "\(host): z tekstem — zerwanie: \(driver.status ?? "nil")")
      XCTAssertTrue(driver.text.hasSuffix("Dyktuję"), "\(host): tekst zostaje")
      XCTAssertEqual(dropped.tokens.mints, 4)
    }
  }

  /// W trakcie nagrania mint dostaje 503 `voice_unconfigured` → zdanie serwera, tekst zostaje,
  /// odmowa zapisana, mikrofon zostaje; następne stuknięcie = ekran, bez mikrofonu.
  func testRefusalDuringSonioxRecordingKeepsTextAndMicAndAsksNext() async throws {
    for host in Host.allCases {
      let rig = try Rig(choice: .soniox)
      let refusal = APIFailure(status: 503, code: "voice_unconfigured", message: "Serwer nie ma klucza Soniox.")
      rig.tokens.script([.success(token), .failure(.http(refusal))])
      let driver = try await rig.driver(host)
      driver.tap()
      let socket = try await rig.socket()
      socket.message(#"{"tokens":[{"text":"Dyktuję","is_final":true}]}"#)
      _ = await waitUntil { driver.text.hasSuffix("Dyktuję") }
      socket.drop()
      let said = await waitUntil { driver.status == "Serwer nie ma klucza Soniox." }
      XCTAssertTrue(said, "\(host): zdanie serwera: \(driver.status ?? "nil")")
      XCTAssertTrue(driver.text.hasSuffix("Dyktuję"), "\(host): tekst zostaje")
      XCTAssertEqual(rig.store.state.sonioxOnServer, .unavailable, "odmowa zapisana")
      XCTAssertEqual(rig.store.dictationRoute, .ask(.sonioxUnavailable))
      XCTAssertFalse(driver.recording)
      XCTAssertTrue(driver.microphoneShown, "\(host): mikrofon zostaje")
      XCTAssertEqual(rig.store.dictation.choices.choice, .soniox, "wybór nietknięty")

      driver.tap()
      XCTAssertEqual(driver.asks, 1, "\(host): następne stuknięcie = ekran")
      await settle()
      XCTAssertEqual(rig.counts(host), Counts(mic: 1, mint: 2, connect: 1), "\(host): bez drugiego nagrania")
    }
  }

  /// Send while recording ends the recording and waits for its last words: the message carries the whole
  /// sentence, not only the hypothesis on screen at the tap, and the field is not sent twice.
  func testSendWhileRecordingWaitsForTheTail() async throws {
    let rig = try Rig(choice: .soniox)
    let driver = rig.composer()
    driver.tap()
    let socket = try await rig.socket()
    socket.tail = "Dyktuję z iPada."
    socket.message(#"{"tokens":[{"text":"Dyktuję z","is_final":false}]}"#)
    let shown = await waitUntil { driver.text == "Dyktuję z" }
    XCTAssertTrue(shown, "hypothesis in the field: \(driver.text)")

    driver.send()
    driver.send()
    let sent = await waitUntil { !driver.sent.isEmpty }
    XCTAssertTrue(sent, "the message went")
    XCTAssertEqual(driver.sent, ["Dyktuję z iPada."], "the tail is in the message, sent once")
    XCTAssertFalse(driver.recording)
  }

  /// Send before the recording has a stream (the key is still being minted) ends it at once and sends the field;
  /// the next recording's end sends nothing on its own.
  func testSendBeforeTheStreamSendsOnceAndLeavesNothingBehind() async throws {
    let rig = try Rig(choice: .soniox)
    let driver = rig.composer()
    driver.composer.text = "Notatka"
    driver.tap()
    driver.send()
    let sent = await waitUntil { !driver.sent.isEmpty }
    XCTAssertTrue(sent, "the message went")
    XCTAssertEqual(driver.sent, ["Notatka"])

    driver.tap()
    _ = try await rig.socket()
    try await rig.finish(driver)
    await settle()
    XCTAssertEqual(driver.sent, ["Notatka"], "the next recording's end does not send")
  }

  /// Leaving the screen while Send waits for the last words still sends, with the text on screen at that moment.
  func testLeavingWhileSendWaitsStillSends() async throws {
    let rig = try Rig(choice: .soniox)
    let driver = rig.composer()
    driver.tap()
    let socket = try await rig.socket()
    socket.tail = "Dyktuję z iPada."
    socket.message(#"{"tokens":[{"text":"Dyktuję z","is_final":false}]}"#)
    let shown = await waitUntil { driver.text == "Dyktuję z" }
    XCTAssertTrue(shown, "hypothesis in the field: \(driver.text)")

    driver.send()
    driver.dictation.leave()
    XCTAssertEqual(driver.sent, ["Dyktuję z"], "the waiting send goes when the screen goes")
    await settle()
    XCTAssertEqual(driver.sent, ["Dyktuję z"], "and only once")
  }

  /// Send while speech waits for a first connection that never opens: the recording ends at the connection deadline
  /// with the failure notice, nothing stays connected, and Send sends what the field holds. Both key fetch orders.
  func testSendWhileSpeechWaitsForTheConnectionSendsTheFieldAtTheDeadline() async throws {
    for granted in [false, true] {
      let rig = try Rig(choice: .soniox)
      rig.micGranted = granted
      rig.socketsOpen = false
      let driver = rig.composer()
      driver.composer.text = "Notatka"
      driver.tap()
      let connecting = await waitUntil { rig.sockets.count == 1 && rig.mics.open.contains("composer") }
      XCTAssertTrue(connecting, "granted \(granted): microphone open, socket connecting")
      rig.mics.speak("composer")

      driver.send()
      await settle()
      XCTAssertEqual(driver.sent, [], "granted \(granted): Send waits for the connection")
      let sent = await waitUntil { !driver.sent.isEmpty }
      XCTAssertTrue(sent, "granted \(granted): the message went")
      XCTAssertEqual(driver.sent, ["Notatka"])
      XCTAssertEqual(driver.status, UICopy.voiceNotice(.streamFailed))
      XCTAssertTrue(rig.sockets.allSatisfy { $0.isClosed }, "granted \(granted): no socket left")
      XCTAssertEqual(rig.tokens.mints, 1, "granted \(granted): no new attempt after the stop")
      XCTAssertFalse(driver.recording)
    }
  }

  /// Send while speech waits for the first connection, which opens, takes the speech and then fails before any
  /// result (a drop, a 429 frame): Send sends what the field holds and the failure notice shows.
  func testSendWhenTheWaitedConnectionFailsAfterTheSpeechSendsTheFieldWithTheNotice() async throws {
    let cases: [(RouteSocket.End, String)] = [
      (.drop, UICopy.voiceNotice(.streamFailed)),
      (.limit, UICopy.voiceNotice(.message(UICopy.voiceRateLimited))),
    ]
    for (end, notice) in cases {
      let rig = try Rig(choice: .soniox)
      rig.socketsOpen = false
      let driver = rig.composer()
      driver.composer.text = "Notatka"
      driver.tap()
      let connecting = await waitUntil { rig.sockets.count == 1 && rig.mics.open.contains("composer") }
      XCTAssertTrue(connecting, "\(end): microphone open, socket connecting")
      rig.mics.speak("composer")

      driver.send()
      await settle()
      XCTAssertEqual(driver.sent, [], "\(end): Send waits for the connection")
      let socket = try XCTUnwrap(rig.sockets.last)
      socket.end = end
      socket.open()
      let sent = await waitUntil { !driver.sent.isEmpty }
      XCTAssertTrue(sent, "\(end): the message went")
      XCTAssertEqual(driver.sent, ["Notatka"])
      XCTAssertEqual(driver.status, notice, "\(end)")
      XCTAssertEqual(rig.tokens.mints, 1, "\(end): no new attempt after the stop")
      XCTAssertFalse(driver.recording)
    }
  }

  /// Sonda wersji jeszcze nie odpowiedziała, wybór Soniox — nagrywa przez Soniox (mint rozstrzyga).
  func testUnknownServerWithSonioxChoiceRecords() async throws {
    for host in Host.allCases {
      let rig = try Rig(choice: .soniox, server: .unknown)
      let driver = try await rig.driver(host)
      driver.tap()
      _ = try await rig.socket()
      XCTAssertEqual(driver.asks, 0)
      XCTAssertEqual(rig.counts(host), Counts(mic: 1, mint: 1, connect: 1))
      try await rig.finish(driver)
    }
  }

  // MARK: - Zmiana wyboru, reset, flaga

  /// Zmiana wyboru w trakcie nagrania — bieżące kończy się na swojej trasie, następne bierze nową.
  func testChoiceChangeDuringRecordingAppliesToNextTap() async throws {
    for host in Host.allCases {
      let rig = try Rig(choice: .soniox)
      let driver = try await rig.driver(host)
      driver.tap()
      let socket = try await rig.socket()
      XCTAssertTrue(DictationChoiceModel(store: rig.store).choose(.system), "\(host): zmiana w Ustawieniach")
      socket.message(#"{"tokens":[{"text":"Dalej Soniox","is_final":true}]}"#)
      let soniox = await waitUntil { driver.text.hasSuffix("Dalej Soniox") }
      XCTAssertTrue(soniox, "\(host): nagranie trwa na Soniox: \(driver.text)")
      XCTAssertNil(rig.speech.task, "bez rozpoznawania Apple w trakcie")
      try await rig.finish(driver)
      XCTAssertEqual(rig.counts(host), Counts(mic: 1, mint: 1, connect: 1))

      driver.tap()
      let system = await waitUntil { rig.speech.task != nil }
      XCTAssertTrue(system, "\(host): następne stuknięcie — systemowe")
      XCTAssertEqual(rig.counts(host), Counts(mic: 2, mint: 1, connect: 1), "\(host): bez nowego mintu")
      try await rig.finish(driver)
    }
  }

  /// `RAROG_UI_TEST_RESET` usuwa wybór — następne stuknięcie otwiera ekran. Tryb testów UI trzyma
  /// wybór w pamięci według `RAROG_UI_TEST_DICTATION`, a sam `RAROG_UI_TEST_VOICE` znaczy Soniox.
  func testResetClearsChoiceAndUITestModeMapsEnvironment() async throws {
    for host in Host.allCases {
      let rig = try Rig(choice: nil)
      let suite = "rarog.dictation.route.\(UUID().uuidString)"
      let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
      defer { defaults.removePersistentDomain(forName: suite) }
      rig.store.attachDictation(.live(sonioxAllowed: true, defaults: defaults))
      rig.store.dictation.choices.save(.system)
      XCTAssertEqual(rig.store.dictationRoute, .system)
      DictationTestMode.reset(defaults: defaults)
      XCTAssertNil(defaults.object(forKey: DictationChoiceStore.key), "klucz usunięty")
      let driver = try await rig.driver(host)
      driver.tap()
      XCTAssertEqual(driver.asks, 1, "\(host): po resecie ekran")
      await settle()
      XCTAssertEqual(rig.counts(host), Counts())
    }

    func choice(_ environment: [String: String]) -> DictationChoice?? {
      DictationTestMode.services(environment: environment, sonioxAllowed: true).map { $0.choices.choice }
    }
    XCTAssertEqual(choice([:]), .none, "bez zmiennych — produkcja")
    XCTAssertEqual(choice(["RAROG_UI_TEST_DICTATION": "none"]), .some(nil))
    XCTAssertEqual(choice(["RAROG_UI_TEST_DICTATION": "system"]), .some(.system))
    XCTAssertEqual(choice(["RAROG_UI_TEST_DICTATION": "soniox"]), .some(.soniox))
    XCTAssertEqual(choice(["RAROG_UI_TEST_DICTATION": "inne"]), .some(nil), "nieznana wartość = brak wyboru")
    XCTAssertEqual(choice(["RAROG_UI_TEST_VOICE": "1"]), .some(.soniox), "dzisiejsze testy dyktowania")
    XCTAssertEqual(choice(["RAROG_UI_TEST_VOICE": "1", "RAROG_UI_TEST_DICTATION": "none"]), .some(nil))
    let flagNo = DictationTestMode.services(environment: ["RAROG_UI_TEST_DICTATION": "soniox"], sonioxAllowed: false)
    XCTAssertEqual(flagNo?.sonioxAllowed, false, "flaga builda przechodzi do trybu testów")
    XCTAssertTrue(DictationServices.sonioxAllowed(info: "YES"))
    XCTAssertFalse(DictationServices.sonioxAllowed(info: "$(RAROG_VOICE_SONIOX)"))
  }

  /// Flaga `NO`: wybór Soniox daje ekran bez opcji Soniox w obu gospodarzach; wybór zostaje nietknięty.
  /// `voiceEnabled: false`: ekran z opcją Soniox niedostępną.
  func testFlagNoAndServerWithoutSonioxAskWithTheRightScreen() async throws {
    for host in Host.allCases {
      let hidden = try Rig(choice: .soniox, sonioxAllowed: false)
      let driver = try await hidden.driver(host)
      driver.tap()
      XCTAssertEqual(driver.asks, 1, "\(host): flaga NO — ekran")
      await settle()
      XCTAssertEqual(hidden.counts(host), Counts())
      let screen = DictationChoiceModel(store: hidden.store).screen()
      XCTAssertEqual(screen.options.map(\.choice), [.system], "\(host): bez opcji Soniox")
      XCTAssertFalse(screen.texts.contains { $0.contains("Soniox") }, "\(host): słowa „Soniox” nie ma")
      XCTAssertEqual(hidden.store.dictation.choices.choice, .soniox, "wybór nietknięty do wyboru na ekranie")

      for choice in [DictationChoice.soniox, nil] {
        let off = try Rig(choice: choice, server: .disabled)
        let offDriver = try await off.driver(host)
        offDriver.tap()
        XCTAssertEqual(offDriver.asks, 1, "\(host), \(String(describing: choice)): serwer bez Soniox — ekran")
        await settle()
        XCTAssertEqual(off.counts(host), Counts(), "bez przejścia na systemowe")
        let model = DictationChoiceModel(store: off.store)
        XCTAssertEqual(model.sonioxOption, .unavailable)
        XCTAssertEqual(model.screen().options.map(\.choice), [.system, .soniox])
        XCTAssertFalse(model.canChoose(.soniox))
      }
    }
  }

  // MARK: - Odmowy i błędy

  /// Odmowa mikrofonu (każda trasa) i rozpoznawania mowy (systemowa): zdanie z „Ustawienia”, które otwiera ustawienia
  /// apki; bez przejścia na drugą trasę; następne stuknięcie — to samo zdanie, bez ekranu i bez ponownego pytania.
  func testDenialsOfferSettingsAndNeverSwitchProvider() async throws {
    for host in Host.allCases {
      for choice in [DictationChoice.system, .soniox] {
        let rig = try Rig(choice: choice)
        rig.mics.denied = true
        let driver = try await rig.driver(host)
        let before = driver.text
        for attempt in 1...2 {
          driver.tap()
          let denied = await waitUntil { driver.status == UICopy.voiceNotice(.microphone(.denied)) }
          XCTAssertTrue(denied, "\(host), \(choice), próba \(attempt): \(driver.status ?? "nil")")
          XCTAssertTrue(driver.settingsShown, "\(host): przycisk „Ustawienia”")
          XCTAssertEqual(driver.asks, 0, "bez ekranu")
          XCTAssertEqual(rig.tokens.mints, 0, "bez Soniox")
          XCTAssertEqual(rig.sockets.count, 0)
          XCTAssertEqual(rig.speech.asked, 0, "bez pytania o rozpoznawanie")
        }
        driver.pressSettings()
        XCTAssertEqual(rig.opened, [URL(string: UIApplication.openSettingsURLString)], "\(host): ustawienia apki")
        XCTAssertEqual(driver.text, before, "pole nietknięte")
        XCTAssertTrue(driver.editable, "pole zostaje do pisania")
      }

      let speech = try Rig(choice: .system)
      speech.speech.status = .notDetermined
      speech.speech.answer = .denied
      let driver = try await speech.driver(host)
      for attempt in 1...2 {
        driver.tap()
        let denied = await waitUntil { driver.status == UICopy.dictationFailure(.speechDenied) }
        XCTAssertTrue(denied, "\(host), próba \(attempt): \(driver.status ?? "nil")")
        XCTAssertTrue(driver.settingsShown)
        XCTAssertEqual(speech.speech.asked, 1, "\(host): pytanie systemowe raz, bez pętli")
        XCTAssertEqual(speech.counts(host), Counts(), "\(host): bez mikrofonu, mintu i gniazda")
        XCTAssertEqual(driver.asks, 0)
      }
      driver.pressSettings()
      XCTAssertEqual(speech.opened.count, 1)

      let restricted = try Rig(choice: .system)
      restricted.speech.status = .restricted
      let restrictedDriver = try await restricted.driver(host)
      restrictedDriver.tap()
      let said = await waitUntil { restrictedDriver.status == UICopy.dictationFailure(.speechRestricted) }
      XCTAssertTrue(said, "\(host)")
      XCTAssertFalse(restrictedDriver.settingsShown, "\(host): ograniczenia nie zmienia się w ustawieniach apki")
    }
  }

  /// Błędy rozpoznawania Apple: zdanie błędu bez „Ustawienia”, tekst zostaje, bez Soniox.
  func testSystemFailuresSayWhyWithoutSettingsOrSoniox() async throws {
    let cases: [(DictationFailure, @MainActor (Rig) -> Void, SpeechTaskError?)] = [
      (.localeUnsupported, { $0.speech.facts = nil }, nil),
      (.appleServerUnreachable, {
        $0.speech.facts = SpeechRecognizerFacts(locale: "pl-PL", isAvailable: false, supportsOnDeviceRecognition: false)
      }, nil),
      (.assetsMissing, { _ in }, SpeechTaskError(domain: SpeechTaskError.recognizerDomain, code: 102)),
      (.dictationDisabled, { _ in }, SpeechTaskError(domain: SpeechTaskError.recognizerDomain, code: 201)),
      (.engineFailed, { _ in }, SpeechTaskError(domain: SpeechTaskError.assistantDomain, code: 1101)),
    ]
    for host in Host.allCases {
      for (failure, setUp, taskError) in cases {
        let rig = try Rig(choice: .system)
        setUp(rig)
        let driver = try await rig.driver(host)
        driver.tap()
        if let taskError {
          let task = try await rig.speechTask()
          task.partial("Zostaje")
          _ = await waitUntil { driver.text.hasSuffix("Zostaje") }
          task.fail(taskError)
        }
        let said = await waitUntil { driver.status == UICopy.dictationFailure(failure) }
        XCTAssertTrue(said, "\(host), \(failure): \(driver.status ?? "nil")")
        XCTAssertFalse(driver.settingsShown, "\(host), \(failure): bez „Ustawienia”")
        if taskError != nil { XCTAssertTrue(driver.text.hasSuffix("Zostaje"), "\(host): tekst zostaje") }
        XCTAssertEqual(rig.tokens.mints, 0, "\(host), \(failure): bez przejścia na Soniox")
        XCTAssertEqual(rig.sockets.count, 0)
        XCTAssertEqual(driver.asks, 0)
      }
    }
  }

  /// Scenariusz testów UI na trasie systemowej (`RAROG_UI_TEST_DICTATION=system`) oddaje ten sam tekst co scenariusz
  /// Soniox: hipoteza po trzech ramkach, całość po końcu dźwięku.
  func testScriptedSystemSpeechMatchesSonioxScenario() {
    XCTAssertEqual(ScriptedVoice.systemPartial, "Dyktuję z")
    XCTAssertEqual(ScriptedVoice.systemFinal, "Dyktuję z iPada.")
  }

  // MARK: - Notatka: autostart i przejęcie mikrofonu

  /// „Dyktuj” z listy (autostart z nowej linii): przy trasie, która pyta, strona „Dyktowanie” bez nagrania; przy
  /// systemowej nagranie od nowej linii.
  func testNoteAutostartAsksOrRecordsOnNewLine() async throws {
    let asking = try Rig(choice: nil)
    let note = try await asking.note()
    note.dictation.toggle(doc: note.doc, editor: nil, newLine: true)
    XCTAssertTrue(note.dictation.choosing, "strona „Dyktowanie” w notatce")
    await settle()
    XCTAssertEqual(asking.counts(.note), Counts(), "nic nie nagrywa")

    let recording = try Rig(choice: .system)
    let started = try await recording.note()
    started.dictation.toggle(doc: started.doc, editor: nil, newLine: true)
    XCTAssertFalse(started.dictation.choosing)
    let task = try await recording.speechTask()
    task.partial("Nowa linia")
    let line = await waitUntil { started.doc.text == "- punkt\nNowa linia" }
    XCTAssertTrue(line, "dopisek od nowej linii: \(started.doc.text)")
    try await recording.finish(started)
  }

  /// Przejęcie mikrofonu kompozytor ↔ notatka na prawdziwych gospodarzach: mikrofon poprzedniego zamknięty, zanim
  /// następny się otworzy; tekst poprzedniego zostaje w jego polu.
  func testMicrophoneHandOffBetweenRealHosts() async throws {
    let rig = try Rig(choice: .system)
    let composer = rig.composer()
    let note = try await rig.note()
    composer.tap()
    let first = try await rig.speechTask()
    first.partial("Z pola")
    _ = await waitUntil { composer.text == "Z pola" }

    note.tap()
    let second = await waitUntil { rig.mics.starts["note"] == 1 && rig.mics.open == ["note"] }
    XCTAssertTrue(second, "notatka nagrywa: \(rig.mics.events)")
    XCTAssertEqual(rig.mics.events, ["open composer", "close composer", "open note"], "najpierw zamknięcie")
    XCTAssertEqual(composer.text, "Z pola", "tekst pola wiadomości zostaje")
    XCTAssertFalse(composer.recording)
    let noteTask = try await rig.speechTask()
    noteTask.partial("Z notatki")
    _ = await waitUntil { note.text.hasSuffix("Z notatki") }

    composer.tap()
    let back = await waitUntil { rig.mics.open == ["composer"] }
    XCTAssertTrue(back, "\(rig.mics.events)")
    XCTAssertEqual(
      Array(rig.mics.events.suffix(3)), ["open note", "close note", "open composer"], "znowu najpierw zamknięcie")
    XCTAssertTrue(note.text.hasSuffix("Z notatki"), "tekst notatki zostaje: \(note.text)")
    XCTAssertEqual(rig.mics.maxOpen, 1, "nigdy dwa mikrofony naraz")
    XCTAssertEqual(rig.violations, [])
    try await rig.finish(composer)
  }

  // MARK: - Locked-phone trial

  /// Catches a background that still interrupts the field's recording with the locked-phone trial on (the trial
  /// would do nothing for dictation), and text that stops landing in the field after the lock.
  func testTrialKeepsTheFieldRecordingInTheBackground() async throws {
    let rig = try Rig(choice: .system)
    rig.store.voiceAgent.lockedPhoneTrial.set(true)
    let composer = rig.composer()
    composer.tap()
    let task = try await rig.speechTask()
    task.partial("Z pola")
    _ = await waitUntil { composer.text == "Z pola" }
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    await settle()
    XCTAssertTrue(composer.recording, "the recording goes on")
    XCTAssertEqual(rig.mics.open, ["composer"])
    XCTAssertFalse(task.cancelled)
    task.partial("Z pola po blokadzie")
    let landed = await waitUntil { composer.text == "Z pola po blokadzie" }
    XCTAssertTrue(landed, "text after the lock lands in the same field: \(composer.text)")
    XCTAssertEqual(endLines(rig), [])
    try await rig.finish(composer)
    XCTAssertEqual(endLines(rig), ["dictation: ended stopped"])
  }

  /// Catches a background that keeps the field's recording with the trial off (the microphone would run on in the
  /// locked phone without the switch), and a missing end line.
  func testBackgroundEndsTheFieldRecordingWithoutTheTrial() async throws {
    let rig = try Rig(choice: .system)
    let composer = rig.composer()
    composer.tap()
    let task = try await rig.speechTask()
    task.partial("Z pola")
    _ = await waitUntil { composer.text == "Z pola" }
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    let ended = await waitUntil { !composer.recording }
    XCTAssertTrue(ended, "the background ends the recording")
    XCTAssertEqual(rig.mics.open, [])
    XCTAssertEqual(composer.text, "Z pola", "its text stays in the field")
    XCTAssertEqual(endLines(rig), ["dictation: ended background"])
  }

  /// Catches a trial that keeps a recording still preparing: its microphone would open with the app in the
  /// background, without the user's tap in the foreground.
  func testTrialDoesNotKeepARecordingWhoseMicrophoneHasNotOpened() async throws {
    let rig = try Rig(choice: .system)
    rig.store.voiceAgent.lockedPhoneTrial.set(true)
    let composer = rig.composer()
    composer.tap()
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    await settle()
    XCTAssertFalse(composer.recording)
    XCTAssertEqual(rig.mics.starts["composer"] ?? 0, 0, "the microphone never opened")
    XCTAssertEqual(endLines(rig), ["dictation: ended background"])
  }

  /// Catches the trial reaching a project note's dictation: the trial covers the message field only, so the
  /// background still ends a note's recording.
  func testTrialLeavesNoteDictationEndingInTheBackground() async throws {
    let rig = try Rig(choice: .system)
    rig.store.voiceAgent.lockedPhoneTrial.set(true)
    let note = try await rig.note()
    note.tap()
    let task = try await rig.speechTask()
    task.partial("Z notatki")
    _ = await waitUntil { note.text.hasSuffix("Z notatki") }
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    let ended = await waitUntil { !note.recording }
    XCTAssertTrue(ended, "the note's recording ends")
    XCTAssertEqual(rig.mics.open, [])
  }

  /// Catches a recording kept in the background that ends there without writing the draft: the words said after the
  /// lock and the last ones, which land after the end, stay only in the field, and an app the system removes while
  /// suspended loses them. A new draft store reads the disk, with no screen coming back.
  func testBackgroundEndWritesTheWholeTextToTheDraft() async throws {
    for end in BackgroundEnd.allCases {
      let directory = FileManager.default.temporaryDirectory.appending(path: "drafts-\(UUID().uuidString)")
      defer { try? FileManager.default.removeItem(at: directory) }
      let drafts = ComposerDrafts(directory: directory)
      let rig = try Rig(choice: .system)
      let composer = try await keptInTheBackground(rig, drafts: drafts)
      self.end(end, rig)
      let ended = await waitUntil { !composer.recording }
      XCTAssertTrue(ended, "\(end): the recording ends")
      XCTAssertEqual(composer.text, Self.whole, "\(end): the last words land in the field")
      drafts.flush()
      XCTAssertEqual(ComposerDrafts(directory: directory).take(for: "s1")?.text, Self.whole, "\(end): stored draft")
    }
  }

  /// Catches a recording kept in the background that finishes there without background time: once its microphone
  /// stops nothing keeps the app running, and a suspension cuts the last words and the draft write. The time is taken
  /// while the microphone is still open, held at the draft write and ended once; a recording that goes on holds none.
  func testBackgroundEndHoldsBackgroundTimeUntilTheDraftIsWritten() async throws {
    for end in BackgroundEnd.allCases {
      let rig = try Rig(choice: .system)
      let system = rig.attachBackgroundWork()
      let composer = try await keptInTheBackground(rig)
      XCTAssertEqual(system.started, [], "\(end): a recording that goes on holds none")
      self.end(end, rig)
      XCTAssertEqual(system.started, ["dyktowanie"], "\(end): the finalization holds one")
      XCTAssertEqual(rig.mics.open, ["composer"], "\(end): taken before the microphone stops")
      let ended = await waitUntil { !composer.recording }
      XCTAssertTrue(ended, "\(end): the recording ends")
      XCTAssertEqual(rig.draftWrites.last, Rig.DraftWrite(text: Self.whole, held: 1), "\(end): written while held")
      let released = await waitUntil { !system.stopped.isEmpty }
      XCTAssertTrue(released, "\(end): the background time ends")
      XCTAssertEqual(system.stopped, [1], "\(end): ended once, after the write")
    }
  }

  /// Catches a recording kept in the background whose stream fails for good: it ends with no finalizing view, so no
  /// background time was taken, its microphone is closed, and the draft write with the words said after the lock
  /// could stay in the queue of a suspended app.
  func testBackgroundEndWithoutAFinalizationHoldsBackgroundTimeForTheDraft() async throws {
    let rig = try Rig(choice: .system)
    let system = rig.attachBackgroundWork()
    let composer = try await keptInTheBackground(rig)
    let task = try await rig.speechTask()
    task.fail(SpeechTaskError(domain: SpeechTaskError.assistantDomain, code: 1101))
    let ended = await waitUntil { !composer.recording }
    XCTAssertTrue(ended, "the recording ends")
    XCTAssertEqual(system.started, ["dyktowanie"], "the end takes background time for the draft write")
    XCTAssertEqual(
      rig.draftWrites.last, Rig.DraftWrite(text: "Before the lock and after it", held: 1), "written while held")
    let released = await waitUntil { !system.stopped.isEmpty }
    XCTAssertTrue(released, "the background time ends")
    XCTAssertEqual(system.stopped, [1])
  }

  /// Catches a draft write after a Send that waited for the last words: the send emptied the field, so the write
  /// would delete the stored draft before the message is stored.
  func testWaitingSendWritesNoDraftAtTheEndOfTheRecording() async throws {
    let rig = try Rig(choice: .system)
    let composer = rig.composer()
    composer.tap()
    let task = try await rig.speechTask()
    task.tail = "Send me."
    task.partial("Send")
    _ = await waitUntil { composer.text == "Send" }
    let before = rig.draftWrites.count
    composer.send()
    let sent = await waitUntil { composer.sent == ["Send me."] }
    XCTAssertTrue(sent, "the send took the whole text: \(composer.sent)")
    await settle()
    XCTAssertEqual(rig.draftWrites.count, before, "no draft write of this end")
  }

  /// Catches background time that ends when the draft write is only asked for: the screen queues the disk write, and
  /// a process suspended right after could be removed before the queue ran. The time is held until the disk confirms.
  func testBackgroundTimeEndsOnceTheDiskConfirmedTheDraft() async throws {
    let rig = try Rig(choice: .system)
    let system = rig.attachBackgroundWork()
    let composer = try await keptInTheBackground(rig)
    let disk = DiskGate()
    composer.onDraftOnDisk = { await disk.wait() }
    end(.silence, rig)
    let asked = await waitUntil { disk.asked }
    XCTAssertTrue(asked, "the end waits for the disk")
    XCTAssertFalse(composer.recording, "the recording ended")
    XCTAssertEqual(rig.draftWrites.last?.text, Self.whole)
    XCTAssertEqual(system.stopped, [], "held while the disk has not confirmed")
    disk.confirm()
    let released = await waitUntil { system.stopped == [1] }
    XCTAssertTrue(released, "ended once the disk confirmed: \(system.stopped)")
  }

  /// Catches a background entered while the field's recording finishes, its microphone already stopped, that holds
  /// no background time with the trial on: the trial keeps that recording, and nothing keeps the app running for its
  /// last words. With the trial off the background takes the time too.
  func testBackgroundDuringTheFinalizationHoldsBackgroundTime() async throws {
    for trial in [false, true] {
      let rig = try Rig(choice: .system)
      rig.clock = VoiceAgentRowScheduler()
      rig.store.voiceAgent.lockedPhoneTrial.set(trial)
      let system = rig.attachBackgroundWork()
      let composer = rig.composer()
      composer.tap()
      let task = try await rig.speechTask()
      task.holdsEnd = true
      task.tail = "Finishing words."
      task.partial("Finishing")
      _ = await waitUntil { composer.text == "Finishing" }
      composer.tap()
      let finishing = await waitUntil { task.audioEnded }
      XCTAssertTrue(finishing, "trial \(trial): the microphone stopped, the recognizer finishes")
      XCTAssertEqual(rig.mics.open, [])
      NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
      let held = await waitUntil { system.started == ["dyktowanie"] }
      XCTAssertTrue(held, "trial \(trial): background time for the last words: \(system.started)")
      task.answerEnd()
      let ended = await waitUntil { !composer.recording }
      XCTAssertTrue(ended, "trial \(trial): the recording ends")
      XCTAssertEqual(rig.draftWrites.last, Rig.DraftWrite(text: "Finishing words.", held: 1), "trial \(trial)")
      let released = await waitUntil { !system.stopped.isEmpty }
      XCTAssertTrue(released, "trial \(trial): the background time ends")
      XCTAssertEqual(system.stopped, [1], "trial \(trial)")
    }
  }

  /// Catches a field that goes away with its screen mid-recording without an end line: the recorder's view does not
  /// reach a field in its deinit. One line, without the text.
  func testDeallocatedFieldWritesOneEndLine() async throws {
    let rig = try Rig(choice: .system)
    var composer: ComposerDriver? = rig.composer()
    composer?.tap()
    let task = try await rig.speechTask()
    task.partial("Private words")
    _ = await waitUntil { composer?.text == "Private words" }
    weak var gone = composer?.dictation
    composer = nil
    let deallocated = await waitUntil { gone == nil }
    XCTAssertTrue(deallocated, "the field goes with its screen")
    await settle()
    XCTAssertEqual(endLines(rig), ["dictation: ended hand-off"])
    XCTAssertFalse(rig.store.reporter.pending.contains { $0.contains("Private") }, "no line carries the text")
  }

  /// How a recording kept in the background ends there: by itself after a minute of silence, or from outside the
  /// app's screens.
  private enum BackgroundEnd: CaseIterable { case silence, lockScreen }

  private static let whole = "Before the lock and after it, to the end."

  /// A message-field recording on the system route with the trial on, kept in the background on a clock the test
  /// moves: words before the lock, the screen's draft write at the lock, words after it, and last words that only the
  /// end of the audio gives.
  private func keptInTheBackground(_ rig: Rig, drafts: ComposerDrafts? = nil) async throws -> ComposerDriver {
    rig.clock = VoiceAgentRowScheduler()
    rig.store.voiceAgent.lockedPhoneTrial.set(true)
    let composer = rig.composer(drafts: drafts)
    composer.tap()
    let task = try await rig.speechTask()
    task.tail = Self.whole
    task.partial("Before the lock")
    _ = await waitUntil { composer.text == "Before the lock" }
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    composer.onDraftWrite?()
    task.partial("Before the lock and after it")
    let landed = await waitUntil { composer.text == "Before the lock and after it" }
    XCTAssertTrue(landed, "text after the lock lands in the field: \(composer.text)")
    XCTAssertTrue(composer.recording, "the trial keeps the recording")
    return composer
  }

  private func end(_ end: BackgroundEnd, _ rig: Rig) {
    switch end {
    case .silence: rig.clock?.advance(VoiceTiming().silenceLimit)
    case .lockScreen: XCTAssertEqual(DictationCenter.shared.endFromLockScreen(), .dictation)
    }
  }

  private func endLines(_ rig: Rig) -> [String] {
    rig.store.reporter.pending.filter { $0.hasPrefix("dictation: ended") }
  }

  // MARK: - Microphone use

  /// Catches a field recording reported before its microphone opened (an observer outside the app's screens would
  /// show a recording that may never start), one never reported, a use with more in it than its flags and its
  /// session's project and name (the field's text would reach the Lock Screen), and an open or an end the observers
  /// never learn.
  func testFieldRecordingReportsItsUseWhileItsMicrophoneIsOpen() async throws {
    let rig = try Rig(choice: .soniox)
    let json = #"{"type":"sessions-snapshot","sessions":[\#(DecisionDockTests.session(state: "running", since: 1))]}"#
    try DecisionDockTests.frame(rig.store, json, source: .global)
    let center = DictationCenter.shared
    let told = Told()
    center.observe { [told] in told.count += 1 }
    let composer = rig.composer()
    composer.tap()
    XCTAssertTrue(composer.dictation.isActive)
    XCTAssertNil(center.use, "a recording still preparing reports none")
    let beforeOpen = told.count
    let opened = await waitUntil { center.use != nil }
    XCTAssertTrue(opened, "the open microphone is reported")
    XCTAssertEqual(rig.mics.open, ["composer"])
    XCTAssertGreaterThan(told.count, beforeOpen, "the open reaches the observers")
    let socket = try await rig.socket()
    rig.mics.speak("composer")
    socket.message(#"{"tokens":[{"text":"Dictated words","is_final":false}]}"#)
    let streaming = await waitUntil { center.use?.soniox == true && composer.text == "Dictated words" }
    XCTAssertTrue(streaming, "\(String(describing: center.use)), field: \(composer.text)")
    let session = MicrophoneSubject.session(project: "project", name: nil)
    XCTAssertEqual(
      center.use,
      MicrophoneUse(kind: .dictation, audio: true, openAI: false, soniox: true, phase: .dictating, subject: session))
    XCTAssertFalse(String(reflecting: center.use).contains("Dictated words"), "the field's text stays out")

    let beforeEnd = told.count
    try await rig.finish(composer)
    XCTAssertNil(center.use, "an ended recording reports none")
    XCTAssertGreaterThan(told.count, beforeEnd, "the end reaches the observers")
  }

  /// Catches a field that goes away mid-recording (its screen gone without `leave`) while the center still reports
  /// it, or whose going the observers never learn.
  func testDeallocatedFieldLeavesNoUse() async throws {
    let rig = try Rig(choice: .system)
    let center = DictationCenter.shared
    let told = Told()
    center.observe { [told] in told.count += 1 }
    var composer: ComposerDriver? = rig.composer()
    composer?.tap()
    let opened = await waitUntil { center.use != nil }
    XCTAssertTrue(opened, "the open microphone is reported")
    weak var gone = composer?.dictation
    let before = told.count
    composer = nil
    let deallocated = await waitUntil { gone == nil }
    XCTAssertTrue(deallocated, "the field goes with its screen")
    XCTAssertNil(center.use)
    XCTAssertGreaterThan(told.count, before, "the observers learn it")
    XCTAssertEqual(rig.mics.open, [], "the microphone closes with the field")
  }

  /// Catches an end from outside the app's screens that loses the last words, sends the field, leaves the
  /// microphone open, or writes another end line than `live-activity`; no line carries the text.
  func testEndFromLockScreenKeepsTheTextInTheFieldWithoutSending() async throws {
    let rig = try Rig(choice: .soniox)
    rig.store.voiceAgent.lockedPhoneTrial.set(true)
    let composer = rig.composer()
    composer.tap()
    let socket = try await rig.socket()
    socket.tail = "Dictated on the lock screen."
    socket.message(#"{"tokens":[{"text":"Dictated on","is_final":false}]}"#)
    let shown = await waitUntil { composer.text == "Dictated on" }
    XCTAssertTrue(shown, "hypothesis in the field: \(composer.text)")
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    await settle()
    XCTAssertTrue(composer.recording, "the trial keeps the recording in the background")

    XCTAssertEqual(DictationCenter.shared.endFromLockScreen(), .dictation)
    let ended = await waitUntil { !composer.recording }
    XCTAssertTrue(ended, "the recording ends")
    XCTAssertEqual(composer.text, "Dictated on the lock screen.", "the last words land in the same field")
    XCTAssertEqual(composer.sent, [], "nothing is sent")
    XCTAssertEqual(rig.mics.open, [])
    XCTAssertNil(DictationCenter.shared.use)
    XCTAssertEqual(endLines(rig), ["dictation: ended live-activity"])
    XCTAssertFalse(rig.store.reporter.pending.contains { $0.contains("Dictated") }, "no line carries the text")
  }

  /// Catches a project note's recording reported as the microphone's use, or ended from outside the app's screens:
  /// the locked-phone trial covers the message field only.
  func testNoteRecordingReportsNoUse() async throws {
    let rig = try Rig(choice: .system)
    let note = try await rig.note()
    note.tap()
    let task = try await rig.speechTask()
    task.partial("From the note")
    let landed = await waitUntil { note.text.hasSuffix("From the note") }
    XCTAssertTrue(landed, "\(note.text)")
    XCTAssertTrue(note.recording)
    XCTAssertNil(DictationCenter.shared.use)
    XCTAssertNil(DictationCenter.shared.endFromLockScreen())
    await settle()
    XCTAssertTrue(note.recording, "the note's recording goes on")
    XCTAssertEqual(rig.mics.open, ["note"])
    try await rig.finish(note)
  }

  // MARK: - Wpięcie w ekran sesji

  /// Ekran sesji wpina nawigację: stuknięcie przy trasie, która pyta, stawia arkusz „Dyktowanie”; drugie stuknięcie
  /// nie buduje go od nowa.
  func testSessionScreenOpensDictationSheet() throws {
    let store = try SessionToastTests.makeStore(messages: 3)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    controller.installVoice(navigation: navigation)
    controller.loadViewIfNeeded()
    XCTAssertEqual(store.dictationRoute, .ask(.noChoice))
    controller.dictation.toggle()
    let sheet = try XCTUnwrap(navigation.dictationSheet, "arkusz „Dyktowanie”")
    controller.dictation.toggle()
    XCTAssertEqual(navigation.dictationSheet, sheet, "ten sam arkusz")
    XCTAssertFalse(controller.dictation.isActive, "nic nie nagrywa")
  }
}

// MARK: - Stanowisko

private let token: VoiceToken = {
  let json = #"""
    {"apiKey":"snx_temp_test_a","expiresAt":"2026-08-23T12:00:00.000Z",
     "webSocketUri":"wss://stt-rt.eu.soniox.com/transcribe-websocket","model":"stt-rt-v6","maxSessionSeconds":900,
     "config":{"languageHints":["pl","en"],"audioFormat":"pcm_s16le","sampleRate":16000,"numChannels":1}}
    """#
  // swiftlint:disable:next force_try
  return try! JSONDecoder().decode(VoiceToken.self, from: Data(json.utf8))
}()

/// Co serwer powiedział o dyktowaniu: bez sondy, `voiceEnabled: false`, `voiceEnabled: true`.
private enum ServerVoice: CustomStringConvertible {
  case unknown, disabled, enabled

  var description: String {
    switch self {
    case .unknown: "bez sondy"
    case .disabled: "voiceEnabled false"
    case .enabled: "voiceEnabled true"
    }
  }
}

private enum Host: String, CaseIterable, CustomStringConvertible {
  case composer, note
  var description: String { rawValue }
}

/// Liczniki gospodarza: otwarcia mikrofonu, `voiceToken()`, połączenia z Soniox.
private struct Counts: Equatable {
  var mic = 0
  var mint = 0
  var connect = 0
}

/// Calls of a microphone center's observer. The app's center keeps its observers for the process, so the observer
/// captures only this box, never a host or the rig.
@MainActor
private final class Told {
  var count = 0
}

@MainActor
private final class Rig {
  /// Results of `voiceToken()` in order, and the count of its calls.
  let tokens = VoiceTokenScript(otherwise: .success(token))
  let store: RarogStore
  let mics = MicLog()
  let speech = RouteSpeech()
  private(set) var sockets: [RouteSocket] = []
  private(set) var opened: [URL?] = []
  /// Zdarzenia widoku z otwartym mikrofonem bez wskaźnika nagrywania (pole wiadomości).
  var violations: [String] = []
  /// The microphone permission is already granted (the key fetch then starts while the microphone opens).
  var micGranted = false
  /// `false`: new sockets never open (a connection that hangs).
  var socketsOpen = true
  /// The recorder's clock for hosts made after it is set, moved by the test; `nil` = real time.
  var clock: VoiceAgentRowScheduler?
  /// The system's background tasks under the store's background work (`attachBackgroundWork()`).
  private(set) var background: FakeBackgroundSystem?
  /// Each draft write the message field asked for (the session screen's `persistDraftNow`).
  private(set) var draftWrites: [DraftWrite] = []

  /// The field's text at a draft write, and how many background tasks were held then.
  struct DraftWrite: Equatable {
    var text: String
    var held: Int
  }

  init(choice: DictationChoice?, sonioxAllowed: Bool = true, server: ServerVoice = .enabled) throws {
    store = RarogStore(
      transport: UIKitTransport.scriptedVoiceTokens(tokens), rules: MutationRules(),
      outboxDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString), clientBuild: 1)
    store.dispatch(.loggedIn)
    store.dispatch(.streamOpened(.global, resumedWithCursor: false))
    let hello = #"{"type":"hello","protocolVersion":3,"serverStartId":"route"}"#
    store.dispatch(.frame(try EventDecoder.decode(Data(hello.utf8)).get().event, source: .global, cursor: nil))
    switch server {
    case .unknown: break
    case .disabled: store.dispatch(.versionProbed(try Self.version(voice: false)))
    case .enabled: store.dispatch(.versionProbed(try Self.version(voice: true)))
    }
    store.attachDictation(.memory(sonioxAllowed: sonioxAllowed, choice: choice))
  }

  private static func version(voice: Bool) throws -> VersionInfo {
    let json = #"{"version":"0.1.0","protocolVersion":3,"serverStartId":"route","tailnet":null,"voiceEnabled":\#(voice)}"#
    return try JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
  }

  func services(_ host: Host) -> VoiceServices {
    var timing = VoiceTiming()
    timing.reconnectDelays = [0.01, 0.01, 0.01]
    timing.minMintInterval = 0
    timing.finalizeTimeout = 0.3
    timing.stopConnectWait = 0.3
    let scheduler: any VoiceScheduler = clock ?? TaskVoiceScheduler()
    return VoiceServices(
      microphone: { [mics] in RouteMicrophone(tag: host.rawValue, log: mics) },
      connect: { [weak self] _, _, events in
        let socket = RouteSocket(events: events, opens: self?.socketsOpen ?? true)
        self?.sockets.append(socket)
        return socket
      },
      speech: { [speech] in speech }, scheduler: scheduler, timing: timing, language: .pl,
      open: { [weak self] url in self?.opened.append(url) },
      microphoneGranted: { [weak self] in self?.micGranted ?? false })
  }

  func counts(_ host: Host) -> Counts {
    Counts(mic: mics.starts[host.rawValue] ?? 0, mint: tokens.mints, connect: sockets.count)
  }

  /// The message field; `drafts` gets each draft write as the session screen writes it, under session `s1`.
  func composer(drafts: ComposerDrafts? = nil) -> ComposerDriver {
    let driver = ComposerDriver(store: store, services: services(.composer))
    driver.dictation.onActiveChange = { [weak self, weak driver] in
      guard let self, let driver, self.mics.open.contains("composer"), !driver.recording else { return }
      self.violations.append("composer: \(self.mics.events)")
    }
    driver.onDraftWrite = { [weak self, weak driver] in
      guard let self, let driver else { return }
      let held = self.background.map { $0.started.count - $0.stopped.count } ?? 0
      self.draftWrites.append(DraftWrite(text: driver.text, held: held))
      drafts?.persist(text: driver.text, attachments: [], for: "s1")
    }
    return driver
  }

  /// The store's background work through the app's adapter over a fake system, kept by the rig: the fake's
  /// closures hold it unowned.
  func attachBackgroundWork() -> FakeBackgroundSystem {
    let system = FakeBackgroundSystem()
    store.pushRuntime.background = UIKitBackgroundWork(system: system.system)
    background = system
    return system
  }

  func note() async throws -> NoteDriver {
    let notes = ProjectNotes(io: NoteIO(
      fetch: { _ in .loaded(NotesDoc(text: "- punkt", updatedAt: 1)) },
      save: { _, _, _ in .saved(2) },
      sleep: { _ in try? await Task.sleep(for: .seconds(3600)) }))
    let doc = notes.document("/Users/demo/Projects/rarog")
    doc.open()
    for _ in 0..<200 where !doc.editable {
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertTrue(doc.editable, "pierwszy odczyt dał pole do pisania")
    return NoteDriver(notes: notes, doc: doc, dictation: NoteDictation(store: store, services: services(.note)))
  }

  func driver(_ host: Host) async throws -> any Driver {
    switch host {
    case .composer: composer()
    case .note: try await note()
    }
  }

  func socket() async throws -> RouteSocket {
    let ready = await waitUntil { self.sockets.last?.isOpen == true }
    XCTAssertTrue(ready, "gniazdo otwarte")
    return try XCTUnwrap(sockets.last)
  }

  func speechTask() async throws -> RouteSpeechTask {
    let ready = await waitUntil { self.speech.task?.cancelled == false }
    XCTAssertTrue(ready, "zadanie rozpoznawania")
    return try XCTUnwrap(speech.task)
  }

  /// Drugie stuknięcie kończy nagranie z zatwierdzeniem; czeka na koniec.
  func finish(_ driver: any Driver) async throws {
    driver.tap()
    let done = await waitUntil { !driver.recording }
    XCTAssertTrue(done, "nagranie skończone")
  }
}

/// Gospodarz pod testem: pole wiadomości albo notatka, widziane tak samo.
@MainActor
private protocol Driver: AnyObject {
  func tap()
  var text: String { get }
  /// Wiersz stanu dyktowania; `nil` = schowany.
  var status: String? { get }
  var settingsShown: Bool { get }
  func pressSettings()
  /// Wskaźnik nagrywania.
  var recording: Bool { get }
  var microphoneShown: Bool { get }
  var editable: Bool { get }
  /// Ile razy stuknięcie otworzyło ekran „Dyktowanie”.
  var asks: Int { get }
  /// Ekran „Dyktowanie” zamknięty (wybór albo „Wstecz”).
  func dismissAsk()
}

/// The disk's answer to a draft write, given when the test says so.
@MainActor
private final class DiskGate {
  private var waiting: CheckedContinuation<Void, Never>?

  var asked: Bool { waiting != nil }

  func wait() async {
    await withCheckedContinuation { waiting = $0 }
  }

  func confirm() {
    waiting?.resume()
    waiting = nil
  }
}

@MainActor
private final class ComposerDriver: Driver {
  let composer = ComposerView(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
  let dictation: ComposerDictation
  private(set) var asks = 0
  /// The field's text at each send, as the session screen's send would take it.
  private(set) var sent: [String] = []
  /// The draft write the dictation asks for (the session screen's `persistDraftNow`).
  var onDraftWrite: (@MainActor () -> Void)?
  /// The wait for the disk to run that write (the draft store's `written`); `nil` confirms at once.
  var onDraftOnDisk: (@MainActor () async -> Void)?

  init(store: RarogStore, services: VoiceServices) {
    dictation = ComposerDictation(services: services)
    composer.onSend = { [weak self] in
      guard let self else { return }
      self.sent.append(self.composer.text)
    }
    dictation.install(
      in: composer, store: store, sessionId: "s1", persistDraft: { [weak self] in self?.onDraftWrite?() },
      draftOnDisk: { [weak self] in await self?.onDraftOnDisk?() })
    dictation.onAsk = { [weak self] in self?.asks += 1 }
    dictation.render(editable: true)
    composer.layoutIfNeeded()
  }

  var mic: UIButton { dictation.buttons.mic }
  func tap() { mic.sendActions(for: .primaryActionTriggered) }
  /// Send, as the field's primary button calls it.
  func send() { composer.onSend?() }
  var text: String { composer.text }
  var status: String? {
    guard !dictation.status.isHidden else { return nil }
    return subviews(of: UILabel.self, in: dictation.status).first { $0.accessibilityIdentifier == "composer.voice.status" }?.text
  }
  private var settingsButton: UIButton? {
    subviews(of: UIButton.self, in: dictation.status).first { $0.accessibilityIdentifier == "composer.voice.settings" }
  }
  var settingsShown: Bool { status != nil && settingsButton?.isHidden == false }
  func pressSettings() { settingsButton?.sendActions(for: .primaryActionTriggered) }
  var recording: Bool { mic.accessibilityTraits.contains(.selected) }
  var microphoneShown: Bool { !mic.isHidden }
  var editable: Bool { composer.isEditable }
  func dismissAsk() {}
}

@MainActor
private final class NoteDriver: Driver {
  /// Notatki trzymają dokument przy życiu.
  let notes: ProjectNotes
  let doc: NoteDocument
  let dictation: NoteDictation
  private(set) var asks = 0

  init(notes: ProjectNotes, doc: NoteDocument, dictation: NoteDictation) {
    self.notes = notes
    self.doc = doc
    self.dictation = dictation
  }

  func tap() {
    let before = dictation.choosing
    dictation.toggle(doc: doc, editor: nil)
    if !before, dictation.choosing { asks += 1 }
  }

  var text: String { doc.text }
  var status: String? { dictation.statusLine?.text }
  var settingsShown: Bool { dictation.statusLine?.action == .settings }
  func pressSettings() { dictation.openSettings() }
  var recording: Bool { dictation.active }
  var microphoneShown: Bool { NoteDictation.offersMicrophone(editable: doc.editable, recording: dictation.active) }
  var editable: Bool { doc.editable }
  func dismissAsk() { dictation.choosing = false }
}

// MARK: - Atrapy

/// Dziennik mikrofonów obu gospodarzy: otwarcia po znaczniku, kolejność, otwarte teraz.
@MainActor
private final class MicLog {
  var denied = false
  private(set) var starts: [String: Int] = [:]
  private(set) var events: [String] = []
  private(set) var open: [String] = []
  private(set) var maxOpen = 0
  /// Frame delivery of each open microphone.
  var feeds: [String: @MainActor (VoiceFrame) -> Void] = [:]

  /// 100 ms of speech from the open microphone with this tag.
  func speak(_ tag: String) {
    feeds[tag]?(VoiceFrame(pcm: Data(count: VoiceFrame.bytesPerSecond / 10), peak: 0.5))
  }

  func started(_ tag: String) { starts[tag, default: 0] += 1 }

  func opened(_ tag: String) {
    events.append("open \(tag)")
    open.append(tag)
    maxOpen = max(maxOpen, open.count)
  }

  func closed(_ tag: String) {
    events.append("close \(tag)")
    open.removeAll { $0 == tag }
  }
}

@MainActor
private final class RouteMicrophone: VoiceMicrophone {
  private let tag: String
  private let log: MicLog
  private var isOpen = false

  init(tag: String, log: MicLog) {
    self.tag = tag
    self.log = log
  }

  func start(
    onFrame: @escaping @MainActor (VoiceFrame) -> Void, onInterrupt: @escaping @MainActor () -> Void
  ) async throws(VoiceMicError) {
    log.started(tag)
    if log.denied { throw .denied }
    isOpen = true
    log.feeds[tag] = onFrame
    log.opened(tag)
  }

  func flush() async {}

  func stop() {
    guard isOpen else { return }
    isOpen = false
    log.feeds[tag] = nil
    log.closed(tag)
  }
}

/// Gniazdo Soniox: otwiera się w następnym obrocie; pusta ramka (koniec strumienia) daje `finished`.
@MainActor
private final class RouteSocket: VoiceSocket {
  private let events: VoiceSocketEvents
  private(set) var isOpen = false
  private var closed = false
  /// Final words Soniox gives only after the end of the audio (the tail of a recording); `nil` = none.
  var tail: String?

  /// `opens: false` = the connection hangs and never opens.
  init(events: VoiceSocketEvents, opens: Bool = true) {
    self.events = events
    guard opens else { return }
    Task { @MainActor [weak self] in
      guard let self, !self.closed else { return }
      self.isOpen = true
      events.opened()
    }
  }

  /// What Soniox does after the end frame: the tail and `finished`, a drop, or a 429 error frame.
  enum End { case finished, drop, limit }
  var end = End.finished

  func send(text: String) {
    guard !closed, text.isEmpty else { return }
    Task { @MainActor [weak self] in
      guard let self, !self.closed else { return }
      switch self.end {
      case .finished:
        if let tail = self.tail { self.events.message(#"{"tokens":[{"text":"\#(tail)","is_final":true}]}"#) }
        self.events.message(#"{"finished":true}"#)
      case .drop:
        self.drop()
      case .limit:
        self.events.message(#"{"error_code":429,"error_type":"limit_exceeded","error_message":"Limit exceeded."}"#)
      }
    }
  }

  /// Opens a socket made with `opens: false`.
  func open() {
    guard !closed, !isOpen else { return }
    isOpen = true
    events.opened()
  }

  func send(data: Data) {}

  func close() { closed = true }

  var isClosed: Bool { closed }

  func message(_ json: String) { events.message(json) }

  /// Zerwanie z zewnątrz (sieć).
  func drop() {
    closed = true
    events.closed()
  }
}

/// Rozpoznawanie mowy Apple: zgoda, odpowiedź na pytanie, recognizer dla locale.
@MainActor
private final class RouteSpeech: SpeechRecognition {
  var status: SpeechAuthorization = .authorized
  var answer: SpeechAuthorization = .authorized
  var facts: SpeechRecognizerFacts? = SpeechRecognizerFacts(
    locale: "pl-PL", isAvailable: true, supportsOnDeviceRecognition: true)
  private(set) var asked = 0
  /// Ostatnie zadanie rozpoznawania.
  private(set) var task: RouteSpeechTask?

  func authorization() -> SpeechAuthorization { status }

  func requestAuthorization() async -> SpeechAuthorization {
    asked += 1
    status = answer
    return answer
  }

  func recognizer(locale: String) -> (any SpeechRecognizer)? {
    guard let facts else { return nil }
    return RouteRecognizer(facts: facts) { [weak self] in self?.task = $0 }
  }
}

@MainActor
private final class RouteRecognizer: SpeechRecognizer {
  let facts: SpeechRecognizerFacts
  private let made: @MainActor (RouteSpeechTask) -> Void

  init(facts: SpeechRecognizerFacts, made: @escaping @MainActor (RouteSpeechTask) -> Void) {
    self.facts = facts
    self.made = made
  }

  func recognize(_ request: SpeechRequest, events: SpeechTaskEvents) -> any SpeechTask {
    let task = RouteSpeechTask(request: request, events: events)
    made(task)
    return task
  }
}

/// Zadanie: wyniki i błędy podaje test; koniec dźwięku oddaje ostatnią hipotezę jako wynik końcowy.
@MainActor
private final class RouteSpeechTask: SpeechTask {
  let request: SpeechRequest
  private let events: SpeechTaskEvents
  private(set) var cancelled = false
  private var last = ""
  /// The final result only the end of the audio gives (a recording's last words); `nil` = the last hypothesis.
  var tail: String?
  /// `true`: the end of the audio waits for `answerEnd()`.
  var holdsEnd = false
  private(set) var audioEnded = false

  init(request: SpeechRequest, events: SpeechTaskEvents) {
    self.request = request
    self.events = events
  }

  func append(_ pcm: Data) {}

  func endAudio() {
    audioEnded = true
    if !holdsEnd { answerEnd() }
  }

  /// The recognizer's answer to the end of the audio: the tail, or else the last hypothesis, as the final result.
  func answerEnd() {
    Task { @MainActor [weak self] in
      guard let self, !self.cancelled else { return }
      self.events.result(self.tail ?? self.last, .final)
    }
  }

  func cancel() { cancelled = true }

  func partial(_ text: String) {
    last = text
    events.result(text, .partial)
  }

  /// Koniec fragmentu po pauzie: kolejne wyniki liczą się od zera.
  func segmentEnd(_ text: String) {
    last = ""
    events.result(text, .segmentEnd)
  }

  func fail(_ error: SpeechTaskError) { events.failure(error) }
}

// MARK: - Pomocnicze

@MainActor
private func waitUntil(timeout: Duration = .seconds(3), _ condition: @MainActor () -> Bool) async -> Bool {
  let deadline = ContinuousClock.now + timeout
  while !condition() {
    if ContinuousClock.now > deadline { return false }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return true
}

/// Chwila na zadania w tle (start nagrania, mint): stan „nic się nie stało” sprawdzamy po niej, nie od razu.
@MainActor
private func settle() async {
  try? await Task.sleep(for: .milliseconds(80))
}

@MainActor
private func subviews<T: UIView>(of type: T.Type, in root: UIView) -> [T] {
  root.subviews.flatMap { view -> [T] in
    (view as? T).map { [$0] + subviews(of: type, in: view) } ?? subviews(of: type, in: view)
  }
}
