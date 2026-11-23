import Foundation
import RarogContract
@testable import RarogUI
import Testing

// Dictation records from the tap: speech while the first Soniox connection is being set up waits in a backlog and
// goes in one burst after the config frame; a stop during that time still delivers it; the key fetch starts before
// the microphone when the permission is already granted; one ready line per recording. On the manual clock, the
// socket fake and the server-like key fetch (`DictationTestSupport.swift`).

/// 100 ms of PCM (3200 bytes) filled with one byte value, so each frame is recognizable in the send log.
private func pcm(_ mark: UInt8, ms: Int = 100) -> Data {
  Data(repeating: mark, count: ms * VoiceFrame.bytesPerSecond / 1000)
}

private let finalizeFrame = #"{"type":"finalize"}"#
private let invalidKeyFrame = #"{"error_code":401,"error_type":"unauthenticated","error_message":"Invalid API key."}"#
private let limitFrame = #"{"error_code":429,"error_type":"limit_exceeded","error_message":"Limit exceeded."}"#

@MainActor
private func audio(_ socket: MockSocket) -> [Data] {
  socket.sent.compactMap { if case let .data(data) = $0 { data } else { nil } }
}

@MainActor
@Suite("dictation: backlog of the first Soniox connection")
struct SonioxBacklogTests {
  @Test("speech while connecting goes after the config frame, in order, before live frames")
  func backlogFollowsConfig() async throws {
    let h = StreamHarness()
    h.mint.hold = true
    h.stream.start()
    await dictationSettle()
    h.stream.sendAudio(pcm(1))
    h.mint.release()
    await dictationSettle()
    h.stream.sendAudio(pcm(2))
    h.stream.sendAudio(pcm(3))
    #expect(h.last.sent.isEmpty, "nothing goes before the socket opens")
    h.last.open()
    h.stream.sendAudio(pcm(4))
    let config = try #require(h.last.texts.first)
    #expect(config.contains(#""model":"stt-rt-v6""#))
    #expect(h.last.sent == [.text(config), .data(pcm(1)), .data(pcm(2)), .data(pcm(3)), .data(pcm(4))])
    #expect(h.stream.state == .streaming)
  }

  @Test("seven seconds of connecting: only the last five seconds go")
  func backlogKeepsTheLastFiveSeconds() async {
    let h = StreamHarness()
    h.stream.start()
    await dictationSettle()
    for mark in 0..<70 { h.stream.sendAudio(pcm(UInt8(mark))) }
    h.last.open()
    #expect(audio(h.last) == (20..<70).map { pcm(UInt8($0)) })
    #expect(audio(h.last).reduce(0) { $0 + $1.count } == 5 * VoiceFrame.bytesPerSecond)
  }

  @Test("a first attempt that fails before streaming keeps the backlog for the next one; a later reconnect drops frames")
  func backlogSurvivesTheFirstAttemptOnly() async {
    let h = StreamHarness()
    h.stream.start()
    await dictationSettle()
    h.stream.sendAudio(pcm(1))
    h.last.drop()
    h.stream.sendAudio(pcm(2))
    await h.pass(3)
    #expect(h.sockets.count == 2 && h.sockets[0].sent.isEmpty)
    h.stream.sendAudio(pcm(3))
    h.last.open()
    #expect(audio(h.last) == [pcm(1), pcm(2), pcm(3)])

    h.last.reply(#"{"tokens":[{"text":"ala","is_final":true}]}"#)
    h.last.drop()
    #expect(h.stream.state == .reconnecting)
    h.stream.sendAudio(pcm(4))
    await h.pass(3)
    #expect(h.sockets.count == 3)
    h.last.open()
    h.stream.sendAudio(pcm(5))
    #expect(audio(h.last) == [pcm(5)], "after the first streaming, audio while reconnecting is lost")
  }

  @Test("an edit of the field before the backlog went drops it")
  func editDropsTheBacklog() async {
    let h = StreamHarness()
    h.stream.start()
    await dictationSettle()
    h.stream.sendAudio(pcm(1))
    h.stream.resetBuffers()
    h.stream.sendAudio(pcm(2))
    h.last.open()
    #expect(audio(h.last) == [pcm(2)])
  }

  @Test("stop while connecting with a backlog: config, backlog, finalize, end frame; the wait grows by the backlog")
  func stopWhileConnectingSendsTheBacklog() async throws {
    let h = StreamHarness()
    h.stream.start()
    await dictationSettle()
    h.stream.sendAudio(pcm(1))
    h.stream.sendAudio(pcm(2))
    h.stream.finish()
    #expect(h.done.isEmpty && !h.last.closed, "waits for the connection")
    h.last.open()
    let config = try #require(h.last.texts.first)
    #expect(h.last.sent == [.text(config), .data(pcm(1)), .data(pcm(2)), .text(finalizeFrame), .text("")])
    h.clock.advance(2.5)
    #expect(h.done.isEmpty, "finalizeTimeout plus the 200 ms backlog")
    h.clock.advance(0.25)
    #expect(h.done == [.finished] && h.last.closed)

    let text = StreamHarness()
    text.stream.start()
    await dictationSettle()
    text.stream.sendAudio(pcm(1))
    text.stream.finish()
    text.last.open()
    text.last.reply(#"{"tokens":[{"text":"powiedziane","is_final":true}]}"#)
    text.last.reply(#"{"finished":true}"#)
    #expect(text.done == [.finished] && text.stream.buffers.committed == "powiedziane")
  }

  @Test("a stop after the burst also waits longer by the backlog the connection took")
  func laterStopWaitsForTheBurst() async {
    let h = StreamHarness()
    h.stream.start()
    await dictationSettle()
    for mark in 0..<10 { h.stream.sendAudio(pcm(UInt8(mark))) }
    h.last.open()
    h.stream.finish()
    h.clock.advance(3.4)
    #expect(h.done.isEmpty, "finalizeTimeout plus the one-second backlog")
    h.clock.advance(0.2)
    #expect(h.done == [.finished])
  }

  @Test("stop while connecting, the socket never opens: failure at the deadline, no new attempt, nothing left open")
  func stopWhileConnectingGivesUpAtTheDeadline() async {
    let h = StreamHarness()
    h.stream.start()
    await dictationSettle()
    h.stream.sendAudio(pcm(1))
    h.stream.finish()
    await h.pass(2.75)
    #expect(h.done.isEmpty)
    await h.pass(0.25)
    #expect(h.done == [.failed(.dropped)] && h.last.closed && h.last.sent.isEmpty)
    await h.pass(10)
    #expect(h.mints == 1 && h.sockets.count == 1)

    // The key fetch still in flight at the deadline is cancelled and opens nothing.
    let minting = StreamHarness()
    minting.mint.hold = true
    minting.stream.start()
    await dictationSettle()
    minting.stream.sendAudio(pcm(1))
    minting.stream.finish()
    await minting.pass(3)
    #expect(minting.done == [.failed(.dropped)])
    minting.mint.release()
    await dictationSettle()
    #expect(minting.sockets.isEmpty && minting.mint.cancelled == 1)

    // The attempt fails during the wait: the end comes at once, without a new attempt.
    let failing = StreamHarness()
    failing.stream.start()
    await dictationSettle()
    failing.stream.sendAudio(pcm(1))
    failing.stream.finish()
    failing.last.drop()
    #expect(failing.done == [.failed(.dropped)])
    await failing.pass(10)
    #expect(failing.mints == 1 && failing.sockets.count == 1)
  }

  @Test("stop waited for the first connection, which then fails before any result: a failure, not a clean end")
  func waitedConnectionFailsAfterTheBurst() async {
    let cases: [(String, (MockSocket) -> Void, SonioxStream.End)] = [
      ("drop", { $0.drop() }, .failed(.dropped)),
      ("error frame", { $0.reply(invalidKeyFrame) }, .failed(.dropped)),
      ("429 frame", { $0.reply(limitFrame) }, .failed(.rateLimited)),
    ]
    for (name, fail, end) in cases {
      let h = StreamHarness()
      h.stream.start()
      await dictationSettle()
      h.stream.sendAudio(pcm(1))
      h.stream.finish()
      h.last.open()
      #expect(audio(h.last) == [pcm(1)], "\(name): the burst went")
      fail(h.last)
      #expect(h.done == [end], "\(name)")
      await h.pass(10)
      #expect(h.mints == 1 && h.done == [end], "\(name): no new attempt after a stop")
    }

    // The connection delivered a result first: its end after the stop is a normal one.
    let h = StreamHarness()
    h.stream.start()
    await dictationSettle()
    h.stream.sendAudio(pcm(1))
    h.stream.finish()
    h.last.open()
    h.last.reply(#"{"tokens":[{"text":"powiedziane","is_final":true}]}"#)
    h.last.drop()
    #expect(h.done == [.finished] && h.stream.buffers.committed == "powiedziane")
  }

  @Test("stop with a backlog between attempts: nothing can carry it, so the end is a failure at once")
  func stopBetweenAttemptsFails() async {
    let h = StreamHarness()
    h.stream.start()
    await dictationSettle()
    h.stream.sendAudio(pcm(1))
    h.last.drop()
    #expect(h.stream.state == .reconnecting)
    h.stream.finish()
    #expect(h.done == [.failed(.dropped)])
    await h.pass(10)
    #expect(h.mints == 1)
  }
}

@MainActor
@Suite("dictation: recording from the tap")
struct VoiceRecorderStartTests {
  @Test("permission granted and a microphone that opens without suspending: the key request still goes first")
  func keyRequestBeforeASynchronousMicrophone() async {
    let h = RecorderHarness(micGranted: true)
    await h.recorder.start()?.value
    #expect(h.log.entries == ["mint", "microphone"])
    #expect(h.mic.isOpen && h.view.phase == .recording)
  }

  @Test("permission granted: the key fetch starts while the microphone opens; otherwise after it")
  func keyFetchOrder() async {
    let early = RecorderHarness(micGranted: true)
    early.mic.holdStart = true
    let start = early.recorder.start()
    await dictationSettle()
    #expect(early.mint.calls.count == 1 && !early.mic.isOpen, "key fetch before the microphone opened")
    early.mic.grant()
    await start?.value
    #expect(early.mic.isOpen && early.view.phase == .recording)

    let late = RecorderHarness(micGranted: false)
    late.mic.holdStart = true
    let lateStart = late.recorder.start()
    await dictationSettle()
    #expect(late.mint.calls.isEmpty, "no key before the permission prompt is answered")
    late.mic.grant()
    await lateStart?.value
    await dictationSettle()
    #expect(late.log.entries == ["microphone", "mint"])

    // The system route has nothing to fetch: `prepare()` → microphone → `start()` whatever the permission.
    let system = RecorderHarness(fake: true, micGranted: true)
    await system.recorder.start()?.value
    #expect(system.log.entries == ["prepare", "microphone", "start"])
  }

  @Test("the phase is recording once the microphone is open, before the stream; a failed first attempt keeps it")
  func recordingFollowsTheMicrophone() async {
    for granted in [true, false] {
      let h = RecorderHarness(micGranted: granted)
      await h.recorder.start()?.value
      await dictationSettle()
      #expect(h.sockets.count == 1 && h.view.phase == .recording, "granted \(granted)")
      h.sockets[0].drop()
      #expect(h.view.phase == .recording, "granted \(granted): speech is still kept")
      await h.pass(3)
      h.sockets[1].open()
      #expect(h.view.phase == .recording)
      h.sockets[1].reply(#"{"tokens":[]}"#)
      h.sockets[1].drop()
      #expect(h.view.phase == .reconnecting, "granted \(granted): after streaming a drop loses audio")
      h.expectMicInvariant()
    }
  }

  @Test("a stream that streams before the microphone opens leaves it opening; recording follows the microphone")
  func streamingBeforeTheMicrophone() async {
    let h = RecorderHarness(micGranted: true)
    h.mic.holdStart = true
    let start = h.recorder.start()
    await dictationSettle()
    h.sockets[0].open()
    #expect(h.view.phase == .starting)
    h.mic.grant()
    await start?.value
    #expect(h.view.phase == .recording && h.mic.isOpen && h.recorder.active)
  }

  @Test("microphone refused after the stream started: stream aborted, no socket, one notice, no ready line")
  func microphoneRefusedAfterTheStreamStarted() async {
    let h = RecorderHarness(micGranted: true)
    h.mic.failure = .busy
    h.mint.hold = true
    await h.recorder.start()?.value
    #expect(h.view == VoiceView(notice: .microphone(.busy)))
    #expect(h.views.filter { $0.phase == .idle } == [VoiceView(notice: .microphone(.busy))])
    h.mint.release()
    await dictationSettle()
    #expect(h.sockets.isEmpty && h.traces.isEmpty)
    #expect(h.mint.cancelled == h.mint.calls.count, "a key fetch that ran was cancelled")

    // The key came first and a socket is connecting: it closes.
    let connecting = RecorderHarness(micGranted: true)
    connecting.mic.holdStart = true
    let start = connecting.recorder.start()
    await dictationSettle()
    #expect(connecting.sockets.count == 1)
    connecting.mic.failure = .busy
    connecting.mic.grant()
    await start?.value
    #expect(connecting.view == VoiceView(notice: .microphone(.busy)))
    #expect(connecting.sockets.allSatisfy { $0.closed } && connecting.traces.isEmpty)
    connecting.sockets.first?.open()
    #expect(connecting.sockets[0].sent.isEmpty)
  }

  @Test("stop or cancel while the microphone opens ends the early stream: nothing fetched stays, microphone closed")
  func endWhileTheMicrophoneOpens() async {
    for cancel in [false, true] {
      let h = RecorderHarness(micGranted: true)
      h.mic.holdStart = true
      let start = h.recorder.start()
      await dictationSettle()
      if cancel { h.recorder.cancel() } else { h.recorder.stop() }
      await dictationSettle()
      #expect(h.view.phase == .idle && !h.recorder.active, "cancel \(cancel)")
      h.mic.grant()
      await start?.value
      await dictationSettle()
      #expect(!h.mic.isOpen && h.sockets.allSatisfy { $0.closed } && h.view.notice == nil, "cancel \(cancel)")
      h.expectMicInvariant()
    }
  }

  @Test("stop while the microphone opens, then the microphone fails: the recording still ends")
  func stopThenMicrophoneFails() async {
    let h = RecorderHarness(micGranted: true)
    h.mic.holdStart = true
    let start = h.recorder.start()
    await dictationSettle()
    h.mic.failure = .busy
    h.mic.grant()
    h.recorder.stop()
    await start?.value
    await dictationSettle()
    #expect(h.view == VoiceView() && !h.recorder.active)
    #expect(h.sockets.allSatisfy { $0.closed })
    h.expectMicInvariant()
  }

  @Test("stop while connecting with speech: the backlog, then finalize; the last words reach the field")
  func stopWhileConnectingDeliversTheSpeech() async throws {
    let h = RecorderHarness(micGranted: true)
    await h.recorder.start()?.value
    await dictationSettle()
    h.mic.frame(pcm(1))
    h.mic.frame(pcm(2))
    h.recorder.stop()
    await dictationSettle()
    #expect(h.view.phase == .finalizing && !h.mic.isOpen && h.mic.flushes == 1)
    h.sockets[0].open()
    let config = try #require(h.sockets[0].texts.first)
    #expect(h.sockets[0].sent == [.text(config), .data(pcm(1)), .data(pcm(2)), .text(finalizeFrame), .text("")])
    h.sockets[0].reply(#"{"tokens":[{"text":"powiedziane","is_final":true}]}"#)
    h.sockets[0].reply(#"{"finished":true}"#)
    #expect(h.view == VoiceView(buffers: VoiceBuffers(committed: "powiedziane")))
    h.expectMicInvariant()
  }

  @Test("stop while connecting, the socket never opens: the failure notice at the 3 s deadline, nothing left open")
  func stopWhileConnectingGivesUp() async {
    let h = RecorderHarness(micGranted: true)
    await h.recorder.start()?.value
    await dictationSettle()
    h.mic.frame(pcm(1))
    h.recorder.stop()
    await dictationSettle()
    await h.pass(2.75)
    #expect(h.view.phase == .finalizing)
    await h.pass(0.25)
    #expect(h.view == VoiceView(notice: .streamFailed))
    #expect(h.sockets.allSatisfy { $0.closed } && h.mint.calls.count == 1 && !h.mic.isOpen && h.traces.isEmpty)
    h.expectMicInvariant()
  }

  @Test("stop while connecting without speech ends at once, also after an edit dropped the backlog")
  func stopWithoutBacklogEndsAtOnce() async {
    for edit in [false, true] {
      let h = RecorderHarness(micGranted: true)
      await h.recorder.start()?.value
      await dictationSettle()
      if edit {
        h.mic.frame(pcm(1))
        h.recorder.rebase()
      }
      h.recorder.stop()
      await dictationSettle()
      #expect(h.view == VoiceView(), "edit \(edit)")
      #expect(h.sockets.allSatisfy { $0.closed })
    }
  }

  @Test("an edit of the field while connecting drops the speech not sent yet")
  func editWhileConnectingDropsTheBacklog() async {
    let h = RecorderHarness(micGranted: true)
    await h.recorder.start()?.value
    await dictationSettle()
    h.mic.frame(pcm(1))
    h.recorder.rebase()
    h.mic.frame(pcm(2))
    h.sockets[0].open()
    #expect(audio(h.sockets[0]) == [pcm(2)])
  }

  @Test("one ready line per recording, with the stage times from the tap")
  func readyLineOnce() async {
    let h = RecorderHarness(micGranted: true)
    h.mic.holdStart = true
    h.mint.hold = true
    let start = h.recorder.start()
    await dictationSettle()
    h.clock.advance(0.2)
    h.mic.grant()
    await start?.value
    for mark in 1...3 { h.mic.frame(pcm(UInt8(mark))) }
    h.clock.advance(0.3)
    h.mint.hold = false
    h.mint.release()
    await dictationSettle()
    h.clock.advance(0.4)
    #expect(h.traces.isEmpty)
    h.sockets[0].open()
    #expect(h.traces == ["dictation: ready after 900 ms (microphone 200 ms, key 500 ms, socket 400 ms), backlog 300 ms"])

    h.sockets[0].reply(#"{"tokens":[]}"#)
    h.sockets[0].drop()
    await h.pass(3)
    h.sockets[1].open()
    #expect(h.traces.count == 1, "a reconnect writes no second line")

    // The connection is ready before the microphone: the line comes when the microphone opens.
    let first = RecorderHarness(micGranted: true)
    first.mic.holdStart = true
    let firstStart = first.recorder.start()
    await dictationSettle()
    first.clock.advance(0.1)
    first.sockets[0].open()
    #expect(first.traces.isEmpty)
    first.clock.advance(0.5)
    first.mic.grant()
    await firstStart?.value
    #expect(first.traces == ["dictation: ready after 600 ms (microphone 600 ms, key 0 ms, socket 100 ms), backlog 0 ms"])
  }
}
