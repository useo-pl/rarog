import AVFAudio
import Foundation

// Styk audio rozmowy głosowej: mikrofon i głośnik na jednym silniku, PCM s16le 24 kHz mono w obie strony.
// Właściciel: agent głosowy. Silnik produkcyjny to `VoiceChatAudio` (iOS); rozmowa
// (`RealtimeConversation`) dostaje go wstrzykniętego, więc jej reguły testują się na macOS z atrapą.

enum RealtimeAudioFormat {
  /// Wejście i wyjście Realtime: `audio/pcm` 24 kHz, 16 bit, mono.
  static let sampleRate = 24_000
  static let bytesPerSample = 2

  static func samples(in pcm: Data) -> Int { pcm.count / bytesPerSample }

  static func milliseconds(samples: Int) -> Int { samples * 1000 / sampleRate }

  /// The mixer → speaker format of `VoiceChatAudio`, or nil when the default connection stays. Voice processing needs
  /// the same sample rate on the input and on that connection, otherwise `engine.start()` fails with -10875
  /// ("client-side input and output formats do not match"). On a Mac (the iPad app) voice processing gives a 48 kHz
  /// input while the mixer goes to the speaker at 44.1 kHz; measured on an Apple silicon Mac, where the reconnected
  /// engine starts and cancels the speaker echo. On iPhone and iPad the rates already match and nothing changes.
  static func speakerFormat(inputRate: Double, mixerRate: Double, speakerChannels: AVAudioChannelCount) -> AVAudioFormat? {
    guard inputRate > 0, inputRate != mixerRate else { return nil }
    return AVAudioFormat(standardFormatWithSampleRate: inputRate, channels: max(1, speakerChannels))
  }
}

/// Zdarzenia silnika audio, zawsze na głównym aktorze.
struct RealtimeAudioHandlers {
  /// The engine runs; argument = its format for `client.log`: `in <port> <Hz> Hz <channels> ch, out <port>` (port
  /// types, no device names).
  var started: @MainActor (String) -> Void
  /// Kawałek mowy z mikrofonu: PCM s16le 24 kHz mono, po przetwarzaniu głosu (bez echa głośnika).
  var input: @MainActor (Data) -> Void
  /// Odtwarzanie ruszyło z pustej kolejki; argument = opóźnienie wyjścia (s), które jeszcze dzieli dźwięk od ucha.
  var playbackStarted: @MainActor (TimeInterval) -> Void
  /// Kolejka odtwarzania opustoszała: wszystko, co do niej trafiło, zostało odtworzone.
  var drained: @MainActor () -> Void
  /// Przerwanie przez system (rozmowa telefoniczna, Siri, zmiana trasy, restart usług audio); argument = przyczyna
  /// do `client.log` (nazwa zdarzenia i pola systemu, bez treści rozmowy).
  var interrupted: @MainActor (String) -> Void
  /// Silnik wystartował od nowa po zmianie konfiguracji; rozmowa trwa. Argumenty: przyczyna jak w `interrupted`
  /// i czy przepadła kolejka odtwarzania (wtedy `playedSamples` mówi, ile rozmówca usłyszał, a `clearPlayback()`
  /// nic już nie zmienia).
  var restarted: @MainActor (String, Bool) -> Void
  /// The start failed after the permission: argument = the step and the system error code for `client.log`, e.g.
  /// `engine start -10875`. Comes right before `start` throws.
  var startFailed: @MainActor (String) -> Void = { _ in }
}

/// Jeden silnik na wejście i wyjście.
@MainActor
protocol RealtimeAudio: AnyObject {
  /// Zgoda na mikrofon, sesja audio, silnik. Błąd = rozmowa się nie zaczyna.
  func start(_ handlers: RealtimeAudioHandlers) async throws(VoiceMicError)
  /// Dokłada PCM s16le 24 kHz mono na koniec kolejki odtwarzania.
  func play(_ pcm: Data)
  /// Próbki odtworzone od startu silnika; rośnie monotonicznie.
  var playedSamples: Int { get }
  /// Zatrzymuje odtwarzanie i wyrzuca kolejkę (barge-in); zwraca `playedSamples` po zatrzymaniu.
  func clearPlayback() -> Int
  /// Playback volume, 0…1; 1 at the start of each conversation. Speech over an answer lowers it while the app decides
  /// whether the sound is noise (`RealtimeConversation+Noise.swift`).
  var playbackVolume: Float { get set }
  /// Zwalnia mikrofon, głośnik i sesję audio. Idempotentne.
  func stop()
}

enum RealtimePCM {
  /// Float32 (−1…1) → PCM s16le; skala jak w dyktowaniu (`PCMFramer.sample`).
  static func int16Data(_ samples: UnsafeBufferPointer<Float>) -> Data {
    var out = [Int16]()
    out.reserveCapacity(samples.count)
    for raw in samples {
      let value = raw.isNaN ? 0 : min(1, max(-1, raw))
      out.append(PCMFramer.sample(value).littleEndian)
    }
    return out.withUnsafeBufferPointer { Data(buffer: $0) }
  }

  static func int16Data(_ samples: [Float]) -> Data {
    samples.withUnsafeBufferPointer { int16Data($0) }
  }

  /// PCM s16le → Float32 (−1…1) do bufora odtwarzacza. Nieparzysty bajt na końcu odpada.
  static func floats(_ pcm: Data) -> [Float] {
    let count = pcm.count / 2
    var out = [Float](repeating: 0, count: count)
    pcm.withUnsafeBytes { raw in
      for index in 0..<count {
        let value = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
        out[index] = value < 0 ? Float(value) / 32768 : Float(value) / 32767
      }
    }
    return out
  }
}
