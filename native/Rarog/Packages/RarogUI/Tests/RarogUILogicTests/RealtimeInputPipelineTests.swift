import AVFAudio
import Foundation
@testable import RarogUI
import Testing

// Microphone input of the voice agent → PCM s16le 24 kHz mono (`RealtimeInputPipeline`). Owner: voice agent.

@Suite("voice agent input: microphone buffers to 24 kHz mono PCM")
struct RealtimeInputPipelineTests {
  /// Regression: on a Mac the voice processing input has 5 discrete channels; a downmix to mono gave all-zero PCM,
  /// so the conversation started but OpenAI heard silence ("mic peak 0.00").
  @Test("a discrete multi-channel input keeps the voice of channel 0")
  func discreteChannelsKeepTheVoice() throws {
    let layout = try #require(AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 5))
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, interleaved: false, channelLayout: layout)
    let pcm = try convert(sine(format: format))
    #expect(rms(pcm) > 0.3)
  }

  @Test("a mono input passes at 24 kHz")
  func monoPasses() throws {
    let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false))
    let pcm = try convert(sine(format: format))
    #expect(rms(pcm) > 0.3)
    // 4 800 frames at 48 kHz are at most 2 400 at 24 kHz; the converter holds back a few for its filter.
    #expect((2_000...2_400).contains(RealtimeAudioFormat.samples(in: pcm)))
  }

  /// 100 ms of a 440 Hz sine at half scale on every channel.
  private func sine(format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    let frames = 4_800
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)))
    buffer.frameLength = AVAudioFrameCount(frames)
    let channels = try #require(buffer.floatChannelData)
    for channel in 0..<Int(format.channelCount) {
      for index in 0..<frames {
        channels[channel][index] = 0.5 * sin(2 * .pi * 440 * Float(index) / Float(format.sampleRate))
      }
    }
    return buffer
  }

  private func convert(_ buffer: AVAudioPCMBuffer) throws -> Data {
    let pipeline = try #require(RealtimeInputPipeline(input: buffer.format))
    return try #require(pipeline.process(buffer))
  }

  /// RMS of PCM s16le, 0…1.
  private func rms(_ pcm: Data) -> Double {
    let samples = RealtimePCM.floats(pcm)
    guard !samples.isEmpty else { return 0 }
    return (samples.reduce(0) { $0 + Double($1 * $1) } / Double(samples.count)).squareRoot()
  }
}
