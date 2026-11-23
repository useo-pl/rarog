import Foundation
import RarogContract
import RarogCore

// The activity line under the transcript: glyph, label, detail, delegation segments and the turn
// clock in a fixed field. A pure model: the view (`ActivityRowView`) draws it
// and holds it with `ActivityLineHold`. The list card keeps `ActivityText.cardText`. Tool names reach this file only
// through `ToolActivity`. Owner: activity.

/// The glyph of the activity line. A tool's glyph follows its category (`ToolCategory`).
public enum ActivityGlyph: Sendable, Equatable {
  case thinking
  case tool(ToolCategory)
  case delegation
  case waiting
  case quiet
  case offline
  case starting
  case interrupting

  /// SF Symbol of the glyph.
  public var symbolName: String {
    switch self {
    case .thinking: "sparkle"
    case let .tool(category): category.symbolName
    case .delegation: "arrow.triangle.branch"
    case .waiting, .quiet: "hourglass"
    case .offline: "antenna.radiowaves.left.and.right.slash"
    case .starting: "circle.dotted"
    case .interrupting: "stop.circle"
    }
  }
}

/// One activity line. Truncation order is the view's: the detail first, then the label; the clock never.
public struct ActivityRowLine: Sendable, Equatable {
  public var glyph: ActivityGlyph
  public var label: String
  /// Empty = no detail.
  public var detail: String
  /// The detail is machine text (path, command, pattern): monospaced face.
  public var detailIsMono: Bool
  /// Workflow bar segments of a delegation; `nil` = no bar.
  public var segments: [ProgressSegment]?
  /// Seconds of the turn clock; `nil` = no clock (below 1 s, agent start, no base).
  public var clockSeconds: Int?
  /// The turn clock in its short form ("2m"); `nil` with `clockSeconds`.
  public var clock: String?
  /// The glyph is drawn in the live (run) colour: a working line on a live stream. Quiet, offline and interrupt: no.
  public var isLive: Bool
  /// The session stream is broken: the clock stands, VoiceOver adds "connecting…".
  public var streamDown: Bool
  /// Kind of the activity behind the line (`ActivitySpeechGate` hears a change of kind at once).
  public var kind: ActivityKind
  /// The sentence for VoiceOver: label, detail, the turn time in words, "connecting…" on a broken stream.
  public var spoken: String
  /// What the line says without its times ("Quiet for", "still running", "last update" count without their
  /// numbers): VoiceOver hears a new key, not a tick, and the hold compares lines by it.
  public var contentKey: String

  /// The agent works now on a live stream: thinking that is not yet quiet, an open tool call (also past "still
  /// running": the call is open, a fact), a delegation. Only then the glyph breathes and the label shimmers;
  /// waiting, quiet, offline, agent start and interrupt stand still.
  public var isWorking: Bool {
    guard isLive else { return false }
    switch glyph {
    case .thinking, .tool, .delegation: return true
    case .waiting, .quiet, .offline, .starting, .interrupting: return false
    }
  }

  /// Agent start, interrupt, offline: these lines skip the hold (`ActivityLineHold`).
  var skipsHold: Bool {
    switch glyph {
    case .starting, .interrupting, .offline: true
    default: false
    }
  }

  /// Thinking quiet for this long turns the label into "Quiet for …".
  public static let quietAfter: TimeInterval = 90
  /// A tool running this long gets "still running · …" as its detail.
  public static let stillRunningAfter: TimeInterval = 60

  // MARK: Line of a session's activity

  /// The line of a transcript with content. Inputs as `ActivityText.live` plus the time bases and the moment the stream
  /// broke (`downSince`, `nil` = live). `nil` = no line (streaming answer, a session that is not working, no activity).
  public static func make(
    view: TranscriptState, state: SessionState?, clocks: ActivityClocks, now: Date, downSince: Date?
  ) -> ActivityRowLine? {
    guard let current = ActivityText.live(view: view, state: state, now: now) else { return nil }
    let activity = current.activity
    // On a broken stream every clock stops at the break: the line does not count a silence it knows nothing of.
    let clockNow = downSince.map { min($0, now) } ?? now
    guard var pieces = content(activity, clocks: clocks, since: current.since, clockNow: clockNow) else { return nil }
    if let downSince {
      // The line stays with what it said last; the glyph and the detail tell the stream is gone.
      pieces.glyph = .offline
      let heard = clocks.silence ?? min(downSince, now)
      pieces.detail = Part(
        shown: UICopy.activityLineLastUpdate(RelativeTime.short(since: heard, now: now)),
        spoken: UICopy.activityLineLastUpdateSpoken(RelativeTime.spokenAgo(since: heard, now: now)), key: "lastUpdate")
      pieces.mono = false
    }
    return line(
      pieces, turnSince: clocks.turn ?? current.since, clockNow: clockNow,
      isLive: downSince == nil && pieces.glyph != .quiet, streamDown: downSince != nil, kind: activity.kind)
  }

  /// The line of a session in the store: interrupt and agent start take the line as today; otherwise the line of a
  /// transcript with content. `link` = the view's memory of the session stream (start of the whole outage).
  public static func make(state: AppState, sessionId: String, now: Date, link: ConnectionMemory? = nil) -> ActivityRowLine? {
    let downSince = Self.downSince(link ?? observed(state.sessionStream, now: now), now: now)
    let clocks = state.activityClocks(sessionId)
    if let sentAt = state.turnControl.interrupts[sessionId] {
      switch state.transcriptPhase(for: sessionId) {
      case .content, .empty:
        return interrupting(
          state: state, sessionId: sessionId, clocks: clocks, sentAt: sentAt, now: now, downSince: downSince)
      case .loading, .unknownSession:
        return nil
      }
    }
    if state.sendBlock(for: sessionId) == .starting {
      let pieces = Pieces(label: Part(text: UICopy.sendBlock(.starting, session: nil)), glyph: .starting)
      return line(
        pieces, turnSince: nil, clockNow: now, isLive: downSince == nil, streamDown: downSince != nil, kind: .thinking)
    }
    guard state.transcriptPhase(for: sessionId) == .content, let view = state.transcripts[sessionId] else { return nil }
    return make(view: view, state: state.sessions[sessionId]?.state, clocks: clocks, now: now, downSince: downSince)
  }

  // MARK: Parts

  /// A piece of the line on screen, for VoiceOver and in the content key.
  struct Part: Equatable {
    var shown: String
    var spoken: String
    var key: String

    init(shown: String, spoken: String, key: String) {
      self.shown = shown
      self.spoken = spoken
      self.key = key
    }

    init(text: String) {
      self.init(shown: text, spoken: text, key: text)
    }
  }

  /// Label, detail and glyph before the clock and the stream are added.
  struct Pieces {
    var label: Part
    var detail: Part?
    var mono = false
    var glyph: ActivityGlyph
    var segments: [ProgressSegment]?
  }

  /// Label, detail and glyph of a live activity.
  private static func content(_ activity: ViewActivity, clocks: ActivityClocks, since: Date, clockNow: Date) -> Pieces? {
    switch activity.kind {
    case .idle:
      return nil
    case .thinking:
      let silence = clocks.silence ?? since
      guard clockNow.timeIntervalSince(silence) >= quietAfter else {
        return Pieces(label: Part(text: UICopy.activityLineThinking), glyph: .thinking)
      }
      let label = Part(
        shown: UICopy.activityLineQuiet(RelativeTime.short(since: silence, now: clockNow)),
        spoken: UICopy.activityLineQuiet(RelativeTime.spokenSince(since: silence, now: clockNow)), key: "quiet")
      return Pieces(label: label, glyph: .quiet)
    case .waiting:
      let summary = activity.summary ?? ""
      return Pieces(label: Part(text: summary.isEmpty ? UICopy.activityLineWaiting : summary), glyph: .waiting)
    case .tool:
      if activity.delegation != nil {
        let today = ActivityText.delegationLine(activity)
        return Pieces(
          label: Part(text: today.lead), detail: today.tail.isEmpty ? nil : Part(text: today.tail), glyph: .delegation,
          segments: ActivityText.workflowSegments(activity))
      }
      return tool(activity, started: clocks.tool ?? since, clockNow: clockNow)
    }
  }

  private static func tool(_ activity: ViewActivity, started: Date, clockNow: Date) -> Pieces {
    let category = ToolActivity.category(for: activity.toolName)
    let summary = activity.summary ?? ""
    let description = (activity.description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let label = description.isEmpty ? ToolActivity.lineLabel(for: activity.toolName) : description
    var text = Pieces(label: Part(text: label), glyph: .tool(category))
    if clockNow.timeIntervalSince(started) >= stillRunningAfter {
      text.detail = Part(
        shown: UICopy.activityLineStillRunning(RelativeTime.short(since: started, now: clockNow)),
        spoken: UICopy.activityLineStillRunningSpoken(RelativeTime.spokenSince(since: started, now: clockNow)),
        key: "stillRunning")
      return text
    }
    // A summary that only repeats the tool name (the server's fallback) says nothing new.
    guard !summary.isEmpty, summary != activity.toolName else { return text }
    let shown = category.detailIsFile ? fileName(summary) : summary
    text.detail = Part(text: shown)
    text.mono = category.monoDetail
    return text
  }

  /// The last path component: the file name of a path summary.
  private static func fileName(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
  }

  // MARK: Rows outside the table

  private static func interrupting(
    state: AppState, sessionId: String, clocks: ActivityClocks, sentAt: Date, now: Date, downSince: Date?
  ) -> ActivityRowLine {
    let live = state.transcripts[sessionId].flatMap {
      ActivityText.live(view: $0, state: state.sessions[sessionId]?.state, now: now)
    }
    let clockNow = downSince.map { min($0, now) } ?? now
    return line(
      Pieces(label: Part(text: UICopy.activityInterrupting), glyph: .interrupting),
      turnSince: clocks.turn ?? live?.since ?? sentAt, clockNow: clockNow, isLive: false, streamDown: downSince != nil,
      kind: live?.activity.kind ?? .thinking)
  }

  private static func line(
    _ text: Pieces, turnSince: Date?, clockNow: Date, isLive: Bool, streamDown: Bool, kind: ActivityKind
  ) -> ActivityRowLine {
    let seconds = turnSince.map { max(0, Int(clockNow.timeIntervalSince($0).rounded())) }.flatMap { $0 >= 1 ? $0 : nil }
    let clock = seconds.flatMap { _ in turnSince.map { RelativeTime.short(since: $0, now: clockNow) } }
    var spoken = [text.label.spoken, text.detail?.spoken ?? ""]
    if let seconds { spoken.append(UICopy.sinceSpoken(UICopy.spokenDuration(seconds))) }
    if streamDown { spoken.append(UICopy.connecting) }
    let key = ["\(kind)", text.glyph.symbolName, text.label.key, text.detail?.key ?? "", streamDown ? "down" : "live"]
    return ActivityRowLine(
      glyph: text.glyph, label: text.label.shown, detail: text.detail?.shown ?? "", detailIsMono: text.mono,
      segments: text.segments, clockSeconds: seconds, clock: clock, isLive: isLive, streamDown: streamDown, kind: kind,
      spoken: UICopy.list(spoken.filter { !$0.isEmpty }, .comma), contentKey: key.joined(separator: "|"))
  }

  /// Since when the session stream is down: from the start of the whole outage, not the current attempt (the stream
  /// loop alternates `offline` and `connecting`, each attempt with a new `since`). An attempt that has not failed yet
  /// counts after a second, so a short reconnect does not blink.
  static func downSince(_ link: ConnectionMemory, now: Date) -> Date? {
    guard let since = link.notOnlineSince else { return nil }
    return link.failedSinceOnline || link.showsConnecting(now: now) ? since : nil
  }

  private static func observed(_ status: ConnectionStatus, now: Date) -> ConnectionMemory {
    var link = ConnectionMemory()
    link.observe(status, now: now)
    return link
  }
}
