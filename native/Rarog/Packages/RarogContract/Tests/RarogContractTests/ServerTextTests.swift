// Tłumacz zdań serwera `ServerText`: reguły `render`, fasada zdań składanych w apce
// i klucz katalogu. Kody prawdziwe idą przez publiczne API na wygenerowanym katalogu RarogContract; kody sztuczne
// (`fixture.*`: argument `code`, `instant`, pozycje przestawione, kod wycofany, wzorzec niezgodny z rodzajami) idą
// przez wariant wewnętrzny z deskryptorami wstrzykniętymi w teście i katalogiem-próbką celu testów
// (`Resources/Localizable.xcstrings`, klucze `server.fixture.*`).
import Foundation
@testable import RarogContract
import Testing

@Suite("tłumacz zdań serwera: reguły `render`, fasada i klucz katalogu")
struct ServerTextTests {
  static let utc = TimeZone(identifier: "UTC")!

  /// Deskryptory kodów sztucznych; ich wzorce stoją w katalogu-próbce testów.
  static let fixtureDescriptors: [String: SentenceDescriptor] = [
    "fixture.at": SentenceDescriptor(args: [.instant], retired: false),
    "fixture.because": SentenceDescriptor(args: [.code], retired: false),
    "fixture.counted": SentenceDescriptor(args: [.int], retired: false),
    "fixture.extra-position": SentenceDescriptor(args: [.text], retired: false),
    "fixture.kind-mismatch": SentenceDescriptor(args: [.int], retired: false),
    "fixture.missing": SentenceDescriptor(args: [], retired: false),
    "fixture.quiet": SentenceDescriptor(args: [.int], retired: false),
    "fixture.reason": SentenceDescriptor(args: [], retired: false),
    "fixture.retired": SentenceDescriptor(args: [], retired: true),
    "fixture.swap": SentenceDescriptor(args: [.text, .text], retired: false),
  ]

  /// Kod sztuczny na katalogu-próbce testów, w strefie UTC.
  static func fixture(_ code: String, _ args: [String] = [], _ language: CopyLanguage = .pl) -> String {
    ServerText.render(
      "SERWER", SentenceRef(code: code, args: args), language: language, descriptors: fixtureDescriptors,
      bundle: .module, timeZone: utc)
  }

  /// Kod prawdziwy przez publiczne API (katalog RarogContract, deskryptory wygenerowane).
  static func real(_ code: String, _ args: [String] = [], _ language: CopyLanguage = .pl) -> String {
    ServerText.render("SERWER", SentenceRef(code: code, args: args), language: language)
  }

  // MARK: - Tekst serwera zostaje

  @Test("brak `ref` → tekst serwera")
  func noRef() {
    #expect(ServerText.render("x", nil, language: .pl) == "x")
    #expect(ServerText.render("x", nil, language: .en) == "x")
  }

  @Test("kod poza deskryptorami → tekst serwera")
  func unknownCode() {
    #expect(Self.real("rest.no-such-code") == "SERWER")
    #expect(Self.fixture("fixture.unknown") == "SERWER")
  }

  @Test("zła liczba argumentów → tekst serwera")
  func wrongArgumentCount() {
    #expect(Self.real("rest.session-not-found", ["1"]) == "SERWER")
    #expect(Self.real("session.fallback-label") == "SERWER")
    #expect(Self.real("session.fallback-label", ["3", "4"]) == "SERWER")
  }

  @Test("klucz bez wzorca w katalogu → tekst serwera")
  func keyWithoutPattern() {
    #expect(Self.fixture("fixture.missing") == "SERWER")
  }

  @Test("wzorzec z pozycją spoza deskryptora albo specyfikatorem innego rodzaju → tekst serwera")
  func patternMismatch() {
    #expect(Self.fixture("fixture.extra-position", ["a"]) == "SERWER")
    #expect(Self.fixture("fixture.kind-mismatch", ["3"]) == "SERWER")
  }

  // MARK: - Zdania prawdziwego katalogu

  @Test("zdanie bez argumentów po polsku i po angielsku")
  func plainSentence() {
    #expect(Self.real("rest.session-not-found", [], .pl) == "Nie ma takiej sesji.")
    #expect(Self.real("rest.session-not-found", [], .en) == "That session doesn't exist.")
  }

  @Test("argument int: liczba dziesiętna w zakresie Int64, inaczej tekst serwera")
  func intArgument() {
    #expect(Self.real("session.fallback-label", ["3"], .pl) == "sesja 3")
    #expect(Self.real("session.fallback-label", ["3"], .en) == "session 3")
    #expect(Self.real("session.fallback-label", ["12345"], .pl) == "sesja 12345")
    #expect(Self.real("session.fallback-label", ["abc"]) == "SERWER")
    #expect(Self.real("session.fallback-label", [""]) == "SERWER")
    #expect(Self.real("session.fallback-label", ["3.5"]) == "SERWER")
    #expect(Self.real("session.fallback-label", ["9223372036854775808"]) == "SERWER")
    #expect(Self.real("session.fallback-label", ["-9223372036854775809"]) == "SERWER")
  }

  @Test(
    "argument plural po polsku: znak, znaki, znaków",
    arguments: [(1, "znak"), (2, "znaki"), (5, "znaków"), (22, "znaki"), (101, "znaków"), (12345, "znaków")])
  func polishPlural(count: Int, word: String) {
    #expect(Self.real("transcript.truncation-footer", [String(count)], .pl) == "\n… (ucięto \(count) \(word))")
  }

  @Test("argument plural po angielsku: character, characters", arguments: [(1, "character"), (2, "characters")])
  func englishPlural(count: Int, word: String) {
    #expect(Self.real("transcript.truncation-footer", [String(count)], .en) == "\n… (\(count) \(word) cut off)")
  }

  @Test("argument plural nieparsowalny albo poza Int64 → tekst serwera")
  func pluralUnparsable() {
    #expect(Self.real("transcript.truncation-footer", ["dużo"]) == "SERWER")
    #expect(Self.real("transcript.truncation-footer", ["99999999999999999999"]) == "SERWER")
  }

  // MARK: - Instant

  static let resetISO = "2026-11-06T10:05:00.000Z"
  static let resetDate = Date(timeIntervalSince1970: 1_793_959_500)

  @Test("`state.limit-reached`: godzina przez `CopyDate.clock` w locale języka")
  func limitReached() {
    let ref = SentenceRef(code: "state.limit-reached", args: [Self.resetISO])
    let token = "resetAt=" + Self.resetISO
    #expect(ServerText.render(token, ref, language: .pl, timeZone: Self.utc) == "Limit planu — spróbuj po 10:05.")
    let clock = CopyDate.clock(Self.resetDate, timeZone: Self.utc, locale: Locale(identifier: "en_US"))
    #expect(ServerText.render(token, ref, language: .en, timeZone: Self.utc) == "Plan limit reached. Try again after \(clock).")
  }

  @Test("`state.limit-reached` z chwilą nieparsowalną → tekst serwera (token `resetAt`)")
  func limitReachedUnparsable() {
    #expect(ServerText.render(
      "resetAt=jutro", SentenceRef(code: "state.limit-reached", args: ["jutro"]), language: .pl) == "resetAt=jutro")
  }

  @Test("argument instant: poprawny → `CopyDate`, bez ułamka sekund też; nieistniejący dzień → tekst serwera")
  func instantArgument() {
    let locale = Locale(identifier: "pl_PL")
    let expected = "Wraca o " + CopyDate.string(Self.resetDate, template: "MMMdjmm", timeZone: Self.utc, locale: locale) + "."
    #expect(Self.fixture("fixture.at", [Self.resetISO]) == expected)
    #expect(Self.fixture("fixture.at", ["2026-11-06T10:05:00Z"]) == expected)
    #expect(Self.fixture("fixture.at", ["2026-11-06T11:05:00+01:00"]) == expected)
    #expect(Self.fixture("fixture.at", ["2028-02-29T10:00:00Z"]) != "SERWER")
    #expect(Self.fixture("fixture.at", ["2026-02-30T10:00:00Z"]) == "SERWER")
    #expect(Self.fixture("fixture.at", ["2026-11-06T25:00:00Z"]) == "SERWER")
    #expect(Self.fixture("fixture.at", ["2026-11-06T10:61:00Z"]) == "SERWER")
    #expect(Self.fixture("fixture.at", ["wczoraj"]) == "SERWER")
    #expect(Self.fixture("fixture.at", [""]) == "SERWER")
  }

  // MARK: - Argument code

  @Test("argument code: znany kod bez argumentów → podzdanie przetłumaczone")
  func codeArgumentKnown() {
    #expect(Self.fixture("fixture.because", ["fixture.reason"], .pl) == "Odmowa: karta jest nieaktualna")
    #expect(Self.fixture("fixture.because", ["fixture.reason"], .en) == "Refused: the card is stale")
  }

  @Test("argument code: kod nieznany, z własnymi argumentami albo bez wzorca → tekst serwera")
  func codeArgumentRejected() {
    #expect(Self.fixture("fixture.because", ["fixture.nope"]) == "SERWER")
    #expect(Self.fixture("fixture.because", ["fixture.counted"]) == "SERWER")
    #expect(Self.fixture("fixture.because", ["fixture.quiet"]) == "SERWER")
    #expect(Self.fixture("fixture.because", ["fixture.missing"]) == "SERWER")
    #expect(Self.fixture("fixture.because", [""]) == "SERWER")
  }

  @Test("argument code w prawdziwym katalogu: powód błędu jako zdanie własne bez argumentów → całość po polsku")
  func nestedErrorReasonCode() {
    #expect(Self.real("state.herdr-launch-failed.code", ["herdr.agent-vanished"])
      == "nie udało się założyć panelu: Agent `claude` zniknął zaraz po starcie.")
    #expect(Self.real("restart.failed.code", ["herdr.agent-vanished"])
      == "Nie udało się uruchomić ponownie: Agent `claude` zniknął zaraz po starcie.")
    #expect(Self.real("commands.panel-send-failed.code", ["herdr.connect-timeout"])
      == "⚠ Wysyłka do panelu nie powiodła się: Przekroczony czas łączenia z herdr (2 s).")
    #expect(Self.real("commands.send-refused", ["commands.bare-slash"])
      == "⚠ Wiadomość nie została wysłana: Sam ukośnik wykonałby pierwszą podpowiedź CLI — napisz nazwę komendy.")
    #expect(Self.real("commands.interrupt-failed.mac.code", ["herdr.connect-timeout"])
      == "⚠ Przerwanie tury nie powiodło się. Otwórz panel w herdr na Macu i naciśnij Esc tam. "
      + "Powód: Przekroczony czas łączenia z herdr (2 s).")
    #expect(Self.real("commands.send-refused", ["uploads.module-missing"])
      == "⚠ Wiadomość nie została wysłana: Brak modułu załączników — załącznik nie został zapisany.")
    #expect(Self.real("state.herdr-launch-failed.code", ["herdr.agent-vanished"], .en)
      == "couldn't create the pane: The `claude` agent disappeared right after starting.")
    // Podkod z własnymi argumentami nie przechodzi: serwer takie zdanie wysyła samo, nie jako podkod.
    #expect(Self.real("restart.failed.code", ["herdr.launch-timeout"]) == "SERWER")
  }

  // MARK: - Pozycje, kody wycofane, tekst argumentu

  @Test("pozycje przestawione i powtórzone")
  func swappedAndRepeatedPositions() {
    #expect(Self.fixture("fixture.swap", ["A", "B"], .pl) == "B przed A, potem znowu A")
    #expect(Self.fixture("fixture.swap", ["A", "B"], .en) == "B before A, then A again")
  }

  @Test("argument text idzie dosłownie, także z `%`")
  func textArgumentVerbatim() {
    #expect(Self.fixture("fixture.swap", ["100%", "%1$@ %d"], .pl) == "%1$@ %d przed 100%, potem znowu 100%")
  }

  @Test("kod wycofany (`retired`) tłumaczy się jak zwykły")
  func retiredCode() {
    #expect(Self.fixture("fixture.retired", [], .pl) == "Stare zdanie")
    #expect(Self.fixture("fixture.retired", [], .en) == "Old sentence")
  }

  @Test("każdy kod prawdziwego katalogu ma wzorzec po polsku i po angielsku zgodny z rodzajami argumentów")
  func everyRealCodeTranslates() {
    let sample: [SentenceArgKind: String] = [.int: "2", .plural: "2", .text: "t", .instant: Self.resetISO]
    for (code, descriptor) in SentenceDescriptors.table.sorted(by: { $0.key < $1.key }) {
      let args = descriptor.args.map { sample[$0] ?? "" }
      if descriptor.args.contains(.code) { continue }
      for language in [CopyLanguage.pl, .en] {
        #expect(Self.real(code, args, language) != "SERWER", "\(code) [\(language)]: tekst serwera zamiast wzorca")
      }
    }
  }

  // MARK: - Fasada, renderer, klucz katalogu

  @Test("fasada: odmowa na karcie bez decyzji po polsku i po angielsku")
  func facade() {
    #expect(ServerText.sentence(code: "dialogs.refuse.multi-select", language: .pl)
      == "Wielokrotny wybór zrób w terminalu — Rarog wysyła jedną cyfrę.")
    #expect(ServerText.sentence(code: "dialogs.refuse.multi-select", language: .en)
      == "Make multiple selections in the terminal. Rarog sends only one digit.")
    #expect(ServerText.sentence(code: "transcript.truncation-footer", args: ["5"], language: .pl)
      == "\n… (ucięto 5 znaków)")
  }

  @Test("fasada: kod spoza deskryptorów albo złe argumenty → sam kod")
  func facadeUnknownCode() {
    #expect(ServerText.sentence(code: "dialogs.refuse.no-such-reason", language: .pl) == "dialogs.refuse.no-such-reason")
    #expect(ServerText.sentence(code: "session.fallback-label", language: .pl) == "session.fallback-label")
  }

  @Test("renderer języka daje to samo co `render`")
  func renderer() {
    let pl = ServerText.renderer(language: .pl)
    let en = ServerText.renderer(language: .en)
    let ref = SentenceRef(code: "rest.session-not-found")
    #expect(pl("x", ref) == "Nie ma takiej sesji.")
    #expect(en("x", ref) == "That session doesn't exist.")
    #expect(pl("x", nil) == "x")
  }

  @Test("klucz katalogu: `push.*` bez zmian, reszta `server.<kod>` (jak `catalogKey` generatora)")
  func catalogKey() {
    #expect(ServerText.catalogKey(code: "push.chime.title") == "push.chime.title")
    #expect(ServerText.catalogKey(code: "push.placeholder.body") == "push.placeholder.body")
    #expect(ServerText.catalogKey(code: "rest.bad-request") == "server.rest.bad-request")
    #expect(ServerText.catalogKey(code: "dialogs.refuse.multi-select") == "server.dialogs.refuse.multi-select")
    #expect(ServerText.catalogKey(code: "pushy.code") == "server.pushy.code")
    for code in SentenceDescriptors.table.keys {
      #expect(ServerText.catalogKey(code: code) == (code.hasPrefix("push.") ? code : "server." + code))
    }
  }
}
