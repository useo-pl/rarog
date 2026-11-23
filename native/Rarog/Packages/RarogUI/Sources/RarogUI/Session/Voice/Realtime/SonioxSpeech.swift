import Foundation

// Soniox text-to-speech client for the voice agent: the agent's text goes in as deltas per utterance, PCM (s16le at
// the key's sample rate) and the spoken characters with their times come back. Owner: voice agent. Frames and the
// heard text: `SonioxSpeechFrames.swift`.
//
// Rules this type holds:
// 1. One socket per key, one stream per utterance, one stream at a time: the next utterance waits in its buffer until
//    the stream before it ends (`terminated`), even when its text came first. A stream that was cancelled or got an
//    error still holds the slot until its `terminated`, at most `drainLimit` seconds.
// 2. Before a stream starts, a key closer than `keyMargin` to its expiry is not used: the client asks for a new key
//    (`keyNeeded`), closes the old socket and opens a new one with the key from `renew`. A key that is already that
//    close when `renew` gets it is a failure. A 401 asks for a new key once; a second 401 before any audio is a
//    failure.
// 3. Between streams a keepalive goes out every `keepalive` seconds (Soniox closes an idle connection after 40 s).
// 4. Errors are events, never a hang: a stream error ends that utterance (`failed(.stream)`, then `finished`), a
//    connection error or a dropped socket ends the client (one `failed`, then nothing).
// 5. `cancel` stops an utterance: no `text_end`, late audio and characters of it are dropped, and no `finished`
//    comes for it. After `close()` nothing reaches the caller.
// 6. `sent` tells the caller how many characters of an utterance went out in text frames, once per character: text
//    that waits in the queue and is cancelled or closed away never counts, and text sent again after a 401 does not
//    count twice (the price, `RealtimeConversation+Speech.swift`).

@MainActor
final class SonioxSpeech {
  struct Timing: Sendable, Equatable {
    /// A key closer than this to `expiresAt` opens no new stream.
    var keyMargin: TimeInterval = 30
    /// Keepalive period while no stream runs.
    var keepalive: TimeInterval = 20
    /// How long a cancelled or failed stream may hold the slot while its `terminated` does not come.
    var drainLimit: TimeInterval = 3

    static let production = Timing()
  }

  /// Why speech failed. `stream` ends one utterance; the others end the client.
  enum Failure: Sendable, Equatable {
    /// An error frame for the utterance's stream (`request_timeout`, `temp_api_key_session_expired`, …).
    case stream(utterance: String, code: Int, type: String)
    /// The key was refused again after a new one (401 `unauthenticated`).
    case unauthenticated
    /// The key cannot be sent (not a `snx_temp_` key), or a new key was already too close to its expiry.
    case invalidKey
    /// An error frame for the whole connection (`code`, `type`), or the socket dropped (both `nil`).
    case connection(code: Int?, type: String?)

    /// A code for `client.log`, without the server's message.
    var logCode: String {
      switch self {
      case let .stream(_, code, type): "\(code) \(type)"
      case .unauthenticated: "401 unauthenticated"
      case .invalidKey: "invalid-key"
      case let .connection(code?, type): "\(code) \(type ?? "-")"
      case .connection(nil, _): "socket-closed"
      }
    }

    /// The stream ran past the key's `max_session_duration_seconds` (Soniox docs: 403
    /// `temp_api_key_session_expired`; the connection stays open). Matched on the type, not on the code.
    var isStreamLimit: Bool {
      if case let .stream(_, _, type) = self { return type == "temp_api_key_session_expired" }
      return false
    }
  }

  enum Event: Sendable, Equatable {
    case audio(utterance: String, pcm: Data)
    case characters(utterance: String, [SonioxSpokenCharacter])
    /// The utterance's synthesis is over (`terminated`, an error on its stream, or nothing to say).
    case finished(utterance: String)
    /// The client needs a new key: answer with `renew(_:)` or `close()`.
    case keyNeeded
    case failed(Failure)
  }

  private struct Utterance {
    let id: String
    /// The stream it runs on; `nil` while it waits.
    var stream: String?
    /// Text not sent yet.
    var pending = ""
    /// Text sent on the current stream, sent again on a new socket after a 401.
    var sent = ""
    /// Characters of `sent`, and how many of them the caller already heard of (`sent`, rule 6).
    var sentCount = 0
    var reported = 0
    var ended = false
    var hadAudio = false
  }

  private var config: SonioxSpeechConfig
  private let connect: VoiceSocketFactory
  private let scheduler: any VoiceScheduler
  private let clock: @MainActor () -> Date
  private let timing: Timing
  private let onEvent: @MainActor (Event) -> Void
  private let onSent: @MainActor (_ utterance: String, _ characters: Int) -> Void

  private var socket: (any VoiceSocket)?
  private var socketOpen = false
  /// Socket attempt number: callbacks of a socket we no longer want see a different number.
  private var generation = 0
  /// Utterances in order; the head is the running one or the next to run.
  private var queue: [Utterance] = []
  /// Live stream id → utterance id. A frame for a stream not here (cancelled, ended, old socket) is dropped.
  private var streams: [String: String] = [:]
  private var cancelled: Set<String> = []
  private var streamCount = 0
  private var awaitingKey = false
  /// A 401 already got a new key; cleared by the first audio.
  private var rejectedOnce = false
  /// A cancelled or failed stream that has not sent `terminated` yet: it holds the slot (rule 1).
  private var draining: String?
  private var drainTimer: VoiceTimer?
  private var keepaliveTimer: VoiceTimer?
  private var closed = false

  init(
    config: SonioxSpeechConfig, connect: @escaping VoiceSocketFactory, scheduler: any VoiceScheduler,
    clock: @escaping @MainActor () -> Date = { Date() }, timing: Timing = .production,
    onEvent: @escaping @MainActor (Event) -> Void,
    sent: @escaping @MainActor (_ utterance: String, _ characters: Int) -> Void = { _, _ in }
  ) {
    self.config = config
    self.connect = connect
    self.scheduler = scheduler
    self.clock = clock
    self.timing = timing
    self.onEvent = onEvent
    onSent = sent
  }

  /// Opens the socket with the first key, ahead of the first text.
  func start() {
    guard !closed, socket == nil, !awaitingKey else { return }
    open()
  }

  /// Text of an utterance. The first call puts the utterance in the queue; text after `end` or `cancel` is dropped.
  func append(_ text: String, to utterance: String) {
    guard !closed, !cancelled.contains(utterance) else { return }
    guard let index = queue.firstIndex(where: { $0.id == utterance }) else {
      queue.append(Utterance(id: utterance, pending: text))
      pump()
      return
    }
    guard !queue[index].ended, !text.isEmpty else { return }
    if let stream = queue[index].stream {
      queue[index].sent += text
      queue[index].sentCount += text.count
      sendText(text, stream: stream)
      reportSent(index)
    } else {
      queue[index].pending += text
      pump()
    }
  }

  /// The utterance's text is complete (`text_end`). An utterance without text ends without a stream.
  func end(_ utterance: String) {
    guard !closed, !cancelled.contains(utterance) else { return }
    guard let index = queue.firstIndex(where: { $0.id == utterance }) else {
      queue.append(Utterance(id: utterance, ended: true))
      pump()
      return
    }
    guard !queue[index].ended else { return }
    queue[index].ended = true
    if let stream = queue[index].stream {
      send(SonioxSpeechFrame.text(stream: stream, "", end: true))
    } else {
      pump()
    }
  }

  /// Stops an utterance: a running stream gets `cancel`, a waiting one never starts. Nothing more comes for it.
  func cancel(_ utterance: String) {
    guard !closed else { return }
    cancelled.insert(utterance)
    guard let index = queue.firstIndex(where: { $0.id == utterance }) else { return }
    let removed = queue.remove(at: index)
    if let stream = removed.stream {
      streams[stream] = nil
      send(SonioxSpeechFrame.cancel(stream: stream))
      drain(stream)
    }
    pump()
  }

  /// A new key after `keyNeeded`: a new socket with it, then the waiting utterance starts. A key already within
  /// `keyMargin` of its expiry is a failure, so the client never loops on asking.
  func renew(_ next: SonioxSpeechConfig) {
    guard !closed, awaitingKey else { return }
    guard next.expiresAt.timeIntervalSince(clock()) >= timing.keyMargin else {
      fail(.invalidKey)
      return
    }
    awaitingKey = false
    config = next
    open()
  }

  /// Ends speech: the socket closes, timers stop, and no event comes after this call.
  func close() {
    guard !closed else { return }
    closed = true
    tearDown()
  }

  // MARK: - Socket

  private func open() {
    guard let protocols = SonioxKey.protocols(config.apiKey) else {
      fail(.invalidKey)
      return
    }
    generation += 1
    let generation = generation
    socketOpen = false
    let events = VoiceSocketEvents(
      opened: { [weak self] in
        guard let self, self.current(generation) else { return }
        self.socketOpen = true
        self.armKeepalive()
        self.pump()
      },
      message: { [weak self] text in
        guard let self, self.current(generation) else { return }
        self.receive(text)
      },
      closed: { [weak self] in
        guard let self, self.current(generation) else { return }
        self.socket = nil
        self.socketOpen = false
        self.fail(.connection(code: nil, type: nil))
      })
    socket = connect(config.webSocketURL, protocols, events)
  }

  private func current(_ generation: Int) -> Bool {
    self.generation == generation && !closed
  }

  private func closeSocket() {
    generation += 1
    keepaliveTimer?.cancel()
    keepaliveTimer = nil
    drainTimer?.cancel()
    drainTimer = nil
    draining = nil
    socket?.close()
    socket = nil
    socketOpen = false
    streams = [:]
  }

  /// `stream` holds the slot until its `terminated` or `drainLimit`, whichever comes first.
  private func drain(_ stream: String) {
    draining = stream
    drainTimer?.cancel()
    drainTimer = scheduler.schedule(after: timing.drainLimit) { [weak self] in
      guard let self, !self.closed, self.draining == stream else { return }
      self.drained(stream)
    }
  }

  private func drained(_ stream: String) {
    guard draining == stream else { return }
    draining = nil
    drainTimer?.cancel()
    drainTimer = nil
    pump()
  }

  private func requestKey() {
    closeSocket()
    awaitingKey = true
    emit(.keyNeeded)
  }

  private func armKeepalive() {
    keepaliveTimer?.cancel()
    keepaliveTimer = scheduler.schedule(after: timing.keepalive) { [weak self] in
      guard let self, !self.closed, self.socketOpen else { return }
      self.keepaliveTimer = nil
      if self.queue.first?.stream == nil { self.send(SonioxSpeechFrame.keepalive) }
      self.armKeepalive()
    }
  }

  private func send(_ frame: String) {
    guard socketOpen else { return }
    socket?.send(text: frame)
  }

  private func sendText(_ text: String, stream: String) {
    for piece in SonioxSpeechFrame.pieces(text) { send(SonioxSpeechFrame.text(stream: stream, piece)) }
  }

  // MARK: - Queue

  /// Starts the head utterance when it can: no stream runs, it has text or its end, the socket is open and the key
  /// is far enough from its expiry.
  private func pump() {
    guard !closed, !awaitingKey, draining == nil, let head = queue.first, head.stream == nil else { return }
    if head.ended && head.pending.isEmpty && head.sent.isEmpty {
      queue.removeFirst()
      emit(.finished(utterance: head.id))
      pump()
      return
    }
    guard !head.pending.isEmpty || head.ended, socketOpen else { return }
    if config.expiresAt.timeIntervalSince(clock()) < timing.keyMargin {
      requestKey()
      return
    }
    startStream()
  }

  private func startStream() {
    streamCount += 1
    let stream = "u\(streamCount)"
    let text = queue[0].sent + queue[0].pending
    queue[0].stream = stream
    queue[0].sent = text
    queue[0].sentCount = text.count
    queue[0].pending = ""
    streams[stream] = queue[0].id
    send(SonioxSpeechFrame.start(stream: stream, config: config))
    sendText(text, stream: stream)
    reportSent(0)
    if queue[0].ended { send(SonioxSpeechFrame.text(stream: stream, "", end: true)) }
  }

  /// The utterance on `stream` is over: out of the queue, `finished` to the caller, the next one starts.
  private func finish(stream: String) {
    guard let utterance = streams.removeValue(forKey: stream) else { return }
    queue.removeAll { $0.id == utterance }
    emit(.finished(utterance: utterance))
    pump()
  }

  // MARK: - Frames

  private func receive(_ text: String) {
    guard let reply = SonioxSpeechReply.parse(text) else { return }
    if let code = reply.errorCode {
      error(code: code, type: reply.errorType ?? "", stream: reply.stream)
      if reply.terminated, let stream = reply.stream { drained(stream) }
      return
    }
    if let stream = reply.stream, stream == draining {
      if reply.terminated { drained(stream) }
      return
    }
    guard let stream = reply.stream, let utterance = streams[stream] else { return }
    if let pcm = reply.audio {
      rejectedOnce = false
      if let index = queue.firstIndex(where: { $0.id == utterance }) { queue[index].hadAudio = true }
      emit(.audio(utterance: utterance, pcm: pcm))
    }
    if !reply.characters.isEmpty, streams[stream] == utterance {
      emit(.characters(utterance: utterance, reply.characters))
    }
    if reply.terminated { finish(stream: stream) }
  }

  private func error(code: Int, type: String, stream: String?) {
    let utterance = stream.flatMap { streams[$0] }
    if code == 401, stream == nil || (utterance != nil && queue.first?.hadAudio == false) {
      keyRejected()
      return
    }
    if let stream, let utterance {
      emit(.failed(.stream(utterance: utterance, code: code, type: type)))
      // The stream may still answer until its `terminated`; until then it holds the slot.
      drain(stream)
      finish(stream: stream)
    } else if stream == nil {
      fail(.connection(code: code, type: type))
    }
    // An error for a stream no longer live (cancelled, ended) has no one to tell.
  }

  /// 401: the key does not open streams. Once: a new key and the running utterance again on the new socket.
  private func keyRejected() {
    guard !rejectedOnce else {
      fail(.unauthenticated)
      return
    }
    rejectedOnce = true
    if !queue.isEmpty, queue[0].stream != nil {
      queue[0].stream = nil
      queue[0].pending = queue[0].sent + queue[0].pending
      queue[0].sent = ""
      queue[0].sentCount = 0
    }
    requestKey()
  }

  // MARK: - Out

  /// Characters of the utterance at `index` that went out for the first time (rule 6).
  private func reportSent(_ index: Int) {
    let fresh = queue[index].sentCount - queue[index].reported
    guard fresh > 0, !closed else { return }
    queue[index].reported = queue[index].sentCount
    onSent(queue[index].id, fresh)
  }

  private func emit(_ event: Event) {
    guard !closed else { return }
    onEvent(event)
  }

  /// A failure that ends speech: everything closes first, then one event.
  private func fail(_ failure: Failure) {
    guard !closed else { return }
    closed = true
    tearDown()
    onEvent(.failed(failure))
  }

  private func tearDown() {
    closeSocket()
    queue = []
    awaitingKey = false
  }
}
