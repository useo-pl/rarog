import Foundation

/// Próbki mikrofonu (Float32, już 16 kHz mono) → ramki PCM s16le po 100 ms ze szczytem amplitudy.
/// Skala: przester przycinany, a nie zawijany,
/// −1 → −32768, +1 → 32767. Czyste, testowane na macOS. Właściciel: dyktowanie.
struct PCMFramer {
  /// 1600 próbek 16-bitowych = 3200 bajtów = 100 ms przy 16 kHz.
  static let frameSamples = 1600

  private var samples: [Int16] = []
  private var peak: Float = 0

  init() {
    samples.reserveCapacity(Self.frameSamples)
  }

  /// Dokłada próbki; oddaje ramki, które się zapełniły.
  mutating func push(_ input: UnsafeBufferPointer<Float>) -> [VoiceFrame] {
    var frames: [VoiceFrame] = []
    for raw in input {
      let value = raw.isNaN ? 0 : min(1, max(-1, raw))
      peak = max(peak, abs(value))
      samples.append(Self.sample(value))
      if samples.count == Self.frameSamples { frames.append(take()) }
    }
    return frames
  }

  mutating func push(_ input: [Float]) -> [VoiceFrame] {
    input.withUnsafeBufferPointer { push($0) }
  }

  /// Ostatnia, niepełna ramka (stop z zatwierdzeniem); `nil`, gdy nic nie czeka.
  mutating func flush() -> VoiceFrame? {
    samples.isEmpty ? nil : take()
  }

  /// Asymetryczna skala: symetryczne 32767 zostawiałoby −32768 nieosiągalne i dawało stałą składową.
  static func sample(_ value: Float) -> Int16 {
    value < 0 ? Int16(value * 32768) : Int16(value * 32767)
  }

  private mutating func take() -> VoiceFrame {
    let data = samples.map(\.littleEndian).withUnsafeBufferPointer { Data(buffer: $0) }
    let frame = VoiceFrame(pcm: data, peak: peak)
    samples.removeAll(keepingCapacity: true)
    peak = 0
    return frame
  }
}
