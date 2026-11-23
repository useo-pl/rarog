import Foundation
import RarogContract

// Reguła drogi dyktowania systemowego: którędy idzie dźwięk. To jest granica prywatności trasy
// systemowej: serwery Apple dostają dźwięk wyłącznie wtedy, gdy recognizer żądanego języka nie ma modelu mowy
// na urządzeniu; wszędzie, gdzie model jest, żądanie wymusza rozpoznawanie na urządzeniu. Czyste funkcje
// z tabeli warunków pomiaru dyktowania (sam `SFSpeechRecognizer`, bez pobierania zasobów), każdy wiersz
// z testem (`SystemDictationTests`). Właściciel: dyktowanie.

/// Którędy rozpoznaje `SFSpeechRecognizer`.
enum SystemDictationPath: Sendable, Equatable {
  /// Model mowy na urządzeniu; dźwięk nie opuszcza urządzenia.
  case onDevice
  /// Serwery rozpoznawania Apple: język bez modelu na urządzeniu.
  case appleServers
}

/// Droga użyta po `prepare()`: API, `onDevice` albo `appleServers`, locale. Do śladu diagnostycznego gospodarza;
/// nie niesie tekstu ani dźwięku.
struct SystemDictationRoute: Sendable, Equatable {
  static let api = "SFSpeechRecognizer"

  let path: SystemDictationPath
  /// Locale żądania (BCP 47).
  let locale: String

  var api: String { Self.api }

  /// Jedna linia śladu, np. `api=SFSpeechRecognizer path=on-device locale=pl-PL`.
  var summary: String {
    let name = switch path {
    case .onDevice: "on-device"
    case .appleServers: "apple-servers"
    }
    return "api=\(api) path=\(name) locale=\(locale)"
  }
}

/// Wynik reguły przed mikrofonem.
enum SystemPrepareStep: Sendable, Equatable {
  /// Zgoda nieustalona: pytanie systemowe, potem reguła od nowa.
  case askAuthorization
  case route(SystemDictationRoute)
  case refuse(DictationFailure)
}

/// Co znaczy błąd zadania w trakcie nagrania.
enum SystemTaskErrorOutcome: Sendable, Equatable {
  /// Zwykły koniec po stopie (brak mowy).
  case finished
  /// System zamknął zadanie bez mowy w trakcie nagrania: następne zadanie tą samą drogą.
  case nextTask
  case fail(DictationFailure)
}

enum SystemDictationPolicy {
  /// Locale rozpoznawania z języka apki: pl → `pl-PL`, en → `en-US`; inny kod języka idzie bez regionu.
  static func locale(for language: CopyLanguage) -> String {
    switch language {
    case .pl: "pl-PL"
    case .en: "en-US"
    default: language.rawValue
    }
  }

  /// Wiersze 1–7 tabeli, w tej kolejności. `recognizer` dla `locale`; bez zgody nikt go nie tworzy.
  static func prepare(
    authorization: SpeechAuthorization, locale: String, recognizer: SpeechRecognizerFacts?
  ) -> SystemPrepareStep {
    switch authorization {
    case .notDetermined: return .askAuthorization
    case .denied: return .refuse(.speechDenied)
    case .restricted: return .refuse(.speechRestricted)
    case .authorized: break
    }
    guard let recognizer, language(recognizer.locale) == language(locale) else { return .refuse(.localeUnsupported) }
    if recognizer.supportsOnDeviceRecognition { return .route(SystemDictationRoute(path: .onDevice, locale: locale)) }
    guard recognizer.isAvailable else { return .refuse(.appleServerUnreachable) }
    return .route(SystemDictationRoute(path: .appleServers, locale: locale))
  }

  /// Żądanie drogi: na urządzeniu wymusza model lokalny (`requiresOnDeviceRecognition`), serwery Apple dostają
  /// dźwięk tylko z żądaniem drogi `appleServers`.
  static func request(for path: SystemDictationPath) -> SpeechRequest {
    SpeechRequest(requiresOnDeviceRecognition: path == .onDevice)
  }

  /// Wiersze 9–13 tabeli. Kod 301 (anulowanie) po `abort()` albo nowym zadaniu nie dochodzi tu wcale: strumień
  /// pomija zdarzenia zadania, które sam zamknął. `isAvailable` w chwili błędu.
  static func taskError(
    _ error: SpeechTaskError, path: SystemDictationPath, isAvailable: Bool, finishing: Bool
  ) -> SystemTaskErrorOutcome {
    switch (error.domain, error.code) {
    case (SpeechTaskError.assistantDomain, 1110): return finishing ? .finished : .nextTask
    case (SpeechTaskError.recognizerDomain, 102): return .fail(.assetsMissing)
    case (SpeechTaskError.assistantDomain, 1700): return .fail(.speechDenied)
    case (SpeechTaskError.recognizerDomain, 201): return .fail(.dictationDisabled)
    default:
      // Tabela błędów Apple nie ma kodu „brak sieci”; na drodze serwerowej mówi o nim dostępność usługi.
      return path == .appleServers && !isAvailable ? .fail(.appleServerUnreachable) : .fail(.engineFailed)
    }
  }

  /// Kod języka z locale w zapisie BCP 47 albo z podkreśleniem (`pl-PL`, `pl_PL` → `pl`).
  private static func language(_ locale: String) -> String? {
    Locale.Language(identifier: locale).languageCode?.identifier.lowercased()
  }
}
