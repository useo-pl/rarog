import AVFAudio
import Foundation

#if os(iOS)
/// Silnik audio rozmowy głosowej: jeden `AVAudioEngine` na mikrofon i głośnik.
/// Właściciel: agent głosowy.
///
/// Sesja `.playAndRecord` w trybie `.voiceChat`, wyjście domyślnie na głośnik, przetwarzanie głosu na węzłach wejścia
/// i wyjścia (usuwanie echa: agent nie słyszy sam siebie z głośnika). Wejście: podsłuch → `AVAudioConverter` do 24 kHz
/// mono → PCM s16le. Wyjście: `AVAudioPlayerNode` z buforami 24 kHz. Dyktowanie (`MicrophoneCapture`, 16 kHz,
/// `.record`) zostaje osobno; obie drogi się wykluczają (pilnuje ekran).
///
/// Domknięcia wołane z wątków audio (podsłuch, koniec bufora) powstają w funkcjach `nonisolated`: domknięcie
/// utworzone w metodzie głównego aktora dostaje w Swift 6 sprawdzenie izolacji i na wątku audio kończy proces
/// (opis w `MicrophoneCapture.installTap`).
@MainActor
final class VoiceChatAudio: RealtimeAudio {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let playbackFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: Double(RealtimeAudioFormat.sampleRate), channels: 1, interleaved: false)!
  private var handlers: RealtimeAudioHandlers?
  private var pipeline: RealtimeInputPipeline?
  private var sessionActive = false
  private var tapInstalled = false
  private var attached = false
  private var running = false
  private var observers: [any NSObjectProtocol] = []
  /// Chwile restartów silnika po zmianie konfiguracji (czas od startu systemu), z ostatnich 10 s.
  private var restarts: [TimeInterval] = []

  /// Próbki buforów odtworzonych do końca.
  private var completedSamples = 0
  /// Długości buforów w kolejce odtwarzacza, w kolejności grania.
  private var pending: [Int] = []
  /// Chwila (czas od startu systemu), od której gra pierwszy bufor kolejki.
  private var headStartedAt: TimeInterval = 0
  /// Wyczyszczenie kolejki podnosi epokę: końce buforów sprzed niego nic nie liczą.
  private var epoch = 0
  /// Każdy start i każde `stop()` podnosi numer: start, który wrócił z pytania o zgodę po nich, się wycofuje.
  private var startEpoch = 0

  init() {}

  var playedSamples: Int { completedSamples + headPartial() }

  /// The player node's mixer volume. Kept here as well, because a new connection of the node (start, restart after a
  /// configuration change) may reset its mixing parameters.
  var playbackVolume: Float = 1 {
    didSet { player.volume = playbackVolume }
  }

  func start(_ handlers: RealtimeAudioHandlers) async throws(VoiceMicError) {
    startEpoch += 1
    let mine = startEpoch
    guard await Self.permission() else { throw .denied }
    // W trakcie pytania o zgodę rozmowa się skończyła (`stop()`) albo ruszył nowszy start: ten nie konfiguruje
    // silnika, który należy już do kogoś innego.
    guard mine == startEpoch else { throw .failed }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
      try session.setActive(true)
      sessionActive = true
    } catch {
      handlers.startFailed("audio session \((error as NSError).code)")
      throw Self.error(error)
    }
    guard session.isInputAvailable else {
      stop()
      throw .unavailable
    }
    do {
      try engine.inputNode.setVoiceProcessingEnabled(true)
      try engine.outputNode.setVoiceProcessingEnabled(true)
    } catch {
      handlers.startFailed("voice processing \((error as NSError).code)")
      stop()
      throw .failed
    }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0, let pipeline = RealtimeInputPipeline(input: format) else {
      stop()
      throw .unavailable
    }
    self.pipeline = pipeline
    self.handlers = handlers
    restarts = []
    engine.attach(player)
    attached = true
    engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
    player.volume = playbackVolume
    matchOutputRate(to: format)
    Self.installTap(on: input, format: format, pipeline: pipeline, deliver: inputDelivery())
    tapInstalled = true
    engine.prepare()
    do {
      try engine.start()
    } catch {
      handlers.startFailed("engine start \((error as NSError).code), \(Self.format(input: format))")
      stop()
      throw Self.error(error)
    }
    player.play()
    running = true
    observe()
    handlers.started(Self.format(input: format))
  }

  /// The mixer → speaker connection at the input sample rate when they differ (`RealtimeAudioFormat.speakerFormat`).
  private func matchOutputRate(to input: AVAudioFormat) {
    let mixer = engine.mainMixerNode
    guard
      let format = RealtimeAudioFormat.speakerFormat(
        inputRate: input.sampleRate, mixerRate: mixer.outputFormat(forBus: 0).sampleRate,
        speakerChannels: engine.outputNode.outputFormat(forBus: 0).channelCount)
    else { return }
    engine.connect(mixer, to: engine.outputNode, format: format)
  }

  /// Engine format for `client.log`: input port types, rate and channels, output port types (no device names).
  private static func format(input: AVAudioFormat) -> String {
    let route = AVAudioSession.sharedInstance().currentRoute
    let inputs = route.inputs.map(\.portType.rawValue).joined(separator: "+")
    let outputs = route.outputs.map(\.portType.rawValue).joined(separator: "+")
    return "in \(inputs.isEmpty ? "none" : inputs) \(Int(input.sampleRate)) Hz \(input.channelCount) ch, "
      + "out \(outputs.isEmpty ? "none" : outputs)"
  }

  /// Kawałki mowy z wątku podsłuchu do rozmowy, na głównym aktorze; po `stop()` nic nie przechodzi.
  private func inputDelivery() -> @Sendable (Data) -> Void {
    { [weak self] pcm in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, self.running else { return }
          self.handlers?.input(pcm)
        }
      }
    }
  }

  nonisolated static func installTap(
    on node: AVAudioNode, format: AVAudioFormat?, pipeline: RealtimeInputPipeline,
    deliver: @escaping @Sendable (Data) -> Void
  ) {
    node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      guard let pcm = pipeline.process(buffer), !pcm.isEmpty else { return }
      deliver(pcm)
    }
  }

  func play(_ pcm: Data) {
    guard running else { return }
    let samples = RealtimePCM.floats(pcm)
    guard !samples.isEmpty,
      let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(samples.count)),
      let channel = buffer.floatChannelData?[0]
    else { return }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { source in
      channel.update(from: source.baseAddress!, count: samples.count)
    }
    let wasIdle = pending.isEmpty
    pending.append(samples.count)
    if wasIdle { headStartedAt = ProcessInfo.processInfo.systemUptime }
    let done: @Sendable () -> Void = { [weak self, epoch] in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { self?.completed(epoch: epoch) }
      }
    }
    Self.schedule(buffer, on: player, done: done)
    if wasIdle {
      let session = AVAudioSession.sharedInstance()
      handlers?.playbackStarted(session.outputLatency + session.ioBufferDuration)
    }
  }

  nonisolated static func schedule(_ buffer: AVAudioPCMBuffer, on player: AVAudioPlayerNode, done: @escaping @Sendable () -> Void) {
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in done() }
  }

  private func completed(epoch: Int) {
    guard epoch == self.epoch, running, !pending.isEmpty else { return }
    completedSamples += pending.removeFirst()
    headStartedAt = ProcessInfo.processInfo.systemUptime
    if pending.isEmpty { handlers?.drained() }
  }

  /// Ile próbek pierwszego bufora kolejki już zagrało — szacunek z zegara, nie więcej niż sam bufor.
  private func headPartial() -> Int {
    guard let head = pending.first else { return 0 }
    let elapsed = ProcessInfo.processInfo.systemUptime - headStartedAt
    return min(head, max(0, Int(elapsed * Double(RealtimeAudioFormat.sampleRate))))
  }

  func clearPlayback() -> Int {
    completedSamples += headPartial()
    pending = []
    epoch += 1
    if running {
      player.stop()
      player.play()
    }
    return completedSamples
  }

  func stop() {
    startEpoch += 1
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    running = false
    if tapInstalled {
      tapInstalled = false
      engine.inputNode.removeTap(onBus: 0)
    }
    if attached { player.stop() }
    if engine.isRunning { engine.stop() }
    if attached {
      attached = false
      engine.detach(player)
    }
    pending = []
    epoch += 1
    handlers = nil
    pipeline = nil
    if sessionActive {
      sessionActive = false
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  /// Zmiana konfiguracji silnika, np. przetwarzanie głosu przestawia wejście tuż po starcie (zmierzone na iPadzie:
  /// wbudowany mikrofon i głośnik, bez zmiany trasy). Silnik wtedy stoi, a połączenia trzeba zbudować od nowa
  /// i wystartować (dokumentacja `AVAudioEngineConfigurationChange`). Odtwarzanie w toku przepada; rozmowa
  /// przycina je jak przy barge-in (`RealtimeConversation.playbackLost`). Więcej niż 3 restarty w 10 s (pętla) albo nieudany start kończą rozmowę.
  private func restart(_ cause: String) {
    let now = ProcessInfo.processInfo.systemUptime
    restarts = restarts.filter { now - $0 < 10 } + [now]
    guard restarts.count <= 3 else {
      handlers?.interrupted("\(cause), restart limit")
      return
    }
    if tapInstalled {
      tapInstalled = false
      engine.inputNode.removeTap(onBus: 0)
    }
    let hadPlayback = !pending.isEmpty
    completedSamples += headPartial()
    pending = []
    epoch += 1
    player.stop()
    if engine.isRunning { engine.stop() }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0, let pipeline = RealtimeInputPipeline(input: format) else {
      handlers?.interrupted("\(cause), no input format after restart")
      return
    }
    self.pipeline = pipeline
    engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
    player.volume = playbackVolume
    matchOutputRate(to: format)
    Self.installTap(on: input, format: format, pipeline: pipeline, deliver: inputDelivery())
    tapInstalled = true
    engine.prepare()
    do {
      try engine.start()
    } catch {
      handlers?.interrupted("\(cause), restart failed (\((error as NSError).code))")
      return
    }
    player.play()
    handlers?.restarted("\(cause), input \(Int(format.sampleRate)) Hz \(format.channelCount) ch", hadPlayback)
  }

  /// Rozmowa telefoniczna, Siri, restart usług audio: rozmowa się kończy. Zmiana konfiguracji silnika: restart.
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
      let cause = Self.cause(note)
      MainActor.assumeIsolated {
        guard let self, self.running else { return }
        self.handlers?.interrupted(cause)
      }
    }
    let reconfigure: @Sendable (Notification) -> Void = { [weak self] note in
      let cause = Self.cause(note)
      MainActor.assumeIsolated {
        guard let self, self.running else { return }
        self.restart(cause)
      }
    }
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main, using: interrupt),
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main, using: interrupt),
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main, using: reconfigure),
    ]
  }

  /// Przyczyna przerwania do `client.log`: nazwa zdarzenia, powód systemu i bieżąca trasa (typy portów, bez nazw
  /// urządzeń).
  nonisolated private static func cause(_ note: Notification) -> String {
    let session = AVAudioSession.sharedInstance()
    let route = session.currentRoute
    let ports = "in=\(route.inputs.map(\.portType.rawValue).joined(separator: "+")) "
      + "out=\(route.outputs.map(\.portType.rawValue).joined(separator: "+"))"
    switch note.name {
    case AVAudioSession.interruptionNotification:
      let reason = (note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt).map(String.init) ?? "none"
      return "session interruption (reason \(reason), \(ports), other audio \(session.isOtherAudioPlaying))"
    case AVAudioSession.mediaServicesWereResetNotification:
      return "media services reset (\(ports))"
    default:
      return "engine configuration change (\(ports), \(Int(session.sampleRate)) Hz, "
        + "input channels \(session.inputNumberOfChannels))"
    }
  }

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
#endif

/// Wejście mikrofonu → PCM s16le 24 kHz mono. Z wątku audio (podsłuch), pod zamkiem; konwerter trzyma stan
/// próbkowania między blokami.
final class RealtimeInputPipeline: @unchecked Sendable {
  private let lock = NSLock()
  private var converter: AVAudioConverter
  private let output: AVAudioFormat

  init?(input: AVAudioFormat) {
    guard
      let output = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: Double(RealtimeAudioFormat.sampleRate), channels: 1,
        interleaved: false),
      let converter = Self.converter(from: input, to: output)
    else { return nil }
    self.converter = converter
    self.output = output
  }

  /// Channel 0 only. On a Mac (the iPad app) the voice processing input has 5 or 7 discrete channels, each carrying
  /// the processed voice, and a downmix of a discrete layout to mono gives silence; on iPhone and iPad the input is
  /// already mono.
  private static func converter(from input: AVAudioFormat, to output: AVAudioFormat) -> AVAudioConverter? {
    let converter = AVAudioConverter(from: input, to: output)
    if input.channelCount > 1 { converter?.channelMap = [0] }
    return converter
  }

  func process(_ buffer: AVAudioPCMBuffer) -> Data? {
    lock.lock()
    defer { lock.unlock() }
    if !buffer.format.isEqual(converter.inputFormat) {
      guard let rebuilt = Self.converter(from: buffer.format, to: output) else { return nil }
      converter = rebuilt
    }
    let ratio = output.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
    guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }
    let source = RealtimeOneShotInput(buffer)
    var error: NSError?
    let status = converter.convert(to: converted, error: &error) { _, inputStatus in
      source.next(inputStatus)
    }
    guard status != .error, let channel = converted.floatChannelData?[0] else { return nil }
    return RealtimePCM.int16Data(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
  }
}

/// Blok wejścia konwertera: bufor podsłuchu raz, potem „na razie nic” (nie „koniec strumienia”, który gubi stan).
private final class RealtimeOneShotInput: @unchecked Sendable {
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
