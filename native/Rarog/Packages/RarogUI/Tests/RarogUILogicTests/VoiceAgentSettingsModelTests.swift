import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Strona „Agent głosowy” w Ustawieniach: przełącznik i strona zgody, wyłączenie kasuje
// zgodę, wiersz Ustawień, teksty zgody i stopki w obu językach. Ustawienia w pamięci (`VoiceAgentSettings.memory`);
// reguły zgody i głosu sprawdza `VoiceAgentSettingsTests` w RarogCore.

@MainActor
@Suite("Ustawienia → „Agent głosowy”: zgoda, wiersz i teksty")
struct VoiceAgentSettingsModelTests {
  @Test("bez zgody przełącznik wraca: włączenie otwiera zgodę, „Anuluj” zostawia wyłączone, „Zgadzam się” włącza")
  func consentGate() {
    let model = VoiceAgentSettingsModel(settings: .memory())
    model.toggle(true)
    #expect(model.consentShown && !model.isOn && !model.settings.enabled, "sam przełącznik niczego nie włącza")
    model.cancelConsent()
    #expect(!model.consentShown && !model.isOn)
    model.toggle(true)
    model.acceptConsent()
    #expect(!model.consentShown && model.isOn)
    model.toggle(true)
    #expect(!model.consentShown, "włączone: drugi raz zgody nie ma")
  }

  @Test("wyłączenie kasuje zgodę; ponowne włączenie znów pyta")
  func disableAsksAgain() {
    let model = VoiceAgentSettingsModel(settings: .memory())
    model.toggle(true)
    model.acceptConsent()
    model.toggle(false)
    #expect(!model.isOn && !model.settings.enabled)
    model.toggle(true)
    #expect(model.consentShown && !model.isOn)
  }

  @Test("wiersz Ustawień: wyłączony, włączony")
  func summary() {
    let model = VoiceAgentSettingsModel(settings: .memory())
    #expect(model.summary() == VoiceAgentSettingsSummary(label: "Agent głosowy", value: "Wyłączony"))
    model.acceptConsent()
    #expect(model.summary() == VoiceAgentSettingsSummary(label: "Agent głosowy", value: "Włączony"))
    #expect(model.summary(language: .en) == VoiceAgentSettingsSummary(label: "Voice Agent", value: "On"))
  }

  @Test("the shortcut section stands on the page only while the voice agent is on")
  func shortcutOnlyWhenOn() {
    let model = VoiceAgentSettingsModel(settings: .memory())
    #expect(!model.showsShortcut)
    model.toggle(true)
    #expect(!model.showsShortcut, "consent not given yet")
    model.acceptConsent()
    #expect(model.showsShortcut)
    model.toggle(false)
    #expect(!model.showsShortcut)
  }

  /// The app state after a version probe with `field` appended to the answer; `nil` = no answer yet.
  private static func state(_ field: String?) -> AppState {
    var state = Sample.state(session: Sample.session())
    guard let field else { return state }
    state.capabilities = Capabilities(
      Sample.decode(VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s"\#(field)}"#))
    return state
  }

  nonisolated private static let both = #","companionEnabled":true,"companionSpeech":true"#

  @Test(
    "the Settings row: hidden without Soniox or an answer; not set up without the agent; offered with Soniox speech",
    arguments: [
      (both, false, .hidden),
      (nil, true, .hidden),
      (both, true, .offered),
      (#","companionEnabled":true"#, true, .notSetUp),
      (#","companionEnabled":true,"companionSpeech":false"#, true, .notSetUp),
      (#","companionEnabled":false"#, true, .notSetUp),
      ("", true, .notSetUp),
    ] as [(String?, Bool, VoiceAgentSettingsAvailability)])
  func availability(field: String?, sonioxAllowed: Bool, expected: VoiceAgentSettingsAvailability) {
    let state = Self.state(field)
    #expect(VoiceAgentSettingsModel.availability(state: state, sonioxAllowed: sonioxAllowed) == expected)
    // The session button and the shortcut keep the stricter rule: only an offered agent starts a conversation.
    #expect(VoiceAgentAvailability.offered(state: state, sonioxAllowed: sonioxAllowed) == (expected == .offered))
  }

  @Test("the page shows the setup steps unless the agent is offered, also when the server's answer goes away")
  func pageShowsSetup() {
    #expect(!VoiceAgentSettingsModel.showsSetup(.offered))
    #expect(VoiceAgentSettingsModel.showsSetup(.notSetUp))
    #expect(VoiceAgentSettingsModel.showsSetup(.hidden), "page open while the capabilities go nil: no blank page")
  }

  @Test("a consent given earlier stays while the server is not set up and counts again once it offers the agent")
  func consentSurvivesNotSetUp() {
    let settings = VoiceAgentSettings.memory()
    let model = VoiceAgentSettingsModel(settings: settings)
    model.acceptConsent()
    let notSetUp = VoiceAgentSettingsModel.availability(state: Self.state(""), sonioxAllowed: true)
    #expect(notSetUp == .notSetUp && VoiceAgentSettingsModel.showsSetup(notSetUp))
    _ = model.setup(sonioxOnServer: .unavailable)
    #expect(settings.enabled && model.isOn, "the setup page does not touch the stored consent")
    let offered = VoiceAgentSettingsModel.availability(state: Self.state(Self.both), sonioxAllowed: true)
    #expect(offered == .offered && !VoiceAgentSettingsModel.showsSetup(offered) && model.isOn)
  }

  @Test("setup steps: the Soniox step only while dictation with Soniox does not work; the key and the server command")
  func setupSteps() throws {
    let model = VoiceAgentSettingsModel(settings: .memory())
    for language in [CopyLanguage.en, .pl] {
      for server in [SonioxServerState.unknown, .unavailable] {
        let setup = model.setup(sonioxOnServer: server, language: language)
        #expect(setup.steps.steps.count == 3, "\(language) \(server)")
        #expect(setup.steps.steps.map(\.commands) == [[], [], ["rarog voice-agent set-key", "rarog restart"]])
      }
      let ready = model.setup(sonioxOnServer: .available, language: language)
      #expect(ready.steps.steps.map(\.commands) == [[], ["rarog voice-agent set-key", "rarog restart"]],
              "\(language): dictation with Soniox works, so its step is left out")
      #expect(ready.steps.linkURL == ProviderLinks.openAIKeys)
      #expect(ready.steps.steps.first?.text.contains("platform.openai.com/api-keys") == true, "\(language)")
      #expect(([ready.lead] + ready.steps.texts).allSatisfy { !$0.isEmpty && !$0.hasPrefix("voiceAgent.") })
    }
  }

  @Test("the voice row names Soniox and the server; there is no OpenAI voice list")
  func sonioxVoice() {
    let model = VoiceAgentSettingsModel(settings: .memory())
    #expect(
      model.sonioxVoice()
        == VoiceAgentSonioxVoice(value: "Soniox", hint: "Odpowiedzi czyta Soniox głosem ustawionym na serwerze Raroga."))
    #expect(model.sonioxVoice(language: .en).hint == "Soniox reads the answers in the voice set on the Rarog server.")
    #expect(!model.sonioxVoice(language: .en).hint.contains("OpenAI"))
  }

  @Test("the page offers four reading speeds labelled for the app language")
  func speechSpeeds() {
    let settings = VoiceAgentSettings.memory()
    let model = VoiceAgentSettingsModel(settings: settings)
    #expect(model.speechSpeeds().map(\.value) == [1.0, 1.1, 1.2, 1.3])
    #expect(model.speechSpeeds().map(\.label) == ["1,0× (normalne)", "1,1×", "1,2×", "1,3×"])
    #expect(model.speechSpeeds(language: .en).map(\.label) == ["1.0× (normal)", "1.1×", "1.2×", "1.3×"])
    #expect(UICopy.voiceAgentSpeechSpeed(language: .pl) == "Tempo czytania")
    #expect(UICopy.voiceAgentSpeechSpeed(language: .en) == "Reading Speed")
    model.chooseSpeechSpeed(1.2)
    #expect(settings.speechSpeed == 1.2 && model.speechSpeed == 1.2)
    model.chooseSpeechSpeed(0.8)
    #expect(settings.speechSpeed == 1.2, "outside the list: no change")
  }

  @Test("zgoda mówi: co idzie do OpenAI, USA, retencja według zasad API, klucz na serwerze, klucz krótkotrwały, koszt")
  func consentContent() {
    let model = VoiceAgentSettingsModel(settings: .memory())
    let pl = model.consent(language: .pl)
    let plText = pl.paragraphs.joined(separator: " ")
    for fragment in ["dźwięk rozmowy", "ostatnie tury sesji", "maskowane", "USA", "zasad API OpenAI",
                     "serwerze Raroga", "klucz krótkotrwały", "60 s", "kolejne rozmowy", "odpięte urządzenie",
                     "0,01–0,04 USD", "konto Soniox", "limit tokenów na minutę"] {
      #expect(plText.contains(fragment), "pl: \(fragment)")
    }
    #expect(!plText.contains("pęku kluczy") && !plText.contains("zostaje na tym urządzeniu") && !plText.contains("jednorazow"))
    #expect(plText.contains("tekst odpowiedzi agenta do Soniox w UE") && plText.contains("na głos"), "pl: Soniox")
    #expect(pl.accept == "Zgadzam się i włączam" && pl.cancel == "Anuluj")
    let en = model.consent(language: .en)
    let enText = en.paragraphs.joined(separator: " ")
    for fragment in ["conversation audio", "recent turns of the session", "masked", "United States",
                     "OpenAI API data policies", "Rarog server", "short-lived key", "60 seconds",
                     "more conversations", "revoked device", "$0.01–$0.04", "Soniox account",
                     "tokens-per-minute limit"] {
      #expect(enText.contains(fragment), "en: \(fragment)")
    }
    #expect(!enText.contains("keychain") && !enText.contains("stays on this device") && !enText.contains("one-time"))
    #expect(enText.contains("text of the agent's answers to Soniox in the EU") && enText.contains("read aloud"),
            "en: Soniox")
    #expect(en.paragraphs.count == 5 && pl.paragraphs.count == 5)
    #expect(en.title == "Voice Agent and OpenAI" && en.accept == "Agree and Turn On")
  }

  @Test("stopka pod przełącznikiem: klucz na serwerze Raroga, bez zdania o kasowaniu klucza")
  func lead() {
    let pl = UICopy.voiceAgentLead(language: .pl)
    #expect(pl.contains("serwerze Raroga") && !pl.contains("usuwa klucz"))
    let en = UICopy.voiceAgentLead(language: .en)
    #expect(en.contains("Rarog server") && !en.contains("deletes the key"))
  }

  @Test("the iOS microphone text names the voice agent by its Settings row title and OpenAI, in both languages")
  func microphoneUsage() throws {
    let catalog = DictationCopyTests.app.appending(path: "Rarog/InfoPlist.xcstrings")
    let root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: catalog)) as? [String: Any])
    let entry = (root["strings"] as? [String: Any])?["NSMicrophoneUsageDescription"] as? [String: Any]
    func value(_ language: String) -> String? {
      let unit = ((entry?["localizations"] as? [String: Any])?[language] as? [String: Any])?["stringUnit"]
      return (unit as? [String: Any])?["value"] as? String
    }
    let en = try #require(value("en"))
    #expect(en.contains("OpenAI") && en.contains("“\(UICopy.voiceAgentTitle(language: .en))”"))
    let pl = try #require(value("pl"))
    #expect(pl.contains("OpenAI") && pl.contains("„\(UICopy.voiceAgentTitle(language: .pl))”"))
  }
}
