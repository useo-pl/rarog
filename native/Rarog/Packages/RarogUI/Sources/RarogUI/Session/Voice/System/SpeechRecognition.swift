import Foundation

// Styki rozpoznawania mowy Apple pod strumieniem dyktowania systemowego (`SystemDictationStream`). Produkcja:
// `AppleSpeechRecognition` na `SFSpeechRecognizer`; testy podają atrapę, więc reguły strumienia sprawdzają się na
// macOS bez zgody na rozpoznawanie, mikrofonu i sieci. Właściciel: dyktowanie.

/// Zgoda apki na rozpoznawanie mowy — lustro `SFSpeechRecognizerAuthorizationStatus`.
enum SpeechAuthorization: Sendable, Equatable {
  case notDetermined, denied, restricted, authorized
}

/// Recognizer dla żądanego języka w chwili odczytu: wejście reguły drogi (`SystemDictationPolicy`).
struct SpeechRecognizerFacts: Sendable, Equatable {
  /// Locale, które recognizer naprawdę ma (BCP 47). Przy języku bez rozpoznawania system potrafi podstawić język
  /// klawiatury dyktowania, więc recognizer bez `nil` nie dowodzi, że to żądany język.
  var locale: String
  /// Usługa rozpoznawania dostępna teraz; bez modelu na urządzeniu zależy od sieci.
  var isAvailable: Bool
  /// Recognizer ma model mowy na urządzeniu i rozpozna bez sieci.
  var supportsOnDeviceRecognition: Bool
}

/// Ustawienia jednego zadania, które zależą od drogi. Resztę (wyniki częściowe, interpunkcja, podpowiedź
/// „dyktowanie”) adapter ustawia zawsze tak samo.
struct SpeechRequest: Sendable, Equatable {
  /// `true` = dźwięk nie opuszcza urządzenia; `false` = rozpoznają serwery Apple.
  var requiresOnDeviceRecognition: Bool
}

/// Błąd zadania rozpoznawania: domena i kod `NSError`; tekstu błędu nie czytamy.
struct SpeechTaskError: Sendable, Equatable {
  /// Domena kodów 203, 1100, 1101, 1107, 1110, 1700 (tabela błędów `SFSpeechRecognitionTask`).
  static let assistantDomain = "kAFAssistantErrorDomain"
  /// Domena kodów 102, 201, 300, 301.
  static let recognizerDomain = "kLSRErrorDomain"

  var domain: String
  var code: Int
}

/// Rodzaj wyniku zadania.
enum SpeechResultKind: Sendable, Equatable {
  /// Hipoteza bieżącego fragmentu.
  case partial
  /// Koniec fragmentu w trakcie zadania: tekst fragmentu jest gotowy, zadanie trwa, a kolejne wyniki niosą tylko
  /// nowy fragment. Tak oddaje wynik po pauzie recognizer z modelem na urządzeniu (bez `isFinal`).
  case segmentEnd
  /// Wynik końcowy zadania (`isFinal`).
  case final
}

/// Zdarzenia zadania, zawsze na głównym aktorze i w kolejności przyjścia. Zadanie nie woła ich synchronicznie
/// w `recognize`; po `cancel()` może jeszcze coś przyjść — strumień rozpoznaje to po numerze zadania.
struct SpeechTaskEvents: Sendable {
  /// Cały tekst bieżącego fragmentu do tej chwili (nie przyrost) i rodzaj wyniku. Bez pauzy fragmentem jest całe
  /// zadanie.
  var result: @MainActor @Sendable (_ text: String, _ kind: SpeechResultKind) -> Void
  var failure: @MainActor @Sendable (SpeechTaskError) -> Void
}

/// Dostęp do rozpoznawania mowy: zgoda i recognizer dla języka.
@MainActor
protocol SpeechRecognition: AnyObject {
  func authorization() -> SpeechAuthorization
  /// Pytanie systemowe o zgodę (może stać długo).
  func requestAuthorization() async -> SpeechAuthorization
  /// Recognizer dla locale (BCP 47); `nil` = język bez rozpoznawania.
  func recognizer(locale: String) -> (any SpeechRecognizer)?
}

@MainActor
protocol SpeechRecognizer: AnyObject {
  /// Odczyt bieżący: dostępność usługi zmienia się z siecią.
  var facts: SpeechRecognizerFacts { get }
  func recognize(_ request: SpeechRequest, events: SpeechTaskEvents) -> any SpeechTask
}

/// Jedno zadanie rozpoznawania.
@MainActor
protocol SpeechTask: AnyObject {
  /// PCM s16le 16 kHz mono (`VoiceFrame`).
  func append(_ pcm: Data)
  /// Koniec dźwięku: zadanie domyka tekst i oddaje wynik końcowy.
  func endAudio()
  func cancel()
}
