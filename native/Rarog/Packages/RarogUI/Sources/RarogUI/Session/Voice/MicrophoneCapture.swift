#if os(iOS)
import AVFAudio
import Foundation

/// Mikrofon dyktowania na `AVAudioEngine`: wejście → `AVAudioConverter` do 16 kHz mono →
/// ramki PCM s16le po 100 ms (`PCMFramer`). Właściciel: dyktowanie.
///
/// Ramki powstają na wątku audio i jadą na główny `DispatchQueue.main.async` — w kolejności
/// przyjścia, więc spłukanie ostatniej ramki (też przez główną kolejkę, po zdjęciu podsłuchu)
/// stoi zawsze za wszystkimi wcześniejszymi. Przerwanie przez system (rozmowa, Siri, zmiana wejścia,
/// restart usług audio) to zdarzenie `onInterrupt`, nie błąd: tekst zostaje w polu.
@MainActor
final class MicrophoneCapture: VoiceMicrophone {
  private let engine = AVAudioEngine()
  private var pipeline: AudioPipeline?
  private var onFrame: (@MainActor (VoiceFrame) -> Void)?
  private var onInterrupt: (@MainActor () -> Void)?
  private var tapInstalled = false
  private var running = false
  /// Sesja audio aktywna — `stop` oddaje ją innym apkom także po nieudanym starcie silnika.
  private var sessionActive = false
  private var observers: [any NSObjectProtocol] = []

  func start(
    onFrame: @escaping @MainActor (VoiceFrame) -> Void, onInterrupt: @escaping @MainActor () -> Void
  ) async throws(VoiceMicError) {
    guard await Self.permission() else { throw .denied }
    let session = AVAudioSession.sharedInstance()
    do {
      // Nagranie mowy: inne dźwięki milkną na czas dyktowania i wracają po nim
      // (`notifyOthersOnDeactivation` w `stop`).
      try session.setCategory(.record, mode: .default, options: [])
      try session.setActive(true)
      sessionActive = true
    } catch {
      throw Self.error(error)
    }
    guard session.isInputAvailable else {
      stop()
      throw .unavailable
    }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0, let pipeline = AudioPipeline(input: format) else {
      stop()
      throw .unavailable
    }
    self.pipeline = pipeline
    self.onFrame = onFrame
    self.onInterrupt = onInterrupt
    let deliver: @Sendable ([VoiceFrame]) -> Void = { [weak self] frames in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, let deliver = self.onFrame else { return }
          for frame in frames { deliver(frame) }
        }
      }
    }
    Self.installTap(on: input, format: format, pipeline: pipeline, deliver: deliver)
    tapInstalled = true
    engine.prepare()
    do {
      try engine.start()
    } catch {
      stop()
      throw Self.error(error)
    }
    running = true
    observe()
  }

  /// A tap on the engine's node; frames go to `deliver` from the audio thread (`RealtimeMessenger`). The function
  /// is `nonisolated`: a closure passed to `installTap` in a method of this class would inherit main-actor
  /// isolation, and Swift 6 (SE-0423) adds an isolation check to a closure given to an Objective-C API — on the
  /// audio thread that is the `_dispatch_assert_queue_fail` trap (a crash at the first dictation on iPhone).
  /// Dictation UI tests use a fake microphone; `MicrophoneTapTests` checks this path
  /// on a running engine.
  nonisolated static func installTap(
    on node: AVAudioNode, format: AVAudioFormat?, pipeline: AudioPipeline,
    deliver: @escaping @Sendable ([VoiceFrame]) -> Void
  ) {
    node.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
      let frames = pipeline.process(buffer)
      guard !frames.isEmpty else { return }
      deliver(frames)
    }
  }

  func flush() async {
    guard running else { return }
    // Po zdjęciu podsłuchu wątek audio nie dołoży już ramki; ostatnia, niepełna jedzie główną
    // kolejką ZA wszystkimi, które są już w drodze.
    removeTap()
    let last = pipeline?.flush()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          if let last { self.onFrame?(last) }
          continuation.resume()
        }
      }
    }
  }

  func stop() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    removeTap()
    if engine.isRunning { engine.stop() }
    onFrame = nil
    onInterrupt = nil
    pipeline = nil
    running = false
    if sessionActive {
      sessionActive = false
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  private func removeTap() {
    guard tapInstalled else { return }
    tapInstalled = false
    engine.inputNode.removeTap(onBus: 0)
  }

  /// Rozmowa, Siri, zmiana wejścia (słuchawki), restart usług audio — mikrofon przestaje dawać
  /// próbki, więc nagranie kończy się tak, jak przy zejściu w tło.
  private func observe() {
    let center = NotificationCenter.default
    let interrupt: @Sendable (Notification) -> Void = { [weak self] note in
      let began: Bool
      if note.name == AVAudioSession.interruptionNotification {
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        began = raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
      } else {
        began = true
      }
      guard began else { return }
      MainActor.assumeIsolated { self?.onInterrupt?() }
    }
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main, using: interrupt),
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main, using: interrupt),
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main, using: interrupt),
    ]
  }

  /// The permission is already granted, so `start` asks nothing.
  static var permissionGranted: Bool { AVAudioApplication.shared.recordPermission == .granted }

  /// Zgoda na mikrofon; pytanie systemowe tylko przy pierwszym razie.
  private static func permission() async -> Bool {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: true
    case .denied: false
    default: await AVAudioApplication.requestRecordPermission()
    }
  }

  private static func error(_ error: any Error) -> VoiceMicError {
    let code = AVAudioSession.ErrorCode(rawValue: (error as NSError).code)
    switch code {
    case .cannotInterruptOthers?, .insufficientPriority?, .isBusy?: return .busy
    default: return .failed
    }
  }
}

/// Konwersja i cięcie na ramki. Używana z wątku audio (podsłuch) i raz z głównego (spłukanie),
/// więc pod zamkiem; konwerter trzyma stan próbkowania między blokami.
final class AudioPipeline: @unchecked Sendable {
  private let lock = NSLock()
  private var converter: AVAudioConverter
  private let output: AVAudioFormat
  private var framer = PCMFramer()

  init?(input: AVAudioFormat) {
    guard let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
      let converter = Self.converter(from: input, to: output)
    else { return nil }
    self.converter = converter
    self.output = output
  }

  private static func converter(from input: AVAudioFormat, to output: AVAudioFormat) -> AVAudioConverter? {
    let converter = AVAudioConverter(from: input, to: output)
    converter?.downmix = input.channelCount > 1
    return converter
  }

  func process(_ buffer: AVAudioPCMBuffer) -> [VoiceFrame] {
    lock.lock()
    defer { lock.unlock() }
    // Konwerter przyjmuje wyłącznie swój format wejścia; podsłuch potrafi oddać bufor w innym (inny układ
    // kanałów węzła, zmiana trasy audio) i wtedy KAŻDY blok odpadał z „required condition is false”.
    if !buffer.format.isEqual(converter.inputFormat) {
      guard let rebuilt = Self.converter(from: buffer.format, to: output) else { return [] }
      converter = rebuilt
    }
    let ratio = output.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
    guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return [] }
    let source = OneShotInput(buffer)
    var error: NSError?
    let status = converter.convert(to: converted, error: &error) { _, inputStatus in
      source.next(inputStatus)
    }
    guard status != .error, let channel = converted.floatChannelData?[0] else { return [] }
    return framer.push(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
  }

  func flush() -> VoiceFrame? {
    lock.lock()
    defer { lock.unlock() }
    return framer.flush()
  }
}

/// Blok wejścia konwertera: oddaje bufor podsłuchu raz, potem „na razie nic" — nie „koniec
/// strumienia", bo wtedy konwerter zgubiłby stan próbkowania przed następnym blokiem.
private final class OneShotInput: @unchecked Sendable {
  private var buffer: AVAudioPCMBuffer?

  init(_ buffer: AVAudioPCMBuffer) {
    self.buffer = buffer
  }

  func next(_ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
    guard let buffer else {
      status.pointee = .noDataNow
      return nil
    }
    self.buffer = nil
    status.pointee = .haveData
    return buffer
  }
}
#endif
