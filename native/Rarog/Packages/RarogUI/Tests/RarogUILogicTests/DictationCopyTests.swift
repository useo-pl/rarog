import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Copy dyktowania: ekran „Dyktowanie” w en i pl, opcja Soniox niedostępna bez twierdzenia o kluczu, flaga
// NO bez słowa „Soniox”, komunikat nagrywarki dla każdego `DictationFailure`, `VoiceNotice.dictation` i teksty zgód
// iOS (`Info.plist` apki, `InfoPlist.xcstrings`). Proces testów ma język pl; angielski idzie jawnym językiem.
@MainActor
@Suite("copy dyktowania: zgoda, opcja Soniox, błędy rozpoznawania mowy i teksty zgód iOS")
struct DictationCopyTests {
  static let languages: [CopyLanguage] = [.en, .pl]

  /// Korzeń apki natywnej (`native/Rarog`): `Info.plist` i katalog zgód celu `Rarog`.
  static let app = URL(filePath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

  private func model(allowed: Bool, server: SonioxServerState, choice: DictationChoice? = nil) -> DictationChoiceModel {
    DictationChoiceModel(services: .memory(sonioxAllowed: allowed, choice: choice), server: { server })
  }

  @Test("żaden tekst opcji Soniox w żadnym stanie nie twierdzi, że serwerowi brakuje klucza (en i pl)")
  func noMissingKeyClaim() throws {
    let claims = ["no key", "missing", "without a key", "isn't set", "not set", "doesn't have",
                  "brak klucza", "brakuje", "bez klucza", "nie ma klucza", "nie ustawi"]
    for state in [SonioxServerState.unknown, .available, .unavailable] {
      for language in Self.languages {
        let screen = model(allowed: true, server: state).screen(language: language)
        let soniox = try #require(screen.options.first { $0.choice == .soniox })
        let texts = ([soniox.title, soniox.summary, soniox.state, soniox.button].compactMap { $0 }
          + (soniox.setup?.texts ?? [])).map { $0.lowercased() }
        for text in texts {
          #expect(!claims.contains { text.contains($0) }, "\(state) \(language): „\(text)”")
        }
      }
    }
  }

  @Test("flaga NO: drzewo tekstów ekranu i wiersza Ustawień bez słowa „Soniox”, w każdym stanie i przy każdym wyborze")
  func hiddenHasNoSoniox() {
    for state in [SonioxServerState.unknown, .available, .unavailable] {
      for choice in [nil, DictationChoice.system, .soniox] {
        let hidden = model(allowed: false, server: state, choice: choice)
        for language in Self.languages {
          let texts = hidden.screen(language: language).texts + hidden.settings(language: language).texts
          #expect(!texts.isEmpty)
          #expect(texts.allSatisfy { !$0.localizedCaseInsensitiveContains("soniox") },
                  "\(state) \(String(describing: choice)) \(language): \(texts.filter { $0.contains("Soniox") })")
        }
      }
    }
  }

  @Test("Soniox consent: provider, EU region, only the audio straight to Soniox, not via the server or USEO")
  func sonioxConsent() throws {
    for language in Self.languages {
      let screen = model(allowed: true, server: .available).screen(language: language)
      let soniox = try #require(screen.options.first { $0.choice == .soniox })
      let text = [soniox.title, soniox.summary].joined(separator: " ")
      #expect(text.contains("Soniox"))
      #expect(text.contains(language == .en ? "EU" : "UE"), "\(language): region")
      #expect(text.contains("USEO"), "\(language): nie do twórcy apki")
      #expect(text.contains(language == .en ? "Rarog server" : "serwer"), "\(language): klucz na serwerze")
      #expect(screen.privacyURL == ProductLinks.privacyDictation)
      #expect(screen.privacyURL.absoluteString == "https://rarog.ai/privacy#dictation")
    }
    #expect(UICopy.dictationSonioxSummary(language: .en).contains("only the microphone audio"))
    #expect(UICopy.dictationSonioxSummary(language: .en).contains("not through the Rarog server"))
    #expect(UICopy.dictationSonioxSummary(language: .pl).contains("tylko dźwięk z mikrofonu"))
    #expect(UICopy.dictationSonioxSummary(language: .pl).contains("nie przez serwer Rarog"))
  }

  @Test("zgoda systemowa: rozpoznawanie mowy Apple, na urządzeniu albo przez serwery Apple; zdanie o języku z pomiaru")
  func systemConsent() throws {
    for language in Self.languages {
      let screen = model(allowed: true, server: .available).screen(language: language)
      let system = try #require(screen.options.first { $0.choice == .system })
      #expect(system.summary.contains("Apple") && system.summary.contains("Rarog"), "\(language)")
      #expect(system.summary.contains(language == .en ? "Apple's servers" : "serwerów Apple"), "\(language)")
      #expect(!system.summary.localizedCaseInsensitiveContains("soniox"), "\(language): przy fladze NO też stoi")
    }
  }

  @Test("`UICopy.dictationFailure`: tekst en i pl dla każdego `DictationFailure`, różne przypadki, różne języki")
  func failures() {
    for language in Self.languages {
      let texts = DictationFailure.allCases.map { UICopy.dictationFailure($0, language: language) }
      #expect(texts.allSatisfy { !$0.isEmpty && !$0.hasPrefix("dictation.") }, "\(language): \(texts)")
      #expect(Set(texts).count == DictationFailure.allCases.count, "\(language): każdy przypadek ma własne zdanie")
      #expect(texts.allSatisfy { $0.hasSuffix(".") }, "\(language): pełne zdania")
    }
    for failure in DictationFailure.allCases {
      #expect(UICopy.dictationFailure(failure, language: .en) != UICopy.dictationFailure(failure, language: .pl))
      #expect(UICopy.dictationFailure(failure) == UICopy.dictationFailure(failure, language: .pl), "język procesu: pl")
    }
    #expect(UICopy.dictationFailure(.speechDenied, language: .en)
      == "Rarog doesn't have speech recognition access. Turn it on in Settings: Rarog → Speech Recognition.")
    #expect(UICopy.dictationFailure(.speechDenied, language: .pl)
      == "Brak zgody na rozpoznawanie mowy. Włącz ją w Ustawieniach: Rarog → Rozpoznawanie mowy.")
    // Wyłączone dyktowanie systemu: zdanie mówi, gdzie je włączyć (ścieżka z pomocy Apple, en i pl).
    #expect(UICopy.dictationFailure(.dictationDisabled, language: .en).contains("General → Keyboard → Enable Dictation"))
    #expect(UICopy.dictationFailure(.dictationDisabled, language: .pl).contains("Ogólne → Klawiatura → Włącz dyktowanie"))
    #expect(UICopy.dictationFailure(.appleServerUnreachable, language: .en).contains("Apple"))
  }

  @Test("`VoiceNotice.dictation`: błąd zawsze; „Ustawienia” tylko przy odmowie mikrofonu i rozpoznawania mowy")
  func notice() {
    for failure in DictationFailure.allCases {
      let notice = VoiceNotice.dictation(failure)
      #expect(notice.isError, "\(failure)")
      #expect(notice.opensSettings == (failure == .speechDenied), "\(failure)")
      #expect(UICopy.voiceNotice(notice) == UICopy.dictationFailure(failure))
      #expect(UICopy.voiceStatus(VoiceView(notice: notice)) == UICopy.dictationFailure(failure), "komunikat wygrywa")
    }
    for error in [VoiceMicError.denied, .unavailable, .busy, .failed] {
      #expect(VoiceNotice.microphone(error).opensSettings == (error == .denied), "\(error)")
    }
    for notice in [VoiceNotice.silence, .sessionLimit, .interrupted, .streamFailed, .message("x")] {
      #expect(!notice.opensSettings, "\(notice)")
    }
  }

  @Test("zgody iOS: mikrofon bez nazwy dostawcy; rozpoznawanie mowy z tekstem z pomiaru; en w Info.plist = en katalogu")
  func usageDescriptions() throws {
    let plist = try #require(NSDictionary(contentsOf: Self.app.appending(path: "Info.plist")) as? [String: Any])
    let data = try Data(contentsOf: Self.app.appending(path: "Rarog/InfoPlist.xcstrings"))
    let catalog = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let strings = try #require(catalog["strings"] as? [String: Any])
    func value(_ key: String, _ language: String) -> String? {
      let entry = strings[key] as? [String: Any]
      let unit = ((entry?["localizations"] as? [String: Any])?[language] as? [String: Any])?["stringUnit"]
      return (unit as? [String: Any])?["value"] as? String
    }
    for key in ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"] {
      let english = try #require(plist[key] as? String, "\(key) w Info.plist")
      #expect(value(key, "en") == english, "\(key): en katalogu = Info.plist")
      #expect(value(key, "pl").map { !$0.isEmpty && $0 != english } == true, "\(key): pl przetłumaczone")
    }
    for language in ["en", "pl"] {
      let microphone = try #require(value("NSMicrophoneUsageDescription", language))
      for provider in ["Soniox", "Apple"] {
        #expect(!microphone.contains(provider), "\(language): mikrofon bez nazwy dostawcy")
      }
      let speech = try #require(value("NSSpeechRecognitionUsageDescription", language))
      #expect(speech.contains("Apple"), "\(language): rozpoznawanie mowy nazywa Apple")
      #expect(!speech.contains("Soniox"), "\(language)")
    }
    #expect(value("NSMicrophoneUsageDescription", "en")?.contains("microphone button") == true)
    #expect(value("NSSpeechRecognitionUsageDescription", "en") == "Speech recognition runs only when you tap the "
      + "microphone button with “System Dictation” chosen: your speech becomes text in the field. The audio stays "
      + "on this device when your language has an on-device speech model; otherwise it goes to Apple's speech "
      + "recognition servers.")
    #expect(value("NSSpeechRecognitionUsageDescription", "pl") == "Rozpoznawanie mowy działa tylko po stuknięciu "
      + "ikony mikrofonu, gdy wybrane jest „Dyktowanie systemowe”: mowa zamienia się w tekst w polu. Dźwięk zostaje "
      + "na tym urządzeniu, gdy Twój język ma model mowy na urządzeniu; w przeciwnym razie idzie do serwerów "
      + "rozpoznawania mowy Apple.")
    #expect(UICopy.dictationSystemTitle(language: .en) == "System Dictation", "zgoda cytuje nazwę opcji")
    #expect(UICopy.dictationSystemTitle(language: .pl) == "Dyktowanie systemowe")
  }
}
