import Foundation
import RarogContract

// Stan Soniox na serwerze. Właściciel:
// dyktowanie. Gałąź reduktora wołana z głównego `switch` w `Reducer.swift`.

/// Zdarzenie dyktowania w rdzeniu.
public enum VoiceEvent: Sendable, Equatable {
  /// Serwer przy pobraniu klucza powiedział „Soniox niedostępny” (404 starszy serwer bez trasy, 503
  /// `voice_unconfigured`: brak klucza, klucz spoza UE albo odrzucony przez Soniox), choć sonda wersji mówiła
  /// „włączona” (starszy serwer bez pola, klucz zdjęty po sondzie).
  case serverDisabled
}

/// Odmowa dyktowania zapamiętana przy pobraniu klucza.
public struct VoiceAvailabilityState: Sendable, Equatable {
  public struct Refusal: Sendable, Equatable {
    /// Proces serwera, który odmówił. Restart serwera (nowy `serverStartId`) zdejmuje odmowę:
    /// klucz mógł właśnie dojść na Macu, a sonda wersji powie, czy jest.
    public let serverStartId: String?
  }

  public internal(set) var refusal: Refusal?

  public init() {}
}

extension AppState {
  mutating func applyVoice(_ event: VoiceEvent) {
    switch event {
    case .serverDisabled:
      voice.refusal = .init(serverStartId: serverStartId)
    }
  }

  /// Czy serwer daje drogę „Soniox przez Twój serwer”: odmowa przy mincie z tym samym `serverStartId` =
  /// niedostępny do restartu serwera, także zanim sonda `GET /api/version` odpowie (mint rozstrzyga); poza
  /// tym brak sondy = nie wiadomo, `voiceEnabled: false` = niedostępny (brak pola = starszy serwer = dostępny,
  /// ``Capabilities``). Nie chowa mikrofonu: wejście trasy dyktowania (``DictationPolicy``).
  public var sonioxOnServer: SonioxServerState {
    if let refusal = voice.refusal, refusal.serverStartId == serverStartId { return .unavailable }
    guard let capabilities else { return .unknown }
    return capabilities.voice ? .available : .unavailable
  }
}
