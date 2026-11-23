import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Angielska kolumna katalogu RarogUI (`docs/localization.md`, „Tests”): proces testów zostaje przypięty do `pl`,
// a angielski idzie obok przez `L(_:language:)` z jawnym językiem. Liczba mnoga wybiera formę po locale `en`
// (`CopyLookup`), a wzorce dat i zdania z datą są kluczami katalogu, więc ich angielski kształt sprawdza się tu,
// nie w zrzutach polskiego tekstu.
@Suite("katalog copy RarogUI po angielsku: liczba mnoga i daty")
struct EnglishCopyTests {
  static let warsaw = TimeZone(identifier: "Europe/Warsaw")!
  static let us = Locale(identifier: "en_US")
  /// 9 października 2026, 21:40 w Warszawie (piątek).
  static let date = Date(timeIntervalSince1970: 1_791_574_800)

  @Test("liczba mnoga całym zdaniem: one i other; one bez liczby tam, gdzie katalog tak pisze")
  func plural() {
    #expect(L("header.filesCount", language: .en, 1) == "1\u{00A0}file", "twarda spacja jak po polsku")
    #expect(L("header.filesCount", language: .en, 2) == "2\u{00A0}files")
    #expect(L("header.filesCount", language: .en, 0) == "0\u{00A0}files")
    #expect(L("transcript.newPill", language: .en, 1) == "1 new message", "licznik na ekranie zostawia cyfrę")
    #expect(L("composer.voiceLimitSpoken", language: .en, 1) == "One minute of recording left.")
    #expect(L("composer.voiceLimitSpoken", language: .en, 2) == "2 minutes of recording left.")
    #expect(L("composer.voiceLimitSpoken", language: .pl, 2) == "Do końca nagrania zostały 2 minuty.", "polski obok")
  }

  @Test("liczba mnoga w podstawieniu z dalszym parametrem i bez grupowania cyfr")
  func substitution() {
    #expect(L("header.backgroundSpoken", language: .en, 1, "agent") == "1 task in the background: agent")
    #expect(L("header.backgroundSpoken", language: .en, 3, "agent, command") == "3 tasks in the background: agent, command")
    #expect(L("header.filesCount", language: .en, 12_345) == "12345\u{00A0}files", "locale en grupuje, CopyLookup cofa")
  }

  @Test("aktualizacja serwera po angielsku: wiersz stopki i zdanie z komendą, warianty Mac i VPS")
  func serverUpdate() {
    #expect(L("list.serverUpdate", language: .en) == "Server update available")
    #expect(L("usage.serverUpdate.detail", language: .en, "0.1.0", "1.0.0", "npm i -g @rarog/server@latest")
      == "Server 0.1.0 is older than this app (1.0.0). Update it on the Mac: npm i -g @rarog/server@latest")
    #expect(L("usage.serverUpdate.detail.vps", language: .en, "0.1.0", "1.0.0", "npm i -g @rarog/server@latest")
      == "Server 0.1.0 is older than this app (1.0.0). Update it on the VPS: npm i -g @rarog/server@latest")
  }

  @Test("zegar decyzji dla czytnika: po angielsku sam czas, po polsku „czeka od” (ekran w obu językach bez klucza)")
  func cardWaitClock() {
    #expect(L("list.cardWaitClock", language: .en, "34m") == "34m")
    #expect(L("list.cardWaitClock", language: .pl, "34 min") == "czeka od 34 min", "polski obok")
  }

  @Test("linia stanu i etykieta karty pytania po angielsku: „waiting for permission · 4m”, „question · …”")
  func waitingLineAndQuestionLabel() {
    let dot = L("app.list.dot", language: .en)
    #expect([L("list.stateLabel.waitingPermission", language: .en), "4m"].joined(separator: dot)
      == "waiting for permission · 4m")
    #expect([L("cards.waitingQuestion", language: .en), "Release M1"].joined(separator: dot) == "question · Release M1")
    #expect([L("cards.questionSpokenHeader.single", language: .en), "Release M1"]
      .joined(separator: L("app.list.comma", language: .en)) == "Question from the agent, Release M1")
  }

  @Test("słowo tonu „czeka na zadanie w tle” dla czytnika po angielsku")
  func backgroundWaitTone() {
    #expect(L("list.toneSpoken.backgroundWait", language: .en) == "waiting on a background task")
    #expect(L("list.toneSpoken.backgroundWait", language: .pl) == "czeka na zadanie w tle", "polski obok")
  }

  @Test("powód pola w starcie agenta po angielsku")
  func startingReason() {
    #expect(L("composer.startingReason", language: .en) == "Starting the agent… You can send once it's ready.")
    #expect(L("composer.startingReason", language: .pl) == "Uruchamiam agenta… Wyślesz, gdy będzie gotowy.", "polski obok")
  }

  @Test("słowo maszyny serwera po angielsku: warianty `.vps` obok bazy z „Mac”")
  func machineWord() {
    #expect(L("notes.offline.vps", language: .en) == "can't reach the VPS—the text is waiting in the app")
    #expect(L("notes.offline", language: .en) == "can't reach the Mac—the text is waiting in the app")
    #expect(L("pairing.revokedBy.admin.vps", language: .en) == "on the VPS: rarog devices")
    #expect(L("list.macTailnetSpoken.vps", language: .en, "example.ts.net") == "VPS on tailnet example.ts.net")
    #expect(L("pairing.newDeviceNotice.at.vps", language: .en, "iPad", "Oct 4, 10:01", "code from the VPS")
      == "New device: iPad on Oct 4, 10:01, code from the VPS. If this wasn't you, revoke it on the VPS: rarog devices.")
  }

  @Test("ekran „Dyktowanie” po angielsku: tytuły w title case, przyciski z czasownikiem")
  func dictation() {
    let keys = ["dictation.title", "dictation.close", "dictation.system.title", "dictation.system.choose",
                "dictation.soniox.title", "dictation.soniox.choose", "dictation.selected", "dictation.privacy"]
    #expect(keys.map { L($0, language: .en) } == [
      "Dictation", "Close Dictation", "System Dictation", "Use System Dictation", "Soniox via Your Server",
      "Use Soniox", "Selected", "Dictation in the Privacy Policy",
    ])
    #expect(UICopy.dictationSettingsNone(language: .en) == "Not chosen")
    #expect(UICopy.voiceNotice(.dictation(.speechRestricted)) == UICopy.dictationFailure(.speechRestricted, language: .pl),
            "polski obok: język procesu")
  }

  @Test("wzorce dat z katalogu: kolejność i skróty języka, nazwy z locale")
  func datePatterns() {
    func day(_ key: String, context: Formatter.Context = .unknown) -> String {
      CopyDate.string(Self.date, pattern: L(key, language: .en), timeZone: Self.warsaw, locale: Self.us, context: context)
    }
    #expect(L("format.dayPattern", language: .en) == "MMM d")
    #expect(day("format.dayPattern") == "Oct 9")
    #expect(day("format.dayYearPattern") == "Oct 9, 2026")
    #expect(day("format.dayNumericPattern") == "10/9")
    #expect(day("transcript.timeGapDayPattern") == "Fri, Oct 9")
    #expect(day("transcript.timeGapSpokenDayPattern", context: .beginningOfSentence) == "Friday, October 9")
  }

  @Test("dzień z godziną: separator z katalogu, godzina z regionu (12 h w USA, 24 h w Polsce)")
  func dayClock() {
    let day = CopyDate.string(Self.date, pattern: L("format.dayPattern", language: .en), timeZone: Self.warsaw,
      locale: Self.us)
    let clockUS = CopyDate.clock(Self.date, timeZone: Self.warsaw, locale: Self.us)
    let clockPL = CopyDate.clock(Self.date, timeZone: Self.warsaw, locale: Locale(identifier: "en_PL"))
    #expect(L("format.dayClock", language: .en, day, clockUS) == "Oct 9, 9:40\u{202F}PM")
    #expect(L("format.dayClock", language: .en, day, clockPL) == "Oct 9, 21:40")
    let numeric = CopyDate.string(Self.date, pattern: L("format.dayNumericPattern", language: .en),
      timeZone: Self.warsaw, locale: Self.us)
    #expect(L("format.dayNumericClock", language: .en, numeric, clockUS) == "10/9\u{00A0}9:40\u{202F}PM")
  }
}
