import AVFAudio
@testable import RarogUI
import XCTest

/// Podsłuch mikrofonu na prawdziwym `AVAudioEngine`: blok `installTap` biegnie na wątku audio. Domknięcie
/// z izolacją głównego aktora wpada tam w pułapkę Swift 6 (`_dispatch_assert_queue_fail`) — wywrotka przy
/// pierwszym dyktowaniu na iPhonie, build 1131. Mikrofonu w testach nie ma, więc źródłem jest
/// odtwarzacz z ciszą, a podsłuch zakłada ta sama funkcja co mikrofon (`MicrophoneCapture.installTap`).
final class MicrophoneTapTests: XCTestCase {
  @MainActor
  func testTapOnRunningEngineDeliversFramesOffMainThread() throws {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    engine.attach(player)
    let format = engine.mainMixerNode.outputFormat(forBus: 0)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    let pipeline = try XCTUnwrap(AudioPipeline(input: format))
    let delivered = expectation(description: "ramki z wątku audio")
    delivered.assertForOverFulfill = false
    MicrophoneCapture.installTap(on: engine.mainMixerNode, format: format, pipeline: pipeline) { frames in
      if !Thread.isMainThread, !frames.isEmpty { delivered.fulfill() }
    }
    defer {
      engine.mainMixerNode.removeTap(onBus: 0)
      engine.stop()
    }
    try engine.start()
    let silence = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(format.sampleRate)))
    silence.frameLength = silence.frameCapacity
    player.scheduleBuffer(silence, at: nil, options: .loops)
    player.play()
    wait(for: [delivered], timeout: 5)
  }
}
