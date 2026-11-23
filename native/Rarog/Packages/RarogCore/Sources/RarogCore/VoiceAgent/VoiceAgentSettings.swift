import Foundation
import Observation

// Ustawienia agenta głosowego na urządzeniu. Właściciel: agent głosowy.
//
// Klucz API OpenAI i model rozmowy trzyma serwer Raroga (jak klucz Soniox); na rozmowę apka dostanie od serwera
// tylko klucz krótkotrwały. Tu są wyłącznie decyzje tego urządzenia:
// - Jedyna droga do włączenia to zgoda z ekranu zgody (`acceptConsent`); przełącznik bez zgody wraca do „wyłączone”.
//   Zgoda dotyczy wersji tekstu (`consentVersion`): zgoda na starszy tekst przy starcie znaczy brak zgody.
// - Wyłączenie kasuje zgodę, więc ponowne włączenie znów pyta.
// - Soniox reading speed from `speechSpeeds`; it applies from the next conversation.
// Ekran: `RarogUI/Views/VoiceAgent/`.

/// Ustawienia agenta głosowego na tym urządzeniu.
@MainActor
@Observable
public final class VoiceAgentSettings {
  /// Wersja tekstu zgody (`voiceAgent.consent.*` w katalogu RarogUI). Zmiana tego, co idzie do OpenAI albo gdzie
  /// żyje klucz, ją podnosi. Wersja 2: klucz OpenAI na serwerze Raroga, telefon dostaje klucz krótkotrwały.
  /// Version 3: when the server offers Soniox speech, the text of the agent's answers goes to Soniox in the EU to be
  /// read aloud (`voiceAgent.consent.speech`); a consent to version 2 no longer turns the feature on.
  /// Version 4: Soniox always reads the answers (no OpenAI voice), so the Soniox sentence has no condition, and the
  /// cost names the measured price of the text-only conversation and the Soniox account.
  public static let consentVersion = 4

  @ObservationIgnored private let preferences: VoiceAgentPreferences

  /// Włączone na tym urządzeniu (zgoda na bieżący tekst). Czy serwer daje rozmowę, mówi on sam.
  public private(set) var enabled: Bool
  /// Soniox reading speed (`speed` of the start frame), one of ``speechSpeeds``.
  public private(set) var speechSpeed: Double

  /// Reading speeds the page offers. Soniox takes 0.7–1.3, 1.0 normal; the owner asked only for faster reading.
  public static let speechSpeeds: [Double] = [1.0, 1.1, 1.2, 1.3]
  public static let defaultSpeechSpeed = 1.0

  public init(preferences: VoiceAgentPreferences) {
    self.preferences = preferences
    enabled = preferences.consent == Self.consentVersion
    speechSpeed =
      preferences.speechSpeed.flatMap { Self.speechSpeeds.contains($0) ? $0 : nil } ?? Self.defaultSpeechSpeed
  }

  /// Apka: preferencje w `UserDefaults`.
  public static func live(defaults: UserDefaults) -> VoiceAgentSettings {
    VoiceAgentSettings(preferences: VoiceAgentPreferences(defaults: defaults))
  }

  /// Testy i tryb testów UI: preferencje w pamięci.
  public static func memory() -> VoiceAgentSettings {
    VoiceAgentSettings(preferences: .memory())
  }

  /// Zgoda z ekranu zgody: włącza funkcję i zapisuje wersję tekstu.
  public func acceptConsent() {
    preferences.consent = Self.consentVersion
    enabled = true
  }

  /// Wyłączenie: kasuje zgodę.
  public func disable() {
    preferences.consent = nil
    enabled = false
  }

  /// Reading speed from ``speechSpeeds``; any other value — no change.
  public func choose(speechSpeed: Double) {
    guard Self.speechSpeeds.contains(speechSpeed) else { return }
    preferences.speechSpeed = speechSpeed
    self.speechSpeed = speechSpeed
  }
}
